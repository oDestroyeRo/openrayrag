import gridData from './data/navigation-maps.json';
import { type Position } from './protocol';

export const NAVIGATION_MAPS = Object.keys(gridData);
// Includes the 416-cell Payon fields; shared with status validation and extraction.
export const MAX_MAP_DIMENSION = 512;
export const distance = (a: Position, b: Position): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
/** An admissible movement-cost bound to a square goal range, without wall penalties. */
export function minimumRouteCost(from: Position, to: Position, range = 0): number {
  const dx = Math.max(0, Math.abs(from.x - to.x) - range);
  const dy = Math.max(0, Math.abs(from.y - to.y) - range);
  return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
}
const directions = [[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]] as const;
const cardinalDirections = [[0,1],[1,0],[0,-1],[-1,0]] as const;
const wallPenalties = [0, 60, 50, 20, 10, 0] as const;
export interface PortalArea extends Position { halfWidth: number; halfHeight: number }
interface GridData { width: number; height: number; walkableBitsBase64: string; portals: PortalArea[] }
const maps: Record<string, GridData> = gridData;
export interface WalkGrid {
  width: number; height: number; walkable: (p: Position) => boolean;
  portals?: readonly PortalArea[];
}
const cachedGrids = new Map<string, WalkGrid>();
export function searchGrid(map: string): WalkGrid | null {
  if (!Object.hasOwn(maps, map)) return null;
  const cached = cachedGrids.get(map);
  if (cached) return cached;
  const data = maps[map]!;
  const bytes = Uint8Array.from(atob(data.walkableBitsBase64), c => c.charCodeAt(0));
  const grid: WalkGrid = {
    width: data.width, height: data.height, portals: data.portals,
    walkable: ({ x, y }) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0
      && x < data.width && y < data.height
      && (bytes[(x + y * data.width) >> 3]! & (1 << ((x + y * data.width) & 7))) !== 0,
  };
  cachedGrids.set(map, grid);
  return grid;
}

export interface NavigationSummary {
  width: number;
  height: number;
  // Walkable and blocked describe the source grid; excluded is a subset of walkable.
  walkable: number;
  blocked: number;
  excluded: number;
  reachable: number;
}

export interface RouteOptions { range?: number; maxDistance?: number; avoidWalls?: boolean }
type TileState = 'blocked' | 'portal' | 'walkable';
interface OpenCell { cell: number; cost: number; priority: number }
interface SearchScratch { costs: Float64Array; parents: Int32Array; seen: Uint32Array; closed: Uint32Array; stamp: number; queue?: Int32Array }
const ROUTE_CACHE_ENTRIES = 256;
const ROUTE_CACHE_CELLS = 4096;

class RouteHeap {
  private readonly cells: OpenCell[] = [];
  private before(a: OpenCell, b: OpenCell): boolean {
    return a.priority < b.priority || (a.priority === b.priority && a.cost > b.cost);
  }
  push(value: OpenCell): void {
    let index = this.cells.length;
    this.cells.push(value);
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!this.before(value, this.cells[parent]!)) break;
      this.cells[index] = this.cells[parent]!;
      index = parent;
    }
    this.cells[index] = value;
  }
  pop(): OpenCell | undefined {
    const first = this.cells[0];
    const last = this.cells.pop();
    if (!first || !last || this.cells.length === 0) return first;
    let index = 0;
    while (index * 2 + 1 < this.cells.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.cells.length && this.before(this.cells[child + 1]!, this.cells[child]!)) child++;
      if (!this.before(this.cells[child]!, last)) break;
      this.cells[index] = this.cells[child]!;
      index = child;
    }
    this.cells[index] = last;
    return first;
  }
}

/** A snapshot of published collision cells, independent of observed server movement. */
export class GridNavigator {
  private readonly width: number;
  private readonly height: number;
  private readonly count: number;
  private readonly tiles: Uint8Array;
  private readonly clearance: Uint8Array;
  private readonly components: Uint32Array;
  private readonly members: number[][] = [[]];
  private readonly blockedUntil = new Map<number, number>();
  private readonly counts: Omit<NavigationSummary, 'reachable'>;
  private readonly routeCache = new Map<string, Position[] | null>();
  private cachedCells = 0;
  private scratch: SearchScratch | null = null;
  private now = 0;

  constructor(grid: WalkGrid, excludedAreas: readonly PortalArea[] = grid.portals ?? []) {
    if (!Number.isInteger(grid.width) || !Number.isInteger(grid.height)
      || grid.width < 1 || grid.height < 1 || grid.width > MAX_MAP_DIMENSION || grid.height > MAX_MAP_DIMENSION) {
      throw new RangeError(`Navigation grid dimensions must be integers from 1 to ${MAX_MAP_DIMENSION}`);
    }
    this.width = grid.width;
    this.height = grid.height;
    this.count = grid.width * grid.height;
    this.tiles = new Uint8Array(this.count);
    this.clearance = new Uint8Array(this.count);
    this.components = new Uint32Array(this.count);
    let walkable = 0;
    let excluded = 0;
    for (let cell = 0; cell < this.count; cell++) {
      const p = this.position(cell);
      if (!grid.walkable(p)) continue;
      walkable++;
      if (excludedAreas.some(portal => Math.abs(p.x - portal.x) <= portal.halfWidth
        && Math.abs(p.y - portal.y) <= portal.halfHeight)) {
        this.tiles[cell] = 1;
        excluded++;
      } else this.tiles[cell] = 2;
    }
    this.counts = { width: this.width, height: this.height, walkable, blocked: this.count - walkable, excluded };
    this.analyzeClearance();
    this.analyzeComponents();
  }

  private index(p: Position): number {
    return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0
      && p.x < this.width && p.y < this.height ? p.x + p.y * this.width : -1;
  }
  private position(cell: number): Position { return { x: cell % this.width, y: Math.floor(cell / this.width) }; }
  tileState(p: Position): TileState {
    const tile = this.tiles[this.index(p)];
    return tile === 2 ? 'walkable' : tile === 1 ? 'portal' : 'blocked';
  }
  safe(p: Position): boolean { return this.tiles[this.index(p)] === 2; }
  connected(a: Position, b: Position): boolean {
    return this.safe(a) && this.safe(b) && distance(a, b) === 1
      && (a.x === b.x || a.y === b.y || (this.safe({ x: a.x, y: b.y }) && this.safe({ x: b.x, y: a.y })));
  }
  validRoute(cells: Position[]): boolean {
    return cells.length > 0 && cells.every((p, i) => this.safe(p) && (!i || this.connected(cells[i - 1]!, p)));
  }
  summary(from: Position): NavigationSummary {
    const component = this.components[this.index(from)] ?? 0;
    return { ...this.counts, reachable: this.members[component]!.length };
  }

  /** Temporary failures influence planning, never the physical collision layer. */
  time(now: number): void {
    if (!Number.isFinite(now)) return;
    this.now = now;
    let changed = false;
    for (const [cell, until] of this.blockedUntil) if (until <= now) { this.blockedUntil.delete(cell); changed = true; }
    if (changed) this.clearRouteCache();
  }
  temporaryBlocked(p: Position, until: number): void {
    if (!this.safe(p) || !Number.isFinite(until) || until <= this.now) return;
    const cell = this.index(p);
    if (!this.blockedUntil.has(cell)) this.clearRouteCache();
    this.blockedUntil.set(cell, Math.max(until, this.blockedUntil.get(cell) ?? until));
  }
  private available(p: Position): boolean {
    return this.safe(p) && (this.blockedUntil.get(this.index(p)) ?? -Infinity) <= this.now;
  }
  private step(a: Position, b: Position): boolean {
    return this.connected(a, b) && this.available(b)
      && (a.x === b.x || a.y === b.y || (this.available({ x: a.x, y: b.y }) && this.available({ x: b.x, y: a.y })));
  }

  private analyzeClearance(): void {
    // Cardinal clearance to effective obstacles, including map edges and portal margins.
    this.clearance.fill(5);
    const queue = new Int32Array(this.count);
    let head = 0;
    let tail = 0;
    for (let cell = 0; cell < this.count; cell++) if (this.tiles[cell] !== 2) {
      this.clearance[cell] = 0;
      queue[tail++] = cell;
    }
    // Add clear edge cells after the distance-zero sources so the queue stays ordered.
    for (let cell = 0; cell < this.count; cell++) {
      const p = this.position(cell);
      if (this.tiles[cell] === 2 && (p.x === 0 || p.y === 0 || p.x === this.width - 1 || p.y === this.height - 1)) {
        this.clearance[cell] = 1;
        queue[tail++] = cell;
      }
    }
    while (head < tail) {
      const cell = queue[head++]!;
      const nextDistance = this.clearance[cell]! + 1;
      if (nextDistance >= 5) continue;
      const p = this.position(cell);
      for (const [dx, dy] of cardinalDirections) {
        const next = this.index({ x: p.x + dx, y: p.y + dy });
        if (next < 0 || this.clearance[next]! <= nextDistance) continue;
        this.clearance[next] = nextDistance;
        queue[tail++] = next;
      }
    }
  }
  private analyzeComponents(): void {
    const queue = new Int32Array(this.count);
    for (let cell = 0; cell < this.count; cell++) {
      if (this.tiles[cell] !== 2 || this.components[cell] !== 0) continue;
      const component = this.members.length;
      const members: number[] = [];
      this.members.push(members);
      let head = 0;
      let tail = 1;
      queue[0] = cell;
      this.components[cell] = component;
      while (head < tail) {
        const current = queue[head++]!;
        members.push(current);
        const p = this.position(current);
        for (const [dx, dy] of directions) {
          const next = { x: p.x + dx, y: p.y + dy };
          const index = this.index(next);
          if (index < 0 || this.components[index] !== 0 || !this.connected(p, next)) continue;
          this.components[index] = component;
          queue[tail++] = index;
        }
      }
    }
  }

  /** Verify a straight walking corridor, including diagonal side cells and portals. */
  clearWalkCorridor(from: Position, to: Position): boolean {
    return this.safe(from) && this.available(to) && this.clearApproach(from, to);
  }

  private clearApproach(from: Position, to: Position): boolean {
    let current = from;
    let error = Math.abs(to.x - from.x) - Math.abs(to.y - from.y);
    const dx = Math.abs(to.x - from.x);
    const dy = Math.abs(to.y - from.y);
    while (current.x !== to.x || current.y !== to.y) {
      const next = { ...current };
      const twice = error * 2;
      if (twice > -dy) { error -= dy; next.x += Math.sign(to.x - from.x); }
      if (twice < dx) { error += dx; next.y += Math.sign(to.y - from.y); }
      if (!this.step(current, next)) return false;
      current = next;
    }
    return true;
  }
  private route(parents: Int32Array, end: number): Position[] {
    const cells: Position[] = [];
    for (let cell = end; cell >= 0; cell = parents[cell]!) cells.push(this.position(cell));
    return cells.reverse();
  }
  private clearRouteCache(): void { this.routeCache.clear(); this.cachedCells = 0; }
  private cacheRoute(key: string, cells: Position[] | null): void {
    if (cells && cells.length > ROUTE_CACHE_CELLS) return;
    while (this.routeCache.size >= ROUTE_CACHE_ENTRIES || this.cachedCells + (cells?.length ?? 0) > ROUTE_CACHE_CELLS) {
      const oldest = this.routeCache.keys().next().value!;
      this.cachedCells -= this.routeCache.get(oldest)?.length ?? 0;
      this.routeCache.delete(oldest);
    }
    this.routeCache.set(key, cells?.map(p => ({ ...p })) ?? null);
    this.cachedCells += cells?.length ?? 0;
  }
  private beginSearch(): SearchScratch {
    this.scratch ??= { costs: new Float64Array(this.count), parents: new Int32Array(this.count),
      seen: new Uint32Array(this.count), closed: new Uint32Array(this.count), stamp: 0 };
    if (++this.scratch.stamp > 0xffff_ffff) {
      this.scratch.seen.fill(0); this.scratch.closed.fill(0); this.scratch.stamp = 1;
    }
    return this.scratch;
  }
  plan(from: Position, to: Position, options: RouteOptions = {}): Position[] | null {
    const range = options.range ?? 0;
    const maxDistance = options.maxDistance ?? this.count - 1;
    if (!Number.isInteger(range) || range < 0 || range > MAX_MAP_DIMENSION || !Number.isInteger(maxDistance)
      || maxDistance < 0 || !this.safe(from) || (!this.available(to) && distance(from, to) !== 0)) return null;
    const start = this.index(from);
    const target = this.index(to);
    if (this.components[start] !== this.components[target] || Math.max(0, distance(from, to) - range) > maxDistance) return null;
    // Geometry is immutable. Only the effective temporary-block set invalidates
    // exact results; extend this key whenever a new route option is introduced.
    const key = `${start}:${target}:${range}:${maxDistance}:${options.avoidWalls === false ? 0 : 1}`;
    if (this.routeCache.has(key)) {
      const cached = this.routeCache.get(key)!;
      this.routeCache.delete(key); this.routeCache.set(key, cached);
      return cached?.map(p => ({ ...p })) ?? null;
    }
    const cells = this.findRoute(from, to, range, maxDistance, options.avoidWalls !== false);
    this.cacheRoute(key, cells);
    return cells;
  }
  private findRoute(from: Position, to: Position, range: number, maxDistance: number, avoidWalls: boolean): Position[] | null {
    const goal = (p: Position) => distance(p, to) <= range && this.clearApproach(p, to);
    // Prove capped local failures before exploring the whole component. This
    // square bounds every cell BFS can reach within the cap; successful queries
    // still use the original weighted search and its exact tie ordering.
    let cappedRoute: Position[] | undefined;
    if (maxDistance <= 64 && (2 * maxDistance + 1) ** 2 < this.count / 2 && !this.clearWalkCorridor(from, to)) {
      const reachable = this.shortestSteps(from, goal, maxDistance);
      if (!reachable) return null;
      cappedRoute = reachable;
    }
    const heuristic = (p: Position) => minimumRouteCost(p, to, range);
    const { costs, parents, seen, closed, stamp } = this.beginSearch();
    const start = this.index(from);
    const open = new RouteHeap();
    costs[start] = 0; parents[start] = -1; seen[start] = stamp;
    open.push({ cell: start, cost: 0, priority: heuristic(from) });
    let current: OpenCell | undefined;
    while ((current = open.pop())) {
      if (closed[current.cell] === stamp || current.cost !== costs[current.cell]) continue;
      closed[current.cell] = stamp;
      const p = this.position(current.cell);
      if (goal(p)) {
        const route = this.route(parents, current.cell);
        if (route.length - 1 <= maxDistance) return route;
        // A cheaper wall-aware detour can exceed a step cap. Try a shortest-step
        // route so a narrow but valid corridor is still usable within that cap.
        return cappedRoute ?? this.shortestSteps(from, goal, maxDistance);
      }
      for (const [dx, dy] of directions) {
        const next = { x: p.x + dx, y: p.y + dy };
        if (!this.step(p, next)) continue;
        const cell = this.index(next);
        if (closed[cell] === stamp) continue;
        const wallCost = avoidWalls ? wallPenalties[this.clearance[cell]!]! : 0;
        const cost = current.cost + (dx && dy ? 14 : 10) + wallCost;
        if (seen[cell] === stamp && cost >= costs[cell]!) continue;
        costs[cell] = cost; seen[cell] = stamp;
        parents[cell] = current.cell;
        open.push({ cell, cost, priority: cost + heuristic(next) });
      }
    }
    return null;
  }
  private shortestSteps(from: Position, goal: (p: Position) => boolean, maxDistance: number): Position[] | null {
    const scratch = this.beginSearch();
    const { parents, costs: steps, seen, stamp } = scratch;
    const queue = scratch.queue ??= new Int32Array(this.count);
    const start = this.index(from);
    let head = 0;
    let tail = 1;
    queue[0] = start;
    steps[start] = 0; parents[start] = -1; seen[start] = stamp;
    while (head < tail) {
      const cell = queue[head++]!;
      const p = this.position(cell);
      if (goal(p)) return this.route(parents, cell);
      if (steps[cell]! >= maxDistance) continue;
      for (const [dx, dy] of directions) {
        const next = { x: p.x + dx, y: p.y + dy };
        const index = this.index(next);
        if (index < 0 || seen[index] === stamp || !this.step(p, next)) continue;
        steps[index] = steps[cell]! + 1; seen[index] = stamp;
        parents[index] = cell;
        queue[tail++] = index;
      }
    }
    return null;
  }

  randomGoal(from: Position, random: () => number = Math.random): Position | null {
    if (!this.safe(from)) return null;
    const component = this.components[this.index(from)]!;
    const members = this.members[component]!;
    for (let trial = 0; trial < 500; trial++) {
      const sample = random();
      if (!Number.isFinite(sample) || sample < 0 || sample >= 1) continue;
      const p = this.position(members[Math.floor(sample * members.length)]!);
      if (distance(from, p) >= 6 && this.available(p)) return p;
    }
    // Small components or an unhelpful random stream still get a finite fallback.
    let best: Position | null = null;
    let farthest = 0;
    for (const cell of members) {
      const p = this.position(cell);
      const away = distance(from, p);
      if (away > farthest && this.available(p)) { best = p; farthest = away; }
    }
    return best;
  }
}

/** A destination-only server command must follow one straight portion of a route. */
export function routeSegment(cells: Position[], maxSteps: number): Position[] {
  if (!cells.length || !Number.isInteger(maxSteps) || maxSteps < 0
    || !Number.isInteger(cells[0]!.x) || !Number.isInteger(cells[0]!.y)) return [];
  const segment = [{ ...cells[0]! }];
  if (!maxSteps || cells.length === 1) return segment;
  const dx = cells[1]!.x - cells[0]!.x;
  const dy = cells[1]!.y - cells[0]!.y;
  if (!Number.isInteger(dx) || !Number.isInteger(dy) || Math.max(Math.abs(dx), Math.abs(dy)) !== 1) return segment;
  for (let i = 1; i < cells.length && i <= maxSteps; i++) {
    if (cells[i]!.x - cells[i - 1]!.x !== dx || cells[i]!.y - cells[i - 1]!.y !== dy) break;
    segment.push({ ...cells[i]! });
  }
  return segment;
}

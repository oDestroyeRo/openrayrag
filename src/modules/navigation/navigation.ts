import { findNavigationRoute, navigationDirections } from './navigation-search-logic';
import type { Position } from '../protocol/protocol';
import { attackDistance, projectileLineOfSight } from '../combat/combat';
import { createMapGrid, distance, MAX_MAP_DIMENSION, type WalkGrid, type NavigationSummary, type PortalArea, type RouteOptions } from './navigation-logic';
export { NAVIGATION_MAPS, MAX_MAP_DIMENSION, distance, minimumRouteCost, routeSegment, type PortalArea, type WalkGrid, type NavigationSummary, type RouteOptions } from './navigation-logic';

const cardinalDirections = [[0,1],[1,0],[0,-1],[-1,0]] as const;

const cachedGrids = new Map<string, WalkGrid>();

export function searchGrid(map: string): WalkGrid | null {
  const cached = cachedGrids.get(map);
  if (cached) return cached;
  const grid = createMapGrid(map);
  if (grid) cachedGrids.set(map, grid);
  return grid;
}

type TileState = 'blocked' | 'portal' | 'walkable';

const ROUTE_CACHE_ENTRIES = 256;

const ROUTE_CACHE_CELLS = 4096;


/** A snapshot of published collision cells, independent of observed server movement. */
export class GridNavigator {
  private readonly width: number;
  private readonly height: number;
  private readonly count: number;
  private readonly tiles: Uint8Array;
  private readonly sight: Uint8Array;
  private readonly clearance: Uint8Array;
  private readonly components: Uint32Array;
  private readonly members: number[][] = [[]];
  private readonly blockedUntil = new Map<number, number>();
  private readonly counts: Omit<NavigationSummary, 'reachable'>;
  private readonly routeCache = new Map<string, Position[] | null>();
  private cachedCells = 0;
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
    this.sight = new Uint8Array(this.count);
    this.clearance = new Uint8Array(this.count);
    this.components = new Uint32Array(this.count);
    let walkable = 0;
    let excluded = 0;
    for (let cell = 0; cell < this.count; cell++) {
      const p = this.position(cell);
      this.sight[cell] = (grid.seeThrough ?? grid.walkable)(p) ? 1 : 0;
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
        for (const [dx, dy] of navigationDirections) {
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

  /** Portals and failed movement remain excluded as firing positions. Melee
   * retains the existing clear adjacent walking/no-corner-cut guarantee.
   */
  canAttack(from: Position, to: Position, range: number): boolean {
    return this.safe(from) && this.available(to) && attackDistance(from, to) <= range
      && projectileLineOfSight(from, to, p => this.sight[this.index(p)] === 1)
      && (range > 1 || this.clearApproach(from, to));
  }

  /** Spell destinations need a valid coordinate and directional LOS, not walkability. */
  canCast(from: Position, to: Position, range: number): boolean {
    return this.safe(from) && this.index(to)>=0 && attackDistance(from,to)<=range
      && projectileLineOfSight(from,to,p=>this.sight[this.index(p)]===1);
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
  plan(from: Position, to: Position, options: RouteOptions = {}): Position[] | null {
    const range = options.range ?? 0;
    const maxDistance = options.maxDistance ?? this.count - 1;
    if (!Number.isInteger(range) || range < 0 || range > MAX_MAP_DIMENSION || !Number.isInteger(maxDistance)
      || maxDistance < 0 || !this.safe(from) || this.index(to)<0 || (options.goal!=='cast' && !this.available(to) && distance(from, to) !== 0)) return null;
    const start = this.index(from);
    const target = this.index(to);
    const goalMode = options.goal === 'cast' ? 'cast' : options.goal === 'attack' ? 'attack' : 'walk';
    // One-cell melee also requires a clear walking approach. Longer attacks may
    // fire across a visible barrier into another walking component.
    if (((goalMode === 'walk' || goalMode === 'attack' && range <= 1) && this.components[start] !== this.components[target]) || Math.max(0, distance(from, to) - range) > maxDistance) return null;
    // Geometry is immutable. Only the effective temporary-block set invalidates
    // exact results; extend this key whenever a new route option is introduced.
    const key = `${start}:${target}:${range}:${maxDistance}:${options.avoidWalls === false ? 0 : 1}:${goalMode}`;
    if (this.routeCache.has(key)) {
      const cached = this.routeCache.get(key)!;
      this.routeCache.delete(key); this.routeCache.set(key, cached);
      return cached?.map(p => ({ ...p })) ?? null;
    }
    const cells = this.findRoute(from, to, range, maxDistance, options.avoidWalls !== false, goalMode);
    this.cacheRoute(key, cells);
    return cells;
  }
  private findRoute(from: Position, to: Position, range: number, maxDistance: number, avoidWalls: boolean, goalMode: 'walk' | 'attack' | 'cast'): Position[] | null {
    return findNavigationRoute({ count: this.count, clearance: this.clearance,
      index: p => this.index(p), position: cell => this.position(cell), step: (a, b) => this.step(a, b),
      clearWalkCorridor: (a, b) => this.clearWalkCorridor(a, b), clearApproach: (a, b) => this.clearApproach(a, b),
      canAttack: (a, b, r) => this.canAttack(a, b, r), canCast: (a, b, r) => this.canCast(a, b, r),
    }, from, to, range, maxDistance, avoidWalls, goalMode);
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

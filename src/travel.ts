import { filter, map, pipe, sort } from 'remeda';
import { completePlanning, runPlanning, type PlanningOptions, type PlanningWork } from './route-planning';
import { DEFAULT_MAP_POLICY, mapAllowed, PORTAL_COST, type MapPolicy } from './map-policy-logic';
import { GridNavigator, searchGrid } from './navigation';
import { MAX_MAP_DIMENSION, type PortalArea, type WalkGrid } from './navigation-logic';
import type { Position } from './protocol';

import { type PortalEdge, type TravelStep, TRAVEL_PORTALS, directions, cardinal, penalties, inside, sameArea, sameArrival, type Cell, type Path, copyCells, type WorldNode, type TravelPlannerOptions } from './travel-logic';

export { type PortalEdge, type TravelStep, TRAVEL_PORTALS, TRAVEL_SOURCE_COMMIT, type TravelPlannerOptions } from './travel-logic';

/** Small generic heap, used for bounded cell and world searches. */
class Heap<T> {
  private values: T[] = [];
  constructor(private readonly before: (a: T, b: T) => boolean) {}
  push(value: T): void {
    let i = this.values.length;
    this.values.push(value);
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.before(value, this.values[parent]!)) break;
      this.values[i] = this.values[parent]!;
      i = parent;
    }
    this.values[i] = value;
  }
  pop(): T | undefined {
    const first = this.values[0];
    const last = this.values.pop();
    if (first === undefined || last === undefined || this.values.length === 0) return first;
    let i = 0;
    while (i * 2 + 1 < this.values.length) {
      let child = i * 2 + 1;
      if (child + 1 < this.values.length && this.before(this.values[child + 1]!, this.values[child]!)) child++;
      if (!this.before(this.values[child]!, last)) break;
      this.values[i] = this.values[child]!;
      i = child;
    }
    this.values[i] = last;
    return first;
  }
}


/** Physical cells plus all excluded areas, independent of live movement state. */
class MapCells {
  readonly count: number;
  readonly tiles: Uint8Array;
  readonly clearance: Uint8Array;
  readonly owners = new Map<number, number[]>();
  constructor(readonly grid: WalkGrid, readonly areas: readonly PortalArea[]) {
    this.count = grid.width * grid.height;
    this.tiles = new Uint8Array(this.count);
    this.clearance = new Uint8Array(this.count);
  }
  *initialize(): PlanningWork<void> {
    const { grid, areas } = this;
    for (let cell = 0; cell < this.count; cell++) {
      if (cell % 128 === 0) yield 'map-analysis';
      if (grid.walkable(this.position(cell))) this.tiles[cell] = 2;
    }
    let areaCells = 0;
    for (const [owner, area] of areas.entries()) {
      for (let y = Math.max(0, area.y - area.halfHeight); y <= Math.min(grid.height - 1, area.y + area.halfHeight); y++) {
        for (let x = Math.max(0, area.x - area.halfWidth); x <= Math.min(grid.width - 1, area.x + area.halfWidth); x++) {
          const cell = x + y * grid.width;
          if (areaCells++ % 128 === 0) yield 'map-analysis';
          if (!this.tiles[cell]) continue;
          this.tiles[cell] = 1;
          const list = this.owners.get(cell) ?? [];
          list.push(owner);
          this.owners.set(cell, list);
        }
      }
    }
    yield* this.analyzeClearance();
  }
  index(p: Position): number {
    return Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.y >= 0
      && p.x < this.grid.width && p.y < this.grid.height ? p.x + p.y * this.grid.width : -1;
  }
  position(cell: number): Position { return { x: cell % this.grid.width, y: Math.floor(cell / this.grid.width) }; }
  safe(p: Position): boolean { return this.tiles[this.index(p)] === 2; }
  private *analyzeClearance(): PlanningWork<void> {
    this.clearance.fill(5);
    const queue = new Int32Array(this.count);
    let head = 0;
    let tail = 0;
    for (let cell = 0; cell < this.count; cell++) {
      if (cell % 128 === 0) yield 'map-analysis';
      if (this.tiles[cell] !== 2) { this.clearance[cell] = 0; queue[tail++] = cell; }
    }
    for (let cell = 0; cell < this.count; cell++) {
      if (cell % 128 === 0) yield 'map-analysis';
      const p = this.position(cell);
      if (this.tiles[cell] === 2 && (p.x === 0 || p.y === 0 || p.x === this.grid.width - 1 || p.y === this.grid.height - 1)) {
        this.clearance[cell] = 1;
        queue[tail++] = cell;
      }
    }
    while (head < tail) {
      if (head % 128 === 0) yield 'map-analysis';
      const cell = queue[head++]!;
      const nextDistance = this.clearance[cell]! + 1;
      if (nextDistance >= 5) continue;
      const p = this.position(cell);
      for (const [dx, dy] of cardinal) {
        const next = this.index({ x: p.x + dx, y: p.y + dy });
        if (next < 0 || this.clearance[next]! <= nextDistance) continue;
        this.clearance[next] = nextDistance;
        queue[tail++] = next;
      }
    }
  }
}


export class TravelPlanner {
  private readonly edges: readonly PortalEdge[];
  private readonly byMap = new Map<string, PortalEdge[]>();
  private readonly grid: (map: string) => WalkGrid | null;
  private readonly maps = new Map<string, MapCells>();
  private mapCellCount = 0;
  private readonly paths = new Map<string, { map: string; path: Path | null }>();
  private pathCells = 0;
  private readonly navigators = new Map<string, { map: string; navigator: GridNavigator }>();
  private readonly allowSameMap: boolean;
  constructor(options: TravelPlannerOptions = {}) {
    this.edges = options.edges ?? TRAVEL_PORTALS;
    this.grid = options.grid ?? searchGrid;
    this.allowSameMap = options.allowSameMap ?? false;
    for (const edge of this.edges) {
      const list = this.byMap.get(edge.fromMap) ?? [];
      list.push(edge);
      this.byMap.set(edge.fromMap, list);
    }
  }
  private mapCells(map: string): MapCells | null { return completePlanning(this.mapCellsWork(map)); }
  private *mapCellsWork(map: string): PlanningWork<MapCells | null> {
    const cached = this.maps.get(map);
    if (cached) {
      this.maps.delete(map); this.maps.set(map, cached);
      return cached;
    }
    const grid = this.grid(map);
    if (!grid || !Number.isInteger(grid.width) || !Number.isInteger(grid.height)
      || grid.width < 1 || grid.height < 1 || grid.width > MAX_MAP_DIMENSION || grid.height > MAX_MAP_DIMENSION) return null;
    const areas = grid.portals ?? this.byMap.get(map)?.map(edge => edge.area) ?? [];
    if (areas.some(a => ![a.x,a.y,a.halfWidth,a.halfHeight].every(Number.isInteger)
      || a.halfWidth < 0 || a.halfHeight < 0)) return null;
    const cells = new MapCells(grid, areas);
    yield* cells.initialize();
    // Another yielded query may have installed this map while analysis ran.
    const installed = this.maps.get(map);
    if (installed) return installed;
    this.maps.set(map, cells);
    this.mapCellCount += cells.count;
    // A custom grid provider may change between snapshots. Do not reuse a
    // result from an older snapshot after its analyzed grid was evicted.
    for (const [key, cached] of this.paths) if (cached.map === map) {
      this.pathCells -= cached.path?.cells.length ?? 0;
      this.paths.delete(key);
    }
    for (const [key, cached] of this.navigators) if (cached.map === map) this.navigators.delete(key);
    // Keep a normal multi-map trip warm. The two byte layers together stay
    // below 8 MB, and small custom grids still have a finite entry limit.
    while (this.maps.size > 32 || this.mapCellCount > 4_000_000) {
      const oldest = this.maps.keys().next().value!;
      this.mapCellCount -= this.maps.get(oldest)!.count;
      this.maps.delete(oldest);
    }
    return cells;
  }
  private edgeKnown(map: string, edge: PortalEdge): boolean {
    return edge.fromMap === map && (this.byMap.get(map) ?? []).some(e => e.id === edge.id
      && sameArea(e.area, edge.area) && sameArrival(e, edge));
  }
  private search(map: string, from: Position, edge: PortalEdge | null, avoidWalls: boolean): Path | null {
    return completePlanning(this.searchWork(map, from, edge, avoidWalls));
  }
  private *searchWork(map: string, from: Position, edge: PortalEdge | null, avoidWalls: boolean): PlanningWork<Path | null> {
    const mapCells = yield* this.mapCellsWork(map);
    if (!mapCells || (edge && !this.edgeKnown(map, edge))) return null;
    const key = `${map}:${from.x}:${from.y}:${edge?.id ?? 'escape'}:${avoidWalls ? 1 : 0}`;
    const cached = this.paths.get(key);
    if (cached) {
      this.paths.delete(key); this.paths.set(key,cached);
      return cached.path;
    }
    const path = yield* this.findPath(map,mapCells,from,edge,avoidWalls);
    // Cache exact, collision-checked approaches rather than bypassing planning
    // for nearby positions. Bound both the number of entries and stored cells.
    if (this.maps.get(map) === mapCells && (!path || path.cells.length <= 60_000)) {
      this.pathCells -= this.paths.get(key)?.path?.cells.length ?? 0;
      this.paths.set(key,{ map,path }); this.pathCells += path?.cells.length ?? 0;
      while (this.paths.size > 128 || this.pathCells > 60_000) {
        const first = this.paths.keys().next().value!;
        this.pathCells -= this.paths.get(first)!.path?.cells.length ?? 0;
        this.paths.delete(first);
      }
    }
    return path;
  }
  private *findPath(map: string, mapCells: MapCells, from: Position, edge: PortalEdge | null, avoidWalls: boolean): PlanningWork<Path | null> {
    const { count, tiles, clearance, owners } = mapCells;
    const start = mapCells.index(from);
    if (start < 0 || !tiles[start]) return null;
    if (!edge && tiles[start] === 2) return { cells: [{ ...from }], cost: 0 };
    const initialOwners = new Set(owners.get(start) ?? []);
    // A portal can overlap another rectangle. Permit entry only when every
    // possible trigger there has the same verified destination and arrival.
    const equivalent = edge ? new Set(mapCells.areas.flatMap((area, i) => {
      const candidates = (this.byMap.get(map) ?? []).filter(e => sameArea(e.area, area));
      return candidates.length && candidates.every(e => sameArrival(e, edge)) ? [i] : [];
    })) : new Set<number>();
    const entry = (cell: number): boolean => !!edge && inside(mapCells.position(cell), edge.area)
      && tiles[cell] === 1 && (owners.get(cell) ?? []).every(owner => equivalent.has(owner));
    const allowed = (cell: number, escaped: boolean): boolean => cell >= 0 && !!tiles[cell]
      && (tiles[cell] === 2 || (!escaped && (owners.get(cell) ?? []).every(owner => initialOwners.has(owner)))
        || (escaped && entry(cell)));
    const heuristic = (p: Position): number => {
      if (!edge) return 0;
      const dx = Math.max(0, Math.abs(p.x - edge.area.x) - edge.area.halfWidth);
      const dy = Math.max(0, Math.abs(p.y - edge.area.y) - edge.area.halfHeight);
      return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
    };
    const costs = new Float64Array(count * 2); costs.fill(Infinity);
    const parents = new Int32Array(count * 2); parents.fill(-1);
    const closed = new Uint8Array(count * 2);
    const open = new Heap<Cell>((a,b) => a.priority < b.priority || (a.priority === b.priority && a.cost > b.cost));
    const initial = start + (tiles[start] === 2 ? count : 0);
    costs[initial] = 0;
    open.push({ state: initial, cost: 0, priority: heuristic(from) });
    let current: Cell | undefined;
    let visited = 0;
    while ((current = open.pop())) {
      if (visited++ % 128 === 0) yield 'local-search';
      if (closed[current.state] || costs[current.state] !== current.cost) continue;
      closed[current.state] = 1;
      const cell = current.state % count;
      const p = mapCells.position(cell);
      const escaped = current.state >= count;
      if ((!edge && tiles[cell] === 2) || (edge && escaped && entry(cell))) {
        const cells: Position[] = [];
        for (let state = current.state; state >= 0; state = parents[state]!) {
          if (cells.length % 128 === 0) yield 'local-search';
          cells.push(mapCells.position(state % count));
        }
        return { cells: cells.reverse(), cost: current.cost };
      }
      for (const [dx,dy] of directions) {
        const next = { x: p.x + dx, y: p.y + dy };
        const index = mapCells.index(next);
        if (!allowed(index, escaped)) continue;
        if (dx && dy && (!allowed(mapCells.index({ x: p.x + dx, y: p.y }), escaped)
          || !allowed(mapCells.index({ x: p.x, y: p.y + dy }), escaped))) continue;
        const state = index + (escaped || tiles[index] === 2 ? count : 0);
        if (closed[state]) continue;
        const cost = current.cost + (dx && dy ? 14 : 10) + (avoidWalls ? penalties[clearance[index]!]! : 0);
        if (cost >= costs[state]!) continue;
        costs[state] = cost; parents[state] = current.state;
        open.push({ state, cost, priority: cost + heuristic(next) });
      }
    }
    return null;
  }
  planPortalApproach(map: string, from: Position, edge: PortalEdge, avoidWalls = true): Position[] | null {
    return this.search(map, from, edge, avoidWalls)?.cells.map(p => ({ ...p })) ?? null;
  }
  planArrivalEscape(map: string, from: Position, avoidWalls = true): Position[] | null {
    return this.search(map, from, null, avoidWalls)?.cells.map(p => ({ ...p })) ?? null;
  }
  /** Validate accepted walk legs using only their explicit portal corridor. */
  travelNavigator(map: string, cells: readonly Position[]): GridNavigator | null {
    const source = this.mapCells(map);
    if (!source || !cells.length || cells.some(p => source.index(p) < 0 || !source.tiles[source.index(p)])) return null;
    const allowed = new Set(cells.map(p => source.index(p)));
    // A diagonal route also relies on its two orthogonal corner cells. Keep
    // those checks intact when the initial escape is inside a trigger area.
    for (let i = 1; i < cells.length; i++) {
      const a = cells[i - 1]!; const b = cells[i]!;
      if (a.x !== b.x && a.y !== b.y) {
        allowed.add(source.index({ x: a.x,y: b.y }));
        allowed.add(source.index({ x: b.x,y: a.y }));
      }
    }
    // Every base-safe cell is always available. Only the explicitly allowed
    // portal cells affect this navigator, so route suffixes can reuse it.
    const portalCells = pipe([...allowed], filter(cell => source.tiles[cell] === 1), sort((a,b) => a - b));
    const key = `${map}:${portalCells.join(',')}`;
    const cached = this.navigators.get(key);
    if (cached) { this.navigators.delete(key); this.navigators.set(key,cached); return cached.navigator; }
    const navigator = new GridNavigator({ width: source.grid.width, height: source.grid.height,
      walkable: p => !!source.tiles[source.index(p)] && (source.tiles[source.index(p)] === 2 || allowed.has(source.index(p))) }, []);
    this.navigators.set(key,{ map,navigator });
    if (this.navigators.size > 4) this.navigators.delete(this.navigators.keys().next().value!);
    return navigator;
  }
  private *distancesTo(toMap: string, policy: MapPolicy = DEFAULT_MAP_POLICY, origin = ''): PlanningWork<Map<string, number>> {
    const incoming = new Map<string, string[]>();
    for (const edge of this.edges) {
      yield 'heuristic';
      if ((!this.allowSameMap && edge.fromMap === edge.toMap) || !mapAllowed(policy,edge.toMap) || (!mapAllowed(policy,edge.fromMap) && edge.fromMap !== origin)) continue;
      const maps = incoming.get(edge.toMap) ?? []; maps.push(edge.fromMap); incoming.set(edge.toMap, maps);
    }
    const distances = new Map([[toMap,0]]);
    const queue = [toMap];
    for (let head = 0; head < queue.length; head++) for (const map of incoming.get(queue[head]!) ?? []) {
      yield 'heuristic';
      if (distances.has(map)) continue;
      distances.set(map, distances.get(queue[head]!)! + 1); queue.push(map);
    }
    return distances;
  }
  /** Fewest reachable portal crossings, then least collision-aware walking cost. */
  routeBetweenMaps(fromMap: string, from: Position, toMap: string, avoidWalls = true, policy: MapPolicy = DEFAULT_MAP_POLICY): TravelStep[] | null {
    return completePlanning(this.routeWork(fromMap, from, toMap, avoidWalls, policy));
  }
  /** Detached input is shared by the native UI and injected bridge. */
  routeBetweenMapsAsync(fromMap: string, from: Position, toMap: string, avoidWalls = true, policy: MapPolicy = DEFAULT_MAP_POLICY, options: PlanningOptions = {}): Promise<TravelStep[] | null> {
    return runPlanning(this.routeWork(fromMap, { ...from }, toMap, avoidWalls, structuredClone(policy)), options);
  }
  private *routeWork(fromMap: string, from: Position, toMap: string, avoidWalls: boolean, policy: MapPolicy): PlanningWork<TravelStep[] | null> {
    if (!mapAllowed(policy,toMap)) return null;
    if (policy.mode === 'weighted') return yield* this.weightedRoute(fromMap,from,toMap,avoidWalls,policy);
    if (!(yield* this.mapCellsWork(fromMap)) || !(yield* this.mapCellsWork(toMap)) || !(yield* this.searchWork(fromMap, from, null, avoidWalls))) return null;
    if (fromMap === toMap) return [];
    const distances = yield* this.distancesTo(toMap,policy,fromMap);
    if (!distances.has(fromMap)) return null;
    const key = (map: string, p: Position) => `${map}:${p.x}:${p.y}`;
    const initial: WorldNode = { key: key(fromMap,from), map: fromMap, position: { ...from }, hops: 0,
      cost: 0, estimate: distances.get(fromMap)!, parent: null, step: null, pending: null };
    const best = new Map([[initial.key,initial]]);
    const open = new Heap<WorldNode>((a,b) => a.estimate < b.estimate || (a.estimate === b.estimate && a.cost < b.cost));
    open.push(initial);
    let current: WorldNode | undefined;
    let expanded = 0;
    while ((current = open.pop())) {
      yield 'world-search';
      if (current.pending) {
        // Validate an edge only when its minimum crossings and geometric
        // walking lower bound could beat the next fully verified route.
        const parent = current.parent!;
        if (best.get(parent.key) !== parent) continue;
        const previous = best.get(current.key);
        if (previous && (previous.hops < current.hops || previous.hops === current.hops && previous.cost <= current.cost)) continue;
        const approach = yield* this.searchWork(parent.map,parent.position,current.pending,avoidWalls);
        if (!approach) continue;
        const target = yield* this.mapCellsWork(current.map);
        if (!target || !target.tiles[target.index(current.position)]) continue;
        const cost = parent.cost + approach.cost;
        if (previous && previous.hops === current.hops && previous.cost <= cost) continue;
        const node: WorldNode = { ...current, cost, pending: null,
          step: { portal: current.pending,cells: approach.cells } };
        best.set(node.key,node); open.push(node);
        continue;
      }
      if (best.get(current.key) !== current) continue;
      if (++expanded > 4096 || current.hops > 64) return null;
      if (current.map === toMap) {
        const escape = yield* this.searchWork(current.map, current.position, null, avoidWalls);
        const finalEscape = escape ? yield* copyCells(escape.cells) : null;
        if (!finalEscape) continue;
        const steps: TravelStep[] = [];
        for (let node: WorldNode | null = current; node?.step; node = node.parent)
          steps.push({ ...node.step,cells: yield* copyCells(node.step.cells),arrivalEscape: [] });
        steps.reverse();
        for (let i = 0; i < steps.length; i++) {
          const next = steps[i + 1]?.cells;
          if (!next) { steps[i]!.arrivalEscape = finalEscape; continue; }
          const target = (yield* this.mapCellsWork(steps[i]!.portal.toMap))!;
          const exit = next.findIndex(p => target.safe(p));
          if (exit < 0) return null;
          steps[i]!.arrivalEscape = next.slice(0, exit + 1);
        }
        return steps;
      }
      for (const edge of this.byMap.get(current.map) ?? []) {
        if ((!this.allowSameMap && edge.fromMap === edge.toMap) || !mapAllowed(policy,edge.toMap) || !distances.has(edge.toMap)) continue;
        const destinationKey = key(edge.toMap, edge.arrival);
        const hops = current.hops + 1;
        const previous = best.get(destinationKey);
        if (previous && previous.hops < hops) continue;
        const dx = Math.max(0,Math.abs(current.position.x - edge.area.x) - edge.area.halfWidth);
        const dy = Math.max(0,Math.abs(current.position.y - edge.area.y) - edge.area.halfHeight);
        const cost = current.cost + 10 * Math.max(dx,dy) + 4 * Math.min(dx,dy);
        if (previous && previous.hops === hops && previous.cost <= cost) continue;
        const node: WorldNode = { key: destinationKey, map: edge.toMap, position: { ...edge.arrival }, hops, cost,
          estimate: hops + distances.get(edge.toMap)!, parent: current, step: null,pending: edge };
        open.push(node);
      }
    }
    return null;
  }
  /** Weighted Dijkstra retains a Pareto frontier of score and hops per exact
   * arrival. A cheap label near the hop cap cannot erase a more expensive
   * label which still has enough crossings available. Physical searches/cache
   * remain policy independent; every graph edge is checked against this snapshot.
   */
  private *weightedRoute(fromMap:string,from:Position,toMap:string,avoidWalls:boolean,policy:MapPolicy):PlanningWork<TravelStep[]|null> {
    if (!(yield* this.mapCellsWork(fromMap)) || !(yield* this.mapCellsWork(toMap)) || !(yield* this.searchWork(fromMap,from,null,avoidWalls))) return null;
    if(fromMap===toMap)return [];
    type Label={key:string;map:string;position:Position;score:number;estimate:number;hops:number;sequence:number;parent:Label|null;step:Omit<TravelStep,'arrivalEscape'>|null;terminal?:Path;pending?:PortalEdge};
    const key=(map:string,p:Position)=>`${map}:${p.x}:${p.y}`;
    let sequence=0,expanded=0;
    const labels=new Map<string,Label[]>();
    const remaining=yield* this.weightedPotential(toMap,policy);
    const initialEstimate=remaining(fromMap,from);if(!Number.isFinite(initialEstimate))return null;
    const heap=new Heap<Label>((a,b)=>a.estimate<b.estimate||(a.estimate===b.estimate&&(a.score<b.score||a.score===b.score&&(a.hops<b.hops||a.hops===b.hops&&a.sequence<b.sequence))));
    const first:Label={key:key(fromMap,from),map:fromMap,position:{...from},score:0,estimate:initialEstimate,hops:0,sequence:sequence++,parent:null,step:null};
    labels.set(first.key,[first]);heap.push(first);
    const penalties=new Map(map(policy.penalties, p=>[p.map,p.cost] as const));
    const distances=yield* this.distancesTo(toMap,policy,fromMap);
    let current:Label|undefined;
    while((current=heap.pop())){
      yield 'world-search';
      if(current.pending){
        const parent=current.parent!;
        if(!labels.get(parent.key)?.includes(parent))continue;
        const previous=labels.get(current.key)??[];
        if(previous.some(l=>l.score<=current!.score&&l.hops<=current!.hops))continue;
        const approach=yield* this.searchWork(parent.map,parent.position,current.pending,avoidWalls);if(!approach)continue;
        const score=parent.score+approach.cost+PORTAL_COST+(penalties.get(parent.map)??0);
        const next:Label={...current,score,estimate:Math.floor(score)+remaining(current.map,current.position),pending:undefined,step:{portal:current.pending,cells:approach.cells}};
        if(previous.some(l=>l.score<=next.score&&l.hops<=next.hops))continue;
        labels.set(next.key,[...previous.filter(l=>!(next.score<=l.score&&next.hops<=l.hops)),next]);heap.push(next);continue;
      }
      if(current.terminal){
        const steps:TravelStep[]=[];
        for(let node:Label|null=current.parent;node?.step;node=node.parent)steps.push({...node.step,cells:yield* copyCells(node.step.cells),arrivalEscape:[]});
        steps.reverse();
        for(let i=0;i<steps.length;i++){
          const next=steps[i+1]?.cells;
          if(!next){steps[i]!.arrivalEscape=yield* copyCells(current.terminal.cells);continue;}
          const target=(yield* this.mapCellsWork(steps[i]!.portal.toMap))!,exit=next.findIndex(p=>target.safe(p));
          if(exit<0)return null;
          steps[i]!.arrivalEscape=yield* copyCells(next,exit+1);
        }
        return steps;
      }
      if(!labels.get(current.key)?.includes(current))continue;
      if(++expanded>4096)return null;
      if(current.map===toMap){
        const escape=yield* this.searchWork(current.map,current.position,null,avoidWalls);
        if(escape)heap.push({...current,score:current.score+escape.cost,estimate:current.score+escape.cost,sequence:sequence++,parent:current,terminal:escape});
        continue;
      }
      if(current.hops>=64)continue;
      for(const edge of this.byMap.get(current.map)??[]){
        if((!this.allowSameMap&&edge.fromMap===edge.toMap)||!mapAllowed(policy,edge.toMap)||!distances.has(edge.toMap)||current.hops+1+distances.get(edge.toMap)!>64)continue;
        const target=yield* this.mapCellsWork(edge.toMap);if(!target||!target.tiles[target.index(edge.arrival)])continue;
        const dx=Math.max(0,Math.abs(current.position.x-edge.area.x)-edge.area.halfWidth),dy=Math.max(0,Math.abs(current.position.y-edge.area.y)-edge.area.halfHeight);
        const score=current.score+10*Math.max(dx,dy)+4*Math.min(dx,dy)+PORTAL_COST+(penalties.get(current.map)??0),bound=remaining(edge.toMap,edge.arrival);
        if(!Number.isFinite(bound))continue;
        const next:Label={key:key(edge.toMap,edge.arrival),map:edge.toMap,position:{...edge.arrival},score,estimate:Math.floor(score)+bound,hops:current.hops+1,sequence:sequence++,parent:current,step:null,pending:edge};
        const old=labels.get(next.key)??[];
        if(old.some(l=>l.score<=next.score&&l.hops<=next.hops))continue;
        heap.push(next);
      }
    }
    return null;
  }

  /** Reverse Dijkstra over exact portal arrivals supplies a consistent lower
   * bound, without reading any physical grid. Each abstract edge ignores walls,
   * corners and trigger exclusions, so its octile distance cannot exceed the
   * verified walking cost. Terminal escape has lower bound zero. Rounding only
   * the heuristic penalties down keeps these sums exact integers even when the
   * configured score has fractional penalties. Frontier estimates also round
   * their accumulated score down, avoiding floating summation overestimates;
   * actual scores, terminal scores and Pareto labels are unchanged. The fixed
   * catalog bounds this temporary graph, which is discarded
   * after the query rather than retaining another planner per policy.
   */
  private *weightedPotential(toMap:string,policy:MapPolicy):PlanningWork<(map:string,p:Position)=>number> {
    const key=(map:string,p:Position)=>`${map}:${p.x}:${p.y}`;
    const penalties=new Map(map(policy.penalties, p=>[p.map,Math.floor(p.cost)] as const));
    const departures=(map:string)=>(this.byMap.get(map)??[]).filter(e=>(this.allowSameMap||e.fromMap!==e.toMap)&&mapAllowed(policy,e.toMap));
    const cost=(map:string,p:Position,e:PortalEdge)=>{
      const dx=Math.max(0,Math.abs(p.x-e.area.x)-e.area.halfWidth),dy=Math.max(0,Math.abs(p.y-e.area.y)-e.area.halfHeight);
      return 10*Math.max(dx,dy)+4*Math.min(dx,dy)+PORTAL_COST+(penalties.get(map)??0);
    };
    const arrivals=new Map<string,{map:string;position:Position}>();
    for(const edges of this.byMap.values())for(const e of edges) { yield 'heuristic'; if(mapAllowed(policy,e.toMap))arrivals.set(key(e.toMap,e.arrival),{map:e.toMap,position:e.arrival}); }
    const reverse=new Map<string,Array<{key:string;cost:number}>>();
    for(const [origin,a] of arrivals)for(const edge of departures(a.map)){
      yield 'heuristic';
      const destination=key(edge.toMap,edge.arrival),incoming=reverse.get(destination)??[];
      incoming.push({key:origin,cost:cost(a.map,a.position,edge)});reverse.set(destination,incoming);
    }
    const distances=new Map<string,number>();
    const heap=new Heap<{key:string;cost:number}>((a,b)=>a.cost<b.cost);
    for(const [id,a] of arrivals)if(a.map===toMap){distances.set(id,0);heap.push({key:id,cost:0});}
    let current:{key:string;cost:number}|undefined;
    while((current=heap.pop())){
      yield 'heuristic';
      if(distances.get(current.key)!==current.cost)continue;
      for(const edge of reverse.get(current.key)??[]){
        yield 'heuristic';
        const distance=current.cost+edge.cost;
        if(distance<(distances.get(edge.key)??Infinity)){distances.set(edge.key,distance);heap.push({key:edge.key,cost:distance});}
      }
    }
    return(map,p)=>{
      if(map===toMap)return 0;
      const known=distances.get(key(map,p));if(known!==undefined)return known;
      // The initial point may be arbitrary or on a forbidden departure map.
      // Only its outgoing edges are considered; forbidden reentry stays absent.
      let bound=Infinity;
      for(const edge of departures(map))bound=Math.min(bound,cost(map,p,edge)+(distances.get(key(edge.toMap,edge.arrival))??Infinity));
      return bound;
    };
  }

}


const planner = new TravelPlanner();

export const routeBetweenMaps = (fromMap: string, from: Position, toMap: string, avoidWalls = true, policy: MapPolicy = DEFAULT_MAP_POLICY): TravelStep[] | null =>
  planner.routeBetweenMaps(fromMap,from,toMap,avoidWalls,policy);

export const planPortalApproach = (map: string, from: Position, edge: PortalEdge, avoidWalls = true): Position[] | null =>
  planner.planPortalApproach(map,from,edge,avoidWalls);

export const planArrivalEscape = (map: string, from: Position, avoidWalls = true): Position[] | null =>
  planner.planArrivalEscape(map,from,avoidWalls);

export const travelNavigator = (map: string, cells: readonly Position[]): GridNavigator | null => planner.travelNavigator(map,cells);


export const routeBetweenMapsAsync = (fromMap: string, from: Position, toMap: string, avoidWalls = true, policy: MapPolicy = DEFAULT_MAP_POLICY, options: PlanningOptions = {}): Promise<TravelStep[] | null> =>
  planner.routeBetweenMapsAsync(fromMap, from, toMap, avoidWalls, policy, options);

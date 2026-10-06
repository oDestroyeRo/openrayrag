import type { Position } from './protocol';
import { distance, minimumRouteCost } from './navigation-logic';

/** Search reads one synchronous geometry view; all queues and ledgers belong to this invocation. */
export interface NavigationSearchView {
  count: number;
  clearance: Uint8Array;
  index(position: Position): number;
  position(cell: number): Position;
  step(from: Position, to: Position): boolean;
  clearWalkCorridor(from: Position, to: Position): boolean;
  clearApproach(from: Position, to: Position): boolean;
  canAttack(from: Position, to: Position, range: number): boolean;
  canCast(from: Position, to: Position, range: number): boolean;
}

export const navigationDirections = [[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]] as const;

const wallPenalties = [0, 60, 50, 20, 10, 0] as const;

interface OpenCell { cell: number; cost: number; priority: number }

interface SearchScratch { costs: Float64Array | number[]; parents: Int32Array | number[]; seen: Uint32Array | number[]; closed: Uint32Array | number[]; stamp: number; queue?: Int32Array | number[] }

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
export function findNavigationRoute(
  view: NavigationSearchView, from: Position, to: Position, range: number, maxDistance: number,
  avoidWalls: boolean, goalMode: 'walk' | 'attack' | 'cast',
): Position[] | null {
  let scratch: SearchScratch | null = null;
  // Bounded local queries avoid allocating full-map buffers. Larger searches
  // retain dense typed arrays so sparse property lookups cannot dominate them.
  const dense = maxDistance > 64 || view.count <= 4096;
  const origin = dense ? 0 : view.index(from);
  function beginSearch(): SearchScratch {
    scratch ??= { costs: dense ? new Float64Array(view.count) : [], parents: dense ? new Int32Array(view.count) : [],
      seen: dense ? new Uint32Array(view.count) : [], closed: dense ? new Uint32Array(view.count) : [], stamp: 0 };
    scratch.stamp++;
    return scratch;
  }
  function reconstructPath(parents: Int32Array | number[], end: number): Position[] {
    const cells: Position[] = [];
    for (let cell = end; cell >= 0; cell = parents[cell - origin]!) cells.push(view.position(cell));
    return cells.reverse();
  }
  function shortestSteps(from: Position, goal: (p: Position) => boolean, maxDistance: number): Position[] | null {
    const workspace = beginSearch();
    const { parents, costs: steps, seen, stamp } = workspace;
    const queue = workspace.queue ??= dense ? new Int32Array(view.count) : [];
    const start = view.index(from);
    let head = 0;
    let tail = 1;
    queue[0] = start;
    steps[start - origin] = 0; parents[start - origin] = -1; seen[start - origin] = stamp;
    while (head < tail) {
      const cell = queue[head++]!;
      const p = view.position(cell);
      if (goal(p)) return reconstructPath(parents, cell);
      if (steps[cell - origin]! >= maxDistance) continue;
      for (const [dx, dy] of navigationDirections) {
        const next = { x: p.x + dx, y: p.y + dy };
        const index = view.index(next);
        if (index < 0 || seen[index - origin] === stamp || !view.step(p, next)) continue;
        steps[index - origin] = steps[cell - origin]! + 1; seen[index - origin] = stamp;
        parents[index - origin] = cell;
        queue[tail++] = index;
      }
    }
    return null;
  }

  const goal = goalMode === 'cast' ? (p:Position)=>view.canCast(p,to,range) : goalMode === 'attack' ? (p: Position) => view.canAttack(p, to, range)
    : (p: Position) => distance(p, to) <= range && view.clearApproach(p, to);
  // Prove capped local failures before exploring the whole component. This
  // square bounds every cell BFS can reach within the cap; successful queries
  // still use the original weighted search and its exact tie ordering.
  let cappedRoute: Position[] | undefined;
  if (maxDistance <= 64 && (2 * maxDistance + 1) ** 2 < view.count / 2 && !view.clearWalkCorridor(from, to)) {
    const reachable = shortestSteps(from, goal, maxDistance);
    if (!reachable) return null;
    cappedRoute = reachable;
  }
  const heuristic = (p: Position) => minimumRouteCost(p, to, range);
  const { costs, parents, seen, closed, stamp } = beginSearch();
  const start = view.index(from);
  const open = new RouteHeap();
  costs[start - origin] = 0; parents[start - origin] = -1; seen[start - origin] = stamp;
  open.push({ cell: start, cost: 0, priority: heuristic(from) });
  let current: OpenCell | undefined;
  while ((current = open.pop())) {
    if (closed[current.cell - origin] === stamp || current.cost !== costs[current.cell - origin]) continue;
    closed[current.cell - origin] = stamp;
    const p = view.position(current.cell);
    if (goal(p)) {
      const route = reconstructPath(parents, current.cell);
      if (route.length - 1 <= maxDistance) return route;
      // A cheaper wall-aware detour can exceed a step cap. Try a shortest-step
      // route so a narrow but valid corridor is still usable within that cap.
      return cappedRoute ?? shortestSteps(from, goal, maxDistance);
    }
    for (const [dx, dy] of navigationDirections) {
      const next = { x: p.x + dx, y: p.y + dy };
      if (!view.step(p, next)) continue;
      const cell = view.index(next);
      if (closed[cell - origin] === stamp) continue;
      const wallCost = avoidWalls ? wallPenalties[view.clearance[cell]!]! : 0;
      const cost = current.cost + (dx && dy ? 14 : 10) + wallCost;
      if (seen[cell - origin] === stamp && cost >= costs[cell - origin]!) continue;
      costs[cell - origin] = cost; seen[cell - origin] = stamp;
      parents[cell - origin] = current.cell;
      open.push({ cell, cost, priority: cost + heuristic(next) });
    }
  }
  return null;
}

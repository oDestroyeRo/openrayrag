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

interface SearchScratch {
  costs: Float64Array; parents: Int32Array; seen: Uint8Array; closed: Uint8Array;
  size: number; stamp: number; queue?: Int32Array;
}

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
  const last = view.position(view.count - 1), gridWidth = last.x + 1, gridHeight = last.y + 1;
  let compact = maxDistance <= 64 && view.count > 4096;
  const minX = compact ? Math.max(0, from.x - maxDistance) : 0;
  const minY = compact ? Math.max(0, from.y - maxDistance) : 0;
  const width = compact ? Math.min(gridWidth - 1, from.x + maxDistance) - minX + 1 : gridWidth;
  const height = compact ? Math.min(gridHeight - 1, from.y + maxDistance) - minY + 1 : gridHeight;
  function createScratch(size: number, stamp = 0): SearchScratch {
    const buffer = new ArrayBuffer(size * 14);
    return { costs: new Float64Array(buffer, 0, size), parents: new Int32Array(buffer, size * 8, size),
      seen: new Uint8Array(buffer, size * 12, size), closed: new Uint8Array(buffer, size * 13, size), size, stamp };
  }
  function beginSearch(): SearchScratch {
    scratch ??= createScratch(width * height);
    scratch.stamp++;
    return scratch;
  }
  function searchIndex(cell: number, point: Position): number {
    if (!compact) return cell;
    const y = point.y - minY, x = point.x - minX;
    if (x >= 0 && y >= 0 && x < width && y < height) return x + y * width;
    // A* may prefer a cheaper detour beyond the step cap before falling back
    // to BFS. Grow its ledger without pruning cells or changing heap ordering.
    const previous = scratch!, expanded = createScratch(view.count, previous.stamp);
    for (let index = 0; index < previous.size; index++) {
      if (!previous.seen[index]) continue;
      const global = index % width + minX + (Math.floor(index / width) + minY) * gridWidth;
      expanded.costs[global] = previous.costs[index]!;
      expanded.parents[global] = previous.parents[index]!;
      expanded.seen[global] = previous.seen[index]!;
      expanded.closed[global] = previous.closed[index]!;
    }
    Object.assign(previous, expanded);
    compact = false;
    return cell;
  }
  function reconstructPath(workspace: SearchScratch, end: number): Position[] {
    const cells: Position[] = [];
    for (let cell = end; cell >= 0;) {
      const point = view.position(cell);
      cells.push(point); cell = workspace.parents[searchIndex(cell, point)]!;
    }
    return cells.reverse();
  }
  function shortestSteps(from: Position, goal: (p: Position) => boolean, maxDistance: number): Position[] | null {
    const workspace = beginSearch();
    const { stamp } = workspace;
    const queue = workspace.queue ??= new Int32Array(workspace.size);
    const start = view.index(from), startIndex = searchIndex(start, from);
    let head = 0;
    let tail = 1;
    queue[0] = start;
    workspace.costs[startIndex] = 0; workspace.parents[startIndex] = -1; workspace.seen[startIndex] = stamp;
    while (head < tail) {
      const cell = queue[head++]!, p = view.position(cell), cellIndex = searchIndex(cell, p);
      if (goal(p)) return reconstructPath(workspace, cell);
      if (workspace.costs[cellIndex]! >= maxDistance) continue;
      for (const [dx, dy] of navigationDirections) {
        const next = { x: p.x + dx, y: p.y + dy };
        const index = view.index(next);
        if (index < 0) continue;
        const nextIndex = searchIndex(index, next);
        if (workspace.seen[nextIndex] === stamp || !view.step(p, next)) continue;
        workspace.costs[nextIndex] = workspace.costs[cellIndex]! + 1; workspace.seen[nextIndex] = stamp;
        workspace.parents[nextIndex] = cell;
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
  const workspace = beginSearch();
  const { stamp } = workspace;
  const start = view.index(from), startIndex = searchIndex(start, from);
  const open = new RouteHeap();
  workspace.costs[startIndex] = 0; workspace.parents[startIndex] = -1; workspace.seen[startIndex] = stamp;
  open.push({ cell: start, cost: 0, priority: heuristic(from) });
  let current: OpenCell | undefined;
  while ((current = open.pop())) {
    const p = view.position(current.cell), currentIndex = searchIndex(current.cell, p);
    if (workspace.closed[currentIndex] === stamp || current.cost !== workspace.costs[currentIndex]) continue;
    workspace.closed[currentIndex] = stamp;
    if (goal(p)) {
      const route = reconstructPath(workspace, current.cell);
      if (route.length - 1 <= maxDistance) return route;
      // A cheaper wall-aware detour can exceed a step cap. Try a shortest-step
      // route so a narrow but valid corridor is still usable within that cap.
      return cappedRoute ?? shortestSteps(from, goal, maxDistance);
    }
    for (const [dx, dy] of navigationDirections) {
      const next = { x: p.x + dx, y: p.y + dy };
      if (!view.step(p, next)) continue;
      const cell = view.index(next), cellIndex = searchIndex(cell, next);
      if (workspace.closed[cellIndex] === stamp) continue;
      const wallCost = avoidWalls ? wallPenalties[view.clearance[cell]!]! : 0;
      const cost = current.cost + (dx && dy ? 14 : 10) + wallCost;
      if (workspace.seen[cellIndex] === stamp && cost >= workspace.costs[cellIndex]!) continue;
      workspace.costs[cellIndex] = cost; workspace.seen[cellIndex] = stamp;
      workspace.parents[cellIndex] = current.cell;
      open.push({ cell, cost, priority: cost + heuristic(next) });
    }
  }
  return null;
}

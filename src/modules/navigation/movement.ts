import type { Position, Walk } from '../protocol/protocol';

export function walkDuration(walk: Walk): number {
  let seconds = walk.cells.length > 1 ? Math.max(0, walk.firstSeconds) : 0;
  for (let i = 2; i < walk.cells.length; i++) {
    const a = walk.cells[i - 1]!,
      b = walk.cells[i]!;
    seconds += walk.secondsPerCell * (a.x !== b.x && a.y !== b.y ? 1.4142 : 1);
  }
  return seconds * 1000;
}

// Estimates follow the server-accepted route and timing, never the requested destination.
export function walkPosition(walk: Walk, elapsedMs: number): Position {
  let origin = walk.origin;
  let remaining = Math.max(0, elapsedMs) / 1000;
  if (walk.locked || walk.cells.length < 2)
    return { x: Math.floor(origin.x), y: Math.floor(origin.y) };
  for (let i = 1; i < walk.cells.length; i++) {
    const cell = walk.cells[i]!,
      previous = walk.cells[i - 1]!;
    const duration =
      i === 1
        ? Math.max(0, walk.firstSeconds)
        : walk.secondsPerCell * (cell.x !== previous.x && cell.y !== previous.y ? 1.4142 : 1);
    const destination = { x: cell.x + 0.5, y: cell.y + 0.5 };
    if (remaining < duration) {
      const fraction = remaining / duration;
      return {
        x: Math.floor(origin.x + (destination.x - origin.x) * fraction),
        y: Math.floor(origin.y + (destination.y - origin.y) * fraction),
      };
    }
    remaining -= duration;
    origin = destination;
  }
  return { ...walk.cells.at(-1)! };
}

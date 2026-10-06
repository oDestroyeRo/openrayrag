import gridData from './data/navigation-maps.json';
import type { Position } from './protocol';

export const NAVIGATION_MAPS = Object.keys(gridData);

// Includes the 416-cell Payon fields; shared with status validation and extraction.
export const MAX_MAP_DIMENSION = 512;

export const distance = (a: Position, b: Position): number => Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));

/** A square goal is a superset of rounded Euclidean attack goals, so this
 * movement-cost bound remains admissible for both modes without wall penalties.
 */
export function minimumRouteCost(from: Position, to: Position, range = 0): number {
  const dx = Math.max(0, Math.abs(from.x - to.x) - range);
  const dy = Math.max(0, Math.abs(from.y - to.y) - range);
  return 10 * Math.max(dx, dy) + 4 * Math.min(dx, dy);
}

export interface PortalArea extends Position { halfWidth: number; halfHeight: number }

interface GridData { width: number; height: number; walkableBitsBase64: string; snipableOnlyBitsBase64: string; portals: PortalArea[] }

const maps: Record<string, GridData> = gridData;

export interface WalkGrid {
  width: number; height: number; walkable: (p: Position) => boolean;
  seeThrough?: (p: Position) => boolean;
  portals?: readonly PortalArea[];
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

export interface RouteOptions { range?: number; maxDistance?: number; avoidWalls?: boolean; goal?: 'walk' | 'attack' | 'cast' }

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
/** Published geometry metadata; consulting it never decodes or caches a grid. */
export function mapDimensions(map: string): { width: number; height: number } | null {
  const data = Object.hasOwn(maps, map) ? maps[map] : undefined;
  return data ? { width: data.width, height: data.height } : null;
}
const base64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
function publishedBit(bits: string, cell: number): boolean {
  const byte = cell >> 3, group = Math.floor(byte / 3) * 4, offset = byte % 3;
  const left = base64.indexOf(bits[group + offset]!), right = base64.indexOf(bits[group + offset + 1]!);
  const value = ((left << (offset * 2 + 2)) | (right >> (4 - offset * 2))) & 255;
  return (value & (1 << (cell & 7))) !== 0;
}
/** A cache-free view for sparse policy and contract validation. */
export function publishedGrid(map: string): WalkGrid | null {
  const data = Object.hasOwn(maps, map) ? maps[map] : undefined;
  if (!data) return null;
  const inBounds = ({ x, y }: Position) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < data.width && y < data.height;
  const bit = (bits: string, p: Position) => publishedBit(bits, p.x + p.y * data.width);
  return { width: data.width, height: data.height, portals: data.portals,
    walkable: p => inBounds(p) && bit(data.walkableBitsBase64, p),
    seeThrough: p => inBounds(p) && (bit(data.walkableBitsBase64, p) || bit(data.snipableOnlyBitsBase64, p)) };
}
/** Decode once per cache miss; the caller owns any reuse policy. */
export function createMapGrid(map: string): WalkGrid | null {
  const data = Object.hasOwn(maps, map) ? maps[map] : undefined;
  if (!data) return null;
  const bytes = Uint8Array.from(atob(data.walkableBitsBase64), c => c.charCodeAt(0));
  const snipable = Uint8Array.from(atob(data.snipableOnlyBitsBase64), c => c.charCodeAt(0));
  const inBounds = ({ x, y }: Position) => Number.isInteger(x) && Number.isInteger(y) && x >= 0 && y >= 0 && x < data.width && y < data.height;
  const bit = (bits: Uint8Array, { x, y }: Position) => (bits[(x + y * data.width) >> 3]! & (1 << ((x + y * data.width) & 7))) !== 0;
  return { width: data.width, height: data.height, portals: data.portals,
    walkable: p => inBounds(p) && bit(bytes, p),
    seeThrough: p => inBounds(p) && (bit(bytes, p) || bit(snipable, p)) };
}

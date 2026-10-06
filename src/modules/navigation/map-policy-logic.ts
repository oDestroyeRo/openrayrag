import type { ReadonlyData } from '../settings/settings';
import { sort, sortBy } from 'remeda';
import { NAVIGATION_MAPS, mapDimensions, type WalkGrid } from './navigation-logic';
import type { Position } from '../protocol/protocol';
export interface LockArea { map: string; minX: number; minY: number; maxX: number; maxY: number }

export interface MapPolicy {
  mode: 'legacy' | 'weighted';
  allow: string[];
  deny: string[];
  penalties: Array<{ map: string; cost: number }>;
  lockArea: LockArea | null;
}

export type MapPolicyInput = ReadonlyData<MapPolicy>;

export const DEFAULT_MAP_POLICY: MapPolicy = { mode: 'legacy', allow: [], deny: [], penalties: [], lockArea: null };

export const PORTAL_COST = 200;

export const MAX_MAP_PENALTY = 1_000_000;

const maps = new Set(NAVIGATION_MAPS);

const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

function exact(v: unknown, fields: string[]): asserts v is Record<string, unknown> {
  if (!record(v) || Object.keys(v).length !== fields.length || !Object.keys(v).every(k => fields.includes(k)))
    throw new Error('Invalid map policy fields.');
}

export function validateMapPolicy(input: unknown): MapPolicy {
  exact(input, ['mode','allow','deny','penalties','lockArea']);
  if (input.mode !== 'legacy' && input.mode !== 'weighted') throw new Error('Invalid routing mode.');
  for (const key of ['allow','deny']) {
    const list = input[key];
    if (!Array.isArray(list) || list.length > 256 || list.some(m => typeof m !== 'string' || !maps.has(m)) || new Set(list).size !== list.length)
      throw new Error('Map lists require unique known map codes (maximum 256).');
  }
  if (!Array.isArray(input.penalties) || input.penalties.length > 256) throw new Error('Invalid map penalties.');
  const seen = new Set<string>();
  for (const p of input.penalties) {
    exact(p,['map','cost']);
    if (typeof p.map !== 'string' || !maps.has(p.map) || seen.has(p.map) || typeof p.cost !== 'number'
      || !Number.isFinite(p.cost) || p.cost < 0 || p.cost > MAX_MAP_PENALTY) throw new Error('Invalid map penalty.');
    seen.add(p.map);
  }
  if (input.lockArea !== null) {
    const a = input.lockArea; exact(a,['map','minX','minY','maxX','maxY']);
    const grid = typeof a.map === 'string' ? mapDimensions(a.map) : null;
    if (!grid || !['minX','minY','maxX','maxY'].every(k => typeof a[k] === 'number' && Number.isInteger(a[k]))
      || (a.minX as number) < 0 || (a.minY as number) < 0 || (a.maxX as number) >= grid.width || (a.maxY as number) >= grid.height
      || (a.minX as number) > (a.maxX as number) || (a.minY as number) > (a.maxY as number)) throw new Error('Lock area must be an inclusive rectangle inside its known map.');
  }
  return structuredClone(input) as unknown as MapPolicy;
}

export function mapPolicy(settings: { readonly automation?: { readonly mapPolicy?: ReadonlyData<MapPolicy> } }): ReadonlyData<MapPolicy> { return settings.automation?.mapPolicy ?? DEFAULT_MAP_POLICY; }

export function mapAllowed(policy: ReadonlyData<MapPolicy>, map: string): boolean { return !policy.deny.includes(map) && (!policy.allow.length || policy.allow.includes(map)); }

export function insideLockArea(policy: ReadonlyData<MapPolicy>, map: string, p: Position): boolean {
  const a = policy.lockArea;
  return !a || map === a.map && p.x >= a.minX && p.x <= a.maxX && p.y >= a.minY && p.y <= a.maxY;
}

export function policyIdentity(policy: ReadonlyData<MapPolicy>): string {
  return JSON.stringify([policy.mode,sortBy(policy.allow, map=>map),sortBy(policy.deny, map=>map),sort(policy.penalties, (a,b)=>a.map.localeCompare(b.map)),policy.lockArea]);
}

export function policySummary(policy: ReadonlyData<MapPolicy>, origin?: string): string {
  const a=policy.lockArea;
  return `${policy.mode === 'weighted' ? 'Weighted: walk 10/14 + wall cost, portal 200 + departing-map penalty, including final escape' : 'Fewest portal crossings, then walking cost'}; allow ${policy.allow.join(', ') || 'all'}; deny ${policy.deny.join(', ') || 'none'}; penalties ${policy.penalties.map(p=>`${p.map}=${p.cost}`).join(', ') || 'none'}; ${a ? `lock ${a.map} [${a.minX},${a.minY}]–[${a.maxX},${a.maxY}] inclusive` : 'no lock rectangle'}${origin && !mapAllowed(policy,origin) ? '; current map forbidden: departure only, no reentry' : ''}.`;
}

/** Only the field owner uses this mask. Service and entry owners retain physical grids. */
export function fieldGrid(map: string, grid: WalkGrid, policy: ReadonlyData<MapPolicy>): WalkGrid {
  if (!policy.lockArea && mapAllowed(policy,map)) return grid;
  return {...grid,walkable:p=>mapAllowed(policy,map)&&insideLockArea(policy,map,p)&&grid.walkable(p)};
}

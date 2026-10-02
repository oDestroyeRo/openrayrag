/** Read-only evidence from the pinned server, never inferred from skill costs or visuals. */
export type ResourceSource = 'spawn' | 'own-stats' | 'own-sp' | 'hp-recovery' | 'hit-target' | 'party';
export type ResourceReason = 'invalid' | 'missing-baseline' | 'stale-baseline' | 'conflict' | 'binding' | 'out-of-order';
export interface ResourceObservation {
  value: number | null; max: number | null; at: number | null;
  source: ResourceSource | null; reason: ResourceReason | null;
}
export type ResourceOperator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
export const RESOURCE_OPERATORS: readonly ResourceOperator[] = ['lt', 'lte', 'eq', 'gte', 'gt'];
export const RESOURCE_STALE_MS = 15_000;
export function resourceValues(value: unknown, max: unknown): value is number {
  return typeof value === 'number' && typeof max === 'number' && Number.isInteger(value) && Number.isInteger(max)
    && value >= 0 && max > 0 && value <= max && max <= 0x7fffffff;
}
export function unavailableResource(reason: ResourceReason, at: number | null = null, source: ResourceSource | null = null): ResourceObservation {
  return { value: null, max: null, at, source, reason };
}
export function absoluteResource(value: unknown, max: unknown, at: number, source: ResourceSource): ResourceObservation {
  return resourceValues(value, max) ? { value, max: max as number, at, source, reason: null } : unavailableResource('invalid', at, source);
}
export function resourceFresh(resource: ResourceObservation | undefined, at: number): boolean {
  return !!resource && resource.reason === null && resource.at !== null && resource.at <= at && at - resource.at <= RESOURCE_STALE_MS
    && resourceValues(resource.value, resource.max);
}
export function damageResource(resource: ResourceObservation | undefined, damage: number, at: number): ResourceObservation {
  if (!Number.isInteger(damage) || damage < 0 || damage > 0x7fffffff) return unavailableResource('invalid', at, 'hit-target');
  if (!resource || resource.reason !== null) return unavailableResource('missing-baseline', at, 'hit-target');
  if (!resourceFresh(resource, at)) return unavailableResource('stale-baseline', at, 'hit-target');
  return absoluteResource(Math.max(0, resource.value! - damage), resource.max, at, 'hit-target');
}
export function compareResource(actual: number, operator: ResourceOperator, expected: number): boolean {
  switch (operator) {
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'eq': return actual === expected;
    case 'gte': return actual >= expected;
    case 'gt': return actual > expected;
  }
}
export function validResourceObservation(value: unknown): value is ResourceObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).length !== 5 || !['value','max','at','source','reason'].every(key => Object.hasOwn(r,key))) return false;
  if (!(r.at === null || typeof r.at === 'number' && Number.isFinite(r.at) && r.at >= 0 && r.at <= Number.MAX_SAFE_INTEGER)
    || !(r.source === null || ['spawn','own-stats','own-sp','hp-recovery','hit-target','party'].includes(r.source as string))) return false;
  return r.reason === null ? r.at !== null && r.source !== null && resourceValues(r.value,r.max)
    : ['invalid','missing-baseline','stale-baseline','conflict','binding','out-of-order'].includes(r.reason as string) && r.value === null && r.max === null;
}

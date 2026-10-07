import { quantity, type Quantity } from '../../shared/domain-values';

/** Read-only evidence from the pinned server, never inferred from skill costs or visuals. */
export type ResourceSource =
  | 'spawn'
  | 'own-stats'
  | 'own-sp'
  | 'hp-recovery'
  | 'hit-target'
  | 'party';
export type ResourceReason =
  | 'invalid'
  | 'missing-baseline'
  | 'stale-baseline'
  | 'conflict'
  | 'binding'
  | 'out-of-order';
/** Erased nominal record: ordinary spreads cannot retain its bounds proof. */
declare class AvailableResourceObservation {
  private constructor();
  /** Admission proves 0 <= value <= max <= int32max and max > 0. */
  private readonly resourceBounds: true;
  readonly value: Quantity;
  readonly max: Quantity;
  readonly at: number;
  readonly source: ResourceSource;
  readonly reason: null;
}
export type ResourceObservation =
  | AvailableResourceObservation
  | Readonly<{
      value: null;
      max: null;
      at: number | null;
      source: ResourceSource | null;
      reason: ResourceReason;
    }>;
export type ResourceOperator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
export const RESOURCE_OPERATORS: readonly ResourceOperator[] = ['lt', 'lte', 'eq', 'gte', 'gt'];
export const RESOURCE_STALE_MS = 15_000;
export function resourceValues(value: unknown, max: unknown): value is number {
  return (
    typeof value === 'number' &&
    typeof max === 'number' &&
    Number.isInteger(value) &&
    Number.isInteger(max) &&
    value >= 0 &&
    max > 0 &&
    value <= max &&
    max <= 0x7fffffff
  );
}
export function unavailableResource(
  reason: ResourceReason,
  at: number | null = null,
  source: ResourceSource | null = null,
): ResourceObservation {
  return { value: null, max: null, at, source, reason };
}
export function absoluteResource(
  value: unknown,
  max: unknown,
  at: number,
  source: ResourceSource,
): ResourceObservation {
  // Resource relationships and int32 bounds remain narrower than Quantity.
  // Producer clocks are deliberately raw; external snapshot admission owns them.
  if (!resourceValues(value, max)) return unavailableResource('invalid', at, source);
  // The private marker is erased; the unchanged wire fields carry this proof.
  return {
    value: quantity(value),
    max: quantity(max),
    at,
    source,
    reason: null,
  } as AvailableResourceObservation;
}
export function resourceFresh(resource: ResourceObservation | undefined, at: number): boolean {
  return (
    !!resource &&
    resource.reason === null &&
    resource.at !== null &&
    resource.at <= at &&
    at - resource.at <= RESOURCE_STALE_MS &&
    resourceValues(resource.value, resource.max)
  );
}
export function damageResource(
  resource: ResourceObservation | undefined,
  damage: number,
  at: number,
): ResourceObservation {
  if (!Number.isInteger(damage) || damage < 0 || damage > 0x7fffffff)
    return unavailableResource('invalid', at, 'hit-target');
  if (!resource || resource.reason !== null)
    return unavailableResource('missing-baseline', at, 'hit-target');
  if (!resourceFresh(resource, at)) return unavailableResource('stale-baseline', at, 'hit-target');
  return absoluteResource(Math.max(0, resource.value - damage), resource.max, at, 'hit-target');
}
export function compareResource(
  actual: number,
  operator: ResourceOperator,
  expected: number,
): boolean {
  switch (operator) {
    case 'lt':
      return actual < expected;
    case 'lte':
      return actual <= expected;
    case 'eq':
      return actual === expected;
    case 'gte':
      return actual >= expected;
    case 'gt':
      return actual > expected;
  }
}
export function validResourceObservation(value: unknown): value is ResourceObservation {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  if (
    Object.keys(r).length !== 5 ||
    !['value', 'max', 'at', 'source', 'reason'].every((key) => Object.hasOwn(r, key))
  )
    return false;
  if (
    !(
      r.at === null ||
      (typeof r.at === 'number' &&
        Number.isFinite(r.at) &&
        r.at >= 0 &&
        r.at <= Number.MAX_SAFE_INTEGER)
    ) ||
    !(
      r.source === null ||
      ['spawn', 'own-stats', 'own-sp', 'hp-recovery', 'hit-target', 'party'].includes(
        r.source as string,
      )
    )
  )
    return false;
  return r.reason === null
    ? r.at !== null && r.source !== null && resourceValues(r.value, r.max)
    : [
        'invalid',
        'missing-baseline',
        'stale-baseline',
        'conflict',
        'binding',
        'out-of-order',
      ].includes(r.reason as string) &&
        r.value === null &&
        r.max === null;
}

/** Copy admitted evidence through its owner while retaining raw producer clocks. */
export function copyResourceObservation(value: ResourceObservation): ResourceObservation {
  return value.reason === null
    ? absoluteResource(value.value, value.max, value.at, value.source)
    : unavailableResource(value.reason, value.at, value.source);
}

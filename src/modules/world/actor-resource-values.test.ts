import { describe, expect, it } from 'vitest';
import {
  absoluteResource, copyResourceObservation, damageResource, resourceFresh, resourceValues,
  unavailableResource, validResourceObservation, RESOURCE_STALE_MS,
  type ResourceObservation, type ResourceReason,
} from './actor-resources';
import { addQuantities, milliseconds, percentage, quantity, subtractQuantities, type Quantity } from '../../shared/domain-values';

/** Raw JSON fixtures cross the same guard as external resource observations. */
function resourceFixture(value: unknown): ResourceObservation | null {
  return validResourceObservation(value) ? copyResourceObservation(value) : null;
}

// The ordinary project tsc gate compiles these real consumers but never runs them.
function incompatibleResourceEvidence(count: Quantity): void {
  const available: ResourceObservation = absoluteResource(count, count, 0, 'spawn');
  if (available.reason !== null) return;
  resourceFresh(available, 0);
  damageResource(available, 0, 0);
  resourceFresh(copyResourceObservation(available), 0);
  subtractQuantities(available.value, count);
  // @ts-expect-error Resource arithmetic requires quantities, not durations.
  subtractQuantities(available.value, milliseconds(10));
  // @ts-expect-error Resource arithmetic requires quantities, not percentages.
  addQuantities(available.max, percentage(100));
  // @ts-expect-error A duration is not an admitted resource quantity.
  resourceFresh({ ...available, value: milliseconds(10) }, 0);
  // @ts-expect-error A percentage is not a resource maximum.
  damageResource({ ...available, max: percentage(100) }, 0, 0);
  // @ts-expect-error Raw numbers have not crossed resource quantity admission.
  resourceFresh({ ...available, value: 1 }, 0);
  // @ts-expect-error Individually valid quantities do not prove their relationship.
  resourceFresh({ value: quantity(2), max: quantity(1), at: 0, source: 'spawn', reason: null }, 0);
  // @ts-expect-error A modified spread cannot retain the owner's relationship proof.
  resourceFresh({ ...available, value: quantity(2), max: quantity(1) }, 0);
  // @ts-expect-error Available evidence cannot have absent resource values.
  resourceFresh({ value: null, max: null, at: 0, source: 'spawn', reason: null }, 0);
  // @ts-expect-error Available evidence requires an observation clock.
  resourceFresh({ ...available, at: null }, 0);
  // @ts-expect-error Available evidence requires provenance.
  resourceFresh({ ...available, source: null }, 0);
  // @ts-expect-error Unavailable evidence cannot retain quantities.
  damageResource({ ...available, reason: 'invalid' }, 0, 0);
  // @ts-expect-error Resource evidence is readonly after admission.
  available.value = count;
  const evidence = resourceFixture({ value: 1, max: 2, at: 0.5, source: 'spawn', reason: null });
  if (evidence?.reason === null) {
    const admitted: Quantity = evidence.value;
    damageResource(evidence, admitted, evidence.at);
  }
}
void incompatibleResourceEvidence;

describe('admitted actor resource values', () => {
  it('preserves the boolean value contract and checks resource relationships before quantity construction', () => {
    for (const [value, max] of [[0, 1], [1, 1], [0, 0x7fffffff], [0x7fffffff, 0x7fffffff]]) {
      expect(resourceValues(value, max)).toBe(true);
      expect(absoluteResource(value, max, 0, 'spawn')).toEqual({ value, max, at: 0, source: 'spawn', reason: null });
    }
    for (const [value, max] of [[-1, 1], [2, 1], [0, 0], [1, -1], [0, 0x80000000],
      [0.5, 1], [1, 1.5], [NaN, 1], [1, Infinity], [Infinity, Infinity], ['1', 1], [1, '1'], [true, 1], [undefined, 1], [1, null]]) {
      expect(resourceValues(value, max)).toBe(false);
      expect(absoluteResource(value, max, 0, 'spawn')).toEqual({ value: null, max: null, at: 0, source: 'spawn', reason: 'invalid' });
    }
    expect(Object.is(absoluteResource(-0, 1, 0, 'spawn').value, -0)).toBe(true);
  });

  it('keeps all unavailable reasons separate from quantities without adding wire fields', () => {
    const reasons: readonly ResourceReason[] = ['invalid', 'missing-baseline', 'stale-baseline', 'conflict', 'binding', 'out-of-order'];
    for (const reason of reasons) {
      const missing = unavailableResource(reason);
      expect(missing).toEqual({ value: null, max: null, at: null, source: null, reason });
      expect(validResourceObservation(missing)).toBe(true);
      expect(resourceFresh(missing, 0)).toBe(false);
      expect(unavailableResource(reason, 0.25, 'party')).toEqual({ value: null, max: null, at: 0.25, source: 'party', reason });
    }
  });

  it('admits finite fractional external clocks without tightening raw producer clocks', () => {
    for (const at of [0, 0.25, Number.MAX_SAFE_INTEGER]) {
      const observation = absoluteResource(1, 2, at, 'spawn');
      expect(observation.at).toBe(at);
      expect(validResourceObservation(observation)).toBe(true);
      expect(resourceFixture(observation)).toEqual(observation);
    }
    for (const at of [-1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity, -Infinity]) {
      const observation = absoluteResource(1, 2, at, 'spawn');
      expect(observation).toEqual({ value: 1, max: 2, at, source: 'spawn', reason: null });
      expect(copyResourceObservation(observation)).toEqual(observation);
      expect(validResourceObservation(observation)).toBe(false);
      expect(resourceFixture(observation)).toBeNull();
      expect(unavailableResource('invalid', at, 'spawn').at).toBe(at);
    }
    expect(resourceFresh(absoluteResource(1, 2, -1, 'spawn'), -1)).toBe(true);
  });

  it('rejects impossible and malformed external observations at the existing admission point', () => {
    const available = { value: 1, max: 2, at: 0.25, source: 'spawn', reason: null };
    for (const invalid of [null, [], 1, { ...available, extra: true },
      { ...available, value: null }, { ...available, max: null }, { ...available, at: null },
      { ...available, source: null }, { ...available, source: 'skill-cost' },
      { ...available, reason: 'invalid' }, { ...available, reason: 'unknown' },
      { ...available, value: 3 }, { ...available, max: 0 }, { ...available, value: 1.5 },
      { ...available, value: null, max: null, reason: 'invalid', at: -1 },
      { value: 1, max: 2, at: 0.25, source: 'spawn' }]) {
      expect(validResourceObservation(invalid)).toBe(false);
      expect(resourceFixture(invalid)).toBeNull();
    }
  });

  it('detaches admitted JSON evidence from its raw alias and retains serialization', () => {
    const raw = { value: 5, max: 10, at: 0.5, source: 'party', reason: null };
    const observation = resourceFixture(raw);
    expect(JSON.stringify(observation)).toBe(JSON.stringify(raw));
    expect(observation).not.toBe(raw);
    raw.value = 9;
    raw.source = 'unsupported';
    expect(observation).toEqual({ value: 5, max: 10, at: 0.5, source: 'party', reason: null });
    const missing = { value: null, max: null, at: null, source: null, reason: 'binding' };
    const unavailable = resourceFixture(missing);
    expect(JSON.stringify(unavailable)).toBe(JSON.stringify(missing));
    expect(unavailable).not.toBe(missing);
    missing.reason = 'conflict';
    expect(unavailable?.reason).toBe('binding');
  });

  it('keeps the erased relational proof outside runtime objects and copied wire data', () => {
    const keys = ['value', 'max', 'at', 'source', 'reason'];
    for (const observation of [absoluteResource(5, 10, 0.25, 'party'), unavailableResource('binding')]) {
      const copy = copyResourceObservation(observation);
      expect(Reflect.ownKeys(observation)).toEqual(keys);
      expect(Reflect.ownKeys(copy)).toEqual(keys);
      expect(Object.getPrototypeOf(observation)).toBe(Object.prototype);
      expect(Object.getPrototypeOf(copy)).toBe(Object.prototype);
      expect(copy).not.toBe(observation);
      expect(JSON.stringify(copy)).toBe(JSON.stringify(observation));
    }
  });

  it('preserves exact freshness boundaries and independently rechecks quantity relationships', () => {
    const baseline = absoluteResource(5, 10, 0.25, 'spawn');
    expect(resourceFresh(undefined, 0.25)).toBe(false);
    expect(resourceFresh(baseline, 0)).toBe(false);
    expect(resourceFresh(baseline, 0.25 + RESOURCE_STALE_MS)).toBe(true);
    expect(resourceFresh(baseline, 0.5 + RESOURCE_STALE_MS)).toBe(false);
    expect(resourceFresh(baseline, NaN)).toBe(false);
    expect(resourceFresh(baseline, Infinity)).toBe(false);
    // Deliberate runtime corruption remains guarded even though typed callers
    // cannot mutate an admitted observation.
    Object.assign(baseline, { max: 0 });
    expect(resourceFresh(baseline, 0.25)).toBe(false);
    expect(damageResource(baseline, 1, 0.25).reason).toBe('stale-baseline');
  });

  it('retains invalid-damage, missing-baseline and stale-baseline failure order', () => {
    for (const damage of [-1, 0.5, 0x80000000, NaN, Infinity]) {
      expect(damageResource(undefined, damage, -1)).toEqual(unavailableResource('invalid', -1, 'hit-target'));
      expect(damageResource(unavailableResource('conflict'), damage, 0)).toEqual(unavailableResource('invalid', 0, 'hit-target'));
    }
    expect(damageResource(undefined, 0, 0)).toEqual(unavailableResource('missing-baseline', 0, 'hit-target'));
    expect(damageResource(unavailableResource('conflict'), 0, 0)).toEqual(unavailableResource('missing-baseline', 0, 'hit-target'));
    expect(damageResource(absoluteResource(5, 10, 1, 'spawn'), 0, 0)).toEqual(unavailableResource('stale-baseline', 0, 'hit-target'));
    expect(damageResource(absoluteResource(5, 10, 0, 'spawn'), 0, 15_001)).toEqual(unavailableResource('stale-baseline', 15_001, 'hit-target'));
  });

  it('revalidates clamped damage results and preserves detached wire values and raw timing', () => {
    const baseline = absoluteResource(5, 10, -1, 'spawn');
    const before = JSON.stringify(baseline);
    const damaged = damageResource(baseline, 2, -0.5);
    expect(JSON.stringify(damaged)).toBe('{"value":3,"max":10,"at":-0.5,"source":"hit-target","reason":null}');
    expect(damageResource(baseline, 0x7fffffff, -0.5)).toEqual({ value: quantity(0), max: quantity(10), at: -0.5, source: 'hit-target', reason: null });
    expect(damaged).not.toBe(baseline);
    expect(JSON.stringify(baseline)).toBe(before);
    expect(validResourceObservation(damaged)).toBe(false);
    expect(damageResource(absoluteResource(0, 0x7fffffff, 0.25, 'party'), 0, 0.5))
      .toEqual({ value: quantity(0), max: quantity(0x7fffffff), at: 0.5, source: 'hit-target', reason: null });
  });
});

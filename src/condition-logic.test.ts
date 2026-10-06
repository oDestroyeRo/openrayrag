import { describe, expect, it } from 'vitest';
import { foldConditions, unavailableFirstConditions, unmatchedFirstConditions, type ConditionState } from './condition-logic';

const states: ConditionState[] = ['matched', 'unmatched', 'unavailable'];

describe.each([
  ['unavailable-first', unavailableFirstConditions, 'unavailable'],
  ['unmatched-first', unmatchedFirstConditions, 'unmatched'],
] as const)('%s condition algebra', (_, policy, first) => {
  it('has a two-sided matched identity and an empty fold', () => {
    expect(foldConditions([], policy)).toBe('matched');
    for (const state of states) {
      expect(policy.combine(policy.identity, state)).toBe(state);
      expect(policy.combine(state, policy.identity)).toBe(state);
    }
  });

  it('is associative for all three-state triples', () => {
    for (const left of states) for (const middle of states) for (const right of states) {
      expect(policy.combine(policy.combine(left, middle), right))
        .toBe(policy.combine(left, policy.combine(middle, right)));
      expect(foldConditions([left, middle, right].map(state => ({ state })), policy))
        .toBe(policy.combine(policy.combine(left, middle), right));
    }
  });

  it('is closed, commutative and idempotent while retaining its explicit precedence', () => {
    for (const left of states) for (const right of states) {
      expect(states).toContain(policy.combine(left, right));
      expect(policy.combine(left, right)).toBe(policy.combine(right, left));
      if (left === right) expect(policy.combine(left, right)).toBe(left);
    }
    const conditions = states.map(state => ({ state }));
    const before = structuredClone(conditions);
    expect(foldConditions(conditions, policy)).toBe(first);
    expect(foldConditions([...conditions].reverse(), policy)).toBe(first);
    expect(conditions).toEqual(before);
  });
});

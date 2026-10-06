import { reduce } from 'remeda';

export type ConditionState = 'matched' | 'unmatched' | 'unavailable';

/** Each policy combines an already evaluated trace; neither evaluates predicates. */
export interface ConditionStateMonoid {
  readonly identity: ConditionState;
  readonly combine: (left: ConditionState, right: ConditionState) => ConditionState;
}

function conditionStateMonoid(first: 'unavailable' | 'unmatched'): ConditionStateMonoid {
  return { identity: 'matched', combine: (left, right) =>
    left === first || right === first ? first : left === 'matched' ? right : left };
}

/** Automation and strategy admission fail closed when any observation is missing. */
export const unavailableFirstConditions = conditionStateMonoid('unavailable');

/** Routine diagnostics retain a known false condition ahead of missing observations. */
export const unmatchedFirstConditions = conditionStateMonoid('unmatched');

export function foldConditions(conditions: readonly { state: ConditionState }[], policy: ConditionStateMonoid): ConditionState {
  return reduce(conditions, (state, condition) => policy.combine(state, condition.state), policy.identity);
}

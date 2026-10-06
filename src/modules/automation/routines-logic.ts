import { filter, flatMap, map } from 'remeda';
import { foldConditions, unmatchedFirstConditions, type ConditionState } from '../../shared/condition-logic';
import { actorPredicateEvaluator, validActorPredicate, type ActorPredicate, type ActorObservationSnapshot } from '../world/actor-observations-logic';
export type NumericOperator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';

export type RoutineCondition =
  | ActorPredicate
  | { field: 'hpPercent' | 'spPercent' | 'weightPercent' | 'level' | 'jobLevel' | 'zeny' | 'elapsedSeconds'; operator: NumericOperator; value: number }
  | { field: 'map'; operator: 'eq' | 'ne'; value: string }
  | { field: 'inventory'; itemId: number; operator: NumericOperator; value: number };

/** Retain rule order and the original predicate references for the current observation pass. */
export function routineActorPredicates(rules: readonly { conditions: RoutineCondition[] }[]): ActorPredicate[] {
  return flatMap(rules, rule => filter(rule.conditions, (condition): condition is ActorPredicate =>
    condition.field === 'actorStatus' || condition.field === 'actorCasting'
    || condition.field === 'actorHpPercent' || condition.field === 'actorSpPercent'));
}

export interface RoutineRule<Action> {
  name: string; priority: number; cooldownSeconds: number; maxRuns: number;
  conditions: RoutineCondition[]; action: Action;
}

export interface RoutineSpec<Action> {
  name: string; durationSeconds: number; maxActions: number; rules: RoutineRule<Action>[];
}

export interface RoutineObservation {
  actors?: ActorObservationSnapshot;
  hpPercent?: number; spPercent?: number; weightPercent?: number; level?: number; jobLevel?: number; map?: string; zeny?: number;
  inventory?: Readonly<Record<number, number>>;
  // Dry runs may supply elapsed time; a running routine always uses its own clock.
  elapsedSeconds?: number;
}

export type ActionValidator<Action> = (value: unknown) => value is Action;

export type RoutineState = 'idle' | 'running' | 'waiting' | 'completed' | 'cancelled' | 'failed';

export interface RoutineSnapshot {
  state: RoutineState; reason: string; name: string; currentRule: string | null;
  pendingActionId: number | null;
  actionsIssued: number; actionsCompleted: number; steps: number; elapsedSeconds: number;
}

/** Internal logical selector ledger. It never represents a dispatched game action. */
export interface RoutineSelectorCheckpoint<Action> {
  version: 1; spec: RoutineSpec<Action>; progress: { runs: number; lastIssued: number | null }[];
  pending: { id: number; ruleIndex: number; issuedAt: number } | null;
  nextActionId: number; state: 'running' | 'waiting' | 'completed'; reason: string;
  startedAt: number; lastTime: number; actionsIssued: number; actionsCompleted: number; steps: number;
}

export interface ConditionTrace {
  condition: RoutineCondition; state: ConditionState; reason: string;
}

export interface RuleTrace<Action> {
  name: string; priority: number; action: Action;
  state: ConditionTrace['state'] | 'cooldown' | 'exhausted'; reason: string; conditions: ConditionTrace[];
}

export interface RoutineTrace<Action> { rules: RuleTrace<Action>[]; action: Action | null; rule: string | null }

export interface RoutineOptions {
  actionTimeoutSeconds?: number; maxSteps?: number;
  /** Internal selector owners may raise the ceiling; legacy routines retain 120 seconds. */
  actionTimeoutLimitSeconds?: number;
  /** Macro selectors opt in to zero execution limits; ordinary routines remain finite. */
  allowUnlimitedLimits?: boolean;
}

export const ROUTINE_LIMITS = {
  rules: 32, conditions: 16, actions: 1_000, durationSeconds: 86_400,
  maxSteps: 1_000_000, defaultSteps: 200_000, actionBytes: 4_096, specBytes: 65_536,
} as const;

const MAX_NUMBER = 2_147_483_647;

const utf8 = new TextEncoder();

const numericOperators: readonly string[] = ['lt', 'lte', 'eq', 'gte', 'gt'];

const mapCode = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);

export const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;

export const name = (value: unknown): value is string => typeof value === 'string' && value.length <= 64
  && value.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(value);

const record = (value: unknown): value is Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
};

const keys = (value: Record<string, unknown>, expected: string[]): boolean => {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
};

export function validRoutineCondition(value: unknown): value is RoutineCondition {
  if (!record(value)) return false;
  if (value.field==='actorStatus'||value.field==='actorCasting'||value.field==='actorHpPercent'||value.field==='actorSpPercent') return validActorPredicate(value);
  if (value.field === 'map') return keys(value, ['field', 'operator', 'value'])
    && (value.operator === 'eq' || value.operator === 'ne') && mapCode(value.value);
  if (typeof value.operator !== 'string' || !numericOperators.includes(value.operator)) return false;
  if (value.field === 'inventory') return keys(value, ['field', 'itemId', 'operator', 'value'])
    && integer(value.itemId, 1, MAX_NUMBER) && integer(value.value, 0, MAX_NUMBER);
  if (!keys(value, ['field', 'operator', 'value'])) return false;
  if (value.field === 'hpPercent' || value.field === 'spPercent' || value.field === 'weightPercent') return finite(value.value, 0, 100);
  if (value.field === 'level' || value.field === 'jobLevel') return integer(value.value, 1, 1_000);
  if (value.field === 'zeny') return integer(value.value, 0, MAX_NUMBER);
  return value.field === 'elapsedSeconds' && finite(value.value, 0, ROUTINE_LIMITS.durationSeconds);
}

function jsonValue(value: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (value === null || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value === 'string') return value.length <= ROUTINE_LIMITS.actionBytes;
  if (Array.isArray(value)) return value.length <= 64 && value.every(item => jsonValue(item, depth + 1));
  return record(value) && Object.keys(value).length <= 64 && Object.values(value).every(item => jsonValue(item, depth + 1));
}

function cloneAction<Action>(value: unknown, isAction: ActionValidator<Action>): Action {
  if (!jsonValue(value)) throw new Error('Routine action must use bounded JSON data.');
  const serialized = JSON.stringify(value);
  if (!serialized || utf8.encode(serialized).length > ROUTINE_LIMITS.actionBytes) throw new Error('Routine action is too large.');
  const action: unknown = JSON.parse(serialized);
  if (!isAction(action)) throw new Error('Routine action is not in the verified action catalog.');
  return action;
}

// The supplied validator is the only extension point: routines cannot load code or add commands.
export function validateRoutineSpec<Action>(value: unknown, isAction: ActionValidator<Action>,
  options: Pick<RoutineOptions, 'allowUnlimitedLimits'> = {}): RoutineSpec<Action> {
  const minimum = options.allowUnlimitedLimits === true ? 0 : 1;
  if (!record(value) || !keys(value, ['name', 'durationSeconds', 'maxActions', 'rules'])
    || !name(value.name) || !integer(value.durationSeconds, minimum, ROUTINE_LIMITS.durationSeconds)
    || !integer(value.maxActions, minimum, ROUTINE_LIMITS.actions) || !Array.isArray(value.rules)
    || value.rules.length < 1 || value.rules.length > ROUTINE_LIMITS.rules) throw new Error('Invalid routine limits or rules.');
  const rules: RoutineRule<Action>[] = value.rules.map(rule => {
    if (!record(rule) || !keys(rule, ['name', 'priority', 'cooldownSeconds', 'maxRuns', 'conditions', 'action'])
      || !name(rule.name) || !integer(rule.priority, -1_000, 1_000)
      || !integer(rule.cooldownSeconds, 0, ROUTINE_LIMITS.durationSeconds)
      || !integer(rule.maxRuns, minimum, ROUTINE_LIMITS.actions) || !Array.isArray(rule.conditions)
      || rule.conditions.length < 1 || rule.conditions.length > ROUTINE_LIMITS.conditions
      || !rule.conditions.every(validRoutineCondition)) throw new Error('Invalid routine rule or condition.');
    return { name: rule.name, priority: rule.priority, cooldownSeconds: rule.cooldownSeconds, maxRuns: rule.maxRuns,
      conditions: structuredClone(rule.conditions), action: cloneAction(rule.action, isAction) };
  });
  if (new Set(rules.map(rule => rule.name)).size !== rules.length) throw new Error('Routine rule names must be unique.');
  const spec = { name: value.name, durationSeconds: value.durationSeconds, maxActions: value.maxActions, rules };
  if (utf8.encode(JSON.stringify(spec)).length > ROUTINE_LIMITS.specBytes) throw new Error('Routine is too large.');
  return spec;
}

function compare(actual: number, operator: NumericOperator, expected: number): boolean {
  switch (operator) {
    case 'lt': return actual < expected;
    case 'lte': return actual <= expected;
    case 'eq': return actual === expected;
    case 'gte': return actual >= expected;
    case 'gt': return actual > expected;
  }
}

export interface RoutineConditionContext {
  observation: RoutineObservation; allowExtendedElapsed?: boolean;
}

/** Bind read-only observations for one synchronous rule evaluation pass. */
export function routineConditionEvaluator({ observation, allowExtendedElapsed = false }: RoutineConditionContext): (condition: RoutineCondition) => ConditionTrace {
  const evaluateActor = actorPredicateEvaluator(observation.actors);
  return condition => {
    if (condition.field==='actorStatus'||condition.field==='actorCasting'||condition.field==='actorHpPercent'||condition.field==='actorSpPercent') return evaluateActor(condition);
    let matched: boolean;
    if (condition.field === 'map') {
      if (!mapCode(observation.map)) return { condition: { ...condition }, state: 'unavailable', reason: 'Current map is unavailable.' };
      matched = condition.operator === 'eq' ? observation.map === condition.value : observation.map !== condition.value;
    } else {
      const actual = condition.field === 'inventory'
        ? (record(observation.inventory) && Object.hasOwn(observation.inventory, condition.itemId) ? observation.inventory[condition.itemId] : undefined)
        : observation[condition.field];
      const available = condition.field === 'hpPercent' || condition.field === 'spPercent' || condition.field === 'weightPercent' ? finite(actual, 0, 100)
        : condition.field === 'level' || condition.field === 'jobLevel' ? integer(actual, 1, 1_000)
        : condition.field === 'elapsedSeconds' ? finite(actual, 0, allowExtendedElapsed ? Number.MAX_SAFE_INTEGER / 1_000 : ROUTINE_LIMITS.durationSeconds)
          : integer(actual, 0, MAX_NUMBER);
      if (!available || typeof actual !== 'number') return { condition: { ...condition }, state: 'unavailable',
        reason: condition.field === 'inventory' ? `Count for item ${condition.itemId} is unavailable.` : `${condition.field} is unavailable.` };
      matched = compare(actual, condition.operator, condition.value);
    }
    return { condition: { ...condition }, state: matched ? 'matched' : 'unmatched',
      reason: matched ? 'Condition matched.' : 'Condition did not match.' };
  };
}

/** Compatibility entrypoint for callers evaluating a single condition. */
export function evaluateRoutineCondition(condition: RoutineCondition, observation: RoutineObservation,
  allowExtendedElapsed = false): ConditionTrace {
  return routineConditionEvaluator({ observation, allowExtendedElapsed })(condition);
}

export interface RuleProgress { runs: number; lastIssued: number | null }

export function validateRoutineSelectorCheckpoint<Action>(input: unknown,
  isAction: ActionValidator<Action>): RoutineSelectorCheckpoint<Action> {
  if (!record(input) || !keys(input, ['version', 'spec', 'progress', 'pending', 'nextActionId', 'state', 'reason',
    'startedAt', 'lastTime', 'actionsIssued', 'actionsCompleted', 'steps']) || input.version !== 1
    || (input.state !== 'running' && input.state !== 'waiting' && input.state !== 'completed')
    || typeof input.reason !== 'string' || input.reason.length > 200
    || !integer(input.startedAt, 0, Number.MAX_SAFE_INTEGER) || !integer(input.lastTime, input.startedAt, Number.MAX_SAFE_INTEGER)
    || !integer(input.actionsIssued, 0, Number.MAX_SAFE_INTEGER) || !integer(input.actionsCompleted, 0, input.actionsIssued)
    || !integer(input.nextActionId, input.actionsIssued, Number.MAX_SAFE_INTEGER)
    || !integer(input.steps, input.actionsIssued, Number.MAX_SAFE_INTEGER)) throw new Error('Invalid selector checkpoint.');
  const spec = validateRoutineSpec(input.spec, isAction, { allowUnlimitedLimits: true });
  if (!Array.isArray(input.progress) || input.progress.length !== spec.rules.length) throw new Error('Invalid selector progress.');
  const startedAt = input.startedAt, lastTime = input.lastTime;
  const progress = input.progress.map((entry, index): RuleProgress => {
    if (!record(entry) || !keys(entry, ['runs', 'lastIssued'])
      || !integer(entry.runs, 0, spec.rules[index]!.maxRuns || Number.MAX_SAFE_INTEGER)
      || (entry.runs === 0 ? entry.lastIssued !== null : !integer(entry.lastIssued, startedAt, lastTime))) {
      throw new Error('Invalid selector rule ledger.');
    }
    return { runs: entry.runs, lastIssued: entry.lastIssued as number | null };
  });
  const issued = progress.reduce((sum, entry) => sum + entry.runs, 0);
  if (!Number.isSafeInteger(issued) || issued !== input.actionsIssued
    || (spec.maxActions > 0 && issued > spec.maxActions)) throw new Error('Invalid selector counters.');
  let pending: RoutineSelectorCheckpoint<Action>['pending'] = null;
  if (input.pending !== null) {
    const value = input.pending;
    if (!record(value) || !keys(value, ['id', 'ruleIndex', 'issuedAt'])
      || !integer(value.id, 1, input.nextActionId) || !integer(value.ruleIndex, 0, spec.rules.length - 1)
      || !integer(value.issuedAt, startedAt, lastTime) || progress[value.ruleIndex]!.lastIssued !== value.issuedAt
      || progress[value.ruleIndex]!.runs === 0) throw new Error('Invalid selector ownership.');
    pending = { id: value.id, ruleIndex: value.ruleIndex, issuedAt: value.issuedAt };
  }
  const exhausted = (spec.maxActions > 0 && issued >= spec.maxActions)
    || progress.every((entry, index) => spec.rules[index]!.maxRuns > 0 && entry.runs >= spec.rules[index]!.maxRuns);
  const expired = spec.durationSeconds > 0 && lastTime - startedAt >= spec.durationSeconds * 1_000;
  if ((input.state === 'waiting') !== (pending !== null) || input.actionsCompleted !== issued - (pending ? 1 : 0)
    || (input.state === 'running' && (exhausted || expired))
    || (input.state === 'waiting' && expired) || (input.state === 'completed' && !exhausted && !expired)) {
    throw new Error('Invalid selector state.');
  }
  return { version: 1, spec, progress, pending, nextActionId: input.nextActionId,
    state: input.state as RoutineSelectorCheckpoint<Action>['state'], reason: input.reason,
    startedAt, lastTime, actionsIssued: issued, actionsCompleted: input.actionsCompleted, steps: input.steps };
}

export interface RoutineTraceInput<Action> extends RoutineConditionContext {
  spec: RoutineSpec<Action>; progress?: readonly RuleProgress[]; now?: number;
}

export function traceRules<Action>({ spec, observation, progress, now = 0, allowExtendedElapsed = false }: RoutineTraceInput<Action>): RoutineTrace<Action> {
  const evaluate = routineConditionEvaluator({ observation, allowExtendedElapsed });
  const rules = map(spec.rules, (rule, index): RuleTrace<Action> => {
    const conditions = map(rule.conditions, evaluate);
    let state: RuleTrace<Action>['state'] = foldConditions(conditions, unmatchedFirstConditions);
    let reason = state === 'matched' ? 'All conditions matched.'
      : state === 'unavailable' ? 'Required observation is unavailable.' : 'A condition did not match.';
    const current = progress?.[index];
    if (current && rule.maxRuns > 0 && current.runs >= rule.maxRuns) { state = 'exhausted'; reason = 'Rule run budget reached.'; }
    else if (current?.lastIssued !== null && current?.lastIssued !== undefined
      && now - current.lastIssued < rule.cooldownSeconds * 1_000) { state = 'cooldown'; reason = 'Rule cooldown is active.'; }
    return { name: rule.name, priority: rule.priority, action: structuredClone(rule.action), state, reason, conditions };
  }).sort((a, b) => b.priority - a.priority);
  const selected = rules.find(rule => rule.state === 'matched');
  return { rules, action: selected ? structuredClone(selected.action) : null, rule: selected?.name ?? null };
}

// Pure preview: no clock, dispatch, counters, or external resources are touched.
export function dryRunRoutine<Action>(spec: unknown, observation: RoutineObservation,
  isAction: ActionValidator<Action>, options: Pick<RoutineOptions, 'allowUnlimitedLimits'> = {}): RoutineTrace<Action> {
  return traceRules({ spec: validateRoutineSpec(spec, isAction, options), observation, allowExtendedElapsed: options.allowUnlimitedLimits === true });
}

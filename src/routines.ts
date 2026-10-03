import { evaluateActorPredicate, validActorPredicate, type ActorPredicate, type ActorObservationSnapshot } from './actor-observations';

export type NumericOperator = 'lt' | 'lte' | 'eq' | 'gte' | 'gt';
export type RoutineCondition =
  | ActorPredicate
  | { field: 'hpPercent' | 'spPercent' | 'weightPercent' | 'level' | 'jobLevel' | 'zeny' | 'elapsedSeconds'; operator: NumericOperator; value: number }
  | { field: 'map'; operator: 'eq' | 'ne'; value: string }
  | { field: 'inventory'; itemId: number; operator: NumericOperator; value: number };
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
export interface ConditionTrace {
  condition: RoutineCondition; state: 'matched' | 'unmatched' | 'unavailable'; reason: string;
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
}

export const ROUTINE_LIMITS = {
  rules: 32, conditions: 16, actions: 1_000, durationSeconds: 86_400,
  maxSteps: 1_000_000, defaultSteps: 200_000, actionBytes: 4_096, specBytes: 65_536,
} as const;
const MAX_NUMBER = 2_147_483_647;
const utf8 = new TextEncoder();
const numericOperators: readonly string[] = ['lt', 'lte', 'eq', 'gte', 'gt'];
const mapCode = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
const finite = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
const name = (value: unknown): value is string => typeof value === 'string' && value.length <= 64
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
export function validateRoutineSpec<Action>(value: unknown, isAction: ActionValidator<Action>): RoutineSpec<Action> {
  if (!record(value) || !keys(value, ['name', 'durationSeconds', 'maxActions', 'rules'])
    || !name(value.name) || !integer(value.durationSeconds, 1, ROUTINE_LIMITS.durationSeconds)
    || !integer(value.maxActions, 1, ROUTINE_LIMITS.actions) || !Array.isArray(value.rules)
    || value.rules.length < 1 || value.rules.length > ROUTINE_LIMITS.rules) throw new Error('Invalid routine limits or rules.');
  const rules: RoutineRule<Action>[] = value.rules.map(rule => {
    if (!record(rule) || !keys(rule, ['name', 'priority', 'cooldownSeconds', 'maxRuns', 'conditions', 'action'])
      || !name(rule.name) || !integer(rule.priority, -1_000, 1_000)
      || !integer(rule.cooldownSeconds, 0, ROUTINE_LIMITS.durationSeconds)
      || !integer(rule.maxRuns, 1, ROUTINE_LIMITS.actions) || !Array.isArray(rule.conditions)
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

export function evaluateRoutineCondition(condition: RoutineCondition, observation: RoutineObservation): ConditionTrace {
  if (condition.field==='actorStatus'||condition.field==='actorCasting'||condition.field==='actorHpPercent'||condition.field==='actorSpPercent') return evaluateActorPredicate(condition,observation.actors);
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
      : condition.field === 'elapsedSeconds' ? finite(actual, 0, ROUTINE_LIMITS.durationSeconds)
        : integer(actual, 0, MAX_NUMBER);
    if (!available || typeof actual !== 'number') return { condition: { ...condition }, state: 'unavailable',
      reason: condition.field === 'inventory' ? `Count for item ${condition.itemId} is unavailable.` : `${condition.field} is unavailable.` };
    matched = compare(actual, condition.operator, condition.value);
  }
  return { condition: { ...condition }, state: matched ? 'matched' : 'unmatched',
    reason: matched ? 'Condition matched.' : 'Condition did not match.' };
}

interface RuleProgress { runs: number; lastIssued: number | null }
function traceRules<Action>(spec: RoutineSpec<Action>, observation: RoutineObservation,
  progress?: RuleProgress[], now = 0): RoutineTrace<Action> {
  const rules = spec.rules.map((rule, index): RuleTrace<Action> => {
    const conditions = rule.conditions.map(condition => evaluateRoutineCondition(condition, observation));
    let state: RuleTrace<Action>['state'] = conditions.some(condition => condition.state === 'unmatched') ? 'unmatched'
      : conditions.some(condition => condition.state === 'unavailable') ? 'unavailable' : 'matched';
    let reason = state === 'matched' ? 'All conditions matched.'
      : state === 'unavailable' ? 'Required observation is unavailable.' : 'A condition did not match.';
    const current = progress?.[index];
    if (current && current.runs >= rule.maxRuns) { state = 'exhausted'; reason = 'Rule run budget reached.'; }
    else if (current?.lastIssued !== null && current?.lastIssued !== undefined
      && now - current.lastIssued < rule.cooldownSeconds * 1_000) { state = 'cooldown'; reason = 'Rule cooldown is active.'; }
    return { name: rule.name, priority: rule.priority, action: structuredClone(rule.action), state, reason, conditions };
  }).sort((a, b) => b.priority - a.priority);
  const selected = rules.find(rule => rule.state === 'matched');
  return { rules, action: selected ? structuredClone(selected.action) : null, rule: selected?.name ?? null };
}

// Pure preview: no clock, dispatch, counters, or external resources are touched.
export function dryRunRoutine<Action>(spec: unknown, observation: RoutineObservation,
  isAction: ActionValidator<Action>): RoutineTrace<Action> {
  return traceRules(validateRoutineSpec(spec, isAction), observation);
}

export class RoutineRuntime<Action> {
  private spec: RoutineSpec<Action> | null = null;
  private progress: RuleProgress[] = [];
  private pending: { id: number; ruleIndex: number; issuedAt: number } | null = null;
  private nextActionId = 0;
  private state: RoutineState = 'idle';
  private reason = 'Start a routine explicitly to run its rules.';
  private startedAt = 0;
  private lastTime = 0;
  private actionsIssued = 0;
  private actionsCompleted = 0;
  private steps = 0;
  private readonly timeoutMs: number;
  private readonly maxSteps: number;

  constructor(private readonly isAction: ActionValidator<Action>, private readonly now = Date.now, options: RoutineOptions = {}) {
    const timeout = options.actionTimeoutSeconds ?? 10;
    const timeoutLimit = options.actionTimeoutLimitSeconds ?? 120;
    const maxSteps = options.maxSteps ?? ROUTINE_LIMITS.defaultSteps;
    if (!integer(timeoutLimit, 1, ROUTINE_LIMITS.durationSeconds) || !integer(timeout, 1, timeoutLimit)
      || !integer(maxSteps, 1, ROUTINE_LIMITS.maxSteps)) throw new Error('Invalid routine runtime limits.');
    this.timeoutMs = timeout * 1_000; this.maxSteps = maxSteps;
  }

  start(value: unknown): void {
    if (this.state === 'running' || this.state === 'waiting') throw new Error('Stop the current routine before starting another.');
    const spec = validateRoutineSpec(value, this.isAction);
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Routine clock is unavailable.');
    this.spec = spec; this.progress = spec.rules.map(() => ({ runs: 0, lastIssued: null }));
    this.pending = null; this.actionsIssued = 0; this.actionsCompleted = 0; this.steps = 0;
    this.startedAt = now; this.lastTime = now; this.state = 'running'; this.reason = 'Waiting for a rule to match.';
  }

  private finish(state: RoutineState, reason: string): void { this.state = state; this.reason = reason; this.pending = null; }
  private activeTime(): number | null {
    if (!this.spec || (this.state !== 'running' && this.state !== 'waiting')) return null;
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now < this.lastTime) {
      this.finish('failed', 'Routine clock changed or became unavailable.'); return null;
    }
    this.lastTime = now;
    if (now - this.startedAt >= this.spec.durationSeconds * 1_000) {
      this.finish(this.pending ? 'failed' : 'completed', this.pending
        ? 'Routine duration reached while an action was unconfirmed. Do not retry automatically.' : 'Routine duration reached.');
      return null;
    }
    if (this.pending && now - this.pending.issuedAt >= this.timeoutMs) {
      this.finish('failed', 'Action confirmation timed out. Do not retry automatically.'); return null;
    }
    return now;
  }

  /** Service deadlines without evaluating or debiting an action. */
  advance(): void { this.activeTime(); }

  tick(observation: RoutineObservation): Action | null {
    const now = this.activeTime();
    if (now === null || !this.spec) return null;
    if (this.steps >= this.maxSteps) { this.finish('failed', 'Routine evaluation budget reached.'); return null; }
    this.steps++;
    if (this.pending) return null;
    if (this.actionsIssued >= this.spec.maxActions || this.progress.every((progress, index) => progress.runs >= this.spec!.rules[index]!.maxRuns)) {
      this.finish('completed', 'Routine action budget reached.'); return null;
    }
    const trace = traceRules(this.spec, { ...observation, elapsedSeconds: (now - this.startedAt) / 1_000 }, this.progress, now);
    if (trace.rule === null) { this.reason = 'Waiting for a rule to match.'; return null; }
    const ruleIndex = this.spec.rules.findIndex(rule => rule.name === trace.rule);
    const progress = this.progress[ruleIndex]!;
    if (this.nextActionId === Number.MAX_SAFE_INTEGER) { this.finish('failed', 'Routine action identity budget reached.'); return null; }
    progress.runs++; progress.lastIssued = now; this.actionsIssued++;
    this.pending = { id: ++this.nextActionId, ruleIndex, issuedAt: now }; this.state = 'waiting'; this.reason = `Waiting for ${trace.rule} confirmation.`;
    return trace.action;
  }

  acknowledge(success: boolean, actionId: number): boolean {
    if (this.activeTime() === null || !this.pending || !this.spec) return false;
    if (actionId !== this.pending.id) return false;
    if (success !== true) { this.finish('failed', 'Action failed or its result is uncertain. Do not retry automatically.'); return true; }
    this.pending = null; this.actionsCompleted++;
    if (this.actionsIssued >= this.spec.maxActions || this.progress.every((progress, index) => progress.runs >= this.spec!.rules[index]!.maxRuns)) {
      this.finish('completed', 'Routine action budget reached.');
    } else { this.state = 'running'; this.reason = 'Waiting for a rule to match.'; }
    return true;
  }

  cancel(reason = 'Routine stopped by you.'): void {
    this.finish('cancelled', reason.slice(0, 200));
  }

  snapshot(): RoutineSnapshot {
    return { state: this.state, reason: this.reason, name: this.spec?.name ?? '',
      currentRule: this.pending ? this.spec!.rules[this.pending.ruleIndex]!.name : null,
      pendingActionId: this.pending?.id ?? null,
      actionsIssued: this.actionsIssued, actionsCompleted: this.actionsCompleted, steps: this.steps,
      elapsedSeconds: this.spec ? Math.min(ROUTINE_LIMITS.durationSeconds, (this.lastTime - this.startedAt) / 1_000) : 0 };
  }

  trace(observation: RoutineObservation): RoutineTrace<Action> {
    if (!this.spec) return { rules: [], action: null, rule: null };
    const trace = traceRules(this.spec, { ...observation, elapsedSeconds: this.snapshot().elapsedSeconds }, this.progress, this.lastTime);
    // A preview cannot claim an action may dispatch while another action is pending or after Stop.
    if (this.state !== 'running') { trace.action = null; trace.rule = null; }
    return trace;
  }
}

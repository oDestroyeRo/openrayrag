import serviceCatalog from './data/npc-services.json';
import { dryRunRoutine, RoutineRuntime, validRoutineCondition,
  type RoutineCondition, type RoutineObservation, type RoutineSpec, type RuleTrace } from './routines';

export type MacroStep =
  | { type: 'farm'; map: string; targets: number[]; timeoutSeconds: number }
  | { type: 'travel'; map: string; timeoutSeconds: number }
  | { type: 'buy'; serviceId: string; itemId: number; quantity: number; maxSpend: number; timeoutSeconds: number }
  | { type: 'store'; serviceId: string; itemId: number; quantity: number; keep: number; maxSpend: number; timeoutSeconds: number }
  | { type: 'useItem'; itemId: number; timeoutSeconds: number }
  | { type: 'skill'; skillId: number; level: number; mode: 'self' | 'target'; timeoutSeconds: number };
export interface MacroRule {
  name: string; priority: number; cooldownSeconds: number; maxRuns: number;
  conditions: RoutineCondition[]; steps: MacroStep[];
}
export interface MacroScript {
  version: 1; name: string; durationSeconds: number; maxActions: number; maxSpend: number; rules: MacroRule[];
}
/** An adapter owns this exact identity until it confirms or rejects the effect. */
export interface MacroIntent {
  id: number; generation: number; ruleIndex: number; stepIndex: number; step: MacroStep;
}
export type MacroState = 'idle' | 'running' | 'waiting' | 'monitoring' | 'completed' | 'failed' | 'cancelled';
export interface MacroSnapshot {
  state: MacroState; reason: string; name: string; generation: number;
  currentRule: string | null; stepIndex: number | null; pendingActionId: number | null;
  actionsIssued: number; actionsCompleted: number; sequencesIssued: number; sequencesCompleted: number;
  spendReserved: number; elapsedSeconds: number; fieldIntentActive: boolean; fieldSuspended: boolean;
}
interface Selection { ruleIndex: number }
export interface MacroRuleTrace extends Omit<RuleTrace<Selection>, 'action'> { ruleIndex: number; steps: MacroStep[] }
export interface MacroTrace { rules: MacroRuleTrace[]; rule: string | null; ruleIndex: number | null; steps: MacroStep[] }

export const MACRO_LIMITS = {
  rules: 32, conditions: 16, stepsPerRule: 16, actions: 1_000, durationSeconds: 86_400,
  documentBytes: 65_536, maxId: 2_147_483_647, maxSpend: 2_000_000_000, targets: 64,
} as const;
const utf8 = new TextEncoder();
const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const record = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
};
const keys = (v: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(v).length === expected.length && expected.every(key => Object.hasOwn(v, key));
const name = (v: unknown): v is string => typeof v === 'string' && v.length <= 64
  && v.trim().length > 0 && !/[\u0000-\u001f\u007f]/.test(v);
const mapCode = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
function jsonData(v: unknown, depth = 0): boolean {
  if (depth > 8) return false;
  if (v === null || typeof v === 'boolean' || typeof v === 'string') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (Array.isArray(v)) return v.length <= 64 && Array.from(v).every(item => jsonData(item, depth + 1));
  return record(v) && Object.keys(v).length <= 16 && Object.values(v).every(item => jsonData(item, depth + 1));
}
function serviceMatches(id: unknown, type: 'buy' | 'store'): boolean {
  const service = serviceCatalog.contracts.find(service => service.id === id);
  return !!service && (type === 'store' ? service.outcome.type === 'storageOpened'
    : service.outcome.type === 'shopOpened' && 'mode' in service.outcome && service.outcome.mode === 'buy');
}

export function validMacroStep(v: unknown): v is MacroStep {
  if (!record(v) || !integer(v.timeoutSeconds, 1, MACRO_LIMITS.durationSeconds)) return false;
  switch (v.type) {
    case 'farm': return keys(v, ['type', 'map', 'targets', 'timeoutSeconds']) && mapCode(v.map)
      && Array.isArray(v.targets) && v.targets.length >= 1 && v.targets.length <= MACRO_LIMITS.targets
      && v.targets.every(id => integer(id, 1, MACRO_LIMITS.maxId)) && new Set(v.targets).size === v.targets.length;
    case 'travel': return keys(v, ['type', 'map', 'timeoutSeconds']) && mapCode(v.map);
    case 'buy':
    case 'store': return keys(v, ['type', 'serviceId', 'itemId', 'quantity', ...(v.type === 'store' ? ['keep'] : []), 'maxSpend', 'timeoutSeconds'])
      && serviceMatches(v.serviceId, v.type) && integer(v.itemId, 1, MACRO_LIMITS.maxId)
      && integer(v.quantity, 1, 100_000) && integer(v.maxSpend, 0, MACRO_LIMITS.maxSpend)
      && (v.type !== 'store' || integer(v.keep, 0, 100_000));
    case 'useItem': return keys(v, ['type', 'itemId', 'timeoutSeconds'])
      && integer(v.itemId, 1, MACRO_LIMITS.maxId) && v.timeoutSeconds <= 120;
    case 'skill': return keys(v, ['type', 'skillId', 'level', 'mode', 'timeoutSeconds'])
      && integer(v.skillId, 1, v.mode === 'target' ? 255 : 32_767) && v.skillId !== 55 && integer(v.level, 1, 10)
      && (v.mode === 'self' || v.mode === 'target') && v.timeoutSeconds <= 120;
    default: return false;
  }
}

/** Strict versioned JSON data only: no commands, code, recursive calls, or implicit defaults. */
export function validateMacroScript(input: unknown): MacroScript {
  if (!jsonData(input)) throw new Error('Macro must use bounded JSON data.');
  const serialized = JSON.stringify(input);
  if (!serialized || utf8.encode(serialized).length > MACRO_LIMITS.documentBytes) throw new Error('Macro document is too large.');
  const v: unknown = JSON.parse(serialized);
  if (!record(v) || !keys(v, ['version', 'name', 'durationSeconds', 'maxActions', 'maxSpend', 'rules'])
    || v.version !== 1 || !name(v.name) || !integer(v.durationSeconds, 1, MACRO_LIMITS.durationSeconds)
    || !integer(v.maxActions, 1, MACRO_LIMITS.actions) || !integer(v.maxSpend, 0, MACRO_LIMITS.maxSpend)
    || !Array.isArray(v.rules) || v.rules.length < 1 || v.rules.length > MACRO_LIMITS.rules) throw new Error('Invalid macro version, limits, or rules.');
  const maxSpend = v.maxSpend;
  const rules: MacroRule[] = v.rules.map(rule => {
    if (!record(rule) || !keys(rule, ['name', 'priority', 'cooldownSeconds', 'maxRuns', 'conditions', 'steps'])
      || !name(rule.name) || !integer(rule.priority, -1_000, 1_000)
      || !integer(rule.cooldownSeconds, 0, MACRO_LIMITS.durationSeconds) || !integer(rule.maxRuns, 1, MACRO_LIMITS.actions)
      || !Array.isArray(rule.conditions) || rule.conditions.length < 1 || rule.conditions.length > MACRO_LIMITS.conditions
      || !rule.conditions.every(validRoutineCondition) || !Array.isArray(rule.steps) || rule.steps.length < 1
      || rule.steps.length > MACRO_LIMITS.stepsPerRule || !rule.steps.every(validMacroStep)
      || rule.steps.some(step => 'maxSpend' in step && step.maxSpend > maxSpend)) throw new Error('Invalid macro rule, condition, or step.');
    return { name: rule.name, priority: rule.priority, cooldownSeconds: rule.cooldownSeconds,
      maxRuns: rule.maxRuns, conditions: rule.conditions, steps: rule.steps };
  });
  if (new Set(rules.map(rule => rule.name)).size !== rules.length) throw new Error('Macro rule names must be unique.');
  return { version: 1, name: v.name, durationSeconds: v.durationSeconds, maxActions: v.maxActions, maxSpend, rules };
}
const validSelection = (v: unknown): v is Selection => record(v) && keys(v, ['ruleIndex'])
  && integer(v.ruleIndex, 0, MACRO_LIMITS.rules - 1);
function selectionSpec(script: MacroScript): RoutineSpec<Selection> {
  return { name: script.name, durationSeconds: script.durationSeconds, maxActions: script.maxActions,
    rules: script.rules.map((rule, ruleIndex) => ({ name: rule.name, priority: rule.priority,
      cooldownSeconds: rule.cooldownSeconds, maxRuns: rule.maxRuns, conditions: rule.conditions, action: { ruleIndex } })) };
}
/** Pure validation and next-rule trace. It neither starts a clock nor reserves any spend. */
export function dryRunMacro(input: unknown, observation: RoutineObservation): MacroTrace {
  const script = validateMacroScript(input);
  const trace = dryRunRoutine(selectionSpec(script), observation, validSelection);
  return { rules: trace.rules.map(({ action, ...rule }) => ({ ...rule, ruleIndex: action.ruleIndex,
    steps: structuredClone(script.rules[action.ruleIndex]!.steps) })), rule: trace.rule,
    ruleIndex: trace.action?.ruleIndex ?? null,
    steps: trace.action ? structuredClone(script.rules[trace.action.ruleIndex]!.steps) : [] };
}
/** Publish known-zero inventory observations only for explicitly requested item conditions. */
export function macroInventoryItemIds(script: MacroScript): number[] {
  return [...new Set(script.rules.flatMap(rule => rule.conditions.flatMap(condition =>
    condition.field === 'inventory' ? [condition.itemId] : [])))].sort((a, b) => a - b);
}

/**
 * Call start explicitly, then tick with observations. Dispatch each returned intent once;
 * acknowledge its exact id only after the controller confirms the effect. A farm ACK means
 * field automation is active, not that farming has ended. Confirmed farm intent survives a
 * completed sequence so later level/inventory/HP rules can select. Travel ACK clears it.
 * Other sequences suspend the retained field intent until all ordered steps are confirmed.
 * Buy/store reserve their entire maxSpend before dispatch, including NPC fees. Adapters must
 * keep the combined fee/item cost within that cap; reservations are never refunded or offset
 * by sale proceeds. Failure, timeout and Stop revoke all pending ownership without replay.
 */
export class MacroRuntime {
  private script: MacroScript | null = null;
  private readonly selector: RoutineRuntime<Selection>;
  private sequence: { ruleIndex: number; stepIndex: number; selectorId: number } | null = null;
  private pending: { intent: MacroIntent; issuedAt: number } | null = null;
  private retainedField: Extract<MacroStep, { type: 'farm' }> | null = null;
  private state: MacroState = 'idle';
  private reason = 'Start a macro explicitly to run its rules.';
  private generation = 0;
  private nextId = 0;
  private startedAt = 0;
  private lastTime = 0;
  private actionsIssued = 0;
  private actionsCompleted = 0;
  private spendReserved = 0;

  constructor(private readonly now = Date.now) {
    this.selector = new RoutineRuntime(validSelection, now, {
      actionTimeoutSeconds: MACRO_LIMITS.durationSeconds, actionTimeoutLimitSeconds: MACRO_LIMITS.durationSeconds,
    });
  }
  get active(): boolean { return this.state === 'running' || this.state === 'waiting' || this.state === 'monitoring'; }
  get currentIntent(): MacroIntent | null { return this.pending ? structuredClone(this.pending.intent) : null; }
  get fieldIntent(): Extract<MacroStep, { type: 'farm' }> | null { return this.retainedField ? structuredClone(this.retainedField) : null; }
  inventoryItemIds(): number[] { return this.script ? macroInventoryItemIds(this.script) : []; }

  start(input: unknown): void {
    if (this.active) throw new Error('Stop the current macro before starting another.');
    const script = validateMacroScript(input);
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Macro clock is unavailable.');
    if (this.generation === Number.MAX_SAFE_INTEGER) throw new Error('Macro generation budget reached.');
    this.selector.start(selectionSpec(script));
    this.script = script; this.generation++; this.sequence = null; this.pending = null; this.retainedField = null;
    this.startedAt = now; this.lastTime = now; this.actionsIssued = 0; this.actionsCompleted = 0; this.spendReserved = 0;
    this.state = 'running'; this.reason = 'Waiting for a rule to match.';
  }
  private finish(state: 'completed' | 'failed' | 'cancelled', reason: string): void {
    this.state = state; this.reason = reason.slice(0, 200); this.pending = null; this.sequence = null; this.retainedField = null;
    this.selector.cancel(this.reason);
  }
  private activeTime(): number | null {
    if (!this.active || !this.script) return null;
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now < this.lastTime) {
      this.finish('failed', 'Macro clock changed or became unavailable.'); return null;
    }
    this.lastTime = now;
    if (now - this.startedAt >= this.script.durationSeconds * 1_000) {
      this.finish(this.pending ? 'failed' : 'completed', this.pending
        ? 'Macro duration reached while a step was unconfirmed. Do not retry automatically.' : 'Macro duration reached.');
      return null;
    }
    if (this.pending && now - this.pending.issuedAt >= this.pending.intent.step.timeoutSeconds * 1_000) {
      this.finish('failed', 'Macro step confirmation timed out. Do not retry automatically.'); return null;
    }
    this.selector.advance();
    if (this.selector.snapshot().state === 'failed') { this.finish('failed', this.selector.snapshot().reason); return null; }
    return now;
  }
  private settle(): void {
    if (!this.script || this.sequence) return;
    const exhausted = this.actionsIssued >= this.script.maxActions || this.selector.snapshot().state === 'completed';
    if (exhausted && !this.retainedField) this.finish('completed', 'Macro action or rule budget reached.');
    else {
      this.state = this.retainedField ? 'monitoring' : 'running';
      this.reason = exhausted ? 'Monitoring the active field until the macro duration ends.' : 'Waiting for a rule to match.';
    }
  }
  tick(observation: RoutineObservation): MacroIntent | null {
    const now = this.activeTime();
    if (now === null || !this.script || this.pending) return null;
    if (this.actionsIssued >= this.script.maxActions) {
      // Never abandon an already selected sequence and silently resume its field.
      if (this.sequence) this.finish('failed', 'Macro step budget reached before the selected sequence completed.');
      else this.settle();
      return null;
    }
    if (!this.sequence) {
      const selected = this.selector.tick(observation);
      if (!selected) {
        if (this.selector.snapshot().state === 'failed') this.finish('failed', this.selector.snapshot().reason);
        else this.settle();
        return null;
      }
      this.sequence = { ruleIndex: selected.ruleIndex, stepIndex: 0, selectorId: this.selector.snapshot().pendingActionId! };
      const steps = this.script.rules[selected.ruleIndex]!.steps;
      if (steps.length > this.script.maxActions - this.actionsIssued) {
        this.finish('failed', 'Selected macro sequence exceeds the remaining step budget.'); return null;
      }
    }
    const { ruleIndex, stepIndex } = this.sequence;
    const step = this.script.rules[ruleIndex]!.steps[stepIndex]!;
    const reservation = 'maxSpend' in step ? step.maxSpend : 0;
    if (reservation > this.script.maxSpend - this.spendReserved) {
      this.finish('failed', 'Macro spend budget would be exceeded.'); return null;
    }
    if (this.nextId === Number.MAX_SAFE_INTEGER) { this.finish('failed', 'Macro action identity budget reached.'); return null; }
    this.spendReserved += reservation; this.actionsIssued++;
    const intent: MacroIntent = { id: ++this.nextId, generation: this.generation, ruleIndex, stepIndex, step: structuredClone(step) };
    this.pending = { intent, issuedAt: now }; this.state = 'waiting'; this.reason = `Waiting for ${step.type} confirmation.`;
    return structuredClone(intent);
  }
  acknowledge(id: number, confirmed: boolean, reason?: string): boolean {
    if (this.activeTime() === null || !this.pending || !this.sequence || id !== this.pending.intent.id) return false;
    if (confirmed !== true) { this.finish('failed', reason ?? 'Macro step failed or its result is uncertain. Do not retry automatically.'); return true; }
    const step = this.pending.intent.step;
    if (step.type === 'farm') this.retainedField = structuredClone(step);
    else if (step.type === 'travel') this.retainedField = null;
    this.pending = null; this.actionsCompleted++; this.sequence.stepIndex++;
    if (this.sequence.stepIndex >= this.script!.rules[this.sequence.ruleIndex]!.steps.length) {
      const selectorId = this.sequence.selectorId;
      this.sequence = null;
      if (!this.selector.acknowledge(true, selectorId)) {
        this.finish('failed', 'Macro rule confirmation ownership was lost.'); return true;
      }
      this.settle();
    } else { this.state = 'running'; this.reason = 'Preparing the next ordered macro step.'; }
    return true;
  }
  fail(reason: string): void { if (this.active) this.finish('failed', reason); }
  cancel(reason = 'Macro stopped by you.'): void { this.finish('cancelled', reason); }
  snapshot(): MacroSnapshot {
    const selector = this.selector.snapshot();
    return { state: this.state, reason: this.reason, name: this.script?.name ?? '', generation: this.generation,
      currentRule: this.sequence ? this.script!.rules[this.sequence.ruleIndex]!.name : null,
      stepIndex: this.sequence?.stepIndex ?? null, pendingActionId: this.pending?.intent.id ?? null,
      actionsIssued: this.actionsIssued, actionsCompleted: this.actionsCompleted,
      sequencesIssued: selector.actionsIssued, sequencesCompleted: selector.actionsCompleted, spendReserved: this.spendReserved,
      elapsedSeconds: this.script ? Math.min(this.script.durationSeconds, (this.lastTime - this.startedAt) / 1_000) : 0,
      fieldIntentActive: this.retainedField !== null, fieldSuspended: this.retainedField !== null && this.sequence !== null };
  }
}

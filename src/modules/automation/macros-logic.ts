import { flatMap, map, dedupe } from 'effect/Array';
import { pipe } from 'effect/Function';
import serviceCatalog from '../../data/npc-services.json';
import { dryRunRoutine, validRoutineCondition, validateRoutineSelectorCheckpoint, type RoutineCondition, type RoutineObservation, type RoutineSelectorCheckpoint, type RoutineSpec, type RuleTrace } from './routines-logic';
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

/** A clean continuation boundary: the next step is logical, with no game action in flight. */
export interface MacroCheckpoint {
  version: 1; script: MacroScript; selector: RoutineSelectorCheckpoint<{ ruleIndex: number }>;
  sequence: { ruleIndex: number; stepIndex: number; selectorId: number } | null;
  retainedField: Extract<MacroStep, { type: 'farm' }> | null; state: 'running' | 'monitoring'; reason: string;
  generation: number; nextId: number; startedAt: number; lastTime: number;
  actionsIssued: number; actionsCompleted: number; spendReserved: number;
}

export interface Selection { ruleIndex: number }

export interface MacroRuleTrace extends Omit<RuleTrace<Selection>, 'action'> { ruleIndex: number; steps: MacroStep[] }

export interface MacroTrace { rules: MacroRuleTrace[]; rule: string | null; ruleIndex: number | null; steps: MacroStep[] }

export const MACRO_LIMITS = {
  rules: 32, conditions: 16, stepsPerRule: 16, actions: 1_000, durationSeconds: 86_400,
  documentBytes: 65_536, maxId: 2_147_483_647, maxSpend: 2_000_000_000, targets: 64,
} as const;

const utf8 = new TextEncoder();

// MacroRuntime owns each finite step deadline; the selector must not cap their whole sequence.
export const selectorOptions = { allowUnlimitedLimits: true, maxSteps: 0, actionTimeoutSeconds: 0 } as const;

export const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const record = (v: unknown): v is Record<string, unknown> => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return false;
  return Object.getPrototypeOf(v) === Object.prototype || Object.getPrototypeOf(v) === null;
};

const keys = (v: Record<string, unknown>, expected: string[]): boolean =>
  Object.keys(v).length === expected.length && expected.every(key => Object.hasOwn(v, key));

export const name = (v: unknown): v is string => typeof v === 'string' && v.length <= 64
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
    || v.version !== 1 || !name(v.name) || !integer(v.durationSeconds, 0, MACRO_LIMITS.durationSeconds)
    || !integer(v.maxActions, 0, MACRO_LIMITS.actions) || !integer(v.maxSpend, 0, MACRO_LIMITS.maxSpend)
    || !Array.isArray(v.rules) || v.rules.length < 1 || v.rules.length > MACRO_LIMITS.rules) throw new Error('Invalid macro version, limits, or rules.');
  const maxSpend = v.maxSpend;
  const rules: MacroRule[] = v.rules.map(rule => {
    if (!record(rule) || !keys(rule, ['name', 'priority', 'cooldownSeconds', 'maxRuns', 'conditions', 'steps'])
      || !name(rule.name) || !integer(rule.priority, -1_000, 1_000)
      || !integer(rule.cooldownSeconds, 0, MACRO_LIMITS.durationSeconds) || !integer(rule.maxRuns, 0, MACRO_LIMITS.actions)
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

export const validSelection = (v: unknown): v is Selection => record(v) && keys(v, ['ruleIndex'])
  && integer(v.ruleIndex, 0, MACRO_LIMITS.rules - 1);

export function selectionSpec(script: MacroScript): RoutineSpec<Selection> {
  return { name: script.name, durationSeconds: script.durationSeconds, maxActions: script.maxActions,
    rules: map(script.rules, (rule, ruleIndex) => ({ name: rule.name, priority: rule.priority,
      cooldownSeconds: rule.cooldownSeconds, maxRuns: rule.maxRuns, conditions: rule.conditions, action: { ruleIndex } })) };
}

/** Validate every cross-ledger invariant before a runtime may change its ownership. */
export function validateMacroCheckpoint(input: unknown): MacroCheckpoint {
  if (!record(input) || !keys(input, ['version', 'script', 'selector', 'sequence', 'retainedField', 'state', 'reason',
    'generation', 'nextId', 'startedAt', 'lastTime', 'actionsIssued', 'actionsCompleted', 'spendReserved'])
    || input.version !== 1 || (input.state !== 'running' && input.state !== 'monitoring')
    || typeof input.reason !== 'string' || input.reason.length > 200
    || !integer(input.generation, 1, Number.MAX_SAFE_INTEGER) || !integer(input.actionsIssued, 0, Number.MAX_SAFE_INTEGER)
    || input.actionsCompleted !== input.actionsIssued || !integer(input.nextId, input.actionsIssued, Number.MAX_SAFE_INTEGER)
    || !integer(input.startedAt, 0, Number.MAX_SAFE_INTEGER) || !integer(input.lastTime, input.startedAt, Number.MAX_SAFE_INTEGER)) {
    throw new Error('Invalid macro checkpoint.');
  }
  const script = validateMacroScript(input.script);
  const selector = validateRoutineSelectorCheckpoint(input.selector, validSelection);
  const lastTime = input.lastTime;
  if (JSON.stringify(selector.spec) !== JSON.stringify(selectionSpec(script))
    || selector.startedAt < input.startedAt
    || selector.progress.some(entry => entry.lastIssued !== null && entry.lastIssued > lastTime)
    || (script.durationSeconds > 0 && input.lastTime - input.startedAt >= script.durationSeconds * 1_000)
    || (script.maxActions > 0 && input.actionsIssued > script.maxActions)
    || !integer(input.spendReserved, 0, script.maxSpend)) throw new Error('Macro checkpoint limits or script disagree.');
  let sequence: MacroCheckpoint['sequence'] = null;
  if (input.sequence !== null) {
    const value = input.sequence;
    if (!record(value) || !keys(value, ['ruleIndex', 'stepIndex', 'selectorId'])
      || !integer(value.ruleIndex, 0, script.rules.length - 1)
      || !integer(value.stepIndex, 1, script.rules[value.ruleIndex]!.steps.length - 1)
      || !integer(value.selectorId, 1, selector.nextActionId) || selector.pending?.id !== value.selectorId
      || selector.pending.ruleIndex !== value.ruleIndex) throw new Error('Macro checkpoint cursor lost its selector owner.');
    sequence = { ruleIndex: value.ruleIndex, stepIndex: value.stepIndex, selectorId: value.selectorId };
  } else if (selector.pending !== null) throw new Error('Macro checkpoint has an unowned selection.');
  let completed = 0, spend = 0;
  const possibleFieldSteps: MacroStep[] = [];
  for (const [index, rule] of script.rules.entries()) {
    const runs = selector.progress[index]!.runs - (sequence?.ruleIndex === index ? 1 : 0);
    if (runs < 0) throw new Error('Macro checkpoint cursor has no selected rule.');
    completed += runs * rule.steps.length;
    spend += runs * rule.steps.reduce((sum, step) => sum + ('maxSpend' in step ? step.maxSpend : 0), 0);
    const lastField = [...rule.steps].reverse().find(step => step.type === 'farm' || step.type === 'travel');
    if (runs > 0 && lastField) possibleFieldSteps.push(lastField);
  }
  const prefix = sequence ? script.rules[sequence.ruleIndex]!.steps.slice(0, sequence.stepIndex) : [];
  completed += prefix.length;
  spend += prefix.reduce((sum, step) => sum + ('maxSpend' in step ? step.maxSpend : 0), 0);
  if (!Number.isSafeInteger(completed) || completed !== input.actionsCompleted || spend !== input.spendReserved
    || (sequence && script.maxActions > 0
      && script.rules[sequence.ruleIndex]!.steps.length - sequence.stepIndex > script.maxActions - completed)) {
    throw new Error('Macro checkpoint action or spend ledger disagrees with its cursor.');
  }
  const retainedField = input.retainedField;
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  const lastFieldStep = [...prefix].reverse().find(step => step.type === 'farm' || step.type === 'travel');
  // A confirmed prefix is newer than every completed sequence; otherwise only each
  // completed rule's final field effect can still own the field.
  const possibleFields = lastFieldStep ? [lastFieldStep] : possibleFieldSteps;
  if (retainedField !== null && (!validMacroStep(retainedField) || retainedField.type !== 'farm'
    || !possibleFields.some(step => step.type === 'farm' && same(step, retainedField)))) {
    throw new Error('Macro checkpoint field was never confirmed.');
  }
  if ((lastFieldStep && !same(retainedField, lastFieldStep.type === 'farm' ? lastFieldStep : null))
    || (retainedField === null && possibleFields.length > 0 && !possibleFields.some(step => step.type === 'travel'))
    || (input.state === 'monitoring') !== (retainedField !== null && sequence === null)
    || (!sequence && retainedField === null && (selector.state === 'completed'
      || (script.maxActions > 0 && completed >= script.maxActions)))) throw new Error('Macro checkpoint field or state disagrees.');
  return { version: 1, script, selector, sequence, retainedField: retainedField === null ? null : structuredClone(retainedField),
    state: input.state, reason: input.reason, generation: input.generation, nextId: input.nextId,
    startedAt: input.startedAt, lastTime: input.lastTime, actionsIssued: completed, actionsCompleted: completed, spendReserved: spend };
}

/** Pure validation and next-rule trace. It neither starts a clock nor reserves any spend. */
export function dryRunMacro(input: unknown, observation: RoutineObservation): MacroTrace {
  const script = validateMacroScript(input);
  const trace = dryRunRoutine(selectionSpec(script), observation, validSelection, selectorOptions);
  return { rules: map(trace.rules, ({ action, ...rule }) => ({ ...rule, ruleIndex: action.ruleIndex,
    steps: structuredClone(script.rules[action.ruleIndex]!.steps) })), rule: trace.rule,
    ruleIndex: trace.action?.ruleIndex ?? null,
    steps: trace.action ? structuredClone(script.rules[trace.action.ruleIndex]!.steps) : [] };
}

/** Publish known-zero inventory observations only for explicitly requested item conditions. */
export function macroInventoryItemIds(script: MacroScript): number[] {
  const ids = flatMap(script.rules, rule => flatMap(rule.conditions, condition =>
    condition.field === 'inventory' ? [condition.itemId] : []));
  return pipe(ids, dedupe, items => [...items].sort((a, b) => a - b));
}

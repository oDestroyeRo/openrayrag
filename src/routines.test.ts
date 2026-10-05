import { describe, expect, it } from 'vitest';
import { dryRunRoutine, ROUTINE_LIMITS, RoutineRuntime, validateRoutineSpec,
  type RoutineCondition, type RoutineObservation, type RoutineOptions, type RoutineRule, type RoutineSpec } from './routines';

type TestAction = { type: 'heal'; itemId: number } | { type: 'stop' };
const isAction = (value: unknown): value is TestAction => {
  if (!value || typeof value !== 'object') return false;
  const action = value as Record<string, unknown>;
  return action.type === 'stop' ? Object.keys(action).length === 1
    : action.type === 'heal' && Object.keys(action).length === 2 && Number.isInteger(action.itemId) && Number(action.itemId) > 0;
};
const hp: RoutineCondition = { field: 'hpPercent', operator: 'lte', value: 50 };
const rule = (options: Partial<RoutineRule<TestAction>> = {}): RoutineRule<TestAction> => ({
  name: 'Heal', priority: 10, cooldownSeconds: 2, maxRuns: 2, conditions: [{ ...hp }], action: { type: 'heal', itemId: 501 }, ...options,
});
const spec = (options: Partial<RoutineSpec<TestAction>> = {}): RoutineSpec<TestAction> => ({
  name: 'Recovery', durationSeconds: 60, maxActions: 5, rules: [rule()], ...options,
});
function setup(options: RoutineOptions = {}) {
  let time = 1_000;
  const runtime = new RoutineRuntime(isAction, () => time, options);
  return { runtime, advance: (milliseconds: number) => { time += milliseconds; }, setTime: (milliseconds: number) => { time = milliseconds; } };
}
function acknowledge(runtime: RoutineRuntime<TestAction>, success = true) {
  const actionId = runtime.snapshot().pendingActionId;
  expect(actionId).not.toBeNull();
  return runtime.acknowledge(success, actionId!);
}

describe('routine validation', () => {
  it('accepts a bounded catalog action and clones conditions/actions', () => {
    const original = spec();
    const validated = validateRoutineSpec(original, isAction);
    original.rules[0]!.conditions[0]!.value = 1;
    original.rules[0]!.action = { type: 'stop' };
    expect(validated.rules[0]!.conditions[0]!.value).toBe(50);
    expect(validated.rules[0]!.action).toEqual({ type: 'heal', itemId: 501 });
  });

  it.each([
    { durationSeconds: 0 }, { durationSeconds: 86_401 }, { durationSeconds: 1.5 },
    { maxActions: 0 }, { maxActions: 1_001 }, { name: '' }, { name: '\nunsafe' },
    { name: 'x'.repeat(65) }, { rules: [] }, { rules: Array.from({ length: 33 }, (_, index) => rule({ name: String(index) })) },
    { unexpected: 'script' },
  ])('rejects invalid top-level limits: %j', invalid => {
    expect(() => validateRoutineSpec({ ...spec(), ...invalid }, isAction)).toThrow();
  });

  it.each([
    { priority: 1_001 }, { priority: -1_001 }, { maxRuns: 0 }, { maxRuns: 1_001 },
    { cooldownSeconds: -1 }, { cooldownSeconds: 86_401 }, { cooldownSeconds: 0.5 },
    { conditions: [] }, { conditions: Array.from({ length: 17 }, () => hp) },
    { action: { type: 'eval', code: 'anything' } }, { script: 'anything' },
  ])('rejects invalid rule limits or unknown commands: %j', invalid => {
    expect(() => validateRoutineSpec(spec({ rules: [{ ...rule(), ...invalid } as RoutineRule<TestAction>] }), isAction)).toThrow();
  });

  it.each([
    { field: 'hpPercent', operator: 'lte', value: 101 },
    { field: 'spPercent', operator: 'gte', value: Number.NaN },
    { field: 'hpPercent', operator: 'lte', value: Number.POSITIVE_INFINITY },
    { field: 'inventory', itemId: 0, operator: 'eq', value: 0 },
    { field: 'inventory', itemId: 501, operator: 'eq', value: -1 },
    { field: 'zeny', operator: 'gt', value: 2_147_483_648 },
    { field: 'elapsedSeconds', operator: 'gte', value: 86_401 },
    { field: 'map', operator: 'eq', value: '../map' },
    { field: 'map', operator: 'contains', value: 'prontera' },
    { field: 'hpPercent', operator: 'eval', value: 50 },
    { field: 'hpPercent', operator: { toString: (): string => 'lte' }, value: 50 },
    { field: 'hpPercent', operator: 'lte', value: 50, script: 'anything' },
  ])('rejects invalid conditions: %j', condition => {
    expect(() => validateRoutineSpec(spec({ rules: [rule({ conditions: [condition as RoutineCondition] })] }), isAction)).toThrow();
  });

  it('rejects duplicate rule names and non-JSON actions', () => {
    expect(() => validateRoutineSpec(spec({ rules: [rule(), rule()] }), isAction)).toThrow(/unique/);
    expect(() => validateRoutineSpec(spec({ rules: [rule({ action: { type: 'stop', script: () => undefined } as TestAction })] }), isAction)).toThrow(/JSON/);
    const circular: Record<string, unknown> = { type: 'heal', itemId: 501 };
    circular.self = circular;
    expect(() => validateRoutineSpec(spec({ rules: [rule({ action: circular as TestAction })] }), isAction)).toThrow(/JSON/);
  });

  it('limits aggregate bytes even when individual actions pass the supplied catalog', () => {
    const broad = (value: unknown): value is { type: string; payload: string } => typeof value === 'object' && value !== null;
    const action = { type: 'known', payload: 'x'.repeat(4_000) };
    expect(() => validateRoutineSpec({ ...spec(), rules: Array.from({ length: 32 }, (_, index) => ({ ...rule({ name: String(index) }), action })) }, broad)).toThrow(/too large/);
    expect(() => validateRoutineSpec({ ...spec(), rules: [{ ...rule(), action: { type: 'known', payload: 'x'.repeat(4_100) } }] }, broad)).toThrow();
    expect(() => validateRoutineSpec({ ...spec(), rules: [{ ...rule(), action: { type: 'known', payload: 'ก'.repeat(2_000) } }] }, broad)).toThrow(/too large/);
  });

  it('accepts finite boundary budgets', () => {
    expect(validateRoutineSpec(spec({ durationSeconds: 86_400, maxActions: 1_000,
      rules: Array.from({ length: 32 }, (_, index) => rule({ name: String(index), priority: index ? 1_000 : -1_000,
        cooldownSeconds: 86_400, maxRuns: 1_000, conditions: Array.from({ length: 16 }, () => ({ ...hp })) })) }), isAction).rules).toHaveLength(32);
    expect(() => new RoutineRuntime(isAction, Date.now, { maxSteps: ROUTINE_LIMITS.maxSteps + 1 })).toThrow();
    expect(() => new RoutineRuntime(isAction, Date.now, { actionTimeoutSeconds: 0 })).toThrow();
    expect(() => new RoutineRuntime(isAction, Date.now, { actionTimeoutSeconds: 121 })).toThrow();
    expect(() => new RoutineRuntime(isAction, Date.now, { actionTimeoutSeconds: 121, actionTimeoutLimitSeconds: 86_400 })).not.toThrow();
    expect(() => new RoutineRuntime(isAction, Date.now, { actionTimeoutLimitSeconds: 86_401 })).toThrow();
  });
});

describe('macro selector opt-in', () => {
  const unlimited = () => spec({ durationSeconds: 0, maxActions: 0, rules: [rule({ maxRuns: 0, cooldownSeconds: 0 })] });
  const options: RoutineOptions = { allowUnlimitedLimits: true, actionTimeoutSeconds: 0, maxSteps: 0 };

  it('admits zero limits only with explicit opt-in and keeps legacy validation and previews finite', () => {
    expect(validateRoutineSpec(unlimited(), isAction, options)).toEqual(unlimited());
    expect(dryRunRoutine(unlimited(), { hpPercent: 40 }, isAction, options).rule).toBe('Heal');
    for (const allowUnlimitedLimits of [undefined, false]) {
      expect(() => validateRoutineSpec(unlimited(), isAction, { allowUnlimitedLimits })).toThrow();
      expect(() => dryRunRoutine(unlimited(), { hpPercent: 40 }, isAction, { allowUnlimitedLimits })).toThrow();
      expect(() => setup({ allowUnlimitedLimits, actionTimeoutSeconds: 0 })).toThrow();
      expect(() => setup({ allowUnlimitedLimits, maxSteps: 0 })).toThrow();
    }
    expect(() => validateRoutineSpec(spec({ rules: [rule({ conditions: [{ field: 'elapsedSeconds', operator: 'gt', value: 86_401 }] })] }), isAction, options)).toThrow();
  });

  it('retains positive confirmation and evaluation limits when the selector opts in', () => {
    const { runtime, advance } = setup({ allowUnlimitedLimits: true, actionTimeoutSeconds: 1, maxSteps: 2 });
    runtime.start(unlimited());
    runtime.tick({ hpPercent: 40 });
    advance(1_000);
    expect(acknowledge(runtime)).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1 });
    runtime.start(unlimited());
    runtime.tick({}); runtime.tick({});
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', steps: 2, actionsIssued: 0 });
  });

  it('keeps an owned sequence pending across a day and rejects stale receipts after Stop', () => {
    const { runtime, advance } = setup(options);
    runtime.start(unlimited());
    runtime.tick({ hpPercent: 40 });
    const oldId = runtime.snapshot().pendingActionId!;
    advance(90_000_000);
    runtime.advance();
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'waiting', pendingActionId: oldId, actionsIssued: 1, elapsedSeconds: 90_000 });
    expect(acknowledge(runtime)).toBe(true);
    runtime.tick({ hpPercent: 40 });
    const stoppedId = runtime.snapshot().pendingActionId!;
    runtime.cancel();
    expect(runtime.acknowledge(true, stoppedId)).toBe(false);
    runtime.start(unlimited()); runtime.tick({ hpPercent: 40 });
    expect(runtime.acknowledge(true, stoppedId)).toBe(false);
    expect(runtime.snapshot().pendingActionId).toBeGreaterThan(stoppedId);
  });

  it('traces actual elapsed time beyond a day without clamping equality or changing legacy previews', () => {
    const value = spec({ durationSeconds: 0, maxActions: 0, rules: [rule({ maxRuns: 0, conditions: [
      { field: 'elapsedSeconds', operator: 'eq', value: 86_400 }] })] });
    const { runtime, advance } = setup(options);
    runtime.start(value);
    advance(90_000_000);
    expect(runtime.tick({ elapsedSeconds: 86_400 })).toBeNull();
    expect(runtime.trace({ elapsedSeconds: 86_400 }).rules[0]!.state).toBe('unmatched');
    expect(runtime.snapshot().elapsedSeconds).toBe(90_000);
    expect(dryRunRoutine(spec({ rules: value.rules.map(rule => ({ ...rule, maxRuns: 1 })) }),
      { elapsedSeconds: 90_000 }, isAction).rules[0]!.state).toBe('unavailable');
  });

  it('saturates unlimited evaluation telemetry while preserving dispatch ownership', () => {
    const { runtime } = setup(options);
    runtime.start(unlimited());
    Reflect.set(runtime, 'steps', Number.MAX_SAFE_INTEGER - 1);
    runtime.tick({}); runtime.tick({});
    expect(runtime.snapshot()).toMatchObject({ state: 'running', steps: Number.MAX_SAFE_INTEGER, actionsIssued: 0 });
    expect(runtime.tick({ hpPercent: 40 })).toEqual({ type: 'heal', itemId: 501 });
    expect(acknowledge(runtime)).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: 'running', steps: Number.MAX_SAFE_INTEGER, actionsCompleted: 1 });
  });

  it('never overflows selector action identities for unlimited run counts', () => {
    const { runtime } = setup(options);
    runtime.start(unlimited());
    Reflect.set(runtime, 'nextActionId', Number.MAX_SAFE_INTEGER - 1);
    runtime.tick({ hpPercent: 40 });
    expect(runtime.snapshot().pendingActionId).toBe(Number.MAX_SAFE_INTEGER);
    expect(acknowledge(runtime)).toBe(true);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1, actionsCompleted: 1 });
    expect(runtime.snapshot().reason).toMatch(/identity budget/);
  });
});

describe('routine preview', () => {
  it('validates and evaluates level, job level, and weight without inventing unknown observations', () => {
    const conditions: RoutineCondition[] = [{ field: 'level', operator: 'gte', value: 10 },
      { field: 'jobLevel', operator: 'eq', value: 1 }, { field: 'weightPercent', operator: 'eq', value: 0 }];
    const routine = spec({ rules: [rule({ conditions })] });
    expect(dryRunRoutine(routine, {}, isAction).rules[0]!.conditions.every(condition => condition.state === 'unavailable')).toBe(true);
    expect(dryRunRoutine(routine, { level: 10, jobLevel: 1, weightPercent: 0 }, isAction).rule).toBe('Heal');
    expect(dryRunRoutine(routine, { level: 0, jobLevel: 0, weightPercent: -1 }, isAction).rules[0]!.conditions.every(condition => condition.state === 'unavailable')).toBe(true);
    for (const condition of [{ field: 'level', operator: 'eq', value: 0 }, { field: 'level', operator: 'eq', value: 1.5 },
      { field: 'jobLevel', operator: 'eq', value: 1_001 }, { field: 'weightPercent', operator: 'eq', value: 101 }]) {
      expect(() => validateRoutineSpec(spec({ rules: [rule({ conditions: [condition as RoutineCondition] })] }), isAction)).toThrow();
    }
  });

  it('does not match missing HP/SP/map/zeny/item observations, including map inequality and count zero', () => {
    const conditions: RoutineCondition[] = [hp, { field: 'spPercent', operator: 'eq', value: 0 },
      { field: 'map', operator: 'ne', value: 'prontera' }, { field: 'zeny', operator: 'eq', value: 0 },
      { field: 'inventory', itemId: 501, operator: 'eq', value: 0 }];
    const trace = dryRunRoutine(spec({ rules: conditions.map((condition, index) => rule({ name: String(index), conditions: [condition] })) }), {}, isAction);
    expect(trace.action).toBeNull();
    expect(trace.rules.every(rule => rule.state === 'unavailable' && rule.conditions[0]!.reason.includes('unavailable'))).toBe(true);
    const missingItem = dryRunRoutine(spec({ rules: [rule({ conditions: [{ field: 'inventory', itemId: 501, operator: 'eq', value: 0 }] })] }), { inventory: {} }, isAction);
    expect(missingItem.rules[0]!.state).toBe('unavailable');
  });

  it('uses known zero counts and AND conditions, and reports unmatched conditions', () => {
    const routine = spec({ rules: [rule({ conditions: [hp, { field: 'inventory', itemId: 501, operator: 'eq', value: 0 },
      { field: 'spPercent', operator: 'gte', value: 20 }, { field: 'map', operator: 'eq', value: 'prt_fild08' }] })] });
    const observation = { hpPercent: 40, spPercent: 30, map: 'prt_fild08', inventory: { 501: 0 } };
    expect(dryRunRoutine(routine, observation, isAction).rule).toBe('Heal');
    const trace = dryRunRoutine(routine, { ...observation, hpPercent: 90 }, isAction);
    expect(trace.action).toBeNull();
    expect(trace.rules[0]!.conditions[0]!.state).toBe('unmatched');
  });

  it.each([
    { operator: 'lt', actual: 49, expected: true }, { operator: 'lte', actual: 50, expected: true },
    { operator: 'eq', actual: 50, expected: true }, { operator: 'gte', actual: 50, expected: true },
    { operator: 'gt', actual: 50, expected: false },
  ] as const)('evaluates numeric operator $operator', ({ operator, actual, expected }) => {
    const trace = dryRunRoutine(spec({ rules: [rule({ conditions: [{ field: 'hpPercent', operator, value: 50 }] })] }), { hpPercent: actual }, isAction);
    expect(trace.action !== null).toBe(expected);
  });

  it.each([{ hpPercent: -1 }, { spPercent: 101 }, { zeny: 1.5 }, { zeny: -1 }, { map: '../map' },
    { inventory: { 501: Number.NaN } }])('treats malformed observations as unavailable: %j', observation => {
    const field = Object.keys(observation)[0]!;
    const condition: RoutineCondition = field === 'map' ? { field: 'map', operator: 'ne', value: 'prontera' }
      : field === 'inventory' ? { field: 'inventory', itemId: 501, operator: 'eq', value: 0 }
        : { field: field as 'hpPercent' | 'spPercent' | 'zeny', operator: 'lte', value: 50 };
    expect(dryRunRoutine(spec({ rules: [rule({ conditions: [condition] })] }), observation as RoutineObservation, isAction).rules[0]!.state).toBe('unavailable');
  });

  it('sorts matching rules by priority, preserving declaration order for ties, without running anything', () => {
    const routine = spec({ rules: [rule({ name: 'first', priority: 5 }), rule({ name: 'second', priority: 20 }), rule({ name: 'third', priority: 20 })] });
    expect(dryRunRoutine(routine, { hpPercent: 40 }, isAction).rules.map(rule => rule.name)).toEqual(['second', 'third', 'first']);
    expect(dryRunRoutine(routine, { hpPercent: 40 }, isAction).rule).toBe('second');
  });
});

describe('routine execution', () => {
  it('requires explicit start, owns only one pending action, and returns defensive action copies', () => {
    const { runtime } = setup();
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('idle');
    runtime.start(spec());
    const action = runtime.tick({ hpPercent: 40 });
    expect(action).toEqual({ type: 'heal', itemId: 501 });
    if (action?.type === 'heal') action.itemId = 999;
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'waiting', currentRule: 'Heal', actionsIssued: 1, actionsCompleted: 0 });
    expect(runtime.trace({ hpPercent: 40 }).action).toBeNull();
    expect(acknowledge(runtime)).toBe(true);
    expect(runtime.snapshot().state).toBe('running');
    expect(runtime.trace({ hpPercent: 40 }).rules[0]!.action).toEqual({ type: 'heal', itemId: 501 });
  });

  it('waits for cooldown and chooses a lower-priority ready rule, then exhausts each rule budget', () => {
    const { runtime, advance } = setup();
    runtime.start(spec({ rules: [rule({ name: 'high', priority: 20, maxRuns: 2 }), rule({ name: 'low', priority: 1, maxRuns: 1, action: { type: 'stop' } })] }));
    expect(runtime.tick({ hpPercent: 40 })).toEqual({ type: 'heal', itemId: 501 });
    acknowledge(runtime);
    expect(runtime.trace({ hpPercent: 40 }).rules[0]!.state).toBe('cooldown');
    expect(runtime.tick({ hpPercent: 40 })).toEqual({ type: 'stop' });
    acknowledge(runtime);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    advance(2_000);
    expect(runtime.tick({ hpPercent: 40 })).toEqual({ type: 'heal', itemId: 501 });
    acknowledge(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', actionsIssued: 3, actionsCompleted: 3 });
    advance(10_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
  });

  it('uses its own elapsed clock and ignores a caller-supplied elapsed override', () => {
    const { runtime, advance } = setup();
    runtime.start(spec({ rules: [rule({ conditions: [{ field: 'elapsedSeconds', operator: 'gte', value: 5 }] })] }));
    expect(runtime.tick({ elapsedSeconds: 50 })).toBeNull();
    advance(5_000);
    expect(runtime.tick({ elapsedSeconds: 0 })).toEqual({ type: 'heal', itemId: 501 });
    expect(runtime.snapshot().elapsedSeconds).toBe(5);
  });

  it('halts after an uncertain result and never retries it', () => {
    const { runtime, advance } = setup();
    runtime.start(spec());
    runtime.tick({ hpPercent: 40 });
    expect(acknowledge(runtime, false)).toBe(true);
    advance(5_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1, actionsCompleted: 0, pendingActionId: null });
  });

  it('halts at the confirmation timeout without resending and rejects late acknowledgements', () => {
    const { runtime, advance } = setup();
    runtime.start(spec());
    runtime.tick({ hpPercent: 40 });
    const oldId = runtime.snapshot().pendingActionId!;
    advance(9_999);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('waiting');
    advance(1);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1, pendingActionId: null });
    expect(runtime.snapshot().reason).toMatch(/timed out/);
    expect(runtime.acknowledge(true, oldId)).toBe(false);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
  });

  it('checks timeout when a delayed acknowledgement arrives without an intervening tick', () => {
    const { runtime, advance } = setup();
    runtime.start(spec());
    runtime.tick({ hpPercent: 40 });
    const oldId = runtime.snapshot().pendingActionId!;
    advance(10_000);
    expect(runtime.acknowledge(true, oldId)).toBe(false);
    expect(runtime.snapshot().state).toBe('failed');
  });

  it('Stop invalidates pending IDs, requires explicit restart, and rejects an earlier-run acknowledgement', () => {
    const { runtime } = setup();
    const original = spec();
    runtime.start(original);
    runtime.tick({ hpPercent: 40 });
    const oldId = runtime.snapshot().pendingActionId!;
    runtime.cancel();
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.acknowledge(true, oldId)).toBe(false);
    expect(runtime.snapshot().state).toBe('cancelled');
    expect(runtime.trace({ hpPercent: 40 }).action).toBeNull();
    runtime.start(original);
    runtime.tick({ hpPercent: 40 });
    expect(runtime.snapshot().pendingActionId).not.toBe(oldId);
    expect(runtime.acknowledge(true, oldId)).toBe(false);
    expect(runtime.snapshot().state).toBe('waiting');
    expect(acknowledge(runtime)).toBe(true);
  });

  it('rejects replacement while active and does not consume the current pending action', () => {
    const { runtime } = setup();
    runtime.start(spec());
    runtime.tick({ hpPercent: 40 });
    const pending = runtime.snapshot().pendingActionId;
    expect(() => runtime.start(spec({ name: 'other' }))).toThrow(/Stop/);
    expect(runtime.snapshot().pendingActionId).toBe(pending);
    expect(acknowledge(runtime)).toBe(true);
  });

  it('enforces the global action budget after the final owned result', () => {
    const { runtime, advance } = setup();
    runtime.start(spec({ maxActions: 1, rules: [rule({ maxRuns: 100, cooldownSeconds: 0 })] }));
    runtime.tick({ hpPercent: 40 });
    expect(runtime.snapshot().state).toBe('waiting');
    acknowledge(runtime);
    advance(1_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', actionsIssued: 1 });
  });

  it('enforces the finite evaluation budget even when no observation matches', () => {
    const { runtime } = setup({ maxSteps: 2 });
    runtime.start(spec());
    expect(runtime.tick({})).toBeNull();
    expect(runtime.tick({})).toBeNull();
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', steps: 2, actionsIssued: 0 });
    expect(runtime.snapshot().reason).toMatch(/evaluation budget/);
  });

  it('completes at duration without a pending action, and halts uncertain pending work', () => {
    const { runtime, advance } = setup();
    runtime.start(spec({ durationSeconds: 1 }));
    advance(1_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('completed');
    runtime.start(spec({ durationSeconds: 1 }));
    runtime.tick({ hpPercent: 40 });
    const pendingId = runtime.snapshot().pendingActionId!;
    advance(1_000);
    expect(runtime.acknowledge(true, pendingId)).toBe(false);
    expect(runtime.snapshot().state).toBe('failed');
    expect(runtime.snapshot().reason).toMatch(/unconfirmed/);
  });

  it('stops on a reversed or unavailable clock without dispatching more actions', () => {
    const { runtime, setTime } = setup();
    runtime.start(spec());
    setTime(999);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('failed');
    expect(runtime.snapshot().elapsedSeconds).toBe(0);
    setTime(2_000);
    runtime.start(spec());
    setTime(Number.NaN);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('failed');
    expect(() => runtime.start(spec())).toThrow(/clock/);
  });
});

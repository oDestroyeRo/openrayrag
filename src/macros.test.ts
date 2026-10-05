import { describe, expect, it } from 'vitest';
import cases from './data/macro-script-cases.json';
import { dryRunMacro, MACRO_LIMITS, MacroRuntime, validateMacroScript,
  type MacroRule, type MacroScript, type MacroStep } from './macros';

const item: MacroStep = { type: 'useItem', itemId: 501, timeoutSeconds: 10 };
const farm: MacroStep = { type: 'farm', map: 'prt_fild08', targets: [1002], timeoutSeconds: 120 };
const rule = (options: Partial<MacroRule> = {}): MacroRule => ({ name: 'Recover', priority: 10,
  cooldownSeconds: 0, maxRuns: 1, conditions: [{ field: 'hpPercent', operator: 'lte', value: 50 }],
  steps: [{ ...item }], ...options });
const script = (options: Partial<MacroScript> = {}): MacroScript => ({ version: 1, name: 'Train',
  durationSeconds: 600, maxActions: 10, maxSpend: 1_000, rules: [rule()], ...options });
const buy = (maxSpend: number): MacroStep => ({ type: 'buy', serviceId: 'tool-dealer-buy', itemId: 501,
  quantity: 1, maxSpend, timeoutSeconds: 120 });
function setup() {
  let time = 1_000;
  return { runtime: new MacroRuntime(() => time), advance: (ms: number) => { time += ms; }, setTime: (ms: number) => { time = ms; } };
}
function confirm(runtime: MacroRuntime, confirmed = true) {
  const id = runtime.currentIntent?.id;
  expect(id).toBeDefined();
  return runtime.acknowledge(id!, confirmed);
}

describe('macro protocol validation', () => {
  it.each(cases)('$name matches the shared native validation corpus', ({ script, valid }) => {
    if (valid) expect(validateMacroScript(script).version).toBe(1);
    else expect(() => validateMacroScript(script)).toThrow();
  });

  it('clones the complete script and rejects non-JSON or oversized documents', () => {
    const original = script();
    const validated = validateMacroScript(original);
    original.rules[0]!.steps[0] = { ...farm };
    original.rules[0]!.conditions[0]!.value = 0;
    expect(validated.rules[0]!.steps[0]).toEqual(item);
    expect(validated.rules[0]!.conditions[0]!.value).toBe(50);
    expect(() => validateMacroScript({ ...script(), code: () => 1 })).toThrow(/JSON/);
    expect(() => validateMacroScript({ ...script(), maxSpend: Number.NaN })).toThrow(/JSON/);
    const circular: Record<string, unknown> = { ...script() };
    circular.self = circular;
    expect(() => validateMacroScript(circular)).toThrow(/JSON/);
    const huge = script({ rules: Array.from({ length: 32 }, (_, index) => rule({ name: String(index),
      steps: Array.from({ length: 16 }, () => ({ ...farm, targets: Array.from({ length: 64 }, (_, i) => 2_000_000_000 + i) })) })) });
    expect(() => validateMacroScript(huge)).toThrow(/too large/);
  });

  it('does not impose the routine actionBytes cap on a valid ordered step array', () => {
    const large = script({ maxActions: 16, rules: [rule({ steps: Array.from({ length: 16 }, () => ({ ...farm,
      targets: Array.from({ length: 64 }, (_, index) => 2_000_000_000 + index) })) })] });
    expect(JSON.stringify(large.rules[0]!.steps).length).toBeGreaterThan(4_096);
    expect(new TextEncoder().encode(JSON.stringify(large)).length).toBeLessThan(MACRO_LIMITS.documentBytes);
    const { runtime } = setup();
    expect(() => runtime.start(large)).not.toThrow();
    expect(runtime.tick({ hpPercent: 40 })?.step.type).toBe('farm');
  });
});

describe('macro dry run', () => {
  it('traces levels, weight, and known-zero inventory without issuing effects', () => {
    const original = script({ rules: [rule({ conditions: [{ field: 'level', operator: 'gte', value: 10 },
      { field: 'jobLevel', operator: 'eq', value: 5 }, { field: 'weightPercent', operator: 'gte', value: 0 },
      { field: 'inventory', itemId: 501, operator: 'eq', value: 0 }] })] });
    const missing = dryRunMacro(original, {});
    expect(missing.rule).toBeNull();
    expect(missing.rules[0]!.conditions.map(condition => condition.state)).toEqual(Array(4).fill('unavailable'));
    expect(dryRunMacro(original, { level: 10, jobLevel: 5, weightPercent: 0, inventory: {} }).rule).toBeNull();
    const trace = dryRunMacro(original, { level: 10, jobLevel: 5, weightPercent: 0, inventory: { 501: 0 } });
    expect(trace).toMatchObject({ rule: 'Recover', ruleIndex: 0, steps: [item] });
    trace.steps[0]!.timeoutSeconds = 99;
    expect(original.rules[0]!.steps[0]!.timeoutSeconds).toBe(10);
    const { runtime } = setup();
    expect(runtime.snapshot()).toMatchObject({ state: 'idle', actionsIssued: 0, spendReserved: 0 });
    runtime.start(original);
    expect(runtime.inventoryItemIds()).toEqual([501]);
  });
});

describe('macro owned ordered execution', () => {
  it('selects by priority and evaluates conditions once for the complete sequence', () => {
    const { runtime } = setup();
    runtime.start(script({ rules: [rule({ name: 'low', priority: 0 }), rule({ name: 'high', priority: 20,
      steps: [item, { type: 'skill', skillId: 28, level: 1, mode: 'self', timeoutSeconds: 10 }] })] }));
    const first = runtime.tick({ hpPercent: 40 })!;
    expect(first).toMatchObject({ ruleIndex: 1, stepIndex: 0, step: item });
    expect(runtime.tick({ hpPercent: 90 })).toBeNull();
    expect(runtime.acknowledge(first.id + 10, true)).toBe(false);
    expect(confirm(runtime)).toBe(true);
    const second = runtime.tick({ hpPercent: 90 })!;
    expect(second).toMatchObject({ ruleIndex: 1, stepIndex: 1, step: { type: 'skill' } });
    expect(second.id).toBeGreaterThan(first.id);
    confirm(runtime);
    expect(runtime.tick({ hpPercent: 90 })).toBeNull();
    expect(runtime.tick({ hpPercent: 40 })).toMatchObject({ ruleIndex: 0, stepIndex: 0 });
    confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', actionsIssued: 3, actionsCompleted: 3,
      sequencesIssued: 2, sequencesCompleted: 2 });
  });

  it('preserves declaration order for priority ties and reuses scheduler cooldowns', () => {
    const { runtime, advance } = setup();
    runtime.start(script({ rules: [rule({ name: 'first', priority: 20, maxRuns: 2, cooldownSeconds: 5 }),
      rule({ name: 'second', priority: 20 })] }));
    expect(runtime.tick({ hpPercent: 40 })?.ruleIndex).toBe(0);
    confirm(runtime);
    expect(runtime.tick({ hpPercent: 40 })?.ruleIndex).toBe(1);
    confirm(runtime);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    advance(5_000);
    expect(runtime.tick({ hpPercent: 40 })?.ruleIndex).toBe(0);
    confirm(runtime);
    expect(runtime.snapshot().state).toBe('completed');
  });

  it('returns defensive intent copies and uses the running clock for elapsed conditions', () => {
    const { runtime, advance } = setup();
    const original = script({ rules: [rule({ steps: [buy(50)], conditions: [{ field: 'elapsedSeconds', operator: 'gte', value: 5 }] })] });
    runtime.start(original);
    original.rules[0]!.steps[0] = { ...farm };
    expect(runtime.tick({ elapsedSeconds: 500 })).toBeNull();
    advance(5_000);
    const intent = runtime.tick({ elapsedSeconds: 0 })!;
    intent.step.timeoutSeconds = 1;
    const current = runtime.currentIntent!;
    expect(current.step).toEqual(buy(50));
    current.id = 0;
    expect(runtime.snapshot().pendingActionId).toBe(intent.id);
  });

  it('consumes spend reservations across rules before effects and never refunds uncertain costs', () => {
    const { runtime } = setup();
    runtime.start(script({ maxSpend: 100, rules: [rule({ name: 'first', steps: [buy(60)] }),
      rule({ name: 'second', steps: [buy(60)] })] }));
    expect(runtime.tick({ hpPercent: 40 })?.step).toEqual(buy(60));
    expect(runtime.snapshot().spendReserved).toBe(60);
    confirm(runtime);
    expect(runtime.tick({ hpPercent: 40, zeny: 2_000_000_000 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1, spendReserved: 60 });
    runtime.start(script({ rules: [rule({ steps: [{ type: 'store', serviceId: 'kafra-south-storage',
      itemId: 501, quantity: 1, keep: 0, maxSpend: 20, timeoutSeconds: 10 }] })] }));
    runtime.tick({ hpPercent: 40 });
    expect(runtime.snapshot().spendReserved).toBe(20);
    confirm(runtime, false);
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', spendReserved: 20 });
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
  });

  it('counts actual steps and rejects a sequence that cannot fit before its first effect', () => {
    const { runtime } = setup();
    runtime.start(script({ maxActions: 1, rules: [rule({ steps: [item, item] })] }));
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 0 });
    runtime.start(script({ maxActions: 2, rules: [rule({ maxRuns: 100, steps: [item, item] })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', actionsIssued: 2, sequencesCompleted: 1 });
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
  });

  it('invalidates stopped ownership and rejects late ACKs before and after restart', () => {
    const { runtime } = setup();
    runtime.start(script());
    const old = runtime.tick({ hpPercent: 40 })!;
    expect(() => runtime.start(script())).toThrow(/Stop/);
    expect(runtime.currentIntent?.id).toBe(old.id);
    runtime.cancel();
    expect(runtime.active).toBe(false);
    expect(runtime.currentIntent).toBeNull();
    expect(runtime.acknowledge(old.id, true)).toBe(false);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    runtime.start(script());
    const next = runtime.tick({ hpPercent: 40 })!;
    expect(next.id).toBeGreaterThan(old.id);
    expect(next.generation).toBeGreaterThan(old.generation);
    expect(runtime.acknowledge(old.id, true)).toBe(false);
    expect(runtime.currentIntent?.id).toBe(next.id);
  });

  it('never reissues a failed or uncertain effect and keeps its failure reason', () => {
    const { runtime } = setup();
    runtime.start(script({ rules: [rule({ maxRuns: 100, steps: [item, item] })] }));
    const intent = runtime.tick({ hpPercent: 40 })!;
    expect(runtime.acknowledge(intent.id, false, 'Inventory result was uncertain.')).toBe(true);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.acknowledge(intent.id, true)).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', reason: 'Inventory result was uncertain.', actionsIssued: 1 });
  });

  it('checks the exact per-step deadline on ticks and delayed acknowledgements', () => {
    const { runtime, advance } = setup();
    runtime.start(script());
    const intent = runtime.tick({ hpPercent: 40 })!;
    advance(9_999);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('waiting');
    advance(1);
    expect(runtime.acknowledge(intent.id, true)).toBe(false);
    expect(runtime.snapshot().state).toBe('failed');
    expect(runtime.snapshot().reason).toMatch(/timed out/);
    runtime.start(script());
    runtime.tick({ hpPercent: 40 });
    advance(10_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('failed');
  });

  it('supports long travel deadlines without changing legacy routine timeouts', () => {
    const { runtime, advance } = setup();
    runtime.start(script({ durationSeconds: 1_000, rules: [rule({ steps: [
      { type: 'travel', map: 'prontera', timeoutSeconds: 600 }, item] })] }));
    runtime.tick({ hpPercent: 40 });
    advance(121_000);
    expect(confirm(runtime)).toBe(true);
    expect(runtime.tick({ hpPercent: 90 })?.step.type).toBe('useItem');
    confirm(runtime);
    expect(runtime.snapshot().state).toBe('completed');
  });

  it('completes at global duration only if no effect remains unconfirmed', () => {
    const { runtime, advance } = setup();
    runtime.start(script({ durationSeconds: 1 }));
    advance(1_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('completed');
    runtime.start(script({ durationSeconds: 1 }));
    const pending = runtime.tick({ hpPercent: 40 })!;
    advance(1_000);
    expect(runtime.acknowledge(pending.id, true)).toBe(false);
    expect(runtime.snapshot().state).toBe('failed');
    expect(runtime.snapshot().reason).toMatch(/unconfirmed/);
  });

  it('fails a reversed or unavailable clock without issuing effects', () => {
    const { runtime, setTime } = setup();
    runtime.start(script());
    setTime(999);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('failed');
    setTime(Number.NaN);
    expect(() => runtime.start(script())).toThrow(/clock/);
  });
});

describe('macro field supervision', () => {
  it('fails monitoring after the controller loses world ownership', () => {
    const { runtime } = setup();
    runtime.start(script({ rules: [rule({ steps: [farm] })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    expect(runtime.snapshot().state).toBe('monitoring');
    runtime.fail('Unexpected map change.');
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', fieldIntentActive: false, reason: 'Unexpected map change.' });
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    runtime.fail('A later stale event.');
    expect(runtime.snapshot().reason).toBe('Unexpected map change.');
  });

  it('monitors a one-run farm until duration even when every allowance is exhausted', () => {
    const { runtime, advance } = setup();
    runtime.start(script({ durationSeconds: 300, maxActions: 1, rules: [rule({ steps: [farm] })] }));
    const intent = runtime.tick({ hpPercent: 40 })!;
    expect(runtime.snapshot().fieldIntentActive).toBe(false);
    expect(runtime.acknowledge(intent.id, true)).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: 'monitoring', fieldIntentActive: true, fieldSuspended: false });
    expect(runtime.active).toBe(true);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    advance(120_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe('monitoring');
    advance(180_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', fieldIntentActive: false });
  });

  it('selects new level/inventory rules during farming and resumes after temporary steps', () => {
    const { runtime } = setup();
    runtime.start(script({ rules: [rule({ name: 'farm', priority: 0, steps: [farm],
      conditions: [{ field: 'level', operator: 'lt', value: 10 }] }), rule({ name: 'restock', priority: 20,
      conditions: [{ field: 'level', operator: 'gte', value: 10 }, { field: 'inventory', itemId: 501, operator: 'eq', value: 0 }],
      steps: [buy(50), item] })] }));
    runtime.tick({ level: 9 }); confirm(runtime);
    const retained = runtime.fieldIntent!;
    retained.targets.push(999);
    expect(runtime.fieldIntent).toEqual(farm);
    expect(runtime.tick({ level: 10, inventory: { 501: 0 } })?.step.type).toBe('buy');
    expect(runtime.snapshot()).toMatchObject({ fieldIntentActive: true, fieldSuspended: true });
    confirm(runtime);
    expect(runtime.tick({ level: 1, inventory: { 501: 100 } })?.step.type).toBe('useItem');
    confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'monitoring', fieldIntentActive: true, fieldSuspended: false });
    expect(runtime.fieldIntent).toEqual(farm);
  });

  it('travel confirmation clears field intent and Stop revokes monitoring', () => {
    const { runtime } = setup();
    runtime.start(script({ rules: [rule({ steps: [farm, { type: 'travel', map: 'prontera', timeoutSeconds: 60 }] })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    expect(runtime.fieldIntent).toEqual(farm);
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', fieldIntentActive: false });
    runtime.start(script({ rules: [rule({ steps: [farm] })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    runtime.cancel();
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', fieldIntentActive: false });
    expect(runtime.fieldIntent).toBeNull();
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
  });
});

describe('unlimited macro execution', () => {
  const unlimited = (options: Partial<MacroScript> = {}): MacroScript => script({ durationSeconds: 0,
    maxActions: 0, maxSpend: 0, rules: [rule({ maxRuns: 0 })], ...options });

  it('dry-runs explicit unlimited limits using actual elapsed observations beyond a day', () => {
    const value = unlimited({ rules: [rule({ maxRuns: 0,
      conditions: [{ field: 'elapsedSeconds', operator: 'gt', value: 86_400 }] })] });
    expect(dryRunMacro(value, { elapsedSeconds: 90_000 })).toMatchObject({ rule: 'Recover', steps: [item] });
    value.rules[0]!.conditions = [{ field: 'elapsedSeconds', operator: 'eq', value: 86_400 }];
    expect(dryRunMacro(value, { elapsedSeconds: 90_000 }).rules[0]!.state).toBe('unmatched');
    for (const elapsedSeconds of [Number.NaN, Number.POSITIVE_INFINITY, -1, Number.MAX_SAFE_INTEGER]) {
      expect(dryRunMacro(value, { elapsedSeconds }).rules[0]!.state).toBe('unavailable');
    }
  });

  it('uses the real running clock after 25 hours without accepting caller elapsed overrides', () => {
    const { runtime, advance } = setup();
    runtime.start(unlimited({ rules: [rule({ name: 'At one day', priority: 20, maxRuns: 0,
      conditions: [{ field: 'elapsedSeconds', operator: 'eq', value: 86_400 }] }),
    rule({ name: 'After one day', maxRuns: 0,
      conditions: [{ field: 'elapsedSeconds', operator: 'gt', value: 86_400 }] })] }));
    expect(runtime.tick({ elapsedSeconds: 90_000 })).toBeNull();
    advance(90_000_000);
    expect(runtime.tick({ elapsedSeconds: 0 })?.ruleIndex).toBe(1);
    expect(confirm(runtime)).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: 'running', elapsedSeconds: 90_000, actionsCompleted: 1 });
  });

  it('continues past 1,000 owned steps and rule runs without renewing the run or replaying intents', () => {
    const { runtime } = setup();
    runtime.start(unlimited({ rules: [rule({ maxRuns: 0, steps: [item, item] })] }));
    let lastId = 0;
    for (let index = 0; index < 1_001; index++) {
      for (let stepIndex = 0; stepIndex < 2; stepIndex++) {
        const intent = runtime.tick({ hpPercent: stepIndex ? 90 : 40 })!;
        expect(intent).toMatchObject({ generation: 1, ruleIndex: 0, stepIndex, step: item });
        expect(intent.id).toBeGreaterThan(lastId);
        expect(runtime.tick({ hpPercent: 40 })).toBeNull();
        expect(runtime.acknowledge(intent.id, true)).toBe(true);
        expect(runtime.acknowledge(intent.id, true)).toBe(false);
        lastId = intent.id;
      }
    }
    expect(runtime.snapshot()).toMatchObject({ state: 'running', generation: 1, actionsIssued: 2_002,
      actionsCompleted: 2_002, sequencesIssued: 1_001, sequencesCompleted: 1_001, spendReserved: 0 });
  });

  it('waits beyond the old lifetime evaluation budget and dispatches only when a rule matches', () => {
    const { runtime } = setup();
    runtime.start(unlimited());
    for (let index = 0; index <= 200_000; index++) runtime.tick({ hpPercent: 90 });
    expect(runtime.snapshot()).toMatchObject({ state: 'running', actionsIssued: 0, sequencesIssued: 0 });
    expect(runtime.tick({ hpPercent: 40 })?.step).toEqual(item);
    expect(confirm(runtime)).toBe(true);
    expect(runtime.snapshot()).toMatchObject({ state: 'running', actionsCompleted: 1 });
  });

  it('allows a sequence to span a day while every individual travel deadline remains finite', () => {
    const { runtime, advance } = setup();
    const travel: MacroStep = { type: 'travel', map: 'prontera', timeoutSeconds: 50_000 };
    runtime.start(unlimited({ maxActions: 2, rules: [rule({ steps: [travel, travel] })] }));
    for (let index = 0; index < 2; index++) {
      expect(runtime.tick({ hpPercent: index ? 90 : 40 })?.stepIndex).toBe(index);
      advance(46_800_000);
      expect(confirm(runtime)).toBe(true);
    }
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', elapsedSeconds: 93_600,
      actionsCompleted: 2, sequencesCompleted: 1 });
  });

  it('keeps a finite rule allowance when action count and duration are unlimited', () => {
    const { runtime } = setup();
    runtime.start(unlimited({ rules: [rule({ maxRuns: 2, steps: [item, item] })] }));
    for (let index = 0; index < 4; index++) { runtime.tick({ hpPercent: 40 }); confirm(runtime); }
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', actionsCompleted: 4, sequencesCompleted: 2 });
  });

  it('keeps a finite step allowance when duration and rule runs are unlimited', () => {
    const { runtime } = setup();
    runtime.start(unlimited({ maxActions: 2 }));
    for (let index = 0; index < 2; index++) { runtime.tick({ hpPercent: 40 }); confirm(runtime); }
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'completed', actionsCompleted: 2, sequencesCompleted: 2 });
    runtime.start(unlimited({ maxActions: 1, rules: [rule({ maxRuns: 0, steps: [item, item] })] }));
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 0 });
  });

  it.each([false, true])('keeps a finite duration with unlimited counts and pending work = %s', pending => {
    const { runtime, advance } = setup();
    runtime.start(unlimited({ durationSeconds: 1 }));
    const intent = pending ? runtime.tick({ hpPercent: 40 }) : null;
    advance(1_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot().state).toBe(pending ? 'failed' : 'completed');
    if (intent) expect(runtime.acknowledge(intent.id, true)).toBe(false);
  });

  it('exhausts finite rules independently while an unlimited lower-priority rule remains eligible', () => {
    const { runtime } = setup();
    runtime.start(unlimited({ rules: [rule({ name: 'Once', priority: 20 }), rule({ name: 'Repeat', maxRuns: 0 })] }));
    expect(runtime.tick({ hpPercent: 40 })?.ruleIndex).toBe(0); confirm(runtime);
    for (let index = 0; index < 2; index++) {
      expect(runtime.tick({ hpPercent: 40 })?.ruleIndex).toBe(1); confirm(runtime);
    }
    expect(runtime.snapshot()).toMatchObject({ state: 'running', sequencesCompleted: 3 });
  });

  it('keeps cooldowns active for unlimited rule runs', () => {
    const { runtime, advance } = setup();
    runtime.start(unlimited({ rules: [rule({ maxRuns: 0, cooldownSeconds: 5 })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    advance(4_999);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    advance(1);
    expect(runtime.tick({ hpPercent: 40 })?.step).toEqual(item);
    confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'running', actionsCompleted: 2 });
  });

  it.each([false, true])('retains uncertain-step and exact deadline failures with timeout = %s', timeout => {
    const { runtime, advance } = setup();
    runtime.start(unlimited());
    const intent = runtime.tick({ hpPercent: 40 })!;
    if (timeout) { advance(10_000); expect(runtime.acknowledge(intent.id, true)).toBe(false); }
    else expect(runtime.acknowledge(intent.id, false)).toBe(true);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.acknowledge(intent.id, true)).toBe(false);
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1, actionsCompleted: 0 });
  });

  it('does not turn a zero spend cap into unlimited spending', () => {
    const { runtime } = setup();
    expect(() => runtime.start(unlimited({ rules: [rule({ maxRuns: 0, steps: [buy(1)] })] }))).toThrow();
    runtime.start(unlimited({ maxSpend: 100, rules: [rule({ maxRuns: 0, steps: [buy(60)] })] }));
    expect(runtime.tick({ hpPercent: 40 })?.step).toEqual(buy(60)); confirm(runtime);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', spendReserved: 60, actionsIssued: 1 });
    runtime.start(unlimited({ rules: [rule({ maxRuns: 0, steps: [buy(0)] })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'running', spendReserved: 0 });
  });

  it('revokes unlimited pending ownership on Stop and cannot acknowledge it into a later run', () => {
    const { runtime } = setup();
    runtime.start(unlimited());
    const old = runtime.tick({ hpPercent: 40 })!;
    runtime.cancel();
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.acknowledge(old.id, true)).toBe(false);
    runtime.start(unlimited());
    const next = runtime.tick({ hpPercent: 40 })!;
    expect(next.id).toBeGreaterThan(old.id);
    expect(next.generation).toBeGreaterThan(old.generation);
    expect(runtime.acknowledge(old.id, true)).toBe(false);
    expect(runtime.currentIntent?.id).toBe(next.id);
    confirm(runtime);
    expect(runtime.snapshot()).toMatchObject({ state: 'running', actionsCompleted: 1 });
  });

  it('monitors a finite-run field indefinitely without resetting spent allowances', () => {
    const { runtime, advance } = setup();
    runtime.start(unlimited({ maxActions: 1, rules: [rule({ steps: [farm] })] }));
    runtime.tick({ hpPercent: 40 }); confirm(runtime);
    advance(90_000_000);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'monitoring', elapsedSeconds: 90_000,
      actionsIssued: 1, actionsCompleted: 1, sequencesCompleted: 1, fieldIntentActive: true });
    expect(runtime.snapshot().reason).toMatch(/until you stop/);
    runtime.cancel();
    expect(runtime.snapshot()).toMatchObject({ state: 'cancelled', fieldIntentActive: false });
  });

  it('fails safely at the action identity boundary instead of overflowing an unlimited run', () => {
    const { runtime } = setup();
    runtime.start(unlimited());
    Reflect.set(runtime, 'nextId', Number.MAX_SAFE_INTEGER - 1);
    const last = runtime.tick({ hpPercent: 40 })!;
    expect(last.id).toBe(Number.MAX_SAFE_INTEGER); confirm(runtime);
    expect(runtime.tick({ hpPercent: 40 })).toBeNull();
    expect(runtime.snapshot()).toMatchObject({ state: 'failed', actionsIssued: 1, actionsCompleted: 1 });
    expect(runtime.snapshot().reason).toMatch(/identity budget/);
  });
});

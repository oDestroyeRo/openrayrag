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

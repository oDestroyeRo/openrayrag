import { describe, expect, it } from 'vitest';
import { MacroDraft, MacroUi, macroActive, macroExample, macroBaseSettings, validMacroSnapshot } from './macro-ui';
import { dryRunMacro, MacroRuntime } from './macros';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION } from './settings';

class Store {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}
describe('macro editor documents', () => {
  it('starts farm scripts from an empty target draft without changing retained preferences',()=>{
    const settings={...structuredClone(DEFAULT_SETTINGS),map:'prt_fild08',targets:[],automation:structuredClone(DEFAULT_AUTOMATION)};
    const projected=macroBaseSettings(settings,macroExample('leveling'));
    expect(projected.targets).toEqual([4000,4012,4002]);expect(settings.targets).toEqual([]);
    expect(projected.automation).toEqual(settings.automation);
  });
  it('admits a standalone item script without targets and preserves explicit combat-off policy',()=>{
    const settings={...structuredClone(DEFAULT_SETTINGS),map:'prt_fild08',targets:[],automation:structuredClone(DEFAULT_AUTOMATION)};
    expect(macroBaseSettings(settings,macroExample('item')).automation?.combat.mode).toBe('off');
    settings.automation.combat.mode='off';
    expect(macroBaseSettings(settings,macroExample('leveling')).automation?.combat.mode).toBe('off');
    expect(settings.targets).toEqual([]);
  });
  it('preserves bounded native rejection messages for the user', () => {
    const result={hidden:true,textContent:''};let notice='';
    const view={result,hooks:{notify:(message:string)=>{notice=message;}}};
    const show=(error:unknown)=>Reflect.apply(Reflect.get(MacroUi.prototype,'error'),view,[error]);
    show('Wait for previous action receipts.');
    expect(result).toEqual({hidden:false,textContent:'Wait for previous action receipts.'});expect(notice).toBe(result.textContent);
    show('x'.repeat(2001));expect(notice.length).toBe(2000);
  });
  it.each(['leveling', 'continuous', 'buy', 'store', 'item', 'skill'] as const)('provides a valid portable %s example', kind => {
    const value = macroExample(kind);
    expect(value.version).toBe(1); expect(value.rules.length).toBeGreaterThan(0);
    expect(dryRunMacro(value, {}).rules.every(rule => rule.state === 'unavailable')).toBe(true);
  });
  it('uses the selected field and targets without sharing their mutable array', () => {
    const targets = [4000]; const script = macroExample('leveling', { map: 'prt_fild08', targets }); targets.push(4012);
    expect(script.rules[0]!.steps[0]).toMatchObject({ type: 'farm', map: 'prt_fild08', targets: [4000] });
  });
  it('offers an unlimited template that starts the field once and keeps monitoring First Aid', () => {
    const targets = [4000];
    const script = macroExample('continuous', { map: 'prt_fild07', targets }); targets.push(4012);
    expect(script).toMatchObject({ name: 'Until stopped', durationSeconds: 0, maxActions: 0, maxSpend: 0 });
    expect(script.rules[0]).toMatchObject({ name: 'Start farming', maxRuns: 1, steps: [{ type: 'farm', map: 'prt_fild07', targets: [4000], timeoutSeconds: 300 }] });
    expect(script.rules[1]).toMatchObject({ name: 'First Aid', maxRuns: 0, cooldownSeconds: 10,
      conditions: [{ field: 'hpPercent', operator: 'lt', value: 60 }, { field: 'spPercent', operator: 'gte', value: 30 }],
      steps: [{ type: 'skill', timeoutSeconds: 30 }] });
    expect(dryRunMacro(script, { level: 1, hpPercent: 100, spPercent: 100 }).rule).toBe('Start farming');
    expect(dryRunMacro(script, { level: 1, hpPercent: 50, spPercent: 100 }).rule).toBe('First Aid');
  });
  it('keeps the existing examples finite', () => {
    for (const kind of ['leveling', 'buy', 'store', 'item', 'skill'] as const) {
      const script = macroExample(kind);
      expect(script.durationSeconds).toBe(3600); expect(script.maxActions).toBe(20);
      expect(script.rules.every(rule => rule.maxRuns > 0)).toBe(true);
    }
  });
  it('distinguishes an absent item from unavailable inventory in preview', () => {
    const script = macroExample('buy');
    expect(dryRunMacro(script, { zeny: 1000 }).rule).toBeNull();
    expect(dryRunMacro(script, { zeny: 1000, inventory: { 501: 0 } }).rule).toBe('Restock potions');
  });
  it('restores only the validated document and never a running continuation', () => {
    const store = new Store(); const draft = new MacroDraft(store);
    draft.text = JSON.stringify(macroExample('item')); expect(draft.dirty).toBe(true); draft.save();
    const restored = new MacroDraft(store); expect(restored.read().name).toBe('Use a potion'); expect(restored.dirty).toBe(false);
    expect([...store.data.values()][0]).not.toContain('generation');
    expect([...store.data.values()][0]).not.toContain('pendingActionId');
  });
  it('saves and restores explicit zero limits without a running continuation', () => {
    const store = new Store(); const draft = new MacroDraft(store); const script = macroExample('continuous');
    draft.text = JSON.stringify(script); draft.save();
    const restored = new MacroDraft(store);
    expect(restored.restoreError).toBeNull(); expect(restored.dirty).toBe(false); expect(restored.read()).toEqual(script);
    expect(JSON.parse([...store.data.values()][0]!)).toEqual({ version: 1, script });
  });
  it('previews an unlimited draft without starting execution', () => {
    const draft = new MacroDraft(new Store()); const result = { hidden: true, textContent: '' }; let notices = 0; let starts = 0;
    const view = { draft, editor: { value: JSON.stringify(macroExample('continuous')) }, result,
      observation: { level: 1, hpPercent: 100, spPercent: 100 }, observedAt: Date.now(),
      hooks: { notify: () => { notices++; }, start: () => { starts++; } } };
    Reflect.apply(Reflect.get(MacroUi.prototype, 'preview'), view, []);
    expect(result.hidden).toBe(false); expect(result.textContent).toContain('Next sequence: Start farming');
    expect(result.textContent).toContain('Preview sends no commands.'); expect(notices).toBe(1); expect(starts).toBe(0);
    expect(draft.dirty).toBe(true);
  });
  it('passes zero limits to explicit Start while preserving the retained settings', async () => {
    const script = macroExample('continuous'); const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [], automation: structuredClone(DEFAULT_AUTOMATION) };
    const before = structuredClone(settings); const draft = new MacroDraft(new Store()); let request: unknown;
    const view = { draft, editor: { value: JSON.stringify(script) }, busy: false, locked: false, startButton: { disabled: false },
      hooks: { settings: () => settings, start: async (value: unknown) => { request = value; } }, error: (error: unknown) => { throw error; } };
    await Reflect.apply(Reflect.get(MacroUi.prototype, 'start'), view, []);
    expect(request).toMatchObject({ script }); expect(settings).toEqual(before);
    expect(view.busy).toBe(false); expect(view.startButton.disabled).toBe(false);
  });
  it('keeps the previous saved script when an invalid draft is saved', () => {
    const store = new Store(); const draft = new MacroDraft(store); draft.save(); const before = [...store.data.values()][0];
    draft.text = '{'; expect(() => draft.save()).toThrow(/JSON syntax/); expect([...store.data.values()][0]).toBe(before); expect(draft.dirty).toBe(true);
  });
  it('preserves unrecognized saved data until explicit replacement', () => {
    const store = new Store(); store.data.set('rayrag.companion.macro.v1', JSON.stringify({ version: 2, script: {} }));
    const before = [...store.data.values()][0]; const draft = new MacroDraft(store);
    expect(draft.restoreError).toMatch(/kept/); expect([...store.data.values()][0]).toBe(before);
  });
  it('does not mark a script saved when storage fails', () => {
    const draft = new MacroDraft({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    draft.text = JSON.stringify(macroExample('store')); expect(() => draft.save()).toThrow('quota'); expect(draft.dirty).toBe(true);
  });
  it('treats every macro phase as active and terminal states as stopped', () => {
    for (const state of ['running', 'waiting', 'monitoring']) expect(macroActive({ state })).toBe(true);
    for (const state of ['idle', 'completed', 'failed', 'cancelled']) expect(macroActive({ state })).toBe(false);
  });
  it('accepts controller snapshots while bounding malformed macro telemetry', () => {
    const snapshot = new MacroRuntime().snapshot();
    expect(validMacroSnapshot(snapshot)).toBe(true);
    for (const change of [{ state: 'unknown' }, { state: ['monitoring'] }, { state: { toString: () => 'monitoring' } }, { actionsIssued: NaN }, { stepIndex: 16 }, { pendingActionId: -1 }, { reason: 'x'.repeat(201) }, { credentials: 'unexpected' }]) {
      expect(validMacroSnapshot({ ...snapshot, ...change })).toBe(false);
    }
    expect(macroActive({ state: ['monitoring'] })).toBe(false);
  });
  it('accepts elapsed telemetry past one day up to the safe clock bound', () => {
    const snapshot = new MacroRuntime().snapshot();
    for (const elapsedSeconds of [86_400.001, 172_800, Number.MAX_SAFE_INTEGER / 1_000]) {
      expect(validMacroSnapshot({ ...snapshot, elapsedSeconds })).toBe(true);
    }
  });
  it('rejects malformed elapsed telemetry and unsafe action counters', () => {
    const snapshot = new MacroRuntime().snapshot();
    for (const elapsedSeconds of [-1, NaN, Infinity, '90000', Number.MAX_SAFE_INTEGER / 1_000 + 1]) {
      expect(validMacroSnapshot({ ...snapshot, elapsedSeconds })).toBe(false);
    }
    for (const key of ['generation', 'actionsIssued', 'actionsCompleted', 'sequencesIssued', 'sequencesCompleted', 'spendReserved']) {
      for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
        expect(validMacroSnapshot({ ...snapshot, [key]: value })).toBe(false);
      }
    }
  });
});

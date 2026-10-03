import { describe, expect, it } from 'vitest';
import { MacroDraft, MacroUi, macroActive, macroExample, validMacroSnapshot } from './macro-ui';
import { dryRunMacro, MacroRuntime } from './macros';

class Store {
  data = new Map<string, string>();
  getItem(key: string): string | null { return this.data.get(key) ?? null; }
  setItem(key: string, value: string): void { this.data.set(key, value); }
}
describe('macro editor documents', () => {
  it('preserves bounded native rejection messages for the user', () => {
    const result={hidden:true,textContent:''};let notice='';
    const view={result,hooks:{notify:(message:string)=>{notice=message;}}};
    const show=(error:unknown)=>Reflect.apply(Reflect.get(MacroUi.prototype,'error'),view,[error]);
    show('Wait for previous action receipts.');
    expect(result).toEqual({hidden:false,textContent:'Wait for previous action receipts.'});expect(notice).toBe(result.textContent);
    show('x'.repeat(2001));expect(notice.length).toBe(2000);
  });
  it.each(['leveling', 'buy', 'store', 'item', 'skill'] as const)('provides a valid portable %s example', kind => {
    const value = macroExample(kind);
    expect(value.version).toBe(1); expect(value.rules.length).toBeGreaterThan(0);
    expect(dryRunMacro(value, {}).rules.every(rule => rule.state === 'unavailable')).toBe(true);
  });
  it('uses the selected field and targets without sharing their mutable array', () => {
    const targets = [4000]; const script = macroExample('leveling', { map: 'prt_fild08', targets }); targets.push(4012);
    expect(script.rules[0]!.steps[0]).toMatchObject({ type: 'farm', map: 'prt_fild08', targets: [4000] });
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
});

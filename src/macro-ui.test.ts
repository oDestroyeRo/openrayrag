import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureUi } from './feature-ui';
import { BOT_SCRIPT_LIMITS, formatBotScript, parseBotScript } from './bot-script';
import * as botScript from './bot-script';
import { MacroDraft, MacroUi, macroActive, macroExample, macroBaseSettings, validMacroSnapshot } from './macro-ui';
import { dryRunMacro, MacroRuntime } from './macros';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION, validateFormSettings, type SettingsInput } from './settings';

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
  it('starts with settings only and no silently enabled example rules', () => {
    const store = new Store(); const draft = new MacroDraft(store);
    expect(draft.read().script).toBeNull(); expect(draft.read().settings).toEqual(DEFAULT_SETTINGS);
    expect(draft.dirty).toBe(false); expect(draft.unsaved).toBe(false); expect(store.data.size).toBe(0);
  });
  it('imports legacy JSON using retained settings and saves readable source without execution state', () => {
    const store = new Store(); const draft = new MacroDraft(store);
    const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [4000], radius: 14 };
    draft.syncSettings(settings); draft.text = JSON.stringify(macroExample('item')); draft.save();
    const restored = new MacroDraft(store);
    expect(restored.read()).toEqual({ settings, script: macroExample('item') }); expect(restored.dirty).toBe(false);
    const value = JSON.parse(store.data.get('rayrag.companion.setup-script.v1')!);
    expect(value.source).toContain('rule "Use a potion"'); expect(value.source).not.toContain('pendingActionId');
  });
  it('migrates the old local macro without writing and lets native retained settings override cached settings', () => {
    const store = new Store(); const script = macroExample('continuous');
    store.data.set('rayrag.companion.macro.v1', JSON.stringify({ version: 1, script }));
    const before = [...store.data]; const draft = new MacroDraft(store);
    const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild07', targets: [4012], radius: 18 };
    draft.syncSettings(settings);
    expect(draft.read()).toEqual({ settings, script }); expect([...store.data]).toEqual(before);
    expect(draft.dirty).toBe(false); expect(draft.unsaved).toBe(false);
  });
  it('preserves comments and rules through Form sync and explicit Save without derived dirty flags', () => {
    const store = new Store(); const draft = new MacroDraft(store);
    draft.text = '# my setup\n' + formatBotScript({ settings: DEFAULT_SETTINGS, script: macroExample('item') }) + '\n# keep this rule note\n';
    draft.save(); const before = draft.text.slice(draft.text.indexOf('rule '));
    const settings = { ...structuredClone(DEFAULT_SETTINGS), radius: 19 };
    draft.syncSettings(settings);
    expect(draft.read().settings.radius).toBe(19); expect(draft.text).toContain('# my setup');
    expect(draft.text.slice(draft.text.indexOf('rule '))).toBe(before);
    expect(draft.dirty).toBe(false); expect(draft.unsaved).toBe(false);
    draft.save(); expect(JSON.parse(store.data.get('rayrag.companion.setup-script.v1')!).source).toBe(draft.text);
  });
  it('protects a manually dirty source across delayed native settings restoration and discards to the latest settings', () => {
    const draft = new MacroDraft(new Store()); draft.text = draft.text.replace('set radius = 12', 'set radius = 14');
    const manual = draft.text; draft.syncSettings({ ...structuredClone(DEFAULT_SETTINGS), radius: 18 });
    expect(draft.text).toBe(manual); expect(draft.read().settings.radius).toBe(14);
    expect(() => draft.configured()).toThrow('Apply or discard');
    draft.discard(); expect(draft.configured().settings.radius).toBe(18); expect(draft.dirty).toBe(false);
  });
  it('synchronizes distinct applied and saved rules while retaining a dirty draft and detached configuration', () => {
    const store = new Store(), draft = new MacroDraft(store);
    draft.text = '# saved notes\r\n' + formatBotScript({ settings: DEFAULT_SETTINGS, script: macroExample('item') }).replaceAll('\n', '\r\n');
    draft.save(); const persisted = [...store.data];
    draft.text = '# applied notes\r\n' + formatBotScript({ settings: DEFAULT_SETTINGS, script: macroExample('continuous') }).replaceAll('\n', '\r\n');
    draft.apply(draft.read());
    const settings = { ...structuredClone(DEFAULT_SETTINGS), radius: 18 };
    draft.syncSettings(settings);
    const configured = draft.configured();
    expect(configured).toEqual({ settings, script: macroExample('continuous') });
    expect(configured).toEqual(draft.read());
    Reflect.set(configured.settings, 'radius', 1); configured.script!.rules.length = 0; settings.radius = 19;
    expect(draft.configured().settings.radius).toBe(18); expect(draft.enabledScript?.rules).toHaveLength(2);
    expect(draft.text).toContain('# applied notes\r\n'); expect(draft.unsaved).toBe(true);
    draft.text += '\r\ninvalid manual draft'; const manual = draft.text;
    draft.syncSettings(settings);
    expect(draft.text).toBe(manual); expect(draft.dirty).toBe(true);
    expect(() => draft.configured()).toThrow('Apply or discard');
    draft.discard();
    expect(draft.configured()).toEqual({ settings, script: macroExample('item') });
    expect(draft.text).toContain('# saved notes\r\n'); expect(draft.unsaved).toBe(false);
    expect([...store.data]).toEqual(persisted);
  });
  it('retains applied configuration when a saved-source conversion fails after the applied transition succeeds', () => {
    const draft = new MacroDraft(new Store());
    draft.text = `script "Saved"\n#${'x'.repeat(BOT_SCRIPT_LIMITS.authoringBytes - 2_000)}`;
    draft.save();
    draft.text = formatBotScript({ settings: DEFAULT_SETTINGS, script: macroExample('item') });
    draft.apply(draft.read());
    const before = draft.text, document = draft.configured(), settings = largeSettings('self');
    expect(() => draft.syncSettings(settings)).toThrow('Script source is too large');
    expect(draft.text).toBe(before); expect(draft.configured()).toEqual(document);
    expect(draft.dirty).toBe(false); expect(draft.unsaved).toBe(true);
    draft.syncSettings({ ...structuredClone(DEFAULT_SETTINGS), radius: 18 });
    expect(draft.configured().settings.radius).toBe(18);
    draft.discard(); expect(draft.configured().script).toBeNull(); expect(draft.configured().settings.radius).toBe(18);
  });
  it('keeps the previous saved source when an invalid draft is saved', () => {
    const store = new Store(); const draft = new MacroDraft(store); draft.save(); const before = [...store.data.values()][0];
    draft.text = 'script "Bad"\nset radius = nope'; expect(() => draft.save()).toThrow(/Line 2/i);
    expect([...store.data.values()][0]).toBe(before); expect(draft.dirty).toBe(true);
  });
  it.each(['rayrag.companion.macro.v1', 'rayrag.companion.setup-script.v1'])('preserves corrupt %s data until explicit replacement', key => {
    const store = new Store(); store.data.set(key, JSON.stringify({ version: 2, script: {} }));
    const before = [...store.data]; const draft = new MacroDraft(store);
    expect(draft.restoreError).toMatch(/kept/); expect([...store.data]).toEqual(before); expect(draft.read().script).toBeNull();
  });
  it('does not mark a source saved when storage fails', () => {
    const draft = new MacroDraft({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
    draft.text = formatBotScript({ settings: DEFAULT_SETTINGS, script: macroExample('store') });
    expect(() => draft.save()).toThrow('quota'); expect(draft.dirty).toBe(true); expect(draft.unsaved).toBe(true);
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


// A small DOM adapter exercises editor event ownership and text preservation.
class Node {
  children: Node[] = []; parentElement: Node | null = null;
  id = ''; className = ''; textContent = ''; value = ''; type = ''; tabIndex = 0; rows = 0; spellcheck = false; hidden = false; disabled = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  listeners = new Map<string, Array<(event: {stopPropagation():void;key:string;preventDefault():void}) => void>>();
  constructor(readonly tag: string) {}
  append(...children: Node[]) { for (const child of children) { child.parentElement = this; this.children.push(child); } }
  prepend(child: Node) { child.parentElement=this;this.children.unshift(child); }
  focus() {}
  setSelectionRange() {}
  querySelector(selector: string): Node | null { return this.all().find(node=>selector.startsWith('#')&&node.id===selector.slice(1))??null; }
  all(): Node[] { return [this, ...this.children.flatMap(child => child.all())]; }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  addEventListener(type: string, callback: (event: {stopPropagation():void;key:string;preventDefault():void}) => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]); }
  emit(type: string, key = '') { let stopped = false; for (const listener of this.listeners.get(type) ?? []) listener({stopPropagation:()=>{stopped=true;},key,preventDefault(){}}); if(!stopped)this.parentElement?.emit(type); }
  querySelectorAll(selector: string): Node[] { return this.all().filter(node => selector === '[data-config]' && node.dataset.config === 'true'); }
}
function editor(store: Store | null = new Store()) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
  let settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [4000] };
  const hooks = { settings: () => settings, apply: vi.fn((value: typeof settings) => { settings = structuredClone(value); }), changed: vi.fn(), notify: vi.fn() };
  const ui = new MacroUi(hooks, store); ui.syncSettings(settings);
  const root = ui.root as unknown as Node;
  const input = root.all().find(node=>node.id==='macro-document')!;
  const button = (label: string) => root.all().find(node=>node.tag==='button' && node.textContent===label)!;
  const change = (text: string) => { input.value = text; input.emit('input'); };
  return { ui, hooks, input, root, button, change, settings: () => settings };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('unified Setup editor', () => {
  it('defers retained-form reading while mounting and has no second Start action', () => {
    vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
    const settings = vi.fn(() => { throw new Error('Form is still mounting'); });
    const ui = new MacroUi({ settings, apply: vi.fn(), changed: vi.fn(), notify: vi.fn() }, new Store());
    expect(settings).not.toHaveBeenCalled();
    expect((ui.root as unknown as Node).all().filter(node=>node.tag==='button').map(node=>node.textContent)).not.toContain('Start macro');
    expect(ui.configured().script).toBeNull();
  });
  it('routes source edits only to draft refresh, retaining the unapplied current settings', () => {
    const f = editor(); const persisted = vi.fn(); const parent = new Node('main'); parent.append(f.root); parent.addEventListener('input', persisted);
    f.change(f.input.value.replace('set radius = 12', 'set radius = 14'));
    expect(f.ui.dirty).toBe(true); expect(f.settings().radius).toBe(12); expect(f.hooks.changed).toHaveBeenCalledTimes(1);
    expect(persisted).not.toHaveBeenCalled(); expect(f.hooks.apply).not.toHaveBeenCalled();
  });
  it('previews settings and rules without applying settings or sending commands', () => {
    const f = editor(); f.change('script "Only settings"\nset radius = 14'); f.button('Validate & preview').emit('click');
    expect(f.root.all().find(node=>node.id==='macro-preview')?.textContent).toContain('Preview sends no commands.');
    expect(f.hooks.apply).not.toHaveBeenCalled(); expect(f.settings().radius).toBe(12);
    f.change(formatBotScript({ settings: f.settings(), script: macroExample('continuous') }));
    f.button('Validate & preview').emit('click'); expect(f.hooks.apply).not.toHaveBeenCalled();
  });
  it('validates the entire draft before applying and keeps a bad rule from partially changing settings', () => {
    const f = editor(); f.change('script "Bad"\nset radius = 14\nrule "Bad action"\nwhen level >= 1\nlaunch arbitrary-code\nend');
    f.button('Apply & save').emit('click'); expect(f.hooks.apply).not.toHaveBeenCalled(); expect(f.settings().radius).toBe(12);
    expect(f.hooks.notify).toHaveBeenCalledWith(expect.stringMatching(/Line 5/i), true); expect(f.ui.dirty).toBe(true);
  });
  it('applies once, preserves comments, and adds examples to existing rules without replacing settings', () => {
    const f = editor(); f.change('# important\n' + formatBotScript({ settings: { ...f.settings(), radius: 17 }, script: macroExample('item') }));
    const select = f.root.all().find(node=>node.id==='macro-example')!; select.value='item'; f.button('Add example rules').emit('click');
    const parsed = parseBotScript(f.input.value); expect(parsed.settings.radius).toBe(17); expect(parsed.script?.rules.map(rule=>rule.name)).toEqual(['Use a potion', 'Use a potion 2']);
    expect(f.input.value).toContain('# important'); expect(f.hooks.apply).not.toHaveBeenCalled();
    f.button('Apply & save').emit('click'); expect(f.hooks.apply).toHaveBeenCalledTimes(1); expect(f.settings().radius).toBe(17);
    expect(f.ui.configured().script?.rules).toHaveLength(2); expect(f.ui.dirty).toBe(false); expect(f.ui.unsaved).toBe(false);
  });
  it('locks editor mutations during an active request, leaving the draft intact', () => {
    const f = editor(); f.change(formatBotScript({ settings: { ...f.settings(), radius: 14 }, script: macroExample('item') }));
    const before = f.input.value; f.ui.lock(true); f.button('Apply & save').emit('click'); f.button('Discard draft').emit('click');
    expect(f.hooks.apply).not.toHaveBeenCalled(); expect(f.input.value).toBe(before); expect(f.ui.dirty).toBe(true);
  });
  it('keeps applied source visibly unsaved on storage failure, and protects maintenance', () => {
    const store = new Store(); store.setItem = () => { throw new Error('quota'); };
    const f = editor(store); f.change(formatBotScript({ settings: f.settings(), script: macroExample('item') })); f.button('Apply & save').emit('click');
    expect(f.hooks.apply).toHaveBeenCalledTimes(1); expect(f.ui.dirty).toBe(false); expect(f.ui.unsaved).toBe(true);
    expect(f.root.all().find(node=>node.id==='macro-saved')?.textContent).toContain('Applied but not saved');
  });
});


it('keeps Form and Script in one workspace and blocks Form switching until Apply or Discard', () => {
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
  const host = new Node('main');
  for (const id of ['setup-form','setup-script','setup-tab-form','setup-tab-script']) { const node = new Node(id.includes('tab') ? 'button' : 'div'); node.id=id;host.append(node); }
  const form = host.querySelector('#setup-form')!, script = host.querySelector('#setup-script')!;
  let settings = { ...structuredClone(DEFAULT_SETTINGS), map:'prt_fild08', targets:[4000] };
  const hooks = { macroSettings:()=>settings, settings:()=>settings, applySetup:(value:typeof settings)=>{settings=value;}, setupChanged:vi.fn(), notify:vi.fn() };
  const feature = Object.assign(Object.create(FeatureUi.prototype),{host,hooks});
  Reflect.apply(Reflect.get(FeatureUi.prototype,'setup'),feature,[]);
  host.querySelector('#setup-tab-script')!.emit('click'); expect(form.hidden).toBe(true); expect(script.hidden).toBe(false);
  const editor = host.querySelector('#macro-document')!; editor.value=editor.value.replace('set radius = 12','set radius = 14');editor.emit('input');
  host.querySelector('#setup-tab-form')!.emit('click'); expect(form.hidden).toBe(true); expect(script.hidden).toBe(false);
  expect(hooks.notify).toHaveBeenCalledWith(expect.stringContaining('Discard draft before switching'),true);
  const discard = host.all().find(node=>node.textContent==='Discard draft')!;discard.emit('click');
  host.querySelector('#setup-tab-form')!.emit('click');expect(form.hidden).toBe(false);expect(script.hidden).toBe(true);
  expect(host.querySelector('#setup-rules-summary')!.textContent).toContain('No script rules enabled');
  host.querySelector('#setup-tab-form')!.emit('keydown','ArrowRight');expect(script.hidden).toBe(false);
});


it('converts a pasted legacy JSON macro before adding examples, without dropping retained settings', () => {
  const f = editor(); f.change(JSON.stringify(macroExample('continuous')));
  f.root.all().find(node=>node.id==='macro-example')!.value='item'; f.button('Add example rules').emit('click');
  const document = parseBotScript(f.input.value);
  expect(document.settings).toEqual(f.settings()); expect(document.script?.rules).toHaveLength(3);
  expect(document.script).toMatchObject({durationSeconds:0,maxActions:0});
  expect(f.input.value.trimStart()).toMatch(/^script /);
});

it('preserves custom tab-separated rule budgets while appending examples', () => {
  const f = editor();
  f.change(formatBotScript({settings:f.settings(),script:{...macroExample('item'),durationSeconds:7200,maxActions:15,maxSpend:500}})
    .replace('duration 7200s','duration\t7200s').replace('actions 15','actions\t15').replace('spend 500','spend\t500'));
  f.root.all().find(node=>node.id==='macro-example')!.value='item'; f.button('Add example rules').emit('click');
  const document = parseBotScript(f.input.value); expect(document.script).toMatchObject({durationSeconds:7200,maxActions:15,maxSpend:500});
  expect(document.script?.rules).toHaveLength(2); expect(f.input.value).toContain('duration\t7200s');
});

function largeSettings(scope: 'self' | 'actor'): SettingsInput {
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.combat.rules = Array.from({length:32},(_,i)=>({classId:4000+i,action:'attack',priority:0,
    conditions:Array.from({length:16},()=>({field:'actorHpPercent',actor:scope==='self'?{scope:'self'}:{scope:'actor',id:1,world:'00000000-0000-0000-0000-000000000001',incarnation:1},operator:'gte',value:0}))}));
  return validateFormSettings({...structuredClone(DEFAULT_SETTINGS),map:'prt_fild08',targets:[4000],automation});
}
it('reports oversized Script conversion without losing source or returning stale macro settings, and recovers after a valid Form change', () => {
  const f=editor();f.change(formatBotScript({settings:f.settings(),script:macroExample('item')}));f.button('Apply & save').emit('click');
  const before=f.input.value;
  expect(()=>f.ui.syncSettings(largeSettings('actor'))).not.toThrow();expect(f.input.value).toBe(before);
  expect(()=>f.ui.configured()).toThrow(/cannot be converted.*too large/i);
  expect(f.root.all().find(node=>node.id==='macro-saved')?.textContent).toContain('cannot be converted');
  f.ui.syncSettings(f.settings());expect(f.ui.configured().settings).toEqual(f.settings());
  expect(f.root.all().find(node=>node.id==='macro-preview')?.hidden).toBe(true);
});
it('uses the cached applied document for unchanged refreshes and draft keystrokes', () => {
  const draft=new MacroDraft(new Store());const settings=largeSettings('self');draft.syncSettings(settings);
  const replace = vi.spyOn(botScript, 'replaceBotScriptSettings'); const parse = vi.spyOn(botScript, 'parseBotScript');
  draft.text += '\n# manual draft';
  // An unchanged sync must not inspect or rewrite user text, and configured
  // getters retain only the already validated source rather than compiling it.
  expect(()=>draft.syncSettings(settings)).not.toThrow();expect(draft.text).toContain('# manual draft');
  draft.discard();const initial=draft.configured();Reflect.set(initial.settings,'radius',1);
  expect(draft.configured().settings.radius).toBe(12);expect(draft.enabledScript).toBeNull();
  expect(replace).not.toHaveBeenCalled(); expect(parse).not.toHaveBeenCalled();
});

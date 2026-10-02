import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureUi } from './feature-ui';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, DEFAULT_RETREAT } from './settings';

// Exercise the actual field creation/read/write/lock paths. Unrelated feature
// panels are stubbed so this fixture needs no browser or account-bearing main.
vi.mock('./social-ui', () => ({ SocialUi: class { root = document.createElement('div'); lock() {} }, validSocialSnapshot: () => true }));
vi.mock('./memo-ui', () => ({ MemoUi: class { root = document.createElement('div'); lock() {} }, validMemoSnapshot: () => true }));
vi.mock('./refine-ui', () => ({ RefineUi: class { root = document.createElement('div'); lock() {} policyChanged() {} settledForMaintenance() { return true; } }, validRefineSnapshot: () => true }));
vi.mock('./socket-ui', () => ({ SocketUi: class { root = Object.assign(document.createElement('details'), { className: 'manual-details' }); lock() {} policyChanged() {} }, validSocketSnapshot: () => true }));
vi.mock('./warp-ui', () => ({ WarpUi: class { root = document.createElement('div'); lock() {} policyChanged() {} }, validWarpSnapshot: () => true }));

class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  dataset: Record<string, string> = {};
  id = ''; className = ''; textContent = ''; value = ''; type = '';
  checked = false; hidden = false; disabled = false;
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  constructor(readonly tag: string) {}
  get previousElementSibling(): Element | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null; }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(child => child !== this); this.parentElement = null; }
  append(...children: Element[]) { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  prepend(...children: Element[]) { for (const child of [...children].reverse()) { child.remove(); child.parentElement = this; this.children.unshift(child); } }
  insertBefore(child: Element, before: Element | null) { child.remove(); child.parentElement = this; const index = before ? this.children.indexOf(before) : -1; this.children.splice(index < 0 ? this.children.length : index, 0, child); }
  addEventListener() {}
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const data = selector.match(/^\[data-(setting|config)(?:="([^"]+)")?\]$/);
    if (data) return this.dataset[data[1]!] !== undefined && (!data[2] || this.dataset[data[1]!] === data[2]);
    return this.tag === selector;
  }
  querySelectorAll(selector: string): Element[] { return this.all().slice(1).filter(child => selector.split(',').some(part => child.matches(part.trim()))); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}
function setup() {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const host = new Element('main'), combat = new Element('section');
  const sections = { combat, recovery: new Element('section'), travel: new Element('section'), inventory: new Element('section'), workflows: new Element('section'), profiles: new Element('section') };
  const manualTools = new Element('section'), sessionDetails = new Element('div');
  for (const panel of Object.values(sections)) panel.className = 'settings feature-panel';
  manualTools.className = 'feature-panel'; host.append(...Object.values(sections), manualTools, sessionDetails);
  const masterRow = new Element('label'), master = new Element('input'); master.id = 'loot'; master.checked = true; masterRow.append(master); combat.append(masterRow);
  type PanelMethod = 'rules' | 'workflows' | 'servicePanel' | 'profilePanel' | 'supplyPanel' | 'dispositionPanel' | 'mapPolicyPanel';
  const prototype = FeatureUi.prototype as unknown as Record<PanelMethod, () => void>;
  for (const name of ['rules', 'workflows', 'servicePanel', 'profilePanel', 'supplyPanel'] as const) vi.spyOn(prototype, name).mockImplementation(() => {});
  vi.spyOn(prototype, 'dispositionPanel').mockImplementation(function (this: unknown) {
    const input = new Element('input'); input.dataset.setting = 'disposition.maxSpend';
    const output = new Element('div'); output.id = 'disposition-preview'; host.append(input, output);
    Object.assign(this as object, { dispositionEditor: { read: () => [], write: () => {}, lock: () => {} } });
  });
  vi.spyOn(prototype, 'mapPolicyPanel').mockImplementation(() => {
    for (const key of ['allow', 'deny', 'area', 'map', 'minX', 'minY', 'maxX', 'maxY']) { const input = new Element('input'); input.id = `map-policy-${key}`; host.append(input); }
  });
  const hooks = { settings: () => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] }), apply: vi.fn(), map: () => 'prt_fild08', character: () => 'Test',
    command: vi.fn(async () => {}), workflow: vi.fn(async () => {}), routine: vi.fn(async () => {}), service: vi.fn(async () => {}), social: vi.fn(async () => {}), memo: vi.fn(async () => {}), notify: vi.fn(), changed: vi.fn() };
  const ui = new FeatureUi(host as unknown as HTMLElement, hooks, { sections, manualTools, sessionDetails } as unknown as ConstructorParameters<typeof FeatureUi>[2]);
  return { ui, host, combat, master, sections, manualTools, sessionDetails };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
it('uses the supplied mounts once and separates manual roots from Bot and profiles',()=>{
  const {ui,host,sections,manualTools}=setup();
  const panels=Reflect.get(ui,'panels') as Map<string,Element>;
  for(const [name,panel] of Object.entries(sections))expect(panels.get(name)).toBe(panel);
  expect(host.querySelectorAll('.settings')).toHaveLength(6);
  for(const name of ['manualTargets','social','memo','socket','refine','warp']){
    const root=Reflect.get(ui,name).root as Element;
    expect(root.parentElement).toBe(manualTools);
    for(const panel of Object.values(sections))expect(panel.all()).not.toContain(root);
  }
  expect(manualTools.children).toHaveLength(6);
  expect((Reflect.get(ui,'socket').root as Element).className).toBe('manual-details manual-group');
});
describe('discoverable canonical loot controls', () => {
  it('shows one own/all scope beside the existing master on the initial Combat & loot panel', () => {
    const { host, combat, master } = setup();
    const controls = host.querySelectorAll('[data-setting="loot.ownership"]'); expect(controls).toHaveLength(1);
    expect(combat.querySelector('[data-setting="loot.ownership"]')).toBe(controls[0]); expect(combat.querySelector('#loot')).toBe(master);
    expect(combat.hidden).toBe(false); expect(controls[0]!.value).toBe('own');
    expect(controls[0]!.children.map(option => [option.value, option.textContent])).toEqual([['own', 'Only drops from your kills'], ['all', 'Loot all nearby drops']]);
  });
  it('uses the same setting for edits/profile readback and locks it without changing its current value', () => {
    const { ui, host, master } = setup(), scope = host.querySelector('[data-setting="loot.ownership"]')!;
    scope.value = 'all'; expect(ui.read().loot.ownership).toBe('all');
    master.checked = false; ui.lock(true, true); expect(scope.disabled).toBe(true); expect(scope.value).toBe('all'); expect(master.checked).toBe(false);
    ui.lock(false, true); const own = structuredClone(DEFAULT_AUTOMATION); ui.write(own);
    expect(ui.read().loot.ownership).toBe('own'); expect(scope.value).toBe('own');
    scope.value = 'unverified'; expect(() => ui.read()).toThrow();
  });
});
describe('opt-in normal retreat controls',()=>{
  it('keeps default omission and displays one disabled group with exact bounds',()=>{
    const {ui,combat}=setup();expect(ui.read()).not.toHaveProperty('retreat');
    const toggle=combat.querySelector('[data-setting="retreat.enabled"]')!;expect(toggle.checked).toBe(false);
    for(const [field,value] of Object.entries(DEFAULT_RETREAT))if(field!=='enabled')expect(combat.querySelector(`[data-setting="retreat.${field}"]`)!.value).toBe(String(value));
    expect(combat.querySelectorAll('[data-setting="retreat.enabled"]')).toHaveLength(1);
  });
  it('reads/writes one strict policy, retains it while locked and rejects an invalid distance',()=>{
    const {ui,combat}=setup(),automation=structuredClone(DEFAULT_AUTOMATION);automation.retreat={...DEFAULT_RETREAT,enabled:true,maxAttempts:1};ui.write(automation);
    expect(ui.read().retreat).toEqual(automation.retreat);ui.lock(true,true);const toggle=combat.querySelector('[data-setting="retreat.enabled"]')!;expect(toggle.disabled).toBe(true);expect(toggle.checked).toBe(true);
    ui.lock(false,true);combat.querySelector('[data-setting="retreat.desiredDistance"]')!.value='1';expect(()=>ui.read()).toThrow();
    ui.write(DEFAULT_AUTOMATION);expect(ui.read()).not.toHaveProperty('retreat');expect(toggle.checked).toBe(false);
  });
});

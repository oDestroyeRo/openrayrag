import { afterEach, describe, expect, it, vi } from 'vitest';
import { RecoveryItemUi } from './recovery-item-ui';
import { DEFAULT_SP_ITEMS, type RecoveryResource } from './recovery-items';
import { DEFAULT_HP_POTIONS, HP_POTION_IDS, validateHpPotions } from './hp-potions';
import { FeatureUi } from './feature-ui';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type AutomationSettings } from './settings';

vi.mock('./social-ui', () => ({ SocialUi: class { root = document.createElement('div'); lock() {} render() {} }, validSocialSnapshot: () => true }));
vi.mock('./memo-ui', () => ({ MemoUi: class { root = document.createElement('div'); lock() {} render() {} }, validMemoSnapshot: () => true }));
vi.mock('./refine-ui', () => ({ RefineUi: class { root = document.createElement('div'); lock() {} render() {} policyChanged() {} }, validRefineSnapshot: () => true }));
vi.mock('./socket-ui', () => ({ SocketUi: class { root = document.createElement('div'); lock() {} render() {} policyChanged() {} }, validSocketSnapshot: () => true }));
vi.mock('./warp-ui', () => ({ WarpUi: class { root = document.createElement('div'); lock() {} render() {} policyChanged() {} }, validWarpSnapshot: () => true }));
vi.mock('./manual-target-ui', () => ({ ManualTargetUi: class { root = document.createElement('div'); lock() {} render() {} } }));

// Same bounded DOM fixture style as nearby feature UI tests. Removing a focused
// node clears focus, so a status-driven rebuild or move cannot pass unnoticed.
class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  dataset: Record<string, string> = {};
  id = ''; className = ''; value = ''; type = ''; ariaLabel = ''; ariaLive = '';
  checked = false; hidden = false; disabled = false; textWrites = 0;
  private text = '';
  listeners = new Map<string, Array<() => void>>();
  classList = { add: (name: string) => { this.className += ` ${name}`; } };
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.textWrites++; }
  get childElementCount(): number { return this.children.length; }
  get previousElementSibling(): Element | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null; }
  get nextElementSibling(): Element | null { return this.parentElement?.children[this.parentElement.children.indexOf(this) + 1] ?? null; }
  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(child => child !== this);
      const active: unknown = document.activeElement;
      if (this.all().some(node => node === active)) Reflect.set(document, 'activeElement', null);
    }
    this.parentElement = null;
  }
  append(...children: Element[]): void { for (const child of children) { child.remove(); child.parentElement = this; this.children.push(child); } }
  prepend(...children: Element[]): void { for (const child of [...children].reverse()) { child.remove(); child.parentElement = this; this.children.unshift(child); } }
  insertBefore(child: Element, before: Element | null): void {
    child.remove(); child.parentElement = this; const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
  replaceChildren(...children: Element[]): void { for (const child of [...this.children]) child.remove(); this.append(...children); }
  focus(): void { Reflect.set(document, 'activeElement', this); }
  setAttribute() {}
  addEventListener(type: string, callback: () => void): void { this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]); }
  emit(type: string): void { for (const callback of this.listeners.get(type) ?? []) callback(); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const data = selector.match(/^\[data-([a-z-]+)(?:="([^"]+)")?\]$/);
    if (data) {
      const key = data[1]!.replace(/-([a-z])/g, (_match, letter: string) => letter.toUpperCase());
      return this.dataset[key] !== undefined && (!data[2] || this.dataset[key] === data[2]);
    }
    return this.tag === selector;
  }
  querySelectorAll(selector: string): Element[] { return this.all().slice(1).filter(child => selector.split(',').some(part => child.matches(part.trim()))); }
  querySelector(selector: string): Element | null { return this.querySelectorAll(selector)[0] ?? null; }
}

function setupDom() {
  const createElement = vi.fn((tag: string) => new Element(tag));
  vi.stubGlobal('document', { createElement, activeElement: null });
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  return createElement;
}

function widget(resource: RecoveryResource = 'hp') {
  const createElement = setupDom(), changed = vi.fn();
  const settings = { minHpPercent: 45 };
  const ui = new RecoveryItemUi(changed, () => settings.minHpPercent, resource), root = ui.root as unknown as Element;
  ui.update({ inventoryKnown: true, inventory: [501,502,504,547,569,512,514,505].map(itemId => ({itemId,count:3})) });
  const field = (id: string) => root.querySelector(`#${resource}-potion-${id}`)!;
  const mode = (value: string) => { field('mode').value = value; field('mode').emit('change'); };
  const row = (itemId: number) => root.querySelector(`[data-item-id="${itemId}"]`)!;
  const select = (itemId: number, checked = true) => { const choice = row(itemId).querySelector('input')!; choice.checked = checked; choice.emit('change'); };
  return { ui, root, changed, createElement, settings, field, mode, row, select };
}

function featureUi(settingsUnavailable = false) {
  setupDom();
  const host = new Element('main');
  const sections = { combat: new Element('section'), recovery: new Element('section'), travel: new Element('section'), inventory: new Element('section'), workflows: new Element('section'), profiles: new Element('section') };
  for (const panel of Object.values(sections)) panel.className = 'settings feature-panel';
  const manualTools = new Element('section'), sessionDetails = new Element('div');
  host.append(...Object.values(sections), manualTools, sessionDetails);
  const stopLimit = new Element('input'); stopLimit.id = 'min-hp'; stopLimit.value = '45'; host.append(stopLimit);
  const hooks = { settings: () => { if (settingsUnavailable) throw new Error('Settings form is not ready.'); return { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] }; }, apply: vi.fn(), map: () => 'prt_fild08', character: () => 'Test',
    command: vi.fn(async () => {}), workflow: vi.fn(async () => {}), routine: vi.fn(async () => {}), service: vi.fn(async () => {}), social: vi.fn(async () => {}), memo: vi.fn(async () => {}), notify: vi.fn(), changed: vi.fn() };
  const prototype = FeatureUi.prototype as unknown as Record<string, () => void>;
  for (const method of ['servicePanel', 'profilePanel', 'supplyPanel']) vi.spyOn(prototype, method).mockImplementation(() => {});
  vi.spyOn(prototype, 'rules').mockImplementation(function (this: unknown) {
    let items: AutomationSettings['items'] = [];
    Reflect.get(this as object, 'editors').set('items', { read: () => items, write: (value: AutomationSettings['items']) => { items = structuredClone(value); }, lock: () => {} });
  });
  vi.spyOn(prototype, 'workflows').mockImplementation(function (this: unknown) {
    Object.assign(this as object, { macroUi: { render: () => {}, lock: () => {}, dirty: false } });
  });
  vi.spyOn(prototype, 'dispositionPanel').mockImplementation(function (this: unknown) {
    const input = new Element('input'); input.dataset.setting = 'disposition.maxSpend';
    const output = new Element('div'); output.id = 'disposition-preview'; host.append(input, output);
    Object.assign(this as object, { dispositionEditor: { read: () => [], write: () => {}, lock: () => {} } });
  });
  vi.spyOn(prototype, 'mapPolicyPanel').mockImplementation(() => {
    for (const key of ['allow', 'deny', 'area', 'map', 'minX', 'minY', 'maxX', 'maxY']) { const input = new Element('input'); input.id = `map-policy-${key}`; host.append(input); }
  });
  const ui = new FeatureUi(host as unknown as HTMLElement, hooks, { sections, manualTools, sessionDetails } as unknown as ConstructorParameters<typeof FeatureUi>[2]);
  for (const id of ['party-engagement-state', 'party-heal-state', 'attack-strategy-state', 'actor-condition-state', 'supply-preview', 'map-policy-preview', 'session-details', 'visible-npcs', 'character-data', 'npc-dialogue', 'shop-state', 'storage-state', 'party-state', 'barter-state', 'workflow-state', 'service-state', 'routine-state']) {
    const output = new Element('div'); output.id = id; host.append(output);
  }
  return { ui, host, sections, hooks };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('HP potion selection', () => {
  it('filters each resource by current carried stock and preserves depleted selections for restocking', () => {
    const f=widget();
    f.ui.write({...DEFAULT_HP_POTIONS,mode:'selected',itemIds:[512,501]});
    f.ui.update({inventoryKnown:true,inventory:[{itemId:512,count:4},{itemId:514,count:8},{itemId:601,count:3}]});
    expect(f.root.querySelectorAll('.hp-potion-row').filter(row=>!row.hidden).map(row=>Number(row.dataset.itemId))).toEqual([512]);
    expect(f.ui.read().itemIds).toEqual([512,501]);expect(f.row(501).hidden).toBe(true);
    f.ui.update({inventoryKnown:true,inventory:[]});expect(f.row(512).hidden).toBe(true);
    expect(f.root.all().some(node=>node.textContent.includes('No carried HP recovery items'))).toBe(true);
    f.ui.update({inventoryKnown:true,inventory:[{itemId:501,count:3},{itemId:512,count:2}]});
    expect(f.root.querySelectorAll('.hp-potion-row').filter(row=>!row.hidden).map(row=>Number(row.dataset.itemId))).toEqual([512,501]);
    f.ui.update({inventoryKnown:false,inventory:[]});
    expect(f.root.querySelectorAll('.hp-potion-row').every(row=>row.hidden)).toBe(true);
    expect(f.root.all().some(node=>node.textContent==='Waiting for current inventory.')).toBe(true);
    expect(f.ui.read().itemIds).toEqual([512,501]);expect(f.changed).not.toHaveBeenCalled();
  });
  it('lists carried SP foods and potions and uses a separate SP threshold without an HP stop warning', () => {
    const f=widget('sp');expect(f.ui.read()).toEqual(DEFAULT_SP_ITEMS);
    expect(f.root.querySelectorAll('.hp-potion-row').filter(row=>!row.hidden).map(row=>Number(row.dataset.itemId))).toEqual([514,505]);
    f.mode('selected');expect(f.ui.read().itemIds).toEqual([514]);
    expect(f.root.querySelector('.notice')!.hidden).toBe(true);
    expect(f.field('belowPercent').ariaLabel).toBe('Use below SP %');
  });
  it('starts off and displays only carried items that restore HP', () => {
    const f = widget(); expect(f.ui.read()).toEqual(DEFAULT_HP_POTIONS);
    expect(f.root.querySelectorAll('.hp-potion-row').filter(row => !row.hidden).map(row => Number(row.dataset.itemId))).toEqual(HP_POTION_IDS.filter(id => [501,502,504,547,569,512].includes(id)));
    expect(f.root.all().some(node => /Blue Potion|Green Potion/.test(node.textContent))).toBe(false);
    expect(f.field('mode').children.map(option => [option.value, option.textContent])).toEqual([['off', 'Off'], ['any', 'Any carried HP item'], ['selected', 'Choose items']]);
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('does not read a not-yet-constructed settings owner while Off', () => {
    setupDom(); const stopLimit = vi.fn(() => { throw new Error('Settings not ready.'); });
    expect(() => new RecoveryItemUi(() => {}, stopLimit)).not.toThrow(); expect(stopLimit).not.toHaveBeenCalled();
  });

  it('defaults an explicit first Choose opt-in to a carried item and retains preference order across modes', () => {
    const f = widget(); f.ui.update({inventoryKnown:true,inventory:[501,502,504].map(itemId=>({itemId,count:3}))}); f.mode('selected'); expect(f.ui.read().itemIds).toEqual([501]);
    f.select(504); f.select(502);
    f.row(502).querySelectorAll('button')[0]!.emit('click'); expect(f.ui.read().itemIds).toEqual([501, 502, 504]);
    expect(f.root.querySelectorAll('.hp-potion-row').slice(0, 3).map(row => Number(row.dataset.itemId))).toEqual([501, 502, 504]);
    f.mode('any'); expect(f.ui.read()).toMatchObject({ mode: 'any', itemIds: [501, 502, 504] });
    expect(f.root.querySelectorAll('input').filter(input => input.type === 'checkbox').every(input => input.checked && input.disabled)).toBe(true);
    f.mode('off'); f.mode('selected'); expect(f.ui.read().itemIds).toEqual([501, 502, 504]);
    expect(f.changed).toHaveBeenCalledTimes(7);
  });

  it('commits checkbox input before a bubbling form refresh and not again on change', () => {
    const f = widget(); f.ui.write({...DEFAULT_HP_POTIONS,mode:'selected',itemIds:[501]}); f.changed.mockClear();
    const choice = f.row(504).querySelector('input')!;
    choice.checked = true; choice.emit('input');
    f.ui.lock(false); choice.emit('change');
    expect(f.ui.read().itemIds).toEqual([501, 504]); expect(choice.checked).toBe(true);
    expect(f.changed).toHaveBeenCalledTimes(1);
    choice.checked = false; choice.emit('input'); f.ui.lock(false); choice.emit('change');
    expect(f.ui.read().itemIds).toEqual([501]); expect(f.changed).toHaveBeenCalledTimes(2);
  });
  it('round-trips multiple choices, threshold/reserve/cooldown and moves in both directions', () => {
    const f = widget(), settings = { ...DEFAULT_HP_POTIONS, mode: 'selected' as const, itemIds: [547, 501, 569], belowPercent: 78, minStock: 3, cooldownSeconds: 12 };
    f.ui.write(settings); expect(f.ui.read()).toEqual(settings); expect(f.changed).not.toHaveBeenCalled();
    f.row(547).querySelectorAll('button')[1]!.emit('click'); expect(f.ui.read().itemIds).toEqual([501, 547, 569]);
    f.row(547).querySelectorAll('button')[0]!.emit('click'); expect(f.ui.read()).toEqual(settings);
    settings.itemIds.push(502); expect(f.ui.read().itemIds).toEqual([547, 501, 569]);
  });

  it('makes an empty Choose list visible and invalid without choosing a replacement automatically', () => {
    const f = widget(); f.ui.write({...DEFAULT_HP_POTIONS,mode:'selected',itemIds:[501]}); f.select(501, false);
    expect(f.ui.read()).toMatchObject({ mode: 'selected', itemIds: [] });
    expect(() => validateHpPotions(f.ui.read())).toThrow();
    expect(f.root.all().some(node => node.textContent.includes('Choose at least one carried HP recovery item'))).toBe(true);
    f.select(504); expect(validateHpPotions(f.ui.read()).itemIds).toEqual([504]);
  });

  it('locks every settings control and guards synthetic events without changing saved choices', () => {
    const f = widget(); f.ui.write({ ...DEFAULT_HP_POTIONS, mode: 'selected', itemIds: [501, 504] });
    const before = f.ui.read(); f.ui.lock(true);
    expect(f.root.querySelectorAll('input,select,button').every(control => control.disabled)).toBe(true);
    f.row(501).querySelectorAll('button')[1]!.emit('click'); f.row(504).querySelector('input')!.emit('change');
    expect(f.ui.read()).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
    f.ui.lock(false); expect(f.field('mode').disabled).toBe(false); expect(f.row(501).querySelector('input')!.disabled).toBe(false);
  });

  it('reports unknown/zero/aggregated stock and does not rewrite labels or rebuild controls on unchanged status', () => {
    const f = widget(); f.mode('selected'); f.select(504);
    const input = f.field('belowPercent'); input.focus(); input.value = '77';
    const status = { inventoryKnown: true, inventory: [{ itemId: 501, count: 3 }, { itemId: 501, count: 4 }, { itemId: 504, count: 2 }] };
    const stock = f.row(501).querySelector('.hp-potion-stock')!;
    expect(stock.textContent).toBe('Carried: 3'); f.ui.update(status);
    expect(stock.textContent).toBe('Carried: 7'); expect(f.row(502).querySelector('.hp-potion-stock')!.textContent).toBe('Carried: 0');
    const creations = f.createElement.mock.calls.length, writes = stock.textWrites;
    const list = f.root.querySelector('.hp-potion-list')!, move = vi.spyOn(list, 'insertBefore');
    f.ui.update(status); expect(f.createElement).toHaveBeenCalledTimes(creations); expect(stock.textWrites).toBe(writes); expect(move).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(input); expect(f.field('belowPercent')).toBe(input); expect(input.value).toBe('77');
    f.ui.update({ ...status, inventoryKnown: false }); expect(stock.textContent).toBe('Carried: unknown');
    f.ui.update({ inventoryKnown: true, inventory: [{ itemId: 501, count: -1 }] }); expect(stock.textContent).toBe('Carried: unknown');
  });

  it('warns when the potion threshold cannot precede the HP stop guard and never alters either setting', () => {
    const f = widget(); f.mode('any'); const warning = f.root.querySelector('.notice')!;
    expect(warning.hidden).toBe(true); f.field('belowPercent').value = '45'; f.field('belowPercent').emit('input');
    expect(warning.hidden).toBe(false); expect(warning.textContent).toContain('stops at 45% HP before using recovery items');
    expect(f.ui.read().belowPercent).toBe(45); expect(f.settings.minHpPercent).toBe(45);
    f.settings.minHpPercent = 40; f.ui.update(undefined); expect(warning.hidden).toBe(true);
    f.mode('off'); f.settings.minHpPercent = 80; f.ui.update(undefined); expect(warning.hidden).toBe(true);
  });

  it('rejects empty or fractional numeric controls through normal settings validation', () => {
    const f = widget(); f.mode('any'); f.field('minStock').value = ''; f.field('minStock').emit('input');
    expect(f.ui.read().minStock).toBeNaN(); expect(() => validateHpPotions(f.ui.read())).toThrow();
    f.field('minStock').value = '1.5'; expect(() => validateHpPotions(f.ui.read())).toThrow();
  });
});

describe('FeatureUi HP potion policy integration', () => {
  it('switches inventory lists between HP and SP while retaining both policies and avoiding game commands',()=>{
    const f=featureUi();
    const automation=structuredClone(DEFAULT_AUTOMATION);
    automation.hpPotions={...DEFAULT_HP_POTIONS,mode:'selected',itemIds:[512],belowPercent:70};
    automation.spPotions={...DEFAULT_SP_ITEMS,mode:'selected',itemIds:[514,505],belowPercent:25,minStock:2};
    f.ui.write(automation);f.ui.render({character:{inventoryKnown:true,inventory:[512,514,505].map(itemId=>({itemId,count:4}))}});
    const resource=f.host.querySelector('#recovery-item-resource')!;
    resource.value='sp';resource.emit('change');
    expect(f.host.querySelector('#hp-potions')!.hidden).toBe(true);expect(f.host.querySelector('#sp-potions')!.hidden).toBe(false);
    expect(f.ui.read().hpPotions).toEqual(automation.hpPotions);expect(f.ui.read().spPotions).toEqual(automation.spPotions);
    f.ui.lock(true,true);expect(resource.disabled).toBe(false);
    resource.value='hp';resource.emit('change');expect(f.host.querySelector('#hp-potions')!.hidden).toBe(false);
    expect(f.hooks.changed).not.toHaveBeenCalled();expect(f.hooks.command).not.toHaveBeenCalled();
    f.ui.write(DEFAULT_AUTOMATION);expect(f.ui.read()).not.toHaveProperty('spPotions');
  });
  it('uses the independently mounted HP stop limit before form initialization and during invalid drafts', () => {
    const f = featureUi(true), mode = f.host.querySelector('#hp-potion-mode')!;
    f.ui.render({character:{inventoryKnown:true,inventory:[{itemId:501,count:3}]}});
    mode.value = 'selected'; expect(() => mode.emit('change')).not.toThrow();
    const threshold = f.host.querySelector('#hp-potion-belowPercent')!; threshold.value = '40'; expect(() => threshold.emit('input')).not.toThrow();
    expect(f.host.querySelector('.notice')!.hidden).toBe(false);
    const red = f.host.querySelector('[data-potion="501"]')!; red.checked = false; expect(() => red.emit('change')).not.toThrow();
    expect(() => f.ui.read()).toThrow();
    threshold.value = ''; expect(() => threshold.emit('input')).not.toThrow();
    expect(() => f.ui.render({ character: { inventoryKnown: true, inventory: [] } })).not.toThrow();
  });
  it('mounts once in Recovery and preserves default omission plus advanced recovery rules', () => {
    const f = featureUi(); expect(f.sections.recovery.querySelectorAll('#hp-potions')).toHaveLength(1); expect(f.sections.recovery.querySelectorAll('#sp-potions')).toHaveLength(1);
    expect(f.ui.read()).not.toHaveProperty('hpPotions');
    const automation = structuredClone(DEFAULT_AUTOMATION); automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 65, minStock: 1, cooldownSeconds: 7 }];
    automation.hpPotions = { ...DEFAULT_HP_POTIONS, mode: 'selected', itemIds: [504, 501], minStock: 2 };
    f.ui.write(automation); expect(f.ui.read().hpPotions).toEqual(automation.hpPotions); expect(f.ui.read().items).toEqual(automation.items);
    expect(f.hooks.changed).not.toHaveBeenCalled(); expect(f.hooks.command).not.toHaveBeenCalled();
    f.ui.write(DEFAULT_AUTOMATION); expect(f.ui.read()).not.toHaveProperty('hpPotions');
  });

  it('notifies autosave on mode/choice/reorder/number edits while full policy locking preserves values', () => {
    const f = featureUi(), mode = f.host.querySelector('#hp-potion-mode')!;
    f.ui.render({character:{inventoryKnown:true,inventory:[501,504].map(itemId=>({itemId,count:3}))}});
    mode.value = 'selected'; mode.emit('change');
    const white = f.host.querySelector('[data-potion="504"]')!; white.checked = true; white.emit('change');
    const row = f.host.querySelector('[data-item-id="504"]')!; row.querySelectorAll('button')[0]!.emit('click');
    const threshold = f.host.querySelector('#hp-potion-belowPercent')!; threshold.value = '75'; threshold.emit('input');
    expect(f.hooks.changed).toHaveBeenCalledTimes(4); expect(f.ui.read().hpPotions).toMatchObject({ itemIds: [504, 501], belowPercent: 75 });
    f.ui.lock(true, true); expect(f.sections.recovery.querySelectorAll('input,select,button').filter(control=>control.id!=='recovery-item-resource').every(control => control.disabled)).toBe(true);
    expect(f.ui.read().hpPotions?.itemIds).toEqual([504, 501]); expect(f.hooks.command).not.toHaveBeenCalled();
  });

  it('refreshes potion counts through actual status rendering without changing a focused draft or dispatching actions', () => {
    const f = featureUi(), input = f.host.querySelector('#hp-potion-belowPercent')!; input.value = '73'; input.focus();
    const inventory = [{ itemId: 504, count: 9 }]; f.ui.render({ character: { inventoryKnown: true, inventory } });
    expect(f.host.querySelector('[data-item-id="504"]')!.querySelector('.hp-potion-stock')!.textContent).toBe('Carried: 9');
    f.ui.render({ character: { inventoryKnown: false, inventory } });
    expect(f.host.querySelector('[data-item-id="504"]')!.querySelector('.hp-potion-stock')!.textContent).toBe('Carried: unknown');
    expect(document.activeElement).toBe(input); expect(input.value).toBe('73'); expect(f.hooks.changed).not.toHaveBeenCalled(); expect(f.hooks.command).not.toHaveBeenCalled();
  });
});

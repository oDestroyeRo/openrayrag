import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureUi } from './feature-ui';
import { DEFAULT_SETTINGS } from './settings';

// Exercise the actual field creation/read/write/lock paths. Unrelated feature
// panels are stubbed so this fixture needs no browser or account-bearing main.
vi.mock('./social-ui', () => ({ SocialUi: class { root = document.createElement('div'); lock() {} }, validSocialSnapshot: () => true }));
vi.mock('./memo-ui', () => ({ MemoUi: class { root = document.createElement('div'); lock() {} }, validMemoSnapshot: () => true }));
vi.mock('./socket-ui', () => ({ SocketUi: class { root = document.createElement('div'); lock() {} policyChanged() {} }, validSocketSnapshot: () => true }));

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
  listeners=new Map<string,Array<()=>unknown>>();
  addEventListener(type:string,callback:()=>unknown){this.listeners.set(type,[...(this.listeners.get(type)??[]),callback]);}
  emit(type:string){for(const callback of this.listeners.get(type)??[])callback();}
  setAttribute(){} replaceChildren(...children:Element[]){this.children=[];this.append(...children);}
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
  const host = new Element('main'), combat = new Element('section'), activity = new Element('section'), footer = new Element('footer'), session = new Element('section');
  combat.className = 'settings'; activity.className = 'activity'; session.className = 'session-card'; host.append(combat, activity, session, footer);
  const masterRow = new Element('label'), master = new Element('input'); master.id = 'loot'; master.checked = true; masterRow.append(master); combat.append(masterRow);
  const routing = new Element('div'), routeSettings = new Element('div'); routing.className = 'routing-field'; routeSettings.className = 'routing-settings';
  const hpLabel = new Element('label'), hp = new Element('input'); hp.id = 'min-hp';
  const actions = new Element('div'), footnote = new Element('p'); actions.className = 'actions'; footnote.className = 'footnote'; combat.append(routing, routeSettings, hpLabel, hp, actions, footnote);
  type PanelMethod = 'rules' | 'workflows' | 'servicePanel' | 'profilePanel' | 'navigation' | 'supplyPanel' | 'dispositionPanel' | 'mapPolicyPanel';
  const prototype = FeatureUi.prototype as unknown as Record<PanelMethod, () => void>;
  for (const name of ['rules', 'workflows', 'servicePanel', 'navigation', 'supplyPanel'] as const) vi.spyOn(prototype, name).mockImplementation(() => {});
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
  const ui = new FeatureUi(host as unknown as HTMLElement, hooks);
  return { ui, host, combat, master, hooks };
}
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
describe('independent profile selection notification',()=>{
  it('notifies current-form changes after programmatic Save/Delete selection',()=>{
    const {ui,host,hooks}=setup();
    host.querySelector('#profile-name')!.value='Synthetic profile';
    const button=(label:string)=>host.all().find(n=>n.tag==='button'&&n.textContent===label)!;
    button('Save new').emit('click');
    expect(ui.selectedProfileId()).not.toBeNull();
    expect(hooks.changed).toHaveBeenCalledTimes(1);
    button('Delete').emit('click');
    expect(ui.selectedProfileId()).toBeNull();
    expect(hooks.changed).toHaveBeenCalledTimes(2);
  });
});

it('hydrates restored profile details without Apply and permits Update selected',()=>{
  const {ui,host,hooks}=setup();
  const name=host.querySelector('#profile-name')!;name.value='Synthetic profile';
  const button=(label:string)=>host.all().find(n=>n.tag==='button'&&n.textContent===label)!;
  button('Save new').emit('click');const id=ui.selectedProfileId()!;
  name.value='';ui.restoreProfileSelection(id);
  expect(ui.selectedProfileId()).toBe(id);expect(name.value).toBe('Synthetic profile');expect(hooks.apply).not.toHaveBeenCalled();
  button('Update selected').emit('click');
  expect(hooks.notify).toHaveBeenLastCalledWith('Profile updated.');
});

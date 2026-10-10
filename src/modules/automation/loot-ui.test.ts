import { afterEach, describe, expect, it, vi } from 'vitest';
import { FeatureUi } from '../client/feature-ui';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, DEFAULT_RETREAT } from '../settings/settings';
import { DEFAULT_SUPPLY } from '../services/supply-trip';
import { formatBotScript, parseBotScript } from '../settings/bot-script';

// Exercise the actual field creation/read/write/lock paths. Unrelated feature
// panels are stubbed so this fixture needs no browser or account-bearing main.
vi.mock('../social/social-ui', () => ({
  SocialUi: class {
    root = document.createElement('div');
    lock() {}
  },
  validSocialSnapshot: () => true,
}));
vi.mock('../memo/memo-ui', () => ({
  MemoUi: class {
    root = document.createElement('div');
    lock() {}
  },
  validMemoSnapshot: () => true,
}));
vi.mock('../refine/refine-ui', () => ({
  RefineUi: class {
    root = document.createElement('div');
    lock() {}
    policyChanged() {}
    settledForMaintenance() {
      return true;
    }
  },
  validRefineSnapshot: () => true,
}));
vi.mock('../socket/socket-ui', () => ({
  SocketUi: class {
    root = Object.assign(document.createElement('details'), { className: 'manual-details' });
    lock() {}
    policyChanged() {}
  },
  validSocketSnapshot: () => true,
}));
vi.mock('../warp/warp-ui', () => ({
  WarpUi: class {
    root = document.createElement('div');
    lock() {}
    policyChanged() {}
  },
  validWarpSnapshot: () => true,
}));

class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  dataset: Record<string, string> = {};
  id = '';
  className = '';
  textContent = '';
  value = '';
  type = '';
  checked = false;
  hidden = false;
  disabled = false;
  classList = {
    add: (name: string) => {
      this.className += ` ${name}`;
    },
  };
  constructor(readonly tag: string) {}
  get childElementCount(): number {
    return this.children.length;
  }
  get previousElementSibling(): Element | null {
    return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null;
  }
  remove() {
    if (this.parentElement)
      this.parentElement.children = this.parentElement.children.filter((child) => child !== this);
    this.parentElement = null;
  }
  append(...children: Element[]) {
    for (const child of children) {
      child.remove();
      child.parentElement = this;
      this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) {
    for (const child of [...this.children]) child.remove();
    this.append(...children);
  }
  prepend(...children: Element[]) {
    for (const child of [...children].reverse()) {
      child.remove();
      child.parentElement = this;
      this.children.unshift(child);
    }
  }
  insertBefore(child: Element, before: Element | null) {
    child.remove();
    child.parentElement = this;
    const index = before ? this.children.indexOf(before) : -1;
    this.children.splice(index < 0 ? this.children.length : index, 0, child);
  }
  listeners = new Map<string, Array<(event: { target: Element }) => void>>();
  addEventListener(name: string, listener: (event: { target: Element }) => void) {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  emit(name: string) {
    for (const listener of this.listeners.get(name) ?? []) listener({ target: this });
  }
  setAttribute() {}
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  matches(selector: string): boolean {
    if (selector.startsWith('#')) return this.id === selector.slice(1);
    if (selector.startsWith('.')) return this.className.split(/\s+/).includes(selector.slice(1));
    const data = selector.match(/^\[data-(setting|config|column|manual|service)(?:="([^"]+)")?\]$/);
    if (data)
      return (
        this.dataset[data[1]!] !== undefined && (!data[2] || this.dataset[data[1]!] === data[2])
      );
    return this.tag === selector;
  }
  querySelectorAll(selector: string): Element[] {
    return this.all()
      .slice(1)
      .filter((child) => selector.split(',').some((part) => child.matches(part.trim())));
  }
  querySelector(selector: string): Element | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}
function setup(autoSell = false, realDisposition = false) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  vi.stubGlobal('HTMLInputElement', Element);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {} });
  const host = new Element('main'),
    combat = new Element('section');
  const sections = {
    combat,
    recovery: new Element('section'),
    travel: new Element('section'),
    inventory: new Element('section'),
    workflows: new Element('section'),
    profiles: new Element('section'),
  };
  const manualTools = new Element('section'),
    sessionDetails = new Element('div');
  for (const panel of Object.values(sections)) panel.className = 'settings feature-panel';
  manualTools.className = 'feature-panel';
  host.append(...Object.values(sections), manualTools, sessionDetails);
  const masterRow = new Element('label'),
    master = new Element('input');
  master.id = 'loot';
  master.checked = true;
  masterRow.append(master);
  combat.append(masterRow);
  type PanelMethod =
    | 'setup'
    | 'rules'
    | 'workflows'
    | 'servicePanel'
    | 'profilePanel'
    | 'supplyPanel'
    | 'dispositionPanel'
    | 'mapPolicyPanel';
  const prototype = FeatureUi.prototype as unknown as Record<PanelMethod, () => void>;
  for (const name of ['rules', 'servicePanel', 'profilePanel'] as const)
    vi.spyOn(prototype, name).mockImplementation(() => {});
  if (!autoSell) vi.spyOn(prototype, 'supplyPanel').mockImplementation(() => {});
  vi.spyOn(prototype, 'setup').mockImplementation(() => {});
  vi.spyOn(prototype, 'workflows').mockImplementation(function (this: unknown) {
    Object.assign(this as object, { macroUi: { render: () => {}, lock: () => {}, dirty: false } });
  });
  if (!realDisposition)
    vi.spyOn(prototype, 'dispositionPanel').mockImplementation(function (this: unknown) {
      const input = new Element('input');
      input.dataset.setting = 'disposition.maxSpend';
      const output = new Element('div');
      output.id = 'disposition-preview';
      host.append(input, output);
      Object.assign(this as object, {
        dispositionEditor: {
          root: new Element('div'),
          read: () => [],
          write: () => {},
          lock: () => {},
        },
      });
    });
  vi.spyOn(prototype, 'mapPolicyPanel').mockImplementation(() => {
    for (const key of ['allow', 'deny', 'area', 'map', 'minX', 'minY', 'maxX', 'maxY']) {
      const input = new Element('input');
      input.id = `map-policy-${key}`;
      host.append(input);
    }
  });
  const hooks = {
    settings: () => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] }),
    apply: vi.fn(),
    map: () => 'prt_fild08',
    character: () => 'Test',
    command: vi.fn(async () => {}),
    workflow: vi.fn(async () => {}),
    routine: vi.fn(async () => {}),
    service: vi.fn(async () => {}),
    social: vi.fn(async () => {}),
    memo: vi.fn(async () => {}),
    notify: vi.fn(),
    changed: vi.fn(),
  };
  const ui = new FeatureUi(host as unknown as HTMLElement, hooks, {
    sections,
    manualTools,
    sessionDetails,
  } as unknown as ConstructorParameters<typeof FeatureUi>[2]);
  return { ui, host, combat, master, sections, manualTools, sessionDetails, hooks };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it.each([500, 1000])(
  'round-trips a %i-command supply budget between Form and Script',
  (maxActions) => {
    const { ui, host, hooks } = setup(true);
    ui.write({ ...structuredClone(DEFAULT_AUTOMATION), supply: { ...DEFAULT_SUPPLY, maxActions } });
    const input = host.querySelector('[data-setting="supply.maxActions"]')!;
    expect(Reflect.get(input, 'max')).toBe('1000');
    expect(input.value).toBe(String(maxActions));
    const settings = { ...hooks.settings(), automation: ui.read() };
    const source = formatBotScript({ settings, script: null });
    expect(source).toContain(`set automation.supply.maxActions = ${maxActions}`);
    const parsed = parseBotScript(source);
    expect(parsed.settings.automation?.supply?.maxActions).toBe(maxActions);
    ui.write(parsed.settings.automation!);
    expect(ui.read().supply?.maxActions).toBe(maxActions);
    expect(input.value).toBe(String(maxActions));
    for (const name of ['apply', 'command', 'workflow', 'routine', 'service'] as const)
      expect(hooks[name]).not.toHaveBeenCalled();
  },
);
it('adds a valid sale rule through the real editor and saves retained quantities without sending commands', () => {
  const { ui, sections, hooks } = setup(true, true);
  const panel = sections.inventory.querySelector('.auto-sell-setup')!;
  panel.querySelector(`[data-setting="supply.enabled"]`)!.checked = true;
  panel.querySelector(`[data-setting="supply.enabled"]`)!.emit('change');
  const editor = panel.querySelector('.rule-editor')!;
  editor.querySelector('button')!.emit('click');
  editor.querySelector('[data-column="itemId"]')!.value = '909';
  editor.querySelector('[data-column="sell"]')!.value = '1';
  const retained = editor.querySelector('[data-column="maximum"]')!;
  retained.value = '4';
  expect(ui.read().disposition!.rules).toEqual([
    {
      itemId: 909,
      keep: 1,
      minimum: 1,
      desired: 1,
      maximum: 4,
      store: false,
      cart: false,
      sell: true,
      restock: 'off',
      allowUnique: false,
    },
  ]);
  expect(ui.read().supply).toMatchObject({
    enabled: true,
    weightEnabled: true,
    merchantMode: 'automatic',
  });
  for (const name of ['apply', 'command', 'workflow', 'routine', 'service'] as const)
    expect(hooks[name]).not.toHaveBeenCalled();
  ui.lock(true, true);
  expect(retained.disabled).toBe(true);
});
it('mounts canonical auto-sell controls in Loot & supplies and keeps saving/preview sender-free', () => {
  const { ui, host, sections, hooks } = setup(true);
  const panel = sections.inventory.querySelector('.auto-sell-setup')!;
  expect(panel).not.toBeNull();
  const input = (path: string) => panel.querySelector(`[data-setting="supply.${path}"]`)!;
  for (const path of [
    'enabled',
    'merchantMode',
    'transport',
    'saveMap',
    'returnMinStock',
    'sellService',
  ]) {
    expect(host.querySelectorAll(`[data-setting="supply.${path}"]`)).toHaveLength(1);
    expect(sections.travel.querySelector(`[data-setting="supply.${path}"]`)).toBeNull();
  }
  ui.write(structuredClone(DEFAULT_AUTOMATION));
  expect(input('enabled').checked).toBe(false);
  const unavailable = input('transport').children.find((option) => option.value === 'unstuck')!;
  expect(unavailable.disabled).toBe(true);
  expect(panel.querySelector('details')!.all()).toContain(input('storageService'));
  input('enabled').checked = true;
  input('enabled').emit('change');
  expect(input('merchantMode').value).toBe('automatic');
  expect(input('stockEnabled').checked).toBe(false);
  expect(input('weightEnabled').checked).toBe(true);
  const configured = {
    ...structuredClone(DEFAULT_AUTOMATION),
    supply: {
      ...DEFAULT_SUPPLY,
      enabled: true,
      stockEnabled: false,
      weightEnabled: true,
      merchantMode: 'automatic' as const,
      transport: 'butterfly' as const,
      saveMap: 'prontera',
      returnMinStock: 3,
    },
  };
  ui.write(configured);
  expect(ui.read().supply).toEqual(configured.supply);
  panel.querySelector('button')!.emit('click');
  for (const name of ['apply', 'command', 'workflow', 'routine', 'service'] as const)
    expect(hooks[name]).not.toHaveBeenCalled();
  ui.lock(true, true);
  expect(input('enabled').disabled).toBe(true);
});
it('restores both previews after the startup lock and keeps manual and service locks independent', () => {
  const { ui, host, manualTools, hooks } = setup(true, true);
  ui.write(structuredClone(DEFAULT_AUTOMATION));
  const previews = ['Preview item disposition', 'Preview auto sell & supply trip'].map((label) => {
    const button = host.querySelectorAll('button').find((button) => button.textContent === label);
    expect(button).toBeDefined();
    return button!;
  });
  const manual = host.querySelector('#manual-run-walk')!,
    service = new Element('button');
  service.dataset.service = 'true';
  manualTools.append(service);
  // main.ts disables every control while native saved settings are loading.
  for (const input of host.querySelectorAll('input,select,button,textarea')) input.disabled = true;
  ui.lock(true, true, true);
  for (const button of previews) expect(button.disabled).toBe(true);

  ui.lock(false, true, true);
  for (const button of previews) expect(button.disabled).toBe(false);
  expect(manual.disabled).toBe(true);
  expect(service.disabled).toBe(true);
  for (const button of previews) button.emit('click');
  expect(host.querySelector('#disposition-preview')!.textContent).toContain(
    'Preview only · 0 suggested actions',
  );
  expect(host.querySelector('#supply-preview')!.textContent).toBe(
    'Supply trips are off. No trip will start.',
  );
  for (const name of [
    'apply',
    'command',
    'workflow',
    'routine',
    'service',
    'social',
    'memo',
  ] as const)
    expect(hooks[name]).not.toHaveBeenCalled();

  ui.lock(true, false, false);
  for (const button of previews) expect(button.disabled).toBe(true);
  expect(manual.disabled).toBe(false);
  expect(service.disabled).toBe(false);
});
it('uses the supplied mounts once and separates manual roots from Bot and profiles', () => {
  const { ui, host, sections, manualTools } = setup();
  const panels = Reflect.get(ui, 'panels') as Map<string, Element>;
  for (const [name, panel] of Object.entries(sections)) expect(panels.get(name)).toBe(panel);
  expect(host.querySelectorAll('.settings')).toHaveLength(6);
  for (const name of ['manualTargets', 'social', 'memo', 'socket', 'refine', 'warp']) {
    const root = Reflect.get(ui, name).root as Element;
    expect(root.parentElement).toBe(manualTools);
    for (const panel of Object.values(sections)) expect(panel.all()).not.toContain(root);
  }
  expect(manualTools.children).toHaveLength(6);
  expect((Reflect.get(ui, 'socket').root as Element).className).toBe('manual-details manual-group');
});
describe('discoverable canonical loot controls', () => {
  it('shows one own/all scope beside the existing master on the initial Combat & loot panel', () => {
    const { host, combat, master } = setup();
    const controls = host.querySelectorAll('[data-setting="loot.ownership"]');
    expect(controls).toHaveLength(1);
    expect(combat.querySelector('[data-setting="loot.ownership"]')).toBe(controls[0]);
    expect(combat.querySelector('#loot')).toBe(master);
    expect(combat.hidden).toBe(false);
    expect(controls[0]!.value).toBe('own');
    expect(controls[0]!.children.map((option) => [option.value, option.textContent])).toEqual([
      ['own', 'Only drops from your kills'],
      ['all', 'Loot all nearby drops'],
    ]);
  });
  it('uses the same setting for edits/profile readback and locks it without changing its current value', () => {
    const { ui, host, master } = setup(),
      scope = host.querySelector('[data-setting="loot.ownership"]')!;
    scope.value = 'all';
    expect(ui.read().loot.ownership).toBe('all');
    master.checked = false;
    ui.lock(true, true);
    expect(scope.disabled).toBe(true);
    expect(scope.value).toBe('all');
    expect(master.checked).toBe(false);
    ui.lock(false, true);
    const own = structuredClone(DEFAULT_AUTOMATION);
    ui.write(own);
    expect(ui.read().loot.ownership).toBe('own');
    expect(scope.value).toBe('own');
    scope.value = 'unverified';
    expect(() => ui.read()).toThrow();
  });
});
describe('opt-in normal retreat controls', () => {
  it('keeps default omission and displays one disabled group with exact bounds', () => {
    const { ui, combat } = setup();
    expect(ui.read()).not.toHaveProperty('retreat');
    const toggle = combat.querySelector('[data-setting="retreat.enabled"]')!;
    expect(toggle.checked).toBe(false);
    for (const [field, value] of Object.entries(DEFAULT_RETREAT))
      if (field !== 'enabled')
        expect(combat.querySelector(`[data-setting="retreat.${field}"]`)!.value).toBe(
          String(value),
        );
    expect(combat.querySelectorAll('[data-setting="retreat.enabled"]')).toHaveLength(1);
  });
  it('reads/writes one strict policy, retains it while locked and rejects an invalid distance', () => {
    const { ui, combat } = setup(),
      automation = structuredClone(DEFAULT_AUTOMATION);
    automation.retreat = { ...DEFAULT_RETREAT, enabled: true, maxAttempts: 1 };
    ui.write(automation);
    expect(ui.read().retreat).toEqual(automation.retreat);
    ui.lock(true, true);
    const toggle = combat.querySelector('[data-setting="retreat.enabled"]')!;
    expect(toggle.disabled).toBe(true);
    expect(toggle.checked).toBe(true);
    ui.lock(false, true);
    combat.querySelector('[data-setting="retreat.desiredDistance"]')!.value = '1';
    expect(() => ui.read()).toThrow();
    ui.write(DEFAULT_AUTOMATION);
    expect(ui.read()).not.toHaveProperty('retreat');
    expect(toggle.checked).toBe(false);
  });
});

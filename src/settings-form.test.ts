import { DEFAULT_SP_ITEMS, type RecoveryItemSettings } from './recovery-items';
import { DEFAULT_HP_POTIONS, type HpPotionSettings } from './hp-potions';
import { describe, expect, it, vi } from 'vitest';
import { CurrentForm, formDocument, type FormDocument } from './current-form';
import { FeatureUi } from './feature-ui';
import type { MapInfo } from './map-data';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { DEFAULT_AUTOMATION, DEFAULT_PARTY_HEAL, DEFAULT_RETREAT, DEFAULT_SETTINGS, validateSettings, type Settings, type SettingsInput } from './settings';
import { SettingsForm, type SettingsFormContext } from './settings-form';

// A local DOM adapter; projection and optional-policy conversion stay in the
// production SettingsForm and FeatureUi implementations.
class Element {
  children: Element[] = [];
  parentElement: Element | null = null;
  id = ''; className = ''; textContent = ''; value = ''; type = ''; title = ''; label = '';
  checked = false; disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => void>>();
  ownerDocument = { createElement: (tag: string): Element => new Element(tag) };
  classList = { toggle: (name: string, enabled: boolean) => {
    const names = new Set(this.className.split(/\s+/).filter(Boolean));
    if (enabled) names.add(name); else names.delete(name);
    this.className = [...names].join(' ');
  } };
  constructor(readonly tag: string) {}
  append(...children: Element[]) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(value => value !== child);
      child.parentElement = this; this.children.push(child);
    }
  }
  replaceChildren(...children: Element[]) { for (const child of this.children) child.parentElement = null; this.children = []; this.append(...children); }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  addEventListener(type: string, callback: () => void) { this.listeners.set(type, [...this.listeners.get(type) ?? [], callback]); }
  emit(type: string, bubbles = false) {
    for (const callback of this.listeners.get(type) ?? []) callback();
    if (bubbles) this.parentElement?.emit(type, true);
  }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  querySelector(selector: string): Element | null {
    const found = this.all().find(child => selector.startsWith('#') ? child.id === selector.slice(1) : child.dataset.setting === selector.match(/^\[data-setting="([^"]+)"\]$/)?.[1]);
    if (found) return found;
    // FeatureUi's existing read/write fixture needs only mounted input nodes.
    if (selector.startsWith('[data-setting=') || selector.startsWith('#map-policy-')) {
      const input = new Element('input');
      if (selector.startsWith('#')) input.id = selector.slice(1); else input.dataset.setting = selector.match(/"([^"]+)"/)![1]!;
      this.append(input); return input;
    }
    return null;
  }
}

const map: MapInfo = { code: 'prt_fild08', name: 'Prontera Field 8', source: 'database', monsters: [
  { classId: 4000, name: 'Poring', level: 1, maxHp: 51, spawnCount: 70, visibleCount: 2 },
  { classId: 4007, name: 'Thief Bug', level: 8, maxHp: 152, spawnCount: 10, visibleCount: 0 },
] };
const emptyMap: MapInfo = { code: '', name: '', source: 'observed', monsters: [] };
function settings(): Settings {
  return { ...DEFAULT_SETTINGS, map: map.code, targets: [4000, 4007], radius: 17, minHpPercent: 55,
    loot: false, route_randomWalk: 2, route_step: 3, route_avoidWalls: false,
    route_randomWalk_maxRouteTime: 99, attackRouteMaxPathDistance: 41, attackMaxRouteTime: 9,
    automation: { ...structuredClone(DEFAULT_AUTOMATION), limits: { minutes: 17, kills: 18, pickups: 19, weightPercent: 20 }, respawn: { enabled: true, maxDeaths: 1 } },
  };
}
function document(settings: SettingsInput, selectedProfileId: string | null = 'saved-profile', revision = 10): FormDocument {
  return formDocument({ version: 1, revision, settings, selectedProfileId });
}

function setup() {
  const host = new Element('main');
  for (const id of ['radius', 'min-hp', 'loot', 'random-walk', 'route-step', 'route-time', 'attack-distance', 'attack-time', 'avoid-walls',
    'radius-value', 'hp-value', 'select-targets', 'clear-targets', 'targets', 'target-count', 'target-map', 'target-source', 'profile-select', 'disposition-preview']) {
    const input = new Element('input'); input.id = id; host.append(input);
  }
  let context: SettingsFormContext = { sessionId: '', mapInfo: emptyMap, level: null, runActive: false, controlsLocked: false, targetsLocked: true };
  const changed = vi.fn();
  const editor: FeatureUi = Object.create(FeatureUi.prototype);
  const recursiveSettings = vi.fn(() => form.runSettings());
  let strategies: Array<Record<string, unknown>> = [];
  let disposition: Array<Record<string, unknown>> = [];
  // This adapter omits the full FeatureUi constructor, so mount permanent
  // controls lazily and retain their references just as the real constructor does.
  let spPotions: RecoveryItemSettings = structuredClone(DEFAULT_SP_ITEMS);
  let hpPotions: HpPotionSettings = structuredClone(DEFAULT_HP_POTIONS);
  const mountedInputs = new Map<string, Element>();
  Object.assign(editor, {
    host, hooks: { settings: recursiveSettings },
    spPotions: { read: () => structuredClone(spPotions), write: (value: RecoveryItemSettings) => { spPotions = structuredClone(value); } },
    hpPotions: { read: () => structuredClone(hpPotions), write: (value: HpPotionSettings) => { hpPotions = structuredClone(value); } },
    settingInputs: { get: (path: string) => {
      if (!mountedInputs.has(path)) mountedInputs.set(path, host.querySelector(`[data-setting="${path}"]`)!);
      return mountedInputs.get(path);
    } },
    editors: new Map([['attackStrategies', { read: () => structuredClone(strategies), write: (rows: typeof strategies) => { strategies = structuredClone(rows); } }]]),
    dispositionEditor: { read: () => structuredClone(disposition), write: (rows: typeof disposition) => { disposition = structuredClone(rows); } },
    profiles: { list: () => [{ id: 'saved-profile' }] }, hydrateProfileSelection: vi.fn(),
  });
  const form = new SettingsForm(host as unknown as HTMLElement, editor, { context: () => context, changed });
  form.restore(document(DEFAULT_SETTINGS, null));
  function observe(value: Partial<SettingsFormContext> = {}) {
    context = { ...context, sessionId: 'session', mapInfo: map, level: 7, targetsLocked: false, ...value };
    form.refresh();
  }
  function field(id: string): Element { return host.querySelector(`#${id}`)!; }
  function target(name: string): Element { return host.all().find(element => element.attributes.get('aria-label') === `Attack ${name}`)!; }
  return { form, host, editor, changed, recursiveSettings, observe, field, target,
    context: (value: Partial<SettingsFormContext>) => { context = { ...context, ...value }; },
  };
}

describe('settings form interface', () => {
  it('projects one observed pass coherently while later DOM writes remain fresh for commands and the next pass', () => {
    const f = setup(); f.form.restore(document(settings()));
    f.context({ sessionId: 'session', mapInfo: map, level: 1, targetsLocked: false });
    const pass = f.form.project();
    expect(pass.snapshot()).toMatchObject({ selectedProfileId: 'saved-profile', settings: { map: map.code, targets: [4000, 4007], radius: 17 } });
    expect(pass.runSettings()).toMatchObject({ map: map.code, targets: [4000], radius: 17 });
    f.field('radius').value = '13';
    expect(pass.runSettings().radius).toBe(17);
    expect(f.form.runSettings().radius).toBe(13);
    expect(f.form.project().snapshot().settings.radius).toBe(13);
    expect(f.target('Poring').checked).toBe(true);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });

  it('keeps invalid drafts editable and observes automation corrections and full restores on the next pass without events', () => {
    const f = setup(); f.form.restore(document(settings())); f.observe();
    const distance = f.host.querySelector('[data-setting="follow.distance"]')!;
    distance.value = '0';
    const invalid = f.form.project();
    expect(() => invalid.snapshot()).toThrow('Invalid automation');
    expect(f.field('radius').disabled).toBe(false);
    expect(distance.value).toBe('0');
    distance.value = '6';
    expect(() => invalid.runSettings()).toThrow('Invalid automation');
    expect(f.form.runSettings().automation?.follow.distance).toBe(6);
    expect(f.form.project().snapshot().settings.automation?.follow.distance).toBe(6);
    f.form.restore(document({ ...settings(), radius: 8 }, null));
    expect(f.form.project().snapshot()).toMatchObject({ selectedProfileId: null, settings: { radius: 8, targets: [4000, 4007] } });
    expect(f.changed).not.toHaveBeenCalled();
  });

  it('applies complete Setup offline, retaining configured map and targets and clearing the profile once', () => {
    const f = setup(); f.form.restore(document(settings()));
    const changed = settings(); changed.map = 'prt_fild07'; changed.targets = [4012]; changed.radius = 14;
    f.form.applySettings(changed);
    expect(f.form.snapshot()).toMatchObject({ settings: changed, selectedProfileId: null });
    expect(f.form.runSettings()).toMatchObject({ map: '', targets: [] });
    expect(f.changed).toHaveBeenCalledTimes(1);
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });

  it('keeps all retained controls and profile unchanged when any Setup setting fails validation', () => {
    const f = setup(); f.form.restore(document(settings())); const before = f.form.snapshot();
    expect(() => f.form.applySettings({ ...settings(), radius: 21 })).toThrow();
    expect(f.form.snapshot()).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
  });

  it.each([{ runActive: true }, { controlsLocked: true }])('guards complete Setup applying while the form is owned by %o', owner => {
    const f = setup(); f.form.restore(document(settings())); const before = f.form.snapshot(); f.context(owner);
    expect(() => f.form.applySettings({ ...settings(), radius: 14 })).toThrow('Stop automation');
    expect(f.form.snapshot()).toEqual(before); expect(f.changed).not.toHaveBeenCalled();
  });

  it('retains configured targets before readiness while field settings use only eligible targets', () => {
    const f = setup(); f.form.restore(document(settings()));
    expect(f.form.snapshot()).toMatchObject({ selectedProfileId: 'saved-profile', settings: settings() });
    expect(f.form.runSettings()).toMatchObject({ map: '', targets: [] });
    expect(() => validateSettings(f.form.runSettings())).toThrow();
    f.observe({ level: null });
    expect(f.target('Poring').checked).toBe(true);
    expect(f.form.runSettings().targets).toEqual([]);
    expect(() => validateSettings(f.form.runSettings())).toThrow('Choose selected monsters');
    f.observe({ mapInfo: { ...map, source: 'observed', monsters: [] }, level: 1 });
    expect(f.form.runSettings().targets).toEqual([4000]);
    expect(f.form.snapshot().settings.targets).toEqual([4000, 4007]);
    f.observe({ level: 10 });
    expect(f.form.runSettings().targets).toEqual([4000, 4007]);
    expect(f.changed).not.toHaveBeenCalled();
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });

  it('updates both projections through target interactions and keeps choices across other maps', () => {
    const f = setup(); f.observe();
    const target = f.target('Poring'); target.checked = true; target.emit('input');
    expect(f.form.runSettings().targets).toEqual([4000]);
    expect(f.form.snapshot().settings.targets).toEqual([4000]);
    f.observe({ mapInfo: { code: 'prontera', name: 'Prontera', source: 'database', monsters: [] } });
    expect(f.form.snapshot().settings).toMatchObject({ map: map.code, targets: [4000] });
    expect(f.form.runSettings()).toMatchObject({ map: 'prontera', targets: [] });
    expect(() => validateSettings(f.form.runSettings())).toThrow('Choose selected monsters');
    f.observe(); expect(f.target('Poring').checked).toBe(true);
    f.field('select-targets').emit('click');
    expect(f.form.snapshot().settings.targets).toEqual([4000, 4007]);
    f.field('clear-targets').emit('click');
    expect(f.form.snapshot().settings.targets).toEqual([]);
    expect(f.changed).toHaveBeenCalledTimes(3);
  });

  it('commits checkbox input before a bubbling form refresh and not again on change', () => {
    const f = setup(); f.observe();
    const persisted: Array<readonly number[]> = [];
    // Main refreshes controls synchronously when settings input bubbles.
    f.host.addEventListener('input', () => {
      persisted.push(f.form.snapshot().settings.targets);
      f.form.refresh();
    });
    f.changed.mockImplementation(() => f.form.refresh());
    const target = f.target('Poring');

    target.checked = true; target.emit('input', true); target.emit('change', true);
    expect(target.checked).toBe(true);
    expect(f.form.runSettings().targets).toEqual([4000]);
    expect(persisted).toEqual([[4000]]);
    expect(f.changed).toHaveBeenCalledTimes(1);

    target.checked = false; target.emit('input', true); target.emit('change', true);
    expect(target.checked).toBe(false);
    expect(f.form.runSettings().targets).toEqual([]);
    expect(f.form.snapshot().settings.targets).toEqual([]);
    expect(persisted).toEqual([[4000], []]);
    expect(f.changed).toHaveBeenCalledTimes(2);
  });

  it('keeps DOM-owned loot and wall avoidance edits through the same input refresh', () => {
    const f = setup(); f.observe();
    f.host.addEventListener('input', () => f.form.refresh());
    for (const [id, key] of [['loot', 'loot'], ['avoid-walls', 'route_avoidWalls']] as const) {
      const input = f.field(id);
      for (const checked of [false, true]) {
        input.checked = checked; input.emit('input', true); input.emit('change', true);
        expect(f.form.runSettings()[key]).toBe(checked);
        expect(f.form.snapshot().settings[key]).toBe(checked);
      }
    }
  });

  it('applies a profile using its new level limit and current eligible selection', () => {
    const f = setup(); f.observe();
    const value = settings(); value.automation!.combat.levelDifference = 0;
    f.form.applyProfile(value);
    expect(f.form.runSettings()).toMatchObject({ ...value, targets: [4000] });
    expect(f.form.snapshot().settings.targets).toEqual([4000]);
    expect(f.field('radius-value').textContent).toBe('17 cells');
    expect(f.field('hp-value').textContent).toBe('55%');
    expect(f.form.snapshot().settings.automation).toMatchObject({ limits: value.automation!.limits, respawn: { enabled: true, maxDeaths: 1 } });
    expect(f.changed).toHaveBeenCalledTimes(1);
  });

  it('rejects active, wrong-map and invalid profiles before any presentation mutation', () => {
    const f = setup(); f.observe(); f.form.restore(document(settings()));
    const before = f.form.snapshot(), write = vi.spyOn(f.editor, 'write');
    f.context({ runActive: true });
    expect(() => f.form.applyProfile({ ...settings(), radius: 3 })).toThrow('Stop automation');
    f.context({ runActive: false });
    expect(() => f.form.applyProfile({ ...settings(), map: 'prontera', radius: 3 })).toThrow('profile map');
    expect(() => f.form.applyProfile({ ...settings(), radius: 99 })).toThrow('Invalid settings');
    expect(() => f.form.applyProfile({ ...settings(), password: 'synthetic' } as Settings)).toThrow('Unknown settings');
    const invalid = settings(); invalid.automation!.limits.minutes = 1441;
    expect(() => f.form.applyProfile(invalid)).toThrow('Invalid automation');
    expect(f.form.snapshot()).toEqual(before);
    expect(f.field('radius-value').textContent).toBe('17 cells');
    expect(write).not.toHaveBeenCalled(); expect(f.changed).not.toHaveBeenCalled();
  });

  it('rejects invalid restored documents without changing values, profile or targets', () => {
    const f = setup(); f.observe(); f.form.restore(document(settings()));
    const before = f.form.snapshot(), write = vi.spyOn(f.editor, 'write');
    expect(() => f.form.restore(document({ ...settings(), radius: 99 }, null))).toThrow();
    expect(() => f.form.restore({ ...document(settings(), null), runRequested: true } as FormDocument)).toThrow();
    expect(f.form.snapshot()).toEqual(before); expect(write).not.toHaveBeenCalled();
  });

  it('uses the lock-map override while retaining configured target IDs', () => {
    const f = setup(), value = settings();
    value.automation!.combat.mode = 'off';
    value.automation!.mapPolicy = { ...structuredClone(DEFAULT_MAP_POLICY), lockArea: { map: map.code, minX: 0, minY: 0, maxX: 4, maxY: 4 } };
    f.form.restore(document(value));
    f.observe({ mapInfo: { code: 'prontera', name: 'Prontera', source: 'observed', monsters: [] } });
    expect(f.form.snapshot().settings).toMatchObject({ map: map.code, targets: value.targets });
    expect(f.form.runSettings()).toMatchObject({ map: map.code, targets: [] });
    f.observe();
    expect(f.form.runSettings()).toMatchObject({ map: map.code, targets: [4000, 4007] });
    expect(f.form.snapshot().settings.automation?.mapPolicy).toEqual(value.automation!.mapPolicy);
  });

  it('projects retained run targets without recording run ownership as settings or an edit', () => {
    const f = setup();
    f.observe({ runActive: true, controlsLocked: true, targetsLocked: true, retainedTargets: [4000, 9999] });
    expect(f.form.runSettings().targets).toEqual([4000]);
    expect(f.form.snapshot().settings.targets).toEqual([4000]);
    expect(f.form.snapshot()).not.toHaveProperty('runActive');
    expect(f.form.snapshot().settings).not.toHaveProperty('retainedTargets');
    expect(f.changed).not.toHaveBeenCalled();
  });

  it.each(['retaliate', 'both'] as const)('retains %s defense mode across form restoration and profiles', mode => {
    const f = setup(), value = settings();
    value.automation!.combat.mode = mode;
    if (mode === 'retaliate') value.targets = [];
    f.form.restore(document(value));
    f.observe();
    expect(validateSettings(f.form.runSettings()).automation?.combat.mode).toBe(mode);
    const saved = f.form.snapshot();
    const reopened = setup(); reopened.form.restore(document(saved.settings, saved.selectedProfileId)); reopened.observe();
    expect(validateSettings(reopened.form.runSettings()).automation?.combat.mode).toBe(mode);
    expect(reopened.form.snapshot().settings.targets).toEqual(value.targets);
    reopened.form.applyProfile(value);
    expect(reopened.form.snapshot().settings.automation?.combat.mode).toBe(mode);
  });

  it('preserves the saved death cap of one and recovery OFF across restoration and profile application', () => {
    const f = setup(), value = settings();
    value.automation!.recovery.enabled = false;
    f.form.restore(document(value));
    expect(f.form.snapshot().settings.automation).toMatchObject({ respawn: { enabled: true, maxDeaths: 1 }, recovery: { enabled: false } });
    f.observe(); f.form.applyProfile(value);
    expect(f.form.runSettings().automation).toMatchObject({ respawn: { enabled: true, maxDeaths: 1 }, recovery: { enabled: false } });
    expect(f.form.snapshot().settings.automation?.recovery).toEqual(value.automation!.recovery);
    expect(f.form.snapshot().settings.automation?.respawn).toEqual(value.automation!.respawn);
  });

  it('separately retains synthetic zero-death-cap schema compatibility', () => {
    const f = setup(), value = settings(); value.automation!.respawn.maxDeaths = 0;
    f.form.restore(document(value)); expect(f.form.snapshot().settings.automation?.respawn.maxDeaths).toBe(0);
    f.observe(); f.form.applyProfile(value); expect(f.form.snapshot().settings.automation?.respawn.maxDeaths).toBe(0);
  });

  it('preserves optional absence and explicit defaults through the actual automation editor', () => {
    const f = setup(); f.observe();
    const value = settings();
    value.automation = { ...value.automation!, partyHeal: { ...DEFAULT_PARTY_HEAL }, attackStrategies: [] };
    f.form.restore(document(value));
    expect(f.form.snapshot().settings.automation).toMatchObject({ partyHeal: DEFAULT_PARTY_HEAL, attackStrategies: [] });
    f.form.applyProfile(settings());
    expect(f.form.snapshot().settings.automation).not.toHaveProperty('partyHeal');
    expect(f.form.snapshot().settings.automation).not.toHaveProperty('attackStrategies');
    f.field('radius').value = '13'; f.field('radius').emit('input');
    expect(f.form.snapshot().settings.radius).toBe(13);
    expect(f.field('radius-value').textContent).toBe('13 cells');
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });

  it('retains ordered HP potion settings on restore and profile apply while legacy absence stays disabled', () => {
    const f = setup(), value = settings();
    value.automation!.hpPotions = { mode: 'selected', itemIds: [504, 501], belowPercent: 70, minStock: 2, cooldownSeconds: 8 };
    f.form.restore(document(value)); expect(f.form.snapshot().settings.automation?.hpPotions).toEqual(value.automation!.hpPotions);
    f.observe(); f.form.applyProfile(value); expect(f.form.snapshot().settings.automation?.hpPotions).toEqual(value.automation!.hpPotions);
    f.form.applyProfile(settings()); expect(f.form.snapshot().settings.automation).not.toHaveProperty('hpPotions');
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });

  it('round trips optional retreat policy and resets its presence when a legacy profile is applied', () => {
    const f = setup(); f.observe();
    expect(f.form.snapshot().settings.automation).not.toHaveProperty('retreat');
    const explicit = settings(); explicit.automation!.retreat = { ...DEFAULT_RETREAT };
    f.form.restore(document(explicit));
    expect(f.form.snapshot().settings.automation?.retreat).toEqual(DEFAULT_RETREAT);
    const configured = settings(); configured.automation!.retreat = { ...DEFAULT_RETREAT, enabled: true, maxAttempts: 5 };
    f.form.applyProfile(configured);
    const saved = f.form.snapshot();
    f.form.restore(document(saved.settings, saved.selectedProfileId));
    expect(f.form.runSettings().automation?.retreat).toEqual(configured.automation!.retreat);
    f.form.applyProfile(settings());
    expect(f.form.snapshot().settings.automation).not.toHaveProperty('retreat');
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });

  it('refreshes labels and locks without replacing focused target controls or notifying edits', () => {
    const f = setup(); f.observe(); const input = f.target('Poring');
    f.host.addEventListener('input', () => f.form.refresh());
    f.field('min-hp').value = '63'; f.field('min-hp').emit('input');
    expect(f.field('hp-value').textContent).toBe('63%');
    f.observe({ controlsLocked: true, targetsLocked: true });
    expect(f.field('radius').disabled).toBe(true); expect(input.disabled).toBe(true);
    input.checked = true; input.emit('input', true); input.emit('change', true);
    expect(f.form.snapshot().settings.targets).toEqual([]);
    expect(input.checked).toBe(false);
    f.field('select-targets').emit('click'); expect(f.changed).not.toHaveBeenCalled();
    f.observe({ controlsLocked: false, mapInfo: { ...map, monsters: [{ ...map.monsters[0]!, name: 'Updated Poring', visibleCount: 1 }, map.monsters[1]!] } });
    expect(f.target('Updated Poring')).toBe(input); expect(input.checked).toBe(false);
    expect(f.field('radius').disabled).toBe(false); expect(input.disabled).toBe(false);
    expect(f.field('target-source').textContent).toContain('Level limit: yours +1.');
  });
});

describe('settings form composed with CurrentForm', () => {
  it('preserves manual edits over delayed restoration and serializes changing snapshots', async () => {
    const f = setup(); f.form.restore(document(settings()));
    const writes: FormDocument[] = []; let release: () => void = () => {};
    const current = new CurrentForm(() => f.form.snapshot(), async value => {
      writes.push(structuredClone(value));
      if (writes.length === 1) await new Promise<void>(resolve => { release = resolve; });
      return value.revision;
    });
    f.field('radius').value = '13'; f.field('radius').emit('input'); current.touch();
    current.restore(document({ ...settings(), radius: 3 }, null), value => f.form.restore(value));
    expect(f.form.snapshot()).toMatchObject({ selectedProfileId: 'saved-profile', settings: { radius: 13, targets: [4000, 4007] } });
    const first = current.flush(); await Promise.resolve(); await Promise.resolve();
    f.field('radius').value = '18'; current.touch(); const second = current.flush();
    expect(writes.map(value => value.settings.radius)).toEqual([13]);
    release(); await first; const saved = await second;
    expect(writes.map(value => value.settings.radius)).toEqual([13, 18]);
    expect(saved.revision).toBe(12); expect(saved.settings.targets).toEqual([4000, 4007]);
  });

  it('rejects dirty invalid input without saving or incorporating credentials and run state', async () => {
    const f = setup(); f.observe(); f.form.restore(document(settings()));
    for (const id of ['username', 'password', 'running', 'runRequested']) {
      const input = new Element('input'); input.id = id; input.value = 'synthetic'; input.checked = true; f.host.append(input);
    }
    const snapshot = f.form.snapshot();
    expect(Object.keys(snapshot).sort()).toEqual(['selectedProfileId', 'settings']);
    for (const key of ['username', 'password', 'running', 'runRequested']) expect(snapshot.settings).not.toHaveProperty(key);
    const save = vi.fn(async (value: FormDocument) => value.revision), current = new CurrentForm(() => f.form.snapshot(), save);
    current.restore(document(settings()), value => f.form.restore(value));
    f.field('route-time').value = ''; current.touch();
    expect(f.form.runSettings().route_randomWalk_maxRouteTime).toBe(0);
    expect(() => f.form.snapshot()).toThrow('Invalid settings'); expect(() => validateSettings(f.form.runSettings())).toThrow('Invalid settings');
    await expect(current.flush()).rejects.toThrow('Invalid settings'); expect(save).not.toHaveBeenCalled();
    expect(f.field('route-time').value).toBe('');
  });

  it('restores then saves through the same interface and retains a valid later save after failure', async () => {
    const f = setup(), writes: FormDocument[] = [];
    const current = new CurrentForm(() => f.form.snapshot(), async value => {
      writes.push(structuredClone(value)); if (writes.length === 1) throw new Error('save unavailable'); return value.revision;
    });
    current.restore(document(settings()), value => f.form.restore(value));
    expect(f.field('radius-value').textContent).toBe('17 cells'); expect(f.changed).not.toHaveBeenCalled();
    await expect(current.flush()).rejects.toThrow('save unavailable');
    f.observe(); f.form.applyProfile({ ...settings(), radius: 8 }); current.touch();
    const saved = await current.flush();
    expect(saved.settings).toMatchObject({ ...settings(), radius: 8 });
    expect(saved.selectedProfileId).toBe('saved-profile'); expect(saved.revision).toBe(12);
    expect(f.recursiveSettings).not.toHaveBeenCalled();
  });
});

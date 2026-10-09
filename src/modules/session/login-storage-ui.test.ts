import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotEngine } from '../automation/engine';
import { CompanionController } from '../runtime/controller';
import { PersistentFieldRun } from './reconnect';
import { DEFAULT_SETTINGS, type SettingsInput } from '../settings/settings';
import type { BotScriptDocument } from '../settings/bot-script';
import type { MacroUi } from '../automation/macro-ui';
import type { UpdateContinuationInput } from '../update/update-continuation';
import type { GameStatus } from '../client/game-status';
import { searchGrid } from '../navigation/navigation';
import { liveSettingsGuard } from '../settings/live-settings-logic';
import type { SupplySnapshot } from '../services/supply-trip-logic';

const ipc = vi.hoisted(() => ({
  featureSettled: true,
  macroDirty: false,
  scriptStorageFails: false,
  useEditor: false,
  limitMinutes: 0,
  travelDestination: '',
  partyFollow: false,
  editor: null as MacroUi | null,
  setupScript: null as BotScriptDocument['script'],
  setupSettings: null as SettingsInput | null,
  syncSetup: vi.fn(),
  clearMacro: vi.fn(),
  invoke: vi.fn(),
  listen: vi.fn(
    async (_name: string, _callback: (event: { payload: unknown }) => void) => () => {},
  ),
}));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('../client/feature-ui', async () => {
  const { DEFAULT_AUTOMATION } = await import('../settings/settings');
  const { MacroUi } = await import('../automation/macro-ui');
  return {
    FeatureUi: class {
      private profile: string | null = null;
      private held = false;
      constructor(
        _host: HTMLElement,
        private readonly hooks: {
          macroSettings(): SettingsInput;
          applySetup(settings: SettingsInput): void;
          setupChanged(): void;
          notify(message: string, error?: boolean): void;
        },
        mounts: { manualTools: HTMLElement },
      ) {
        if (ipc.useEditor)
          ipc.editor = new MacroUi(
            {
              settings: () => hooks.macroSettings(),
              apply: (value) => hooks.applySetup(value),
              changed: () => hooks.setupChanged(),
              notify: hooks.notify,
            },
            {
              getItem: () => null,
              setItem: () => {
                if (ipc.scriptStorageFails) throw new Error('quota');
              },
            },
          );
        if (ipc.editor) _host.append(ipc.editor.root);
        const group = document.createElement('details');
        group.className = 'manual-group';
        group.id = 'synthetic-manual-group';
        const title = document.createElement('summary');
        title.textContent = 'Synthetic manual tool';
        const action = document.createElement('button');
        action.id = 'synthetic-manual-action';
        group.append(title, action);
        mounts.manualTools.append(group);
        const supply = document.createElement('div');
        supply.id = 'supply-preview';
        _host.append(supply);
      }

      selectedProfileId() {
        return this.profile;
      }
      restoreProfileSelection(id: string | null) {
        this.profile = id;
      }
      write(): void {}
      levelDifference() {
        return 1;
      }
      withSettings<T>(_settings: () => SettingsInput, render: () => T): T {
        return render();
      }
      render(status: { refine?: { blocked?: boolean } }): void {
        this.held = status.refine?.blocked === true;
      }
      active(): boolean {
        return this.held;
      }
      serviceBlocked(): boolean {
        return false;
      }
      warpActivationReady(): boolean {
        return false;
      }
      settledForMaintenance(): boolean {
        return ipc.featureSettled;
      }
      hasUnsavedMacro(): boolean {
        return ipc.macroDirty || ipc.editor?.unsaved === true;
      }
      setupDraftDirty(): boolean {
        return ipc.macroDirty || ipc.editor?.dirty === true;
      }
      syncSetup(settings: SettingsInput): void {
        ipc.syncSetup(settings);
        ipc.editor?.syncSettings(settings);
      }
      setupDocument(): { settings: SettingsInput; script: BotScriptDocument['script'] } {
        if (ipc.macroDirty) throw new Error('Apply or discard your Script draft before Start.');
        if (ipc.editor) return ipc.editor.configured();
        return {
          settings: ipc.setupSettings ?? this.hooks.macroSettings(),
          script: ipc.setupScript,
        };
      }
      clearMacro(): void {
        ipc.clearMacro();
      }
      clearSocial(): void {}
      clearMemo(): void {}
      readProfiles() {
        return [];
      }
      readServices() {
        return { saved: [], builtins: [] };
      }
      readScript() {
        return ipc.editor?.readScript() ?? { script: '', dirty: false, unsaved: false };
      }
      setScript(script: string) {
        return ipc.editor?.setScript(script) ?? { draftChanged: false, persisted: false };
      }
      serviceOperation(): void {
        this.hooks.setupChanged();
      }
      read() {
        const value = structuredClone(DEFAULT_AUTOMATION);
        value.limits.minutes = ipc.limitMinutes;
        value.travel.destinationMap = ipc.travelDestination;
        if (ipc.partyFollow) value.follow.mode = 'partyLeader';
        return value;
      }
      lock(): void {}
    },
    validFeatureStatus: () => true,
  };
});

// Exercise the actual main-window form callbacks with native IPC replaced.
// No browser, app data, real account or persistent frontend store is involved.
class Element {
  value = '';
  checked = false;
  disabled = false;
  hidden = false;
  open = false;
  tabIndex = 0;
  textContent = '';
  placeholder = '';
  id = '';
  className = '';
  title = '';
  dataset: Record<string, string> = {};
  style = { width: '', setProperty() {} };
  width = 400;
  height = 400;
  attributes = new Map<string, string>();
  children: Element[] = [];
  parentElement: Element | null = null;
  ownerDocument = { createElement: (tag: string) => new Element(this.elements, tag) };
  get tagName(): string {
    return this.tag.toUpperCase();
  }
  classList = { toggle() {}, add() {}, remove() {} };
  listeners = new Map<
    string,
    Array<(event: { preventDefault(): void; stopPropagation(): void; target?: Element }) => unknown>
  >();
  markup = '';
  constructor(
    private readonly elements: Map<string, Element>,
    readonly tag = 'div',
  ) {}
  set innerHTML(html: string) {
    this.markup = html;
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = new Element(this.elements, match[1]!);
      node.id = match[3]!;
      node.className = /\bclass="([^"]*)"/.exec(match[2]!)?.[1] ?? '';
      const pureNav = /data-client-navigation="([^"]*)"/.exec(match[2]!)?.[1];
      if (pureNav) node.dataset.clientNavigation = pureNav;
      for (const key of ['page', 'bot', 'inspector', 'navigation']) {
        const value = new RegExp(`data-client-${key}-nav="([^"]*)"`).exec(match[2]!)?.[1];
        if (value)
          node.dataset[
            key === 'page'
              ? 'clientPageNav'
              : key === 'bot'
                ? 'clientBotNav'
                : key === 'inspector'
                  ? 'clientInspectorNav'
                  : 'clientNavigation'
          ] = value;
      }
      node.checked = /\bchecked\b/.test(match[2]!);
      node.disabled = /\bdisabled\b/.test(match[2]!);
      node.hidden = /\bhidden\b/.test(match[2]!);
      node.value =
        /\bvalue="([^"]*)"/.exec(match[2]!)?.[1] ??
        (node.id === 'connection-mode' ? 'botOnly' : match[1] === 'select' ? '0' : '');
      this.elements.set(node.id, node);
    }
  }
  append(...children: Element[]): void {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
      if (child.id) this.elements.set(child.id, child);
    }
  }
  prepend(...children: Element[]): void {
    for (const child of [...children].reverse()) {
      child.parentElement = this;
      this.children.unshift(child);
      if (child.id) this.elements.set(child.id, child);
    }
  }
  replaceChildren(...children: Element[]): void {
    this.children = [];
    this.append(...children);
  }
  get childElementCount(): number {
    return this.children.length;
  }
  querySelector(selector: string): Element | null {
    if (selector === 'main' || selector === '.client-toolbar' || selector === '.client-skip-link')
      return this.elements.get(selector) ?? null;
    if (selector === 'summary') return this.children.find((node) => node.tag === 'summary') ?? null;
    return selector.startsWith('#') ? (this.elements.get(selector.slice(1)) ?? null) : null;
  }
  querySelectorAll(selector: string): Element[] {
    if (selector.includes('button[data-client-page-nav]'))
      return [...this.elements.values()]
        .filter(
          (node) =>
            node.dataset.clientPageNav ||
            node.dataset.clientBotNav ||
            node.dataset.clientInspectorNav ||
            node.dataset.clientNavigation,
        )
        .concat(this.elements.get('client-manual-index')?.children ?? []);
    if (selector.startsWith('details.manual-group'))
      return this.children.filter(
        (node) => node.tag === 'details' && node.className.includes('manual-group'),
      );
    if (selector === 'input,select,button,textarea')
      return [...new Set(this.elements.values())]
        .filter((node) => ['input', 'select', 'button', 'textarea'].includes(node.tag))
        .concat(this.elements.get('client-manual-index')?.children ?? []);
    return [];
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  getBoundingClientRect() {
    return this.id === 'client-game-viewport'
      ? { x: 24, y: 220, width: 800, height: 440, bottom: 660 }
      : { x: 0, y: 0, width: 1100, height: 160, bottom: 160 };
  }
  focus(): void {}
  scrollIntoView(): void {}

  getContext() {
    return {
      clearRect() {},
      fillText() {},
      createImageData(width: number, height: number) {
        return { data: new Uint8ClampedArray(width * height * 4) };
      },
      putImageData() {},
      drawImage() {},
      beginPath() {},
      lineTo() {},
      moveTo() {},
      stroke() {},
      arc() {},
      fill() {},
    };
  }
  addEventListener(
    type: string,
    callback: (event: {
      preventDefault(): void;
      stopPropagation(): void;
      target?: Element;
    }) => unknown,
  ): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  click(): void {
    void this.emit('click');
  }
  closest(selector: string): Element | null {
    if (selector === '#client-mcp') return this.id.startsWith('mcp-') ? this : null;
    if (selector === '#signin-panel')
      return [
        'username',
        'password',
        'character-slot',
        'connection-mode',
        'remember-login',
        'auto-login',
        'auto-reconnect',
      ].includes(this.id)
        ? this
        : null;
    return selector.includes('.settings') ? this : null;
  }
  async emit(type: string, target?: Element): Promise<void> {
    for (const callback of this.listeners.get(type) ?? [])
      callback({ preventDefault() {}, stopPropagation() {}, target });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}
type SavedProfile = {
  username: string;
  characterSlot: number;
  autoLogin: boolean;
  mode?: 'botOnly' | 'gameClient';
};
async function fixture(
  saved: SavedProfile | null | Promise<SavedProfile | null> = null,
  readFails = false,
  savedForm: unknown = null,
  continuation: unknown = null,
  updateStopped = false,
  useEditor = false,
) {
  const elements = new Map<string, Element>(),
    root = new Element(elements),
    main = new Element(elements, 'main');
  elements.set('main', main);
  elements.set('.client-toolbar', new Element(elements, 'header'));
  elements.set('.client-skip-link', new Element(elements, 'a'));
  vi.useFakeTimers();
  vi.stubGlobal('document', {
    querySelector: (selector: string) => (selector === '#app' ? root : main),
    querySelectorAll: (selector: string) => main.querySelectorAll(selector),
    getElementById: (id: string) => elements.get(id),
    createElement: (tag: string) => new Element(elements, tag),
  });
  vi.stubGlobal('innerWidth', 1100);
  vi.stubGlobal('innerHeight', 880);
  vi.stubGlobal('addEventListener', vi.fn());
  ipc.featureSettled = true;
  ipc.macroDirty = false;
  ipc.useEditor = useEditor;
  ipc.limitMinutes = 0;
  ipc.travelDestination = '';
  ipc.partyFollow = false;
  ipc.scriptStorageFails = false;
  ipc.editor = null;
  ipc.setupScript = null;
  ipc.setupSettings = null;
  ipc.syncSetup.mockClear();
  ipc.clearMacro.mockClear();
  ipc.invoke.mockReset();
  ipc.listen.mockClear();
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document?: { revision: number } }) => {
      if (command === 'current_form') return savedForm;
      if (command === 'save_current_form') return args?.document?.revision;
      if (command === 'update_continuation') return continuation;
      if (command === 'update_startup_stopped') return updateStopped;
      if (command === 'update_status')
        return { version: '0.2.27', platform: 'macos', phase: 'current', message: 'Current' };
      if (command === 'saved_login') {
        if (readFails) throw 'synthetic store failure';
        return saved;
      }
      return undefined;
    },
  );
  vi.resetModules();
  await import('../../app/main');
  for (let i = 0; i < 40; i++) await Promise.resolve();
  return {
    root,
    main,
    index: () => elements.get('client-manual-index')!.children,
    get: (id: string) => elements.get(id)!,
    calls: (command: string) => ipc.invoke.mock.calls.filter((call) => call[0] === command),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function pendingNative() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}
function readyStatus(sessionId = 'synthetic-old'): GameStatus {
  const grid = searchGrid('prt_fild08')!;
  let x = 0,
    y = 0;
  while (y < grid.height && !grid.walkable({ x, y })) {
    if (++x === grid.width) {
      x = 0;
      y++;
    }
  }
  return {
    ...new BotEngine(() => {}).snapshot(),
    sessionId,
    map: 'prt_fild08',
    connected: true,
    compatible: true,
    reconnectAvailable: true,
    login: { phase: 'complete', message: '' },
    player: {
      id: 0,
      classId: 4,
      kind: 0,
      name: 'Synthetic',
      level: 30,
      hp: 100,
      maxHp: 100,
      x,
      y,
      dead: false,
      statuses: [],
    },
    mapInfo: {
      code: 'prt_fild08',
      name: 'Synthetic field',
      source: 'observed',
      monsters: [
        {
          classId: 4000,
          name: 'Synthetic monster',
          level: 1,
          maxHp: 100,
          spawnCount: null,
          visibleCount: 0,
        },
      ],
    },
  };
}
async function settleMain() {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
async function publishStatus(status: GameStatus) {
  ipc.listen.mock.calls.find((call) => call[0] === 'game-status')![1]({ payload: status });
  await settleMain();
}
function closeGame() {
  ipc.listen.mock.calls.find((call) => call[0] === 'game-closed')![1]({ payload: undefined });
}

it.each(['botOnly', 'gameClient'] as const)(
  'edits a separate draft and acknowledges live Apply through Main in %s mode',
  async (mode) => {
    const f = await fixture(),
      ready = { ...readyStatus(), connectionMode: mode };
    await publishStatus(ready);
    await f.get('select-targets').emit('click');
    await f.get('start').emit('click');
    const settings = (
      f
        .calls('control_bot')
        .find((call) => (call[1] as { action?: string }).action === 'start')![1] as {
        settings: SettingsInput;
      }
    ).settings;
    const active = {
      ...ready,
      running: true,
      runRequested: true,
      state: 'running' as const,
      activeSettings: settings,
    };
    await publishStatus(active);
    expect(f.get('radius').disabled).toBe(false);
    expect(f.get('loot').disabled).toBe(false);
    await f.get('clear-targets').emit('click');
    await publishStatus(active);
    expect(f.get('target-count').textContent).toBe('0 selected');
    expect(f.get('apply-run-settings').disabled).toBe(true);
    expect(f.get('console-setup-summary').textContent).toContain('Synthetic monster');
    await f.get('select-targets').emit('click');
    f.get('radius').value = '8';
    f.get('loot').checked = false;
    f.get('route-step').value = '11';
    await f.main.emit('input', f.get('radius'));
    expect(f.get('console-setup-summary').textContent).toContain('Active run:');
    expect(f.get('console-setup-summary').textContent).toContain('Own drops');
    expect(f.get('console-saved-draft-summary').textContent).toContain('Pickup off');
    expect(f.get('live-settings-status').textContent).toContain('Next run: Route step');
    expect(
      f.calls('control_bot').filter((call) => (call[1] as { action?: string }).action === 'apply'),
    ).toEqual([]);
    expect(f.get('apply-run-settings').disabled).toBe(false);
    await f.get('apply-run-settings').emit('click');
    await settleMain();
    const request = f
      .calls('control_bot')
      .find((call) => (call[1] as { action?: string }).action === 'apply')![1] as {
      applyId: string;
      settings: SettingsInput;
    };
    expect(request.settings).toMatchObject({ radius: 8, loot: false, route_step: 11 });
    expect(f.get('apply-run-settings').disabled).toBe(true);
    await publishStatus({
      ...active,
      settingsApply: {
        id: request.applyId,
        state: 'pending',
        applied: [],
        pending: ['radius', 'loot'],
        nextRun: ['route_step'],
        reason: 'Waiting for action confirmation.',
      },
    });
    expect(f.get('live-settings-status').textContent).toContain(
      'Pending: Waiting for action confirmation.',
    );
    expect(f.get('console-setup-summary').textContent).toContain('Own drops');
    const applied = { ...settings, radius: 8, loot: false };
    await publishStatus({
      ...active,
      activeSettings: applied,
      liveSettingsGuard: liveSettingsGuard(applied, null, 'Synthetic', [], Date.now()),
      settingsApply: {
        id: request.applyId,
        state: 'applied',
        applied: ['radius', 'loot'],
        pending: [],
        nextRun: ['route_step'],
        reason: 'Applied to the same run.',
      },
    });
    expect(f.get('console-setup-summary').textContent).toContain('Pickup off');
    expect(f.get('live-settings-status').textContent).toContain('Applied to the same run.');
    expect(f.get('route-step').value).toBe('11');
    await publishStatus({ ...readyStatus('replacement'), connectionMode: mode });
    const starts = f
      .calls('control_bot')
      .filter((call) => (call[1] as { action?: string }).action === 'start');
    expect(starts).toHaveLength(2);
    expect(starts[1]![1]).toMatchObject({
      settings: { radius: 8, loot: false, route_step: settings.route_step },
    });
  },
);

it('shares the existing login and active run between Game and Bot without reconnecting', async () => {
  const f = await fixture({
    username: 'synthetic-user',
    characterSlot: 0,
    autoLogin: false,
    mode: 'gameClient',
  });
  await f.get('signin-form').emit('submit');
  await settleMain();
  expect(f.calls('login_game')).toHaveLength(1);
  expect(f.get('client-page-game').hidden).toBe(false);
  expect(f.calls('set_game_view')).toEqual([
    ['set_game_view', { bounds: { x: 24, y: 220, width: 800, height: 440 } }],
  ]);
  await publishStatus({
    ...readyStatus('shared-session'),
    connectionMode: 'gameClient',
    runRequested: true,
    running: true,
    state: 'running',
  });
  const commands = f.calls('control_bot').length;
  for (let index = 0; index < 3; index++) {
    await f.get('client-tab-session').emit('click');
    await settleMain();
    expect(f.get('client-page-session').hidden).toBe(false);
    expect(f.get('stop').disabled).toBe(false);
    await f.get('client-tab-game').emit('click');
    await settleMain();
    expect(f.get('client-page-game').hidden).toBe(false);
    expect(f.get('client-game-placeholder').hidden).toBe(true);
  }
  expect(f.get('character').textContent).toBe('Synthetic');
  expect(f.calls('login_game')).toHaveLength(1);
  expect(f.calls('reconnect_game')).toEqual([]);
  expect(f.calls('close_game')).toEqual([]);
  expect(f.calls('control_bot')).toHaveLength(commands);
  expect(f.calls('set_game_view').slice(1)).toEqual(
    Array.from({ length: 3 }, () => [
      ['set_game_view', { bounds: null }],
      ['set_game_view', { bounds: { x: 24, y: 220, width: 800, height: 440 } }],
    ]).flat(),
  );
  closeGame();
  await settleMain();
  expect(f.calls('set_game_view').at(-1)).toEqual(['set_game_view', { bounds: null }]);
  expect(f.get('client-game-placeholder').hidden).toBe(false);
});

it('shows connection guidance in Game without creating a second bot-only connection', async () => {
  const f = await fixture();
  await f.get('client-tab-game').emit('click');
  await settleMain();
  expect(f.get('client-game-help').textContent).toContain('With game client');
  await publishStatus({ ...readyStatus(), connectionMode: 'botOnly' });
  expect(f.get('client-game-help').textContent).toContain('Disconnect');
  expect(f.calls('set_game_view')).toEqual([]);
  expect(f.calls('login_game')).toEqual([]);
  expect(f.calls('open_game')).toEqual([]);
  expect(f.calls('reconnect_game')).toEqual([]);
});
function continuationFixture(): UpdateContinuationInput {
  const ready = readyStatus(),
    settings = { ...DEFAULT_SETTINGS, map: ready.map, targets: [4000] };
  const c = new CompanionController(() => {});
  c.connect(true);
  c.engine.receive([
    { type: 'enter', id: ready.player!.id, map: ready.map },
    { type: 'spawn', entity: ready.player! },
  ]);
  c.world.reset(ready.map);
  const status = { ...c.snapshot(), ...ready, runRequested: true, running: false };
  const field = new PersistentFieldRun();
  field.begin(settings, ready.player!.name, ready.sessionId);
  return {
    version: 1,
    account: { username: 'synthetic-user', characterSlot: 1, mode: 'botOnly' },
    form: { version: 1, revision: 5, selectedProfileId: null, settings },
    field: field.checkpoint()!,
    savedAccount: true,
    runtime: {
      version: 1,
      frozenAt: Date.now(),
      status,
      settings,
      macro: null,
      partyHeal: { version: 1, attempts: 0, confirmed: 0, cooldownUntil: 0 },
      run: { startedAt: Date.now(), kills: 0, pickups: 0, deaths: 0 },
    },
  };
}

describe('main run intent dispatch wiring', () => {
  it.each(['start', 'resume', 'reconnect'])(
    'keeps Stop locked until deferred %s settles and the compensating Stop completes',
    async (kind) => {
      const f = await fixture(),
        sent = pendingNative(),
        finalStop = pendingNative();
      let starts = 0,
        stops = 0;
      ipc.invoke.mockImplementation(
        (command: string, args?: { action?: string; document?: { revision: number } }) => {
          if (command === 'save_current_form') return Promise.resolve(args!.document!.revision);
          if (command === 'control_bot' && args?.action === 'start') {
            starts++;
            if (kind === 'start' || (kind === 'resume' && starts === 2)) return sent.promise;
          }
          if (command === 'control_bot' && args?.action === 'stop' && ++stops === 2)
            return finalStop.promise;
          if (command === 'reconnect_game') return sent.promise;
          return Promise.resolve(undefined);
        },
      );
      const ready = readyStatus();
      await publishStatus(ready);
      await f.get('select-targets').emit('click');
      expect(f.get('start').disabled).toBe(false);
      await f.get('start').emit('click');
      await settleMain();
      if (kind === 'resume') await publishStatus(readyStatus('synthetic-new'));
      if (kind === 'reconnect') {
        await publishStatus({
          ...ready,
          connected: false,
          player: null,
          login: { phase: 'idle', message: '' },
        });
        await vi.advanceTimersByTimeAsync(5000);
        expect(f.calls('reconnect_game')).toHaveLength(1);
      }
      await f.get('stop').emit('click');
      expect(f.get('stop').disabled).toBe(true);
      expect(f.get('radius').disabled).toBe(true);
      const actions = () =>
        f
          .calls('control_bot')
          .map((call) => (call[1] as { action: string }).action)
          .filter((action) => action !== 'heartbeat');
      expect(actions().at(-1)).toBe('stop');
      sent.resolve();
      await settleMain();
      expect(actions().slice(-2)).toEqual(['stop', 'stop']);
      expect(f.get('stop').disabled).toBe(true);
      expect(f.get('radius').disabled).toBe(true);
      finalStop.resolve();
      await settleMain();
      expect(f.get('radius').disabled).toBe(false);
      expect(f.get('notice').textContent).toBe('Bot stopped.');
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.calls('reconnect_game')).toHaveLength(kind === 'reconnect' ? 1 : 0);
      expect(actions().filter((action) => action === 'start')).toHaveLength(
        kind === 'resume' ? 2 : 1,
      );
    },
  );

  it.each(['success', 'failure'])(
    'retires %s sign-in at native completion before metadata reaches the main UI',
    async (result) => {
      const f = await fixture(),
        sent = pendingNative();
      f.get('username').value = 'synthetic-user';
      f.get('password').value = 'synthetic-password';
      f.get('remember-login').checked = true;
      ipc.invoke.mockImplementation((command: string) =>
        command === 'login_game' ? sent.promise : Promise.resolve(undefined),
      );
      await f.get('signin-form').emit('submit');
      void sent.promise.then(closeGame, closeGame);
      if (result === 'success') sent.resolve();
      else sent.reject('Old sign-in failed');
      await settleMain();
      expect(f.get('saved-account').textContent).toBe('Session only');
      expect(f.get('password').value).toBe('');
      expect(f.get('connection-mode').disabled).toBe(false);
      expect(f.get('signin').disabled).toBe(false);
      expect(f.get('notice').textContent).toBe(
        'Disconnected. Select an account and character to connect again.',
      );
    },
  );

  it('keeps the updater waiting for native sign-in after game closure retires its UI phase', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 0, autoLogin: false }),
      sent = pendingNative();
    ipc.invoke.mockImplementation(
      async (command: string, args?: { document: { revision: number } }) => {
        if (command === 'login_game') return sent.promise;
        if (command === 'update_status')
          return { version: '0.2.27', phase: 'waiting', message: 'Update ready' };
        if (command === 'save_current_form') return args!.document.revision;
        if (command === 'update_reserve') return 'a'.repeat(32);
        if (command === 'update_install') return true;
      },
    );
    await f.get('signin-form').emit('submit');
    closeGame();
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.get('update-status').textContent).toBe(
      'Update waits for the pending sign-in request to finish.',
    );
    expect(f.calls('update_reserve')).toEqual([]);
    expect(f.calls('update_install')).toEqual([]);
    sent.resolve();
    await settleMain();
    expect(f.get('connection-mode').disabled).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(f.calls('update_reserve')).toHaveLength(1);
    expect(f.calls('update_install')).toHaveLength(1);
    expect(f.calls('control_bot')).toEqual([]);
  });

  it('does not publish an old Stop receipt into a replacement offline UI', async () => {
    const f = await fixture(),
      sent = pendingNative();
    await publishStatus(readyStatus());
    ipc.invoke.mockImplementation((command: string, args?: { action: string }) =>
      command === 'control_bot' && args?.action === 'stop'
        ? sent.promise
        : Promise.resolve(undefined),
    );
    await f.get('stop').emit('click');
    void sent.promise.then(closeGame);
    sent.resolve();
    await settleMain();
    expect(f.get('notice').textContent).toBe(
      'Disconnected. Select an account and character to connect again.',
    );
    expect(f.get('connection-mode').disabled).toBe(false);
  });
});

const closeToken = '11111111-1111-4111-8111-111111111111';
async function requestClose(token = closeToken): Promise<void> {
  const listener = ipc.listen.mock.calls.find((call) => call[0] === 'settings-close-request');
  expect(listener).toBeDefined();
  listener![1]({ payload: { token } });
  for (let i = 0; i < 50; i++) await Promise.resolve();
}
it('saves an immediate settings edit before acknowledging native Close, then restores it on reopen', async () => {
  const f = await fixture();
  f.get('radius').value = '17';
  await f.main.emit('input', f.get('radius'));
  expect(f.calls('save_current_form')).toHaveLength(1);
  await requestClose();
  const saved = (f.calls('save_current_form').at(-1)![1] as { document: unknown }).document;
  expect(saved).toMatchObject({ settings: { radius: 17 } });
  expect(f.calls('settings_close_complete')).toEqual([
    ['settings_close_complete', { token: closeToken, revision: 2 }],
  ]);
  await requestClose();
  expect(f.calls('settings_close_complete')).toHaveLength(1);
  const commandOrder = ipc.invoke.mock.calls.map((c) => c[0]);
  expect(commandOrder.indexOf('settings_close_complete')).toBeGreaterThan(
    commandOrder.lastIndexOf('save_current_form'),
  );
  const reopened = await fixture(null, false, saved);
  expect(reopened.get('radius').value).toBe('17');
  expect(reopened.calls('control_bot')).toEqual([]);
});

it('waits for an in-flight save, reflushes a late edit, and deduplicates Close while fencing the updater', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  const writing = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'save_current_form') {
        if (first) {
          first = false;
          await writing;
        }
        return args!.document.revision;
      }
      if (command === 'update_status')
        return { version: '0.2.27', platform: 'macos', phase: 'waiting', message: 'Update ready' };
    },
  );
  f.get('radius').value = '17';
  await f.main.emit('input', f.get('radius'));
  await vi.advanceTimersByTimeAsync(300);
  await requestClose();
  await requestClose();
  expect(f.root).toHaveProperty('inert', true);
  expect(f.get('radius').disabled).toBe(true);
  expect(f.calls('settings_close_complete')).toEqual([]);
  // An edit already dispatched at the locking boundary must still be retained.
  f.get('radius').value = '18';
  await f.main.emit('input', f.get('radius'));
  await vi.advanceTimersByTimeAsync(15_000);
  expect(f.calls('update_reserve')).toEqual([]);
  release();
  for (let i = 0; i < 80; i++) await Promise.resolve();
  expect(f.calls('save_current_form').at(-1)![1]).toMatchObject({
    document: { settings: { radius: 18 } },
  });
  expect(f.calls('settings_close_complete')).toEqual([
    ['settings_close_complete', { token: closeToken, revision: 3 }],
  ]);
  expect(f.root).toHaveProperty('inert', true);
});

it('registers before startup restoration and keeps its settings, profile and targets through Close/reopen', async () => {
  const { DEFAULT_SETTINGS } = await import('../settings/settings');
  let release: (value: unknown) => void = () => {};
  const saved = {
    version: 1,
    revision: 12,
    selectedProfileId: 'profile_one',
    settings: {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      radius: 17,
      loot: false,
      route_randomWalk: 2,
      route_step: 7,
      route_avoidWalls: false,
      route_randomWalk_maxRouteTime: 120,
      attackRouteMaxPathDistance: 25,
      attackMaxRouteTime: 5,
    },
  };
  const f = await fixture(
    null,
    false,
    new Promise((resolve) => {
      release = resolve;
    }),
  );
  expect(ipc.invoke.mock.calls.findIndex((c) => c[0] === 'settings_close_ready')).toBeLessThan(
    ipc.invoke.mock.calls.findIndex((c) => c[0] === 'current_form'),
  );
  await requestClose();
  expect(f.calls('save_current_form')).toEqual([]);
  expect(f.calls('settings_close_complete')).toEqual([]);
  release(saved);
  for (let i = 0; i < 80; i++) await Promise.resolve();
  const document = (f.calls('save_current_form').at(-1)![1] as { document: unknown }).document;
  expect(document).toMatchObject({
    selectedProfileId: saved.selectedProfileId,
    settings: saved.settings,
  });
  expect(f.calls('settings_close_complete')).toHaveLength(1);
  const reopened = await fixture(null, false, document);
  for (const [id, value] of Object.entries({
    radius: '17',
    'random-walk': '2',
    'route-step': '7',
    'route-time': '120',
    'attack-distance': '25',
    'attack-time': '5',
  }))
    expect(reopened.get(id).value).toBe(value);
  expect(reopened.get('loot').checked).toBe(false);
  expect(reopened.get('avoid-walls').checked).toBe(false);
  expect(reopened.calls('save_current_form')[0]![1]).toMatchObject({
    document: { selectedProfileId: saved.selectedProfileId, settings: saved.settings },
  });
  expect(reopened.calls('control_bot')).toEqual([]);
});

it('lets Close wait for updater preflight and stops it before reserving an install lease', async () => {
  const f = await fixture();
  let release: () => void = () => {};
  let first = true;
  const saving = new Promise<void>((resolve) => {
    release = resolve;
  });
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'update_status')
        return { version: '0.2.27', platform: 'macos', phase: 'waiting', message: 'Update ready' };
      if (command === 'save_current_form') {
        if (first) {
          first = false;
          await saving;
        }
        return args!.document.revision;
      }
    },
  );
  await vi.advanceTimersByTimeAsync(15_000);
  await requestClose();
  expect(f.calls('settings_close_complete')).toEqual([]);
  release();
  for (let i = 0; i < 80; i++) await Promise.resolve();
  expect(f.calls('update_reserve')).toEqual([]);
  expect(f.calls('update_install')).toEqual([]);
  expect(f.calls('settings_close_cancel')).toEqual([]);
  expect(f.calls('settings_close_complete')).toHaveLength(1);
});

it('retries failed startup restoration on Close after storage recovers while retaining subsequent edits', async () => {
  const { DEFAULT_SETTINGS } = await import('../settings/settings');
  let fail: (reason: unknown) => void = () => {};
  const f = await fixture(
    null,
    false,
    new Promise((_resolve, reject) => {
      fail = reject;
    }),
  );
  fail(new Error('Synthetic read failure'));
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(f.calls('save_current_form')).toEqual([]);
  f.get('radius').value = '18';
  await f.main.emit('input', f.get('radius'));
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'current_form')
        return {
          version: 1,
          revision: 12,
          selectedProfileId: null,
          settings: { ...DEFAULT_SETTINGS, radius: 13 },
        };
      if (command === 'save_current_form') return args!.document.revision;
    },
  );
  await requestClose();
  expect(f.get('radius').value).toBe('18');
  expect(f.calls('current_form')).toHaveLength(2);
  expect(f.calls('save_current_form').at(-1)![1]).toMatchObject({
    document: { settings: { radius: 18 } },
  });
  expect(f.calls('settings_close_complete')).toEqual([
    ['settings_close_complete', { token: closeToken, revision: 13 }],
  ]);
});

it('cancels Close after an invalid draft or failed save, unlocks editing, and permits a corrected retry', async () => {
  const f = await fixture();
  f.get('radius').value = '99';
  await f.main.emit('input', f.get('radius'));
  await requestClose();
  expect(f.calls('save_current_form')).toHaveLength(1);
  expect(f.calls('settings_close_complete')).toEqual([]);
  expect(f.calls('settings_close_cancel')).toHaveLength(1);
  expect(f.root).toHaveProperty('inert', false);
  expect(f.get('radius').disabled).toBe(false);
  expect(f.get('update-status').textContent).toContain('Close cancelled');
  expect(f.get('notice').textContent).toContain('Close cancelled');
  const publish = ipc.listen.mock.calls.find((call) => call[0] === 'game-status')![1];
  publish({ payload: new BotEngine(() => {}).snapshot() });
  expect(f.get('notice').textContent).toContain('Close cancelled');
  f.get('radius').value = '18';
  await f.main.emit('input', f.get('radius'));
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'save_current_form') throw new Error('Synthetic write failure');
      return args?.document?.revision;
    },
  );
  await requestClose();
  expect(f.calls('settings_close_complete')).toEqual([]);
  expect(f.calls('settings_close_cancel')).toHaveLength(2);
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) =>
      command === 'save_current_form' ? args!.document.revision : undefined,
  );
  const retryToken = '22222222-2222-4222-8222-222222222222';
  await requestClose(retryToken);
  expect(f.calls('settings_close_complete')).toEqual([
    ['settings_close_complete', { token: retryToken, revision: 2 }],
  ]);
});

describe('native local-login form and metadata', () => {
  it('starts session-only and discloses unencrypted local storage without accessing frontend persistence', async () => {
    const f = await fixture();
    expect(f.root.markup).toContain('Save login on this computer');
    expect(f.root.markup).toContain('local file with user-only access');
    expect(f.root.markup).toContain('The app does not encrypt them.');
    expect(f.root.markup).not.toContain('Keychain');
    expect(f.get('remember-login').checked).toBe(false);
    expect(f.get('auto-login').checked).toBe(false);
    expect(f.get('auto-login').disabled).toBe(true);
    expect(f.calls('login_game')).toHaveLength(0);
    f.get('username').value = 'synthetic-user';
    f.get('password').value = 'synthetic-only-password';
    f.get('character-slot').value = '2';
    await f.get('signin-form').emit('submit');
    expect(f.calls('login_game')).toEqual([
      [
        'login_game',
        {
          request: {
            credentials: {
              username: 'synthetic-user',
              password: 'synthetic-only-password',
              characterSlot: 2,
            },
            characterSlot: 2,
            remember: false,
            autoLogin: false,
            mode: 'botOnly',
          },
        },
      ],
    ]);
    expect(f.get('password').value).toBe('');
    expect(f.get('saved-account').textContent).toBe('Session only');
  });
  it('requires explicit remember opt-in and clears automatic launch preference on uncheck', async () => {
    const f = await fixture();
    f.get('remember-login').checked = true;
    await f.get('remember-login').emit('change');
    expect(f.get('auto-login').disabled).toBe(false);
    f.get('auto-login').checked = true;
    f.get('remember-login').checked = false;
    await f.get('remember-login').emit('change');
    expect(f.get('auto-login').checked).toBe(false);
    expect(f.get('auto-login').disabled).toBe(true);
  });
  it('restores only metadata and saved slot, with password reused natively on explicit sign-in', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: false });
    expect(f.get('username').value).toBe('synthetic-user');
    expect(f.get('character-slot').value).toBe('2');
    expect(f.get('password').value).toBe('');
    expect(f.calls('login_game')).toHaveLength(0);
    f.get('character-slot').value = '1';
    await f.get('signin-form').emit('submit');
    expect(f.calls('login_game')).toEqual([
      [
        'login_game',
        {
          request: {
            credentials: null,
            characterSlot: 1,
            remember: true,
            autoLogin: false,
            mode: 'gameClient',
          },
        },
      ],
    ]);
  });
  it('auto-login uses native reuse and the saved slot without returning a password to the form', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: true });
    expect(f.calls('login_game')).toEqual([
      [
        'login_game',
        {
          request: {
            credentials: null,
            characterSlot: 2,
            remember: true,
            autoLogin: true,
            mode: 'gameClient',
          },
        },
      ],
    ]);
    expect(f.get('password').value).toBe('');
  });
  it('Forget deletes the local profile and clears launch preference, including after unreadable metadata', async () => {
    for (const readFails of [false, true]) {
      const f = await fixture(
        readFails ? null : { username: 'synthetic-user', characterSlot: 1, autoLogin: false },
        readFails,
      );
      expect(f.get('forget-login').hidden).toBe(false);
      await f.get('forget-login').emit('click');
      expect(f.calls('forget_login')).toHaveLength(1);
      expect(f.get('forget-login').hidden).toBe(true);
      expect(f.get('remember-login').checked).toBe(false);
      expect(f.get('auto-login').checked).toBe(false);
      expect(f.get('notice').textContent).toBe(
        'Local saved login and app-open sign-in preference removed.',
      );
      expect(f.get('password').value).toBe('');
    }
  });
});

describe('current form before app-open login', () => {
  it('restores native current settings and logical targets before optional sign-in without starting the bot', async () => {
    const { DEFAULT_SETTINGS } = await import('../settings/settings');
    const document = {
      version: 1,
      revision: 12,
      selectedProfileId: 'profile_one',
      settings: { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], radius: 17 },
    };
    const f = await fixture(
      { username: 'synthetic-user', characterSlot: 2, autoLogin: true },
      false,
      document,
    );
    expect(f.get('radius').value).toBe('17');
    expect(f.calls('control_bot')).toEqual([]);
    const save = f.calls('save_current_form')[0]![1] as {
      document: {
        settings: { map: string; targets: number[]; radius: number };
        selectedProfileId: string;
      };
    };
    expect(save.document.settings).toMatchObject({
      map: 'prt_fild08',
      targets: [4000],
      radius: 17,
    });
    expect(save.document.selectedProfileId).toBe('profile_one');
    expect(ipc.invoke.mock.calls.findIndex((c) => c[0] === 'save_current_form')).toBeLessThan(
      ipc.invoke.mock.calls.findIndex((c) => c[0] === 'login_game'),
    );
    expect(JSON.stringify(save)).not.toMatch(/password|username|running|runRequested/);
  });
});

it('recovers continuous saves when an edit during delayed restore is invalid then corrected', async () => {
  const { DEFAULT_SETTINGS } = await import('../settings/settings');
  let release: (v: unknown) => void = () => {};
  const delayed = new Promise((r) => {
    release = r;
  });
  const f = await fixture(null, false, delayed);
  f.get('radius').value = '99';
  await f.main.emit('input', f.get('radius'));
  release({ version: 1, revision: 12, selectedProfileId: null, settings: DEFAULT_SETTINGS });
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(f.get('radius').value).toBe('99');
  expect(f.calls('save_current_form')).toEqual([]);
  f.get('radius').value = '12';
  await f.main.emit('input', f.get('radius'));
  await vi.advanceTimersByTimeAsync(1000);
  expect(f.calls('save_current_form')).toHaveLength(1);
});

describe('unsent account draft update fence', () => {
  it.each([
    'password',
    'username',
    'character-slot',
    'connection-mode',
    'remember-login',
    'auto-login',
  ])('defers installation for %s, then permits it after restoring the baseline', async (id) => {
    const f = await fixture();
    const input = f.get(id),
      beforeValue = input.value,
      beforeChecked = input.checked;
    if (id.endsWith('-login')) input.checked = true;
    else input.value = id === 'character-slot' ? '1' : 'synthetic-unsent';
    ipc.invoke.mockImplementation(
      async (command: string, args?: { document: { revision: number } }) => {
        if (command === 'update_status')
          return {
            version: '0.2.27',
            platform: 'macos',
            phase: 'waiting',
            message: 'Update ready',
          };
        if (command === 'save_current_form') return args!.document.revision;
        if (command === 'update_reserve') return 'a'.repeat(32);
        if (command === 'update_install') return true;
      },
    );
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.calls('update_reserve')).toHaveLength(0);
    expect(f.get('update-status').textContent).toContain('account draft');
    input.value = beforeValue;
    input.checked = beforeChecked;
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.calls('update_reserve')).toHaveLength(1);
    expect(f.calls('control_bot')).toEqual([]);
    expect(f.get('client-version').textContent).toBe('macOS · v0.2.27');
  });
});

it('opens the manual release through a fixed native command without gameplay commands', async () => {
  const f = await fixture();
  await f.get('update-download').emit('click');
  expect(f.calls('update_open_release')).toEqual([['update_open_release']]);
  expect(f.calls('control_bot')).toEqual([]);
});

it('checks immediately during an active run without pausing for the download or duplicating a pending check', async () => {
  const f = await fixture();
  await publishStatus(readyStatus());
  await f.get('select-targets').emit('click');
  await f.get('start').emit('click');
  const checking = pendingNative();
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'update_check') {
      await checking.promise;
      return {
        version: '0.2.27',
        platform: 'macos',
        phase: 'downloading',
        message: 'Downloading a signed client update in the background.',
      };
    }
  });
  expect(f.get('update-check').disabled).toBe(false);
  await f.get('update-check').emit('click');
  expect(f.get('update-check').disabled).toBe(true);
  await f.get('update-check').emit('click');
  expect(f.calls('update_check')).toEqual([['update_check']]);
  expect(f.get('stop').disabled).toBe(false);
  expect(f.calls('update_prepare')).toEqual([]);
  checking.resolve();
  await settleMain();
  expect(f.get('update-status').textContent).toBe(
    'Downloading a signed client update in the background.',
  );
  expect(f.get('update-check').disabled).toBe(false);
  expect(f.calls('update_reserve')).toEqual([]);
  expect(f.calls('update_install')).toEqual([]);
  expect(f.calls('control_bot').map((call) => (call[1] as { action: string }).action)).toEqual([
    'start',
  ]);
});

it('permits an immediate check with an account draft while deferring installation', async () => {
  const f = await fixture();
  f.get('password').value = 'synthetic-unsent';
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'update_check')
      return { version: '0.2.27', platform: 'macos', phase: 'waiting', message: 'Update ready' };
  });
  await f.get('update-check').emit('click');
  await settleMain();
  expect(f.calls('update_check')).toEqual([['update_check']]);
  expect(f.get('update-status').textContent).toContain('account draft');
  expect(f.get('password').value).toBe('synthetic-unsent');
  expect(f.calls('update_reserve')).toEqual([]);
  expect(f.calls('control_bot')).toEqual([]);
});

it('defers the actual main updater while a refine preview or retained economic owner is unsettled', async () => {
  const f = await fixture();
  ipc.featureSettled = false;
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'update_status')
        return { version: '0.2.27', platform: 'macos', phase: 'waiting', message: 'Update ready' };
      if (command === 'save_current_form') return args!.document.revision;
      if (command === 'update_reserve') return 'b'.repeat(32);
      if (command === 'update_install') return true;
    },
  );
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls('update_reserve')).toEqual([]);
  expect(f.calls('update_install')).toEqual([]);
  expect(f.get('update-status').textContent).toBe(
    'Update waits for pending game actions or previews to finish.',
  );
  ipc.featureSettled = true;
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls('update_reserve')).toHaveLength(1);
  expect(f.calls('control_bot')).toEqual([]);
});

it('defers the actual main updater for an unsaved macro and permits installation once the document is saved', async () => {
  const f = await fixture();
  ipc.macroDirty = true;
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'update_status')
        return { version: '0.2.27', platform: 'macos', phase: 'waiting', message: 'Update ready' };
      if (command === 'save_current_form') return args!.document.revision;
      if (command === 'update_reserve') return 'd'.repeat(32);
      if (command === 'update_install') return true;
    },
  );
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls('update_reserve')).toEqual([]);
  expect(f.calls('update_install')).toEqual([]);
  expect(f.get('update-status').textContent).toBe(
    'Update waits for your Script draft. Correct it and retry Save script, or Discard draft first.',
  );
  ipc.macroDirty = false;
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls('update_reserve')).toHaveLength(1);
  expect(f.calls('update_install')).toEqual([['update_install', { nonce: 'd'.repeat(32) }]]);
  expect(f.calls('control_bot')).toEqual([]);
});

describe('updater waiting diagnostics', () => {
  it.each(['periodic', 'requested'])(
    '%s update suspends an active run, keeps Stop available, and preserves intent',
    async (trigger) => {
      const f = await fixture();
      await publishStatus(readyStatus());
      await f.get('select-targets').emit('click');
      await f.get('start').emit('click');
      const installing = pendingNative();
      ipc.invoke.mockImplementation(
        async (command: string, args?: { document?: { revision: number } }) => {
          if (command === 'update_status' || command === 'update_check')
            return {
              version: '0.2.27',
              platform: 'macos',
              phase: 'waiting',
              message: 'Update ready',
            };
          if (command === 'save_current_form') return args!.document!.revision;
          if (command === 'update_reserve') return 'f'.repeat(32);
          if (command === 'update_install') return installing.promise;
        },
      );
      if (trigger === 'requested') {
        await f.get('update-check').emit('click');
        await settleMain();
      } else await vi.advanceTimersByTimeAsync(15000);
      expect(f.calls('update_prepare')).toHaveLength(1);
      expect(f.calls('update_reserve')).toEqual([]);
      expect(f.get('stop').disabled).toBe(false);
      expect(f.get('radius').disabled).toBe(true);
      const checkpoint = continuationFixture().runtime;
      const requestId = (f.calls('update_prepare')[0]![1] as { requestId: string }).requestId;
      ipc.listen.mock.calls.find((call) => call[0] === 'update-prepared')![1]({
        payload: { requestId, checkpoint },
      });
      await settleMain();
      expect(f.calls('update_reserve')).toHaveLength(1);
      expect(f.calls('update_install')).toHaveLength(1);
      const reserved = f.calls('update_reserve')[0]![1] as {
        continuation: { field: { character: string; escapeGuard: { latched: boolean } } };
      };
      expect(reserved.continuation.field).toMatchObject({
        character: 'Synthetic',
        escapeGuard: { latched: false },
      });
      await f.get('stop').emit('click');
      expect(f.calls('update_cancel').length).toBeGreaterThan(0);
      expect(
        f.calls('control_bot').some((call) => (call[1] as { action: string }).action === 'stop'),
      ).toBe(true);
      const cancelIndex = ipc.invoke.mock.calls.findIndex(
        (call) => call[0] === 'update_cancel' && (call[1] as { stop?: boolean })?.stop === true,
      );
      const stopIndex = ipc.invoke.mock.calls.findIndex(
        (call) => call[0] === 'control_bot' && (call[1] as { action: string }).action === 'stop',
      );
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(cancelIndex).toBeLessThan(stopIndex);
      installing.resolve();
      await settleMain();
      await vi.advanceTimersByTimeAsync(100);
      expect(
        f.calls('control_bot').filter((call) => (call[1] as { action: string }).action === 'start'),
      ).toHaveLength(1);
    },
  );
  it('does not auto-login when Stop wins while startup saved-account metadata is pending', async () => {
    const continuation = continuationFixture();
    let reply!: (value: SavedProfile) => void;
    const saved = new Promise<SavedProfile>((resolve) => {
      reply = resolve;
    });
    const f = await fixture(saved, false, continuation.form, continuation);
    await vi.waitFor(() => expect(f.calls('saved_login')).toHaveLength(1));
    expect(f.get('stop').disabled).toBe(false);
    await f.get('stop').emit('click');
    reply({ username: 'synthetic-user', characterSlot: 1, autoLogin: true, mode: 'botOnly' });
    await settleMain();
    expect(f.calls('login_game')).toEqual([]);
    expect(f.calls('update_restore')).toEqual([]);
  });
  it('keeps saved auto-login preferences but suppresses sign-in after Stop during committed replacement', async () => {
    const f = await fixture(
      { username: 'synthetic-user', characterSlot: 1, autoLogin: true, mode: 'botOnly' },
      false,
      null,
      null,
      true,
    );
    expect(f.get('auto-login').checked).toBe(true);
    expect(f.get('remember-login').checked).toBe(true);
    expect(f.calls('login_game')).toEqual([]);
    expect(f.calls('control_bot')).toEqual([]);
  });
  it('identifies an invalid settings form before connection preparation', async () => {
    const f = await fixture();
    f.get('radius').value = '99';
    await f.main.emit('input', f.get('radius'));
    ipc.invoke.mockImplementation(async (command: string) => {
      if (command === 'update_status')
        return {
          version: '0.2.27',
          availableVersion: '0.18.0',
          platform: 'macos',
          phase: 'waiting',
          message: 'Update ready',
        };
    });
    await vi.advanceTimersByTimeAsync(15000);
    expect(f.get('update-status').textContent).toContain(
      'Update deferred. Current settings could not be saved. Check the settings form. It will retry automatically.',
    );
    expect(f.get('update-status').textContent).toContain('to v0.18.0 (installed v0.2.27)');
    expect(f.get('update-status').textContent).toContain('Next automatic attempt');
    expect(f.calls('update_reserve')).toEqual([]);
    expect(f.calls('update_install')).toEqual([]);
  });
});

it('keeps shell navigation usable through a deferred installation without unlocking actions', async () => {
  const f = await fixture();
  let rejectInstall: ((error: Error) => void) | undefined;
  ipc.invoke.mockImplementation(
    async (command: string, args?: { document: { revision: number } }) => {
      if (command === 'update_status')
        return { version: '0.2.27', platform: 'macos', phase: 'waiting', message: 'Update ready' };
      if (command === 'save_current_form') return args!.document.revision;
      if (command === 'update_reserve') return 'c'.repeat(32);
      if (command === 'update_install')
        return new Promise((_resolve, reject) => {
          rejectInstall = reject;
        });
    },
  );
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.calls('update_install')).toHaveLength(1);
  const tabs = ['session', 'bot', 'manual', 'settings'].map((page) => f.get(`client-tab-${page}`));
  const botTabs = ['combat', 'recovery', 'travel', 'inventory', 'workflows'].map((section) =>
    f.get(`client-bot-tab-${section}`),
  );
  const consoleNavigation = [
    'console-tab-nearby',
    'console-tab-inventory',
    'console-edit-setup',
    'console-loot-settings',
    'console-item-tools',
    'open',
  ].map((id) => f.get(id));
  expect(
    [...tabs, ...botTabs, ...consoleNavigation, ...f.index()].every((button) => !button.disabled),
  ).toBe(true);
  expect(f.get('setup-back').disabled).toBe(true);
  expect(f.get('setup-next').disabled).toBe(false);
  expect(f.get('console-attention-connection').disabled).toBe(false);
  expect(f.get('start').disabled).toBe(true);
  expect(f.get('open').disabled).toBe(false);
  expect(f.get('synthetic-manual-action').disabled).toBe(true);
  expect(f.get('console-walk').disabled).toBe(true);
  expect(f.get('console-use-item').disabled).toBe(true);
  expect(f.get('disconnect').disabled).toBe(true);
  const saves = f.calls('save_current_form').length;
  await f.get('console-attention-connection').emit('click');
  expect(f.get('client-page-settings').hidden).toBe(false);
  f.get('console-item').value = '501';
  f.get('console-walk-x').value = '123';
  await f.get('console-tab-inventory').emit('click');
  expect(f.get('console-panel-inventory').hidden).toBe(false);
  await f.get('console-tab-nearby').emit('click');
  await f.get('console-edit-setup').emit('click');
  expect(f.get('client-page-bot').hidden).toBe(false);
  await f.get('open').emit('click');
  expect(f.get('client-page-settings').hidden).toBe(false);
  expect(f.get('console-item').value).toBe('501');
  expect(f.get('console-walk-x').value).toBe('123');
  await f.get('client-tab-settings').emit('click');
  expect(f.get('client-page-settings').hidden).toBe(false);
  await f.index()[0]!.emit('click');
  expect(f.get('client-page-manual').hidden).toBe(false);
  expect(f.calls('control_bot')).toEqual([]);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(f.calls('login_game')).toEqual([]);
  expect(f.calls('open_game')).toEqual([]);
  rejectInstall!(new Error('Synthetic install interruption'));
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(f.calls('update_release')).toHaveLength(1);
  expect([...tabs, ...botTabs, ...f.index()].every((button) => !button.disabled)).toBe(true);
  expect(f.get('start').disabled).toBe(true);
  expect(f.get('synthetic-manual-action').disabled).toBe(true);
});

it('retains step boundaries across status ticks and navigates attention without saving or starting', async () => {
  const f = await fixture(),
    saves = f.calls('save_current_form').length;
  expect(f.get('setup-back').disabled).toBe(true);
  await publishStatus(readyStatus());
  expect(f.get('setup-back').disabled).toBe(true);
  await f.get('console-attention-setup').emit('click');
  expect(f.get('client-page-bot').hidden).toBe(false);
  await f.get('setup-next').emit('click');
  expect(f.get('setup-back').disabled).toBe(false);
  expect(f.get('setup-step-progress').textContent).toBe('Step 2 of 5');
  await publishStatus(readyStatus());
  expect(f.get('setup-back').disabled).toBe(false);
  await f.get('setup-back').emit('click');
  expect(f.get('setup-back').disabled).toBe(true);
  await publishStatus(readyStatus());
  expect(f.get('setup-back').disabled).toBe(true);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(f.calls('control_bot')).toEqual([]);
  expect(f.calls('login_game')).toEqual([]);
  expect(f.calls('command_game')).toEqual([]);
});

it('reveals the supply owner status from attention without requesting another transaction', async () => {
  const f = await fixture(),
    saves = f.calls('save_current_form').length;
  await f.get('setup-tab-script').emit('click');
  const status = {
    ...readyStatus(),
    supply: {
      state: 'waiting',
      active: true,
      uncertain: true,
      reason: 'Waiting for resource reconciliation.',
      latched: true,
      remainingTrips: 1,
      actions: 0,
      spent: 0,
      reserved: 0,
      deadline: 0,
      nextTripAt: 0,
      goals: [],
      returnDestination: null,
    } satisfies SupplySnapshot,
  };
  await publishStatus(status);
  await f.get('console-attention-supply').emit('click');
  expect(f.get('client-page-bot').hidden).toBe(false);
  expect(f.get('setup-form').hidden).toBe(false);
  expect(f.get('client-bot-travel').hidden).toBe(false);
  expect(f.get('setup-travel-advanced').open).toBe(true);
  expect(f.get('supply-preview').tabIndex).toBe(-1);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(f.calls('control_bot')).toEqual([]);
  expect(f.calls('command_game')).toEqual([]);
  expect(f.calls('supply_game')).toEqual([]);
});

it('renders the fresh held owner before toolbar status and binds observed session readouts', async () => {
  const f = await fixture();
  const publish = ipc.listen.mock.calls.find((call) => call[0] === 'game-status')![1];
  const base = new BotEngine(() => {}).snapshot();
  const status = {
    ...base,
    sessionId: 'synthetic-session',
    login: { phase: 'idle', message: '' },
    reconnectAvailable: false,
    connected: true,
    compatible: true,
    player: {
      id: 0,
      classId: 4,
      kind: 0,
      name: 'Synthetic',
      level: 30,
      hp: 100,
      maxHp: 100,
      x: 1,
      y: 1,
      dead: false,
      statuses: [],
    },
    character: { ...base.character, stats: { sp: 75, maxSp: 200 } },
    deaths: 2,
    reason: 'Stopped by you.',
    mapInfo: { code: '', name: '', source: 'observed', monsters: [] },
    refine: {
      state: 'pending',
      blocked: true,
      reason: 'Waiting for the exact refine transaction.',
      candidates: [],
      dialogueToken: null,
      preview: null,
    },
  };
  const saves = f.calls('save_current_form').length;
  publish({ payload: status });
  expect(f.get('status').textContent).toBe('WAITING');
  expect(f.get('notice').textContent).toBe(status.refine.reason);
  expect(f.get('client-run-title').textContent).toBe('Waiting to continue');
  await f.get('console-attention-refine').emit('click');
  expect(f.get('client-page-manual').hidden).toBe(false);
  expect(f.get('sp-text').textContent).toBe('75 / 200');
  expect(f.get('sp-bar').style.width).toBe('37.5%');
  expect(f.get('death-count').textContent).toBe('2');
  await f.get('client-tab-settings').emit('click');
  expect(f.get('notice').textContent).toBe(status.refine.reason);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(f.calls('control_bot')).toEqual([]);
  publish({
    payload: {
      ...status,
      character: { ...base.character, stats: null },
      refine: { ...status.refine, state: 'idle', blocked: false },
    },
  });
  expect(f.get('status').textContent).toBe('SETUP');
  expect(f.get('sp-text').textContent).toBe('— / —');
  expect(f.get('sp-bar').style.width).toBe('0%');
});

it('Connect account opens the retained account form without creating or showing a game window', async () => {
  const f = await fixture();
  await f.get('open').emit('click');
  expect(f.get('client-page-settings').hidden).toBe(false);
  expect(f.calls('open_game')).toEqual([]);
  expect(f.calls('login_game')).toEqual([]);
  expect(f.calls('control_bot')).toEqual([]);
});

it('shows automatic time-limit completion and retains the run until explicit Stop', async () => {
  const f = await fixture();
  ipc.limitMinutes = 1;
  await publishStatus(readyStatus('limited-run'));
  await f.get('select-targets').emit('click');
  await f.get('start').emit('click');
  await vi.advanceTimersByTimeAsync(60_000);
  expect(
    f
      .calls('control_bot')
      .filter((call) => call[1]?.action === 'stop')
      .map((call) => call[1]),
  ).toEqual([{ action: 'stop', runLimit: 'minutes' }]);
  expect(f.get('status').textContent).toBe('LIMIT');
  expect(f.get('client-run-title').textContent).toBe('Run limit reached');
  expect(f.get('notice').textContent).toContain('Press Stop to end this run');
  expect(f.get('start').disabled).toBe(true);
  expect(f.get('stop').disabled).toBe(false);
  await publishStatus({
    ...readyStatus('limited-run'),
    reason: 'Configured session limit reached.',
  });
  expect(f.get('status').textContent).toBe('LIMIT');
  expect(f.get('start').disabled).toBe(true);
  await f.get('stop').emit('click');
  expect(f.calls('control_bot').at(-1)?.[1]).toEqual({ action: 'stop' });
  expect(f.get('status').textContent).toBe('READY');
  expect(f.get('start').disabled).toBe(false);
});

it.each(['disconnect', 'account-disconnect'])(
  'requires settled, fresh stopped state for %s and clears telemetry for a new login',
  async (disconnectId) => {
    const f = await fixture(),
      publish = ipc.listen.mock.calls.find((call) => call[0] === 'game-status')![1];
    const base = new BotEngine(() => {}).snapshot();
    const status = {
      ...base,
      sessionId: 'synthetic-session',
      login: { phase: 'idle', message: '' },
      reconnectAvailable: false,
      connected: true,
      compatible: true,
      player: {
        id: 0,
        classId: 4,
        kind: 0,
        name: 'Synthetic',
        level: 30,
        hp: 100,
        maxHp: 100,
        x: 1,
        y: 1,
        dead: false,
        statuses: [],
      },
      character: { ...base.character, stats: { sp: 75, maxSp: 200 } },
      mapInfo: { code: '', name: '', source: 'observed', monsters: [] },
    };
    publish({ payload: { ...status, runRequested: true } });
    expect(f.get('connection-mode').disabled).toBe(true);
    expect(f.get(disconnectId).disabled).toBe(true);
    await f.get(disconnectId).emit('click');
    expect(f.calls('close_game')).toEqual([]);
    publish({ payload: { ...status, refine: { blocked: true, reason: 'Pending receipt' } } });
    expect(f.get(disconnectId).disabled).toBe(true);
    await f.get(disconnectId).emit('click');
    expect(f.calls('close_game')).toEqual([]);
    publish({ payload: status });
    ipc.featureSettled = false;
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.get(disconnectId).disabled).toBe(true);
    ipc.featureSettled = true;
    publish({ payload: status });
    expect(f.get(disconnectId).disabled).toBe(false);
    let finish!: () => void;
    ipc.invoke.mockImplementation((command: string) =>
      command === 'close_game'
        ? new Promise<void>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(undefined),
    );
    await f.get(disconnectId).emit('click');
    expect(f.calls('close_game')).toEqual([['close_game']]);
    for (const id of ['disconnect', 'account-disconnect']) expect(f.get(id).disabled).toBe(true);
    expect(f.get('console-walk').disabled).toBe(true);
    finish();
    const closed = ipc.listen.mock.calls.find((call) => call[0] === 'game-closed')![1];
    closed({ payload: undefined });
    expect(ipc.clearMacro).toHaveBeenCalledOnce();
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(f.get('connection-mode').disabled).toBe(false);
    expect(f.get('character').textContent).toBe('No character connected');
    expect(f.get('hp-text').textContent).toBe('— / —');
    expect(f.get('console-weight').textContent).toBe('— / —');
    expect(f.get('signin').disabled).toBe(false);
    expect(f.calls('login_game')).toEqual([]);
    expect(f.get('character').title).toBe('No character connected');
    expect(f.get('location').title).toBe('Connect an account to load your character.');
  },
);

it('refreshes console locks for stale status and unsettled owners', async () => {
  const f = await fixture(),
    publish = ipc.listen.mock.calls.find((call) => call[0] === 'game-status')![1],
    base = new BotEngine(() => {}).snapshot();
  const status = {
    ...base,
    sessionId: 'synthetic-session',
    login: { phase: 'idle', message: '' },
    reconnectAvailable: false,
    connected: true,
    compatible: true,
    player: {
      id: 0,
      classId: 4,
      kind: 0,
      name: 'Synthetic',
      level: 30,
      hp: 100,
      maxHp: 100,
      x: 1,
      y: 1,
      dead: false,
      statuses: [],
    },
    character: {
      ...base.character,
      inventoryKnown: true,
      inventory: [{ itemId: 501, bagId: 501, type: 1, count: 3 }],
    },
    mapInfo: { code: '', name: '', source: 'observed', monsters: [] },
  };
  publish({ payload: status });
  f.get('console-item').value = '501';
  await f.get('console-item').emit('change');
  expect(f.get('console-use-item').disabled).toBe(false);
  await vi.advanceTimersByTimeAsync(8000);
  expect(f.get('console-use-item').disabled).toBe(true);
  expect(f.get('disconnect').disabled).toBe(true);
  expect(f.get('client-run-title').textContent).toBe('Waiting for fresh game status');
  expect(f.get('start').disabled).toBe(true);
  publish({ payload: status });
  expect(f.get('console-use-item').disabled).toBe(false);
  ipc.featureSettled = false;
  publish({ payload: status });
  expect(f.get('console-use-item').disabled).toBe(true);
  ipc.featureSettled = true;
  publish({ payload: status });
  expect(f.get('console-use-item').disabled).toBe(false);
});

it('restores explicit Bot only mode before automatic native saved-profile reuse', async () => {
  const f = await fixture({
    username: 'synthetic-user',
    characterSlot: 1,
    autoLogin: true,
    mode: 'botOnly',
  });
  expect(f.get('connection-mode').value).toBe('botOnly');
  expect(f.calls('login_game')).toEqual([
    [
      'login_game',
      {
        request: {
          credentials: null,
          characterSlot: 1,
          remember: true,
          autoLogin: true,
          mode: 'botOnly',
        },
      },
    ],
  ]);
  expect(f.get('connection-mode').disabled).toBe(true);
  expect(f.get('password').value).toBe('');
});
it('a mode draft emits no login or settings save and legacy saved profiles retain game client mode', async () => {
  const f = await fixture({ username: 'synthetic-user', characterSlot: 0, autoLogin: false });
  expect(f.get('connection-mode').value).toBe('gameClient');
  const before = f.calls('save_current_form').length;
  f.get('connection-mode').value = 'botOnly';
  await f.get('connection-mode').emit('change');
  expect(f.calls('login_game')).toEqual([]);
  expect(f.calls('save_current_form')).toHaveLength(before);
  await f.get('signin-form').emit('submit');
  expect(f.calls('login_game')[0]?.[1]).toMatchObject({ request: { mode: 'botOnly' } });
  expect(f.get('connection-mode').disabled).toBe(true);
});

it('uses the applied script and its compiled settings through the global Start owner', async () => {
  const f = await fixture();
  await publishStatus(readyStatus('script-start'));
  const { macroExample } = await import('../automation/macro-ui');
  const script = macroExample('leveling', { map: 'prt_fild07', targets: [4012] });
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    map: 'prt_fild07',
    targets: [4012],
    radius: 17,
  };
  ipc.setupScript = script;
  ipc.setupSettings = settings;
  await f.get('start').emit('click');
  await settleMain();
  const request = f.calls('control_bot').find((call) => call[1]?.action === 'macro')?.[1]?.request;
  expect(request).toEqual({ script, settings });
  expect(f.calls('control_bot').some((call) => call[1]?.action === 'start')).toBe(false);
});

it('keeps a settings-only setup on the existing projected field Start path', async () => {
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    map: 'prt_fild08',
    targets: [4000, 4007],
    radius: 17,
  };
  const f = await fixture(null, false, {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings,
  });
  const status = readyStatus('plain-start');
  status.player!.level = 1;
  await publishStatus(status);
  await f.get('start').emit('click');
  await settleMain();
  const request = f.calls('control_bot').find((call) => call[1]?.action === 'start')?.[1];
  expect(request?.settings).toMatchObject({ map: 'prt_fild08', targets: [4000], radius: 17 });
  expect(f.calls('control_bot').some((call) => call[1]?.action === 'macro')).toBe(false);
});

it.each(['botOnly', 'gameClient'] as const)(
  'starts the retained field from another map in %s mode and describes its selected targets',
  async (mode) => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      map: 'prt_fild07',
      targets: [4005, 4006],
    };
    const f = await fixture(null, false, {
      version: 1,
      revision: 2,
      selectedProfileId: null,
      settings,
    });
    await publishStatus({ ...readyStatus('cross-map-start'), connectionMode: mode });
    expect(f.get('status').textContent).toBe('READY');
    expect(f.get('start').disabled).toBe(false);
    expect(f.get('console-setup-summary').textContent).toContain('prt_fild07');
    expect(f.get('console-setup-summary').textContent).not.toContain('No targets selected');
    await f.get('start').emit('click');
    expect(
      f.calls('control_bot').find((call) => call[1]?.action === 'start')?.[1]?.settings,
    ).toMatchObject({ map: 'prt_fild07', targets: [4005, 4006] });
  },
);

it('describes the explicit travel destination while retaining the configured target field', async () => {
  const f = await fixture(null, false, {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings: { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild07', targets: [4005] },
  });
  ipc.travelDestination = 'prt_fild06';
  await publishStatus(readyStatus('explicit-destination'));
  expect(f.get('console-setup-summary').textContent).toContain('Travel to prt_fild06');
  await f.get('start').emit('click');
  expect(
    f.calls('control_bot').find((call) => call[1]?.action === 'start')?.[1]?.settings,
  ).toMatchObject({
    map: 'prt_fild07',
    targets: [4005],
    automation: { travel: { destinationMap: 'prt_fild06' } },
  });
});

it('keeps party leader destination ownership out of the ordinary initial-trip hint', async () => {
  const f = await fixture(null, false, {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings: { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild07', targets: [4005] },
  });
  ipc.partyFollow = true;
  await publishStatus(readyStatus('party-destination'));
  expect(f.get('start').disabled).toBe(false);
  expect(f.get('console-setup-summary').textContent).not.toContain('Travel to');
  await f.get('start').emit('click');
  expect(
    f.calls('control_bot').find((call) => call[1]?.action === 'start')?.[1]?.settings,
  ).toMatchObject({
    map: 'prt_fild07',
    targets: [4005],
    automation: { follow: { mode: 'partyLeader' } },
  });
});

it('preserves retained field choices until an explicit current-field target edit', async () => {
  const saved = {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings: { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild07', targets: [4005, 4006] },
  };
  const before = structuredClone(saved),
    f = await fixture(null, false, saved);
  await publishStatus(readyStatus('different-field'));
  expect(f.get('status').textContent).toBe('READY');
  expect(f.get('start').disabled).toBe(false);
  expect(f.get('console-setup-summary').textContent).toContain('prt_fild07');
  expect(f.get('console-saved-draft-summary').hidden).toBe(true);
  const saves = f.calls('save_current_form').length;
  await f.get('client-bot-tab-recovery').emit('click');
  await f.get('client-tab-session').emit('click');
  await f.get('console-edit-setup').emit('click');
  expect(f.get('client-page-bot').hidden).toBe(false);
  expect(f.get('client-bot-recovery').hidden).toBe(false);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(saved).toEqual(before);
  expect(f.calls('control_bot')).toEqual([]);
  await f.get('client-bot-tab-combat').emit('click');
  await f.get('select-targets').emit('click');
  expect(f.get('status').textContent).toBe('READY');
  expect(f.get('start').disabled).toBe(false);
  expect(f.get('console-setup-summary').textContent).toContain('Synthetic monster');
  expect(f.get('console-saved-draft-summary').hidden).toBe(true);
  await f.get('start').emit('click');
  expect(
    f.calls('control_bot').find((call) => call[1]?.action === 'start')?.[1]?.settings,
  ).toMatchObject({ map: 'prt_fild08', targets: [4000] });
});

it('never sends a Start request while a Script draft is unapplied', async () => {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [4000] };
  const f = await fixture(null, false, {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings,
  });
  await publishStatus(readyStatus('draft-start'));
  ipc.macroDirty = true;
  await f.get('start').emit('click');
  await settleMain();
  expect(f.calls('control_bot').some((call) => ['start', 'macro'].includes(call[1]?.action))).toBe(
    false,
  );
});

it('restores native retained settings during an invalid Script draft without overwriting its text or touching native CurrentForm', async () => {
  let restore!: (value: unknown) => void;
  const pending = new Promise<unknown>((resolve) => {
    restore = resolve;
  });
  const f = await fixture(null, false, pending, null, false, true);
  const source = f.get('macro-document');
  source.value = source.value.replace('set radius = 12', 'set radius = 14') + '\nrule "Incomplete"';
  await source.emit('input');
  const manual = source.value;
  const settings = {
    ...structuredClone(DEFAULT_SETTINGS),
    map: 'prt_fild08',
    targets: [4000],
    radius: 18,
  };
  restore({ version: 1, revision: 4, selectedProfileId: null, settings });
  await settleMain();
  expect(source.value).toBe(manual);
  expect(f.get('radius').value).toBe('18');
  expect(f.calls('save_current_form').at(-1)?.[1]?.document.settings.radius).toBe(18);
  expect(ipc.editor?.dirty).toBe(true);
  expect(f.get('radius').disabled).toBe(true);
  const root = ipc.editor!.root as unknown as Element;
  const discard = root.children
    .flatMap((node) => node.children)
    .find((node) => node.textContent === 'Discard draft')!;
  await discard.emit('click');
  await settleMain();
  expect(f.get('macro-document').value).toContain('set radius = 18');
  expect(ipc.editor?.dirty).toBe(false);
});

it('synchronizes valid Script edits offline through reentrant Main and saves without any game commands or implicit Start', async () => {
  const f = await fixture(null, false, null, null, false, true);
  const source = f.get('macro-document');
  source.value =
    '# my field\nscript "Poring"\nset map = prt_fild08\nset targets = [4000]\nset radius = 17';
  await source.emit('input');
  await settleMain();
  await vi.advanceTimersByTimeAsync(350);
  expect(f.get('radius').value).toBe('17');
  expect(ipc.editor?.configured().settings).toMatchObject({
    map: 'prt_fild08',
    targets: [4000],
    radius: 17,
  });
  expect(source.value).toContain('# my field');
  expect(f.calls('control_bot')).toHaveLength(0);
  expect(f.calls('login_game')).toHaveLength(0);
  expect(f.calls('save_current_form').at(-1)?.[1]?.document.settings).toMatchObject({
    map: 'prt_fild08',
    targets: [4000],
    radius: 17,
  });
  expect(ipc.editor?.configured().settings).toEqual(
    f.calls('save_current_form').at(-1)?.[1]?.document.settings,
  );
  expect(ipc.editor?.unsaved).toBe(false);
  f.get('radius').value = '19';
  await f.main.emit('input', f.get('radius'));
  expect(source.value).toContain('set radius = 19');
  expect(source.value).toContain('# my field');
  expect(ipc.editor?.configured().settings.radius).toBe(19);
});

it('lets valid Script settings edits win over delayed native restore without overwriting comments or rules', async () => {
  let restore!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    restore = resolve;
  });
  const f = await fixture(null, false, pending, null, false, true),
    source = f.get('macro-document');
  source.value =
    '# edited before restore\nscript "Poring"\nset map = prt_fild08\nset targets = [4000]\nset radius = 17';
  await source.emit('input');
  restore({
    version: 1,
    revision: 4,
    selectedProfileId: null,
    settings: { ...structuredClone(DEFAULT_SETTINGS), radius: 18 },
  });
  await settleMain();
  await vi.advanceTimersByTimeAsync(350);
  expect(f.get('radius').value).toBe('17');
  expect(source.value).toContain('# edited before restore');
  expect(ipc.editor?.dirty).toBe(false);
  expect(f.calls('save_current_form').at(-1)?.[1]?.document.settings.radius).toBe(17);
  expect(f.calls('control_bot')).toHaveLength(0);
});

it('rebases a valid partial Script onto normalized Form defaults and the observed field before global Start', async () => {
  const f = await fixture(null, false, null, null, false, true);
  await publishStatus(readyStatus('partial-script'));
  const source = f.get('macro-document');
  source.value =
    'script "Potion"\nrule "Potion"\nwhen hpPercent < 60\nuse item 501 timeout 30s\nend';
  await source.emit('input');
  await vi.advanceTimersByTimeAsync(350);
  expect(ipc.editor?.configured().settings).toEqual(
    f.calls('save_current_form').at(-1)?.[1]?.document.settings,
  );
  expect(ipc.editor?.configured().settings.map).toBe('prt_fild08');
  expect(source.value).toContain('set map = "prt_fild08"');
  expect(f.get('start').disabled).toBe(false);
  expect(f.calls('control_bot')).toHaveLength(0);
  await f.get('start').emit('click');
  await settleMain();
  expect(
    f.calls('control_bot').find((call) => call[1]?.action === 'macro')?.[1]?.request.settings.map,
  ).toBe('prt_fild08');
});

it('recovers a newly saved sparse Script whose normalized Form settings exceed the source limit', async () => {
  const f = await fixture(null, false, null, null, false, true);
  await publishStatus(readyStatus('oversized-normalization'));
  const { BOT_SCRIPT_LIMITS } = await import('../settings/bot-script'),
    source = f.get('macro-document');
  const small =
    'script "Potion"\nrule "Potion"\nwhen hpPercent < 60\nuse item 501 timeout 30s\nend';
  source.value = small + '\n#' + 'x'.repeat(BOT_SCRIPT_LIMITS.authoringBytes - small.length - 102);
  await source.emit('input');
  expect(() => ipc.editor?.configured()).toThrow(/too large/);
  expect(f.get('start').disabled).toBe(true);
  expect(f.calls('control_bot')).toHaveLength(0);
  source.value = small;
  await source.emit('input');
  expect(ipc.editor?.configured().settings.map).toBe('prt_fild08');
  expect(ipc.editor?.unsaved).toBe(false);
  expect(f.get('start').disabled).toBe(false);
  expect(f.calls('control_bot')).toHaveLength(0);
});

it('preserves the selected profile and native revision for comment and rule-only Script edits', async () => {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [4000] };
  const f = await fixture(
    null,
    false,
    { version: 1, revision: 4, selectedProfileId: 'retained-profile', settings },
    null,
    false,
    true,
  );
  const source = f.get('macro-document'),
    saves = f.calls('save_current_form').length;
  source.value += '\n# my note';
  await source.emit('input');
  await vi.advanceTimersByTimeAsync(350);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(ipc.editor?.unsaved).toBe(false);
  const { formatBotScript } = await import('../settings/bot-script'),
    { macroExample } = await import('../automation/macro-ui');
  source.value = formatBotScript({
    settings: ipc.editor!.configured().settings,
    script: macroExample('item'),
  });
  await source.emit('input');
  await vi.advanceTimersByTimeAsync(350);
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(ipc.editor?.configured().script?.rules).toHaveLength(1);
  await requestClose();
  expect(f.calls('save_current_form').at(-1)?.[1]?.document.selectedProfileId).toBe(
    'retained-profile',
  );
  expect(f.calls('control_bot')).toHaveLength(0);
});

it('cancels Close for an invalid Script draft and permits Close after explicit Discard', async () => {
  const f = await fixture(null, false, null, null, false, true);
  const source = f.get('macro-document');
  source.value += '\nrule "Still editing"';
  await source.emit('input');
  const before = source.value;
  await requestClose();
  expect(f.calls('settings_close_complete')).toEqual([]);
  expect(f.calls('settings_close_cancel')).toEqual([
    ['settings_close_cancel', { token: closeToken }],
  ]);
  expect(f.root).toHaveProperty('inert', false);
  expect(source.value).toBe(before);
  expect(f.get('setup-tab-form').disabled).toBe(false);
  expect(f.get('setup-tab-script').disabled).toBe(false);
  expect(f.get('notice').textContent).toContain('Save script');
  const root = ipc.editor!.root as unknown as Element;
  const discard = root.children
    .flatMap((node) => node.children)
    .find((node) => node.textContent === 'Discard draft')!;
  await discard.emit('click');
  await requestClose();
  expect(f.calls('settings_close_complete')).toHaveLength(1);
});

it('keeps failed script saves from Close and discards only unsaved rules while retaining native-applied settings', async () => {
  const f = await fixture(null, false, null, null, false, true);
  ipc.scriptStorageFails = true;
  const source = f.get('macro-document');
  source.value =
    'script "Potion"\nset map = prt_fild08\nset targets = [4000]\nset radius = 17\nrule "Potion"\nwhen hpPercent < 60\nuse item 501 timeout 30s\nend';
  await source.emit('input');
  const root = ipc.editor!.root as unknown as Element;
  const button = (label: string) =>
    root.children.flatMap((node) => node.children).find((node) => node.textContent === label)!;
  await button('Save script').emit('click');
  expect(ipc.editor?.unsaved).toBe(true);
  expect(f.get('radius').value).toBe('17');
  await requestClose();
  expect(f.calls('settings_close_complete')).toHaveLength(0);
  expect(f.root).toHaveProperty('inert', false);
  const copy = source.value;
  expect(copy).toContain('rule "Potion"');
  source.value += '\nrule "another edit after failed Save"';
  await source.emit('input');
  expect(ipc.editor?.dirty).toBe(true);
  await button('Discard draft').emit('click');
  expect(ipc.editor?.unsaved).toBe(false);
  expect(ipc.editor?.configured().script).toBeNull();
  expect(f.get('radius').value).toBe('17');
  await requestClose();
  expect(f.calls('settings_close_complete')).toHaveLength(1);
  expect(f.calls('save_current_form').at(-1)?.[1]?.document.settings.radius).toBe(17);
});

it('blocks macro Start when current Form edits are invalid instead of using older compiled settings', async () => {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [4000] };
  const f = await fixture(null, false, {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings,
  });
  const { macroExample } = await import('../automation/macro-ui');
  ipc.setupScript = macroExample('item');
  ipc.setupSettings = settings;
  await publishStatus(readyStatus('invalid-script-settings'));
  expect(f.get('start').disabled).toBe(false);
  f.get('radius').value = '';
  await f.main.emit('input', f.get('radius'));
  expect(f.get('start').disabled).toBe(true);
  expect(f.get('config-help').textContent).toContain('Invalid settings');
  await f.get('start').emit('click');
  expect(f.calls('control_bot').some((call) => ['start', 'macro'].includes(call[1]?.action))).toBe(
    false,
  );
});

it('keeps item/skill macro Start available without collision data while ordinary field Start remains disabled', async () => {
  const settings = { ...structuredClone(DEFAULT_SETTINGS), map: 'unknown', targets: [] };
  const f = await fixture(null, false, {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings,
  });
  const status = readyStatus('no-grid');
  status.map = 'unknown';
  status.mapInfo = { code: 'unknown', name: 'Unknown map', source: 'observed', monsters: [] };
  await publishStatus(status);
  expect(f.get('start').disabled).toBe(true);
  const { macroExample } = await import('../automation/macro-ui');
  ipc.setupScript = macroExample('item');
  ipc.setupSettings = settings;
  await publishStatus(status);
  expect(f.get('start').disabled).toBe(false);
  await f.get('start').emit('click');
  expect(
    f.calls('control_bot').find((call) => call[1]?.action === 'macro')?.[1]?.request.script,
  ).toEqual(ipc.setupScript);
});

let mcpQueryId = 0;
function mainMcpQuery(tool: string, arguments_: Record<string, unknown> = {}) {
  const id = `synthetic-mcp-${++mcpQueryId}`;
  ipc.listen.mock.calls.find((call) => call[0] === 'mcp-query')![1]({
    payload: { id, tool, arguments: arguments_, runtimeGeneration: 2 },
  });
  return id;
}
async function mainMcpResult(id: string): Promise<Record<string, unknown> | undefined> {
  await settleMain();
  return ipc.invoke.mock.calls.find((call) => call[0] === 'mcp_reply' && call[1]?.id === id)?.[1]
    ?.result;
}
async function mcpDraftRevision() {
  return (await mainMcpResult(mainMcpQuery('get_settings')))!.draftRevision as number;
}
const mcpForm = () => ({
  version: 1,
  revision: 1,
  selectedProfileId: null,
  settings: { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] },
});
async function publishMcpStatus(mode: 'botOnly' | 'gameClient' = 'botOnly') {
  await publishStatus(
    Object.assign(readyStatus(), {
      connectionMode: mode,
      mcpObservation: { generation: 2, sequence: 1, observedAt: Date.now() },
    }),
  );
}

it('local Stop retires an MCP Start awaiting native claim through the real Main bridge', async () => {
  const f = await fixture(null, false, mcpForm());
  await publishMcpStatus();
  const revision = await mcpDraftRevision(),
    claimed = pendingNative(),
    original = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation((command: string, arguments_: Record<string, unknown>) =>
    command === 'mcp_claim' ? claimed.promise : original(command, arguments_),
  );
  const id = mainMcpQuery('start_bot', {
    requestId: 'start-local-stop',
    expectedDraftRevision: revision,
    expectedGeneration: 2,
  });
  await settleMain();
  expect(f.calls('mcp_claim')).toHaveLength(1);
  await f.get('stop').emit('click');
  await settleMain();
  expect(f.calls('control_bot').map((call) => call[1]?.action)).toEqual(['stop']);
  claimed.resolve();
  expect(await mainMcpResult(id)).toMatchObject({
    error: expect.stringContaining('cancelled by Stop'),
  });
  expect(f.calls('control_bot').map((call) => call[1]?.action)).toEqual(['stop']);
});

it('blocks Main draft writes after a failed UI disable until a new control grant succeeds', async () => {
  const f = await fixture(null, false, mcpForm()),
    claimed = pendingNative(),
    original = ipc.invoke.getMockImplementation()!;
  let first = '',
    disableFails = true;
  ipc.invoke.mockImplementation((command: string, arguments_: Record<string, unknown>) => {
    if (command === 'mcp_claim' && arguments_.id === first) return claimed.promise;
    if (command === 'mcp_set_enabled') {
      if (!arguments_.enabled && disableFails)
        return Promise.reject(new Error('synthetic disable failure'));
      return Promise.resolve(
        arguments_.enabled
          ? { endpoint: 'http://127.0.0.1:123/mcp', token: 'private-fixture', control: true }
          : null,
      );
    }
    return original(command, arguments_);
  });
  f.get('mcp-control').checked = true;
  await f.get('mcp-toggle').emit('click');
  await settleMain();
  const revision = await mcpDraftRevision(),
    saves = f.calls('save_current_form').length;
  first = mainMcpQuery('set_settings', {
    requestId: 'delayed-before-disable',
    expectedDraftRevision: revision,
    settings: { ...mcpForm().settings, radius: 16 },
  });
  await settleMain();
  expect(f.calls('mcp_claim')).toHaveLength(1);
  await f.get('mcp-toggle').emit('click');
  await settleMain();
  expect(f.get('mcp-status').textContent).toContain('remain blocked');
  claimed.resolve();
  expect(await mainMcpResult(first)).toMatchObject({ error: expect.stringContaining('revoked') });
  const blocked = mainMcpQuery('set_settings', {
    requestId: 'after-failed-disable',
    expectedDraftRevision: revision,
    settings: { ...mcpForm().settings, radius: 18 },
  });
  expect(await mainMcpResult(blocked)).toMatchObject({ error: expect.stringContaining('revoked') });
  expect(f.get('radius').value).toBe(String(mcpForm().settings.radius));
  expect(f.calls('save_current_form')).toHaveLength(saves);
  expect(f.calls('control_bot')).toEqual([]);
  disableFails = false;
  await f.get('mcp-toggle').emit('click');
  await settleMain();
  await f.get('mcp-toggle').emit('click');
  await settleMain();
  const renewed = mainMcpQuery('set_settings', {
    requestId: 'new-control-grant',
    expectedDraftRevision: await mcpDraftRevision(),
    settings: { ...mcpForm().settings, radius: 16 },
  });
  expect(await mainMcpResult(renewed)).toMatchObject({ persisted: true });
  expect(f.get('radius').value).toBe('16');
  expect(f.calls('save_current_form').at(-1)?.[1]).toMatchObject({ mcpOperation: renewed });
  expect(f.calls('control_bot')).toEqual([]);
});

it.each(['botOnly', 'gameClient'] as const)(
  'dispatches MCP Start with retained destination targets from another map in %s',
  async (mode) => {
    const settings = {
      ...structuredClone(DEFAULT_SETTINGS),
      map: 'prt_fild07',
      targets: [4005, 4006],
    };
    const f = await fixture(null, false, { ...mcpForm(), settings });
    await publishMcpStatus(mode);
    const started = mainMcpQuery('start_bot', {
      requestId: 'cross-map-start',
      expectedDraftRevision: await mcpDraftRevision(),
      expectedGeneration: 2,
    });
    expect(await mainMcpResult(started)).toMatchObject({ dispatch: 'accepted' });
    expect(f.calls('control_bot')[0]?.[1]).toMatchObject({
      action: 'start',
      mcpOperation: started,
      settings: { map: 'prt_fild07', targets: [4005, 4006] },
    });
  },
);

it.each(['botOnly', 'gameClient'] as const)(
  'dispatches MCP Start and Stop through the same Main owners in %s',
  async (mode) => {
    const f = await fixture(null, false, mcpForm());
    await publishMcpStatus(mode);
    const started = mainMcpQuery('start_bot', {
      requestId: 'start',
      expectedDraftRevision: await mcpDraftRevision(),
      expectedGeneration: 2,
    });
    expect(await mainMcpResult(started)).toMatchObject({ dispatch: 'accepted' });
    expect(f.calls('control_bot')[0]?.[1]).toMatchObject({
      action: 'start',
      mcpOperation: started,
    });
    const stopped = mainMcpQuery('stop_bot', { requestId: 'stop' });
    expect(await mainMcpResult(stopped)).toMatchObject({
      dispatch: 'accepted',
      retainedRunCancelled: true,
    });
    expect(f.calls('update_cancel').at(-1)?.[1]).toMatchObject({
      stop: true,
      mcpOperation: stopped,
    });
    expect(f.calls('control_bot').at(-1)?.[1]).toMatchObject({
      action: 'stop',
      mcpOperation: stopped,
    });
  },
);

it('records a busy MCP competitor immediately after claim and protects human edits during a deferred claim', async () => {
  const f = await fixture(null, false, mcpForm());
  const revision = await mcpDraftRevision(),
    claimed = pendingNative(),
    original = ipc.invoke.getMockImplementation()!;
  let first = '';
  ipc.invoke.mockImplementation((command: string, arguments_: Record<string, unknown>) =>
    command === 'mcp_claim' && arguments_.id === first
      ? claimed.promise
      : original(command, arguments_),
  );
  first = mainMcpQuery('set_settings', {
    requestId: 'first',
    expectedDraftRevision: revision,
    settings: { ...mcpForm().settings, radius: 16 },
  });
  await settleMain();
  const competitor = mainMcpQuery('set_settings', {
    requestId: 'second',
    expectedDraftRevision: revision,
    settings: { ...mcpForm().settings, radius: 18 },
  });
  expect(await mainMcpResult(competitor)).toMatchObject({
    error: expect.stringContaining('operation is in progress'),
  });
  f.get('radius').value = '14';
  await f.main.emit('input', f.get('radius'));
  claimed.resolve();
  expect(await mainMcpResult(first)).toMatchObject({
    error: expect.stringContaining('draft changed'),
  });
  expect(f.get('radius').value).toBe('14');
});

it('saves an MCP Script through Main without starting and reports persistence failure while retaining the draft', async () => {
  const f = await fixture(null, false, mcpForm(), null, false, true);
  const revision = await mcpDraftRevision(),
    original = ipc.invoke.getMockImplementation()!;
  ipc.invoke.mockImplementation((command: string, arguments_: Record<string, unknown>) => {
    if (command === 'save_current_form' && arguments_.mcpOperation)
      return Promise.reject('synthetic persistence failure');
    return original(command, arguments_);
  });
  const id = mainMcpQuery('set_script', {
    requestId: 'script',
    expectedDraftRevision: revision,
    script: 'script "Updated"\nset radius = 16',
  });
  expect(await mainMcpResult(id)).toMatchObject({
    draftChanged: true,
    persisted: false,
    scriptPersisted: true,
  });
  expect(f.get('radius').value).toBe('16');
  expect(f.calls('control_bot')).toEqual([]);
  expect(f.calls('login_game')).toEqual([]);
  expect(f.calls('save_current_form').at(-1)?.[1]).toMatchObject({ mcpOperation: id });
});

it('keeps a human Form autosave when an MCP service collection operation succeeds', async () => {
  const f = await fixture(null, false, mcpForm());
  const saves = f.calls('save_current_form').length;
  f.get('radius').value = '14';
  await f.main.emit('input', f.get('radius'));
  const id = mainMcpQuery('service_definition', {
    requestId: 'services',
    expectedDraftRevision: await mcpDraftRevision(),
    operation: 'save',
    definition: {},
  });
  expect(await mainMcpResult(id)).toMatchObject({ persisted: true });
  await vi.advanceTimersByTimeAsync(300);
  expect(f.calls('save_current_form').length).toBeGreaterThan(saves);
  expect(f.calls('save_current_form').at(-1)?.[1]?.document.settings.radius).toBe(14);
  expect(f.calls('control_bot')).toEqual([]);
});

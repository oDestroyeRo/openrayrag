import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotConsole, mapCoordinate } from './bot-console';
import { BotEngine } from './engine';
import { ITEM_CATALOG } from './game-catalog';
import { actorKey, manualTargetView } from './manual-target-view';
import { GridNavigator, searchGrid } from './navigation';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import type { Entity } from './protocol';

class Node {
  children: Node[] = []; parent: Node | null = null; id = ''; className = ''; type = ''; disabled = false; hidden = false;
  private text = ''; private selected = ''; width = 400; height = 400;
  style = { aspectRatio: '' }; attributes = new Map<string, string>(); classes = new Set<string>();
  classList = { toggle: (name: string, value: boolean) => value ? this.classes.add(name) : this.classes.delete(name) };
  listeners = new Map<string, Array<(event: { preventDefault(): void; clientX: number; clientY: number }) => void>>();
  constructor(readonly tag: string) {}
  get textContent(): string { return this.text; }
  set textContent(value: string) { this.text = value; this.children = []; }
  get value(): string { return this.selected; }
  set value(value: string) { this.selected = this.tag === 'select' && !this.children.some(node => node.value === value) ? '' : value; }
  get childElementCount(): number { return this.children.length; }
  append(...nodes: Node[]): void { for (const node of nodes) { node.remove(); node.parent = this; this.children.push(node); } }
  replaceChildren(...nodes: Node[]): void { this.children = []; this.selected = ''; this.append(...nodes); }
  remove(): void { if (this.parent) this.parent.children = this.parent.children.filter(node => node !== this); this.parent = null; }
  all(): Node[] { return [this, ...this.children.flatMap(node => node.all())]; }
  querySelector(selector: string): Node | null { return this.all().find(node => selector.startsWith('#') ? node.id === selector.slice(1) : node.className === selector.slice(1)) ?? null; }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, listener: (event: { preventDefault(): void; clientX: number; clientY: number }) => void): void { this.listeners.set(name, [...this.listeners.get(name) ?? [], listener]); }
  getBoundingClientRect() { return { left: 50, top: 100, width: 800, height: 800 }; }
  getContext() { return { createImageData: (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) }), putImageData() {}, clearRect() {}, fillText() {}, drawImage() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {}, arc() {}, fill() {} }; }
  async emit(name: string, x = 0, y = 0): Promise<void> {
    for (const listener of this.listeners.get(name) ?? []) listener({ preventDefault() {}, clientX: x, clientY: y });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}
const grid = searchGrid('prt_fild08')!, nav = new GridNavigator(grid);
let origin = { x: 100, y: 100 };
for (let y = 100; y < 200; y++) { let found = false; for (let x = 100; x < 200; x++) if (nav.safe({ x, y }) && nav.safe({ x: x + 1, y })) { origin = { x, y }; found = true; break; } if (found) break; }
const player: Entity = { id: 0, kind: 0, classId: 4, name: 'Synthetic', level: 20, hp: 100, maxHp: 100, ...origin, dead: false };
const monster: Entity = { ...player, id: 2, kind: 1, classId: 4000, name: 'Poring', level: 1, x: origin.x + 1 };
function fixture() {
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
  const engine = new BotEngine(() => {}); engine.connect(true);
  engine.receive([{ type: 'enter', id: 0, map: 'prt_fild08' }, { type: 'spawn', entity: player }, { type: 'spawn', entity: monster }, { type: 'inventory', items: [{ itemId: 501, bagId: 501, count: 3, type: 1 }, { itemId: 610, bagId: 610, count: 2, type: 1 }], equipment: Array(10).fill(0), ammoId: -1 }]);
  const host = new Node('main');
  const ids = ['radar', 'console-walk-x', 'console-walk-y', 'console-item', 'console-use-item', 'console-walk-form', 'console-walk', 'console-action', 'console-item-info', 'console-item-result', 'console-latest-action', 'console-target-result', 'console-lock', 'console-loot-settings', 'console-item-tools', 'open', 'console-levels', 'console-weight', 'console-zeny', 'console-experience', 'console-base-experience', 'console-job-experience', 'console-stock-count', 'monster-list', 'console-drops', 'navigation-info'];
  for (const id of ids) { const node = new Node(id === 'radar' ? 'canvas' : id === 'console-item' ? 'select' : id === 'console-walk-x' || id === 'console-walk-y' ? 'input' : 'div'); node.id = id; host.append(node); }
  const command = vi.fn(async (_request: Record<string, unknown>) => {}), notify = vi.fn(), account = vi.fn(), lootSettings = vi.fn(), manualTools = vi.fn();
  const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [], automation: structuredClone(DEFAULT_AUTOMATION) };
  const view = new BotConsole(host as unknown as HTMLElement, { settings: () => settings, command, notify, account, lootSettings, manualTools });
  const render = () => view.render(engine.snapshot()); render(); view.lock(false, 'Ready');
  return { engine, host, view, command, notify, settings, render, account, lootSettings, manualTools, get: (id: string) => host.querySelector(`#${id}`)! };
}
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe('bot console map coordinates', () => {
  it('maps CSS scale, map edges and flipped Y without allowing outside clicks', () => {
    const rect = { left: 10, top: 20, width: 800, height: 400 };
    expect(mapCoordinate(10, 20, rect, 400, 200)).toEqual({ x: 0, y: 199 });
    expect(mapCoordinate(809.9, 419.9, rect, 400, 200)).toEqual({ x: 399, y: 0 });
    expect(mapCoordinate(410, 220, rect, 400, 200)).toEqual({ x: 200, y: 99 });
    for (const [x, y] of [[9, 20], [810, 20], [10, 19], [10, 420]]) expect(mapCoordinate(x!, y!, rect, 400, 200)).toBeNull();
    expect(mapCoordinate(10, 20, { ...rect, width: 0 }, 400, 200)).toBeNull();
  });
  it('sends one bounded current-world actor-zero walk for a click and preserves saved settings', async () => {
    const f = fixture(), before = structuredClone(f.settings), canvas = f.get('radar');
    const x = 50 + (origin.x + 1.5) / grid.width * 800, y = 100 + (grid.height - .5 - origin.y) / grid.height * 800;
    await canvas.emit('click', x, y);
    expect(f.command).toHaveBeenCalledOnce(); expect(f.command.mock.calls[0]![0]).toMatchObject({ type: 'manualTarget', owner: { id: 0 }, command: { type: 'walk', destination: { x: origin.x + 1, y: origin.y } } });
    expect(f.settings).toEqual(before); expect(f.get('console-action').textContent).toContain('waiting for controller observations');
  });
  it('supports keyboard coordinates and rejects blocked tiles, portals and unsupported maps before dispatch', async () => {
    const f = fixture(); let blocked: { x: number; y: number } | null = null, portal: { x: number; y: number } | null = null;
    for (let y = 0; y < grid.height && (!blocked || !portal); y++) for (let x = 0; x < grid.width && (!blocked || !portal); x++) { const state = nav.tileState({ x, y }); if (state === 'blocked') blocked ??= { x, y }; if (state === 'portal') portal ??= { x, y }; }
    expect(blocked).not.toBeNull(); expect(portal).not.toBeNull();
    for (const point of [blocked!, portal!, { x: 999, y: 0 }]) { f.get('console-walk-x').value = String(point.x); f.get('console-walk-y').value = String(point.y); await f.get('console-walk-form').emit('submit'); }
    expect(f.command).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledTimes(3);
    f.get('console-walk-x').value = String(origin.x + 1); f.get('console-walk-y').value = String(origin.y); await f.get('console-walk-form').emit('submit'); expect(f.command).toHaveBeenCalledOnce();
    f.view.render({ ...f.engine.snapshot(), map: 'unknown-map' }); await f.get('console-walk-form').emit('submit'); expect(f.command).toHaveBeenCalledOnce();
  });
  it('rejects stale observations and replaced monster lifetimes including detached old buttons', async () => {
    const f = fixture(), old = f.get('monster-list').all().find(node => node.tag === 'button')!;
    const before = f.engine.snapshot().actorObservations, key = actorKey(before.world, 2, before.actors.find(actor => actor.id === 2)!.incarnation);
    f.engine.receive([{ type: 'spawn', entity: monster }]); f.render(); await old.emit('click'); expect(f.command).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining('replaced'), true);
    expect(() => manualTargetView(f.engine.snapshot() as unknown as Record<string, unknown>, f.settings, { type: 'attack', key })).toThrow('replaced');
    const snapshot = f.engine.snapshot(); f.view.render({ ...snapshot, actorObservations: { ...snapshot.actorObservations, at: Date.now() - 16000, lastFrameAt: Date.now() - 16000 } });
    f.get('console-walk-x').value = String(origin.x); f.get('console-walk-y').value = String(origin.y); await f.get('console-walk-form').emit('submit'); expect(f.command).not.toHaveBeenCalled();
  });
  it('rejects a safe tile in a disconnected collision component rather than sending a walk', async () => {
    const f = fixture(); let destination: { x: number; y: number } | null = null;
    for (let y = 0; y < grid.height && !destination; y++) for (let x = 0; x < grid.width && !destination; x++) {
      const point = { x, y };
      if (nav.safe(point) && nav.summary(point).reachable !== nav.summary(origin).reachable && !nav.plan(origin, point)) destination = point;
    }
    expect(destination).not.toBeNull(); f.get('console-walk-x').value = String(destination!.x); f.get('console-walk-y').value = String(destination!.y);
    await f.get('console-walk-form').emit('submit'); expect(f.command).not.toHaveBeenCalled(); expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('safe walking route'), true);
  });
  it('uses field policy and current monster rules for attack without starting automation', async () => {
    const f = fixture(), attack = () => f.get('monster-list').all().find(node => node.tag === 'button')!;
    f.settings.automation.combat.levelDifference = -100; await attack().emit('click'); expect(f.command).not.toHaveBeenCalled();
    f.settings.automation.combat.levelDifference = 1; await attack().emit('click'); expect(f.command).toHaveBeenCalledOnce(); expect(f.command.mock.calls[0]![0]).toMatchObject({ type: 'manualTarget', command: { type: 'attack', target: { id: 2 } } });
    expect(f.settings.targets).toEqual([]);
  });
});

describe('bot console inventory and monitoring', () => {
  it('keeps selection, coordinate drafts and focused action nodes through telemetry; never selects a default item', () => {
    const f = fixture(), selector = f.get('console-item'), attack = f.get('monster-list').all().find(node => node.tag === 'button');
    expect(selector.value).toBe(''); selector.value = '501'; f.get('console-walk-x').value = '123'; f.render();
    expect(f.get('console-item')).toBe(selector); expect(selector.value).toBe('501'); expect(f.get('console-walk-x').value).toBe('123'); expect(f.get('monster-list').all()).toContain(attack);
    f.engine.receive([{ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 0 }]); f.render(); expect(selector.value).toBe('501'); expect(f.get('console-item-info').textContent).toContain('2 observed');
  });
  it('routes untargeted use through the existing command without attributing shared receipts', async () => {
    const f = fixture(); f.get('console-item').value = '501'; await f.get('console-item').emit('change'); await f.get('console-use-item').emit('click');
    expect(f.command).toHaveBeenCalledWith({ type: 'useItem', itemId: 501 }); expect(f.get('console-item-result').textContent).toContain('outcome unconfirmed'); expect(f.get('console-item-result').textContent).not.toContain('Confirmed');
    const s = f.engine.snapshot(); f.view.render({ ...s, actionResult: { sequence: 1, status: 'pending', reason: 'Waiting for inventory receipt.' } }); expect(f.get('console-latest-action').textContent).toContain('pending');
    f.view.render({ ...s, actionResult: { sequence: 1, status: 'failed', reason: 'Receipt timed out.' } }); expect(f.get('console-latest-action').textContent).toContain('unresolved');
    f.view.render({ ...s, actionResult: { sequence: 1, status: 'confirmed', reason: 'Observed item decrement.' } }); expect(f.get('console-latest-action').textContent).toContain('receipt confirmed'); expect(f.get('console-item-result').textContent).toContain('outcome unconfirmed');
    f.view.render({ ...s, actionResult: { sequence: 2, status: 'pending', reason: 'Another command.' } }); expect(f.get('console-item-result').textContent).not.toContain('Another command'); expect(f.get('console-latest-action').textContent).toContain('Another command');
  });
  it('never attributes a later unrelated confirmation to an item rejected before a receipt is allocated', async () => {
    const f = fixture(); f.get('console-item').value = '501'; await f.get('console-item').emit('change');
    // Native eval can resolve even when controller admission fails. No new sequence is evidence of acceptance.
    await f.get('console-use-item').emit('click');
    const snapshot = f.engine.snapshot();
    f.view.render({ ...snapshot, reason: 'Item admission rejected.' });
    f.view.render({ ...snapshot, actionResult: { sequence: 8, status: 'confirmed', reason: 'An unrelated skill receipt.' } });
    expect(f.get('console-item-result').textContent).toContain('outcome unconfirmed');
    expect(f.get('console-item-result').textContent).not.toContain('receipt confirmed');
    expect(f.get('console-latest-action').textContent).toContain('unrelated skill receipt');
  });
  it('keeps prior bounded-command telemetry separate from a newly requested walk', async () => {
    const f = fixture(), snapshot = f.engine.snapshot();
    const status = { ...snapshot, manualTarget: { ...snapshot.manualTarget, sequence: 4, state: 'complete' as const, reason: 'Old walk finished.' } };
    f.view.render(status); f.get('console-walk-x').value = String(origin.x + 1); f.get('console-walk-y').value = String(origin.y);
    await f.get('console-walk-form').emit('submit'); f.view.render(status);
    expect(f.get('console-action').textContent).toContain('Walk requested'); expect(f.get('console-target-result').textContent).toContain('Latest bounded command #4: complete');
  });
  it('blocks targeted/unknown items and unknown inventory, with explicit access to advanced tools', async () => {
    const f = fixture(); expect(ITEM_CATALOG[610]?.useType).toBe(2);
    f.get('console-item').value = '610'; await f.get('console-item').emit('change'); expect(f.get('console-use-item').disabled).toBe(true); expect(f.get('console-item-info').textContent).toContain('explicit target'); await f.get('console-use-item').emit('click'); expect(f.command).not.toHaveBeenCalled();
    f.view.render({ ...f.engine.snapshot(), character: { ...f.engine.snapshot().character, inventory: [{ itemId: 2147483647, bagId: 1, type: 1, count: 1 }] } });
    f.get('console-item').value = '2147483647'; await f.get('console-item').emit('change'); expect(f.get('console-use-item').disabled).toBe(true); expect(f.get('console-item-info').textContent).toContain('No verified direct-use action');
    f.view.render({ ...f.engine.snapshot(), character: { ...f.engine.snapshot().character, inventoryKnown: false } }); expect(f.get('console-item').disabled).toBe(true); expect(f.get('console-use-item').disabled).toBe(true);
    await f.get('console-item-tools').emit('click'); await f.get('console-loot-settings').emit('click'); await f.get('open').emit('click'); expect(f.manualTools).toHaveBeenCalledOnce(); expect(f.lootSettings).toHaveBeenCalledOnce(); expect(f.account).toHaveBeenCalledOnce(); expect(f.command).not.toHaveBeenCalled();
  });
  it('refreshes all action locks immediately and prevents a second click during an outstanding request', async () => {
    const f = fixture(); f.get('console-item').value = '501'; f.view.lock(true, 'Stop bot first.');
    await f.get('console-use-item').emit('click'); expect(f.command).not.toHaveBeenCalled(); expect(f.get('console-walk').disabled).toBe(true); expect(f.get('console-lock').textContent).toBe('Stop bot first.');
    let finish!: () => void; f.command.mockImplementation(() => new Promise<void>(resolve => { finish = resolve; })); f.view.lock(false, '');
    await f.get('console-use-item').emit('click'); await f.get('console-use-item').emit('click'); expect(f.command).toHaveBeenCalledOnce(); expect(f.get('console-walk').disabled).toBe(true);
    f.view.lock(true, 'Update in progress.'); finish(); for (let i = 0; i < 12; i++) await Promise.resolve(); expect(f.get('console-use-item').disabled).toBe(true); expect(f.get('console-lock').textContent).toBe('Update in progress.');
  });
  it('shows only observed level, weight, currency and EXP totals without fabricated percentages', () => {
    const f = fixture(), s = f.engine.snapshot();
    f.view.render({ ...s, character: { ...s.character, stats: { level: 20, hp: 100, maxHp: 100, jobLevel: 15, weight: 200, maxWeight: 1000, zeny: 42 }, experience: { baseTotal: 500, baseGained: 12, jobTotal: 200, jobGained: 7 } } });
    expect(f.get('console-levels').textContent).toBe('20 / 15'); expect(f.get('console-weight').textContent).toBe('200 / 1,000'); expect(f.get('console-zeny').textContent).toBe('42'); expect(f.get('console-experience').textContent).toBe('Base EXP 500 (+12) · Job EXP 200 (+7)');
    f.view.render(null); expect(f.get('console-weight').textContent).toBe('— / —'); expect(f.get('console-levels').textContent).toBe('— / —'); expect(f.get('console-item').disabled).toBe(true);
  });
});

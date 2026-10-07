import { afterEach, describe, expect, it, vi } from 'vitest';
import { BotConsole, mapCoordinate } from './bot-console';
import { BotEngine, type Snapshot } from '../automation/engine';
import { ITEM_CATALOG } from '../catalog/game-catalog';
import { actorKey, manualTargetView } from '../combat/manual-target-view';
import { GridNavigator, searchGrid } from '../navigation/navigation';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import type { Entity } from '../protocol/protocol';
import { consoleNpcs, consolePlayerShops, consoleInteractionAt } from './bot-console-logic';

class Node {
  children: Node[] = [];
  parent: Node | null = null;
  id = '';
  className = '';
  type = '';
  title = '';
  disabled = false;
  hidden = false;
  private text = '';
  private selected = '';
  private canvasWidth = 400;
  private canvasHeight = 400;
  get width() {
    return this.canvasWidth;
  }
  set width(value: number) {
    this.canvasWidth = value;
  }
  get height() {
    return this.canvasHeight;
  }
  set height(value: number) {
    this.canvasHeight = value;
  }
  style = { aspectRatio: '' };
  attributes = new Map<string, string>();
  classes = new Set<string>();
  classList = {
    toggle: (name: string, value: boolean) =>
      value ? this.classes.add(name) : this.classes.delete(name),
  };
  listeners = new Map<
    string,
    Array<(event: { preventDefault(): void; clientX: number; clientY: number }) => void>
  >();
  constructor(readonly tag: string) {}
  get textContent(): string {
    return this.text;
  }
  set textContent(value: string) {
    this.text = value;
    this.children = [];
  }
  get value(): string {
    return this.selected;
  }
  set value(value: string) {
    this.selected =
      this.tag === 'select' && !this.children.some((node) => node.value === value) ? '' : value;
  }
  get childElementCount(): number {
    return this.children.length;
  }
  append(...nodes: Node[]): void {
    for (const node of nodes) {
      node.remove();
      node.parent = this;
      this.children.push(node);
    }
  }
  replaceChildren(...nodes: Node[]): void {
    this.children = [];
    this.selected = '';
    this.append(...nodes);
  }
  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((node) => node !== this);
    this.parent = null;
  }
  all(): Node[] {
    return [this, ...this.children.flatMap((node) => node.all())];
  }
  querySelector(selector: string): Node | null {
    return (
      this.all().find((node) =>
        selector.startsWith('#')
          ? node.id === selector.slice(1)
          : node.className === selector.slice(1),
      ) ?? null
    );
  }
  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value);
  }
  addEventListener(
    name: string,
    listener: (event: { preventDefault(): void; clientX: number; clientY: number }) => void,
  ): void {
    this.listeners.set(name, [...(this.listeners.get(name) ?? []), listener]);
  }
  getBoundingClientRect() {
    return { left: 50, top: 100, width: 800, height: 800 };
  }
  readonly context = {
    createImageData: (width: number, height: number) => ({
      data: new Uint8ClampedArray(width * height * 4),
    }),
    putImageData: vi.fn(),
    clearRect: vi.fn(),
    fillText: vi.fn(),
    drawImage: vi.fn(),
    beginPath: vi.fn(),
    moveTo: vi.fn(),
    lineTo: vi.fn(),
    stroke: vi.fn(),
    arc: vi.fn(),
    fill: vi.fn(),
  };
  getContext() {
    return this.context;
  }
  async emit(name: string, x = 0, y = 0): Promise<void> {
    for (const listener of this.listeners.get(name) ?? [])
      listener({ preventDefault() {}, clientX: x, clientY: y });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}
const grid = searchGrid('prt_fild08')!,
  nav = new GridNavigator(grid);
let origin = { x: 100, y: 100 };
for (let y = 100; y < 200; y++) {
  let found = false;
  for (let x = 100; x < 200; x++)
    if (nav.safe({ x, y }) && nav.safe({ x: x + 1, y })) {
      origin = { x, y };
      found = true;
      break;
    }
  if (found) break;
}
const player: Entity = {
  id: 0,
  kind: 0,
  classId: 4,
  name: 'Synthetic',
  level: 20,
  hp: 100,
  maxHp: 100,
  ...origin,
  dead: false,
};
const monster: Entity = {
  ...player,
  id: 2,
  kind: 1,
  classId: 4000,
  name: 'Poring',
  level: 1,
  x: origin.x + 1,
};
function fixture() {
  vi.stubGlobal('document', { createElement: (tag: string) => new Node(tag) });
  const engine = new BotEngine(() => {});
  engine.connect(true);
  engine.receive([
    { type: 'enter', id: 0, map: 'prt_fild08' },
    { type: 'spawn', entity: { ...player } },
    { type: 'spawn', entity: { ...monster } },
    {
      type: 'inventory',
      items: [
        { itemId: 501, bagId: 501, count: 3, type: 1 },
        { itemId: 610, bagId: 610, count: 2, type: 1 },
      ],
      equipment: Array(10).fill(0),
      ammoId: -1,
    },
  ]);
  const host = new Node('main');
  const ids = [
    'radar',
    'console-walk-x',
    'console-walk-y',
    'console-item',
    'console-use-item',
    'console-walk-form',
    'console-walk',
    'console-action',
    'console-item-info',
    'console-item-result',
    'console-latest-action',
    'console-target-result',
    'console-lock',
    'console-loot-settings',
    'console-item-tools',
    'open',
    'console-levels',
    'console-weight',
    'console-zeny',
    'console-experience',
    'console-base-experience',
    'console-job-experience',
    'console-stock-count',
    'monster-list',
    'console-npcs',
    'console-player-shops',
    'console-drops',
    'navigation-info',
  ];
  for (const id of ids) {
    const node = new Node(
      id === 'radar'
        ? 'canvas'
        : id === 'console-item'
          ? 'select'
          : id === 'console-walk-x' || id === 'console-walk-y'
            ? 'input'
            : 'div',
    );
    node.id = id;
    host.append(node);
  }
  const command = vi.fn(async (_request: Record<string, unknown>) => {}),
    notify = vi.fn(),
    account = vi.fn(),
    lootSettings = vi.fn(),
    manualTools = vi.fn(),
    npcDialogue = vi.fn(),
    playerShop = vi.fn();
  const settings = {
    ...DEFAULT_SETTINGS,
    map: 'prt_fild08',
    targets: [],
    automation: structuredClone(DEFAULT_AUTOMATION),
  };
  const view = new BotConsole(host as unknown as HTMLElement, {
    settings: () => settings,
    command,
    notify,
    account,
    lootSettings,
    manualTools,
    npcDialogue,
    playerShop,
  });
  const render = () => view.render(engine.snapshot());
  render();
  view.lock(false, 'Ready');
  return {
    engine,
    host,
    view,
    command,
    notify,
    settings,
    render,
    account,
    lootSettings,
    manualTools,
    npcDialogue,
    playerShop,
    get: (id: string) => host.querySelector(`#${id}`)!,
  };
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('bot console map coordinates', () => {
  it('maps CSS scale, map edges and flipped Y without allowing outside clicks', () => {
    const rect = { left: 10, top: 20, width: 800, height: 400 };
    expect(mapCoordinate(10, 20, rect, 400, 200)).toEqual({ x: 0, y: 199 });
    expect(mapCoordinate(809.9, 419.9, rect, 400, 200)).toEqual({ x: 399, y: 0 });
    expect(mapCoordinate(410, 220, rect, 400, 200)).toEqual({ x: 200, y: 99 });
    for (const [x, y] of [
      [9, 20],
      [810, 20],
      [10, 19],
      [10, 420],
    ])
      expect(mapCoordinate(x!, y!, rect, 400, 200)).toBeNull();
    expect(mapCoordinate(10, 20, { ...rect, width: 0 }, 400, 200)).toBeNull();
  });
  it('sends one bounded current-world actor-zero walk for a click and preserves saved settings', async () => {
    const f = fixture(),
      before = structuredClone(f.settings),
      canvas = f.get('radar');
    const x = 50 + ((origin.x + 1.5) / grid.width) * 800,
      y = 100 + ((grid.height - 0.5 - origin.y) / grid.height) * 800;
    await canvas.emit('click', x, y);
    expect(f.command).toHaveBeenCalledOnce();
    expect(f.command.mock.calls[0]![0]).toMatchObject({
      type: 'manualTarget',
      owner: { id: 0 },
      command: { type: 'walk', destination: { x: origin.x + 1, y: origin.y } },
    });
    expect(f.settings).toEqual(before);
    expect(f.get('console-action').textContent).toContain('waiting for controller observations');
  });
  it('supports keyboard coordinates and rejects blocked tiles, portals and unsupported maps before dispatch', async () => {
    const f = fixture();
    let blocked: { x: number; y: number } | null = null,
      portal: { x: number; y: number } | null = null;
    for (let y = 0; y < grid.height && (!blocked || !portal); y++)
      for (let x = 0; x < grid.width && (!blocked || !portal); x++) {
        const state = nav.tileState({ x, y });
        if (state === 'blocked') blocked ??= { x, y };
        if (state === 'portal') portal ??= { x, y };
      }
    expect(blocked).not.toBeNull();
    expect(portal).not.toBeNull();
    for (const point of [blocked!, portal!, { x: 999, y: 0 }]) {
      f.get('console-walk-x').value = String(point.x);
      f.get('console-walk-y').value = String(point.y);
      await f.get('console-walk-form').emit('submit');
    }
    expect(f.command).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledTimes(3);
    f.get('console-walk-x').value = String(origin.x + 1);
    f.get('console-walk-y').value = String(origin.y);
    await f.get('console-walk-form').emit('submit');
    expect(f.command).toHaveBeenCalledOnce();
    f.view.render({ ...f.engine.snapshot(), map: 'unknown-map' });
    await f.get('console-walk-form').emit('submit');
    expect(f.command).toHaveBeenCalledOnce();
  });
  it('rejects stale observations and replaced monster lifetimes including detached old buttons', async () => {
    const f = fixture(),
      old = f
        .get('monster-list')
        .all()
        .find((node) => node.tag === 'button')!;
    const before = f.engine.snapshot().actorObservations,
      key = actorKey(before.world, 2, before.actors.find((actor) => actor.id === 2)!.incarnation);
    f.engine.receive([{ type: 'spawn', entity: monster }]);
    f.render();
    await old.emit('click');
    expect(f.command).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith(expect.stringContaining('replaced'), true);
    expect(() =>
      manualTargetView(f.engine.snapshot() as unknown as Record<string, unknown>, f.settings, {
        type: 'attack',
        key,
      }),
    ).toThrow('replaced');
    const snapshot = f.engine.snapshot();
    f.view.render({
      ...snapshot,
      actorObservations: {
        ...snapshot.actorObservations,
        at: Date.now() - 16000,
        lastFrameAt: Date.now() - 16000,
      },
    });
    f.get('console-walk-x').value = String(origin.x);
    f.get('console-walk-y').value = String(origin.y);
    await f.get('console-walk-form').emit('submit');
    expect(f.command).not.toHaveBeenCalled();
  });
  it('rejects a safe tile in a disconnected collision component rather than sending a walk', async () => {
    const f = fixture();
    let destination: { x: number; y: number } | null = null;
    for (let y = 0; y < grid.height && !destination; y++)
      for (let x = 0; x < grid.width && !destination; x++) {
        const point = { x, y };
        if (
          nav.safe(point) &&
          nav.summary(point).reachable !== nav.summary(origin).reachable &&
          !nav.plan(origin, point)
        )
          destination = point;
      }
    expect(destination).not.toBeNull();
    f.get('console-walk-x').value = String(destination!.x);
    f.get('console-walk-y').value = String(destination!.y);
    await f.get('console-walk-form').emit('submit');
    expect(f.command).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalledWith(expect.stringContaining('safe walking route'), true);
  });
  it('uses field policy and current monster rules for attack without starting automation', async () => {
    const f = fixture(),
      attack = () =>
        f
          .get('monster-list')
          .all()
          .find((node) => node.tag === 'button')!;
    f.settings.automation.combat.levelDifference = -100;
    await attack().emit('click');
    expect(f.command).not.toHaveBeenCalled();
    f.settings.automation.combat.levelDifference = 1;
    await attack().emit('click');
    expect(f.command).toHaveBeenCalledOnce();
    expect(f.command.mock.calls[0]![0]).toMatchObject({
      type: 'manualTarget',
      command: { type: 'attack', target: { id: 2 } },
    });
    expect(f.settings.targets).toEqual([]);
  });
});

describe('bot console NPC map interactions', () => {
  const npc: Entity = {
    ...player,
    id: 10,
    kind: 2,
    classId: 50,
    name: 'Map Guide',
    hp: 0,
    maxHp: 0,
    x: origin.x + 8,
    y: origin.y + 6,
  };
  const button = (f: ReturnType<typeof fixture>) =>
    f
      .get('console-npcs')
      .all()
      .find((node) => node.tag === 'button')!;
  const spawn = (f: ReturnType<typeof fixture>, entity = npc) => {
    f.engine.receive([{ type: 'spawn', entity: { ...entity } }]);
    f.render();
  };

  it('talks once from the painted marker, reveals dialogue and preserves settings and coordinate drafts', async () => {
    const f = fixture(),
      before = structuredClone(f.settings);
    spawn(f);
    f.get('console-walk-x').value = '123';
    f.get('console-walk-y').value = '234';
    const canvas = f.get('radar'),
      x = 50 + ((npc.x + 0.5) / grid.width) * 800,
      y = 100 + ((grid.height - 0.5 - npc.y) / grid.height) * 800;
    await canvas.emit('mousemove', x, y);
    expect(canvas.title).toContain('Map Guide · NPC');
    await canvas.emit('click', x, y);
    expect(f.command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'manualNpcTalk',
        map: 'prt_fild08',
        owner: expect.objectContaining({ id: 0 }),
        target: expect.objectContaining({ id: 10 }),
      }),
    );
    expect(f.npcDialogue).toHaveBeenCalledExactlyOnceWith(10);
    expect(f.settings).toEqual(before);
    expect(f.get('console-walk-x').value).toBe('123');
    expect(f.get('console-walk-y').value).toBe('234');
  });

  it.each([2, 4])('allows a zero-ID, zero-HP kind %i NPC through the Talk button', async (kind) => {
    const f = fixture();
    f.engine.receive([
      { type: 'enter', id: 1, map: 'prt_fild08' },
      { type: 'spawn', entity: { ...player, id: 1 } },
    ]);
    spawn(f, { ...npc, id: 0, kind });
    expect(button(f).hidden).toBe(false);
    await button(f).emit('click');
    expect(f.command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'manualNpcTalk',
        target: expect.objectContaining({ id: 0 }),
      }),
    );
    expect(f.npcDialogue).toHaveBeenCalledWith(0);
  });

  it('matches CSS-scaled marker centers and edges, selects the closest NPC and breaks ties by ID', () => {
    const f = fixture();
    spawn(f);
    const status = f.engine.snapshot(),
      rect = { left: 17, top: 43, width: 800, height: 200 };
    const x = rect.left + ((npc.x + 0.5) / grid.width) * rect.width,
      y = rect.top + ((grid.height - 0.5 - npc.y) / grid.height) * rect.height;
    const hit = (clientX = x, clientY = y, bounds = rect) =>
      consoleInteractionAt({
        status,
        clientX,
        clientY,
        rect: bounds,
        width: grid.width,
        height: grid.height,
      });
    expect(hit()?.id).toBe(10);
    expect(hit(x + 7.9)?.id).toBe(10);
    expect(hit(x + 8.1)).toBeNull();
    expect(hit(rect.left - 1, y)).toBeNull();
    expect(hit(x, rect.top + rect.height)).toBeNull();
    expect(hit(x, y, { ...rect, width: 0 })).toBeNull();
    expect(hit(NaN)).toBeNull();
    status.actors.push({ ...npc, id: 11, x: npc.x + 1 });
    expect(hit(x + 1.6)?.id).toBe(11);
    expect(hit(x + 1)?.id).toBe(10);
  });

  it.each([
    'replacement',
    'removed',
    'world',
    'disconnect',
    'stale',
    'noTarget',
    'noOwner',
    'dead',
  ])('rejects an old Talk button after %s', async (variant) => {
    const f = fixture();
    spawn(f);
    const old = button(f);
    if (variant === 'replacement') spawn(f);
    else if (variant === 'removed') {
      f.engine.receive([{ type: 'remove', id: npc.id, dead: false }]);
      f.render();
    } else if (variant === 'disconnect') f.view.render(null);
    else {
      const status = f.engine.snapshot();
      if (variant === 'world')
        status.actorObservations.world = '00000000-0000-0000-0000-000000000001';
      if (variant === 'stale') {
        status.actorObservations.at = Date.now() - 16000;
        status.actorObservations.lastFrameAt = Date.now() - 16000;
      }
      if (variant === 'noTarget' || variant === 'noOwner')
        status.actorObservations.actors = status.actorObservations.actors.filter(
          (actor) => actor.id !== (variant === 'noTarget' ? npc.id : 0),
        );
      if (variant === 'dead') status.actors.find((actor) => actor.id === npc.id)!.dead = true;
      f.view.render(status);
    }
    await old.emit('click');
    expect(f.command).not.toHaveBeenCalled();
    expect(f.npcDialogue).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenCalled();
  });

  it('keeps unobserved lifetimes read-only and retains list talk on a map without collision', async () => {
    const f = fixture();
    spawn(f);
    const status = f.engine.snapshot();
    status.actorObservations.actors = status.actorObservations.actors.filter(
      (actor) => actor.id !== npc.id,
    );
    f.view.render(status);
    expect(button(f).hidden).toBe(true);
    expect(
      f
        .get('console-npcs')
        .all()
        .some((node) => node.textContent.includes('Map Guide')),
    ).toBe(true);
    f.view.render({ ...f.engine.snapshot(), map: 'unmapped_field', navigation: null });
    await button(f).emit('click');
    expect(f.command).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'manualNpcTalk', map: 'unmapped_field' }),
    );
  });

  it('respects lock, pending and dispatch failure without revealing dialogue', async () => {
    const f = fixture();
    spawn(f);
    f.view.lock(true, 'Stop automation.');
    expect(button(f).disabled).toBe(true);
    await button(f).emit('click');
    expect(f.command).not.toHaveBeenCalled();
    f.view.lock(false, 'Ready');
    let resolve!: () => void;
    f.command.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await button(f).emit('click');
    expect(button(f).disabled).toBe(true);
    await button(f).emit('click');
    expect(f.command).toHaveBeenCalledOnce();
    resolve();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    f.npcDialogue.mockClear();
    f.command.mockRejectedValueOnce(new Error('NPC request unavailable.'));
    await button(f).emit('click');
    expect(f.npcDialogue).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith('NPC request unavailable.', true);
  });

  it('labels exact known NPC services while keeping unknown, misplaced and ambiguous NPCs generic', () => {
    const f = fixture(),
      status = f.engine.snapshot(),
      kafra = { ...npc, name: 'Kafra Staff', x: 151, y: 29 };
    const labels = (map: string, actors: Entity[]) =>
      consoleNpcs({ ...status, map, actors }).map((actor) => actor.kindLabel);
    expect(labels('prontera', [kafra])).toEqual(['NPC · Storage / Teleport']);
    expect(labels('prt_fild05', [{ ...npc, name: 'Tool Dealer', x: 290, y: 221 }])).toEqual([
      'NPC · Shop',
    ]);
    for (const actors of [
      [npc],
      [{ ...kafra, x: 152 }],
      [{ ...kafra, kind: 4 }],
      [kafra, { ...kafra, id: 11 }],
    ])
      expect(labels('prontera', actors).every((label) => label === 'NPC')).toBe(true);
    expect(labels('prt_fild08', [kafra])).toEqual(['NPC']);
    expect(labels('prontera', [{ ...kafra, dead: true }])).toEqual([]);
  });

  it('redraws NPC additions, movement and removal while retaining unchanged Talk buttons and map pixels', () => {
    const f = fixture(),
      context = f.get('radar').context;
    context.drawImage.mockClear();
    spawn(f);
    expect(context.drawImage).toHaveBeenCalledOnce();
    const talk = button(f);
    context.drawImage.mockClear();
    f.render();
    expect(button(f)).toBe(talk);
    expect(context.drawImage).not.toHaveBeenCalled();
    spawn(f, { ...npc, x: npc.x + 0.25 });
    expect(context.drawImage).toHaveBeenCalledOnce();
    context.drawImage.mockClear();
    f.engine.receive([{ type: 'remove', id: npc.id, dead: false }]);
    f.render();
    expect(context.drawImage).toHaveBeenCalledOnce();
    expect(f.get('console-npcs').all()).not.toContain(talk);
  });
});

describe('bot console inventory and monitoring', () => {
  it('retains map pixels and backing dimensions for HP/metadata updates while always refreshing locks', () => {
    const f = fixture(),
      canvas = f.get('radar'),
      context = canvas.context;
    const width = vi.spyOn(canvas, 'width', 'set'),
      height = vi.spyOn(canvas, 'height', 'set');
    context.drawImage.mockClear();
    context.clearRect.mockClear();
    const status = f.engine.snapshot();
    status.player!.hp--;
    status.navigation!.ready = false;
    status.navigation!.reachable = 17;
    status.navigation!.routeLength = 9;
    f.view.render(status);
    expect(context.drawImage).not.toHaveBeenCalled();
    expect(context.clearRect).not.toHaveBeenCalled();
    expect(width).not.toHaveBeenCalled();
    expect(height).not.toHaveBeenCalled();
    expect(f.get('navigation-info').textContent).toContain('17 reachable');
    expect(f.get('navigation-info').textContent).toContain('9 route cells');
    expect(f.get('navigation-info').textContent).toContain('outside verified safe ground');
    f.view.lock(true, 'Automation owns controls.');
    f.view.render(status);
    expect(f.get('console-walk').disabled).toBe(true);
    expect(f.get('console-lock').textContent).toBe('Automation owns controls.');
  });
  it('redraws each changed overlay from exact copied coordinates, including in-place fractional edits', () => {
    const f = fixture(),
      context = f.get('radar').context,
      status = f.engine.snapshot();
    status.drops = [{ id: 99, itemId: 501, count: 1, x: origin.x, y: origin.y, isNew: true }];
    f.view.render(status);
    context.drawImage.mockClear();
    const changed = (edit: () => void) => {
      edit();
      f.view.render(status);
      expect(context.drawImage).toHaveBeenCalledOnce();
      context.drawImage.mockClear();
    };
    changed(() => {
      status.player!.x += 0.125;
    });
    changed(() => {
      status.monsters[0]!.y += 0.25;
    });
    changed(() => {
      status.drops[0]!.x += 0.5;
    });
    changed(() => {
      status.navigation!.goal = { x: origin.x + 2, y: origin.y };
    });
    changed(() => {
      status.navigation!.route = [{ ...origin }, { x: origin.x + 1, y: origin.y }];
    });
    changed(() => {
      status.navigation!.route[1]!.y++;
    });
    changed(() => {
      status.navigation!.leg = [{ ...origin }, { x: origin.x, y: origin.y + 1 }];
    });
    changed(() => {
      status.navigation!.leg[0]!.x++;
    });
    status.monsters[0]!.hp--;
    status.drops[0]!.count++;
    f.view.render(status);
    expect(context.drawImage).not.toHaveBeenCalled();
    // Dead actors are still part of the existing radar projection.
    status.monsters[0]!.dead = true;
    changed(() => {
      status.monsters[0]!.x++;
    });
  });
  it('restores map paint after unsupported maps, disconnect, context restoration and external resize', async () => {
    const f = fixture(),
      canvas = f.get('radar'),
      context = canvas.context,
      status = f.engine.snapshot();
    f.view.render({ ...status, map: 'unknown-map', navigation: null });
    expect(f.get('navigation-info').textContent).toContain('Collision unavailable');
    expect(context.fillText).toHaveBeenCalled();
    f.view.render(null);
    expect(f.get('navigation-info').textContent).toContain('Connect a character');
    context.drawImage.mockClear();
    f.view.render(status);
    expect(context.drawImage).toHaveBeenCalledOnce();
    context.drawImage.mockClear();
    await canvas.emit('contextrestored');
    expect(context.drawImage).toHaveBeenCalledOnce();
    context.drawImage.mockClear();
    canvas.width = 500;
    f.view.render(status);
    expect(canvas.width).toBe(grid.width);
    expect(context.drawImage).toHaveBeenCalledOnce();
  });
  it('retains unchanged drop rows and detects count, item, coordinate, ordering and removal edits', () => {
    const f = fixture(),
      status = f.engine.snapshot(),
      drops = f.get('console-drops');
    status.drops = [
      { id: 99, itemId: 501, count: 1, x: origin.x, y: origin.y, isNew: true },
      { id: 100, itemId: 610, count: 2, x: origin.x + 1, y: origin.y, isNew: true },
    ];
    f.view.render(status);
    const first = drops.children[0];
    f.view.render(structuredClone(status));
    expect(drops.children[0]).toBe(first);
    status.drops[0]!.count = 3;
    f.view.render(status);
    expect(drops.children[0]).not.toBe(first);
    expect(drops.children[0]!.textContent).toContain('× 3');
    status.drops[0]!.itemId = 610;
    status.drops[0]!.x += 0.25;
    f.view.render(status);
    expect(drops.children[0]!.textContent).toContain(String(status.drops[0]!.x));
    const texts = drops.children.map((row) => row.textContent);
    status.drops.reverse();
    f.view.render(status);
    expect(drops.children.map((row) => row.textContent)).toEqual(texts.reverse());
    status.drops = [];
    f.view.render(status);
    expect(drops.textContent).toBe('No drops observed.');
    f.view.render(null);
    expect(drops.textContent).toBe('No drops observed.');
  });
  it('keeps selection, coordinate drafts and focused action nodes through telemetry; never selects a default item', () => {
    const f = fixture(),
      selector = f.get('console-item'),
      attack = f
        .get('monster-list')
        .all()
        .find((node) => node.tag === 'button');
    expect(selector.value).toBe('');
    selector.value = '501';
    f.get('console-walk-x').value = '123';
    f.render();
    expect(f.get('console-item')).toBe(selector);
    expect(selector.value).toBe('501');
    expect(f.get('console-walk-x').value).toBe('123');
    expect(f.get('monster-list').all()).toContain(attack);
    f.engine.receive([{ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 0 }]);
    f.render();
    expect(selector.value).toBe('501');
    expect(f.get('console-item-info').textContent).toContain('2 observed');
  });
  it.each([
    [true, 'Stop automation before sending a manual command.'],
    [false, 'Wait for pending actions to settle before sending a manual command.'],
  ])(
    'allows read-only inventory browsing while running=%s and manual controls are locked',
    async (running, reason) => {
      vi.useFakeTimers({ toFake: ['Date'] });
      const f = fixture(),
        selector = f.get('console-item'),
        before = f.engine.snapshot(),
        settings = structuredClone(f.settings);
      const status = { ...before, running, runRequested: true };
      f.view.render(status);
      f.view.lock(true, reason);
      expect(selector.disabled).toBe(false);
      selector.value = '501';
      await selector.emit('change');
      expect(f.get('console-item-info').textContent).toContain('3 observed · Untargeted use');
      selector.value = '610';
      await selector.emit('change');
      expect(f.get('console-item-info').textContent).toContain(
        '2 observed · Requires an explicit target',
      );
      expect(f.get('console-use-item').disabled).toBe(true);
      expect(f.get('console-walk').disabled).toBe(true);
      await f.get('console-use-item').emit('click');
      const attack = f
        .get('monster-list')
        .all()
        .find((node) => node.tag === 'button')!;
      expect(attack.disabled).toBe(true);
      await attack.emit('click');
      expect(f.command).not.toHaveBeenCalled();
      expect(f.settings).toEqual(settings);
      expect(f.engine.snapshot()).toEqual(before);
    },
  );
  it('preserves inspection through active stock updates, unavailable inventory, removal and replacement connections', async () => {
    const f = fixture(),
      selector = f.get('console-item'),
      snapshot = f.engine.snapshot();
    const status = { ...snapshot, running: true, runRequested: true };
    f.view.render(status);
    f.view.lock(true, 'Automation owns manual controls.');
    selector.value = '501';
    await selector.emit('change');
    const updated: Snapshot = {
      ...status,
      character: {
        ...status.character,
        inventory: [...status.character.inventory, { itemId: 501, bagId: 502, count: 4, type: 1 }],
      },
    };
    f.view.render(updated);
    expect(selector.value).toBe('501');
    expect(f.get('console-item-info').textContent).toContain('7 observed');
    f.view.render({ ...updated, character: { ...updated.character, inventoryKnown: false } });
    expect(selector.value).toBe('501');
    expect(selector.disabled).toBe(true);
    expect(f.get('console-item-info').textContent).toBe('Inventory has not been observed.');
    f.view.render(updated);
    expect(selector.value).toBe('501');
    expect(selector.disabled).toBe(false);
    const removed = {
      ...status,
      character: {
        ...status.character,
        inventory: status.character.inventory.filter((item) => item.itemId !== 501),
      },
    };
    f.view.render(removed);
    expect(selector.value).toBe('501');
    expect(selector.children.find((option) => option.value === '501')?.disabled).toBe(true);
    expect(f.get('console-item-info').textContent).toContain('is no longer carried');
    expect(f.get('console-use-item').disabled).toBe(true);
    f.view.render(removed);
    expect(f.get('console-item-info').textContent).toContain('is no longer carried');
    selector.value = '610';
    await selector.emit('change');
    expect(f.get('console-item-info').textContent).toContain('2 observed');
    f.view.render({
      ...updated,
      actorObservations: { ...updated.actorObservations, world: 'replacement-connection' },
    });
    expect(selector.value).toBe('');
    expect(f.get('console-item-info').textContent).toContain('No item is selected automatically.');
    expect(f.command).not.toHaveBeenCalled();
  });
  it('does not enable direct use when the inspected item is removed after manual controls unlock', async () => {
    const f = fixture(),
      status = f.engine.snapshot(),
      selector = f.get('console-item');
    selector.value = '501';
    await selector.emit('change');
    f.view.render({
      ...status,
      character: {
        ...status.character,
        inventory: status.character.inventory.filter((item) => item.itemId !== 501),
      },
    });
    f.view.lock(false, 'Ready');
    expect(selector.disabled).toBe(false);
    expect(f.get('console-use-item').disabled).toBe(true);
    await f.get('console-use-item').emit('click');
    expect(f.command).not.toHaveBeenCalled();
  });
  it('routes untargeted use through the existing command without attributing shared receipts', async () => {
    const f = fixture();
    f.get('console-item').value = '501';
    await f.get('console-item').emit('change');
    await f.get('console-use-item').emit('click');
    expect(f.command).toHaveBeenCalledWith({ type: 'useItem', itemId: 501 });
    expect(f.get('console-item-result').textContent).toContain('outcome unconfirmed');
    expect(f.get('console-item-result').textContent).not.toContain('Confirmed');
    const s = f.engine.snapshot();
    f.view.render({
      ...s,
      actionResult: { sequence: 1, status: 'pending', reason: 'Waiting for inventory receipt.' },
    });
    expect(f.get('console-latest-action').textContent).toContain('pending');
    f.view.render({
      ...s,
      actionResult: { sequence: 1, status: 'failed', reason: 'Receipt timed out.' },
    });
    expect(f.get('console-latest-action').textContent).toContain('unresolved');
    f.view.render({
      ...s,
      actionResult: { sequence: 1, status: 'confirmed', reason: 'Observed item decrement.' },
    });
    expect(f.get('console-latest-action').textContent).toContain('receipt confirmed');
    expect(f.get('console-item-result').textContent).toContain('outcome unconfirmed');
    f.view.render({
      ...s,
      actionResult: { sequence: 2, status: 'pending', reason: 'Another command.' },
    });
    expect(f.get('console-item-result').textContent).not.toContain('Another command');
    expect(f.get('console-latest-action').textContent).toContain('Another command');
  });
  it('never attributes a later unrelated confirmation to an item rejected before a receipt is allocated', async () => {
    const f = fixture();
    f.get('console-item').value = '501';
    await f.get('console-item').emit('change');
    // Native eval can resolve even when controller admission fails. No new sequence is evidence of acceptance.
    await f.get('console-use-item').emit('click');
    const snapshot = f.engine.snapshot();
    f.view.render({ ...snapshot, reason: 'Item admission rejected.' });
    f.view.render({
      ...snapshot,
      actionResult: { sequence: 8, status: 'confirmed', reason: 'An unrelated skill receipt.' },
    });
    expect(f.get('console-item-result').textContent).toContain('outcome unconfirmed');
    expect(f.get('console-item-result').textContent).not.toContain('receipt confirmed');
    expect(f.get('console-latest-action').textContent).toContain('unrelated skill receipt');
  });
  it('keeps prior bounded-command telemetry separate from a newly requested walk', async () => {
    const f = fixture(),
      snapshot = f.engine.snapshot();
    const status = {
      ...snapshot,
      manualTarget: {
        ...snapshot.manualTarget,
        sequence: 4,
        state: 'complete' as const,
        reason: 'Old walk finished.',
      },
    };
    f.view.render(status);
    f.get('console-walk-x').value = String(origin.x + 1);
    f.get('console-walk-y').value = String(origin.y);
    await f.get('console-walk-form').emit('submit');
    f.view.render(status);
    expect(f.get('console-action').textContent).toContain('Walk requested');
    expect(f.get('console-target-result').textContent).toContain(
      'Latest bounded command #4: complete',
    );
  });
  it('blocks targeted/unknown items and unknown inventory, with explicit access to advanced tools', async () => {
    const f = fixture();
    expect(ITEM_CATALOG[610]?.useType).toBe(2);
    f.get('console-item').value = '610';
    await f.get('console-item').emit('change');
    expect(f.get('console-use-item').disabled).toBe(true);
    expect(f.get('console-item-info').textContent).toContain('explicit target');
    await f.get('console-use-item').emit('click');
    expect(f.command).not.toHaveBeenCalled();
    f.view.render({
      ...f.engine.snapshot(),
      character: {
        ...f.engine.snapshot().character,
        inventory: [{ itemId: 2147483647, bagId: 1, type: 1, count: 1 }],
      },
    });
    f.get('console-item').value = '2147483647';
    await f.get('console-item').emit('change');
    expect(f.get('console-use-item').disabled).toBe(true);
    expect(f.get('console-item-info').textContent).toContain('No verified direct-use action');
    f.view.render({
      ...f.engine.snapshot(),
      character: { ...f.engine.snapshot().character, inventoryKnown: false },
    });
    expect(f.get('console-item').disabled).toBe(true);
    expect(f.get('console-use-item').disabled).toBe(true);
    await f.get('console-item-tools').emit('click');
    await f.get('console-loot-settings').emit('click');
    await f.get('open').emit('click');
    expect(f.manualTools).toHaveBeenCalledOnce();
    expect(f.lootSettings).toHaveBeenCalledOnce();
    expect(f.account).toHaveBeenCalledOnce();
    expect(f.command).not.toHaveBeenCalled();
  });
  it('refreshes all action locks immediately and prevents a second click during an outstanding request', async () => {
    const f = fixture();
    f.get('console-item').value = '501';
    f.view.lock(true, 'Stop bot first.');
    await f.get('console-use-item').emit('click');
    expect(f.command).not.toHaveBeenCalled();
    expect(f.get('console-walk').disabled).toBe(true);
    expect(f.get('console-lock').textContent).toBe('Stop bot first.');
    let finish!: () => void;
    f.command.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    f.view.lock(false, '');
    await f.get('console-use-item').emit('click');
    await f.get('console-use-item').emit('click');
    expect(f.command).toHaveBeenCalledOnce();
    expect(f.get('console-walk').disabled).toBe(true);
    expect(f.get('console-item').disabled).toBe(false);
    f.get('console-item').value = '610';
    await f.get('console-item').emit('change');
    expect(f.command).toHaveBeenCalledOnce();
    f.view.lock(true, 'Update in progress.');
    finish();
    for (let i = 0; i < 12; i++) await Promise.resolve();
    expect(f.get('console-use-item').disabled).toBe(true);
    expect(f.get('console-lock').textContent).toBe('Update in progress.');
  });
  it('shows only observed level, weight, currency and EXP totals without fabricated percentages', () => {
    const f = fixture(),
      s = f.engine.snapshot();
    f.view.render({
      ...s,
      character: {
        ...s.character,
        stats: {
          level: 20,
          hp: 100,
          maxHp: 100,
          jobLevel: 15,
          weight: 200,
          maxWeight: 1000,
          zeny: 42,
        },
        experience: { baseTotal: 500, baseGained: 12, jobTotal: 200, jobGained: 7 },
      },
    });
    expect(f.get('console-levels').textContent).toBe('20 / 15');
    expect(f.get('console-weight').textContent).toBe('200 / 1,000');
    expect(f.get('console-zeny').textContent).toBe('42');
    expect(f.get('console-experience').textContent).toBe(
      'Base EXP current 500 (latest +12) · Job EXP current 200 (latest +7)',
    );
    f.view.render({
      ...s,
      character: {
        ...s.character,
        experience: { baseTotal: 479, baseGained: -21, jobTotal: 182, jobGained: -18 },
      },
    });
    expect(f.get('console-base-experience').textContent).toBe('479 (latest -21)');
    expect(f.get('console-job-experience').textContent).toBe('182 (latest -18)');
    f.view.render(null);
    expect(f.get('console-weight').textContent).toBe('— / —');
    expect(f.get('console-levels').textContent).toBe('— / —');
    expect(f.get('console-item').disabled).toBe(true);
  });
});

describe('player shops are separate from NPC conversations', () => {
  const shop: Entity = {
    ...player,
    id: 30,
    kind: 2,
    name: 'Supply stall',
    hp: 0,
    maxHp: 0,
    x: origin.x + 8,
    y: origin.y + 6,
    npcSpawn: { displayType: 3, effectType: 0, interactable: true, ownerId: 999 },
  };
  const spawn = (f: ReturnType<typeof fixture>, entity = shop) => {
    f.engine.receive([{ type: 'spawn', entity: { ...entity } }]);
    f.render();
  };
  const button = (f: ReturnType<typeof fixture>) =>
    f
      .get('console-player-shops')
      .all()
      .find((node) => node.tag === 'button')!;

  it('separates metadata-confirmed shops while keeping kind4 and missing metadata as NPCs', () => {
    const f = fixture();
    spawn(f);
    spawn(f, { ...shop, id: 31, kind: 4 });
    spawn(f, { ...shop, id: 32, npcSpawn: undefined });
    const status = f.engine.snapshot();
    expect(consolePlayerShops(status).map((actor) => actor.id)).toEqual([30]);
    expect(consoleNpcs(status).map((actor) => actor.id)).toEqual([31, 32]);
    expect(button(f).textContent).toBe('View shop');
    expect(
      f
        .get('console-npcs')
        .all()
        .filter((node) => node.tag === 'button')
        .map((node) => node.textContent),
    ).toEqual(['Talk', 'Talk']);
  });

  it('opens one guarded vending request from a marker and the player shop tools panel', async () => {
    const f = fixture();
    spawn(f);
    const canvas = f.get('radar'),
      x = 50 + ((shop.x + 0.5) / grid.width) * 800,
      y = 100 + ((grid.height - 0.5 - shop.y) / grid.height) * 800;
    await canvas.emit('mousemove', x, y);
    expect(canvas.title).toContain('Player shop');
    expect(canvas.title).toContain('view shop');
    await canvas.emit('click', x, y);
    expect(f.command).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        type: 'manualVendingView',
        target: expect.objectContaining({ id: 30 }),
      }),
    );
    expect(f.playerShop).toHaveBeenCalledExactlyOnceWith(30);
    expect(f.npcDialogue).not.toHaveBeenCalled();
  });

  it('chooses the nearest marker across both families and uses lower IDs for equal distances', () => {
    const f = fixture();
    spawn(f);
    const status = f.engine.snapshot(),
      rect = { left: 0, top: 0, width: grid.width * 4, height: grid.height * 4 };
    status.actors.push({ ...shop, id: 40, npcSpawn: undefined, x: shop.x + 1 });
    const x = (shop.x + 0.5) * 4,
      y = (grid.height - 0.5 - shop.y) * 4;
    const hit = (clientX: number) =>
      consoleInteractionAt({
        status,
        clientX,
        clientY: y,
        rect,
        width: grid.width,
        height: grid.height,
      });
    expect(
      consoleInteractionAt({
        status,
        clientX: x - 15.9,
        clientY: y - 15.9,
        rect,
        width: grid.width,
        height: grid.height,
      })?.id,
    ).toBe(30);
    expect(hit(x)?.family).toBe('shop');
    expect(hit(x + 2)?.id).toBe(30);
    expect(hit(x + 3)?.id).toBe(40);
    status.actors[status.actors.length - 1]!.id = 20;
    expect(hit(x + 2)?.id).toBe(20);
  });

  it.each(['removed', 'reused', 'family', 'stale', 'missingLifetime', 'noOwner', 'world', 'dead'])(
    'rejects a saved shop button after %s',
    async (variant) => {
      const f = fixture();
      spawn(f);
      const old = button(f);
      if (variant === 'removed') {
        f.engine.receive([{ type: 'remove', id: shop.id, dead: false }]);
        f.render();
      } else if (variant === 'reused') spawn(f);
      else {
        const status = f.engine.snapshot();
        if (variant === 'family')
          status.actors.find((actor) => actor.id === shop.id)!.npcSpawn = undefined;
        if (variant === 'stale')
          status.actorObservations.at = status.actorObservations.lastFrameAt = Date.now() - 16000;
        if (variant === 'missingLifetime' || variant === 'noOwner')
          status.actorObservations.actors = status.actorObservations.actors.filter(
            (actor) => actor.id !== (variant === 'missingLifetime' ? shop.id : 0),
          );
        if (variant === 'world')
          status.actorObservations.world = '00000000-0000-0000-0000-000000000001';
        if (variant === 'dead') status.actors.find((actor) => actor.id === shop.id)!.dead = true;
        f.view.render(status);
      }
      await old.emit('click');
      expect(f.command).not.toHaveBeenCalled();
      expect(f.playerShop).not.toHaveBeenCalled();
    },
  );

  it('keeps missing lifetimes read-only and supports zero-ID shops without a raster', async () => {
    const f = fixture();
    f.engine.receive([
      { type: 'enter', id: 1, map: 'unmapped_field' },
      { type: 'spawn', entity: { ...player, id: 1 } },
    ]);
    spawn(f, { ...shop, id: 0 });
    const status = f.engine.snapshot();
    status.actorObservations.actors = status.actorObservations.actors.filter(
      (actor) => actor.id !== 0,
    );
    f.view.render(status);
    expect(button(f).hidden).toBe(true);
    f.render();
    await button(f).emit('click');
    expect(f.command).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'manualVendingView',
        map: 'unmapped_field',
        target: expect.objectContaining({ id: 0 }),
      }),
    );
  });

  it('keeps locks, pending admission and failed writes from opening the shop panel', async () => {
    const f = fixture();
    spawn(f);
    f.view.lock(true, 'Stop automation');
    await button(f).emit('click');
    expect(f.command).not.toHaveBeenCalled();
    f.view.lock(false, 'Ready');
    let resolve!: () => void;
    f.command.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    await button(f).emit('click');
    await button(f).emit('click');
    expect(f.command).toHaveBeenCalledOnce();
    expect(button(f).disabled).toBe(true);
    resolve();
    for (let index = 0; index < 12; index++) await Promise.resolve();
    f.playerShop.mockClear();
    f.command.mockRejectedValueOnce(new Error('Shop unavailable'));
    await button(f).emit('click');
    expect(f.playerShop).not.toHaveBeenCalled();
    expect(f.notify).toHaveBeenLastCalledWith('Shop unavailable', true);
  });

  it('invalidates map pixels and old Talk controls on an NPC-to-shop family change', async () => {
    const f = fixture();
    spawn(f, { ...shop, npcSpawn: undefined });
    const talk = f
        .get('console-npcs')
        .all()
        .find((node) => node.tag === 'button')!,
      context = f.get('radar').context;
    context.drawImage.mockClear();
    const status = f.engine.snapshot();
    status.actors.find((actor) => actor.id === shop.id)!.npcSpawn = shop.npcSpawn;
    f.view.render(status);
    expect(context.drawImage).toHaveBeenCalledOnce();
    await talk.emit('click');
    expect(f.command).not.toHaveBeenCalled();
    expect(f.get('console-npcs').all()).not.toContain(talk);
    expect(button(f).textContent).toBe('View shop');
  });
});

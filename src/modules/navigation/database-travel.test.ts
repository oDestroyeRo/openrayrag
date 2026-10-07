import { describe, expect, it, vi } from 'vitest';
import { BitReader, BitWriter } from '../../shared/binary';
import {
  DATABASE_TELEPORT_COOLDOWN_MS,
  databaseTeleportWait,
  databaseTravelCommand,
  supportsDatabaseTravel,
} from './database-travel-protocol';
import { TravelController, type TravelPlanningContext } from './travel-controller';
import { wireController } from '../runtime/controller-wire';
import { OP, type Entity, type GameEvent } from '../protocol/protocol';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { NAVIGATION_MAPS, searchGrid } from './navigation';
import type { Action } from '../automation/engine';
import type { MacroStep } from '../automation/macros';
import { BUILTIN_SERVICES } from '../services/npc-services';
import { DEFAULT_SUPPLY } from '../services/supply-trip';
import { FEATURE_OP } from '../protocol/protocol-feature';

const own: Entity = {
  id: 0,
  classId: 6,
  name: 'Database fixture',
  kind: 0,
  level: 15,
  hp: 100,
  maxHp: 100,
  sp: 100,
  maxSp: 100,
  x: 170,
  y: 370,
  dead: false,
  statuses: [],
  sitting: false,
};
function spawn(entity = own, entryType = 1): Uint8Array {
  const name = new TextEncoder().encode(entity.name),
    body = new BitWriter()
      .u8(15)
      .i32(entity.id)
      .i32(entity.classId)
      .i32(0)
      .i32(~name.length)
      .i32(entity.name.length)
      .take(name)
      .u8(entity.kind)
      .u8(0)
      .u8(entity.dead ? 3 : 0)
      .i32(entity.x)
      .i32(entity.y)
      .u8(entity.level)
      .i32(entity.hp)
      .i32(entity.maxHp)
      .i32(entity.sp ?? 0)
      .i32(entity.maxSp ?? 0)
      .i32(0)
      .u8(0)
      .finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
function resources(hp = 100, count = 5): Uint8Array {
  const w = new BitWriter().u8(FEATURE_OP.stats);
  for (const n of [
    15,
    15,
    10000,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    hp,
    100,
    100,
    100,
    ...Array(16).fill(0),
    1000,
  ])
    w.i32(n);
  w.f32(0.4)
    .i32(5)
    .i32(0)
    .bool(true)
    .i16(1)
    .i16(1)
    .u8(9)
    .i16(0)
    .bool(true)
    .u8(1)
    .i32(count ? 1 : 0);
  if (count) w.i32(501).i16(count);
  w.i32(0).u8(0);
  for (let i = 0; i < 10; i++) w.i32(0);
  return w.i32(-1).finish();
}
function travelFixture(sendFailure = false, reserve = () => true) {
  let now = 100_000,
    ready = true,
    inputReady = true;
  let context: TravelPlanningContext = {
    identity: 'source lifetime',
    connection: 'connection 1',
    map: 'prt_fild08',
    player: own,
  };
  const actions: Action[] = [],
    send = vi.fn(() => {
      if (sendFailure) throw Error('Synthetic write failure');
    });
  const travel = new TravelController(
    (action) => actions.push(action),
    () => now,
    undefined,
    {
      context: () => context,
      dispatchReady: () => ready,
      databaseTravel: { supported: supportsDatabaseTravel, send, reserve, ready: () => inputReady },
    },
  );
  const observe = (event: GameEvent) => {
    travel.prepareObservation([event]);
    if ((event.type === 'remove' && event.id === own.id) || event.type === 'clear')
      context = { ...context, identity: null, player: undefined };
    if (event.type === 'map')
      context = { ...context, map: event.map, identity: null, player: undefined };
    if (event.type === 'spawn' && event.entity.id === own.id)
      context = { ...context, identity: 'arrival lifetime', player: event.entity };
    return travel.observe([event]);
  };
  const start = () => {
    travel.start(context.map, context.player!, 'prontera', 10, true);
    travel.tick(context.map, context.player);
  };
  const departure = () => observe({ type: 'remove', id: own.id, reason: 0, dead: false });
  const map = () => observe({ type: 'map', map: 'prontera' });
  const arrive = () => {
    departure();
    map();
    travel.observeReady();
    return observe({ type: 'spawn', entity: own, entryType: 1 });
  };
  return {
    travel,
    send,
    actions,
    observe,
    start,
    departure,
    map,
    arrive,
    setReady: (value: boolean) => {
      ready = value;
    },
    setInputReady: (value: boolean) => {
      inputReady = value;
    },
    advance: (ms: number) => {
      now += ms;
    },
    context: () => context,
    setContext: (value: TravelPlanningContext) => {
      context = value;
    },
  };
}

describe('Database travel wire contract', () => {
  it('accepts only bounded, exact server teleport cooldown messages', () => {
    const text = 'You need to wait 12 more seconds before you can teleport again.';
    expect(databaseTeleportWait({ type: 'featureError', message: text })).toBe(12_000);
    for (const channel of [0, 3] as const)
      expect(
        databaseTeleportWait({ type: 'chat', actorId: -1, name: 'Server', channel, text }),
      ).toBe(12_000);
    expect(
      databaseTeleportWait({ type: 'chat', actorId: 9, name: 'Server', channel: 0, text }),
    ).toBeNull();
    expect(
      databaseTeleportWait({ type: 'chat', actorId: -1, name: 'Server', channel: 2, text }),
    ).toBeNull();
    for (const message of [
      text + ' ',
      text.replace('12', '0'),
      text.replace('12', '61'),
      text.replace('12', '999'),
      text.replace('12', '-1'),
    ])
      expect(databaseTeleportWait({ type: 'featureError', message })).toBeNull();
  });
  it('matches the deployed Database map request, default server coordinates and no force flag', () => {
    const bytes = databaseTravelCommand('alde_dun01');
    expect([...bytes]).toEqual([
      64, 10, 0, 97, 108, 100, 101, 95, 100, 117, 110, 48, 49, 25, 252, 25, 252, 0,
    ]);
    const r = new BitReader(bytes);
    expect(r.u8()).toBe(64);
    expect(r.string()).toBe('alde_dun01');
    expect([r.i16(), r.i16(), r.bool()]).toEqual([-999, -999, false]);
    r.finish();
  });
  it.each([
    null,
    undefined,
    {},
    '',
    'prontera\n',
    '../prontera',
    'PRONTERA',
    '2009rwc_03',
    'payon_p',
    'pvp_n_1-5',
  ])('rejects unsupported destination %j', (value) => {
    expect(supportsDatabaseTravel(value)).toBe(false);
    expect(() => databaseTravelCommand(value)).toThrow('Unsupported');
  });
  it('admits only the complete pinned collision-map catalog', () => {
    for (const map of NAVIGATION_MAPS) expect(supportsDatabaseTravel(map)).toBe(true);
  });
});

describe('Database trip evidence and retained uncertainty', () => {
  it('needs captured own removal, requested map, ordered Ready and a fresh living spawn', () => {
    const f = travelFixture();
    f.start();
    expect(f.send).toHaveBeenCalledExactlyOnceWith('prontera');
    expect(f.actions).toEqual([]);
    expect(f.travel.snapshot().state).toBe('transition');
    expect(f.travel.movementSettled('prt_fild08', own)).toBe(false);
    expect(f.departure()[0]?.phase).toBe('remove');
    expect(f.map()[0]?.phase).toBe('map');
    f.travel.observeReady();
    expect(f.observe({ type: 'spawn', entity: own, entryType: 1 })[0]?.phase).toBe('spawn');
    expect(f.travel.snapshot().state).toBe('complete');
    expect(f.travel.movementSettled('prontera', own)).toBe(true);
  });
  it('permits an owned clear only after captured departure and before the requested map', () => {
    const f = travelFixture();
    f.start();
    f.departure();
    expect(f.observe({ type: 'clear' })[0]?.phase).toBe('clear');
    f.map();
    f.travel.observeReady();
    f.observe({ type: 'spawn', entity: own, entryType: 1 });
    expect(f.travel.snapshot().state).toBe('complete');
  });
  it.each([
    'clearAlone',
    'mapAlone',
    'wrongReason',
    'wrongMap',
    'missingReady',
    'earlyReady',
    'dead',
    'wrongName',
    'wrongKind',
    'wrongEntry',
    'staleIdentity',
    'connection',
  ])('rejects %s without retrying or granting physical fallback', (fault) => {
    const f = travelFixture();
    f.start();
    if (fault === 'clearAlone') f.observe({ type: 'clear' });
    else if (fault === 'mapAlone') f.map();
    else if (fault === 'wrongReason') f.observe({ type: 'remove', id: 0, reason: 4, dead: false });
    else {
      if (fault === 'earlyReady') f.travel.observeReady();
      f.departure();
      f.observe({ type: 'map', map: fault === 'wrongMap' ? 'prt_fild05' : 'prontera' });
      if (!['missingReady', 'earlyReady'].includes(fault)) f.travel.observeReady();
      if (fault === 'connection') f.setContext({ ...f.context(), connection: 'connection 2' });
      const entity = {
        ...own,
        ...(fault === 'dead' ? { dead: true, hp: 0 } : {}),
        ...(fault === 'wrongName' ? { name: 'Foreign' } : {}),
        ...(fault === 'wrongKind' ? { kind: 1 } : {}),
      };
      if (fault === 'staleIdentity') {
        const event: GameEvent = { type: 'spawn', entity, entryType: 1 };
        f.travel.prepareObservation([event]);
        f.setContext({ ...f.context(), identity: 'source lifetime', player: entity });
        f.travel.observe([event]);
      } else f.observe({ type: 'spawn', entity, entryType: fault === 'wrongEntry' ? 2 : 1 });
    }
    f.advance(30_000);
    f.travel.tick(f.context().map, f.context().player);
    expect(f.travel.snapshot().state).toBe('failed');
    expect(f.travel.teleportPending).toBe(true);
    expect(() => f.travel.start('prontera', own, 'prt_fild08', 10, true)).toThrow('settle');
    expect(f.send).toHaveBeenCalledTimes(1);
    expect(f.actions).toEqual([]);
  });
  it('foreign actor spawns cannot confirm or erase the pending receipt', () => {
    const f = travelFixture();
    f.start();
    f.departure();
    f.map();
    f.travel.observeReady();
    f.observe({ type: 'spawn', entity: { ...own, id: 2 }, entryType: 1 });
    expect(f.travel.snapshot().state).toBe('transition');
    f.observe({ type: 'spawn', entity: own, entryType: 1 });
    expect(f.travel.snapshot().state).toBe('complete');
  });
  it.each(['Stop', 'deadline', 'throw'])(
    'retains a sent request after %s and late exact arrival only drains the fence',
    (fault) => {
      const f = travelFixture(fault === 'throw');
      f.start();
      if (fault === 'Stop') f.travel.cancel();
      if (fault === 'deadline') f.advance(20_001);
      f.arrive();
      expect(f.travel.snapshot().state).toBe(fault === 'Stop' ? 'cancelled' : 'failed');
      expect(f.travel.teleportPending).toBe(false);
      expect(f.actions).toEqual([]);
      expect(f.send).toHaveBeenCalledTimes(1);
    },
  );
  it('reconnect clears sent uncertainty and does not replay the trip', () => {
    const f = travelFixture();
    f.start();
    f.travel.cancel();
    f.travel.connectionChanged();
    expect(f.travel.movementSettled('prt_fild08', own)).toBe(true);
    expect(f.send).toHaveBeenCalledTimes(1);
  });
  it('waits for action settlement, reserves a finite command once, and keeps budget rejection unsent', () => {
    const reserve = vi.fn(() => false),
      f = travelFixture(false, reserve);
    f.setReady(false);
    f.start();
    expect(f.send).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    f.setReady(true);
    f.travel.tick('prt_fild08', own);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(f.travel.snapshot().state).toBe('failed');
    expect(f.travel.teleportPending).toBe(false);
    expect(f.send).not.toHaveBeenCalled();
  });
  it('does not reserve or write until server input cooldown clears', () => {
    const reserve = vi.fn(() => true),
      f = travelFixture(false, reserve);
    f.setInputReady(false);
    f.start();
    f.advance(2_000);
    f.travel.tick('prt_fild08', own);
    expect(f.send).not.toHaveBeenCalled();
    expect(reserve).not.toHaveBeenCalled();
    expect(f.travel.teleportPending).toBe(false);
    f.setInputReady(true);
    f.travel.tick('prt_fild08', own);
    f.travel.tick('prt_fild08', own);
    expect(reserve).toHaveBeenCalledTimes(1);
    expect(f.send).toHaveBeenCalledExactlyOnceWith('prontera');
  });
  it('expires unsent preparation without reserving a command or retaining sent uncertainty', () => {
    const reserve = vi.fn(() => true),
      f = travelFixture(false, reserve);
    f.setInputReady(false);
    f.start();
    f.advance(60_001);
    f.travel.tick('prt_fild08', own);
    expect(f.travel.snapshot()).toMatchObject({
      state: 'failed',
      reason: 'Database travel preparation timed out before sending a request.',
    });
    expect(f.travel.teleportPending).toBe(false);
    expect(reserve).not.toHaveBeenCalled();
    expect(f.send).not.toHaveBeenCalled();
  });
  it('preserves denied-map policy and same-map verified walking instead of teleporting', () => {
    const f = travelFixture();
    f.setInputReady(false);
    expect(() =>
      f.travel.start('prt_fild08', own, 'prontera', 10, true, {
        ...DEFAULT_MAP_POLICY,
        deny: ['prontera'],
      }),
    ).toThrow('forbidden');
    const grid = searchGrid('prt_fild08')!,
      target = [
        { x: own.x - 1, y: own.y },
        { x: own.x + 1, y: own.y },
        { x: own.x, y: own.y - 1 },
        { x: own.x, y: own.y + 1 },
      ].find((p) => grid.walkable(p))!;
    f.travel.startApproach('prt_fild08', own, target);
    f.travel.tick('prt_fild08', own);
    expect(f.actions[0]?.type).toBe('walk');
    expect(f.send).not.toHaveBeenCalled();
  });
  it('uses physical planning only before dispatch when the transport does not support the map', () => {
    const send = vi.fn(),
      actions: Action[] = [],
      travel = new TravelController(
        (a) => actions.push(a),
        () => 100_000,
        undefined,
        { databaseTravel: { supported: () => false, send } },
      );
    travel.start('prt_fild08', { ...own, x: 170, y: 370 }, 'prontera', 10, true);
    travel.tick('prt_fild08', { ...own, x: 170, y: 370 });
    expect(actions[0]?.type).toBe('walk');
    expect(send).not.toHaveBeenCalled();
  });
});

function controllerFixture(
  map = 'prt_fild08',
  player = own,
  initialWait = DATABASE_TELEPORT_COOLDOWN_MS,
) {
  let now = 100_000;
  const packets: Uint8Array[] = [];
  const c = wireController(
      (packet) => packets.push(packet),
      undefined,
      () => now,
    ),
    receive = (packet: BitWriter | Uint8Array) =>
      c.receive(packet instanceof BitWriter ? packet.finish() : packet);
  c.connect(true);
  receive(new BitWriter().u8(OP.enter).i32(player.id).string(map));
  c.observeOfficialPacket(new Uint8Array([2]));
  receive(spawn(player));
  c.engine.receive([
    {
      type: 'inventory',
      items: [{ bagId: 501, itemId: 501, type: 1, count: 5 }],
      equipment: Array(10).fill(0),
      ammoId: -1,
    },
    { type: 'skills', learned: [{ skillId: 1, level: 9 }], granted: [] },
    {
      type: 'stats',
      level: 15,
      jobLevel: 15,
      hp: player.hp,
      maxHp: 100,
      sp: 100,
      maxSp: 100,
      zeny: 10_000,
      weight: 5,
      maxWeight: 1000,
    },
  ]);
  const fresh = () => receive(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100));
  now += initialWait;
  fresh();
  const step = (ms = 100, traffic = true) => {
      now += ms;
      if (traffic) fresh();
      c.tick();
    },
    advance = (ms: number, traffic = true) => {
      for (let elapsed = 0; elapsed < ms; elapsed += 100)
        step(Math.min(100, ms - elapsed), traffic);
    };
  const transition = (map: string, position = { x: 100, y: 100 }, clear = false) => {
    receive(new BitWriter().u8(OP.remove).i32(player.id).u8(0));
    if (clear) receive(new BitWriter().u8(OP.clear));
    receive(new BitWriter().u8(OP.map).string(map));
    c.observeOfficialPacket(new Uint8Array([2]));
    receive(spawn({ ...own, ...position }));
  };
  const settings = {
    ...DEFAULT_SETTINGS,
    map: 'prt_fild08',
    targets: [4000],
    automation: structuredClone(DEFAULT_AUTOMATION),
  };
  const macro = (steps: MacroStep[]) =>
    c.perform('macro', {
      settings,
      script: {
        version: 1,
        name: 'Database travel',
        durationSeconds: 120,
        maxActions: 10,
        maxSpend: 1000,
        rules: [
          {
            name: 'Route',
            priority: 0,
            cooldownSeconds: 0,
            maxRuns: 1,
            conditions: [{ field: 'level', operator: 'gte', value: 1 }],
            steps,
          },
        ],
      },
    });
  return {
    c,
    receive,
    fresh,
    step,
    advance,
    transition,
    packets,
    settings,
    macro,
    teleports: () => packets.filter((p) => p[0] === 64),
  };
}

describe('production shared-controller Database travel', () => {
  it.each([false, true])('enters the configured field before combat with Stop=%s', (stopped) => {
    const f = controllerFixture();
    f.receive(spawn({ ...own, id: 2, classId: 4000, kind: 1, level: 1, x: 171 }, 0));
    f.c.start({ ...f.settings, map: 'prt_fild05' });
    f.step();
    expect(f.teleports()).toEqual([databaseTravelCommand('prt_fild05')]);
    expect(f.c.engine.running).toBe(false);
    expect(f.packets.some((packet) => packet[0] === OP.attack)).toBe(false);
    expect(f.c.snapshot().initialFieldEntryPending).toBe(true);
    if (stopped) f.c.stop();
    f.transition('prt_fild05');
    f.receive(spawn({ ...own, id: 2, classId: 4000, kind: 1, level: 1, x: 101, y: 100 }, 0));
    f.step();
    f.step();
    expect(f.c.engine.running).toBe(!stopped);
    expect(f.packets.some((packet) => packet[0] === OP.attack)).toBe(!stopped);
    expect(f.c.snapshot().initialFieldEntryPending).toBe(false);
    expect(f.teleports()).toHaveLength(1);
  });

  it('preserves an explicit travel destination over the retained configured field', () => {
    const f = controllerFixture();
    f.settings.automation.travel.destinationMap = 'prt_fild06';
    f.c.start({ ...f.settings, map: 'prt_fild05' });
    f.step();
    expect(f.teleports()).toEqual([databaseTravelCommand('prt_fild06')]);
    expect(f.c.engine.running).toBe(false);
  });

  it.each(['travel', 'farm', 'store'] as const)(
    'retains the same unsent %s owner on a quiet map and sends only after fresh evidence',
    (type) => {
      const f = controllerFixture('prt_fild08', own, 0);
      const step: MacroStep =
        type === 'store'
          ? {
              type: 'store',
              serviceId: 'kafra-south-storage',
              itemId: 501,
              quantity: 1,
              keep: 1,
              maxSpend: 100,
              timeoutSeconds: 90,
            }
          : type === 'farm'
            ? { type: 'farm', map: 'prt_fild05', targets: [4000], timeoutSeconds: 90 }
            : { type: 'travel', map: 'prt_fild05', timeoutSeconds: 90 };
      f.macro([step]);
      f.advance(500);
      const trip = f.c.travel.tripId;
      expect(f.c.travel.databasePreparing).toBe(true);
      f.advance(44_500, false);
      expect(f.teleports()).toHaveLength(0);
      expect(f.c.travel.tripId).toBe(trip);
      expect(f.c.travel.databasePreparing).toBe(true);
      expect(f.c.macro.active).toBe(true);
      expect(f.c.travel.snapshot().reason).toContain('fresh server update');
      f.fresh();
      f.step();
      expect(f.teleports()).toHaveLength(1);
      expect(f.c.travel.tripId).toBe(trip);
    },
  );
  it('preserves a short script deadline instead of extending it to cover cooldown', () => {
    const f = controllerFixture('prt_fild08', own, 0);
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 20 }]);
    f.advance(20_100);
    expect(f.c.macro.snapshot().state).toBe('failed');
    expect(f.teleports()).toHaveLength(0);
    expect(f.c.travel.teleportPending).toBe(false);
  });
  it('ends a silent-map preparation at its original sixty-second deadline', () => {
    const f = controllerFixture('prt_fild08', own, 0);
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 90 }]);
    f.advance(100);
    f.advance(60_200, false);
    expect(f.c.macro.snapshot()).toMatchObject({
      state: 'failed',
      reason: 'Database travel preparation timed out before sending a request.',
    });
    expect(f.c.travel.active).toBe(false);
    expect(f.teleports()).toHaveLength(0);
    expect(f.c.travel.teleportPending).toBe(false);
  });
  it('waits through the fresh-login teleport guard without consuming a command and preserves it across Stop', () => {
    const f = controllerFixture('prt_fild08', own, 0);
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    f.advance(15_000);
    expect(f.teleports()).toHaveLength(0);
    expect(f.c.travel.snapshot().reason).toContain('15s');
    f.c.stop();
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    f.advance(14_900);
    expect(f.teleports()).toHaveLength(0);
    f.step();
    expect(f.teleports()).toHaveLength(1);
  });
  it('extends the wait from a server warning but ignores player impersonation', () => {
    const f = controllerFixture();
    const message = 'You need to wait 12 more seconds before you can teleport again.';
    f.receive(new BitWriter().u8(44).i32(9).string(message).string('Server').u8(0));
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    f.step();
    expect(f.teleports()).toHaveLength(1);
    const g = controllerFixture();
    g.receive(new BitWriter().u8(FEATURE_OP.featureError).string(message));
    g.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    g.advance(12_900);
    expect(g.teleports()).toHaveLength(0);
    g.step();
    expect(g.teleports()).toHaveLength(1);
  });
  it('paces Stop and consecutive macro transfers from fresh arrival even after slow map loading', () => {
    const f = controllerFixture();
    f.c.start(f.settings);
    f.c.stop();
    expect(f.packets.some((packet) => packet[0] === OP.stop)).toBe(true);
    f.macro([
      { type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 },
      { type: 'farm', map: 'prt_fild08', targets: [4000], timeoutSeconds: 60 },
    ]);
    f.advance(1_900);
    expect(f.teleports()).toHaveLength(0);
    f.step();
    expect(f.teleports()).toHaveLength(1);
    // Loading outlasts send-time quiet time; server debt drains only after Ready.
    f.advance(5_000);
    f.transition('prt_fild05');
    f.advance(29_900);
    expect(f.teleports()).toHaveLength(1);
    expect(f.c.macro.snapshot().actionsCompleted).toBe(1);
    f.step();
    expect(f.teleports()).toHaveLength(2);
    f.transition('prt_fild08', { x: own.x, y: own.y });
    f.advance(500);
    expect(f.c.snapshot()).toMatchObject({
      map: 'prt_fild08',
      running: true,
      macro: { state: 'monitoring', actionsCompleted: 2 },
    });
  });
  it('paces the official Look packet before Database travel', () => {
    const f = controllerFixture();
    f.c.officialLook();
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 30 }]);
    f.advance(1_900);
    expect(f.teleports()).toHaveLength(0);
    f.step();
    expect(f.teleports()).toHaveLength(1);
  });
  it('keeps the same unsent macro trip through official movement and a manual map change', () => {
    const f = controllerFixture('prt_fild08', own, 0);
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    const trip = f.c.travel.tripId;
    f.c.engine.deaths = 1;
    f.c.engine.kills = 7;
    f.c.engine.looted = 4;
    f.c.manualCommand();
    f.receive(
      new BitWriter()
        .u8(OP.walk)
        .i32(0)
        .position(own)
        .f32(own.x)
        .f32(own.y)
        .f32(0.1)
        .f32(0.1)
        .u8(2)
        .u8(0x60)
        .u8(0),
    );
    for (let i = 0; i < 10; i++) {
      f.c.manualInput();
      f.step(1000);
    }
    f.transition('prt_fild06');
    expect(f.c.travel.tripId).toBe(trip);
    expect(f.c.macro.active).toBe(true);
    expect(f.teleports()).toHaveLength(0);
    f.advance(30_000);
    expect(f.teleports()).toHaveLength(1);
    f.transition('prt_fild05');
    expect(f.c.macro.snapshot()).toMatchObject({
      state: 'completed',
      actionsIssued: 1,
      actionsCompleted: 1,
    });
    expect(f.c.snapshot()).toMatchObject({ deaths: 1, kills: 7, looted: 4 });
    expect(f.packets.filter((p) => p[0] === OP.stop)).toEqual([]);
  });
  it('does not renew a short macro deadline when manual travel changes the unsent source', () => {
    const f = controllerFixture('prt_fild08', own, 0);
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 20 }]);
    f.advance(10_000);
    f.c.manualCommand();
    f.transition('prt_fild06');
    f.advance(10_000);
    expect(f.c.macro.snapshot()).toMatchObject({
      state: 'failed',
      actionsIssued: 1,
      actionsCompleted: 0,
    });
    expect(f.teleports()).toHaveLength(0);
  });
  it('drains the sent Database receipt through official input and never replays it', () => {
    const f = controllerFixture();
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    f.step();
    f.c.manualCommand();
    for (let i = 0; i < 15; i++) {
      f.c.manualInput();
      f.step(100);
    }
    expect(f.c.travel.teleportPending).toBe(true);
    expect(f.teleports()).toHaveLength(1);
    expect(f.c.macro.active).toBe(true);
    f.transition('prt_fild05');
    expect(f.c.macro.snapshot()).toMatchObject({ state: 'completed', actionsCompleted: 1 });
    expect(f.teleports()).toHaveLength(1);
    expect(f.packets.filter((p) => p[0] === OP.stop)).toEqual([]);
  });
  it('keeps an unsent trip during manual NPC input and dispatches once after its authoritative close', () => {
    const f = controllerFixture('prt_fild08', own, 0);
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 60 }]);
    const trip = f.c.travel.tripId;
    f.advance(20_000);
    f.c.manualCommand();
    f.receive(new BitWriter().u8(77).u8(0).i32(3).bool(true));
    f.advance(15_000);
    expect(f.teleports()).toHaveLength(0);
    expect(f.c.travel.tripId).toBe(trip);
    expect(f.c.macro.active).toBe(true);
    f.receive(new BitWriter().u8(77).u8(3));
    expect(f.teleports()).toHaveLength(1);
    f.step();
    expect(f.teleports()).toHaveLength(1);
    expect(f.packets.filter((p) => p[0] === OP.stop)).toEqual([]);
  });
  it('completes explicit macro travel then activates farming on the requested map without renewing run counters', () => {
    const f = controllerFixture();
    f.macro([
      { type: 'travel', map: 'prt_fild05', timeoutSeconds: 30 },
      { type: 'farm', map: 'prt_fild05', targets: [4000], timeoutSeconds: 30 },
    ]);
    f.c.engine.deaths = 1;
    f.c.engine.kills = 5;
    f.c.engine.looted = 4;
    f.step();
    expect(f.teleports()).toHaveLength(1);
    expect(f.packets.some((p) => p[0] === OP.walk)).toBe(false);
    f.transition('prt_fild05', undefined, true);
    f.step();
    f.step();
    expect(f.c.snapshot()).toMatchObject({
      map: 'prt_fild05',
      running: true,
      deaths: 1,
      kills: 5,
      looted: 4,
      macro: { state: 'monitoring', actionsCompleted: 2 },
    });
  });
  it('uses Database travel for a farm stage and configured field destination', () => {
    const f = controllerFixture();
    f.macro([{ type: 'farm', map: 'prt_fild05', targets: [4000], timeoutSeconds: 30 }]);
    f.step();
    expect(f.teleports()).toHaveLength(1);
    f.transition('prt_fild05');
    f.step();
    expect(f.c.engine.running).toBe(true);
    f.c.stop();
    const g = controllerFixture();
    g.settings.automation.travel.destinationMap = 'prt_fild05';
    g.c.start(g.settings);
    g.step();
    expect(g.teleports()).toHaveLength(1);
    g.transition('prt_fild05');
    g.step();
    expect(g.c.engine.running).toBe(true);
  });
  it('Stop retains teleport uncertainty, blocks manual actions and Start, and never resumes a canceled macro', () => {
    const f = controllerFixture();
    f.macro([{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 30 }]);
    f.step();
    f.c.stop();
    expect(() => f.c.start(f.settings)).toThrow('settle');
    expect(() => f.c.perform('command', { type: 'useItem', itemId: 501 })).toThrow('settle');
    f.advance(25_000);
    expect(f.teleports()).toHaveLength(1);
    expect(f.c.settledForMaintenance()).toBe(false);
    f.transition('prt_fild05');
    f.step();
    expect(f.c.snapshot()).toMatchObject({
      running: false,
      runRequested: false,
      macro: { state: 'cancelled', actionsCompleted: 0 },
    });
  });
  it('macro service travel confirms a fresh actor before its local NPC approach', () => {
    const f = controllerFixture(),
      definition = BUILTIN_SERVICES.find((service) => service.id === 'kafra-south-storage')!;
    f.macro([
      {
        type: 'store',
        serviceId: definition.id,
        itemId: 501,
        quantity: 1,
        keep: 1,
        maxSpend: 100,
        timeoutSeconds: 30,
      },
    ]);
    f.step();
    f.step();
    expect(f.teleports()).toHaveLength(1);
    expect(f.c.macro.active).toBe(true);
    f.transition('prontera', { x: 145, y: 28 }, true);
    f.step();
    f.step();
    expect(f.c.service.snapshot().state).toBe('approach');
    expect(f.packets.some((p) => p[0] === OP.walk)).toBe(true);
    expect(f.c.macro.snapshot().actionsCompleted).toBe(0);
  });
  it('retains an unsent macro service approach through official travel and keeps its original step deadline', () => {
    const f = controllerFixture('prontera', { ...own, x: 145, y: 28 }, 0),
      definition = BUILTIN_SERVICES.find((service) => service.id === 'kafra-south-storage')!;
    f.macro([
      {
        type: 'store',
        serviceId: definition.id,
        itemId: 501,
        quantity: 1,
        keep: 1,
        maxSpend: 100,
        timeoutSeconds: 20,
      },
    ]);
    f.step();
    expect(f.c.service.preparingUnsent).toBe(true);
    f.c.manualCommand(true);
    f.transition('prt_fild08', { x: 170, y: 370 });
    expect(f.c.macro.active).toBe(true);
    expect(f.c.macro.snapshot()).toMatchObject({ actionsIssued: 1, actionsCompleted: 0 });
    expect(f.c.service.preparingUnsent).toBe(true);
    expect(f.c.service.snapshot().state).not.toBe('failed');
    const worldRequests = () =>
      f.packets.filter((p) => [76, 78, 79, 86, 87, 88, 89].includes(p[0]!));
    expect(worldRequests()).toEqual([]);
    f.step(300);
    const cells = f.c.travel.snapshot().leg,
      dirs = [
        [0, -1],
        [-1, -1],
        [-1, 0],
        [-1, 1],
        [0, 1],
        [1, 1],
        [1, 0],
        [1, -1],
      ],
      walk = new BitWriter()
        .u8(OP.walk)
        .i32(0)
        .position(cells[0]!)
        .f32(cells[0]!.x)
        .f32(cells[0]!.y)
        .f32(0.05)
        .f32(0.05)
        .u8(cells.length);
    const directions = cells
      .slice(1)
      .map((p, i) =>
        dirs.findIndex(([x, y]) => p.x - cells[i]!.x === x && p.y - cells[i]!.y === y),
      );
    for (let i = 0; i < directions.length; i += 2)
      walk.u8((directions[i]! << 4) | (directions[i + 1] ?? 0));
    f.receive(walk.u8(0));
    f.c.engine.receive([
      {
        type: 'castStart',
        id: 0,
        target: 0,
        skillId: 42,
        level: 1,
        facing: 0,
        flags: 0,
        position: { x: 170, y: 370 },
        remainingSeconds: 30,
      },
    ]);
    f.advance(19_600);
    expect(f.c.macro.snapshot()).toMatchObject({
      state: 'failed',
      actionsIssued: 1,
      actionsCompleted: 0,
    });
    expect(worldRequests()).toEqual([]);
    expect(f.c.macro.snapshot().reason).toBe(
      'Macro step confirmation timed out. Do not retry automatically.',
    );
  });
  it('death recovery returns to the captured farming map through the same Database transport', () => {
    const f = controllerFixture('prontera', { ...own, dead: true, hp: 0 });
    f.settings.automation.recovery.enabled = false;
    f.settings.automation.respawn = { enabled: true, maxDeaths: 2 };
    f.settings.automation.travel.returnToLockMap = true;
    f.c.start(f.settings);
    f.advance(2200);
    expect(f.packets.some((p) => p[0] === FEATURE_OP.respawn)).toBe(true);
    f.receive(new BitWriter().u8(OP.clear));
    f.receive(spawn(own, 2));
    f.step();
    f.step();
    f.advance(30_000);
    expect(f.teleports()).toHaveLength(1);
    f.transition('prt_fild08', { x: own.x, y: own.y });
    f.step();
    expect(f.c.engine.running).toBe(true);
    expect(f.c.snapshot().deathRecoveryGuard).toBeUndefined();
  });
  it.each([false, true])(
    'accounts for Database teleport within real supply ownership, pre-dispatch exhaustion=%s',
    (exhausted) => {
      const f = controllerFixture();
      f.receive(resources());
      f.settings.automation.supply = {
        ...DEFAULT_SUPPLY,
        enabled: true,
        maxActions: 1,
        maxSpend: 1000,
        buyService: 'trader.prt-fild05.tool-dealer.buy.v1',
      };
      f.settings.automation.disposition = {
        maxSpend: 1000,
        rules: [
          {
            itemId: 501,
            keep: 0,
            minimum: 6,
            desired: 10,
            maximum: 10,
            store: false,
            sell: false,
            cart: false,
            restock: 'buy',
            allowUnique: false,
          },
        ],
      };
      f.c.start(f.settings);
      expect(f.c.supply.ownsField).toBe(true);
      // A prior owner's command reservation consumes this same finite allowance.
      if (exhausted) expect(f.c.supply.commandAllowed()).toBe(true);
      f.advance(2_100);
      expect(f.c.supply.snapshot().actions).toBe(1);
      expect(f.teleports()).toHaveLength(exhausted ? 0 : 1);
      expect(f.c.travel.teleportPending).toBe(!exhausted);
      if (exhausted) expect(f.c.supply.snapshot().reason).toMatch(/allowance/);
    },
  );
});

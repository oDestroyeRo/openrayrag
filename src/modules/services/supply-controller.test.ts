import { describe, expect, it } from 'vitest';
import { BUILTIN_SERVICES } from './npc-services';
import { CompanionController } from '../runtime/controller';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  DEFAULT_ESCAPE,
  settingsDraft,
  type Settings,
} from '../settings/settings';
import { DEFAULT_SUPPLY } from './supply-trip';
import { BitWriter } from '../../shared/binary';
import { OP, type Entity } from '../protocol/protocol';
import { FEATURE_OP } from '../protocol/protocol-feature';
import { WORLD_OP, type WorldAction } from '../protocol/world-protocol';
import type { Action } from '../automation/engine';
import type { DatabaseTravelTransport } from '../navigation/travel-controller';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy-logic';
import { PersistentFieldRun } from '../session/reconnect';
const player: Entity = {
  id: 1,
  classId: 1,
  name: 'Tester',
  kind: 0,
  level: 10,
  hp: 100,
  maxHp: 100,
  x: 289,
  y: 220,
  dead: false,
};
const npc: Entity = {
  ...player,
  id: 20,
  name: 'Tool Dealer',
  kind: 2,
  x: 290,
  y: 221,
};
function spawn(e: Entity, entryType = 0) {
  const name = new TextEncoder().encode(e.name);
  const body = new BitWriter()
    .u8(15)
    .i32(e.id)
    .i32(e.classId)
    .i32(0)
    .i32(~name.length)
    .i32(e.name.length)
    .take(name)
    .u8(e.kind)
    .u8(0)
    .u8(0)
    .i32(e.x)
    .i32(e.y)
    .u8(e.level)
    .i32(e.hp)
    .i32(e.maxHp)
    .i32(100)
    .i32(100)
    .i32(-1)
    .u8(e.id === 1 ? 1 : 0)
    .finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
function stats(
  count = 4,
  zeny = 1000,
  options: {
    maxWeight?: number;
    weight?: number;
    items?: Array<{ itemId: number; count: number }>;
    wings?: number;
    returnSkill?: boolean;
    sp?: number;
  } = {},
) {
  const items = options.items ?? [
    ...(count ? [{ itemId: 501, count }] : []),
    ...(options.wings ? [{ itemId: 602, count: options.wings }] : []),
  ];
  const w = new BitWriter().u8(FEATURE_OP.stats);
  for (const n of [
    10,
    1,
    zeny,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    100,
    100,
    options.sp ?? 100,
    100,
    ...Array(16).fill(0),
    options.maxWeight ?? 10000,
  ])
    w.i32(n);
  w.f32(0.4)
    .i32(options.weight ?? count * 70)
    .i32(0)
    .bool(true)
    .i16(options.returnSkill ? 2 : 1)
    .i16(1)
    .u8(5);
  if (options.returnSkill) w.i16(54).u8(1);
  w.i16(0).bool(true).u8(1).i32(items.length);
  for (const item of items) w.i32(item.itemId).i16(item.count);
  w.i32(0).u8(0);
  for (let i = 0; i < 10; i++) w.i32(0);
  return w.i32(-1).finish();
}
const settings = {
  ...DEFAULT_SETTINGS,
  map: 'prt_fild05',
  targets: [4000],
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    supply: {
      ...DEFAULT_SUPPLY,
      enabled: true,
      maxTrips: 2,
      maxSpend: 1000,
      buyService: 'trader.prt-fild05.tool-dealer.buy.v1',
    },
    disposition: {
      maxSpend: 1000,
      rules: [
        {
          itemId: 501,
          keep: 0,
          minimum: 5,
          desired: 10,
          maximum: 10,
          store: false,
          sell: false,
          cart: false,
          restock: 'buy' as const,
          allowUnique: false,
        },
      ],
    },
  },
};
function setup(
  runSettings: Settings = settings,
  map = 'prt_fild05',
  position = player,
  database?: DatabaseTravelTransport,
) {
  let now = 100_000,
    throwBuy = false,
    throwReturn = false;
  const sent: Array<Action | WorldAction> = [];
  const c = new CompanionController(
    (a) => {
      sent.push(a);
      if (throwBuy && a.type === 'shop' && a.rows.length)
        throw Error('Synthetic transport exception');
      if (throwReturn && (a.type === 'useItem' || (a.type === 'skill' && a.skillId === 54)))
        throw Error('Synthetic return transport exception');
    },
    () => now,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    database,
  );
  c.connect(true);
  const packet = (p: Uint8Array) => c.receive(p);
  packet(new BitWriter().u8(OP.enter).i32(1).string(map).finish());
  packet(spawn(position));
  if (map === 'prt_fild05') packet(spawn(npc));
  packet(stats());
  const step = (ms = 100) => {
    now += ms;
    c.tick();
  };
  const advance = (ms: number) => {
    while (ms > 0) {
      const part = Math.min(ms, 100);
      step(part);
      ms -= part;
    }
  };
  const begin = () => {
    c.start(runSettings);
    for (let i = 0; i < 12 && !sent.some((a) => a.type === 'npcTalk'); i++) step();
    expect(sent.filter((a) => a.type === 'npcTalk')).toHaveLength(1);
  };
  const open = (price = 50) => {
    packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
    for (const s of ['Buy', 'Sell', 'Cancel']) w.string(s);
    packet(w.finish());
    for (let i = 0; i < 4; i++) step();
    expect(sent.some((a) => a.type === 'npcOption' && a.index === 0)).toBe(true);
    packet(new BitWriter().u8(WORLD_OP.shop).u8(1).u8(0).i32(1).i32(501).i32(price).finish());
    for (let i = 0; i < 5; i++) step();
  };
  const end = () => packet(new BitWriter().u8(WORLD_OP.npc).u8(3).finish());
  const settleWalk = () => {
    const cells = c.travel.snapshot().leg;
    if (cells.length < 2) throw Error('No travel leg');
    const w = new BitWriter()
      .u8(OP.walk)
      .i32(1)
      .i16(cells[0]!.x)
      .i16(cells[0]!.y)
      .f32(cells[0]!.x)
      .f32(cells[0]!.y)
      .f32(0.05)
      .f32(0)
      .u8(cells.length);
    const dirs = [
      [0, -1],
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [0, 1],
      [1, 1],
      [1, 0],
      [1, -1],
    ];
    const d = cells
      .slice(1)
      .map((p, i) =>
        dirs.findIndex(([x, y]) => p.x - cells[i]!.x === x && p.y - cells[i]!.y === y),
      );
    for (let i = 0; i < d.length; i += 2) w.u8((d[i]! << 4) | (d[i + 1] ?? 0));
    packet(w.u8(0).finish());
    step(2000);
  };
  return {
    c,
    sent,
    packet,
    step,
    advance,
    begin,
    open,
    end,
    settleWalk,
    setThrow: () => {
      throwBuy = true;
    },
    setThrowReturn: () => {
      throwReturn = true;
    },
    buy: () => sent.filter((a) => a.type === 'shop' && a.rows.length),
  };
}
function autoSellFixture(
  transport: 'travel' | 'butterfly' | 'returnSkill' = 'butterfly',
  hardStop = 95,
) {
  const configured: Settings = {
    ...settings,
    map: 'prt_fild08',
    automation: {
      ...structuredClone(settings.automation),
      combat: { ...settings.automation.combat, mode: 'off' },
      loot: { ...settings.automation.loot, defaultAction: 'ignore' },
      limits: { minutes: 10, kills: 20, pickups: 30, weightPercent: hardStop },
      supply: {
        ...DEFAULT_SUPPLY,
        enabled: true,
        stockEnabled: false,
        weightEnabled: true,
        merchantMode: 'automatic',
        transport,
        saveMap: 'prontera',
        maxTrips: 2,
      },
      disposition: {
        maxSpend: 0,
        rules: [
          {
            ...settings.automation.disposition.rules[0]!,
            keep: 2,
            minimum: 2,
            desired: 2,
            maximum: 2,
            sell: true,
            restock: 'off',
          },
        ],
      },
    },
  };
  const f = setup(configured, 'prt_fild08', { ...player, x: 156, y: 374 });
  const observations = (count = 12, zeny = 1000, wings = 2, sp = 100) =>
    f.packet(stats(count, zeny, { maxWeight: 1000, wings, returnSkill: true, sp }));
  observations();
  const start = () => {
    f.c.start(configured);
    f.advance(900);
  };
  const arrival = (map = 'prontera', withNpc = true) => {
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.inventoryDelta)
        .bool(false)
        .i32(602)
        .i16(1)
        .i32(840)
        .bool(false)
        .finish(),
    );
    f.packet(new BitWriter().u8(OP.map).string(map).finish());
    f.packet(spawn({ ...player, x: 103, y: 48 }));
    if (withNpc) f.packet(spawn({ ...npc, name: 'Fruit Gardener', x: 104, y: 49 }));
    observations(12, 1000, 1);
    f.advance(900);
  };
  const openSale = (menu = ['Buy', 'Sell', 'Cancel'], overcharge = 0) => {
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(menu.length);
    for (const label of menu) w.string(label);
    f.packet(w.finish());
    f.advance(500);
    if (menu[1] === 'Sell') {
      expect(f.sent).toContainEqual({ type: 'npcOption', index: 1 });
      f.packet(new BitWriter().u8(WORLD_OP.shop).u8(0).i32(overcharge).finish());
      f.advance(600);
    }
  };
  const walkUntil = (predicate: () => boolean) => {
    for (let i = 0; i < 180 && !predicate(); i++) {
      if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
      else f.step();
    }
    expect(predicate(), f.c.supply.snapshot().reason + ' ' + f.c.travel.snapshot().reason).toBe(
      true,
    );
  };
  const sales = () => f.sent.filter((a) => a.type === 'shop' && a.mode === 'sell' && a.rows.length);
  return { ...f, configured, observations, start, arrival, openSale, walkUntil, sales };
}

describe('owned auto-sell save-point trips', () => {
  it.each(['buy', 'storage'] as const)(
    'preserves an explicit remote %s service while automatic selling is enabled',
    (mode) => {
      const contractId =
        mode === 'buy' ? 'trader.prt-fild05.tool-dealer.buy.v1' : 'kafra.prontera-south.storage.v1';
      const definition = BUILTIN_SERVICES.find((service) => service.contractId === contractId)!;
      const configured = {
        ...settings,
        map: 'prt_fild08',
        automation: {
          ...settings.automation,
          supply: {
            ...settings.automation.supply,
            merchantMode: 'automatic' as const,
            storageService: mode === 'storage' ? contractId : '',
          },
          disposition: {
            ...settings.automation.disposition,
            rules: [
              {
                ...settings.automation.disposition.rules[0]!,
                restock: mode === 'storage' ? ('storage' as const) : ('buy' as const),
              },
            ],
          },
        },
      };
      const requests: string[] = [];
      const f = setup(
        configured,
        'prt_fild08',
        { ...player, x: 156, y: 374 },
        { supported: (map) => map === definition.map, send: (map) => requests.push(map) },
      );
      f.c.start(configured);
      f.advance(1000);
      expect(requests).toEqual([definition.map]);
      f.packet(new BitWriter().u8(OP.remove).i32(player.id).u8(0).finish());
      f.packet(new BitWriter().u8(OP.map).string(definition.map).finish());
      f.c.observeOfficialPacket(new Uint8Array([2]));
      f.packet(spawn({ ...player, x: definition.approach.x, y: definition.approach.y }, 1));
      f.packet(
        spawn({
          ...npc,
          name: definition.identity.name,
          x: definition.identity.anchor!.x,
          y: definition.identity.anchor!.y,
        }),
      );
      f.packet(stats());
      f.advance(1200);
      expect(Reflect.get(f.c, 'supplyIntent').contractId).toBe(contractId);
      expect(f.sent).toContainEqual({ type: 'npcTalk', id: 20 });
      expect(requests).toHaveLength(1);
      expect(f.c.supply.snapshot().remainingTrips).toBe(1);
    },
  );
  it.each(['prt_fild08', 'iz_dun00'])(
    'reselects the nearest merchant from an actual Database landing departing %s',
    (origin) => {
      const requests: string[] = [];
      const configured = autoSellFixture('travel').configured;
      configured.map = origin;
      configured.automation!.mapPolicy = { ...DEFAULT_MAP_POLICY, allow: [origin, 'prontera'] };
      const position = origin === 'prt_fild08' ? { x: 156, y: 374 } : { x: 281, y: 47 };
      const f = setup(
        configured,
        origin,
        { ...player, ...position },
        { supported: (map) => map === 'prontera', send: (map) => requests.push(map) },
      );
      f.packet(stats(12, 1000, { maxWeight: 1000 }));
      f.c.start(configured);
      f.advance(1000);
      expect(requests).toEqual(['prontera']);
      const planned = Reflect.get(f.c, 'supplyIntent').contractId;
      expect(planned).not.toContain('milk-ranch');
      f.packet(new BitWriter().u8(OP.remove).i32(player.id).u8(0).finish());
      f.packet(new BitWriter().u8(OP.map).string('prontera').finish());
      f.c.observeOfficialPacket(new Uint8Array([2]));
      f.packet(spawn({ ...player, x: 72, y: 133 }, 1));
      f.packet(spawn({ ...npc, name: 'Vendor from Milk Ranch', x: 73, y: 134 }));
      f.packet(stats(12, 1000, { maxWeight: 1000 }));
      f.advance(1200);
      expect(f.c.supply.snapshot().state, f.c.supply.snapshot().reason).toBe('service');
      expect(Reflect.get(f.c, 'supplyIntent').contractId).toBe(
        'trader.prontera.milk-ranch-vendor.sell.v1',
      );
      expect(f.sent).toContainEqual({ type: 'npcTalk', id: 20 });
      expect(requests).toHaveLength(1);
      expect(f.c.supply.snapshot()).toMatchObject({
        remainingTrips: 1,
        returnDestination: { map: origin, position },
      });
    },
  );
  it('returns alive, selects a fresh merchant, confirms one protected sale and returns to the captured field cell without renewing the run', () => {
    const f = autoSellFixture();
    f.start();
    expect(f.sent).toContainEqual({ type: 'useItem', itemId: 602 });
    expect(f.c.supply.snapshot()).toMatchObject({
      state: 'departing',
      remainingTrips: 1,
      actions: 1,
    });
    expect(f.sent.some((a) => a.type === 'respawn' || a.type === 'npcTalk')).toBe(false);
    f.arrival();
    expect(f.sent).toContainEqual({ type: 'npcTalk', id: 20 });
    expect(f.c.escape.snapshot().latched).toBe(false);
    f.openSale();
    expect(f.sales()).toEqual([{ type: 'shop', mode: 'sell', rows: [{ id: 501, count: 10 }] }]);
    expect(f.c.engine.running).toBe(false);
    f.end();
    f.observations(2, 1250, 1);
    f.walkUntil(() => f.c.travel.snapshot().state === 'transition');
    f.packet(new BitWriter().u8(OP.map).string('prt_fild08').finish());
    f.packet(spawn({ ...player, x: 170, y: 375 }));
    f.walkUntil(() => f.c.supply.snapshot().state === 'complete');
    f.advance(600);
    expect(f.c.engine.running).toBe(true);
    expect(f.c.engine.player).toMatchObject({ x: 156, y: 374 });
    expect(f.c.supply.snapshot()).toMatchObject({
      remainingTrips: 1,
      spent: 0,
      reserved: 0,
      returnDestination: { map: 'prt_fild08', position: { x: 156, y: 374 } },
    });
    expect(f.c.engine.settings.automation?.limits).toEqual(f.configured.automation?.limits);
    expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
  });
  it.each([80, 75])('honors hard weight stop %s before departure', (hardStop) => {
    const f = autoSellFixture('butterfly', hardStop);
    f.start();
    expect(f.sent.some((a) => a.type === 'useItem' || a.type === 'npcTalk')).toBe(false);
    expect(f.c.supply.snapshot().remainingTrips).toBe(2);
    expect(f.c.engine.running).toBe(false);
  });
  it('rechecks the hard stop while the first return is preparing', () => {
    const f = autoSellFixture('butterfly', 90);
    f.c.start(f.configured);
    f.step();
    f.step();
    f.observations(14);
    f.advance(1000);
    expect(f.sent.some((a) => a.type === 'useItem')).toBe(false);
    expect(f.c.supply.snapshot().reason).toContain('hard weight stop');
  });
  it.each(['stop', 'timeout', 'rejection', 'death', 'disconnect', 'send-throw'] as const)(
    'never repeats a sent save return after %s',
    (boundary) => {
      const f = autoSellFixture();
      if (boundary === 'send-throw') f.setThrowReturn();
      f.start();
      expect(f.c.supply.snapshot().remainingTrips).toBe(1);
      if (boundary === 'stop') f.c.stop();
      if (boundary === 'timeout') f.advance(31_000);
      if (boundary === 'rejection')
        f.packet(new BitWriter().u8(FEATURE_OP.requestFailure).u8(1).finish());
      if (boundary === 'death') f.packet(new BitWriter().u8(OP.death).i32(1).finish());
      if (boundary === 'disconnect') f.c.connect(false);
      f.advance(1000);
      expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
      expect(f.sales()).toHaveLength(0);
      expect(f.c.engine.running).toBe(false);
      if (boundary === 'stop') {
        expect(() => f.c.start(f.configured)).toThrow(/save-point return/);
        f.arrival();
        expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
        expect(f.sent.some((a) => a.type === 'npcTalk')).toBe(false);
        expect(f.c.engine.running).toBe(false);
      }
    },
  );
  it('rejects the wrong save map and never sells there', () => {
    const f = autoSellFixture();
    f.start();
    f.arrival('izlude');
    expect(f.c.supply.snapshot().reason).toContain('different map');
    expect(f.sales()).toHaveLength(0);
  });
  it.each(['stock', 'skill', 'sp'] as const)('waits when return %s is unavailable', (boundary) => {
    const f = autoSellFixture(boundary === 'stock' ? 'butterfly' : 'returnSkill');
    if (boundary === 'stock') f.observations(12, 1000, 1);
    if (boundary === 'skill') f.packet(stats(12, 1000, { maxWeight: 1000, wings: 2 }));
    if (boundary === 'sp') f.observations(12, 1000, 2, 0);
    f.start();
    expect(f.sent.some((a) => a.type === 'useItem' || a.type === 'skill')).toBe(false);
    expect(f.c.supply.snapshot().state).toBe('waiting');
  });
  it('uses the separate learned Return skill while alive and never sends Respawn', () => {
    const f = autoSellFixture('returnSkill');
    f.start();
    expect(f.sent).toContainEqual({ type: 'skill', mode: 'self', skillId: 54, level: 1 });
    expect(f.sent.some((a) => a.type === 'respawn' || a.type === 'useItem')).toBe(false);
    f.observations(12, 1000, 2, 90);
    f.advance(500);
    expect(f.c.supply.snapshot().state).toBe('departing');
    expect(f.sent.some((a) => a.type === 'npcTalk')).toBe(false);
    f.arrival();
    f.openSale();
    expect(f.sales()).toHaveLength(1);
    expect(f.sent.filter((a) => a.type === 'skill')).toHaveLength(1);
  });
  it('disarms a page-reloaded supply return with emergency escape off and retains the spent trip allowance', () => {
    const f = autoSellFixture();
    expect(f.configured.automation!.escape!.enabled).toBe(false);
    const run = new PersistentFieldRun(() => 100000);
    run.begin(f.configured, 'Tester', 'old');
    f.start();
    run.observe({
      sessionId: 'old',
      connected: true,
      compatible: true,
      map: 'prt_fild08',
      player: { name: 'Tester', dead: false },
      supplyGuard: f.c.supply.guard(),
      escape: f.c.escape.snapshot(),
    });
    const restored = new PersistentFieldRun(() => 100000);
    restored.restore(run.checkpoint());
    const request = restored.resumeFor({
      sessionId: 'new',
      connected: true,
      compatible: true,
      map: 'prontera',
      player: { name: 'Tester', dead: false },
    })!;
    expect(request.supplyGuard).toMatchObject({
      interrupted: true,
      uncertain: true,
      remainingTrips: 1,
    });
    const next = setup(settingsDraft(request.settings), 'prontera', { ...player, x: 103, y: 48 });
    next.packet(stats(12, 1000, { maxWeight: 1000, wings: 1 }));
    next.c.start(
      settingsDraft(request.settings),
      request.escapeGuard,
      request.supplyGuard,
      request.deathRecoveryGuard,
    );
    next.advance(2000);
    expect(next.sent).toEqual([]);
    expect(next.c.engine.running).toBe(false);
    expect(next.c.supply.snapshot().remainingTrips).toBe(1);
  });
  it.each(['menu', 'missing npc'] as const)(
    'waits with no sale when %s changes at arrival',
    (boundary) => {
      const f = autoSellFixture();
      f.start();
      f.arrival('prontera', boundary !== 'missing npc');
      if (boundary === 'menu') f.openSale(['Buy', 'Different', 'Cancel']);
      else
        for (let i = 0; i < 8; i++) {
          f.observations(12, 1000, 1);
          f.advance(5000);
        }
      expect(f.sales()).toHaveLength(0);
      expect(f.c.engine.running).toBe(false);
      expect(f.c.supply.snapshot().state).toBe('waiting');
    },
  );
  it('retains an uncertain sale through Stop and drains only an exact late inventory/zeny receipt', () => {
    const f = autoSellFixture();
    f.start();
    f.arrival();
    f.openSale();
    f.c.stop();
    f.end();
    f.observations(2, 1249, 1);
    expect(f.c.supply.uncertain).toBe(true);
    f.observations(2, 1250, 1);
    f.advance(1000);
    expect(f.c.supply.uncertain).toBe(false);
    expect(f.sales()).toHaveLength(1);
    expect(f.c.engine.running).toBe(false);
  });
});
describe('controller supply repair regressions', () => {
  it.each([500, 85])(
    'holds the field through a long captured-cell return under the remaining %i-command cap',
    (maxActions) => {
      const configured = autoSellFixture('travel', 0).configured;
      configured.map = 'iz_dun00';
      configured.automation!.limits!.minutes = 0;
      configured.automation!.supply = {
        ...configured.automation!.supply!,
        maxTrips: 100,
        maxActions,
        maxDurationSeconds: 600,
        weightEndPercent: 75,
      };
      const origin = { x: 303, y: 77 };
      const f = setup(configured, 'iz_dun00', { ...player, x: 247, y: 318 });
      const protectedItems = [{ itemId: 501, count: 2 }];
      const observations = () =>
        f.packet(stats(0, 213305, { maxWeight: 34900, weight: 25740, items: protectedItems }));
      observations();
      // Exact economics and NPC closure were settled before this explicit recovery.
      f.c.start(configured, undefined, {
        version: 1,
        character: 'Tester',
        latched: true,
        remainingTrips: 99,
        actions: 81,
        spent: 0,
        reserved: 0,
        intervalSeconds: 0,
        deadlineSeconds: 0,
        interrupted: false,
        uncertain: false,
        returnDestination: { map: 'iz_dun00', position: origin },
      });
      expect(f.c.supply.snapshot()).toMatchObject({
        remainingTrips: 98,
        actions: 81,
        uncertain: false,
        returnDestination: { map: 'iz_dun00', position: origin },
      });
      expect(f.c.engine.running).toBe(false);
      for (
        let i = 0;
        i < 300 && !['complete', 'waiting'].includes(f.c.supply.snapshot().state);
        i++
      ) {
        expect(f.c.engine.running).toBe(false);
        observations();
        if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
        else f.step();
      }
      const walks = f.sent.filter((action) => action.type === 'walk');
      expect(
        f.sent.some((action) => ['shop', 'npcTalk', 'useItem', 'skill'].includes(action.type)),
      ).toBe(false);
      expect(f.c.supply.snapshot()).toMatchObject({ remainingTrips: 98, spent: 0, reserved: 0 });
      expect(f.c.engine.character.snapshot().inventory).toEqual(
        protectedItems.map((item) => ({ ...item, bagId: item.itemId, type: 1 })),
      );
      if (maxActions === 500) {
        f.advance(600);
        expect(f.c.supply.snapshot().state).toBe('complete');
        expect(f.c.engine.player).toMatchObject(origin);
        expect(f.c.engine.running).toBe(true);
        expect(walks).toHaveLength(100);
        expect(f.c.supply.snapshot().actions).toBe(81 + walks.length);
      } else {
        expect(f.c.supply.snapshot()).toMatchObject({ state: 'waiting', actions: 85 });
        expect(f.c.supply.snapshot().reason).toContain('allowance');
        expect(f.c.engine.running).toBe(false);
        expect(f.c.engine.player).not.toMatchObject(origin);
        const sentBefore = [...f.sent];
        f.advance(1000);
        expect(f.sent).toEqual(sentBefore);
        expect(f.c.supply.snapshot().actions).toBe(85);
        f.c.stop();
        const sentBeforeRestart = [...f.sent];
        f.c.start(configured);
        f.advance(1000);
        expect(f.c.supply.snapshot()).toMatchObject({ actions: 85, remainingTrips: 98 });
        expect(f.c.engine.running).toBe(false);
        expect(f.sent).toEqual(sentBeforeRestart);
      }
    },
  );
  it.each([
    [false, 'complete'],
    [true, 'complete'],
    [true, 'unquoted'],
    [true, 'stop'],
    [true, 'timeout'],
  ] as const)(
    'sell-all permitted %s with second service %s retains exact ownership after crossing the weight goal',
    (sellAllPermitted, outcome) => {
      const configured = autoSellFixture('travel', 0).configured;
      configured.map = 'prt_fild05';
      configured.automation!.supply = {
        ...configured.automation!.supply!,
        merchantMode: 'manual',
        sellService: 'trader.prt-fild05.tool-dealer.sell.v1',
        weightEndPercent: 60,
        sellAllPermitted,
      };
      configured.automation!.disposition!.rules = [918, 1052].map((itemId) => ({
        ...configured.automation!.disposition!.rules[0]!,
        itemId,
        keep: 0,
        minimum: 0,
        desired: 0,
        maximum: 0,
      }));
      const f = setup(configured);
      const protectedItems = [
        { itemId: 501, count: 2 },
        { itemId: 4001, count: 1 },
      ];
      const observations = (stage: number, zeny: number) =>
        f.packet(
          stats(0, zeny, {
            maxWeight: 1000,
            weight: [900, 500, 300][stage],
            items: [
              ...protectedItems,
              ...(stage === 0 ? [{ itemId: 918, count: 10 }] : []),
              ...(stage < 2 ? [{ itemId: 1052, count: 10 }] : []),
            ],
          }),
        );
      const sales = () => f.sent.filter((action) => action.type === 'shop' && action.rows.length);
      const until = (predicate: () => boolean) => {
        for (let i = 0; i < 90 && !predicate(); i++) {
          if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
          else f.step();
        }
        expect(predicate(), f.c.supply.snapshot().reason).toBe(true);
      };
      const openSell = (quoted = true) => {
        f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
        const menu = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
        for (const label of ['Buy', 'Sell', 'Cancel']) menu.string(label);
        f.packet(menu.finish());
        f.advance(500);
        if (quoted) f.packet(new BitWriter().u8(WORLD_OP.shop).u8(0).i32(0).finish());
        f.advance(600);
      };
      observations(0, 1000);
      f.c.start(configured);
      until(() => f.sent.some((action) => action.type === 'npcTalk'));
      openSell();
      expect(sales()).toEqual([{ type: 'shop', mode: 'sell', rows: [{ id: 918, count: 10 }] }]);
      // Catalog price is authoritative; the exact receipt requires both new stock and currency.
      // Sticky Webfoot sells for 20z at the observed zero overcharge shop.
      f.end();
      observations(1, 1200);
      f.advance(1000);
      expect(f.c.supply.uncertain).toBe(false);
      if (sellAllPermitted) {
        until(() => f.sent.filter((action) => action.type === 'npcTalk').length === 2);
        if (outcome === 'stop') {
          f.c.stop();
          const stopped = [...f.sent];
          f.advance(1500);
          expect(f.sent).toEqual(stopped);
          expect(sales()).toHaveLength(1);
          expect(f.c.engine.running).toBe(false);
          return;
        }
        openSell(outcome !== 'unquoted');
        if (outcome === 'unquoted') {
          f.advance(1500);
          expect(sales()).toHaveLength(1);
          expect(f.c.supply.snapshot().state).not.toBe('complete');
          expect(f.c.engine.running).toBe(false);
          return;
        }
        expect(sales()).toHaveLength(2);
        expect(sales()[1]).toEqual({ type: 'shop', mode: 'sell', rows: [{ id: 1052, count: 10 }] });
        if (outcome === 'timeout') {
          f.advance(11000);
          expect(sales()).toHaveLength(2);
          expect(f.c.engine.running).toBe(false);
          expect(f.c.supply.snapshot().state).toBe('waiting');
          return;
        }
        f.end();
        observations(2, 1660);
        f.advance(1000);
      }
      until(() => f.c.supply.snapshot().state === 'complete');
      f.advance(600);
      expect(f.c.engine.running).toBe(true);
      expect(f.c.supply.snapshot()).toMatchObject({
        state: 'complete',
        uncertain: false,
        remainingTrips: 1,
      });
      expect(f.c.engine.character.snapshot().inventory).toEqual(
        [...protectedItems, ...(sellAllPermitted ? [] : [{ itemId: 1052, count: 10 }])].map(
          (item) => ({ ...item, bagId: item.itemId, type: 1 }),
        ),
      );
      expect(sales()).toHaveLength(sellAllPermitted ? 2 : 1);
    },
  );
  it('retains the protected-weight blocker and explicitly recovers under a corrected strict finish threshold', () => {
    const configured = autoSellFixture('travel', 0).configured;
    configured.map = 'prt_fild05';
    configured.automation!.supply = {
      ...configured.automation!.supply!,
      merchantMode: 'manual',
      sellService: 'trader.prt-fild05.tool-dealer.sell.v1',
      weightEndPercent: 70,
      minimumIntervalSeconds: 1,
      maxDurationSeconds: 30,
    };
    configured.automation!.disposition!.rules = [
      {
        ...configured.automation!.disposition!.rules[0]!,
        itemId: 1052,
        keep: 0,
        minimum: 0,
        desired: 0,
        maximum: 0,
      },
    ];
    const origin = { x: 285, y: 220 };
    const f = setup(configured, 'prt_fild05', { ...player, ...origin });
    const protectedItems = [{ itemId: 501, count: 367 }];
    const observations = (sold = false, zeny = 1000) =>
      f.packet(
        stats(0, zeny, {
          maxWeight: 34900,
          weight: sold ? 25740 : 30000,
          items: [...protectedItems, ...(sold ? [] : [{ itemId: 1052, count: 10 }])],
        }),
      );
    const walkUntil = (predicate: () => boolean) => {
      for (let i = 0; i < 90 && !predicate(); i++) {
        if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
        else f.step();
      }
      expect(predicate(), f.c.supply.snapshot().reason).toBe(true);
    };
    observations();
    f.c.start(configured);
    walkUntil(() => f.sent.some((action) => action.type === 'npcTalk'));
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const menu = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
    for (const label of ['Buy', 'Sell', 'Cancel']) menu.string(label);
    f.packet(menu.finish());
    f.advance(500);
    f.packet(new BitWriter().u8(WORLD_OP.shop).u8(0).i32(0).finish());
    f.advance(600);
    const sales = () => f.sent.filter((action) => action.type === 'shop' && action.rows.length);
    expect(sales()).toEqual([{ type: 'shop', mode: 'sell', rows: [{ id: 1052, count: 10 }] }]);
    f.end();
    f.packet(new BitWriter().u8(FEATURE_OP.currency).i32(1460).finish());
    f.advance(500);
    expect(f.c.supply.uncertain).toBe(true);
    observations(true, 1460);
    f.advance(1000);
    const before = f.c.supply.snapshot();
    const counters = () => ({
      kills: f.c.engine.kills,
      pickups: f.c.engine.looted,
      deaths: f.c.engine.deaths,
    });
    const beforeCounters = counters();
    expect(before).toMatchObject({ state: 'waiting', uncertain: false, remainingTrips: 1 });
    expect(before.reason).toContain('73.75% (25740/34900)');
    expect(before.reason).toContain('below 70%');
    expect(f.c.engine.running).toBe(false);
    const sentBeforeDeadline = [...f.sent];
    // Refresh normal observations while the original trip deadline elapses.
    for (let i = 0; i < 4; i++) {
      observations(true, 1460);
      f.advance(10000);
    }
    expect(f.c.supply.snapshot()).toMatchObject({
      state: 'waiting',
      reason: before.reason,
      uncertain: false,
      actions: before.actions,
      remainingTrips: before.remainingTrips,
      spent: before.spent,
      reserved: before.reserved,
    });
    expect(f.sent).toEqual(sentBeforeDeadline);
    expect(counters()).toEqual(beforeCounters);

    f.c.stop();
    const corrected = settingsDraft(configured);
    corrected.automation!.supply!.weightEndPercent = 75;
    f.c.start(corrected);
    expect(f.c.supply.snapshot()).toMatchObject({
      actions: before.actions,
      remainingTrips: 0,
      returnDestination: { map: 'prt_fild05', position: origin },
    });
    expect(f.c.engine.running).toBe(false);
    // The protected-only weight now meets the explicit new goal; no new sale is permitted.
    walkUntil(() => f.c.supply.snapshot().state === 'complete');
    f.advance(600);
    expect(f.c.engine.player).toMatchObject(origin);
    expect(f.c.engine.running).toBe(true);
    expect(f.c.supply.snapshot()).toMatchObject({ state: 'complete', remainingTrips: 0, spent: 0 });
    expect(f.c.supply.snapshot().actions).toBeGreaterThanOrEqual(before.actions);
    expect(counters()).toEqual(beforeCounters);
    expect(sales()).toHaveLength(1);
    expect(f.c.engine.character.snapshot().inventory).toEqual(
      protectedItems.map((item) => ({ ...item, bagId: item.itemId, type: 1 })),
    );
  });
  it('recovers a blocked actual Database landing only after Stop, manual relocation and a charged explicit Start', () => {
    const configured = autoSellFixture('travel', 0).configured;
    configured.map = 'iz_dun00';
    configured.automation!.supply!.maxDurationSeconds = 30;
    const requests: string[] = [];
    const origin = { x: 281, y: 47 };
    const f = setup(
      configured,
      'iz_dun00',
      { ...player, ...origin },
      {
        supported: (map) => ['izlude', 'prontera', 'iz_dun00'].includes(map),
        send: (map) => requests.push(map),
      },
    );
    const observations = (count = 12, zeny = 1000) =>
      f.packet(stats(count, zeny, { maxWeight: 1000 }));
    const arrival = (map: string, x: number, y: number, count = 12, zeny = 1000) => {
      f.packet(new BitWriter().u8(OP.remove).i32(player.id).u8(0).finish());
      f.packet(new BitWriter().u8(OP.map).string(map).finish());
      f.c.observeOfficialPacket(new Uint8Array([2]));
      f.packet(spawn({ ...player, x, y }, 1));
      observations(count, zeny);
      f.advance(1200);
    };
    observations();
    f.c.start(configured);
    f.advance(1000);
    expect(requests).toEqual(['izlude']);
    arrival('izlude', 145, 181);
    expect(f.c.supply.snapshot()).toMatchObject({ state: 'waiting', remainingTrips: 1 });
    expect(f.c.supply.snapshot().reason).toContain('izlude (145, 181)');
    expect(f.c.supply.snapshot().reason).toContain('Stop');
    expect(f.sent.some((a) => ['walk', 'npcTalk', 'shop'].includes(a.type))).toBe(false);
    f.advance(2000);
    expect(requests).toEqual(['izlude']);
    f.c.stop();
    // Normal manual Database relocation is observed; automation sends no retry.
    arrival('prontera', 112, 41);
    f.packet(spawn({ ...npc, name: 'Flower Girl', x: 113, y: 42 }));
    const corrected = settingsDraft(configured);
    corrected.automation!.supply!.merchantMode = 'manual';
    corrected.automation!.supply!.sellService = 'trader.prontera.flower-girl-south.sell.v1';
    f.c.start(corrected);
    expect(f.c.supply.snapshot()).toMatchObject({
      state: 'waiting',
      remainingTrips: 1,
      latched: true,
      returnDestination: { map: 'iz_dun00', position: origin },
    });
    expect(f.c.engine.running).toBe(false);
    // The old 30-second deadline must not cancel permission while the 300-second interval ages.
    for (let i = 0; i < 30; i++) {
      observations();
      f.advance(10000);
    }
    observations();
    f.advance(1200);
    expect(requests).toEqual(['izlude']);
    expect(f.c.supply.snapshot()).toMatchObject({ remainingTrips: 0, latched: true });
    expect(f.sent.filter((a) => a.type === 'npcTalk')).toEqual([{ type: 'npcTalk', id: 20 }]);
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const menu = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
    for (const label of ['Buy', 'Sell', 'Cancel']) menu.string(label);
    f.packet(menu.finish());
    f.advance(500);
    f.packet(new BitWriter().u8(WORLD_OP.shop).u8(0).i32(0).finish());
    f.advance(600);
    const sales = () => f.sent.filter((a) => a.type === 'shop' && a.rows.length);
    expect(sales()).toEqual([{ type: 'shop', mode: 'sell', rows: [{ id: 501, count: 10 }] }]);
    const spentActions = f.c.supply.snapshot().actions;
    // Neither closure nor a currency-only update proves the sale.
    f.end();
    f.packet(new BitWriter().u8(FEATURE_OP.currency).i32(1250).finish());
    f.advance(500);
    expect(f.c.supply.uncertain).toBe(true);
    expect(requests).toEqual(['izlude']);
    expect(f.c.engine.running).toBe(false);
    observations(2, 1250);
    f.advance(1000);
    expect(requests).toEqual(['izlude', 'iz_dun00']);
    arrival('iz_dun00', 290, 47, 2, 1250);
    expect(f.c.engine.running).toBe(false);
    for (let i = 0; i < 60 && f.c.supply.snapshot().state !== 'complete'; i++) {
      if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
      else f.step();
    }
    f.advance(600);
    expect(f.c.engine.player).toMatchObject(origin);
    expect(f.c.engine.running).toBe(true);
    expect(f.c.supply.snapshot()).toMatchObject({ state: 'complete', remainingTrips: 0, spent: 0 });
    expect(f.c.supply.snapshot().actions).toBeGreaterThanOrEqual(spentActions);
    expect(sales()).toHaveLength(1);
  });
  it('does not reserve low-stock supply on the departure map before configured field entry', () => {
    const value = { ...settings, map: 'prt_fild08' };
    const f = setup(value);
    f.c.start(value);
    f.advance(500);
    expect(f.c.supply.snapshot()).toMatchObject({
      active: false,
      returnDestination: null,
      remainingTrips: 2,
      spent: 0,
      reserved: 0,
    });
    expect(f.c.engine.running).toBe(false);
    expect(f.sent.every((action) => action.type === 'walk')).toBe(true);
    expect(f.c.snapshot().initialFieldEntryPending).toBe(true);
  });

  it('does not reserve a supply trip or budget while an observed own cast is pending', () => {
    const f = setup();
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.castStart)
        .i32(1)
        .i32(1)
        .u8(11)
        .u8(1)
        .u8(0)
        .position(player)
        .f32(10)
        .u8(0)
        .finish(),
    );
    f.c.start(settings);
    const before = f.c.supply.snapshot();
    f.advance(3000);
    expect(f.c.supply.snapshot()).toMatchObject({
      state: before.state,
      remainingTrips: before.remainingTrips,
      spent: 0,
      reserved: 0,
    });
    expect(f.sent).toEqual([]);
    expect(f.c.runRequested).toBe(true);
    f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());
    f.advance(500);
    expect(f.c.supply.snapshot().remainingTrips).toBe(before.remainingTrips - 1);
  });
  it('advances a sent supply receipt deadline during an observed own cast', () => {
    const f = setup();
    f.begin();
    f.open();
    expect(f.buy()).toHaveLength(1);
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.castStart)
        .i32(1)
        .i32(1)
        .u8(11)
        .u8(1)
        .u8(0)
        .position(player)
        .f32(20)
        .u8(0)
        .finish(),
    );
    f.advance(10_100);
    expect(f.c.supply.snapshot()).toMatchObject({ state: 'waiting', remainingTrips: 1 });
    expect(f.c.supply.snapshot().reason).toContain('timed out');
    expect(f.c.supply.uncertain).toBe(true);
    expect(f.buy()).toHaveLength(1);
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  });
  it('allows emergency escape after interrupting a supply prepare or exhausted wait', () => {
    for (const exhausted of [false, true]) {
      const a = {
        ...settings.automation,
        escape: { ...DEFAULT_ESCAPE, enabled: true, hpBelowPercent: 20 },
        disposition: { ...settings.automation.disposition, maxSpend: 0 },
      };
      const f = setup({ ...settings, automation: a });
      f.c.engine.receive([
        {
          type: 'inventory',
          items: [
            { bagId: 501, itemId: 501, count: 4, type: 1 },
            { bagId: 601, itemId: 601, count: 5, type: 1 },
          ],
          equipment: [],
          ammoId: -1,
        },
      ]);
      f.c.start({ ...settings, automation: a });
      if (exhausted) {
        f.c.supply.interrupt('Allowance exhausted.');
      }
      f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(10).i32(100).finish());
      f.step(500);
      expect(f.sent.filter((action) => action.type === 'useItem')).toEqual([
        { type: 'useItem', itemId: 601 },
      ]);
      expect(f.c.snapshot().escape.pending).toBe(true);
      expect(f.c.supply.snapshot().spent).toBe(0);
    }
  });
  it.each(['travel', 'approach'] as const)(
    'hands %s movement to exactly one escape after observed settlement',
    (phase) => {
      const runSettings = {
        ...settings,
        automation: {
          ...settings.automation,
          escape: { ...DEFAULT_ESCAPE, enabled: true, hpBelowPercent: 20 },
        },
      };
      const map = phase === 'travel' ? 'prt_fild08' : 'prt_fild05';
      const position =
        phase === 'travel' ? { ...player, x: 156, y: 374 } : { ...player, x: 280, y: 220 };
      const f = setup(runSettings, map, position);
      f.c.engine.receive([
        {
          type: 'inventory',
          items: [
            { bagId: 501, itemId: 501, count: 4, type: 1 },
            { bagId: 601, itemId: 601, count: 5, type: 1 },
          ],
          equipment: [],
          ammoId: -1,
        },
      ]);
      f.c.start({ ...runSettings, map });
      for (let i = 0; i < 12 && !f.sent.some((a) => a.type === 'walk'); i++) f.step();
      expect(f.c.service.snapshot().state).toBe(phase);
      expect(f.sent.some((a) => a.type === 'walk')).toBe(true);
      f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(10).i32(100).finish());
      f.step();
      expect(f.sent.at(-1)).toEqual({ type: 'stop' });
      expect(f.sent.some((a) => a.type === 'useItem')).toBe(false);
      f.packet(new BitWriter().u8(OP.stop).i32(1).finish());
      f.advance(500);
      expect(f.sent.filter((a) => a.type === 'useItem')).toEqual([
        { type: 'useItem', itemId: 601 },
      ]);
      expect(f.c.snapshot().escape).toMatchObject({
        state: 'sent',
        pending: true,
      });
      expect(f.c.supply.snapshot().spent).toBe(0);
      f.advance(1000);
      expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
    },
  );
  it('holds field continuation after reload reconciliation when the previous destination is unknown', () => {
    const f = setup(),
      interrupted = {
        version: 1 as const,
        character: 'Tester',
        latched: false,
        remainingTrips: 1,
        actions: 0,
        spent: 0,
        reserved: 0,
        intervalSeconds: 0,
        deadlineSeconds: 0,
        interrupted: true,
        uncertain: true,
        returnDestination: null,
      };
    f.c.start(settings, undefined, interrupted);
    for (let i = 0; i < 10; i++) f.step();
    expect(f.c.supply.uncertain).toBe(false);
    expect(f.c.supply.snapshot().state).toBe('waiting');
    expect(f.c.engine.running).toBe(false);
    expect(f.sent).toEqual([]);
  });
  it('rejects a foreign-character resume guard atomically before requesting a run', () => {
    const f = setup(),
      before = f.c.supply.snapshot();
    const foreign = {
      version: 1 as const,
      character: 'Other',
      latched: false,
      remainingTrips: 2,
      actions: 0,
      spent: 0,
      reserved: 0,
      intervalSeconds: 0,
      deadlineSeconds: 0,
      interrupted: false,
      uncertain: false,
      returnDestination: null,
    };
    expect(() => f.c.start(settings, undefined, foreign)).toThrow(/different character/);
    expect(f.c.runRequested).toBe(false);
    expect(f.c.supply.snapshot()).toEqual(before);
    for (let i = 0; i < 10; i++) f.step();
    expect(f.sent).toEqual([]);
    expect(f.c.runRequested).toBe(false);
    expect(f.c.supply.guard()).toBeUndefined();
  });
  it('does not allocate a dormant allowance before supply is first enabled', () => {
    const disabled = {
        ...settings,
        automation: {
          ...settings.automation,
          supply: { ...DEFAULT_SUPPLY, enabled: false },
        },
      },
      f = setup(disabled);
    f.c.start(disabled);
    expect(f.c.snapshot().supplyGuard).toBeUndefined();
    expect(f.c.supply.guard()).toBeUndefined();
    f.c.stop();
    f.c.start({
      ...settings,
      automation: {
        ...settings.automation,
        supply: { ...settings.automation.supply, maxTrips: 3 },
      },
    });
    expect(f.c.supply.snapshot().remainingTrips).toBe(2);
  });
  it('retains local consumed allowance through Stop, disabled Start and stale guard publication', () => {
    const f = setup();
    f.c.start(settings);
    expect(f.c.supply.snapshot().remainingTrips).toBe(1);
    f.c.stop();
    const disabled = {
      ...settings,
      automation: {
        ...settings.automation,
        supply: { ...settings.automation.supply, enabled: false },
      },
    };
    f.c.start(disabled);
    expect(f.c.supply.snapshot().remainingTrips).toBe(1);
    f.c.stop();
    const stale = {
      ...f.c.supply.guard()!,
      remainingTrips: 2,
      intervalSeconds: 0,
      actions: 0,
      spent: 0,
      reserved: 0,
      latched: false,
      interrupted: false,
      returnDestination: null,
    };
    f.c.start(settings, undefined, stale);
    expect(f.c.supply.snapshot().remainingTrips).toBe(1);
    expect(f.c.supply.snapshot().latched).toBe(true);
    expect(f.sent.filter((a) => a.type === 'npcTalk' || a.type === 'shop')).toEqual([]);
  });
  it('does not subtract the current held reservation twice at the exact trip cap', () => {
    const f = setup({
      ...settings,
      automation: {
        ...settings.automation,
        supply: { ...settings.automation.supply, maxSpend: 300 },
        disposition: { ...settings.automation.disposition, maxSpend: 300 },
      },
    });
    f.begin();
    f.open();
    expect(f.buy()).toEqual([{ type: 'shop', mode: 'buy', rows: [{ id: 501, count: 6 }] }]);
  });
  it('reopens each partial shop batch and reaches captured desired stock at the finite whole-trip cap', () => {
    const f = setup({
      ...settings,
      automation: {
        ...settings.automation,
        supply: { ...settings.automation.supply, maxSpend: 300 },
        disposition: { ...settings.automation.disposition, maxSpend: 100 },
      },
    });
    f.begin();
    for (let batch = 1; batch <= 3; batch++) {
      f.open();
      expect(f.buy()).toHaveLength(batch);
      expect(f.buy()[batch - 1]).toEqual({
        type: 'shop',
        mode: 'buy',
        rows: [{ id: 501, count: 2 }],
      });
      f.end();
      f.packet(stats(4 + 2 * batch, 1000 - 100 * batch));
      for (let i = 0; i < 12; i++) f.step();
    }
    expect(f.c.supply.snapshot()).toMatchObject({
      state: 'complete',
      spent: 300,
      reserved: 300,
    });
    expect(f.c.engine.running).toBe(true);
    expect(f.sent.filter((a) => a.type === 'npcTalk')).toHaveLength(3);
  });
  it('closes observed full storage then sends one protected cart fallback, without reopening storage', () => {
    const f = setup();
    f.c.engine.receive([
      {
        type: 'stats',
        level: 10,
        hp: 100,
        maxHp: 100,
        weight: 840,
        maxWeight: 1000,
        cartWeight: 0,
        zeny: 1000,
      },
      {
        type: 'inventory',
        items: [{ bagId: 501, itemId: 501, count: 12, type: 1 }],
        equipment: [],
        ammoId: -1,
      },
      {
        type: 'skills',
        learned: [
          { skillId: 1, level: 5 },
          { skillId: 73, level: 1 },
        ],
      },
    ]);
    f.c.world.npc = { id: 20, mode: 'storage', options: [], dialog: null };
    f.c.world.storageReady = true;
    for (let i = 0; i < 600; i++)
      f.c.world.storage.set(10000 + i, {
        bagId: 10000 + i,
        itemId: 10000 + i,
        count: 1,
        type: 1,
      });
    f.c.world.replaceCart([]);
    const a = {
      ...settings.automation,
      supply: {
        ...settings.automation.supply,
        stockEnabled: false,
        weightEnabled: true,
        weightStartPercent: 80,
        weightEndPercent: 40,
      },
      disposition: {
        maxSpend: 0,
        rules: [
          {
            ...settings.automation.disposition.rules[0]!,
            minimum: 0,
            desired: 0,
            maximum: 4,
            store: true,
            cart: true,
            restock: 'off' as const,
          },
        ],
      },
    };
    f.c.start({ ...settings, automation: a });
    for (let i = 0; i < 5; i++) f.step();
    expect(f.sent, JSON.stringify(f.c.snapshot().supply)).toContainEqual({
      type: 'storage',
      operation: 'close',
    });
    expect(f.sent.some((a) => a.type === 'cart')).toBe(false);
    f.end();
    for (let i = 0; i < 5; i++) f.step();
    expect(f.sent.filter((a) => a.type === 'cart')).toEqual([
      { type: 'cart', direction: 1, bagId: 501, count: 8 },
    ]);
    expect(f.sent.some((a) => a.type === 'npcTalk')).toBe(false);
    f.packet(
      new BitWriter()
        .u8(WORLD_OP.cart)
        .u8(1)
        .i32(501)
        .u8(1)
        .i32(501)
        .i16(8)
        .i16(8)
        .i32(560)
        .i32(280)
        .finish(),
    );
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.inventoryDelta)
        .bool(false)
        .i32(501)
        .i16(8)
        .i32(280)
        .bool(false)
        .finish(),
    );
    for (let i = 0; i < 6; i++) f.step();
    expect(f.c.supply.snapshot().state).toBe('complete');
    expect(f.c.engine.running).toBe(true);
  });
});
describe('controller supply ownership', () => {
  it('uses the verified fresh service, confirms stock/money, closes and returns before retaining field intent', () => {
    const f = setup();
    f.begin();
    expect(f.c.runRequested).toBe(true);
    expect(f.c.engine.running).toBe(false);
    f.open();
    expect(f.buy()).toEqual([{ type: 'shop', mode: 'buy', rows: [{ id: 501, count: 6 }] }]);
    f.end();
    expect(f.c.supply.uncertain).toBe(true);
    expect(f.c.engine.running).toBe(false);
    f.packet(stats(10, 700));
    for (let i = 0; i < 8; i++) f.step();
    expect(f.c.snapshot().supply).toMatchObject({
      state: 'complete',
      spent: 300,
      reserved: 300,
      remainingTrips: 1,
      uncertain: false,
    });
    expect(f.c.engine.running).toBe(true);
    expect(f.c.engine.settings.targets).toEqual([4000]);
    expect(f.buy()).toHaveLength(1);
  });
  it.each(['stop', 'timeout', 'death', 'manual', 'send-throw'] as const)(
    'retains sent ownership through %s and drains a late exact receipt without resuming',
    (boundary) => {
      const f = setup();
      f.begin();
      if (boundary === 'send-throw') f.setThrow();
      f.open();
      expect(f.buy()).toHaveLength(1);
      if (boundary === 'stop') f.c.stop();
      if (boundary === 'timeout') f.advance(10100);
      if (boundary === 'death') f.packet(new BitWriter().u8(OP.death).i32(1).finish());
      if (boundary === 'manual') f.c.pause('Manual input', 2000);
      f.end();
      expect(f.c.supply.uncertain).toBe(true);
      f.packet(stats(10, 700));
      f.advance(5000);
      expect(f.buy()).toHaveLength(1);
      expect(f.c.supply.uncertain).toBe(false);
      expect(f.c.engine.running).toBe(false);
    },
  );
  it('never confirms a larger gain or unrelated spending, even when the NPC closes', () => {
    const f = setup();
    f.begin();
    f.open();
    f.end();
    f.packet(stats(11, 700));
    f.advance(10100);
    expect(f.c.supply.uncertain).toBe(true);
    expect(f.buy()).toHaveLength(1);
    f.packet(stats(10, 699));
    expect(f.c.supply.uncertain).toBe(true);
    expect(f.c.engine.running).toBe(false);
  });
  it('blocks changed menu and missing NPC without field resume at the service', () => {
    const f = setup();
    f.begin();
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
    for (const s of ['Buy', 'Changed', 'Cancel']) w.string(s);
    f.packet(w.finish());
    for (let i = 0; i < 5; i++) f.step();
    expect(f.buy()).toHaveLength(0);
    expect(f.c.engine.running).toBe(false);
    expect(f.c.snapshot().supply.state).toBe('waiting');
  });
  it('completes a cross-map storage trip and a verified final approach to the captured field cell', () => {
    const runSettings = {
      ...settings,
      map: 'prt_fild08',
      automation: {
        ...settings.automation,
        supply: {
          ...settings.automation.supply,
          storageService: 'kafra.prontera-south.storage.v1',
        },
        disposition: {
          ...settings.automation.disposition,
          rules: [
            {
              ...settings.automation.disposition.rules[0]!,
              restock: 'storage' as const,
            },
          ],
        },
      },
    };
    const f = setup(runSettings, 'prt_fild08', { ...player, x: 156, y: 374 });
    f.c.start(runSettings);
    const walkUntil = (predicate: () => boolean) => {
      for (let i = 0; i < 90 && !predicate(); i++) {
        if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
        else f.step();
      }
      expect(predicate(), f.c.snapshot().supply.reason + ' ' + f.c.travel.snapshot().reason).toBe(
        true,
      );
    };
    walkUntil(() => f.c.travel.snapshot().state === 'transition');
    f.packet(new BitWriter().u8(OP.map).string('prontera').finish());
    expect(f.c.supply.snapshot().state).toBe('service');
    f.packet(spawn({ ...player, x: 156, y: 26 }));
    f.packet(spawn({ ...npc, name: 'Kafra Staff', x: 151, y: 29 }));
    walkUntil(() => f.sent.some((a) => a.type === 'npcTalk'));
    const def = BUILTIN_SERVICES[0]!;
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const d = def.workflow.steps[1]!;
    if (d.type !== 'advance') throw Error();
    f.packet(
      new BitWriter()
        .u8(WORLD_OP.npc)
        .u8(1)
        .string(d.exactDialogue!.name)
        .string(d.exactDialogue!.text)
        .bool(false)
        .finish(),
    );
    f.step();
    const o = def.workflow.steps[2]!;
    if (o.type !== 'option') throw Error();
    const menu = o.expectedOptions![0]!,
      w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(menu.length);
    for (const label of menu) w.string(label);
    f.packet(w.finish());
    f.step();
    f.packet(new BitWriter().u8(WORLD_OP.storage).u8(1).i32(1).i32(501).i16(10).i32(0).finish());
    for (let i = 0; i < 6; i++) f.step();
    expect(f.sent).toContainEqual({
      type: 'storage',
      operation: 'withdraw',
      bagId: 501,
      count: 6,
    });
    f.packet(
      new BitWriter()
        .u8(WORLD_OP.storageMove)
        .u8(1)
        .i32(501)
        .i16(6)
        .i32(501)
        .i16(10)
        .i32(700)
        .i32(4)
        .bool(false)
        .finish(),
    );
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.inventoryDelta)
        .bool(true)
        .u8(1)
        .i32(501)
        .i16(6)
        .i32(700)
        .i32(501)
        .i16(10)
        .finish(),
    );
    for (let i = 0; i < 4; i++) f.step();
    expect(f.sent).toContainEqual({ type: 'storage', operation: 'close' });
    f.end();
    walkUntil(() => f.c.travel.snapshot().state === 'transition');
    f.packet(new BitWriter().u8(OP.map).string('prt_fild08').finish());
    f.packet(spawn({ ...player, x: 170, y: 375 }));
    walkUntil(() => f.c.supply.snapshot().state === 'complete');
    for (let i = 0; i < 5; i++) f.step();
    expect(f.c.engine.running).toBe(true);
    expect(f.c.engine.player).toMatchObject({ x: 156, y: 374 });
    expect(f.c.supply.snapshot().returnDestination).toEqual({
      map: 'prt_fild08',
      position: { x: 156, y: 374 },
    });
  });
  it('waits for a late canceled cast to settle before departing for supplies', () => {
    const configured = structuredClone(settings);
    configured.automation.combat.mode = 'off';
    const f = setup(configured);
    f.packet(stats(6));
    f.c.engine.receive([
      { type: 'spawn', entity: { ...player, statuses: [], sp: 200, maxSp: 200 } },
      {
        type: 'spawn',
        entity: { ...player, id: 2, kind: 1, classId: 4000, name: 'Poring', x: 290 },
      },
      {
        type: 'skills',
        learned: [
          { skillId: 1, level: 5 },
          { skillId: 11, level: 1 },
        ],
      },
    ]);
    f.c.start(configured);
    f.c.pause('Prepare manual cast', 0);
    f.c.engine.manualAction({ type: 'skill', mode: 'target', skillId: 11, level: 1, target: 2 });
    f.c.tick();
    f.c.pause('Temporary interruption', 0);
    f.step(31_000);
    f.packet(stats(4));
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.skill)
        .u8(1)
        .i32(1)
        .i32(1)
        .i32(2)
        .u8(11)
        .u8(1)
        .u8(0)
        .position(player)
        .i32(1)
        .u8(0)
        .u8(1)
        .f32(2)
        .f32(0)
        .bool(false)
        .finish(),
    );
    expect(f.c.engine.featureActionsSettled).toBe(false);
    expect(f.c.supply.snapshot().actions).toBe(0);
    f.step(1999);
    expect(f.sent.some((a) => a.type === 'npcTalk')).toBe(false);
    expect(f.c.supply.snapshot().actions).toBe(0);
    f.step(1);
    for (let n = 0; n < 12 && !f.sent.some((a) => a.type === 'npcTalk'); n++) f.step();
    expect(f.sent.filter((a) => a.type === 'npcTalk')).toHaveLength(1);
    expect(f.sent.filter((a) => a.type === 'skill')).toHaveLength(1);
  });
  it('keeps a confirmed trip receipt across a reconnect and requires fresh economics to reconcile unknown outcome', () => {
    const f = setup();
    f.begin();
    f.open();
    const generation = f.c.connectionGeneration;
    f.c.disconnect();
    f.c.connect(true);
    f.c.receive(stats(10, 700), generation);
    expect(f.c.supply.uncertain).toBe(true);
    f.packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild05').finish());
    f.packet(spawn(player));
    expect(f.c.supply.uncertain).toBe(true);
    f.packet(stats(10, 700));
    expect(f.c.supply.uncertain).toBe(false);
    expect(f.c.engine.running).toBe(false);
    expect(f.buy()).toHaveLength(1);
    expect(f.c.snapshot().supply.state).toBe('waiting');
  });
});

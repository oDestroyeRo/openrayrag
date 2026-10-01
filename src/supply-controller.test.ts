import { describe, expect, it } from "vitest";
import { BUILTIN_SERVICES } from "./npc-services";
import { CompanionController } from "./controller";
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  DEFAULT_ESCAPE,
  type Settings,
} from "./settings";
import { DEFAULT_SUPPLY } from "./supply-trip";
import { BitWriter } from "./binary";
import { OP, type Entity } from "./protocol";
import { FEATURE_OP } from "./protocol-feature";
import { WORLD_OP, type WorldAction } from "./world-protocol";
import type { Action } from "./engine";
const player: Entity = {
  id: 1,
  classId: 1,
  name: "Tester",
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
  name: "Tool Dealer",
  kind: 2,
  x: 290,
  y: 221,
};
function spawn(e: Entity) {
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
  return new BitWriter()
    .u8(OP.spawn)
    .u8(0)
    .i32(body.length)
    .take(body)
    .finish();
}
function stats(count = 4, zeny = 1000) {
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
    100,
    100,
    ...Array(16).fill(0),
    10000,
  ])
    w.i32(n);
  w.f32(0.4)
    .i32(count * 70)
    .i32(0)
    .bool(true)
    .i16(1)
    .i16(1)
    .u8(5)
    .i16(0)
    .bool(true)
    .u8(1)
    .i32(count ? 1 : 0);
  if (count) w.i32(501).i16(count);
  w.i32(0).u8(0);
  for (let i = 0; i < 10; i++) w.i32(0);
  return w.i32(-1).finish();
}
const settings = {
  ...DEFAULT_SETTINGS,
  map: "prt_fild05",
  targets: [4000],
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    supply: {
      ...DEFAULT_SUPPLY,
      enabled: true,
      maxTrips: 2,
      maxSpend: 1000,
      buyService: "trader.prt-fild05.tool-dealer.buy.v1",
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
          restock: "buy" as const,
          allowUnique: false,
        },
      ],
    },
  },
};
function setup(
  runSettings: Settings = settings,
  map = "prt_fild05",
  position = player,
) {
  let now = 100_000,
    throwBuy = false;
  const sent: Array<Action | WorldAction> = [];
  const c = new CompanionController(
    (a) => {
      sent.push(a);
      if (throwBuy && a.type === "shop" && a.rows.length)
        throw Error("Synthetic transport exception");
    },
    () => now,
  );
  c.connect(true);
  const packet = (p: Uint8Array) => c.receive(p);
  packet(new BitWriter().u8(OP.enter).i32(1).string(map).finish());
  packet(spawn(position));
  if (map === "prt_fild05") packet(spawn(npc));
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
    for (let i = 0; i < 12 && !sent.some((a) => a.type === "npcTalk"); i++)
      step();
    expect(sent.filter((a) => a.type === "npcTalk")).toHaveLength(1);
  };
  const open = (price = 50) => {
    packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
    for (const s of ["Buy", "Sell", "Cancel"]) w.string(s);
    packet(w.finish());
    for (let i = 0; i < 4; i++) step();
    expect(sent.some((a) => a.type === "npcOption" && a.index === 0)).toBe(
      true,
    );
    packet(
      new BitWriter()
        .u8(WORLD_OP.shop)
        .u8(1)
        .u8(0)
        .i32(1)
        .i32(501)
        .i32(price)
        .finish(),
    );
    for (let i = 0; i < 5; i++) step();
  };
  const end = () => packet(new BitWriter().u8(WORLD_OP.npc).u8(3).finish());
  const settleWalk = () => {
    const cells = c.travel.snapshot().leg;
    if (cells.length < 2) throw Error("No travel leg");
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
        dirs.findIndex(
          ([x, y]) => p.x - cells[i]!.x === x && p.y - cells[i]!.y === y,
        ),
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
    buy: () => sent.filter((a) => a.type === "shop" && a.rows.length),
  };
}
describe("controller supply repair regressions", () => {
  it("allows emergency escape after interrupting a supply prepare or exhausted wait", () => {
    for (const exhausted of [false, true]) {
      const a = {
        ...settings.automation,
        escape: { ...DEFAULT_ESCAPE, enabled: true, hpBelowPercent: 20 },
        disposition: { ...settings.automation.disposition, maxSpend: 0 },
      };
      const f = setup({ ...settings, automation: a });
      f.c.engine.receive([
        {
          type: "inventory",
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
        f.c.supply.interrupt("Allowance exhausted.");
      }
      f.packet(
        new BitWriter().u8(OP.heal).i32(1).i32(0).i32(10).i32(100).finish(),
      );
      f.step(500);
      expect(f.sent.filter((action) => action.type === "useItem")).toEqual([
        { type: "useItem", itemId: 601 },
      ]);
      expect(f.c.snapshot().escape.pending).toBe(true);
      expect(f.c.supply.snapshot().spent).toBe(0);
    }
  });
  it.each(["travel", "approach"] as const)(
    "hands %s movement to exactly one escape after observed settlement",
    (phase) => {
      const runSettings = {
        ...settings,
        automation: {
          ...settings.automation,
          escape: { ...DEFAULT_ESCAPE, enabled: true, hpBelowPercent: 20 },
        },
      };
      const map = phase === "travel" ? "prt_fild08" : "prt_fild05";
      const position =
        phase === "travel"
          ? { ...player, x: 156, y: 374 }
          : { ...player, x: 280, y: 220 };
      const f = setup(runSettings, map, position);
      f.c.engine.receive([
        {
          type: "inventory",
          items: [
            { bagId: 501, itemId: 501, count: 4, type: 1 },
            { bagId: 601, itemId: 601, count: 5, type: 1 },
          ],
          equipment: [],
          ammoId: -1,
        },
      ]);
      f.c.start({ ...runSettings, map });
      for (let i = 0; i < 12 && !f.sent.some((a) => a.type === "walk"); i++)
        f.step();
      expect(f.c.service.snapshot().state).toBe(phase);
      expect(f.sent.some((a) => a.type === "walk")).toBe(true);
      f.packet(
        new BitWriter().u8(OP.heal).i32(1).i32(0).i32(10).i32(100).finish(),
      );
      f.step();
      expect(f.sent.at(-1)).toEqual({ type: "stop" });
      expect(f.sent.some((a) => a.type === "useItem")).toBe(false);
      f.packet(new BitWriter().u8(OP.stop).i32(1).finish());
      f.advance(500);
      expect(f.sent.filter((a) => a.type === "useItem")).toEqual([
        { type: "useItem", itemId: 601 },
      ]);
      expect(f.c.snapshot().escape).toMatchObject({
        state: "sent",
        pending: true,
      });
      expect(f.c.supply.snapshot().spent).toBe(0);
      f.advance(1000);
      expect(f.sent.filter((a) => a.type === "useItem")).toHaveLength(1);
    },
  );
  it("holds field continuation after reload reconciliation when the previous destination is unknown", () => {
    const f = setup(),
      interrupted = {
        version: 1 as const,
        character: "Tester",
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
    expect(f.c.supply.snapshot().state).toBe("waiting");
    expect(f.c.engine.running).toBe(false);
    expect(f.sent).toEqual([]);
  });
  it("rejects a foreign-character resume guard atomically before requesting a run", () => {
    const f = setup(),
      before = f.c.supply.snapshot();
    const foreign = {
      version: 1 as const,
      character: "Other",
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
    expect(() => f.c.start(settings, undefined, foreign)).toThrow(
      /different character/,
    );
    expect(f.c.runRequested).toBe(false);
    expect(f.c.supply.snapshot()).toEqual(before);
    for (let i = 0; i < 10; i++) f.step();
    expect(f.sent).toEqual([]);
    expect(f.c.runRequested).toBe(false);
    expect(f.c.supply.guard()).toBeUndefined();
  });
  it("does not allocate a dormant allowance before supply is first enabled", () => {
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
  it("retains local consumed allowance through Stop, disabled Start and stale guard publication", () => {
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
    expect(
      f.sent.filter((a) => a.type === "npcTalk" || a.type === "shop"),
    ).toEqual([]);
  });
  it("does not subtract the current held reservation twice at the exact trip cap", () => {
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
    expect(f.buy()).toEqual([
      { type: "shop", mode: "buy", rows: [{ id: 501, count: 6 }] },
    ]);
  });
  it("reopens each partial shop batch and reaches captured desired stock at the finite whole-trip cap", () => {
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
        type: "shop",
        mode: "buy",
        rows: [{ id: 501, count: 2 }],
      });
      f.end();
      f.packet(stats(4 + 2 * batch, 1000 - 100 * batch));
      for (let i = 0; i < 12; i++) f.step();
    }
    expect(f.c.supply.snapshot()).toMatchObject({
      state: "complete",
      spent: 300,
      reserved: 300,
    });
    expect(f.c.engine.running).toBe(true);
    expect(f.sent.filter((a) => a.type === "npcTalk")).toHaveLength(3);
  });
  it("closes observed full storage then sends one protected cart fallback, without reopening storage", () => {
    const f = setup();
    f.c.engine.receive([
      {
        type: "stats",
        level: 10,
        hp: 100,
        maxHp: 100,
        weight: 840,
        maxWeight: 1000,
        cartWeight: 0,
        zeny: 1000,
      },
      {
        type: "inventory",
        items: [{ bagId: 501, itemId: 501, count: 12, type: 1 }],
        equipment: [],
        ammoId: -1,
      },
      {
        type: "skills",
        learned: [
          { skillId: 1, level: 5 },
          { skillId: 73, level: 1 },
        ],
      },
    ]);
    f.c.world.npc = { id: 20, mode: "storage", options: [], dialog: null };
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
            restock: "off" as const,
          },
        ],
      },
    };
    f.c.start({ ...settings, automation: a });
    for (let i = 0; i < 5; i++) f.step();
    expect(f.sent, JSON.stringify(f.c.snapshot().supply)).toContainEqual({
      type: "storage",
      operation: "close",
    });
    expect(f.sent.some((a) => a.type === "cart")).toBe(false);
    f.end();
    for (let i = 0; i < 5; i++) f.step();
    expect(f.sent.filter((a) => a.type === "cart")).toEqual([
      { type: "cart", direction: 1, bagId: 501, count: 8 },
    ]);
    expect(f.sent.some((a) => a.type === "npcTalk")).toBe(false);
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
    expect(f.c.supply.snapshot().state).toBe("complete");
    expect(f.c.engine.running).toBe(true);
  });
});
describe("controller supply ownership", () => {
  it("uses the verified fresh service, confirms stock/money, closes and returns before retaining field intent", () => {
    const f = setup();
    f.begin();
    expect(f.c.runRequested).toBe(true);
    expect(f.c.engine.running).toBe(false);
    f.open();
    expect(f.buy()).toEqual([
      { type: "shop", mode: "buy", rows: [{ id: 501, count: 6 }] },
    ]);
    f.end();
    expect(f.c.supply.uncertain).toBe(true);
    expect(f.c.engine.running).toBe(false);
    f.packet(stats(10, 700));
    for (let i = 0; i < 8; i++) f.step();
    expect(f.c.snapshot().supply).toMatchObject({
      state: "complete",
      spent: 300,
      reserved: 300,
      remainingTrips: 1,
      uncertain: false,
    });
    expect(f.c.engine.running).toBe(true);
    expect(f.c.engine.settings.targets).toEqual([4000]);
    expect(f.buy()).toHaveLength(1);
  });
  it.each(["stop", "timeout", "death", "manual", "send-throw"] as const)(
    "retains sent ownership through %s and drains a late exact receipt without resuming",
    (boundary) => {
      const f = setup();
      f.begin();
      if (boundary === "send-throw") f.setThrow();
      f.open();
      expect(f.buy()).toHaveLength(1);
      if (boundary === "stop") f.c.stop();
      if (boundary === "timeout") f.advance(10100);
      if (boundary === "death")
        f.packet(new BitWriter().u8(OP.death).i32(1).finish());
      if (boundary === "manual") f.c.pause("Manual input", 2000);
      f.end();
      expect(f.c.supply.uncertain).toBe(true);
      f.packet(stats(10, 700));
      f.advance(5000);
      expect(f.buy()).toHaveLength(1);
      expect(f.c.supply.uncertain).toBe(false);
      expect(f.c.engine.running).toBe(false);
    },
  );
  it("never confirms a larger gain or unrelated spending, even when the NPC closes", () => {
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
  it("blocks changed menu and missing NPC without field resume at the service", () => {
    const f = setup();
    f.begin();
    f.packet(
      new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish(),
    );
    const w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3);
    for (const s of ["Buy", "Changed", "Cancel"]) w.string(s);
    f.packet(w.finish());
    for (let i = 0; i < 5; i++) f.step();
    expect(f.buy()).toHaveLength(0);
    expect(f.c.engine.running).toBe(false);
    expect(f.c.snapshot().supply.state).toBe("waiting");
  });
  it("completes a cross-map storage trip and a verified final approach to the captured field cell", () => {
    const runSettings = {
      ...settings,
      map: "prt_fild08",
      automation: {
        ...settings.automation,
        supply: {
          ...settings.automation.supply,
          storageService: "kafra.prontera-south.storage.v1",
        },
        disposition: {
          ...settings.automation.disposition,
          rules: [
            {
              ...settings.automation.disposition.rules[0]!,
              restock: "storage" as const,
            },
          ],
        },
      },
    };
    const f = setup(runSettings, "prt_fild08", { ...player, x: 156, y: 374 });
    f.c.start(runSettings);
    const walkUntil = (predicate: () => boolean) => {
      for (let i = 0; i < 90 && !predicate(); i++) {
        if (f.c.travel.snapshot().leg.length > 1) f.settleWalk();
        else f.step();
      }
      expect(
        predicate(),
        f.c.snapshot().supply.reason + " " + f.c.travel.snapshot().reason,
      ).toBe(true);
    };
    walkUntil(() => f.c.travel.snapshot().state === "transition");
    f.packet(new BitWriter().u8(OP.map).string("prontera").finish());
    expect(f.c.supply.snapshot().state).toBe("service");
    f.packet(spawn({ ...player, x: 156, y: 26 }));
    f.packet(spawn({ ...npc, name: "Kafra Staff", x: 151, y: 29 }));
    walkUntil(() => f.sent.some((a) => a.type === "npcTalk"));
    const def = BUILTIN_SERVICES[0]!;
    f.packet(
      new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish(),
    );
    const d = def.workflow.steps[1]!;
    if (d.type !== "advance") throw Error();
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
    if (o.type !== "option") throw Error();
    const menu = o.expectedOptions![0]!,
      w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(menu.length);
    for (const label of menu) w.string(label);
    f.packet(w.finish());
    f.step();
    f.packet(
      new BitWriter()
        .u8(WORLD_OP.storage)
        .u8(1)
        .i32(1)
        .i32(501)
        .i16(10)
        .i32(0)
        .finish(),
    );
    for (let i = 0; i < 6; i++) f.step();
    expect(f.sent).toContainEqual({
      type: "storage",
      operation: "withdraw",
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
    expect(f.sent).toContainEqual({ type: "storage", operation: "close" });
    f.end();
    walkUntil(() => f.c.travel.snapshot().state === "transition");
    f.packet(new BitWriter().u8(OP.map).string("prt_fild08").finish());
    f.packet(spawn({ ...player, x: 170, y: 375 }));
    walkUntil(() => f.c.supply.snapshot().state === "complete");
    for (let i = 0; i < 5; i++) f.step();
    expect(f.c.engine.running).toBe(true);
    expect(f.c.engine.player).toMatchObject({ x: 156, y: 374 });
    expect(f.c.supply.snapshot().returnDestination).toEqual({
      map: "prt_fild08",
      position: { x: 156, y: 374 },
    });
  });
  it("keeps a confirmed trip receipt across a reconnect and requires fresh economics to reconcile unknown outcome", () => {
    const f = setup();
    f.begin();
    f.open();
    const generation = f.c.connectionGeneration;
    f.c.disconnect();
    f.c.connect(true);
    f.c.receive(stats(10, 700), generation);
    expect(f.c.supply.uncertain).toBe(true);
    f.packet(new BitWriter().u8(OP.enter).i32(1).string("prt_fild05").finish());
    f.packet(spawn(player));
    expect(f.c.supply.uncertain).toBe(true);
    f.packet(stats(10, 700));
    expect(f.c.supply.uncertain).toBe(false);
    expect(f.c.engine.running).toBe(false);
    expect(f.buy()).toHaveLength(1);
    expect(f.c.snapshot().supply.state).toBe("waiting");
  });
});

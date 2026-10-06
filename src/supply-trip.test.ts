import { itemId, bagId, quantity, revisionFor, incrementRevision } from './domain-values';
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SUPPLY,
  SupplyTripRuntime,
  validateSupplySettings,
  validateSupplyResumeGuard,
  type SupplyContext,
  type SupplyIntent,
} from "./supply-trip";
import { nextSupplyAction } from "./supply-plan";
import {
  createSupplyReceipt,
  observeSupplyReceipt,
  confirmSupplyReceipt,
} from "./supply-receipt";
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
} from "./settings";
import { publishedDispositionMetadata } from "./disposition-ui";
import { WorldState } from "./world-state";
import { validateDispositionPolicy, type DispositionAction, type DispositionPolicyView } from "./disposition";
import type { SupplyPolicySettings } from "./supply-trip-logic";
import type { WorkflowReceipt } from "./workflows";
const rule = {
  itemId: 501,
  keep: 0,
  minimum: 5,
  desired: 10,
  maximum: 10,
  store: false,
  cart: false,
  sell: false,
  restock: "buy" as const,
  allowUnique: false,
};
const policy = validateDispositionPolicy({ maxSpend: 1000, rules: [rule] });
const configured: SupplyPolicySettings = {
  ...DEFAULT_SETTINGS,
  map: "prt_fild05",
  targets: [4000],
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    disposition: policy,
    supply: {
      ...DEFAULT_SUPPLY,
      enabled: true,
      maxTrips: 2,
      maxSpend: 1000,
      buyService: "trader.prt-fild05.tool-dealer.buy.v1",
      sellService: "trader.prt-fild05.tool-dealer.sell.v1",
      storageService: "kafra.prontera-south.storage.v1",
    },
  },
};
function context(stock = 4): SupplyContext & { disposition: SupplyContext['disposition'] & { workflow: SupplyContext['disposition']['workflow'] & { world: WorldState } } } {
  const world = new WorldState();
  world.reset("prt_fild05");
  world.replaceCart([]);
  world.npc = { id: 20, mode: "shop", dialog: null, options: [] };
  world.shop = {
    mode: "buy",
    discountLevel: 0,
    entries: [{ itemId: 501, price: 50 }],
  };
  const items = stock
    ? [{ bagId: 501, itemId: 501, count: stock, type: 1 as const }]
    : [];
  return {
    character: "Tester",
    epoch: "1",
    map: "prt_fild05",
    position: { x: 289, y: 220 },
    connected: true,
    alive: true,
    fresh: true,
    settled: true,
    canPrepare: true,
    fieldRequested: true,
    inventoryRevision: revisionFor('inventory', 1),
    currencyRevision: revisionFor('currency', 1),
    economicUncertain: false,
    disposition: {
      revision: "1",
      containers: {
        inventory: { items, slots: 200, weight: stock * 70, maxWeight: 10000 },
        storage: {
          items: null,
          slots: 600,
          weight: null,
          maxWeight: "unlimited",
        },
        cart: { items: [], slots: 100, weight: 0, maxWeight: 80000 },
      },
      equipment: [],
      ammoId: -1,
      metadata: publishedDispositionMetadata(),
      workflow: {
        map: "prt_fild05",
        playerId: 1,
        alive: true,
        idle: true,
        inventory: items,
        equipped: [],
        zeny: 1000,
        world,
        visibleNpcIds: [20],
        pushCartLevel: 1,
      },
    },
  };
}
function setStock(c: SupplyContext, n: number) {
  const items = n
    ? [{ bagId: 501, itemId: 501, count: n, type: 1 as const }]
    : [];
  c.disposition.containers.inventory.items = items;
  c.disposition.workflow.inventory = items;
  c.inventoryRevision=incrementRevision(c.inventoryRevision);
}
function setup(settings = configured) {
  let now = 100_000;
  const c = context();
  let confirmed = false;
  let plannedPolicy: DispositionPolicyView | undefined;
  const action: DispositionAction = {
    kind: "buy",
    itemId: itemId(501),
    count: quantity(2),
    from: "shop",
    to: "inventory",
    command: { type: "shop", mode: "buy", rows: [{ id: 501, count: 2 }] },
    estimatedCost: 100,
    reservedSpend: 100,
    estimatedProceeds: 0,
  };
  const runtime = new SupplyTripRuntime(
    {
      next: (ctx, _goals, p) => {
        plannedPolicy = p;
        return (ctx.disposition.containers.inventory.items?.[0]?.count ?? 0) <
          10
          ? { type: "action", action }
          : { type: "ready" };
      },
      confirm: (_r: { exact: boolean }) => confirmed,
    },
    () => now,
  );
  runtime.configure(settings, c);
  const next = () => runtime.next(c)!;
  const prepare = () => {
    const i = next();
    expect(i.type).toBe("prepare");
    runtime.acknowledge(i.id, "confirmed", c);
  };
  const send = () => {
    const i = next();
    expect(i.type).toBe("action");
    runtime.attachReceipt(i.id, { exact: true }, c);
    expect(runtime.commandAllowed()).toBe(true);
    runtime.markSent(i.id);
    return i;
  };
  const ack = (i: SupplyIntent) => runtime.acknowledge(i.id, "confirmed", c);
  return {
    runtime,
    c,
    next,
    prepare,
    send,
    ack,
    action,
    advance: (ms: number) => {
      now += ms;
      runtime.observe(c);
    },
    confirm: () => {
      confirmed = true;
      runtime.observe(c);
    },
    getPolicy: () => plannedPolicy,
  };
}
describe("bounded supply runtime", () => {
  it("defaults off and strictly validates limits/IDs and config-free guards", () => {
    expect(validateSupplySettings(DEFAULT_SUPPLY).enabled).toBe(false);
    expect(
      validateSupplySettings(configured.automation!.supply!).buyService,
    ).toContain(".v1");
    for (const patch of [
      { enabled: 1 },
      { maxTrips: 0 },
      { maxActions: 101 },
      { maxSpend: 2000000001 },
      { weightEndPercent: 80 },
      { unknown: true },
      { buyService: "x".repeat(129) },
    ])
      expect(() =>
        validateSupplySettings({ ...DEFAULT_SUPPLY, ...patch }),
      ).toThrow();
    const f = setup();
    const guard = f.runtime.guard()!;
    expect(validateSupplyResumeGuard(guard)).toEqual(guard);
    for (const patch of [
      { character: "" },
      { remainingTrips: 101 },
      { actorId: 20 },
      { returnDestination: { map: "prt_fild05", position: { x: 512, y: 0 } } },
    ])
      expect(() => validateSupplyResumeGuard({ ...guard, ...patch })).toThrow();
  });
  it("captures desired targets and continues after partial refill crosses minimum", () => {
    const f = setup();
    f.prepare();
    f.send();
    setStock(f.c, 6);
    f.confirm();
    f.c.disposition.workflow.world.apply({ type: "npcEnd" });
    const close = f.next();
    expect(close.type).toBe("close");
    f.ack(close);
    expect(f.next().type).toBe("action");
    expect(f.getPolicy()?.rules[0]?.minimum).toBe(10);
    expect(f.runtime.snapshot().goals).toEqual([{ itemId: 501, desired: 10 }]);
    expect(f.runtime.snapshot()).toMatchObject({
      spent: 100,
      reserved: 200,
      remainingTrips: 1,
    });
  });
  it.each(["same", "cross"] as const)(
    "returns to the captured %s map and exact work cell before one resume",
    (kind) => {
      const f = setup();
      f.prepare();
      f.send();
      setStock(f.c, 10);
      f.confirm();
      f.c.disposition.workflow.world.apply({ type: "npcEnd" });
      const close = f.next();
      f.ack(close);
      expect(f.runtime.snapshot().reason).toBe("Returning to the captured map and work cell.");
      const ret = f.next();
      expect(ret).toMatchObject({
        type: "return",
        map: "prt_fild05",
        position: { x: 289, y: 220 },
      });
      if (kind === "cross") f.c.map = "prontera";
      f.c.position = { x: 288, y: 220 };
      f.ack(ret);
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      f.c.map = "prt_fild05";
      f.ack(ret);
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      f.c.position = { x: 289, y: 220 };
      f.ack(ret);
      const resume = f.runtime.resumeIntent(f.c)!;
      expect(resume).toMatchObject({ type: "resume", settings: configured });
      f.ack(resume);
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      expect(f.runtime.next(f.c)).toBeNull();
    },
  );
  it.each(["prepare", "before-send", "after-send", "close", "return"] as const)(
    "Stop invalidates %s continuation and preserves only sent uncertainty",
    (stage) => {
      const f = setup();
      if (stage === "prepare") f.next();
      else {
        f.prepare();
        if (stage === "before-send") {
          const i = f.next();
          f.runtime.attachReceipt(i.id, { exact: true }, f.c);
        } else {
          f.send();
          if (stage === "close" || stage === "return") {
            setStock(f.c, 10);
            f.confirm();
            f.c.disposition.workflow.world.apply({ type: "npcEnd" });
            const close = f.next();
            if (stage === "return") {
              f.ack(close);
              f.next();
            }
          }
        }
      }
      f.runtime.stop();
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      expect(f.runtime.uncertain).toBe(stage === "after-send");
      if (stage === "after-send") {
        f.confirm();
        expect(f.runtime.uncertain).toBe(false);
        expect(f.runtime.snapshot().state).toBe("cancelled");
      }
    },
  );
  it.each([
    "timeout",
    "manual",
    "death",
    "map",
    "disconnect",
    "send-throw",
  ] as const)(
    "retains exact economics after %s without another intention",
    (event) => {
      const f = setup();
      f.prepare();
      f.send();
      if (event === "timeout") f.advance(10001);
      else f.runtime.interrupt(event);
      expect(f.runtime.uncertain).toBe(true);
      expect(f.runtime.next(f.c)).toBeNull();
      f.confirm();
      expect(f.runtime.uncertain).toBe(false);
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
    },
  );
  it("requires fresh inventory AND currency after connection reset; never repeats the old action", () => {
    const f = setup();
    f.prepare();
    f.send();
    f.c.epoch = "2";
    f.c.fresh = false;
    f.runtime.observe(f.c);
    expect(f.runtime.uncertain).toBe(true);
    f.c.fresh = true;
    f.c.inventoryRevision=incrementRevision(f.c.inventoryRevision);
    f.runtime.observe(f.c);
    expect(f.runtime.uncertain).toBe(true);
    f.c.currencyRevision=incrementRevision(f.c.currencyRevision);
    f.runtime.observe(f.c);
    expect(f.runtime.uncertain).toBe(false);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().reason).toContain("outcome remains unknown");
  });
  it("retains latch, allowance, budget and interrupted return across reload", () => {
    const f = setup();
    f.prepare();
    f.send();
    const guard = f.runtime.guard()!;
    const resumed = setup();
    resumed.runtime.configure(configured, resumed.c, guard);
    expect(resumed.runtime.snapshot()).toMatchObject({
      latched: true,
      remainingTrips: 1,
      reserved: 100,
      uncertain: true,
      state: "waiting",
    });
    expect(resumed.runtime.next(resumed.c)).toBeNull();
    expect(Object.keys(guard)).not.toContain("action");
    expect(Object.keys(guard)).not.toContain("settings");
    expect(Object.keys(guard)).not.toContain("npcId");
  });
  it("does not treat an empty plan as success or replenish its cap from sale proceeds", () => {
    const f = setup({
      ...configured,
      automation: {
        ...configured.automation!,
        supply: { ...configured.automation!.supply!, maxSpend: 100 },
      },
    });
    f.prepare();
    f.send();
    setStock(f.c, 6);
    f.c.disposition.workflow.zeny = 100000;
    f.confirm();
    f.c.disposition.workflow.world.apply({ type: "npcEnd" });
    const close = f.next();
    f.ack(close);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().reason).toContain("budget");
  });
  it("waits for resource/cast settlement before prepare and counts finite commands", () => {
    const f = setup({
      ...configured,
      automation: {
        ...configured.automation!,
        supply: { ...configured.automation!.supply!, maxActions: 1 },
      },
    });
    f.c.canPrepare = false;
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().reason).toContain("casts");
    f.c.canPrepare = true;
    f.prepare();
    expect(f.runtime.commandAllowed()).toBe(true);
    expect(f.runtime.commandAllowed()).toBe(false);
    expect(f.runtime.next(f.c)).toBeNull();
  });
  it("blocks unknown inventory, weight, capacity, equipment and uncertain external economics", () => {
    for (const field of [
      "stock",
      "weight",
      "capacity",
      "equipment",
      "uncertain",
    ] as const) {
      const f = setup();
      if (field === "stock") f.c.disposition.containers.inventory.items = null;
      if (field === "weight")
        f.c.disposition.containers.inventory.weight = null;
      if (field === "capacity")
        f.c.disposition.containers.inventory.slots = null;
      if (field === "equipment") f.c.disposition.equipment = null;
      if (field === "uncertain") f.c.economicUncertain = true;
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.snapshot().remainingTrips).toBe(2);
    }
  });
  it("suppresses stable triggers and enforces interval after recovery, including a guard restore", () => {
    const f = setup();
    f.prepare();
    f.send();
    f.runtime.stop();
    const guard = f.runtime.guard()!;
    expect(guard.latched).toBe(true);
    expect(guard.remainingTrips).toBe(1);
    const g = setup();
    g.runtime.configure(configured, g.c, {
      ...guard,
      uncertain: false,
      interrupted: false,
      returnDestination: null,
    });
    expect(g.runtime.next(g.c)).toBeNull();
    setStock(g.c, 10);
    g.advance(300001);
    setStock(g.c, 4);
    expect(g.runtime.next(g.c)?.type).toBe("prepare");
    expect(g.runtime.snapshot().remainingTrips).toBe(0);
  });
});
describe("supply direct configuration allowance", () => {
  it("keeps consumed allowance when a disabled runtime is configured without window telemetry", () => {
    const f = setup();
    f.prepare();
    f.runtime.stop();
    f.runtime.configure(
      {
        ...configured,
        automation: {
          ...configured.automation!,
          supply: { ...configured.automation!.supply!, enabled: false },
        },
      },
      f.c,
    );
    expect(f.runtime.guard()?.remainingTrips).toBe(1);
    f.runtime.configure(configured, f.c);
    expect(f.runtime.guard()?.remainingTrips).toBe(1);
  });
});
describe("supply configuration atomicity", () => {
  it.each(["foreign", "unknown", "settings"] as const)(
    "preserves the configured runtime after rejecting %s input",
    (kind) => {
      const f = setup();
      f.prepare();
      const before = f.runtime.snapshot(),
        guard = f.runtime.guard()!;
      const request =
        kind === "foreign"
          ? { ...guard, character: "Other" }
          : kind === "unknown"
            ? { ...guard, injected: true }
            : guard;
      const input =
        kind === "settings"
          ? {
              ...configured,
              automation: {
                ...configured.automation!,
                supply: { ...configured.automation!.supply!, maxTrips: 0 },
              },
            }
          : configured;
      expect(() => f.runtime.configure(input, f.c, request)).toThrow();
      expect(f.runtime.snapshot()).toEqual(before);
      expect(f.runtime.guard()).toEqual(guard);
    },
  );
});
describe("supply repair regressions", () => {
  it("records achieved stock recovery before the minimum interval expires", () => {
    const f = setup();
    f.prepare();
    f.send();
    setStock(f.c, 10);
    f.confirm();
    f.c.disposition.workflow.world.apply({ type: "npcEnd" });
    const close = f.next();
    f.ack(close);
    const ret = f.next();
    f.ack(ret);
    const resume = f.runtime.resumeIntent(f.c)!;
    f.ack(resume);
    setStock(f.c, 4);
    f.advance(1000);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().latched).toBe(false);
    f.advance(300000);
    expect(f.runtime.next(f.c)?.type).toBe("prepare");
    expect(f.runtime.snapshot().remainingTrips).toBe(0);
  });
  it("closes confirmed full storage before cart fallback and keeps unknown preference blocked", () => {
    const c = context(12);
    c.disposition.workflow.world.npc.mode = "storage";
    c.disposition.workflow.world.storageReady = true;
    c.disposition.containers.storage.items = Array.from(
      { length: 600 },
      (_, i) => ({
        bagId: i + 10000,
        itemId: i + 10000,
        count: 1,
        type: 1 as const,
      }),
    );
    const p = validateDispositionPolicy({
      maxSpend: 0,
      rules: [{ ...rule, store: true, cart: true, restock: "off" as const }],
    });
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!)).toEqual({
      type: "close",
    });
    c.disposition.workflow.world.apply({ type: "npcEnd" });
    c.disposition.containers.storage.items = null;
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!, {
        storageFull: {
          character: c.character,
          epoch: c.epoch,
          revision: c.disposition.revision,
        },
      }),
    ).toMatchObject({ type: "action", action: { kind: "cart", count: 2 } });
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!),
    ).toMatchObject({
      type: "service",
      contractId: "kafra.prontera-south.storage.v1",
    });
  });
  it("does not reuse full storage evidence after character, connection or observed capacity changes", () => {
    const c = context(12),
      p = validateDispositionPolicy({
        maxSpend: 0,
        rules: [{ ...rule, store: true, sell: true, restock: "off" as const }],
      });
    c.disposition.workflow.world.apply({ type: "npcEnd" });
    const evidence = {
      storageFull: {
        character: c.character,
        epoch: c.epoch,
        revision: c.disposition.revision,
      },
    };
    for (const changed of [{ character: "Other" }, { epoch: "2" }])
      expect(
        nextSupplyAction(
          { ...c, ...changed },
          [],
          p,
          configured.automation!.supply!,
          evidence,
        ),
      ).toMatchObject({
        type: "service",
        contractId: "kafra.prontera-south.storage.v1",
      });
    c.disposition.containers.storage.items = [];
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!, evidence),
    ).toMatchObject({
      type: "service",
      contractId: "kafra.prontera-south.storage.v1",
    });
  });
  it("retains a proven-full preferred storage phase when visiting the explicitly configured sell service", () => {
    const c = context(12);
    const p = validateDispositionPolicy({
      maxSpend: 0,
      rules: [{ ...rule, store: true, sell: true, restock: "off" as const }],
    });
    c.disposition.workflow.world.apply({ type: "npcEnd" });
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!, {
        storageFull: {
          character: c.character,
          epoch: c.epoch,
          revision: c.disposition.revision,
        },
      }),
    ).toMatchObject({
      type: "service",
      contractId: "trader.prt-fild05.tool-dealer.sell.v1",
    });
    c.disposition.workflow.world.npc = {
      id: 20,
      mode: "shop",
      options: [],
      dialog: null,
    };
    c.disposition.workflow.world.shop = {
      mode: "sell",
      discountLevel: 0,
      entries: [],
    };
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!, {
        storageFull: {
          character: c.character,
          epoch: c.epoch,
          revision: c.disposition.revision,
        },
      }),
    ).toMatchObject({ type: "action", action: { kind: "sell", count: 2 } });
  });
  it("preserves unpermitted excess while planning an unrelated safe refill", () => {
    const c = context();
    c.disposition.containers.inventory.items!.push({
      bagId: 512,
      itemId: 512,
      count: 10,
      type: 1,
    });
    c.disposition.workflow.inventory =
      c.disposition.containers.inventory.items!;
    const p = validateDispositionPolicy({
      ...policy,
      rules: [
        {
          ...rule,
          itemId: 512,
          minimum: 0,
          desired: 0,
          maximum: 0,
          restock: "off" as const,
        },
        rule,
      ],
    });
    expect(
      nextSupplyAction(
        c,
        [{ itemId: itemId(501), desired: quantity(10) }],
        p,
        configured.automation!.supply!,
      ),
    ).toMatchObject({
      type: "action",
      action: { kind: "buy", itemId: 501, count: 6 },
    });
  });
});
describe("phase planning and exact receipts", () => {
  it("opens the source-backed dealer and revalidates changed prices from current state", () => {
    const c = context();
    c.disposition.workflow.world.apply({ type: "npcEnd" });
    expect(
      nextSupplyAction(
        c,
        [{ itemId: itemId(501), desired: quantity(10) }],
        policy,
        configured.automation!.supply!,
      ),
    ).toMatchObject({
      type: "service",
      contractId: "trader.prt-fild05.tool-dealer.buy.v1",
      fee: 0,
    });
    c.disposition.workflow.world.npc = {
      id: 20,
      mode: "shop",
      dialog: null,
      options: [],
    };
    c.disposition.workflow.world.shop = {
      mode: "buy",
      discountLevel: 0,
      entries: [{ itemId: 501, price: 200 }],
    };
    expect(
      nextSupplyAction(
        c,
        [{ itemId: itemId(501), desired: quantity(10) }],
        policy,
        configured.automation!.supply!,
      ),
    ).toMatchObject({
      type: "action",
      action: { count: 5, reservedSpend: 1000 },
    });
  });
  it("unknown preferred storage cannot authorize a fallback sale", () => {
    const c = context(12);
    const p = validateDispositionPolicy({
      maxSpend: 1000,
      rules: [{ ...rule, store: true, sell: true, restock: "off" as const }],
    });
    expect(
      nextSupplyAction(c, [], p, {
        ...configured.automation!.supply!,
        storageService: "",
      }),
    ).toMatchObject({ type: "blocked" });
  });
  it("disposes excess first and preserves source stock, equipped and selected ammo", () => {
    const c = context(12);
    c.disposition.workflow.world.shop!.mode = "sell";
    const p = validateDispositionPolicy({
      maxSpend: 1000,
      rules: [{ ...rule, sell: true, restock: "off" as const }],
    });
    c.disposition.minimumStock = [{ itemId: 501, count: 11 }];
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!),
    ).toMatchObject({ type: "action", action: { kind: "sell", count: 1 } });
    c.disposition.ammoId = 501;
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!),
    ).toMatchObject({ type: "blocked" });
    c.disposition.ammoId = -1;
    c.disposition.equipment = [501];
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!),
    ).toMatchObject({ type: "blocked" });
  });
  it("requires exact stock and money even after NPC end; later excess gains do not confirm", () => {
    const c = context();
    const action = nextSupplyAction(
      c,
      [{ itemId: itemId(501), desired: quantity(10) }],
      policy,
      configured.automation!.supply!,
    );
    if (action.type !== "action") throw Error();
    const economic: WorkflowReceipt = {
      zeny: 1000,
      cost: 300,
      credit: 0,
      items: new Map([[itemId(501), quantity(4)]]),
      bags: new Map([[bagId(501), quantity(4)]]),
      itemChanges: new Map([[itemId(501), 6]]),
      bagChanges: new Map(),
      strictStock: false,
    };
    const r = createSupplyReceipt(action.action, economic, c);
    c.disposition.workflow.world.apply({ type: "npcEnd" });
    setStock(c, 10);
    expect(confirmSupplyReceipt(r, c)).toBe(false);
    c.disposition.workflow.zeny = 700;
    c.currencyRevision=incrementRevision(c.currencyRevision);
    expect(confirmSupplyReceipt(r, c)).toBe(true);
    setStock(c, 11);
    expect(confirmSupplyReceipt(r, c)).toBe(false);
    c.map = "prontera";
    expect(confirmSupplyReceipt(r, c)).toBe(false);
  });
  it("retains exact container gain from transfer receipt when NPC closes before inventory", () => {
    const c = context(12);
    c.disposition.workflow.world.npc.mode = "storage";
    c.disposition.workflow.world.storageReady = true;
    c.disposition.containers.storage.items = [];
    const action: DispositionAction = {
      kind: "store",
      itemId: itemId(501),
      count: quantity(2),
      from: "inventory",
      to: "storage",
      bagId: bagId(501),
      command: { type: "storage", operation: "deposit", bagId: 501, count: 2 },
      estimatedCost: 0,
      reservedSpend: 0,
      estimatedProceeds: 0,
    };
    const economic: WorkflowReceipt = {
      zeny: 1000,
      cost: 0,
      credit: 0,
      items: new Map([[itemId(501), quantity(12)]]),
      bags: new Map([[bagId(501), quantity(12)]]),
      itemChanges: new Map([[itemId(501), -2]]),
      bagChanges: new Map([[bagId(501), -2]]),
      strictStock: false,
    };
    const r = createSupplyReceipt(action, economic, c);
    observeSupplyReceipt(
      r,
      [
        {
          type: "storageMoved",
          deposit: true,
          currentWeight: 700,
          storageCount: 1,
          item: { bagId: 501, itemId: 501, type: 1, count: 2 },
          change: 2,
        },
      ],
      c,
    );
    c.disposition.workflow.world.apply({ type: "npcEnd" });
    setStock(c, 10);
    expect(confirmSupplyReceipt(r, c)).toBe(true);
    const wrong = createSupplyReceipt(action, economic, context(12));
    setStock(c, 10);
    expect(confirmSupplyReceipt(wrong, c)).toBe(false);
  });
});

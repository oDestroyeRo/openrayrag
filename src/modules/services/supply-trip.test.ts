import {
  itemId,
  bagId,
  quantity,
  revisionFor,
  incrementRevision,
} from '../../shared/domain-values';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SUPPLY,
  SupplyTripRuntime,
  validateSupplySettings,
  validateSupplyResumeGuard,
  type SupplyContext,
  type SupplyIntent,
} from './supply-trip';
import { nextSupplyAction, previewSupplyTrip } from './supply-plan';
import { previewSupplySales } from './supply-sales-logic';
import { dispositionStockFloors } from './disposition-ui-logic';
import { createSupplyReceipt, observeSupplyReceipt, confirmSupplyReceipt } from './supply-receipt';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import { publishedDispositionMetadata } from './disposition-ui';
import { WorldState } from '../world/world-state';
import {
  validateDispositionPolicy,
  type DispositionAction,
  type DispositionPolicyView,
} from './disposition';
import type { SupplyPolicySettings } from './supply-trip-logic';
import type { WorkflowReceipt } from './workflows';
import { farmingReadiness } from '../client/farming-readiness-logic';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy-logic';
const rule = {
  itemId: 501,
  keep: 0,
  minimum: 5,
  desired: 10,
  maximum: 10,
  store: false,
  cart: false,
  sell: false,
  restock: 'buy' as const,
  allowUnique: false,
};
const policy = validateDispositionPolicy({ maxSpend: 1000, rules: [rule] });
const configured: SupplyPolicySettings = {
  ...DEFAULT_SETTINGS,
  map: 'prt_fild05',
  targets: [4000],
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    disposition: policy,
    supply: {
      ...DEFAULT_SUPPLY,
      enabled: true,
      maxTrips: 2,
      maxSpend: 1000,
      buyService: 'trader.prt-fild05.tool-dealer.buy.v1',
      sellService: 'trader.prt-fild05.tool-dealer.sell.v1',
      storageService: 'kafra.prontera-south.storage.v1',
    },
  },
};
it('admits portable auto-sell choices and requires a configured save map before departure', () => {
  expect(
    validateSupplySettings({
      ...DEFAULT_SUPPLY,
      merchantMode: 'automatic',
      transport: 'butterfly',
      saveMap: 'prontera',
      returnMinStock: 1,
    }),
  ).toMatchObject({ merchantMode: 'automatic', transport: 'butterfly', saveMap: 'prontera' });
  expect(() =>
    validateSupplySettings({
      ...DEFAULT_SUPPLY,
      enabled: true,
      transport: 'butterfly',
      saveMap: '',
    }),
  ).toThrow();
});
function context(stock = 4): SupplyContext & {
  disposition: SupplyContext['disposition'] & {
    workflow: SupplyContext['disposition']['workflow'] & { world: WorldState };
  };
} {
  const world = new WorldState();
  world.reset('prt_fild05');
  world.replaceCart([]);
  world.npc = { id: 20, mode: 'shop', dialog: null, options: [] };
  world.shop = {
    mode: 'buy',
    discountLevel: 0,
    entries: [{ itemId: 501, price: 50 }],
  };
  const items = stock ? [{ bagId: 501, itemId: 501, count: stock, type: 1 as const }] : [];
  return {
    character: 'Tester',
    epoch: '1',
    map: 'prt_fild05',
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
      revision: '1',
      containers: {
        inventory: { items, slots: 200, weight: stock * 70, maxWeight: 10000 },
        storage: {
          items: null,
          slots: 600,
          weight: null,
          maxWeight: 'unlimited',
        },
        cart: { items: [], slots: 100, weight: 0, maxWeight: 80000 },
      },
      equipment: [],
      ammoId: -1,
      metadata: publishedDispositionMetadata(),
      workflow: {
        map: 'prt_fild05',
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
  const items = n ? [{ bagId: 501, itemId: 501, count: n, type: 1 as const }] : [];
  c.disposition.containers.inventory.items = items;
  c.disposition.workflow.inventory = items;
  c.inventoryRevision = incrementRevision(c.inventoryRevision);
}
describe('readiness follows reachable supply planner service paths', () => {
  const review = (settings: SupplyPolicySettings) =>
    farmingReadiness(settings, null, {
      active: false,
      fresh: false,
      remainingSupplyTrips: 1,
      reconnectEnabled: false,
      reconnectAvailable: true,
    });
  it('requires storage before an automatic weight sale even when refill is off', () => {
    const c = context(12);
    const rules = validateDispositionPolicy({
      maxSpend: 0,
      rules: [{ ...rule, store: true, sell: true, restock: 'off' }],
    });
    const settings = {
      ...configured,
      automation: {
        ...configured.automation!,
        disposition: rules,
        supply: {
          ...DEFAULT_SUPPLY,
          enabled: true,
          stockEnabled: false,
          weightEnabled: true,
          merchantMode: 'automatic' as const,
        },
      },
    };
    expect(nextSupplyAction(c, [], rules, settings.automation.supply)).toEqual({
      type: 'blocked',
      reasons: ['A verified storage service must be selected.'],
    });
    expect(review(settings)).toContainEqual(
      expect.objectContaining({ id: 'service-storage', severity: 'error' }),
    );
    expect(review(settings).find((row) => row.id === 'service-sell')).toBeUndefined();
    settings.automation.supply.storageService = 'kafra.prontera-south.storage.v1';
    expect(nextSupplyAction(c, [], rules, settings.automation.supply)).toMatchObject({
      type: 'service',
      contractId: settings.automation.supply.storageService,
    });
    expect(review(settings).find((row) => row.id === 'service-storage')).toBeUndefined();
  });
  it('requires a manual sell service before disposing excess on a stock-triggered refill trip', () => {
    const c = context(12);
    const rules = validateDispositionPolicy({
      maxSpend: 1000,
      rules: [
        { ...rule, sell: true, restock: 'off' },
        { ...rule, itemId: 502 },
      ],
    });
    const shortage = rules.rules.find((rule) => rule.itemId === 502)!;
    const goals = [{ itemId: shortage.itemId, desired: shortage.desired }];
    const settings = {
      ...configured,
      automation: {
        ...configured.automation!,
        disposition: rules,
        supply: {
          ...DEFAULT_SUPPLY,
          enabled: true,
          stockEnabled: true,
          weightEnabled: false,
          buyService: 'trader.prt-fild05.tool-dealer.buy.v1',
        },
      },
    };
    expect(nextSupplyAction(c, goals, rules, settings.automation.supply)).toEqual({
      type: 'blocked',
      reasons: ['A verified sell service must be selected.'],
    });
    expect(review(settings)).toContainEqual(
      expect.objectContaining({ id: 'service-sell', severity: 'error' }),
    );
    settings.automation.supply.sellService = 'trader.prt-fild05.tool-dealer.sell.v1';
    expect(nextSupplyAction(c, goals, rules, settings.automation.supply)).toMatchObject({
      type: 'service',
      contractId: settings.automation.supply.sellService,
    });
    expect(review(settings).find((row) => row.id === 'service-sell')).toBeUndefined();
  });
});
it('previews only permitted excess, retains shared recovery floors and explains an unmet weight target', () => {
  const c = context(12),
    saleRule = {
      ...rule,
      keep: 2,
      minimum: 2,
      desired: 2,
      maximum: 2,
      sell: true,
      restock: 'off' as const,
    },
    salePolicy = validateDispositionPolicy({ maxSpend: 0, rules: [saleRule] });
  c.disposition.containers.inventory.maxWeight = 1000;
  c.disposition.minimumStock = [{ itemId: 501, count: 9 }];
  expect(previewSupplySales(salePolicy, c.disposition)).toMatchObject({
    eligible: [{ itemId: 501, count: 3, retained: 9 }],
    remainingWeight: 630,
  });
  const value = {
    ...configured,
    automation: {
      ...configured.automation!,
      disposition: salePolicy,
      supply: {
        ...DEFAULT_SUPPLY,
        enabled: true,
        stockEnabled: false,
        weightEnabled: true,
        merchantMode: 'automatic' as const,
      },
      limits: { ...DEFAULT_AUTOMATION.limits, weightPercent: 80 },
    },
  };
  const preview = previewSupplyTrip(value, c);
  expect(previewSupplyTrip(value, { ...c, remainingTrips: 0 })).toContain(
    '0 trips remaining (configured cap 1)',
  );
  expect(previewSupplyTrip(value, { ...c, remainingTrips: 0 })).toContain(
    'Stop/Start does not replenish spent trips.',
  );
  expect(preview).toContain('retained trip capacity unobserved (configured cap 1)');
  expect(preview).toContain('Eligible sale: item #501 × 3');
  expect(preview).toContain('Unmet weight target');
  expect(preview).toContain('hard stop prevents departure');
  expect(preview).toContain('No commands sent');
  c.disposition.equipment = [501];
  expect(previewSupplySales(salePolicy, c.disposition)).toMatchObject({
    eligible: [],
    protectedItems: [expect.stringContaining('Equipped item')],
  });
  c.disposition.equipment = [];
  c.disposition.ammoId = 501;
  expect(previewSupplySales(salePolicy, c.disposition).eligible).toEqual([]);
  c.disposition.ammoId = -1;
  c.disposition.containers.inventory.items = [
    { ...c.disposition.containers.inventory.items![0]!, type: 2 },
  ];
  expect(previewSupplySales(salePolicy, c.disposition).protectedItems[0]).toContain('Unique item');
  expect(
    dispositionStockFloors({
      ...DEFAULT_AUTOMATION,
      supply: {
        ...DEFAULT_SUPPLY,
        enabled: true,
        transport: 'butterfly',
        saveMap: 'prontera',
        returnMinStock: 3,
      },
    }),
  ).toContainEqual({ itemId: 602, count: 3 });
});
function setup(settings = configured) {
  let now = 100_000;
  const c = context();
  let confirmed = false;
  let plannedPolicy: DispositionPolicyView | undefined;
  const action: DispositionAction = {
    kind: 'buy',
    itemId: itemId(501),
    count: quantity(2),
    from: 'shop',
    to: 'inventory',
    command: { type: 'shop', mode: 'buy', rows: [{ id: 501, count: 2 }] },
    estimatedCost: 100,
    reservedSpend: 100,
    estimatedProceeds: 0,
  };
  const runtime = new SupplyTripRuntime(
    {
      next: (ctx, _goals, p) => {
        plannedPolicy = p;
        return (ctx.disposition.containers.inventory.items?.[0]?.count ?? 0) < 10
          ? { type: 'action', action }
          : { type: 'ready' };
      },
      confirm: (_r: { exact: boolean }) => confirmed,
    },
    () => now,
  );
  runtime.configure(settings, c);
  const next = () => runtime.next(c)!;
  const prepare = () => {
    const i = next();
    expect(i.type).toBe('prepare');
    runtime.acknowledge(i.id, 'confirmed', c);
  };
  const send = () => {
    const i = next();
    expect(i.type).toBe('action');
    runtime.attachReceipt(i.id, { exact: true }, c);
    expect(runtime.commandAllowed()).toBe(true);
    runtime.markSent(i.id);
    return i;
  };
  const ack = (i: SupplyIntent) => runtime.acknowledge(i.id, 'confirmed', c);
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
describe('bounded supply runtime', () => {
  it('defaults off and strictly validates limits/IDs and config-free guards', () => {
    expect(validateSupplySettings(DEFAULT_SUPPLY).enabled).toBe(false);
    expect(validateSupplySettings(DEFAULT_SUPPLY).maxActions).toBe(100);
    expect(validateSupplySettings(configured.automation!.supply!).buyService).toContain('.v1');
    for (const patch of [
      { enabled: 1 },
      { maxTrips: 0 },
      { maxActions: 1001 },
      { maxSpend: 2000000001 },
      { weightEndPercent: 80 },
      { unknown: true },
      { buyService: 'x'.repeat(129) },
    ])
      expect(() => validateSupplySettings({ ...DEFAULT_SUPPLY, ...patch })).toThrow();
    const f = setup();
    const guard = f.runtime.guard()!;
    expect(validateSupplyResumeGuard(guard)).toEqual(guard);
    for (const patch of [
      { character: '' },
      { remainingTrips: 101 },
      { actorId: 20 },
      { returnDestination: { map: 'prt_fild05', position: { x: 512, y: 0 } } },
    ])
      expect(() => validateSupplyResumeGuard({ ...guard, ...patch })).toThrow();
  });
  it('captures desired targets and continues after partial refill crosses minimum', () => {
    const f = setup();
    f.prepare();
    f.send();
    setStock(f.c, 6);
    f.confirm();
    f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
    const close = f.next();
    expect(close.type).toBe('close');
    f.ack(close);
    expect(f.next().type).toBe('action');
    expect(f.getPolicy()?.rules[0]?.minimum).toBe(10);
    expect(f.runtime.snapshot().goals).toEqual([{ itemId: 501, desired: 10 }]);
    expect(f.runtime.snapshot()).toMatchObject({
      spent: 100,
      reserved: 200,
      remainingTrips: 1,
    });
  });
  it.each(['same', 'cross'] as const)(
    'returns to the captured %s map and exact work cell before one resume',
    (kind) => {
      const f = setup();
      f.prepare();
      f.send();
      setStock(f.c, 10);
      f.confirm();
      f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
      const close = f.next();
      f.ack(close);
      expect(f.runtime.snapshot().reason).toBe('Returning to the captured map and work cell.');
      const ret = f.next();
      expect(ret).toMatchObject({
        type: 'return',
        map: 'prt_fild05',
        position: { x: 289, y: 220 },
      });
      if (kind === 'cross') f.c.map = 'prontera';
      f.c.position = { x: 288, y: 220 };
      f.ack(ret);
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      f.c.map = 'prt_fild05';
      f.ack(ret);
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      f.c.position = { x: 289, y: 220 };
      f.ack(ret);
      const resume = f.runtime.resumeIntent(f.c)!;
      expect(resume).toMatchObject({ type: 'resume', settings: configured });
      f.ack(resume);
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      expect(f.runtime.next(f.c)).toBeNull();
    },
  );
  it.each(['prepare', 'before-send', 'after-send', 'close', 'return'] as const)(
    'Stop invalidates %s continuation and preserves only sent uncertainty',
    (stage) => {
      const f = setup();
      if (stage === 'prepare') f.next();
      else {
        f.prepare();
        if (stage === 'before-send') {
          const i = f.next();
          f.runtime.attachReceipt(i.id, { exact: true }, f.c);
        } else {
          f.send();
          if (stage === 'close' || stage === 'return') {
            setStock(f.c, 10);
            f.confirm();
            f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
            const close = f.next();
            if (stage === 'return') {
              f.ack(close);
              f.next();
            }
          }
        }
      }
      f.runtime.stop();
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
      expect(f.runtime.uncertain).toBe(stage === 'after-send');
      if (stage === 'after-send') {
        f.confirm();
        expect(f.runtime.uncertain).toBe(false);
        expect(f.runtime.snapshot().state).toBe('cancelled');
      }
    },
  );
  it.each(['timeout', 'manual', 'death', 'map', 'disconnect', 'send-throw'] as const)(
    'retains exact economics after %s without another intention',
    (event) => {
      const f = setup();
      f.prepare();
      f.send();
      if (event === 'timeout') f.advance(10001);
      else f.runtime.interrupt(event);
      expect(f.runtime.uncertain).toBe(true);
      expect(f.runtime.next(f.c)).toBeNull();
      f.confirm();
      expect(f.runtime.uncertain).toBe(false);
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.resumeIntent(f.c)).toBeNull();
    },
  );
  it('timeout diagnostics preserve an earlier service interruption after the whole-trip deadline', () => {
    const f = setup();
    f.prepare();
    const reason = 'NPC approach timed out before any sale was sent.';
    f.runtime.interrupt(reason);
    const before = f.runtime.snapshot();

    f.advance(600001);

    expect(f.runtime.snapshot()).toMatchObject({
      state: 'waiting',
      reason,
      uncertain: false,
      remainingTrips: before.remainingTrips,
      actions: before.actions,
      spent: before.spent,
      reserved: before.reserved,
    });
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.resumeIntent(f.c)).toBeNull();
    expect(f.runtime.commandAllowed()).toBe(false);
    expect(f.runtime.snapshot().reason).toBe(reason);
  });
  it('timeout diagnostics preserve the exact-receipt failure after the whole-trip deadline', () => {
    const f = setup();
    f.prepare();
    f.send();
    f.advance(10001);
    const before = f.runtime.snapshot();
    expect(before.reason).toContain('without an exact receipt');

    f.advance(600001);

    expect(f.runtime.snapshot()).toMatchObject({
      state: 'waiting',
      reason: before.reason,
      uncertain: true,
      remainingTrips: before.remainingTrips,
      actions: before.actions,
      spent: before.spent,
      reserved: before.reserved,
    });
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.resumeIntent(f.c)).toBeNull();
  });
  it('timeout diagnostics do not claim unresolved economics when an active trip sent no transaction', () => {
    const f = setup();
    f.prepare();

    f.advance(600001);

    expect(f.runtime.snapshot()).toMatchObject({
      state: 'waiting',
      uncertain: false,
      actions: 0,
      spent: 0,
      reserved: 0,
    });
    expect(f.runtime.snapshot().reason).toContain('duration limit');
    expect(f.runtime.snapshot().reason).not.toContain('unresolved economics');
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.resumeIntent(f.c)).toBeNull();
  });
  it('timeout diagnostics retain a recent sent receipt at the whole-trip deadline and drain a late exact result', () => {
    const f = setup();
    f.prepare();
    f.advance(595000);
    f.send();

    f.advance(5001);

    const before = f.runtime.snapshot();
    expect(before).toMatchObject({ state: 'waiting', uncertain: true, actions: 1, reserved: 100 });
    expect(before.reason).toContain('Whole-trip duration limit');
    expect(before.reason).toContain('transaction was awaiting confirmation');
    expect(f.runtime.next(f.c)).toBeNull();
    f.advance(10000);
    expect(f.runtime.snapshot().reason).toBe(before.reason);
    f.confirm();
    expect(f.runtime.snapshot()).toMatchObject({
      state: 'waiting',
      uncertain: false,
      reason: before.reason,
      actions: 1,
      spent: 100,
      reserved: 100,
    });
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.resumeIntent(f.c)).toBeNull();
  });
  it.each([25740, 24430])(
    'timeout diagnostics preserve unmet protected weight %i after the final permitted sale and exact closure',
    (weight) => {
      let now = 100000;
      const c = context(0);
      const protectedItems = [{ bagId: 501, itemId: 501, count: 367, type: 1 as const }];
      const items = [...protectedItems, { bagId: 1052, itemId: 1052, count: 10, type: 1 as const }];
      c.disposition.containers.inventory.items = items;
      c.disposition.containers.inventory.weight = 30000;
      c.disposition.containers.inventory.maxWeight = 34900;
      c.disposition.workflow.inventory = items;
      c.disposition.workflow.world.shop!.mode = 'sell';
      const disposition = validateDispositionPolicy({
        maxSpend: 0,
        rules: [
          {
            ...rule,
            itemId: 1052,
            minimum: 0,
            desired: 0,
            maximum: 0,
            sell: true,
            restock: 'off',
          },
        ],
      });
      const supply = {
        ...configured.automation!.supply!,
        stockEnabled: false,
        weightEnabled: true,
        weightStartPercent: 80,
        weightEndPercent: 70,
        maxSpend: 0,
      };
      const runtime = new SupplyTripRuntime(
        {
          next: (ctx, goals, policy) => nextSupplyAction(ctx, goals, policy, supply),
          confirm: confirmSupplyReceipt,
        },
        () => now,
      );
      runtime.configure(
        { ...configured, automation: { ...configured.automation!, disposition, supply } },
        c,
      );
      const prepare = runtime.next(c)!;
      expect(prepare.type).toBe('prepare');
      runtime.acknowledge(prepare.id, 'confirmed', c);
      const sale = runtime.next(c)!;
      if (sale.type !== 'action') throw Error('Expected the last permitted common-drop sale.');
      expect(sale.action).toMatchObject({ kind: 'sell', itemId: 1052, count: 10 });
      const receipt = createSupplyReceipt(
        sale.action,
        {
          zeny: c.disposition.workflow.zeny,
          cost: 0,
          credit: sale.action.estimatedProceeds,
          items: new Map(items.map((item) => [itemId(item.itemId), quantity(item.count)])),
          bags: new Map(items.map((item) => [bagId(item.bagId), quantity(item.count)])),
          itemChanges: new Map([[itemId(1052), -10]]),
          bagChanges: new Map([[bagId(1052), -10]]),
          strictStock: false,
        },
        c,
      );
      runtime.attachReceipt(sale.id, receipt, c);
      expect(runtime.commandAllowed()).toBe(true);
      runtime.markSent(sale.id);
      c.disposition.containers.inventory.items = protectedItems;
      c.disposition.containers.inventory.weight = weight;
      c.disposition.workflow.inventory = protectedItems;
      c.inventoryRevision = incrementRevision(c.inventoryRevision);
      c.disposition.workflow.zeny += sale.action.estimatedProceeds;
      c.currencyRevision = incrementRevision(c.currencyRevision);
      runtime.observe(c);
      expect(runtime.snapshot().uncertain).toBe(false);
      c.disposition.workflow.world.apply({ type: 'npcEnd' });
      const close = runtime.next(c)!;
      expect(close.type).toBe('close');
      runtime.acknowledge(close.id, 'confirmed', c);
      expect(runtime.next(c)).toBeNull();
      const reason = runtime.snapshot().reason;
      expect(reason).toContain(`${((weight / 34900) * 100).toFixed(2)}% (${weight}/34900)`);
      expect(reason).toContain('below 70%');
      expect(reason).toContain('Protected stock remains retained');
      expect(reason).toContain('finish threshold, storage setup or explicit item permissions');
      expect(c.disposition.containers.inventory.items).toEqual(protectedItems);
      const before = runtime.snapshot();
      expect(runtime.commandAllowed()).toBe(false);

      now += 600001;
      runtime.observe(c);

      expect(runtime.snapshot()).toEqual(before);
      expect(runtime.next(c)).toBeNull();
      expect(runtime.resumeIntent(c)).toBeNull();
      expect(c.disposition.containers.inventory.items).toEqual(protectedItems);
    },
  );
  it('requires fresh inventory AND currency after connection reset; never repeats the old action', () => {
    const f = setup();
    f.prepare();
    f.send();
    f.c.epoch = '2';
    f.c.fresh = false;
    f.runtime.observe(f.c);
    expect(f.runtime.uncertain).toBe(true);
    f.c.fresh = true;
    f.c.inventoryRevision = incrementRevision(f.c.inventoryRevision);
    f.runtime.observe(f.c);
    expect(f.runtime.uncertain).toBe(true);
    f.c.currencyRevision = incrementRevision(f.c.currencyRevision);
    f.runtime.observe(f.c);
    expect(f.runtime.uncertain).toBe(false);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().reason).toContain('outcome remains unknown');
  });
  it('retains latch, allowance, budget and interrupted return across reload', () => {
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
      state: 'waiting',
    });
    expect(resumed.runtime.next(resumed.c)).toBeNull();
    expect(Object.keys(guard)).not.toContain('action');
    expect(Object.keys(guard)).not.toContain('settings');
    expect(Object.keys(guard)).not.toContain('npcId');
  });
  it('does not treat an empty plan as success or replenish its cap from sale proceeds', () => {
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
    f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
    const close = f.next();
    f.ack(close);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().reason).toContain('budget');
  });
  it('waits for resource/cast settlement before prepare and counts finite commands', () => {
    const f = setup({
      ...configured,
      automation: {
        ...configured.automation!,
        supply: { ...configured.automation!.supply!, maxActions: 1 },
      },
    });
    f.c.canPrepare = false;
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().reason).toContain('casts');
    f.c.canPrepare = true;
    f.prepare();
    expect(f.runtime.commandAllowed()).toBe(true);
    expect(f.runtime.commandAllowed()).toBe(false);
    expect(f.runtime.next(f.c)).toBeNull();
  });
  it.each([500, 1000])('enforces exactly %i commands across the whole trip', (maxActions) => {
    const f = setup({
      ...configured,
      automation: {
        ...configured.automation!,
        supply: { ...configured.automation!.supply!, maxActions },
      },
    });
    f.prepare();
    for (let command = 0; command < maxActions; command++)
      expect(f.runtime.commandAllowed()).toBe(true);
    expect(f.runtime.guard()?.actions).toBe(maxActions);
    expect(f.runtime.commandAllowed()).toBe(false);
    expect(f.runtime.snapshot()).toMatchObject({ actions: maxActions, state: 'waiting' });
    expect(f.runtime.next(f.c)).toBeNull();
  });
  it('blocks unknown inventory, weight, capacity, equipment and uncertain external economics', () => {
    for (const field of ['stock', 'weight', 'capacity', 'equipment', 'uncertain'] as const) {
      const f = setup();
      if (field === 'stock') f.c.disposition.containers.inventory.items = null;
      if (field === 'weight') f.c.disposition.containers.inventory.weight = null;
      if (field === 'capacity') f.c.disposition.containers.inventory.slots = null;
      if (field === 'equipment') f.c.disposition.equipment = null;
      if (field === 'uncertain') f.c.economicUncertain = true;
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.snapshot().remainingTrips).toBe(2);
    }
  });
  it('suppresses stable triggers and enforces interval after recovery, including a guard restore', () => {
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
    expect(g.runtime.next(g.c)?.type).toBe('prepare');
    expect(g.runtime.snapshot().remainingTrips).toBe(0);
  });
});
describe('supply direct configuration allowance', () => {
  it('preserves counters above 255 through Stop, guard serialization and explicit replacement', () => {
    const settings = {
      ...configured,
      automation: {
        ...configured.automation!,
        supply: { ...configured.automation!.supply!, maxActions: 500 },
      },
    };
    const f = setup(settings);
    f.prepare();
    for (let transaction = 0; transaction < 3; transaction++) {
      f.send();
      f.confirm();
      f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
      f.ack(f.next());
    }
    for (let command = 3; command < 300; command++) expect(f.runtime.commandAllowed()).toBe(true);
    f.runtime.stop();
    const guard = validateSupplyResumeGuard(JSON.parse(JSON.stringify(f.runtime.guard())));
    expect(guard).toMatchObject({ actions: 300, spent: 300, reserved: 300, remainingTrips: 1 });
    const resumed = setup(settings);
    resumed.runtime.configure(
      settings,
      resumed.c,
      { ...guard, interrupted: false },
      {
        explicitStart: true,
      },
    );
    resumed.advance(300001);
    resumed.prepare();
    expect(resumed.runtime.snapshot()).toMatchObject({
      actions: 300,
      spent: 300,
      reserved: 300,
      remainingTrips: 0,
      returnDestination: guard.returnDestination,
    });
    for (let command = 300; command < 500; command++)
      expect(resumed.runtime.commandAllowed()).toBe(true);
    expect(resumed.runtime.commandAllowed()).toBe(false);
    expect(resumed.runtime.guard()?.actions).toBe(500);
  });
  it('charges one explicit replacement after settlement and interval without resetting cumulative economics or destination', () => {
    const f = setup();
    f.prepare();
    f.send();
    f.confirm();
    f.runtime.stop();
    const original = f.runtime.guard()!;
    f.c.position = { x: 100, y: 100 };
    f.runtime.configure(configured, f.c, undefined, { explicitStart: true });
    expect(f.runtime.ownsField).toBe(true);
    expect(f.runtime.snapshot()).toMatchObject({
      state: 'waiting',
      latched: true,
      remainingTrips: 1,
      actions: 1,
      spent: 100,
      reserved: 100,
      deadline: 0,
      returnDestination: original.returnDestination,
    });
    f.advance(300001);
    f.c.settled = false;
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().remainingTrips).toBe(1);
    f.c.settled = true;
    expect(f.runtime.next(f.c)?.type).toBe('prepare');
    expect(f.runtime.snapshot()).toMatchObject({
      remainingTrips: 0,
      actions: 1,
      spent: 100,
      reserved: 100,
      returnDestination: original.returnDestination,
    });
    expect(f.runtime.snapshot().deadline).toBeGreaterThan(400000);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().remainingTrips).toBe(0);
  });
  it.each(['default', 'restore', 'automatic', 'Stop', 'connection'] as const)(
    'does not grant replacement permission through %s',
    (boundary) => {
      const f = setup();
      f.prepare();
      f.runtime.stop();
      const guard = f.runtime.guard()!;
      f.runtime.configure(
        configured,
        f.c,
        boundary === 'automatic'
          ? { ...guard, interrupted: true }
          : boundary === 'restore'
            ? { ...guard, interrupted: false }
            : undefined,
        { explicitStart: boundary !== 'default' && boundary !== 'restore' },
      );
      if (boundary === 'Stop') f.runtime.stop();
      if (boundary === 'connection') {
        f.c.connected = false;
        f.runtime.observe(f.c);
        f.c.connected = true;
      }
      f.advance(300001);
      expect(f.runtime.next(f.c)).toBeNull();
      expect(f.runtime.snapshot()).toMatchObject({
        remainingTrips: 1,
        latched: true,
        returnDestination: guard.returnDestination,
      });
    },
  );
  it.each([
    'stale',
    'dead',
    'foreign',
    'economics',
    'inventory',
    'revisions',
    'policy',
    'destination',
    'exhausted',
    'actions',
    'save-return',
  ] as const)('does not charge or dispatch a replacement with %s evidence', (boundary) => {
    const f = setup();
    f.prepare();
    f.runtime.stop();
    const guard = f.runtime.guard()!;
    const input: SupplyPolicySettings = {
      ...configured,
      map: boundary === 'destination' ? 'prontera' : configured.map,
      automation: {
        ...configured.automation!,
        ...(boundary === 'policy'
          ? { mapPolicy: { ...DEFAULT_MAP_POLICY, deny: ['prt_fild05'] } }
          : {}),
        ...(boundary === 'save-return'
          ? {
              supply: {
                ...configured.automation!.supply!,
                transport: 'butterfly',
                saveMap: 'prontera',
              },
            }
          : {}),
      },
    };
    f.runtime.configure(
      input,
      f.c,
      {
        ...guard,
        interrupted: false,
        ...(boundary === 'exhausted' ? { remainingTrips: 0 } : {}),
        ...(boundary === 'actions' ? { actions: 100 } : {}),
      },
      { explicitStart: true },
    );
    if (boundary === 'stale') f.c.fresh = false;
    if (boundary === 'dead') f.c.alive = false;
    if (boundary === 'foreign') f.c.character = 'Other';
    if (boundary === 'economics') f.c.economicUncertain = true;
    if (boundary === 'inventory') f.c.disposition.containers.inventory.items = null;
    if (boundary === 'revisions') f.c.currencyRevision = revisionFor('currency', 0);
    if (boundary === 'policy') f.c.map = 'prontera';
    f.advance(300001);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot()).toMatchObject({
      remainingTrips: boundary === 'exhausted' ? 0 : 1,
      latched: true,
      returnDestination: guard.returnDestination,
    });
    expect(f.runtime.ownsField).toBe(true);
  });
  it('fresh economics reconcile a restored uncertain guard without granting replacement permission', () => {
    const f = setup();
    f.prepare();
    f.send();
    const g = setup();
    g.runtime.configure(configured, g.c, f.runtime.guard(), { explicitStart: true });
    g.advance(300001);
    expect(g.runtime.uncertain).toBe(false);
    expect(g.runtime.next(g.c)).toBeNull();
    expect(g.runtime.snapshot().remainingTrips).toBe(1);
  });
  it('returns without another transaction when fresh recovery observations already satisfy the captured goals', () => {
    const f = setup();
    f.prepare();
    f.runtime.stop();
    setStock(f.c, 10);
    f.runtime.configure(configured, f.c, undefined, { explicitStart: true });
    f.advance(300001);
    const close = f.next();
    expect(close.type).toBe('close');
    f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
    f.ack(close);
    expect(f.next().type).toBe('return');
    expect(f.runtime.snapshot()).toMatchObject({ latched: true, remainingTrips: 0, actions: 0 });
  });
  it.each(['explicit destination', 'lock area'] as const)(
    'uses the existing %s precedence when admitting the captured work map',
    (boundary) => {
      const f = setup();
      f.prepare();
      f.runtime.stop();
      const input: SupplyPolicySettings = {
        ...configured,
        map: 'prontera',
        automation: {
          ...configured.automation!,
          travel: {
            ...configured.automation!.travel,
            destinationMap: boundary === 'explicit destination' ? 'prt_fild05' : 'prontera',
          },
          ...(boundary === 'lock area'
            ? {
                mapPolicy: {
                  ...DEFAULT_MAP_POLICY,
                  lockArea: { map: 'prt_fild05', minX: 280, minY: 210, maxX: 300, maxY: 230 },
                },
              }
            : {}),
        },
      };
      f.runtime.configure(input, f.c, undefined, { explicitStart: true });
      f.advance(300001);
      expect(f.next().type).toBe('prepare');
    },
  );
  it('admits the full existing signed-32-bit currency range for fresh supply recovery', () => {
    const f = setup();
    f.prepare();
    f.runtime.stop();
    f.c.disposition.workflow.zeny = 2_147_483_647;
    f.runtime.configure(configured, f.c, undefined, { explicitStart: true });
    f.advance(300001);
    expect(f.next()?.type).toBe('prepare');
  });
  it('publishes exhausted retained capacity instead of waiting for a trigger or renewing it on configure', () => {
    const f = setup();
    const retained = {
      version: 1 as const,
      character: f.c.character,
      latched: false,
      remainingTrips: 0,
      actions: 0,
      spent: 0,
      reserved: 0,
      intervalSeconds: 0,
      deadlineSeconds: 0,
      interrupted: false,
      uncertain: false,
      returnDestination: null,
    };
    f.runtime.configure(configured, f.c, retained);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot()).toMatchObject({
      remainingTrips: 0,
      reason:
        'Supply trip allowance exhausted. Stop/Start and unlimited farming time do not replenish spent trips.',
    });
    f.runtime.stop();
    f.runtime.configure(configured, f.c);
    expect(f.runtime.next(f.c)).toBeNull();
    expect(f.runtime.snapshot().remainingTrips).toBe(0);
    expect(f.runtime.snapshot().reason).toContain('exhausted');
  });
  it('keeps consumed allowance when a disabled runtime is configured without window telemetry', () => {
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
describe('supply configuration atomicity', () => {
  it.each(['foreign', 'unknown', 'settings'] as const)(
    'preserves the configured runtime after rejecting %s input',
    (kind) => {
      const f = setup();
      f.prepare();
      const before = f.runtime.snapshot(),
        guard = f.runtime.guard()!;
      const request =
        kind === 'foreign'
          ? { ...guard, character: 'Other' }
          : kind === 'unknown'
            ? { ...guard, injected: true }
            : guard;
      const input =
        kind === 'settings'
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
describe('supply repair regressions', () => {
  it('records achieved stock recovery before the minimum interval expires', () => {
    const f = setup();
    f.prepare();
    f.send();
    setStock(f.c, 10);
    f.confirm();
    f.c.disposition.workflow.world.apply({ type: 'npcEnd' });
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
    expect(f.runtime.next(f.c)?.type).toBe('prepare');
    expect(f.runtime.snapshot().remainingTrips).toBe(0);
  });
  it('closes confirmed full storage before cart fallback and keeps unknown preference blocked', () => {
    const c = context(12);
    c.disposition.workflow.world.npc.mode = 'storage';
    c.disposition.workflow.world.storageReady = true;
    c.disposition.containers.storage.items = Array.from({ length: 600 }, (_, i) => ({
      bagId: i + 10000,
      itemId: i + 10000,
      count: 1,
      type: 1 as const,
    }));
    const p = validateDispositionPolicy({
      maxSpend: 0,
      rules: [{ ...rule, store: true, cart: true, restock: 'off' as const }],
    });
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!)).toEqual({
      type: 'close',
    });
    c.disposition.workflow.world.apply({ type: 'npcEnd' });
    c.disposition.containers.storage.items = null;
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!, {
        storageFull: {
          character: c.character,
          epoch: c.epoch,
          revision: c.disposition.revision,
        },
      }),
    ).toMatchObject({ type: 'action', action: { kind: 'cart', count: 2 } });
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!)).toMatchObject({
      type: 'service',
      contractId: 'kafra.prontera-south.storage.v1',
    });
  });
  it('does not reuse full storage evidence after character, connection or observed capacity changes', () => {
    const c = context(12),
      p = validateDispositionPolicy({
        maxSpend: 0,
        rules: [{ ...rule, store: true, sell: true, restock: 'off' as const }],
      });
    c.disposition.workflow.world.apply({ type: 'npcEnd' });
    const evidence = {
      storageFull: {
        character: c.character,
        epoch: c.epoch,
        revision: c.disposition.revision,
      },
    };
    for (const changed of [{ character: 'Other' }, { epoch: '2' }])
      expect(
        nextSupplyAction({ ...c, ...changed }, [], p, configured.automation!.supply!, evidence),
      ).toMatchObject({
        type: 'service',
        contractId: 'kafra.prontera-south.storage.v1',
      });
    c.disposition.containers.storage.items = [];
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!, evidence)).toMatchObject({
      type: 'service',
      contractId: 'kafra.prontera-south.storage.v1',
    });
  });
  it('retains a proven-full preferred storage phase when visiting the explicitly configured sell service', () => {
    const c = context(12);
    const p = validateDispositionPolicy({
      maxSpend: 0,
      rules: [{ ...rule, store: true, sell: true, restock: 'off' as const }],
    });
    c.disposition.workflow.world.apply({ type: 'npcEnd' });
    expect(
      nextSupplyAction(c, [], p, configured.automation!.supply!, {
        storageFull: {
          character: c.character,
          epoch: c.epoch,
          revision: c.disposition.revision,
        },
      }),
    ).toMatchObject({
      type: 'service',
      contractId: 'trader.prt-fild05.tool-dealer.sell.v1',
    });
    c.disposition.workflow.world.npc = {
      id: 20,
      mode: 'shop',
      options: [],
      dialog: null,
    };
    c.disposition.workflow.world.shop = {
      mode: 'sell',
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
    ).toMatchObject({ type: 'action', action: { kind: 'sell', count: 2 } });
  });
  it('preserves unpermitted excess while planning an unrelated safe refill', () => {
    const c = context();
    c.disposition.containers.inventory.items!.push({
      bagId: 512,
      itemId: 512,
      count: 10,
      type: 1,
    });
    c.disposition.workflow.inventory = c.disposition.containers.inventory.items!;
    const p = validateDispositionPolicy({
      ...policy,
      rules: [
        {
          ...rule,
          itemId: 512,
          minimum: 0,
          desired: 0,
          maximum: 0,
          restock: 'off' as const,
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
      type: 'action',
      action: { kind: 'buy', itemId: 501, count: 6 },
    });
  });
});
describe('phase planning and exact receipts', () => {
  it('opens the source-backed dealer and revalidates changed prices from current state', () => {
    const c = context();
    c.disposition.workflow.world.apply({ type: 'npcEnd' });
    expect(
      nextSupplyAction(
        c,
        [{ itemId: itemId(501), desired: quantity(10) }],
        policy,
        configured.automation!.supply!,
      ),
    ).toMatchObject({
      type: 'service',
      contractId: 'trader.prt-fild05.tool-dealer.buy.v1',
      fee: 0,
    });
    c.disposition.workflow.world.npc = {
      id: 20,
      mode: 'shop',
      dialog: null,
      options: [],
    };
    c.disposition.workflow.world.shop = {
      mode: 'buy',
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
      type: 'action',
      action: { count: 5, reservedSpend: 1000 },
    });
  });
  it('unknown preferred storage cannot authorize a fallback sale', () => {
    const c = context(12);
    const p = validateDispositionPolicy({
      maxSpend: 1000,
      rules: [{ ...rule, store: true, sell: true, restock: 'off' as const }],
    });
    expect(
      nextSupplyAction(c, [], p, {
        ...configured.automation!.supply!,
        storageService: '',
      }),
    ).toMatchObject({ type: 'blocked' });
  });
  it('disposes excess first and preserves source stock, equipped and selected ammo', () => {
    const c = context(12);
    c.disposition.workflow.world.shop!.mode = 'sell';
    const p = validateDispositionPolicy({
      maxSpend: 1000,
      rules: [{ ...rule, sell: true, restock: 'off' as const }],
    });
    c.disposition.minimumStock = [{ itemId: 501, count: 11 }];
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!)).toMatchObject({
      type: 'action',
      action: { kind: 'sell', count: 1 },
    });
    c.disposition.ammoId = 501;
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!)).toMatchObject({
      type: 'blocked',
    });
    c.disposition.ammoId = -1;
    c.disposition.equipment = [501];
    expect(nextSupplyAction(c, [], p, configured.automation!.supply!)).toMatchObject({
      type: 'blocked',
    });
  });
  it('requires exact stock and money even after NPC end; later excess gains do not confirm', () => {
    const c = context();
    const action = nextSupplyAction(
      c,
      [{ itemId: itemId(501), desired: quantity(10) }],
      policy,
      configured.automation!.supply!,
    );
    if (action.type !== 'action') throw Error();
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
    c.disposition.workflow.world.apply({ type: 'npcEnd' });
    setStock(c, 10);
    expect(confirmSupplyReceipt(r, c)).toBe(false);
    c.disposition.workflow.zeny = 700;
    c.currencyRevision = incrementRevision(c.currencyRevision);
    expect(confirmSupplyReceipt(r, c)).toBe(true);
    setStock(c, 11);
    expect(confirmSupplyReceipt(r, c)).toBe(false);
    c.map = 'prontera';
    expect(confirmSupplyReceipt(r, c)).toBe(false);
  });
  it('retains exact container gain from transfer receipt when NPC closes before inventory', () => {
    const c = context(12);
    c.disposition.workflow.world.npc.mode = 'storage';
    c.disposition.workflow.world.storageReady = true;
    c.disposition.containers.storage.items = [];
    const action: DispositionAction = {
      kind: 'store',
      itemId: itemId(501),
      count: quantity(2),
      from: 'inventory',
      to: 'storage',
      bagId: bagId(501),
      command: { type: 'storage', operation: 'deposit', bagId: 501, count: 2 },
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
          type: 'storageMoved',
          deposit: true,
          currentWeight: 700,
          storageCount: 1,
          item: { bagId: 501, itemId: 501, type: 1, count: 2 },
          change: 2,
        },
      ],
      c,
    );
    c.disposition.workflow.world.apply({ type: 'npcEnd' });
    setStock(c, 10);
    expect(confirmSupplyReceipt(r, c)).toBe(true);
    const wrong = createSupplyReceipt(action, economic, context(12));
    setStock(c, 10);
    expect(confirmSupplyReceipt(wrong, c)).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import {
  bagId,
  itemId,
  quantity,
  seconds,
  revisionFor,
  type ItemId,
  type BagId,
  type Quantity,
} from '../../shared/domain-values';
import {
  DEFAULT_DISPOSITION,
  planDisposition,
  planAdmittedDisposition,
  validateDispositionPolicy,
  type DispositionContext,
  type DispositionPolicy,
  type ValidatedDispositionPolicy,
} from './disposition';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  automationSettings,
  validateAutomation,
  validateSettings,
  type ValidatedAutomationSettings,
  type RunSettings,
} from '../settings/settings';
import { DEFAULT_SUPPLY, type SupplyContext, type SupplyGoal } from './supply-trip-logic';
import { SupplyTripRuntime } from './supply-trip';
import { nextSupplyAction, previewSupplyTrip } from './supply-plan';
import type { SupplyReceipt } from './supply-receipt-logic';
import { WorldState } from '../world/world-state';

const rawPolicy = (): DispositionPolicy => ({
  maxSpend: 1000,
  rules: [
    {
      itemId: 501,
      keep: 2,
      minimum: 3,
      desired: 5,
      maximum: 6,
      store: false,
      sell: true,
      cart: false,
      restock: 'buy',
      allowUnique: false,
    },
  ],
});
function context(stock = 10): SupplyContext {
  const items = [{ bagId: 501, itemId: 501, count: stock, type: 1 as const }];
  const world = new WorldState();
  world.reset('prontera');
  world.npc = { id: 42, mode: 'shop', dialog: null, options: [] };
  world.shop = { mode: 'sell', discountLevel: 0, entries: [{ itemId: 501, price: 50 }] };
  return {
    character: 'Tester',
    epoch: '1',
    map: 'prontera',
    position: { x: 10, y: 10 },
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
      revision: '1:prontera:1',
      containers: {
        inventory: { items, slots: 200, weight: stock * 70, maxWeight: 10000 },
        storage: { items: [], slots: 600, weight: null, maxWeight: 'unlimited' },
        cart: { items: [], slots: 100, weight: 0, maxWeight: 80000 },
      },
      equipment: [],
      ammoId: -1,
      metadata: {
        501: {
          weight: 70,
          sellPrice: 25,
          itemClass: 0,
          unique: false,
          store: true,
          sell: true,
          cart: true,
          buy: true,
        },
      },
      workflow: {
        map: 'prontera',
        playerId: 1,
        alive: true,
        idle: true,
        inventory: items,
        equipped: [],
        zeny: 1000,
        world,
        visibleNpcIds: [42],
        pushCartLevel: 1,
      },
    },
  };
}

describe('disposition and supply domain admission', () => {
  it('retains the original JSON shape and detaches every admitted rule', () => {
    const raw = rawPolicy(),
      before = JSON.stringify(raw),
      admitted = validateDispositionPolicy(raw);
    expect(JSON.stringify(admitted)).toBe(before);
    expect(Object.getOwnPropertySymbols(admitted)).toEqual([]);
    raw.rules[0]!.desired = 4;
    raw.rules.push({ ...raw.rules[0]!, itemId: 512 });
    raw.maxSpend = 0;
    expect(admitted.rules).toHaveLength(1);
    expect(admitted.rules[0]!.desired).toBe(5);
    expect(admitted.maxSpend).toBe(1000);
    expect(validateDispositionPolicy(DEFAULT_DISPOSITION)).toEqual(DEFAULT_DISPOSITION);
  });
  it('keeps ordered aggregate failures and accepted range endpoints', () => {
    const raw = rawPolicy(),
      rule = raw.rules[0]!;
    expect(() => validateDispositionPolicy({ maxSpend: -1, rules: null })).toThrow(
      'Invalid disposition quantity or identifier.',
    );
    expect(() =>
      validateDispositionPolicy({ ...raw, rules: [{ ...rule, keep: 4, sell: 1 }] }),
    ).toThrow('Disposition quantities must satisfy keep ≤ minimum ≤ desired ≤ maximum.');
    expect(() =>
      validateDispositionPolicy({ ...raw, rules: [rule, { ...rule, sell: 1 }] }),
    ).toThrow('Invalid disposition permissions.');
    expect(() => validateDispositionPolicy({ ...raw, rules: [rule, rule] })).toThrow(
      'Conflicting disposition rules for the same item.',
    );
    expect(
      validateDispositionPolicy({
        maxSpend: 2_000_000_000,
        rules: [
          { ...rule, itemId: 2_147_483_647, keep: 0, minimum: 0, desired: 32767, maximum: 32767 },
        ],
      }),
    ).toMatchObject({ maxSpend: 2_000_000_000, rules: [{ desired: 32767 }] });
  });
  it('retains nested disposition admission without sharing editor rules', () => {
    const raw = { ...structuredClone(DEFAULT_AUTOMATION), disposition: rawPolicy() };
    const admitted = validateAutomation(raw);
    expect(automationSettings({ automation: admitted }).disposition).toEqual(raw.disposition);
    raw.disposition.rules[0]!.minimum = 4;
    expect(admitted.disposition!.rules[0]!.minimum).toBe(3);
    const invalid = {
      ...admitted.disposition!,
      rules: admitted.disposition!.rules.map((rule) => ({
        ...rule,
        keep: quantity(5),
        minimum: quantity(3),
      })),
    };
    expect(() => validateAutomation({ ...admitted, disposition: invalid })).toThrow(
      'Invalid automation settings. Check rules, recovery thresholds and session limits.',
    );
  });
  it('produces the same guarded wire command from admitted and external policies', () => {
    const raw = rawPolicy(),
      admitted = validateDispositionPolicy(raw),
      c = context().disposition;
    const before = JSON.stringify(c.containers),
      plan = planAdmittedDisposition(admitted, c);
    expect(plan).toEqual(planDisposition(raw, c));
    expect(plan.actions).toEqual([
      {
        kind: 'sell',
        itemId: 501,
        count: 4,
        from: 'inventory',
        to: 'shop',
        bagId: 501,
        command: { type: 'shop', mode: 'sell', rows: [{ id: 501, count: 4 }] },
        estimatedCost: 0,
        reservedSpend: 0,
        estimatedProceeds: 100,
      },
    ]);
    expect(JSON.stringify(c.containers)).toBe(before);
  });
  it('captures detached typed goals once and keeps the captured quantity after draft edits', () => {
    const raw = rawPolicy(),
      c = context(2),
      settings = validateSettings({
        ...DEFAULT_SETTINGS,
        map: 'prontera',
        targets: [4000],
        automation: {
          ...structuredClone(DEFAULT_AUTOMATION),
          disposition: raw,
          supply: { ...DEFAULT_SUPPLY, enabled: true, maxSpend: 1000 },
        },
      });
    const trip = new SupplyTripRuntime(
      { next: () => ({ type: 'ready' }), confirm: () => false },
      () => 1000,
    );
    trip.configure(settings, c);
    raw.rules[0]!.desired = 4;
    expect(trip.next(c)?.type).toBe('prepare');
    const goals = trip.snapshot().goals;
    expect(goals).toEqual([{ itemId: 501, desired: 5 }]);
    Object.assign(goals[0]!, { desired: quantity(1) });
    expect(trip.snapshot().goals).toEqual([{ itemId: 501, desired: 5 }]);
  });
});

function typeContracts(
  policy: ValidatedDispositionPolicy,
  raw: DispositionPolicy,
  c: DispositionContext,
  supply: SupplyContext,
  settings: RunSettings,
  automation: ValidatedAutomationSettings,
  receipt: SupplyReceipt,
  trip: SupplyTripRuntime<unknown>,
) {
  const rule = policy.rules[0]!,
    item: ItemId = rule.itemId,
    count: Quantity = rule.desired;
  const goal: SupplyGoal = { itemId: item, desired: count };
  nextSupplyAction(supply, [goal], policy, DEFAULT_SUPPLY);
  planAdmittedDisposition(policy, c);
  // @ts-expect-error Raw policies cannot enter the admitted decision function.
  planAdmittedDisposition(raw, c);
  // @ts-expect-error Bag identity cannot address an item stock goal.
  nextSupplyAction(supply, [{ itemId: bagId(501), desired: count }], policy, DEFAULT_SUPPLY);
  // @ts-expect-error Time cannot establish a desired stock quantity.
  nextSupplyAction(supply, [{ itemId: itemId(501), desired: seconds(5) }], policy, DEFAULT_SUPPLY);
  // @ts-expect-error Admitted rules are read-only.
  rule.keep = count;
  // @ts-expect-error Captured goals are read-only.
  goal.desired = count;
  const edited = {
    ...policy,
    rules: policy.rules.map((row) => ({ ...row, keep: quantity(5), minimum: quantity(3) })),
  };
  // @ts-expect-error An edited aggregate must pass relation and uniqueness checks again.
  planAdmittedDisposition(edited, c);
  // @ts-expect-error Supply configuration retains the nested disposition admission proof.
  trip.configure({ ...settings, automation: { ...automation, disposition: edited } }, supply);
  // @ts-expect-error The settings helper cannot turn an edited disposition into admitted automation.
  const bypass: ValidatedAutomationSettings = automationSettings({
    automation: { ...automation, disposition: edited },
  });
  // @ts-expect-error Preview consumes the same retained policy proof, without parsing per invocation.
  previewSupplyTrip({ ...settings, automation: { ...automation, disposition: edited } }, supply);
  const receiptItem: ItemId = receipt.action.itemId,
    receiptCount: Quantity = receipt.action.count;
  const receiptBag: BagId | undefined = receipt.action.bagId;
  // @ts-expect-error Receipt item identity cannot be used as a bag selector.
  const mixedBag: BagId = receipt.action.itemId;
  void bypass;
  void receiptItem;
  void receiptCount;
  void receiptBag;
  void mixedBag;
}
void typeContracts;

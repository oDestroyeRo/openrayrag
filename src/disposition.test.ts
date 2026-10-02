import { describe, expect, it } from 'vitest';
import { DEFAULT_DISPOSITION, dispositionPreviewIsCurrent, planDisposition, revalidateDisposition, validateDispositionPolicy,
  type DispositionContext, type DispositionPolicy, type DispositionRule } from './disposition';
import { dispositionContextFromStatus, dispositionPreviewText, dispositionStockFloors, publishedDispositionMetadata } from './disposition-ui';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE } from './settings';
import type { InventoryItem } from './protocol-feature';
import { WorldState } from './world-state';

const stack = (itemId = 501, count = 10): InventoryItem => ({ bagId: itemId, itemId, count, type: 1 });
const unique = (bagId: number, guid = `unique-${bagId}`): InventoryItem => ({ bagId, itemId: 1201, count: 1, type: 2, guid, refine: 0, slots: [0, 0, 0, 0] });
const rule = (changes: Partial<DispositionRule> = {}): DispositionRule => ({ itemId: 501, keep: 2, minimum: 3, desired: 5, maximum: 6,
  store: false, sell: false, cart: false, restock: 'off', allowUnique: false, ...changes });
const policy = (changes: Partial<DispositionRule> = {}, maxSpend = 0): DispositionPolicy => ({ maxSpend, rules: [rule(changes)] });
function context(mode: 'sell' | 'buy' | 'storage' | 'cart' = 'sell'): DispositionContext {
  const world = new WorldState(); world.reset('prontera');
  world.npc = { id: mode === 'cart' ? null : 42, mode: mode === 'storage' ? 'storage' : mode === 'cart' ? 'idle' : 'shop', dialog: null, options: [] };
  if (mode === 'sell' || mode === 'buy') world.shop = { mode, discountLevel: 0, entries: [{ itemId: 501, price: 50 }, { itemId: 512, price: 15 }] };
  world.storageReady = mode === 'storage'; world.hasCart = true; world.cartReady = true;
  return { revision: 'session:1:prontera:1:2',
    containers: {
      inventory: { items: [stack()], slots: 200, weight: 700, maxWeight: 10000 },
      storage: { items: [], slots: 600, weight: null, maxWeight: 'unlimited' },
      cart: { items: [], slots: 100, weight: 0, maxWeight: 80000 },
    }, equipment: [], ammoId: -1,
    metadata: { ...publishedDispositionMetadata(), 1201: { weight: 100, sellPrice: 50, itemClass: 2, unique: true, store: true, sell: true, cart: true, buy: true } },
    workflow: { map: 'prontera', playerId: 1, alive: true, idle: true, inventory: [stack()], equipped: [], zeny: 1000, world, visibleNpcIds: [42], pushCartLevel: 1 } };
}
function setItems(ctx: DispositionContext, name: 'inventory' | 'storage' | 'cart', items: InventoryItem[]): void {
  ctx.containers[name].items = items;
  if (name === 'inventory') ctx.workflow.inventory = items;
  else { const target = ctx.workflow.world[name]; target.clear(); for (const item of items) target.set(item.bagId, item); }
}

describe('disposition policy boundaries', () => {
  it('preserves legacy/default items and validates detached policies', () => {
    const ctx = context(); const result = planDisposition(DEFAULT_DISPOSITION, ctx);
    expect(result.actions).toEqual([]); expect(result.protections[0]?.reason).toContain('No disposition rule');
    const original = policy(); const parsed = validateDispositionPolicy(original); parsed.rules[0]!.keep = 0; expect(original.rules[0]!.keep).toBe(2);
  });
  it.each([
    { keep: 4 }, { minimum: 6 }, { desired: 7 }, { maximum: 32768 }, { itemId: 0 }, { maximum: 0.5 },
    { sell: 1 }, { allowUnique: 'true' }, { restock: 'any' }, { unknown: true },
  ])('rejects conflicts, coercion and unknown fields: %j', changes => expect(() => validateDispositionPolicy({ maxSpend: 0, rules: [{ ...rule(), ...changes }] })).toThrow());
  it('rejects duplicate rules, missing fields and oversized budgets/rule arrays', () => {
    for (const input of [null, { maxSpend: -1, rules: [] }, { maxSpend: 2000000001, rules: [] }, { maxSpend: 0, rules: [rule(), rule()] },
      { maxSpend: 0, rules: Array.from({ length: 129 }, (_, i) => rule({ itemId: i + 1 })) }, { rules: [] }]) expect(() => validateDispositionPolicy(input)).toThrow();
    expect(validateDispositionPolicy(policy({ keep: 0, minimum: 0, desired: 32767, maximum: 32767 }, 2000000000)).maxSpend).toBe(2000000000);
  });
});
describe('protected and deterministic disposition plans', () => {
  it('preserves each compatible arrow reserve when loadout policy is enabled', () => {
    const settings = structuredClone(DEFAULT_AUTOMATION);
    settings.loadout.enabled = true; settings.loadout.minAmmoStock = 5;
    const ctx = context(); setItems(ctx, 'inventory', [stack(1750, 20)]);
    ctx.minimumStock = dispositionStockFloors(settings);
    expect(ctx.minimumStock).toContainEqual({ itemId: 1750, count: 5 });
    expect(ctx.minimumStock).toContainEqual({ itemId: 1751, count: 5 });
    expect(ctx.minimumStock.some(row => row.itemId === 13200)).toBe(false);
    const configured = policy({ itemId: 1750, keep: 0, minimum: 0, desired: 0, maximum: 0, sell: true });
    const plan = planDisposition(configured, ctx);
    expect(plan.actions).toMatchObject([{ itemId: 1750, count: 15 }]);
    settings.loadout.minAmmoStock = 10; ctx.minimumStock = dispositionStockFloors(settings);
    expect(dispositionPreviewIsCurrent(plan, configured, ctx)).toBe(false);
    expect(planDisposition(configured, ctx).actions[0]?.count).toBe(10);
    settings.loadout.enabled = false; expect(dispositionStockFloors(settings)).toEqual([]);
  });
  it.each(['random', 'save'] as const)('retains the selected %s escape wing reserve and invalidates changed protection', mode => {
    const itemId = mode === 'random' ? 601 : 602;
    const settings = structuredClone(DEFAULT_AUTOMATION);
    settings.escape = { ...DEFAULT_ESCAPE, enabled: true, mode, minStock: 3 };
    const ctx = context(); setItems(ctx, 'inventory', [stack(itemId, 5)]);
    ctx.minimumStock = dispositionStockFloors(settings);
    const configured = policy({ itemId, keep: 0, minimum: 0, desired: 0, maximum: 0, sell: true });
    const plan = planDisposition(configured, ctx);
    expect(plan.actions).toMatchObject([{ itemId, count: 2 }]);
    settings.escape.minStock = 4; ctx.minimumStock = dispositionStockFloors(settings);
    expect(dispositionPreviewIsCurrent(plan, configured, ctx)).toBe(false);
    expect(planDisposition(configured, ctx).actions[0]?.count).toBe(1);
    settings.escape.method = 'skill'; expect(dispositionStockFloors(settings)).toEqual([]);
    settings.escape.method = 'item'; settings.escape.enabled = false;
    expect(dispositionStockFloors(settings)).toEqual([]);
  });
  it('sells a partial published Red Potion stack, retaining maximum and exact proceeds', () => {
    const ctx = context(); const before = JSON.stringify(ctx.containers); const worldBefore = ctx.workflow.world.snapshot();
    const result = planDisposition(policy({ sell: true }), ctx);
    expect(result.actions).toMatchObject([{ kind: 'sell', itemId: 501, bagId: 501, count: 4, estimatedProceeds: 100, command: { type: 'shop', mode: 'sell', rows: [{ id: 501, count: 4 }] } }]);
    expect(result.blocked).toEqual([]); expect(JSON.stringify(ctx.containers)).toBe(before); expect(ctx.workflow.world.snapshot()).toEqual(worldBefore);
    expect(dispositionPreviewText(result)).toContain('Red Potion × 4');
  });
  it('honors overlapping protected stock floors before maximum targets', () => {
    const ctx = context(); ctx.minimumStock = [{ itemId: 501, count: 8 }, { itemId: 501, count: 7 }];
    const result = planDisposition(policy({ sell: true }), ctx);
    expect(result.actions[0]?.count).toBe(2); expect(result.unmet).toMatchObject([{ count: 2, kind: 'excess' }]);
  });
  it.each(['equipped', 'ammo', 'protected'] as const)('preserves %s stacks regardless of disposition permissions', kind => {
    const ctx = context(); if (kind === 'equipped') ctx.equipment = [501]; else if (kind === 'ammo') ctx.ammoId = 501; else ctx.workflow.protectedItemIds = [501];
    expect(planDisposition(policy({ sell: true, store: true, cart: true }), ctx).actions).toEqual([]);
  });
  it('keeps distinct unique identities protected by default', () => {
    const ctx = context(); setItems(ctx, 'inventory', [unique(20001), unique(20002)]);
    const result = planDisposition(policy({ itemId: 1201, keep: 0, minimum: 0, desired: 0, maximum: 0, sell: true }), ctx);
    expect(result.actions).toEqual([]); expect(result.protections.map(row => row.bagId)).toEqual([20001, 20002]);
  });
  it('uses explicit unique identities independently without aggregating equipment', () => {
    const ctx = context(); setItems(ctx, 'inventory', [unique(20002), unique(20001)]);
    const result = planDisposition(policy({ itemId: 1201, keep: 0, minimum: 0, desired: 0, maximum: 0, sell: true, allowUnique: true }), ctx);
    expect(result.actions.map(row => [row.bagId, row.uniqueId, row.count])).toEqual([[20001, 'unique-20001', 1], [20002, 'unique-20002', 1]]);
  });
  it.each(['refined', 'carded', 'unknown'] as const)('protects %s unique items even after explicit opt-in', kind => {
    const ctx = context(); const item = unique(20001); if (kind === 'refined') item.refine = 1; else if (kind === 'carded') item.slots = [4001]; else delete item.guid;
    setItems(ctx, 'inventory', [item]); expect(planDisposition(policy({ itemId: 1201, keep: 0, minimum: 0, desired: 0, maximum: 0, sell: true, allowUnique: true }), ctx).actions).toEqual([]);
  });
  it('uses storage before cart and sale when multiple permissions are configured', () => {
    const result = planDisposition(policy({ store: true, cart: true, sell: true }), context('storage'));
    expect(result.actions.map(row => row.kind)).toEqual(['store']);
  });
  it('blocks unknown preferred storage rather than silently selling', () => {
    const ctx = context(); ctx.containers.storage.items = null;
    const result = planDisposition(policy({ store: true, sell: true }), ctx);
    expect(result.actions).toEqual([]); expect(result.blocked.join(' ')).toContain('not observed');
  });
  it('is stable when rule and inventory iteration order change', () => {
    const ctx = context(); setItems(ctx, 'inventory', [stack(512, 10), stack()]);
    const rules = [rule({ itemId: 512, sell: true }), rule({ sell: true })]; const result = planDisposition({ maxSpend: 0, rules }, ctx);
    ctx.containers.inventory.items!.reverse(); ctx.workflow.inventory.reverse();
    expect(planDisposition({ maxSpend: 0, rules: [...rules].reverse() }, ctx)).toEqual(result);
  });
  it('does not confuse bag IDs with item IDs or accept conflicting snapshot identities', () => {
    for (const items of [[{ ...stack(), bagId: 20001 }], [stack(), stack()], [unique(20001, 'same'), unique(20002, 'same')]]) {
      const ctx = context(); setItems(ctx, 'inventory', items); expect(planDisposition(policy({ sell: true }), ctx).actions).toEqual([]);
    }
  });
});
describe('authoritative stock, capacity and spending', () => {
  it.each(['items', 'slots', 'maxWeight', 'weight'] as const)('does not turn unknown inventory %s into zero or unlimited', field => {
    const ctx = context('buy'); setItems(ctx, 'inventory', []); ctx.containers.inventory[field] = null;
    const result = planDisposition(policy({ restock: 'buy' }, 1000), ctx); expect(result.actions).toEqual([]); expect(result.blocked.length).toBeGreaterThan(0);
  });
  it('restocks from observed storage only to desired, with no synthetic stock', () => {
    const ctx = context('storage'); setItems(ctx, 'inventory', [stack(501, 1)]); setItems(ctx, 'storage', [stack(501, 20)]);
    expect(planDisposition(policy({ restock: 'storage' }), ctx).actions).toMatchObject([{ kind: 'withdraw', count: 4, bagId: 501 }]);
    setItems(ctx, 'storage', [stack(501, 2)]); const partial = planDisposition(policy({ restock: 'storage' }), ctx);
    expect(partial.actions[0]?.count).toBe(2); expect(partial.unmet[0]?.count).toBe(2);
  });
  it('does not restock at minimum and does not dispose at maximum', () => {
    const ctx = context('storage'); setItems(ctx, 'inventory', [stack(501, 3)]); expect(planDisposition(policy({ restock: 'storage' }), ctx).actions).toEqual([]);
    setItems(ctx, 'inventory', [stack(501, 6)]); expect(planDisposition(policy({ store: true }), ctx).actions).toEqual([]);
  });
  it('limits cart transfers by known remaining weight', () => {
    const ctx = context('cart'); ctx.containers.cart.weight = 79860;
    const result = planDisposition(policy({ cart: true }), ctx); expect(result.actions[0]?.count).toBe(2); expect(result.unmet[0]?.count).toBe(2);
  });
  it('rejects full storage/cart even if the target regular stack already exists', () => {
    for (const kind of ['storage', 'cart'] as const) {
      const ctx = context(kind); setItems(ctx, kind, [stack()]); ctx.containers[kind].slots = 1;
      expect(planDisposition(policy(kind === 'storage' ? { store: true } : { cart: true }), ctx).actions).toEqual([]);
    }
  });
  it('enforces withdrawal stack limit and signed protocol count boundaries', () => {
    const ctx = context('storage'); setItems(ctx, 'inventory', [stack(501, 29998)]); setItems(ctx, 'storage', [stack(501, 32767)]); ctx.containers.inventory.weight = 0; ctx.containers.inventory.maxWeight = 2147483647;
    const result = planDisposition(policy({ keep: 0, minimum: 30000, desired: 32767, maximum: 32767, restock: 'storage' }), ctx);
    expect(result.actions[0]?.count).toBe(1); expect(result.unmet[0]?.count).toBe(2768);
    setItems(ctx, 'inventory', [stack(501, 32768)]); expect(planDisposition(policy({ store: true }), ctx).actions).toEqual([]);
  });
  it('partially buys within both zeny and reserved maxSpend', () => {
    const ctx = context('buy'); setItems(ctx, 'inventory', []); ctx.containers.inventory.weight = 0;
    expect(planDisposition(policy({ restock: 'buy' }, 100), ctx).actions[0]?.count).toBe(2);
    ctx.workflow.zeny = 50; const result = planDisposition(policy({ restock: 'buy' }, 100), ctx); expect(result.actions[0]?.count).toBe(1); expect(result.estimatedCost).toBe(50);
    expect(planDisposition(policy({ restock: 'buy' }, 0), ctx).actions).toEqual([]);
  });
  it('uses exact pinned discount cost and conservative displayed-cost budget', () => {
    const ctx = context('buy'); setItems(ctx, 'inventory', []); ctx.containers.inventory.weight = 0; ctx.workflow.world.shop!.discountLevel = 1;
    const result = planDisposition(policy({ restock: 'buy' }, 47), ctx); expect(result.actions[0]).toMatchObject({ count: 1, estimatedCost: 15, reservedSpend: 47 });
  });
  it('reserves cumulative discounted spending within the observed zeny balance', () => {
    const ctx=context('buy');setItems(ctx,'inventory',[]);ctx.containers.inventory.weight=0;ctx.workflow.zeny=230;
    ctx.workflow.world.shop={mode:'buy',discountLevel:1,entries:[{itemId:501,price:50},{itemId:502,price:200}]};
    const result=planDisposition({maxSpend:1000,rules:[rule({keep:0,minimum:1,desired:2,maximum:2,restock:'buy'}),rule({itemId:502,keep:0,minimum:1,desired:1,maximum:1,restock:'buy'})]},ctx);
    expect(result.actions.map(row=>[row.itemId,row.count])).toEqual([[501,2]]);expect(result.estimatedCost).toBe(30);expect(result.reservedSpend).toBe(94);
    expect(result.unmet).toMatchObject([{itemId:502,count:1,kind:'shortage'}]);expect(result.blocked.join(' ')).toContain('spending');
  });
  it('blocks unknown prices/permissions and negative/overflow source arithmetic', () => {
    const ctx = context('buy'); setItems(ctx, 'inventory', []);
    ctx.workflow.world.shop!.entries = []; expect(planDisposition(policy({ restock: 'buy' }, 1000), ctx).actions).toEqual([]);
    ctx.workflow.world.shop!.entries = [{ itemId: 501, price: 1 }]; ctx.workflow.world.shop!.discountLevel = 10;
    expect(planDisposition(policy({ restock: 'buy' }, 1000), ctx).actions).toEqual([]);
    const sell = context(); sell.metadata = { ...sell.metadata, 501: { ...sell.metadata[501]!, sellPrice: null } };
    expect(planDisposition(policy({ sell: true }), sell).actions).toEqual([]);
  });
  it('shares cumulative capacity and budget between item rules', () => {
    const ctx = context('buy'); setItems(ctx, 'inventory', []); ctx.containers.inventory.weight = 0;
    const result = planDisposition({ maxSpend: 65, rules: [rule({ restock: 'buy', keep: 0, minimum: 1, desired: 1 }), rule({ itemId: 512, restock: 'buy', keep: 0, minimum: 1, desired: 1 })] }, ctx);
    expect(result.actions.map(row => [row.itemId, row.count])).toEqual([[501, 1], [512, 1]]); expect(result.reservedSpend).toBe(65);
    ctx.containers.inventory.slots = 1; expect(planDisposition({ maxSpend: 65, rules: [rule({ restock: 'buy', keep: 0, minimum: 1, desired: 1 }), rule({ itemId: 512, restock: 'buy', keep: 0, minimum: 1, desired: 1 })] }, ctx).actions).toHaveLength(1);
  });
  it('does not buy unique identities through aggregate item targets', () => {
    const ctx = context('buy'); setItems(ctx, 'inventory', []);
    expect(planDisposition(policy({ itemId: 1201, restock: 'buy', allowUnique: true }, 1000), ctx).actions).toEqual([]);
  });
});
describe('revision-bound preview and future execution boundary', () => {
  it('requires revalidation for revision, money, inventory, equipment and policy changes', () => {
    const ctx = context(); const configured = policy({ sell: true }); const result = planDisposition(configured, ctx);
    expect(revalidateDisposition(result, configured, ctx)).toEqual({ ok: true, reasons: [] });
    const mutations = [() => { ctx.revision += ':new'; }, () => { ctx.workflow.zeny++; }, () => { ctx.containers.inventory.items![0]!.count++; }, () => { ctx.equipment!.push(501); }, () => { configured.rules[0]!.maximum++; }];
    for (const mutate of mutations) { const before = planDisposition(configured, ctx); mutate(); expect(revalidateDisposition(before, configured, ctx).ok).toBe(false); }
    expect(dispositionPreviewIsCurrent(result, configured, ctx)).toBe(false);
  });
  it('keeps an unchanged blocked preview current but never execution-ready', () => {
    const ctx = context(); ctx.containers.storage.items = null; const configured = policy({ store: true }); const result = planDisposition(configured, ctx);
    expect(dispositionPreviewIsCurrent(result, configured, ctx)).toBe(true); expect(revalidateDisposition(result, configured, ctx).ok).toBe(false);
  });
  it('adapts a real catalog regular-item sale without a command hook or sender', () => {
    const status = { sessionId: 'test', connectionId: 1, map: 'prontera', connected: true, compatible: true, running: false,
      player: { id: 1, kind:0, dead: false }, task: { pending: false }, actionResult: { status: 'idle' },
      character: { inventoryKnown: true, inventory: [stack(512, 10)], equipment: [], ammoId: -1, stats: { zeny: 50, weight: 200, maxWeight: 10000 } },
      world: { map: 'prontera', generation: 1, revision: 2, npc: { id: 42, mode: 'shop' }, shop: { mode: 'sell', discountLevel: 0, entries: [] }, storageReady: false, cartReady: false } };
    const ctx = dispositionContextFromStatus(status); const result = planDisposition(policy({ itemId: 512, sell: true }), ctx);
    expect(result.actions[0]).toMatchObject({ itemId: 512, count: 4, estimatedProceeds: 28 });
    expect(result.blocked).toEqual([]); expect(ctx.containers.storage.items).toBeNull(); expect(dispositionPreviewText(result)).toContain('Apple × 4');
    const pendingEscape = dispositionContextFromStatus({ ...status, escape: { state: 'uncertain', pending: true } });
    expect(pendingEscape.workflow.idle).toBe(false);
    expect(planDisposition(policy({ itemId: 512, sell: true }), pendingEscape).actions).toEqual([]);
    expect(revalidateDisposition(result, policy({ itemId: 512, sell: true }), pendingEscape).ok).toBe(false);
    const pendingLoadout = dispositionContextFromStatus({ ...status, loadout: { state: 'fault' } });
    expect(pendingLoadout.workflow.idle).toBe(false);
    expect(planDisposition(policy({ itemId: 512, sell: true }), pendingLoadout).actions).toEqual([]);
  });
  it('retains omitted unique identity/cards and disconnected telemetry as unknown', () => {
    const ctx = dispositionContextFromStatus({}); expect(ctx.containers.inventory.items).toBeNull(); expect(ctx.equipment).toBeNull(); expect(ctx.workflow.alive).toBe(false);
    expect(planDisposition(DEFAULT_DISPOSITION, ctx).actions).toEqual([]);
  });
  it.each(['storage','cart'] as const)('preserves fully observed %s unique identity for explicit restocking', source => {
    const item=unique(20001);const ctx=context(source);setItems(ctx,'inventory',[]);setItems(ctx,source,[item]);ctx.containers.inventory.weight=0;
    const carried: InventoryItem[]=[];
    const status={sessionId:'test',map:'prontera',connected:true,compatible:true,running:false,player:{id:1,kind:0,dead:false},task:{pending:false},
      character:{inventoryKnown:true,inventory:carried,equipment:[],ammoId:-1,skillsKnown:true,learned:[{skillId:73,level:1}],stats:{weight:0,maxWeight:10000,zeny:1000,cartWeight:100}},world:ctx.workflow.world.snapshot()};
    const observed=dispositionContextFromStatus(status);const result=planDisposition(policy({itemId:1201,keep:0,minimum:1,desired:1,maximum:1,restock:source,allowUnique:true}),observed);
    expect(result.actions[0]).toMatchObject({bagId:20001,uniqueId:'unique-20001',count:1,from:source,to:'inventory'});
    carried.push({bagId:20002,itemId:1201,count:1,type:2});
    const protect=planDisposition(policy({itemId:1201,keep:0,minimum:0,desired:0,maximum:0,sell:true,allowUnique:true}),dispositionContextFromStatus(status));
    expect(protect.actions).toEqual([]);expect(protect.protections[0]?.reason).toContain('not observed');
  });
});

import { describe, expect, it } from 'vitest';
import { actionIdentity, sameActionIdentity } from './actor-identity';
import { CharacterState } from './character-state';
import { admitInventoryItem, inventoryItemCount } from './character-state-logic';
import { bagId, itemId, skillId, revisionFor, type Revision } from './domain-values';
import type { FeatureEvent, InventoryItem } from './protocol-feature';
import type { WorkflowReceipt } from './workflows-logic';

const unique = (): InventoryItem => ({ type: 2, bagId: 900, itemId: 1201, count: 1, guid: '01'.repeat(16), slots: [0, 0, 0, 0] });
const inventory = (): Extract<FeatureEvent, { type: 'inventory' }> => ({ type: 'inventory', items: [unique()], cart: [unique()], equipment: Array(10).fill(0), ammoId: -1 });

describe('owned character domain values', () => {
  it('detaches nested inventory, cart, delta and unique-update slot arrays on admission', () => {
    const state = new CharacterState(), full = inventory();
    state.apply(full, 0);
    full.items[0]!.slots![0] = 4001;
    full.cart![0]!.slots![0] = 4002;
    expect(state.inventory.get(bagId(900))!.slots).toEqual([0, 0, 0, 0]);
    expect(state.cart![0]!.slots).toEqual([0, 0, 0, 0]);
    const added = unique(); added.bagId = 901;
    state.apply({ type: 'inventoryDelta', add: true, bagId: 901, change: 1, weight: 0, item: added }, 0);
    added.slots![1] = 4003;
    expect(state.inventory.get(bagId(901))!.slots).toEqual([0, 0, 0, 0]);
    const updated = unique(); updated.slots![2] = 4004;
    state.apply({ type: 'inventoryItem', item: updated }, 0);
    updated.slots![2] = 4005;
    expect(state.inventory.get(bagId(900))!.slots).toEqual([0, 0, 4004, 0]);
    expect(state.count(itemId(1201))).toBe(2);
  });

  it('keeps offered wire sentinels outside owned inventory and checks aggregate quantities', () => {
    expect(() => admitInventoryItem({ ...unique(), bagId: -1, count: 0 })).toThrow('Invalid bag ID');
    expect(() => inventoryItemCount(itemId(501))([{ itemId: 501, count: Number.MAX_SAFE_INTEGER }, { itemId: 501, count: 1 }])).toThrow('Invalid quantity');
  });

  it.each(['inventory', 'equipment'] as const)('rejects a full update atomically when %s revision is exhausted', channel => {
    const state = new CharacterState(); state.apply(inventory(), 0);
    if (channel === 'inventory') state.inventoryRevision = revisionFor('inventory', Number.MAX_SAFE_INTEGER);
    else state.equipmentRevision = revisionFor('equipment', Number.MAX_SAFE_INTEGER);
    const before = state.snapshot(), inventoryRevision = state.inventoryRevision, equipmentRevision = state.equipmentRevision;
    const event = inventory(); event.items = [{ bagId: 501, itemId: 501, count: 2, type: 1 }]; event.cart = [];
    expect(() => state.apply(event, 0)).toThrow('Invalid revision');
    expect(state.snapshot()).toEqual(before);
    expect(state.inventoryRevision).toBe(inventoryRevision); expect(state.equipmentRevision).toBe(equipmentRevision);
  });

  it('does not change resources or SP revision when the stats revision is exhausted', () => {
    const state = new CharacterState(); state.apply({ type: 'stats', hp: 10, maxHp: 20, sp: 3, maxSp: 5, level: 1 }, 0);
    state.statsRevision = revisionFor('stats', Number.MAX_SAFE_INTEGER);
    const before = state.snapshot(), sp = state.spRevision;
    expect(() => state.apply({ type: 'stats', hp: 20, maxHp: 20, sp: 5, maxSp: 5, level: 2 }, 0)).toThrow('Invalid revision');
    expect(state.snapshot()).toEqual(before); expect(state.spRevision).toBe(sp);
    expect(() => state.applyCartWeights(10, 20)).toThrow('Invalid revision'); expect(state.snapshot()).toEqual(before);
  });

  it('does not subtract stock or update weight before a delta revision is admitted', () => {
    const state = new CharacterState(); state.apply({ type: 'stats', hp: 10, maxHp: 20, level: 1, weight: 5 }, 0); state.apply(inventory(), 0);
    state.inventoryRevision = revisionFor('inventory', Number.MAX_SAFE_INTEGER);
    const before = state.snapshot();
    expect(() => state.apply({ type: 'inventoryDelta', add: false, bagId: 900, change: 1, weight: 0 }, 0)).toThrow('Invalid revision');
    expect(state.snapshot()).toEqual(before);
  });

  it('preserves actor zero, mixed-case world spelling and dead-self incarnation zero', () => {
    const world = 'ABCDEF01-0000-0000-0000-000000000001';
    const own = actionIdentity({ world, selfId: 0, selfIncarnation: 0 });
    expect(own).toEqual({ world, selfId: 0, selfIncarnation: 0 });
    const target = actionIdentity({ ...own, targetId: 0, targetIncarnation: 1 });
    expect(sameActionIdentity(target, actionIdentity({ ...own, targetId: 0, targetIncarnation: 1 }))).toBe(true);
    expect(() => actionIdentity({ ...own, targetId: 0, targetIncarnation: 0 })).toThrow('Invalid incarnation');
  });
});

function typeContracts(state: CharacterState, receipt: WorkflowReceipt, raw: InventoryItem) {
  state.count(itemId(501)); state.skillLevel(skillId(11)); state.inventory.get(bagId(501));
  // @ts-expect-error A bag identifier is not a catalog item identifier.
  state.count(bagId(501));
  // @ts-expect-error A catalog item cannot address an inventory bag.
  state.inventory.get(itemId(501));
  // @ts-expect-error Raw rows have not passed inventory admission.
  state.inventory.set(bagId(501), raw);
  // @ts-expect-error Skills and items are separate identifier families.
  state.skillLevel(itemId(11));
  // @ts-expect-error Receipt item deltas cannot be keyed by a physical bag.
  receipt.itemChanges.set(bagId(501), -1);
  // @ts-expect-error Receipt bag deltas cannot be keyed by a catalog item.
  receipt.bagChanges.set(itemId(501), -1);
  const acceptsInventoryRevision = (_value: Revision<'inventory'>) => undefined;
  // @ts-expect-error Equipment and inventory evidence have independent channels.
  acceptsInventoryRevision(state.equipmentRevision);
  // @ts-expect-error A target lifetime cannot be half-bound.
  actionIdentity({ world: '00000000-0000-0000-0000-000000000001', selfId: 0, selfIncarnation: 1, targetId: 1 });
}
void typeContracts;

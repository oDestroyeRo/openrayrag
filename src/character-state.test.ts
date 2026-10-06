import { admitInventoryItem } from './character-state-logic';
import { itemId as domainItemId, bagId as domainBagId, skillId as domainSkillId } from './domain-values';
import { describe, expect, it } from 'vitest';
import { CharacterState } from './character-state';
import { inventoryItemCount } from './character-state-logic';
import type { InventoryItem } from './protocol-feature';
import type { Entity } from './protocol';

const player: Entity = { id: 1, classId: 0, name: 'Player', kind: 0, level: 13,
  hp: 149, maxHp: 149, x: 100, y: 100, dead: false, sp: 0, maxSp: 0 };

describe('player spawn resources', () => {
  it('preserves full login stats when a nearby-player broadcast follows', () => {
    const state = new CharacterState();
    state.apply({ type: 'stats', level: 13, hp: 149, maxHp: 149, sp: 20, maxSp: 30 }, 1);
    state.spawn(player);
    expect(state.snapshot().stats).toMatchObject({ hp: 149, sp: 20, maxSp: 30 });
    state.resetField();
    state.spawn(player);
    expect(state.snapshot().stats).toMatchObject({ sp: 20, maxSp: 30 });
  });

  it('keeps placeholder SP unknown until authoritative values arrive', () => {
    const state = new CharacterState();
    state.spawn(player);
    expect(state.snapshot().stats?.sp).toBeUndefined();
    expect(state.snapshot().stats?.maxSp).toBeUndefined();
    state.apply({ type: 'sp', sp: 0, maxSp: 30 }, 1);
    expect(state.snapshot().stats).toMatchObject({ sp: 0, maxSp: 30 });
  });

  it('accepts a real self spawn including exhausted SP', () => {
    const state = new CharacterState();
    state.spawn({ ...player, sp: 0, maxSp: 30 });
    expect(state.snapshot().stats).toMatchObject({ sp: 0, maxSp: 30 });
  });
});

describe('inventory projections', () => {
  it('reuses item counters, skips sparse slots, and leaves stock unchanged', () => {
    const items: InventoryItem[] = new Array(4);
    items[1] = { bagId: 501, itemId: 501, type: 1, count: 2 };
    items[2] = { bagId: 502, itemId: 502, type: 1, count: 7 };
    items[3] = { bagId: 900, itemId: 501, type: 2, count: 1 };
    const before = structuredClone(items), count = inventoryItemCount(domainItemId(501));
    expect(count(items)).toBe(3);
    expect(count([])).toBe(0);
    expect(inventoryItemCount(domainItemId(999))(items)).toBe(0);
    expect(count(items)).toBe(3);
    expect(items).toEqual(before);
    expect(Object.hasOwn(items, 0)).toBe(false);
  });

  it('bounds dense state projections and detaches published rows', () => {
    const state = new CharacterState();
    for (let id = 1; id <= 601; id++) state.inventory.set(domainBagId(id), admitInventoryItem({ bagId: id, itemId: id, type: 1, count: 1 }));
    for (let id = 1; id <= 513; id++) { state.learned.set(domainSkillId(id), 2); state.granted.set(domainSkillId(id), 3); }
    for (let id = 1; id <= 129; id++) state.statuses.set(id, 10);
    const snapshot = state.snapshot();
    expect(snapshot.inventory).toHaveLength(600);
    expect(snapshot.inventory.at(-1)?.bagId).toBe(600);
    expect(snapshot.learned).toHaveLength(512);
    expect(snapshot.granted).toHaveLength(512);
    expect(snapshot.statuses).toHaveLength(128);
    snapshot.inventory[0]!.count = 50;
    snapshot.learned[0]!.level = 50;
    snapshot.statuses[0]!.seconds = 50;
    expect(state.inventory.get(domainBagId(1))?.count).toBe(1);
    expect(state.learned.get(domainSkillId(1))).toBe(2);
    expect(state.statuses.get(1)).toBe(10);
  });
});

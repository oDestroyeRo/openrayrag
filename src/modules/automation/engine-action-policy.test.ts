import { describe, expect, it } from 'vitest';
import { manualActionBlocker, type ManualActionState } from './engine-action-policy';
import type { Entity } from '../protocol/protocol';
import type { ExpandedAction, InventoryItem } from '../protocol/protocol-feature';

const player: Entity = { id: 1, classId: 0, name: 'Test', kind: 0, level: 10, hp: 100, maxHp: 100, x: 0, y: 0, dead: false };
function state(overrides: Partial<ManualActionState> = {}): ManualActionState {
  return { connected: true, compatible: true, player, inventoryKnown: true, inventory: new Map(), skillsKnown: true,
    learned: new Map([[1, 2]]), stats: { level: 10, hp: 100, maxHp: 100, attributes: [9, 10, 1, 1, 1, 1], statPoints: 100, skillPoints: 1 },
    entities: new Map([[1, player]]), actors: new Map(), ...overrides };
}
function itemState(itemId: number, count = 1): ManualActionState {
  const item: InventoryItem = { bagId: itemId, itemId, count, type: 1 };
  return state({ inventory: new Map([[itemId, item]]) });
}

describe('manual action admission', () => {
  it('requires a verified character and living ownership except for respawn', () => {
    expect(manualActionBlocker({ type: 'respawn' }, state())).toBe('Respawn requires a dead character.');
    const dead = state({ player: { ...player, dead: true } });
    expect(manualActionBlocker({ type: 'respawn' }, dead)).toBeNull();
    expect(manualActionBlocker({ type: 'sit', sitting: false }, dead)).toBe('Revive before using this action.');
    expect(manualActionBlocker({ type: 'respawn' }, state({ compatible: false }))).toBe('A verified character is required.');
  });
  it('requires observed novice mastery before sitting', () => {
    const action: ExpandedAction = { type: 'sit', sitting: true };
    expect(manualActionBlocker(action, state())).toBeNull();
    expect(manualActionBlocker(action, state({ skillsKnown: false }))).toContain('Basic Mastery level 2');
    expect(manualActionBlocker(action, state({ learned: new Map([[1, 1]]) }))).toContain('Basic Mastery level 2');
    expect(manualActionBlocker(action, state({ player: { ...player, classId: 1 }, skillsKnown: false }))).toBeNull();
  });
  it('uses known inventory totals and preserves target admission', () => {
    expect(manualActionBlocker({ type: 'useItem', itemId: 501 }, itemState(501))).toBeNull();
    expect(manualActionBlocker({ type: 'useItem', itemId: 501 }, itemState(501, 0))).toBe('Item is not present in a verified inventory.');
    expect(manualActionBlocker({ type: 'useItem', itemId: 501 }, { ...itemState(501), inventoryKnown: false })).toBe('Item is not present in a verified inventory.');
    expect(manualActionBlocker({ type: 'useItem', itemId: 610 }, itemState(610))).toBe('This item requires a target.');
    expect(manualActionBlocker({ type: 'useItem', itemId: 610, target: -1 }, itemState(610))).toBe('This item requires a target.');
    expect(manualActionBlocker({ type: 'useItem', itemId: 610, target: 2 }, itemState(610))).toBe('Item target is not visible.');
    expect(manualActionBlocker({ type: 'useItem', itemId: 610, target: 1 }, itemState(610))).toBeNull();
  });
  it('admits verified equipment and ammunition but rejects consumables', () => {
    for (const id of [1201, 1750]) expect(manualActionBlocker({ type: 'equip', bagId: id, equipped: true }, itemState(id))).toBeNull();
    expect(manualActionBlocker({ type: 'equip', bagId: 501, equipped: true }, itemState(501))).toBe('Equipment is not present in a verified inventory.');
  });
  it('requires observed points, class membership and skill prerequisites', () => {
    expect(manualActionBlocker({ type: 'allocateSkill', skillId: 2 }, state())).toBeNull();
    expect(manualActionBlocker({ type: 'allocateSkill', skillId: 2 }, state({ learned: new Map([[1, 1]]) }))).toContain('class prerequisites');
    expect(manualActionBlocker({ type: 'allocateSkill', skillId: 5 }, state())).toContain('class prerequisites');
    expect(manualActionBlocker({ type: 'allocateSkill', skillId: 1 }, state({ learned: new Map([[1, 8]]) }))).toContain('learnable skill');
  });
  it('calculates escalating point costs without changing attributes or points', () => {
    const current = state(), original = structuredClone(current);
    const action: ExpandedAction = { type: 'allocateStats', attributes: [3, 2, 0, 0, 0, 0] };
    expect(manualActionBlocker(action, current)).toBeNull();
    expect(current).toEqual(original);
    expect(manualActionBlocker(action, state({ stats: { ...current.stats!, statPoints: 11 } }))).toBe('Insufficient verified stat points.');
    expect(manualActionBlocker(action, state({ stats: { ...current.stats!, statPoints: 12 } }))).toBeNull();
    expect(manualActionBlocker({ type: 'allocateStats', attributes: [91, 0, 0, 0, 0, 0] }, current)).toBe('Attributes cannot exceed 99.');
  });
});

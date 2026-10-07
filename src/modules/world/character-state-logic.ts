import { reduce } from 'effect/Array';
import { bagId, itemId, quantity, type BagId, type ItemId, type Quantity } from '../../shared/domain-values';
import type { Entity } from '../protocol/protocol';
import type { InventoryItem, InventoryItemInput, PlayerStats, SkillLevel } from '../protocol/protocol-feature';
export interface CharacterSnapshot {
  stats: PlayerStats | null; inventoryKnown: boolean; skillsKnown: boolean;
  inventory: InventoryItem[]; cart: InventoryItem[] | null; equipment: number[]; ammoId: number;
  learned: SkillLevel[]; granted: SkillLevel[]; sitting: boolean | null;
  statuses: Array<{ id: number; seconds: number }>;
  experience: { baseTotal: number; baseGained: number; jobTotal: number; jobGained: number } | null;
}

export type StatefulEntity = Entity & { sp?: number; maxSp?: number; sitting?: boolean; statuses?: Array<{ id: number; seconds: number }> };

/** Owned inventory differs from offered wire items, which can have bag ID -1. */
export type DomainInventoryItem = Readonly<Omit<InventoryItem, 'bagId' | 'itemId' | 'count' | 'slots'>> & {
  readonly bagId: BagId; readonly itemId: ItemId; readonly count: Quantity; readonly slots?: readonly number[];
};
export function admitInventoryItem(value: InventoryItemInput): DomainInventoryItem {
  return { ...value, bagId: bagId(value.bagId), itemId: itemId(value.itemId), count: quantity(value.count),
    ...(value.slots ? { slots: value.slots.slice() } : {}) };
}
/** Detached mutable scalar projection for wire fixtures and local simulations. */
export function inventoryItemDraft(value: InventoryItemInput): InventoryItem {
  const { slots, ...base } = value;
  return { ...base, ...(slots !== undefined ? { slots: slots.slice() } : {}) };
}

/** Count known inventory stacks without mutating or treating sparse slots as items. */
export const inventoryItemCount = (id: ItemId) => (items: readonly Pick<InventoryItem, 'itemId' | 'count'>[]): Quantity =>
  quantity(reduce(items, 0, (total, item) => total + (item.itemId === id ? item.count : 0)));

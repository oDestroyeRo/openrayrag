import { filter } from 'effect/Array';
import { pipe } from 'effect/Function';
import { addQuantities, itemId, quantity, type ItemId, type Quantity } from '../../shared/domain-values';
export type RecoveryInventory = ReadonlyMap<ItemId, Quantity>;

/** Reject the whole observation before exposing any stock from a malformed row. */
export function recoveryInventory(character: unknown): RecoveryInventory | null {
  const value = character && typeof character === 'object' ? character as Record<string, unknown> : {};
  if (value.inventoryKnown !== true || !Array.isArray(value.inventory) || value.inventory.length > 600) return null;
  const stock = new Map<ItemId, Quantity>();
  for (const entry of value.inventory) {
    const row = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
    if (!Number.isInteger(row.itemId) || Number(row.itemId) < 1 || Number(row.itemId) > 2147483647
      || !Number.isInteger(row.count) || Number(row.count) < 0 || Number(row.count) > 32767) return null;
    const id = itemId(row.itemId);
    stock.set(id, addQuantities(stock.get(id) ?? quantity(0), quantity(row.count)));
  }
  return stock;
}

export const carriedRecoveryItem = (stock: RecoveryInventory | null) => (itemId: ItemId): boolean =>
  (stock?.get(itemId) ?? 0) > 0;

export function recoveryChoices({ selected, itemIds, ids, stock }: {
  selected: boolean; itemIds: readonly ItemId[]; ids: readonly ItemId[]; stock: RecoveryInventory | null;
}): { order: ItemId[]; visibleOrder: ItemId[] } {
  const order = selected ? pipe(ids, filter(id => !itemIds.includes(id)), remaining => [...itemIds, ...remaining]) : [...ids];
  const visibleOrder = filter(order, carriedRecoveryItem(stock));
  return { order, visibleOrder };
}

export function recoveryStockSummary({ ids, itemIds, stock }: {
  ids: readonly ItemId[]; itemIds: readonly ItemId[]; stock: RecoveryInventory | null;
}): { carried: boolean; missing: number } {
  return { carried: ids.find(carriedRecoveryItem(stock)) !== undefined,
    missing: stock === null ? 0 : filter(itemIds, id => (stock.get(id) ?? 0) === 0).length };
}

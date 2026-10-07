import { sameSupplyItem, type SupplyReceipt } from './supply-receipt-logic';
import { inventoryItemDraft } from '../world/character-state-logic';
import type { SupplyContext } from './supply-trip-logic';
import type { WorldEvent } from '../protocol/world-protocol';
export {
  createSupplyReceipt,
  confirmSupplyReceipt,
  type SupplyReceipt,
} from './supply-receipt-logic';

/** Copy matching destination evidence before NPC end discards its snapshot. */
export function observeSupplyReceipt(
  receipt: SupplyReceipt,
  events: WorldEvent[],
  context: SupplyContext,
): void {
  if (
    context.epoch !== receipt.epoch ||
    context.map !== receipt.map ||
    context.disposition.workflow.world.generation !== receipt.generation
  )
    return;
  const a = receipt.action,
    s = receipt.source;
  for (const event of events) {
    const storage =
      event.type === 'storageMoved' &&
      (a.kind === 'store' || a.kind === 'withdraw') &&
      event.deposit === (a.kind === 'store');
    const cart =
      event.type === 'cartMoved' &&
      (a.kind === 'cart' || a.kind === 'uncart') &&
      event.direction === (a.kind === 'cart' ? 1 : 2);
    if (
      !(storage || cart) ||
      !s ||
      !('item' in event) ||
      !('change' in event) ||
      event.change !== a.count ||
      !sameSupplyItem(event.item, s) ||
      ((a.kind === 'withdraw' || a.kind === 'uncart') && event.item.bagId !== a.bagId)
    )
      continue;
    receipt.acknowledged = true;
    // Retain receipt rows separately: WorldState may be discarded on close.
    const rows = (receipt.containerBefore ?? []).map(inventoryItemDraft);
    if (a.kind === 'store' || a.kind === 'cart') {
      const index = rows.findIndex((row) => row.bagId === event.item.bagId);
      if (index >= 0) rows[index] = structuredClone(event.item);
      else rows.push(structuredClone(event.item));
    } else {
      const row = rows.find((row) => row.bagId === a.bagId);
      if (!row || row.count < a.count) {
        receipt.acknowledged = false;
        continue;
      }
      row.count -= a.count;
    }
    receipt.containerAfter = rows.filter((row) => row.count > 0);
  }
}

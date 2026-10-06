import type { InventoryItem } from './protocol-feature';
import type { DispositionAction } from './disposition';
import type { SupplyContext } from './supply-trip-logic';
import type { WorldEvent } from './world-protocol';
import { confirmWorkflowReceipt, type WorkflowReceipt } from './workflows-logic';

export interface SupplyReceipt {
  economic: WorkflowReceipt;
  action: DispositionAction;
  character: string;
  epoch: string;
  map: string;
  generation: number;
  inventoryRevision: number;
  currencyRevision: number;
  source: InventoryItem | null;
  containerBefore: InventoryItem[] | null;
  containerAfter: InventoryItem[] | null;
  acknowledged: boolean;
}
const same = (a: InventoryItem, b: InventoryItem) =>
  a.itemId === b.itemId &&
  a.type === b.type &&
  (a.type !== 2 || (!!a.guid && a.guid === b.guid));
const stock = (items: InventoryItem[], source: InventoryItem) =>
  items
    .filter((item) => same(item, source))
    .reduce((sum, item) => sum + item.count, 0);
export function createSupplyReceipt(
  action: DispositionAction,
  economic: WorkflowReceipt,
  context: SupplyContext,
): SupplyReceipt {
  const from =
    action.from === "inventory"
      ? context.disposition.containers.inventory.items
      : action.from === "storage"
        ? context.disposition.containers.storage.items
        : action.from === "cart"
          ? context.disposition.containers.cart.items
          : null;
  const container =
    action.kind === "store" || action.kind === "withdraw"
      ? "storage"
      : action.kind === "cart" || action.kind === "uncart"
        ? "cart"
        : null;
  return {
    economic: { ...structuredClone(economic), strictStock: false },
    action: structuredClone(action),
    character: context.character,
    epoch: context.epoch,
    map: context.map,
    generation: context.disposition.workflow.world.generation,
    inventoryRevision: context.inventoryRevision,
    currencyRevision: context.currencyRevision,
    source: structuredClone(
      from?.find((item) => item.bagId === action.bagId) ?? null,
    ),
    containerBefore: container
      ? structuredClone(context.disposition.containers[container].items)
      : null,
    containerAfter: null,
    acknowledged: false,
  };
}
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
      event.type === "storageMoved" &&
      (a.kind === "store" || a.kind === "withdraw") &&
      event.deposit === (a.kind === "store");
    const cart =
      event.type === "cartMoved" &&
      (a.kind === "cart" || a.kind === "uncart") &&
      event.direction === (a.kind === "cart" ? 1 : 2);
    if (
      !(storage || cart) ||
      !s ||
      !("item" in event) ||
      !("change" in event) ||
      event.change !== a.count ||
      !same(event.item, s) ||
      ((a.kind === "withdraw" || a.kind === "uncart") &&
        event.item.bagId !== a.bagId)
    )
      continue;
    receipt.acknowledged = true;
    // Retain receipt rows separately: WorldState may be discarded on close.
    const rows = structuredClone(receipt.containerBefore ?? []);
    if (a.kind === "store" || a.kind === "cart") {
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
export function confirmSupplyReceipt(
  receipt: SupplyReceipt,
  context: SupplyContext,
): boolean {
  if (
    context.character !== receipt.character ||
    context.epoch !== receipt.epoch ||
    context.map !== receipt.map ||
    context.disposition.workflow.world.generation !== receipt.generation ||
    !context.fresh ||
    !context.disposition.containers.inventory.items ||
    context.inventoryRevision <= receipt.inventoryRevision ||
    !confirmWorkflowReceipt(receipt.economic, context.disposition.workflow)
  )
    return false;
  const a = receipt.action;
  const expectedBags = new Map(receipt.economic.bags);
  for (const [id, delta] of receipt.economic.bagChanges)
    expectedBags.set(id, (expectedBags.get(id) ?? 0) + delta);
  if (a.to === "inventory") {
    if (a.kind === "buy" || receipt.source?.type === 1)
      expectedBags.set(a.itemId, (expectedBags.get(a.itemId) ?? 0) + a.count);
    else if (receipt.source?.type === 2) {
      const incoming = context.disposition.containers.inventory.items.filter(
        (item) => same(item, receipt.source!),
      );
      if (
        incoming.length !== 1 ||
        incoming[0]!.count !== a.count ||
        expectedBags.has(incoming[0]!.bagId)
      )
        return false;
      expectedBags.set(incoming[0]!.bagId, a.count);
    } else return false;
  }
  const actualBags = new Map(
    context.disposition.containers.inventory.items.map((item) => [
      item.bagId,
      item.count,
    ]),
  );
  for (const id of new Set([...expectedBags.keys(), ...actualBags.keys()]))
    if ((expectedBags.get(id) ?? 0) !== (actualBags.get(id) ?? 0)) return false;
  const actual = new Map<number, number>();
  for (const item of context.disposition.containers.inventory.items)
    actual.set(item.itemId, (actual.get(item.itemId) ?? 0) + item.count);
  for (const id of new Set([
    ...actual.keys(),
    ...receipt.economic.items.keys(),
  ]))
    if (
      (actual.get(id) ?? 0) !==
      (receipt.economic.items.get(id) ?? 0) +
        (receipt.economic.itemChanges.get(id) ?? 0)
    )
      return false;
  if (a.kind === "buy" || a.kind === "sell")
    return context.currencyRevision > receipt.currencyRevision;
  const source = receipt.source,
    before = receipt.containerBefore,
    after = receipt.containerAfter;
  if (!receipt.acknowledged || !source || !before || !after) return false;
  const direction = a.kind === "store" || a.kind === "cart" ? 1 : -1;
  if (stock(after, source) !== stock(before, source) + direction * a.count)
    return false;
  // Exact source bag identity for removals, plus unchanged unrelated rows.
  if (
    direction < 0 &&
    (after.find((row) => row.bagId === a.bagId)?.count ?? 0) !==
      source.count - a.count
  )
    return false;
  const unrelated = (rows: InventoryItem[]) =>
    rows
      .filter((item) => !same(item, source))
      .sort((a, b) => a.bagId - b.bagId);
  return JSON.stringify(unrelated(before)) === JSON.stringify(unrelated(after));
}

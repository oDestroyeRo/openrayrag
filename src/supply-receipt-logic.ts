import type { InventoryItem } from './protocol-feature';
import type { DispositionAction } from './disposition';
import type { SupplyContext } from './supply-trip-logic';
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
export const sameSupplyItem = (a: InventoryItem, b: InventoryItem) =>
  a.itemId === b.itemId &&
  a.type === b.type &&
  (a.type !== 2 || (!!a.guid && a.guid === b.guid));
const stock = (items: InventoryItem[], source: InventoryItem) =>
  items
    .filter((item) => sameSupplyItem(item, source))
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
        (item) => sameSupplyItem(item, receipt.source!),
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
      .filter((item) => !sameSupplyItem(item, source))
      .sort((a, b) => a.bagId - b.bagId);
  return JSON.stringify(unrelated(before)) === JSON.stringify(unrelated(after));
}

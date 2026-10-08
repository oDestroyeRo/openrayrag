import {
  dispositionItemProtection,
  type DispositionContext,
  type DispositionPolicyView,
} from './disposition';

/** Sender-free eligible quantity/weight estimate. Price and exact economics are
 * deliberately deferred to the fresh shop; this never authorizes a sale. */
export function previewSupplySales(policy: DispositionPolicyView, context: DispositionContext) {
  const eligible: Array<{ itemId: number; count: number; retained: number }> = [];
  const protectedItems: string[] = [];
  let removableWeight = 0;
  const items = context.containers.inventory.items;
  if (!items || context.equipment === null || context.ammoId === null)
    return {
      eligible,
      protectedItems: ['Inventory, equipment or ammunition is unknown.'],
      remainingWeight: null,
    };
  for (const item of items) {
    const rule = policy.rules.find((row) => row.itemId === item.itemId);
    const info = context.metadata[item.itemId];
    const protection = dispositionItemProtection(context, item, 'inventory', rule);
    if (
      protection ||
      !rule?.sell ||
      info?.sell !== true ||
      typeof info.weight !== 'number' ||
      !Number.isInteger(info.weight)
    ) {
      protectedItems.push(
        `Item #${item.itemId} × ${item.count}: ${protection || 'No verified sale permission or weight.'}`,
      );
      continue;
    }
    const carried = items
      .filter((row) => row.itemId === item.itemId)
      .reduce((sum, row) => sum + row.count, 0);
    const floor = Math.max(
      rule.keep,
      rule.maximum,
      ...(context.minimumStock
        ?.filter((row) => row.itemId === item.itemId)
        .map((row) => row.count) ?? []),
    );
    const already = eligible
      .filter((row) => row.itemId === item.itemId)
      .reduce((sum, row) => sum + row.count, 0);
    const count = Math.min(item.count, Math.max(0, carried - floor - already));
    if (count) {
      eligible.push({ itemId: item.itemId, count, retained: floor });
      removableWeight += info.weight * count;
    } else
      protectedItems.push(
        `Item #${item.itemId} × ${item.count}: retained by keep/reserve floor ${floor}.`,
      );
  }
  return {
    eligible,
    protectedItems,
    remainingWeight:
      context.containers.inventory.weight === null
        ? null
        : Math.max(0, context.containers.inventory.weight - removableWeight),
  };
}

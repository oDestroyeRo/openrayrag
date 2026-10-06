import { itemId as domainItemId } from './domain-values';
import type { ReadonlyData } from './settings';
import { inventoryItemCount, inventoryItemDraft } from './character-state-logic';
import { sort } from 'remeda';
import type { InventoryItemInput as InventoryItem } from './protocol-feature';
import type { WorldAction } from './world-protocol';
import { saleProceeds, shopQuote, worldActionBlockers, workflowWorldFromSnapshot, workflowWorldSnapshot, type WorkflowContext, type WorkflowWorld } from './workflows-logic';

export const DISPOSITION_SOURCE_PIN = '4099e2c000c3c550516760b9c1241595aac9aceb';
export const MAX_DISPOSITION_ACTIONS = 32;
export interface DispositionRule {
  itemId: number;
  keep: number; minimum: number; desired: number; maximum: number;
  store: boolean; sell: boolean; cart: boolean;
  restock: 'off' | 'storage' | 'cart' | 'buy';
  allowUnique: boolean;
}
export interface DispositionPolicy { maxSpend: number; rules: DispositionRule[] }
export const DEFAULT_DISPOSITION: DispositionPolicy = { maxSpend: 0, rules: [] };
export type ContainerName = 'inventory' | 'storage' | 'cart';
export interface DispositionContainer {
  /** Null is unknown, never an empty bag or unlimited capacity. */
  items: InventoryItem[] | null;
  /** Verified slot ceiling; current used slots come from the complete snapshot. */
  slots: number | null;
  weight: number | null;
  maxWeight: number | 'unlimited' | null;
}
export interface DispositionItemInfo {
  weight: number | null; sellPrice: number | null; itemClass: number;
  unique: boolean | null;
  /** Verified restrictions; omission blocks the corresponding operation. */
  store?: boolean; sell?: boolean; cart?: boolean; buy?: boolean;
}
export interface DispositionContext {
  revision: string;
  containers: Record<ContainerName, DispositionContainer>;
  equipment: number[] | null; ammoId: number | null;
  metadata: Readonly<Record<string, DispositionItemInfo>>;
  minimumStock?: { itemId: number; count: number }[];
  workflow: WorkflowContext;
}
export interface DispositionAction {
  kind: 'store' | 'cart' | 'sell' | 'withdraw' | 'uncart' | 'buy';
  itemId: number; count: number; from: ContainerName | 'shop'; to: ContainerName | 'shop';
  bagId?: number; uniqueId?: string;
  command: WorldAction;
  estimatedCost: number; reservedSpend: number; estimatedProceeds: number;
}
export interface DispositionProtection { container: ContainerName; itemId: number; bagId: number; count: number; reason: string }
export interface DispositionTarget { itemId: number; count: number; kind: 'shortage' | 'excess'; reasons: string[] }
export interface DispositionPlan {
  binding: { revision: string; fingerprint: string };
  actions: DispositionAction[]; protections: DispositionProtection[];
  unmet: DispositionTarget[]; blocked: string[];
  estimatedCost: number; reservedSpend: number; estimatedProceeds: number;
}

function object(value: unknown, keys: string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== keys.length || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid disposition fields.');
  return value as Record<string, unknown>;
}
function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid disposition quantity or identifier.');
  return value;
}
export function validateDispositionPolicy(input: unknown): DispositionPolicy {
  const policy = object(input, ['maxSpend', 'rules']);
  const maxSpend = integer(policy.maxSpend, 0, 2_000_000_000);
  if (!Array.isArray(policy.rules) || policy.rules.length > 128) throw new Error('Keep at most 128 disposition rules.');
  const rules = policy.rules.map((input): DispositionRule => {
    const row = object(input, ['itemId', 'keep', 'minimum', 'desired', 'maximum', 'store', 'sell', 'cart', 'restock', 'allowUnique']);
    const itemId = integer(row.itemId, 1, 2_147_483_647);
    const keep = integer(row.keep, 0, 32767); const minimum = integer(row.minimum, 0, 32767);
    const desired = integer(row.desired, 0, 32767); const maximum = integer(row.maximum, 0, 32767);
    if (keep > minimum || minimum > desired || desired > maximum) throw new Error('Disposition quantities must satisfy keep ≤ minimum ≤ desired ≤ maximum.');
    if (['store', 'sell', 'cart', 'allowUnique'].some(key => typeof row[key] !== 'boolean')
      || typeof row.restock !== 'string' || !['off', 'storage', 'cart', 'buy'].includes(row.restock)) throw new Error('Invalid disposition permissions.');
    return { itemId, keep, minimum, desired, maximum, store: row.store as boolean, sell: row.sell as boolean,
      cart: row.cart as boolean, restock: row.restock as DispositionRule['restock'], allowUnique: row.allowUnique as boolean };
  });
  if (new Set(rules.map(row => row.itemId)).size !== rules.length) throw new Error('Conflicting disposition rules for the same item.');
  return { maxSpend, rules };
}

const names: ContainerName[] = ['inventory', 'storage', 'cart'];
const safeNumber = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 2_147_483_647;
const ordered = (items: InventoryItem[]) => sort(items, (a, b) => a.itemId - b.itemId || a.bagId - b.bagId);
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
  return JSON.stringify(value) ?? 'null';
}
function fingerprint(policy: ReadonlyData<DispositionPolicy>, context: DispositionContext): string {
  const ids = new Set(policy.rules.map(row => row.itemId));
  for (const name of names) for (const item of context.containers[name].items ?? []) ids.add(item.itemId);
  const metadata = Object.fromEntries([...ids].sort((a, b) => a - b).map(id => [id, context.metadata[id] ?? null]));
  return canonical({ policy: { ...policy, rules: sort(policy.rules, (a, b) => a.itemId - b.itemId) },
    containers: Object.fromEntries(names.map(name => [name, { ...context.containers[name], items: context.containers[name].items === null ? null : ordered(context.containers[name].items!) }])),
    equipment: context.equipment === null ? null : sort(context.equipment, (a, b) => a - b), ammoId: context.ammoId, metadata,
    minimumStock: sort(context.minimumStock ?? [], (a, b) => a.itemId - b.itemId),
    workflow: { map: context.workflow.map, playerId: context.workflow.playerId, alive: context.workflow.alive, idle: context.workflow.idle,
      zeny: context.workflow.zeny, world: workflowWorldSnapshot(context.workflow.world), protectedItemIds: context.workflow.protectedItemIds,
      pushCartLevel: context.workflow.pushCartLevel } });
}
function invalidContainer(container: DispositionContainer): boolean {
  const items = container.items;
  return items !== null && (items.length > 600 || new Set(items.map(item => item.bagId)).size !== items.length
    || new Set(items.filter(item => item.type === 2 && item.guid).map(item => item.guid)).size !== items.filter(item => item.type === 2 && item.guid).length
    || items.some(item => !safeNumber(item.bagId) || item.bagId < 1 || !safeNumber(item.itemId) || item.itemId < 1
      || !Number.isInteger(item.count) || item.count < 1 || item.count > 32767 || ![1, 2].includes(item.type)
      || item.type === 1 && item.bagId !== item.itemId || item.type === 2 && item.count !== 1));
}
function cloneWorld(world: WorkflowWorld): WorkflowWorld {
  const snapshot = workflowWorldSnapshot(world);
  return workflowWorldFromSnapshot({ ...snapshot, barter: [], party: null, invite: null, viewedVending: null });
}

/** Pure suggestion only: no sender, RPC, timer, or executor is accepted here. */
export function planDisposition(input: unknown, context: DispositionContext): DispositionPlan {
  const policy = validateDispositionPolicy(input);
  const plan: DispositionPlan = { binding: { revision: context.revision, fingerprint: fingerprint(policy, context) },
    actions: [], protections: [], unmet: [], blocked: [], estimatedCost: 0, reservedSpend: 0, estimatedProceeds: 0 };
  const fail = (message: string) => { if (!plan.blocked.includes(message)) plan.blocked.push(message); };
  if (!context.revision || context.revision.length > 256) fail('An observed revision is required.');
  for (const name of names) if (invalidContainer(context.containers[name])) fail(`Invalid ${name} snapshot.`);
  if (context.containers.inventory.items === null) fail('Inventory is not observed.');
  if (context.equipment === null || context.ammoId === null) fail('Equipment and selected ammunition are not observed.');
  if (context.minimumStock?.some(row => !safeNumber(row.itemId) || row.itemId < 1 || !Number.isInteger(row.count) || row.count < 0 || row.count > 32767)) fail('Invalid protected stock floor.');
  if (plan.blocked.length) return plan;
  const containers = {
    inventory: { ...context.containers.inventory, items: context.containers.inventory.items?.map(inventoryItemDraft) ?? null },
    storage: { ...context.containers.storage, items: context.containers.storage.items?.map(inventoryItemDraft) ?? null },
    cart: { ...context.containers.cart, items: context.containers.cart.items?.map(inventoryItemDraft) ?? null },
  };
  const incomingUniqueSlots: Record<ContainerName, number> = { inventory: 0, storage: 0, cart: 0 };
  const world = cloneWorld(context.workflow.world);
  let zeny = context.workflow.zeny;
  let conservativeZeny = context.workflow.zeny;
  const workflow = (): WorkflowContext => ({ ...context.workflow, world, zeny,
    inventory: containers.inventory.items!, equipped: [...context.equipment!, context.ammoId!],
    itemCatalog: Object.fromEntries(Object.entries(context.metadata).map(([id, item]) => [id, { sellPrice: item.sellPrice ?? -1, itemClass: item.itemClass }])) });
  const protection = (item: InventoryItem, name: ContainerName, rule?: DispositionRule): string | null => {
    if (name === 'inventory' && context.equipment!.includes(item.bagId)) return 'Equipped item';
    if (name === 'inventory' && context.ammoId === item.bagId) return 'Selected ammunition';
    if (context.workflow.protectedItemIds?.includes(item.itemId)) return 'Protected by transaction policy';
    if (!rule) return 'No disposition rule: preserve';
    if (item.type === 2) {
      if (!rule.allowUnique) return 'Unique item: preserve by default';
      if (typeof item.guid !== 'string' || !item.guid || item.guid.length > 64 || !Number.isInteger(item.refine) || item.refine! < 0 || item.refine! > 255
        || !Array.isArray(item.slots) || item.slots.length !== 4 || item.slots.some(id => !safeNumber(id))) return 'Unique identity, refinement or cards not observed';
      if (item.refine! > 0) return 'Refined item';
      if (item.slots.some(id => id !== 0)) return 'Carded item';
    }
    if (item.refine !== undefined && item.refine > 0) return 'Refined item';
    if (item.slots?.some(id => id !== 0)) return 'Carded item';
    return null;
  };
  const rules = sort(policy.rules, (a, b) => a.itemId - b.itemId);
  for (const name of names) for (const item of ordered(containers[name].items ?? [])) {
    const reason = protection(item, name, rules.find(row => row.itemId === item.itemId));
    if (reason) plan.protections.push({ container: name, itemId: item.itemId, bagId: item.bagId, count: item.count, reason });
  }
  const count = (itemId: number) => inventoryItemCount(domainItemId(itemId))(containers.inventory.items!);
  function capacity(item: InventoryItem, destination: ContainerName, requested: number, buy: boolean): { count: number; reason?: string } {
    const target = containers[destination]; const info = context.metadata[item.itemId];
    if (target.items === null) return { count: 0, reason: `${destination} stock is not observed.` };
    if (!safeNumber(target.slots) || target.slots < 1) return { count: 0, reason: `${destination} slot capacity is unknown.` };
    const stack = target.items.find(row => row.type === 1 && row.itemId === item.itemId);
    // Withdrawals use CanPickUpItem (full means full, even for an existing
    // stack). NPC buying uses a different, explicitly merge-aware slot check.
    if (target.items.length + incomingUniqueSlots[destination] >= target.slots && !(buy && stack)) return { count: 0, reason: `${destination} has no free slots.` };
    let allowed = Math.min(requested, 32767 - (stack?.count ?? 0));
    if (destination === 'inventory' && !buy && stack) allowed = Math.min(allowed, 29999 - stack.count);
    if (target.maxWeight !== 'unlimited') {
      if (!safeNumber(target.weight) || !safeNumber(target.maxWeight) || !safeNumber(info?.weight)) return { count: 0, reason: `${destination} weight or item weight is unknown.` };
      if (target.weight > target.maxWeight) return { count: 0, reason: `${destination} is overweight.` };
      if (info.weight > 0) allowed = Math.min(allowed, Math.floor((target.maxWeight - target.weight) / info.weight));
    }
    return { count: Math.max(0, allowed), ...(allowed < requested ? { reason: `${destination} weight or stack capacity limits quantity.` } : {}) };
  }
  function project(item: InventoryItem, from: ContainerName | 'shop', to: ContainerName | 'shop', quantity: number): void {
    const weight = context.metadata[item.itemId]?.weight;
    if (from !== 'shop') {
      const source = containers[from]; const entry = source.items!.find(row => row.bagId === item.bagId)!;
      entry.count -= quantity; source.items = source.items!.filter(row => row.count > 0);
      if (source.weight !== null) source.weight = safeNumber(weight) ? source.weight - weight * quantity : null;
    }
    if (to !== 'shop') {
      const target = containers[to]; const stack = item.type === 1 ? target.items!.find(row => row.type === 1 && row.itemId === item.itemId) : undefined;
      if (stack) stack.count += quantity;
      // Reserve a slot without inventing a destination bag ID or selectable
      // unique stock. The server alone assigns the new bag ID in its receipt.
      else if (item.type === 2) incomingUniqueSlots[to]++;
      else target.items!.push({ ...inventoryItemDraft(item), bagId: item.itemId, count: quantity });
      if (target.weight !== null) target.weight = safeNumber(weight) ? target.weight + weight * quantity : null;
    }
    world.storage.clear(); for (const row of containers.storage.items ?? []) world.storage.set(row.bagId, row);
    world.cart.clear(); for (const row of containers.cart.items ?? []) world.cart.set(row.bagId, row);
  }
  function suggest(rule: DispositionRule, item: InventoryItem, kind: DispositionAction['kind'], requested: number): { count: number; reasons: string[] } {
    const info = context.metadata[item.itemId]; const reasons: string[] = [];
    const from: DispositionAction['from'] = kind === 'buy' ? 'shop' : kind === 'withdraw' ? 'storage' : kind === 'uncart' ? 'cart' : 'inventory';
    const to: DispositionAction['to'] = kind === 'sell' ? 'shop' : kind === 'store' ? 'storage' : kind === 'cart' ? 'cart' : 'inventory';
    const permission = kind === 'withdraw' ? 'store' : kind === 'uncart' ? 'cart' : kind;
    if (!info || info[permission] !== true) reasons.push(`Verified ${permission} permission is unavailable or restricted.`);
    if (from !== 'shop') { const protectedReason = protection(item, from, rule); if (protectedReason) reasons.push(protectedReason); }
    if (kind === 'buy' && info?.unique !== false) reasons.push('Buying unique or unknown item identities is not planned.');
    if (plan.actions.length >= MAX_DISPOSITION_ACTIONS) reasons.push(`Preview is limited to ${MAX_DISPOSITION_ACTIONS} actions.`);
    if (reasons.length) return { count: 0, reasons };
    let quantity = Math.min(requested, item.count, 32767);
    if (to !== 'shop') { const room = capacity(item, to, quantity, kind === 'buy'); quantity = room.count; if (room.reason) reasons.push(room.reason); }
    if (!quantity) return { count: 0, reasons };
    const command = (quantity: number): WorldAction => kind === 'sell' || kind === 'buy' ? { type: 'shop', mode: kind, rows: [{ id: kind === 'buy' ? item.itemId : item.bagId, count: quantity }] }
      : kind === 'store' || kind === 'withdraw' ? { type: 'storage', operation: kind === 'store' ? 'deposit' : 'withdraw', bagId: item.bagId, count: quantity }
      : { type: 'cart', direction: kind === 'cart' ? 1 : 2, bagId: item.bagId, count: quantity };
    let cost = 0; let reserved = 0; let proceeds = 0;
    if (kind === 'buy') {
      const unit = shopQuote([{ id: item.itemId, count: 1 }], workflow());
      if (!unit || !safeNumber(conservativeZeny)) return { count: 0, reasons: [...reasons, 'Verified shop price or zeny is unknown.'] };
      if (unit.budget > 0) quantity = Math.min(quantity, Math.floor(Math.min(conservativeZeny, policy.maxSpend - plan.reservedSpend) / unit.budget));
      if (!quantity) return { count: 0, reasons: [...reasons, 'Zeny or maximum spending is exhausted.'] };
      const quote = shopQuote([{ id: item.itemId, count: quantity }], workflow());
      if (!quote) return { count: 0, reasons: [...reasons, 'Safe purchase quote is unavailable.'] };
      cost = quote.cost; reserved = quote.budget;
      if (quantity < requested) reasons.push('Available stock, capacity or spending limits quantity.');
    } else if (kind === 'sell') {
      const value = saleProceeds([{ id: item.bagId, count: quantity }], workflow());
      if (value === null) return { count: 0, reasons: [...reasons, 'Verified sale price or safe zeny balance is unknown.'] };
      proceeds = value;
    }
    const action = command(quantity); const blockers = worldActionBlockers(action, workflow());
    if (blockers.length) return { count: 0, reasons: [...reasons, ...blockers] };
    plan.actions.push({ kind, itemId: item.itemId, count: quantity, from, to, ...(from === 'shop' ? {} : { bagId: item.bagId }),
      ...(item.type === 2 ? { uniqueId: item.guid } : {}), command: action, estimatedCost: cost, reservedSpend: reserved, estimatedProceeds: proceeds });
    zeny += proceeds - cost; conservativeZeny += proceeds - reserved;
    plan.estimatedCost += cost; plan.reservedSpend += reserved; plan.estimatedProceeds += proceeds;
    project(item, from, to, quantity);
    return { count: quantity, reasons };
  }
  for (const rule of rules) {
    const carried = count(rule.itemId);
    const stockFloor = Math.max(rule.keep, ...context.minimumStock?.filter(row => row.itemId === rule.itemId).map(row => row.count) ?? []);
    const protectedExcess = Math.min(Math.max(0, carried - rule.maximum), Math.max(0, stockFloor - rule.maximum));
    let remaining = Math.max(0, carried - Math.max(rule.maximum, stockFloor)); const reasons: string[] = [];
    if (protectedExcess) plan.unmet.push({ itemId: rule.itemId, count: protectedExcess, kind: 'excess', reasons: ['Protected stock floor takes precedence over the maximum target.'] });
    if (remaining > 0) {
      const options = (['store', 'cart', 'sell'] as const).filter(kind => rule[kind]);
      if (!options.length) reasons.push('No excess disposition is permitted; preserve.');
      for (const kind of options) {
        for (const item of ordered(containers.inventory.items!).filter(item => item.itemId === rule.itemId)) {
          if (remaining <= 0) break;
          const result = suggest(rule, item, kind, Math.min(item.count, remaining)); remaining -= result.count; reasons.push(...result.reasons);
        }
        // Unknown preferred prerequisites cannot authorize a destructive fallback.
        if (remaining && reasons.some(reason => /unknown|unavailable|not observed|required|not open|not ready|confirmed/i.test(reason))) break;
      }
      if (remaining) plan.unmet.push({ itemId: rule.itemId, count: remaining, kind: 'excess', reasons: [...new Set(reasons)] });
    } else if (carried < rule.minimum) {
      remaining = rule.desired - carried;
      if (rule.restock === 'off') reasons.push('Restocking is disabled.');
      else if (rule.restock === 'buy') {
        const result = suggest(rule, { bagId: rule.itemId, itemId: rule.itemId, count: remaining, type: 1 }, 'buy', remaining);
        remaining -= result.count; reasons.push(...result.reasons);
      } else {
        const source = containers[rule.restock];
        if (source.items === null) reasons.push(`${rule.restock} stock is not observed.`);
        else for (const item of ordered(source.items).filter(item => item.itemId === rule.itemId && item.bagId > 0)) {
          if (remaining <= 0) break;
          const result = suggest(rule, item, rule.restock === 'storage' ? 'withdraw' : 'uncart', Math.min(item.count, remaining));
          remaining -= result.count; reasons.push(...result.reasons);
        }
        if (remaining && !reasons.length) reasons.push(`Insufficient ${rule.restock} stock.`);
      }
      if (remaining) plan.unmet.push({ itemId: rule.itemId, count: remaining, kind: 'shortage', reasons: [...new Set(reasons)] });
    }
  }
  for (const target of plan.unmet) for (const reason of target.reasons) fail(`Item #${target.itemId}: ${reason}`);
  return plan;
}

/** Recompute before every future action; a matching revision alone is insufficient. */
export function revalidateDisposition(plan: DispositionPlan, input: unknown, context: DispositionContext): { ok: boolean; reasons: string[] } {
  const next = planDisposition(input, context); const reasons: string[] = [];
  if (plan.binding.revision !== next.binding.revision) reasons.push('Observed revision changed.');
  if (plan.binding.fingerprint !== next.binding.fingerprint) reasons.push('Inventory, policy or transaction prerequisites changed.');
  if (canonical(plan.actions) !== canonical(next.actions)) reasons.push('Suggested actions changed.');
  if (next.blocked.length) reasons.push(...next.blocked);
  return { ok: reasons.length === 0, reasons: [...new Set(reasons)] };
}

export function dispositionPreviewIsCurrent(plan: DispositionPlan, input: unknown, context: DispositionContext): boolean {
  return plan.binding.revision === context.revision && plan.binding.fingerprint === fingerprint(validateDispositionPolicy(input), context);
}

import { entries, filter, fromEntries, groupBy, map, pipe, reduce, take, values } from 'remeda';
import { hpPotionIds } from './hp-potions';
import { recoveryItemIds } from './recovery-items';
import { ITEM_CATALOG, itemName } from './game-catalog';
import type { InventoryItem } from './protocol-feature';
import type { WorldSnapshot } from './world-state-logic';
import { workflowWorldFromSnapshot } from './workflows-logic';
import type { ShopEntry } from './world-protocol';
import type { AutomationSettings } from './settings';
import { AMMO_CATALOG } from './loadout-logic';
import { type DispositionContext, type DispositionItemInfo, type DispositionPlan } from './disposition';

const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const number = (v: unknown): number | null => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 && v <= 2_147_483_647 ? v : null;
function items(input: unknown): InventoryItem[] | null {
  if (!Array.isArray(input) || input.length > 600) return null;
  const result: InventoryItem[] = [];
  for (const value of input) {
    const row = object(value); const bagId = number(row.bagId); const itemId = number(row.itemId); const count = number(row.count);
    if (!bagId || !itemId || !count || count > 32767 || row.type !== 1 && row.type !== 2) return null;
    // Character telemetry may omit unique identity/cards; world container
    // snapshots can supply them. Copy only observed, bounded metadata.
    result.push({ bagId, itemId, count, type: row.type,
      ...(number(row.refine) === null || number(row.refine)! > 255 ? {} : { refine: number(row.refine)! }),
      ...(typeof row.guid === 'string' && row.guid.length > 0 && row.guid.length <= 64 ? { guid: row.guid } : {}),
      ...(Array.isArray(row.slots) && row.slots.length === 4 && row.slots.every(id => number(id) !== null) ? { slots: [...row.slots] as number[] } : {}) });
  }
  return result;
}

/** These are handler/category contracts from the pinned server, not item flags.
 * DataLoader maps classes 1/4/5/6 to regular and 2/3 to unique items. The normal
 * shop/storage/cart handlers have no additional binding or category restriction.
 * Equipment, selected ammo and unique protections are applied by the planner.
 */
export function publishedDispositionMetadata(): Readonly<Record<string, DispositionItemInfo>> {
  return pipe(ITEM_CATALOG, entries(), map(([id, item]) => {
    const known = [1, 2, 3, 4, 5, 6].includes(item.itemClass);
    return [id, { weight: number(item.weight), sellPrice: number(item.sellPrice), itemClass: item.itemClass,
      unique: known ? [2, 3].includes(item.itemClass) : null,
      ...(known ? { store: true, sell: true, cart: true, buy: true } : {}) }] as const;
  }), fromEntries());
}
const metadata = publishedDispositionMetadata();
const compatibleAmmoIds = pipe(AMMO_CATALOG, entries(), filter(([, info]) => info.ammoType === 0), map(([id]) => Number(id)));

export function dispositionStockFloors(settings: AutomationSettings): { itemId: number; count: number }[] {
  const floors = map(settings.items, row => ({ itemId: row.itemId, count: row.minStock }));
  const withReserve = (policy: { minStock: number } | undefined) => (itemId: number) => ({ itemId, count: policy!.minStock });
  floors.push(...map(hpPotionIds(settings.hpPotions), withReserve(settings.hpPotions)));
  floors.push(...map(recoveryItemIds(settings.spPotions,'sp'), withReserve(settings.spPotions)));
  const escape = settings.escape;
  if (escape?.enabled && escape.method === 'item') floors.push({ itemId: escape.mode === 'random' ? 601 : 602, count: escape.minStock });
  if (settings.loadout.enabled && settings.loadout.minAmmoStock > 0)
    floors.push(...map(compatibleAmmoIds, withReserve({ minStock: settings.loadout.minAmmoStock })));
  return pipe(floors, groupBy(row => `item:${row.itemId}`), values(),
    map(rows => ({ itemId: rows[0]!.itemId, count: reduce(rows, (count, row) => Math.max(count, row.count), 0) })));
}

/** Read-only adapter. No game/controller hooks are available to this module. */
export function dispositionContextFromStatus(status: Record<string, unknown>): DispositionContext {
  const character = object(status.character); const stats = object(character.stats); const observedWorld = object(status.world);
  const npc = object(observedWorld.npc); const player = object(status.player);
  const world: WorldSnapshot = { map: '', generation: 0, revision: 0,
    npc: { id: null, mode: 'idle', dialog: null, options: [] }, shop: null, storage: [], storageReady: false,
    barter: [], cart: [], hasCart: false, cartReady: false, party: null, invite: null, vending: null, viewedVending: null };
  world.map = typeof observedWorld.map === 'string' ? observedWorld.map : '';
  world.generation = number(observedWorld.generation) ?? 0; world.revision = number(observedWorld.revision) ?? 0;
  const inventory = character.inventoryKnown === true ? items(character.inventory) : null;
  const storage = observedWorld.storageReady === true ? items(observedWorld.storage) : null;
  const cart = observedWorld.cartReady === true ? items(observedWorld.cart) : null;
  const npcId = number(npc.id); const mode = npc.mode;
  if (npcId !== null && Number.isInteger(npcId) && npcId>=0 && npcId<=0x7fffffff && ['idle', 'dialog', 'options', 'shop', 'storage', 'barter', 'refine', 'vending'].includes(String(mode))) {
    world.npc = { id: npcId, mode: mode as typeof world.npc.mode, dialog: null, options: [] };
  }
  const shop = object(observedWorld.shop);
  if (['buy', 'sell'].includes(String(shop.mode)) && number(shop.discountLevel) !== null && Array.isArray(shop.entries)) {
    const entries: ShopEntry[] = [];
    for (const value of shop.entries) { const row = object(value); const itemId = number(row.itemId); const price = number(row.price); if (itemId && price !== null) entries.push({ itemId, price }); }
    if (entries.length === shop.entries.length && new Set(entries.map(row => row.itemId)).size === entries.length) world.shop = { mode: shop.mode as 'buy' | 'sell', discountLevel: number(shop.discountLevel)!, entries };
  }
  world.storageReady = storage !== null; world.storage = storage ?? [];
  world.hasCart = observedWorld.hasCart === true; world.cartReady = cart !== null; world.cart = cart ?? [];
  if (observedWorld.vending) world.vending = { name: '', rows: [] };
  const equipment = Array.isArray(character.equipment) && character.equipment.length <= 14
    && character.equipment.every(id => typeof id === 'number' && Number.isInteger(id) && id >= -1 && id <= 2_147_483_647) ? [...character.equipment] as number[] : null;
  const ammoId = typeof character.ammoId === 'number' && Number.isInteger(character.ammoId) && character.ammoId >= -1 && character.ammoId <= 2_147_483_647 ? character.ammoId : null;
  const learned = character.skillsKnown === true && Array.isArray(character.learned) ? map(character.learned, object) : [];
  const pushCartLevel = number(learned.find(row => row.skillId === 73)?.level) ?? 0;
  const ownId=number(player.id);const own=ownId!==null&&Number.isInteger(ownId)&&ownId>=0&&ownId<=0x7fffffff&&player.kind===0;
  const ready = status.connected === true && status.compatible === true && own && player.dead === false;
  const idle = status.running === false && status.runRequested !== true && object(status.task).pending === false
    && object(status.escape).pending !== true
    && !['switching', 'restoring', 'holding', 'fault'].includes(String(object(status.loadout).state))
    && object(status.actionResult).status !== 'pending' && object(status.workflow).running !== true
    && !['running', 'waiting'].includes(String(object(status.routine).state))
    && (!Array.isArray(object(status.navigation).leg) || (object(status.navigation).leg as unknown[]).length === 0);
  return {
    revision: typeof status.sessionId === 'string' ? `${status.sessionId}:${status.connectionId ?? ''}:${world.map}:${world.generation}:${world.revision}` : '',
    containers: {
      // Source-known ceilings are explicit; current weight remains unknown
      // until the server supplies it. Storage has no weight check in this pin.
      inventory: { items: inventory, slots: 200, weight: number(stats.weight), maxWeight: number(stats.maxWeight) },
      storage: { items: storage, slots: 600, weight: null, maxWeight: 'unlimited' },
      cart: { items: cart, slots: 100, weight: number(stats.cartWeight), maxWeight: 80000 },
    }, equipment, ammoId, metadata: structuredClone(metadata),
    workflow: { map: typeof status.map === 'string' ? status.map : '', playerId: own?ownId:null,
      alive: ready, idle, inventory: inventory ?? [], equipped: equipment ?? [], zeny: number(stats.zeny) ?? -1,
      world: workflowWorldFromSnapshot(world), visibleNpcIds: [], pushCartLevel },
  };
}

export function dispositionPreviewText(plan: DispositionPlan): string {
  const lines = [`Preview only · ${plan.actions.length} suggested actions · ${plan.protections.length} protected entries`,
    `Estimated spending ${plan.estimatedCost}z · Budget reserved ${plan.reservedSpend}z · Estimated proceeds ${plan.estimatedProceeds}z`,
    ...map(plan.actions, (action, index) => `${index + 1}. ${action.kind} ${itemName(action.itemId)} × ${action.count}${action.bagId === undefined ? '' : ` · bag #${action.bagId}`} · ${action.from} → ${action.to}`),
    ...pipe(plan.protections, take(32), map(row => `Keep ${itemName(row.itemId)} × ${row.count} · ${row.container} bag #${row.bagId}: ${row.reason}`)),
    ...map(plan.unmet, row => `Unmet ${row.kind}: ${itemName(row.itemId)} × ${row.count}`),
    ...map(plan.blocked, reason => `Blocked: ${reason}`)];
  if (plan.protections.length > 32) lines.push(`+ ${plan.protections.length - 32} further protected entries`);
  if (plan.estimatedCost !== plan.reservedSpend) lines.push('Shop pricing may differ from the display. The spending reservation uses the higher quote.');
  lines.push('No items moved or sold. Generate a new preview when stock or transaction state changes.');
  return lines.join('\n');
}

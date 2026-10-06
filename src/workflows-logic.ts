import type { ActionIdentity } from './actor-identity';
import type { InventoryItem } from './protocol-feature';
import { validateWorldAction, type PartyMember, type ItemRow, type WorldAction, type WorldEvent } from './world-protocol';
import type { WorldSnapshot } from './world-state-logic';
export type WorkflowStep =
  | { type: 'talk'; expectedCost?: number }
  | { type: 'advance'; expectedText?: string; exactDialogue?: { name: string; text: string }; expectedCost?: number }
  | { type: 'option'; index: number; expectedLabel: string; expectedOptions?: string[][]; expectedCost?: number }
  | { type: 'buy' | 'sell'; rows: ItemRow[] }
  | { type: 'deposit' | 'withdraw'; bagId: number; count: number }
  | { type: 'closeShop' | 'closeStorage' | 'cancelBarter' }
  | { type: 'barter'; choice: number; count: number; bagIds: number[] };

export interface WorkflowSpec {
  name: string; map: string; npcId: number; maxSpend: number;
  minStock: { itemId: number; count: number }[];
  steps: WorkflowStep[]; timeoutMs?: number;
}

/** Data consumed by workflow policy. Runtime state owners satisfy this view structurally. */
export interface WorkflowWorld extends Omit<WorldSnapshot, 'storage' | 'cart' | 'party'> {
  storage: Map<number, InventoryItem>;
  cart: Map<number, InventoryItem>;
  party: { id: number; name: string; members: Map<number, PartyMember> } | null;
}

/** Detach a server snapshot before projections or speculative plans change local copies. */
export function workflowWorldFromSnapshot(snapshot: WorldSnapshot): WorkflowWorld {
  const detached = structuredClone(snapshot);
  return { ...detached,
    storage: new Map(detached.storage.map(item => [item.bagId, item])),
    cart: new Map(detached.cart.map(item => [item.bagId, item])),
    party: detached.party ? { ...detached.party, members: new Map(detached.party.members.map(member => [member.memberId, member])) } : null };
}

export function workflowWorldSnapshot(world: WorkflowWorld): WorldSnapshot {
  return structuredClone({
    map: world.map, generation: world.generation, revision: world.revision,
    npc: world.npc, shop: world.shop, storage: [...world.storage.values()], storageReady: world.storageReady,
    barter: world.barter, cart: [...world.cart.values()], hasCart: world.hasCart, cartReady: world.cartReady,
    party: world.party ? { id: world.party.id, name: world.party.name, members: [...world.party.members.values()] } : null,
    invite: world.invite, vending: world.vending, viewedVending: world.viewedVending,
  });
}

export interface WorkflowContext {
  map: string; playerId: number | null; alive: boolean; idle: boolean;
  inventory: InventoryItem[]; equipped: number[]; zeny: number;
  world: WorkflowWorld; visibleNpcIds: number[]; visiblePlayerIds?: number[];
  actorIdentity?:(id:number)=>ActionIdentity|null;
  protectedItemIds?: number[]; basicSkillLevel?: number; pushCartLevel?: number; vendingLevel?: number;
  itemCatalog?: Readonly<Record<string, { sellPrice: number; itemClass: number }>>;
}

export interface WorkflowSnapshot {
  state: 'idle' | 'running' | 'complete' | 'failed' | 'cancelled';
  running: boolean; name: string; step: number; total: number;
  pending: string | null; reason: string; spent: number;
}

export interface WorkflowPreview { ok: boolean; reasons: string[]; estimatedSpend: number; unpriced: boolean }

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)
    || Object.keys(value).some(key => !keys.includes(key))) throw new Error('Invalid workflow fields');
  return value as Record<string, unknown>;
}

function integer(value: unknown, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) throw new Error('Invalid workflow number');
  return value;
}

export function text(value: unknown, max: number, allowEmpty = false): string {
  if (typeof value !== 'string' || (!allowEmpty && !value.trim()) || value.length > max || /[\u0000-\u001f\u007f]/.test(value)) throw new Error('Invalid workflow text');
  return value;
}

export function validateWorkflowSpec(input: unknown): WorkflowSpec {
  const value = record(input, ['name', 'map', 'npcId', 'maxSpend', 'minStock', 'steps', 'timeoutMs']);
  const name = text(value.name, 64); const map = text(value.map, 64);
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(map)) throw new Error('Invalid workflow map');
  const npcId = integer(value.npcId, 0, 2_147_483_647); const maxSpend = integer(value.maxSpend, 0, 2_000_000_000);
  // Both recovery catalogs, advanced item rules, ammo and escape reserves fit.
  if (!Array.isArray(value.minStock) || value.minStock.length > 160) throw new Error('Invalid stock rules');
  const minStock = value.minStock.map(item => {
    const row = record(item, ['itemId', 'count']);
    return { itemId: integer(row.itemId, 1, 2_147_483_647), count: integer(row.count, 0, 32767) };
  });
  if (new Set(minStock.map(item => item.itemId)).size !== minStock.length) throw new Error('Duplicate stock rules');
  if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32) throw new Error('Invalid workflow steps');
  const steps = value.steps.map((inputStep): WorkflowStep => {
    const step = record(inputStep, ['type', 'expectedText', 'exactDialogue', 'expectedOptions', 'expectedCost', 'index', 'expectedLabel', 'rows', 'bagId', 'count', 'choice', 'bagIds']);
    const exact = (keys: string[]) => record(step, ['type', ...keys]);
    const fee = () => step.expectedCost === undefined ? {} : { expectedCost: integer(step.expectedCost, 0, 2_000_000_000) };
    switch (step.type) {
      case 'talk': exact(['expectedCost']); return { type: 'talk', ...fee() };
      case 'closeShop': case 'closeStorage': case 'cancelBarter': exact([]); return { type: step.type };
      case 'advance':
        exact(['expectedText', 'exactDialogue', 'expectedCost']);
        return { type: 'advance', ...fee(), ...(step.expectedText === undefined ? {} : { expectedText: text(step.expectedText, 1024) }),
          ...(step.exactDialogue === undefined ? {} : { exactDialogue: (() => { const dialog = record(step.exactDialogue, ['name','text']); return { name: text(dialog.name, 128), text: text(dialog.text, 1024) }; })() }) };
      case 'option':
        exact(['index', 'expectedLabel', 'expectedOptions', 'expectedCost']);
        return { type: 'option', index: integer(step.index, 0, 31), expectedLabel: text(step.expectedLabel, 1024), ...fee(),
          ...(step.expectedOptions === undefined ? {} : { expectedOptions: (() => {
            if (!Array.isArray(step.expectedOptions) || !step.expectedOptions.length || step.expectedOptions.length > 4) throw new Error('Invalid expected menus');
            return step.expectedOptions.map(menu => {
              if (!Array.isArray(menu) || !menu.length || menu.length > 32) throw new Error('Invalid expected menu');
              return menu.map(label => text(label, 1024, true));
            });
          })() }) };
      case 'buy': case 'sell': {
        exact(['rows']); const action = validateWorldAction({ type: 'shop', mode: step.type, rows: step.rows });
        if (action.type !== 'shop' || !action.rows.length) throw new Error('Empty workflow purchase/sale');
        return { type: step.type, rows: action.rows };
      }
      case 'deposit': case 'withdraw': {
        exact(['bagId', 'count']); const action = validateWorldAction({ type: 'storage', operation: step.type, bagId: step.bagId, count: step.count });
        if (action.type !== 'storage' || action.operation === 'close') throw new Error('Invalid transfer');
        return { type: step.type, bagId: action.bagId, count: action.count };
      }
      case 'barter': {
        exact(['choice', 'count', 'bagIds']); const action = validateWorldAction({ ...step, type: 'npcBarter' });
        if (action.type !== 'npcBarter') throw new Error('Invalid barter');
        return { type: 'barter', choice: action.choice, count: action.count, bagIds: action.bagIds };
      }
      default: throw new Error('Unknown workflow step');
    }
  });
  return { name, map, npcId, maxSpend, minStock, steps,
    ...(value.timeoutMs === undefined ? {} : { timeoutMs: integer(value.timeoutMs, 1000, 60_000) }) };
}

function itemCount(items: InventoryItem[], itemId: number): number { return items.reduce((sum, item) => sum + (item.itemId === itemId ? item.count : 0), 0); }

export function stock(items: InventoryItem[]): Map<number, number> {
  const result = new Map<number, number>();
  for (const item of items) result.set(item.itemId, (result.get(item.itemId) ?? 0) + item.count);
  return result;
}

function protectedItem(item: InventoryItem, context: WorkflowContext): boolean {
  return context.equipped.includes(item.bagId) || (context.protectedItemIds?.includes(item.itemId) ?? false);
}

export function shopQuote(rows: ItemRow[], context: WorkflowContext): { cost: number; budget: number } | null {
  const shop = context.world.shop;
  if (shop?.mode !== 'buy') return null;
  const discount = shop.discountLevel > 0 ? Math.min(24, 5 + shop.discountLevel * 2) : 0;
  let cost = 0; let budget = 0;
  for (const row of rows) {
    const entry = shop.entries.find(entry => entry.itemId === row.id);
    if (!entry) return null;
    // Npc.cs710 currently discounts the item ID, while ShopUI displays a
    // discount on the price. Match the server receipt, but budget for either
    // nonnegative interpretation. Do not automate negative prices or int32
    // arithmetic overflow in this source bug.
    if (entry.itemId * discount > 2_147_483_647 || entry.price * discount > 2_147_483_647) return null;
    const serverUnitCost = entry.price - Math.floor(entry.itemId * discount / 100);
    const displayedUnitCost = entry.price - Math.floor(entry.price * discount / 100);
    if (serverUnitCost < 0 || serverUnitCost * row.count > 2_147_483_647) return null;
    cost += serverUnitCost * row.count;
    budget += Math.max(serverUnitCost, displayedUnitCost) * row.count;
  }
  return Number.isSafeInteger(cost) && cost <= 2_147_483_647 && Number.isSafeInteger(budget) && budget <= 2_147_483_647 ? { cost, budget } : null;
}

export function saleProceeds(rows: ItemRow[], context: WorkflowContext): number | null {
  const shop = context.world.shop;
  if (shop?.mode !== 'sell') return null;
  const percent = shop.discountLevel > 0 ? Math.min(24, 5 + shop.discountLevel * 2) : 0;
  let proceeds = 0;
  for (const row of rows) {
    const item = context.inventory.find(item => item.bagId === row.id);
    if (!item) return null;
    const info = context.itemCatalog?.[item.itemId];
    if (!info || !Number.isInteger(info.sellPrice) || info.sellPrice < 0 || !Number.isInteger(info.itemClass) || info.itemClass < 0 || info.itemClass > 6) return null;
    // DataToClientUtility exports SellPrice = ItemInfo.SellToStoreValue.
    // Npc.cs788-791 ignores ammo proceeds and rounds each unit before count.
    const product = info.sellPrice * (100 + percent);
    if (product > 2_147_483_647) return null;
    const value = info.itemClass === 4 ? 0 : Math.floor(product / 100);
    if (value * row.count > 2_147_483_647) return null;
    proceeds += value * row.count;
  }
  if (!Number.isInteger(context.zeny) || context.zeny < 0 || context.zeny + proceeds > 2_147_483_647) return null;
  return Number.isSafeInteger(proceeds) && proceeds <= 2_147_483_647 ? proceeds : null;
}

export function barterConsumption(action: Extract<WorldAction, { type: 'npcBarter' }>, context: WorkflowContext): { itemId: number; count: number }[] | null {
  const offer = context.world.barter[action.choice];
  if (!offer) return null;
  const required = new Map<number, number>();
  for (const row of offer.required) required.set(row.itemId, (required.get(row.itemId) ?? 0) + row.count * action.count);
  const selected = action.bagIds.map(bagId => context.inventory.find(item => item.bagId === bagId));
  if (selected.some(item => !item || item.type !== 2 || protectedItem(item, context))) return null;
  // Unique ingredients must name every selected bag. Automatic choice by item ID
  // could consume a refined, socketed, or equipped item the user did not select.
  for (const item of selected) if (item && !required.has(item.itemId)) return null;
  for (const [itemId, count] of required) {
    const regular = context.inventory.filter(item => item.itemId === itemId && item.type === 1 && !protectedItem(item, context)).reduce((sum, item) => sum + item.count, 0);
    const unique = selected.filter(item => item?.itemId === itemId).length;
    if (regular < count && unique !== count) return null;
    if (regular >= count && unique > 0) return null;
  }
  return [...required].map(([itemId, count]) => ({ itemId, count }));
}

/** Context checks apply to manual actions and routine actions as well as workflows. */
export function worldActionBlockers(input: WorldAction, context: WorkflowContext, refineAdvance = false): string[] {
  let action: WorldAction;
  try { action = validateWorldAction(input); } catch (error) { return [error instanceof Error ? error.message : 'Invalid action']; }
  const reasons: string[] = []; const state = context.world;
  if (context.playerId===null||!context.alive) reasons.push('A ready living character is required.');
  if (!context.idle) reasons.push('Wait for movement and the previous action to finish.');
  if (!context.map || context.map !== state.map) reasons.push('World state is not ready for this map.');
  const npcContext = () => { if (state.npc.id === null) reasons.push('No confirmed NPC interaction.'); else if(state.npc.id===0&&!context.visibleNpcIds.includes(0))reasons.push('NPC actor zero is no longer observed.'); };
  const checkBag = (items: InventoryItem[], bagId: number, count: number, protect: boolean) => {
    const item = items.find(item => item.bagId === bagId);
    if (!item || item.count < count) reasons.push('Item count is unavailable.');
    else if (protect && protectedItem(item, context)) reasons.push('Equipped or protected items cannot be consumed.');
  };
  const ownMember = state.party ? [...state.party.members.values()].find(member => member.entityId > 0 && member.entityId === context.playerId) : undefined;
  const partyIdentity = () => {if(context.playerId===0)reasons.push('Party member actor zero is ambiguous with offline membership; identity is unavailable.');};
  const leader = () => {partyIdentity(); if (!state.party || !ownMember?.leader) reasons.push('Only the confirmed party leader can perform this action.'); };
  switch (action.type) {
    case 'npcTalk':
      if (!context.visibleNpcIds.includes(action.id)) reasons.push('Select a visible NPC.');
      if (state.npc.mode !== 'idle' || state.npc.id !== null) reasons.push('Finish the current NPC interaction first.');
      break;
    case 'npcAdvance': npcContext(); if (state.npc.mode !== 'dialog' && !(refineAdvance && state.npc.mode === 'refine')) reasons.push('NPC is not waiting at a dialog.'); break;
    case 'npcOption':
      npcContext(); if (state.npc.mode !== 'options' || !state.npc.options[action.index]?.trim()) reasons.push('NPC option is unavailable.'); break;
    case 'shop':
      npcContext(); if (state.npc.mode !== 'shop' || state.shop?.mode !== action.mode) reasons.push('The corresponding shop is not open.');
      if (action.mode === 'buy' && action.rows.length) {
        const quote = shopQuote(action.rows, context);
        if (quote === null) reasons.push('Requested item or safe price is unavailable.');
        else if (quote.budget > context.zeny) reasons.push('Insufficient zeny.');
      } else if (action.mode === 'sell') {
        for (const row of action.rows) checkBag(context.inventory, row.id, row.count, true);
        if (action.rows.length && saleProceeds(action.rows, context) === null) reasons.push('Verified sale prices or safe proceeds are unavailable.');
      }
      break;
    case 'storage':
      npcContext(); if (state.npc.mode !== 'storage' || !state.storageReady) reasons.push('A confirmed storage snapshot is required.');
      if (action.operation !== 'close') checkBag(action.operation === 'deposit' ? context.inventory : [...state.storage.values()], action.bagId, action.count, action.operation === 'deposit');
      break;
    case 'npcBarter': {
      npcContext(); if (state.npc.mode !== 'barter') reasons.push('A barter window is required.');
      const offer = state.barter[action.choice];
      if (!offer || barterConsumption(action, context) === null) reasons.push('Barter ingredients or selected bags are unavailable.');
      if (offer && offer.zenyCost * action.count > context.zeny) reasons.push('Insufficient zeny.');
      break;
    }
    case 'npcBarterCancel': npcContext(); if (state.npc.mode !== 'barter') reasons.push('A barter window is required.'); break;
    case 'cart':
      if (!state.hasCart || !state.cartReady || (context.pushCartLevel ?? 0) < 1) reasons.push('A confirmed cart and Push Cart skill are required.');
      if (state.npc.mode !== 'idle' || state.vending) reasons.push('Finish the current interaction first.');
      checkBag(action.direction === 1 ? context.inventory : [...state.cart.values()], action.bagId, action.count, action.direction === 1); break;
    case 'partyCreate':
      if (state.party) reasons.push('Already in a party.');
      if ((context.basicSkillLevel ?? 0) < 6) reasons.push('Basic Mastery level 6 is required.');
      if (action.inviteId === context.playerId) reasons.push('Cannot invite yourself.'); break;
    case 'partyInviteId': leader(); if(action.id===0&&!context.visiblePlayerIds?.includes(0))reasons.push('Select a currently observed player for actor-zero invitation.'); if (action.id === context.playerId) reasons.push('Cannot invite yourself.'); break;
    case 'partyInviteName': leader(); break;
    case 'partyAccept': if (state.party || state.invite?.partyId !== action.partyId) reasons.push('Select the current received party invitation.'); break;
    case 'partyLeave': partyIdentity(); if (!state.party || !ownMember) reasons.push('No confirmed party membership.'); break;
    case 'partyLeader': case 'partyRemove':
      leader(); if (!state.party?.members.has(action.memberId)) reasons.push('Selected party member is unavailable.'); break;
    case 'partyDisband': leader(); break;
    case 'vendingStart':
      if (!state.hasCart || !state.cartReady || (context.vendingLevel ?? 0) < 1) reasons.push('A confirmed cart and Vending skill are required.');
      if (state.vending || state.npc.mode !== 'idle') reasons.push('Finish the current interaction first.');
      if (action.rows.length > (context.vendingLevel ?? 0) + 2) reasons.push('Too many rows for the learned Vending level.');
      for (const row of action.rows) checkBag([...state.cart.values()], row.id, row.count, false); break;
    case 'vendingStop': if (!state.vending) reasons.push('No confirmed active vending shop.'); break;
    case 'vendingView': if (!context.visibleNpcIds.includes(action.id)) reasons.push('Select a visible vendor.'); break;
    case 'vendingPurchase': {
      if (!state.viewedVending) reasons.push('Open a confirmed vending store first.');
      let cost = 0;
      for (const row of action.rows) {
        const entry = state.viewedVending?.entries.find(entry => entry.item.bagId === row.id);
        if (!entry || entry.item.count < row.count) reasons.push('Requested vendor stock is unavailable.');
        else cost += entry.price * row.count;
      }
      if (!Number.isSafeInteger(cost) || cost > context.zeny) reasons.push('Insufficient zeny.'); break;
    }
  }
  return [...new Set(reasons)];
}

export interface VendingReceipt {
  readonly map: string; readonly generation: number; readonly vendorId: number; readonly npcId: number | null;
  readonly beforeZeny: number; readonly cost: number;
  readonly gains: readonly { readonly itemId: number; readonly before: number; readonly count: number }[];
}

/** Capture before sending: ending the NPC interaction clears the store preview. */
export function createVendingReceipt(action: Extract<WorldAction, { type: 'vendingPurchase' }>, context: WorkflowContext): VendingReceipt {
  const validated = validateWorldAction(action);
  if (validated.type !== 'vendingPurchase') throw new Error('Invalid vending purchase');
  const reasons = worldActionBlockers(validated, context);
  if (reasons.length) throw new Error(reasons.join(' '));
  const store = context.world.viewedVending!; const counts = new Map<number, number>();
  let cost = 0;
  for (const row of validated.rows) {
    const entry = store.entries.find(entry => entry.item.bagId === row.id)!;
    counts.set(entry.item.itemId, (counts.get(entry.item.itemId) ?? 0) + row.count);
    cost += entry.price * row.count;
  }
  return {
    map: context.map, generation: context.world.generation, vendorId: store.id, npcId: context.world.npc.id,
    beforeZeny: context.zeny, cost,
    gains: [...counts].map(([itemId, count]) => ({ itemId, before: itemCount(context.inventory, itemId), count })),
  };
}

/** A send alone proves nothing; require the exact authoritative debit and gain. */
export function confirmVendingReceipt(receipt: VendingReceipt, context: WorkflowContext): boolean {
  if (context.map !== receipt.map || context.world.map !== receipt.map || context.world.generation !== receipt.generation) return false;
  if (context.world.npc.id !== null && receipt.npcId !== null && context.world.npc.id !== receipt.npcId) return false;
  if (context.world.viewedVending !== null && context.world.viewedVending.id !== receipt.vendorId) return false;
  if (receipt.beforeZeny - context.zeny !== receipt.cost) return false;
  if (!receipt.gains.length) return context.world.viewedVending === null && context.world.npc.mode === 'idle';
  return receipt.gains.every(gain => itemCount(context.inventory, gain.itemId) === gain.before + gain.count);
}

export function actionFor(step: WorkflowStep, npcId: number): WorldAction {
  switch (step.type) {
    case 'talk': return { type: 'npcTalk', id: npcId };
    case 'advance': return { type: 'npcAdvance' };
    case 'option': return { type: 'npcOption', index: step.index };
    case 'buy': case 'sell': return { type: 'shop', mode: step.type, rows: step.rows };
    case 'deposit': case 'withdraw': return { type: 'storage', operation: step.type, bagId: step.bagId, count: step.count };
    case 'closeShop': return { type: 'shop', mode: 'sell', rows: [] }; // replaced with observed mode by caller
    case 'closeStorage': return { type: 'storage', operation: 'close' };
    case 'barter': return { type: 'npcBarter', choice: step.choice, count: step.count, bagIds: step.bagIds };
    case 'cancelBarter': return { type: 'npcBarterCancel' };
  }
}

export function dryRunWorkflow(input: unknown, context: WorkflowContext): WorkflowPreview {
  let spec: WorkflowSpec;
  try { spec = validateWorkflowSpec(input); } catch (error) { return { ok: false, reasons: [error instanceof Error ? error.message : 'Invalid workflow'], estimatedSpend: 0, unpriced: false }; }
  const reasons: string[] = [];
  if (spec.map !== context.map || spec.map !== context.world.map) reasons.push('Workflow is bound to a different map.');
  if (!context.alive || !context.idle) reasons.push('Wait for a living, idle character.');
  if (context.world.npc.id !== null && context.world.npc.id !== spec.npcId) reasons.push('A different NPC interaction is active.');
  if (spec.steps[0]!.type === 'talk' && !context.visibleNpcIds.includes(spec.npcId)) reasons.push('Workflow NPC is not visible.');
  let estimatedSpend = 0; let unpriced = false;
  for (const step of spec.steps) {
    if (step.type === 'talk' || step.type === 'advance' || step.type === 'option') {
      estimatedSpend += step.expectedCost ?? 0;
    } else if (step.type === 'buy') {
      const quote = shopQuote(step.rows, context);
      if (quote === null) unpriced = true; else estimatedSpend += quote.budget;
    } else if (step.type === 'barter') {
      const offer = context.world.barter[step.choice];
      if (!offer) unpriced = true; else estimatedSpend += offer.zenyCost * step.count;
    }
  }
  if (!Number.isSafeInteger(estimatedSpend) || estimatedSpend > spec.maxSpend) reasons.push('Known purchases exceed the workflow budget.');
  return { ok: !reasons.length, reasons, estimatedSpend, unpriced };
}

export interface WorkflowReceipt {
  zeny: number; cost: number; credit: number; items: Map<number, number>; bags: Map<number, number>;
  itemChanges: Map<number, number>; bagChanges: Map<number, number>; strictStock: boolean;
}

export interface Pending extends WorkflowReceipt {
  action: WorldAction; sentAt: number; acknowledged: boolean;
  budget: number;
  storageItemId?: number;
}

export const npcResponses = new Set<WorldEvent['type']>(['npcDialog', 'npcOptions', 'npcEnd', 'npcRefine', 'shopOpened', 'storageOpened', 'barterOpened']);

/** Shared authoritative accounting for workflows and canceled service requests. */
export function confirmWorkflowReceipt(pending: WorkflowReceipt, context: WorkflowContext): boolean {
  if (context.zeny !== pending.zeny - pending.cost + pending.credit) return false;
  const items = stock(context.inventory); const bags = new Map(context.inventory.map(item => [item.bagId,item.count]));
  const itemIds = pending.strictStock ? new Set([...pending.items.keys(), ...items.keys()]) : pending.itemChanges.keys();
  const bagIds = pending.strictStock ? new Set([...pending.bags.keys(), ...bags.keys()]) : pending.bagChanges.keys();
  for (const id of itemIds) if ((items.get(id) ?? 0) !== (pending.items.get(id) ?? 0) + (pending.itemChanges.get(id) ?? 0)) return false;
  for (const id of bagIds) if ((bags.get(id) ?? 0) !== (pending.bags.get(id) ?? 0) + (pending.bagChanges.get(id) ?? 0)) return false;
  return true;
}

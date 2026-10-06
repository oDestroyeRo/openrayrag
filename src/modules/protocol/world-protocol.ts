import { uniqueBy } from 'remeda';
import { actorId } from '../world/actor-identity';
// Source: Rebuild pin 4099e2c000c3c550516760b9c1241595aac9aceb plus deployed V8 evidence in docs/PROTOCOL.md.
// Normal player actions only. Inventory and combat packets have separate owners.
import { BitReader, BitWriter } from '../../shared/binary';
import { readInventory, readItem, type InventoryItem } from './protocol-feature';

export const WORLD_OP = {
  npcTalk: 76, npc: 77, npcAdvance: 78, npcOption: 79,
  shop: 83, storage: 84, barter: 85, storageMove: 86, shopSubmit: 87,
  barterSubmit: 88, cart: 89, partyCreate: 99, partyInvite: 100,
  partyAccept: 101, partyUpdate: 102, vendingStart: 105, vendingStop: 106,
  vendingView: 107, vendingSale: 108, vendingPurchase: 109,
} as const;

export interface ItemRow { id: number; count: number }
export interface PricedRow extends ItemRow { price: number }
export interface ShopEntry { itemId: number; price: number }
export interface BarterOffer {
  item: InventoryItem; count: number; zenyCost: number;
  required: { itemId: number; count: number }[];
}
export interface PartyMember {
  memberId: number; entityId: number; level: number; name: string; leader: boolean;
  map?: string; hp?: number; maxHp?: number; sp?: number; maxSp?: number;
}
export interface VendingEntry { item: InventoryItem; price: number }
export type WorldEvent =
  | { type: 'npcFocus'; id: number; focus: boolean }
  | { type: 'npcDialog'; name: string; text: string; big: boolean }
  | { type: 'npcOptions'; options: string[] }
  | { type: 'npcEnd' }
  | { type: 'npcSprite'; sprite: string; position: number }
  | { type: 'npcRefine' }
  | { type: 'shopOpened'; mode: 'buy' | 'sell'; discountLevel: number; entries: ShopEntry[] }
  | { type: 'storageOpened'; items: InventoryItem[] }
  | { type: 'storageMoved'; item: InventoryItem; change: number; currentWeight: number; storageCount: number; deposit: boolean }
  | { type: 'barterOpened'; offers: BarterOffer[] }
  | { type: 'cartMoved'; direction: 1 | 2; item: InventoryItem; change: number; cartWeight: number; currentWeight: number }
  | { type: 'partyInvite'; partyId: number; name: string; sender: string }
  | { type: 'partyJoined'; partyId: number; name: string; login: boolean; members: PartyMember[] }
  | { type: 'partyMember'; change: 'add' | 'update' | 'login' | 'logout'; member: PartyMember }
  | { type: 'partyRemove'; memberId: number }
  | { type: 'partyLeader'; memberId: number }
  | { type: 'partyLeft'; disbanded: boolean }
  | { type: 'partyMap'; memberId: number; map: string }
  | { type: 'partyHealth'; memberId: number; hp: number; maxHp: number; sp: number; maxSp: number }
  | { type: 'vendingStarted'; name: string; rows: PricedRow[] }
  | { type: 'vendingStopped' }
  | { type: 'vendingViewed'; id: number; name: string; entries: VendingEntry[] }
  | { type: 'vendingSale'; bagId: number; count: number };

export type WorldAction =
  | { type: 'npcTalk'; id: number }
  | { type: 'npcAdvance' }
  | { type: 'npcOption'; index: number }
  | { type: 'shop'; mode: 'buy' | 'sell'; rows: ItemRow[] }
  | { type: 'storage'; operation: 'close' }
  | { type: 'storage'; operation: 'deposit' | 'withdraw'; bagId: number; count: number }
  | { type: 'npcBarter'; choice: number; count: number; bagIds: number[] }
  | { type: 'npcBarterCancel' }
  | { type: 'cart'; direction: 1 | 2; bagId: number; count: number }
  | { type: 'partyCreate'; name: string; inviteId?: number }
  | { type: 'partyInviteId'; id: number }
  | { type: 'partyInviteName'; name: string }
  | { type: 'partyAccept'; partyId: number }
  | { type: 'partyLeave' }
  | { type: 'partyLeader' | 'partyRemove'; memberId: number }
  | { type: 'partyDisband' }
  | { type: 'vendingStart'; name: string; rows: PricedRow[] }
  | { type: 'vendingStop' }
  | { type: 'vendingView'; id: number }
  | { type: 'vendingPurchase'; rows: ItemRow[] };

function bounded(value: number, min: number, max: number, label = 'value'): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${label}`);
  return value;
}
function id(value: number): number { return bounded(value, 1, 2_147_483_647, 'ID'); }
function amount(value: number): number { return bounded(value, 0, 2_147_483_647, 'amount'); }
function mapCode(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Invalid map');
  return value;
}
function health(hp: number, maxHp: number): void {
  amount(hp); amount(maxHp);
  if (hp > maxHp) throw new Error('Invalid party health');
}
function itemType(r: BitReader): 1 | 2 {
  const value = r.u8();
  if (value !== 1 && value !== 2) throw new Error('Unknown item type');
  return value;
}
function member(r: BitReader): PartyMember {
  const value: PartyMember = {
    memberId: id(r.i32()), entityId: bounded(r.i32(), -1, 2_147_483_647, 'entity ID'),
    level: bounded(r.i16(), -1, 999, 'level'), name: r.string(128), leader: r.u8() === 1,
  };
  // Persisted offline members have entityId=0 and unknown level=-1. A logged
  // out member can retain its known level; a live member must have a real one.
  if (value.level < 1 && !(value.entityId <= 0 && value.level === -1)) throw new Error('Invalid party level');
  if (value.entityId > 0) {
    // LogMemberIn can run before InitialSpawn assigns the member's map.
    const map = r.string(64); if (map) value.map = mapCode(map);
    value.hp = r.i32(); value.maxHp = r.i32();
    value.sp = r.i32(); value.maxSp = r.i32();
    health(value.hp, value.maxHp); health(value.sp, value.maxSp);
  }
  return value;
}

export function decodeWorld(data: Uint8Array): WorldEvent[] | null {
  const r = new BitReader(data); const opcode = r.u8();
  let event: WorldEvent;
  switch (opcode) {
    case WORLD_OP.npc: {
      switch (r.u8()) {
        case 0: event = { type: 'npcFocus', id: actorId(r.i32()), focus: r.bool() }; break;
        case 1: event = { type: 'npcDialog', name: r.string(256), text: r.string(), big: r.bool() }; break;
        case 2: {
          const count = bounded(r.i32(), 0, 32, 'option count');
          event = { type: 'npcOptions', options: Array.from({ length: count }, () => r.string(1024)) }; break;
        }
        case 3: event = { type: 'npcEnd' }; break;
        case 4: event = { type: 'npcSprite', sprite: r.string(256), position: r.u8() }; break;
        case 5: event = { type: 'npcRefine' }; break;
        // The pinned client has no decoder for subtype 6/7. Do not guess layouts.
        default: return null;
      }
      break;
    }
    case WORLD_OP.shop: {
      const kind = r.u8();
      // CommandBuilder writes a byte for buy Discount, but an int32 for sell
      // Overcharge. The official client reader alone misses this asymmetry.
      const discountLevel = kind === 0 ? bounded(r.i32(), 0, 255, 'overcharge level') : r.u8();
      const count = kind === 0 ? 0 : bounded(r.i32(), 0, 600, 'shop count');
      const entries = Array.from({ length: count }, () => ({ itemId: id(r.i32()), price: amount(r.i32()) }));
      if (uniqueBy(entries, e => e.itemId).length !== entries.length) throw new Error('Duplicate shop item');
      event = { type: 'shopOpened', mode: kind === 0 ? 'sell' : 'buy', discountLevel, entries }; break;
    }
    case WORLD_OP.storage: event = { type: 'storageOpened', items: readInventory(r) }; break;
    case WORLD_OP.storageMove: {
      const type = itemType(r); const bagId = id(r.i32()); const change = bounded(r.i16(), 1, 32767, 'storage count');
      const item = readItem(r, type, bagId); const currentWeight = amount(r.i32());
      const storageCount = bounded(r.i32(), 0, 32767, 'stored count');
      event = { type: 'storageMoved', item, change, currentWeight, storageCount, deposit: r.bool() }; break;
    }
    case WORLD_OP.barter: {
      const count = bounded(r.u8(), 0, 64, 'trade count');
      const offers = Array.from({ length: count }, (): BarterOffer => {
        const item = readItem(r, itemType(r), -1); const outputCount = bounded(r.i32(), 1, 32767, 'output count');
        const zenyCost = amount(r.i32()); const requiredCount = bounded(r.i32(), 0, 100, 'required count');
        const required = Array.from({ length: requiredCount }, () => ({ itemId: id(r.i32()), count: bounded(r.i16(), 1, 32767, 'required count') }));
        return { item, count: outputCount, zenyCost, required };
      });
      event = { type: 'barterOpened', offers }; break;
    }
    case WORLD_OP.cart: {
      const direction = r.u8();
      if (direction !== 1 && direction !== 2) throw new Error('Unsupported cart direction');
      const bagId = id(r.i32()); const item = readItem(r, itemType(r), bagId);
      event = { type: 'cartMoved', direction, item, change: bounded(r.i16(), 1, 32767, 'cart count'), cartWeight: amount(r.i32()), currentWeight: amount(r.i32()) }; break;
    }
    case WORLD_OP.partyInvite:
      event = { type: 'partyInvite', partyId: id(r.i32()), name: r.string(128), sender: r.string(128) }; break;
    case WORLD_OP.partyAccept: {
      const login = r.u8() === 1; const partyId = id(r.i32()); const name = r.string(128);
      // The deployed V8 client reads an additional byte after PartyName. Its
      // meaning is unverified; consume it without assigning settings semantics.
      r.u8();
      // Party.SerializePartyInfo writes the whole roster without a capacity cap.
      // Even an offline row needs 13 bytes: two IDs, level, string length, leader.
      const count = bounded(r.i32(), 1, Math.floor(r.remainingBits / (13 * 8)), 'party count');
      const members = Array.from({ length: count }, () => member(r));
      if (uniqueBy(members, m => m.memberId).length !== count) throw new Error('Duplicate party member');
      // Live deployed snapshots can include eight unread bytes after the roster.
      // The official V8 reader ignores them; accept only this observed width and
      // keep their meaning opaque. Other trailers still fail in finish().
      if (r.remainingBits === 8 * 8) r.take(8);
      event = { type: 'partyJoined', partyId, name, login, members }; break;
    }
    case WORLD_OP.partyUpdate: {
      switch (r.u8()) {
        case 0: event = { type: 'partyMember', change: 'add', member: member(r) }; break;
        case 1: event = { type: 'partyRemove', memberId: id(r.i32()) }; break;
        case 2: {
          const value = member(r);
          // Deployed V8 subtype 2 can append four bytes that its official
          // reader ignores. Keep their meaning opaque and other widths strict.
          if (r.remainingBits === 4 * 8) r.take(4);
          event = { type: 'partyMember', change: 'update', member: value }; break;
        }
        case 3: event = { type: 'partyMember', change: 'login', member: member(r) }; break;
        case 4: event = { type: 'partyMember', change: 'logout', member: member(r) }; break;
        case 5: event = { type: 'partyLeader', memberId: id(r.i32()) }; break;
        case 6: event = { type: 'partyLeft', disbanded: false }; break;
        case 7: event = { type: 'partyLeft', disbanded: true }; break;
        case 8: {
          const memberId = id(r.i32()); const hp = r.i32(); const maxHp = r.i32(); const sp = r.i32(); const maxSp = r.i32();
          health(hp, maxHp); health(sp, maxSp); event = { type: 'partyHealth', memberId, hp, maxHp, sp, maxSp }; break;
        }
        case 9: event = { type: 'partyMap', memberId: id(r.i32()), map: mapCode(r.string(64)) }; break;
        default: return null;
      }
      break;
    }
    case WORLD_OP.vendingStart: {
      const name = r.string(128); const count = bounded(r.i32(), 1, 32, 'vending count');
      const rows = Array.from({ length: count }, () => ({ id: id(r.i32()), count: bounded(r.i32(), 1, 32767, 'vending count'), price: bounded(r.i32(), 0, 9_999_999, 'price') }));
      if (uniqueBy(rows, row => row.id).length !== count) throw new Error('Duplicate vending row');
      event = { type: 'vendingStarted', name, rows }; break;
    }
    case WORLD_OP.vendingStop: event = { type: 'vendingStopped' }; break;
    case WORLD_OP.vendingView: {
      const vendorId = actorId(r.i32()); const name = r.string(128); const count = bounded(r.i32(), 0, 32, 'vending count');
      const entries = Array.from({ length: count }, (): VendingEntry => {
        const bagId = id(r.i32()); const item = readItem(r, itemType(r), bagId); const price = bounded(r.i32(), 0, 9_999_999, 'price');
        return { item, price };
      });
      if (uniqueBy(entries, e => e.item.bagId).length !== count) throw new Error('Duplicate vending item');
      event = { type: 'vendingViewed', id: vendorId, name, entries }; break;
    }
    case WORLD_OP.vendingSale: event = { type: 'vendingSale', bagId: id(r.i32()), count: bounded(r.i32(), 1, 32767, 'sale count') }; break;
    default: return null;
  }
  r.finish(); return [event];
}

function object(input: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof input !== 'object' || input === null || Array.isArray(input)
    || Object.keys(input).some(key => !keys.includes(key))) throw new Error('Invalid action fields');
  return input as Record<string, unknown>;
}
function number(input: unknown, min = 1, max = 2_147_483_647): number {
  if (typeof input !== 'number') throw new Error('Invalid action number');
  return bounded(input, min, max);
}
function name(input: unknown): string {
  if (typeof input !== 'string' || !input.trim() || input.length > 32 || /[\u0000-\u001f\u007f]/.test(input)) throw new Error('Invalid name');
  return input;
}
function rows(input: unknown, max: number, priced = false): ItemRow[] | PricedRow[] {
  if (!Array.isArray(input) || input.length > max) throw new Error('Invalid rows');
  const value = input.map(item => {
    const row = object(item, priced ? ['id', 'count', 'price'] : ['id', 'count']);
    const entry = { id: number(row.id), count: number(row.count, 1, 32767) };
    return priced ? { ...entry, price: number(row.price, 0, 9_999_999) } : entry;
  });
  if (new Set(value.map(row => row.id)).size !== value.length) throw new Error('Duplicate rows');
  return value;
}

export function validateWorldAction(input: unknown): WorldAction {
  const value = object(input, ['type', 'id', 'index', 'mode', 'rows', 'operation', 'bagId', 'count', 'choice', 'bagIds', 'direction', 'name', 'inviteId', 'partyId', 'memberId']);
  const exact = (keys: string[]) => object(value, ['type', ...keys]);
  switch (value.type) {
    case 'npcTalk': case 'partyInviteId': case 'vendingView': exact(['id']); return { type: value.type, id: number(value.id,0) };
    case 'npcAdvance': case 'npcBarterCancel': case 'partyLeave': case 'partyDisband': case 'vendingStop': exact([]); return { type: value.type };
    case 'npcOption': exact(['index']); return { type: value.type, index: number(value.index, 0, 31) };
    case 'shop': {
      exact(['mode', 'rows']);
      if (value.mode !== 'buy' && value.mode !== 'sell') throw new Error('Invalid shop mode');
      return { type: 'shop', mode: value.mode, rows: rows(value.rows, value.mode === 'buy' ? 20 : 200) };
    }
    case 'storage': {
      if (value.operation === 'close') { exact(['operation']); return { type: 'storage', operation: 'close' }; }
      exact(['operation', 'bagId', 'count']);
      if (value.operation !== 'deposit' && value.operation !== 'withdraw') throw new Error('Invalid storage operation');
      return { type: 'storage', operation: value.operation, bagId: number(value.bagId), count: number(value.count, 1, 32767) };
    }
    case 'npcBarter': {
      exact(['choice', 'count', 'bagIds']);
      if (!Array.isArray(value.bagIds) || value.bagIds.length > 10) throw new Error('Invalid trade bags');
      const bagIds = value.bagIds.map(bag => number(bag));
      if (new Set(bagIds).size !== bagIds.length) throw new Error('Duplicate trade bags');
      return { type: 'npcBarter', choice: number(value.choice, 0, 63), count: number(value.count, 1, 99), bagIds };
    }
    case 'cart': {
      exact(['direction', 'bagId', 'count']);
      if (value.direction !== 1 && value.direction !== 2) throw new Error('Unsupported cart direction');
      return { type: 'cart', direction: value.direction, bagId: number(value.bagId), count: number(value.count, 1, 32767) };
    }
    case 'partyCreate': {
      exact(['name', 'inviteId']);
      return { type: 'partyCreate', name: name(value.name), ...(value.inviteId === undefined ? {} : { inviteId: number(value.inviteId) }) };
    }
    case 'partyInviteName': exact(['name']); return { type: 'partyInviteName', name: name(value.name) };
    case 'partyAccept': exact(['partyId']); return { type: 'partyAccept', partyId: number(value.partyId) };
    case 'partyLeader': case 'partyRemove': exact(['memberId']); return { type: value.type, memberId: number(value.memberId) };
    case 'vendingStart': {
      exact(['name', 'rows']); const entries = rows(value.rows, 32, true) as PricedRow[];
      if (!entries.length) throw new Error('Empty vending shop');
      return { type: 'vendingStart', name: name(value.name), rows: entries };
    }
    case 'vendingPurchase': exact(['rows']); return { type: 'vendingPurchase', rows: rows(value.rows, 32) };
    default: throw new Error('Unknown world action');
  }
}

export function worldCommand(input: WorldAction): Uint8Array {
  const action = validateWorldAction(input); const w = new BitWriter();
  const writeRows = (entries: ItemRow[]) => { w.i32(entries.length); for (const row of entries) w.i32(row.id).i32(row.count); };
  switch (action.type) {
    case 'npcTalk': w.u8(WORLD_OP.npcTalk).i32(action.id); break;
    case 'npcAdvance': w.u8(WORLD_OP.npcAdvance); break;
    case 'npcOption': w.u8(WORLD_OP.npcOption).i32(action.index); break;
    case 'shop': w.u8(WORLD_OP.shopSubmit); writeRows(action.rows); break;
    case 'storage':
      w.u8(WORLD_OP.storageMove).u8(action.operation === 'close' ? 0 : action.operation === 'deposit' ? 1 : 2);
      if (action.operation !== 'close') w.i32(action.bagId).i32(action.count); break;
    case 'npcBarter':
      w.u8(WORLD_OP.barterSubmit).i32(action.choice).i32(action.count).i32(action.bagIds.length);
      for (const bagId of action.bagIds) w.i32(bagId); break;
    case 'npcBarterCancel': w.u8(WORLD_OP.barterSubmit).i32(-1); break;
    case 'cart': w.u8(WORLD_OP.cart).i32(action.bagId).i16(action.count).u8(action.direction); break;
    case 'partyCreate': w.u8(WORLD_OP.partyCreate).string(action.name).i32(action.inviteId ?? -1); break;
    case 'partyInviteId': w.u8(WORLD_OP.partyInvite).u8(0).i32(action.id); break;
    case 'partyInviteName': w.u8(WORLD_OP.partyInvite).u8(1).string(action.name); break;
    case 'partyAccept': w.u8(WORLD_OP.partyAccept).i32(action.partyId); break;
    case 'partyLeave': w.u8(WORLD_OP.partyUpdate).u8(0); break;
    case 'partyLeader': w.u8(WORLD_OP.partyUpdate).u8(1).i32(action.memberId); break;
    case 'partyRemove': w.u8(WORLD_OP.partyUpdate).u8(2).i32(action.memberId); break;
    case 'partyDisband': w.u8(WORLD_OP.partyUpdate).u8(3).i32(-1); break;
    case 'vendingStart':
      w.u8(WORLD_OP.vendingStart).string(action.name).i32(action.rows.length);
      for (const row of action.rows) w.i32(row.id).i32(row.count).i32(row.price); break;
    case 'vendingStop': w.u8(WORLD_OP.vendingStop); break;
    case 'vendingView': w.u8(WORLD_OP.vendingView).i32(action.id); break;
    case 'vendingPurchase': w.u8(WORLD_OP.vendingPurchase); writeRows(action.rows); break;
  }
  return w.finish();
}

import { map } from 'remeda';
import type { InventoryItem } from '../protocol/protocol-feature';
import type { BarterOffer, PartyMember, PricedRow, ShopEntry, VendingEntry } from '../protocol/world-protocol';
export type NpcMode = 'idle' | 'dialog' | 'options' | 'shop' | 'storage' | 'barter' | 'refine' | 'vending';

export interface WorldSnapshot {
  map: string; generation: number; revision: number;
  npc: { id: number | null; mode: NpcMode; dialog: { name: string; text: string; big: boolean } | null; options: string[] };
  shop: { mode: 'buy' | 'sell'; discountLevel: number; entries: ShopEntry[] } | null;
  storage: InventoryItem[]; storageReady: boolean;
  barter: BarterOffer[]; cart: InventoryItem[]; hasCart: boolean; cartReady: boolean;
  party: { id: number; name: string; members: PartyMember[] } | null;
  invite: { partyId: number; name: string; sender: string } | null;
  vending: { name: string; rows: PricedRow[] } | null;
  viewedVending: { id: number; name: string; entries: VendingEntry[] } | null;
}

export function cloneItem(item: InventoryItem): InventoryItem { return { ...item, ...(item.slots ? { slots: [...item.slots] } : {}) }; }

export function cloneOffer(offer: BarterOffer): BarterOffer { return { ...offer, item: cloneItem(offer.item), required: map(offer.required, item => ({ ...item })) }; }

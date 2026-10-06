import { map } from 'remeda';
import { PartyActorBindings } from './party-actors';
import type { ActorObservations } from './actor-observations';
import type { InventoryItem } from './protocol-feature';
import type { BarterOffer, PartyMember, WorldEvent } from './world-protocol';

import { type NpcMode, type WorldSnapshot, cloneItem, cloneOffer } from './world-state-logic';

export { type NpcMode, type WorldSnapshot } from './world-state-logic';

/** Server-owned world state. Sending a request never changes inventory or money. */
export class WorldState {
  readonly partyActors = new PartyActorBindings();
  map = ''; generation = 0; revision = 0;
  npc: WorldSnapshot['npc'] = { id: null, mode: 'idle', dialog: null, options: [] };
  shop: WorldSnapshot['shop'] = null;
  readonly storage = new Map<number, InventoryItem>();
  storageReady = false;
  barter: BarterOffer[] = [];
  readonly cart = new Map<number, InventoryItem>();
  hasCart = false; cartReady = false;
  party: { id: number; name: string; members: Map<number, PartyMember> } | null = null;
  invite: WorldSnapshot['invite'] = null;
  vending: WorldSnapshot['vending'] = null;
  viewedVending: WorldSnapshot['viewedVending'] = null;

  reset(map = '', preservePersistent = false): void {
    this.partyActors.clear();
    this.map = map; this.generation++; this.revision++;
    this.endInteraction(); this.viewedVending = null; this.vending = null;
    if (!preservePersistent) {
      this.party = null; this.invite = null;
      this.cart.clear(); this.hasCart = false; this.cartReady = false;
    }
  }

  replaceCart(items: InventoryItem[] | undefined): void {
    // Cart data is optional in ordinary inventory refreshes. Omission is not
    // evidence that a previously observed cart was removed.
    if (items === undefined) return;
    this.cart.clear(); this.hasCart = true; this.cartReady = items.length <= 100;
    if (!this.cartReady) { this.revision++; return; }
    for (const item of items) this.cart.set(item.bagId, cloneItem(item));
    this.revision++;
  }

  private endInteraction(): void {
    this.npc = { id: null, mode: 'idle', dialog: null, options: [] };
    this.shop = null; this.storage.clear(); this.storageReady = false; this.barter = [];
  }

  private mode(mode: NpcMode): void {
    this.npc.mode = mode; this.npc.options = [];
    if (mode !== 'dialog') this.npc.dialog = null;
    if (mode !== 'shop') this.shop = null;
    if (mode !== 'storage') { this.storage.clear(); this.storageReady = false; }
    if (mode !== 'barter') this.barter = [];
  }

  /** Mutate the roster and its owned actor evidence as one observation. The
   * roster observer sees detached prior rows and the new roster before bindings
   * refresh, so follow evidence retains its original packet ordering. */
  observe(event: WorldEvent, observations: ActorObservations, playerId: number | null = null,
    observeRoster?: (before: WorldState['party']) => void): void {
    const before = observeRoster && this.party
      ? { ...this.party, members: new Map([...this.party.members].map(([id, member]) => [id, { ...member }])) }
      : null;
    this.apply(event, playerId);
    observeRoster?.(before);
    this.partyActors.observe(event, this.party, this.map, observations, playerId);
  }

  /** Reconcile retained rows with current actor lifetimes without renewing row evidence. */
  refreshPartyActors(observations: ActorObservations, playerId: number | null = null): void {
    this.partyActors.sync(this.party, this.map, observations, playerId);
  }

  apply(event: WorldEvent, playerId: number | null = null): void {
    this.revision++;
    switch (event.type) {
      case 'npcFocus':
        if (event.focus) {
          if (this.npc.id !== event.id) this.endInteraction();
          this.npc.id = event.id;
        }
        break;
      case 'npcDialog': this.mode('dialog'); this.npc.dialog = { name: event.name, text: event.text, big: event.big }; break;
      case 'npcOptions': this.mode('options'); this.npc.options = [...event.options]; break;
      case 'npcEnd': this.endInteraction(); this.viewedVending = null; break;
      case 'npcSprite': break;
      case 'npcRefine': this.mode('refine'); break;
      case 'shopOpened':
        this.mode('shop'); this.shop = { mode: event.mode, discountLevel: event.discountLevel, entries: event.entries.map(item => ({ ...item })) }; break;
      case 'storageOpened':
        this.mode('storage'); this.storage.clear(); this.storageReady = true;
        for (const item of event.items) this.storage.set(item.bagId, cloneItem(item)); break;
      case 'storageMoved':
        // Inventory changes arrive separately. Mutating it here would apply each transfer twice.
        if (this.npc.mode !== 'storage' || !this.storageReady) break;
        if (event.deposit) {
          if (this.storage.size >= 600 && !this.storage.has(event.item.bagId)) { this.storageReady = false; break; }
          this.storage.set(event.item.bagId, cloneItem(event.item));
        }
        else this.remove(this.storage, event.item.bagId, event.change, 'storage');
        break;
      case 'barterOpened': this.mode('barter'); this.barter = event.offers.map(cloneOffer); break;
      case 'cartMoved':
        if (!this.hasCart || !this.cartReady) break;
        if (event.direction === 1) {
          if (this.cart.size >= 100 && !this.cart.has(event.item.bagId)) { this.cartReady = false; break; }
          this.cart.set(event.item.bagId, cloneItem(event.item));
        }
        else this.remove(this.cart, event.item.bagId, event.change, 'cart');
        break;
      case 'partyInvite': this.invite = { partyId: event.partyId, name: event.name, sender: event.sender }; break;
      case 'partyJoined':
        this.party = { id: event.partyId, name: event.name, members: new Map(event.members.map(member => [member.memberId, { ...member }])) };
        this.invite = null; break;
      case 'partyMember':
        if (this.party && (this.party.members.size < 32 || this.party.members.has(event.member.memberId))) this.party.members.set(event.member.memberId, { ...event.member }); break;
      case 'partyRemove':
        if (playerId!==null&&playerId>=0&&this.party?.members.get(event.memberId)?.entityId === playerId) this.party = null;
        else this.party?.members.delete(event.memberId); break;
      case 'partyLeader':
        if (this.party) for (const member of this.party.members.values()) member.leader = member.memberId === event.memberId;
        break;
      case 'partyLeft': this.party = null; break;
      case 'partyMap': {
        const member = this.party?.members.get(event.memberId); if (member) member.map = event.map; break;
      }
      case 'partyHealth': {
        const member = this.party?.members.get(event.memberId);
        if (member) { member.hp = event.hp; member.maxHp = event.maxHp; member.sp = event.sp; member.maxSp = event.maxSp; }
        break;
      }
      case 'vendingStarted': this.mode('vending'); this.vending = { name: event.name, rows: event.rows.map(row => ({ ...row })) }; break;
      case 'vendingStopped': this.vending = null; this.endInteraction(); break;
      case 'vendingViewed': this.mode('vending'); this.viewedVending = { id: event.id, name: event.name, entries: event.entries.map(entry => ({ item: cloneItem(entry.item), price: entry.price })) }; break;
      case 'vendingSale': {
        const row = this.vending?.rows.find(row => row.id === event.bagId);
        if (row) row.count = Math.max(0, row.count - event.count);
        if (this.hasCart && this.cartReady) this.remove(this.cart, event.bagId, event.count, 'cart');
        break;
      }
    }
  }

  private remove(items: Map<number, InventoryItem>, bagId: number, count: number, owner: 'cart' | 'storage'): void {
    const item = items.get(bagId);
    if (!item || item.count < count) {
      // A missing snapshot cannot safely be reconstructed from a partial delta.
      if (owner === 'cart') this.cartReady = false; else this.storageReady = false;
      return;
    }
    if (item.count === count) items.delete(bagId); else items.set(bagId, { ...item, count: item.count - count });
  }

  snapshot(): WorldSnapshot {
    return {
      map: this.map, generation: this.generation, revision: this.revision,
      npc: { ...this.npc, dialog: this.npc.dialog ? { ...this.npc.dialog } : null, options: [...this.npc.options] },
      shop: this.shop ? { ...this.shop, entries: map(this.shop.entries, item => ({ ...item })) } : null,
      storage: map([...this.storage.values()], cloneItem), storageReady: this.storageReady,
      barter: map(this.barter, cloneOffer), cart: map([...this.cart.values()], cloneItem), hasCart: this.hasCart, cartReady: this.cartReady,
      party: this.party ? { id: this.party.id, name: this.party.name, members: map([...this.party.members.values()], member => ({ ...member })) } : null,
      invite: this.invite ? { ...this.invite } : null,
      vending: this.vending ? { ...this.vending, rows: map(this.vending.rows, row => ({ ...row })) } : null,
      viewedVending: this.viewedVending ? { ...this.viewedVending, entries: map(this.viewedVending.entries, entry => ({ item: cloneItem(entry.item), price: entry.price })) } : null,
    };
  }
}

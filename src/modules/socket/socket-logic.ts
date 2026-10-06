import { itemId, quantity, regularItemBagId, type BagId, type ItemId, type Quantity, type Revision, type Milliseconds } from '../../shared/domain-values';
import { sort } from 'remeda';
import { inventoryItemDraft, type DomainInventoryItem } from '../world/character-state-logic';
import catalog from '../../data/socket-catalog.json';
import type { InventoryItemInput as InventoryItem } from '../protocol/protocol-feature';
import type { SocketSelection, SocketSelectionInput } from './socket-protocol';
export interface SocketMetadata { code:string; name:string; itemClass:number; mask:number; capacity:number }

export const SOCKET_METADATA: Readonly<Record<string,SocketMetadata>> = catalog.items;

export interface SocketContext {
  ready:boolean; settled:boolean; character:string; identity:string; connection:Revision<'connection'>; map:string;
  readbackKey:string|null;
  inventoryKnown:boolean; equipmentKnown:boolean; inventoryRevision:Revision<'inventory'>; equipmentRevision:Revision<'equipment'>;
  inventory:ReadonlyMap<BagId,DomainInventoryItem>; equipment:readonly number[]; ammoId:number;
  floors:ReadonlyMap<ItemId,Quantity>;
}

export interface SocketTarget { readonly bagId:BagId;readonly itemId:ItemId;readonly name:string;readonly refine:number;readonly slots:readonly (ItemId|0)[];readonly capacity:number }

export interface SocketCard { readonly bagId:BagId;readonly itemId:ItemId;readonly name:string;readonly count:Quantity;readonly reserve:Quantity }

export interface SocketPlan extends SocketSelection {
  previewToken:string; target:SocketTarget; card:SocketCard; slot:number; cost:1;
}

export type SocketTargetSnapshot = Omit<SocketTarget,'bagId'|'itemId'|'slots'> & {bagId:number;itemId:number;slots:readonly number[]};
export type SocketCardSnapshot = Omit<SocketCard,'bagId'|'itemId'|'count'|'reserve'> & {bagId:number;itemId:number;count:number;reserve:number};
export interface SocketPreview extends SocketSelectionInput {previewToken:string;target:SocketTargetSnapshot;card:SocketCardSnapshot;slot:number;cost:1}
export interface SocketSnapshot {
  state:'idle'|'preview'|'pending'|'confirmed'|'uncertain'|'reconciled'; pending:boolean; reason:string;
  targets:SocketTargetSnapshot[]; cards:SocketCardSnapshot[]; preview:SocketPreview|null;
}

export const clone=inventoryItemDraft;

const itemKey=(i:InventoryItem):string=>JSON.stringify([i.bagId,i.itemId,i.type,i.count,i.flags??null,i.refine??null,i.guid??null,i.slots??null]);

export const same=(a:InventoryItem|undefined,b:InventoryItem|undefined):boolean=>!a&&!b||!!a&&!!b&&itemKey(a)===itemKey(b);

export const guid=(i:InventoryItem):boolean=>typeof i.guid==='string'&&/^[a-f0-9]{32}$/.test(i.guid)&&i.guid!=='0'.repeat(32);

function unique(i:InventoryItem):boolean {
  return i.type===2&&i.count===1&&guid(i)&&Number.isInteger(i.flags)&&Number(i.flags)>=0&&Number(i.flags)<=255
    &&Number.isInteger(i.refine)&&Number(i.refine)>=0&&Number(i.refine)<=255&&Array.isArray(i.slots)&&i.slots.length===4
    &&i.slots.every(v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647);
}

export function target(i:DomainInventoryItem,c:SocketContext):SocketTarget|null {
  const m=SOCKET_METADATA[i.itemId];
  if(!m||![2,3].includes(m.itemClass)||m.capacity<1||m.capacity>4||!unique(i)||(i.flags!&1)!==0
    ||c.equipment.includes(i.bagId)||c.ammoId===i.bagId||i.slots!.slice(m.capacity).some(v=>v!==0)
    ||i.slots!.some(v=>v!==0&&(SOCKET_METADATA[v]?.itemClass!==5||(SOCKET_METADATA[v]!.mask&m.mask)===0))
    ||!i.slots!.slice(0,m.capacity).includes(0))return null;
  return {bagId:i.bagId,itemId:i.itemId,name:m.name,refine:i.refine!,slots:i.slots!.map(value=>value===0?0:itemId(value)),capacity:m.capacity};
}

export function card(i:DomainInventoryItem,c:SocketContext,enforceReserve=true):SocketCard|null {
  const m=SOCKET_METADATA[i.itemId],reserve=c.floors.get(i.itemId)??quantity(0);
  return m?.itemClass===5&&i.type===1&&i.bagId===regularItemBagId(i.itemId)&&i.count>0&&(!enforceReserve||i.count>reserve)
    ?{bagId:i.bagId,itemId:i.itemId,name:m.name,count:i.count,reserve}:null;
}

export function candidates(c:SocketContext):Pick<SocketSnapshot,'targets'|'cards'> {
  if(!c.inventoryKnown||!c.equipmentKnown||c.inventory.size>200)return {targets:[],cards:[]};
  const targets:SocketTarget[]=[],cards:SocketCard[]=[];
  for(const i of c.inventory.values()){const t=target(i,c),s=card(i,c,false);if(t)targets.push(t);if(s)cards.push(s);}
  return {targets,cards};
}

export function requireContext(c:SocketContext):void {
  if(!c.ready||!c.settled||!c.character||!c.identity||!c.map)throw new Error('Enter a fresh living character, stop automation and settle every action first.');
  if(!c.inventoryKnown||!c.equipmentKnown||c.inventory.size>200)throw new Error('Wait for authoritative inventory and equipment.');
}

export interface Prepared { view:SocketPlan; target:DomainInventoryItem; card:DomainInventoryItem; context:string; reserve:Quantity; fingerprint:string }

export interface Receipt { prepared:Prepared; inventory:Map<BagId,DomainInventoryItem>; equipment:number[]; ammoId:number;
  character:string; identity:string; connection:Revision<'connection'>; map:string; deadline:Milliseconds; cardSeen:boolean; targetSeen:boolean; canceled:boolean; dirty:boolean;
  fresh?:{key:string;connection:Revision<'connection'>;inventoryRevision:Revision<'inventory'>;equipmentRevision:Revision<'equipment'>} }

export const binding=(c:SocketContext):string=>JSON.stringify([c.character,c.identity,c.connection,c.map,c.inventoryRevision,c.equipmentRevision,sort([...c.floors], ([a],[b])=>a-b)]);

import catalog from './data/socket-catalog.json';
import type { GameEvent } from './protocol';
import type { InventoryItem } from './protocol-feature';
import { validateSocketRequest, validateSocketSelection, type SocketAction, type SocketSelection } from './socket-protocol';

export interface SocketMetadata { code:string; name:string; itemClass:number; mask:number; capacity:number }
export const SOCKET_METADATA: Readonly<Record<string,SocketMetadata>> = catalog.items;
export interface SocketContext {
  ready:boolean; settled:boolean; character:string; identity:string; connection:number; map:string;
  readbackKey:string|null;
  inventoryKnown:boolean; equipmentKnown:boolean; inventoryRevision:number; equipmentRevision:number;
  inventory:ReadonlyMap<number,InventoryItem>; equipment:readonly number[]; ammoId:number;
  floors:ReadonlyMap<number,number>;
}
export interface SocketTarget { bagId:number; itemId:number; name:string; refine:number; slots:number[]; capacity:number }
export interface SocketCard { bagId:number; itemId:number; name:string; count:number; reserve:number }
export interface SocketPreview extends SocketSelection {
  previewToken:string; target:SocketTarget; card:SocketCard; slot:number; cost:1;
}
export interface SocketSnapshot {
  state:'idle'|'preview'|'pending'|'confirmed'|'uncertain'|'reconciled'; pending:boolean; reason:string;
  targets:SocketTarget[]; cards:SocketCard[]; preview:SocketPreview|null;
}
const clone=(i:InventoryItem):InventoryItem=>({...i,...(i.slots?{slots:i.slots.slice()}: {})});
const itemKey=(i:InventoryItem):string=>JSON.stringify([i.bagId,i.itemId,i.type,i.count,i.flags??null,i.refine??null,i.guid??null,i.slots??null]);
const same=(a:InventoryItem|undefined,b:InventoryItem|undefined):boolean=>!a&&!b||!!a&&!!b&&itemKey(a)===itemKey(b);
const guid=(i:InventoryItem):boolean=>typeof i.guid==='string'&&/^[a-f0-9]{32}$/.test(i.guid)&&i.guid!=='0'.repeat(32);
function unique(i:InventoryItem):boolean {
  return i.type===2&&i.count===1&&guid(i)&&Number.isInteger(i.flags)&&Number(i.flags)>=0&&Number(i.flags)<=255
    &&Number.isInteger(i.refine)&&Number(i.refine)>=0&&Number(i.refine)<=255&&Array.isArray(i.slots)&&i.slots.length===4
    &&i.slots.every(v=>Number.isSafeInteger(v)&&v>=0&&v<=2147483647);
}
function target(i:InventoryItem,c:SocketContext):SocketTarget|null {
  const m=SOCKET_METADATA[i.itemId];
  if(!m||![2,3].includes(m.itemClass)||m.capacity<1||m.capacity>4||!unique(i)||(i.flags!&1)!==0
    ||c.equipment.includes(i.bagId)||c.ammoId===i.bagId||i.slots!.slice(m.capacity).some(v=>v!==0)
    ||i.slots!.some(v=>v!==0&&(SOCKET_METADATA[v]?.itemClass!==5||(SOCKET_METADATA[v]!.mask&m.mask)===0))
    ||!i.slots!.slice(0,m.capacity).includes(0))return null;
  return {bagId:i.bagId,itemId:i.itemId,name:m.name,refine:i.refine!,slots:i.slots!.slice(),capacity:m.capacity};
}
function card(i:InventoryItem,c:SocketContext,enforceReserve=true):SocketCard|null {
  const m=SOCKET_METADATA[i.itemId],reserve=c.floors.get(i.itemId)??0;
  return m?.itemClass===5&&i.type===1&&i.bagId===i.itemId&&i.count>0&&(!enforceReserve||i.count>reserve)
    ?{bagId:i.bagId,itemId:i.itemId,name:m.name,count:i.count,reserve}:null;
}
function candidates(c:SocketContext):Pick<SocketSnapshot,'targets'|'cards'> {
  if(!c.inventoryKnown||!c.equipmentKnown||c.inventory.size>200)return {targets:[],cards:[]};
  const targets:SocketTarget[]=[],cards:SocketCard[]=[];
  for(const i of c.inventory.values()){const t=target(i,c),s=card(i,c,false);if(t)targets.push(t);if(s)cards.push(s);}
  return {targets,cards};
}
function requireContext(c:SocketContext):void {
  if(!c.ready||!c.settled||!c.character||!c.identity||!c.map)throw new Error('Enter a fresh living character, stop automation and settle every action first.');
  if(!c.inventoryKnown||!c.equipmentKnown||c.inventory.size>200)throw new Error('Wait for authoritative inventory and equipment.');
}
interface Prepared { view:SocketPreview; target:InventoryItem; card:InventoryItem; context:string; reserve:number; fingerprint:string }
interface Receipt { prepared:Prepared; inventory:Map<number,InventoryItem>; equipment:number[]; ammoId:number;
  character:string; identity:string; connection:number; map:string; deadline:number; cardSeen:boolean; targetSeen:boolean; canceled:boolean; dirty:boolean;
  fresh?:{key:string;connection:number;inventoryRevision:number;equipmentRevision:number} }
const binding=(c:SocketContext):string=>JSON.stringify([c.character,c.identity,c.connection,c.map,c.inventoryRevision,c.equipmentRevision,[...c.floors].sort(([a],[b])=>a-b)]);

/** Private transient proof over CharacterState; this owner never sends from tick/observe. */
export class ManualSocket {
  private prepared:Prepared|null=null; private receipt:Receipt|null=null;
  private state:SocketSnapshot['state']='idle'; private reason='Preview one card on unequipped gear. Socketing is irreversible.';
  private readonly attempted=new Set<string>();
  constructor(private readonly send:(action:SocketAction)=>void,private readonly now=Date.now,
    private readonly token=()=>crypto.randomUUID().replaceAll('-','')){}
  get busy():boolean{return this.receipt!==null;}
  prepare(input:unknown,c:SocketContext):void {
    this.tick(c);
    const selection=validateSocketSelection(input);requireContext(c);
    if(this.busy)throw new Error('The prior socket outcome is unresolved. Wait for exact evidence or a fresh full inventory reconciliation.');
    const item=c.inventory.get(selection.targetBagId),source=c.inventory.get(selection.cardBagId);
    const t=item&&target(item,c),s=source&&card(source,c);
    if(!item||!source||!t||!s)throw new Error('Choose observed unequipped, non-crafted gear with a free supported slot and a regular card above its reserve.');
    if((SOCKET_METADATA[item.itemId]!.mask&SOCKET_METADATA[source.itemId]!.mask)===0)throw new Error('This card does not match the target equipment mask.');
    const slot=t.slots.slice(0,t.capacity).indexOf(0),fingerprint=JSON.stringify([item.guid,item.itemId,item.flags,item.refine,item.slots,source.itemId]);
    if(this.attempted.has(fingerprint)||this.attempted.size>=200)throw new Error('This exact socket attempt was already sent or the session attempt limit was reached. It cannot be replayed.');
    this.prepared={view:{...selection,previewToken:this.token(),target:t,card:s,slot,cost:1},target:clone(item),card:clone(source),context:binding(c),reserve:s.reserve,fingerprint};
    this.state='preview';this.reason=`Consume 1 ${s.name}; fill slot ${slot+1} of ${t.name}. Installed cards cannot be removed by this action.`;
  }
  dispatch(input:unknown,c:SocketContext):void {
    this.tick(c);
    const request=validateSocketRequest(input);requireContext(c);const p=this.prepared;
    if(this.busy||!p||request.previewToken!==p.view.previewToken||request.targetBagId!==p.target.bagId||request.cardBagId!==p.card.bagId
      ||binding(c)!==p.context||!same(c.inventory.get(p.target.bagId),p.target)||!same(c.inventory.get(p.card.bagId),p.card)
      ||(c.floors.get(p.card.itemId)??0)!==p.reserve||!target(p.target,c)||!card(p.card,c))throw new Error('Socket preview is stale. Request a new preview.');
    this.receipt={prepared:p,inventory:new Map([...c.inventory].map(([id,i])=>[id,clone(i)])),equipment:[...c.equipment],ammoId:c.ammoId,
      character:c.character,identity:c.identity,connection:c.connection,map:c.map,deadline:this.now()+10_000,cardSeen:false,targetSeen:false,canceled:false,dirty:false};
    this.attempted.add(p.fingerprint);this.prepared=null;this.state='pending';this.reason='One socket request sent. Waiting for the exact card decrement and target mutation; no retry.';
    try{this.send({type:'socket',targetBagId:request.targetBagId,cardBagId:request.cardBagId});}
    catch{this.cancel('Socket write is uncertain. The request will not be retried.');throw new Error(this.reason);}
  }
  cancel(reason:string):void {
    this.prepared=null;
    if(this.receipt){this.receipt.canceled=true;this.state='uncertain';this.reason=`${reason} Socket outcome remains uncertain; no retry.`;}
    else if(this.state==='preview'){this.state='idle';this.reason=reason;}
  }
  /** Trusted game input may start another socket request without a transaction ID. */
  externalInput():void {
    if(this.receipt){this.receipt.dirty=true;delete this.receipt.fresh;}
    this.cancel('Manual game input invalidated socket correlation. Wait for fresh full inventory; the old outcome remains unknown.');
  }
  tick(c:SocketContext):void {
    if(this.prepared&&(!c.ready||!c.settled||!c.inventoryKnown||!c.equipmentKnown||binding(c)!==this.prepared.context))this.cancel('Socket preview expired after state changed.');
    const r=this.receipt;
    if(r&&(this.now()>=r.deadline||!c.ready||c.identity!==r.identity||c.connection!==r.connection||c.character!==r.character||c.map!==r.map))this.cancel('Socket observation window or character context changed.');
    this.reconcile(c);
  }
  observe(events:readonly GameEvent[],c:SocketContext):void {
    this.tick(c);const r=this.receipt;if(!r)return;
    const p=r.prepared,expected=clone(p.target);expected.slots![p.view.slot]=p.card.itemId;
    const matchingContext=c.character===r.character&&c.identity===r.identity&&c.connection===r.connection&&c.map===r.map;
    for(const e of events){
      if(e.type==='equipment')this.cancel('Equipment changed during socketing.');
      if(e.type==='requestFailure'||e.type==='skillFailure')this.cancel('The game rejected a request without a socket rollback receipt.');
      if(e.type==='inventoryDelta'){
        if(!e.add&&e.bagId===p.card.bagId&&e.change===1)r.cardSeen=true;
        else r.dirty=true;
      }
      if(e.type==='inventoryItem'){
        if(same(e.item,expected))r.targetSeen=true;else r.dirty=true;
      }
    }
    if(r.dirty)this.cancel('Unexpected inventory change during socketing.');
    if(matchingContext&&!r.dirty&&r.cardSeen&&r.targetSeen&&this.exact(r,c,expected)){
      this.receipt=null;this.state='confirmed';this.reason=r.canceled?'Late exact socket result confirmed. The canceled action will not resume or repeat.':'Confirmed: exactly one card consumed and the expected first free slot changed.';return;
    }
    if(events.some(e=>e.type==='inventory')&&c.readbackKey&&c.inventoryKnown&&c.equipmentKnown&&r.canceled)r.fresh={key:c.readbackKey,connection:c.connection,inventoryRevision:c.inventoryRevision,equipmentRevision:c.equipmentRevision};
    this.reconcile(c);
  }
  private reconcile(c:SocketContext):void {
    const r=this.receipt,f=r?.fresh;
    if(r&&r.canceled&&f&&c.ready&&c.character===r.character&&c.inventoryKnown&&c.equipmentKnown&&f.key===c.readbackKey&&f.connection===c.connection
      &&f.inventoryRevision===c.inventoryRevision&&f.equipmentRevision===c.equipmentRevision){
      this.receipt=null;this.state='reconciled';this.reason='Fresh full inventory reconciled. The old socket outcome was not inferred; its exact attempt cannot be replayed.';
    }
  }
  private exact(r:Receipt,c:SocketContext,expected:InventoryItem):boolean {
    if(!c.inventoryKnown||!c.equipmentKnown||c.ammoId!==r.ammoId||JSON.stringify(c.equipment)!==JSON.stringify(r.equipment))return false;
    const remaining=r.prepared.card.count-1;
    if(c.inventory.size!==r.inventory.size-(remaining===0?1:0))return false;
    for(const [id,i]of r.inventory){
      const wanted=id===expected.bagId?expected:id===r.prepared.card.bagId?(remaining?{...i,count:remaining}:undefined):i;
      if(!same(c.inventory.get(id),wanted))return false;
    }
    return true;
  }
  snapshot(c:SocketContext):SocketSnapshot {
    const view=this.prepared?.view;
    return {state:this.state,pending:this.busy,reason:this.reason,...candidates(c),preview:view?{...view,target:{...view.target,slots:[...view.target.slots]},card:{...view.card}}:null};
  }
}

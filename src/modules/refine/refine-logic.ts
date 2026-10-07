import { map, sortWith } from 'effect/Array';
import { pipe } from 'effect/Function';
import { Number as numberOrder } from 'effect/Order';
import { actorId, itemId, quantity, regularItemBagId, type ActorId, type BagId, type ItemId, type Quantity, type Revision, type Milliseconds } from '../../shared/domain-values';
import { admitInventoryItem, inventoryItemDraft, type DomainInventoryItem } from '../world/character-state-logic';
import catalog from '../../data/socket-catalog.json';
import { dispositionStockFloors } from '../services/disposition-ui-logic';
import type { InventoryItemInput as InventoryItem } from '../protocol/protocol-feature';
import type { ValidatedRefinePreviewRequest } from './refine-protocol';
export const REFINE_WINDOW_MS = 10_000;

export interface RefineMetadata { rank: number; oreItemId: number; zenyCost: number; thresholds: number[] }

export interface RefineContext {
  ready: boolean; settled: boolean; identity: string | null; character: string | null; readbackKey: string | null; connection: Revision<'connection'>; map: string;
  npcId: number | null; npcIdentity: string | null; npcGeneration: number; npcMode: string; promptToken: string | null;
  inventory: readonly DomainInventoryItem[] | null; equipment: readonly number[] | null; zeny: number | null;
  inventoryRevision: Revision<'inventory'>; equipmentRevision: Revision<'equipment'>; currencyRevision: Revision<'currency'>; activityRevision: Revision<'activity'>;
}

export interface RefinePreview {
  token: string; targetBagId: number; itemId: number; name: string; startingRefine: number;
  oreItemId: number; zenyCost: number; failurePossible: boolean; npcId: number;
}

export interface RefineSnapshot {
  state: 'idle' | 'preview' | 'pending' | 'improved' | 'downgraded' | 'uncertain' | 'reconciled';
  blocked: boolean; reason: string; preview: RefinePreview | null; dialogueToken: string | null;
  candidates: Array<{ bagId:number; itemId:number; name:string; refine:number }>;
}

export interface RefinePlan extends Omit<RefinePreview,'targetBagId'|'itemId'|'oreItemId'|'npcId'> {readonly targetBagId:BagId;readonly itemId:ItemId;readonly oreItemId:ItemId;readonly npcId:ActorId}
export interface Prepared { display: RefinePlan; key: string; item: DomainInventoryItem; ore: DomainInventoryItem; zeny: number; context: Readonly<RefineContext> }

export interface Receipt extends Prepared { since:Milliseconds; cancelled:boolean; oreSeen:boolean; currencySeen:boolean; mutation:InventoryItem|null; tainted:boolean }

export const cloneItem = inventoryItemDraft;

export function sameItem(a:InventoryItem,b:InventoryItem,ignoreRefine=false):boolean {
  return a.bagId===b.bagId&&a.itemId===b.itemId&&a.type===b.type&&a.count===b.count&&a.flags===b.flags&&a.guid===b.guid
    && (ignoreRefine||a.refine===b.refine)&&JSON.stringify(a.slots)===JSON.stringify(b.slots);
}

export function refineMetadata(itemId:ItemId):RefineMetadata|null {
  const row=(catalog.items as Record<string,{refine?:RefineMetadata}>)[itemId]; return row?.refine??null;
}

export function refineFloors(request:ValidatedRefinePreviewRequest):Array<{itemId:ItemId;count:Quantity}> {
  const floors=new Map<ItemId,Quantity>();
  for(const row of [...dispositionStockFloors(request.policy),...request.policy.disposition?.rules.map(row=>({itemId:row.itemId,count:row.keep}))??[]])
    {const id=itemId(row.itemId);floors.set(id,quantity(Math.max(floors.get(id)??0,row.count)));}
  return pipe([...floors], map(([itemId,count])=>({itemId,count})), sortWith(row=>row.itemId, numberOrder));
}

function guardKey(request:ValidatedRefinePreviewRequest):string { return JSON.stringify([request.targetBagId,refineFloors(request),request.maxSpend,request.minZeny,request.policy.disposition?.maxSpend??null]); }

export function contextKey(c:RefineContext):string { return JSON.stringify([c.identity,c.connection,c.map,c.npcId,c.npcIdentity,c.npcGeneration,c.npcMode,c.promptToken,c.inventoryRevision,c.equipmentRevision,c.currencyRevision,c.activityRevision,c.zeny,c.inventory,c.equipment]); }

export function lifetime(c:RefineContext):string { return JSON.stringify([c.identity,c.connection,c.map]); }

export function targetAllowed(item:DomainInventoryItem,c:RefineContext):boolean {
  return item.type===2&&item.count===1&&typeof item.guid==='string'&&/^[a-f0-9]{32}$/i.test(item.guid)&&Number.isInteger(item.flags)&&Number(item.flags)>=0&&Number(item.flags)<=255
    &&Number.isInteger(item.refine)&&Number(item.refine)>=0&&Number(item.refine)<10&&Array.isArray(item.slots)&&item.slots.length===4
    &&item.slots.every(slot=>Number.isInteger(slot)&&slot>=0&&slot<=2147483647)&&!c.equipment?.includes(item.bagId)&&refineMetadata(item.itemId)!==null;
}

export function prepare(request:ValidatedRefinePreviewRequest,c:RefineContext,token:string):Prepared {
  if(!c.ready||!c.settled||!c.identity||!c.character||!c.npcIdentity||c.npcId===null||c.npcMode!=='refine'||!c.promptToken)throw new Error('Open a fresh refining dialogue and wait for your character and all actions to settle.');
  if(!c.inventory||!c.equipment||c.zeny===null)throw new Error('Wait for authoritative inventory, equipment and zeny.');
  const item=c.inventory.find(row=>row.bagId===request.targetBagId);
  if(!item||!targetAllowed(item,c))throw new Error('Select a verified refinable, unequipped unique weapon or armor below +10.');
  const meta=refineMetadata(item.itemId)!;
  if(meta.rank<0||meta.rank>4||meta.thresholds.length!==10)throw new Error('Refine metadata is unavailable.');
  const ores=c.inventory.filter(row=>row.itemId===meta.oreItemId);
  // The source removes ore by regular item ID. Unique/duplicate stacks cannot be attributed safely.
  if(ores.length!==1||ores[0]!.type!==1||ores[0]!.bagId!==regularItemBagId(itemId(meta.oreItemId))||ores[0]!.count<1||c.equipment.includes(ores[0]!.bagId))throw new Error('One observed regular ore stack is required.');
  const ore=ores[0]!,floor=refineFloors(request).find(row=>row.itemId===meta.oreItemId)?.count??0;
  if(ore.count-1<floor)throw new Error('This attempt would consume protected ore stock.');
  if(meta.zenyCost>request.maxSpend||meta.zenyCost>(request.policy.disposition?.maxSpend??2000000000)||c.zeny-meta.zenyCost<request.minZeny)throw new Error('This attempt exceeds the spending limit or zeny reserve.');
  return {display:{token,targetBagId:item.bagId,itemId:item.itemId,name:(catalog.items as Record<string,{name:string}>)[item.itemId]!.name,
    startingRefine:item.refine!,oreItemId:itemId(meta.oreItemId),zenyCost:meta.zenyCost,failurePossible:meta.thresholds[item.refine!]!<99,npcId:actorId(c.npcId)},
    key:guardKey(request)+contextKey(c),item:admitInventoryItem(item),ore:admitInventoryItem(ore),zeny:c.zeny,context:structuredClone(c)};
}

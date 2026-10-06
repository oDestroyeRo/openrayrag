import catalog from './data/socket-catalog.json';
import { dispositionStockFloors } from './disposition-ui';
import type { InventoryItem } from './protocol-feature';
import type { RefinePreviewRequest } from './refine-protocol';
export const REFINE_WINDOW_MS = 10_000;

export interface RefineMetadata { rank: number; oreItemId: number; zenyCost: number; thresholds: number[] }

export interface RefineContext {
  ready: boolean; settled: boolean; identity: string | null; character: string | null; readbackKey: string | null; connection: number; map: string;
  npcId: number | null; npcIdentity: string | null; npcGeneration: number; npcMode: string; promptToken: string | null;
  inventory: InventoryItem[] | null; equipment: number[] | null; zeny: number | null;
  inventoryRevision: number; equipmentRevision: number; currencyRevision: number; activityRevision: number;
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

export interface Prepared { display: RefinePreview; key: string; item: InventoryItem; ore: InventoryItem; zeny: number; context: RefineContext }

export interface Receipt extends Prepared { since:number; cancelled:boolean; oreSeen:boolean; currencySeen:boolean; mutation:InventoryItem|null; tainted:boolean }

export function cloneItem(item: InventoryItem): InventoryItem { return {...item,slots:item.slots?.slice()}; }

export function sameItem(a:InventoryItem,b:InventoryItem,ignoreRefine=false):boolean {
  return a.bagId===b.bagId&&a.itemId===b.itemId&&a.type===b.type&&a.count===b.count&&a.flags===b.flags&&a.guid===b.guid
    && (ignoreRefine||a.refine===b.refine)&&JSON.stringify(a.slots)===JSON.stringify(b.slots);
}

export function refineMetadata(itemId:number):RefineMetadata|null {
  const row=(catalog.items as Record<string,{refine?:RefineMetadata}>)[itemId]; return row?.refine??null;
}

export function refineFloors(request:RefinePreviewRequest):Array<{itemId:number;count:number}> {
  const floors=new Map<number,number>();
  for(const row of [...dispositionStockFloors(request.policy),...request.policy.disposition?.rules.map(row=>({itemId:row.itemId,count:row.keep}))??[]])
    floors.set(row.itemId,Math.max(floors.get(row.itemId)??0,row.count));
  return [...floors].map(([itemId,count])=>({itemId,count})).sort((a,b)=>a.itemId-b.itemId);
}

function guardKey(request:RefinePreviewRequest):string { return JSON.stringify([request.targetBagId,refineFloors(request),request.maxSpend,request.minZeny,request.policy.disposition?.maxSpend??null]); }

export function contextKey(c:RefineContext):string { return JSON.stringify([c.identity,c.connection,c.map,c.npcId,c.npcIdentity,c.npcGeneration,c.npcMode,c.promptToken,c.inventoryRevision,c.equipmentRevision,c.currencyRevision,c.activityRevision,c.zeny,c.inventory,c.equipment]); }

export function lifetime(c:RefineContext):string { return JSON.stringify([c.identity,c.connection,c.map]); }

export function targetAllowed(item:InventoryItem,c:RefineContext):boolean {
  return item.type===2&&item.count===1&&typeof item.guid==='string'&&/^[a-f0-9]{32}$/i.test(item.guid)&&Number.isInteger(item.flags)&&Number(item.flags)>=0&&Number(item.flags)<=255
    &&Number.isInteger(item.refine)&&Number(item.refine)>=0&&Number(item.refine)<10&&Array.isArray(item.slots)&&item.slots.length===4
    &&item.slots.every(slot=>Number.isInteger(slot)&&slot>=0&&slot<=2147483647)&&!c.equipment?.includes(item.bagId)&&refineMetadata(item.itemId)!==null;
}

export function prepare(request:RefinePreviewRequest,c:RefineContext,token:string):Prepared {
  if(!c.ready||!c.settled||!c.identity||!c.character||!c.npcIdentity||c.npcId===null||c.npcMode!=='refine'||!c.promptToken)throw new Error('Open a fresh refining dialogue and wait for your character and all actions to settle.');
  if(!c.inventory||!c.equipment||c.zeny===null)throw new Error('Wait for authoritative inventory, equipment and zeny.');
  const item=c.inventory.find(row=>row.bagId===request.targetBagId);
  if(!item||!targetAllowed(item,c))throw new Error('Select a verified refinable, unequipped unique weapon or armor below +10.');
  const meta=refineMetadata(item.itemId)!;
  if(meta.rank<0||meta.rank>4||meta.thresholds.length!==10)throw new Error('Refine metadata is unavailable.');
  const ores=c.inventory.filter(row=>row.itemId===meta.oreItemId);
  // The source removes ore by regular item ID. Unique/duplicate stacks cannot be attributed safely.
  if(ores.length!==1||ores[0]!.type!==1||ores[0]!.bagId!==meta.oreItemId||ores[0]!.count<1||c.equipment.includes(ores[0]!.bagId))throw new Error('One observed regular ore stack is required.');
  const ore=ores[0]!,floor=refineFloors(request).find(row=>row.itemId===meta.oreItemId)?.count??0;
  if(ore.count-1<floor)throw new Error('This attempt would consume protected ore stock.');
  if(meta.zenyCost>request.maxSpend||meta.zenyCost>(request.policy.disposition?.maxSpend??2000000000)||c.zeny-meta.zenyCost<request.minZeny)throw new Error('This attempt exceeds the spending limit or zeny reserve.');
  return {display:{token,targetBagId:item.bagId,itemId:item.itemId,name:(catalog.items as Record<string,{name:string}>)[item.itemId]!.name,
    startingRefine:item.refine!,oreItemId:meta.oreItemId,zenyCost:meta.zenyCost,failurePossible:meta.thresholds[item.refine!]!<99,npcId:c.npcId},
    key:guardKey(request)+contextKey(c),item:cloneItem(item),ore:cloneItem(ore),zeny:c.zeny,context:structuredClone(c)};
}

import { sameMemoLocation } from './memo-logic';
import type { MemoSlots, MemoLocation } from './memo-protocol';
import type { WarpBinding, WarpRequest } from './warp-protocol';
export const WARP_SELECTION_MS=30_000;

export const WARP_RECOVERY='Stop only ends local intent. It does not cancel server casts, clear selection or destroy portals. Automation stays held until verified death/revival or a genuinely new initialized character session, with reconciled inventory/SP. Normal map arrival and reconnect alone do not release it.';

export interface WarpContext {
  ready:boolean;idle:boolean;character:string;connection:number;binding:WarpBinding|null;slots:MemoSlots|null;unavailable:string|null;
  sp:number|null;gems:number|null;reserve:number;cost:number|null;resourcesReady:boolean;
  groundAllowed:(target:{x:number;y:number})=>boolean;
}

export interface WarpGuardStore {read():boolean;write(held:boolean):void}

export interface WarpSnapshot {
  generation:number;blocked:boolean;pending:boolean;state:'idle'|'groundSent'|'selectionObserved'|'activationSent'|'stopped'|'recovered';reason:string;
  ready:WarpBinding|null;activation:WarpRequest|null;preview:WarpRequest|null;slots:MemoSlots|null;cost:number|null;gems:number|null;reserve:number;
  selection:'unknown'|'waiting'|'cleared';resourceEvidence:string;captured:{slot:number;ground:{x:number;y:number};destination:MemoLocation}|null;
}

export interface Attempt {
  request:Extract<WarpRequest,{type:'warpGround'}>;character:string;slots:MemoSlots;sp:number;gems:number;cost:number;
  since:number;deadline:number;selectionDeadline:number;waiting:boolean;castObserved:boolean;executed:boolean;spObserved:boolean;settledAt:number;
  stopped:boolean;activated:boolean;activationSince:number|null;activationWindowClosed:boolean;activationSpRevision:number;activationInventoryRevision:number;
  inventoryObserved:boolean;activationSpObserved:boolean;memoValid:boolean;
}

export const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export const physical=(b:WarpBinding)=>[b.world,b.actorId,b.incarnation,b.connectionEpoch,b.map,b.x,b.y,b.revision,b.level,b.skillsRevision,b.equipmentRevision,b.generation];

export const slotsEqual=(a:MemoSlots,b:MemoSlots)=>a.every((slot,index)=>sameMemoLocation(slot,b[index]!));

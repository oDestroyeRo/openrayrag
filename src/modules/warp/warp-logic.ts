import { sameMemoLocation } from '../memo/memo-logic';
import type { MemoCell, MemoSlot, MemoSlotsInput, MemoLocation } from '../memo/memo-protocol';
import type { PreparedWarpRequest, WarpActivationObservation, WarpBindingInput, WarpGeneration, WarpRequest } from './warp-protocol';
import { incrementRevision, milliseconds, revisionFor, type Milliseconds, type Quantity, type Revision } from '../../shared/domain-values';
export const WARP_SELECTION_MS=milliseconds(30_000);

export const WARP_RECOVERY='Stop only ends local intent. It does not cancel server casts, clear selection or destroy portals. Automation stays held until verified death/revival or a genuinely new initialized character session, with reconciled inventory/SP. Normal map arrival and reconnect alone do not release it.';

export interface WarpContext {
  ready:boolean;idle:boolean;character:string;connection:number;binding:Readonly<WarpBindingInput>|null;slots:MemoSlotsInput|null;unavailable:string|null;
  sp:number|null;gems:Quantity|null;reserve:Quantity;cost:number|null;resourcesReady:boolean;
  groundAllowed:(target:Readonly<{x:number;y:number}>)=>boolean;
}

export interface WarpGuardStore {read():boolean;write(held:boolean):void}

export type WarpSnapshot = Readonly<{
  generation:WarpGeneration;blocked:boolean;pending:boolean;state:'idle'|'groundSent'|'selectionObserved'|'activationSent'|'stopped'|'recovered';reason:string;
  ready:Readonly<WarpBindingInput>|null;activation:WarpActivationObservation|null;preview:PreparedWarpRequest|null;slots:MemoSlotsInput|null;cost:number|null;gems:Quantity|null;reserve:Quantity;
  selection:'unknown'|'waiting'|'cleared';resourceEvidence:string;captured:Readonly<{slot:MemoSlot;ground:Readonly<{x:MemoCell;y:MemoCell}>;destination:Readonly<MemoLocation>}>|null;
}>;

export interface Attempt {
  readonly request:Extract<WarpRequest,{type:'warpGround'}>;readonly character:string;readonly slots:MemoSlotsInput;readonly sp:number;readonly gems:Quantity;readonly cost:number;
  readonly since:Milliseconds;deadline:Milliseconds;selectionDeadline:Milliseconds;waiting:boolean;castObserved:boolean;executed:boolean;spObserved:boolean;settledAt:Milliseconds|null;
  stopped:boolean;activated:boolean;activationSince:Milliseconds|null;activationWindowClosed:boolean;activationSpRevision:Revision<'sp'>;activationInventoryRevision:Revision<'inventory'>;
  inventoryObserved:boolean;activationSpObserved:boolean;memoValid:boolean;
}

export const equal=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);

export const nextWarpGeneration = (value: WarpGeneration): WarpGeneration => revisionFor('warp', Math.min(2147483647, value + 1));

/** Raw SP evidence confirms only the next revision and the captured ground debit. */
export const groundSpReadback = (receipt: Readonly<Pick<Attempt, 'request' | 'sp' | 'cost'>>) =>
  (observed: Readonly<{ sp: number | null; revision: number }>): boolean =>
    observed.revision === incrementRevision(receipt.request.preview.spRevision) && observed.sp === receipt.sp - receipt.cost;

/** Comparing current evidence never admits a raw observation as a request. */
export const physical=(b:Readonly<WarpBindingInput>)=>[b.world,b.actorId,b.incarnation,b.connectionEpoch,b.map,b.x,b.y,b.revision,b.level,b.skillsRevision,b.equipmentRevision,b.generation];

export const slotsEqual=(a:MemoSlotsInput,b:MemoSlotsInput)=>a.every((slot,index)=>sameMemoLocation(slot,b[index]!));

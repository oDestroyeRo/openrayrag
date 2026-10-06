import { validateMemoRequest, type MemoBinding, type MemoBindingInput, type MemoGeneration, type MemoLocation, type MemoRequest, type MemoRevision, type MemoSlot, type MemoSlotsInput } from './memo-protocol';
import { milliseconds, revisionFor, type Milliseconds } from '../../shared/domain-values';
export const MEMO_WINDOW_MS = milliseconds(10_000);

export interface MemoContext {
  ready: boolean; idle: boolean; world: string; actorId: number | null; incarnation: number | null; connectionEpoch: number;
  map: string; x: number; y: number; walkable: boolean | null; canMemo: boolean | null; learnedWarp: number | null;
}

export interface MemoSnapshot {
  readonly generation: MemoGeneration; readonly revision: MemoRevision; readonly slots: MemoSlotsInput | null; readonly pending: boolean; readonly blocked: boolean;
  readonly state: 'unknown' | 'observed' | 'alreadyCurrent' | 'sent' | 'notified' | 'confirmed' | 'uncertain'; readonly reason: string;
  readonly ready: MemoBinding | null; readonly learnedWarp: number | null; readonly unavailable: string | null;
}

export interface Receipt { readonly request: MemoRequest; readonly before: MemoSlotsInput; notified: boolean; readonly ambiguous: boolean; readonly since: Milliseconds; readonly deadline: Milliseconds }

export const nextMemoRevision = (value: MemoRevision): MemoRevision => revisionFor('memo', Math.min(2147483647, value + 1));
export const nextMemoGeneration = (value: MemoGeneration): MemoGeneration => revisionFor('memo-generation', Math.min(2147483647, value + 1));

export const cloneSlots = (slots: MemoSlotsInput): MemoSlotsInput => structuredClone(slots);

export const sameMemoLocation = (a: Readonly<MemoLocation> | null, b: Readonly<MemoLocation> | null): boolean => a === null || b === null ? a === b : a.map === b.map && a.x === b.x && a.y === b.y;

/** Raw observations may invalidate an admitted receipt without becoming a new binding. */
export const identity = (p: Readonly<MemoBindingInput>): string => JSON.stringify([p.world,p.actorId,p.incarnation,p.connectionEpoch,p.map,p.x,p.y]);

declare const memoRequestIdentity: unique symbol;
export type MemoRequestIdentity = string & { readonly [memoRequestIdentity]: 'MemoRequestIdentity' };
/** Only an admitted request can create a correlation key retained across resets. */
export const fingerprint = (request: MemoRequest): MemoRequestIdentity => JSON.stringify([request.slot,request.preview.map,request.preview.x,request.preview.y]) as MemoRequestIdentity;

export function memoPreview(snapshot: Readonly<MemoSnapshot>, slot: MemoSlot): { readonly request: MemoRequest | null; readonly previous: Readonly<MemoLocation> | null; readonly message: string } {
  if (!snapshot.ready || !snapshot.slots || snapshot.learnedWarp === null || slot >= snapshot.learnedWarp) throw new Error(snapshot.unavailable ?? 'This slot requires a higher learned Warp Portal level.');
  const previous = snapshot.slots[slot];
  if (sameMemoLocation(previous,snapshot.ready)) return { request:null,previous:structuredClone(previous),message:'Already current. No write is needed.' };
  return { request:validateMemoRequest({type:'memoSave',slot,preview:snapshot.ready}),previous:structuredClone(previous),message:'Preview only. Save once to replace this slot with the captured current location.' };
}

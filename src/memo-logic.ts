import { validateMemoRequest, type MemoBinding, type MemoLocation, type MemoRequest, type MemoSlot, type MemoSlots } from './memo-protocol';
export const MEMO_WINDOW_MS = 10_000;

export interface MemoContext {
  ready: boolean; idle: boolean; world: string; actorId: number | null; incarnation: number | null; connectionEpoch: number;
  map: string; x: number; y: number; walkable: boolean | null; canMemo: boolean | null; learnedWarp: number | null;
}

export interface MemoSnapshot {
  generation: number; revision: number; slots: MemoSlots | null; pending: boolean; blocked: boolean;
  state: 'unknown' | 'observed' | 'alreadyCurrent' | 'sent' | 'notified' | 'confirmed' | 'uncertain'; reason: string;
  ready: MemoBinding | null; learnedWarp: number | null; unavailable: string | null;
}

export interface Receipt { request: MemoRequest; before: MemoSlots; notified: boolean; ambiguous: boolean; since: number; deadline: number }

export const cloneSlots = (slots: MemoSlots): MemoSlots => structuredClone(slots);

export const sameMemoLocation = (a: MemoLocation | null, b: MemoLocation | null): boolean => a === null || b === null ? a === b : a.map === b.map && a.x === b.x && a.y === b.y;

export const identity = (p: MemoBinding): string => JSON.stringify([p.world,p.actorId,p.incarnation,p.connectionEpoch,p.map,p.x,p.y]);

export const fingerprint = (request: MemoRequest): string => JSON.stringify([request.slot,request.preview.map,request.preview.x,request.preview.y]);

export function memoPreview(snapshot: MemoSnapshot, slot: MemoSlot): { request: MemoRequest | null; previous: MemoLocation | null; message: string } {
  if (!snapshot.ready || !snapshot.slots || snapshot.learnedWarp === null || slot >= snapshot.learnedWarp) throw new Error(snapshot.unavailable ?? 'This slot requires a higher learned Warp Portal level.');
  const previous = snapshot.slots[slot];
  if (sameMemoLocation(previous,snapshot.ready)) return { request:null,previous,message:'Already current. No write is needed.' };
  return { request:validateMemoRequest({type:'memoSave',slot,preview:snapshot.ready}),previous:structuredClone(previous),message:'Preview only. Save once to replace this slot with the captured current location.' };
}

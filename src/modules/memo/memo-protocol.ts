import { BitReader, BitWriter } from '../../shared/binary';
import { DomainValueError, actorId, incarnation, mapCode as checkedMapCode, revisionFor, worldId, type ActorId, type Incarnation, type MapCode, type Revision, type WorldId } from '../../shared/domain-values';

export const MEMO_OP = 94;
export type MemoSlot = 0 | 1 | 2 | 3;
export interface MemoLocation { map: string; x: number; y: number }
export type MemoSlots = [MemoLocation | null, MemoLocation | null, MemoLocation | null, MemoLocation | null];
export type MemoSlotsInput = Readonly<[Readonly<MemoLocation> | null, Readonly<MemoLocation> | null, Readonly<MemoLocation> | null, Readonly<MemoLocation> | null]>;
export interface MemoEvent { type: 'memoSlots'; slots: MemoSlots }
/** Coordinates only bind the preview to the current cell. The wire sends a slot. */
export interface MemoBindingInput extends MemoLocation {
  world: string; actorId: number; incarnation: number; connectionEpoch: number; revision: number;
}
declare const memoCellValue: unique symbol;
/** Current-cell request coordinates are bounded more tightly than observed memo locations. */
export type MemoCell = number & { readonly [memoCellValue]: 'MemoCell' };
export function memoCell(value: unknown): MemoCell {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 511) throw new DomainValueError('MemoCell', typeof value === 'number' ? 'range' : 'type', 'memo cell');
  return value as MemoCell;
}
export type MemoRevision = Revision<'memo'>;
export type MemoGeneration = Revision<'memo-generation'>;
export interface MemoBinding {
  readonly world: WorldId; readonly actorId: ActorId; readonly incarnation: Incarnation;
  readonly connectionEpoch: Revision<'connection'>; readonly revision: MemoRevision;
  readonly map: MapCode; readonly x: MemoCell; readonly y: MemoCell;
}
export interface MemoRequest { readonly type: 'memoSave'; readonly slot: MemoSlot; readonly preview: MemoBinding }
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, allowed: string[]): boolean => Object.keys(v).length === allowed.length && Object.keys(v).every(key => allowed.includes(key));
const integer = (v: unknown, min: number, max: number): v is number => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
const mapCode = (v: unknown): v is string => typeof v === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(v);
export function validateMemoRequest(value: unknown): MemoRequest {
  if (!record(value) || !keys(value, ['type','slot','preview']) || value.type !== 'memoSave' || !integer(value.slot,0,3) || !record(value.preview)) throw new Error('Invalid manual memo request.');
  const p = value.preview;
  if (!keys(p,['world','actorId','incarnation','connectionEpoch','revision','map','x','y']) || typeof p.world !== 'string'
    || !/^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(p.world)
    || !integer(p.actorId,0,0x7fffffff) || !integer(p.incarnation,1,0x7fffffff) || !integer(p.connectionEpoch,1,0x7fffffff)
    || !integer(p.revision,1,0x7fffffff) || !mapCode(p.map) || !integer(p.x,0,511) || !integer(p.y,0,511)) throw new Error('Memo preview is invalid or incomplete.');
  return { type: 'memoSave', slot: value.slot as MemoSlot, preview: { world:worldId(p.world),actorId:actorId(p.actorId),incarnation:incarnation(p.incarnation),connectionEpoch:revisionFor('connection',p.connectionEpoch),revision:revisionFor('memo',p.revision),map:checkedMapCode(p.map),x:memoCell(p.x),y:memoCell(p.y) } };
}
export function memoCommand(slot: MemoSlot): Uint8Array<ArrayBuffer> {
  if (!integer(slot,0,3)) throw new Error('Choose memo slot 0–3.');
  return new BitWriter().u8(MEMO_OP).u8(slot).finish();
}
/** Only the memo event uses this adapter; BOM bytes are nonempty text content. */
export function decodeMemoNotification(data:Uint8Array):Array<{type:'serverEvent';event:number;value:number;text:string}>|null {
  if(data[0]!==91||data[1]!==8)return null;
  const r=new BitReader(data);r.u8();const event=r.u8(),value=r.i32(),bytes=r.u16();
  if(bytes>4096)throw new Error('Oversized memo notification text.');
  const text=new TextDecoder('utf-8',{fatal:true,ignoreBOM:true}).decode(r.take(bytes));
  r.finish();return[{type:'serverEvent',event,value,text}];
}
export function decodeMemo(data: Uint8Array): MemoEvent[] | null {
  if (data[0] !== MEMO_OP) return null;
  const reader = new BitReader(data); reader.u8();
  const utf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  const slots: MemoSlots = [null,null,null,null];
  for (let slot = 0; slot < 4; slot++) {
    const present = reader.u8();
    if (present === 0) continue;
    if (present !== 1) throw new Error('Invalid memo presence.');
    const bytes = reader.u16(); if (bytes > 64) throw new Error('Invalid memo map length.');
    const map = utf8.decode(reader.take(bytes)), x = reader.i16(), y = reader.i16();
    if (!mapCode(map) || x < 0 || y < 0) throw new Error('Invalid memo location.');
    slots[slot] = { map, x, y };
  }
  reader.finish(); return [{ type:'memoSlots', slots }];
}

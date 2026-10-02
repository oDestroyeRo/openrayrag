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
interface Receipt { request: MemoRequest; before: MemoSlots; notified: boolean; ambiguous: boolean; since: number; deadline: number }
const cloneSlots = (slots: MemoSlots): MemoSlots => structuredClone(slots);
export const sameMemoLocation = (a: MemoLocation | null, b: MemoLocation | null): boolean => a === null || b === null ? a === b : a.map === b.map && a.x === b.x && a.y === b.y;
const identity = (p: MemoBinding): string => JSON.stringify([p.world,p.actorId,p.incarnation,p.connectionEpoch,p.map,p.x,p.y]);
const fingerprint = (request: MemoRequest): string => JSON.stringify([request.slot,request.preview.map,request.preview.x,request.preview.y]);
/** Source observations only reconcile state; only dispatch can issue one packet. */
export class ManualMemo {
  private generation = 0; private revision = 0; private slots: MemoSlots | null = null;
  private pending: Receipt | null = null; private held: MemoBinding | null = null;
  private seen = new Set<string>(); private correlationFull = false;
  private state: MemoSnapshot['state'] = 'unknown'; private reason = 'Waiting for the initial four-slot server snapshot.';
  constructor(private readonly send: (slot: MemoSlot) => void, private readonly now = Date.now) {}
  get busy(): boolean { return this.pending !== null; }
  get blocked(): boolean { return this.pending !== null || this.held !== null; }
  cancel(reason: string): void {
    this.generation=Math.min(2147483647,this.generation+1); this.revise();
    if (this.pending) { this.held = { ...this.pending.request.preview }; this.pending = null; this.state = 'uncertain'; }
    this.reason = reason;
  }
  reset(reason: string): void {
    this.cancel(reason); this.held = null; this.slots = null; this.revise(); this.state = 'unknown';
    // Keep bounded fingerprints: Stop/world/session resets never make an
    // identical replay uniquely attributable. New pages do not replay intent.
  }
  /** A same-connection lifetime replacement is not a fresh memo readback. */
  invalidate(reason:string):void {
    this.cancel(reason);this.slots=null;if(!this.held)this.state='unknown';
  }
  unavailable(c: MemoContext): string | null {
    if (!c.ready || c.actorId === null || c.incarnation === null) return 'Enter a fresh verified character first.';
    if (!c.idle) return 'Stop automation and wait for accepted movement, resource and cast actions to settle.';
    if (this.blocked) return 'Wait for a complete memo readback or reconnect to reconcile the uncertain write.';
    if (this.slots === null) return 'Wait for the complete four-slot server memo snapshot.';
    if(this.revision>=2147483647||this.generation>=2147483647)return 'Memo observation budget exhausted. Reopen the game to establish a new session.';
    try { validateMemoRequest({type:'memoSave',slot:0,preview:this.binding(c)}); } catch { return 'Current character/world/cell evidence is incomplete.'; }
    if (c.learnedWarp === null || c.learnedWarp < 1) return 'Memo requires observed learned Warp Portal (skill 55). Granted skills do not permit it.';
    if (c.canMemo !== true) return c.canMemo === false ? 'The pinned server metadata forbids memo on this map.' : 'This map has no verified CanMemo permission.';
    if (c.walkable !== true) return 'The current cell is not verified walkable.';
    return null;
  }
  private binding(c: MemoContext): MemoBinding {
    return { world:c.world,actorId:c.actorId!,incarnation:c.incarnation!,connectionEpoch:c.connectionEpoch,revision:this.revision,map:c.map,x:c.x,y:c.y };
  }
  private revise():void {this.revision=Math.min(2147483647,this.revision+1);}
  dispatch(input: unknown, c: MemoContext): void {
    const request = validateMemoRequest(input), unavailable = this.unavailable(c);
    if (unavailable) throw new Error(unavailable);
    const current = this.binding(c);
    if (request.slot >= c.learnedWarp!) throw new Error('This slot requires a higher observed learned Warp Portal level.');
    if (JSON.stringify(request.preview) !== JSON.stringify(current)) throw new Error('The memo preview is stale. Preview this slot again.');
    if (sameMemoLocation(this.slots![request.slot],current)) { this.state = 'alreadyCurrent'; this.reason = 'This slot already contains the exact current map/cell. Nothing was sent.'; return; }
    if(this.seen.size>=128)this.correlationFull=true;
    const key = fingerprint(request), ambiguous = this.correlationFull || this.seen.has(key);
    if (this.seen.size < 128) this.seen.add(key);
    const since=this.now();this.pending = { request, before:cloneSlots(this.slots!),notified:false,ambiguous,since,deadline:since+MEMO_WINDOW_MS };
    this.state = 'sent'; this.reason = 'Sent once. Waiting for the slot notification and complete readback; this is not yet confirmed.';
    try { this.send(request.slot); } catch { this.cancel('Uncertain socket write. No retry will be sent; wait for full state or reconnect.'); throw new Error('Memo write is uncertain. Nothing will be retried.'); }
  }
  observeNotification(slot: number, c: MemoContext): void {
    this.tick(c);
    const receipt = this.pending;
    if (!receipt) { this.slots = null; this.revise(); if(this.state!=='uncertain')this.state='unknown'; this.reason = 'Memo notification observed. Waiting for the complete slot snapshot.'; return; }
    if (slot !== receipt.request.slot || receipt.notified) { this.cancel('Uncertain or duplicate slot notification. Waiting for full state without retry.'); return; }
    receipt.notified = true; this.state = 'notified'; this.reason = 'Matching slot notification observed. Awaiting the complete four-slot readback.';
  }
  observeSlots(slots: MemoSlots, c: MemoContext): void {
    this.tick(c); const receipt = this.pending;
    this.slots = cloneSlots(slots); this.revise();
    if (!receipt) { this.held = null; if (this.state !== 'uncertain') this.state = 'observed'; this.reason = this.state === 'uncertain' ? 'Fresh memo state observed. The canceled/uncertain attempt is not confirmed and will not replay.' : 'All four server memo slots observed.'; return; }
    const { request, before } = receipt;
    const targetMatches = sameMemoLocation(slots[request.slot],request.preview);
    const untouchedMatch = slots.every((slot,index) => index === request.slot || sameMemoLocation(slot,before[index]!));
    if (!receipt.notified || !targetMatches || !untouchedMatch) {
      const unchanged=slots.every((slot,index)=>sameMemoLocation(slot,before[index]!));
      this.cancel(!receipt.notified ? 'Uncertain: a readback arrived before the matching notification.' : unchanged ? 'Uncertain: full readback was unchanged; the captured current cell was not saved.' : !targetMatches ? 'Uncertain: readback did not show the captured current cell.' : 'Uncertain: an untouched memo slot contradicted the preview.');
      return;
    }
    this.pending = null; this.held = null;
    this.state = receipt.ambiguous ? 'uncertain' : 'confirmed';
    this.reason = receipt.ambiguous ? 'Current slot state observed, but an identical earlier attempt makes attribution ambiguous. Nothing will replay.' : 'Memo update confirmed by the ordered slot notification and complete matching server readback.';
  }
  tick(c?: MemoContext): void {
    const p = this.pending;
    if (!p) return;
    if (c && (!c.ready || c.actorId === null || c.incarnation === null || identity(this.binding(c)) !== identity(p.request.preview))) this.cancel('Memo intent canceled after character/world/current-cell changes. A transmitted update cannot be undone.');
    else if (this.now()<p.since||this.now() >= p.deadline) this.cancel('Memo result uncertain after the 10-second observation window or a clock change. Nothing will retry.');
  }
  snapshot(c: MemoContext): MemoSnapshot {
    const unavailable = this.unavailable(c);
    return { generation:this.generation,revision:this.revision,slots:this.slots===null?null:cloneSlots(this.slots),pending:this.busy,blocked:this.blocked,state:this.state,reason:this.reason,
      ready:unavailable?null:this.binding(c),learnedWarp:c.learnedWarp,unavailable };
  }
}

export function memoPreview(snapshot: MemoSnapshot, slot: MemoSlot): { request: MemoRequest | null; previous: MemoLocation | null; message: string } {
  if (!snapshot.ready || !snapshot.slots || snapshot.learnedWarp === null || slot >= snapshot.learnedWarp) throw new Error(snapshot.unavailable ?? 'This slot requires a higher learned Warp Portal level.');
  const previous = snapshot.slots[slot];
  if (sameMemoLocation(previous,snapshot.ready)) return { request:null,previous,message:'Already current. No write is needed.' };
  return { request:validateMemoRequest({type:'memoSave',slot,preview:snapshot.ready}),previous:structuredClone(previous),message:'Preview only. Save once to replace this slot with the captured current location.' };
}

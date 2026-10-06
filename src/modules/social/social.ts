import { EMOTES, validateSocialAction, type ManualSocialAction, type SocialEvent } from './social-protocol';

import { SOCIAL_WINDOW_MS, SOCIAL_HISTORY_COUNT, SOCIAL_HISTORY_BYTES, encoder, type SocialContext, type SocialEntry, type SocialSnapshot, displayText, fingerprint } from './social-logic';

export { SOCIAL_WINDOW_MS, SOCIAL_HISTORY_COUNT, SOCIAL_HISTORY_BYTES, type SocialContext, type SocialEntry, type SocialSnapshot, displayText } from './social-logic';

/** Explicit sends only. No tick/receive path can issue a packet. */
export class ManualSocial {
  private generation = 0; private sequence = 0; private history: SocialEntry[] = [];
  private pending: { action: ManualSocialAction; entry: SocialEntry; actorId: number; deadline: number; ambiguous: boolean } | null = null;
  private seen = new Set<string>(); private correlationFull = false;
  private shoutAt = -Infinity; private emoteAt = -Infinity;
  private state: SocialSnapshot['state'] = 'idle'; private reason = 'Messages remain on this session only.';
  constructor(private readonly send: (action: ManualSocialAction) => void, private readonly now = Date.now) {}
  get busy(): boolean { return this.pending !== null; }
  cancel(reason: string): void {
    this.generation++; if (this.pending) { this.pending.entry.state = 'unconfirmed'; this.state = 'unconfirmed'; }
    this.pending = null; this.reason = reason; this.boundHistory();
  }
  reset(reason: string, newConnection = false): void {
    this.cancel(reason); this.history = []; this.state = 'idle';
    if (newConnection) { this.seen.clear(); this.correlationFull = false; this.shoutAt = this.emoteAt = -Infinity; }
  }
  blocker(action: ManualSocialAction, c: SocialContext): string | null {
    if (!c.ready || c.actorId === null) return 'Connect a verified character with fresh state first.';
    if (this.busy) return 'Wait for the current social observation window.';
    if (action.type === 'chat') {
      if (action.channel === 2 && !c.inParty) return 'Party chat requires observed current party membership.';
      if (action.channel === 1 && (c.learnedBasic === null || c.learnedBasic < 7)) return 'Shout requires learned Basic Mastery level 7.';
      if (action.channel === 1 && this.now() < this.shoutAt + 20_000) return 'Wait 20 seconds between Shout dispatches.';
    } else {
      if (c.job === null || c.job === 0 && (c.learnedBasic === null || c.learnedBasic < 1)) return 'A novice needs learned Basic Mastery level 1 to emote.';
      if (c.silenced) return 'Silence prevents emotes.';
      if (this.now() < this.emoteAt + 1_800) return 'Wait 1.8 seconds between emote dispatches.';
    }
    return null;
  }
  dispatch(input: unknown, c: SocialContext): void {
    const action = validateSocialAction(input), blocker = this.blocker(action, c);
    if (blocker) throw new Error(blocker);
    const key = fingerprint(action), ambiguous = this.correlationFull || this.seen.has(key);
    if (this.seen.size < 256) this.seen.add(key); else this.correlationFull = true;
    const entry: SocialEntry = { sequence: ++this.sequence, at: this.now(), kind: action.type, direction: 'sent', actorId: c.actorId!,
      name: displayText(c.name, 256), text: action.type === 'chat' ? action.text : EMOTES.find(e => e.id === action.id)!.label,
      ...(action.type === 'chat' ? { channel: action.channel } : { emoteId: action.id }), state: 'sent' };
    this.history.push(entry); this.pending = { action, entry, actorId: c.actorId!, deadline: this.now() + SOCIAL_WINDOW_MS, ambiguous };
    this.state = 'sent'; this.reason = ambiguous ? 'Sent. Echo correlation is ambiguous after repetition or the session correlation limit; this attempt remains unconfirmed.' : 'Sent. Waiting up to 10 seconds for an own-actor echo; delivery is not guaranteed.';
    // Apply dispatch gaps even if a socket write throws: its outcome is uncertain.
    if (action.type === 'emote') this.emoteAt = this.now(); else if (action.channel === 1) this.shoutAt = this.now();
    try { this.send(action); } catch { this.cancel('Unconfirmed socket write. Nothing will be retried.'); throw new Error('Social write was unconfirmed. Nothing will be retried.'); }
    this.boundHistory();
  }
  observe(event: SocialEvent, c: SocialContext): void {
    this.tick(); const p = this.pending;
    const match = p && c.ready && c.actorId !== null && c.actorId === p.actorId && event.actorId === p.actorId && !p.ambiguous
      && (p.action.type === 'chat' ? event.type === 'chat' && event.channel === p.action.channel && event.text === p.action.text
        : event.type === 'emote' && (p.action.id === 58 ? event.id >= 200 && event.id <= 205 : event.id === p.action.id));
    if (match && p) { p.entry.state = 'echo'; this.pending = null; this.state = 'echo'; this.reason = 'Echo observed from your actor. The protocol has no delivery receipt.'; }
    this.history.push({ sequence: ++this.sequence, at: this.now(), kind: event.type, direction: 'received', actorId: event.actorId,
      name: displayText(event.type === 'chat' ? event.name : event.actorId === c.actorId && c.ready ? c.name : `Actor #${event.actorId}`, 256),
      text: displayText(event.type === 'chat' ? event.text : EMOTES.find(e => e.id === event.id)?.label ?? (event.id >= 200 && event.id <= 205 ? `Dice ${event.id - 199}` : `Emote #${event.id}`), 4096),
      ...(event.type === 'chat' ? { channel: event.channel } : { emoteId: event.id }), state: 'observed' });
    this.boundHistory();
  }
  tick(): void { if (this.pending && this.now() >= this.pending.deadline) this.cancel('Unconfirmed after the 10-second observation window. No retry was sent.'); }
  private boundHistory(): void {
    while (this.history.length > SOCIAL_HISTORY_COUNT || encoder.encode(JSON.stringify(this.history)).length > SOCIAL_HISTORY_BYTES) this.history.shift();
  }
  snapshot(): SocialSnapshot {
    return { generation: this.generation, pending: this.busy, state: this.state, reason: this.reason,
      shoutWaitMs: Math.max(0, this.shoutAt + 20_000 - this.now()), emoteWaitMs: Math.max(0, this.emoteAt + 1_800 - this.now()), history: this.history.map(row => ({ ...row })) };
  }
}

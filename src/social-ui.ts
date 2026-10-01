import { EMOTES, validateSocialAction, type ManualSocialAction } from './social-protocol';
import { ManualSocial, type SocialContext, type SocialSnapshot } from './social';

const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function socialContextFromStatus(value: unknown): SocialContext {
  const s = record(value), p = record(s.player), c = record(s.character);
  const skills = Array.isArray(c.learned) ? c.learned.map(record) : [];
  return { ready: s.connected === true && s.compatible === true && typeof p.id === 'number', actorId: typeof p.id === 'number' ? p.id : null,
    name: typeof p.name === 'string' ? p.name : '', job: typeof p.classId === 'number' ? p.classId : null,
    learnedBasic: c.skillsKnown === true ? Number(skills.find(skill => skill.skillId === 1)?.level ?? 0) : null,
    inParty: record(s.world).party != null, silenced: Array.isArray(c.statuses) && c.statuses.some(status => record(status).id === 6) };
}
/** This component has no persistence or keypress sender. */
export class SocialUi {
  readonly root = document.createElement('details');
  private readonly channel = document.createElement('select');
  private readonly draft = document.createElement('textarea');
  private readonly count = document.createElement('p');
  private readonly emote = document.createElement('select');
  private readonly chatButton = document.createElement('button');
  private readonly emoteButton = document.createElement('button');
  private readonly reason = document.createElement('p');
  private readonly history = document.createElement('pre');
  private status: Record<string, unknown> = {}; private locked = true; private sending = false; private lifecycle: string | null = null;
  constructor(private readonly send: (action: ManualSocialAction) => Promise<unknown>, private readonly notify: (text: string, error?: boolean) => void) {
    this.root.className = 'manual-group social-panel'; const title = document.createElement('summary'); title.textContent = 'Social · manual chat and emotes';
    const help = document.createElement('p'); help.className = 'hint'; help.textContent = 'Say reaches this entire map; Shout reaches all players; Party reaches your party. Each button sends once. History is session-only. No automatic replies or Enter-to-send.';
    this.channel.setAttribute('aria-label', 'Chat channel');
    for (const [value, label] of [['0', 'Say · entire map'], ['1', 'Shout · all players'], ['2', 'Party · your party']]) {
      const option = document.createElement('option'); option.value = value!; option.textContent = label!; this.channel.append(option);
    }
    this.channel.value = '0'; this.draft.setAttribute('aria-label', 'Chat draft'); this.draft.rows = 3; this.draft.maxLength = 140;
    this.draft.className = 'document-editor'; this.count.className = 'hint'; this.reason.className = 'telemetry-summary';
    this.emote.setAttribute('aria-label', 'Player emote');
    for (const item of EMOTES) { const option = document.createElement('option'); option.value = String(item.id); option.textContent = item.label; this.emote.append(option); }
    this.emote.value = '0'; this.chatButton.type = this.emoteButton.type = 'button'; this.chatButton.dataset.manual = this.emoteButton.dataset.manual = 'true';
    this.chatButton.className = this.emoteButton.className = 'secondary compact'; this.chatButton.textContent = 'Send message'; this.emoteButton.textContent = 'Send emote';
    this.history.className = 'telemetry-summary social-history'; this.history.setAttribute('aria-label', 'Session social history');
    const channelLabel = document.createElement('label'), emoteLabel = document.createElement('label');
    channelLabel.className = emoteLabel.className = 'form-field'; const channelName = document.createElement('span'), emoteName = document.createElement('span');
    channelName.textContent = 'Channel'; emoteName.textContent = 'Player emote'; channelLabel.append(channelName, this.channel); emoteLabel.append(emoteName, this.emote);
    this.root.append(title, help, channelLabel, this.draft, this.count, this.chatButton, emoteLabel, this.emoteButton, this.reason, this.history);
    this.draft.addEventListener('input', () => this.update()); this.channel.addEventListener('change', () => this.update()); this.emote.addEventListener('change', () => this.update());
    this.chatButton.addEventListener('click', () => void this.dispatch({ type: 'chat', channel: Number(this.channel.value) as 0 | 1 | 2, text: this.draft.value }));
    this.emoteButton.addEventListener('click', () => void this.dispatch({ type: 'emote', id: Number(this.emote.value) })); this.update();
  }
  lock(locked: boolean): void { this.locked = locked; this.update(); }
  clear(): void { this.draft.value = ''; this.lifecycle = null; this.render({}); this.lock(true); }
  render(value: unknown): void {
    this.status = record(value); const social = record(this.status.social), player = record(this.status.player);
    // A new game page restarts its counter. Bind the draft to the independently
    // observed page/socket/character too, even when startup snapshots are missed.
    const lifecycle = JSON.stringify([this.status.sessionId ?? null, this.status.connectionId ?? null, social.generation ?? null, player.id ?? null, player.name ?? null]);
    if (this.lifecycle !== null && this.lifecycle !== lifecycle) this.draft.value = '';
    this.lifecycle = lifecycle;
    const rows = Array.isArray(social.history) ? social.history.map(record) : [];
    const states: Record<string, string> = { sent: 'Sent', echo: 'Echo observed', unconfirmed: 'Unconfirmed', observed: 'Observed' };
    this.history.textContent = rows.map(row => `${states[String(row.state)] ?? 'Observed'} · ${String(row.name ?? '')} · ${row.kind === 'chat' ? ['Say', 'Shout', 'Party', 'Notice'][Number(row.channel)] ?? 'Chat' : 'Emote'}: ${String(row.text ?? '')}`).join('\n');
    this.update();
  }
  private blocker(action: ManualSocialAction): string | null {
    try { validateSocialAction(action); } catch (e) { return e instanceof Error ? e.message : 'Invalid social input.'; }
    if (this.locked || this.sending) return 'Stop automation and wait for the current action before sending.';
    const s = record(this.status.social), c = socialContextFromStatus(this.status);
    if (s.pending === true) return 'Wait for the current 10-second observation window.';
    const prerequisite = new ManualSocial(() => {}).blocker(action, c);
    if (prerequisite) return prerequisite;
    if (action.type === 'chat' && action.channel === 1 && Number(s.shoutWaitMs ?? 0) > 0) return `Shout cooldown: ${Math.ceil(Number(s.shoutWaitMs) / 1000)} seconds.`;
    if (action.type === 'emote' && Number(s.emoteWaitMs ?? 0) > 0) return `Emote cooldown: ${(Number(s.emoteWaitMs) / 1000).toFixed(1)} seconds.`;
    return null;
  }
  private update(): void {
    const chat: ManualSocialAction = { type: 'chat', channel: Number(this.channel.value) as 0 | 1 | 2, text: this.draft.value }, emote: ManualSocialAction = { type: 'emote', id: Number(this.emote.value) };
    const chatReason = this.blocker(chat), emoteReason = this.blocker(emote);
    this.chatButton.disabled = !!chatReason; this.emoteButton.disabled = !!emoteReason;
    this.channel.disabled = this.draft.disabled = this.emote.disabled = this.locked || this.sending;
    this.count.textContent = `${this.draft.value.length} / 140 UTF-16 units`;
    this.reason.textContent = [String(record(this.status.social).reason ?? 'A socket write is Sent; only a matching own echo is Echo observed. The server can silently refuse. No automatic retries.'), chatReason && `Message: ${chatReason}`, emoteReason && `Emote: ${emoteReason}`].filter(Boolean).join('\n');
  }
  private async dispatch(action: ManualSocialAction): Promise<void> {
    if (this.blocker(action)) return;
    this.sending = true; this.update();
    try { await this.send(validateSocialAction(action)); this.notify('One social send requested. Check Sent / Echo observed / Unconfirmed in session history.'); }
    catch (e) { this.notify(e instanceof Error ? e.message : 'Social request was not accepted.', true); }
    finally { this.sending = false; this.update(); }
  }
}

export function validSocialSnapshot(value: unknown): value is SocialSnapshot {
  const v = record(value);
  if (Object.keys(v).some(key => !['generation','pending','state','reason','shoutWaitMs','emoteWaitMs','history'].includes(key))
    || !Number.isSafeInteger(v.generation) || Number(v.generation) < 0 || typeof v.pending !== 'boolean' || !['idle', 'sent', 'echo', 'unconfirmed'].includes(String(v.state))
    || typeof v.reason !== 'string' || v.reason.length > 512 || !Number.isFinite(v.shoutWaitMs) || !Number.isFinite(v.emoteWaitMs)
    || Number(v.shoutWaitMs) < 0 || Number(v.shoutWaitMs) > 20000 || Number(v.emoteWaitMs) < 0 || Number(v.emoteWaitMs) > 1800
    || !Array.isArray(v.history) || v.history.length > 200) return false;
  const validRows = v.history.every(entry => { const row = record(entry); return Object.keys(row).every(key => ['sequence','at','kind','direction','actorId','name','text','channel','emoteId','state'].includes(key))
    && typeof row.name === 'string' && new TextEncoder().encode(row.name).length <= 256
    && typeof row.text === 'string' && new TextEncoder().encode(row.text).length <= 4096 && ['chat', 'emote'].includes(String(row.kind))
    && ['sent', 'received'].includes(String(row.direction)) && ['sent', 'echo', 'unconfirmed', 'observed'].includes(String(row.state))
    && Number.isSafeInteger(row.actorId) && Number(row.actorId) >= (row.kind === 'chat' ? -1 : 0) && Number(row.actorId) <= 2147483647
    && (row.kind === 'chat' ? row.emoteId === undefined && Number.isInteger(row.channel) && Number(row.channel) >= 0 && Number(row.channel) <= 3
      : row.channel === undefined && Number.isInteger(row.emoteId) && Number(row.emoteId) >= -2147483648 && Number(row.emoteId) <= 2147483647)
    && Number.isSafeInteger(row.sequence) && Number(row.sequence) >= 0 && Number.isFinite(row.at); });
  return validRows && new TextEncoder().encode(JSON.stringify(v.history)).length <= 32768;
}

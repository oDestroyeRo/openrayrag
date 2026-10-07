import { map } from 'effect/Array';
import { pipe } from 'effect/Function';
import type { SocialContext, SocialSnapshot } from './social';
const record = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function socialContextFromStatus(value: unknown): SocialContext {
  const s = record(value), p = record(s.player), c = record(s.character);
  const skills = Array.isArray(c.learned) ? map(c.learned, record) : [];
  const own=typeof p.id==='number'&&Number.isInteger(p.id)&&p.id>=0&&p.id<=0x7fffffff&&p.kind===0;
  return { ready: s.connected === true && s.compatible === true && own, actorId: own ? p.id as number : null,
    name: typeof p.name === 'string' ? p.name : '', job: typeof p.classId === 'number' ? p.classId : null,
    learnedBasic: c.skillsKnown === true ? Number(skills.find(skill => skill.skillId === 1)?.level ?? 0) : null,
    inParty: record(s.world).party != null, silenced: Array.isArray(c.statuses) && c.statuses.some(status => record(status).id === 6) };
}
export function socialHistoryText(history: unknown): string {
  const states: Record<string, string> = { sent: 'Sent', echo: 'Echo observed', unconfirmed: 'Unconfirmed', observed: 'Observed' };
  return pipe(Array.isArray(history) ? history : [], map(record),
    map(row => `${states[String(row.state)] ?? 'Observed'} · ${String(row.name ?? '')} · ${row.kind === 'chat' ? ['Say', 'Shout', 'Party', 'Notice'][Number(row.channel)] ?? 'Chat' : 'Emote'}: ${String(row.text ?? '')}`)).join('\n');
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

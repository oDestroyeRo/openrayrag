import type { ManualSocialAction } from './social-protocol';
export const SOCIAL_WINDOW_MS = 10_000;

export const SOCIAL_HISTORY_COUNT = 200;

export const SOCIAL_HISTORY_BYTES = 32 * 1024;

export const encoder = new TextEncoder();

export interface SocialContext {
  ready: boolean; actorId: number | null; name: string; job: number | null;
  learnedBasic: number | null; inParty: boolean; silenced: boolean;
}

export interface SocialEntry {
  sequence: number; at: number; kind: 'chat' | 'emote'; direction: 'sent' | 'received';
  actorId: number; name: string; text: string; channel?: number; emoteId?: number;
  state: 'sent' | 'echo' | 'unconfirmed' | 'observed';
}

export interface SocialSnapshot {
  generation: number; pending: boolean; reason: string; state: 'idle' | 'sent' | 'echo' | 'unconfirmed';
  shoutWaitMs: number; emoteWaitMs: number; history: SocialEntry[];
}

export function displayText(value: string, bytes: number): string {
  if (encoder.encode(value).length <= bytes) return value;
  const marker = '… [truncated]', budget = bytes - encoder.encode(marker).length;
  let result = '', size = 0;
  for (const char of value) { const count = encoder.encode(char).length; if (size + count > budget) break; result += char; size += count; }
  return result + marker;
}

export function fingerprint(action: ManualSocialAction): string { return JSON.stringify(action); }

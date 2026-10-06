import { BitReader, BitWriter } from '../../shared/binary';
import catalog from '../../data/emote-catalog.json';

export const SOCIAL_OP = { chat: 44, emote: 54 } as const;
export const EMOTES: ReadonlyArray<{ id: number; label: string }> = catalog.items;
const emoteIds = new Set(EMOTES.map(item => item.id));
// The server's Encoding.UTF8.GetString preserves a leading U+FEFF. Do not use
// BitReader.string's legacy BOM-stripping decoder for opaque social text/name.
const socialUtf8 = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
const socialString = (reader: BitReader): string => socialUtf8.decode(reader.take(reader.u16()));
export type ChatChannel = 0 | 1 | 2;
export type ManualSocialAction = { type: 'chat'; channel: ChatChannel; text: string } | { type: 'emote'; id: number };
export type SocialEvent = { type: 'chat'; actorId: number; channel: ChatChannel | 3; text: string; name: string }
  | { type: 'emote'; actorId: number; id: number };

export function validateChatText(value: unknown): string {
  // Unicode White_Space matches Rust is_whitespace and the server's whitespace
  // handling. Accepted content is never trimmed, parsed or normalized.
  if (typeof value !== 'string' || !value.length || value.length > 140 || /^\p{White_Space}+$/u.test(value))
    throw new Error('Enter a message of 1–140 UTF-16 units, including a non-whitespace character.');
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(++i);
      if (!(next >= 0xdc00 && next <= 0xdfff)) throw new Error('Message contains an incomplete Unicode character.');
    } else if (code >= 0xdc00 && code <= 0xdfff) throw new Error('Message contains an incomplete Unicode character.');
  }
  return value;
}
export function validateSocialAction(value: unknown): ManualSocialAction {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid manual social request.');
  const v = value as Record<string, unknown>;
  const keys = v.type === 'chat' ? ['type', 'channel', 'text'] : ['type', 'id'];
  if (Object.keys(v).length !== keys.length || Object.keys(v).some(key => !keys.includes(key))) throw new Error('Unknown social request fields.');
  if (v.type === 'chat' && [0, 1, 2].includes(v.channel as number)) return { type: 'chat', channel: v.channel as ChatChannel, text: validateChatText(v.text) };
  if (v.type === 'emote' && typeof v.id === 'number' && emoteIds.has(v.id)) return { type: 'emote', id: v.id };
  throw new Error('Choose a supported chat channel or player emote.');
}
export function socialCommand(input: ManualSocialAction): Uint8Array<ArrayBuffer> {
  const action = validateSocialAction(input), w = new BitWriter();
  return action.type === 'chat' ? w.u8(SOCIAL_OP.chat).string(action.text, 420).u8(action.channel).finish()
    : w.u8(SOCIAL_OP.emote).i32(action.id).finish();
}
export function decodeSocial(data: Uint8Array): SocialEvent[] | null {
  if (data[0] !== SOCIAL_OP.chat && data[0] !== SOCIAL_OP.emote) return null;
  const r = new BitReader(data); const opcode = r.u8(), actorId = r.i32();
  if (actorId < (opcode === SOCIAL_OP.chat ? -1 : 0)) throw new Error('Invalid social actor ID.');
  let event: SocialEvent;
  if (opcode === SOCIAL_OP.chat) {
    const text = socialString(r), name = socialString(r), channel = r.u8();
    if (channel > 3) throw new Error('Unknown incoming chat channel.');
    event = { type: 'chat', actorId, text, name, channel: channel as ChatChannel | 3 };
  } else event = { type: 'emote', actorId, id: r.i32() };
  r.finish(); return [event];
}

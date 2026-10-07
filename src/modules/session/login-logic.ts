import { identity } from 'effect/Function';
import { flatMap, fromNullishOr, getOrNull, none, some } from 'effect/Option';
import { getOrThrowWith, match, try as tryResult, type Result } from 'effect/Result';
import { DomainValueError, type Milliseconds } from '../../shared/domain-values';

declare const characterSlotValue: unique symbol;
export type CharacterSlot = number & { readonly [characterSlotValue]: 'CharacterSlot' };
export function characterSlot(value: unknown): CharacterSlot {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 2) throw new DomainValueError('CharacterSlot', 'range', 'login settings.');
  return value as CharacterSlot;
}
export interface LoginSelection { readonly username: string; readonly characterSlot: CharacterSlot }
/** Credentials stay in the mutable caller-owned draft and are cleared after dispatch. */
export interface LoginProfile {
  username: string;
  password: string;
  characterSlot: number;
}
export interface LoginStatus {
  readonly phase: 'idle' | 'signingIn' | 'selecting' | 'entering' | 'complete' | 'failed' | 'cancelled';
  readonly message: string;
}
export interface UnityClient {
  SendMessage(object: string, method: string, value?: string | number): void;
}
export interface LoginDriver {
  prepare(profile: LoginProfile, active: () => boolean): Promise<void>;
  submit(): void;
  selectionReady(): boolean;
  // false means the enter request has not been dispatched yet.
  select(slot: CharacterSlot): boolean | void;
}

// ConnectionApproved starts with a single bit, so its remaining fields are unaligned.
class LoginReader {
  private bit = 8;
  constructor(private readonly data: Uint8Array) {}
  number(bits: number): number {
    if (this.bit + bits > this.data.length * 8) throw new Error('Truncated character list');
    let result = 0;
    for (let i = 0; i < bits; i++, this.bit++) {
      result += ((this.data[this.bit >>> 3]! >>> (this.bit & 7)) & 1) * 2 ** i;
    }
    return result;
  }
  skip(bytes: number): void {
    if (!Number.isInteger(bytes) || bytes < 0 || this.bit + bytes * 8 > this.data.length * 8) {
      throw new Error('Invalid character list length');
    }
    this.bit += bytes * 8;
  }
  string(): string {
    const size = this.number(16);
    if (size > 256) throw new Error('Invalid character name');
    return new TextDecoder('utf-8', { fatal: true }).decode(
      Uint8Array.from({ length: size }, () => this.number(8)),
    );
  }
}

export function characterSlots(data: Uint8Array): readonly CharacterSlot[] {
  return getOrThrowWith(characterSlotsResult(data), identity);
}
function characterSlotsResult(data: Uint8Array): Result<readonly CharacterSlot[], unknown> {
  return tryResult(() => readCharacterSlots(data));
}
function readCharacterSlots(data: Uint8Array): readonly CharacterSlot[] {
  if (data[0] !== 0 || data.length > 16_384) throw new Error('Unknown character list');
  const reader = new LoginReader(data);
  if (reader.number(1)) {
    const length = reader.number(32);
    if (length > 4096) throw new Error('Invalid token length');
    reader.skip(length); // Never interpret or retain an authentication token.
  }
  const count = reader.number(32);
  if (count > 3) throw new Error('Unknown character count');
  const slots: CharacterSlot[] = [];
  for (let i = 0; i < count; i++) {
    const name = reader.string();
    const slot = reader.number(32);
    reader.string(); // Map is unnecessary for character selection.
    const size = reader.number(32);
    if (!name || slot > 2 || slots.some(saved => saved === slot) || size > 256 || size % 4 !== 0) {
      throw new Error('Unknown character layout');
    }
    reader.skip(size);
    slots.push(characterSlot(slot));
  }
  return slots;
}

export function loginActive(status: LoginStatus): boolean {
  return ['signingIn', 'selecting', 'entering'].includes(status.phase);
}
export function validateLoginProfile(profile: LoginProfile): LoginSelection {
  if (!profile.username.trim() || !profile.password || !Number.isInteger(profile.characterSlot)
    || profile.characterSlot < 0 || profile.characterSlot > 2) throw new Error('Invalid login settings.');
  return { username: profile.username, characterSlot: characterSlot(profile.characterSlot) };
}
export function loginPacketStatus(status: LoginStatus, data: Uint8Array, slot: CharacterSlot): LoginStatus | null {
  return getOrNull(flatMap(loginActive(status) ? fromNullishOr(data[0]) : none<number>(), (opcode) => {
    if (opcode === 1 || opcode === 32) return some<LoginStatus>({ phase: 'failed', message: 'Sign-in was rejected. Check the game window and try again explicitly.' });
    if (opcode !== 0 || status.phase !== 'signingIn') return none<LoginStatus>();
    return some(match(characterSlotsResult(data), {
      onSuccess: slots => slots.includes(slot)
        ? { phase: 'selecting' as const, message: `Selecting character slot ${slot + 1}…` }
        : { phase: 'failed' as const, message: `Character slot ${slot + 1} is empty. Choose an existing character.` },
      onFailure: () => ({ phase: 'failed' as const, message: 'The character list format changed. Select your character manually.' }),
    }));
  }));
}
export function selectionReadiness(ready: boolean, since: Milliseconds | null, now: Milliseconds): { since: Milliseconds | null; settled: boolean } {
  const started = ready ? since ?? now : null;
  return { since: started, settled: started !== null && now - started >= 200 };
}

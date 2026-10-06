export interface LoginProfile {
  username: string;
  password: string;
  characterSlot: number;
}
export interface LoginStatus {
  phase: 'idle' | 'signingIn' | 'selecting' | 'entering' | 'complete' | 'failed' | 'cancelled';
  message: string;
}
export interface UnityClient {
  SendMessage(object: string, method: string, value?: string | number): void;
}
export interface LoginDriver {
  prepare(profile: LoginProfile, active: () => boolean): Promise<void>;
  submit(): void;
  selectionReady(): boolean;
  // false means the enter request has not been dispatched yet.
  select(slot: number): boolean | void;
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

export function characterSlots(data: Uint8Array): number[] {
  if (data[0] !== 0 || data.length > 16_384) throw new Error('Unknown character list');
  const reader = new LoginReader(data);
  if (reader.number(1)) {
    const length = reader.number(32);
    if (length > 4096) throw new Error('Invalid token length');
    reader.skip(length); // Never interpret or retain an authentication token.
  }
  const count = reader.number(32);
  if (count > 3) throw new Error('Unknown character count');
  const slots: number[] = [];
  for (let i = 0; i < count; i++) {
    const name = reader.string();
    const slot = reader.number(32);
    reader.string(); // Map is unnecessary for character selection.
    const size = reader.number(32);
    if (!name || slot > 2 || slots.includes(slot) || size > 256 || size % 4 !== 0) {
      throw new Error('Unknown character layout');
    }
    reader.skip(size);
    slots.push(slot);
  }
  return slots;
}

export function loginActive(status: LoginStatus): boolean {
  return ['signingIn', 'selecting', 'entering'].includes(status.phase);
}
export function validateLoginProfile(profile: LoginProfile): void {
  if (!profile.username.trim() || !profile.password || !Number.isInteger(profile.characterSlot)
    || profile.characterSlot < 0 || profile.characterSlot > 2) throw new Error('Invalid login settings.');
}
export function loginPacketStatus(status: LoginStatus, data: Uint8Array, slot: number): LoginStatus | null {
  if (!loginActive(status)) return null;
  if (data[0] === 1 || data[0] === 32) return { phase: 'failed', message: 'Sign-in was rejected. Check the game window and try again explicitly.' };
  if (data[0] !== 0 || status.phase !== 'signingIn') return null;
  try {
    return characterSlots(data).includes(slot)
      ? { phase: 'selecting', message: `Selecting character slot ${slot + 1}…` }
      : { phase: 'failed', message: `Character slot ${slot + 1} is empty. Choose an existing character.` };
  } catch { return { phase: 'failed', message: 'The character list format changed. Select your character manually.' }; }
}
export function selectionReadiness(ready: boolean, since: number | null, now: number): { since: number | null; settled: boolean } {
  const started = ready ? since ?? now : null;
  return { since: started, settled: started !== null && now - started >= 200 };
}

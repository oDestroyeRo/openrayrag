import { SOCKET_URL } from './protocol';

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

const LOGIN = 'Canvas/Login Screen/LoginBoxWindow';
const USERNAME = `${LOGIN}/LoginBox/Login/Username/Title/InputField (TMP)`;
const PASSWORD = `${LOGIN}/LoginBox/Login/Password/Title/InputField (TMP)`;
const SERVER = `${LOGIN}/LoginBox/Server Settings/Username/Title/InputField (TMP)`;
const CHARACTERS = 'Canvas/Login Screen/CharacterCreator';
const SELECTION_PANE = `${CHARACTERS}/CharacterWindow/CharacterSelectPane`;
const SELECTION_OK = `${SELECTION_PANE}/BottomBar/OkButton`;
const SELECTION_SETTLE_MS = 200;
const READY_PROBE = '__rayrag_login_ready_probe__';

// Unity's WebGL SendMessage reports missing objects through its console, not a
// JavaScript exception. Observe only this synchronous call, retaining no log text.
function dispatch(client: UnityClient, object: string, method: string, value?: string | number) {
  let missing = false;
  let present = false;
  const originals = { log: console.log, warn: console.warn, error: console.error };
  for (const level of ['log', 'warn', 'error'] as const) {
    console[level] = (...args: unknown[]) => {
      if (args.some(arg => typeof arg === 'string' && /SendMessage:|Failed to execute SendMessage/.test(arg))) {
        missing = true;
        present ||= method === READY_PROBE && args.some(arg => typeof arg === 'string'
          && arg.includes(`SendMessage: object ${object} does not have receiver for function ${READY_PROBE}!`));
      }
      else originals[level](...args);
    };
  }
  try { client.SendMessage(object, method, value); } catch { missing = true; }
  finally { Object.assign(console, originals); }
  return { sent: !missing, present };
}

export function unityMessage(client: UnityClient, object: string, method: string, value?: string | number): boolean {
  return dispatch(client, object, method, value).sent;
}

function objectReady(client: UnityClient, object: string): boolean {
  // A nonexistent method is a harmless positive probe: the native diagnostic
  // distinguishes an active object from one that has not finished loading.
  return dispatch(client, object, READY_PROBE).present;
}

export function loginReady(client: UnityClient): boolean {
  return objectReady(client, LOGIN);
}

class SelectionDispatchError extends Error {
  constructor(stage: 'slot' | 'enter') {
    super(stage === 'slot'
      ? 'Could not select the requested slot. Choose your character in the game window.'
      : 'Could not enter with the selected character. Continue in the game window.');
  }
}

export function loginDriver(client: UnityClient): LoginDriver {
  let selectedSlot: number | null = null;
  let enterAttempted = false;
  const selectionReady = () => objectReady(client, CHARACTERS)
    && objectReady(client, SELECTION_PANE) && objectReady(client, SELECTION_OK);
  const message = (object: string, method: string, value?: string | number) => {
    if (!unityMessage(client, object, method, value)) throw new Error('Game interface unavailable');
  };
  return {
    async prepare(profile, active) {
      if (!active()) return;
      // SendMessage resolves only active objects, so expose the server input first.
      message(LOGIN, 'ChangeTabs', 2);
      message(SERVER, 'SetTextWithoutNotify', SOCKET_URL);
      message(LOGIN, 'ChangeTabs', 0);
      message(USERNAME, 'SetTextWithoutNotify', profile.username);
      message(PASSWORD, 'SetTextWithoutNotify', profile.password);
    },
    submit: () => message(LOGIN, 'AttemptLogin'),
    selectionReady,
    select(slot) {
      if (enterAttempted) return true;
      // Recheck immediately before either dispatch. A shared parent also hosts
      // character creation, so its existence alone cannot prove selection ready.
      if (!selectionReady()) return false;
      if (selectedSlot === null) {
        if (!unityMessage(client, CHARACTERS, 'SetCharacterInfo', slot)) throw new SelectionDispatchError('slot');
        selectedSlot = slot;
        // Let Unity finish applying the selected slot before the enter request.
        return false;
      }
      if (selectedSlot !== slot) throw new SelectionDispatchError('slot');
      enterAttempted = true;
      if (!unityMessage(client, CHARACTERS, 'ClickOk')) throw new SelectionDispatchError('enter');
      return true;
    },
  };
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

export class LoginController {
  status: LoginStatus = { phase: 'idle', message: '' };
  private slot = 0;
  private deadline = 0;
  private selectionReadySince: number | null = null;
  constructor(private readonly driver: LoginDriver, private readonly now = Date.now) {}
  get active(): boolean {
    return ['signingIn', 'selecting', 'entering'].includes(this.status.phase);
  }
  private fail(message: string): void { this.status = { phase: 'failed', message }; }
  async start(profile: LoginProfile): Promise<void> {
    if (this.status.phase !== 'idle') throw new Error('Reopen the game for a new sign-in attempt.');
    if (!profile.username.trim() || !profile.password || !Number.isInteger(profile.characterSlot)
      || profile.characterSlot < 0 || profile.characterSlot > 2) throw new Error('Invalid login settings.');
    this.slot = profile.characterSlot;
    this.deadline = this.now() + 30_000;
    this.status = { phase: 'signingIn', message: 'Signing in through the game…' };
    try {
      await this.driver.prepare(profile, () => this.active);
      if (this.active) this.driver.submit();
    } catch {
      if (this.active) this.fail('The game login interface changed. Sign in manually or update Companion.');
    } finally {
      profile.password = '';
    }
  }
  receive(data: Uint8Array): void {
    if (!this.active) return;
    if (data[0] === 1 || data[0] === 32) {
      this.fail('Sign-in was rejected. Check the game window and try again explicitly.');
    } else if (data[0] === 0 && this.status.phase === 'signingIn') {
      try {
        if (!characterSlots(data).includes(this.slot)) {
          this.fail(`Character slot ${this.slot + 1} is empty. Choose an existing character.`);
          return;
        }
        this.selectionReadySince = null;
        this.status = { phase: 'selecting', message: `Selecting character slot ${this.slot + 1}…` };
        this.deadline = this.now() + 30_000;
      } catch {
        this.fail('The character list format changed. Select your character manually.');
      }
    }
  }
  tick(): void {
    if (!this.active) return;
    if (this.now() > this.deadline) {
      this.fail('Sign-in timed out. Check the game connection.');
      return;
    }
    if (this.status.phase === 'selecting') {
      let ready = false;
      try { ready = this.driver.selectionReady(); } catch { /* Read-only preflight; wait until its bounded deadline. */ }
      if (!ready) { this.selectionReadySince = null; return; }
      this.selectionReadySince ??= this.now();
      if (this.now() - this.selectionReadySince < SELECTION_SETTLE_MS) return;
      try {
        if (this.driver.select(this.slot) === false) return;
        this.status = { phase: 'entering', message: 'Entering the field…' };
        this.deadline = this.now() + 30_000;
      } catch (error) {
        this.fail(error instanceof SelectionDispatchError ? error.message : 'Could not select the character. Continue in the game window.');
      }
    }
  }
  complete(): void {
    if (this.active) this.status = { phase: 'complete', message: 'Signed in. Your character is ready.' };
  }
  disconnect(): void { if (this.active) this.fail('Game disconnected during sign-in.'); }
  cancel(): void {
    if (this.active || this.status.phase === 'idle') {
      this.status = { phase: 'cancelled', message: 'Automatic sign-in cancelled. Continue manually or reopen the game.' };
    }
  }
}

import {
  characterSlot,
  loginActive,
  loginPacketStatus,
  selectionReadiness,
  validateLoginProfile,
  type LoginProfile,
  type LoginStatus,
  type LoginDriver,
} from './login-logic';
import { addMilliseconds, milliseconds, type Milliseconds } from '../../shared/domain-values';
import { SelectionDispatchError } from './login-effects';
export {
  characterSlots,
  type LoginProfile,
  type LoginStatus,
  type UnityClient,
  type LoginDriver,
} from './login-logic';
export { unityMessage, loginReady } from './login-effects';
export { loginDriver } from './login-driver';

export class LoginController {
  status: LoginStatus = { phase: 'idle', message: '' };
  private slot = characterSlot(0);
  private deadline = milliseconds(0);
  private selectionReadySince: Milliseconds | null = null;
  constructor(
    private readonly driver: LoginDriver,
    private readonly now = Date.now,
  ) {}
  get active(): boolean {
    return loginActive(this.status);
  }
  private fail(message: string): void {
    this.status = { phase: 'failed', message };
  }
  async start(profile: LoginProfile): Promise<void> {
    if (this.status.phase !== 'idle') throw new Error('Reopen the game for a new sign-in attempt.');
    const selection = validateLoginProfile(profile);
    this.slot = selection.characterSlot;
    this.deadline = addMilliseconds(milliseconds(this.now()), milliseconds(30_000));
    this.status = { phase: 'signingIn', message: 'Signing in through the game…' };
    try {
      await this.driver.prepare(profile, () => this.active);
      if (this.active) this.driver.submit();
    } catch {
      if (this.active)
        this.fail('The game login interface changed. Sign in manually or update Companion.');
    } finally {
      profile.password = '';
    }
  }
  receive(data: Uint8Array): void {
    const next = loginPacketStatus(this.status, data, this.slot);
    if (!next) return;
    this.status = next;
    if (next.phase === 'selecting') {
      this.selectionReadySince = null;
      this.deadline = addMilliseconds(milliseconds(this.now()), milliseconds(30_000));
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
      try {
        ready = this.driver.selectionReady();
      } catch {
        /* Read-only preflight; wait until its bounded deadline. */
      }
      const readiness = selectionReadiness(
        ready,
        this.selectionReadySince,
        milliseconds(this.now()),
      );
      this.selectionReadySince = readiness.since;
      if (!readiness.settled) return;
      try {
        if (this.driver.select(this.slot) === false) return;
        this.status = { phase: 'entering', message: 'Entering the field…' };
        this.deadline = addMilliseconds(milliseconds(this.now()), milliseconds(30_000));
      } catch (error) {
        this.fail(
          error instanceof SelectionDispatchError
            ? error.message
            : 'Could not select the character. Continue in the game window.',
        );
      }
    }
  }
  complete(): void {
    if (this.active)
      this.status = { phase: 'complete', message: 'Signed in. Your character is ready.' };
  }
  disconnect(): void {
    if (this.active) this.fail('Game disconnected during sign-in.');
  }
  cancel(): void {
    if (this.active || this.status.phase === 'idle') {
      this.status = {
        phase: 'cancelled',
        message: 'Automatic sign-in cancelled. Continue manually or reopen the game.',
      };
    }
  }
}

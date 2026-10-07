import { validateControllerUpdateCheckpoint } from './controller-update';
import type { ValidatedControllerUpdateCheckpoint } from './controller-update-logic';
import { validStatus, type GameStatus } from '../client/game-status';
import type { PersistentFieldRun } from '../session/reconnect';

import {
  type UpdateAccount,
  type ValidatedUpdateAccount,
  type UpdateContinuation,
  type Invoke,
  record,
  ERROR,
  updateRequestId,
  nativeUpdateReservation,
  type NativeUpdateReservation,
  type UpdateCommand,
  validateUpdateContinuation as validateUpdateContinuationAt,
  sameUpdateAccount,
  type Reply,
  type InstallationAdapter,
  type UpdateInstallationResult,
  type UpdateStep,
  deferredReason,
} from './update-continuation-logic';

export {
  type UpdateAccount,
  type UpdateContinuation,
  type UpdateContinuationInput,
  type ValidatedUpdateAccount,
  sameUpdateAccount,
  type UpdateInstallationResult,
} from './update-continuation-logic';

/** Own update installation and its one-shot claim. Stop invalidates every outstanding reply. */
export class UpdateContinuationOwner {
  private continuation: UpdateContinuation | null = null;
  private reply: Reply | null = null;
  private epoch = 0;
  private restoring = false;
  private blocked = false;
  private installing = false;
  private stoppedByUser = false;
  constructor(
    private readonly invoke: Invoke,
    private readonly id = () => crypto.randomUUID().replaceAll('-', ''),
    private readonly timeoutMs = 30_000,
  ) {}
  get pending(): boolean {
    return this.continuation !== null;
  }
  get inFlight(): boolean {
    return this.restoring;
  }
  get confirmationLost(): boolean {
    return this.blocked;
  }
  get stopped(): boolean {
    return this.stoppedByUser;
  }
  get account(): ValidatedUpdateAccount | null {
    return this.continuation ? { ...this.continuation.account } : null;
  }
  get needsSignIn(): boolean {
    return this.continuation !== null && !this.continuation.savedAccount;
  }
  claim(input: unknown, fieldRun: PersistentFieldRun): UpdateContinuation | null {
    if (input === null) return null;
    const continuation = validateUpdateContinuation(input);
    if (fieldRun.requested) throw new Error(ERROR);
    if (continuation.field) {
      fieldRun.restore(continuation.field);
      // Apply the final frozen old-page readback before seeing a fresh successor.
      fieldRun.observe(continuation.runtime.status, continuation.runtime.frozenAt);
    }
    this.continuation = continuation;
    this.blocked = false;
    return structuredClone(continuation);
  }
  async claimFrom(
    load: Promise<unknown>,
    fieldRun: PersistentFieldRun,
    retired = false,
  ): Promise<UpdateContinuation | null> {
    const epoch = this.epoch,
      input = await load;
    if (epoch !== this.epoch || this.stoppedByUser || input === null) return null;
    const continuation = validateUpdateContinuation(input);
    if (retired) fieldRun.stop();
    return this.claim(continuation, fieldRun);
  }
  async startup(fieldRun: PersistentFieldRun): Promise<UpdateContinuation | null> {
    const stopped = await this.invoke('update_startup_stopped').catch((error) => {
      this.stoppedByUser = true;
      throw error;
    });
    this.stoppedByUser ||= stopped === true;
    if (this.stoppedByUser) return null;
    return this.claimFrom(this.invoke('update_continuation'), fieldRun);
  }
  /** Own the entire update transaction; the window adapter only presents it. */
  async install(
    fieldRun: PersistentFieldRun,
    adapter: InstallationAdapter,
  ): Promise<UpdateInstallationResult> {
    if (this.installing || this.pending) throw new Error('An update handoff is already pending.');
    this.installing = true;
    this.stoppedByUser = false;
    const epoch = this.epoch;
    const preparing = () => epoch === this.epoch && !adapter.interrupted();
    const result: UpdateInstallationResult = {
      continuation: null,
      retired: false,
      recoveryFailed: false,
    };
    let reservation: NativeUpdateReservation | null = null;
    let step: UpdateStep = 'settings';
    try {
      adapter.status('Saving current settings before updating.');
      const document = await adapter.flush();
      if (!preparing()) return result;
      const game = adapter.game();
      let active =
        fieldRun.requested ||
        game.status?.runRequested === true ||
        (!!game.status?.macro &&
          ['running', 'waiting', 'monitoring'].includes(game.status.macro.state));
      if (game.open && active) {
        step = 'prepare';
        adapter.status(
          'Pausing new decisions and waiting for the current action to finish. Stop cancels continuation.',
        );
        const checkpoint = await this.prepare();
        if (!preparing()) return result;
        if (!validStatus(checkpoint.status)) throw new Error('Update handoff is unavailable.');
        // Reserve only after the final old-page counters spend the original allowances.
        fieldRun.observe(checkpoint.status, checkpoint.frozenAt);
        active = fieldRun.requested || checkpoint.settings !== null || checkpoint.macro !== null;
      }
      step = 'reserve';
      adapter.status('Preparing the connection for update confirmation.');
      reservation = nativeUpdateReservation(
        await this.invoke('update_reserve', {
          document,
          continuation: active ? { version: 1, field: fieldRun.checkpoint() } : null,
        }),
      );
      if (!preparing()) return result;
      step = 'confirmation';
      adapter.status(
        'Update waits for game confirmation that all actions have stopped. It will retry automatically.',
      );
      for (let attempt = 0; attempt < 20; attempt++) {
        if (epoch !== this.epoch) return result;
        if (await this.invoke('update_install', { nonce: reservation.rawNonce })) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    } catch (error) {
      adapter.status(deferredReason(step, error));
    } finally {
      if (reservation?.rawNonce)
        await this.invoke('update_release', { nonce: reservation.rawNonce }).catch(() => {});
      if (!adapter.game().open && epoch === this.epoch) {
        try {
          result.continuation = await this.claimFrom(
            this.invoke('update_continuation'),
            fieldRun,
            true,
          );
        } catch {
          result.recoveryFailed = true;
        }
        result.retired = !this.pending;
      }
      if (!this.pending) await this.cancel().catch(() => {});
      this.installing = false;
    }
    return result;
  }
  /** A replacement close belongs to install; an ordinary close retires ownership. */
  gameClosed(): boolean {
    if (this.installing || this.pending) return false;
    void this.cancel().catch(() => {});
    return true;
  }
  automaticLogin(profile: UpdateAccount | null): boolean {
    return (
      !!this.continuation?.savedAccount &&
      !!profile &&
      sameUpdateAccount(this.continuation.account, profile)
    );
  }
  private exchange(command: UpdateCommand, args: Record<string, unknown>): Promise<unknown> {
    if (this.reply) return Promise.reject(new Error('An update handoff is already pending.'));
    const requestId = updateRequestId(this.id());
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.reply?.id !== requestId) return;
        this.reply = null;
        this.blocked = true;
        reject(
          new Error('Update handoff confirmation timed out. Press Stop before starting again.'),
        );
      }, this.timeoutMs);
      this.reply = { id: requestId, command, resolve, reject, timer };
      void this.invoke(command, { ...args, requestId }).catch(() => {
        if (this.reply?.id !== requestId) return;
        clearTimeout(timer);
        this.reply = null;
        reject(new Error('Update handoff is unavailable.'));
      });
    });
  }
  prepared(input: unknown): void {
    if (
      !record(input) ||
      this.reply?.command !== 'update_prepare' ||
      input.requestId !== this.reply.id ||
      !Object.hasOwn(input, 'checkpoint')
    )
      return;
    const reply = this.reply!;
    clearTimeout(reply.timer);
    this.reply = null;
    reply.resolve(input.checkpoint);
  }
  restored(input: unknown): void {
    if (
      !record(input) ||
      this.reply?.command !== 'update_restore' ||
      input.requestId !== this.reply.id ||
      typeof input.success !== 'boolean'
    )
      return;
    const reply = this.reply!;
    clearTimeout(reply.timer);
    this.reply = null;
    if (input.success) reply.resolve(true);
    else reply.reject(new Error('Waiting for fresh, settled character data before continuing.'));
  }
  async prepare(): Promise<ValidatedControllerUpdateCheckpoint> {
    return validateControllerUpdateCheckpoint(await this.exchange('update_prepare', {}));
  }
  async resume(
    status: GameStatus,
    account: UpdateAccount,
    fieldRun: PersistentFieldRun,
  ): Promise<boolean> {
    const c = this.continuation;
    if (
      !c ||
      this.installing ||
      this.stoppedByUser ||
      this.restoring ||
      this.blocked ||
      !status.connected ||
      !status.compatible ||
      !status.player ||
      status.sessionId === c.runtime.status.sessionId ||
      status.player.name !== c.runtime.status.player?.name ||
      !sameUpdateAccount(c.account, account) ||
      fieldRun.limitReason
    )
      return false;
    const request = c.field ? fieldRun.resumeFor(status, { settledUpdate: true }) : null;
    if (c.field && !request) return false;
    const epoch = this.epoch;
    this.restoring = true;
    try {
      await this.exchange('update_restore', {
        checkpoint: c.runtime,
        ...(request
          ? {
              settings: request.settings,
              escapeGuard: request.escapeGuard,
              supplyGuard: request.supplyGuard,
              deathRecoveryGuard: request.deathRecoveryGuard,
            }
          : {}),
      });
      if (epoch !== this.epoch || this.continuation !== c) return false;
      if (request) fieldRun.completeResume(request, true);
      this.continuation = null;
      return true;
    } catch (error) {
      if (request && epoch === this.epoch) fieldRun.completeResume(request, false);
      throw error;
    } finally {
      this.restoring = false;
    }
  }
  cancel(stop = false): Promise<unknown> {
    if (stop) this.stoppedByUser = true;
    this.epoch++;
    this.continuation = null;
    this.blocked = false;
    if (this.reply) {
      clearTimeout(this.reply.timer);
      this.reply.reject(new Error('Update continuation cancelled by Stop.'));
      this.reply = null;
    }
    return this.invoke('update_cancel', { stop });
  }
}

export function validateUpdateContinuation(input: unknown, now = Date.now()): UpdateContinuation {
  return validateUpdateContinuationAt(input, now);
}

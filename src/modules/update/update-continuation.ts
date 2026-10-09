import { validateControllerUpdateCheckpoint } from './controller-update';
import type { ValidatedControllerUpdateCheckpoint } from './controller-update-logic';
import { validStatus, type GameStatus } from '../client/game-status';
import type { PersistentFieldRun } from '../session/reconnect';
import type { LogEntry } from '../automation/engine';
import {
  updatePresentation,
  updateVersion,
  type UpdateDiagnostic,
  type UpdateTransition,
} from './update-presentation-logic';

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
  type UpdateInstallationOptions,
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
  private continuationSource: 'startup' | 'recovery' | null = null;
  private reply: Reply | null = null;
  private epoch = 0;
  private restoring = false;
  private blocked = false;
  private installing = false;
  private stoppedByUser = false;
  private diagnostic: UpdateDiagnostic | null = null;
  private activity: LogEntry[] = [];
  private deferrals = 0;
  constructor(
    private readonly invoke: Invoke,
    private readonly id = () => crypto.randomUUID().replaceAll('-', ''),
    private readonly timeoutMs = 30_000,
    private readonly now = Date.now,
  ) {}
  get history(): readonly LogEntry[] {
    return this.activity.map((entry) => ({ ...entry }));
  }
  presentation(): { active: boolean; reason: string } {
    return updatePresentation(this.diagnostic, this.installing, this.now(), !this.blocked);
  }
  canInstall(targetVersion: unknown, requested = false): boolean {
    if (this.blocked) return false;
    return (
      requested ||
      this.diagnostic?.stage !== 'deferred' ||
      this.diagnostic.targetVersion !== updateVersion(targetVersion) ||
      this.now() >= this.diagnostic.retryAt
    );
  }
  private transition(stage: UpdateTransition, message: string, retryAt = 0): void {
    const previous = this.diagnostic;
    this.diagnostic = {
      installedVersion: previous?.installedVersion ?? null,
      targetVersion: previous?.targetVersion ?? null,
      startedAt: previous?.startedAt ?? this.now(),
      stage,
      at: this.now(),
      message,
      retryAt,
    };
    if (previous?.stage === stage && previous.message === message && previous.retryAt === retryAt)
      return;
    this.activity.unshift({
      at: this.now(),
      text: updatePresentation(this.diagnostic, false, this.now(), !this.blocked).reason,
    });
    this.activity.length = Math.min(this.activity.length, 50);
  }
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
    this.continuationSource = null;
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
    const claimed = this.claim(continuation, fieldRun);
    if (retired && claimed) {
      this.continuationSource = 'recovery';
      this.transition(
        'restore',
        'Update restart was not confirmed. Waiting for the same character to restore the interrupted run.',
      );
    }
    return claimed;
  }
  async startup(fieldRun: PersistentFieldRun): Promise<UpdateContinuation | null> {
    const stopped = await this.invoke('update_startup_stopped').catch((error) => {
      this.stoppedByUser = true;
      throw error;
    });
    this.stoppedByUser ||= stopped === true;
    if (this.stoppedByUser) return null;
    const epoch = this.epoch;
    const claimed = await this.claimFrom(this.invoke('update_continuation'), fieldRun);
    if (epoch === this.epoch && claimed && this.continuation) {
      // Only native startup consumes the version- and launch-bound restart checkpoint.
      this.continuationSource = 'startup';
      this.transition(
        'restore',
        'Verified update restart claimed. Waiting for character continuation.',
      );
    }
    return claimed;
  }
  /** Own the entire update transaction; the window adapter only presents it. */
  async install(
    fieldRun: PersistentFieldRun,
    adapter: InstallationAdapter,
    options: UpdateInstallationOptions = {},
  ): Promise<UpdateInstallationResult> {
    if (this.installing || this.pending) throw new Error('An update handoff is already pending.');
    const result: UpdateInstallationResult = {
      continuation: null,
      retired: false,
      recoveryFailed: false,
    };
    if (!this.canInstall(options.targetVersion, options.requested)) {
      adapter.status(this.presentation().reason);
      return result;
    }
    const targetVersion = updateVersion(options.targetVersion);
    if (this.diagnostic?.targetVersion !== targetVersion) this.deferrals = 0;
    const retry = this.diagnostic?.stage === 'deferred';
    this.diagnostic = {
      stage: 'settings',
      installedVersion: updateVersion(options.installedVersion),
      targetVersion,
      startedAt: this.now(),
      at: this.now(),
      message: '',
      retryAt: 0,
    };
    if (retry) this.transition('retry', 'Retrying update preparation. Stop cancels continuation.');
    this.installing = true;
    this.stoppedByUser = false;
    const epoch = this.epoch;
    const preparing = () => epoch === this.epoch && !adapter.interrupted();
    const present = (stage: UpdateStep, message: string) => {
      this.transition(stage, message);
      adapter.status(message);
    };
    let reservation: NativeUpdateReservation | null = null;
    let step: UpdateStep = 'settings';
    try {
      present('settings', 'Saving current settings before updating.');
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
        present(
          'prepare',
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
      present('reserve', 'Preparing the connection for update confirmation.');
      reservation = nativeUpdateReservation(
        await this.invoke('update_reserve', {
          document,
          continuation: active ? { version: 1, field: fieldRun.checkpoint() } : null,
        }),
      );
      if (!preparing()) return result;
      step = 'confirmation';
      present(
        'confirmation',
        'Update waits for game confirmation that all actions have stopped. It will retry automatically.',
      );
      let installed = false;
      for (let attempt = 0; attempt < 20; attempt++) {
        if (epoch !== this.epoch) return result;
        if (await this.invoke('update_install', { nonce: reservation.rawNonce })) {
          installed = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      if (!installed) throw new Error('Update confirmation is still pending.');
      // Successful native restart exits this process while update_install stays pending.
      // A truthy compatibility reply alone cannot prove installation or continuation.
    } catch (error) {
      if (epoch === this.epoch) {
        const message = deferredReason(step, error);
        this.deferrals++;
        this.transition(
          'deferred',
          message,
          this.now() + Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.min(this.deferrals - 1, 3)),
        );
        adapter.status(message);
      }
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
      if (this.continuationSource === 'startup') {
        this.deferrals = 0;
        this.transition('complete', 'Verified update restart and run continuation completed.');
      } else if (this.continuationSource === 'recovery') {
        this.transition(
          'recovered',
          'Interrupted run continuation confirmed. Update restart was not confirmed.',
        );
      }
      this.continuation = null;
      this.continuationSource = null;
      return true;
    } catch (error) {
      if (request && epoch === this.epoch) fieldRun.completeResume(request, false);
      throw error;
    } finally {
      this.restoring = false;
    }
  }
  cancel(stop = false, mcpOperation?: string): Promise<unknown> {
    if (stop) {
      this.stoppedByUser = true;
      if (this.installing || this.pending || this.reply)
        this.transition(
          'cancelled',
          'Stop cancelled update continuation. Automatic checks remain available.',
        );
    }
    this.epoch++;
    this.continuation = null;
    this.continuationSource = null;
    this.blocked = false;
    if (this.reply) {
      clearTimeout(this.reply.timer);
      this.reply.reject(new Error('Update continuation cancelled by Stop.'));
      this.reply = null;
    }
    return this.invoke('update_cancel', { stop, ...(mcpOperation ? { mcpOperation } : {}) }).catch(
      (error: unknown) => {
        this.blocked = true;
        this.transition(
          'deferred',
          'Update cancellation could not be confirmed. Press Stop before starting again.',
          this.now() + 30 * 60_000,
        );
        throw error;
      },
    );
  }
}

export function validateUpdateContinuation(input: unknown, now = Date.now()): UpdateContinuation {
  return validateUpdateContinuationAt(input, now);
}

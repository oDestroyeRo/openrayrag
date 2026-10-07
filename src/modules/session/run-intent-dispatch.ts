import { incrementRevision, revisionFor } from '../../shared/domain-values';
import type { PersistentFieldRun, ReconnectPolicy } from './reconnect';
import type { RunSession } from './reconnect-logic';
import type { SettingsInput } from '../settings/settings';
import type { RunLimitCause } from './run-limit-logic';

import {
  type DispatchOutcome,
  type DispatchReceipt,
  retiredOutcome,
  type PendingKind,
  type NativeDispatch,
} from './run-intent-dispatch-logic';

export { type DispatchOutcome, type DispatchReceipt } from './run-intent-dispatch-logic';

/** Owns dispatch lifetime; retiring intent never erases work already sent to native. */
export class RunIntentDispatch {
  private runOwner = revisionFor('dispatch-run', 0);
  private loginOwner = revisionFor('dispatch-login', 0);
  private connectionOwner = revisionFor('dispatch-connection', 0);
  private held = false;
  private stopTask: Promise<DispatchReceipt> | null = null;
  private readonly work: Record<PendingKind, Set<Promise<unknown>>> = {
    resume: new Set(),
    login: new Set(),
    service: new Set(),
    manual: new Set(),
    limit: new Set(),
  };

  constructor(
    private readonly field: PersistentFieldRun,
    private readonly reconnectPolicy: ReconnectPolicy,
    private readonly dispatch: NativeDispatch,
    private readonly now = Date.now,
  ) {}

  get pending(): Readonly<Record<PendingKind, boolean>> {
    return {
      resume: this.work.resume.size > 0,
      login: this.work.login.size > 0,
      service: this.work.service.size > 0,
      manual: this.work.manual.size > 0,
      limit: this.work.limit.size > 0,
    };
  }
  get stopping(): boolean {
    return this.stopTask !== null;
  }
  get limitHeld(): boolean {
    return this.held;
  }

  start(
    settings: SettingsInput,
    status: RunSession,
    mcpOperation?: string,
  ): Promise<DispatchReceipt> {
    if (this.stopping || !status.player)
      return Promise.resolve(this.receipt({ status: 'retired' }, () => false));
    const owner = (this.runOwner = incrementRevision(this.runOwner));
    const character = status.player.name,
      session = status.sessionId;
    this.field.begin(settings, character, session, {
      kills: status.kills ?? 0,
      looted: status.looted ?? 0,
      deaths: status.deaths ?? 0,
      attacks: status.attacks ?? 0,
      runExperience: status.runExperience,
    });
    this.held = false;
    const supplyGuard = this.field.supplyGuardForStart(settings, character, session);
    const deathRecoveryGuard = this.field.deathGuardForStart(settings, character, session);
    return this.track(
      'resume',
      async () => {
        try {
          const value = await this.dispatch('control_bot', {
            ...(mcpOperation ? { mcpOperation } : {}),
            action: 'start',
            settings,
            escapeGuard: this.field.guardForStart(settings, character, session),
            supplyGuard,
            deathRecoveryGuard,
          });
          if (owner !== this.runOwner) return { status: 'retired' };
          this.field.completeSupplyStart(character, session, supplyGuard);
          this.field.completeDeathStart(character, session, deathRecoveryGuard);
          return { status: 'accepted', value };
        } catch (error) {
          if (owner !== this.runOwner) return { status: 'retired' };
          this.field.stop();
          return { status: 'failed', error };
        }
      },
      () => owner === this.runOwner,
    );
  }

  resume(status: RunSession): Promise<DispatchReceipt> | null {
    if (this.stopping || this.pending.resume) return null;
    const request = this.field.resumeFor(status);
    if (!request) return null;
    const owner = this.runOwner;
    return this.track(
      'resume',
      async () => {
        try {
          const value = await this.dispatch('control_bot', {
            action: 'start',
            settings: request.settings,
            escapeGuard: request.escapeGuard,
            supplyGuard: request.supplyGuard,
            deathRecoveryGuard: request.deathRecoveryGuard,
            liveSettingsGuard: request.liveSettingsGuard,
          });
          if (owner !== this.runOwner || !this.field.completeResume(request, true))
            return { status: 'retired' };
          return { status: 'accepted', value };
        } catch (error) {
          if (owner !== this.runOwner || !this.field.completeResume(request, false))
            return { status: 'retired' };
          return { status: 'failed', error };
        }
      },
      () => owner === this.runOwner,
    );
  }
  applySettings(
    settings: SettingsInput,
    status: RunSession,
    id: string,
    mcpOperation?: string,
  ): Promise<DispatchReceipt> {
    if (this.stopping || !this.field.registerSettingsApply(id, status))
      return Promise.resolve(this.receipt({ status: 'retired' }, () => false));
    const owner = this.runOwner;
    return this.track(
      'manual',
      async () => {
        try {
          const value = await this.dispatch('control_bot', {
            ...(mcpOperation ? { mcpOperation } : {}),
            action: 'apply',
            settings,
            applyId: id,
          });
          return owner === this.runOwner ? { status: 'accepted', value } : { status: 'retired' };
        } catch (error) {
          this.field.cancelSettingsApply(id);
          return owner === this.runOwner ? { status: 'failed', error } : { status: 'retired' };
        }
      },
      () => owner === this.runOwner,
    );
  }

  login(request: unknown, mcpOperation?: string): Promise<DispatchReceipt> {
    if (this.stopping) return Promise.resolve(this.receipt({ status: 'retired' }, () => false));
    this.reconnectPolicy.signIn();
    return this.signIn('login_game', { request, ...(mcpOperation ? { mcpOperation } : {}) });
  }

  reconnect(): Promise<DispatchReceipt> {
    if (this.stopping) return Promise.resolve(this.receipt({ status: 'retired' }, () => false));
    return this.signIn('reconnect_game');
  }

  private signIn(
    command: 'login_game' | 'reconnect_game',
    args?: Record<string, unknown>,
  ): Promise<DispatchReceipt> {
    const owner = (this.loginOwner = incrementRevision(this.loginOwner));
    return this.track(
      'login',
      async () => {
        try {
          const value = await this.dispatch(command, args);
          return owner === this.loginOwner ? { status: 'accepted', value } : { status: 'retired' };
        } catch (error) {
          if (owner !== this.loginOwner) return { status: 'retired' };
          if (command === 'reconnect_game') {
            if (typeof error === 'string' && /(?:sign in|account)/i.test(error))
              this.reconnectPolicy.observe(
                false,
                false,
                'failed',
                this.now(),
                'Explicit sign-in required.',
              );
            else this.reconnectPolicy.networkFailure(this.now());
          }
          return { status: 'failed', error };
        }
      },
      () => owner === this.loginOwner,
    );
  }

  feature(action: string, request: unknown, mcpOperation?: string): Promise<DispatchReceipt> {
    if (this.stopping) return Promise.resolve(this.receipt({ status: 'retired' }, () => false));
    const replacesField = action === 'service' || action === 'macro';
    const manualTarget =
      action === 'command' &&
      request !== null &&
      typeof request === 'object' &&
      'type' in request &&
      request.type === 'manualTarget';
    const owner =
      replacesField || manualTarget
        ? (this.runOwner = incrementRevision(this.runOwner))
        : this.runOwner;
    const connection = this.connectionOwner;
    const pendingResume = replacesField ? [...this.work.resume] : [];
    if (replacesField) this.retireField();
    else if (manualTarget) this.reconnectPolicy.cancel();
    return this.track(
      action === 'service' ? 'service' : 'manual',
      async () => {
        try {
          if (pendingResume.length) await Promise.allSettled(pendingResume);
          if (owner !== this.runOwner || this.stopping) return { status: 'retired' };
          const value = await this.dispatch('control_bot', {
            action,
            request,
            ...(mcpOperation ? { mcpOperation } : {}),
          });
          // Macro execution can activate farming after its caller has been retired.
          // Manual targeting only needs this fence while an explicit Stop is draining.
          if (
            connection === this.connectionOwner &&
            owner !== this.runOwner &&
            (action === 'macro' || (manualTarget && this.stopping))
          )
            await this.dispatch('control_bot', { action: 'stop' });
          return owner === this.runOwner ? { status: 'accepted', value } : { status: 'retired' };
        } catch (error) {
          return owner === this.runOwner ? { status: 'failed', error } : { status: 'retired' };
        }
      },
      () => owner === this.runOwner,
    );
  }

  stop(beforeDispatch?: Promise<unknown>, mcpOperation?: string): Promise<DispatchReceipt> {
    if (this.stopTask) return this.stopTask;
    const owner = (this.runOwner = incrementRevision(this.runOwner));
    this.loginOwner = incrementRevision(this.loginOwner);
    this.retireField();
    // Snapshot before the first await and before registering the Stop barrier.
    // Limit holds only wait for login/resume, so neither barrier can wait on itself.
    const pending = Object.values(this.work).flatMap((tasks) => [...tasks]);
    const current = () => owner === this.runOwner;
    const barrier = beforeDispatch
      ? beforeDispatch
          .catch(() => {})
          .then(() => this.stopFence(pending, current, undefined, mcpOperation))
      : this.stopFence(pending, current, undefined, mcpOperation);
    const task = barrier
      .then((outcome) => this.receipt(outcome, current))
      .finally(() => {
        if (this.stopTask === task) this.stopTask = null;
      });
    this.stopTask = task;
    return task;
  }

  holdAtRunLimit(gameOpen: boolean): Promise<DispatchReceipt> | null {
    if (!gameOpen || !this.field.limitReason || this.held || this.pending.limit || this.stopping)
      return null;
    const owner = this.runOwner;
    const pending = [...this.work.resume, ...this.work.login];
    return this.track(
      'limit',
      async () => {
        const result = await this.stopFence(
          pending,
          () => owner === this.runOwner && !!this.field.limitReason,
          this.field.limitCause!,
        );
        if (result.status === 'accepted' && owner === this.runOwner && this.field.limitReason)
          this.held = true;
        return result;
      },
      () => owner === this.runOwner && !!this.field.limitReason,
    );
  }

  gameClosed(): void {
    this.connectionOwner = incrementRevision(this.connectionOwner);
    this.runOwner = incrementRevision(this.runOwner);
    this.loginOwner = incrementRevision(this.loginOwner);
    this.retireField();
  }

  private retireField(): void {
    this.field.stop();
    this.reconnectPolicy.cancel();
    this.held = false;
  }

  private async stopFence(
    pending: Promise<unknown>[],
    current: () => boolean,
    runLimit?: RunLimitCause,
    mcpOperation?: string,
  ): Promise<DispatchOutcome> {
    let result: DispatchOutcome;
    const request = {
      action: 'stop',
      ...(runLimit ? { runLimit } : {}),
      ...(mcpOperation ? { mcpOperation } : {}),
    };
    try {
      result = { status: 'accepted', value: await this.dispatch('control_bot', request) };
    } catch (error) {
      result = { status: 'failed', error };
    }
    // Even a failed immediate Stop cannot release controls while activation is pending.
    if (pending.length) {
      await Promise.allSettled(pending);
      if (!current()) return { status: 'retired' };
      try {
        result = { status: 'accepted', value: await this.dispatch('control_bot', request) };
      } catch (error) {
        result = { status: 'failed', error };
      }
    }
    return current() ? result : { status: 'retired' };
  }

  private receipt(outcome: DispatchOutcome, current: () => boolean): DispatchReceipt {
    const settled = Object.freeze(outcome);
    return Object.freeze({
      get outcome(): DispatchOutcome {
        return current() ? settled : retiredOutcome;
      },
    });
  }

  private track(
    kind: PendingKind,
    operation: () => Promise<DispatchOutcome>,
    current: () => boolean,
  ): Promise<DispatchReceipt> {
    const task = operation()
      .then((outcome) => this.receipt(outcome, current))
      .finally(() => {
        this.work[kind].delete(task);
      });
    this.work[kind].add(task);
    return task;
  }
}

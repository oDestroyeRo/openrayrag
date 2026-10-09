import {
  initializationCertificate,
  initializationResetCandidate,
  initializationResetAllowed,
  initializationIdentityCurrent,
  shouldSendPlayerReady,
} from './runtime-initialization-policy';
import { controlStopReason, type RunLimitCause } from '../session/run-limit-logic';
import { wireController } from './controller-wire';
import type { CompanionController } from './controller';
import type {
  ControllerUpdateCheckpoint,
  ControllerUpdateRestore,
} from '../update/controller-update';
import { OP, VERIFIED_BUILD } from '../protocol/protocol';
import { MaintenanceLease } from './maintenance';
import type { LoginStatus } from '../session/login';
import { currentMapInfo, type MapCatalog } from '../navigation/map-data';

export type DirectEvent =
  | { kind: 'opened' }
  | { kind: 'readySent' }
  | { kind: 'enterSent' | 'frame'; bytes: number[] }
  | { kind: 'closed'; reason: string }
  | { kind: 'failed'; reason: string };
export interface RuntimePort {
  invoke(name: string, args: unknown): Promise<unknown>;
  store: ConstructorParameters<typeof CompanionController>[8];
  now?: () => number;
  guardNonce?: string;
}
interface MaintenanceOwner {
  nonce: string;
  revision: number;
}
interface MaintenanceRequest {
  owner: MaintenanceOwner;
  commit: boolean;
  checking: boolean;
}
/** Transport projection only: both modes retain the same controller and action policies. */
export class DirectRuntime {
  readonly controller: CompanionController;
  private readonly lease: MaintenanceLease;
  private readonly now: () => number;
  private queue = Promise.resolve();
  private writes = new Set<Promise<unknown>>();
  private polling = false;
  private opened = false;
  private ended = false;
  private heartbeat = 0;
  private login: LoginStatus = { phase: 'signingIn', message: 'Opening verified bot connection.' };
  private entered = false;
  private enterCount = 0;
  private initial = false;
  private full = false;
  private memo = false;
  private readyPending = false;
  private firstResources = false;
  private firstOwnSeen = false;
  private resources: string | null = null;
  private refineResources: string | null = null;
  private own: string | null = null;
  private certificate = false;
  private resetAllowed = false;
  private initializationHeld = false;
  private nonce: string | null = null;
  private maintenanceOwner: MaintenanceOwner | null = null;
  private pendingMaintenance: MaintenanceRequest | null = null;
  private probing = false;
  private publishing = false;
  private lastPublished = 0;
  private updateRequest: { id: string; checking: boolean; prepared: boolean } | null = null;
  catalog: MapCatalog | null = null;
  catalogLoading = false;
  constructor(
    private readonly port: RuntimePort,
    readonly sessionId = crypto.randomUUID(),
    readonly connectionId = crypto.randomUUID(),
  ) {
    this.now = port.now ?? Date.now;
    this.lease = new MaintenanceLease(this.now);
    this.initializationHeld = port.store?.read() === true;
    this.controller = wireController(
      (packet) => {
        this.lease.assertDispatch();
        if (!this.opened || this.ended) throw new Error('Bot connection closed.');
        const write = this.send(packet);
        void write.catch(() => {});
        return write;
      },
      {
        read: () => port.store?.read() ?? false,
        write: (held) => {
          if (!held && this.initializationHeld && !this.resetAllowed)
            throw new Error('Authoritative first-entry certificate is incomplete.');
          port.store?.write(held);
          if (!held && this.port.guardNonce) {
            const task = this.publish().then(() =>
              this.port.invoke('warp_guard_clear', {
                identity: this.args(),
                permit: this.port.guardNonce,
              }),
            );
            this.writes.add(task);
            void task.catch(() => {}).finally(() => this.writes.delete(task));
          }
        },
      },
      this.now,
    );
  }
  private args(extra: Record<string, unknown> = {}) {
    return { sessionId: this.sessionId, connectionId: this.connectionId, ...extra };
  }
  async connect(): Promise<void> {
    try {
      await this.port.invoke('direct_connect', this.args());
    } catch {
      this.terminal('Explicit sign-in is required. Reconnect this account from the client.', false);
    }
  }
  private mutate() {
    this.pendingMaintenance = null;
    this.lease.mutate();
    if (this.nonce)
      void this.port
        .invoke('update_invalidate', { nonce: this.nonce, kind: 'frame' })
        .catch(() => {});
  }
  private send(packet: Uint8Array): Promise<unknown> {
    this.lease.assertDispatch();
    if (!this.opened || this.ended) throw new Error('Bot connection closed.');
    const task = this.port.invoke('direct_send', this.args({ bytes: Array.from(packet) }));
    this.writes.add(task);
    void task
      .catch(() =>
        this.terminal('Transport write failed. Pending outcomes remain unresolved.', true),
      )
      .finally(() => this.writes.delete(task));
    return task;
  }
  private terminal(reason: string, retryable: boolean) {
    if (this.ended) return;
    this.mutate();
    this.ended = true;
    this.opened = false;
    this.login = this.entered
      ? { phase: 'complete', message: 'Connection closed.' }
      : {
          phase: 'failed',
          message: retryable ? 'Game disconnected during sign-in. Try reconnecting.' : reason,
        };
    this.controller.disconnect();
    this.controller.engine.reason = reason;
    void this.publish();
  }
  /** Native has already discarded credentials, approval bodies and optional token bytes. */
  receive(events: DirectEvent[]): Promise<void> {
    this.queue = this.queue
      .then(async () => {
        for (const event of events) {
          if (this.ended) break;
          await this.apply(event);
        }
      })
      .catch(() =>
        this.terminal('Unverified game packet. Update Companion before reconnecting.', false),
      );
    return this.queue;
  }
  private async apply(event: DirectEvent): Promise<void> {
    this.mutate();
    if (event.kind === 'closed' || event.kind === 'failed') {
      this.terminal(
        event.reason,
        event.kind === 'closed' || /stream failed|timed out|TLS connection/.test(event.reason),
      );
      return;
    }
    if (event.kind === 'readySent') {
      if (!this.opened) throw new Error('Ready before connection');
      this.controller.observeOfficialPacket(new Uint8Array([2]));
      this.certificate = initializationCertificate({
        initial: this.initial,
        fullResources: this.full,
        memo: this.memo,
        readyObserved: true,
      });
      return;
    }
    if (event.kind === 'opened') {
      if (this.opened) throw new Error('Duplicate connection');
      this.opened = true;
      this.controller.connect(true);
      this.login = { phase: 'selecting', message: 'Selecting the requested existing character.' };
      return;
    }
    if (!this.opened) throw new Error('Frame before connection');
    const bytes = Uint8Array.from(event.bytes);
    if (event.kind === 'enterSent') {
      if (this.enterCount || this.login.phase !== 'selecting')
        throw new Error('Unexpected enter request');
      this.controller.observeOfficialPacket(bytes);
      this.login = { phase: 'entering', message: 'Waiting for authoritative character state.' };
      return;
    }
    const observation = this.controller.receive(
      bytes,
      this.controller.connectionGeneration,
      (before) => {
        const ownEntry = before.spawns.find(
          (e) => e.id === this.controller.engine.playerId && e.kind === 0,
        );
        if (ownEntry && !this.firstOwnSeen) {
          this.firstOwnSeen = true;
          const certificate = this.initial && this.certificate;
          const reset = { certificate, entryType: ownEntry.entryType, baseline: this.resources };
          if (
            initializationResetCandidate(reset) &&
            initializationResetAllowed({
              ...reset,
              current: this.controller.officialInitializationResourceRevision(),
            })
          )
            this.resetAllowed = true;
        }
      },
    );
    if (!observation) return;
    if (observation.enter) {
      this.enterCount++;
      this.initial = this.enterCount === 1;
      this.full = false;
      this.memo = false;
      this.firstResources = false;
      this.firstOwnSeen = false;
      this.resources = null;
      this.refineResources = null;
      this.own = null;
      this.certificate = false;
      this.readyPending = true;
    }
    if (observation.map) {
      this.initial = false;
      this.readyPending = true;
      this.certificate = false;
      this.own = null;
    }
    if (observation.clear) {
      this.certificate = false;
      this.own = null;
    }
    if (this.initial && observation.opcode === 56 && !this.firstResources) {
      this.firstResources = true;
      this.full = observation.fullResources;
      if (this.full) {
        this.resources = this.controller.officialInitializationResourceRevision();
        this.refineResources = this.controller.officialRefineResourceRevision();
      }
    }
    if (this.initial && observation.memoSlots) this.memo = true;
    // Initial full resources and memo are sent before PlayerReady. Map changes need
    // their applied reset only. A duplicate/stale opcode never supplies this proof.
    if (
      shouldSendPlayerReady({
        pending: this.readyPending,
        initial: this.initial,
        fullResources: this.full,
        memo: this.memo,
      })
    ) {
      this.readyPending = false;
      await this.send(new Uint8Array([2]));
      if (this.ended) return;
    }
    if (this.initial && observation.opcode === OP.spawn) {
      const own = observation.spawns.find(
        (e) => e.kind === 0 && e.id === this.controller.engine.playerId,
      );
      const identity = this.controller.engine.actorActionIdentity(undefined, true);
      this.own =
        this.certificate && own?.entryType === 1 && identity ? JSON.stringify(identity) : null;
    }
    this.reconcile();
    if (this.controller.engine.player) {
      this.entered = true;
      this.login = { phase: 'complete', message: 'Character connected. Bot controls are ready.' };
    }
  }
  private reconcile() {
    if (
      !initializationIdentityCurrent({
        certificate: this.certificate,
        own: this.own,
        current: JSON.stringify(this.controller.engine.actorActionIdentity(undefined, true)),
        blocked: this.lease.blocked,
        ended: this.ended,
      })
    )
      return;
    if (this.controller.warp.blocked) {
      if (
        this.resources !== null &&
        this.controller.reconcileOfficialInitialization(this.resources)
      )
        this.certificate = false;
    } else if (this.refineResources !== null) {
      this.controller.reconcileOfficialRefineInitialization(this.refineResources);
      this.certificate = false;
    }
  }
  async cycle(): Promise<void> {
    if (this.polling || this.ended) return;
    this.polling = true;
    try {
      const batch = (await this.port.invoke('direct_poll', this.args())) as {
        events: DirectEvent[];
        delivery: number | null;
      };
      if (
        !batch ||
        !Array.isArray(batch.events) ||
        batch.events.length > 16 ||
        (batch.delivery !== null && !Number.isSafeInteger(batch.delivery))
      )
        throw new Error('Invalid native event batch');
      await this.receive(batch.events);
      if (batch.delivery !== null)
        await this.port.invoke('direct_observed', this.args({ delivery: batch.delivery }));
      if (this.nonce && !this.probing) {
        this.probing = true;
        const nonce = this.nonce;
        const owner = this.maintenanceOwner;
        void this.port
          .invoke('update_lease_alive', { nonce })
          .then((alive) => {
            if (alive === false && owner) this.releaseMaintenance(owner);
          })
          .catch(() => {})
          .finally(() => {
            this.probing = false;
          });
      }
      if (!this.ended && !this.lease.blocked) {
        if (this.controller.active && this.now() - this.heartbeat > 6000)
          this.controller.heartbeat(false);
        this.controller.tick();
        this.reconcile();
      }
      if (this.now() - this.lastPublished >= 500) {
        this.lastPublished = this.now();
        await this.publish();
      }
    } catch {
      this.terminal('Bot connection unavailable. Pending outcomes remain unresolved.', true);
    } finally {
      this.polling = false;
      this.confirmPrepared();
      this.confirmMaintenance();
    }
  }
  control(
    action: 'start' | 'stop' | 'heartbeat' | 'apply',
    settings: Parameters<CompanionController['start']>[0],
    escapeGuard?: Parameters<CompanionController['start']>[1],
    supplyGuard?: Parameters<CompanionController['start']>[2],
    recoveryGuard?: Parameters<CompanionController['start']>[3],
    applyId?: string,
    liveSettingsGuard?: Parameters<CompanionController['start']>[4],
    runLimit?: RunLimitCause | null,
  ): void {
    const stopReason = controlStopReason(action, runLimit);
    this.lease.assertDispatch();
    this.mutate();
    if (action === 'heartbeat') {
      this.heartbeat = this.now();
      this.controller.heartbeat(true);
      return;
    }
    try {
      if (action === 'stop') {
        this.updateRequest = null;
        this.controller.stop(stopReason);
      } else {
        this.controller.heartbeat(true);
        if (action === 'apply') this.controller.applySettings(settings, applyId ?? '');
        else
          this.controller.start(
            settings,
            escapeGuard,
            supplyGuard,
            recoveryGuard,
            liveSettingsGuard,
          );
        this.heartbeat = this.now();
      }
    } catch (error) {
      this.controller.engine.reason = error instanceof Error ? error.message : 'Command failed.';
    }
    void this.publish();
  }
  perform(...args: Parameters<CompanionController['perform']>): void {
    try {
      this.lease.assertDispatch();
      this.mutate();
      this.controller.perform(...args);
      this.heartbeat = this.now();
    } catch (error) {
      this.controller.engine.reason = error instanceof Error ? error.message : 'Command failed.';
    }
    void this.publish();
  }
  prepareUpdate(requestId: string): void {
    if (
      !/^[a-f0-9]{32}$/.test(requestId) ||
      this.lease.blocked ||
      (this.updateRequest && this.updateRequest.id !== requestId)
    )
      return;
    if (!this.updateRequest) {
      this.mutate();
      this.updateRequest = { id: requestId, checking: false, prepared: false };
      this.controller.prepareUpdate();
    }
    this.confirmPrepared();
    void this.publish();
  }
  cancelUpdate(requestId: string): void {
    if (this.updateRequest?.id !== requestId) return;
    this.updateRequest = null;
    this.controller.cancelUpdate();
    this.heartbeat = this.now();
    void this.publish();
  }
  restoreUpdate(payload: ControllerUpdateRestore): void {
    if (!payload || !/^[a-f0-9]{32}$/.test(payload.requestId)) return;
    let success = false;
    try {
      this.lease.assertDispatch();
      this.mutate();
      this.controller.restoreUpdate(
        payload.checkpoint,
        payload.settings,
        payload.escapeGuard,
        payload.supplyGuard,
        payload.deathRecoveryGuard,
      );
      this.heartbeat = this.now();
      success = true;
    } catch (error) {
      this.controller.engine.reason =
        error instanceof Error ? error.message : 'Update continuation rejected.';
    }
    void this.port
      .invoke('update_restored', { requestId: payload.requestId, success })
      .catch(() => {});
    void this.publish();
  }
  private checkpoint(): ControllerUpdateCheckpoint | null {
    const value = this.controller.updateCheckpoint();
    return value ? { ...value, status: this.runtimeStatus(value.status) } : null;
  }
  private confirmPrepared(): void {
    const request = this.updateRequest;
    if (!request || request.checking || request.prepared || this.polling || this.lease.blocked)
      return;
    request.checking = true;
    void this.queue
      .then(async () => {
        await Promise.allSettled([...this.writes]);
        if (this.updateRequest !== request || this.polling || !this.maintenanceReady()) return;
        const value = this.checkpoint();
        if (!value) return;
        request.prepared = true;
        await this.port.invoke('update_prepared', { requestId: request.id, checkpoint: value });
      })
      .catch(() => {})
      .finally(() => {
        request.checking = false;
      });
  }
  maintenance(nonce: string, reserve: boolean | 'commit'): void {
    if (!reserve) {
      if (this.pendingMaintenance?.owner.nonce === nonce) this.pendingMaintenance = null;
      if (this.maintenanceOwner?.nonce === nonce) this.releaseMaintenance(this.maintenanceOwner);
      return;
    }
    if (reserve === 'commit') {
      const owner = this.maintenanceOwner;
      if (!owner || owner.nonce !== nonce || !this.lease.matches(nonce, owner.revision)) return;
      this.pendingMaintenance = { owner, commit: true, checking: false };
    } else {
      if (this.lease.blocked || !this.maintenanceReady()) return;
      this.pendingMaintenance = {
        owner: { nonce, revision: this.lease.ownerRevision },
        commit: false,
        checking: false,
      };
    }
    this.confirmMaintenance();
  }
  private maintenanceReady(): boolean {
    return (
      this.opened &&
      !this.ended &&
      this.writes.size === 0 &&
      this.login.phase === 'complete' &&
      this.controller.settledForMaintenance()
    );
  }
  private releaseMaintenance(owner: MaintenanceOwner): void {
    if (this.maintenanceOwner !== owner) return;
    this.lease.release(owner.nonce);
    this.nonce = null;
    this.maintenanceOwner = null;
    if (this.pendingMaintenance?.owner === owner) this.pendingMaintenance = null;
  }
  private confirmMaintenance(): void {
    const request = this.pendingMaintenance;
    if (!request || request.checking || this.polling) return;
    const { owner, commit } = request,
      { nonce, revision } = owner;
    if (this.lease.ownerRevision !== revision || !this.maintenanceReady()) {
      this.pendingMaintenance = null;
      if (!commit) this.releaseMaintenance(owner);
      return;
    }
    if (!commit && this.maintenanceOwner !== owner) {
      if (this.lease.reserve(nonce, true) !== revision) {
        this.pendingMaintenance = null;
        return;
      }
      this.nonce = nonce;
      this.maintenanceOwner = owner;
    }
    request.checking = true;
    void this.queue
      .then(async () => {
        // Includes each native flush promise. Native independently fences its queued
        // frames and pending writes while holding the update Gate lock.
        if (!commit) await Promise.allSettled([...this.writes]);
        if (this.pendingMaintenance !== request) return;
        request.checking = false;
        if (this.maintenanceOwner !== owner || !this.lease.matches(nonce, revision)) {
          this.pendingMaintenance = null;
          if (!commit) this.releaseMaintenance(owner);
          return;
        }
        // receive() can finish before delivery observation or status publication.
        // Retry only after cycle's finally clears polling, retaining this owner.
        if (this.polling) return;
        this.pendingMaintenance = null;
        if (!this.maintenanceReady()) {
          if (!commit) this.releaseMaintenance(owner);
          return;
        }
        if (commit) {
          const checkpoint = this.checkpoint();
          await this.port
            .invoke('update_final_ack', {
              nonce,
              identity: this.args(),
              revision,
              ...(checkpoint ? { checkpoint } : {}),
            })
            .catch(() => {});
          return;
        }
        this.lease.hold(nonce, revision);
        try {
          if (
            (await this.port.invoke('update_ack', { nonce, identity: this.args(), revision })) !==
            true
          )
            this.releaseMaintenance(owner);
        } catch {
          /* Keep frozen until native proves the lease released. */
        }
      })
      .catch(() => {
        /* Native release remains authoritative after a failed confirmation. */
      });
  }
  snapshot() {
    return this.controller.snapshot();
  }
  private runtimeStatus(status = this.controller.snapshot()) {
    return {
      ...status,
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      login: this.login,
      reconnectAvailable: false,
      build: VERIFIED_BUILD,
      connectionMode: 'botOnly',
      mapInfo: currentMapInfo(
        this.controller.engine.map,
        this.controller.engine.entities.values(),
        this.catalog,
        this.catalogLoading,
      ),
    };
  }
  async publish() {
    if (this.publishing) return;
    this.publishing = true;
    try {
      await this.port.invoke('bridge_status', { status: this.runtimeStatus() });
    } catch {
      if (this.controller.active) this.controller.heartbeat(false);
    } finally {
      this.publishing = false;
    }
  }
}

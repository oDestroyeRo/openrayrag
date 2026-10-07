import { minutes, minutesToMilliseconds } from '../../shared/domain-values';
import { reachedRunLimit, runLimitReason, type RunLimitCause } from './run-limit-logic';
import {
  addExperience,
  experienceDifference,
  validRunExperience,
  type ExperienceGains,
  type RunExperience,
} from './run-experience-logic';
import {
  deathLimitGuidance,
  farmingDestination,
  validateDeathRecoveryGuard,
  type DeathRecoveryGuard,
} from '../recovery/death-recovery';
import {
  validateSettings,
  settingsDraft,
  type SettingsInput as Settings,
  type RunSettings,
} from '../settings/settings';
import { validateSupplyResumeGuard, type SupplyResumeGuard } from '../services/supply-trip-logic';
import {
  CONSERVATIVE_ESCAPE_RECOVERY,
  escapeRecovery,
  validateEscapeResumeGuard,
  type EscapeResumeGuard,
} from '../recovery/escape-logic';
import {
  acknowledgedLiveSettings,
  mergeLiveSettingsGuards,
  validSettingsApplyId,
  validSettingsApplySnapshot,
  validateLiveSettingsGuard,
  type LiveSettingsGuard,
} from '../settings/live-settings-logic';

import {
  INITIAL_DELAY,
  MAX_DELAY,
  transientFailure,
  type RunSession,
  type ResumeRequest,
  MAX_ESCAPE_GUARDS,
  type RetainedEscape,
  type RetainedSupply,
  type RetainedDeath,
  type FieldRunCheckpoint,
  type ValidatedFieldRunCheckpoint,
  sessionIdentity,
  timestamp,
  validateFieldRunCheckpoint as validateFieldRunCheckpointAt,
} from './reconnect-logic';

export { type RunSession, type ResumeRequest, type FieldRunCheckpoint } from './reconnect-logic';

/** Controller-side retry timing. Credentials stay in native session memory. */
export class ReconnectPolicy {
  private enabled = false;
  private persistent = false;
  private readySeen = false;
  private attempt = 0;
  private dueAt: number | null = null;
  private inFlight = false;
  private blocked = false;
  configure(enabled: boolean, accountAvailable: boolean, persistent = false): void {
    const next = enabled && accountAvailable;
    if (!next) {
      this.cancel();
      return;
    }
    this.enabled = true;
    this.persistent = persistent;
  }
  observe(connected: boolean, hasPlayer: boolean, phase: string, now: number, message = ''): void {
    if (connected && hasPlayer) {
      this.readySeen = this.enabled;
      this.attempt = 0;
      this.dueAt = null;
      this.inFlight = false;
      this.blocked = false;
      return;
    }
    if (phase === 'failed') {
      if (transientFailure(message)) {
        if (this.inFlight) this.networkFailure(now);
      } else {
        this.blocked = true;
        this.dueAt = null;
        this.inFlight = false;
      }
      return;
    }
    if (phase === 'cancelled') {
      this.blocked = true;
      this.dueAt = null;
      this.inFlight = false;
      return;
    }
    if (
      !connected &&
      this.enabled &&
      !this.blocked &&
      this.readySeen &&
      !this.inFlight &&
      this.dueAt === null
    ) {
      this.readySeen = false;
      this.attempt = 0;
      this.dueAt = now + INITIAL_DELAY;
    }
  }
  takeDue(now: number): number | null {
    if (!this.enabled || this.blocked || this.dueAt === null || now < this.dueAt || this.inFlight)
      return null;
    this.dueAt = null;
    this.inFlight = true;
    this.attempt++;
    return this.attempt;
  }
  networkFailure(now: number): void {
    this.inFlight = false;
    this.dueAt =
      this.enabled && !this.blocked && (this.persistent || this.attempt < 3)
        ? now + Math.min(MAX_DELAY, INITIAL_DELAY * 2 ** Math.min(this.attempt, 4))
        : null;
  }
  /** A fresh explicit sign-in may retry an account that was rejected. */
  signIn(): void {
    this.blocked = false;
    this.dueAt = null;
    this.inFlight = this.enabled;
    this.attempt = 0;
  }
  cancel(): void {
    this.enabled = false;
    this.persistent = false;
    this.readySeen = false;
    this.dueAt = null;
    this.inFlight = false;
    this.attempt = 0;
    this.blocked = false;
  }
  get waitingUntil(): number | null {
    return this.dueAt;
  }
  get requiresSignIn(): boolean {
    return this.blocked;
  }
}

/** Only field settings survive game-page reloads; workflows and passwords do not. */
export class PersistentFieldRun {
  private desired: RunSettings | null = null;
  private settingsApplyOwner: { id: string; session: string; character: string } | null = null;
  private resourceGuard: LiveSettingsGuard | null = null;
  private character = '';
  private session = '';
  private pendingSession = '';
  private generation = 0;
  private startedAt = 0;
  private metricsSession = '';
  private previous = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  private totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  private experienceGains: ExperienceGains | null = null;
  private experiencePrevious: RunExperience | null = null;
  private experienceCharacter = '';
  private experienceSession = '';
  private readonly escapeGuards = new Map<string, RetainedEscape>();
  private escapeOverflowUncertain = false;
  private readonly supplyGuards = new Map<string, RetainedSupply>();
  private supplyOverflow = false;
  private readonly deathGuards = new Map<string, RetainedDeath>();
  private deathOverflow = false;
  private settledUpdateSession = '';
  constructor(private readonly now = Date.now) {}
  checkpoint(): FieldRunCheckpoint | null {
    if (!this.desired) return null;
    if (this.settingsApplyOwner)
      throw new Error(
        'Wait for the settings Apply confirmation or Stop before continuing the run.',
      );
    return validateFieldRunCheckpoint(
      {
        version: 1,
        desired: this.desired,
        character: this.character,
        session: this.session,
        generation: this.generation,
        startedAt: this.startedAt,
        metricsSession: this.metricsSession,
        previous: this.previous,
        totals: this.totals,
        escapeGuard: this.escapeGuards.get(this.character) ?? null,
        experience: {
          gains: this.experienceGains ?? { baseGained: null, jobGained: null },
          previous: this.experiencePrevious,
          session: this.experienceSession,
        },
        supplyGuard: this.supplyGuards.get(this.character) ?? null,
        deathGuard: this.deathGuards.get(this.character) ?? null,
        escapeOverflowUncertain:
          this.escapeOverflowUncertain || this.escapeGuards.size >= MAX_ESCAPE_GUARDS,
        supplyOverflow: this.supplyOverflow || this.supplyGuards.size >= 64,
        deathOverflow: this.deathOverflow || this.deathGuards.size >= 64,
        liveSettingsGuard: this.resourceGuard,
      },
      this.now(),
    );
  }
  restore(checkpoint: unknown): void {
    if (this.desired) throw new Error('Stop the active field run before restoring its checkpoint.');
    const checked = validateFieldRunCheckpoint(checkpoint, this.now());
    if (
      (checked.escapeGuard &&
        !this.escapeGuards.has(checked.character) &&
        this.escapeGuards.size >= MAX_ESCAPE_GUARDS) ||
      (checked.supplyGuard &&
        !this.supplyGuards.has(checked.character) &&
        this.supplyGuards.size >= 64) ||
      (checked.deathGuard &&
        !this.deathGuards.has(checked.character) &&
        this.deathGuards.size >= 64)
    )
      throw new Error('Field run retained guard capacity exhausted.');
    const generation = Math.max(this.generation, checked.generation) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Field run generation exhausted.');
    this.desired = checked.desired;
    this.character = checked.character;
    this.session = checked.session;
    this.resourceGuard = checked.liveSettingsGuard ?? null;
    this.settingsApplyOwner = null;
    this.pendingSession = '';
    this.generation = generation;
    this.startedAt = checked.startedAt;
    this.metricsSession = checked.metricsSession;
    this.previous = checked.previous;
    this.totals = checked.totals;
    this.experienceCharacter = checked.character;
    this.experienceSession = checked.experience?.session ?? checked.session;
    this.experienceGains = checked.experience?.gains ?? { baseGained: null, jobGained: null };
    this.experiencePrevious = checked.experience?.previous ?? null;
    // Preserve unrelated in-memory character guards if restore is used in the
    // same controller; a checkpoint only owns its active character.
    if (checked.escapeGuard) this.escapeGuards.set(checked.character, checked.escapeGuard);
    if (checked.supplyGuard) this.supplyGuards.set(checked.character, checked.supplyGuard);
    if (checked.deathGuard) this.deathGuards.set(checked.character, checked.deathGuard);
    this.escapeOverflowUncertain ||= checked.escapeOverflowUncertain;
    this.supplyOverflow ||= checked.supplyOverflow;
    this.deathOverflow ||= checked.deathOverflow;
    this.settledUpdateSession = checked.session;
  }
  begin(
    settings: Settings,
    character: string,
    sessionId: string,
    metrics: {
      kills: number;
      looted: number;
      deaths: number;
      attacks?: number;
      runExperience?: RunExperience | null;
    } = { kills: 0, looted: 0, deaths: 0 },
  ): void {
    const checked = validateSettings(settings);
    // Reserve the first enabled allowance before native Start can outlive its
    // last publication. Default-off runs allocate no supply state.
    const initial =
      checked.automation?.supply?.enabled &&
      !this.supplyGuards.has(character) &&
      this.supplyGuards.size < 64
        ? validateSupplyResumeGuard({
            version: 1,
            character,
            latched: false,
            remainingTrips: checked.automation.supply.maxTrips,
            actions: 0,
            spent: 0,
            reserved: 0,
            intervalSeconds: 0,
            deadlineSeconds: 0,
            interrupted: false,
            uncertain: false,
            returnDestination: null,
          })
        : undefined;
    const previousDeath = this.deathGuards.get(character);
    if (previousDeath && !previousDeath.guard.uncertain) this.deathGuards.delete(character);
    this.desired = checked;
    this.settingsApplyOwner = null;
    this.resourceGuard = null;
    if (initial)
      this.supplyGuards.set(character, { session: sessionId, at: this.now(), guard: initial });
    this.pruneEscapeGuards();
    if (!this.escapeGuards.has(character) && this.escapeGuards.size < MAX_ESCAPE_GUARDS)
      this.escapeGuards.set(
        character,
        this.escapeOverflowUncertain
          ? { session: '', cooldownUntil: this.now() + 3_600_000, latched: true }
          : { session: sessionId, cooldownUntil: 0, latched: false },
      );
    this.character = character;
    this.session = sessionId;
    this.pendingSession = '';
    this.generation++;
    this.settledUpdateSession = '';
    this.startedAt = this.now();
    this.metricsSession = sessionId;
    this.previous = {
      kills: metrics.kills,
      looted: metrics.looted,
      deaths: metrics.deaths,
      attacks: metrics.attacks ?? 0,
    };
    this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
    this.experienceGains = { baseGained: 0, jobGained: 0 };
    this.experienceCharacter = character;
    this.experienceSession = sessionId;
    this.experiencePrevious =
      validRunExperience(metrics.runExperience) && metrics.runExperience.character === character
        ? { ...metrics.runExperience }
        : null;
  }
  stop(): void {
    this.settingsApplyOwner = null;
    this.resourceGuard = null;
    this.desired = null;
    this.character = '';
    this.session = '';
    this.pendingSession = '';
    this.generation++;
    this.settledUpdateSession = '';
    this.metricsSession = '';
    this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
    // Stop does not prove whether an already sent wing was consumed. Keep the
    // bounded cooldown through a subsequent explicit Start in this app session.
  }
  /** Frozen updater telemetry keeps its capture time so downtime spends timers. */
  observe(status: RunSession, observedAt = this.now()): void {
    if (!timestamp(observedAt) || observedAt > this.now()) return;
    this.observeExperience(status);
    const owner = this.settingsApplyOwner,
      receipt = status.settingsApply;
    if (
      owner &&
      this.desired &&
      status.sessionId === owner.session &&
      status.sessionId === this.session &&
      status.player?.name === owner.character &&
      validSettingsApplySnapshot(receipt) &&
      receipt.id === owner.id
    ) {
      if (receipt.state === 'applied' && status.runRequested && status.activeSettings) {
        try {
          if (!status.liveSettingsGuard)
            throw new Error('Live settings protection acknowledgement is missing.');
          const protection = mergeLiveSettingsGuards(
            this.resourceGuard,
            status.liveSettingsGuard,
            this.now(),
          );
          if (protection.character !== this.character)
            throw new Error('Live settings protection belongs to another character.');
          const desired = acknowledgedLiveSettings(this.desired, status.activeSettings);
          this.desired = desired;
          this.resourceGuard = protection;
          this.settingsApplyOwner = null;
        } catch {
          /* Invalid acknowledgement cannot replace original run intent. */
        }
      } else if (receipt.state === 'rejected' || receipt.state === 'cancelled')
        this.settingsApplyOwner = null;
    }
    if (
      this.resourceGuard &&
      status.sessionId === this.session &&
      status.player?.name === this.character &&
      status.liveSettingsGuard
    ) {
      try {
        const protection = validateLiveSettingsGuard(status.liveSettingsGuard, this.now());
        if (protection.character === this.character)
          this.resourceGuard = mergeLiveSettingsGuards(this.resourceGuard, protection, this.now());
      } catch {
        /* A malformed telemetry guard cannot replace retained protection. */
      }
    }
    if (status.deathRecoveryGuard) {
      try {
        const guard = validateDeathRecoveryGuard(status.deathRecoveryGuard),
          old = this.deathGuards.get(guard.character);
        if (
          status.connected &&
          status.compatible &&
          status.player?.name === guard.character &&
          ((!old && this.deathGuards.size < 64) ||
            old?.session === status.sessionId ||
            (this.desired &&
              this.character === guard.character &&
              guard.destination === farmingDestination(this.desired) &&
              (this.pendingSession === status.sessionId || this.session === status.sessionId)))
        )
          this.deathGuards.set(guard.character, {
            session: status.sessionId,
            at: observedAt,
            guard,
          });
      } catch {
        /* Unvalidated telemetry cannot change an outstanding death episode. */
      }
    } else if (status.runRequested && status.player?.dead === false) {
      const old = this.deathGuards.get(status.player.name);
      if (old?.session === status.sessionId) this.deathGuards.delete(status.player.name);
    }

    if (status.supplyGuard) {
      try {
        const guard = validateSupplyResumeGuard(status.supplyGuard),
          old = this.supplyGuards.get(guard.character);
        // A blank/new page cannot replenish the finite allowance of an older page.
        if (
          old?.session === status.sessionId ||
          (!old && this.supplyGuards.size < 64) ||
          (old && guard.remainingTrips < old.guard.remainingTrips)
        ) {
          if (old) {
            guard.remainingTrips = Math.min(old.guard.remainingTrips, guard.remainingTrips);
            if (guard.remainingTrips === old.guard.remainingTrips)
              guard.reserved = Math.max(old.guard.reserved, guard.reserved);
          }
          this.supplyGuards.set(guard.character, {
            session: status.sessionId,
            at: observedAt,
            guard,
          });
        } else if (!old) this.supplyOverflow = true;
      } catch {
        /* Ignore unvalidated guard telemetry. */
      }
    }
    if (
      status.escape &&
      Number.isInteger(status.escape.cooldownSeconds) &&
      status.escape.cooldownSeconds >= 0 &&
      status.escape.cooldownSeconds <= 3600
    ) {
      const name =
        status.player?.name ??
        [...this.escapeGuards].find(([, guard]) => guard.session === status.sessionId)?.[0];
      this.pruneEscapeGuards();
      if (!name && (status.escape.latched || status.escape.pending))
        this.escapeOverflowUncertain = true;
      if (name) {
        let guard = this.escapeGuards.get(name);
        if (
          !guard &&
          (status.escape.latched || status.escape.pending) &&
          this.escapeGuards.size < MAX_ESCAPE_GUARDS
        ) {
          guard = { session: status.sessionId, cooldownUntil: 0, latched: false };
          this.escapeGuards.set(name, guard);
        }
        if (!guard && (status.escape.latched || status.escape.pending))
          this.escapeOverflowUncertain = true;
        // A blank new page cannot erase an earlier page's spent episode.
        if (
          guard &&
          (status.sessionId === guard.session || status.escape.latched || status.escape.pending)
        ) {
          guard.cooldownUntil = Math.max(
            guard.cooldownUntil,
            observedAt + status.escape.cooldownSeconds * 1000,
          );
          if (status.escape.recovery) {
            try {
              validateEscapeResumeGuard({
                cooldownSeconds: 0,
                latched: true,
                recovery: status.escape.recovery,
              });
              const incoming = status.escape.recovery,
                previous = guard.recovery ?? CONSERVATIVE_ESCAPE_RECOVERY;
              guard.recovery = guard.latched
                ? {
                    hpPercent: Math.max(previous.hpPercent, incoming.hpPercent),
                    threatCount:
                      previous.threatCount && incoming.threatCount
                        ? Math.min(previous.threatCount, incoming.threatCount)
                        : previous.threatCount || incoming.threatCount,
                    quietSeconds: Math.max(previous.quietSeconds, incoming.quietSeconds),
                  }
                : { ...incoming };
            } catch {
              /* Invalid telemetry cannot weaken a retained episode. */
            }
          }
          guard.session = status.sessionId;
          guard.latched = status.escape.latched || status.escape.pending;
        }
      }
    }
    if (!this.desired || (status.player && status.player.name !== this.character)) return;
    const current = {
      kills: status.kills ?? 0,
      looted: status.looted ?? 0,
      deaths: status.deaths ?? 0,
      attacks: status.attacks ?? 0,
    };
    if (
      !sessionIdentity(status.sessionId) ||
      Object.values(current).some((value) => !Number.isSafeInteger(value) || value < 0)
    )
      return;
    if (status.sessionId !== this.metricsSession) {
      this.metricsSession = status.sessionId;
      this.previous = current;
      return;
    }
    for (const key of ['kills', 'looted', 'deaths', 'attacks'] as const) {
      this.totals[key] = Math.min(
        Number.MAX_SAFE_INTEGER,
        this.totals[key] +
          Math.max(
            0,
            current[key] >= this.previous[key] ? current[key] - this.previous[key] : current[key],
          ),
      );
    }
    this.previous = current;
  }
  private observeExperience(status: RunSession): void {
    if (
      !this.experienceGains ||
      !sessionIdentity(status.sessionId) ||
      (status.player && status.player.name !== this.experienceCharacter)
    )
      return;
    const current = status.runExperience,
      previous = this.experiencePrevious;
    if (!validRunExperience(current) || current.character !== this.experienceCharacter) {
      if (
        this.desired &&
        status.runRequested &&
        status.connected &&
        status.compatible &&
        status.player?.name === this.experienceCharacter
      )
        this.experienceGains = { baseGained: null, jobGained: null };
      return;
    }
    const sameStream = status.sessionId === this.experienceSession && current.run === previous?.run;
    if (status.sessionId === this.experienceSession && previous && current.run < previous.run)
      return;
    if (
      !sameStream &&
      status.sessionId !== this.session &&
      status.sessionId !== this.pendingSession
    )
      return;
    // Terminal telemetry can publish confirmed rewards after the player is
    // cleared. Only an already admitted stream has that authority.
    if (
      !sameStream &&
      (!this.desired ||
        !status.runRequested ||
        !status.connected ||
        !status.compatible ||
        status.player?.name !== this.experienceCharacter)
    )
      return;
    if (sameStream && current.revision <= previous!.revision) return;
    this.experienceGains = addExperience(
      this.experienceGains,
      sameStream ? experienceDifference(current, previous!) : current,
    );
    this.experiencePrevious = { ...current };
    this.experienceSession = status.sessionId;
  }
  /** Detached presentation of the active or completed explicit run. */
  experienceFor(status: RunSession): RunExperience | null | undefined {
    if (!this.experienceGains) return status.runExperience;
    if (
      !this.desired &&
      validRunExperience(status.runExperience) &&
      status.runExperience.character === status.player?.name &&
      (status.sessionId !== this.experienceSession ||
        status.runExperience.run !== this.experiencePrevious?.run)
    )
      return status.runExperience;
    if (status.player && status.player.name !== this.experienceCharacter) return null;
    return {
      character: this.experienceCharacter,
      run: this.experiencePrevious?.run ?? 1,
      revision: this.experiencePrevious?.revision ?? 0,
      ...this.experienceGains,
    };
  }
  private pruneEscapeGuards(): void {
    for (const [name, guard] of this.escapeGuards)
      if (
        !guard.latched &&
        guard.cooldownUntil <= this.now() &&
        (!this.desired || name !== this.character)
      )
        this.escapeGuards.delete(name);
  }
  get limitCause(): RunLimitCause | null {
    const a = this.desired?.automation;
    return a
      ? reachedRunLimit({
          limits: a.limits,
          elapsedMilliseconds: this.now() - this.startedAt,
          kills: this.totals.kills,
          pickups: this.totals.looted,
          respawn: a.respawn,
          deaths: this.totals.deaths,
        })
      : null;
  }
  get limitReason(): string {
    const cause = this.limitCause;
    if (!cause) return '';
    return cause === 'deaths'
      ? `Run limit reached: death limit. ${deathLimitGuidance(this.totals.deaths, this.desired!.automation!.respawn.maxDeaths)}`
      : runLimitReason(cause);
  }
  guardForStart(
    settings: Settings,
    character: string,
    sessionId: string,
  ): EscapeResumeGuard | undefined {
    this.pruneEscapeGuards();
    const guard = this.escapeGuards.get(character);
    if (!guard)
      return (settings.automation?.escape?.enabled || this.escapeOverflowUncertain) &&
        (this.escapeOverflowUncertain || this.escapeGuards.size >= MAX_ESCAPE_GUARDS)
        ? { latched: true, cooldownSeconds: 3600 }
        : undefined;
    if (sessionId === guard.session || (!guard.latched && guard.cooldownUntil <= this.now()))
      return undefined;
    return {
      latched: true,
      cooldownSeconds: Math.max(
        0,
        Math.min(3600, Math.ceil((guard.cooldownUntil - this.now()) / 1000)),
      ),
      ...(guard.recovery ? { recovery: { ...guard.recovery } } : {}),
    };
  }
  supplyGuardForStart(
    settings: Settings,
    character: string,
    sessionId: string,
    automatic = false,
  ): SupplyResumeGuard | undefined {
    const old = this.supplyGuards.get(character);
    if (!settings.automation?.supply?.enabled && !old) return undefined;
    if (!old)
      return this.supplyOverflow || this.supplyGuards.size >= 64
        ? {
            version: 1,
            character,
            latched: true,
            remainingTrips: 0,
            actions: 0,
            spent: 0,
            reserved: 0,
            intervalSeconds: 86400,
            deadlineSeconds: 0,
            interrupted: true,
            uncertain: true,
            returnDestination: null,
          }
        : undefined;
    const guard = structuredClone(old.guard),
      elapsed = Math.floor(Math.max(0, this.now() - old.at) / 1000);
    guard.intervalSeconds = Math.max(0, guard.intervalSeconds - elapsed);
    guard.deadlineSeconds = Math.max(0, guard.deadlineSeconds - elapsed);
    if (automatic && sessionId !== old.session) {
      if (!guard.returnDestination) guard.remainingTrips = Math.max(0, guard.remainingTrips - 1);
      guard.interrupted = true;
      guard.uncertain = true;
    }
    // An explicit Start may create a new field run after a canceled, reconciled
    // trip. Its spent trip allowance and latch survive; the old trip never resumes.
    if (!automatic && !guard.uncertain) {
      guard.interrupted = false;
      guard.returnDestination = null;
    }
    return validateSupplyResumeGuard(guard);
  }
  deathGuardForStart(
    settings: Settings,
    character: string,
    sessionId: string,
    automatic = false,
  ): DeathRecoveryGuard | undefined {
    const old = this.deathGuards.get(character);
    if (
      !settings.automation?.respawn.enabled &&
      !old &&
      !(automatic && this.desired?.automation?.respawn.enabled)
    )
      return undefined;
    if (old) {
      const guard = structuredClone(old.guard);
      // A replaced page loses wire ownership. A fresh ready living character can
      // reconcile it; a dead character cannot prove the old request was unsent.
      if (automatic && sessionId !== old.session && guard.phase === 'revival')
        guard.uncertain = true;
      return validateDeathRecoveryGuard(guard);
    }
    if (!automatic) return undefined;
    return {
      version: 1,
      character,
      destination: farmingDestination(settings),
      phase: this.deathOverflow || this.deathGuards.size >= 64 ? 'failed' : 'revival',
      uncertain: true,
      recoverySeconds: settings.automation!.recovery.timeoutSeconds,
      returnSeconds: 1200,
      recoveryDeadline: 0,
      returnDeadline: 0,
    };
  }
  completeDeathStart(character: string, sessionId: string, guard?: DeathRecoveryGuard): void {
    if (!guard) return;
    const checked = validateDeathRecoveryGuard(guard);
    if (checked.character !== character)
      throw new Error('Death recovery state belongs to another character.');
    const old = this.deathGuards.get(character);
    if (old?.session === sessionId) return; // Newer same-page receipts outrank an older callback.
    if (!old && this.deathGuards.size >= 64) {
      this.deathOverflow = true;
      return;
    }
    this.deathGuards.set(character, { session: sessionId, at: this.now(), guard: checked });
  }
  resumeFor(status: RunSession, options: { settledUpdate?: boolean } = {}): ResumeRequest | null {
    if (
      !this.desired ||
      this.settingsApplyOwner ||
      this.limitReason ||
      !status.connected ||
      !status.compatible ||
      !status.player ||
      status.player.name !== this.character ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(status.map) ||
      !sessionIdentity(status.sessionId) ||
      status.sessionId === this.session ||
      status.sessionId === this.pendingSession
    )
      return null;
    const settledUpdate =
      options.settledUpdate === true && this.settledUpdateSession === this.session;
    // A known rejection before activation can retry the same settled boundary.
    // Choosing ordinary reconnect forfeits that provenance immediately.
    if (!settledUpdate) this.settledUpdateSession = '';
    this.pendingSession = status.sessionId;
    const settings = settingsDraft(
      validateSettings({
        ...this.desired,
        map:
          this.desired.automation?.respawn.enabled ||
          this.desired.automation?.travel.returnToLockMap ||
          this.desired.automation?.mapPolicy?.lockArea
            ? farmingDestination(this.desired)
            : status.map,
      }),
    );
    if (settings.automation) {
      const a = settings.automation;
      // A new page has no captured leader association or explicit trip allowance.
      if (a.follow.mode === 'partyLeader') a.follow.rendezvous = false;
      if (a.limits.minutes)
        a.limits.minutes = Math.max(
          1,
          Math.ceil(
            (minutesToMilliseconds(minutes(a.limits.minutes)) - (this.now() - this.startedAt)) /
              60_000,
          ),
        );
      if (a.limits.kills) a.limits.kills -= this.totals.kills;
      if (a.limits.pickups) a.limits.pickups -= this.totals.looted;
      if (a.respawn.enabled) {
        const remaining = a.respawn.maxDeaths - this.totals.deaths;
        a.respawn.enabled = remaining > 0 || status.player.dead === true;
        a.respawn.maxDeaths = Math.max(0, remaining);
      }
    }
    // Ordinary reload publications may precede a consumed wing. Only a restored
    // settled update can transfer a known episode without adding uncertainty.
    const retained = this.guardForStart(settings, this.character, status.sessionId);
    const oldEscape = this.escapeGuards.get(this.character);
    let escapeGuard: EscapeResumeGuard | undefined;
    if (settledUpdate && oldEscape?.session === this.session) {
      // Native restore always requires reconciliation; avoid creating an
      // episode when the frozen owner has neither a latch nor a cooldown.
      if (oldEscape.latched || oldEscape.cooldownUntil > this.now())
        escapeGuard = {
          latched: oldEscape.latched,
          cooldownSeconds: Math.max(
            0,
            Math.min(3600, Math.ceil((oldEscape.cooldownUntil - this.now()) / 1000)),
          ),
          ...(oldEscape.recovery ? { recovery: { ...oldEscape.recovery } } : {}),
        };
    } else if (retained || settings.automation?.escape?.enabled) {
      escapeGuard = {
        ...(retained ?? { recovery: escapeRecovery(settings) }),
        latched: true,
        cooldownSeconds: Math.max(
          settings.automation?.escape?.enabled ? settings.automation.escape.cooldownSeconds : 0,
          retained?.cooldownSeconds ?? 0,
        ),
      };
    }
    const supplyOwner =
      settledUpdate && this.supplyGuards.get(this.character)?.session === this.session
        ? this.session
        : status.sessionId;
    const supplyGuard = this.supplyGuardForStart(settings, this.character, supplyOwner, true);
    const oldDeath = this.deathGuards.get(this.character);
    const deathRecoveryGuard =
      settledUpdate && !oldDeath && !this.deathOverflow && this.deathGuards.size < 64
        ? undefined
        : this.deathGuardForStart(
            settings,
            this.character,
            settledUpdate && oldDeath?.session === this.session ? this.session : status.sessionId,
            true,
          );
    if (
      deathRecoveryGuard &&
      status.player.dead === false &&
      deathRecoveryGuard.phase !== 'failed'
    ) {
      // Capture the maximum remaining cycle budget before invoking native Start.
      // A reload before its first bridge publication cannot create a new deadline.
      deathRecoveryGuard.recoveryDeadline ||=
        this.now() + deathRecoveryGuard.recoverySeconds * 1000;
      deathRecoveryGuard.returnDeadline ||=
        deathRecoveryGuard.recoveryDeadline + deathRecoveryGuard.returnSeconds * 1000;
    }
    return {
      generation: this.generation,
      sessionId: status.sessionId,
      settings: validateSettings(settings),
      ...(escapeGuard ? { escapeGuard } : {}),
      ...(supplyGuard ? { supplyGuard } : {}),
      ...(deathRecoveryGuard ? { deathRecoveryGuard } : {}),
      ...(this.resourceGuard ? { liveSettingsGuard: structuredClone(this.resourceGuard) } : {}),
    };
  }
  completeResume(request: ResumeRequest, success: boolean): boolean {
    if (
      request.generation !== this.generation ||
      request.sessionId !== this.pendingSession ||
      !this.desired
    )
      return false;
    if (
      request.supplyGuard &&
      validateSupplyResumeGuard(request.supplyGuard).character !== this.character
    )
      return false;
    this.pendingSession = '';
    if (success) {
      this.settledUpdateSession = '';
      this.session = request.sessionId;
      if (request.supplyGuard)
        this.completeSupplyStart(
          request.supplyGuard.character,
          request.sessionId,
          request.supplyGuard,
        );
      if (request.deathRecoveryGuard)
        this.completeDeathStart(this.character, request.sessionId, request.deathRecoveryGuard);
    }
    return true;
  }
  completeSupplyStart(character: string, sessionId: string, guard?: SupplyResumeGuard): void {
    const old = this.supplyGuards.get(character);
    if (!guard && !old) return;
    const requested = validateSupplyResumeGuard(guard ?? old!.guard);
    if (requested.character !== character)
      throw new Error('Supply guard belongs to another character.');
    if (!old && this.supplyGuards.size >= 64) {
      this.supplyOverflow = true;
      return;
    }
    let retained = requested;
    if (old) {
      const latest = structuredClone(old.guard),
        elapsed = Math.floor(Math.max(0, this.now() - old.at) / 1000);
      latest.intervalSeconds = Math.max(0, latest.intervalSeconds - elapsed);
      latest.deadlineSeconds = Math.max(0, latest.deadlineSeconds - elapsed);
      // A successful callback may follow a newer sent/reconciled publication.
      // Same-owner telemetry is authoritative; transfer must retain uncertainty.
      if (old.session === sessionId) retained = latest;
      else {
        retained.uncertain = retained.uncertain || latest.uncertain;
        retained.latched = retained.latched || latest.latched;
        retained.intervalSeconds = Math.max(retained.intervalSeconds, latest.intervalSeconds);
        if (latest.uncertain) {
          retained.interrupted = true;
          retained.returnDestination = latest.returnDestination ?? retained.returnDestination;
          retained.deadlineSeconds = latest.deadlineSeconds;
        }
      }
      retained.remainingTrips = Math.min(requested.remainingTrips, latest.remainingTrips);
      retained.reserved = Math.max(requested.reserved, latest.reserved);
    }
    this.supplyGuards.set(character, { session: sessionId, at: this.now(), guard: retained });
  }
  get metrics(): Readonly<typeof this.totals> {
    return { ...this.totals };
  }
  registerSettingsApply(id: string, status: RunSession): boolean {
    if (
      !validSettingsApplyId(id) ||
      !this.desired ||
      status.sessionId !== this.session ||
      status.player?.name !== this.character ||
      !status.runRequested
    )
      return false;
    this.settingsApplyOwner = { id, session: this.session, character: this.character };
    return true;
  }
  cancelSettingsApply(id: string): void {
    if (this.settingsApplyOwner?.id === id) this.settingsApplyOwner = null;
  }
  get activeSettings(): Settings | null {
    return this.desired ? structuredClone(this.desired) : null;
  }
  get liveSettingsGuard(): LiveSettingsGuard | null {
    return this.resourceGuard ? structuredClone(this.resourceGuard) : null;
  }
  get settingsApplyPending(): boolean {
    return this.settingsApplyOwner !== null;
  }
  settingsApplyWaitReason(sessionId: string): string {
    return this.settingsApplyOwner && sessionId !== this.settingsApplyOwner.session
      ? 'Previous runtime did not confirm settings Apply. Waiting safely; Stop cancels the pending change.'
      : '';
  }
  get targetIds(): number[] {
    return this.desired?.targets.slice() ?? [];
  }
  get requested(): boolean {
    return this.desired !== null;
  }
}

export function validateFieldRunCheckpoint(
  input: unknown,
  now = Date.now(),
): ValidatedFieldRunCheckpoint {
  return validateFieldRunCheckpointAt(input, now);
}

import { deathLimitGuidance, farmingDestination, validateDeathRecoveryGuard, type DeathRecoveryGuard } from './death-recovery';
import { validateSettings, type Settings } from './settings';
import { validateSupplyResumeGuard, type SupplyResumeGuard } from './supply-trip';
import { CONSERVATIVE_ESCAPE_RECOVERY, escapeRecovery, validateEscapeResumeGuard, type EscapeRecovery, type EscapeResumeGuard, type EscapeSnapshot } from './escape';

const INITIAL_DELAY = 5_000;
const MAX_DELAY = 60_000;
const transientFailure = (message: string): boolean => /(?:disconnected during sign-in|sign-in timed out)/i.test(message);

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
    if (!next) { this.cancel(); return; }
    this.enabled = true;
    this.persistent = persistent;
  }
  observe(connected: boolean, hasPlayer: boolean, phase: string, now: number, message = ''): void {
    if (connected && hasPlayer) {
      this.readySeen = this.enabled; this.attempt = 0; this.dueAt = null;
      this.inFlight = false; this.blocked = false;
      return;
    }
    if (phase === 'failed') {
      if (transientFailure(message)) {
        if (this.inFlight) this.networkFailure(now);
      } else { this.blocked = true; this.dueAt = null; this.inFlight = false; }
      return;
    }
    if (phase === 'cancelled') {
      this.blocked = true; this.dueAt = null; this.inFlight = false; return;
    }
    if (!connected && this.enabled && !this.blocked && this.readySeen && !this.inFlight && this.dueAt === null) {
      this.readySeen = false; this.attempt = 0; this.dueAt = now + INITIAL_DELAY;
    }
  }
  takeDue(now: number): number | null {
    if (!this.enabled || this.blocked || this.dueAt === null || now < this.dueAt || this.inFlight) return null;
    this.dueAt = null; this.inFlight = true; this.attempt++;
    return this.attempt;
  }
  networkFailure(now: number): void {
    this.inFlight = false;
    this.dueAt = this.enabled && !this.blocked && (this.persistent || this.attempt < 3)
      ? now + Math.min(MAX_DELAY, INITIAL_DELAY * 2 ** Math.min(this.attempt, 4)) : null;
  }
  /** A fresh explicit sign-in may retry an account that was rejected. */
  signIn(): void { this.blocked = false; this.dueAt = null; this.inFlight = this.enabled; this.attempt = 0; }
  cancel(): void {
    this.enabled = false; this.persistent = false; this.readySeen = false;
    this.dueAt = null; this.inFlight = false; this.attempt = 0; this.blocked = false;
  }
  get waitingUntil(): number | null { return this.dueAt; }
  get requiresSignIn(): boolean { return this.blocked; }
}

export interface RunSession {
  sessionId: string; connected: boolean; compatible: boolean; map: string;
  player: { name: string; dead?: boolean } | null; runRequested?: boolean;
  kills?: number; looted?: number; deaths?: number; attacks?: number;
  escape?: EscapeSnapshot; supplyGuard?:SupplyResumeGuard; deathRecoveryGuard?:DeathRecoveryGuard;
}
export interface ResumeRequest { generation: number; sessionId: string; settings: Settings; escapeGuard?: EscapeResumeGuard; supplyGuard?:SupplyResumeGuard; deathRecoveryGuard?:DeathRecoveryGuard }
const MAX_ESCAPE_GUARDS = 64;
interface RetainedEscape { session: string; cooldownUntil: number; latched: boolean; recovery?: EscapeRecovery }
interface FieldMetrics { kills: number; looted: number; deaths: number; attacks: number }
interface RetainedSupply { session: string; at: number; guard: SupplyResumeGuard }
interface RetainedDeath { session: string; at: number; guard: DeathRecoveryGuard }
/** A data-only updater checkpoint for the original requested field run. */
export interface FieldRunCheckpoint {
  version: 1; desired: Settings; character: string; session: string; generation: number;
  startedAt: number; metricsSession: string; previous: FieldMetrics; totals: FieldMetrics;
  escapeGuard: RetainedEscape | null; supplyGuard: RetainedSupply | null; deathGuard: RetainedDeath | null;
  escapeOverflowUncertain: boolean; supplyOverflow: boolean; deathOverflow: boolean;
}
const MAX_TIMESTAMP = 8_640_000_000_000_000;
const sessionIdentity = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const timestamp = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIMESTAMP;
function checkpointRecord(value: unknown, required: string[], optional: string[] = []): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
    || required.some(key => !Object.hasOwn(value, key))) throw new Error('Invalid field run checkpoint.');
  return value as Record<string, unknown>;
}
/** Validate completely before any run intent or retained allowance can change. */
export function validateFieldRunCheckpoint(value: unknown, now = Date.now()): FieldRunCheckpoint {
  const v = checkpointRecord(value, ['version', 'desired', 'character', 'session', 'generation', 'startedAt', 'metricsSession',
    'previous', 'totals', 'escapeGuard', 'supplyGuard', 'deathGuard', 'escapeOverflowUncertain', 'supplyOverflow', 'deathOverflow']);
  if (v.version !== 1 || typeof v.character !== 'string' || !v.character.trim() || v.character.length > 64
    || /[\u0000-\u001f\u007f]/.test(v.character)
    || /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v.character)
    || !sessionIdentity(v.session) || !sessionIdentity(v.metricsSession) || v.metricsSession !== v.session
    || !Number.isSafeInteger(v.generation) || Number(v.generation) < 1 || Number(v.generation) >= Number.MAX_SAFE_INTEGER
    || !timestamp(now) || !timestamp(v.startedAt) || v.startedAt > now
    || ['escapeOverflowUncertain', 'supplyOverflow', 'deathOverflow'].some(key => typeof v[key] !== 'boolean'))
    throw new Error('Invalid field run checkpoint identity or bounds.');
  const desired = validateSettings(v.desired as Settings);
  if (v.escapeGuard === null && !v.escapeOverflowUncertain
    || desired.automation?.supply?.enabled && v.supplyGuard === null && !v.supplyOverflow)
    throw new Error('Missing field run allowance state.');
  for (const metrics of [v.previous, v.totals]) {
    const counters = checkpointRecord(metrics, ['kills', 'looted', 'deaths', 'attacks']);
    if (Object.values(counters).some(counter => !Number.isSafeInteger(counter) || Number(counter) < 0))
      throw new Error('Invalid field run checkpoint counters.');
  }
  if (v.escapeGuard !== null) {
    const guard = checkpointRecord(v.escapeGuard, ['session', 'cooldownUntil', 'latched'], ['recovery']);
    // An empty owner is the existing conservative overflow latch.
    if (!(sessionIdentity(guard.session) || guard.session === '' && guard.latched === true && v.escapeOverflowUncertain === true)
      || !timestamp(guard.cooldownUntil) || guard.cooldownUntil > now + 3_600_000) throw new Error('Invalid field run escape owner.');
    validateEscapeResumeGuard({ cooldownSeconds: 0, latched: guard.latched as boolean,
      ...(Object.hasOwn(guard, 'recovery') ? { recovery: guard.recovery as EscapeRecovery } : {}) });
  }
  if (v.supplyGuard !== null) {
    const retained = checkpointRecord(v.supplyGuard, ['session', 'at', 'guard']);
    const guard = validateSupplyResumeGuard(retained.guard);
    if (!sessionIdentity(retained.session) || !timestamp(retained.at) || retained.at > now || guard.character !== v.character)
      throw new Error('Invalid field run supply owner.');
  }
  if (v.deathGuard !== null) {
    const retained = checkpointRecord(v.deathGuard, ['session', 'at', 'guard']);
    const guard = validateDeathRecoveryGuard(retained.guard);
    if (!sessionIdentity(retained.session) || !timestamp(retained.at) || retained.at > now || guard.character !== v.character
      || guard.destination !== farmingDestination(desired)
      || guard.recoveryDeadline > retained.at + guard.recoverySeconds * 1000
      || guard.returnDeadline > retained.at + (guard.phase === 'return' ? guard.returnSeconds : guard.recoverySeconds + guard.returnSeconds) * 1000)
      throw new Error('Invalid field run death owner or deadline.');
  }
  return { ...structuredClone(value) as FieldRunCheckpoint, desired };
}

/** Only field settings survive game-page reloads; workflows and passwords do not. */
export class PersistentFieldRun {
  private desired: Settings | null = null;
  private character = '';
  private session = '';
  private pendingSession = '';
  private generation = 0;
  private startedAt = 0;
  private metricsSession = '';
  private previous = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  private totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  private readonly escapeGuards = new Map<string, RetainedEscape>();
  private escapeOverflowUncertain = false;
  private readonly supplyGuards=new Map<string,RetainedSupply>();
  private supplyOverflow=false;
  private readonly deathGuards=new Map<string,RetainedDeath>();
  private deathOverflow=false;
  private settledUpdateSession = '';
  constructor(private readonly now = Date.now) {}
  checkpoint(): FieldRunCheckpoint | null {
    if (!this.desired) return null;
    return validateFieldRunCheckpoint({ version: 1, desired: this.desired, character: this.character, session: this.session,
      generation: this.generation, startedAt: this.startedAt, metricsSession: this.metricsSession,
      previous: this.previous, totals: this.totals, escapeGuard: this.escapeGuards.get(this.character) ?? null,
      supplyGuard: this.supplyGuards.get(this.character) ?? null, deathGuard: this.deathGuards.get(this.character) ?? null,
      escapeOverflowUncertain: this.escapeOverflowUncertain || this.escapeGuards.size >= MAX_ESCAPE_GUARDS,
      supplyOverflow: this.supplyOverflow || this.supplyGuards.size >= 64,
      deathOverflow: this.deathOverflow || this.deathGuards.size >= 64 }, this.now());
  }
  restore(checkpoint: unknown): void {
    if (this.desired) throw new Error('Stop the active field run before restoring its checkpoint.');
    const checked = validateFieldRunCheckpoint(checkpoint, this.now());
    if (checked.escapeGuard && !this.escapeGuards.has(checked.character) && this.escapeGuards.size >= MAX_ESCAPE_GUARDS
      || checked.supplyGuard && !this.supplyGuards.has(checked.character) && this.supplyGuards.size >= 64
      || checked.deathGuard && !this.deathGuards.has(checked.character) && this.deathGuards.size >= 64)
      throw new Error('Field run retained guard capacity exhausted.');
    const generation = Math.max(this.generation, checked.generation) + 1;
    if (!Number.isSafeInteger(generation)) throw new Error('Field run generation exhausted.');
    this.desired = checked.desired; this.character = checked.character; this.session = checked.session;
    this.pendingSession = ''; this.generation = generation; this.startedAt = checked.startedAt;
    this.metricsSession = checked.metricsSession; this.previous = checked.previous; this.totals = checked.totals;
    // Preserve unrelated in-memory character guards if restore is used in the
    // same controller; a checkpoint only owns its active character.
    if (checked.escapeGuard) this.escapeGuards.set(checked.character, checked.escapeGuard);
    if (checked.supplyGuard) this.supplyGuards.set(checked.character, checked.supplyGuard);
    if (checked.deathGuard) this.deathGuards.set(checked.character, checked.deathGuard);
    this.escapeOverflowUncertain ||= checked.escapeOverflowUncertain;
    this.supplyOverflow ||= checked.supplyOverflow; this.deathOverflow ||= checked.deathOverflow;
    this.settledUpdateSession = checked.session;
  }
  begin(settings: Settings, character: string, sessionId: string, metrics: { kills: number; looted: number; deaths: number; attacks?: number } = { kills: 0, looted: 0, deaths: 0 }): void {
    const checked=validateSettings(settings);
    // Reserve the first enabled allowance before native Start can outlive its
    // last publication. Default-off runs allocate no supply state.
    const initial=checked.automation?.supply?.enabled&&!this.supplyGuards.has(character)&&this.supplyGuards.size<64
      ?validateSupplyResumeGuard({version:1,character,latched:false,remainingTrips:checked.automation.supply.maxTrips,
        actions:0,spent:0,reserved:0,intervalSeconds:0,deadlineSeconds:0,interrupted:false,uncertain:false,returnDestination:null}):undefined;
    const previousDeath=this.deathGuards.get(character);
    if(previousDeath&&!previousDeath.guard.uncertain)this.deathGuards.delete(character);
    this.desired = checked;
    if(initial)this.supplyGuards.set(character,{session:sessionId,at:this.now(),guard:initial});
    this.pruneEscapeGuards();
    if (!this.escapeGuards.has(character) && this.escapeGuards.size < MAX_ESCAPE_GUARDS)
      this.escapeGuards.set(character, this.escapeOverflowUncertain
        ? { session: '', cooldownUntil: this.now() + 3_600_000, latched: true }
        : { session: sessionId, cooldownUntil: 0, latched: false });
    this.character = character; this.session = sessionId; this.pendingSession = ''; this.generation++; this.settledUpdateSession = '';
    this.startedAt = this.now(); this.metricsSession = sessionId; this.previous = { ...metrics, attacks: metrics.attacks ?? 0 };
    this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  }
  stop(): void {
    this.desired = null; this.character = ''; this.session = ''; this.pendingSession = ''; this.generation++; this.settledUpdateSession = '';
    this.metricsSession = ''; this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
    // Stop does not prove whether an already sent wing was consumed. Keep the
    // bounded cooldown through a subsequent explicit Start in this app session.
  }
  /** Frozen updater telemetry keeps its capture time so downtime spends timers. */
  observe(status: RunSession, observedAt = this.now()): void {
    if (!timestamp(observedAt) || observedAt > this.now()) return;
    if(status.deathRecoveryGuard){
      try{const guard=validateDeathRecoveryGuard(status.deathRecoveryGuard),old=this.deathGuards.get(guard.character);
        if(status.connected&&status.compatible&&status.player?.name===guard.character&&(!old&&this.deathGuards.size<64||old?.session===status.sessionId
          ||this.desired&&this.character===guard.character&&guard.destination===farmingDestination(this.desired)
            &&(this.pendingSession===status.sessionId||this.session===status.sessionId)))
          this.deathGuards.set(guard.character,{session:status.sessionId,at:observedAt,guard});
      }catch{/* Unvalidated telemetry cannot change an outstanding death episode. */}
    }else if(status.runRequested&&status.player?.dead===false){
      const old=this.deathGuards.get(status.player.name);
      if(old?.session===status.sessionId)this.deathGuards.delete(status.player.name);
    }

    if(status.supplyGuard){
      try{
        const guard=validateSupplyResumeGuard(status.supplyGuard),old=this.supplyGuards.get(guard.character);
        // A blank/new page cannot replenish the finite allowance of an older page.
        if(old?.session===status.sessionId||!old&&this.supplyGuards.size<64||old&&guard.remainingTrips<old.guard.remainingTrips){
          if(old){guard.remainingTrips=Math.min(old.guard.remainingTrips,guard.remainingTrips);if(guard.remainingTrips===old.guard.remainingTrips)guard.reserved=Math.max(old.guard.reserved,guard.reserved);}
          this.supplyGuards.set(guard.character,{session:status.sessionId,at:observedAt,guard});
        }else if(!old)this.supplyOverflow=true;
      }catch{/* Ignore unvalidated guard telemetry. */}
    }
    if (status.escape && Number.isInteger(status.escape.cooldownSeconds) && status.escape.cooldownSeconds >= 0 && status.escape.cooldownSeconds <= 3600) {
      const name = status.player?.name ?? [...this.escapeGuards].find(([,guard])=>guard.session===status.sessionId)?.[0];
      this.pruneEscapeGuards();
      if (!name && (status.escape.latched || status.escape.pending)) this.escapeOverflowUncertain = true;
      if (name) {
        let guard = this.escapeGuards.get(name);
        if (!guard && (status.escape.latched || status.escape.pending) && this.escapeGuards.size < MAX_ESCAPE_GUARDS) {
          guard = { session: status.sessionId, cooldownUntil: 0, latched: false }; this.escapeGuards.set(name,guard);
        }
        if (!guard && (status.escape.latched || status.escape.pending)) this.escapeOverflowUncertain = true;
        // A blank new page cannot erase an earlier page's spent episode.
        if (guard && (status.sessionId === guard.session || status.escape.latched || status.escape.pending)) {
          guard.cooldownUntil = Math.max(guard.cooldownUntil, observedAt + status.escape.cooldownSeconds * 1000);
          if (status.escape.recovery) {
            try { validateEscapeResumeGuard({ cooldownSeconds: 0, latched: true, recovery: status.escape.recovery });
              const incoming = status.escape.recovery, previous = guard.recovery ?? CONSERVATIVE_ESCAPE_RECOVERY;
              guard.recovery = guard.latched
                ? { hpPercent: Math.max(previous.hpPercent, incoming.hpPercent),
                  threatCount: previous.threatCount && incoming.threatCount ? Math.min(previous.threatCount, incoming.threatCount) : previous.threatCount || incoming.threatCount,
                  quietSeconds: Math.max(previous.quietSeconds, incoming.quietSeconds) } : { ...incoming };
            } catch { /* Invalid telemetry cannot weaken a retained episode. */ }
          }
          guard.session = status.sessionId; guard.latched = status.escape.latched || status.escape.pending;
        }
      }
    }
    if (!this.desired || status.player && status.player.name !== this.character) return;
    const current = { kills: status.kills ?? 0, looted: status.looted ?? 0, deaths: status.deaths ?? 0, attacks: status.attacks ?? 0 };
    if (!sessionIdentity(status.sessionId) || Object.values(current).some(value => !Number.isSafeInteger(value) || value < 0)) return;
    if (status.sessionId !== this.metricsSession) {
      this.metricsSession = status.sessionId; this.previous = current; return;
    }
    for (const key of ['kills', 'looted', 'deaths', 'attacks'] as const) {
      this.totals[key] = Math.min(Number.MAX_SAFE_INTEGER, this.totals[key] + Math.max(0, current[key] >= this.previous[key] ? current[key] - this.previous[key] : current[key]));
    }
    this.previous = current;
  }
  private pruneEscapeGuards(): void {
    for (const [name, guard] of this.escapeGuards) if (!guard.latched && guard.cooldownUntil <= this.now()
      && (!this.desired || name !== this.character)) this.escapeGuards.delete(name);
  }
  get limitReason(): string {
    const a = this.desired?.automation;
    if (!a) return '';
    if (a.limits.minutes && this.now() - this.startedAt >= a.limits.minutes * 60_000) return 'Waiting: session time limit reached. Press Stop to change settings.';
    if (a.limits.kills && this.totals.kills >= a.limits.kills) return 'Waiting: monster limit reached. Press Stop to change settings.';
    if (a.limits.pickups && this.totals.looted >= a.limits.pickups) return 'Waiting: pickup limit reached. Press Stop to change settings.';
    if (a.respawn.enabled && this.totals.deaths > a.respawn.maxDeaths) return `Waiting: death limit reached. ${deathLimitGuidance(this.totals.deaths, a.respawn.maxDeaths)}`;
    return '';
  }
  guardForStart(settings: Settings, character: string, sessionId: string): EscapeResumeGuard | undefined {
    this.pruneEscapeGuards();
    const guard = this.escapeGuards.get(character);
    if (!guard) return (settings.automation?.escape?.enabled || this.escapeOverflowUncertain) && (this.escapeOverflowUncertain || this.escapeGuards.size >= MAX_ESCAPE_GUARDS) ? { latched: true, cooldownSeconds: 3600 } : undefined;
    if (sessionId === guard.session || !guard.latched && guard.cooldownUntil <= this.now()) return undefined;
    return { latched: true, cooldownSeconds: Math.max(0, Math.min(3600, Math.ceil((guard.cooldownUntil - this.now()) / 1000))), ...(guard.recovery ? { recovery: { ...guard.recovery } } : {}) };
  }
  supplyGuardForStart(settings:Settings,character:string,sessionId:string,automatic=false):SupplyResumeGuard|undefined {
    const old=this.supplyGuards.get(character);
    if(!settings.automation?.supply?.enabled&&!old)return undefined;
    if(!old)return this.supplyOverflow||this.supplyGuards.size>=64?{version:1,character,latched:true,remainingTrips:0,actions:0,spent:0,reserved:0,intervalSeconds:86400,deadlineSeconds:0,interrupted:true,uncertain:true,returnDestination:null}:undefined;
    const guard=structuredClone(old.guard),elapsed=Math.floor(Math.max(0,this.now()-old.at)/1000);
    guard.intervalSeconds=Math.max(0,guard.intervalSeconds-elapsed);guard.deadlineSeconds=Math.max(0,guard.deadlineSeconds-elapsed);
    if(automatic&&sessionId!==old.session){if(!guard.returnDestination)guard.remainingTrips=Math.max(0,guard.remainingTrips-1);guard.interrupted=true;guard.uncertain=true;}
    // An explicit Start may create a new field run after a canceled, reconciled
    // trip. Its spent trip allowance and latch survive; the old trip never resumes.
    if(!automatic&&!guard.uncertain){guard.interrupted=false;guard.returnDestination=null;}
    return validateSupplyResumeGuard(guard);
  }
  deathGuardForStart(settings:Settings,character:string,sessionId:string,automatic=false):DeathRecoveryGuard|undefined {
    const old=this.deathGuards.get(character);
    if(!settings.automation?.respawn.enabled&&!old&&!(automatic&&this.desired?.automation?.respawn.enabled))return undefined;
    if(old){
      const guard=structuredClone(old.guard);
      // A replaced page loses wire ownership. A fresh ready living character can
      // reconcile it; a dead character cannot prove the old request was unsent.
      if(automatic&&sessionId!==old.session&&guard.phase==='revival')guard.uncertain=true;
      return validateDeathRecoveryGuard(guard);
    }
    if(!automatic)return undefined;
    return {version:1,character,destination:farmingDestination(settings),phase:this.deathOverflow||this.deathGuards.size>=64?'failed':'revival',
      uncertain:true,recoverySeconds:settings.automation!.recovery.timeoutSeconds,returnSeconds:1200,recoveryDeadline:0,returnDeadline:0};
  }
  completeDeathStart(character:string,sessionId:string,guard?:DeathRecoveryGuard):void {
    if(!guard)return;const checked=validateDeathRecoveryGuard(guard);
    if(checked.character!==character)throw new Error('Death recovery state belongs to another character.');
    const old=this.deathGuards.get(character);
    if(old?.session===sessionId)return; // Newer same-page receipts outrank an older callback.
    if(!old&&this.deathGuards.size>=64){this.deathOverflow=true;return;}
    this.deathGuards.set(character,{session:sessionId,at:this.now(),guard:checked});
  }
  resumeFor(status: RunSession, options: { settledUpdate?: boolean } = {}): ResumeRequest | null {
    if (!this.desired || this.limitReason || !status.connected || !status.compatible || !status.player
      || status.player.name !== this.character || !/^[a-zA-Z0-9_-]{1,64}$/.test(status.map)
      || !sessionIdentity(status.sessionId) || status.sessionId === this.session || status.sessionId === this.pendingSession) return null;
    const settledUpdate = options.settledUpdate === true && this.settledUpdateSession === this.session;
    // A known rejection before activation can retry the same settled boundary.
    // Choosing ordinary reconnect forfeits that provenance immediately.
    if (!settledUpdate) this.settledUpdateSession = '';
    this.pendingSession = status.sessionId;
    const settings = validateSettings({ ...this.desired, map: this.desired.automation?.respawn.enabled||this.desired.automation?.travel.returnToLockMap||this.desired.automation?.mapPolicy?.lockArea ? farmingDestination(this.desired) : status.map });
    if (settings.automation) {
      const a = settings.automation;
      // A new page has no captured leader association or explicit trip allowance.
      if (a.follow.mode === 'partyLeader') a.follow.rendezvous = false;
      if (a.limits.minutes) a.limits.minutes = Math.max(1, Math.ceil((a.limits.minutes * 60_000 - (this.now() - this.startedAt)) / 60_000));
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
        escapeGuard = { latched: oldEscape.latched,
          cooldownSeconds: Math.max(0, Math.min(3600, Math.ceil((oldEscape.cooldownUntil - this.now()) / 1000))),
          ...(oldEscape.recovery ? { recovery: { ...oldEscape.recovery } } : {}) };
    } else if (retained || settings.automation?.escape?.enabled) {
      escapeGuard = { ...(retained ?? { recovery: escapeRecovery(settings) }), latched: true,
        cooldownSeconds: Math.max(settings.automation?.escape?.enabled ? settings.automation.escape.cooldownSeconds : 0, retained?.cooldownSeconds ?? 0) };
    }
    const supplyOwner = settledUpdate && this.supplyGuards.get(this.character)?.session === this.session ? this.session : status.sessionId;
    const supplyGuard=this.supplyGuardForStart(settings,this.character,supplyOwner,true);
    const oldDeath = this.deathGuards.get(this.character);
    const deathRecoveryGuard = settledUpdate && !oldDeath && !this.deathOverflow && this.deathGuards.size < 64 ? undefined
      : this.deathGuardForStart(settings,this.character,settledUpdate && oldDeath?.session === this.session ? this.session : status.sessionId,true);
    if(deathRecoveryGuard&&status.player.dead===false&&deathRecoveryGuard.phase!=='failed'){
      // Capture the maximum remaining cycle budget before invoking native Start.
      // A reload before its first bridge publication cannot create a new deadline.
      deathRecoveryGuard.recoveryDeadline ||= this.now()+deathRecoveryGuard.recoverySeconds*1000;
      deathRecoveryGuard.returnDeadline ||= deathRecoveryGuard.recoveryDeadline+deathRecoveryGuard.returnSeconds*1000;
    }
    return { generation: this.generation, sessionId: status.sessionId, settings: validateSettings(settings), ...(escapeGuard ? { escapeGuard } : {}),...(supplyGuard?{supplyGuard}:{}),...(deathRecoveryGuard?{deathRecoveryGuard}:{}) };
  }
  completeResume(request: ResumeRequest, success: boolean): boolean {
    if (request.generation !== this.generation || request.sessionId !== this.pendingSession || !this.desired) return false;
    if(request.supplyGuard&&validateSupplyResumeGuard(request.supplyGuard).character!==this.character)return false;
    this.pendingSession = '';
    if (success) {this.settledUpdateSession = '';this.session = request.sessionId;
      if(request.supplyGuard)this.completeSupplyStart(request.supplyGuard.character,request.sessionId,request.supplyGuard);
      if(request.deathRecoveryGuard)this.completeDeathStart(this.character,request.sessionId,request.deathRecoveryGuard);
    }
    return true;
  }
  completeSupplyStart(character:string,sessionId:string,guard?:SupplyResumeGuard):void{
    const old=this.supplyGuards.get(character);if(!guard&&!old)return;
    const requested=validateSupplyResumeGuard(guard??old!.guard);if(requested.character!==character)throw new Error('Supply guard belongs to another character.');
    if(!old&&this.supplyGuards.size>=64){this.supplyOverflow=true;return;}
    let retained=requested;
    if(old){
      const latest=structuredClone(old.guard),elapsed=Math.floor(Math.max(0,this.now()-old.at)/1000);
      latest.intervalSeconds=Math.max(0,latest.intervalSeconds-elapsed);latest.deadlineSeconds=Math.max(0,latest.deadlineSeconds-elapsed);
      // A successful callback may follow a newer sent/reconciled publication.
      // Same-owner telemetry is authoritative; transfer must retain uncertainty.
      if(old.session===sessionId)retained=latest;
      else{
        retained.uncertain=retained.uncertain||latest.uncertain;retained.latched=retained.latched||latest.latched;
        retained.intervalSeconds=Math.max(retained.intervalSeconds,latest.intervalSeconds);
        if(latest.uncertain){retained.interrupted=true;retained.returnDestination=latest.returnDestination??retained.returnDestination;
          retained.deadlineSeconds=latest.deadlineSeconds;}
      }
      retained.remainingTrips=Math.min(requested.remainingTrips,latest.remainingTrips);retained.reserved=Math.max(requested.reserved,latest.reserved);
    }
    this.supplyGuards.set(character,{session:sessionId,at:this.now(),guard:retained});
  }
  get metrics(): Readonly<typeof this.totals> { return { ...this.totals }; }
  get targetIds(): number[] { return this.desired?.targets.slice() ?? []; }
  get requested(): boolean { return this.desired !== null; }
}

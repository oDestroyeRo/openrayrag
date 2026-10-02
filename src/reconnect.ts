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
  private readonly supplyGuards=new Map<string,{session:string;at:number;guard:SupplyResumeGuard}>();
  private supplyOverflow=false;
  private readonly deathGuards=new Map<string,{session:string;at:number;guard:DeathRecoveryGuard}>();
  constructor(private readonly now = Date.now) {}
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
    this.character = character; this.session = sessionId; this.pendingSession = ''; this.generation++;
    this.startedAt = this.now(); this.metricsSession = sessionId; this.previous = { ...metrics, attacks: metrics.attacks ?? 0 };
    this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  }
  stop(): void {
    this.desired = null; this.character = ''; this.session = ''; this.pendingSession = ''; this.generation++;
    this.metricsSession = ''; this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
    // Stop does not prove whether an already sent wing was consumed. Keep the
    // bounded cooldown through a subsequent explicit Start in this app session.
  }
  observe(status: RunSession): void {
    if(status.deathRecoveryGuard){
      try{const guard=validateDeathRecoveryGuard(status.deathRecoveryGuard),old=this.deathGuards.get(guard.character);
        if(status.connected&&status.compatible&&status.player?.name===guard.character&&(!old&&this.deathGuards.size<64||old?.session===status.sessionId
          ||this.desired&&this.character===guard.character&&guard.destination===farmingDestination(this.desired)
            &&(this.pendingSession===status.sessionId||this.session===status.sessionId)))
          this.deathGuards.set(guard.character,{session:status.sessionId,at:this.now(),guard});
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
          this.supplyGuards.set(guard.character,{session:status.sessionId,at:this.now(),guard});
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
          guard.cooldownUntil = Math.max(guard.cooldownUntil, this.now() + status.escape.cooldownSeconds * 1000);
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
    if (!this.desired) return;
    const current = { kills: status.kills ?? 0, looted: status.looted ?? 0, deaths: status.deaths ?? 0, attacks: status.attacks ?? 0 };
    if (status.sessionId !== this.metricsSession) {
      this.metricsSession = status.sessionId; this.previous = current; return;
    }
    for (const key of ['kills', 'looted', 'deaths', 'attacks'] as const) {
      this.totals[key] += Math.max(0, current[key] >= this.previous[key] ? current[key] - this.previous[key] : current[key]);
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
    return {version:1,character,destination:farmingDestination(settings),phase:this.deathGuards.size>=64?'failed':'revival',
      uncertain:true,recoverySeconds:settings.automation!.recovery.timeoutSeconds,returnSeconds:1200,recoveryDeadline:0,returnDeadline:0};
  }
  completeDeathStart(character:string,sessionId:string,guard?:DeathRecoveryGuard):void {
    if(!guard)return;const checked=validateDeathRecoveryGuard(guard);
    if(checked.character!==character)throw new Error('Death recovery state belongs to another character.');
    const old=this.deathGuards.get(character);
    if(old?.session===sessionId)return; // Newer same-page receipts outrank an older callback.
    if(!old&&this.deathGuards.size>=64)return;
    this.deathGuards.set(character,{session:sessionId,at:this.now(),guard:checked});
  }
  resumeFor(status: RunSession): ResumeRequest | null {
    if (!this.desired || this.limitReason || !status.connected || !status.compatible || !status.player
      || status.player.name !== this.character || !/^[a-zA-Z0-9_-]{1,64}$/.test(status.map)
      || !status.sessionId || status.sessionId === this.session || status.sessionId === this.pendingSession) return null;
    this.pendingSession = status.sessionId;
    const settings = validateSettings({ ...this.desired, map: this.desired.automation?.respawn.enabled||this.desired.automation?.travel.returnToLockMap||this.desired.automation?.mapPolicy?.lockArea ? farmingDestination(this.desired) : status.map });
    if (settings.automation) {
      const a = settings.automation;
      if (a.limits.minutes) a.limits.minutes = Math.max(1, Math.ceil((a.limits.minutes * 60_000 - (this.now() - this.startedAt)) / 60_000));
      if (a.limits.kills) a.limits.kills -= this.totals.kills;
      if (a.limits.pickups) a.limits.pickups -= this.totals.looted;
      if (a.respawn.enabled) {
        const remaining = a.respawn.maxDeaths - this.totals.deaths;
        a.respawn.enabled = remaining > 0 || status.player.dead === true;
        a.respawn.maxDeaths = Math.max(0, remaining);
      }
    }
    // The last bridge publication may precede a consumed wing. Any automatic
    // page reload starts disarmed until fresh self HP and resources reconcile.
    const retained = this.guardForStart(settings, this.character, status.sessionId);
    const escapeGuard = retained || settings.automation?.escape?.enabled
      ? { ...(retained ?? { recovery: escapeRecovery(settings) }), latched: true,
        cooldownSeconds: Math.max(settings.automation?.escape?.enabled ? settings.automation.escape.cooldownSeconds : 0, retained?.cooldownSeconds ?? 0) } : undefined;
    const supplyGuard=this.supplyGuardForStart(settings,this.character,status.sessionId,true);
    const deathRecoveryGuard=this.deathGuardForStart(settings,this.character,status.sessionId,true);
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
    if (success) {this.session = request.sessionId;
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

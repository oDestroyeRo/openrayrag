import { validateSettings, type Settings } from './settings';

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
}
export interface ResumeRequest { generation: number; sessionId: string; settings: Settings }

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
  constructor(private readonly now = Date.now) {}
  begin(settings: Settings, character: string, sessionId: string, metrics: { kills: number; looted: number; deaths: number; attacks?: number } = { kills: 0, looted: 0, deaths: 0 }): void {
    this.desired = validateSettings(settings);
    this.character = character; this.session = sessionId; this.pendingSession = ''; this.generation++;
    this.startedAt = this.now(); this.metricsSession = sessionId; this.previous = { ...metrics, attacks: metrics.attacks ?? 0 };
    this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  }
  stop(): void {
    this.desired = null; this.character = ''; this.session = ''; this.pendingSession = ''; this.generation++;
    this.metricsSession = ''; this.totals = { kills: 0, looted: 0, deaths: 0, attacks: 0 };
  }
  observe(status: RunSession): void {
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
  get limitReason(): string {
    const a = this.desired?.automation;
    if (!a) return '';
    if (a.limits.minutes && this.now() - this.startedAt >= a.limits.minutes * 60_000) return 'Waiting: session time limit reached. Press Stop to change settings.';
    if (a.limits.kills && this.totals.kills >= a.limits.kills) return 'Waiting: monster limit reached. Press Stop to change settings.';
    if (a.limits.pickups && this.totals.looted >= a.limits.pickups) return 'Waiting: pickup limit reached. Press Stop to change settings.';
    if (a.respawn.enabled && this.totals.deaths > a.respawn.maxDeaths) return 'Waiting: death limit reached. Press Stop to change settings.';
    return '';
  }
  resumeFor(status: RunSession): ResumeRequest | null {
    if (!this.desired || this.limitReason || !status.connected || !status.compatible || !status.player
      || status.player.name !== this.character || !/^[a-zA-Z0-9_-]{1,64}$/.test(status.map)
      || !status.sessionId || status.sessionId === this.session || status.sessionId === this.pendingSession) return null;
    this.pendingSession = status.sessionId;
    const settings = validateSettings({ ...this.desired, map: status.map });
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
    return { generation: this.generation, sessionId: status.sessionId, settings: validateSettings(settings) };
  }
  completeResume(request: ResumeRequest, success: boolean): boolean {
    if (request.generation !== this.generation || request.sessionId !== this.pendingSession || !this.desired) return false;
    this.pendingSession = '';
    if (success) this.session = request.sessionId;
    return true;
  }
  get metrics(): Readonly<typeof this.totals> { return { ...this.totals }; }
  get targetIds(): number[] { return this.desired?.targets.slice() ?? []; }
  get requested(): boolean { return this.desired !== null; }
}

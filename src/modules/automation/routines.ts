import { type RoutineSpec, type RoutineObservation, type ActionValidator, type RoutineState, type RoutineSnapshot, type RoutineSelectorCheckpoint, type RoutineTrace, type RoutineOptions, ROUTINE_LIMITS, integer, validateRoutineSpec, type RuleProgress, validateRoutineSelectorCheckpoint, traceRules } from './routines-logic';

export { type NumericOperator, type RoutineCondition, type RoutineRule, type RoutineSpec, type RoutineObservation, type ActionValidator, type RoutineState, type RoutineSnapshot, type RoutineSelectorCheckpoint, type ConditionTrace, type RuleTrace, type RoutineTrace, type RoutineOptions, ROUTINE_LIMITS, validRoutineCondition, validateRoutineSpec, evaluateRoutineCondition, validateRoutineSelectorCheckpoint, dryRunRoutine } from './routines-logic';

export class RoutineRuntime<Action> {
  private spec: RoutineSpec<Action> | null = null;
  private progress: RuleProgress[] = [];
  private pending: { id: number; ruleIndex: number; issuedAt: number } | null = null;
  private nextActionId = 0;
  private state: RoutineState = 'idle';
  private reason = 'Start a routine explicitly to run its rules.';
  private startedAt = 0;
  private lastTime = 0;
  private actionsIssued = 0;
  private actionsCompleted = 0;
  private steps = 0;
  private readonly timeoutMs: number;
  private readonly maxSteps: number;
  private readonly allowUnlimitedLimits: boolean;

  constructor(private readonly isAction: ActionValidator<Action>, private readonly now = Date.now, options: RoutineOptions = {}) {
    const timeout = options.actionTimeoutSeconds ?? 10;
    const timeoutLimit = options.actionTimeoutLimitSeconds ?? 120;
    const maxSteps = options.maxSteps ?? ROUTINE_LIMITS.defaultSteps;
    this.allowUnlimitedLimits = options.allowUnlimitedLimits === true;
    const minimum = this.allowUnlimitedLimits ? 0 : 1;
    if (!integer(timeoutLimit, 1, ROUTINE_LIMITS.durationSeconds) || !integer(timeout, minimum, timeoutLimit)
      || !integer(maxSteps, minimum, ROUTINE_LIMITS.maxSteps)) throw new Error('Invalid routine runtime limits.');
    this.timeoutMs = timeout * 1_000; this.maxSteps = maxSteps;
  }

  start(value: unknown): void {
    if (this.state === 'running' || this.state === 'waiting') throw new Error('Stop the current routine before starting another.');
    const spec = validateRoutineSpec(value, this.isAction, { allowUnlimitedLimits: this.allowUnlimitedLimits });
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Routine clock is unavailable.');
    this.spec = spec; this.progress = spec.rules.map(() => ({ runs: 0, lastIssued: null }));
    this.pending = null; this.actionsIssued = 0; this.actionsCompleted = 0; this.steps = 0;
    this.startedAt = now; this.lastTime = now; this.state = 'running'; this.reason = 'Waiting for a rule to match.';
  }

  private get internalSelector(): boolean { return this.allowUnlimitedLimits && this.timeoutMs === 0 && this.maxSteps === 0; }

  /** Only zero-timeout logical selectors may retain their selected sequence owner. */
  selectorCheckpoint(): RoutineSelectorCheckpoint<Action> | null {
    if (!this.internalSelector || !this.spec || !['running', 'waiting', 'completed'].includes(this.state)) return null;
    return structuredClone({ version: 1, spec: this.spec, progress: this.progress, pending: this.pending,
      nextActionId: this.nextActionId, state: this.state as RoutineSelectorCheckpoint<Action>['state'], reason: this.reason,
      startedAt: this.startedAt, lastTime: this.lastTime, actionsIssued: this.actionsIssued,
      actionsCompleted: this.actionsCompleted, steps: this.steps });
  }

  restoreSelector(input: unknown): void {
    if (!this.internalSelector) throw new Error('Only an internal logical selector can restore a checkpoint.');
    if (this.state === 'running' || this.state === 'waiting') throw new Error('Stop the current selector before restoring.');
    const checkpoint = validateRoutineSelectorCheckpoint(input, this.isAction);
    if (!integer(this.now(), Math.max(this.lastTime, checkpoint.lastTime), Number.MAX_SAFE_INTEGER)) {
      throw new Error('Selector checkpoint clock changed or became unavailable.');
    }
    this.spec = checkpoint.spec; this.progress = checkpoint.progress; this.pending = checkpoint.pending;
    this.nextActionId = Math.max(this.nextActionId, checkpoint.nextActionId); this.state = checkpoint.state; this.reason = checkpoint.reason;
    this.startedAt = checkpoint.startedAt; this.lastTime = checkpoint.lastTime;
    this.actionsIssued = checkpoint.actionsIssued; this.actionsCompleted = checkpoint.actionsCompleted; this.steps = checkpoint.steps;
  }

  private finish(state: RoutineState, reason: string): void { this.state = state; this.reason = reason; this.pending = null; }
  private activeTime(): number | null {
    if (!this.spec || (this.state !== 'running' && this.state !== 'waiting')) return null;
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now < this.lastTime) {
      this.finish('failed', 'Routine clock changed or became unavailable.'); return null;
    }
    this.lastTime = now;
    if (this.spec.durationSeconds > 0 && now - this.startedAt >= this.spec.durationSeconds * 1_000) {
      this.finish(this.pending ? 'failed' : 'completed', this.pending
        ? 'Routine duration reached while an action was unconfirmed. Do not retry automatically.' : 'Routine duration reached.');
      return null;
    }
    if (this.pending && this.timeoutMs > 0 && now - this.pending.issuedAt >= this.timeoutMs) {
      this.finish('failed', 'Action confirmation timed out. Do not retry automatically.'); return null;
    }
    return now;
  }

  /** Service deadlines without evaluating or debiting an action. */
  advance(): void { this.activeTime(); }

  private actionBudgetReached(): boolean {
    return this.spec !== null && ((this.spec.maxActions > 0 && this.actionsIssued >= this.spec.maxActions)
      || this.progress.every((progress, index) => {
        const limit = this.spec!.rules[index]!.maxRuns;
        return limit > 0 && progress.runs >= limit;
      }));
  }

  tick(observation: RoutineObservation): Action | null {
    const now = this.activeTime();
    if (now === null || !this.spec) return null;
    if (this.maxSteps > 0 && this.steps >= this.maxSteps) { this.finish('failed', 'Routine evaluation budget reached.'); return null; }
    // An unlimited selector records evaluations without overflowing or ending the run.
    if (this.steps < Number.MAX_SAFE_INTEGER) this.steps++;
    if (this.pending) return null;
    if (this.actionBudgetReached()) {
      this.finish('completed', 'Routine action budget reached.'); return null;
    }
    const trace = traceRules({ spec: this.spec, observation: { ...observation, elapsedSeconds: (now - this.startedAt) / 1_000 },
      progress: this.progress, now, allowExtendedElapsed: this.allowUnlimitedLimits });
    if (trace.rule === null) { this.reason = 'Waiting for a rule to match.'; return null; }
    const ruleIndex = this.spec.rules.findIndex(rule => rule.name === trace.rule);
    const progress = this.progress[ruleIndex]!;
    if (this.nextActionId === Number.MAX_SAFE_INTEGER) { this.finish('failed', 'Routine action identity budget reached.'); return null; }
    progress.runs++; progress.lastIssued = now; this.actionsIssued++;
    this.pending = { id: ++this.nextActionId, ruleIndex, issuedAt: now }; this.state = 'waiting'; this.reason = `Waiting for ${trace.rule} confirmation.`;
    return trace.action;
  }

  acknowledge(success: boolean, actionId: number): boolean {
    if (this.activeTime() === null || !this.pending || !this.spec) return false;
    if (actionId !== this.pending.id) return false;
    if (success !== true) { this.finish('failed', 'Action failed or its result is uncertain. Do not retry automatically.'); return true; }
    this.pending = null; this.actionsCompleted++;
    if (this.actionBudgetReached()) {
      this.finish('completed', 'Routine action budget reached.');
    } else { this.state = 'running'; this.reason = 'Waiting for a rule to match.'; }
    return true;
  }

  cancel(reason = 'Routine stopped by you.'): void {
    this.finish('cancelled', reason.slice(0, 200));
  }

  snapshot(): RoutineSnapshot {
    return { state: this.state, reason: this.reason, name: this.spec?.name ?? '',
      currentRule: this.pending ? this.spec!.rules[this.pending.ruleIndex]!.name : null,
      pendingActionId: this.pending?.id ?? null,
      actionsIssued: this.actionsIssued, actionsCompleted: this.actionsCompleted, steps: this.steps,
      elapsedSeconds: this.spec ? Math.min(this.allowUnlimitedLimits ? Number.MAX_SAFE_INTEGER / 1_000 : ROUTINE_LIMITS.durationSeconds,
        (this.lastTime - this.startedAt) / 1_000) : 0 };
  }

  trace(observation: RoutineObservation): RoutineTrace<Action> {
    if (!this.spec) return { rules: [], action: null, rule: null };
    const trace = traceRules({ spec: this.spec, observation: { ...observation, elapsedSeconds: this.snapshot().elapsedSeconds },
      progress: this.progress, now: this.lastTime, allowExtendedElapsed: this.allowUnlimitedLimits });
    // A preview cannot claim an action may dispatch while another action is pending or after Stop.
    if (this.state !== 'running') { trace.action = null; trace.rule = null; }
    return trace;
  }
}

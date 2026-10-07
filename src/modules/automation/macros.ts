import { RoutineRuntime } from './routines';
import type { RoutineObservation } from './routines-logic';

import {
  type MacroStep,
  type MacroScript,
  type MacroIntent,
  type MacroState,
  type MacroSnapshot,
  type MacroCheckpoint,
  type Selection,
  selectorOptions,
  integer,
  validateMacroScript,
  validSelection,
  selectionSpec,
  validateMacroCheckpoint,
  macroInventoryItemIds,
} from './macros-logic';

export {
  type MacroStep,
  type MacroRule,
  type MacroScript,
  type MacroIntent,
  type MacroState,
  type MacroSnapshot,
  type MacroCheckpoint,
  type MacroRuleTrace,
  type MacroTrace,
  MACRO_LIMITS,
  validMacroStep,
  validateMacroScript,
  validateMacroCheckpoint,
  dryRunMacro,
  macroInventoryItemIds,
} from './macros-logic';

/**
 * Call start explicitly, then tick with observations. Dispatch each returned intent once;
 * acknowledge its exact id only after the controller confirms the effect. A farm ACK means
 * field automation is active, not that farming has ended. Confirmed farm intent survives a
 * completed sequence so later level/inventory/HP rules can select. Travel ACK clears it.
 * Other sequences suspend the retained field intent until all ordered steps are confirmed.
 * Buy/store reserve their entire maxSpend before dispatch, including NPC fees. Adapters must
 * keep the combined fee/item cost within that cap; reservations are never refunded or offset
 * by sale proceeds. Failure, timeout and Stop revoke all pending ownership without replay.
 */
export class MacroRuntime {
  private script: MacroScript | null = null;
  private readonly selector: RoutineRuntime<Selection>;
  private sequence: { ruleIndex: number; stepIndex: number; selectorId: number } | null = null;
  private pending: { intent: MacroIntent; issuedAt: number } | null = null;
  private retainedField: Extract<MacroStep, { type: 'farm' }> | null = null;
  private state: MacroState = 'idle';
  private reason = 'Use Start bot to run the shared setup and its rules.';
  private generation = 0;
  private nextId = 0;
  private startedAt = 0;
  private lastTime = 0;
  private actionsIssued = 0;
  private actionsCompleted = 0;
  private spendReserved = 0;

  constructor(private readonly now = Date.now) {
    this.selector = new RoutineRuntime(validSelection, now, selectorOptions);
  }
  get active(): boolean {
    return this.state === 'running' || this.state === 'waiting' || this.state === 'monitoring';
  }
  get currentIntent(): MacroIntent | null {
    return this.pending ? structuredClone(this.pending.intent) : null;
  }
  get fieldIntent(): Extract<MacroStep, { type: 'farm' }> | null {
    return this.retainedField ? structuredClone(this.retainedField) : null;
  }
  inventoryItemIds(): number[] {
    return this.script ? macroInventoryItemIds(this.script) : [];
  }

  checkpoint(): MacroCheckpoint | null {
    if (!this.active || !this.script || this.pending) return null;
    const selector = this.selector.selectorCheckpoint();
    if (!selector) return null;
    return structuredClone({
      version: 1,
      script: this.script,
      selector,
      sequence: this.sequence,
      retainedField: this.retainedField,
      state: this.state as MacroCheckpoint['state'],
      reason: this.reason,
      generation: this.generation,
      nextId: this.nextId,
      startedAt: this.startedAt,
      lastTime: this.lastTime,
      actionsIssued: this.actionsIssued,
      actionsCompleted: this.actionsCompleted,
      spendReserved: this.spendReserved,
    });
  }

  /** Restore explicit run intent only; dispatch and field activation remain the adapter's responsibility. */
  restore(input: unknown): void {
    if (this.active) throw new Error('Stop the current macro before restoring a checkpoint.');
    const checkpoint = validateMacroCheckpoint(input);
    const now = this.now();
    if (
      !integer(
        now,
        Math.max(checkpoint.lastTime, checkpoint.selector.lastTime, this.lastTime),
        Number.MAX_SAFE_INTEGER,
      )
    ) {
      throw new Error('Macro checkpoint clock changed or became unavailable.');
    }
    this.selector.restoreSelector(checkpoint.selector);
    this.script = checkpoint.script;
    this.sequence = checkpoint.sequence;
    this.pending = null;
    this.retainedField = checkpoint.retainedField;
    this.state = checkpoint.state;
    this.reason = checkpoint.reason;
    this.generation = Math.max(this.generation, checkpoint.generation);
    this.nextId = Math.max(this.nextId, checkpoint.nextId);
    this.startedAt = checkpoint.startedAt;
    this.lastTime = checkpoint.lastTime;
    this.actionsIssued = checkpoint.actionsIssued;
    this.actionsCompleted = checkpoint.actionsCompleted;
    this.spendReserved = checkpoint.spendReserved;
  }

  start(input: unknown): void {
    if (this.active) throw new Error('Stop the current macro before starting another.');
    const script = validateMacroScript(input);
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER)) throw new Error('Macro clock is unavailable.');
    if (this.generation === Number.MAX_SAFE_INTEGER)
      throw new Error('Macro generation budget reached.');
    this.selector.start(selectionSpec(script));
    this.script = script;
    this.generation++;
    this.sequence = null;
    this.pending = null;
    this.retainedField = null;
    this.startedAt = now;
    this.lastTime = now;
    this.actionsIssued = 0;
    this.actionsCompleted = 0;
    this.spendReserved = 0;
    this.state = 'running';
    this.reason = 'Waiting for a rule to match.';
  }
  private finish(state: 'completed' | 'failed' | 'cancelled', reason: string): void {
    this.state = state;
    this.reason = reason.slice(0, 200);
    this.pending = null;
    this.sequence = null;
    this.retainedField = null;
    this.selector.cancel(this.reason);
  }
  private activeTime(): number | null {
    if (!this.active || !this.script) return null;
    const now = this.now();
    if (!integer(now, 0, Number.MAX_SAFE_INTEGER) || now < this.lastTime) {
      this.finish('failed', 'Macro clock changed or became unavailable.');
      return null;
    }
    this.lastTime = now;
    if (
      this.script.durationSeconds > 0 &&
      now - this.startedAt >= this.script.durationSeconds * 1_000
    ) {
      this.finish(
        this.pending ? 'failed' : 'completed',
        this.pending
          ? 'Macro duration reached while a step was unconfirmed. Do not retry automatically.'
          : 'Macro duration reached.',
      );
      return null;
    }
    if (
      this.pending &&
      now - this.pending.issuedAt >= this.pending.intent.step.timeoutSeconds * 1_000
    ) {
      this.finish('failed', 'Macro step confirmation timed out. Do not retry automatically.');
      return null;
    }
    this.selector.advance();
    if (this.selector.snapshot().state === 'failed') {
      this.finish('failed', this.selector.snapshot().reason);
      return null;
    }
    return now;
  }
  private settle(): void {
    if (!this.script || this.sequence) return;
    const exhausted =
      (this.script.maxActions > 0 && this.actionsIssued >= this.script.maxActions) ||
      this.selector.snapshot().state === 'completed';
    if (exhausted && !this.retainedField)
      this.finish('completed', 'Macro action or rule budget reached.');
    else {
      this.state = this.retainedField ? 'monitoring' : 'running';
      this.reason = exhausted
        ? this.script.durationSeconds > 0
          ? 'Monitoring the active field until the macro duration ends.'
          : 'Monitoring the active field until you stop the macro.'
        : 'Waiting for a rule to match.';
    }
  }
  tick(observation: RoutineObservation): MacroIntent | null {
    const now = this.activeTime();
    if (now === null || !this.script || this.pending) return null;
    if (this.script.maxActions > 0 && this.actionsIssued >= this.script.maxActions) {
      // Never abandon an already selected sequence and silently resume its field.
      if (this.sequence)
        this.finish('failed', 'Macro step budget reached before the selected sequence completed.');
      else this.settle();
      return null;
    }
    if (!this.sequence) {
      const selected = this.selector.tick(observation);
      if (!selected) {
        if (this.selector.snapshot().state === 'failed')
          this.finish('failed', this.selector.snapshot().reason);
        else this.settle();
        return null;
      }
      this.sequence = {
        ruleIndex: selected.ruleIndex,
        stepIndex: 0,
        selectorId: this.selector.snapshot().pendingActionId!,
      };
      const steps = this.script.rules[selected.ruleIndex]!.steps;
      if (
        this.script.maxActions > 0 &&
        steps.length > this.script.maxActions - this.actionsIssued
      ) {
        this.finish('failed', 'Selected macro sequence exceeds the remaining step budget.');
        return null;
      }
    }
    const { ruleIndex, stepIndex } = this.sequence;
    const step = this.script.rules[ruleIndex]!.steps[stepIndex]!;
    const reservation = 'maxSpend' in step ? step.maxSpend : 0;
    if (reservation > this.script.maxSpend - this.spendReserved) {
      this.finish('failed', 'Macro spend budget would be exceeded.');
      return null;
    }
    if (this.nextId === Number.MAX_SAFE_INTEGER) {
      this.finish('failed', 'Macro action identity budget reached.');
      return null;
    }
    this.spendReserved += reservation;
    this.actionsIssued++;
    const intent: MacroIntent = {
      id: ++this.nextId,
      generation: this.generation,
      ruleIndex,
      stepIndex,
      step: structuredClone(step),
    };
    this.pending = { intent, issuedAt: now };
    this.state = 'waiting';
    this.reason = `Waiting for ${step.type} confirmation.`;
    return structuredClone(intent);
  }
  acknowledge(id: number, confirmed: boolean, reason?: string): boolean {
    if (
      this.activeTime() === null ||
      !this.pending ||
      !this.sequence ||
      id !== this.pending.intent.id
    )
      return false;
    if (confirmed !== true) {
      this.finish(
        'failed',
        reason ?? 'Macro step failed or its result is uncertain. Do not retry automatically.',
      );
      return true;
    }
    const step = this.pending.intent.step;
    if (step.type === 'farm') this.retainedField = structuredClone(step);
    else if (step.type === 'travel') this.retainedField = null;
    this.pending = null;
    this.actionsCompleted++;
    this.sequence.stepIndex++;
    if (this.sequence.stepIndex >= this.script!.rules[this.sequence.ruleIndex]!.steps.length) {
      const selectorId = this.sequence.selectorId;
      this.sequence = null;
      if (!this.selector.acknowledge(true, selectorId)) {
        this.finish('failed', 'Macro rule confirmation ownership was lost.');
        return true;
      }
      this.settle();
    } else {
      this.state = 'running';
      this.reason = 'Preparing the next ordered macro step.';
    }
    return true;
  }
  fail(reason: string): void {
    if (this.active) this.finish('failed', reason);
  }
  cancel(reason = 'Macro stopped by you.'): void {
    this.finish('cancelled', reason);
  }
  snapshot(): MacroSnapshot {
    const selector = this.selector.snapshot();
    return {
      state: this.state,
      reason: this.reason,
      name: this.script?.name ?? '',
      generation: this.generation,
      currentRule: this.sequence ? this.script!.rules[this.sequence.ruleIndex]!.name : null,
      stepIndex: this.sequence?.stepIndex ?? null,
      pendingActionId: this.pending?.intent.id ?? null,
      actionsIssued: this.actionsIssued,
      actionsCompleted: this.actionsCompleted,
      sequencesIssued: selector.actionsIssued,
      sequencesCompleted: selector.actionsCompleted,
      spendReserved: this.spendReserved,
      elapsedSeconds: this.script
        ? Math.min(
            this.script.durationSeconds || Number.MAX_SAFE_INTEGER / 1_000,
            (this.lastTime - this.startedAt) / 1_000,
          )
        : 0,
      fieldIntentActive: this.retainedField !== null,
      fieldSuspended: this.retainedField !== null && this.sequence !== null,
    };
  }
}

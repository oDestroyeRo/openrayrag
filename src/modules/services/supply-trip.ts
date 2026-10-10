import { quantity, type Revision } from '../../shared/domain-values';
import { insideLockArea, mapAllowed, mapPolicy } from '../navigation/map-policy-logic';
import type { SettingsInput as Settings } from '../settings/settings';
import { farmingDestination } from '../recovery/death-recovery';
import { VALIDATED_DEFAULT_DISPOSITION, type ValidatedDispositionPolicy } from './disposition';

import {
  type SupplySettings,
  DEFAULT_SUPPLY,
  type SupplyGoal,
  type SupplyPolicySettings,
  type SupplyContext,
  type SupplyPorts,
  type SupplyIntent,
  type SupplyPhase,
  type SupplySnapshot,
  type SupplyResumeGuard,
  integer,
  validateSupplySettings,
  validateSupplyResumeGuard,
  count,
} from './supply-trip-logic';

export {
  type SupplySettings,
  DEFAULT_SUPPLY,
  type SupplyGoal,
  type SupplyPolicySettings,
  type SupplyContext,
  type SupplyNext,
  type SupplyPorts,
  type SupplyIntent,
  type SupplyPhase,
  type SupplySnapshot,
  type SupplyResumeGuard,
  validateSupplySettings,
  validateSupplyResumeGuard,
} from './supply-trip-logic';

/** Sender-free trip owner. An intention is single-use; the controller must mark
 * economic send before calling its sole transport, including send exceptions. */
export class SupplyTripRuntime<Receipt> {
  private policy: SupplySettings = DEFAULT_SUPPLY;
  private disposition: ValidatedDispositionPolicy = VALIDATED_DEFAULT_DISPOSITION;
  private settings: Settings | null = null;
  private character = '';
  private epoch = '';
  private phase: SupplyPhase = 'idle';
  private reason = 'Supply trips are disabled.';
  private remainingTrips = 0;
  private latched = false;
  private nextTripAt = 0;
  private deadline = 0;
  private actions = 0;
  private spent = 0;
  private committed = 0;
  private held = 0;
  private goals: SupplyGoal[] = [];
  private weightGoal = false;
  private destination: SupplySnapshot['returnDestination'] = null;
  private sequence = 0;
  private pending: SupplyIntent | null = null;
  private prepared = false;
  private departed = false;
  private receipt: {
    value: Receipt;
    sent: boolean;
    cost: number;
    reservation: number;
    inventoryRevision: Revision<'inventory'>;
    currencyRevision: Revision<'currency'>;
    epoch: string;
    generation: number;
    since: number;
  } | null = null;
  private reloadUncertainty = false;
  private interrupted = false;
  private resumed = false;
  private retained = false;
  private replacementPending = false;
  constructor(
    private readonly ports: SupplyPorts<Receipt>,
    private readonly now = Date.now,
  ) {}
  get active(): boolean {
    return !['idle', 'armed', 'complete', 'cancelled'].includes(this.phase);
  }
  get ownsField(): boolean {
    return (
      (this.destination !== null || (this.interrupted && this.phase === 'waiting')) &&
      this.phase !== 'complete' &&
      this.phase !== 'idle' &&
      this.phase !== 'armed' &&
      this.phase !== 'cancelled'
    );
  }
  get uncertain(): boolean {
    return !!this.receipt?.sent || this.reloadUncertainty;
  }
  configure(
    settings: SupplyPolicySettings,
    context: SupplyContext,
    guard?: SupplyResumeGuard,
    options: { explicitStart?: boolean } = {},
  ): void {
    if (this.uncertain)
      throw new Error('Waiting for the previous supply transaction to reconcile before starting.');
    // Validate every input before replacing retained ownership or allowances.
    const policy = validateSupplySettings(settings.automation?.supply ?? DEFAULT_SUPPLY);
    let retainedGuard = guard ? validateSupplyResumeGuard(guard) : undefined;
    if (retainedGuard && retainedGuard.character !== context.character)
      throw new Error('Supply resume state belongs to a different character.');
    const localGuard = this.guard();
    if (localGuard?.character === context.character) {
      // A delayed controller-window publication cannot replenish this owner's
      // allowance or erase its captured work cell. Only explicit Start can
      // authorize a new attempt; an automatic guard still vetoes that permission.
      retainedGuard = retainedGuard
        ? {
            ...retainedGuard,
            remainingTrips: Math.min(retainedGuard.remainingTrips, localGuard.remainingTrips),
            intervalSeconds: Math.max(retainedGuard.intervalSeconds, localGuard.intervalSeconds),
            actions: Math.max(retainedGuard.actions, localGuard.actions),
            spent: Math.max(retainedGuard.spent, localGuard.spent),
            reserved: Math.max(retainedGuard.reserved, localGuard.reserved),
            latched: retainedGuard.latched || localGuard.latched,
            returnDestination:
              (localGuard.latched && localGuard.returnDestination) ||
              retainedGuard.returnDestination ||
              localGuard.returnDestination,
            interrupted:
              retainedGuard.interrupted || (!options.explicitStart && localGuard.interrupted),
          }
        : { ...localGuard, interrupted: options.explicitStart ? false : localGuard.interrupted };
    }
    const copiedSettings = structuredClone(settings);
    const disposition = structuredClone(
      settings.automation?.disposition ?? VALIDATED_DEFAULT_DISPOSITION,
    );
    const previouslyRetained = this.retained && this.character === context.character;
    this.receipt = null;
    this.reloadUncertainty = false;
    this.resumed = false;
    this.settings = copiedSettings;
    this.policy = policy;
    this.retained = this.policy.enabled || !!retainedGuard || previouslyRetained;
    this.disposition = disposition;
    this.character = context.character;
    this.epoch = context.epoch;
    this.remainingTrips = this.policy.maxTrips;
    this.latched = false;
    this.actions = 0;
    this.spent = 0;
    this.committed = 0;
    this.held = 0;
    this.deadline = 0;
    this.nextTripAt = 0;
    this.pending = null;
    this.prepared = false;
    this.departed = false;
    this.goals = [];
    this.weightGoal = false;
    this.destination = null;
    this.interrupted = false;
    this.replacementPending = false;
    this.phase = this.policy.enabled ? 'armed' : 'idle';
    this.reason = this.policy.enabled
      ? 'Waiting for a verified supply trigger.'
      : 'Supply trips are disabled.';
    if (retainedGuard) {
      const retained = retainedGuard;
      this.remainingTrips = Math.min(this.remainingTrips, retained.remainingTrips);
      this.actions = retained.actions;
      this.spent = retained.spent;
      this.committed = retained.reserved;
      this.latched = retained.latched;
      this.goals = this.disposition.rules
        .filter((rule) => rule.restock !== 'off')
        .map((rule) => ({ itemId: rule.itemId, desired: rule.desired }));
      this.weightGoal = this.policy.weightEnabled && retained.latched;
      this.nextTripAt = this.now() + retained.intervalSeconds * 1000;
      this.deadline = retained.deadlineSeconds ? this.now() + retained.deadlineSeconds * 1000 : 0;
      this.destination = structuredClone(retained.returnDestination);
      this.reloadUncertainty = retained.uncertain;
      this.interrupted = retained.interrupted;
      if (retained.latched && this.destination) {
        this.replacementPending =
          this.policy.enabled &&
          !!options.explicitStart &&
          !retained.interrupted &&
          !retained.uncertain;
        this.interrupted = !this.replacementPending;
        // An expired old deadline cannot cancel a request waiting for its retained
        // interval. Duration starts only after charging the replacement allowance.
        this.deadline = 0;
        this.phase = 'waiting';
        this.reason = this.replacementPending
          ? 'Waiting for fresh settled state before another supply attempt using one remaining trip.'
          : 'Supply trip was interrupted. Stop, check the result and merchant, then explicitly Start to request a bounded replacement.';
      } else if (retained.interrupted || retained.uncertain) {
        this.phase = 'waiting';
        this.reason =
          'Supply trip was interrupted. Check the result and return destination before starting a new run.';
      }
      if (!this.remainingTrips && this.phase === 'waiting')
        this.reason =
          'Supply trip allowance exhausted. Stop/Start and unlimited farming time do not replenish spent trips.';
    }
  }
  private known(context: SupplyContext): string[] {
    const inventory = context.disposition.containers.inventory;
    const reasons: string[] = [];
    if (
      !context.connected ||
      !context.fresh ||
      !context.inventoryRevision ||
      !context.currencyRevision
    )
      reasons.push('Waiting for fresh character, inventory and currency observations.');
    if (!context.alive) reasons.push('Waiting for a living character.');
    if (context.character !== this.character)
      reasons.push('Supply trip belongs to a different character.');
    if (
      !inventory.items ||
      !integer(inventory.weight, 0, 2147483647) ||
      !integer(inventory.maxWeight, 1, 2147483647) ||
      !integer(inventory.slots, 1, 600)
    )
      reasons.push('Verified inventory, weight and capacity are required.');
    if (context.disposition.equipment === null || context.disposition.ammoId === null)
      reasons.push('Equipment and ammunition are not observed.');
    if (!integer(context.disposition.workflow.zeny, 0, 2_147_483_647))
      reasons.push('Verified currency is required.');
    if (context.economicUncertain || this.uncertain)
      reasons.push('Waiting for the exact economic receipt; no repeat transaction is allowed.');
    return reasons;
  }
  private goalsMet(context: SupplyContext): boolean {
    const inventory = context.disposition.containers.inventory;
    return (
      this.goals.every((goal) => (count(context, goal.itemId) ?? -1) >= goal.desired) &&
      (!this.weightGoal ||
        (typeof inventory.weight === 'number' &&
          typeof inventory.maxWeight === 'number' &&
          inventory.maxWeight > 0 &&
          (inventory.weight / inventory.maxWeight) * 100 < this.policy.weightEndPercent))
    );
  }
  observe(context: SupplyContext): void {
    if (this.receipt?.sent) {
      if (this.ports.confirm(this.receipt.value, context)) {
        this.spent += this.receipt.cost;
        this.committed += this.receipt.reservation;
        this.held = 0;
        this.receipt = null;
        if (!this.interrupted && this.phase === 'confirming') {
          this.pending = null;
          this.phase = 'closing';
          this.reason = 'Transaction confirmed. Closing the service before replanning.';
        }
      } else if (
        (context.epoch !== this.receipt.epoch ||
          context.disposition.workflow.world.generation !== this.receipt.generation) &&
        context.character === this.character &&
        context.fresh &&
        context.inventoryRevision > this.receipt.inventoryRevision &&
        context.currencyRevision > this.receipt.currencyRevision
      ) {
        this.committed += this.receipt.reservation;
        this.held = 0;
        this.receipt = null;
        this.interrupted = true;
        this.phase = 'waiting';
        this.reason =
          'Context reset with fresh economics; the old transaction outcome remains unknown. Trip continuation is disabled.';
      }
    }
    if (
      this.reloadUncertainty &&
      context.character === this.character &&
      context.fresh &&
      context.inventoryRevision > 0 &&
      context.currencyRevision > 0
    ) {
      this.reloadUncertainty = false;
      this.interrupted = true;
      this.phase = 'waiting';
      this.reason =
        'Fresh economics arrived after reload. Check the interrupted trip before starting again.';
    }
    if (
      !this.interrupted &&
      this.ownsField &&
      (context.character !== this.character ||
        (!context.alive && !context.loading) ||
        !context.connected ||
        context.epoch !== this.epoch)
    )
      this.interrupt('Supply trip interrupted by death, character or connection change.');
    if (!this.interrupted && this.receipt?.sent && this.now() - this.receipt.since >= 10000) {
      this.interrupted = true;
      this.pending = null;
      this.phase = 'waiting';
      this.reason =
        'Transaction timed out without an exact receipt. No repeat request will be sent.';
    }
    if (
      !this.interrupted &&
      this.phase !== 'waiting' &&
      this.ownsField &&
      this.deadline &&
      this.now() >= this.deadline
    ) {
      this.interrupted = true;
      this.pending = null;
      this.phase = 'waiting';
      this.reason = this.uncertain
        ? 'Whole-trip duration limit reached while a transaction was awaiting confirmation. No repeat request will be sent.'
        : 'Whole-trip duration limit reached with no pending transaction. Check the trip before starting again.';
    }
    if (this.phase === 'armed' || this.phase === 'complete') {
      if (this.latched && (this.phase === 'armed' || this.resumed) && this.goalsMet(context)) {
        this.latched = false;
        this.phase = 'armed';
      }
    }
  }
  interrupt(reason: string): void {
    if (!this.ownsField && !this.receipt) return;
    this.replacementPending = false;
    this.interrupted = true;
    this.pending = null;
    this.phase = 'waiting';
    this.reason = reason;
    if (this.receipt && !this.receipt.sent) {
      this.receipt = null;
      this.held = 0;
    }
  }
  stop(reason = 'Supply trip stopped by you.'): void {
    this.replacementPending = false;
    this.interrupted = true;
    this.pending = null;
    this.phase = 'cancelled';
    this.reason = reason;
    if (this.receipt && !this.receipt.sent) {
      this.receipt = null;
      this.held = 0;
    }
  }
  private intent<T extends Omit<SupplyIntent, 'id'>>(intent: T): SupplyIntent {
    const next = { ...intent, id: ++this.sequence } as SupplyIntent;
    this.pending = next;
    return structuredClone(next);
  }
  next(context: SupplyContext): SupplyIntent | null {
    this.observe(context);
    if (
      !this.policy.enabled ||
      !context.fieldRequested ||
      this.pending ||
      this.interrupted ||
      (this.phase === 'waiting' && !this.replacementPending) ||
      this.uncertain
    )
      return null;
    const reasons = this.known(context);
    if (reasons.length) {
      this.reason = reasons.join(' ');
      return null;
    }
    if (this.replacementPending) {
      if ((this.policy.transport ?? 'travel') !== 'travel') {
        this.reason =
          'Interrupted supply recovery requires normal travel. Choose Travel to selected merchant before Stop/Start; no save-return command will be replayed.';
        return null;
      }
      if (!this.remainingTrips || this.actions >= this.policy.maxActions) {
        this.reason =
          'Interrupted supply recovery has no remaining trip or command allowance. Stop/Start does not replenish either allowance.';
        return null;
      }
      if (this.now() < this.nextTripAt) {
        this.reason =
          'Waiting for the retained minimum supply interval before a replacement attempt.';
        return null;
      }
      if (!context.canPrepare || !context.settled) {
        this.reason =
          'Waiting for movement, casts, services and resource actions to settle before supply recovery.';
        return null;
      }
      const executionPolicy = mapPolicy(this.settings!);
      if (
        !context.position ||
        !integer(context.position.x, 0, 511) ||
        !integer(context.position.y, 0, 511) ||
        !this.destination ||
        !mapAllowed(executionPolicy, context.map) ||
        farmingDestination(this.settings!) !== this.destination.map ||
        !mapAllowed(executionPolicy, this.destination.map) ||
        !insideLockArea(executionPolicy, this.destination.map, this.destination.position)
      ) {
        this.reason =
          'Supply recovery requires a permitted actual arrival and the original work cell on the current farming destination. Restore that destination before Stop/Start.';
        return null;
      }
      const inventory = context.disposition.containers.inventory;
      const hardWeight = this.settings?.automation?.limits.weightPercent ?? 0;
      if (hardWeight && (inventory.weight! / Number(inventory.maxWeight)) * 100 >= hardWeight) {
        this.reason =
          'Configured hard weight stop reached before supply recovery. Lower the auto-sell trigger below that stop.';
        return null;
      }
      this.remainingTrips--;
      this.replacementPending = false;
      this.nextTripAt = this.now() + this.policy.minimumIntervalSeconds * 1000;
      this.deadline = this.now() + this.policy.maxDurationSeconds * 1000;
      this.phase = this.goalsMet(context) ? 'closing' : 'preparing';
      this.reason =
        'Preparing another supply attempt using one remaining trip. Previous command and spending totals still apply.';
    }
    if (this.phase === 'armed' || this.phase === 'complete') {
      if (!this.remainingTrips) {
        this.reason =
          'Supply trip allowance exhausted. Stop/Start and unlimited farming time do not replenish spent trips.';
        return null;
      }
      if (
        (this.phase === 'complete' && !this.resumed) ||
        this.latched ||
        this.now() < this.nextTripAt
      )
        return null;
      const executionPolicy = mapPolicy(this.settings!);
      if (
        !context.position ||
        !mapAllowed(executionPolicy, context.map) ||
        !insideLockArea(executionPolicy, context.map, context.position)
      ) {
        this.reason = 'Supply waits until the allowed field lock area has been entered.';
        return null;
      }
      const low = this.policy.stockEnabled
        ? this.disposition.rules.filter(
            (rule) =>
              rule.restock !== 'off' && (count(context, rule.itemId) ?? Infinity) < rule.minimum,
          )
        : [];
      const inventory = context.disposition.containers.inventory;
      const hardWeight = this.settings?.automation?.limits.weightPercent ?? 0;
      if (hardWeight && (inventory.weight! / Number(inventory.maxWeight)) * 100 >= hardWeight) {
        this.reason =
          'Configured hard weight stop reached before supply departure. Lower the auto-sell trigger below that stop.';
        return null;
      }
      const high =
        this.policy.weightEnabled &&
        (inventory.weight! / Number(inventory.maxWeight)) * 100 >= this.policy.weightStartPercent;
      if (!low.length && !high) return null;
      if (
        !context.position ||
        !integer(context.position.x, 0, 511) ||
        !integer(context.position.y, 0, 511) ||
        !context.map
      ) {
        this.reason = 'A verified return map and work cell are required.';
        return null;
      }
      this.goals = low.map((rule) => ({
        itemId: rule.itemId,
        desired: rule.desired,
      }));
      this.weightGoal = high;
      this.destination = {
        map: context.map,
        position: { ...context.position },
      };
      this.remainingTrips--;
      this.latched = true;
      this.nextTripAt = this.now() + this.policy.minimumIntervalSeconds * 1000;
      this.deadline = this.now() + this.policy.maxDurationSeconds * 1000;
      this.actions = 0;
      this.spent = 0;
      this.committed = 0;
      this.held = 0;
      this.prepared = false;
      this.departed = false;
      this.phase = 'preparing';
      this.reason = 'Preparing a bounded supply trip.';
    }
    if (this.phase === 'preparing') {
      if (!context.canPrepare) {
        this.reason = 'Waiting for movement, casts and resource actions before supply travel.';
        return null;
      }
      if (!this.prepared) return this.intent({ type: 'prepare' });
      if (!context.settled) {
        this.reason = 'Waiting for the field movement stop to settle.';
        return null;
      }
      if ((this.policy.transport ?? 'travel') !== 'travel' && !this.departed) {
        this.phase = 'departing';
        this.reason = 'Returning to the configured save map before selecting a fresh merchant.';
        return this.intent({
          type: 'saveReturn',
          map: this.policy.saveMap!,
          method: this.policy.transport === 'butterfly' ? 'item' : 'skill',
          minStock: this.policy.returnMinStock ?? 1,
        });
      }
      this.phase = 'planning';
    }
    if (this.phase === 'planning') {
      if (!context.settled) {
        this.reason = 'Waiting for the previous movement or service action.';
        return null;
      }
      const remaining = Math.max(0, this.policy.maxSpend - this.committed - this.held);
      const policy = {
        ...this.disposition,
        rules: this.disposition.rules.map((rule) => ({ ...rule })),
      };
      policy.maxSpend = quantity(Math.min(policy.maxSpend, remaining));
      for (const goal of this.goals) {
        const rule = policy.rules.find((rule) => rule.itemId === goal.itemId);
        if (rule) {
          rule.minimum = goal.desired;
          rule.desired = goal.desired;
        }
      }
      const next = this.ports.next(context, structuredClone(this.goals), policy, remaining);
      if (next.type === 'blocked') {
        this.phase = 'waiting';
        this.reason = next.reasons.join(' ');
        return null;
      }
      if (next.type === 'close') {
        this.phase = 'closing';
        return this.intent({ type: 'close' });
      }
      if (next.type === 'ready') {
        if (!this.goalsMet(context)) {
          this.phase = 'waiting';
          const inventory = context.disposition.containers.inventory;
          this.reason =
            this.weightGoal &&
            typeof inventory.weight === 'number' &&
            typeof inventory.maxWeight === 'number' &&
            inventory.maxWeight > 0 &&
            (inventory.weight / inventory.maxWeight) * 100 >= this.policy.weightEndPercent
              ? `The permitted service plan is empty. Weight is ${((inventory.weight / inventory.maxWeight) * 100).toFixed(2)}% (${inventory.weight}/${inventory.maxWeight}); it must be below ${this.policy.weightEndPercent}%. Protected stock remains retained. Review the finish threshold, storage setup or explicit item permissions, then Stop/Start to request a bounded replacement.`
              : 'The service plan is empty but captured stock goals are not met. Review the refill settings, then Stop/Start to request a bounded replacement.';
          return null;
        }
        this.phase = 'closing';
        return this.intent({ type: 'close' });
      }
      if (next.type === 'service') {
        if (context.disposition.workflow.world.npc.id !== null) {
          this.phase = 'closing';
          return this.intent({ type: 'close' });
        }
        if (
          !integer(next.fee, 0, 2000000000) ||
          next.fee > remaining ||
          next.fee > context.disposition.workflow.zeny
        ) {
          this.phase = 'waiting';
          this.reason = 'Service fee exceeds the remaining trip budget or observed zeny.';
          return null;
        }
        this.held = next.fee;
        this.phase = 'service';
        return this.intent({
          type: 'service',
          contractId: next.contractId,
          reserved: next.fee,
        });
      }
      if (
        next.action.reservedSpend > remaining ||
        next.action.reservedSpend > context.disposition.workflow.zeny
      ) {
        this.phase = 'waiting';
        this.reason = 'Transaction exceeds the remaining trip budget or observed zeny.';
        return null;
      }
      this.held = next.action.reservedSpend;
      return this.intent({ type: 'action', action: next.action });
    }
    if (this.phase === 'closing') return this.intent({ type: 'close' });
    if (this.phase === 'returning' && this.destination)
      return this.intent({ type: 'return', ...this.destination });
    return null;
  }
  accepts(id: number): boolean {
    return this.pending?.id === id && !this.interrupted;
  }
  /** Before any NPC interaction, automatic selection may change after travel's
   * actual landing cell is observed. It cannot increase the held opening fee. */
  retargetService(id: number, contractId: string, fee: number): SupplyIntent {
    if (
      !this.accepts(id) ||
      this.pending?.type !== 'service' ||
      fee > this.pending.reserved ||
      !integer(fee, 0, 2_000_000_000)
    )
      throw new Error(
        'The automatic merchant cannot replace this owned service or increase its reservation.',
      );
    this.pending = { ...this.pending, contractId };
    return structuredClone(this.pending);
  }
  commandAllowed(): boolean {
    if (this.replacementPending) return false;
    if (!this.ownsField) return true;
    if (this.interrupted || this.phase === 'waiting') return false;
    if (this.actions >= this.policy.maxActions || this.now() >= this.deadline) {
      this.interrupt('Supply command or duration allowance exhausted.');
      return false;
    }
    this.actions++;
    return true;
  }
  attachReceipt(id: number, value: Receipt, context: SupplyContext): void {
    if (!this.accepts(id) || this.pending?.type !== 'action')
      throw new Error('Supply action is no longer owned.');
    this.receipt = {
      value,
      sent: false,
      cost: this.pending.action.estimatedCost,
      reservation: this.pending.action.reservedSpend,
      inventoryRevision: context.inventoryRevision,
      currencyRevision: context.currencyRevision,
      epoch: context.epoch,
      generation: context.disposition.workflow.world.generation,
      since: this.now(),
    };
  }
  markSent(id: number): void {
    if (!this.accepts(id) || !this.receipt)
      throw new Error('An exact supply receipt must be captured before sending.');
    this.receipt.sent = true;
    this.receipt.since = this.now();
    this.phase = 'confirming';
    this.reason = 'Waiting for the exact transaction receipt.';
  }
  acknowledge(id: number, result: 'confirmed' | 'failed', context: SupplyContext, spent = 0): void {
    const intent = this.pending;
    if (!intent || intent.id !== id || this.interrupted) return;
    if (result === 'failed') {
      this.interrupt('Supply stage failed; no automatic repeat or field resume.');
      return;
    }
    if (intent.type === 'prepare') {
      this.prepared = true;
      this.pending = null;
      return;
    }
    if (intent.type === 'saveReturn') {
      if (context.map !== intent.map || !context.alive || !context.fresh || !context.settled) {
        this.interrupt(
          'Save-point arrival did not match the configured living character and map. No sale or repeat return is allowed.',
        );
        return;
      }
      this.departed = true;
      this.pending = null;
      this.phase = 'planning';
      return;
    }
    if (intent.type === 'service') {
      if (!integer(spent, 0, intent.reserved)) {
        this.interrupt('Service economics did not match the reserved opening fee.');
        return;
      }
      this.spent += spent;
      this.committed += intent.reserved;
      this.held = 0;
      this.pending = null;
      this.phase = 'planning';
      return;
    }
    if (intent.type === 'close') {
      if (
        context.disposition.workflow.world.npc.id !== null ||
        context.disposition.workflow.world.npc.mode !== 'idle'
      ) {
        this.reason = 'Waiting for confirmed NPC closure.';
        return;
      }
      this.pending = null;
      this.phase = this.goalsMet(context) ? 'returning' : 'planning';
      this.reason =
        this.phase === 'returning'
          ? 'Returning to the captured map and work cell.'
          : 'Service closed. Replanning the remaining supply goals.';
      return;
    }
    if (intent.type === 'return') {
      if (
        context.map !== intent.map ||
        !context.position ||
        context.position.x !== intent.position.x ||
        context.position.y !== intent.position.y ||
        !context.settled
      ) {
        this.reason = 'Waiting for the captured return map and work cell.';
        return;
      }
      if (!this.goalsMet(context)) {
        this.interrupt('Captured stock or weight goals changed before return.');
        return;
      }
      this.pending = null;
      this.phase = 'complete';
      this.reason = 'Supply goals and return destination confirmed.';
      return;
    }
    if (intent.type === 'resume') {
      this.pending = null;
      this.phase = 'complete';
      this.resumed = true;
      this.latched = false;
    }
  }
  resumeIntent(context: SupplyContext): SupplyIntent | null {
    if (
      this.resumed ||
      this.phase !== 'complete' ||
      this.pending ||
      this.interrupted ||
      !this.settings ||
      !this.destination ||
      context.character !== this.character ||
      !this.goalsMet(context) ||
      context.map !== this.destination.map ||
      !context.position ||
      context.position.x !== this.destination.position.x ||
      context.position.y !== this.destination.position.y ||
      !context.settled
    )
      return null;
    return this.intent({
      type: 'resume',
      settings: structuredClone(this.settings),
    });
  }
  guard(): SupplyResumeGuard | undefined {
    if (!this.retained) return undefined;
    return {
      version: 1,
      character: this.character,
      latched: this.latched,
      remainingTrips: this.remainingTrips,
      actions: this.actions,
      spent: this.spent,
      reserved: this.committed + this.held,
      intervalSeconds: Math.min(
        86400,
        Math.max(0, Math.ceil((this.nextTripAt - this.now()) / 1000)),
      ),
      deadlineSeconds: Math.min(3600, Math.max(0, Math.ceil((this.deadline - this.now()) / 1000))),
      interrupted: this.interrupted || this.ownsField,
      uncertain: this.uncertain,
      returnDestination: structuredClone(this.destination),
    };
  }
  snapshot(): SupplySnapshot {
    return {
      state: this.phase,
      active: this.active,
      reason: this.reason,
      uncertain: this.uncertain,
      latched: this.latched,
      remainingTrips: this.remainingTrips,
      actions: this.actions,
      spent: this.spent,
      reserved: this.committed + this.held,
      deadline: this.deadline,
      nextTripAt: this.nextTripAt,
      goals: structuredClone(this.goals),
      returnDestination: structuredClone(this.destination),
    };
  }
}

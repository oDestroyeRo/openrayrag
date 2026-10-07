import { itemId, bagId, quantity, type ItemId } from '../../shared/domain-values';
import { sameActionIdentity, type ActionIdentity } from '../world/actor-identity';
import type { WorldAction, WorldEvent } from '../protocol/world-protocol';

import {
  type WorkflowSpec,
  type WorkflowContext,
  type WorkflowSnapshot,
  type WorkflowPreview,
  validateWorkflowSpec,
  stock,
  shopQuote,
  saleProceeds,
  barterConsumption,
  worldActionBlockers,
  actionFor,
  dryRunWorkflow,
  type WorkflowReceipt,
  type Pending,
  npcResponses,
  confirmWorkflowReceipt,
} from './workflows-logic';

export {
  type WorkflowStep,
  type WorkflowSpec,
  type WorkflowContext,
  type WorkflowSnapshot,
  type WorkflowPreview,
  validateWorkflowSpec,
  stock,
  shopQuote,
  saleProceeds,
  worldActionBlockers,
  type VendingReceipt,
  createVendingReceipt,
  confirmVendingReceipt,
  dryRunWorkflow,
  type WorkflowReceipt,
  confirmWorkflowReceipt,
} from './workflows-logic';

/** A bounded script of normal actions, each confirmed before the next is sent. */
export class NpcWorkflow {
  private spec: WorkflowSpec | null = null;
  private identity: ActionIdentity | null = null;
  private generation = 0;
  private step = 0;
  private pending: Pending | null = null;
  private running = false;
  private reason = 'No workflow running.';
  private spent = 0;
  private state: WorkflowSnapshot['state'] = 'idle';
  private terminal = false;
  private strictStock = false;
  constructor(private readonly now: () => number = () => Date.now()) {}

  start(
    input: unknown,
    context: WorkflowContext,
    policy: { terminal?: boolean; strictStock?: boolean } = {},
  ): WorkflowPreview {
    if (this.running)
      return {
        ok: false,
        reasons: ['A workflow is already running.'],
        estimatedSpend: 0,
        unpriced: false,
      };
    const preview = dryRunWorkflow(input, context);
    if (!preview.ok) {
      this.state = 'failed';
      this.reason = preview.reasons.join(' ');
      return preview;
    }
    this.spec = validateWorkflowSpec(input);
    this.identity = context.actorIdentity?.(this.spec.npcId) ?? null;
    if (context.actorIdentity && !this.identity) {
      this.state = 'failed';
      this.reason = 'A current own and NPC identity is required.';
      return { ...preview, ok: false, reasons: [this.reason] };
    }
    this.generation = context.world.generation;
    this.terminal = policy.terminal ?? false;
    this.strictStock = policy.strictStock ?? false;
    this.step = 0;
    this.pending = null;
    this.spent = 0;
    this.running = true;
    this.state = 'running';
    this.reason = 'Ready.';
    return preview;
  }

  cancel(reason = 'Workflow stopped.'): void {
    this.finish('cancelled', reason);
  }
  private fail(reason: string): void {
    this.finish('failed', reason);
  }
  private finish(state: WorkflowSnapshot['state'], reason: string): void {
    this.running = false;
    this.pending = null;
    this.state = state;
    this.reason = reason;
  }

  /** Call after authoritative WorldState and inventory have applied the events. */
  observe(events: WorldEvent[], context: WorkflowContext): void {
    if (!this.running || !this.spec) return;
    if (
      events.some(
        (event) => event.type === 'npcFocus' && event.focus && event.id !== this.spec!.npcId,
      )
    ) {
      this.cancel('NPC focus changed; workflow stopped.');
      return;
    }
    const pending = this.pending;
    if (!pending) return;
    if (!this.bound(context)) return;
    for (const event of events) {
      if (pending.action.type === 'storage' && pending.action.operation !== 'close') {
        if (
          event.type === 'storageMoved' &&
          event.deposit === (pending.action.operation === 'deposit') &&
          event.change === pending.action.count &&
          event.item.itemId === pending.storageItemId &&
          (pending.action.operation === 'deposit' || event.item.bagId === pending.action.bagId)
        )
          pending.acknowledged = true;
      } else if (
        npcResponses.has(event.type) &&
        (event.type === 'npcEnd' || context.world.npc.id === this.spec.npcId)
      )
        pending.acknowledged = true;
    }
  }

  private bound(context: WorkflowContext): boolean {
    if (
      !this.spec ||
      context.map !== this.spec.map ||
      context.world.map !== this.spec.map ||
      context.world.generation !== this.generation
    ) {
      this.cancel('Map or session changed; workflow stopped.');
      return false;
    }
    if (
      this.identity &&
      !sameActionIdentity(this.identity, context.actorIdentity?.(this.spec.npcId))
    ) {
      this.cancel('Own or NPC actor lifetime changed; workflow stopped.');
      return false;
    }
    if (!context.alive) {
      this.cancel('Character died; workflow stopped.');
      return false;
    }
    if (context.world.npc.id !== null && context.world.npc.id !== this.spec.npcId) {
      this.cancel('NPC interaction changed; workflow stopped.');
      return false;
    }
    return true;
  }

  tick(context: WorkflowContext): WorldAction | null {
    if (!this.running || !this.spec || !this.bound(context)) return null;
    if (this.pending) {
      const pending = this.pending;
      if (this.terminal && this.step === this.spec.steps.length - 1) return null;
      if (pending.acknowledged && confirmWorkflowReceipt(pending, context)) {
        this.spent += Math.max(0, pending.zeny - context.zeny);
        this.pending = null;
        this.step++;
        if (this.spent > this.spec.maxSpend) {
          this.fail('Observed spending exceeded the budget.');
          return null;
        }
        this.reason = 'Step confirmed.';
        if (this.step === this.spec.steps.length) this.finish('complete', 'Workflow completed.');
      } else if (this.now() - pending.sentAt >= (this.spec.timeoutMs ?? 10_000)) {
        this.fail('Step timed out; outcome is unconfirmed. Check game state before restarting.');
      }
      return null;
    }
    if (!context.idle) return null;
    const step = this.spec.steps[this.step]!;
    if (step.type !== 'talk' && context.world.npc.id !== this.spec.npcId) {
      this.cancel('Workflow NPC is no longer active.');
      return null;
    }
    if (
      step.type === 'advance' &&
      step.expectedText !== undefined &&
      !context.world.npc.dialog?.text.includes(step.expectedText)
    ) {
      this.fail('NPC dialog did not match the expected text.');
      return null;
    }
    if (
      step.type === 'advance' &&
      step.exactDialogue &&
      (context.world.npc.dialog?.name !== step.exactDialogue.name ||
        context.world.npc.dialog?.text !== step.exactDialogue.text)
    ) {
      this.fail('NPC speaker or complete dialogue changed.');
      return null;
    }
    if (
      step.type === 'option' &&
      step.expectedOptions &&
      !step.expectedOptions.some(
        (menu) =>
          menu.length === context.world.npc.options.length &&
          menu.every((label, index) => label === context.world.npc.options[index]),
      )
    ) {
      this.fail('Complete NPC menu changed.');
      return null;
    }
    if (step.type === 'option' && context.world.npc.options[step.index] !== step.expectedLabel) {
      this.fail('NPC option label changed; workflow stopped.');
      return null;
    }
    let action = actionFor(step, this.spec.npcId);
    if (step.type === 'closeShop')
      action = { type: 'shop', mode: context.world.shop?.mode ?? 'sell', rows: [] };
    const reasons = worldActionBlockers(action, context);
    if (reasons.length) {
      this.fail(reasons.join(' '));
      return null;
    }
    const pending = this.prepare(action, context);
    if (step.type === 'talk' || step.type === 'advance' || step.type === 'option')
      pending.cost = pending.budget = step.expectedCost ?? 0;
    if (pending.budget > context.zeny) {
      this.fail('Insufficient zeny for the expected NPC charge.');
      return null;
    }
    if (this.spent + pending.budget > this.spec.maxSpend) {
      this.fail('Purchase would exceed the workflow budget.');
      return null;
    }
    for (const rule of this.spec.minStock) {
      if (
        (pending.itemChanges.get(itemId(rule.itemId)) ?? 0) < 0 &&
        (pending.items.get(itemId(rule.itemId)) ?? 0) +
          (pending.itemChanges.get(itemId(rule.itemId)) ?? 0) <
          rule.count
      ) {
        this.fail(`Operation would use the minimum stock for item ${rule.itemId}.`);
        return null;
      }
    }
    this.pending = pending;
    this.reason = `Waiting for step ${this.step + 1} confirmation.`;
    return action;
  }

  private prepare(action: WorldAction, context: WorkflowContext): Pending {
    const pending: Pending = {
      action,
      sentAt: this.now(),
      acknowledged: false,
      zeny: context.zeny,
      cost: 0,
      budget: 0,
      credit: 0,
      items: stock(context.inventory),
      bags: new Map(context.inventory.map((item) => [bagId(item.bagId), quantity(item.count)])),
      itemChanges: new Map(),
      bagChanges: new Map(),
      strictStock: this.strictStock,
    };
    const change = (id: ItemId, count: number) =>
      pending.itemChanges.set(id, (pending.itemChanges.get(id) ?? 0) + count);
    if (action.type === 'shop') {
      if (action.mode === 'buy') {
        const quote = shopQuote(action.rows, context)!;
        pending.cost = quote.cost;
        pending.budget = quote.budget;
        for (const row of action.rows) change(itemId(row.id), row.count);
      } else {
        pending.credit = saleProceeds(action.rows, context) ?? 0;
        for (const row of action.rows) {
          const item = context.inventory.find((item) => item.bagId === row.id)!;
          change(itemId(item.itemId), -row.count);
          pending.bagChanges.set(bagId(row.id), -row.count);
        }
      }
    } else if (action.type === 'storage' && action.operation !== 'close') {
      const item =
        action.operation === 'deposit'
          ? context.inventory.find((item) => item.bagId === action.bagId)!
          : context.world.storage.get(action.bagId)!;
      pending.storageItemId = item.itemId;
      change(itemId(item.itemId), action.operation === 'deposit' ? -action.count : action.count);
      if (action.operation === 'deposit')
        pending.bagChanges.set(bagId(action.bagId), -action.count);
    } else if (action.type === 'npcBarter') {
      const offer = context.world.barter[action.choice]!;
      pending.cost = offer.zenyCost * action.count;
      pending.budget = pending.cost;
      change(itemId(offer.item.itemId), offer.count * action.count);
      for (const ingredient of barterConsumption(action, context)!)
        change(itemId(ingredient.itemId), -ingredient.count);
      for (const id of action.bagIds) pending.bagChanges.set(bagId(id), -1);
    }
    return pending;
  }

  receipt(): WorkflowReceipt | null {
    const p = this.pending;
    return p
      ? {
          zeny: p.zeny,
          cost: p.cost,
          credit: p.credit,
          strictStock: p.strictStock,
          items: new Map(p.items),
          bags: new Map(p.bags),
          itemChanges: new Map(p.itemChanges),
          bagChanges: new Map(p.bagChanges),
        }
      : null;
  }
  /** Only a service's verified terminal outcome can settle its final pending step. */
  settleTerminal(context: WorkflowContext): boolean {
    if (
      !this.running ||
      !this.spec ||
      !this.terminal ||
      this.step !== this.spec.steps.length - 1 ||
      !this.pending ||
      !confirmWorkflowReceipt(this.pending, context)
    )
      return false;
    this.spent += Math.max(0, this.pending.zeny - context.zeny);
    this.step++;
    this.finish('complete', 'Service outcome and resource receipt confirmed.');
    return true;
  }

  snapshot(): WorkflowSnapshot {
    return {
      state: this.state,
      running: this.running,
      name: this.spec?.name ?? '',
      step: this.step,
      total: this.spec?.steps.length ?? 0,
      pending: this.pending?.action.type ?? null,
      reason: this.reason,
      spent: this.spent,
    };
  }
}

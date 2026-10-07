import { sameActionIdentity } from '../world/actor-identity';
import { isTalkNpc } from '../world/actor-interaction-logic';
import { confirmWorkflowReceipt } from './workflows-logic';
import {
  DEFAULT_MAP_POLICY,
  mapAllowed,
  policySummary,
  type MapPolicyInput as MapPolicy,
} from '../navigation/map-policy-logic';
import { routeBetweenMaps, routeBetweenMapsAsync } from '../navigation/travel';
import type { PlanningOptions } from '../navigation/route-planning';
import catalog from '../../data/npc-services.json';
import { distance, type WalkGrid } from '../navigation/navigation-logic';
import { GridNavigator, searchGrid } from '../navigation/navigation';
import type { Entity, GameEvent, Position } from '../protocol/protocol';
import type { WorldAction, WorldEvent } from '../protocol/world-protocol';
import { NpcWorkflow } from './workflows';
import type { TravelController } from '../navigation/travel-controller';

import {
  type NpcServiceDefinition,
  inside,
  validateServiceDefinition,
  serviceAvailability,
  validateServiceRequest,
  resolveServiceNpc,
  type ServiceContext,
  type ServiceSnapshot,
  type ServiceReceipt,
  type ServicePreviewContext,
} from './npc-services-logic';

export {
  type ServiceOutcome,
  type NpcServiceDefinition,
  validateServiceDefinition,
  BUILTIN_SERVICES,
  SERVICE_SOURCE,
  serviceByContractId,
  serviceAvailability,
  validateServiceRequest,
  type ServiceResolution,
  resolveServiceNpc,
  type ServiceContext,
  type ServiceSnapshot,
  type ServiceReceipt,
  validateServiceExecution,
  type ServicePreviewContext,
} from './npc-services-logic';

/** Late responses may drain a receipt, but this helper never issues another command. */
export function observeServiceReceipt(
  r: ServiceReceipt,
  events: readonly GameEvent[],
  worldEvents: readonly WorldEvent[],
  context: ServiceContext,
): void {
  if (
    context.connection !== r.connection ||
    (r.outcome?.type !== 'arrival' &&
      r.actorIdentity &&
      !sameActionIdentity(r.actorIdentity, context.actorIdentity?.(r.npcId)))
  )
    return;
  if (r.outcome?.type === 'arrival') {
    for (const e of events) {
      if (e.type === 'clear' && r.outcome.map === r.map && context.map === r.map)
        r.transition = true;
      if (e.type === 'map' && e.map === r.outcome.map) r.transition = true;
      if (
        e.type === 'spawn' &&
        r.transition &&
        e.entity.id === r.playerId &&
        e.entity.name === r.playerName &&
        e.entity.kind === 0 &&
        !e.entity.dead &&
        e.entity.hp > 0 &&
        (r.outcome.map !== r.map || e.entryType === 2) &&
        context.map === r.outcome.map &&
        distance(e.entity, r.outcome.position) === 0
      )
        r.arrived = true;
    }
    r.acknowledged ||= r.arrived;
  } else if (context.map === r.map && context.world.generation === r.generation) {
    const bound = context.world.npc.id === r.npcId || context.world.npc.id === null;
    r.acknowledged ||=
      bound &&
      worldEvents.some((e) =>
        r.outcome?.type === 'storageOpened'
          ? e.type === 'storageOpened'
          : r.outcome?.type === 'shopOpened'
            ? e.type === 'shopOpened' && e.mode === r.outcome.mode
            : ['npcDialog', 'npcOptions', 'npcEnd'].includes(e.type),
      );
  }
}

export function confirmServiceReceipt(r: ServiceReceipt, context: ServiceContext): boolean {
  return (
    context.connection === r.connection &&
    (r.outcome?.type === 'arrival' ||
      !r.actorIdentity ||
      sameActionIdentity(r.actorIdentity, context.actorIdentity?.(r.npcId))) &&
    r.acknowledged &&
    context.inventoryKnown &&
    confirmWorkflowReceipt(r.economic, context)
  );
}

/** One bounded owner coordinates travel, fresh identity binding and the shared workflow accounting. */
export class NpcServiceRuntime {
  private definition: NpcServiceDefinition | null = null;
  private state: ServiceSnapshot['state'] = 'idle';
  private reason = 'No service running.';
  private deadline = 0;
  private retainedPreparationDeadline: number | null = null;
  private binding: { actor: Entity; generation: number; connection: number } | null = null;
  private transition = false;
  private receiptValue: ServiceReceipt | null = null;
  private executionPolicy: MapPolicy = DEFAULT_MAP_POLICY;
  readonly workflow: NpcWorkflow;
  constructor(
    private readonly travel: TravelController,
    private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid,
  ) {
    this.workflow = new NpcWorkflow(now);
  }
  get active(): boolean {
    return ['preparing', 'travel', 'approach', 'locate', 'conversation', 'outcome'].includes(
      this.state,
    );
  }
  receipt(): ServiceReceipt | null {
    return this.receiptValue;
  }
  get preparingUnsent(): boolean {
    return (
      this.active &&
      ['preparing', 'travel', 'approach', 'locate'].includes(this.state) &&
      !this.receiptValue
    );
  }
  start(input: unknown, c: ServiceContext, policy: MapPolicy = DEFAULT_MAP_POLICY): void {
    if (this.active) throw new Error('Stop the current service first.');
    const s = validateServiceRequest(input);
    if (
      !mapAllowed(policy, s.map) ||
      (s.outcome.type === 'arrival' && !mapAllowed(policy, s.outcome.map))
    )
      throw new Error('Service map or arrival outcome is forbidden by the map policy.');
    this.executionPolicy = structuredClone(policy);
    if (!c.alive || !c.inventoryKnown || c.zeny < 0)
      throw new Error('A living character, confirmed inventory and balance are required.');
    if ((c.basicSkillLevel ?? 0) < s.basicSkillLevel)
      throw new Error(`Basic Mastery level ${s.basicSkillLevel} is required.`);
    if (c.world.npc.id !== null || c.world.npc.mode !== 'idle' || c.world.vending)
      throw new Error('Finish the current NPC or vending interaction first.');
    for (const r of s.workflow.minStock)
      if (c.inventory.reduce((n, i) => n + (i.itemId === r.itemId ? i.count : 0), 0) < r.count)
        throw new Error(`Minimum stock for item ${r.itemId} is unavailable.`);
    const fees = s.workflow.steps.reduce(
      (n, step) => n + ('expectedCost' in step ? (step.expectedCost ?? 0) : 0),
      0,
    );
    if (fees > s.workflow.maxSpend || fees > c.zeny)
      throw new Error('Declared service fees exceed the budget or balance.');
    this.definition = s;
    this.state = 'preparing';
    this.reason = 'Preparing the service visit.';
    this.deadline = this.now() + 1_200_000;
    this.binding = null;
    this.transition = false;
    this.receiptValue = null;
    this.retainedPreparationDeadline = null;
  }
  cancel(reason = 'Service stopped by you.', failed = false): void {
    if (this.travel.active) this.travel.cancel(reason, failed);
    this.workflow.cancel(reason);
    this.state = failed ? 'failed' : 'cancelled';
    this.reason = reason;
  }
  private validBinding(c: ServiceContext): boolean {
    const b = this.binding,
      s = this.definition;
    if (
      !b ||
      !s ||
      c.map !== s.map ||
      c.world.generation !== b.generation ||
      c.connection !== b.connection
    )
      return false;
    const a = c.actors.find((a) => a.id === b.actor.id);
    return (
      !!a &&
      !a.dead &&
      a.kind === s.identity.kind &&
      isTalkNpc(a) &&
      a.name === b.actor.name &&
      a.classId === b.actor.classId &&
      distance(a, b.actor) === 0
    );
  }
  observe(
    events: readonly GameEvent[],
    worldEvents: readonly WorldEvent[],
    c: ServiceContext,
    continuePreparation = false,
  ): void {
    if (this.receiptValue) observeServiceReceipt(this.receiptValue, events, worldEvents, c);
    if (!this.active) return;
    if (
      events.some(
        (e) =>
          e.type === 'enter' ||
          e.type === 'requestFailure' ||
          e.type === 'skillFailure' ||
          (e.type === 'death' && e.id === c.playerId),
      ) ||
      worldEvents.some(
        (e) => e.type === 'npcFocus' && e.focus && this.binding && e.id !== this.binding.actor.id,
      )
    ) {
      this.cancel('Service session or NPC focus changed.', true);
      return;
    }
    for (const e of events)
      if (e.type === 'map' || e.type === 'clear') {
        if (continuePreparation && this.preparingUnsent) {
          this.retainedPreparationDeadline = Math.min(
            this.retainedPreparationDeadline ?? Infinity,
            this.deadline,
          );
          if (this.state !== 'travel' && this.state !== 'approach') this.state = 'preparing';
          this.reason = 'Retaining the unsent service visit after official travel.';
          continue;
        }
        if (this.state === 'travel') {
          continue;
        }
        const outcome = this.definition!.outcome;
        if (
          this.state !== 'outcome' ||
          outcome.type !== 'arrival' ||
          (e.type === 'map' && e.map !== outcome.map)
        ) {
          this.cancel('Service stopped after an unexpected world transition.', true);
          return;
        }
        this.transition = true;
      }
    if (
      this.state === 'outcome' &&
      this.transition &&
      this.definition!.outcome.type === 'arrival'
    ) {
      const outcome = this.definition!.outcome;
      if (
        events.some(
          (e) =>
            e.type === 'spawn' &&
            e.entity.id === c.playerId &&
            (e.entity.kind !== 0 ||
              e.entity.name !== this.receiptValue?.playerName ||
              e.entity.dead ||
              e.entity.hp <= 0 ||
              c.map !== outcome.map ||
              distance(e.entity, outcome.position) !== 0),
        )
      ) {
        this.cancel(
          'Service arrival did not match the exact living character and destination.',
          true,
        );
        return;
      }
    }
    if (this.state === 'conversation') this.workflow.observe([...worldEvents], c);
    if (this.state === 'outcome' && !this.transition && this.definition!.outcome.type !== 'arrival')
      this.workflow.observe([...worldEvents], c);
  }
  tick(c: ServiceContext): WorldAction | null {
    if (!this.active || !this.definition) return null;
    const s = this.definition;
    if (this.now() > Math.min(this.deadline, this.retainedPreparationDeadline ?? Infinity)) {
      this.cancel('Service phase timed out; no repeat request was sent.', true);
      return null;
    }
    if (
      !c.alive &&
      !(
        ((this.state === 'outcome' && this.transition) ||
          (['travel', 'approach'].includes(this.state) &&
            this.travel.snapshot().state === 'transition') ||
          (this.retainedPreparationDeadline !== null && this.preparingUnsent)) &&
        !c.player
      )
    ) {
      this.cancel('Service character is unavailable or dead.', true);
      return null;
    }
    if (this.state === 'outcome') {
      if (!this.transition && !this.validBinding(c)) {
        this.cancel('The bound NPC disappeared, moved or changed.', true);
        return null;
      }
      if (
        this.receiptValue &&
        confirmServiceReceipt(this.receiptValue, c) &&
        this.workflow.settleTerminal(c)
      ) {
        this.state = 'complete';
        this.reason =
          'Service outcome confirmed; authoritative resources have no contradictory change.';
      }
      return null;
    }
    if (this.state === 'preparing') {
      if (!c.idle || !c.player) return null;
      const grid = this.gridFor(c.map),
        onPortal = grid?.portals?.some(
          (a) =>
            Math.abs(c.player!.x - a.x) <= a.halfWidth &&
            Math.abs(c.player!.y - a.y) <= a.halfHeight,
        );
      if (c.map !== s.map || onPortal) {
        try {
          this.travel.start(c.map, c.player, s.map, 10, true, this.executionPolicy, 'service');
          this.state = 'travel';
          this.reason = 'Travelling to the service map.';
        } catch (e) {
          this.cancel(e instanceof Error ? e.message : 'No verified route.', true);
        }
        return null;
      }
      this.beginApproach(c);
      return null;
    }
    if (this.state === 'travel' || this.state === 'approach') {
      this.travel.tick(c.map, c.player);
      const t = this.travel.snapshot();
      if (t.state === 'failed' || t.state === 'cancelled') {
        this.cancel(t.reason, true);
        return null;
      }
      if (t.state === 'complete') {
        if (this.state === 'travel') this.beginApproach(c);
        else {
          this.state = 'locate';
          this.deadline = this.now() + 30_000;
          this.reason = 'Resolving the freshly visible NPC.';
        }
      }
      return null;
    }
    if (this.state === 'locate') {
      const r = resolveServiceNpc(s, c.map, c.actors);
      this.reason = r.reason;
      if (r.state === 'ambiguous') {
        this.cancel(r.reason, true);
        return null;
      }
      if (r.state !== 'resolved' || !c.player || !c.idle) return null;
      if (
        !inside(c.player, s.approach) ||
        distance(c.player, r.actor) > s.approach.interactionRange
      ) {
        this.cancel('Character left the verified NPC approach area.', true);
        return null;
      }
      this.binding = {
        actor: { ...r.actor },
        generation: c.world.generation,
        connection: c.connection,
      };
      const result = this.workflow.start(
        { name: s.name, map: s.map, npcId: r.actor.id, ...s.workflow },
        c,
        {
          terminal: true,
          strictStock: true,
        },
      );
      if (!result.ok) {
        this.cancel(result.reasons.join(' '), true);
        return null;
      }
      this.state = 'conversation';
      this.deadline = this.now() + s.workflow.timeoutMs * (s.workflow.steps.length + 1);
    }
    if (this.state === 'conversation') {
      if (
        !this.validBinding(c) ||
        !c.player ||
        !inside(c.player, s.approach) ||
        distance(c.player, this.binding!.actor) > s.approach.interactionRange
      ) {
        this.cancel('The bound NPC or character approach changed.', true);
        return null;
      }
      const action = this.workflow.tick(c),
        w = this.workflow.snapshot();
      if (w.state === 'failed' || w.state === 'cancelled') {
        this.cancel(w.reason, true);
        return null;
      }
      if (action) {
        const terminal = w.step === s.workflow.steps.length - 1,
          economic = this.workflow.receipt()!;
        this.receiptValue = {
          ...(c.actorIdentity?.(this.binding!.actor.id)
            ? { actorIdentity: c.actorIdentity(this.binding!.actor.id)! }
            : {}),
          economic,
          map: c.map,
          generation: c.world.generation,
          npcId: this.binding!.actor.id,
          playerId: c.player!.id,
          playerName: c.player!.name,
          connection: c.connection,
          outcome: terminal ? s.outcome : null,
          acknowledged: false,
          transition: false,
          arrived: false,
        };
        if (terminal) {
          this.state = 'outcome';
          this.deadline = this.now() + s.outcome.timeoutMs;
          this.reason = 'Waiting for the declared service outcome and resource receipt.';
        }
      } else if (!w.pending) this.receiptValue = null;
      return action;
    }
    return null;
  }
  private beginApproach(c: ServiceContext): void {
    const s = this.definition!,
      grid = this.gridFor(s.map);
    if (!grid || !c.player) {
      this.cancel('Verified approach map or character is unavailable.', true);
      return;
    }
    const nav = new GridNavigator(grid);
    let best: Position[] | null = null;
    for (
      let y = s.approach.y - s.approach.halfHeight;
      y <= s.approach.y + s.approach.halfHeight;
      y++
    )
      for (
        let x = s.approach.x - s.approach.halfWidth;
        x <= s.approach.x + s.approach.halfWidth;
        x++
      ) {
        const route = nav.plan(
          { x: Math.floor(c.player.x), y: Math.floor(c.player.y) },
          { x, y },
          { avoidWalls: true },
        );
        if (route?.length && (!best || route.length < best.length)) best = route;
      }
    if (!best?.length || best.length > 512) {
      this.cancel('No bounded route reaches the verified NPC approach area.', true);
      return;
    }
    try {
      this.travel.startApproach(s.map, c.player, best.at(-1)!, 10, this.executionPolicy, 'service');
      this.state = 'approach';
      this.deadline = this.now() + 300_000;
      this.reason = 'Approaching the service NPC.';
    } catch (e) {
      this.cancel(e instanceof Error ? e.message : 'NPC approach failed.', true);
    }
  }
  snapshot(): ServiceSnapshot {
    const w = this.workflow.snapshot();
    return {
      state: this.state,
      active: this.active,
      name: this.definition?.name ?? '',
      contractId: this.definition?.contractId ?? '',
      reason: this.reason,
      step: w.step,
      total: this.definition?.workflow.steps.length ?? 0,
      spent: w.spent,
      npcId: this.binding?.actor.id ?? null,
    };
  }
}

export async function previewServiceAsync(
  input: unknown,
  c: ServicePreviewContext,
  policy: MapPolicy = DEFAULT_MAP_POLICY,
  options: PlanningOptions = {},
): Promise<ReturnType<typeof previewService>> {
  const context = structuredClone(c),
    detachedPolicy = structuredClone(policy);
  let service: NpcServiceDefinition;
  try {
    service = validateServiceDefinition(input);
  } catch {
    return previewService(input, context, detachedPolicy);
  }
  const reachable =
    !context.player ||
    context.map === service.map ||
    !!(await routeBetweenMapsAsync(
      context.map,
      context.player,
      service.map,
      true,
      detachedPolicy,
      options,
    ));
  return servicePreview(service, context, detachedPolicy, reachable);
}

export function previewService(
  input: unknown,
  c: ServicePreviewContext,
  policy: MapPolicy = DEFAULT_MAP_POLICY,
): { available: boolean; reasons: string[]; summary: string } {
  return servicePreview(input, c, policy);
}

function servicePreview(
  input: unknown,
  c: ServicePreviewContext,
  policy: MapPolicy = DEFAULT_MAP_POLICY,
  routeAvailable?: boolean,
): { available: boolean; reasons: string[]; summary: string } {
  let s: NpcServiceDefinition;
  try {
    s = validateServiceDefinition(input);
  } catch (e) {
    return {
      available: false,
      reasons: [e instanceof Error ? e.message : 'Invalid service.'],
      summary: '',
    };
  }
  const unavailable = serviceAvailability(s),
    reasons: string[] = [];
  if (unavailable) reasons.push(unavailable);
  if (
    !mapAllowed(policy, s.map) ||
    (s.outcome.type === 'arrival' && !mapAllowed(policy, s.outcome.map))
  )
    reasons.push('Service map or arrival outcome is forbidden by the map policy.');
  if (
    c.player &&
    c.map !== s.map &&
    !(routeAvailable ?? !!routeBetweenMaps(c.map, c.player, s.map, true, policy))
  )
    reasons.push('No allowed verified portal route reaches this service.');
  if (!c.inventoryKnown || c.zeny === null)
    reasons.push('Wait for authoritative inventory and balance.');
  if (c.basicSkillLevel === null || c.basicSkillLevel < s.basicSkillLevel)
    reasons.push(`Basic Mastery level ${s.basicSkillLevel} is required.`);
  const fees = s.workflow.steps.reduce(
    (n, step) => n + ('expectedCost' in step ? (step.expectedCost ?? 0) : 0),
    0,
  );
  if (fees > s.workflow.maxSpend || (c.zeny !== null && fees > c.zeny))
    reasons.push('Declared fees exceed the budget or balance.');
  for (const r of s.workflow.minStock)
    if ((c.stock[r.itemId] ?? 0) < r.count)
      reasons.push(`Keep at least ${r.count} of item ${r.itemId}.`);
  if (c.map === s.map) {
    const r = resolveServiceNpc(s, c.map, c.actors);
    if (r.state !== 'resolved') reasons.push(r.reason);
    const grid = searchGrid(s.map);
    if (c.player && grid) {
      const nav = new GridNavigator(grid);
      let reachable = false;
      for (
        let y = s.approach.y - s.approach.halfHeight;
        y <= s.approach.y + s.approach.halfHeight;
        y++
      )
        for (
          let x = s.approach.x - s.approach.halfWidth;
          x <= s.approach.x + s.approach.halfWidth;
          x++
        ) {
          const route = nav.plan(
            { x: Math.floor(c.player.x), y: Math.floor(c.player.y) },
            { x, y },
            { avoidWalls: true },
          );
          if (route && route.length <= 512) reachable = true;
        }
      if (!reachable) reasons.push('Final approach is unreachable or exceeds 512 cells.');
    }
  } else reasons.push(`A verified portal trip to ${s.map} will be planned on Run service.`);
  if (!c.player) reasons.push('Wait for a ready character position.');
  const outcome =
    s.outcome.type === 'arrival'
      ? `fresh own arrival in ${s.outcome.map} at ${s.outcome.position.x},${s.outcome.position.y}`
      : s.outcome.type === 'shopOpened'
        ? `authoritative ${s.outcome.mode} shop snapshot`
        : 'authoritative storage-open snapshot';
  const observed =
    !unavailable && catalog.observedVariants.find((v) => v.contractId === s.contractId);
  const provenance = observed
    ? `Baseline source ${s.sourcePath} at ${s.sourcePin}. Exact non-cart storage menu and opening observed on SEA 01 on 2026-10-02; no balance or inventory contradiction. Other services and transfers are not covered.`
    : `Source ${s.sourcePath} at ${s.sourcePin}; deployed contract has not been live verified.`;
  return {
    available:
      !unavailable &&
      mapAllowed(policy, s.map) &&
      (s.outcome.type !== 'arrival' || mapAllowed(policy, s.outcome.map)),
    reasons,
    summary: `${policySummary(policy, c.map)}\n${s.identity.name} · ${s.map} ${s.identity.anchor.x},${s.identity.anchor.y} · NPC kind2\nApproach: ${s.approach.x - s.approach.halfWidth}–${s.approach.x + s.approach.halfWidth}, ${s.approach.y - s.approach.halfHeight}–${s.approach.y + s.approach.halfHeight}; interaction range ${s.approach.interactionRange}\nBasic Mastery ${s.basicSkillLevel} · Fees ${fees} zeny · Spend cap ${s.workflow.maxSpend}\n${s.workflow.steps.length} exact dialogue/menu steps → ${outcome}\n${provenance}`,
  };
}

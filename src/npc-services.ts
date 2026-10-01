import catalog from './data/npc-services.json';
import { distance, GridNavigator, searchGrid, type WalkGrid } from './navigation';
import type { Entity, GameEvent, Position } from './protocol';
import type { WorldAction, WorldEvent } from './world-protocol';
import {
  NpcWorkflow,
  confirmWorkflowReceipt,
  validateWorkflowSpec,
  type WorkflowContext,
  type WorkflowReceipt,
  type WorkflowStep,
} from './workflows';
import { TravelController } from './travel-controller';

export type ServiceOutcome =
  | { type: 'storageOpened'; timeoutMs: number }
  | { type: 'arrival'; map: string; position: Position; timeoutMs: number }
  | { type: 'shopOpened'; mode: 'buy' | 'sell'; timeoutMs: number };
export interface NpcServiceDefinition {
  version: 1;
  id: string;
  name: string;
  contractId: string;
  sourcePin: string;
  sourcePath: string;
  map: string;
  identity: { kind: 2; name: string; anchor: Position; maxDisplacement: number };
  approach: Position & { halfWidth: number; halfHeight: number; interactionRange: number };
  basicSkillLevel: number;
  workflow: {
    maxSpend: number;
    minStock: { itemId: number; count: number }[];
    timeoutMs: number;
    steps: WorkflowStep[];
  };
  outcome: ServiceOutcome;
}
const object = (v: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !v ||
    typeof v !== 'object' ||
    Array.isArray(v) ||
    Object.keys(v).length !== keys.length ||
    Object.keys(v).some((k) => !keys.includes(k))
  )
    throw new Error('Invalid service fields.');
  return v as Record<string, unknown>;
};
const integer = (v: unknown, min: number, max: number): number => {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) throw new Error('Invalid service number.');
  return v;
};
const text = (v: unknown, max: number): string => {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\u0000-\u001f\u007f]/.test(v))
    throw new Error('Invalid service text.');
  return v;
};
const point = (v: unknown): Position => {
  const p = object(v, ['x', 'y']);
  return { x: integer(p.x, 0, 511), y: integer(p.y, 0, 511) };
};
const code = (v: unknown): string => {
  const s = text(v, 64);
  if (!/^[a-zA-Z0-9_-]+$/.test(s)) throw new Error('Invalid service identifier.');
  return s;
};
const inside = (p: Position, a: NpcServiceDefinition['approach']): boolean =>
  Math.abs(p.x - a.x) <= a.halfWidth && Math.abs(p.y - a.y) <= a.halfHeight;

/** Portable configuration only. Conversation state, entity IDs and bag IDs are deliberately absent. */
export function validateServiceDefinition(input: unknown): NpcServiceDefinition {
  if (new TextEncoder().encode(JSON.stringify(input)).length > 65_536)
    throw new Error('Service definition is too large.');
  const s = object(input, [
    'version',
    'id',
    'name',
    'contractId',
    'sourcePin',
    'sourcePath',
    'map',
    'identity',
    'approach',
    'basicSkillLevel',
    'workflow',
    'outcome',
  ]);
  if (s.version !== 1) throw new Error('Unsupported service version.');
  const map = code(s.map),
    grid = searchGrid(map);
  if (!grid) throw new Error('Unsupported service map.');
  const identity = object(s.identity, ['kind', 'name', 'anchor', 'maxDisplacement']);
  if (identity.kind !== 2) throw new Error('Services require an NPC actor.');
  const anchor = point(identity.anchor),
    maxDisplacement = integer(identity.maxDisplacement, 0, 2);
  const a = object(s.approach, ['x', 'y', 'halfWidth', 'halfHeight', 'interactionRange']);
  const approach = {
    x: integer(a.x, 0, 511),
    y: integer(a.y, 0, 511),
    halfWidth: integer(a.halfWidth, 0, 4),
    halfHeight: integer(a.halfHeight, 0, 4),
    interactionRange: integer(a.interactionRange, 1, 5),
  };
  for (let y = approach.y - approach.halfHeight; y <= approach.y + approach.halfHeight; y++)
    for (let x = approach.x - approach.halfWidth; x <= approach.x + approach.halfWidth; x++) {
      if (
        !grid.walkable({ x, y }) ||
        distance({ x, y }, anchor) + maxDisplacement > approach.interactionRange ||
        grid.portals?.some((p) => Math.abs(x - p.x) <= p.halfWidth && Math.abs(y - p.y) <= p.halfHeight)
      )
        throw new Error('Service approach must be walkable, outside portals and in interaction range.');
    }
  const w = object(s.workflow, ['maxSpend', 'minStock', 'timeoutMs', 'steps']);
  const workflow = validateWorkflowSpec({ name: text(s.name, 64), map, npcId: 1, ...w });
  if (workflow.steps.some((step) => !['talk', 'advance', 'option'].includes(step.type)))
    throw new Error('Reusable service steps cannot persist item or bag selections.');
  const outcomeType = (s.outcome as { type?: unknown })?.type;
  const o = object(
    s.outcome,
    outcomeType === 'arrival'
      ? ['type', 'map', 'position', 'timeoutMs']
      : outcomeType === 'shopOpened'
        ? ['type', 'mode', 'timeoutMs']
        : ['type', 'timeoutMs'],
  );
  let outcome: ServiceOutcome;
  const timeoutMs = integer(o.timeoutMs, 1000, 60_000);
  if (o.type === 'storageOpened') outcome = { type: o.type, timeoutMs };
  else if (o.type === 'arrival') {
    const destination = code(o.map),
      position = point(o.position);
    if (!searchGrid(destination)?.walkable(position))
      throw new Error('Service arrival needs a supported walkable cell.');
    outcome = { type: o.type, map: destination, position, timeoutMs };
  } else if (o.type === 'shopOpened' && (o.mode === 'buy' || o.mode === 'sell'))
    outcome = { type: o.type, mode: o.mode, timeoutMs };
  else throw new Error('Unsupported service outcome.');
  const sourcePin = text(s.sourcePin, 40);
  if (!/^[a-f0-9]{40}$/.test(sourcePin)) throw new Error('Invalid service source pin.');
  return {
    version: 1,
    id: code(s.id),
    name: workflow.name,
    contractId: text(s.contractId, 128),
    sourcePin,
    sourcePath: text(s.sourcePath, 256),
    map,
    identity: { kind: 2, name: text(identity.name, 128), anchor, maxDisplacement },
    approach,
    basicSkillLevel: integer(s.basicSkillLevel, 0, 10),
    workflow: {
      maxSpend: workflow.maxSpend,
      minStock: workflow.minStock,
      steps: workflow.steps,
      timeoutMs: workflow.timeoutMs!,
    },
    outcome,
  };
}
export const BUILTIN_SERVICES: readonly NpcServiceDefinition[] = catalog.contracts.map(validateServiceDefinition);
export const SERVICE_SOURCE = catalog.source;
export function serviceByContractId(contractId: string): NpcServiceDefinition | null {
  const definition = BUILTIN_SERVICES.find((service) => service.contractId === contractId);
  return definition ? validateServiceDefinition(definition) : null;
}
function contractFields(s: NpcServiceDefinition): unknown {
  return {
    version: s.version,
    contractId: s.contractId,
    sourcePin: s.sourcePin,
    sourcePath: s.sourcePath,
    map: s.map,
    identity: s.identity,
    approach: s.approach,
    basicSkillLevel: s.basicSkillLevel,
    steps: s.workflow.steps,
    outcome: s.outcome,
  };
}
export function serviceAvailability(s: NpcServiceDefinition): string | null {
  const known = BUILTIN_SERVICES.find((k) => k.contractId === s.contractId);
  return !known
    ? 'No verified adapter for this service contract.'
    : JSON.stringify(contractFields(s)) !== JSON.stringify(contractFields(known))
      ? 'This edited contract differs from the verified source and is unavailable.'
      : null;
}
export function validateServiceRequest(input: unknown): NpcServiceDefinition {
  const s = validateServiceDefinition(input),
    reason = serviceAvailability(s);
  if (reason) throw new Error(reason);
  return s;
}
export type ServiceResolution =
  | { state: 'missing' | 'ambiguous'; reason: string }
  | { state: 'resolved'; actor: Entity; reason: string };
export function resolveServiceNpc(s: NpcServiceDefinition, map: string, actors: readonly Entity[]): ServiceResolution {
  if (map !== s.map) return { state: 'missing', reason: `Enter ${s.map} before resolving this NPC.` };
  const matches = actors.filter(
    (a) =>
      a.kind === 2 &&
      !a.dead &&
      a.name === s.identity.name &&
      distance(a, s.identity.anchor) <= s.identity.maxDisplacement,
  );
  if (matches.length > 1)
    return { state: 'ambiguous', reason: 'More than one visible NPC matches the service identity.' };
  return matches[0]
    ? { state: 'resolved', actor: { ...matches[0] }, reason: 'Fresh NPC identity resolved.' }
    : { state: 'missing', reason: 'Waiting for the exact NPC to become visible at its verified anchor.' };
}
export interface ServiceContext extends WorkflowContext {
  player: Entity | undefined;
  actors: readonly Entity[];
  connection: number;
  inventoryKnown: boolean;
}
export interface ServiceSnapshot {
  state:
    | 'idle'
    | 'preparing'
    | 'travel'
    | 'approach'
    | 'locate'
    | 'conversation'
    | 'outcome'
    | 'complete'
    | 'failed'
    | 'cancelled';
  active: boolean;
  name: string;
  contractId: string;
  reason: string;
  step: number;
  total: number;
  spent: number;
  npcId: number | null;
}
export interface ServiceReceipt {
  economic: WorkflowReceipt;
  map: string;
  generation: number;
  npcId: number;
  playerId: number;
  playerName: string;
  connection: number;
  outcome: ServiceOutcome | null;
  acknowledged: boolean;
  transition: boolean;
  arrived: boolean;
}
/** Late responses may drain a receipt, but this helper never issues another command. */
export function observeServiceReceipt(
  r: ServiceReceipt,
  events: readonly GameEvent[],
  worldEvents: readonly WorldEvent[],
  context: ServiceContext,
): void {
  if (context.connection !== r.connection) return;
  if (r.outcome?.type === 'arrival') {
    for (const e of events) {
      if (e.type === 'clear' && r.outcome.map === r.map && context.map === r.map) r.transition = true;
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
  private binding: { actor: Entity; generation: number; connection: number } | null = null;
  private transition = false;
  private receiptValue: ServiceReceipt | null = null;
  readonly workflow: NpcWorkflow;
  constructor(
    private readonly travel: TravelController,
    private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid,
  ) {
    this.workflow = new NpcWorkflow(now);
  }
  get active(): boolean {
    return ['preparing', 'travel', 'approach', 'locate', 'conversation', 'outcome'].includes(this.state);
  }
  receipt(): ServiceReceipt | null {
    return this.receiptValue;
  }
  start(input: unknown, c: ServiceContext): void {
    if (this.active) throw new Error('Stop the current service first.');
    const s = validateServiceRequest(input);
    if (!c.alive || !c.inventoryKnown || c.zeny < 0)
      throw new Error('A living character, confirmed inventory and balance are required.');
    if ((c.basicSkillLevel ?? 0) < s.basicSkillLevel)
      throw new Error(`Basic Mastery level ${s.basicSkillLevel} is required.`);
    if (c.world.npc.id !== null || c.world.npc.mode !== 'idle' || c.world.vending)
      throw new Error('Finish the current NPC or vending interaction first.');
    for (const r of s.workflow.minStock)
      if (c.inventory.reduce((n, i) => n + (i.itemId === r.itemId ? i.count : 0), 0) < r.count)
        throw new Error(`Minimum stock for item ${r.itemId} is unavailable.`);
    const fees = s.workflow.steps.reduce((n, step) => n + ('expectedCost' in step ? (step.expectedCost ?? 0) : 0), 0);
    if (fees > s.workflow.maxSpend || fees > c.zeny)
      throw new Error('Declared service fees exceed the budget or balance.');
    this.definition = s;
    this.state = 'preparing';
    this.reason = 'Preparing the service visit.';
    this.deadline = this.now() + 1_200_000;
    this.binding = null;
    this.transition = false;
    this.receiptValue = null;
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
    if (!b || !s || c.map !== s.map || c.world.generation !== b.generation || c.connection !== b.connection)
      return false;
    const a = c.actors.find((a) => a.id === b.actor.id);
    return (
      !!a &&
      !a.dead &&
      a.kind === 2 &&
      a.name === b.actor.name &&
      a.classId === b.actor.classId &&
      distance(a, b.actor) === 0
    );
  }
  observe(events: readonly GameEvent[], worldEvents: readonly WorldEvent[], c: ServiceContext): void {
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
      worldEvents.some((e) => e.type === 'npcFocus' && e.focus && this.binding && e.id !== this.binding.actor.id)
    ) {
      this.cancel('Service session or NPC focus changed.', true);
      return;
    }
    for (const e of events)
      if (e.type === 'map' || e.type === 'clear') {
        if (this.state === 'travel') {
          continue;
        }
        const outcome = this.definition!.outcome;
        if (this.state !== 'outcome' || outcome.type !== 'arrival' || (e.type === 'map' && e.map !== outcome.map)) {
          this.cancel('Service stopped after an unexpected world transition.', true);
          return;
        }
        this.transition = true;
      }
    if (this.state === 'outcome' && this.transition && this.definition!.outcome.type === 'arrival') {
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
        this.cancel('Service arrival did not match the exact living character and destination.', true);
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
    if (this.now() > this.deadline) {
      this.cancel('Service phase timed out; no repeat request was sent.', true);
      return null;
    }
    if (
      !c.alive &&
      !(
        ((this.state === 'outcome' && this.transition) ||
          (this.state === 'travel' && this.travel.snapshot().state === 'transition')) &&
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
      if (this.receiptValue && confirmServiceReceipt(this.receiptValue, c) && this.workflow.settleTerminal(c)) {
        this.state = 'complete';
        this.reason = 'Service outcome confirmed; authoritative resources have no contradictory change.';
      }
      return null;
    }
    if (this.state === 'preparing') {
      if (!c.idle || !c.player) return null;
      const grid = this.gridFor(c.map),
        onPortal = grid?.portals?.some(
          (a) => Math.abs(c.player!.x - a.x) <= a.halfWidth && Math.abs(c.player!.y - a.y) <= a.halfHeight,
        );
      if (c.map !== s.map || onPortal) {
        try {
          this.travel.start(c.map, c.player, s.map, 10, true);
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
      if (!inside(c.player, s.approach) || distance(c.player, r.actor) > s.approach.interactionRange) {
        this.cancel('Character left the verified NPC approach area.', true);
        return null;
      }
      this.binding = { actor: { ...r.actor }, generation: c.world.generation, connection: c.connection };
      const result = this.workflow.start({ name: s.name, map: s.map, npcId: r.actor.id, ...s.workflow }, c, {
        terminal: true,
        strictStock: true,
      });
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
          economic,
          map: c.map,
          generation: c.world.generation,
          npcId: this.binding!.actor.id,
          playerId: c.playerId,
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
    for (let y = s.approach.y - s.approach.halfHeight; y <= s.approach.y + s.approach.halfHeight; y++)
      for (let x = s.approach.x - s.approach.halfWidth; x <= s.approach.x + s.approach.halfWidth; x++) {
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
      this.travel.startApproach(s.map, c.player, best.at(-1)!);
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

export interface ServicePreviewContext {
  map: string;
  player: Position | null;
  actors: readonly Entity[];
  inventoryKnown: boolean;
  zeny: number | null;
  basicSkillLevel: number | null;
  stock: Readonly<Record<string, number>>;
}
export function previewService(
  input: unknown,
  c: ServicePreviewContext,
): { available: boolean; reasons: string[]; summary: string } {
  let s: NpcServiceDefinition;
  try {
    s = validateServiceDefinition(input);
  } catch (e) {
    return { available: false, reasons: [e instanceof Error ? e.message : 'Invalid service.'], summary: '' };
  }
  const unavailable = serviceAvailability(s),
    reasons: string[] = [];
  if (unavailable) reasons.push(unavailable);
  if (!c.inventoryKnown || c.zeny === null) reasons.push('Wait for authoritative inventory and balance.');
  if (c.basicSkillLevel === null || c.basicSkillLevel < s.basicSkillLevel)
    reasons.push(`Basic Mastery level ${s.basicSkillLevel} is required.`);
  const fees = s.workflow.steps.reduce((n, step) => n + ('expectedCost' in step ? (step.expectedCost ?? 0) : 0), 0);
  if (fees > s.workflow.maxSpend || (c.zeny !== null && fees > c.zeny))
    reasons.push('Declared fees exceed the budget or balance.');
  for (const r of s.workflow.minStock)
    if ((c.stock[r.itemId] ?? 0) < r.count) reasons.push(`Keep at least ${r.count} of item ${r.itemId}.`);
  if (c.map === s.map) {
    const r = resolveServiceNpc(s, c.map, c.actors);
    if (r.state !== 'resolved') reasons.push(r.reason);
    const grid = searchGrid(s.map);
    if (c.player && grid) {
      const nav = new GridNavigator(grid);
      let reachable = false;
      for (let y = s.approach.y - s.approach.halfHeight; y <= s.approach.y + s.approach.halfHeight; y++)
        for (let x = s.approach.x - s.approach.halfWidth; x <= s.approach.x + s.approach.halfWidth; x++) {
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
  const observed = !unavailable && catalog.observedVariants.find(v => v.contractId === s.contractId);
  const provenance = observed
    ? `Baseline source ${s.sourcePath} at ${s.sourcePin}. Exact non-cart storage menu and opening observed on SEA 01 on 2026-10-02; no balance or inventory contradiction. Other services and transfers are not covered.`
    : `Source ${s.sourcePath} at ${s.sourcePin}; deployed contract has not been live verified.`;
  return {
    available: !unavailable,
    reasons,
    summary: `${s.identity.name} · ${s.map} ${s.identity.anchor.x},${s.identity.anchor.y} · NPC kind2\nApproach: ${s.approach.x - s.approach.halfWidth}–${s.approach.x + s.approach.halfWidth}, ${s.approach.y - s.approach.halfHeight}–${s.approach.y + s.approach.halfHeight}; interaction range ${s.approach.interactionRange}\nBasic Mastery ${s.basicSkillLevel} · Fees ${fees} zeny · Spend cap ${s.workflow.maxSpend}\n${s.workflow.steps.length} exact dialogue/menu steps → ${outcome}\n${provenance}`,
  };
}

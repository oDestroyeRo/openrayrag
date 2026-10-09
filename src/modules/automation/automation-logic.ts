import { map } from 'effect/Array';
import {
  itemId,
  dropId,
  quantity,
  milliseconds,
  type ItemId,
  type SkillId,
  type Revision,
  type Milliseconds,
  type Quantity,
  type DropId,
} from '../../shared/domain-values';
import { foldConditions, unavailableFirstConditions } from '../../shared/condition-logic';
import type { AutomationScheduler } from './automation';
import type { ActionIdentity } from '../world/actor-identity';
import type { matchesSkillExecution } from '../combat/skill-execution';
import type {
  AutomationPolicy as AutomationSettings,
  AutomationSettingsInput,
} from '../settings/settings';
import type { Entity, Drop, GameEvent } from '../protocol/protocol';
import {
  actorPredicateEvaluator,
  type ActorObservationSnapshot,
} from '../world/actor-observations-logic';
import type { CharacterState } from '../world/character-state';
import { SKILL_CATALOG, itemName } from '../catalog/game-catalog';
import type { ExpandedAction, Attributes } from '../protocol/protocol-feature';
export function monsterRule(
  a: Pick<AutomationSettings, 'combat'>,
  classId: number,
): AutomationSettings['combat']['rules'][number] | undefined {
  return a.combat.rules.find((r) => r.classId === classId);
}

export function lootRule(
  a: Pick<AutomationSettings, 'loot'>,
  itemId: ItemId,
): AutomationSettings['loot']['rules'][number] | undefined {
  return a.loot.rules.find((r) => r.itemId === itemId);
}

export function acceptsMonster(
  a: Pick<AutomationSettings, 'combat'>,
  e: Entity,
  player: Entity,
  selected: readonly number[],
  aggressive: boolean,
  observations?: ActorObservationSnapshot,
): boolean {
  let rule = monsterRule(a, e.classId);
  if (rule?.conditions?.length) {
    const traces = map(rule.conditions, actorPredicateEvaluator(observations));
    const state = foldConditions(traces, unavailableFirstConditions);
    if (state === 'unavailable') return false;
    if (state === 'unmatched') {
      if (rule.action === 'attack') return false;
      rule = undefined; // A known-false ignore condition leaves ordinary selection in control.
    }
  }
  if (
    a.combat.mode === 'off' ||
    rule?.action === 'ignore' ||
    e.level > player.level + a.combat.levelDifference
  )
    return false;
  const matching = selected.includes(e.classId) || rule?.action === 'attack';
  return a.combat.mode === 'selected'
    ? matching
    : a.combat.mode === 'retaliate'
      ? aggressive
      : matching || aggressive;
}

export function acceptsLoot(a: Pick<AutomationSettings, 'loot'>, itemId: ItemId): boolean {
  return (lootRule(a, itemId)?.action ?? a.loot.defaultAction) === 'pickup';
}

export function inSchedule(a: Pick<AutomationSettingsInput, 'schedule'>, now: number): boolean {
  if (!a.schedule.enabled || a.schedule.startHour === a.schedule.endHour) return true;
  const hour = new Date(now).getHours();
  return a.schedule.startHour < a.schedule.endHour
    ? hour >= a.schedule.startHour && hour < a.schedule.endHour
    : hour >= a.schedule.startHour || hour < a.schedule.endHour;
}

export function percent(current: number | undefined, maximum: number | undefined): number | null {
  return current !== undefined && maximum !== undefined && maximum > 0
    ? (current / maximum) * 100
    : null;
}

export interface AutomationTask {
  kind: string;
  label: string;
  pending: boolean;
  since: number | null;
}

export interface PendingFeature {
  sequence: number;
  identity?: ActionIdentity;
  afterCastSeconds: number;
  action: ExpandedAction;
  since: Milliseconds;
  deadline: Milliseconds;
  inventory: Revision<'inventory'>;
  equipment: Revision<'equipment'>;
  stats: Revision<'stats'>;
  skills: Revision<'skills'>;
  count: Quantity;
  itemObservation?: ItemConfirmationObservation;
  skillLevel: number;
  attributes: Attributes | null;
  equipmentReceipt?: (state: CharacterState) => boolean;
  skillReceipt?: typeof matchesSkillExecution;
}

export interface ItemConfirmationObservation {
  count: Quantity | null;
  inventoryAdvanced: boolean;
  removalObserved: boolean;
}

/** Observed client hints, never the server's private action-readiness flags. */
export const ITEM_DIAGNOSTIC_STATUSES = [
  { id: 2, name: 'Stun' },
  { id: 3, name: 'Sleep' },
  { id: 4, name: 'Frozen' },
  { id: 10, name: 'Stone' },
  { id: 26, name: 'Hiding' },
  { id: 28, name: 'Cloaking' },
] as const;

export interface ItemDispatchContext {
  connection: number;
  connected: boolean;
  compatible: boolean;
  life: 'alive' | 'dead' | 'unavailable';
  posture: 'sitting' | 'standing' | 'unknown';
  cast: 'observed' | 'settling' | 'none-observed';
  statuses: Array<{
    id: (typeof ITEM_DIAGNOSTIC_STATUSES)[number]['id'];
    state: 'observed' | 'not-observed' | 'unknown';
  }>;
  serverFrameAgeMs: number | null;
}

export interface ItemAttemptDiagnostic {
  sequence: number;
  itemId: ItemId;
  since: Milliseconds;
  context: ItemDispatchContext | null;
  send: 'pending' | 'accepted' | 'uncertain';
  outcome: 'waiting' | 'confirmed' | 'late-confirmed' | 'rejected' | 'unconfirmed' | 'cancelled';
  received: {
    inventory: number;
    removals: number;
    ownResources: number;
    ownState: number;
    rejections: number;
  };
}

export function itemEvidenceCategory(
  event: GameEvent | { type: 'map' | 'resurrection' },
  playerId: number | null,
): keyof ItemAttemptDiagnostic['received'] | null {
  if (event.type === 'inventory' || event.type === 'inventoryItem') return 'inventory';
  if (event.type === 'inventoryDelta') return event.add ? 'inventory' : 'removals';
  if (['featureError', 'requestFailure', 'skillFailure'].includes(event.type)) return 'rejections';
  if (event.type === 'stats' || event.type === 'sp') return 'ownResources';
  if (playerId === null) return null;
  if ((event.type === 'heal' || event.type === 'hit') && event.id === playerId)
    return 'ownResources';
  if (
    event.type === 'map' ||
    event.type === 'clear' ||
    (event.type === 'spawn' && event.entity.id === playerId) ||
    ([
      'death',
      'resurrection',
      'remove',
      'castStart',
      'castExtend',
      'castStop',
      'status',
      'sit',
    ].includes(event.type) &&
      'id' in event &&
      event.id === playerId)
  )
    return 'ownState';
  return null;
}

/** Closed fields keep account names, raw frames and private transport errors out of history. */
export function itemAttemptSummary(attempt: ItemAttemptDiagnostic): string {
  const context = attempt.context;
  return `Item attempt #${attempt.sequence}, ${itemName(attempt.itemId)} (#${attempt.itemId}): Local send ${attempt.send}; outcome ${attempt.outcome}. ${context ? `Connection ${context.connection}, ${context.connected && context.compatible ? 'verified transport' : 'transport unavailable'}, ${context.life}, posture ${context.posture}, cast ${context.cast}, server frame age ${context.serverFrameAgeMs ?? 'unknown'}ms; ${context.statuses.map((status) => `${ITEM_DIAGNOSTIC_STATUSES.find((row) => row.id === status.id)!.name} ${status.state}`).join(', ')}. ` : ''}Received inventory ${attempt.received.inventory}, removals ${attempt.received.removals}, own resources ${attempt.received.ownResources}, own state ${attempt.received.ownState}, rejections ${attempt.received.rejections}. Local send acceptance does not confirm consumption.`;
}

/** Bounded observations explain missing confirmation without asserting consumption. */
export function itemConfirmationDiagnostic({
  id,
  before,
  observation,
}: {
  id: ItemId;
  before: Quantity;
  observation: ItemConfirmationObservation;
}): string {
  const missing: string[] = [];
  if (observation.count === null) missing.push('verified inventory unavailable');
  if (!observation.removalObserved) missing.push('inventory removal update missing');
  if (!observation.inventoryAdvanced) missing.push('inventory did not advance');
  if (observation.count !== null && observation.count >= before)
    missing.push('item stock did not decrease');
  return `${itemName(id)} (#${id}), stock ${before} → ${observation.count ?? 'unavailable'}. Missing evidence: ${missing.join('; ') || 'inventory removal and decreased item stock were not observed together'}. Consumption remains unconfirmed.`;
}

export type ActionReceipts = Pick<
  AutomationScheduler,
  'receipt' | 'discardReceipt' | 'retireReceipt' | 'reconcileReceipt'
>;

export interface ActionResult {
  sequence: number;
  status: 'idle' | 'pending' | 'confirmed' | 'failed';
  reason: string;
}

/** Internal causes determine receipt policy; user-facing text never does. */
export type ActionFailure =
  | { type: 'server-rejection'; reason: string }
  | { type: 'cancel'; reason: string }
  | { type: 'send-failure'; reason: string }
  | { type: 'timeout'; reason: string };

export type AutomationOutcome =
  | { sequence: number; status: 'idle' | 'pending' | 'confirmed'; reason: string }
  | { sequence: number; status: 'failed'; failure: ActionFailure };

export type ObserveSettlement =
  | { state: 'ignored' }
  | { state: 'confirmed' }
  | { state: 'rejected'; failure: Extract<ActionFailure, { type: 'server-rejection' }> };

/** Retain the published contract without exposing internal failure tags. */
export function publishedActionResult(outcome: AutomationOutcome): ActionResult {
  return {
    sequence: outcome.sequence,
    status: outcome.status,
    reason: outcome.status === 'failed' ? outcome.failure.reason : outcome.reason,
  };
}

export type ReceiptRetirement =
  | { state: 'rejected'; discard: true }
  | { state: 'uncertain' | 'retained'; discard: false }
  | { state: 'released'; discard: boolean };

export function receiptRetirement({
  continuing,
  actionType,
  failure,
}: {
  continuing: boolean;
  actionType: ExpandedAction['type'] | null;
  failure: ActionFailure | null;
}): ReceiptRetirement {
  if (!continuing) {
    const discard = actionType === 'sit' || actionType === 'respawn';
    if (actionType && !discard) return { state: 'retained', discard: false };
    return { state: 'released', discard };
  }
  if (failure?.type === 'server-rejection') return { state: 'rejected', discard: true };
  if (actionType && ['useItem', 'allocateStats', 'allocateSkill', 'skill'].includes(actionType)) {
    return { state: 'uncertain', discard: false };
  }
  return { state: 'released', discard: true };
}

// Pinned player spells include Magnus Exorcismus (12s), Storm Gust and Lord
// of Vermilion (up to 15s). Allow a bounded cast and response margin. Equipment
// and debuffs can extend casting: 30s is our policy, not a source maximum.
export function actionConfirmationTimeout(action: { type: string }): Milliseconds {
  return milliseconds(action.type === 'skill' ? 30_000 : 6_000);
}

export function effectiveSkillLevel(
  skillId: SkillId,
  requested: number,
  state: CharacterState,
): number {
  return SKILL_CATALOG[skillId]?.adjustableLevel || skillId === 55
    ? requested
    : state.skillLevel(skillId);
}

export function distanceBetween(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

/** Wire DTOs are admitted once before ground loot enters the decision owner. */
export type DomainDrop = Readonly<Omit<Drop, 'id' | 'itemId' | 'count'>> & {
  readonly id: DropId;
  readonly itemId: ItemId;
  readonly count: Quantity;
};
export function admitDrop(value: Drop): DomainDrop {
  return {
    ...value,
    id: dropId(value.id),
    itemId: itemId(value.itemId),
    count: quantity(value.count),
  };
}

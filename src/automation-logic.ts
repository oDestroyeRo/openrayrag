import { map } from 'remeda';
import type { AutomationScheduler } from './automation';
import type { ActionIdentity } from './actor-identity';
import type { matchesSkillExecution } from './skill-execution';
import type { AutomationSettings, LootRule, MonsterRule } from './settings';
import type { Entity } from './protocol';
import { actorPredicateEvaluator, type ActorObservationSnapshot } from './actor-observations-logic';
import type { CharacterState } from './character-state';
import { SKILL_CATALOG } from './game-catalog';
import type { ExpandedAction, Attributes } from './protocol-feature';
export function monsterRule(a: AutomationSettings, classId: number): MonsterRule | undefined { return a.combat.rules.find(r=>r.classId===classId); }

export function lootRule(a: AutomationSettings, itemId: number): LootRule | undefined { return a.loot.rules.find(r=>r.itemId===itemId); }

export function acceptsMonster(a: AutomationSettings, e: Entity, player: Entity, selected: number[], aggressive: boolean, observations?:ActorObservationSnapshot): boolean {
  let rule = monsterRule(a,e.classId);
  if(rule?.conditions?.length) {
    const traces=map(rule.conditions, actorPredicateEvaluator(observations));
    if(traces.some(trace=>trace.state==='unavailable'))return false;
    if(traces.some(trace=>trace.state==='unmatched')) {
      if(rule.action==='attack')return false;
      rule=undefined; // A known-false ignore condition leaves ordinary selection in control.
    }
  }
  if (a.combat.mode === 'off' || rule?.action === 'ignore' || e.level > player.level + a.combat.levelDifference) return false;
  const matching = selected.includes(e.classId) || rule?.action === 'attack';
  return a.combat.mode === 'selected' ? matching : a.combat.mode === 'retaliate' ? aggressive : matching || aggressive;
}

export function acceptsLoot(a: AutomationSettings, itemId: number): boolean { return (lootRule(a,itemId)?.action ?? a.loot.defaultAction) === 'pickup'; }

export function inSchedule(a: AutomationSettings, now: number): boolean {
  if (!a.schedule.enabled || a.schedule.startHour === a.schedule.endHour) return true;
  const hour = new Date(now).getHours();
  return a.schedule.startHour < a.schedule.endHour ? hour >= a.schedule.startHour && hour < a.schedule.endHour
    : hour >= a.schedule.startHour || hour < a.schedule.endHour;
}

export function percent(current: number | undefined, maximum: number | undefined): number | null {
  return current !== undefined && maximum !== undefined && maximum > 0 ? current / maximum * 100 : null;
}

export interface AutomationTask { kind: string; label: string; pending: boolean; since: number | null }

export interface PendingFeature { sequence:number; identity?:ActionIdentity; afterCastSeconds:number; action: ExpandedAction; since: number; deadline: number; inventory: number; equipment: number; stats: number; skills: number; count: number; skillLevel: number; attributes: Attributes | null; equipmentReceipt?: (state: CharacterState)=>boolean; skillReceipt?:typeof matchesSkillExecution }

export type ActionReceipts = Pick<AutomationScheduler, 'receipt' | 'discardReceipt' | 'retireReceipt' | 'reconcileReceipt'>;

export interface ActionResult { sequence: number; status: 'idle' | 'pending' | 'confirmed' | 'failed'; reason: string }

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
  return { sequence: outcome.sequence, status: outcome.status,
    reason: outcome.status === 'failed' ? outcome.failure.reason : outcome.reason };
}

export type ReceiptRetirement =
  | { state: 'rejected'; discard: true }
  | { state: 'uncertain' | 'retained'; discard: false }
  | { state: 'released'; discard: boolean };

export function receiptRetirement({ continuing, actionType, failure }: {
  continuing: boolean; actionType: ExpandedAction['type'] | null; failure: ActionFailure | null;
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
export function actionConfirmationTimeout(action: { type: string }): number {
  return action.type==='skill' ? 30_000 : 6_000;
}

export function effectiveSkillLevel(skillId: number, requested: number, state: CharacterState): number {
  return SKILL_CATALOG[skillId]?.adjustableLevel || skillId===55 ? requested : state.skillLevel(skillId);
}

export function distanceBetween(a:{x:number;y:number},b:{x:number;y:number}):number{return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));}

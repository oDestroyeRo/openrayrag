import { some } from 'effect/Predicate';
import { filter, groupBy, map, take } from 'effect/Array';
import { map as mapRecord } from 'effect/Record';
import { pipe } from 'effect/Function';
import { isTalkNpc, isPlayerShop } from '../world/actor-interaction-logic';
import { actorId } from '../world/actor-identity';
import type { ActorId } from '../../shared/domain-values';
import type { AutomationSettingsInput } from '../settings/settings';
import { validateExpandedAction } from '../protocol/protocol-feature';
import { validateWorldAction } from '../protocol/world-protocol';
import { validPartyFollowSnapshot } from '../party/party-follow-logic';
import { validPartyHealSnapshot } from '../party/party-heal-logic';
import { validateDeathRecoveryGuard } from '../recovery/death-recovery';
import { validateMapPolicy } from '../navigation/map-policy-logic';
import { validActorSnapshot } from '../world/actor-observations-logic';
import { validMacroSnapshot, macroActive } from '../automation/macro-ui-logic';
import { validRefineSnapshot } from '../refine/refine-ui-logic';
import { validSocketSnapshot } from '../socket/socket-ui-logic';
import { validSocialSnapshot } from '../social/social-ui-logic';
import { validMemoSnapshot } from '../memo/memo-ui-logic';
import { validWarpSnapshot } from '../warp/warp-ui-logic';
import { actorSnapshotAt } from '../world/actor-predicate-ui-logic';
import type { RoutineObservation, RoutineTrace } from '../automation/routines-logic';
import type { NpcServiceDefinition } from '../services/npc-services-logic';
import type { WorkflowSpec } from '../services/workflows-logic';
import { itemName, skillName } from '../catalog/game-catalog';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
export const featureServiceChoices = (services: readonly NpcServiceDefinition[]) => (kind: 'storage' | 'buy' | 'sell'): [string, string][] =>
  pipe(services, filter(service => kind === 'storage' ? service.outcome.type === 'storageOpened'
    : service.outcome.type === 'shopOpened' && service.outcome.mode === kind),
  map(service => [service.contractId, service.name] as [string, string]));

/** Stock, mastery and NPC identity jointly invalidate a pending service preview. */
export function featureServiceEvidence(status: Record<string, unknown>): string {
  const character = object(status.character), stats = object(character.stats);
  const stock = Array.isArray(character.inventory) ? pipe(character.inventory, map(object), map(row => [row.itemId, row.count])) : null;
  const learned = Array.isArray(character.learned) ? map(character.learned, object) : [];
  const mastery = Array.isArray(character.learned) ? learned.find(row => row.skillId === 1)?.level : null;
  const npcs = Array.isArray(status.actors) ? pipe(status.actors, map(object), filter(isTalkNpc),
    map(actor => [actor.id, actor.kind, actor.classId, actor.name, actor.x, actor.y, actor.dead])) : null;
  return JSON.stringify([character.inventoryKnown, stats.zeny, character.skillsKnown, mastery, stock, npcs]);
}
export function featureWorkflowPreviewText(spec: WorkflowSpec): string {
  const expectedFees = spec.steps.reduce((total, step) => total + ('expectedCost' in step ? Number(step.expectedCost ?? 0) : 0), 0);
  return `${spec.steps.length} validated steps · budget ${spec.maxSpend} · expected NPC fees ${expectedFees} · ${spec.minStock.length} stock guards.\nNPC fees count toward the spending cap. Live map, NPC, shop prices and stock are checked on Start.\n${map(spec.steps, (step, index) => `${index + 1}. ${JSON.stringify(step)}`).join('\n')}`;
}
export function featureRoutinePreviewText(trace: RoutineTrace<unknown>): string {
  return map(trace.rules, rule => `${rule.name}: ${rule.state} · ${rule.reason}${map(rule.conditions, condition => '\n  ' + condition.state + ' · ' + condition.reason).join('')}`).join('\n');
}
export function featureAttackStrategiesText(value: unknown): string {
  const strategy = object(value), engagements = Array.isArray(strategy.entries) ? strategy.entries : [];
  return pipe(engagements, take(8), map(entry => {
    const actor = object(entry), rules = Array.isArray(actor.rules) ? actor.rules : [];
    return `Actor #${number(actor.id) ?? '?'} · ${actor.normalStarted === true ? 'normal attack started' : 'opener window open'}`
      + pipe(rules, take(32), map(value => {
        const rule = object(value);
        return `\n  ${text(rule.id)} · ${number(rule.attempts) ?? '?'} attempts · ${number(rule.uses) ?? '?'} confirmed${rule.uncertain === true ? ' · unresolved' : rule.rejected === true ? ' · rejected' : ''}`;
      })).join('');
  })).join('\n') + (strategy.truncated === true ? '\nAdditional actor ledgers omitted from display.' : '');
}
export function featureRuleConditionsText(value: unknown): string {
  return pipe(Array.isArray(value) ? value : [], take(32), map(entry => {
    const rule = object(entry), conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
    return text(rule.rule) + (rule.truncated === true ? ' · additional evidence omitted' : '')
      + map(conditions, condition => { const trace = object(condition); return '\n  ' + text(trace.state) + ' · ' + text(trace.reason); }).join('');
  })).join('\n');
}
export function featureNpcChoices(value: unknown): { value: string; label: string; key: string }[] {
  return pipe(Array.isArray(value) ? value : [], map(object), filter(actor => isTalkNpc(actor) && actor.dead !== true),
    map(actor => ({ value: String(actor.id), label: `${text(actor.name) || 'NPC'} · #${actor.id}`, key: `${actor.id}:${text(actor.name)}` })));
}
export function featureVendorChoices(value: unknown): { value: string; label: string; key: string }[] {
  return pipe(Array.isArray(value) ? value : [], map(object), filter(actor => isPlayerShop(actor) && actor.dead !== true),
    map(actor => ({ value: String(actor.id), label: `${text(actor.name) || 'Player shop'} · #${actor.id}`, key: `${actor.id}:${text(actor.name)}` })));
}

export function featureVendingText(value: unknown): string {
  const shop = object(value);
  if (!Array.isArray(shop.entries)) return 'Select a player shop and request its stock. Buying requires explicit sale IDs and quantities.';
  return `Confirmed player shop · ${text(shop.name) || 'Unnamed shop'} · Seller #${number(shop.id) ?? '?'} · ${shop.entries.length} sale entries`
    + pipe(shop.entries, take(30), map(entry => {
      const row = object(entry), item = object(row.item);
      return `\nSale ${number(item.bagId) ?? '?'} · ${itemName(number(item.itemId) ?? 0)} × ${number(item.count) ?? '?'} · ${number(row.price) ?? '?'} zeny each`;
    })).join('') + (shop.entries.length > 30 ? '\nAdditional sale entries omitted.' : '');
}

export function featureInventoryText(inventory: readonly unknown[]): string {
  return pipe(inventory, take(30), map(item => {
    const row = object(item);
    return `Bag ${number(row.bagId) ?? '?'} · ${itemName(number(row.itemId) ?? 0)} × ${number(row.count) ?? '?'}`;
  })).join('\n');
}
export function featureSkillsText(skills: readonly unknown[]): string {
  return pipe(skills, take(40), map(skill => {
    const row = object(skill);
    return `${skillName(number(row.skillId) ?? 0)} · Lv ${number(row.level) ?? '?'}`;
  })).join(', ');
}
/** Blank is absence, never the allocator's valid actor zero. */
export function actorInput(value:string,optional=false):ActorId|undefined {
  if(!value.trim()){if(optional)return undefined;throw new Error('Choose an observed actor ID.');}
  return actorId(Number(value));
}
export function checkedAction(input: unknown): Record<string, unknown> {
  if (['sit','useItem','skill','equip','respawn','allocateSkill','allocateStats'].includes(text(object(input).type))) {
    return validateExpandedAction(input) as unknown as Record<string,unknown>;
  }
  return validateWorldAction(input) as unknown as Record<string,unknown>;
}
export function isAction(input: unknown): input is Record<string,unknown> { try { checkedAction(input); return true; } catch { return false; } }
/** Mode selection explicitly clears incompatible policy in the form. */
export function chooseFollowMode(follow:AutomationSettingsInput['follow'],mode:'name'|'partyLeader'):AutomationSettingsInput['follow'] {
  return {...follow,mode,...(mode==='partyLeader'?{name:''}:{rendezvous:false})};
}
// Bounded telemetry is treated as data. A new packet field cannot inject HTML or
// make a native status event grow an unbounded tree in the controller.
export function validFeatureStatus(value: Record<string, unknown>): boolean {
  if(value.macro!==undefined&&!validMacroSnapshot(value.macro))return false;
  if(value.partyHeal!==undefined&&!validPartyHealSnapshot(value.partyHeal))return false;
  if(value.deathRecoveryGuard!==undefined){try{validateDeathRecoveryGuard(value.deathRecoveryGuard);}catch{return false;}}
  let remaining = 100_000;
  function bounded(v: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 10) return false;
    if (v === null || typeof v === 'boolean') return true;
    if (typeof v === 'number') return Number.isFinite(v);
    if (typeof v === 'string') return v.length <= 8192;
    if (Array.isArray(v)) return v.length <= 2048 && v.every(entry => bounded(entry,depth+1));
    if (v && typeof v === 'object') return Object.keys(v).length <= 256 && Object.values(v).every(entry => bounded(entry,depth+1));
    return false;
  }
  if (!['character','world','workflow','routine','macro','service','task','actionResult','travel','partyFollow','escape','supply','supplyGuard','deathRecoveryGuard','elapsedSeconds','deaths','lootStats','actors','loadout','attackStrategies','manualTarget','partyHeal','retreat'].every(key => value[key] === undefined || bounded(value[key],0))) return false;
  if(object(value.travel).policy!==undefined){try{validateMapPolicy(object(value.travel).policy);}catch{return false;}}
  if(value.partyEngagement!==undefined) {
    const p=object(value.partyEngagement);
    if(Object.keys(p).length!==4||Object.keys(p).some(key=>!['enabled','accepted','blocked','reasons'].includes(key))||typeof p.enabled!=='boolean'||!Number.isInteger(p.accepted)||!Number.isInteger(p.blocked)||Number(p.accepted)<0||Number(p.blocked)<0||Number(p.accepted)+Number(p.blocked)>150||!Array.isArray(p.reasons)||p.reasons.length>4||!p.reasons.every(reason=>typeof reason==='string'&&reason.length<=160))return false;
  }
  if(value.partyFollow!==undefined&&!validPartyFollowSnapshot(value.partyFollow))return false;
  if(value.actorObservations!==undefined&&!validActorSnapshot(value.actorObservations))return false;
  if(value.social!==undefined&&!validSocialSnapshot(value.social))return false;
  if(value.warp!==undefined&&!validWarpSnapshot(value.warp))return false;
  if(value.memo!==undefined&&!validMemoSnapshot(value.memo))return false;
  if(value.socket!==undefined&&!validSocketSnapshot(value.socket))return false;
  if(value.refine!==undefined&&!validRefineSnapshot(value.refine))return false;
  if(value.ruleConditions!==undefined&&!bounded(value.ruleConditions,0))return false;
  const barter = object(value.world).barter;
  return barter === undefined || Array.isArray(barter) && barter.every(entry => {
    const row = object(entry);
    return Number.isInteger(object(row.item).itemId) && Array.isArray(row.required)
      && row.required.every(required => Number.isInteger(object(required).itemId) && Number.isInteger(object(required).count));
  });
}

type FeaturePredicate = (status: Record<string, unknown>) => boolean;
const featureHas = (field: string) => (feature: string): FeaturePredicate =>
  status => object(status[feature])[field] === true;
const pending = featureHas('pending');
const blocked = featureHas('blocked');
const featureState = ({ feature, states }: { feature: string; states: readonly string[] }): FeaturePredicate =>
  status => states.includes(text(object(status[feature]).state));

// Bind static policy once; evaluate in order and stop at the first match.
const sharedActivity: readonly FeaturePredicate[] = [
  status => macroActive(status.macro),
  blocked('warp'),
  blocked('refine'),
  featureHas('settling')('retreat'),
  featureState({ feature: 'partyHeal', states: ['pending', 'uncertain'] }),
  featureHas('ownsTravel')('partyFollow'),
  featureHas('active')('manualTarget'),
  featureHas('settling')('manualTarget'),
  featureState({ feature: 'travel', states: ['planning', 'walking', 'transition'] }),
  pending('socket'),
  blocked('memo'),
];
const operationActivity: readonly FeaturePredicate[] = [
  featureHas('active')('service'),
  featureHas('running')('workflow'),
  featureState({ feature: 'routine', states: ['running', 'waiting'] }),
  status => object(status.actionResult).status === 'pending',
];
export const featureServiceBlocked = some([
  ...sharedActivity, featureHas('uncertain')('supply'), pending('social'), pending('escape'), ...operationActivity,
]);
export const featureActive = some([
  ...sharedActivity, pending('social'), ...operationActivity, pending('task'),
]);
export function featureObservation(status: Record<string, unknown>, at: number): RoutineObservation {
    const stats=object(object(status.character).stats);const player=object(status.player);const hp=number(stats.hp)??number(player.hp);const maxHp=number(stats.maxHp)??number(player.maxHp);const sp=number(stats.sp);const maxSp=number(stats.maxSp);const zeny=number(stats.zeny);const result:RoutineObservation={actors:actorSnapshotAt(status.actorObservations, at),map:text(status.map),elapsedSeconds:number(status.elapsedSeconds)??0};
    if(hp!==null&&maxHp!==null&&maxHp>0)result.hpPercent=hp/maxHp*100;if(sp!==null&&maxSp!==null&&maxSp>0)result.spPercent=sp/maxSp*100;if(zeny!==null)result.zeny=zeny;
    const level=number(stats.level)??number(player.level),jobLevel=number(stats.jobLevel),weight=number(stats.weight),maxWeight=number(stats.maxWeight);
    if(level!==null)result.level=level;if(jobLevel!==null)result.jobLevel=jobLevel;if(weight!==null&&maxWeight!==null&&maxWeight>0)result.weightPercent=weight/maxWeight*100;
    const character=object(status.character);
    if(character.inventoryKnown===true&&Array.isArray(character.inventory)) {
      result.inventory = pipe(character.inventory,
        map(entry => { const row = object(entry); return { itemId: number(row.itemId), count: number(row.count) }; }),
        filter((row): row is { itemId: number; count: number } => row.itemId !== null && row.count !== null),
        groupBy(row => String(row.itemId)),
        mapRecord(rows => rows.reduce((total, row) => total + (row.count), 0)));
    }
    return result;
  }

import { actorId } from './actor-identity';
import type { AutomationSettings } from './settings';
import { validateExpandedAction } from './protocol-feature';
import { validateWorldAction } from './world-protocol';
import { validPartyFollowSnapshot } from './party-follow-logic';
import { validPartyHealSnapshot } from './party-heal-logic';
import { validateDeathRecoveryGuard } from './death-recovery';
import { validateMapPolicy } from './map-policy-logic';
import { validActorSnapshot } from './actor-observations-logic';
import { validMacroSnapshot, macroActive } from './macro-ui-logic';
import { validRefineSnapshot } from './refine-ui-logic';
import { validSocketSnapshot } from './socket-ui-logic';
import { validSocialSnapshot } from './social-ui-logic';
import { validMemoSnapshot } from './memo-ui-logic';
import { validWarpSnapshot } from './warp-ui-logic';
import { actorSnapshotAt } from './actor-predicate-ui-logic';
import type { RoutineObservation } from './routines';
const object = (v: unknown): Record<string, unknown> => v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
const text = (v: unknown): string => typeof v === 'string' ? v : '';
const number = (v: unknown): number | null => typeof v === 'number' && Number.isFinite(v) ? v : null;
/** Blank is absence, never the allocator's valid actor zero. */
export function actorInput(value:string,optional=false):number|undefined {
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
export function chooseFollowMode(follow:AutomationSettings['follow'],mode:'name'|'partyLeader'):AutomationSettings['follow'] {
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

export function featureServiceBlocked(status: Record<string, unknown>): boolean { return macroActive(status.macro) || object(status.warp).blocked===true || object(status.refine).blocked===true || object(status.retreat).settling===true || ['pending','uncertain'].includes(text(object(status.partyHeal).state)) || object(status.partyFollow).ownsTravel===true || object(status.manualTarget).active===true || object(status.manualTarget).settling===true || ['planning','walking','transition'].includes(text(object(status.travel).state)) || object(status.socket).pending===true || object(status.memo).blocked===true || object(status.supply).uncertain===true || object(status.social).pending===true || object(status.escape).pending===true || object(status.service).active===true || object(status.workflow).running===true || ['running','waiting'].includes(text(object(status.routine).state)) || object(status.actionResult).status==='pending'; }
export function featureActive(status: Record<string, unknown>): boolean { return macroActive(status.macro) || object(status.warp).blocked===true || object(status.refine).blocked===true || object(status.retreat).settling===true || ['pending','uncertain'].includes(text(object(status.partyHeal).state)) || object(status.partyFollow).ownsTravel===true || object(status.manualTarget).active===true || object(status.manualTarget).settling===true || ['planning','walking','transition'].includes(text(object(status.travel).state)) || object(status.socket).pending===true || object(status.memo).blocked===true || object(status.social).pending===true || object(status.service).active===true || object(status.workflow).running===true || ['running','waiting'].includes(text(object(status.routine).state)) || object(status.actionResult).status==='pending' || object(status.task).pending===true; }
export function featureObservation(status: Record<string, unknown>, at: number): RoutineObservation {
    const stats=object(object(status.character).stats);const player=object(status.player);const hp=number(stats.hp)??number(player.hp);const maxHp=number(stats.maxHp)??number(player.maxHp);const sp=number(stats.sp);const maxSp=number(stats.maxSp);const zeny=number(stats.zeny);const result:RoutineObservation={actors:actorSnapshotAt(status.actorObservations, at),map:text(status.map),elapsedSeconds:number(status.elapsedSeconds)??0};
    if(hp!==null&&maxHp!==null&&maxHp>0)result.hpPercent=hp/maxHp*100;if(sp!==null&&maxSp!==null&&maxSp>0)result.spPercent=sp/maxSp*100;if(zeny!==null)result.zeny=zeny;
    const level=number(stats.level)??number(player.level),jobLevel=number(stats.jobLevel),weight=number(stats.weight),maxWeight=number(stats.maxWeight);
    if(level!==null)result.level=level;if(jobLevel!==null)result.jobLevel=jobLevel;if(weight!==null&&maxWeight!==null&&maxWeight>0)result.weightPercent=weight/maxWeight*100;
    const character=object(status.character);if(character.inventoryKnown===true&&Array.isArray(character.inventory)){const counts:Record<number,number>={};for(const entry of character.inventory){const row=object(entry);const id=number(row.itemId);const count=number(row.count);if(id!==null&&count!==null)counts[id]=(counts[id]??0)+count;}result.inventory=counts;}return result;
  }

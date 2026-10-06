import data from './data/cast-policy.json';
import { ITEM_CATALOG, SKILL_CATALOG, skillCost } from './game-catalog';
import type { CharacterState } from './character-state';
import { evaluateActorPredicate, type ActorObservationSnapshot, type ActorPredicate } from './actor-observations-logic';

export const CAST_POLICY_PIN = data.pin;
export const AUTOMATIC_ATTACK_SKILLS = [11,12,16] as const;
export const MANUAL_GROUND_SKILL = 19;
export const PARTY_HEAL_SKILL=41;
export function skillAfterCastSeconds(skillId:number):number {
  return skillId===PARTY_HEAL_SKILL?1:skillId===MANUAL_GROUND_SKILL?1.5:(AUTOMATIC_ATTACK_SKILLS as readonly number[]).includes(skillId)?1:0;
}
export interface CastProfile { skillId:number; level:number; range:number; spCost:number; afterCastSeconds:number }
export type CastReadiness = {state:'ready';profile:CastProfile} | {state:'unavailable'|'blocked';reason:string};
interface ItemPolicy {name:string;card:boolean;percent?:number;refinePercent?:number}
const items: Readonly<Record<string,ItemPolicy>> = data.items;
const known = (id:number) => items[id] && ITEM_CATALOG[id]?.name === items[id]!.name;

/** Source integer arithmetic. Item slots are canonical bag references, not
 * appearance aliases; each physical bag and each installed card is counted once.
 * Unknown equipment or missing unique-item scalars cannot imply zero modifiers. */
export function effectiveSpCost(state:CharacterState, skillId:number, level:number):number|null {
  const base = skillCost(skillId,level);
  if (base===null || !state.inventoryKnown || state.equipment.length!==10) return null;
  let modifier=0;
  const equipped=new Set<number>();
  const ids=new Set<number>();
  for (const bagId of state.equipment) {
    if (bagId<=0 || equipped.has(bagId)) continue;
    equipped.add(bagId);
    const item=state.inventory.get(bagId);
    if (!item || item.type!==2 || item.count!==1 || !known(item.itemId) || items[item.itemId]!.card
      || !item.guid || !Number.isInteger(item.refine) || item.refine!<0 || item.refine!>255 || item.slots?.length!==4) return null;
    ids.add(item.itemId);
    const policy=items[item.itemId]!;
    modifier+=(policy.percent??0)+(policy.refinePercent??0)*item.refine!;
    for (const card of item.slots) {
      if (!Number.isInteger(card)) return null;
      if (card<=0) continue;
      if (!known(card) || !items[card]!.card) return null;
      ids.add(card); modifier+=items[card]!.percent??0;
    }
  }
  if (state.ammoId>0 && !known(state.ammoId)) return null;
  for (const combo of data.combos) if(combo.items.every(id=>ids.has(id)))modifier+=combo.percent;
  if(100+modifier<0)return null;
  const cost=Math.trunc(base*(100+modifier)/100);
  // A negative server modifier total has unusual resource semantics; this
  // bounded policy deliberately does not claim support for negative SP costs.
  return cost>=0&&cost<=0x7fffffff?cost:null;
}
const selfStatus=(statusId:number,value:boolean):ActorPredicate=>({field:'actorStatus',actor:{scope:'self'},statusId,operator:'eq',value});
// BodyStateFlags.NoSkillAttack plus hidden. Pacification is Petrifying at pin.
export const CAST_PREREQUISITES:ActorPredicate[]=[2,3,4,6,9,10,26].map(id=>selfStatus(id,false));
export const BLIND_CONDITION= selfStatus(5,true);
export function castReadiness(skillId:number,level:number,state:CharacterState,observations:ActorObservationSnapshot|undefined,ownCastSettled?:boolean):CastReadiness {
  if (![...AUTOMATIC_ATTACK_SKILLS,MANUAL_GROUND_SKILL,PARTY_HEAL_SKILL].includes(skillId)) return {state:'unavailable',reason:'This skill has no verified cast policy.'};
  const skill=SKILL_CATALOG[skillId];
  if(!skill || !skill.adjustableLevel || skill.maxLevel!==10 || !state.skillsKnown || !Number.isInteger(level) || level<1 || level>10 || state.skillLevel(skillId)<level)
    return {state:'unavailable',reason:'Verified learned or granted skill level is required.'};
  for(const condition of CAST_PREREQUISITES) {
    const trace=evaluateActorPredicate(condition,observations);
    if(trace.state==='unavailable')return {state:'unavailable',reason:'Skill body-state prerequisites are unavailable: '+trace.reason};
    if(trace.state==='unmatched')return {state:'blocked',reason:'A disabling or hidden status prevents this skill.'};
  }
  const cast=observations?.actors.find(actor=>actor.id===observations.selfId)?.cast;
  // Party support shares the engine's durable cast and input-debt fence. An
  // accepted own availability event may outlive the old predicate's estimate.
  if(skillId===PARTY_HEAL_SKILL?ownCastSettled!==true:cast?.state==='casting'&&cast.deadline!==null&&observations!.at<cast.deadline)return {state:'blocked',reason:'A known observed cast is still active.'};
  // Unknown initial server casting is not inferred idle. Our scheduler/motion
  // ownership is checked by the engine; unobserved server gates can silently
  // reject a request, which retains uncertainty at its bounded deadline.
  const blind=evaluateActorPredicate(BLIND_CONDITION,observations);
  if(blind.state==='unavailable')return {state:'unavailable',reason:'Blind state is unavailable; effective skill range is unknown.'};
  const cost=effectiveSpCost(state,skillId,level);
  if(cost===null)return {state:'unavailable',reason:'Effective SP cost needs verified equipment, cards and refinement.'};
  if(state.stats?.sp===undefined)return {state:'unavailable',reason:'Current SP is unavailable.'};
  if(state.stats.sp<cost)return {state:'blocked',reason:'Insufficient effective SP for the selected skill.'};
  return {state:'ready',profile:{skillId,level,range:blind.state==='matched'?5:9,spCost:cost,afterCastSeconds:skillAfterCastSeconds(skillId)}};
}

/** Warp's learned level and stage-specific SP checks belong to its manual owner.
 * Cast availability is checked by the controller's shared observed owner, not a timer. */
export function warpCastReadiness(state:CharacterState,observations:ActorObservationSnapshot|undefined):CastReadiness {
  const level=state.skillsKnown?state.learned.get(55)??0:0;
  if(!Number.isInteger(level)||level<1||level>4)return {state:'unavailable',reason:'Warp Portal requires observed learned level 1–4; granted-only skills are unsupported.'};
  for(const condition of CAST_PREREQUISITES){const trace=evaluateActorPredicate(condition,observations);if(trace.state!=='matched')return {state:trace.state==='unavailable'?'unavailable':'blocked',reason:'Verified clear body-state prerequisites are required for Warp Portal.'};}
  const blind=evaluateActorPredicate(BLIND_CONDITION,observations);
  if(blind.state==='unavailable')return {state:'unavailable',reason:'Blind state is unavailable; stationary range cannot be verified.'};
  const cost=effectiveSpCost(state,55,level);
  if(cost===null)return {state:'unavailable',reason:'Effective SP cost needs verified equipment, cards and refinement.'};
  return {state:'ready',profile:{skillId:55,level,range:blind.state==='matched'?5:9,spCost:cost,afterCastSeconds:0}};
}

import { sort } from 'remeda';
import type { ActionIdentity } from '../world/actor-identity';
import { actorPredicateEvaluator, type ActorObservationSnapshot, type ActorPredicate } from '../world/actor-observations-logic';
import { resourceFresh } from '../world/actor-resources';
import type { PartyActorBinding } from './party-actors-logic';
import type { Entity } from '../protocol/protocol';
import type { ExpandedAction } from '../protocol/protocol-feature';
export type HealAction=Extract<ExpandedAction,{type:'skill';mode:'target'}>;

export interface PartyHealCandidate { binding:PartyActorBinding; hp:number; maxHp:number; hpAt:number }

export interface PartyHealSnapshot { state:'disabled'|'waiting'|'ready'|'pending'|'uncertain'|'confirmed'; reason:string; attempts:number; confirmed:number; targetMemberId:number|null; sequence:number|null; resourceReadback:boolean }

export interface PartyHealCheckpoint { version:1; attempts:number; confirmed:number; cooldownUntil:number }

export function validatePartyHealCheckpoint(value:unknown):PartyHealCheckpoint {
  const c=value as PartyHealCheckpoint;
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).length!==4||c.version!==1
    ||!Number.isInteger(c.attempts)||c.attempts<0||c.attempts>100||!Number.isInteger(c.confirmed)||c.confirmed<0||c.confirmed>c.attempts
    ||!Number.isSafeInteger(c.cooldownUntil)||c.cooldownUntil<0)throw new Error('Invalid party Heal checkpoint.');
  return structuredClone(c);
}

export interface Owner { sequence:number; identity:ActionIdentity; action:HealAction; binding:PartyActorBinding; since:number; retired:boolean; hpAt:number; cooldownSeconds:number }

export function sameOwnIdentity(a:ActionIdentity|null,b:ActionIdentity):boolean {
  return !!a&&a.world===b.world&&a.selfId===b.selfId&&a.selfIncarnation===b.selfIncarnation;
}

export function partyHpCondition(binding:PartyActorBinding,threshold:number):ActorPredicate {
  return {field:'actorHpPercent',actor:{scope:'actor',id:binding.entityId,world:binding.world,incarnation:binding.incarnation},operator:'lte',value:threshold};
}

/** Uses the shared binding and resource evidence; it creates no actors or HP cache. */
export function partyHealCandidates(bindings:PartyActorBinding[],actors:ReadonlyMap<number,Entity>,selfId:number,observations:ActorObservationSnapshot,threshold:number):PartyHealCandidate[] {
  if(!observations.connected)return [];
  const candidates:PartyHealCandidate[]=[];
  const evaluate = actorPredicateEvaluator(observations);
  for(const binding of bindings){
    const actor=actors.get(binding.entityId),row=observations.actors.find(a=>a.id===binding.entityId);
    if(binding.entityId<=0||binding.entityId===selfId||!actor||actor.kind!==0||actor.dead||actor.hp<=0||!row||row.incarnation!==binding.incarnation||observations.world!==binding.world||!resourceFresh(row.hp,observations.at)||row.hp!.value!<=0)continue;
    if(evaluate(partyHpCondition(binding,threshold)).state!=='matched')continue;
    candidates.push({binding,hp:row.hp!.value!,maxHp:row.hp!.max!,hpAt:row.hp!.at!});
  }
  // Cross multiplication is exact even at int32 resource bounds.
  return sort(candidates, (a,b)=>{const delta=BigInt(a.hp)*BigInt(b.maxHp)-BigInt(b.hp)*BigInt(a.maxHp);return delta<0n?-1:delta>0n?1:a.binding.memberId-b.binding.memberId;});
}

export function validPartyHealSnapshot(value:unknown):value is PartyHealSnapshot {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const s=value as Record<string,unknown>;
  const fields=['state','reason','attempts','confirmed','targetMemberId','sequence','resourceReadback'];
  const count=(v:unknown,min:number,max:number):v is number=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max;
  return Object.keys(s).length===fields.length&&fields.every(key=>Object.hasOwn(s,key))&&['disabled','waiting','ready','pending','uncertain','confirmed'].includes(s.state as string)
    &&typeof s.reason==='string'&&s.reason.length<=512&&count(s.attempts,0,100)&&count(s.confirmed,0,s.attempts)
    &&(s.targetMemberId===null||count(s.targetMemberId,1,0x7fffffff))&&(s.sequence===null||count(s.sequence,1,Number.MAX_SAFE_INTEGER))&&typeof s.resourceReadback==='boolean';
}

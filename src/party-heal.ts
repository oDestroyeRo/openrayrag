import { sameActionIdentity, type ActionIdentity } from './actor-identity';
import { evaluateActorPredicate, type ActorObservationSnapshot, type ActorPredicate } from './actor-observations';
import { resourceFresh } from './actor-resources';
import type { PartyActorBinding } from './party-actors';
import type { Entity, GameEvent } from './protocol';
import type { ExpandedAction } from './protocol-feature';
import type { PartyHealSettings } from './settings';
import { matchesPartyHealExecution } from './skill-execution';

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
interface Owner { sequence:number; identity:ActionIdentity; action:HealAction; binding:PartyActorBinding; since:number; retired:boolean; hpAt:number; cooldownSeconds:number }
function sameOwnIdentity(a:ActionIdentity|null,b:ActionIdentity):boolean {
  return !!a&&a.world===b.world&&a.selfId===b.selfId&&a.selfIncarnation===b.selfIncarnation;
}
export function partyHpCondition(binding:PartyActorBinding,threshold:number):ActorPredicate {
  return {field:'actorHpPercent',actor:{scope:'actor',id:binding.entityId,world:binding.world,incarnation:binding.incarnation},operator:'lte',value:threshold};
}
/** Uses the shared binding and resource evidence; it creates no actors or HP cache. */
export function partyHealCandidates(bindings:PartyActorBinding[],actors:ReadonlyMap<number,Entity>,selfId:number,observations:ActorObservationSnapshot,threshold:number):PartyHealCandidate[] {
  if(!observations.connected)return [];
  const candidates:PartyHealCandidate[]=[];
  for(const binding of bindings){
    const actor=actors.get(binding.entityId),row=observations.actors.find(a=>a.id===binding.entityId);
    if(binding.entityId<=0||binding.entityId===selfId||!actor||actor.kind!==0||actor.dead||actor.hp<=0||!row||row.incarnation!==binding.incarnation||observations.world!==binding.world||!resourceFresh(row.hp,observations.at)||row.hp!.value!<=0)continue;
    if(evaluateActorPredicate(partyHpCondition(binding,threshold),observations).state!=='matched')continue;
    candidates.push({binding,hp:row.hp!.value!,maxHp:row.hp!.max!,hpAt:row.hp!.at!});
  }
  // Cross multiplication is exact even at int32 resource bounds.
  return candidates.sort((a,b)=>{const delta=BigInt(a.hp)*BigInt(b.maxHp)-BigInt(b.hp)*BigInt(a.maxHp);return delta<0n?-1:delta>0n?1:a.binding.memberId-b.binding.memberId;});
}
/** A sender-free per-run allowance and retained receipt. Stop is not CancelCast. */
export class PartyHealPolicy {
  private owner:Owner|null=null;
  private last:Owner|null=null;
  private cooldownUntil=0;
  private attempts=0;
  private confirmed=0;
  private state:PartyHealSnapshot['state']='disabled';
  private reason='Party Heal is off.';
  private readback=false;
  // Packet order, rather than wall-clock precision, separates a pre-result
  // refresh from the authoritative SP debit sent after skill execution.
  private observationSequence=0n;
  private confirmationSequence=0n;
  private spReadbackSequence=0n;
  private spReadbackPending=false;
  constructor(private readonly now:()=>number){}
  get busy():boolean{return this.owner!==null;}
  get awaitingSpReadback():boolean{return this.spReadbackPending;}
  checkpoint():PartyHealCheckpoint|null {
    return this.busy||this.awaitingSpReadback?null:{version:1,attempts:this.attempts,confirmed:this.confirmed,cooldownUntil:this.cooldownUntil};
  }
  restore(value:unknown):void {
    const checkpoint=validatePartyHealCheckpoint(value);
    if(this.busy||this.awaitingSpReadback)throw new Error('Waiting for the previous party Heal receipt.');
    this.attempts=checkpoint.attempts;this.confirmed=checkpoint.confirmed;this.cooldownUntil=checkpoint.cooldownUntil;
    this.last=null;this.readback=false;this.state='waiting';this.reason='Waiting for fresh party member and own SP evidence after update.';
    this.observationSequence=0n;this.confirmationSequence=0n;this.spReadbackSequence=0n;
  }
  owns(sequence:number):boolean{return this.owner?.sequence===sequence;}
  newRun():void {if(this.busy)throw new Error('Waiting for the previous party Heal receipt.');this.attempts=0;this.confirmed=0;}
  wait(reason:string):void {if(!this.owner){this.state='waiting';this.reason=reason;}}
  cancel(reason:string):void {if(this.owner){this.owner.retired=true;this.state='uncertain';this.reason=`Party Heal result is unresolved: ${reason} No cast will replay.`;}}
  available(settings:PartyHealSettings|undefined,ownCastSettled:boolean):boolean {
    if(this.owner)return false;
    if(!settings?.enabled){this.state='disabled';this.reason='Party Heal is off.';return false;}
    if(this.attempts>=settings.maxAttempts){this.wait('Party Heal dispatch allowance reached for this run.');return false;}
    if(this.now()<this.cooldownUntil){this.wait('Waiting for the party Heal cooldown.');return false;}
    if(!ownCastSettled){this.wait('Waiting for authoritative own cast availability and stationary input cooldown.');return false;}
    this.state='ready';this.reason='Waiting for a stationary eligible party member.';return true;
  }
  reserve(sequence:number,identity:ActionIdentity,action:HealAction,candidate:PartyHealCandidate,cooldownSeconds:number):void {
    if(this.owner)throw new Error('Party Heal already owns a receipt.');
    this.owner={sequence,identity:{...identity},action:{...action},binding:{...candidate.binding},since:this.now(),retired:false,hpAt:candidate.hpAt,cooldownSeconds};
    this.attempts++;this.state='pending';this.reason='Waiting for exact direct Heal execution; HP and SP changes are separate evidence.';
  }
  /** Consumed resources must be observed again, never subtracted locally. */
  resourcesReadBack(observations:ActorObservationSnapshot):boolean {
    if(!this.last)return true;
    const hp=observations.actors.find(a=>a.id===this.last!.binding.entityId&&a.incarnation===this.last!.binding.incarnation)?.hp;
    const own=observations.actors.find(a=>a.id===observations.selfId);
    const sp=own?.sp;
    const sameOwn=observations.connected&&observations.world===this.last.identity.world&&own?.id===this.last.identity.selfId&&own.incarnation===this.last.identity.selfIncarnation;
    const ownSp=sameOwn&&this.spReadbackSequence>this.confirmationSequence&&resourceFresh(sp,observations.at)&&(sp!.source==='own-sp'||sp!.source==='own-stats');
    this.readback=ownSp&&resourceFresh(hp,observations.at)&&hp!.at!>this.last.hpAt;
    if(this.spReadbackPending&&ownSp)this.spReadbackPending=false;
    // Target HP readback is displayed separately; a departed target must not
    // prevent healing another fresh member after own SP has been observed.
    // Completed proof is not a permanent restriction on future own lifetimes.
    return !this.spReadbackPending&&observations.connected&&resourceFresh(sp,observations.at);
  }
  observe(events:GameEvent[],identity:(target?:number)=>ActionIdentity|null):{sequence:number;motion:number}|null {
    let receipt:{sequence:number;motion:number}|null=null;
    for(const event of events){
      const observed=++this.observationSequence;
      const own=identity();
      if(this.last&&sameOwnIdentity(own,this.last.identity)&&(event.type==='sp'||event.type==='stats'&&event.sp!==undefined))this.spReadbackSequence=observed;
      const owner=this.owner;if(!owner)continue;
      if(matchesPartyHealExecution(owner.action,event,owner.identity.selfId)&&sameActionIdentity(owner.identity,identity(owner.action.target))&&event.type==='skillResult'){
        receipt={sequence:owner.sequence,motion:event.motionSeconds};this.last=owner;this.owner=null;this.confirmed++;this.readback=false;
        this.confirmationSequence=observed;this.spReadbackSequence=0n;this.spReadbackPending=true;
        this.cooldownUntil=this.now()+Math.max(1,owner.cooldownSeconds)*1000;this.state='confirmed';this.reason='Direct Heal execution confirmed. Waiting for fresh HP/SP readback and cooldown.';
      }
    }
    return receipt;
  }
  snapshot():PartyHealSnapshot{return {state:this.state,reason:this.reason,attempts:this.attempts,confirmed:this.confirmed,targetMemberId:(this.owner??this.last)?.binding.memberId??null,sequence:(this.owner??this.last)?.sequence??null,resourceReadback:this.readback};}
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

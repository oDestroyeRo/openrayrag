import { sameActionIdentity, type ActionIdentity } from './actor-identity';
import type { ActorObservationSnapshot } from './actor-observations-logic';
import { resourceFresh } from './actor-resources';
import type { GameEvent } from './protocol';
import type { PartyHealSettings } from './settings';
import { matchesPartyHealExecution } from './skill-execution';

import { type HealAction, type PartyHealCandidate, type PartyHealSnapshot, type PartyHealCheckpoint, validatePartyHealCheckpoint, type Owner, sameOwnIdentity } from './party-heal-logic';

export { type HealAction, type PartyHealCandidate, type PartyHealSnapshot, type PartyHealCheckpoint, validatePartyHealCheckpoint, partyHpCondition, partyHealCandidates, validPartyHealSnapshot } from './party-heal-logic';

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

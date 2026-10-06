import type { Entity, GameEvent } from '../protocol/protocol';
import { SUPPORTED_STATUS_IDS } from './actor-status-catalog';
import { absoluteResource, copyResourceObservation, damageResource, unavailableResource, type ResourceObservation } from './actor-resources';

import { ACTOR_OBSERVATION_LIMITS, PERMANENT_STATUS_SECONDS, type ActorPredicate, type StatusObservation, type ActorObservation, type ActorObservationSnapshot, type ObservationContext, type PartyActorEvidence, type RecordState, clock, unknownCast } from './actor-observations-logic';

export { ACTOR_OBSERVATION_LIMITS, PERMANENT_STATUS_SECONDS, type ActorSelector, type ActorPredicate, type PredicateTrace, type ActorObservation, type ActorObservationSnapshot, type ObservationContext, type PartyActorEvidence, validActorSelector, validActorPredicate, validActorConditions, validActorSnapshot, evaluateActorPredicate, actorConditionsMatch, type PublishedConditionReport, publishConditionReports } from './actor-observations-logic';

export class ActorObservations {
  private world: string;
  private nextIncarnation = 0;
  private sequence = 0;
  private lastFrameAt: number | null = null;
  private ownInitialization: { id:number; at:number; sequence:number; sp?:ResourceObservation } | null = null;
  private readonly actors = new Map<number,RecordState>();
  constructor(private readonly now = Date.now, private readonly newWorld = () => crypto.randomUUID()) { this.world = newWorld(); }
  context(id?: number): ObservationContext { return {world:this.world,at:this.now(),sequence:++this.sequence,...(id!==undefined?{incarnation:this.actors.get(id)?.incarnation??0}:{})}; }
  frame(): void { const at=this.now(); if (this.lastFrameAt !== null && at < this.lastFrameAt) this.reset(); if (clock(at)) this.lastFrameAt=at; }
  reset(): void { this.world=this.newWorld();this.nextIncarnation=0;this.sequence=0;this.lastFrameAt=null;this.ownInitialization=null;this.actors.clear(); }
  /** Enter announces an identity before packet 56 and the matching EnterServer spawn. */
  beginOwnInitialization(id:number): void { this.ownInitialization={id,at:this.now(),sequence:++this.sequence}; }
  remove(id: number): void { this.actors.delete(id);if(this.ownInitialization?.id===id)this.ownInitialization=null; }
  spawn(entity: Entity, selfId:number|null=null, entryType?:number): void {
    const initialization=this.ownInitialization?.id===entity.id?this.ownInitialization:null;
    if(initialization)this.ownInitialization=null; // A wrong or replacement arrival cannot reuse it later.
    if (entity.dead || (entity.kind===0||entity.kind===1)&&entity.hp <= 0) {this.remove(entity.id);return;}
    // Keep room for an announced own actor during loading/death. Filling that
    // slot with another actor must not prevent authoritative self revival.
    const limit=ACTOR_OBSERVATION_LIMITS.actors-(selfId!==null&&entity.id!==selfId&&!this.actors.has(selfId)?1:0);
    if (!this.actors.has(entity.id) && this.actors.size >= limit) return;
    const at=this.now();if(!clock(at)||this.nextIncarnation>=0x7fffffff){this.reset();return;} const statuses=new Map<number,StatusObservation>();
    for (const status of entity.statuses ?? []) if(SUPPORTED_STATUS_IDS.has(status.id)) statuses.set(status.id,this.status(status.id,status.seconds,at));
    const own=entity.kind===0&&entity.id===selfId;
    const placeholder=entity.sp===undefined&&entity.maxSp===undefined||entity.sp===0&&entity.maxSp===0;
    // The owner receives the nearby-player 0/0 SP placeholder after initial
    // stats. Bind that one announced arrival without refreshing receipt time.
    const sp=own&&entryType===1&&placeholder&&initialization?.sp?copyResourceObservation(initialization.sp)
      :own&&entity.sp!==undefined?absoluteResource(entity.sp,entity.maxSp,at,'spawn'):undefined;
    this.actors.set(entity.id,{id:entity.id,incarnation:++this.nextIncarnation,kind:entity.kind,name:entity.name.slice(0,64),observedAt:at,
      statusesKnown:entity.statuses!==undefined,statuses,cast:unknownCast(),startedAt:at,visibleAt:at,hpSequence:++this.sequence,spSequence:this.sequence,hpUsesParty:false,
      partyId:entity.partyId??null,partyName:entity.partyName??null,affiliationRevision:0,affiliationSequence:this.sequence,affiliationAt:at,
      hp:absoluteResource(entity.hp,entity.maxHp,at,'spawn'),
      ...(sp?{sp}:{})});
  }
  /** Current observed HP, including a party update, can revoke a visible player's availability. */
  livingPlayer(id:number): boolean { const actor=this.actors.get(id);return actor?.kind===0&&actor.hp?.reason===null&&actor.hp.value!==null&&actor.hp.value>0; }
  /** Actual world positions refresh visibility only, never resource/status or party-map evidence. */
  visibleAt(id:number):number|null {return this.actors.get(id)?.visibleAt??null;}
  partyActor(id:number): PartyActorEvidence | null {
    const actor=this.actors.get(id);return actor?{world:this.world,incarnation:actor.incarnation,kind:actor.kind,name:actor.name,
      partyId:actor.partyId,partyName:actor.partyName,affiliationRevision:actor.affiliationRevision}:null;
  }
  clearPartyResources(id:number, context:Pick<ObservationContext,'world'|'incarnation'>):void {
    const actor=this.actors.get(id);if(!actor||context.world!==this.world||context.incarnation!==actor.incarnation)return;
    // Retire contexts captured before membership invalidation, even when the
    // visible actor itself has not changed incarnation.
    actor.hpSequence=actor.spSequence=++this.sequence;
    actor.partyHp=undefined;actor.partySp=undefined;
    if(actor.hpUsesParty)actor.hp=unavailableResource('binding');
    if(!actor.sp||actor.sp.source==='party')actor.sp=unavailableResource('binding');
  }
  partyResources(id:number, values:{hp?:number;maxHp?:number;sp?:number;maxSp?:number}, context:ObservationContext):void {
    const actor=this.actors.get(id);
    if(!actor||actor.kind!==0||id<=0||context.world!==this.world||context.incarnation!==actor.incarnation
      ||context.sequence===undefined||!clock(context.at)||context.at>this.now())return;
    const sequence=context.sequence??++this.sequence;
    actor.partyHp=absoluteResource(values.hp,values.maxHp,context.at,'party');
    actor.partySp=absoluteResource(values.sp,values.maxSp,context.at,'party');
    // Absolute packets replace the baseline in captured packet order. Equal
    // numbers never suppress a subsequent HitTarget. HP/SP have separate fences.
    if(sequence>actor.hpSequence&&context.at>=(actor.hp?.at??actor.startedAt)) {
      actor.hpSequence=sequence;actor.hp=copyResourceObservation(actor.partyHp);actor.hpUsesParty=true;
    }
    if((sequence>actor.spSequence||!actor.sp)&&context.at>=(actor.sp?.at??0)) {
      actor.spSequence=sequence;actor.sp=copyResourceObservation(actor.partySp);
    }
  }
  private status(id: number, seconds: number, at: number): StatusObservation {
    const permanent=seconds===PERMANENT_STATUS_SECONDS;
    const deadline=at+Math.max(0,seconds)*1000;
    return {id,present:true,known:Number.isFinite(seconds)&&(permanent||clock(deadline)),observedAt:at,expiresAt:permanent?null:clock(deadline)?deadline:at};
  }
  apply(event: GameEvent, context=this.context(), selfId:number|null=null): void {
    if (context.world!==this.world || !clock(context.at) || context.at > this.now()) return;
    const initialization=this.ownInitialization;
    if((event.type==='stats'||event.type==='sp')&&selfId===null&&initialization&&!this.actors.has(initialization.id)) {
      if(context.incarnation!==undefined||context.sequence===undefined||context.sequence<=initialization.sequence||context.at<initialization.at)return;
      initialization.sequence=context.sequence;
      if(event.sp!==undefined)initialization.sp=context.at<(initialization.sp?.at??0)?unavailableResource('out-of-order',context.at)
        :absoluteResource(event.sp,event.maxSp,context.at,event.type==='sp'?'own-sp':'own-stats');
      return;
    }
    const id=event.type==='stats'||event.type==='sp'?selfId:event.type==='skillResult'?event.source:'id' in event?event.id:null;
    const actor=id===null?undefined:this.actors.get(id);
    if (!actor || context.at < actor.startedAt || context.incarnation!==undefined && context.incarnation!==actor.incarnation || (actor.kind!==0&&actor.kind!==1)) return;
    const at=context.at;
    if(event.type==='position'||event.type==='walk') {
      actor.visibleAt=Math.max(actor.visibleAt,at);return;
    }
    if (event.type==='heal'||event.type==='hit'||event.type==='stats'||event.type==='sp') {
      const sequence=context.sequence??++this.sequence;
      if (event.type!=='sp'&&sequence>actor.hpSequence) {
        actor.hpSequence=sequence;
        if(at<(actor.hp?.at??0))actor.hp=unavailableResource('out-of-order',at);
        else if(event.type==='hit')actor.hp=damageResource(actor.hp,event.damage,at);
        else {actor.hp=absoluteResource(event.hp,event.maxHp,at,event.type==='heal'?'hp-recovery':'own-stats');actor.hpUsesParty=false;}
      }
      if ((event.type==='sp'||event.type==='stats'&&event.sp!==undefined)&&sequence>actor.spSequence) {
        actor.spSequence=sequence;
        actor.sp=at<(actor.sp?.at??0)?unavailableResource('out-of-order',at):absoluteResource(event.sp,event.maxSp,at,event.type==='sp'?'own-sp':'own-stats');
      }
      return;
    }
    if (context.at < actor.observedAt) return;
    if (event.type==='partyAffiliation' && actor.kind===0) {
      if(context.sequence===undefined||context.sequence<=actor.affiliationSequence||at<actor.affiliationAt)return;
      actor.affiliationSequence=context.sequence;actor.affiliationAt=at;
      if(actor.partyId!==event.partyId||actor.partyName!==event.partyName)actor.affiliationRevision++;
      actor.partyId=event.partyId;actor.partyName=event.partyName;
    } else if(event.type==='status' && SUPPORTED_STATUS_IDS.has(event.statusId)) {
      if(event.seconds===null) actor.statuses.set(event.statusId,{id:event.statusId,present:false,known:!event.refresh,observedAt:at,expiresAt:at});
      else actor.statuses.set(event.statusId,this.status(event.statusId,event.seconds,at));
      actor.observedAt=at;
    } else if(event.type==='castStart') {
      const deadline=at+event.remainingSeconds*1000;
      actor.cast=event.remainingSeconds>0&&clock(deadline)?{state:'casting',observedAt:at,deadline,skillId:event.skillId}:unknownCast();actor.observedAt=at;
    } else if(event.type==='castExtend') {
      actor.observedAt=at;actor.visibleAt=Math.max(actor.visibleAt,at);
      if(actor.cast.state!=='casting'||actor.cast.deadline===null||at>=actor.cast.deadline) {actor.cast=unknownCast();return;}
      const deadline=actor.cast.deadline+event.deltaSeconds*1000;
      actor.cast=clock(deadline)&&deadline>at?{...actor.cast,observedAt:at,deadline}:unknownCast();actor.observedAt=at;
    } else if(event.type==='castStop' || event.type==='skillResult' && !event.indirect && actor.cast.state==='casting' && actor.cast.skillId===event.skillId) {
      actor.cast={state:'idle',observedAt:at,deadline:null,skillId:null};actor.observedAt=at;
    }
    // Keep visibility from the existing supported world status/cast evidence.
    // Resource and affiliation packets do not supply a newer visibility clock.
    actor.visibleAt=Math.max(actor.visibleAt,actor.observedAt);
  }
  snapshot(selfId: number | null, targetId: number | null, connected: boolean, requested: readonly ActorPredicate[]=[], includeRest=true,candidateId:number|null=null): ActorObservationSnapshot {
    const ids=new Set<number>([...(selfId!==null?[selfId]:[]),...(targetId!==null?[targetId]:[]),...(candidateId!==null?[candidateId]:[]),...requested.flatMap(p=>p.actor.scope==='actor'?[p.actor.id]:[]),...(includeRest?this.actors.keys():[])]);
    let remaining:number=includeRest?ACTOR_OBSERVATION_LIMITS.publishedStatuses:ACTOR_OBSERVATION_LIMITS.evaluatedStatuses;let truncated=false;
    const actors:ActorObservation[]=[];
    for(const id of ids) {
      const actor=this.actors.get(id);if(!actor)continue;
      const allStatuses=[...actor.statuses.values()];const complete=allStatuses.length<=remaining;const statuses=complete?allStatuses.map(s=>({...s})):[];
      truncated||=!complete;remaining-=statuses.length;actors.push({id:actor.id,incarnation:actor.incarnation,kind:actor.kind,name:actor.name,observedAt:actor.observedAt,statusesKnown:complete&&actor.statusesKnown,statuses,cast:{...actor.cast},...(actor.hp?{hp:copyResourceObservation(actor.hp)}:{}),...(actor.sp?{sp:copyResourceObservation(actor.sp)}:{})});
      if(actors.length>=ACTOR_OBSERVATION_LIMITS.publishedActors){truncated||=ids.size>actors.length;break;}
    }
    return {world:this.world,at:this.now(),lastFrameAt:this.lastFrameAt,connected,selfId,targetId,...(candidateId!==null?{candidateId}:{}),...(truncated?{truncated:true}:{}),actors};
  }
}

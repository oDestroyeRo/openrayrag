import { filter } from 'effect/Array';
import { partyMemberId, type PartyMemberId } from '../../shared/domain-values';
import type { ActorObservations } from '../world/actor-observations';
import { RESOURCE_STALE_MS } from '../world/actor-resources';
import type { PartyMember, WorldEvent } from '../protocol/world-protocol';

import { onlinePartyMembers, distinctPartyActors, partyActorBinding, type PartyActorBinding, type Party, type Association } from './party-actors-logic';

export { type PartyActorBinding } from './party-actors-logic';

/** A full roster row authorizes one visible lifetime only. Partial rows cannot rebind it. */
export class PartyActorBindings {
  private observations?:ActorObservations;
  private readonly associations = new Map<PartyMemberId,Association>();
  private invalidate(memberId:number, observations:ActorObservations):void {
    const id=partyMemberId(memberId),previous=this.associations.get(id);
    if(previous?.binding)observations.clearPartyResources(previous.binding.entityId,previous.binding);
    this.associations.delete(id);
  }
  clear(observations=this.observations):void {
    if(observations)for(const id of this.associations.keys())this.invalidate(id,observations);
    this.associations.clear();
  }
  get(memberId:PartyMemberId):PartyActorBinding|null {
    const binding=this.associations.get(memberId)?.binding;return binding?{...binding}:null;
  }
  /** A verified trip may carry one unrevoked member association into a new world.
   * This detached eligibility check does not restore roster/resource bindings. */
  capturedArrival(captured:PartyActorBinding & {name:string;partyName:string}, party:Party, map:string, observations:ActorObservations):PartyActorBinding|null {
    const member=party?.members.get(captured.memberId), actor=observations.partyActor(captured.entityId);
    if(!party||party.id!==captured.partyId||party.name!==captured.partyName||!member||!member.leader
      ||member.entityId<=0||member.entityId!==captured.entityId||member.name!==captured.name||member.map!==map)return null;
    const online=onlinePartyMembers([...party.members.values()]);
    if(filter(online, row=>row.entityId===member.entityId).length!==1
      ||!distinctPartyActors(online)
      ||!actor||actor.world===captured.world||actor.kind!==0||actor.name!==member.name||actor.partyId!==party.id||actor.partyName!==party.name||!observations.livingPlayer(member.entityId))return null;
    const at=observations.context().at,visibleAt=observations.visibleAt(member.entityId);
    if(visibleAt===null||at<visibleAt||at-visibleAt>RESOURCE_STALE_MS)return null;
    return partyActorBinding({partyId:party.id,memberId:member.memberId,entityId:member.entityId,map,world:actor.world,incarnation:actor.incarnation,affiliationRevision:actor.affiliationRevision});
  }
  observe(event:WorldEvent, party:Party, map:string, observations:ActorObservations, selfId:number|null):void {
    if(event.type==='partyJoined'||event.type==='partyLeft'||!party)this.clear(observations);
    const remember=(member:PartyMember)=>{
      this.invalidate(member.memberId,observations);
      if(!party||member.entityId<=0||member.map!==map||this.associations.size>=32)return;
      this.associations.set(partyMemberId(member.memberId),{member:{...member},context:observations.context(member.entityId),
        actor:observations.partyActor(member.entityId),binding:null,resourcesApplied:false});
    };
    if(event.type==='partyJoined')for(const member of event.members)remember(member);
    else if(event.type==='partyMember') {
      this.invalidate(event.member.memberId,observations);
      if(event.change!=='logout')remember(event.member);
    } else if(event.type==='partyRemove'||event.type==='partyMap')this.invalidate(event.memberId,observations);
    this.sync(party,map,observations,selfId);
    if(event.type==='partyHealth') {
      const binding=this.get(partyMemberId(event.memberId));
      if(binding&&binding.entityId!==selfId)observations.partyResources(binding.entityId,event,observations.context(binding.entityId));
    }
  }
  sync(party:Party,map:string,observations:ActorObservations,selfId:number|null):void {
    this.observations=observations;
    if(!party){this.clear(observations);return;}
    const counts=new Map<number,number>();
    for(const member of party.members.values())if(member.entityId>0)counts.set(member.entityId,(counts.get(member.entityId)??0)+1);
    for(const [id,association] of this.associations) {
      const member=party.members.get(id), original=association.member, current=observations.partyActor(original.entityId);
      const now=observations.context();
      if(!member||member.entityId!==original.entityId||member.name!==original.name||member.map!==map
        ||original.map!==map||counts.get(original.entityId)!==1||now.world!==association.context.world
        ||now.at<association.context.at) {this.invalidate(id,observations);continue;}
      // Once an actor was captured, absence or replacement invalidates the roster
      // evidence. A delayed map/HP update is insufficient to authorize reuse.
      if(association.actor&&(!current||current.world!==association.actor.world||current.incarnation!==association.actor.incarnation
        ||association.binding&&current.affiliationRevision!==association.binding.affiliationRevision)) {this.invalidate(id,observations);continue;}
      if(!current)continue;
      if(!association.actor)association.actor=current;
      if(current.kind!==0||current.name!==member.name||current.partyId!==party.id||current.partyName!==party.name) {
        if(association.binding)this.invalidate(id,observations);
        continue;
      }
      if(!association.binding) {
        if(now.at-association.context.at>RESOURCE_STALE_MS){this.invalidate(id,observations);continue;}
        association.binding=partyActorBinding({partyId:party.id,memberId:id,entityId:member.entityId,map,world:current.world,
          incarnation:current.incarnation,affiliationRevision:current.affiliationRevision});
      }
      if(!association.resourcesApplied) {
        association.resourcesApplied=true;
        // Resource time remains the full row's time. An intervening direct
        // packet makes this old baseline ineligible through its sequence.
        if(member.entityId!==selfId)observations.partyResources(member.entityId,original,
          {...association.context,incarnation:current.incarnation});
      }
    }
  }
}

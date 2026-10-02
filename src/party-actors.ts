import type { ActorObservations, ObservationContext, PartyActorEvidence } from './actor-observations';
import { RESOURCE_STALE_MS } from './actor-resources';
import type { PartyMember, WorldEvent } from './world-protocol';

export interface PartyActorBinding {
  partyId: number; memberId: number; entityId: number; map: string;
  world: string; incarnation: number; affiliationRevision: number;
}
type Party = { id: number; name: string; members: Map<number,PartyMember> } | null;
interface Association {
  member: PartyMember; context: ObservationContext; actor: PartyActorEvidence | null;
  binding: PartyActorBinding | null; resourcesApplied: boolean;
}
/** A full roster row authorizes one visible lifetime only. Partial rows cannot rebind it. */
export class PartyActorBindings {
  private observations?:ActorObservations;
  private readonly associations = new Map<number,Association>();
  private invalidate(memberId:number, observations:ActorObservations):void {
    const previous=this.associations.get(memberId);
    if(previous?.binding)observations.clearPartyResources(previous.binding.entityId,previous.binding);
    this.associations.delete(memberId);
  }
  clear(observations=this.observations):void {
    if(observations)for(const id of this.associations.keys())this.invalidate(id,observations);
    this.associations.clear();
  }
  get(memberId:number):PartyActorBinding|null {
    const binding=this.associations.get(memberId)?.binding;return binding?{...binding}:null;
  }
  observe(event:WorldEvent, party:Party, map:string, observations:ActorObservations, selfId:number|null):void {
    if(event.type==='partyJoined'||event.type==='partyLeft'||!party)this.clear(observations);
    const remember=(member:PartyMember)=>{
      this.invalidate(member.memberId,observations);
      if(!party||member.entityId<=0||member.map!==map||this.associations.size>=32)return;
      this.associations.set(member.memberId,{member:{...member},context:observations.context(member.entityId),
        actor:observations.partyActor(member.entityId),binding:null,resourcesApplied:false});
    };
    if(event.type==='partyJoined')for(const member of event.members)remember(member);
    else if(event.type==='partyMember') {
      this.invalidate(event.member.memberId,observations);
      if(event.change!=='logout')remember(event.member);
    } else if(event.type==='partyRemove'||event.type==='partyMap')this.invalidate(event.memberId,observations);
    this.sync(party,map,observations,selfId);
    if(event.type==='partyHealth') {
      const binding=this.get(event.memberId);
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
        association.binding={partyId:party.id,memberId:id,entityId:member.entityId,map,world:current.world,
          incarnation:current.incarnation,affiliationRevision:current.affiliationRevision};
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

import type { ActionIdentity } from './actor-identity';
import type { ActorObservations } from './actor-observations';
import { RESOURCE_STALE_MS } from './actor-resources';
import type { PartyActorBinding, PartyActorBindings } from './party-actors';
import { mapAllowed, mapPolicy, type MapPolicy } from './map-policy';
import type { Entity, GameEvent } from './protocol';
import { automationSettings, type Settings } from './settings';
import type { TravelTransition } from './travel-controller';
import type { PartyMember, WorldEvent } from './world-protocol';

export interface PartyFollowSnapshot {
  state: 'disabled' | 'selecting' | 'following' | 'waiting' | 'preparing' | 'travelling' | 'awaitingLeader' | 'failed' | 'cancelled' | 'expired';
  reason: string; destination: string; remainingSeconds: number; attemptUsed: boolean; ownsTravel: boolean;
}
export function validPartyFollowSnapshot(value:unknown):value is PartyFollowSnapshot {
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  return Object.keys(v).length===6&&typeof v.state==='string'&&['disabled','selecting','following','waiting','preparing','travelling','awaitingLeader','failed','cancelled','expired'].includes(String(v.state))
    &&typeof v.reason==='string'&&v.reason.length<=512&&typeof v.destination==='string'&&/^(?:[a-zA-Z0-9_-]{1,64})?$/.test(v.destination)
    &&typeof v.remainingSeconds==='number'&&Number.isFinite(v.remainingSeconds)&&v.remainingSeconds>=0&&v.remainingSeconds<=120
    &&typeof v.attemptUsed==='boolean'&&typeof v.ownsTravel==='boolean';
}
type Party = {id:number;name:string;members:Map<number,PartyMember>}|null;
export interface PartyFollowContext {
  party:Party; bindings:PartyActorBindings; observations:ActorObservations; actors:ReadonlyMap<number,Entity>;
  admissionReady?:boolean; map:string; player:Entity|undefined; own:ActionIdentity|null; connection:number;
}
interface Leader extends PartyActorBinding {name:string;partyName:string;epoch:number}
interface MapObservation {partyId:number;entityId:number;map:string;at:number;revision:number}
export interface RendezvousAttempt {
  id:number; leader:Leader; destination:string; mapRevision:number; mapObservedAt:number; deadline:number;
  policy:MapPolicy; settings:Settings; connection:number; ownId:number; ownName:string;
}
/** Owns evidence and one finite allowance. TravelController alone owns movement. */
export class PartyFollowRuntime {
  private settings:Settings|null=null;
  private state:PartyFollowSnapshot['state']='disabled';
  private reason='';
  private epoch=0;
  private sequence=0;
  private selected:Leader|null=null;
  private readonly maps=new Map<number,MapObservation>();
  private mapRevision=0;
  private membershipUnavailable=false;
  private lostAt:number|null=null;
  private used=false;
  private attempt:RendezvousAttempt|null=null;
  private trip:number|null=null;
  private ownKey:string|null=null;
  private ownId:number|null=null;
  private expectedSpawn:string|null=null;
  private arrived=false;
  private arrivalBinding:PartyActorBinding|null=null;
  private arrivalCandidate:{world:string;incarnation:number;affiliationRevision:number|null}|null=null;
  private arrivalUnavailable:{partyId:number;memberId:number;entityId:number;world:string;incarnation:number;epoch:number;at:number}|null=null;
  constructor(private readonly now=Date.now){}
  get enabled():boolean {return this.settings!==null&&automationSettings(this.settings).follow.mode==='partyLeader';}
  get ownsTravel():boolean {return ['preparing','travelling','awaitingLeader'].includes(this.state);}
  get completed():boolean {return this.arrived&&this.used&&this.state==='following';}
  get terminal():boolean {return ['failed','cancelled','expired'].includes(this.state);}
  private identity(context:PartyFollowContext):string|null {return context.own?JSON.stringify([context.connection,context.own]):null;}
  start(settings:Settings,context:PartyFollowContext):void {
    this.settings=structuredClone(settings);this.epoch++;this.selected=null;this.used=false;this.attempt=null;this.trip=null;
    this.expectedSpawn=null;this.arrivalBinding=null;this.arrivalCandidate=null;this.arrivalUnavailable=null;this.arrived=false;this.lostAt=null;this.ownKey=this.identity(context);this.ownId=context.player?.id??context.own?.selfId??null;
    this.state=this.enabled?'selecting':'disabled';this.reason=this.enabled?'Waiting for a verified visible party leader.':'';
    if(this.enabled)this.update(context);
  }
  cancel(reason:string):void {
    if(!this.enabled)return;
    this.epoch++;this.state='cancelled';this.reason=reason.slice(0,512);this.expectedSpawn=null;this.arrivalBinding=null;this.arrivalUnavailable=null;
  }
  fail(reason:string):void {if(!this.enabled)return;this.state='failed';this.reason=reason.slice(0,512);}
  resetEvidence(reason:string):void {this.maps.clear();this.selected=null;this.membershipUnavailable=true;this.cancel(reason);}
  private consistent(context:PartyFollowContext,leader:Leader):boolean {
    const party=context.party,member=party?.members.get(leader.memberId);
    const online=party?[...party.members.values()].filter(row=>row.entityId>0):[];
    return !!party&&party.id===leader.partyId&&party.name===leader.partyName&&!!member&&member.leader&&member.entityId===leader.entityId
      &&member.name===leader.name&&online.filter(row=>row.leader).length===1&&new Set(online.map(row=>row.entityId)).size===online.length;
  }
  /** Partial HP can revoke a captured arrival, but cannot establish identity or shared resources. */
  private observeArrivalHealth(memberId:number,hp:number|undefined,maxHp:number|undefined,context:PartyFollowContext):void {
    const leader=this.attempt?.leader??this.selected,candidate=this.arrivalCandidate;
    if(!this.enabled||this.terminal||!this.arrived||!leader||!candidate||memberId!==leader.memberId||!this.consistent(context,leader)
      ||context.map!==(this.attempt?.destination??this.arrivalBinding?.map)||context.party?.members.get(memberId)?.map!==context.map)return;
    const actor=context.observations.partyActor(leader.entityId),at=this.now();
    if(!actor||actor.kind!==0||actor.name!==leader.name||actor.world!==candidate.world||actor.incarnation!==candidate.incarnation)return;
    const unavailable=this.arrivalUnavailable;
    if(unavailable&&at<unavailable.at)return;
    if(hp!==undefined&&maxHp!==undefined&&Number.isFinite(hp)&&Number.isFinite(maxHp)&&hp>0&&hp<=maxHp) {
      this.arrivalUnavailable=null;
    } else this.arrivalUnavailable={partyId:leader.partyId,memberId,entityId:leader.entityId,world:actor.world,incarnation:actor.incarnation,epoch:this.epoch,at};
  }
  observeParty(event:WorldEvent,before:Party,context:PartyFollowContext):void {
    const selected=this.selected;
    const remember=(member:PartyMember)=>{
      if(!context.party||member.entityId<=0||typeof member.map!=='string'){this.maps.delete(member.memberId);return;}
      if(this.maps.size<32||this.maps.has(member.memberId))this.maps.set(member.memberId,{partyId:context.party.id,entityId:member.entityId,map:member.map,at:this.now(),revision:++this.mapRevision});
    };
    if(event.type==='partyJoined'||event.type==='partyLeft') {
      this.maps.clear();this.selected=null;this.epoch++;this.membershipUnavailable=event.type==='partyLeft';
      if(selected&&this.enabled)this.cancel('Party membership changed. Stop and Start for a new follow attempt.');
      if(event.type==='partyJoined')for(const member of event.members)remember(member);
    } else if(event.type==='partyMember') {
      const previous=before?.members.get(event.member.memberId);
      if(selected?.memberId===event.member.memberId&&(event.change==='logout'||!previous||previous.entityId!==event.member.entityId||previous.name!==event.member.name||previous.map!==event.member.map||previous.leader!==event.member.leader))
        this.cancel('The selected leader roster identity changed. Stop and Start for a new attempt.');
      if(event.change==='logout')this.maps.delete(event.member.memberId);else remember(event.member);
    } else if(event.type==='partyRemove') {
      this.maps.delete(event.memberId);
      // Fail closed for actual own zero even before the shared party-clear repair.
      const ownId=this.attempt?.ownId??this.ownId;
      const removedOwn=ownId!==null&&before?.members.get(event.memberId)?.entityId===ownId;
      if(removedOwn)this.membershipUnavailable=true;
      if(selected&&(event.memberId===selected.memberId||removedOwn))
        this.cancel('The selected party association was removed. Stop and Start for a new attempt.');
    } else if(event.type==='partyLeader'&&selected&&event.memberId!==selected.memberId)
      this.cancel('Party leader changed. Stop and Start for a new attempt.');
    else if(event.type==='partyMap') {
      const member=context.party?.members.get(event.memberId);
      if(member)remember(member);
      if(this.attempt?.leader.memberId===event.memberId&&event.map!==this.attempt.destination)
        this.cancel('Leader changed destination. The captured trip will not chase another map. Stop and Start to retry.');
    }
    if(selected&&!this.consistent(context,selected))this.cancel('Party leader identity is ambiguous or unavailable. Stop and Start for a new attempt.');
    if(event.type==='partyHealth')this.observeArrivalHealth(event.memberId,event.hp,event.maxHp,context);
    else if(event.type==='partyMember'&&event.change!=='logout')this.observeArrivalHealth(event.member.memberId,event.member.hp,event.member.maxHp,context);
  }
  visibleLeader(context:PartyFollowContext):PartyActorBinding|null {
    if(!this.enabled||this.terminal||this.membershipUnavailable||!context.party)return null;
    const online=[...context.party.members.values()].filter(row=>row.entityId>0),leaders=online.filter(row=>row.leader);
    if(leaders.length!==1||new Set(online.map(row=>row.entityId)).size!==online.length)return null;
    const member=leaders[0]!;
    if(this.selected&&(member.memberId!==this.selected.memberId||!this.consistent(context,this.selected)))return null;
    const binding=context.bindings.get(member.memberId)??this.arrivalBinding;
    const actor=context.actors.get(member.entityId),evidence=context.observations.partyActor(member.entityId);
    const unavailable=this.arrivalUnavailable;
    if(binding&&unavailable&&unavailable.epoch===this.epoch&&unavailable.partyId===binding.partyId&&unavailable.memberId===binding.memberId
      &&unavailable.entityId===binding.entityId&&unavailable.world===binding.world&&unavailable.incarnation===binding.incarnation)return null;
    if(!binding||binding.partyId!==context.party.id||binding.memberId!==member.memberId||binding.entityId!==member.entityId||binding.map!==context.map
      ||member.map!==context.map||!actor||actor.dead||actor.hp<=0||actor.kind!==0||actor.name!==member.name||!context.observations.livingPlayer(member.entityId)||!evidence
      ||evidence.world!==binding.world||evidence.incarnation!==binding.incarnation||evidence.affiliationRevision!==binding.affiliationRevision
      ||evidence.partyId!==context.party.id||evidence.partyName!==context.party.name)return null;
    const visibleAt=context.observations.visibleAt(member.entityId);
    if(visibleAt===null||this.now()<visibleAt||this.now()-visibleAt>RESOURCE_STALE_MS)return null;
    return binding;
  }
  /** Deadlines advance even while controller freshness/admission is unavailable. */
  advanceDeadline():void {
    if(!this.enabled||this.terminal)return;
    const now=this.now();
    if(this.attempt&&now>=this.attempt.deadline||this.lostAt!==null&&now>=this.lostAt+automationSettings(this.settings!).follow.lostSeconds*1000) {
      this.state='expired';this.reason='Party follow loss allowance expired. Stop and Start for a new attempt.';
    }
  }
  update(context:PartyFollowContext):void {
    if(!this.enabled||this.terminal)return;
    const now=this.now();
    this.advanceDeadline();if(this.terminal)return;
    if(context.player?.dead||context.player&&context.player.kind!==0) {
      this.cancel('Own character died or changed. Stop and Start for a new attempt.');return;
    }
    if(!this.attempt&&this.ownKey&&context.own&&this.ownKey!==this.identity(context)) {
      this.cancel('Own actor lifetime changed outside a verified trip. Stop and Start to retry.');return;
    }
    if(!this.ownKey&&context.own){this.ownKey=this.identity(context);this.ownId=context.own.selfId;}

    if(this.selected) {
      const actor=context.observations.partyActor(this.selected.entityId);
      if(actor&&actor.world===this.selected.world&&(actor.incarnation!==this.selected.incarnation||actor.affiliationRevision!==this.selected.affiliationRevision||actor.kind!==0||actor.name!==this.selected.name)) {
        if(this.attempt){this.cancel('The captured leader actor was replaced or remapped. Stop and Start to retry.');return;}
        // Fresh ordinary binding may select the new lifetime; map-only evidence cannot.
        this.selected=null;this.arrivalBinding=null;this.arrivalUnavailable=null;this.epoch++;
      }
    }
    if(this.selected&&!this.consistent(context,this.selected)){this.cancel('Captured party association changed. Stop and Start for a new attempt.');return;}
    if(this.attempt) {
      if(context.connection!==this.attempt.connection){this.cancel('Rendezvous connection changed. Stop and Start to retry.');return;}
      if(context.player&&(context.player.dead||context.player.kind!==0||context.player.id!==this.attempt.ownId||context.player.name!==this.attempt.ownName)) {
        this.cancel('Rendezvous own character changed or died. Stop and Start to retry.');return;
      }
      if(!this.expectedSpawn&&this.ownKey!==this.identity(context)){this.cancel('Rendezvous own actor lifetime changed unexpectedly. Stop and Start to retry.');return;}
      if(this.arrived&&context.map===this.attempt.destination) {
        const actor=context.observations.partyActor(this.attempt.leader.entityId),candidate=this.arrivalCandidate;
        // Observe the first destination lifetime even while the final portal
        // escape is outstanding. A later namesake cannot inherit this proof.
        if(candidate&&(!actor||actor.world!==candidate.world||actor.incarnation!==candidate.incarnation
          ||candidate.affiliationRevision!==null&&actor.affiliationRevision!==candidate.affiliationRevision)) {
          this.cancel('Destination leader actor was replaced or remapped. Stop and Start to retry.');return;
        }
        if(actor) {
          if(actor.kind!==0||actor.name!==this.attempt.leader.name||actor.partyId!==null
            &&(actor.partyId!==this.attempt.leader.partyId||actor.partyName!==this.attempt.leader.partyName)) {
            this.cancel('Destination leader identity differs from the captured association. Stop and Start to retry.');return;
          }
          this.arrivalCandidate??={world:actor.world,incarnation:actor.incarnation,affiliationRevision:null};
          if(actor.partyId===this.attempt.leader.partyId&&actor.partyName===this.attempt.leader.partyName)
            this.arrivalCandidate.affiliationRevision=actor.affiliationRevision;
          if(!this.arrivalBinding)this.arrivalBinding=context.bindings.capturedArrival(this.attempt.leader,context.party,context.map,context.observations);
        }
      }
      if(this.state==='awaitingLeader'&&this.arrived&&context.map===this.attempt.destination) {
        const binding=this.visibleLeader(context);
        if(binding){this.selected={...this.attempt.leader,...binding};this.state='following';this.reason='Verified party leader visible after rendezvous.';this.lostAt=null;this.attempt=null;this.trip=null;}
      }
      return;
    }
    const binding=this.visibleLeader(context);
    if(binding) {
      const member=context.party!.members.get(binding.memberId)!;
      this.selected={...binding,name:member.name,partyName:context.party!.name,epoch:this.epoch};
      this.state='following';this.reason='Following the verified visible party leader.';this.lostAt=null;return;
    }
    this.lostAt??=now;this.state=this.selected?'waiting':'selecting';this.reason='Waiting for a fresh visible party leader; no unseen coordinates are available.';
    if(!this.selected||this.used||!automationSettings(this.settings!).follow.rendezvous)return;
    const map=this.maps.get(this.selected.memberId),member=context.party?.members.get(this.selected.memberId);
    if(!map||map.partyId!==this.selected.partyId||map.entityId!==this.selected.entityId||map.map!==member?.map||now<map.at||now-map.at>RESOURCE_STALE_MS){this.reason='Waiting for a fresh authoritative leader-map observation.';return;}
    if(map.map===context.map)return;
    if(context.admissionReady===false){this.reason='Waiting for the existing command owner before rendezvous admission.';return;}
    const policy=mapPolicy(this.settings!);
    this.used=true;
    if(!mapAllowed(policy,map.map)||policy.lockArea&&policy.lockArea.map!==map.map){this.fail('Leader destination is forbidden or conflicts with the explicit field rectangle. Stop and Start to retry.');return;}
    if(!context.player||!context.own){this.fail('A current living own character is required for rendezvous.');return;}
    this.attempt={id:++this.sequence,leader:{...this.selected},destination:map.map,mapRevision:map.revision,mapObservedAt:map.at,
      deadline:this.lostAt+automationSettings(this.settings!).follow.lostSeconds*1000,policy:structuredClone(policy),settings:structuredClone(this.settings!),
      connection:context.connection,ownId:context.player.id,ownName:context.player.name};
    this.ownKey=this.identity(context);this.state='preparing';this.reason=`Preparing one bounded rendezvous to ${map.map}.`;
  }
  prepared():RendezvousAttempt|null {return this.state==='preparing'&&this.attempt?structuredClone(this.attempt):null;}
  travelling(trip:number):void {if(this.state==='preparing'){this.trip=trip;this.state='travelling';this.reason='Travelling through verified fixed portals.';}}
  observeGame(events:GameEvent[],proofs:TravelTransition[],context:PartyFollowContext):void {
    if(!this.enabled||this.terminal)return;
    // Membership events and the original deadline are evaluated before accepting arrival.
    if(this.attempt&&this.now()>=this.attempt.deadline){this.update(context);return;}
    for(const event of events) {
      if(event.type==='heal'&&event.id===(this.attempt?.leader.entityId??this.selected?.entityId))
        this.observeArrivalHealth(this.attempt?.leader.memberId??this.selected!.memberId,event.hp,event.maxHp,context);
      if(event.type==='enter'||event.type==='clear'){this.resetEvidence('Unexpected Enter or world refresh ended party follow. Stop and Start to retry.');return;}
      if((event.type==='death'||event.type==='remove')&&event.id===(this.attempt?.ownId??this.ownId)) {
        const proof=proofs.find(proof=>proof.event===event&&proof.phase==='remove'&&proof.trip===this.trip);
        if(event.type==='remove'&&event.reason===0&&!event.dead&&this.attempt&&proof){this.expectedSpawn=proof.toMap;continue;}
        this.cancel('Own character died or disappeared. Stop and Start to retry.');return;
      }
      if(event.type==='map') {
        const proof=proofs.find(proof=>proof.event===event&&proof.phase==='map'&&proof.trip===this.trip);
        if(!this.attempt||!proof){this.cancel('Unexpected map change ended party follow. Stop and Start to retry.');return;}
        this.expectedSpawn=proof.toMap;
      }
      if(event.type==='spawn'&&event.entity.id===context.player?.id&&!this.attempt&&this.ownKey!==this.identity(context)){this.cancel('Own actor was replaced outside a verified trip. Stop and Start to retry.');return;}
      if(event.type==='spawn'&&event.entity.id===(this.attempt?.ownId??context.player?.id)&&this.attempt) {
        const proof=proofs.find(proof=>proof.event===event&&proof.phase==='spawn'&&proof.trip===this.trip);
        if(!proof||proof.toMap!==this.expectedSpawn||event.entryType!==1||event.entity.kind!==0||event.entity.dead||event.entity.hp<=0||event.entity.name!==this.attempt.ownName) {
          this.cancel('Own arrival lacked ordered verified portal identity. Stop and Start to retry.');return;
        }
        this.expectedSpawn=null;this.ownKey=this.identity(context);this.arrived=proof.toMap===this.attempt.destination;
      }
    }
    this.update(context);
  }
  travelComplete():void {if(this.state==='travelling'){this.state='awaitingLeader';this.reason='Arrived; waiting for the same fresh visible affiliated leader.';}}
  snapshot():PartyFollowSnapshot {
    const deadline=this.attempt?.deadline??(this.lostAt!==null&&this.settings?this.lostAt+automationSettings(this.settings).follow.lostSeconds*1000:0);
    return {state:this.state,reason:this.reason,destination:this.attempt?.destination??'',remainingSeconds:deadline?Math.max(0,Math.min(120,(deadline-this.now())/1000)):0,attemptUsed:this.used,ownsTravel:this.ownsTravel};
  }
}

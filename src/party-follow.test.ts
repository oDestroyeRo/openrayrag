import { describe, expect, it } from 'vitest';
import { ActorObservations } from './actor-observations';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { PartyFollowRuntime, type PartyFollowContext } from './party-follow';
import { type Entity, type GameEvent } from './protocol';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { WorldState } from './world-state';
import type { PartyMember, WorldEvent } from './world-protocol';
import type { TravelTransition } from './travel-controller';

const own:Entity={id:1,name:'Self',kind:0,classId:0,level:10,x:170,y:370,hp:100,maxHp:100,dead:false};
const leader:Entity={...own,id:2,name:'Leader',x:174,partyId:5,partyName:'Party'};
const member:PartyMember={memberId:7,entityId:2,name:'Leader',leader:true,level:10,map:'prt_fild08',hp:100,maxHp:100,sp:50,maxSp:100};
function fixture() {
 let now=100_000,connection=1,player:Entity|undefined={...own};const actors=new Map<number,Entity>([[2,{...leader}]]);
 const observations=new ActorObservations(()=>now),world=new WorldState(),runtime=new PartyFollowRuntime(()=>now);
 world.reset('prt_fild08');observations.spawn(own,1,1);observations.spawn(leader,1,0);observations.frame();
 const context=():PartyFollowContext=>{const self=observations.partyActor(1);return {party:world.party,bindings:world.partyActors,observations,actors,map:world.map,player,connection,
   own:self?{world:self.world,selfId:1,selfIncarnation:self.incarnation}:null};};
 const event=(event:WorldEvent)=>{const before=world.party?{...world.party,members:new Map([...world.party.members].map(([id,row])=>[id,{...row}]))}:null;
  world.apply(event,1);runtime.observeParty(event,before,context());world.partyActors.observe(event,world.party,world.map,observations,1);};
 event({type:'partyJoined',partyId:5,name:'Party',login:false,members:[{...member}]});
 const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[],automation:structuredClone(DEFAULT_AUTOMATION)};
 settings.automation.combat.mode='off';settings.automation.follow={...settings.automation.follow,mode:'partyLeader',rendezvous:true,lostSeconds:20};
 const start=()=>runtime.start(settings,context());const update=()=>{world.partyActors.sync(world.party,world.map,observations,1);runtime.update(context());};
 const advance=(ms:number)=>{now+=ms;observations.frame();};
 const hide=()=>{actors.delete(2);observations.remove(2);update();};
 const remote=(map='prontera')=>{event({type:'partyMap',memberId:7,map});update();};
 const arrive=(map:string,trip=1)=>{
   const change:GameEvent={type:'map',map};world.reset(map,true);observations.reset();actors.clear();player=undefined;
   runtime.observeGame([change],[{trip,phase:'map',fromMap:'prt_fild08',toMap:map,event:change}],context());
   player={...own,x:156,y:26};observations.spawn(player,1,1);observations.frame();
   const spawn:GameEvent={type:'spawn',entity:player,entryType:1};
   const proof:TravelTransition={trip,phase:'spawn',fromMap:'prt_fild08',toMap:map,event:spawn};runtime.observeGame([spawn],[proof],context());
 };
 return {runtime,observations,world,actors,settings,context,event,start,update,advance,hide,remote,arrive,setConnection:(n:number)=>{connection=n;}};
}
describe('captured party follow allowance',()=>{
 it('leaves omitted legacy policy disabled and opt-in off prevents map travel',()=>{
  const f=fixture();delete f.settings.automation.follow.mode;delete f.settings.automation.follow.rendezvous;f.start();expect(f.runtime.snapshot().state).toBe('disabled');
  f.settings.automation.follow.mode='partyLeader';f.start();expect(f.runtime.snapshot().state).toBe('following');f.remote();expect(f.runtime.prepared()).toBeNull();expect(f.runtime.snapshot().state).toBe('waiting');
 });
 it('requires shared binding, a positive online ID and one unambiguous leader',()=>{
  for(const rows of [[{...member,entityId:0}],[{...member,entityId:-1}],[member,{...member,memberId:8,name:'Other',leader:false}],[member,{...member,memberId:8,entityId:3}]] ){
   const f=fixture();f.event({type:'partyJoined',partyId:5,name:'Party',login:false,members:rows});f.start();expect(f.runtime.visibleLeader(f.context())).toBeNull();expect(f.runtime.prepared()).toBeNull();
  }
  const f=fixture();f.actors.set(2,{...leader,name:'Namesake'});f.start();expect(f.runtime.snapshot().state).toBe('selecting');
 });
 it('cannot establish an association from a remote roster/map row or an observed actor zero',()=>{
  const f=fixture();f.event({type:'partyJoined',partyId:5,name:'Party',login:false,members:[{...member,map:'prontera'}]});f.start();f.remote();expect(f.runtime.prepared()).toBeNull();
  const z=fixture();z.actors.set(0,{...leader,id:0});z.observations.spawn({...leader,id:0},1);z.event({type:'partyJoined',partyId:5,name:'Party',login:false,members:[{...member,entityId:0}]});z.start();expect(z.runtime.visibleLeader(z.context())).toBeNull();
 });
 it('captures original loss time, independent map revision and detached policy/settings',()=>{
  const f=fixture();f.start();f.hide();f.advance(5000);f.remote();const trip=f.runtime.prepared()!;
  expect(trip.deadline).toBe(120_000);expect(trip.mapObservedAt).toBe(105_000);expect(trip.destination).toBe('prontera');
  expect(trip).not.toHaveProperty('position');f.settings.automation.follow.lostSeconds=120;trip.policy.deny.push('prontera');
  expect(f.runtime.prepared()!.policy.deny).toEqual([]);expect(f.runtime.prepared()!.deadline).toBe(120_000);
 });
 it('health and arbitrary traffic cannot refresh an old map row or create coordinates',()=>{
  const f=fixture();f.settings.automation.follow.lostSeconds=120;f.start();f.advance(15001);
  f.event({type:'partyHealth',memberId:7,hp:100,maxHp:100,sp:100,maxSp:100});f.hide();f.world.party!.members.get(7)!.map='prontera';f.update();
  expect(f.runtime.prepared()).toBeNull();expect(f.runtime.snapshot().reason).toContain('fresh authoritative');
 });
 it('old full rows cannot bind an actor replacement; a fresh consistent full row may bind it',()=>{
  const f=fixture();f.start();f.observations.spawn(leader,1,0);f.update();expect(f.runtime.visibleLeader(f.context())).toBeNull();f.remote();expect(f.runtime.prepared()).toBeNull();
  const fresh=fixture();fresh.start();fresh.observations.spawn(leader,1,0);fresh.update();fresh.event({type:'partyMember',change:'update',member:{...member}});fresh.update();expect(fresh.runtime.visibleLeader(fresh.context())).not.toBeNull();
 });
 it('same-map loss remains finite and repeated map reports do not restart the deadline',()=>{
  const f=fixture();f.start();f.hide();f.advance(10_000);f.remote();f.runtime.travelling(1);f.advance(9999);f.remote();f.advance(1);f.update();
  expect(f.runtime.snapshot().state).toBe('expired');f.advance(1000);f.remote();expect(f.runtime.prepared()).toBeNull();expect(f.runtime.snapshot().attemptUsed).toBe(true);
 });
 it('preserves the exact association and deadline across verified portal worlds, then waits for actual leader visibility',()=>{
  const f=fixture();f.start();f.hide();f.remote();const deadline=f.runtime.prepared()!.deadline;f.runtime.travelling(1);f.advance(4000);f.arrive('prontera');
  f.runtime.travelComplete();f.update();expect(f.runtime.snapshot().state).toBe('awaitingLeader');expect(f.runtime.snapshot().remainingSeconds).toBe((deadline-104000)/1000);
  f.actors.set(2,{...leader,x:158,y:26});f.observations.spawn({...leader,x:158,y:26},1,0);f.update();expect(f.runtime.snapshot().state).toBe('following');expect(f.runtime.completed).toBe(true);expect(f.world.partyActors.get(7)).toBeNull();
 });
 it('preserves the original allowance over intermediate portals without retargeting',()=>{
  const f=fixture();f.settings.automation.follow.lostSeconds=30;f.start();f.hide();f.remote('payon');f.runtime.travelling(1);f.advance(3000);f.arrive('prontera');f.advance(5000);f.arrive('payon');f.runtime.travelComplete();f.update();
  expect(f.runtime.snapshot().remainingSeconds).toBe(22);expect(f.runtime.snapshot().destination).toBe('payon');expect(f.runtime.snapshot().state).toBe('awaitingLeader');
 });
 it.each(['partyLeft','partyLeader','partyRemove','logout','duplicate','map'])('revokes a captured trip on %s before accepting arrival',kind=>{
  const f=fixture();f.start();f.remote();f.runtime.travelling(1);
  if(kind==='partyLeft')f.event({type:'partyLeft',disbanded:false});
  if(kind==='partyLeader')f.event({type:'partyLeader',memberId:8});
  if(kind==='partyRemove')f.event({type:'partyRemove',memberId:7});
  if(kind==='logout')f.event({type:'partyMember',change:'logout',member:{...member,entityId:0,map:undefined}});
  if(kind==='duplicate')f.event({type:'partyMember',change:'add',member:{...member,memberId:8,leader:false,map:'prontera'}});
  if(kind==='map')f.remote('payon');
  f.arrive('prontera');expect(f.runtime.snapshot().state).toBe('cancelled');expect(f.runtime.snapshot().attemptUsed).toBe(true);
 });
 it('cancels actor affiliation/replacement during the trip and requires new destination evidence',()=>{
  for(const changed of [{...leader,name:'Namesake'},{...leader,partyId:6},{...leader,kind:1}]){
   const f=fixture();f.start();f.remote();f.runtime.travelling(1);f.observations.spawn(changed,1);f.update();expect(f.runtime.snapshot().state).toBe('cancelled');
  }
  const f=fixture();f.start();f.remote();f.runtime.travelling(1);f.arrive('prontera');f.runtime.travelComplete();f.actors.set(2,leader);f.observations.spawn({...leader,partyId:6},1,0);f.update();expect(f.runtime.snapshot().state).toBe('cancelled');
 });
 it.each(['enter','clear','map','wrongTrip','wrongSpawn','death','connection'])('fails closed for %s without new allowance',kind=>{
  const f=fixture();f.start();f.remote();f.runtime.travelling(1);
  if(kind==='connection'){f.setConnection(2);f.update();}
  else if(kind==='wrongTrip')f.arrive('prontera',2);
  else if(kind==='wrongSpawn')f.runtime.observeGame([{type:'spawn',entity:own,entryType:0}],[],f.context());
  else if(kind==='enter')f.runtime.observeGame([{type:'enter',id:1,map:'prontera'}],[],f.context());
  else if(kind==='map')f.runtime.observeGame([{type:'map',map:'prontera'}],[],f.context());
  else if(kind==='death')f.runtime.observeGame([{type:'death',id:1}],[],f.context());
  else f.runtime.observeGame([{type:'clear'}],[],f.context());
  expect(f.runtime.snapshot().state).toBe('cancelled');expect(f.runtime.prepared()).toBeNull();
 });
 it('rejects incompatible lock rectangles and denied destinations before movement',()=>{
  for(const policy of [{...structuredClone(DEFAULT_MAP_POLICY),deny:['prontera']},{...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:160,maxX:180,minY:360,maxY:380}}]){
   const f=fixture();f.settings.automation.mapPolicy=policy;f.start();f.remote();expect(f.runtime.snapshot().state).toBe('failed');expect(f.runtime.prepared()).toBeNull();
  }
 });
 it('existing economic ownership blocks admission without freshening the loss allowance',()=>{
  const f=fixture();f.start();f.event({type:'partyMap',memberId:7,map:'prontera'});f.runtime.update({...f.context(),admissionReady:false});expect(f.runtime.snapshot().attemptUsed).toBe(false);
  f.advance(1000);f.update();expect(f.runtime.prepared()!.deadline).toBe(120000);
 });
});

it('captures destination lifetime before final travel completion and rejects reuse without a new full binding',()=>{
 const f=fixture();f.start();f.remote();f.runtime.travelling(1);f.arrive('prontera');
 f.actors.set(2,{...leader,x:158,y:26});f.observations.spawn({...leader,x:158,y:26},1,0);f.update();
 expect(f.runtime.snapshot().state).toBe('travelling');
 f.observations.remove(2);f.observations.spawn({...leader,x:158,y:26},1,0);f.update();f.runtime.travelComplete();
 expect(f.runtime.snapshot().state).toBe('cancelled');expect(f.world.partyActors.get(7)).toBeNull();expect(f.runtime.completed).toBe(false);
});

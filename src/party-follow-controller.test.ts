import { partyMemberId } from './domain-values';
import { describe, expect, it, vi } from 'vitest';
import { BitWriter } from './binary';
import { CompanionController } from './controller';
import type { Action } from './engine';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { walkDuration } from './movement';
import { OP, type Entity, type Walk } from './protocol';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_SETTINGS } from './settings';
import * as travelRoutes from './travel';
import type { TravelStep } from './travel';
import { BUILTIN_SERVICES } from './npc-services';
import { FEATURE_OP } from './protocol-feature';
import { WORLD_OP, type WorldAction } from './world-protocol';

const own:Entity={id:1,classId:0,name:'Self',kind:0,level:10,hp:100,maxHp:100,x:170,y:370,dead:false};
const leader:Entity={...own,id:2,name:'Leader',x:174,partyId:5,partyName:'Party'};
function spawn(entity:Entity,entry=0):Uint8Array {
 const name=new TextEncoder().encode(entity.name),body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0)
  .i32(~name.length).i32(entity.name.length).take(name).u8(entity.kind).u8(0).u8(entity.dead?3:0)
  .i32(entity.x).i32(entity.y).u8(entity.level).i32(entity.hp).i32(entity.maxHp).i32(0).i32(0).i32(0).u8(0).finish();
 return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body).finish();
}
function resources(hp=100):Uint8Array {
 const data=[10,1,1000,1,1,1,1,1,1,0,0,0],combat=[hp,100,100,100,...Array(16).fill(0),1000];
 const writer=new BitWriter().u8(FEATURE_OP.stats);
 for(const value of [...data,...combat])writer.i32(value);
 writer.f32(0.4).i32(20).i32(0).bool(true).i16(0).i16(0).bool(true).u8(1).i32(2).i32(501).i16(5).i32(601).i16(5).i32(0).u8(0);
 for(let index=0;index<10;index++)writer.i32(0);
 return writer.i32(-1).finish();
}
const attack=(source:number,target:number)=>new BitWriter().u8(OP.attack).i32(source).i32(target).i32(0).position(own).finish();
const cast=(skillId=11,target=3)=>new BitWriter().u8(FEATURE_OP.castStart).i32(1).i32(target).u8(skillId).u8(1).u8(0).position(own).f32(0.1).u8(0).finish();
const execution=({source=1,target=3,skillId=11,level=1,indirect=false}={})=>new BitWriter().u8(FEATURE_OP.skill).u8(2).i32(source).i32(-1).i32(target)
 .u8(skillId).u8(level).u8(0).position(own).i32(1).u8(0).u8(1).f32(0.1).f32(0).bool(indirect).finish();
function fixture(ownId=1) {
 let now=100000;const sent:Array<Action|WorldAction>=[],controller=new CompanionController(action=>sent.push(action),()=>now);
 controller.connect(true);controller.receive(new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());controller.receive(spawn({...own,id:ownId},1));controller.receive(spawn(leader));
 const affiliation=(partyId=5)=>controller.receive(new BitWriter().u8(OP.partyAffiliation).i32(2).u8(1).i32(partyId).string(partyId===5?'Party':'Other').bool(true).finish());
 affiliation();
 const join=(extra=false)=>{
  const writer=new BitWriter().u8(WORLD_OP.partyAccept).u8(0).i32(5).string('Party').u8(0).i32(extra?2:1);
  const row=(id:number,entityId:number,name:string,lead:boolean)=>{writer.i32(id).i32(entityId).i16(10).string(name).u8(lead?1:0);if(entityId>0)writer.string('prt_fild08').i32(100).i32(100).i32(50).i32(100);};
  row(7,2,'Leader',true);if(extra)row(8,ownId,'Self',false);controller.receive(writer.finish());
 };
 join(ownId===0);
 const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:structuredClone(DEFAULT_AUTOMATION)};
 settings.automation.combat.mode='off';settings.automation.follow={...settings.automation.follow,mode:'partyLeader',rendezvous:true,lostSeconds:20};
 const map=(destination='prontera')=>controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(9).i32(7).string(destination).finish());
 const tick=(ms=100)=>{now+=ms;controller.tick();};
 const advance=(ms:number)=>{while(ms>0){const step=Math.min(ms,100);tick(step);ms-=step;}};
 const arrive=()=>{controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());controller.receive(spawn({...own,id:ownId,x:156,y:26},1));};
 return {controller,sent,settings,map,tick,advance,arrive,affiliation,join,spawn:(entity:Entity,entry=0)=>controller.receive(spawn(entity,entry)),time:()=>now};
}
describe('single rendezvous movement owner',()=>{
 it('claims initial departure inside the field before attack, pickup, supply or routines',()=>{
  const f=fixture();f.settings.automation.combat.mode='selected';f.controller.start(f.settings);
  const supply=vi.spyOn(f.controller.supply,'observe'),routine=vi.spyOn(f.controller.routine,'tick');
  f.controller.engine.receive([{type:'spawn',entity:{...own,id:3,classId:4000,name:'Monster',kind:1,x:171}},
    {type:'drop',drop:{id:9,itemId:501,count:1,isNew:true,x:171,y:370}}]);
  f.map();expect(f.controller.snapshot().partyFollow.ownsTravel).toBe(true);
  expect(f.sent.map(action=>action.type)).toEqual(['stop','walk']);expect(routine).not.toHaveBeenCalled();
  const observed=supply.mock.calls.length;f.tick();expect(supply.mock.calls.length).toBe(observed);
  for(const mode of ['service','command','workflow','routine','memo','social'] as const)expect(()=>f.controller.perform(mode,mode==='command'?{type:'sit',sitting:true}:{})).toThrow();
  expect(f.sent.some(action=>['attack','pickup','useItem','shop','npcTalk'].includes(action.type))).toBe(false);
 });
 it('requires real expected own arrival and same visible affiliated leader before resuming finite field counters',()=>{
  const f=fixture();f.controller.start(f.settings);f.controller.engine.kills=3;f.controller.engine.looted=2;f.controller.engine.deaths=1;f.map();
  const before=f.controller.snapshot().partyFollow.remainingSeconds;
  f.controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());
  expect(f.controller.snapshot().partyFollow.state).toBe('travelling');expect(f.controller.engine.running).toBe(false);
  f.spawn({...own,x:156,y:26},1);expect(f.controller.snapshot().partyFollow.state).toBe('awaitingLeader');expect(f.controller.engine.running).toBe(false);
  f.spawn({...leader,x:158,y:26});expect(f.controller.engine.running).toBe(false);f.affiliation();
  expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
  expect(f.controller.engine.map).toBe('prontera');expect(f.controller.engine.deaths).toBe(1);expect(f.controller.engine.kills).toBe(3);expect(f.controller.engine.looted).toBe(2);
  expect(before).toBeLessThanOrEqual(20);expect(f.sent.some(action=>action.type==='attack'||action.type==='pickup')).toBe(false);
 });
 it('arrival without the leader expires once and does not retry or field-search',()=>{
  const f=fixture();f.settings.route_randomWalk=2;f.controller.start(f.settings);f.map();f.arrive();
  f.advance(20000);const walks=f.sent.filter(action=>action.type==='walk').length;
  expect(f.controller.snapshot().partyFollow.state).toBe('expired');expect(f.controller.snapshot().state).toBe('waiting');
  f.map();f.advance(1000);expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(walks);expect(f.controller.engine.running).toBe(false);
 });
 it.each([false,true])('Stop after walk ACK=%s retains the actual canceled movement fence',accepted=>{
  const f=fixture();f.controller.start(f.settings);f.map();const cells=f.controller.travel.snapshot().leg;
  const walk:Walk={origin:own,cells,secondsPerCell:0.1,firstSeconds:0.1,locked:false};
  if(accepted){f.controller.engine.receive([{type:'walk',id:1,walk}]);f.controller.travel.observe([{type:'walk',id:1,walk}]);}
  f.controller.stop();expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
  expect(()=>f.controller.start(f.settings)).toThrow('movement');
  f.controller.travel.observe([{type:'walk',id:1,walk}]);expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
  f.controller.engine.receive([{type:'walk',id:1,walk}]);f.advance(walkDuration(walk)+101);
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
  f.arrive();expect(f.controller.travel.movementSettled('prontera',f.controller.engine.player)).toBe(true);
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.travel.snapshot().state).toBe('cancelled');
 });
 it('changing leader destination cancels with the old wire fence and no new destination trip',()=>{
  const f=fixture();f.controller.start(f.settings);f.map();const walks=f.sent.filter(action=>action.type==='walk').length;f.map('payon');
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);f.advance(1000);
  expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(walks);expect(f.controller.snapshot().state).toBe('waiting');
 });
 it.each([0,1,2])('unsupported own entry %s terminates without field resume',entry=>{
  const f=fixture();f.controller.start(f.settings);f.map();f.controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());f.spawn({...own,x:156,y:26},entry);
  expect(f.controller.snapshot().partyFollow.state).toBe(entry===1?'awaitingLeader':'cancelled');expect(f.controller.engine.running).toBe(false);
 });
 it('unknown and denied destinations fail once; departure-only forbidden origin keeps policy',()=>{
  const unknown=fixture();unknown.controller.start(unknown.settings);unknown.map('unknown');expect(unknown.controller.snapshot().partyFollow.state).toBe('failed');unknown.advance(1000);expect(unknown.sent.some(action=>action.type==='walk')).toBe(false);
  const denied=fixture();denied.settings.automation.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),deny:['prontera']};denied.controller.start(denied.settings);denied.map();expect(denied.controller.snapshot().partyFollow.state).toBe('failed');
  const departure=fixture();departure.controller.start(departure.settings);departure.settings.automation.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),deny:['prt_fild08']};
  departure.controller.stop();departure.controller.start(departure.settings);departure.map();expect(departure.controller.travel.snapshot().policy.deny).toEqual(['prt_fild08']);expect(departure.sent.some(action=>action.type==='walk')).toBe(true);
 });
 it('actual own zero removal invalidates local association before a new automatic trip',()=>{
  const f=fixture(0);f.controller.start(f.settings);f.map();f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(1).i32(8).finish());
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.engine.running).toBe(false);
  expect(f.controller.world.party).toBeNull();expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();
  f.controller.stop();f.controller.travel.observe([{type:'map',map:'prontera'},{type:'spawn',entity:{...own,id:0,x:156,y:26},entryType:1}]);
  f.controller.start(f.settings);expect(f.controller.snapshot().partyFollow.state).toBe('selecting');
 });
 it('reconnect and Enter terminate without rearming from requested settings',()=>{
  for(const kind of ['connect','enter'] as const){const f=fixture();f.controller.start(f.settings);f.map();
   if(kind==='connect')f.controller.connect(true);else f.controller.receive(new BitWriter().u8(OP.enter).i32(1).string('prontera').finish());
   expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.runRequested).toBe(true);expect(f.controller.engine.running).toBe(false);
  }
 });
});

describe('rendezvous cancellation and safety arbitration',()=>{
 it('keeps the portal fence at interpolated and authoritative trigger positions until ordered arrival',()=>{
  const f=fixture();f.controller.start(f.settings);f.map();const cells=f.controller.travel.snapshot().leg;
  const walk:Walk={origin:own,cells,secondsPerCell:0.1,firstSeconds:0.1,locked:false};
  f.controller.engine.receive([{type:'walk',id:1,walk}]);f.controller.travel.observe([{type:'walk',id:1,walk}]);
  f.controller.stop();f.advance(walkDuration(walk)+101);
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
  f.controller.receive(new BitWriter().u8(OP.stopImmediate).i32(1).position(cells.at(-1)!).finish());
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
  expect(()=>f.controller.start(f.settings)).toThrow('movement');
  expect(()=>f.controller.perform('command',{type:'sit',sitting:true})).toThrow('movement');
  expect(()=>f.controller.perform('service',{service:BUILTIN_SERVICES[0],executionPolicy:DEFAULT_MAP_POLICY})).toThrow('movement');
  expect(f.controller.settledForMaintenance()).toBe(false);
  f.arrive();expect(f.controller.travel.movementSettled('prontera',f.controller.engine.player)).toBe(true);
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');
 });
 it('Stop after the accepted map retains its ordered spawn phase and checks pinned arrival geometry',()=>{
  const f=fixture();f.controller.start(f.settings);f.map();f.controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());f.controller.stop();
  f.spawn({...own,x:100,y:100},1);expect(f.controller.travel.movementSettled('prontera',f.controller.engine.player)).toBe(false);
  f.spawn({...own,x:156,y:26},1);expect(f.controller.travel.movementSettled('prontera',f.controller.engine.player)).toBe(true);
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.engine.running).toBe(false);
 });
 it('only a validated shortened prefix can settle a cancelled walk away from the portal',()=>{
  const f=fixture();f.controller.start(f.settings);f.map();const cells=f.controller.travel.snapshot().leg;f.controller.stop();
  const prefix=cells.slice(0,2),walk:Walk={origin:own,cells:prefix,secondsPerCell:0.1,firstSeconds:0.1,locked:false};
  const wrong={...walk,cells:[prefix[0]!,{x:prefix[1]!.x+1,y:prefix[1]!.y}]};
  f.controller.travel.observe([{type:'walk',id:1,walk:wrong}]);f.advance(500);expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
  f.controller.travel.observe([{type:'walk',id:1,walk}]);f.controller.engine.receive([{type:'walk',id:1,walk}]);f.advance(walkDuration(walk)+101);
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(true);
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');
 });
 it.each(['waiting','preparing','arrival'] as const)('enabled observed-threat escape can terminate %s follow without rearming it',phase=>{
  const f=fixture();f.controller.receive(resources());f.settings.automation.escape={...DEFAULT_ESCAPE,enabled:true,hpEnabled:false,threatEnabled:true,threatCount:1};
  f.controller.start(f.settings);
  if(phase==='waiting')f.controller.receive(new BitWriter().u8(OP.remove).i32(2).u8(0).finish());
  if(phase==='preparing'){
   f.controller.receive(new BitWriter().u8(FEATURE_OP.castStart).i32(1).i32(1).u8(11).u8(1).u8(0).position(own).f32(10).u8(0).finish());f.map();
   expect(f.controller.snapshot().partyFollow.state).toBe('preparing');
  }
  if(phase==='arrival'){f.map();f.arrive();expect(f.controller.snapshot().partyFollow.state).toBe('awaitingLeader');}
  f.spawn({...own,id:3,name:'Monster',kind:1,x:171,y:370});
  f.controller.receive(new BitWriter().u8(OP.attack).i32(3).i32(1).u8(0).u8(0).u8(1).u8(0).position({x:171,y:370}).finish());
  if(phase==='preparing')f.controller.receive(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());
  f.advance(250);expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');
  expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
  expect(f.controller.snapshot().escape.pending).toBe(true);expect(f.controller.runRequested).toBe(true);
 });
 it('living respawn advances the existing recovery deadline while follow stays cancelled',()=>{
  const f=fixture();f.controller.receive(resources());f.settings.automation.respawn={enabled:true,maxDeaths:2};
  f.settings.automation.recovery.enabled=true;f.settings.automation.recovery.timeoutSeconds=1;
  f.controller.start(f.settings);f.controller.engine.kills=3;f.controller.engine.looted=2;
  f.controller.receive(new BitWriter().u8(OP.death).i32(1).finish());f.advance(2100);
  expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);
  f.controller.receive(Uint8Array.of(OP.clear));f.spawn({...own,hp:20},2);
  expect(f.controller.snapshot().deathRecoveryGuard?.phase).toBe('recovery');f.advance(1100);
  expect(f.controller.snapshot().deathRecoveryGuard?.phase).toBe('failed');expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');
  expect(f.controller.engine.kills).toBe(3);expect(f.controller.engine.looted).toBe(2);expect(f.controller.engine.deaths).toBe(1);
  expect(f.controller.runRequested).toBe(true);expect(f.controller.engine.running).toBe(false);
 });
 it('own remove cancels even after applying the removal has made the player unavailable',()=>{
  const f=fixture();f.controller.start(f.settings);f.controller.receive(new BitWriter().u8(OP.remove).i32(1).u8(0).finish());
  expect(f.controller.engine.player).toBeUndefined();expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');
 });
});

describe('one captured allowance through preparation and planning',()=>{
 it('includes own cast preparation and deferred planning in the original loss deadline',async()=>{
  const f=fixture();f.settings.automation.follow.lostSeconds=2;f.settings.automation.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),mode:'weighted'};
  let resolve!:(steps:TravelStep[]|null)=>void;
  const planned=travelRoutes.routeBetweenMaps('prt_fild08',own,'prontera',false,f.settings.automation.mapPolicy)!;
  const planner=vi.spyOn(travelRoutes,'routeBetweenMapsAsync').mockImplementation(()=>new Promise(done=>{resolve=done;}));
  try {
   f.controller.start(f.settings);f.controller.receive(new BitWriter().u8(OP.remove).i32(2).u8(0).finish());f.advance(500);
   f.controller.receive(new BitWriter().u8(FEATURE_OP.castStart).i32(1).i32(1).u8(11).u8(1).u8(0).position(own).f32(10).u8(0).finish());f.map();
   expect(f.controller.snapshot().partyFollow).toMatchObject({state:'preparing',remainingSeconds:1.5});
   f.advance(1499);f.controller.receive(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());
   expect(f.controller.travel.snapshot().state).toBe('planning');f.tick(1);expect(f.controller.snapshot().partyFollow.state).toBe('expired');
   resolve(planned);await Promise.resolve();await Promise.resolve();f.tick();
   expect(f.controller.travel.snapshot().state).toBe('cancelled');expect(f.sent.some(action=>action.type==='walk')).toBe(false);
   expect(f.controller.runRequested).toBe(true);expect(f.controller.engine.running).toBe(false);
  } finally {f.controller.stop();planner.mockRestore();}
 });
 it('a late old planner cannot install or cancel the new explicit Start trip',async()=>{
  const f=fixture();f.settings.automation.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),mode:'weighted'};
  const pending:Array<(steps:TravelStep[]|null)=>void>=[];
  const planned=travelRoutes.routeBetweenMaps('prt_fild08',own,'prontera',false,f.settings.automation.mapPolicy)!;
  const planner=vi.spyOn(travelRoutes,'routeBetweenMapsAsync').mockImplementation(()=>new Promise(done=>{pending.push(done);}));
  try {
   f.controller.start(f.settings);f.map();const old=f.controller.travel.tripId;f.controller.stop();f.join();f.controller.start(f.settings);f.map();
   expect(f.controller.travel.tripId).toBeGreaterThan(old);pending[0]!(planned);await Promise.resolve();await Promise.resolve();f.tick();
   expect(f.controller.travel.snapshot().state).toBe('planning');expect(f.sent.some(action=>action.type==='walk')).toBe(false);
   pending[1]!(planned);await Promise.resolve();await Promise.resolve();f.tick();
   expect(f.controller.travel.snapshot().state).toBe('walking');expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
  } finally {f.controller.stop();planner.mockRestore();}
 });
 it('a sent resource receipt blocks admission and cannot be erased by follow loss or health traffic',()=>{
  const f=fixture();f.controller.receive(resources(80));f.settings.automation.items=[{itemId:501,resource:'hp',belowPercent:90,minStock:0,cooldownSeconds:1}];
  f.controller.start(f.settings);f.tick();expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);f.map();
  expect(f.controller.snapshot().partyFollow.attemptUsed).toBe(false);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  f.controller.receive(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100).finish());f.advance(1000);
  expect(f.controller.snapshot().partyFollow.attemptUsed).toBe(false);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  f.controller.receive(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(20).bool(false).finish());f.advance(5100);
  expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
  expect(f.controller.snapshot().partyFollow.remainingSeconds).toBeLessThan(15);
 });
 it('same-map follow retains the configured distance and the physical field rectangle',()=>{
  const f=fixture();f.settings.automation.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:160,maxX:175,minY:365,maxY:375}};
  f.controller.start(f.settings);f.tick();expect(f.sent).toEqual([]);expect(f.controller.engine.reason).toContain('follow distance');
  f.controller.receive(new BitWriter().u8(OP.move).i32(2).position({x:180,y:370}).finish());f.tick();
  expect(f.controller.engine.reason).toContain('outside the field lock area');expect(f.sent.some(action=>action.type==='walk')).toBe(false);
 });
});

it.each([0,1])('own roster removal %i wins while the verified portal is still loading',ownId=>{
 const f=fixture(ownId);f.join(true);f.controller.start(f.settings);f.map();f.controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());
 expect(f.controller.engine.player).toBeUndefined();f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(1).i32(8).finish());
 expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.world.party).toBeNull();
 f.spawn({...own,id:ownId,x:156,y:26},1);f.spawn({...leader,x:158,y:26});f.affiliation();f.tick();
 // An ordinary full member row cannot recreate a removed party association.
 f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(2).i32(7).i32(2).i16(10).string('Leader').u8(1).string('prontera').i32(100).i32(100).i32(50).i32(100).finish());
 f.map();f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(8).i32(7).i32(100).i32(100).i32(50).i32(100).finish());
 f.spawn({...own,id:3,classId:4000,name:'Monster',kind:1,x:157,y:26});f.controller.receive(attack(2,3));
 expect(f.controller.world.party).toBeNull();expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();expect(f.controller.snapshot().partyEngagement.accepted).toBe(0);
 expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.engine.running).toBe(false);expect(f.controller.runRequested).toBe(true);
});
it('passive escape recovery cannot freeze the existing living death-cycle deadline',()=>{
 const f=fixture();f.controller.receive(resources());f.settings.automation.escape={...DEFAULT_ESCAPE,enabled:true,hpBelowPercent:70};
 f.settings.automation.respawn={enabled:true,maxDeaths:2};f.settings.automation.recovery.enabled=true;f.settings.automation.recovery.timeoutSeconds=1;
 f.controller.start(f.settings);f.controller.receive(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(20).i32(100).finish());f.advance(250);
 expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
 f.controller.receive(Uint8Array.of(OP.clear));f.spawn({...own,hp:20},2);expect(f.controller.snapshot().escape).toMatchObject({pending:false,latched:true});
 f.controller.receive(new BitWriter().u8(OP.death).i32(1).finish());f.advance(2100);expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);
 f.controller.receive(Uint8Array.of(OP.clear));f.spawn({...own,hp:20},2);expect(f.controller.snapshot().deathRecoveryGuard?.phase).toBe('recovery');f.advance(1100);
 expect(f.controller.snapshot().deathRecoveryGuard?.phase).toBe('failed');expect(f.controller.snapshot().escape.latched).toBe(true);expect(f.controller.engine.running).toBe(false);
});


describe('rendezvous on merged party engagement owners',()=>{
 it('captured arrival cannot lend shared combat permission before a fresh ordinary member row',()=>{
  const f=fixture();f.settings.automation.combat.partyEngagement=true;f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});f.affiliation();
  expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();
  f.spawn({...own,id:3,classId:4000,name:'Monster',kind:1,x:159,y:26});f.controller.receive(attack(2,3));
  expect(f.controller.snapshot().partyEngagement).toMatchObject({accepted:0,blocked:1});
  f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(2).i32(7).i32(2).i16(10).string('Leader').u8(1).string('prontera').i32(100).i32(100).i32(50).i32(100).finish());
  expect(f.controller.world.partyActors.get(partyMemberId(7))).not.toBeNull();f.controller.receive(attack(2,3));
  expect(f.controller.snapshot().partyEngagement).toMatchObject({accepted:0,blocked:1});
  f.spawn({...own,id:9,classId:4000,name:'New monster',kind:1,x:159,y:26});f.controller.receive(attack(2,9));
  expect(f.controller.snapshot().partyEngagement).toMatchObject({accepted:1,blocked:1});expect(f.controller.snapshot().partyFollow.state).toBe('following');
 });
 function combatFixture(escape=false,lostSeconds=120){
  const f=fixture();f.controller.receive(resources());f.controller.receive(new BitWriter().u8(FEATURE_OP.learnedSkill).u8(11).u8(1).i32(0).finish());
  f.settings.automation.combat.mode='selected';f.settings.automation.combat.partyEngagement=true;f.settings.automation.follow.lostSeconds=lostSeconds;
  f.settings.automation.attackStrategies=[{id:'bolt',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
  if(escape){f.settings.automation.escape={...DEFAULT_ESCAPE,enabled:true,hpEnabled:false,threatEnabled:true,threatCount:1,threatWindowSeconds:60,cooldownSeconds:1};f.settings.automation.respawn={enabled:true,maxDeaths:1};}
  f.spawn({...own,id:3,classId:4000,name:'Monster',kind:1,x:171});f.controller.receive(attack(2,3));f.controller.start(f.settings);f.tick();
  expect(f.sent.filter(action=>action.type==='skill')).toEqual([{type:'skill',mode:'target',skillId:11,level:1,target:3}]);
  f.controller.receive(cast());
  const freshAdvance=(ms:number)=>{while(ms>0){const step=Math.min(ms,1000);f.controller.receive(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100).finish());f.advance(step);ms-=step;}};
  return {...f,freshAdvance};
 }
 it('separates revoked resource and proc-cast receipts from movement admission after timeout',()=>{
  const f=combatFixture(),sequence=f.controller.engine.actionResult.sequence;f.map();f.freshAdvance(35000);
  // Refresh only destination evidence; the original loss allowance keeps running.
  f.map();expect(f.controller.snapshot().partyEngagement).toMatchObject({accepted:0,blocked:1});
  expect(f.controller.snapshot().partyFollow).toMatchObject({state:'waiting',attemptUsed:false});
  f.controller.receive(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());expect(f.controller.engine.observedOwnCastSettled()).toBe(true);
  for(const change of [{skillId:12},{level:2},{target:8},{source:2},{indirect:true}]){
   f.controller.receive(execution(change));f.advance(200);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
   expect(f.controller.engine.actionResult).toMatchObject({sequence,status:'failed'});
  }
  f.controller.receive(cast(42,1));f.controller.receive(execution());f.advance(1200);
  expect(f.controller.engine.observedOwnCastSettled()).toBe(false);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  expect(f.controller.snapshot().partyFollow).toMatchObject({state:'preparing',attemptUsed:true});
  f.controller.receive(new BitWriter().u8(OP.walk).i32(1).position(own).f32(own.x).f32(own.y).f32(0.1).f32(0.1).u8(2).u8(0x60).u8(0).finish());
  expect(f.controller.engine.observedCast).toBeNull();expect(f.controller.engine.observedOwnCastSettled()).toBe(false);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  f.advance(299);expect(f.sent.some(action=>action.type==='walk')).toBe(false);f.advance(201);
  expect(f.sent.filter(action=>action.type==='skill')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
  expect(f.controller.snapshot().partyFollow).toMatchObject({state:'travelling',attemptUsed:true});expect(f.controller.snapshot().partyFollow.remainingSeconds).toBeLessThan(85);
  expect(f.controller.snapshot()).toMatchObject({runRequested:true,kills:0,deaths:0});
  expect(f.controller.snapshot().attackStrategies.entries[0]?.rules[0]).toMatchObject({attempts:1,uses:0,uncertain:true});
 });
 it('does not replenish expired follow when a revoked exact cast result finally arrives',()=>{
  const f=combatFixture(false,2);f.map();f.freshAdvance(35000);expect(f.controller.snapshot().partyFollow.state).toBe('expired');
  f.controller.receive(execution());f.advance(1200);f.map();
  expect(f.sent.filter(action=>action.type==='skill')).toHaveLength(1);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:false,kills:0,deaths:0});expect(f.controller.snapshot().partyFollow.state).toBe('expired');
 });
 it('cancels only unsent threat preparation on own death and keeps the original one-death limit',()=>{
  const f=combatFixture(true);f.controller.engine.kills=3;f.controller.engine.looted=2;
  f.join();f.freshAdvance(35000);f.controller.receive(attack(3,1));f.controller.receive(execution());
  for(let i=0;i<20&&f.controller.snapshot().escape.state!=='preparing';i++)f.advance(100);
  expect(f.controller.snapshot().escape).toMatchObject({state:'preparing',pending:true,latched:false});f.controller.receive(cast(42,1));
  f.controller.receive(new BitWriter().u8(OP.death).i32(2).finish());expect(f.controller.snapshot().escape.pending).toBe(true);
  f.controller.receive(new BitWriter().u8(OP.death).i32(1).finish());f.advance(2100);
  expect(f.controller.snapshot().escape).toMatchObject({state:'idle',pending:false,latched:false});
  expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(0);expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);
  f.controller.receive(Uint8Array.of(OP.clear));f.spawn({...own},2);f.advance(100);
  f.controller.receive(new BitWriter().u8(OP.death).i32(1).finish());f.advance(2100);
  expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.controller.engine.deaths).toBe(2);
  expect(f.controller.snapshot().reason).toContain('Death limit');expect(f.controller.snapshot()).toMatchObject({runRequested:true,kills:3,looted:2});
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.sent.some(action=>action.type==='walk')).toBe(false);
 });
});

it.each([0,1])('ordered same-map clear retains own identity %i for shared membership removal',ownId=>{
 const f=fixture(ownId);f.join(true);f.controller.start(f.settings);f.controller.receive(Uint8Array.of(OP.clear));
 expect(f.controller.engine.player).toBeUndefined();expect(f.controller.engine.playerId).toBe(ownId);
 f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(1).i32(8).finish());expect(f.controller.world.party).toBeNull();expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();
});
it.each(['enter','connect'] as const)('old own identity cannot be borrowed after %s before a fresh own spawn',kind=>{
 const f=fixture(0);f.join(true);f.controller.start(f.settings);const oldConnection=f.controller.connectionGeneration;
 if(kind==='enter')f.controller.receive(new BitWriter().u8(OP.enter).i32(9).string('prt_fild08').finish());else f.controller.connect(true);
 expect(f.controller.engine.playerId).toBe(kind==='enter'?9:null);expect(f.controller.engine.player).toBeUndefined();
 f.join(true);f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(1).i32(8).finish());
 expect(f.controller.world.party?.members.get(7)?.entityId).toBe(2);expect(f.controller.world.party?.members.has(8)).toBe(false);
 f.spawn({...own,id:3,classId:4000,name:'Monster',kind:1,x:171});f.controller.receive(attack(2,3));
 expect(f.controller.snapshot().partyEngagement.accepted).toBe(0);expect(f.controller.engine.actorActionIdentity()).toBeNull();expect(f.sent.some(action=>action.type==='walk'||action.type==='attack')).toBe(false);
 if(kind==='connect'){f.controller.receive(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish(),oldConnection);expect(f.controller.engine.playerId).toBeNull();}
});


function rawWalk(id:number,cells:Array<{x:number;y:number}>,origin=cells[0]!,locked=false):Uint8Array {
 const offsets=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
 const directions=cells.slice(1).map((point,index)=>offsets.findIndex(([x,y])=>point.x-cells[index]!.x===x&&point.y-cells[index]!.y===y));
 const w=new BitWriter().u8(OP.walk).i32(id).position(cells[0]!).f32(origin.x).f32(origin.y).f32(0.1).f32(0.1).u8(cells.length);
 for(let i=0;i<directions.length;i+=2)w.u8(directions[i]!<<4|(directions[i+1]??0));return w.u8(locked?1:0).finish();
}
const leaderHealth=(hp:number)=>new BitWriter().u8(WORLD_OP.partyUpdate).u8(8).i32(7).i32(hp).i32(100).i32(50).i32(100).finish();
const removal=(id:number,reason=0)=>new BitWriter().u8(OP.remove).i32(id).u8(reason).f32(-1).finish();
const availabilityCast=(id:number,seconds=1)=>new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(id).u8(42).u8(1).u8(0).position(own).f32(seconds).u8(0).finish();
const availabilityLook=(id:number,head=1)=>new BitWriter().u8(OP.look).i32(id).i16(-1).i16(1).u8(0).u8(head).finish();
describe('merged stationary availability and rendezvous ownership',()=>{
 it.each([0,1])('own %i positive Look preserves a prior resource owner before admitting one captured trip',id=>{
  const f=fixture(id);f.controller.engine.receive([{type:'inventory',items:[{bagId:501,itemId:501,type:1,count:4}],equipment:Array(10).fill(0),ammoId:-1},{type:'stats',level:10,hp:50,maxHp:100,sp:100,maxSp:100}]);
  f.settings.automation.items=[{itemId:501,resource:'hp',belowPercent:90,minStock:0,cooldownSeconds:10}];f.controller.start(f.settings);f.tick();const sequence=f.controller.engine.actionResult.sequence;
  expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);f.controller.receive(availabilityCast(id));f.map();f.advance(1300);expect(f.sent.filter(action=>action.type==='look')).toHaveLength(1);
  f.controller.receive(availabilityLook(id===0?1:0));expect(f.controller.engine.observedCast).not.toBeNull();
  f.controller.receive(availabilityLook(id));f.advance(300);expect(f.controller.engine.observedCast).toBeNull();expect(f.controller.engine.actionResult).toMatchObject({sequence,status:'failed'});expect(f.controller.engine.featureActionsSettled).toBe(false);
  expect(f.controller.snapshot().partyFollow).toMatchObject({state:'waiting',attemptUsed:false});expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  f.controller.receive(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(0).bool(false).finish());f.advance(1000);
  expect(f.controller.engine.featureActionsSettled).toBe(false);expect(f.sent.some(action=>action.type==='walk')).toBe(false);f.advance(4000);
  expect(f.controller.engine.actionResult).toMatchObject({sequence,status:'failed'});expect(f.controller.engine.featureActionsSettled).toBe(true);expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);
  expect(f.controller.snapshot().partyFollow.state).toBe('travelling');expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
  f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(1).i32(7).finish());f.controller.receive(availabilityLook(id));f.advance(300);
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);
 });
 it.each([0,1])('own %i captured preparation suppresses Look queries while its original deadline advances',id=>{
  const f=fixture(id);f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);f.controller.receive(availabilityCast(id));f.map();
  expect(f.controller.snapshot().partyFollow.state).toBe('preparing');f.advance(1300);
  expect(f.sent.some(action=>action.type==='look')).toBe(false);expect(f.controller.snapshot().partyFollow.remainingSeconds).toBe(0.7);
  f.advance(700);expect(f.controller.snapshot().partyFollow.state).toBe('expired');f.controller.receive(availabilityLook(id));f.advance(500);
  expect(f.sent.some(action=>action.type==='walk'||action.type==='look')).toBe(false);expect(f.controller.engine.running).toBe(false);expect(f.controller.runRequested).toBe(true);
 });
 it.each([0,1])('own %i captured destination wait suppresses stationary queries without refreshing follow',id=>{
  const f=fixture(id);f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);f.map();f.arrive();f.controller.receive(availabilityCast(id));f.advance(1300);
  expect(f.controller.snapshot().partyFollow.state).toBe('awaitingLeader');expect(f.sent.some(action=>action.type==='look')).toBe(false);
  f.advance(700);expect(f.controller.snapshot().partyFollow.state).toBe('expired');f.controller.receive(availabilityLook(id));f.spawn({...leader,x:158,y:26});f.affiliation();
  expect(f.controller.snapshot().partyFollow.state).toBe('expired');expect(f.controller.engine.running).toBe(false);
 });
 it.each([0,1])('own %i late Look cannot acknowledge travel or complete a stopped trip after ordered arrival',id=>{
  const f=fixture(id);f.controller.start(f.settings);f.map();const leg=f.controller.travel.snapshot().leg;f.controller.receive(availabilityLook(id));
  expect(f.controller.travel.snapshot().leg).toEqual(leg);f.controller.stop();f.controller.receive(availabilityLook(id));f.advance(1000);
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);expect(()=>f.controller.start(f.settings)).toThrow('movement');
  f.controller.receive(removal(id));f.arrive();f.controller.receive(availabilityLook(id));f.spawn({...leader,x:158,y:26});f.affiliation();f.advance(300);
  expect(f.controller.travel.movementSettled('prontera',f.controller.engine.player)).toBe(true);expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.runRequested).toBe(false);expect(f.controller.engine.running).toBe(false);
 });
 it.each([0,1])('own %i availability debt survives the expected portal without authorizing field or a newer cast',id=>{
  const f=fixture(id);f.controller.start(f.settings);f.map();f.controller.receive(availabilityLook(id));expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
  f.controller.receive(removal(id));f.arrive();f.spawn({...leader,x:158,y:26});f.affiliation();
  expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(false);expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
  f.advance(199);expect(f.controller.engine.running).toBe(false);f.tick(1);expect(f.controller.engine.running).toBe(true);
  const oldConnection=f.controller.connectionGeneration;f.controller.disconnect();f.controller.connect(true);f.controller.receive(new BitWriter().u8(OP.enter).i32(id).string('prontera').finish());f.spawn({...own,id,x:156,y:26},1);
  f.controller.receive(availabilityCast(id));f.controller.receive(availabilityLook(id),oldConnection);expect(f.controller.engine.observedCast).not.toBeNull();f.advance(1300);
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.sent.some(action=>action.type==='look')).toBe(false);
 });
 it.each([0,1])('own %i death drains prior query debt and preserves the original one-death cap while follow stays canceled',id=>{
  const f=fixture(id);f.settings.automation.respawn={enabled:true,maxDeaths:1};f.settings.automation.recovery.enabled=false;f.controller.start(f.settings);f.controller.engine.kills=3;f.controller.engine.looted=2;
  f.controller.receive(availabilityCast(id));f.advance(1300);expect(f.sent.filter(action=>action.type==='look')).toHaveLength(1);f.map();expect(f.controller.snapshot().partyFollow.state).toBe('preparing');
  f.controller.receive(new BitWriter().u8(OP.death).i32(id).finish());f.advance(2100);expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);
  f.controller.receive(Uint8Array.of(OP.clear));f.spawn({...own,id},2);f.controller.receive(new BitWriter().u8(OP.death).i32(id).finish());f.advance(2100);
  expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='look')).toHaveLength(1);expect(f.controller.snapshot()).toMatchObject({runRequested:true,deaths:2,kills:3,looted:2});
  expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.snapshot().reason).toContain('Death limit');
 });
});
describe('raw moving leader visibility and portal departure',()=>{
 it.each(['walk','position'] as const)('current leader %s remains visible beyond the spawn freshness window',kind=>{
  const f=fixture();f.settings.automation.follow.distance=20;f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);
  const before=f.controller.engine.observations.snapshot(null,2,true,[],false).actors[0]!;
  for(let i=0;i<18;i++){
   f.controller.receive(kind==='walk'?rawWalk(2,[{x:174,y:370},{x:175,y:370}]):new BitWriter().u8(OP.stopImmediate).i32(2).position({x:175,y:370}).finish());f.advance(1000);
  }
  expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
  expect(f.controller.engine.observations.snapshot(null,2,true,[],false).actors[0]!).toMatchObject({observedAt:before.observedAt,hp:before.hp,sp:before.sp});
 });
 it.each(['foreign','tracking','health','removed','replacement','hp-zero'] as const)('%s traffic cannot supply living current-leader visibility',kind=>{
  const f=fixture();f.settings.automation.follow.distance=20;f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);
  if(kind==='removed')f.controller.receive(removal(2));if(kind==='replacement')f.spawn({...leader});if(kind==='hp-zero')f.controller.receive(leaderHealth(0));
  for(let i=0;i<18;i++){
   if(kind==='tracking')f.controller.receive(new BitWriter().u8(OP.tracking).i16(1).i32(2).position(leader).u8(0).finish());
   else if(kind==='health')f.controller.receive(leaderHealth(100));else f.controller.receive(rawWalk(kind==='foreign'?3:2,[{x:174,y:370},{x:175,y:370}]));f.advance(1000);
  }
  expect(f.controller.snapshot().partyFollow.state).toBe('expired');expect(f.controller.engine.running).toBe(false);expect(f.sent.some(action=>action.type==='walk')).toBe(false);
 });
 it.each([0,1])('own %i OutOfSight departure holds the captured portal trip until actual map and living entry1',id=>{
  const f=fixture(id);f.controller.start(f.settings);f.map();const before=f.controller.snapshot().partyFollow.remainingSeconds;
  f.controller.receive(removal(id));expect(f.controller.engine.player).toBeUndefined();expect(f.controller.engine.actorActionIdentity()).toBeNull();
  expect(f.controller.snapshot().partyFollow.state).toBe('travelling');expect(f.controller.travel.snapshot().state).toBe('transition');f.advance(1000);
  expect(f.controller.snapshot().partyFollow.state).toBe('travelling');expect(f.controller.engine.running).toBe(false);expect(f.controller.settledForMaintenance()).toBe(false);
  expect(f.controller.snapshot().partyFollow.remainingSeconds).toBeLessThan(before);expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
  f.arrive();expect(f.controller.snapshot().partyFollow.state).toBe('awaitingLeader');f.spawn({...leader,x:158,y:26});f.affiliation();
  expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
 });
 it.each(['missing-reason','teleport','disconnect','dead','refresh','foreign','wrong-leg','stale-source'] as const)('portal departure rejects %s proof',kind=>{
  const f=fixture();if(kind==='wrong-leg')f.settings.route_step=1;f.controller.start(f.settings);f.map();
  if(kind==='stale-source')f.spawn({...own});
  if(kind==='missing-reason'){
   const event={type:'remove' as const,id:1,dead:false};const proofs=f.controller.travel.observe([event]);
   // Synthetic events have no wire reason and cannot grant the portal exception.
   f.controller.partyFollow.observeGame([event],proofs,{party:f.controller.world.party,bindings:f.controller.world.partyActors,
    observations:f.controller.engine.observations,actors:f.controller.engine.actors,map:f.controller.engine.map,player:f.controller.engine.player,
    own:f.controller.engine.actorActionIdentity(),connection:f.controller.connectionGeneration});
  }else f.controller.receive(removal(kind==='foreign'?2:1,kind==='teleport'?1:kind==='disconnect'?2:kind==='dead'?3:kind==='refresh'?6:0));
  if(kind==='foreign'){expect(f.controller.engine.player).not.toBeUndefined();expect(f.controller.travel.snapshot().state).toBe('walking');expect(f.controller.snapshot().partyFollow.state).toBe('travelling');}
  else {expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.engine.running).toBe(false);f.arrive();expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');}
 });
 it.each(['stop','death','clear','unexpected-map','unordered-spawn','bad-arrival','timeout'] as const)('%s cannot complete a departing portal trip',kind=>{
  const f=fixture();f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);f.map();f.controller.receive(removal(1));
  if(kind==='stop')f.controller.stop();else if(kind==='death')f.controller.receive(new BitWriter().u8(OP.death).i32(1).finish());
  else if(kind==='clear')f.controller.receive(Uint8Array.of(OP.clear));else if(kind==='unexpected-map')f.controller.receive(new BitWriter().u8(OP.map).string('payon').finish());
  else if(kind==='unordered-spawn')f.spawn({...own,x:156,y:26},1);else if(kind==='bad-arrival'){f.controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());f.spawn({...own,x:100,y:100},1);}
  else f.advance(2000);
  expect(f.controller.snapshot().partyFollow.state).toBe(kind==='timeout'?'expired':'cancelled');expect(f.controller.engine.running).toBe(false);
  expect(f.controller.travel.movementSettled(f.controller.engine.map,f.controller.engine.player)).toBe(false);expect(f.controller.settledForMaintenance()).toBe(false);
 });
 it.each([0,1])('Stop during own %i departure retires its wire fence until actual ordered arrival without completing follow',id=>{
  const f=fixture(id);f.controller.start(f.settings);f.map();f.controller.receive(removal(id));f.advance(500);f.controller.stop();f.advance(500);
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);expect(f.controller.settledForMaintenance()).toBe(false);
  f.controller.receive(new BitWriter().u8(OP.map).string('prontera').finish());expect(f.controller.settledForMaintenance()).toBe(false);
  f.spawn({...own,id,x:156,y:26},1);expect(f.controller.settledForMaintenance()).toBe(true);
  f.spawn({...leader,x:158,y:26});f.affiliation();expect(f.controller.snapshot().partyFollow.state).toBe('cancelled');expect(f.controller.engine.running).toBe(false);
 });
});
describe('raw retired travel and observed leader availability',()=>{
 it.each([0,1])('partial zero HP before affiliation cannot complete own %i detached arrival or restore shared resources',id=>{
  const f=fixture(id);f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});
  const before=f.controller.engine.observations.snapshot(null,2,true,[],false).actors[0]!;
  f.controller.receive(leaderHealth(0));f.affiliation();
  expect(f.controller.world.party?.members.get(7)?.hp).toBe(0);expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();expect(f.controller.engine.observations.livingPlayer(2)).toBe(true);
  expect(f.controller.snapshot().partyFollow.state).toBe('awaitingLeader');expect(f.controller.engine.running).toBe(false);
  f.advance(1000);f.controller.receive(leaderHealth(0));expect(f.controller.snapshot().partyFollow.remainingSeconds).toBe(1);
  f.controller.receive(leaderHealth(100));expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
  expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();const after=f.controller.engine.observations.snapshot(null,2,true,[],false).actors[0]!;
  expect(after).toMatchObject({hp:before.hp,observedAt:before.observedAt});expect(after.sp).toEqual(before.sp);
 });
 it.each([0,1])('partial zero HP after own %i detached follow completion starts one finite loss allowance',id=>{
  const f=fixture(id);f.settings.automation.follow.lostSeconds=2;f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});f.affiliation();
  expect(f.controller.snapshot().partyFollow.state).toBe('following');const walks=f.sent.filter(action=>action.type==='walk').length;
  f.controller.receive(leaderHealth(0));expect(f.controller.snapshot().partyFollow.state).toBe('waiting');expect(f.controller.engine.running).toBe(false);
  f.advance(1000);f.controller.receive(leaderHealth(0));expect(f.controller.snapshot().partyFollow.remainingSeconds).toBe(1);f.advance(1000);
  expect(f.controller.snapshot().partyFollow.state).toBe('expired');f.controller.receive(leaderHealth(100));expect(f.controller.snapshot().partyFollow.state).toBe('expired');expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(walks);
  expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();expect(f.controller.runRequested).toBe(true);
 });
 it.each(['replace','remove','party-change','stale-positive'] as const)('partial HP recovery cannot borrow %s destination evidence',kind=>{
  const f=fixture();f.settings.automation.follow.lostSeconds=20;f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});f.controller.receive(leaderHealth(0));f.affiliation();
  if(kind==='replace')f.spawn({...leader,x:158,y:26});else if(kind==='remove')f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(1).i32(7).finish());
  else if(kind==='party-change')f.controller.receive(new BitWriter().u8(WORLD_OP.partyAccept).u8(0).i32(6).string('Other').u8(0).i32(1).i32(7).i32(2).i16(10).string('Leader').u8(1).string('prontera').i32(100).i32(100).i32(50).i32(100).finish());
  else f.advance(16000);
  f.controller.receive(leaderHealth(100));expect(f.controller.engine.running).toBe(false);expect(f.controller.snapshot().partyFollow.state).toBe(kind==='stale-positive'?'awaitingLeader':'cancelled');
  if(kind==='stale-positive'){
   f.controller.receive(new BitWriter().u8(OP.stopImmediate).i32(2).position({x:158,y:26}).finish());expect(f.controller.snapshot().partyFollow.state).toBe('following');
   expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();expect(f.controller.engine.observations.snapshot(null,2,true,[],false).actors[0]?.sp).toBeUndefined();
  }
 });
 it.each(['partial','full-row','heal'] as const)('fresh %s recovery retains the owning source for shared permissions',kind=>{
  const f=fixture();f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});f.affiliation();f.controller.receive(leaderHealth(0));
  expect(f.controller.snapshot().partyFollow.state).toBe('waiting');f.advance(500);
  if(kind==='partial')f.controller.receive(leaderHealth(100));else if(kind==='full-row')f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(2).i32(7).i32(2).i16(10).string('Leader').u8(1).string('prontera').i32(100).i32(100).i32(50).i32(100).finish());
  else f.controller.receive(new BitWriter().u8(OP.heal).i32(2).i32(0).i32(100).i32(100).finish());
  expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
  expect(f.controller.world.partyActors.get(partyMemberId(7))!==null).toBe(kind==='full-row');expect(f.controller.engine.observations.visibleAt(2)).toBe(100000);
 });
 it('foreign positive HP cannot release captured negative evidence and motion cannot replace it',()=>{
  const f=fixture();f.settings.automation.follow.lostSeconds=20;f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});f.controller.receive(leaderHealth(0));f.affiliation();
  f.advance(16000);f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(8).i32(8).i32(100).i32(100).i32(50).i32(100).finish());
  f.controller.receive(new BitWriter().u8(OP.stopImmediate).i32(2).position({x:158,y:26}).finish());
  expect(f.controller.snapshot().partyFollow).toMatchObject({state:'awaitingLeader',remainingSeconds:4});expect(f.controller.engine.running).toBe(false);
  f.controller.receive(leaderHealth(100));expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.world.partyActors.get(partyMemberId(7))).toBeNull();
 });
 it.each([0,1])('verified shortened own %i walk releases both movement owners after physical settlement',ownId=>{
  const f=fixture(ownId);f.controller.start(f.settings);f.map();const prefix=f.controller.travel.snapshot().leg.slice(0,2);f.controller.stop();
  f.controller.receive(rawWalk(ownId,prefix));f.advance(200);expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);expect(f.controller.settledForMaintenance()).toBe(false);
  f.advance(2300);expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(true);expect(f.controller.engine.idleForActions()).toBe(true);
  expect(f.controller.settledForMaintenance()).toBe(true);
  f.join();f.controller.start(f.settings);f.map();expect(f.controller.snapshot().partyFollow.state).toBe('travelling');expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(2);
 });
 it.each(['mismatch','foreign','stale','origin','locked'] as const)('retired travel does not release on %s movement evidence',kind=>{
  const f=fixture();f.controller.start(f.settings);f.map();const prefix=f.controller.travel.snapshot().leg.slice(0,2);f.controller.stop();
  if(kind==='stale')f.spawn({...own});
  const cells=kind==='mismatch'?[prefix[0]!,{x:prefix[0]!.x+1,y:prefix[0]!.y}]:prefix;
  f.controller.receive(rawWalk(kind==='foreign'?2:1,cells,kind==='origin'?{x:own.x+2,y:own.y}:prefix[0]!,kind==='locked'));f.advance(2500);
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);expect(f.controller.settledForMaintenance()).toBe(false);expect(()=>f.controller.start(f.settings)).toThrow('movement');
 });
 it.each([0,1])('accepted own %i portal walk remains fenced through Stop/correction until ordered arrival',ownId=>{
  const f=fixture(ownId);f.controller.start(f.settings);f.map();const cells=f.controller.travel.snapshot().leg;f.controller.stop();f.controller.receive(rawWalk(ownId,cells));f.advance(2500);
  f.controller.receive(new BitWriter().u8(OP.stopImmediate).i32(ownId).position(cells.at(-1)!).finish());
  expect(f.controller.travel.movementSettled('prt_fild08',f.controller.engine.player)).toBe(false);expect(f.controller.settledForMaintenance()).toBe(false);expect(()=>f.controller.start(f.settings)).toThrow('movement');
  f.arrive();expect(f.controller.travel.movementSettled('prontera',f.controller.engine.player)).toBe(true);expect(f.controller.settledForMaintenance()).toBe(true);
 });
 it.each([0,1])('authoritative leader HP zero pauses own %i follow until valid observed recovery',ownId=>{
  const f=fixture(ownId);f.controller.start(f.settings);f.controller.receive(leaderHealth(0));
  expect(f.controller.engine.actors.get(2)?.hp).toBe(100);expect(f.controller.engine.observations.livingPlayer(2)).toBe(false);
  expect(f.controller.snapshot().partyFollow.state).toBe('waiting');expect(f.controller.engine.running).toBe(false);
  f.advance(1000);f.controller.receive(leaderHealth(0));expect(f.controller.snapshot().partyFollow.remainingSeconds).toBeLessThanOrEqual(19);
  f.controller.receive(leaderHealth(100));expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
 });
 it('destination binding with observed HP zero cannot complete the captured trip',()=>{
  const f=fixture();f.controller.start(f.settings);f.map();f.arrive();f.spawn({...leader,x:158,y:26});
  f.controller.receive(new BitWriter().u8(WORLD_OP.partyUpdate).u8(2).i32(7).i32(2).i16(10).string('Leader').u8(1).string('prontera').i32(0).i32(100).i32(50).i32(100).finish());f.affiliation();
  expect(f.controller.engine.actors.get(2)?.hp).toBe(100);expect(f.controller.engine.observations.livingPlayer(2)).toBe(false);
  expect(f.controller.snapshot().partyFollow.state).toBe('awaitingLeader');expect(f.controller.engine.running).toBe(false);
  f.controller.receive(leaderHealth(100));expect(f.controller.snapshot().partyFollow.state).toBe('following');expect(f.controller.engine.running).toBe(true);
 });
});

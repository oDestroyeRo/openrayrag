import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { CompanionController, type ControllerAction } from './controller';
import type { Action } from './engine';
import { FEATURE_OP } from './protocol-feature';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { OP, type Entity } from './protocol';
import { BUILTIN_SERVICES } from './npc-services';
import { manualTargetPolicy } from './manual-target';

const own:Entity={id:1,classId:6,name:'Test',kind:0,level:7,hp:100,maxHp:100,x:100,y:100,dead:false};
const monster:Entity={...own,id:2,kind:1,classId:4000,name:'Poring',hp:10,maxHp:10,x:101};
const modes=['attack','search','pickup','recovery','manualItem','travel'] as const;
type Mode=typeof modes[number];
function cast(id:number,ground=false,skillId=ground?19:11,seconds=10):Uint8Array {
  const w=new BitWriter().u8(ground?FEATURE_OP.areaCastStart:FEATURE_OP.castStart).i32(id);
  if(ground)w.position({x:102,y:100});else w.i32(id);
  w.u8(skillId).u8(1);if(ground)w.u8(1);
  return w.u8(0).position(own).f32(seconds).u8(0).finish();
}
function result(id:number,ground=false,options:{skillId?:number;level?:number;indirect?:boolean;x?:number}={}):Uint8Array {
  const w=new BitWriter().u8(FEATURE_OP.skill).u8(ground?4:5).i32(id);
  if(ground)w.position({x:options.x??102,y:100});
  w.u8(options.skillId??(ground?19:11)).u8(options.level??1).u8(0).position(own).f32(0);
  if(!ground)w.bool(options.indirect??false);
  return w.finish();
}
function setup(mode:Mode='attack',id=1) {
  let now=100_000;const sent:Array<Action|ControllerAction>=[];
  const c=new CompanionController(action=>sent.push(action),()=>now,()=>({width:200,height:200,walkable:()=>true}));c.connect(true);
  c.engine.receive([{type:'enter',id,map:'prt_fild08'},{type:'spawn',entity:{...own,id}},...(mode==='attack'?[{type:'spawn' as const,entity:{...monster}}]:[])]);c.world.reset('prt_fild08');
  c.engine.receive([{type:'inventory',items:[{bagId:501,itemId:501,type:1,count:4}],equipment:Array(10).fill(0),ammoId:-1}]);
  const automation=structuredClone(DEFAULT_AUTOMATION);if(mode==='pickup')automation.loot.ownership='all';
  if(mode==='recovery')automation.items=[{itemId:501,resource:'hp',belowPercent:90,minStock:0,cooldownSeconds:10}];
  const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],route_randomWalk:mode==='search'?2 as const:0 as const,automation};
  const packet=(p:Uint8Array)=>c.receive(p);
  const step=(ms=100)=>{now+=ms;c.tick();};const advance=(ms:number)=>{while(ms>0){const n=Math.min(100,ms);step(n);ms-=n;}};
  const start=()=>c.start(settings);
  const prepare=()=>{if(!['manualItem','travel'].includes(mode))start();c.manualCommand();sent.length=0;};
  const inputs=()=>{if(mode==='pickup')c.engine.receive([{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}}]);if(mode==='recovery')c.engine.receive([{type:'heal',id,hp:80,maxHp:100}]);};
  return {c,sent,packet,step,advance,start,prepare,inputs,settings,time:()=>now,id};
}
describe('observed own cast admission',()=>{
 it.each(modes.flatMap(mode=>[0,1].flatMap(id=>[false,true].map(ground=>({mode,id,ground})))))(
  'holds $mode before claim for own$id ground=$ground, then continues on exact execution',({mode,id,ground})=>{
   const f=setup(mode,id);f.prepare();f.packet(cast(id,ground));f.inputs();f.advance(2500);
   if(mode==='travel'){f.c.travel.startApproach('prt_fild08',f.c.engine.player!,{x:105,y:100});f.step();expect(f.c.travel.snapshot().leg).toEqual([]);}
   if(mode==='manualItem'){expect(()=>f.c.engine.manualAction({type:'useItem',itemId:501})).toThrow();expect(f.c.engine.actionResult.status).toBe('idle');}
   expect(f.sent).toEqual([]);if(!['manualItem','travel'].includes(mode))expect(f.c.runRequested).toBe(true);
   f.packet(result(id,ground));f.advance(1000);if(mode==='manualItem')f.c.engine.manualAction({type:'useItem',itemId:501});
   const expected=mode==='attack'?'attack':mode==='pickup'?'pickup':['recovery','manualItem'].includes(mode)?'useItem':'walk';
   expect(f.sent.some(action=>action.type===expected)).toBe(true);
  });
 const ambiguousShapes=[{mode:'self',skillId:42,level:1},{mode:'target',skillId:43,level:1},{mode:'target',skillId:43,level:3},{mode:'target',skillId:96,level:3},{mode:'target',skillId:96,level:5},{mode:'target',skillId:96,level:10}] as const;
 const procResult=(id:number,skillId:number,level:number,target:number)=>new BitWriter().u8(FEATURE_OP.skill).u8(2).i32(id).i32(-1).i32(target).u8(skillId).u8(level).u8(0).position(own).i32(0).u8(0).u8(1).f32(0).f32(0).bool(false).finish();
 const startProcShape=(id:number,shape:typeof ambiguousShapes[number])=>new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(shape.mode==='self'?id:2).u8(shape.skillId).u8(shape.level).u8(0).position(own).f32(10).u8(0).finish();
 const acceptedWalk=(id:number)=>new BitWriter().u8(OP.walk).i32(id).position(own).f32(100).f32(100).f32(0.1).f32(0.1).u8(2).u8(0x60).u8(0).finish();
 it.each(ambiguousShapes.flatMap(shape=>[0,1].map(id=>({...shape,id}))))('keeps unmarked proc $skillId/$level $mode from clearing own$id, then continues after actual own walking',shape=>{
  const f=setup('attack',shape.id);f.prepare();f.packet(startProcShape(shape.id,shape));
  f.packet(procResult(shape.id,shape.skillId,shape.level,shape.mode==='self'?shape.id:2));f.advance(3000);
  expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(f.sent).toEqual([]);expect(f.c.runRequested).toBe(true);
  expect(f.c.snapshot().reason).toContain('triggered');expect(()=>f.c.engine.manualAction({type:'useItem',itemId:501})).toThrow('cast');
  f.packet(acceptedWalk(shape.id===0?1:0));expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.packet(acceptedWalk(shape.id));expect(f.c.engine.observedOwnCastSettled()).toBe(true);f.advance(400);
  expect(f.sent.some(a=>a.type==='attack')).toBe(true);
 });
 it.each([0,1])('accepts own %s StopCast for an ambiguous shape without completing a resource receipt',id=>{
  const f=setup('manualItem',id);f.c.engine.manualAction({type:'useItem',itemId:501});const sequence=f.c.engine.actionResult.sequence;
  f.packet(startProcShape(id,ambiguousShapes[0]));f.packet(procResult(id,42,1,id));
  f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.c.engine.actionResult).toMatchObject({sequence,status:'pending'});
 });
 it.each([0,1])('uses own %s StartWalk only as availability evidence, never a resource acknowledgment',id=>{
  const f=setup('manualItem',id);f.c.engine.manualAction({type:'useItem',itemId:501});const sequence=f.c.engine.actionResult.sequence;
  f.packet(startProcShape(id,ambiguousShapes[0]));f.packet(procResult(id,42,1,id));
  f.packet(new BitWriter().u8(OP.stop).i32(id).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.packet(acceptedWalk(id));expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.c.engine.actionResult).toMatchObject({sequence,status:'pending'});
  expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
 });
 it('does not settle a current own cast from an earlier socket StartWalk',()=>{
  const f=setup('manualItem'),old=f.c.connectionGeneration;f.c.connect(true);f.c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...own}}]);
  f.packet(startProcShape(1,ambiguousShapes[0]));f.c.receive(acceptedWalk(1),old);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
 });
 it('retains ordinary results for levels without a source-backed unmarked proc',()=>{
  const f=setup('manualItem');
  for(const shape of [{mode:'self',skillId:42,level:2},{mode:'target',skillId:43,level:2},{mode:'target',skillId:96,level:4}] as const){
    f.packet(new BitWriter().u8(FEATURE_OP.castStart).i32(1).i32(shape.mode==='self'?1:2).u8(shape.skillId).u8(shape.level).u8(0).position(own).f32(10).u8(0).finish());
    f.packet(procResult(1,shape.skillId,shape.level,shape.mode==='self'?1:2));expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  }
 });
 it('does not block new work for a foreign cast',()=>{const f=setup();f.prepare();f.packet(cast(2));f.advance(3000);expect(f.sent.some(a=>a.type==='attack')).toBe(true);});
 it.each([false,true])('retains cast uncertainty after deadline, adjust, Stop and unrelated terminal evidence; ground=%s',ground=>{
  const f=setup('manualItem');f.packet(cast(1,ground,ground?19:11,0.1));f.advance(200);
  f.packet(new BitWriter().u8(FEATURE_OP.castExtend).i32(1).f32(-10).finish());f.c.manualInput();f.c.stop();
  for(const terminal of [result(2,ground),result(1,ground,{skillId:12}),result(1,ground,{level:2}),
    new BitWriter().u8(FEATURE_OP.castStop).i32(2).finish(),ground?result(1,true,{x:103}):result(1,false,{indirect:true})]) {
    f.packet(terminal);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  }
  expect(f.c.settledForMaintenance()).toBe(false);expect(()=>f.c.engine.manualAction({type:'useItem',itemId:501})).toThrow('cast');
  f.packet(result(1,ground));expect(f.c.engine.observedOwnCastSettled()).toBe(true);f.c.engine.manualAction({type:'useItem',itemId:501});
  expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
 });
 it.each([0,1])('requires the target, level and result shape of own %s targeted casts',id=>{
  const f=setup('manualItem',id);
  f.packet(new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(2).u8(11).u8(3).u8(0).position(own).f32(1).u8(0).finish());
  const targeted=(target:number,level=3)=>new BitWriter().u8(FEATURE_OP.skill).u8(2).i32(id).i32(-1).i32(target).u8(11).u8(level).u8(0).position(own).i32(10).u8(0).u8(1).f32(0).f32(0).bool(false).finish();
  for(const packet of [targeted(3),targeted(2,2),result(id,false,{level:3}),result(id,true,{skillId:11,level:3}),Uint8Array.of(FEATURE_OP.skillFailure,3),Uint8Array.of(FEATURE_OP.requestFailure,2)]){
    f.packet(packet);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  }
  f.packet(targeted(2));expect(f.c.engine.observedOwnCastSettled()).toBe(true);
 });
 it('does not let an earlier different cast result clear a later owner, and admits exact StopCast',()=>{
  const f=setup('manualItem');f.packet(cast(1));f.packet(cast(1,false,12));f.packet(result(1));
  expect(f.c.engine.observedOwnCastSettled()).toBe(false);f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());
  expect(f.c.engine.observedOwnCastSettled()).toBe(true);
 });
 it.each(['replacement','remove','death','map','clear','reconnect'] as const)('retires prior own-cast evidence on validated %s',edge=>{
  const f=setup('manualItem');f.packet(cast(1));
  if(edge==='replacement')f.c.engine.receive([{type:'spawn',entity:{...own}}]);
  else if(edge==='remove')f.c.engine.receive([{type:'remove',id:1,dead:false}]);
  else if(edge==='death')f.c.engine.receive([{type:'death',id:1}]);
  else if(edge==='map')f.c.engine.receive([{type:'map',map:'prontera'}]);
  else if(edge==='clear')f.c.engine.receive([{type:'clear'}]);else f.c.connect(true);
  expect(f.c.engine.observedOwnCastSettled()).toBe(true);
 });
 it('rejects a terminal packet from an earlier transport generation',()=>{
  const f=setup('manualItem'),old=f.c.connectionGeneration;f.packet(cast(1));f.c.connect(true);
  f.c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...own}}]);f.packet(cast(1));
  f.c.receive(result(1),old);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
 });
 it('keeps field intent and counters while an official cast waits without forced Stop or restart',()=>{
  const f=setup('search');f.prepare();f.packet(cast(1));f.c.engine.deaths=1;f.c.engine.kills=7;
  f.advance(4000);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:7});expect(f.sent).toEqual([]);
  expect(f.c.snapshot().reason).toContain('cast');f.packet(result(1));f.advance(500);
  expect(f.c.engine.deaths).toBe(1);expect(f.c.engine.kills).toBe(7);expect(f.sent.some(a=>a.type==='walk')).toBe(true);
 });
 it('advances an existing resource receipt deadline while an official cast blocks new actions',()=>{
  const f=setup('manualItem');f.c.engine.manualAction({type:'useItem',itemId:501});const sequence=f.c.engine.actionResult.sequence;
  f.packet(cast(1));f.advance(7000);expect(f.c.engine.actionResult).toMatchObject({sequence,status:'failed'});
  expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
 });
 it('advances an existing attack deadline while preserving the unresolved cast fence',()=>{
  const f=setup();f.start();f.step();expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  f.packet(cast(1));f.advance(12_000);expect(f.sent.filter(a=>a.type==='stop')).toHaveLength(1);
  expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
 });
 it('expires an unconfirmed travel leg at its original deadline during a cast',()=>{
  const f=setup('travel');f.c.travel.startApproach('prt_fild08',f.c.engine.player!,{x:105,y:100});f.step();f.packet(cast(1));f.advance(4100);
  expect(f.c.travel.snapshot().state).toBe('failed');expect(f.sent.map(a=>a.type)).toEqual(['walk','stop']);
 });
 it('finishes accepted travel movement without claiming another leg during a cast',()=>{
  const f=setup('travel');f.c.travel.startApproach('prt_fild08',f.c.engine.player!,{x:120,y:100},5);f.step();
  const w=new BitWriter().u8(OP.walk).i32(1).position(own).f32(100).f32(100).f32(0.1).f32(0.1).u8(6).u8(0x66).u8(0x66).u8(0x60).u8(0);
  f.packet(w.finish());f.packet(cast(1));f.advance(1000);expect(f.c.engine.player?.x).toBe(105);expect(f.c.travel.snapshot().leg).toEqual([]);
  expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);f.packet(result(1));expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(2);
 });
 it.each([0,1])('keeps an admitted own %s manual walk finite while a cast waits, with client Stop still available',id=>{
  const f=setup('manualItem',id);f.c.engine.startManual({type:'manualTarget',command:{type:'walk',destination:{x:105,y:100}},owner:f.c.engine.manualActorIdentity(id),map:'prt_fild08',policy:manualTargetPolicy(f.settings),timeoutSeconds:10});
  f.packet(cast(id));f.advance(2500);expect(f.c.engine.manualTargetActive).toBe(true);expect(f.sent).toEqual([]);
  expect(f.c.engine.snapshot().manualTarget.remainingSeconds).toBe(7.5);f.c.stop();expect(f.c.engine.manualTargetActive).toBe(false);
  expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(f.sent.at(-1)?.type).toBe('stop');
 });
 it.each([0,1])('keeps the admitted own %s manual attack finite across a cast wait and resumes the same target',id=>{
  const f=setup('attack',id);f.c.engine.startManual({type:'manualTarget',command:{type:'attack',target:f.c.engine.manualActorIdentity(2)},owner:f.c.engine.manualActorIdentity(id),map:'prt_fild08',policy:manualTargetPolicy(f.settings),timeoutSeconds:10});
  f.packet(cast(id));f.advance(2500);expect(f.c.engine.manualTargetActive).toBe(true);expect(f.sent).toEqual([]);
  expect(f.c.engine.snapshot().manualTarget.remainingSeconds).toBe(7.5);f.packet(result(id));f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);
 });
 it('expires an admitted manual deadline without settling the observed cast',()=>{
  const f=setup('manualItem');f.c.engine.startManual({type:'manualTarget',command:{type:'walk',destination:{x:105,y:100}},owner:f.c.engine.manualActorIdentity(1),map:'prt_fild08',policy:manualTargetPolicy(f.settings),timeoutSeconds:10});
  f.packet(cast(1));f.advance(10_100);expect(f.c.engine.snapshot().manualTarget).toMatchObject({state:'failed',active:false,remainingSeconds:0});expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(f.sent.map(a=>a.type)).toEqual(['stop']);
 });
 it.each([0,1])('settles only the observed own %s CounterAttack on exact ResetMotion111, without acknowledging a resource',id=>{
  const f=setup('manualItem',id);f.c.engine.manualAction({type:'useItem',itemId:501});const sequence=f.c.engine.actionResult.sequence;
  f.packet(cast(id,false,31));f.packet(new BitWriter().u8(111).i32(id===0?1:0).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.packet(new BitWriter().u8(111).i32(id).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  expect(f.c.engine.actionResult).toMatchObject({sequence,status:'pending'});
 });
 it('does not let ResetMotion111 clear an impossible ground CounterAttack',()=>{
  const f=setup('manualItem');f.packet(cast(1,true,31));f.packet(new BitWriter().u8(111).i32(1).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(false);
 });
 it('does not let ResetMotion111 clear a different cast or an earlier connection owner',()=>{
  const f=setup('manualItem');f.packet(cast(1));f.packet(new BitWriter().u8(111).i32(1).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  const old=f.c.connectionGeneration;f.c.connect(true);f.c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...own}}]);f.packet(cast(1,false,31));
  f.c.receive(new BitWriter().u8(111).i32(1).finish(),old);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.c.engine.receive([{type:'spawn',entity:{...own}}]);expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  f.packet(cast(1));f.packet(new BitWriter().u8(111).i32(1).finish());expect(f.c.engine.observedOwnCastSettled()).toBe(false);
 });
 it.each([0,1])('uses shared settlement after CounterAttack111 for own %s maintenance and manual admission',id=>{
  const f=setup('manualItem',id);f.packet(cast(id,false,31));f.packet(new BitWriter().u8(111).i32(id).finish());
  expect(f.c.settledForMaintenance()).toBe(true);
  expect(()=>f.c.engine.startManual({type:'manualTarget',command:{type:'walk',destination:{x:105,y:100}},owner:f.c.engine.manualActorIdentity(id),map:'prt_fild08',policy:manualTargetPolicy(f.settings),timeoutSeconds:10})).not.toThrow();
 });
 it('rejects a new service before replacing field intent or reserving its visit',()=>{
  const f=setup();f.prepare();f.packet(cast(1));const before=f.c.service.snapshot();
  expect(()=>f.c.perform('service',BUILTIN_SERVICES[0])).toThrow('cast');
  expect(f.c.service.snapshot()).toEqual(before);expect(f.c.runRequested).toBe(true);expect(f.sent).toEqual([]);
 });
});

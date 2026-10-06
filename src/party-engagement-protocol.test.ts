import { partyMemberId } from './domain-values';
import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { manualTargetPolicy } from './manual-target';
import type { Action } from './engine';
import { CompanionController, type ControllerAction } from './controller';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { FEATURE_OP } from './protocol-feature';
import { OP, type Entity } from './protocol';
const map='prt_fild08';
const own:Entity={id:1,kind:0,classId:6,name:'Own',level:10,hp:100,maxHp:100,x:100,y:100,dead:false};
const monster:Entity={...own,id:2,kind:1,classId:4000,name:'Poring',level:1,x:101};
function memoryString(w:BitWriter,value:string):void {const b=new TextEncoder().encode(value);w.i32(~b.length).i32(value.length).take(b);}
function spawn(entity:Entity,party=false,entryType=0):Uint8Array {
 const b=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0);memoryString(b,entity.name);
 b.u8(entity.kind).u8(0).u8(0).i32(entity.x).i32(entity.y).u8(entity.level).i32(entity.hp).i32(entity.maxHp).i32(0).i32(0).i32(0).u8(0);
 const body=b.finish(),w=new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body);
 if(party){const a=new BitWriter().u8(13).u8(1).i32(7).u8(2).u8(3).u8(4);for(let i=0;i<5;i++)a.i32(0);a.i32(5);memoryString(a,'Party');a.i32(64);const appearance=a.finish();w.i32(appearance.length).take(appearance);}
 return w.finish();
}
const joined=(entityId=3)=>new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(1).i32(7).i32(entityId).i16(10).string('Ally').u8(0).string(map).i32(100).i32(100).i32(50).i32(100).finish();
const attack=(source=3,target=2)=>new BitWriter().u8(OP.attack).i32(source).i32(target).i32(0).position({x:100,y:100}).finish();
const skill=(attacker=-1,indirect=false,source=3)=>new BitWriter().u8(OP.skill).u8(1).i32(source).i32(attacker).i32(2).u8(11).u8(1).u8(0).position({x:100,y:100}).i32(1).u8(0).u8(1).f32(0.1).f32(0).bool(indirect).finish();
function fixture() {
 let at=100_000;const sent:Array<Action|ControllerAction>=[];
 const c=new CompanionController(action=>sent.push(action),()=>at,()=>({width:200,height:200,walkable:()=>true}));c.connect(true);
 c.receive(new BitWriter().u8(OP.enter).i32(1).string(map).finish());c.receive(spawn(own));c.receive(spawn(monster));c.receive(spawn({...own,id:3,name:'Ally'},true));c.receive(joined());
 const automation=structuredClone(DEFAULT_AUTOMATION);automation.combat.partyEngagement=true;
 const start=(targets=[4000])=>c.start({...DEFAULT_SETTINGS,map,targets,automation});
 const step=(ms=100)=>{at+=ms;c.receive(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100).finish());c.tick();};
 return {c,sent,start,step};
}
const actions=(f:ReturnType<typeof fixture>)=>f.sent.filter(a=>a.type==='attack'||a.type==='skill');
describe('party engagement wire/controller ownership',()=>{
 it.each([-1,3,4,1,0])('honors targeted skill source with separate attacker %i',attacker=>{
  const f=fixture();f.c.receive(skill(attacker));f.start();f.step();expect(actions(f)).toHaveLength(attacker===-1||attacker===3?1:0);
 });
 it('keeps indirect and source-less/source-zero damage foreign despite a party roster',()=>{
  for(const packet of [skill(-1,true),skill(3,false,0),attack(-1)]){const f=fixture();f.c.receive(packet);f.start();f.step();expect(actions(f)).toHaveLength(0);}
 });
 it('revokes raw leave/rejoin before the next tick and retains the requested run',()=>{
  const f=fixture();f.c.receive(attack());f.start();f.step();expect(actions(f)).toHaveLength(1);
  f.c.receive(new BitWriter().u8(102).u8(6).finish());f.c.receive(joined());f.c.receive(attack());f.step();
  expect(actions(f)).toHaveLength(1);expect(f.sent.filter(a=>a.type==='stop')).toHaveLength(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,running:true,partyEngagement:{blocked:1}});
 });
 it('does not resurrect permission with an identical full association replacement',()=>{
  const f=fixture();f.c.receive(attack());f.c.receive(joined());f.c.receive(attack());f.start();f.step();expect(actions(f)).toHaveLength(0);
 });
 it('refuses late old-roster health after visible actor replacement until a new full row, without repairing the old claim',()=>{
  const f=fixture();f.c.receive(attack());f.c.receive(spawn({...own,id:3,name:'Ally'},true));f.c.receive(new BitWriter().u8(102).u8(8).i32(7).i32(100).i32(100).i32(50).i32(100).finish());f.c.receive(joined());f.start();f.step();expect(actions(f)).toHaveLength(0);
 });
 it.each([9999,4,3])('never rehabilitates raw unrecorded overflow source %i, but permits a fresh monster incarnation',source=>{
  const f=fixture();f.c.receive(spawn({...own,id:4,name:'Outsider'}));
  for(let id=10;id<160;id++){f.c.receive(spawn({...monster,id}));f.c.receive(attack(3,id));}
  expect(f.c.snapshot().partyEngagement.accepted).toBe(150);
  f.c.receive(spawn({...monster,id:160,classId:4002}));f.c.receive(attack(source,160));
  f.c.receive(new BitWriter().u8(OP.remove).i32(10).u8(0).finish());f.c.receive(attack(3,160));f.start([4002]);f.step();expect(actions(f)).toHaveLength(0);
  f.c.receive(spawn({...monster,id:160,classId:4002}));f.c.receive(attack(3,160));f.step();expect(actions(f)).toEqual([{type:'attack',id:160}]);
 });
 it('holds a revoked sent cast beyond timeout until the retained exact receipt settles, without resetting run allowance',()=>{
  const f=fixture();f.c.engine.receive([{type:'stats',level:10,hp:100,maxHp:100,sp:100,maxSp:100},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:11,level:1}]}]);f.c.receive(attack());
  const a=structuredClone(DEFAULT_AUTOMATION);a.combat.partyEngagement=true;a.attackStrategies=[{id:'bolt',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];f.c.start({...DEFAULT_SETTINGS,map,targets:[4000],automation:a});f.step();
  expect(actions(f)).toHaveLength(1);f.c.receive(new BitWriter().u8(102).u8(6).finish());f.c.receive(spawn({...monster,id:8,x:101,y:101}));
  for(let i=0;i<35;i++)f.step(1000);expect(actions(f)).toHaveLength(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,running:false});expect(f.c.snapshot().reason).toContain('confirmed result');expect(f.c.snapshot().elapsedSeconds).toBeGreaterThanOrEqual(35);
  f.c.receive(skill(-1,false,1));f.step(1000);f.step();expect(actions(f)).toHaveLength(2);expect(actions(f)[1]).toMatchObject({type:'skill',target:8});
 });
 it('clears all bindings on raw own-zero kick and rejects old and new party claims until a full rejoin',()=>{
  const f=fixture();f.c.receive(new BitWriter().u8(OP.enter).i32(0).string(map).finish());f.c.receive(spawn({...own,id:0}));f.c.receive(spawn(monster));f.c.receive(spawn({...own,id:3,name:'Ally'},true));
  const roster=()=>new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(2).i32(7).i32(3).i16(10).string('Ally').u8(0).string(map).i32(100).i32(100).i32(50).i32(100).i32(8).i32(0).i16(10).string('Own').u8(1).finish();
  f.c.receive(roster());f.c.receive(attack());f.c.receive(new BitWriter().u8(102).u8(1).i32(8).finish());expect(f.c.world.party).toBeNull();expect(f.c.world.partyActors.get(partyMemberId(7))).toBeNull();
  f.c.receive(spawn({...monster,id:8,classId:4002}));f.c.receive(attack(3,8));f.start([4000,4002]);f.step();expect(actions(f)).toHaveLength(0);
  f.c.receive(roster());f.c.receive(attack());f.c.receive(attack(3,8));f.step();expect(actions(f)).toHaveLength(0);
  f.c.receive(spawn({...monster,id:9,classId:4002}));f.c.receive(attack(3,9));f.step();expect(actions(f)).toEqual([{type:'attack',id:9}]);
 });
 it('blocks typed manual attack from borrowing the automatic exception',()=>{
  const f=fixture();f.c.receive(attack());const request={type:'manualTarget',map,owner:f.c.engine.manualActorIdentity(1),command:{type:'attack',target:f.c.engine.manualActorIdentity(2)},policy:manualTargetPolicy({...DEFAULT_SETTINGS,map,targets:[4000]}),timeoutSeconds:10};
  expect(()=>f.c.engine.previewManual(request)).toThrow();
 });
});

const observedCast=(skillId=11,level=1,target=2)=>new BitWriter().u8(FEATURE_OP.castStart).i32(1).i32(target)
 .u8(skillId).u8(level).u8(0).position(own).f32(0.1).u8(0).finish();
const execution=(skillId=11,level=1,target=2,source=1,indirect=false)=>new BitWriter().u8(FEATURE_OP.skill).u8(2)
 .i32(source).i32(-1).i32(target).u8(skillId).u8(level).u8(0).position(own).i32(1).u8(0).u8(1).f32(0.1).f32(0).bool(indirect).finish();
const acceptedWalk=(id=1)=>new BitWriter().u8(OP.walk).i32(id).position(own).f32(100).f32(100)
 .f32(0.1).f32(0.1).u8(2).u8(0x60).u8(0).finish();
const resetMotion=(id=1)=>new BitWriter().u8(FEATURE_OP.resetMotion).i32(id).finish();
function revokedCast(threatWindowSeconds=0,respawn=false) {
 const f=fixture();
 f.c.engine.receive([{type:'stats',level:10,hp:100,maxHp:100,sp:100,maxSp:100},
  {type:'inventory',items:[{bagId:601,itemId:601,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1},
  {type:'skills',learned:[{skillId:11,level:1}]}]);
 const automation=structuredClone(DEFAULT_AUTOMATION);automation.combat.partyEngagement=true;
 automation.attackStrategies=[{id:'bolt',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
 if(threatWindowSeconds)automation.escape={...automation.escape!,enabled:true,hpEnabled:false,threatEnabled:true,threatCount:1,threatWindowSeconds,cooldownSeconds:1};
 automation.respawn={enabled:respawn,maxDeaths:1};
 f.c.receive(attack());f.c.start({...DEFAULT_SETTINGS,map,targets:[4000],automation});f.step();
 expect(actions(f)).toEqual([{type:'skill',mode:'target',skillId:11,level:1,target:2}]);
 const sequence=f.c.engine.actionResult.sequence;
 f.c.receive(observedCast());f.c.receive(new BitWriter().u8(102).u8(6).finish());
 expect(f.c.snapshot()).toMatchObject({runRequested:true,running:false,partyEngagement:{blocked:1}});
 const advance=(ms:number)=>{while(ms>0){const part=Math.min(ms,100);f.step(part);ms-=part;}};
 return {...f,advance,sequence};
}
const ambiguousShapes=[{skillId:42,level:1,target:1},{skillId:43,level:1,target:2},{skillId:43,level:3,target:2},
 {skillId:96,level:3,target:2},{skillId:96,level:5,target:2},{skillId:96,level:10,target:2}] as const;
describe('party revocation with delivered cast and threat owners',()=>{
 it('uses own walking only as availability while the revoked exact resource receipt remains fenced',()=>{
  const f=revokedCast();f.c.receive(spawn({...monster,id:8,y:101}));f.advance(35_000);
  f.c.receive(resetMotion());expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.c.receive(acceptedWalk(3));expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.c.receive(acceptedWalk());expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  for(const packet of [execution(12),execution(11,2),execution(11,1,8),execution(11,1,2,3),execution(11,1,2,1,true)]){
   f.c.receive(packet);f.advance(200);expect(actions(f)).toHaveLength(1);
   expect(f.c.engine.actionResult).toMatchObject({sequence:f.sequence,status:'failed'});
   expect(f.c.snapshot().reason).toContain('confirmed result');
  }
  expect(f.c.snapshot()).toMatchObject({runRequested:true,running:false,kills:0,deaths:0});
  expect(f.c.snapshot().elapsedSeconds).toBeGreaterThanOrEqual(36);
  f.c.receive(execution());f.advance(1200);
  expect(actions(f)).toHaveLength(2);expect(actions(f)[1]).toMatchObject({type:'skill',target:8});
  expect(f.c.snapshot().partyEngagement.blocked).toBeGreaterThanOrEqual(1);
 });
 it.each(ambiguousShapes)('keeps proc ambiguity for $skillId/$level after the revoked bolt receipt settles',shape=>{
  const f=revokedCast();f.c.receive(spawn({...monster,id:8,y:101}));
  f.c.receive(observedCast(shape.skillId,shape.level,shape.target));f.c.receive(execution(shape.skillId,shape.level,shape.target));
  f.c.receive(resetMotion());f.c.receive(new BitWriter().u8(OP.stop).i32(1).finish());f.advance(35_000);
  expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(actions(f)).toHaveLength(1);
  f.c.receive(execution());f.advance(1200);
  expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(actions(f)).toHaveLength(1);
  expect(f.c.snapshot().reason).toContain('triggered');expect(f.c.snapshot().runRequested).toBe(true);
  f.c.receive(acceptedWalk());f.advance(400);
  expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(actions(f)).toHaveLength(2);
  expect(actions(f)[1]).toMatchObject({type:'skill',target:8});
 });
 it('settles only CounterAttack availability with own ResetMotion111 while retaining the canceled bolt receipt',()=>{
  const f=revokedCast();f.c.receive(spawn({...monster,id:8,y:101}));f.c.receive(observedCast(31,1,1));
  f.c.receive(resetMotion(3));expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  f.c.receive(resetMotion());expect(f.c.engine.observedOwnCastSettled()).toBe(true);f.advance(35_000);
  expect(actions(f)).toHaveLength(1);expect(f.c.engine.actionResult).toMatchObject({sequence:f.sequence,status:'failed'});
  expect(f.c.snapshot().reason).toContain('confirmed result');
  f.c.receive(execution());f.advance(1200);expect(actions(f)).toHaveLength(2);
  expect(actions(f)[1]).toMatchObject({type:'skill',target:8});
 });
 it('holds threat escape behind the revoked receipt, then requires fresh world evidence and its captured quiet window',()=>{
  const f=revokedCast(2);expect(f.c.engine.observedThreats(2).count).toBe(0);
  f.c.receive(acceptedWalk());f.advance(35_000);f.c.receive(attack(2,1));f.advance(300);
  expect(f.c.engine.observedThreats(2).count).toBe(1);expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(0);
  f.c.receive(execution());f.advance(1500);expect(f.sent.filter(a=>a.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
  f.c.receive(Uint8Array.of(OP.clear));f.c.receive(spawn(own,false,2));
  expect(f.c.engine.observedThreats(2).count).toBe(0);expect(f.c.snapshot().partyEngagement.accepted).toBe(0);
  expect(f.c.snapshot().escape).toMatchObject({state:'confirmed',latched:true,recovery:{threatCount:1,quietSeconds:2}});
  f.advance(1500);expect(f.c.snapshot().escape.latched).toBe(true);
  f.advance(600);expect(f.c.snapshot().escape.latched).toBe(false);
  expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
  f.c.receive(attack(2,1));f.c.receive(spawn(monster));expect(f.c.engine.observedThreats(2).count).toBe(0);
 });
 it('rejects an old-world receipt after clearing party and threat lifetimes',()=>{
  const f=revokedCast(60);f.c.receive(attack(2,1));expect(f.c.engine.observedThreats(60).count).toBe(1);
  f.c.receive(Uint8Array.of(OP.clear));f.c.receive(spawn(own,false,2));f.c.receive(spawn(monster));
  expect(f.c.engine.observedThreats(60).count).toBe(0);expect(f.c.snapshot().partyEngagement).toMatchObject({accepted:0,blocked:0});
  f.c.receive(execution());f.c.receive(attack(2,1));f.advance(35_000);
  expect(f.c.engine.observedThreats(60).count).toBe(1);expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(0);
  expect(actions(f)).toHaveLength(1);expect(f.c.snapshot().reason).toContain('confirmed result');
 });
 it('cancels unsent threat preparation on own death after the revoked receipt settles and spends at most one respawn',()=>{
  const f=revokedCast(60,true);f.advance(35_000);f.c.receive(attack(2,1));f.c.receive(execution());
  for(let i=0;i<20&&f.c.snapshot().escape.state!=='preparing';i++)f.advance(100);
  expect(f.c.snapshot().escape).toMatchObject({state:'preparing',pending:true,latched:false});
  f.c.receive(observedCast(42,1,1));f.c.receive(new BitWriter().u8(OP.death).i32(3).finish());
  expect(f.c.snapshot().escape.pending).toBe(true);
  f.c.receive(new BitWriter().u8(OP.death).i32(1).finish());f.advance(35_000);f.c.receive(execution());
  expect(f.c.snapshot().escape).toMatchObject({state:'idle',pending:false,latched:false});
  expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(0);expect(f.sent.filter(a=>a.type==='respawn')).toEqual([{type:'respawn'}]);
  expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:0});expect(actions(f)).toHaveLength(1);
 });
});

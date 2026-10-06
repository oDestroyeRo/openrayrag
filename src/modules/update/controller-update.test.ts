import { describe, expect, it } from 'vitest';
import { CompanionController, type ControllerAction } from '../runtime/controller';
import { validateControllerUpdateCheckpoint } from './controller-update';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Settings } from '../settings/settings';
import type { Action } from '../automation/engine';
import { BitWriter } from '../../shared/binary';
import { OP, type Entity } from '../protocol/protocol';
import { FEATURE_OP } from '../protocol/protocol-feature';
import type { MacroScript } from '../automation/macros';
import { DEFAULT_SUPPLY } from '../services/supply-trip';

const own:Entity={id:1,classId:0,name:'Test',kind:0,level:7,hp:100,maxHp:100,sp:100,maxSp:100,x:100,y:100,dead:false};
const monster:Entity={...own,id:2,classId:4000,name:'Poring',kind:1,x:101,hp:10,maxHp:10};
function spawn(entity:Entity,entry=1):Uint8Array {
  const name=new TextEncoder().encode(entity.name),body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0)
    .i32(~name.length).i32(entity.name.length).take(name).u8(entity.kind).u8(0).u8(0).i32(entity.x).i32(entity.y).u8(entity.level)
    .i32(entity.hp).i32(entity.maxHp).i32(entity.sp??0).i32(entity.maxSp??0).i32(0).u8(0).finish();
  return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body).finish();
}
function fixture(name='Test',at=100_000) {
  let now=at;const sent:Array<Action|ControllerAction>=[];
  const c=new CompanionController(action=>sent.push(action),()=>now,()=>({width:200,height:200,walkable:()=>true}));
  c.connect(true);c.receive(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish());c.receive(spawn({...own,name}));
  c.engine.receive([{type:'inventory',items:[{bagId:501,itemId:501,type:1,count:3},{bagId:505,itemId:505,type:1,count:3}],equipment:Array(10).fill(0),ammoId:-1}]);
  const settings:Settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],route_randomWalk:0};
  const step=(ms=100)=>{now+=ms;c.tick();};
  const debit=(id=501)=>c.receive(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(id).i16(1).i32(0).bool(false).finish());
  return {c,sent,settings,step,debit,time:()=>now};
}
const script:MacroScript={version:1,name:'Ordered resources',durationSeconds:60,maxActions:2,maxSpend:0,
  rules:[{name:'Once',priority:0,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:1}],steps:[
    {type:'useItem',itemId:501,timeoutSeconds:20},{type:'useItem',itemId:505,timeoutSeconds:20}]}]};

describe('safe update controller boundary',()=>{
  it('suspends decisions while retaining intent and resumes the same run after cancellation',()=>{
    const f=fixture();f.c.start(f.settings);f.c.engine.deaths=1;
    f.c.prepareUpdate();const checkpoint=f.c.updateCheckpoint()!;
    expect(checkpoint.status).toMatchObject({runRequested:true,running:false,state:'waiting',deaths:1});
    expect(checkpoint.run).toMatchObject({startedAt:100_000,deaths:1});
    expect(()=>f.c.start(f.settings)).toThrow(/update/);expect(()=>f.c.perform('command',{type:'useItem',itemId:501})).toThrow(/update/);
    f.step(1000);expect(f.sent).toEqual([]);f.c.cancelUpdate();f.step();
    expect(f.c.snapshot()).toMatchObject({runRequested:true,running:true,deaths:1,elapsedSeconds:1});
  });
  it('captures late combat counters only after the admitted attack settles',()=>{
    const f=fixture();f.c.receive(spawn(monster,0));f.c.start(f.settings);f.step();
    expect(f.sent).toContainEqual({type:'attack',id:2});f.c.prepareUpdate();expect(f.c.updateCheckpoint()).toBeNull();
    f.step(1000);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
    f.c.receive(new BitWriter().u8(OP.death).i32(2).finish());f.step();
    const checkpoint=f.c.updateCheckpoint()!;expect(checkpoint.status.kills).toBe(1);expect(checkpoint.run?.kills).toBe(1);
  });
  it('does not turn a timed-out pending attack into update settlement',()=>{
    const f=fixture();f.c.receive(spawn(monster,0));f.c.start(f.settings);f.step();f.c.prepareUpdate();
    for(let i=0;i<13;i++){f.c.receive(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish());f.step(1000);}
    expect(f.c.updateCheckpoint()).toBeNull();expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('retains a suspended attack receipt through HP Stop and credits its later fatal hit/death',()=>{
    const f=fixture();f.c.receive(spawn(monster,0));f.c.start(f.settings);f.step();f.c.prepareUpdate();
    f.c.engine.receive([{type:'heal',id:1,hp:20,maxHp:100}]);f.step();expect(f.c.updateCheckpoint()).toBeNull();
    f.c.receive(new BitWriter().u8(OP.hit).i32(2).i32(10).position(monster).u8(0).finish());
    f.c.receive(new BitWriter().u8(OP.death).i32(2).finish());f.step();
    expect(f.c.updateCheckpoint()?.status.kills).toBe(1);
  });
  it('refuses a replacement monster lifetime as the suspended attack receipt',()=>{
    const f=fixture();f.c.receive(spawn(monster,0));f.c.start(f.settings);f.step();f.c.prepareUpdate();
    f.c.receive(spawn({...monster,name:'Replacement'},0));f.c.receive(new BitWriter().u8(OP.death).i32(2).finish());f.step();
    expect(f.c.engine.kills).toBe(0);expect(f.c.updateCheckpoint()).toBeNull();
  });
  it('captures a late pickup confirmation after suspension without another pickup',()=>{
    const f=fixture(),automation=structuredClone(DEFAULT_AUTOMATION);automation.loot.ownership='all';automation.loot.defaultAction='pickup';
    f.c.engine.receive([{type:'drop',drop:{id:40,itemId:501,count:1,x:101,y:100,isNew:true}}]);
    f.c.start({...f.settings,automation});f.step();expect(f.sent).toContainEqual({type:'pickup',id:40});
    f.c.prepareUpdate();expect(f.c.updateCheckpoint()).toBeNull();
    f.c.receive(new BitWriter().u8(OP.pickup).i32(1).i32(40).finish());f.step();
    expect(f.c.updateCheckpoint()?.run?.pickups).toBe(1);expect(f.sent.filter(a=>a.type==='pickup')).toHaveLength(1);
  });
  it('Stop revokes suspension and requested intent',()=>{
    const f=fixture();f.c.start(f.settings);f.c.prepareUpdate();f.c.stop();f.step();
    expect(f.c.preparingUpdate).toBe(false);expect(f.c.runRequested).toBe(false);expect(f.c.updateCheckpoint()).toBeNull();
  });
  it('waits for a macro resource receipt and restores the next logical step without replay',()=>{
    const f=fixture();f.c.perform('macro',{settings:f.settings,script});expect(f.sent).toEqual([{type:'useItem',itemId:501}]);
    f.c.prepareUpdate();expect(f.c.updateCheckpoint()).toBeNull();f.debit();f.step();
    const checkpoint=f.c.updateCheckpoint()!;expect(checkpoint.macro).toMatchObject({actionsCompleted:1,actionsIssued:1,sequence:{stepIndex:1}});
    f.step();expect(f.sent).toHaveLength(1);
    const next=fixture('Test',101_000);next.c.restoreUpdate(checkpoint);expect(next.sent).toEqual([]);next.step();
    expect(next.sent).toEqual([{type:'useItem',itemId:505}]);expect(next.c.snapshot().macro.actionsIssued).toBe(2);
  });
  it('failed macro outcomes remain fenced and no command repeats',()=>{
    const f=fixture();f.c.perform('macro',{settings:f.settings,script});f.c.prepareUpdate();
    for(let i=0;i<25;i++){f.c.receive(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish());f.step(1000);}
    expect(f.c.updateCheckpoint()).toBeNull();expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
    f.c.cancelUpdate();f.step();expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
  });
  it('requires a fresh compatible same-character entry and preserves original limits when no projection is supplied',()=>{
    const f=fixture(),automation=structuredClone(DEFAULT_AUTOMATION);automation.limits.minutes=1;
    f.c.start({...f.settings,automation});f.step(2000);f.c.prepareUpdate();const checkpoint=f.c.updateCheckpoint()!;
    const wrong=fixture('Other',104_000);expect(()=>wrong.c.restoreUpdate(checkpoint)).toThrow(/same character/);expect(wrong.c.active).toBe(false);
    const next=fixture('Test',159_900);next.c.restoreUpdate(checkpoint);next.step(100);
    expect(next.c.snapshot()).toMatchObject({runRequested:true,running:false,elapsedSeconds:60});expect(next.sent).toEqual([]);
    expect(()=>validateControllerUpdateCheckpoint({...checkpoint,frozenAt:200_000},159_900)).toThrow();
  });
  it('uses rebased death allowances once and restores follow without renewing rendezvous',()=>{
    const f=fixture();f.c.start(f.settings);f.c.engine.deaths=1;f.c.prepareUpdate();const checkpoint=f.c.updateCheckpoint()!;
    const next=fixture('Test',101_000),automation=structuredClone(DEFAULT_AUTOMATION);automation.respawn={enabled:true,maxDeaths:1};
    automation.follow={...automation.follow,mode:'partyLeader',rendezvous:true};
    next.c.restoreUpdate(checkpoint,{...f.settings,automation});
    expect(next.c.engine.deaths).toBe(0);expect(next.c.partyFollow.enabled).toBe(true);
    expect(Reflect.get(next.c.partyFollow,'settings').automation.follow.rendezvous).toBe(false);
  });
  it('preserves macro-only supply/escape/death guards and decays frozen relative cooldowns',()=>{
    const f=fixture(),automation=structuredClone(DEFAULT_AUTOMATION);automation.supply={...DEFAULT_SUPPLY,enabled:true};
    f.c.perform('macro',{settings:{...f.settings,automation},script});f.c.prepareUpdate();f.debit();f.step();const checkpoint=f.c.updateCheckpoint()!;
    checkpoint.status.supplyGuard={version:1,character:'Test',latched:false,remainingTrips:0,actions:2,spent:0,reserved:0,intervalSeconds:10,deadlineSeconds:0,interrupted:false,uncertain:false,returnDestination:null};
    checkpoint.status.escape={state:'canceled',reason:'Captured cooldown',pending:false,consumed:false,cooldownSeconds:10,latched:true,recovery:{hpPercent:100,threatCount:0,quietSeconds:0}};
    checkpoint.status.deathRecoveryGuard={version:1,character:'Test',destination:'prt_fild08',phase:'failed',uncertain:false,recoverySeconds:0,returnSeconds:0,recoveryDeadline:0,returnDeadline:0};
    const next=fixture('Test',checkpoint.frozenAt+5000);next.c.restoreUpdate(checkpoint);
    expect(next.c.snapshot().supplyGuard).toMatchObject({remainingTrips:0,actions:2,intervalSeconds:5});
    expect(next.c.snapshot().escape).toMatchObject({latched:true,cooldownSeconds:5});
    expect(next.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',character:'Test'});
  });
  it('rejects invalid timestamps and ownership before changing current allowances',()=>{
    const f=fixture();f.c.perform('macro',{settings:f.settings,script});f.c.prepareUpdate();f.debit();f.step();const checkpoint=f.c.updateCheckpoint()!;
    const next=fixture('Test',101_000),before=next.c.snapshot();
    expect(()=>next.c.restoreUpdate({...checkpoint,run:{...checkpoint.run!,startedAt:checkpoint.frozenAt+1}})).toThrow(/allowance/);
    expect(()=>next.c.restoreUpdate({...checkpoint,macro:{...checkpoint.macro!,lastTime:checkpoint.frozenAt+1}})).toThrow();
    expect(next.c.snapshot()).toEqual(before);expect(next.c.macro.active).toBe(false);expect(next.sent).toEqual([]);
  });
});

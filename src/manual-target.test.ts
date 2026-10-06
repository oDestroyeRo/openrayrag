import { validateFormSettings } from './settings';
import { describe, expect, it } from 'vitest';
import { BotEngine, type Action } from './engine';
import { CompanionController } from './controller';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { manualTargetPolicy, validateManualTargetRequest, type ManualTargetRequest } from './manual-target';
import { command, decode, OP, type Entity, type GameEvent, type Position } from './protocol';
import { BitWriter } from './binary';
import { FEATURE_OP } from './protocol-feature';
import { WORLD_OP } from './world-protocol';
import type { WalkGrid } from './navigation';
import cases from './data/manual-target-cases.json';
import { validControllerAction } from './controller';
import { validateRoutineSpec } from './routines';

const p:Entity={id:1,classId:0,name:'Self',kind:0,level:10,hp:100,maxHp:100,x:100,y:100,dead:false};
const enemy:Entity={id:2,classId:4000,name:'Poring',kind:1,level:1,hp:20,maxHp:20,x:104,y:100,dead:false};
const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[],automation:structuredClone(DEFAULT_AUTOMATION)};
function setup(grid:WalkGrid={width:200,height:200,walkable:()=>true}) {
  let now=100000;const sent:Action[]=[];const engine=new BotEngine(a=>sent.push(a),()=>now,()=>grid);
  engine.connect(true);engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...p}},{type:'spawn',entity:{...enemy}},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1}]);
  const request=(kind:'walk'|'attack'='attack'):ManualTargetRequest=>({type:'manualTarget',map:engine.map,owner:engine.manualActorIdentity(1)!,command:kind==='walk'?{type:'walk',destination:{x:104,y:100}}:{type:'attack',target:engine.manualActorIdentity(2)!},timeoutSeconds:30,policy:manualTargetPolicy(settings)});
  const step=(ms=100)=>{now+=ms;engine.tick();};
  const ack=(cells:Position[],seconds=.1,locked=false)=>engine.receive([{type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:seconds,firstSeconds:seconds,locked}}]);
  return {engine,sent,request,step,ack,receive:(events:GameEvent[])=>engine.receive(events),time:()=>now};
}
describe('bounded manual target owner',()=>{
  it('admits observed monster class zero without making it a configured species selection',()=>{
    const f=setup();f.receive([{type:'spawn',entity:{...enemy,classId:0}}]);
    const request=f.request();expect(f.engine.previewManual(request).length).toBeGreaterThan(1);
    expect(()=>f.engine.startManual(request)).not.toThrow();expect(f.engine.settings.targets).toEqual([0]);
    f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);
    expect(()=>validateFormSettings({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[0]})).toThrow('Invalid settings');
    expect(settings.targets).toEqual([]);
  });
  it('accepts default selected combat with no species selected without changing saved settings',()=>{
    const f=setup(),request=f.request('walk');expect(settings.targets).toEqual([]);f.engine.startManual(request);f.step();
    expect(f.sent[0]?.type).toBe('walk');expect(f.engine.running).toBe(false);expect(f.engine.runIntent).toBe(false);expect(settings.targets).toEqual([]);
  });
  it('keeps normal autoattack owned after its first animation, with no skill/loot/replacement sends',()=>{
    const f=setup();f.engine.startManual(f.request());f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);
    f.engine.receive([{type:'attack',source:1,target:2,position:{x:103,y:100}},{type:'spawn',entity:{...enemy,id:3,x:104}},{type:'drop',drop:{id:7,itemId:501,count:1,x:103,y:100,isNew:true}}]);
    f.step(1000);expect(f.engine.manualTargetActive).toBe(true);expect(f.engine.snapshot().manualTarget.state).toBe('attacking');expect(f.sent).toHaveLength(1);
    f.engine.receive([{type:'death',id:2}]);expect(f.engine.snapshot().manualTarget.state).toBe('complete');expect(f.sent.at(-1)).toEqual({type:'stop'});expect(f.engine.idleForActions()).toBe(false);
    f.engine.receive([{type:'changeTarget',id:0}]);f.step();expect(f.engine.idleForActions()).toBe(true);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('completes segmented walking only after accepted movement and arrival',()=>{
    const f=setup();const r=f.request('walk');r.policy.routeStep=2;f.engine.startManual(r);f.step();
    expect(f.sent).toEqual([{type:'walk',destination:{x:102,y:100}}]);const first=f.engine.snapshot().navigation!.leg;f.ack(first);f.step(350);
    expect(f.sent.at(-1)).toEqual({type:'walk',destination:{x:104,y:100}});expect(f.engine.manualTargetActive).toBe(true);
    const second=f.engine.snapshot().navigation!.leg;f.ack(second);f.step(350);expect(f.engine.snapshot().manualTarget.state).toBe('complete');expect(f.engine.player).toMatchObject({x:104,y:100});expect(f.engine.idleForActions()).toBe(true);
  });
  it('never retries an unconfirmed walking leg and retains it beyond its deadline',()=>{
    const f=setup();f.engine.startManual(f.request('walk'));f.step();const cells=f.engine.snapshot().navigation!.leg;f.step(4100);
    expect(f.engine.snapshot().manualTarget.state).toBe('failed');expect(f.sent.map(a=>a.type)).toEqual(['walk','stop']);f.step(4100);expect(f.engine.idleForActions()).toBe(false);
    expect(()=>f.engine.startManual(f.request('walk'))).toThrow();expect(()=>f.engine.start({...settings,targets:[4000]})).toThrow();expect(()=>f.engine.manualAction({type:'sit',sitting:false})).toThrow();
    f.engine.receive([{type:'attack',source:1,target:2,position:{x:100,y:100}}]);expect(f.engine.idleForActions()).toBe(false);
    f.ack(cells.slice(0,2),2);f.step(1900);expect(f.engine.idleForActions()).toBe(false);f.step(200);expect(f.engine.idleForActions()).toBe(true);expect(f.sent.map(a=>a.type)).toEqual(['walk','stop']);
  });
  it('holds canceled accepted shortened motion and exposes a terminal result',()=>{
    const f=setup();f.engine.startManual(f.request('walk'));f.step();const cells=f.engine.snapshot().navigation!.leg;f.engine.stop();f.ack(cells.slice(0,2),2);
    expect(f.engine.snapshot().manualTarget).toMatchObject({state:'cancelled',settling:true});f.step(1900);expect(f.engine.idleForActions()).toBe(false);f.step(200);expect(f.engine.idleForActions()).toBe(true);
  });
  it('holds attack cancellation until target-clear, rather than attack/Stop timing',()=>{
    const f=setup();f.engine.startManual(f.request());f.step();f.engine.receive([{type:'attack',source:1,target:2,position:{x:103,y:100}}]);f.engine.stop();f.step(5000);
    expect(f.engine.idleForActions()).toBe(false);f.engine.receive([{type:'stop',id:1}]);expect(f.engine.idleForActions()).toBe(false);
    f.engine.receive([{type:'changeTarget',id:0}]);expect(f.engine.idleForActions()).toBe(true);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('never resets the whole engagement deadline from repeated attack animations',()=>{
    const f=setup(),r=f.request();r.timeoutSeconds=2;f.engine.startManual(r);f.step();
    for(let i=0;i<2;i++){f.engine.receive([{type:'attack',source:1,target:2,position:{x:103,y:100}}]);f.step(1000);}
    expect(f.engine.snapshot().manualTarget.state).toBe('failed');expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);
  });
  it('uses collision fallback and keeps one unacknowledged owner',()=>{
    const f=setup({width:200,height:200,walkable:q=>q.x!==102||q.y!==100});f.engine.startManual(f.request());f.step();expect(f.sent[0]?.type).toBe('walk');f.step();expect(f.sent).toHaveLength(1);
    expect(f.engine.snapshot().navigation!.leg.every(q=>q.x!==102||q.y!==100)).toBe(true);
  });
  it.each(['wrongWorld','wrongLifetime','wrongOwner','absent','dead','player','npc','level','foreign','ignore','unknownEquipment'])('rejects %s before any send',variant=>{
    const f=setup(),r=f.request();if(r.command.type!=='attack')throw new Error('fixture');
    if(variant==='wrongWorld')r.command.target.world='00000000-0000-0000-0000-000000000000';
    if(variant==='wrongLifetime')r.command.target.incarnation++;
    if(variant==='wrongOwner')r.owner.incarnation++;
    if(variant==='absent')f.engine.entities.delete(2);
    if(variant==='dead')f.engine.entities.get(2)!.dead=true;
    if(variant==='player')f.engine.entities.get(2)!.kind=0;
    if(variant==='npc')f.engine.entities.get(2)!.kind=2;
    if(variant==='level')f.engine.entities.get(2)!.level=99;
    if(variant==='foreign')f.engine.receive([{type:'attack',source:9,target:2,position:{x:100,y:100}}]);
    if(variant==='ignore')r.policy.monsterRules=[{classId:4000,action:'ignore',priority:0}];
    if(variant==='unknownEquipment')f.engine.character.inventoryKnown=false;
    expect(()=>f.engine.startManual(r)).toThrow();expect(f.sent).toEqual([]);
  });
  it('keeps conditional unknown/false attack rules and true ignore rules closed',()=>{
    const f=setup(),r=f.request();r.policy.monsterRules=[{classId:4000,action:'attack',priority:0,conditions:[{field:'actorCasting',actor:{scope:'candidate'},operator:'eq',value:true}]}];expect(()=>f.engine.startManual(r)).toThrow();
  });
  it('binds a lifetime and never reacquires a respawned ID',()=>{
    const f=setup();f.engine.startManual(f.request());f.step();f.engine.receive([{type:'spawn',entity:{...enemy}}]);f.step();expect(f.engine.snapshot().manualTarget.state).toBe('failed');expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('uses fresh area policy rather than prior Start settings, including adjacent targets',()=>{
    const f=setup(),r=f.request();r.policy.mapPolicy={...DEFAULT_MAP_POLICY,lockArea:{map:'prt_fild08',minX:100,minY:100,maxX:103,maxY:103}};expect(()=>f.engine.startManual(r)).toThrow('outside');
    const walk=f.request('walk');walk.policy.mapPolicy=r.policy.mapPolicy;expect(()=>f.engine.startManual(walk)).toThrow('outside');
  });
  it.each(['removed','outside','unreachable','hp','map','clear','disconnect','stale','sleep'])('terminates on %s without acquiring another target',variant=>{
    const f=setup();f.engine.startManual(f.request());f.step();
    if(variant==='removed')f.engine.receive([{type:'remove',id:2,dead:false}]);
    if(variant==='outside'){f.engine.entities.get(2)!.x=250;f.step();}
    if(variant==='unreachable'){f.engine.entities.get(2)!.x=199;f.step();}
    if(variant==='hp'){f.engine.player!.hp=1;f.step();}
    if(variant==='map')f.engine.receive([{type:'map',map:'prontera'}]);
    if(variant==='clear')f.engine.receive([{type:'clear'}]);
    if(variant==='disconnect')f.engine.disconnect();
    if(variant==='stale'){for(let i=0;i<16;i++)f.step(1000);}
    if(variant==='sleep')f.step(6000);
    expect(f.engine.manualTargetActive).toBe(false);expect(f.engine.runIntent).toBe(false);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('rejects corner-cutting and portal approaches without sending',()=>{
    for(const grid of [{width:200,height:200,walkable:(q:Position)=>q.x===100&&q.y===100||q.x===101&&q.y===101},{width:200,height:200,walkable:()=>true,portals:[{x:104,y:100,halfWidth:0,halfHeight:0}]}] as WalkGrid[]){const f=setup(grid),r=f.request('walk');r.command={type:'walk',destination:{x:101,y:101}};if('portals'in grid)r.command.destination={x:104,y:100};expect(()=>f.engine.startManual(r)).toThrow();expect(f.sent).toEqual([]);}
  });
  it('rejects stale or conflicting admission',()=>{
    const f=setup();f.step(16000);expect(()=>f.engine.startManual(f.request())).toThrow('fresh');f.engine.receive([]);f.engine.start({...settings,targets:[4000]});expect(()=>f.engine.startManual(f.request())).toThrow();
  });
  it('reconciles known same-character manual walking and drops task intent on reconnect',()=>{
    const f=setup();f.engine.startManual(f.request('walk'));f.step();f.engine.stop();f.engine.receive([{type:'stop',id:1}]);expect(f.engine.idleForActions()).toBe(true);
    f.engine.disconnect();f.engine.connect(true);f.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...p}}]);f.step();expect(f.engine.manualTargetActive).toBe(false);expect(f.engine.runIntent).toBe(false);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);
  });
  it('rejects malformed command keys, IDs, destinations and deadline bounds',()=>{
    const f=setup(),r=f.request('walk');
    for(const invalid of [{...r,extra:'x'},{...r,map:'unknown'},{...r,timeoutSeconds:0},{...r,timeoutSeconds:121},{...r,owner:{...r.owner,id:-1}},{...r,owner:{...r.owner,incarnation:0}},{...r,command:{type:'walk',destination:{x:0.5,y:0}}},{...r,command:{type:'walk',destination:{x:400,y:0}}},{...r,command:{type:'walk',destination:{x:0,y:0},target:r.owner}},{...r,policy:{...r.policy,minAmmoStock:-1}}])expect(()=>validateManualTargetRequest(invalid)).toThrow();
  });
});

describe('strict command-only manual schema',()=>{
  it.each(cases)('$name',({valid,request})=>{
    if(valid)expect(validateManualTargetRequest(request)).toEqual(request);
    else expect(()=>validateManualTargetRequest(request)).toThrow();
    expect(validControllerAction(request)).toBe(false);
    expect(()=>validateRoutineSpec({name:'Forbidden',durationSeconds:20,maxActions:1,rules:[{name:'Act',priority:0,maxRuns:1,cooldownSeconds:0,conditions:[],action:request}]},validControllerAction)).toThrow();
  });
});

describe('manual ranged attack and cancellation receipts',()=>{
  const equipBow=(f:ReturnType<typeof setup>,count=20,ammoId=1750)=>{
    f.engine.receive([{type:'inventory',items:[{bagId:77,itemId:1701,count:1,type:1},{bagId:ammoId,itemId:ammoId,count,type:1}],equipment:[0,0,0,0,77,0,0,0,0,0],ammoId},{type:'skills',learned:[{skillId:29,level:5}]}]);
  };
  it('attacks stationary at verified bow range across a snipable barrier',()=>{
    const f=setup({width:200,height:200,walkable:q=>q.x!==102,seeThrough:()=>true});equipBow(f);f.engine.startManual(f.request());f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);
  });
  it('keeps blocked projectile sight on a collision-safe approach, never a direct click',()=>{
    const f=setup({width:200,height:200,walkable:q=>q.x!==102||q.y>105,seeThrough:q=>q.x!==102});equipBow(f);f.engine.startManual(f.request());f.step();expect(f.sent[0]?.type).toBe('walk');
  });
  it.each([0,3])('rejects observed arrow stock %s at a three-arrow reserve',count=>{
    const f=setup();equipBow(f,count);const r=f.request();r.policy.minAmmoStock=3;expect(()=>f.engine.startManual(r)).toThrow('reserve');expect(f.sent).toEqual([]);
  });
  it('rejects incompatible equipped ammunition without switching',()=>{
    const f=setup();equipBow(f,20,13200);expect(()=>f.engine.startManual(f.request())).toThrow('arrows');expect(f.sent).toEqual([]);
  });
  it('sends Stop promptly at an authoritative reserve and never equips/re-Attacks',()=>{
    const f=setup();equipBow(f,4);const r=f.request();r.policy.minAmmoStock=3;f.engine.startManual(r);f.step();
    f.engine.receive([{type:'attack',source:1,target:2,position:{x:100,y:100}},{type:'inventoryDelta',add:false,bagId:1750,change:1,weight:0}]);f.step();
    expect(f.engine.manualTargetActive).toBe(false);expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);expect(f.engine.idleForActions()).toBe(false);
    f.engine.receive([{type:'changeTarget',id:0}]);f.step();expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);
  });
  it.each([2,3,4])('ends on source-shaped ammo event %s and retains Stop uncertainty',event=>{
    const f=setup();equipBow(f);f.engine.startManual(f.request());f.step();f.engine.receive([{type:'serverEvent',event,value:0,text:''}]);f.step();
    expect(f.engine.manualTargetActive).toBe(false);expect(f.engine.snapshot().manualTarget.settling).toBe(true);expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);
  });
  it('does not release an unaccepted attack on earlier clear and sends only one Stop after late acceptance',()=>{
    const f=setup();f.engine.startManual(f.request());f.step();f.engine.stop();f.engine.receive([{type:'changeTarget',id:0}]);
    expect(f.engine.idleForActions()).toBe(false);f.engine.receive([{type:'attack',source:1,target:2,position:{x:103,y:100}}]);
    expect(f.sent.map(a=>a.type)).toEqual(['attack','stop','stop']);f.engine.receive([{type:'attack',source:1,target:2,position:{x:103,y:100}}]);expect(f.sent).toHaveLength(3);expect(f.engine.idleForActions()).toBe(false);
    f.engine.receive([{type:'changeTarget',id:0}]);expect(f.engine.idleForActions()).toBe(true);expect(f.engine.snapshot().manualTarget.state).toBe('cancelled');
  });
  it('keeps unaccepted attack uncertainty through death and external revival',()=>{
    const f=setup();f.engine.startManual(f.request());f.step();f.engine.receive([{type:'death',id:1},{type:'changeTarget',id:0},{type:'resurrection',id:1,hp:100,position:{x:100,y:100}}]);f.step(1000);
    expect(f.engine.idleForActions()).toBe(false);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
    f.engine.receive([{type:'attack',source:1,target:2,position:{x:103,y:100}},{type:'changeTarget',id:0}]);expect(f.engine.idleForActions()).toBe(false);expect(f.engine.runIntent).toBe(false);
    f.engine.disconnect();f.engine.connect(true);expect(f.engine.idleForActions()).toBe(true);
  });
  it('never treats a new target incarnation as acceptance of the canceled old request',()=>{
    const f=setup();f.engine.startManual(f.request());f.step();f.engine.stop();f.engine.receive([{type:'spawn',entity:{...enemy}},{type:'attack',source:1,target:2,position:{x:103,y:100}},{type:'changeTarget',id:0}]);
    expect(f.engine.idleForActions()).toBe(false);expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);
  });
  it('does not let a stale Attack packet erase accepted canceled Walk motion',()=>{
    const f=setup();f.engine.startManual(f.request('walk'));f.step();const cells=f.engine.snapshot().navigation!.leg;f.engine.stop();f.ack(cells.slice(0,2),2);
    f.engine.receive([{type:'attack',source:1,target:2,position:{x:199,y:199}}]);f.step(1000);expect(f.engine.idleForActions()).toBe(false);expect(f.engine.player!.x).toBeLessThan(110);
    f.step(1100);expect(f.engine.idleForActions()).toBe(true);
  });
});

describe('controller manual task exclusivity',()=>{
  function controllerFixture(){let now=100000;const sent:Action[]=[];const c=new CompanionController(a=>sent.push(a as Action),()=>now,()=>({width:200,height:200,walkable:()=>true}));c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...p}},{type:'spawn',entity:{...enemy}},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1}]);const request=():ManualTargetRequest=>({type:'manualTarget',map:'prt_fild08',owner:c.engine.manualActorIdentity(1)!,command:{type:'walk',destination:{x:104,y:100}},timeoutSeconds:30,policy:manualTargetPolicy(settings)});return {c,sent,request,step:(ms=100)=>{now+=ms;c.tick();}};}
  it('is command-only, nonpersistent, and prevents all competing owners',()=>{
    const f=controllerFixture();f.c.perform('command',f.request());f.step();expect(f.c.engine.running).toBe(false);expect(f.c.runRequested).toBe(false);expect(f.c.active).toBe(true);
    for(const mode of ['command','workflow','routine','service','social'] as const)expect(()=>f.c.perform(mode,{type:'sit',sitting:false})).toThrow();expect(()=>f.c.start({...settings,targets:[4000]})).toThrow();
  });
  it('blocks field Start and other commands before and after the retired leg deadline',()=>{
    const f=controllerFixture();f.c.perform('command',f.request());f.step();f.c.stop();f.step(4500);expect(()=>f.c.start({...settings,targets:[4000]})).toThrow();expect(f.c.runRequested).toBe(false);expect(()=>f.c.perform('command',{type:'sit',sitting:false})).toThrow();
  });
  it('an actual official command cancels rather than resuming the manual command',()=>{
    const f=controllerFixture();f.c.perform('command',f.request());f.step();f.c.manualCommand();for(let i=0;i<4;i++)f.step(1000);expect(f.c.runRequested).toBe(false);expect(f.c.engine.manualTargetActive).toBe(false);expect(f.sent.map(a=>a.type)).toEqual(['walk','stop']);
  });
  it('panel input yields new legs while preserving accepted manual movement and the command deadline',()=>{
    const f=controllerFixture(),request=f.request();request.policy.routeStep=2;
    f.c.perform('command',request);f.step();const cells=f.c.engine.snapshot().navigation!.leg;
    f.c.manualInput();f.c.engine.receive([{type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:.1,firstSeconds:.1,locked:false}}]);
    f.step(500);f.step(1000);expect(f.sent).toEqual([{type:'walk',destination:{x:102,y:100}}]);expect(f.c.engine.manualTargetActive).toBe(true);expect(f.c.runRequested).toBe(false);
    f.step(600);expect(f.sent.at(-1)).toEqual({type:'walk',destination:{x:104,y:100}});expect(f.c.engine.snapshot().manualTarget.elapsedSeconds).toBeGreaterThan(2);
  });
  it('never postpones an admitted manual deadline through repeated panel input',()=>{
    const f=controllerFixture(),request=f.request();request.timeoutSeconds=1;
    f.c.perform('command',request);f.c.manualInput();f.step(900);expect(f.sent).toEqual([]);
    f.c.manualInput();f.step(200);expect(f.c.engine.snapshot().manualTarget).toMatchObject({state:'failed',active:false});expect(f.sent).toEqual([{type:'stop'}]);expect(f.c.runRequested).toBe(false);
  });
  it('heartbeat and disconnect terminate without installing reconnect intent',()=>{
    const f=controllerFixture();f.c.perform('command',f.request());f.step();f.c.heartbeat(false);expect(f.c.engine.manualTargetActive).toBe(false);f.c.disconnect();f.c.connect(true);f.step();expect(f.c.runRequested).toBe(false);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);
  });
});

describe('combined actor-zero manual wire ownership',()=>{
  function spawn(actor:Entity):Uint8Array {
    const name=new TextEncoder().encode(actor.name);const body=new BitWriter().u8(15).i32(actor.id).i32(actor.classId).i32(0).i32(~name.length).i32(actor.name.length).take(name).u8(actor.kind).u8(0).u8(actor.dead?3:0).i32(actor.x).i32(actor.y).u8(actor.level).i32(actor.hp).i32(actor.maxHp).i32(0).i32(0).i32(0).u8(0).finish();return new BitWriter().u8(OP.spawn).u8(0).i32(body.length).take(body).finish();
  }
  function wire(ownId:number,targetId:number){let now=100000;const sent:Action[]=[];const c=new CompanionController(a=>sent.push(a as Action),()=>now,()=>({width:200,height:200,walkable:()=>true}));c.connect(true);c.receive(new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());c.receive(spawn({...p,id:ownId}));c.receive(spawn({...enemy,id:targetId}));c.engine.receive([{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1}]);const request=():ManualTargetRequest=>({type:'manualTarget',map:'prt_fild08',owner:c.engine.manualActorIdentity(ownId)!,command:{type:'attack',target:c.engine.manualActorIdentity(targetId)!},timeoutSeconds:30,policy:manualTargetPolicy(settings)});const packet=(w:BitWriter)=>c.receive(w.finish());return {c,sent,request,packet,step:(ms=100)=>{now+=ms;c.tick();}};}
  it.each([[0,2],[1,0]])('retains bounded normal attack with own %s / monster %s', (self,target)=>{
    const f=wire(self,target);f.c.perform('command',f.request());f.step();expect(f.sent).toEqual([{type:'attack',id:target}]);expect(command('attack',target)[0]).toBe(11);
    f.packet(new BitWriter().u8(OP.attack).i32(self).i32(target).i32(0).position({x:103,y:100}));expect(f.c.engine.snapshot().manualTarget.state).toBe('attacking');expect(f.c.engine.manualTargetActive).toBe(true);
    f.packet(new BitWriter().u8(OP.death).i32(target));expect(f.c.engine.snapshot().manualTarget.state).toBe('complete');expect(f.sent.at(-1)).toEqual({type:'stop'});f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));expect(f.c.engine.idleForActions()).toBe(true);expect(f.c.runRequested).toBe(false);
  });
  it.each([[0,2],[1,0]])('fails own %s old monster %s command before a revived lifetime dies', (self,target)=>{
    const f=wire(self,target),request=f.request();f.c.perform('command',request);f.step();
    f.packet(new BitWriter().u8(OP.attack).i32(self).i32(target).i32(0).position({x:103,y:100}));
    const revival=decode(new BitWriter().u8(OP.resurrection).i32(target).position({x:104,y:100}).i32(20).finish());
    const death=decode(new BitWriter().u8(OP.death).i32(target).finish());
    // Source-ordered receipts reach the engine before another decision tick.
    f.c.engine.receive([...revival,...death]);f.step();
    expect(f.c.engine.snapshot().manualTarget).toMatchObject({state:'failed',active:false});
    expect(f.c.engine.kills).toBe(0);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);expect(f.c.runRequested).toBe(false);
  });
  it.each([0,1])('does not turn own %s manual death into configured automatic respawn or return',self=>{
    const f=wire(self,2),automation=structuredClone(DEFAULT_AUTOMATION);
    automation.respawn.enabled=true;automation.respawn.maxDeaths=3;automation.travel.returnToLockMap=true;
    f.c.engine.settings=validateFormSettings({...settings,automation});f.c.engine.deaths=2;
    const request=f.request();request.policy=manualTargetPolicy({...settings,automation});
    f.c.perform('command',request);f.step();expect(f.c.engine.deaths).toBe(2);
    f.packet(new BitWriter().u8(OP.death).i32(self));for(let i=0;i<4;i++)f.step(1000);
    expect(f.c.engine.deaths).toBe(3);expect(f.c.engine.manualTargetActive).toBe(false);
    expect(f.c.snapshot().deathRecoveryGuard).toBeUndefined();expect(f.c.engine.runIntent).toBe(false);expect(f.c.runRequested).toBe(false);
    expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);
  });
  const lateWalk=(self:number)=>new BitWriter().u8(OP.walk).i32(self).position({x:100,y:100}).f32(100.5).f32(100.5).f32(.1).f32(.1).u8(2).u8(0x60).u8(0);
  it.each([0,1])('blocks own %s manual admission on another owner\'s unresolved movement',self=>{
    const f=wire(self,2);
    f.c.travel.startApproach('prt_fild08',f.c.engine.player!,{x:104,y:100});f.step();f.c.stop();f.step(4500);
    const request=f.request();request.command={type:'walk',destination:{x:106,y:100}};
    expect(f.c.engine.idleForActions()).toBe(true);expect(()=>f.c.perform('command',request)).toThrow('movement');
    f.packet(new BitWriter().u8(OP.move).i32(self).position({x:100,y:100}));
    f.packet(new BitWriter().u8(OP.attack).i32(self).i32(2).i32(0).position({x:100,y:100}));
    f.packet(new BitWriter().u8(OP.stop).i32(self));expect(()=>f.c.perform('command',request)).toThrow('movement');
    f.packet(lateWalk(self));f.step(500);expect(()=>f.c.perform('command',request)).toThrow('movement');
    f.packet(new BitWriter().u8(OP.walk).i32(self).position({x:100,y:100}).f32(100).f32(100).f32(.1).f32(.1).u8(5).u8(0x66).u8(0x66).u8(0));
    f.step(1000);f.c.perform('command',request);expect(f.c.engine.manualTargetActive).toBe(true);expect(f.c.runRequested).toBe(false);
  });
  it.each([0,1])('settles own %s canceled manual shortened movement before another manual owner',self=>{
    const f=wire(self,2),request=f.request();request.command={type:'walk',destination:{x:104,y:100}};
    f.c.perform('command',request);f.step();f.c.stop();f.packet(lateWalk(self));
    f.step(50);expect(()=>f.c.perform('command',request)).toThrow();f.step(500);
    expect(f.c.engine.snapshot().manualTarget).toMatchObject({state:'cancelled',settling:false});
    f.c.perform('command',request);expect(f.c.engine.manualTargetActive).toBe(true);expect(f.sent.map(a=>a.type)).toEqual(['walk','stop']);
  });
  it.each([0,1])('settles only own %s captured manual Walk on an authoritative Stop',self=>{
    const f=wire(self,2),request=f.request();request.command={type:'walk',destination:{x:104,y:100}};
    f.c.perform('command',request);f.step();f.c.stop();
    f.packet(new BitWriter().u8(OP.stop).i32(self===0?1:0));expect(()=>f.c.perform('command',request)).toThrow();
    f.packet(new BitWriter().u8(OP.stop).i32(self));f.c.perform('command',request);
    expect(f.c.engine.manualTargetActive).toBe(true);expect(f.sent.map(a=>a.type)).toEqual(['walk','stop']);
  });
  it.each([[0,'attack'],[1,'attack'],[0,'walk'],[1,'walk']] as const)('does not reconcile retired own %s %s receipts against a replacement self lifetime',(self,kind)=>{
    const f=wire(self,2),request=f.request();if(kind==='walk')request.command={type:'walk',destination:{x:104,y:100}};
    f.c.perform('command',request);f.step();f.c.stop();f.c.receive(spawn({...p,id:self}));expect(f.c.engine.manualActorIdentity(self)!.incarnation).not.toBe(request.owner.incarnation);
    f.packet(new BitWriter().u8(OP.attack).i32(self).i32(2).i32(0).position({x:103,y:100}));f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));f.packet(new BitWriter().u8(OP.stop).i32(self));f.packet(lateWalk(self));f.step(1000);
    expect(f.c.engine.idleForActions()).toBe(false);expect(f.c.engine.snapshot().manualTarget).toMatchObject({state:'cancelled',settling:true});expect(f.sent.map(a=>a.type)).toEqual([kind,'stop']);
    expect(()=>f.c.start({...settings,targets:[4000]})).toThrow();expect(()=>f.c.perform('command',f.request())).toThrow();expect(()=>f.c.perform('command',{type:'sit',sitting:false})).toThrow();
    f.c.disconnect();f.c.connect(true);f.c.receive(new BitWriter().u8(OP.enter).i32(self).string('prt_fild08').finish());f.c.receive(spawn({...p,id:self}));f.step();expect(f.c.engine.idleForActions()).toBe(true);expect(f.c.runRequested).toBe(false);expect(f.sent.map(a=>a.type)).toEqual([kind,'stop']);
  });
  it.each([0,1])('retains accepted shortened movement uncertainty if own %s is replaced before settlement',self=>{
    const f=wire(self,2),request=f.request();request.command={type:'walk',destination:{x:104,y:100}};f.c.perform('command',request);f.step();f.c.stop();f.packet(lateWalk(self));
    f.c.receive(spawn({...p,id:self}));f.packet(new BitWriter().u8(OP.stop).i32(self));f.step(1000);expect(f.c.engine.idleForActions()).toBe(false);expect(f.c.engine.snapshot().manualTarget.settling).toBe(true);
  });
  function knownState(f:ReturnType<typeof wire>,self:number,state:'npc'|'vending'|'sit'|'cast') {
    if(state==='npc'){f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(3).bool(true));f.packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('Synthetic NPC').string('Synthetic dialog').bool(false));}
    if(state==='vending')f.packet(new BitWriter().u8(WORLD_OP.vendingStart).string('Synthetic shop').i32(1).i32(501).i32(1).i32(10));
    if(state==='sit')f.packet(new BitWriter().u8(FEATURE_OP.sit).i32(self).bool(true));
    if(state==='cast')f.packet(new BitWriter().u8(FEATURE_OP.castStart).i32(self).i32(2).u8(11).u8(1).u8(0).position({x:100,y:100}).f32(10).u8(0));
  }
  it.each([0,1])('rejects known server action conflicts before own %s dispatch',self=>{
    for(const state of ['npc','vending','sit','cast'] as const)for(const kind of ['walk','attack'] as const){if(state==='sit'&&kind==='walk')continue;const f=wire(self,2),request=f.request();if(kind==='walk')request.command={type:'walk',destination:{x:104,y:100}};knownState(f,self,state);
      expect(()=>f.c.perform('command',request)).toThrow();expect(f.c.engine.manualTargetOwned).toBe(false);expect(f.sent).toEqual([]);
    }
  });
  it.each([0,1])('rechecks known interaction conflicts between own %s admission and dispatch',self=>{
    for(const state of ['npc','vending','sit'] as const)for(const kind of ['walk','attack'] as const){if(state==='sit'&&kind==='walk')continue;const f=wire(self,2),request=f.request();if(kind==='walk')request.command={type:'walk',destination:{x:104,y:100}};f.c.perform('command',request);knownState(f,self,state);f.step();
      expect(f.c.engine.manualTargetActive).toBe(false);expect(f.sent.every(a=>a.type==='stop')).toBe(true);expect(f.c.engine.idleForActions()).toBe(true);expect(f.c.runRequested).toBe(false);
    }
  });
  it('waits for cast completion evidence without inferring it from the deadline',()=>{
    const f=wire(0,2);knownState(f,0,'cast');for(let i=0;i<11;i++)f.step(1000);expect(()=>f.c.perform('command',f.request())).toThrow('cast');expect(f.sent).toEqual([]);
    f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(0));f.c.perform('command',f.request());f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);
  });
  it('never treats ChangeTarget zero as acceptance of monster zero',()=>{
    const f=wire(1,0);f.c.perform('command',f.request());f.step();f.c.stop();f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));expect(f.c.engine.idleForActions()).toBe(false);
    f.packet(new BitWriter().u8(OP.attack).i32(1).i32(0).i32(0).position({x:103,y:100}));expect(f.sent.map(a=>a.type)).toEqual(['attack','stop','stop']);expect(f.c.engine.idleForActions()).toBe(false);f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));expect(f.c.engine.idleForActions()).toBe(true);
  });
  it('does not let unknown/self replacement alias another actor-zero operation',()=>{
    const f=wire(0,2),old=f.request();f.packet(new BitWriter().u8(OP.remove).i32(0).u8(0));f.c.receive(spawn({...p,id:0}));expect(()=>f.c.perform('command',old)).toThrow();expect(f.sent).toEqual([]);
  });
  it('preserves retired uncertainty on same-connection clear/map but fresh reconnect has no manual intent',()=>{
    const f=wire(1,0);f.c.perform('command',f.request());f.step();f.c.engine.receive([{type:'map',map:'prontera'},{type:'spawn',entity:{...p}}]);expect(f.c.engine.manualTargetActive).toBe(false);expect(f.c.engine.idleForActions()).toBe(false);
    f.c.disconnect();f.c.connect(true);f.c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...p}}]);f.step();expect(f.c.runRequested).toBe(false);expect(f.c.engine.manualTargetActive).toBe(false);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('preserves reserved self readiness at the bounded observation cap',()=>{
    const f=wire(0,2);for(let id=3;id<350;id++)f.c.engine.receive([{type:'spawn',entity:{...enemy,id}}]);expect(f.c.engine.observations.snapshot(0,null,true).selfId).toBe(0);expect(f.c.engine.manualActorIdentity(0)).not.toBeNull();expect(f.c.engine.manualActorIdentity(349)).toBeNull();
  });
});

describe('manual target request byte bound',()=>{
  it('rejects a within-count policy that exceeds the native 64 KiB envelope limit',()=>{
    const f=setup(),request=f.request();request.policy.monsterRules=Array.from({length:64},(_,i)=>({classId:4000+i,action:'attack',priority:0,conditions:Array.from({length:16},()=>({field:'actorStatus',actor:{scope:'actor',world:request.owner.world,id:2,incarnation:2},statusId:1,operator:'eq',value:true}))}));expect(new TextEncoder().encode(JSON.stringify(request)).length).toBeGreaterThan(65536);expect(()=>validateManualTargetRequest(request)).toThrow('size');
  });
});

import { manualTargetPolicy } from './manual-target';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { describe, expect, it, vi } from 'vitest';
import { CompanionController, type ControllerAction } from './controller';
import { BotEngine, type Action } from './engine';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_PARTY_HEAL, DEFAULT_RETREAT, DEFAULT_SETTINGS } from './settings';
import { BUILTIN_SERVICES } from './npc-services';
import { type Entity, type GameEvent, type Position, OP } from './protocol';
import { type FeatureEvent, FEATURE_OP } from './protocol-feature';
import { BitWriter } from './binary';
import { WORLD_OP } from './world-protocol';
import type { WalkGrid } from './navigation';
import { dispositionContextFromStatus } from './disposition-ui';
import { planDisposition } from './disposition';
import type { MacroScript, MacroStep } from './macros';

const player: Entity = { id: 1, classId: 0, name: 'Test', kind: 0, level: 7, hp: 100, maxHp: 100, x: 100, y: 100, dead: false };
const monster: Entity = { id: 2, classId: 4000, name: 'Poring', kind: 1, level: 1, hp: 10, maxHp: 10, x: 101, y: 100, dead: false };
const grid: WalkGrid = { width: 200, height: 200, walkable: () => true };
const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
function setup(walkGrid=grid) {
  let now = 100_000; const sent: Array<Action | ControllerAction> = [];
  const controller = new CompanionController(action => sent.push(action), () => now, map => map === 'unknown' ? null : walkGrid);
  controller.connect(true);
  const receive = (...events: Array<GameEvent | FeatureEvent>) => { controller.engine.receive(events);
    for (const event of events) if (event.type === 'enter' || event.type === 'map') controller.world.reset(event.map);
    controller.tick(); };
  receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } });
  const step = (ms = 100) => { now += ms; controller.tick(); };
  const advance = (ms: number) => { while (ms > 0) { const part = Math.min(ms, 100); step(part); ms -= part; } };
  const packet = (writer: BitWriter) => controller.receive(writer.finish());
  return { controller, sent, receive, step, advance, packet, time: () => now };
}
function ownPacket(e:Entity,entry:number):BitWriter {
  const name=new TextEncoder().encode(e.name),body=new BitWriter().u8(15).i32(e.id).i32(e.classId).i32(0)
    .i32(~name.length).i32(e.name.length).take(name).u8(e.kind).u8(0).u8(e.dead?3:e.sitting?2:0)
    .i32(e.x).i32(e.y).u8(e.level).i32(e.hp).i32(e.maxHp).i32(e.sp??0).i32(e.maxSp??0).i32(0).u8(0).finish();
  return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body);
}
function policy() { return structuredClone(DEFAULT_AUTOMATION); }

describe('normal ranged retreat controller ownership',()=>{
  function retreat() {
    const f=setup(),automation=policy();automation.retreat={...DEFAULT_RETREAT,enabled:true};
    f.receive({type:'inventory',items:[{bagId:77,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20},{bagId:601,itemId:601,type:1,count:4}],equipment:[0,0,0,0,77,0,0,0,0,0],ammoId:1750},{type:'skills',learned:[{skillId:1,level:2},{skillId:29,level:5}]});
    f.controller.start({...settings,automation});f.step();
    f.packet(new BitWriter().u8(OP.attack).i32(1).i32(2).i32(0).position(player));f.step();
    expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);
    return {...f,automation};
  }
  it('continues retreat through panel and official input without another Stop or renewed walk allowance',()=>{
    const f=retreat();f.controller.manualInput();f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));f.advance(1900);
    expect(f.sent.map(a=>a.type)).toEqual(['attack','stop','walk']);f.controller.manualCommand();
    expect(f.controller.engine.snapshot().retreat.state).toBe('walking');expect(f.controller.runRequested).toBe(true);
    expect(f.sent.filter(a=>a.type==='stop')).toHaveLength(1);f.advance(5000);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);
    expect(()=>f.controller.start({...settings,automation:f.automation})).toThrow();expect(f.controller.engine.settledForMaintenance()).toBe(false);
  });
  it('emergency escape cancels retreat, then waits for target clear before one resource request',()=>{
    const f=retreat();f.automation.escape={...DEFAULT_ESCAPE,enabled:true,hpBelowPercent:60};
    // The requested policy is immutable. Start with it before acceptance.
    f.controller.stop();f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));f.controller.engine.receive([{type:'stop',id:1}]);
    f.controller.start({...settings,automation:f.automation});f.step();f.packet(new BitWriter().u8(OP.attack).i32(1).i32(2).i32(0).position(player));f.step();
    f.controller.engine.player!.hp=55;f.step();expect(f.controller.engine.snapshot().retreat.state).toBe('skipped');expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(0);
    f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));f.advance(3000);
    expect(f.sent.filter(a=>a.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(0);
  });
});

describe('retreat ownership with stationary availability',()=>{
  function fixture(id:number,hp=100,rendezvous=false) {
    let now=100_000;const sent:Array<Action|ControllerAction>=[];
    const c=new CompanionController(action=>sent.push(action),()=>now,rendezvous?undefined:()=>grid);
    const own={...player,id,classId:6,level:20,hp,sp:200,maxSp:200,...(rendezvous?{x:170,y:370}:{})};
    const packet=(writer:BitWriter)=>c.receive(writer.finish());
    c.connect(true);packet(new BitWriter().u8(OP.enter).i32(id).string('prt_fild08'));
    packet(ownPacket(own,1));packet(ownPacket({...monster,x:own.x+1,y:own.y},0));
    c.engine.receive([{type:'inventory',items:[{bagId:77,itemId:1701,type:2,count:1,guid:'bow',flags:0,refine:0,slots:[0,0,0,0]},
      {bagId:1750,itemId:1750,type:1,count:20},{bagId:501,itemId:501,type:1,count:4},{bagId:601,itemId:601,type:1,count:4}],equipment:[0,0,0,0,77,0,0,0,0,0],ammoId:1750},
      {type:'stats',level:20,hp,maxHp:100,sp:200,maxSp:200},{type:'skills',learned:[{skillId:1,level:2},{skillId:29,level:5},{skillId:42,level:1}]}]);
    const automation=policy();automation.retreat={...DEFAULT_RETREAT,enabled:true};automation.respawn={enabled:true,maxDeaths:1};automation.recovery.enabled=false;
    const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation};
    const step=(ms=100)=>{now+=ms;c.tick();};
    const advance=(ms:number)=>{while(ms>0){const part=Math.min(ms,100);step(part);ms-=part;}};
    const attack=()=>packet(new BitWriter().u8(OP.attack).i32(id).i32(2).i32(0).position(c.engine.player!));
    const clear=()=>packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));
    const cast=()=>packet(new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(id).u8(42).u8(1).u8(6).position(c.engine.player!).f32(1).u8(0));
    const result=()=>packet(new BitWriter().u8(FEATURE_OP.skill).u8(2).i32(id).i32(-1).i32(id).u8(42).u8(1).u8(0)
      .position(c.engine.player!).i32(0).u8(0).u8(1).f32(0).f32(0).bool(false));
    const look=(actor=id,head=1)=>packet(new BitWriter().u8(13).i32(actor).i16(-1).i16(5000).u8(6).u8(head));
    const stopCast=()=>packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id));
    const walk=(cells:Position[],seconds=.1)=>{
      const offsets=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]],directions=cells.slice(1).map((cell,i)=>offsets.findIndex(([x,y])=>cell.x-cells[i]!.x===x&&cell.y-cells[i]!.y===y));
      const packed=[];for(let i=0;i<directions.length;i+=2)packed.push(directions[i]!<<4|(directions[i+1]??0));
      packet(new BitWriter().u8(OP.walk).i32(id).position(cells[0]!).f32(cells[0]!.x).f32(cells[0]!.y).f32(seconds).f32(seconds).u8(cells.length).take(Uint8Array.from(packed)).u8(0));
    };
    const start=()=>c.start(settings);
    const engage=()=>{start();step();attack();step();expect(sent.map(action=>action.type)).toEqual(['attack','stop']);};
    return {c,sent,settings,own,packet,step,advance,attack,clear,cast,result,look,stopCast,walk,start,engage};
  }
  function party(f:ReturnType<typeof fixture>,hp=100) {
    const ally={...f.own,id:3,name:'Member',x:f.own.x+1,hp};
    f.packet(ownPacket(ally,0));f.packet(new BitWriter().u8(OP.partyAffiliation).i32(3).u8(1).i32(5).string('Party').bool(true));
    f.packet(new BitWriter().u8(WORLD_OP.partyAccept).u8(0).i32(5).string('Party').i32(1).i32(7).i32(3).i16(20).string('Member')
      .u8(1).string('prt_fild08').i32(hp).i32(100).i32(200).i32(200));
    f.c.engine.receive([{type:'skills',learned:[{skillId:1,level:2},{skillId:29,level:5},{skillId:42,level:1},{skillId:41,level:10}]}]);
    f.settings.automation.partyHeal={...DEFAULT_PARTY_HEAL,enabled:true,cooldownSeconds:1};
    f.settings.automation.follow={...f.settings.automation.follow,mode:'partyLeader',rendezvous:true,distance:8,lostSeconds:20};
    const health=(value:number)=>f.packet(new BitWriter().u8(WORLD_OP.partyUpdate).u8(8).i32(7).i32(value).i32(100).i32(200).i32(200));
    const depart=()=>f.packet(new BitWriter().u8(WORLD_OP.partyUpdate).u8(9).i32(7).string('prontera'));
    const heals=()=>f.sent.filter(action=>action.type==='skill'&&action.skillId===41);
    return {health,depart,heals};
  }
  const removalTransitions=[
    {transition:'map',reason:0,clearFirst:false},
    {transition:'map',reason:0,clearFirst:true},
    {transition:'clear',reason:0,clearFirst:true},
    {transition:'clear',reason:1,clearFirst:true},
  ];
  it.each([0,1].flatMap(id=>removalTransitions.map(order=>({id,...order}))))(
    'retires own$id unused intent through actual Remove$reason/$transition; clearFirst=$clearFirst',({id,transition,reason,clearFirst})=>{
    const f=fixture(id);f.start();f.step();f.attack();f.c.engine.kills=7;
    expect(f.c.engine.snapshot().retreat).toMatchObject({state:'stopping',attempts:0});
    if(clearFirst)f.clear();
    f.packet(new BitWriter().u8(OP.remove).i32(id).u8(reason).f32(-1));expect(f.c.engine.player).toBeUndefined();
    if(!clearFirst)f.clear();
    expect(f.sent.filter(action=>action.type==='walk')).toEqual([]);expect(f.c.engine.retreatOwned).toBe(true);
    const map=transition==='map'?'prontera':'prt_fild08',entry=transition==='map'?1:2;
    f.packet(transition==='map'?new BitWriter().u8(OP.map).string(map):new BitWriter().u8(OP.clear));
    expect(f.c.engine.retreatOwned).toBe(true);
    f.packet(ownPacket(f.own,entry));expect(f.c.engine.retreatOwned).toBe(false);
    expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:0,kills:7});
    expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='walk'||action.type==='respawn')).toEqual([]);
  });
  it.each([0,1].flatMap(id=>['missing clear','unrelated removal','replacement before map','different name before map','different kind before map',
    'different name arrival','different kind arrival','wrong entry','new transition','new target','Teleport then map'].map(scenario=>({id,scenario}))))(
    'holds own$id removed intent when $scenario breaks its captured transition',({id,scenario})=>{
    const f=fixture(id);f.start();f.step();f.attack();
    if(scenario!=='missing clear')f.clear();
    const reason=scenario==='unrelated removal'?4:scenario==='Teleport then map'?1:0;
    f.packet(new BitWriter().u8(OP.remove).i32(id).u8(reason).f32(-1));
    if(scenario==='replacement before map')f.packet(ownPacket(f.own,0));
    if(scenario==='different name before map')f.packet(ownPacket({...f.own,name:'Other'},0));
    if(scenario==='different kind before map')f.packet(ownPacket({...f.own,kind:1},0));
    if(scenario==='new target'){f.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(2));f.clear();}
    f.packet(new BitWriter().u8(OP.map).string('prontera'));
    if(scenario==='different name arrival')f.packet(ownPacket({...f.own,name:'Other'},1));
    if(scenario==='different kind arrival')f.packet(ownPacket({...f.own,kind:1},1));
    if(scenario==='wrong entry')f.packet(ownPacket(f.own,0));
    if(scenario==='new transition')f.packet(new BitWriter().u8(OP.map).string('prt_fild08'));
    f.packet(ownPacket(f.own,1));f.clear();f.advance(300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.c.engine.featureActionsSettled).toBe(false);
    expect(f.sent.filter(action=>action.type==='walk'||action.type==='respawn')).toEqual([]);
    expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);expect(f.c.snapshot().deaths).toBe(0);
  });
  it.each([0,1])('does not bind foreign removal or old arrival after a new own%s Enter initialization',id=>{
    const f=fixture(id);f.start();f.step();f.attack();const foreign=id===0?1:0;
    f.packet(new BitWriter().u8(OP.remove).i32(foreign).u8(0).f32(-1));
    f.packet(ownPacket(f.own,0));expect(f.c.engine.retreatOwned).toBe(true);
    f.packet(new BitWriter().u8(OP.enter).i32(foreign).string('prontera'));f.clear();f.packet(ownPacket(f.own,1));
    expect(f.c.engine.player).toBeUndefined();expect(f.c.engine.playerId).toBe(foreign);
    expect(f.c.engine.running).toBe(false);expect(f.sent.filter(action=>action.type==='walk'||action.type==='respawn')).toEqual([]);
  });
  it.each([0,1].flatMap(id=>['map','clear'].map(transition=>({id,transition}))))(
    'retires only own$id unsent retreat after ordered $transition and matching living arrival',({id,transition})=>{
    const f=fixture(id);f.start();f.step();f.attack();f.c.engine.kills=7;
    // ResetState/ClearTarget precedes both ChangeMaps and Warp RemoveAllEntities
    // at the pinned source. No Walk or movement completion is invented here.
    if(transition==='map')f.packet(new BitWriter().u8(OP.remove).i32(id).u8(0).f32(-1));
    f.clear();
    if(transition==='clear')f.packet(new BitWriter().u8(OP.remove).i32(id).u8(0).f32(-1));
    expect(f.sent.filter(action=>action.type==='walk')).toEqual([]);
    const map=transition==='map'?'prontera':'prt_fild08',entry=transition==='map'?1:2;
    f.packet(transition==='map'?new BitWriter().u8(OP.map).string(map):new BitWriter().u8(OP.clear));
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.c.engine.featureActionsSettled).toBe(false);
    f.packet(ownPacket({...f.own,id:id===0?1:0},entry));expect(f.c.engine.retreatOwned).toBe(true);
    f.packet(ownPacket({...f.own,dead:true,hp:0},entry));expect(f.c.engine.retreatOwned).toBe(true);
    f.packet(ownPacket(f.own,entry));expect(f.c.engine.retreatOwned).toBe(false);
    expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:0,kills:7});
    expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='walk'||action.type==='respawn')).toEqual([]);
  });
  it.each([0,1].flatMap(id=>['map','clear'].map(transition=>({id,transition}))))(
    'does not infer old target-clear from own$id $transition and arrival alone',({id,transition})=>{
    const f=fixture(id);f.engage();f.packet(transition==='map'?new BitWriter().u8(OP.map).string('prontera'):new BitWriter().u8(OP.clear));
    f.packet(ownPacket(f.own,transition==='map'?1:2));f.advance(300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.c.engine.featureActionsSettled).toBe(false);
    expect(f.sent.filter(action=>action.type==='walk'||action.type==='respawn')).toEqual([]);
  });
  it.each([0,1].flatMap(id=>[false,true].map(sentWalk=>({id,sentWalk}))))(
    'retains own$id movement uncertainty across ordered map arrival; sentWalk=$sentWalk',({id,sentWalk})=>{
    const f=fixture(id);f.engage();
    if(sentWalk){f.clear();f.step();expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);}
    else {f.walk([{x:100,y:100},{x:100,y:101}],2);f.clear();expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(0);}
    f.packet(new BitWriter().u8(OP.remove).i32(id).u8(0).f32(-1));
    f.packet(new BitWriter().u8(OP.map).string('prontera'));f.packet(ownPacket(f.own,1));f.advance(2300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.c.engine.featureActionsSettled).toBe(false);
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(sentWalk?1:0);expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);
  });
  it.each([0,1])('keeps needy party Heal behind own%s unsent and sent retreat ownership',id=>{
    const f=fixture(id),p=party(f);f.engage();p.health(40);f.step();
    expect(f.c.world.partyActors.get(7)).not.toBeNull();expect(f.c.engine.stationaryForPartySupport()).toBe(false);
    expect(f.c.engine.partyHealReadiness(3,1,10)).toContain('movement');expect(p.heals()).toEqual([]);
    f.clear();f.step();expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
    f.look();f.stopCast();f.advance(300);expect(f.c.engine.retreatOwned).toBe(true);
    expect(f.c.engine.stationaryForPartySupport()).toBe(false);expect(p.heals()).toEqual([]);
    expect(f.c.snapshot().partyHeal).toMatchObject({attempts:0,confirmed:0});
  });
  it.each([0,1])('retains unresolved own%s Heal ahead of retreat, Wing, service and party departure',id=>{
    const f=fixture(id),p=party(f,40);f.settings.automation.escape={...DEFAULT_ESCAPE,enabled:true,hpBelowPercent:60};
    f.start();f.step();expect(p.heals(),f.c.snapshot().partyHeal?.reason).toHaveLength(1);f.c.engine.kills=7;
    f.c.manualCommand();f.look();f.stopCast();p.depart();
    f.packet(new BitWriter().u8(OP.heal).i32(id).i32(0).i32(20).i32(100));f.advance(1500);
    // The scheduler's finite timeout may retire its resource owner; the exact
    // Heal receipt still owns the unresolved spend after that separate timeout.
    for(let i=0;i<32;i++){f.step(1000);f.packet(new BitWriter().u8(OP.heal).i32(id).i32(0).i32(20).i32(100));}
    expect(f.c.engine.pendingFeatureAction).toBeNull();
    expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.c.engine.resourceActionsSettled).toBe(false);
    expect(f.c.partyHeal.busy).toBe(true);expect(f.c.engine.retreatOwned).toBe(false);
    expect(()=>f.c.perform('service',{service:BUILTIN_SERVICES[0],executionPolicy:DEFAULT_MAP_POLICY})).toThrow('party Heal');
    expect(f.sent.filter(action=>action.type==='walk'||action.type==='attack'||action.type==='useItem'||action.type==='respawn')).toEqual([]);
    expect(f.c.snapshot().partyFollow).toMatchObject({attemptUsed:false,ownsTravel:false});
    expect(f.c.snapshot()).toMatchObject({runRequested:true,kills:7,partyHeal:{attempts:1,confirmed:0}});
    f.packet(new BitWriter().u8(FEATURE_OP.skill).u8(1).i32(id).i32(-1).i32(3).u8(41).u8(1).u8(0)
      .position(f.c.engine.player!).i32(-20).u8(2).u8(0).f32(0).f32(0).bool(false));
    expect(f.c.partyHeal.busy).toBe(false);expect(f.c.snapshot().partyHeal).toMatchObject({attempts:1,confirmed:1});
    expect(f.c.partyHeal.awaitingSpReadback).toBe(true);f.look();f.stopCast();
    expect(f.c.partyHeal.awaitingSpReadback).toBe(true);f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(187).i32(200));
    expect(f.c.partyHeal.awaitingSpReadback).toBe(false);expect(p.heals()).toHaveLength(1);
  });
  it.each([0,1])('keeps party departure behind own%s retained retreat movement and then gives Travel priority',id=>{
    const f=fixture(id,100,true),p=party(f);f.engage();f.clear();f.step();const cells=f.c.engine.snapshot().navigation!.leg;
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);p.health(40);p.depart();f.look();f.stopCast();f.advance(300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
    expect(f.c.snapshot().partyFollow).toMatchObject({attemptUsed:false,ownsTravel:false});expect(p.heals()).toEqual([]);
    f.walk(cells.slice(0,2));f.advance(400);expect(f.c.engine.retreatOwned).toBe(false);
    expect(f.c.snapshot().partyFollow).toMatchObject({attemptUsed:true,ownsTravel:true,state:'travelling'});
    expect(f.c.travel.snapshot().purpose).toBe('party-follow');expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(2);
    expect(p.heals()).toEqual([]);expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);
    f.c.stop();f.advance(1000);expect(f.c.travel.movementSettled('prt_fild08',f.c.engine.player)).toBe(false);
    expect(()=>f.c.start(f.settings)).toThrow('movement');expect(f.c.settledForMaintenance()).toBe(false);
  });
  it.each([0,1])('preserves cap1 after own%s unsent retreat Death with follow and Heal enabled',id=>{
    const f=fixture(id),p=party(f);f.engage();f.c.engine.kills=7;
    f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.advance(2300);
    expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.c.engine.retreatOwned).toBe(false);
    expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:7,partyFollow:{state:'cancelled'}});
    f.packet(new BitWriter().u8(OP.clear));f.packet(ownPacket(f.own,2));f.advance(300);
    expect(f.c.engine.player?.dead).toBe(false);expect(p.heals()).toEqual([]);
    f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.advance(2300);
    expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:2,kills:7});
    expect(f.c.snapshot().reason).toContain('Death limit reached');expect(f.settings.automation.respawn.maxDeaths).toBe(1);
  });
  it.each([0,1].flatMap(id=>[false,true].map(fatalHit=>({id,fatalHit}))))(
    'releases own$id unsent retreat on actual Death, revives once and retains cap1; fatalHit=$fatalHit',({id,fatalHit})=>{
    const f=fixture(id);f.engage();f.c.engine.kills=7;expect(f.c.engine.snapshot().retreat).toMatchObject({state:'stopping',attempts:0});
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(0);
    if(fatalHit){f.packet(new BitWriter().u8(OP.hit).i32(id).i32(100).position(f.c.engine.player!).u8(0));expect(f.c.engine.retreatOwned).toBe(true);}
    f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.advance(2300);
    expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.c.engine.retreatOwned).toBe(false);
    expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:7});expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(0);
    f.packet(new BitWriter().u8(OP.clear));f.packet(ownPacket(f.own,2));f.advance(300);
    expect(f.c.engine.player?.dead).toBe(false);expect(f.c.engine.running).toBe(true);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:7});
    f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.advance(2300);
    expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:2,kills:7});
    expect(f.c.snapshot().reason).toContain('Death limit reached');expect(f.settings.automation.respawn.maxDeaths).toBe(1);
  });
  it.each([0,1])('does not retire own%s unsent retreat from foreign Death',id=>{
    const f=fixture(id),foreign=id===0?1:0;f.engage();f.packet(ownPacket({...player,id:foreign},0));
    f.packet(new BitWriter().u8(OP.death).i32(foreign).position(player));f.advance(2300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:0});
    expect(f.sent.filter(action=>action.type==='respawn'||action.type==='walk')).toHaveLength(0);
  });
  it.each([0,1])('retains own%s sent retreat Walk uncertainty across Death and late Stop/target clear',id=>{
    const f=fixture(id);f.engage();f.clear();f.step();expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
    f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.clear();f.packet(new BitWriter().u8(OP.stop).i32(id));f.advance(6300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(0);
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1});
  });
  it.each([0,1])('preserves own%s accepted physical movement even before the first explicit retreat Walk',id=>{
    const f=fixture(id);f.engage();f.walk([{x:100,y:100},{x:100,y:101}],2);
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(0);
    f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.advance(2300);
    f.clear();f.packet(new BitWriter().u8(OP.stop).i32(id));f.packet(new BitWriter().u8(OP.death).i32(id).position(f.c.engine.player!));f.advance(300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(0);
    expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1});
  });
  it.each([0,1])('keeps canceled own%s target-clear settlement exclusive to retreat',id=>{
    const f=fixture(id);f.engage();f.c.engine.deaths=1;f.c.engine.kills=7;f.cast();f.result();f.advance(6300);
    expect(f.c.engine.retreatOwned).toBe(true);expect(f.sent.filter(action=>action.type==='look')).toHaveLength(0);
    expect(f.c.engine.stationaryForCastAvailability()).toBe(false);expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.stopCast();expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.c.engine.retreatOwned).toBe(true);
    f.clear();expect(f.c.engine.retreatOwned).toBe(false);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:7});
  });
  it.each([0,1])('keeps own%s Look and cast results separate from a canceled retreat Walk receipt',id=>{
    const f=fixture(id);f.engage();f.clear();f.step();const cells=f.c.engine.snapshot().navigation!.leg;
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);f.cast();f.result();f.advance(2300);
    expect(f.sent.filter(action=>action.type==='look')).toHaveLength(0);f.look(id===0?1:0);expect(f.c.engine.observedCast).not.toBeNull();
    f.look();f.stopCast();expect(f.c.engine.observedOwnCastSettled()).toBe(false);f.advance(199);expect(f.c.engine.retreatOwned).toBe(true);
    f.step(1);expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.c.engine.retreatOwned).toBe(true);
    f.attack();f.clear();f.c.stop();f.stopCast();expect(f.c.runRequested).toBe(false);expect(f.c.settledForMaintenance()).toBe(false);
    f.walk(cells.slice(0,2),2);f.advance(1999);expect(f.c.settledForMaintenance()).toBe(false);f.advance(201);
    expect(f.c.engine.retreatOwned).toBe(false);expect(f.c.settledForMaintenance()).toBe(true);
    expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);
  });
  it.each([0,1])('drains own%s six-Look input debt before normal attack and retreat, without StopCast shortening it',id=>{
    const f=fixture(id);f.start();f.c.engine.deaths=1;f.c.engine.kills=7;f.cast();f.advance(6300);
    expect(f.sent.filter(action=>action.type==='look')).toHaveLength(6);f.look();f.stopCast();f.advance(799);
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);expect(f.sent.filter(action=>action.type==='attack'||action.type==='walk')).toHaveLength(0);
    f.step(1);expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(1);
    f.attack();f.step();f.clear();f.step();expect(f.sent.filter(action=>action.type==='walk')).toHaveLength(1);
    expect(f.c.engine.snapshot().retreat.attempts).toBe(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,deaths:1,kills:7});
  });
  it.each([0,1])('does not acknowledge own%s pending item from Look or StopCast with retreat enabled',id=>{
    const f=fixture(id,80);f.settings.automation.items=[{itemId:501,resource:'hp',belowPercent:90,minStock:0,cooldownSeconds:10}];f.start();f.step();
    expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);const sequence=f.c.engine.actionResult.sequence;
    f.cast();f.advance(1300);expect(f.sent.filter(action=>action.type==='look')).toHaveLength(1);f.look();f.stopCast();f.advance(300);
    expect(f.c.engine.actionResult).toMatchObject({sequence,status:'pending'});expect(f.c.engine.retreatOwned).toBe(false);
    f.packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(0).bool(false));
    expect(f.c.engine.actionResult).toMatchObject({sequence,status:'confirmed'});expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);
  });
});

describe('official game panel input', () => {
  it('continues new pickup decisions while repeated client panel input is still arriving',()=>{
    const f=setup();f.controller.start(settings);f.step();
    f.controller.manualInput();
    f.receive({type:'death',id:2},{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}});
    for(let i=0;i<5;i++){f.controller.manualInput();f.step(100);}
    expect(f.sent.filter(a=>a.type==='pickup')).toEqual([{type:'pickup',id:9}]);
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true});
  });
  it('observes a long official walk across a portal exclusion without Stop, then resumes on safe ground',()=>{
    const f=setup({...grid,portals:[{x:110,y:100,halfWidth:1,halfHeight:1}]});
    f.controller.start(settings);f.step();f.controller.engine.kills=5;f.controller.engine.looted=4;f.controller.manualCommand(true);
    const w=new BitWriter().u8(OP.walk).i32(1).position(player).f32(100).f32(100).f32(.1).f32(.1).u8(25);
    for(let i=0;i<12;i++)w.u8(0x66);f.packet(w.u8(0));
    for(let i=0;i<15;i++){f.controller.manualInput();f.step(100);}
    expect(f.controller.engine.player!.x).toBe(115);expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true,kills:5,looted:4});
    f.advance(1100);expect(f.controller.engine.player!.x).toBe(124);
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);expect(f.controller.engine.running).toBe(true);
    f.controller.stop();const count=f.sent.length;f.controller.manualCommand();f.advance(500);expect(f.sent).toHaveLength(count);
    expect(f.controller.runRequested).toBe(false);
  });
  it('keeps a bounded official movement response sequence after an older bot walk acknowledgment',()=>{
    const f=setup({width:200,height:200,walkable:p=>p.x!==104||p.y<98});
    f.receive({type:'spawn',entity:{...monster,x:108}});f.controller.start(settings);f.step();f.controller.manualCommand(true);
    f.packet(new BitWriter().u8(OP.walk).i32(1).position(player).f32(100).f32(100).f32(.1).f32(.1).u8(2).u8(0x10).u8(0));
    const w=new BitWriter().u8(OP.walk).i32(1).position(player).f32(100).f32(100).f32(.1).f32(.1).u8(25);
    for(let i=0;i<12;i++)w.u8(0x66);f.packet(w.u8(0));f.advance(2600);
    expect(f.controller.engine.player!.x).toBe(124);expect(f.controller.engine.running).toBe(true);
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
  });
  it('retains the run through ordered own departure and map arrival without sending Stop to the missing actor',()=>{
    const f=setup();f.controller.start(settings);f.step();
    f.controller.engine.kills=5;f.controller.manualCommand();
    f.packet(new BitWriter().u8(OP.remove).i32(1).u8(0).f32(-1));f.step();
    expect(f.controller.runRequested).toBe(true);expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
    f.packet(new BitWriter().u8(OP.map).string('prontera'));f.packet(ownPacket(player,1));f.advance(5200);
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true,kills:5});
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
  });
  it('keeps an opener receipt and target strategy through panel input, then attacks after exact skill motion', () => {
    const f=setup(),automation=policy();
    automation.attackStrategies=[{id:'open',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
    f.receive({type:'spawn',entity:{...player,statuses:[],sp:200,maxSp:200}},
      {type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:11,level:1}]});
    f.controller.start({...settings,automation});f.step();f.controller.manualInput();
    f.advance(1000);
    f.packet(new BitWriter().u8(FEATURE_OP.skill).u8(1).i32(1).i32(1).i32(2).u8(11).u8(1).u8(0)
      .position({x:100,y:100}).i32(1).u8(0).u8(1).f32(1).f32(0).bool(false));
    f.advance(999);expect(f.sent.filter(a=>a.type==='attack')).toEqual([]);
    f.step(1);expect(f.sent.filter(a=>a.type==='attack')).toEqual([{type:'attack',id:2}]);
    expect(f.controller.engine.actionResult.status).toBe('confirmed');
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
    expect(f.sent.filter(a=>a.type==='skill')).toHaveLength(1);
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true});
    expect(f.controller.snapshot().reason).not.toContain('unresolved');
  });
  it('preserves a Thief normal attack and finite counters instead of restarting combat on every panel click',()=>{
    const f=setup();f.controller.engine.player!.classId=6;
    f.controller.start(settings);f.step();f.controller.manualInput();
    f.packet(new BitWriter().u8(OP.attack).i32(1).i32(2).i32(0).position(player));f.advance(2000);
    expect(f.sent).toEqual([{type:'attack',id:2}]);expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true,attacks:1});
    expect(f.controller.snapshot().elapsedSeconds).toBe(2);
    f.controller.stop();f.advance(2500);expect(f.controller.runRequested).toBe(false);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('continues passive clocks through more than five seconds of held-key panel input',()=>{
    const f=setup();f.controller.start(settings);f.step();
    for(let i=0;i<9;i++){
      f.controller.manualInput();f.advance(1000);f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100));
    }
    f.advance(2000);expect(f.controller.engine.running).toBe(true);expect(f.sent).toEqual([{type:'attack',id:2}]);
    expect(f.controller.engine.log.some(entry=>entry.text.includes('slept')||entry.text.includes('paused'))).toBe(false);
    expect(f.controller.snapshot().elapsedSeconds).toBe(11);
  });
  it('keeps recovery item confirmation and its cooldown across panel input without a second spend',()=>{
    const f=setup(),automation=policy();automation.items=[{itemId:501,resource:'hp',belowPercent:90,minStock:0,cooldownSeconds:10}];
    f.receive({type:'inventory',items:[{bagId:501,itemId:501,type:1,count:4}],equipment:[],ammoId:-1},
      {type:'heal',id:1,hp:80,maxHp:100});f.controller.start({...settings,automation});f.step();f.controller.manualInput();f.advance(1000);
    f.packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(0).bool(false));
    f.advance(2000);expect(f.sent.filter(a=>a.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);expect(f.controller.engine.actionResult.status).toBe('confirmed');
  });
  it('still expires a genuinely unconfirmed item at its original deadline during repeated panel input',()=>{
    const f=setup(),automation=policy();automation.items=[{itemId:501,resource:'hp',belowPercent:100,minStock:0,cooldownSeconds:1}];
    f.receive({type:'inventory',items:[{bagId:501,itemId:501,type:1,count:4}],equipment:[],ammoId:-1});
    f.controller.start({...settings,automation});f.step();
    for(let i=0;i<7;i++){f.controller.manualInput();f.advance(1000);}
    expect(f.controller.engine.actionResult.status).toBe('failed');expect(f.controller.engine.running).toBe(false);
    expect(f.controller.snapshot().reason).toContain('Waiting for a confirmed result');expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
    f.advance(3000);expect(f.sent.filter(a=>a.type==='useItem')).toHaveLength(1);
  });
  it('keeps a pending automatic ammo change until its exact ACK, then attacks without repeating equipment',()=>{
    const f=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.minAmmoStock=3;
    f.controller.engine.player!.classId=5;f.controller.engine.player!.level=50;
    f.receive({type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],
      equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:-1});
    f.controller.start({...settings,automation});f.step();f.controller.manualInput();f.advance(1000);
    f.packet(new BitWriter().u8(FEATURE_OP.equipment).i32(1750).u8(13).bool(true));f.advance(1000);
    expect(f.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1750,equipped:true}]);
    expect(f.sent.filter(a=>a.type==='attack')).toEqual([{type:'attack',id:2}]);expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
  });
  it('keeps a pickup owner and attribution when its raw receipt arrives during the panel grace period',()=>{
    const f=setup();f.controller.start(settings);f.step();
    f.receive({type:'death',id:2},{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}});f.step(150);
    expect(f.sent.at(-1)).toEqual({type:'pickup',id:9});f.controller.manualInput();f.advance(500);
    f.packet(new BitWriter().u8(OP.pickup).i32(1).i32(9));f.advance(1500);
    expect(f.controller.snapshot()).toMatchObject({kills:1,looted:1,runRequested:true,running:true});
    expect(f.sent.filter(a=>a.type==='pickup')).toHaveLength(1);expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
  });
  it('settles an accepted explicit route leg and continues immediately despite panel input',()=>{
    const f=setup({width:200,height:200,walkable:p=>p.x!==104||p.y<98});
    f.receive({type:'spawn',entity:{...monster,x:108}});f.controller.start(settings);f.step();
    expect(f.sent).toEqual([{type:'walk',destination:{x:99,y:99}}]);f.controller.manualInput();
    f.packet(new BitWriter().u8(OP.walk).i32(1).position(player).f32(100).f32(100).f32(1).f32(1).u8(2).u8(0x10).u8(0));
    f.advance(900);expect(f.sent).toHaveLength(1);f.advance(1000);expect(f.controller.engine.player).toMatchObject({x:99,y:99});
    f.step(100);expect(f.sent.length).toBeGreaterThan(1);expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);expect(f.controller.engine.running).toBe(true);
  });
  it('does not replenish the requested finite time budget during repeated panel input',()=>{
    const f=setup(),automation=policy();automation.limits.minutes=1;f.controller.start({...settings,automation});f.step();
    for(let i=0;i<61;i++){f.controller.manualInput();f.advance(1000);f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100));}
    expect(f.controller.engine.running).toBe(false);expect(f.controller.runRequested).toBe(true);expect(f.controller.snapshot().reason).toContain('session limit');
    const attacks=f.sent.filter(a=>a.type==='attack').length;f.advance(1000);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(attacks);
  });
  it('keeps a sent skill receipt and field run across actual official gameplay without another spend',()=>{
    const f=setup(),automation=policy();automation.skills=[{skillId:11,level:1,target:'enemy',hpBelowPercent:100,spAbovePercent:0,cooldownSeconds:10}];
    f.receive({type:'spawn',entity:{...player,statuses:[],sp:200,maxSp:200}},
      {type:'inventory',items:[],equipment:[],ammoId:-1},{type:'skills',learned:[{skillId:11,level:1}]});
    f.controller.start({...settings,automation});f.step();f.controller.manualCommand();
    expect(f.sent.filter(a=>a.type==='stop')).toHaveLength(0);expect(f.controller.engine.running).toBe(true);
    expect(f.controller.engine.actionResult.status).toBe('pending');f.advance(2000);
    expect(f.sent.filter(a=>a.type==='skill')).toHaveLength(1);expect(f.controller.runRequested).toBe(true);
  });
});
const routine = (action: ControllerAction, durationSeconds = 20) => ({ name: 'Test', durationSeconds, maxActions: 2,
  rules: [{ name: 'Act', priority: 1, maxRuns: 2, cooldownSeconds: 0, conditions: [{ field: 'hpPercent', operator: 'gte', value: 0 }], action }] });

describe('persistent field run ownership', () => {
  it('uses cart receipt weights in the authoritative snapshot and disposition preview', () => {
    const { controller, receive, packet, sent }=setup();
    receive({type:'stats',level:7,hp:100,maxHp:100,zeny:1000,weight:210,maxWeight:10000,cartWeight:79900},
      {type:'inventory',items:[{bagId:501,itemId:501,type:1,count:3}],equipment:[],ammoId:-1},
      {type:'skills',learned:[{skillId:73,level:1}]});
    controller.world.replaceCart([{bagId:501,itemId:501,type:1,count:1140},{bagId:512,itemId:512,type:1,count:5}]);
    const policy={maxSpend:0,rules:[{itemId:501,keep:0,minimum:0,desired:0,maximum:1,store:false,sell:false,cart:true,restock:'off' as const,allowUnique:false}]};
    const context=()=>dispositionContextFromStatus({...controller.snapshot(),sessionId:'test',connectionId:1});
    expect(planDisposition(policy,context()).actions[0]?.count).toBe(1);
    packet(new BitWriter().u8(WORLD_OP.cart).u8(1).i32(501).u8(1).i32(501).i16(1141).i16(1).i32(79970).i32(140));
    receive({type:'inventoryDelta',add:false,bagId:501,change:1,weight:140});
    expect(controller.snapshot().character.stats).toMatchObject({cartWeight:79970,weight:140});
    const result=planDisposition(policy,context());expect(result.actions).toEqual([]);expect(result.unmet[0]?.count).toBe(1);
    expect(sent).toEqual([]);
  });
  it('keeps canceled ground execution fenced until the exact requested coordinate is confirmed',()=>{
    const {controller,receive,packet}=setup();const automation=policy();automation.combat.mode='off';
    receive({type:'spawn',entity:{...player,statuses:[],sp:200,maxSp:200}},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:19,level:1}]});
    controller.start({...settings,automation});controller.pause('External owner',60_000);
    controller.engine.manualAction({type:'skill',mode:'ground',skillId:19,level:1,position:{x:105,y:100}});
    controller.tick();controller.pause('Temporary interruption',60_000);
    expect(controller.snapshot().reason).toContain('Waiting for a confirmed result');
    const ground=(y:number)=>new BitWriter().u8(FEATURE_OP.skill).u8(4).i32(1).position({x:105,y}).u8(19).u8(1).u8(0).position({x:100,y:100}).f32(1.5);
    packet(ground(101));expect(controller.snapshot().reason).toContain('Waiting for a confirmed result');
    packet(ground(100));expect(controller.snapshot().reason).not.toContain('Waiting for a confirmed result');
    expect(controller.runRequested).toBe(true);expect(controller.engine.running).toBe(false);
  });
  it.each([0,2])('settles a late canceled bolt before emergency escape when motion is %s seconds', motion => {
    const {controller,receive,packet,sent,step}=setup();const automation=policy();
    automation.escape={...DEFAULT_ESCAPE,enabled:true};
    automation.attackStrategies=[{id:'open',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
    receive({type:'spawn',entity:{...player,statuses:[],sp:200,maxSp:200}},
      {type:'inventory',items:[{bagId:601,itemId:601,type:1,count:2}],equipment:Array(10).fill(0),ammoId:-1},
      {type:'skills',learned:[{skillId:11,level:1}]});
    controller.start({...settings,automation});step();
    expect(sent.filter(a=>a.type==='skill')).toHaveLength(1);
    packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(20).i32(100));
    for(let n=0;n<31;n++){step(1000);packet(new BitWriter().u8(FEATURE_OP.sp).i32(200).i32(200));}
    packet(new BitWriter().u8(FEATURE_OP.skill).u8(1).i32(1).i32(1).i32(2).u8(11).u8(1).u8(0)
      .position({x:100,y:100}).i32(1).u8(0).u8(1).f32(motion).f32(0).bool(false));
    expect(controller.engine.featureActionsSettled).toBe(false);
    step(Math.max(1,motion)*1000-1);
    expect(sent.filter(a=>a.type==='useItem')).toHaveLength(0);
    expect(controller.engine.featureActionsSettled).toBe(false);
    step(1);step(250);
    expect(sent.filter(a=>a.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
    expect(sent.filter(a=>a.type==='skill')).toHaveLength(1);
  });
  it('keeps a low HP run waiting and resumes only after authoritative recovery', () => {
    const { controller, sent, receive, step } = setup(); controller.start(settings); step();
    receive({ type: 'hit', id: 1, damage: 80, position: { x: 100, y: 100 } });
    expect(controller.snapshot()).toMatchObject({ runRequested: true, running: false, state: 'waiting' });
    const count = sent.length; step(); expect(sent).toHaveLength(count);
    receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 }); step();
    expect(controller.snapshot()).toMatchObject({ runRequested: true, running: true, state: 'running' });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
  });
  it('starts a low HP request in waiting instead of dropping its intent', () => {
    const { controller, receive, step } = setup(); receive({ type: 'hit', id: 1, damage: 80, position: { x: 100, y: 100 } });
    controller.start(settings); expect(controller.runRequested).toBe(true); expect(controller.engine.running).toBe(false);
    receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 }); step(); expect(controller.engine.running).toBe(true);
  });
  it('rebinds the map while preserving selected species and ignoring unselected monsters', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings); step();
    receive({ type: 'map', map: 'prt_fild05' }); expect(controller.runRequested).toBe(true);
    receive({ type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster, classId: 4002 } }); step();
    expect(controller.engine.settings).toMatchObject({ map: 'prt_fild05', targets: [4000] });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(1);
    receive({ type: 'spawn', entity: { ...monster, id: 3 } }); step(); expect(sent.at(-1)).toEqual({ type: 'attack', id: 3 });
  });
  it('waits on unknown ground and an unsupported build without sending commands', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings);
    receive({ type: 'map', map: 'unknown' }, { type: 'spawn', entity: { ...player } }); const count = sent.length;
    step(); expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true }); expect(sent).toHaveLength(count);
    controller.connect(false); receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } });
    step(); expect(controller.snapshot().state).toBe('waiting'); expect(sent).toHaveLength(count);
  });
  it('preserves intent through disconnect and ignores packets from the former connection generation', () => {
    const { controller, receive, sent, packet, step } = setup(); controller.start(settings); step();
    const old = controller.connectionGeneration; controller.disconnect(); expect(controller.runRequested).toBe(true);
    const count = sent.length; step(); expect(sent).toHaveLength(count); controller.connect(true);
    controller.receive(new BitWriter().u8(OP.map).string('wrong_map').finish(), old);
    expect(controller.engine.map).toBe('');
    receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } });
    packet(new BitWriter().u8(OP.heal).i32(1).i32(1).i32(100).i32(100)); step();
    expect(controller.engine.running).toBe(true); expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
  });
  it('yields for manual input and resumes after two seconds, but client Stop cancels retries', () => {
    const { controller, sent, step, advance } = setup(); controller.start(settings); step();
    controller.pause('Manual input', 2000); const count = sent.length; advance(1900); expect(sent).toHaveLength(count);
    step(100); step(); expect(controller.engine.running).toBe(true); expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
    controller.stop(); advance(3000); expect(controller.snapshot()).toMatchObject({ runRequested: false, state: 'idle', running: false });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
  });
  it('pauses on lost client heartbeat and resumes only after it returns', () => {
    const { controller, sent, advance, step } = setup(); controller.start(settings); step(); controller.heartbeat(false);
    const count = sent.length; advance(1000); expect(sent).toHaveLength(count); expect(controller.snapshot().state).toBe('waiting');
    controller.heartbeat(true); step(); step(); expect(controller.engine.running).toBe(true);
  });
  it('preserves finite kill budgets through recovery and map rebinds', () => {
    const { controller, receive, step } = setup(); const automation = policy(); automation.limits.kills = 1;
    controller.start({ ...settings, automation }); step(); receive({ type: 'death', id: 2 });
    expect(controller.snapshot()).toMatchObject({ kills: 1, runRequested: true, state: 'waiting' });
    receive({ type: 'map', map: 'prt_fild05' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster, id: 3 } });
    step(); expect(controller.engine.running).toBe(false); expect(controller.snapshot().reason).toContain('session limit');
  });
  it('does not duplicate an item after an uncertain six-second result', () => {
    const { controller, receive, sent, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 1 }];
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); advance(7000);
    expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true });
    expect(controller.snapshot().reason).toContain('Waiting for a confirmed result');
    receive({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 }); advance(1000);
    expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
  });
  it('waits for revival when automatic respawn is disabled and retains the death budget', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings); step(); receive({ type: 'death', id: 1 });
    expect(controller.snapshot()).toMatchObject({ runRequested: true, state: 'waiting', deaths: 1 });
    expect(sent.some(action => action.type === 'respawn')).toBe(false);
    receive({ type: 'resurrection', id: 1, hp: 100, position: { x: 100, y: 100 } }); step();
    expect(controller.engine.running).toBe(true); expect(controller.engine.deaths).toBe(1);
  });
  it('confirms same-map respawn only after an alive self spawn, then resumes the requested run', () => {
    const { controller, receive, sent, step, packet } = setup(); const automation = policy(); automation.respawn.enabled = true;
    controller.start({ ...settings, automation }); step(); receive({ type: 'death', id: 1 }); step(2100);
    expect(sent.at(-1)).toEqual({ type: 'respawn' }); packet(new BitWriter().u8(OP.clear));
    expect(controller.engine.actionResult.status).toBe('pending'); expect(controller.engine.running).toBe(false);
    receive({ type: 'spawn', entity: { ...monster, id: 3 } }); expect(controller.engine.actionResult.status).toBe('pending');
    packet(ownPacket({...player,sitting:false},2)); step();
    expect(controller.engine.actionResult.status).toBe('confirmed'); expect(controller.engine.running).toBe(true);
    expect(controller.engine.deaths).toBe(1);
  });
  it('resumes after an unsolicited refresh without falsely confirming respawn', () => {
    const { controller, receive, step } = setup(); controller.start(settings); step(); receive({ type: 'clear' });
    expect(controller.engine.actionResult.status).toBe('idle'); expect(controller.runRequested).toBe(true);
    receive({ type: 'spawn', entity: { ...player } }); step(); expect(controller.engine.running).toBe(true);
  });
  it('blocks field Start during a confirmed NPC interaction and resumes after it ends', () => {
    const { controller, packet, step } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false }); controller.start(settings);
    expect(controller.snapshot().state).toBe('waiting'); expect(controller.engine.running).toBe(false);
    packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); step(); expect(controller.engine.running).toBe(true);
  });
});

describe('latency and confirmation ownership', () => {
  it('reacts to an incoming packet immediately and starts the next action at 100 ms', () => {
    const { controller, sent, packet, step, receive } = setup(); controller.start(settings); step();
    receive({type:'spawn',entity:{...monster,id:3}});step();
    packet(new BitWriter().u8(OP.remove).i32(2).bool(false));
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 3 });
  });
  it('uses a short loot settling delay while preserving own-kill attribution', () => {
    const { controller, sent, receive, step } = setup(); controller.start(settings); step();
    receive({ type: 'death', id: 2 }, { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    step(100); expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    step(50); expect(sent.at(-1)).toEqual({ type: 'pickup', id: 9 }); step();
    expect(sent.filter(action => action.type === 'pickup')).toHaveLength(1);
  });
  it('credits a confirmed own targeted skill kill and permits its new loot', () => {
    const { controller, receive, sent, step } = setup(); const automation = policy();
    automation.skills = [{ skillId: 3, level: 1, target: 'enemy', hpBelowPercent: 100, spAbovePercent: 0, cooldownSeconds: 10 }];
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    controller.start({ ...settings, automation }); step(); expect(sent.at(-1)?.type).toBe('skill');
    receive({ type: 'skillResult', source: 1, target: 2, skillId: 3, level: 1, mode: 'target', indirect: false, motionSeconds: 0, position: { x: 100, y: 100 }, damage: 10 },
      { type: 'death', id: 2 }, { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    expect(controller.engine.kills).toBe(1); step(150); expect(sent.at(-1)).toEqual({ type: 'pickup', id: 9 });
  });
  it('never counts an indirect or foreign skill kill as its own', () => {
    const { controller, receive } = setup(); controller.start(settings);
    receive({ type: 'skillResult', source: 9, target: 2, skillId: 3, level: 1, mode: 'target', indirect: false, motionSeconds: 0, position: { x: 100, y: 100 } }, { type: 'death', id: 2 });
    expect(controller.engine.kills).toBe(0);
  });
  it('quarantines canceled world commands so a late response cannot confirm a replacement', () => {
    const { controller, packet, advance } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('command', { type: 'npcAdvance' }); controller.stop();
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late').bool(false));
    expect(controller.active).toBe(false); advance(10_000);
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('waits for skill motion before debiting and dispatching the next routine action', () => {
    const { controller, receive, sent, step, advance } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 2, level: 1 }] });
    controller.perform('routine', routine({ type: 'skill', mode: 'self', skillId: 2, level: 1 })); step();
    receive({ type: 'skillResult', source: 1, skillId: 2, level: 1, mode: 'self', indirect: false, motionSeconds: 2, position: { x: 100, y: 100 } });
    expect(controller.routine.snapshot().actionsIssued).toBe(1); advance(1900); expect(sent).toHaveLength(1);
    step(100); expect(sent).toHaveLength(2); expect(controller.routine.snapshot().actionsIssued).toBe(2);
  });
  it('expires the owning routine before sending its not-yet-started resource step', () => {
    const { controller, receive, sent, step } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'shopOpened', mode: 'buy', discountLevel: 0, entries: [{ itemId: 501, price: 10 }] });
    controller.perform('routine', routine({ type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] }, 1)); step(500); step(500);
    expect(sent).toEqual([]); expect(controller.routine.snapshot().state).toBe('failed'); expect(controller.workflow.snapshot().running).toBe(false);
  });
  it('rejects a distant manual skill and sends Stop for a canceled pending manual skill', () => {
    const { controller, receive, sent } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    controller.engine.entities.get(2)!.x = 110;
    expect(() => controller.perform('command', { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 })).toThrow('Move next');
    controller.engine.entities.get(2)!.x = 101;
    controller.perform('command', { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 }); controller.stop();
    expect(sent.map(action => action.type)).toEqual(['skill', 'stop']);
  });
  it.each(['canceled','confirmed motion'] as const)('accepts requested Start while retaining a %s skill fence',state=>{
    const {controller,receive,sent,step,advance}=setup();
    receive({type:'stats',level:7,hp:100,maxHp:100,sp:100,maxSp:100},{type:'skills',learned:[{skillId:3,level:1}]});
    controller.perform('command',{type:'skill',mode:'target',skillId:3,level:1,target:2});
    if(state==='canceled')controller.stop();
    else receive({type:'skillResult',source:1,target:2,skillId:3,level:1,mode:'target',indirect:false,motionSeconds:2,position:{x:100,y:100}});
    expect(controller.engine.pendingFeatureAction).toBeNull();expect(controller.engine.idleForActions()).toBe(false);
    expect(()=>controller.start(settings)).not.toThrow();expect(controller.runRequested).toBe(true);expect(controller.engine.running).toBe(false);
    const commands=sent.slice();advance(1900);expect(sent).toEqual(commands);expect(controller.engine.idleForActions()).toBe(false);
    if(state==='confirmed motion'){step(100);expect(controller.engine.running).toBe(true);step();expect(sent.at(-1)).toEqual({type:'attack',id:2});}
    else {controller.stop();expect(controller.runRequested).toBe(false);expect(controller.engine.idleForActions()).toBe(false);}
  });
  it('rejects a pending skill before mutating supply configuration or finite budgets',()=>{
    const {controller,receive}=setup();receive({type:'stats',level:7,hp:100,maxHp:100,sp:100,maxSp:100},{type:'skills',learned:[{skillId:3,level:1}]});
    controller.perform('command',{type:'skill',mode:'target',skillId:3,level:1,target:2});controller.engine.deaths=2;
    const configure=vi.spyOn(controller.supply,'configure');expect(()=>controller.start(settings)).toThrow('Stop the current');expect(configure).not.toHaveBeenCalled();expect(controller.engine.deaths).toBe(2);
  });
  it('sends Stop for a manual skill timeout even when the field engine was idle', () => {
    let now = 100_000; const sent: Action[] = []; const engine = new BotEngine(action => sent.push(action), () => now, () => grid);
    engine.connect(true); engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } },
      { type: 'spawn', entity: { ...monster } }, { type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] }]);
    engine.manualAction({ type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 }); now += 30_000; engine.tick();
    expect(sent.map(action => action.type)).toEqual(['skill', 'stop']);
  });
});

describe('persistent recovery and transaction regressions', () => {
  it('holds at the weight limit without a 100 ms Stop/restart storm', () => {
    const { controller, receive, sent, advance, step } = setup(); const automation = policy(); automation.limits.weightPercent = 50;
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, weight: 50, maxWeight: 100 });
    controller.start({ ...settings, automation }); advance(1000);
    expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true }); expect(sent).toEqual([]);
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, weight: 40, maxWeight: 100 }); step();
    expect(controller.engine.running).toBe(true); expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
  });
  it('backs off missing feature prerequisites without repeated Stop packets', () => {
    const { controller, sent, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 80, minStock: 0, cooldownSeconds: 1 }];
    controller.start({ ...settings, automation }); advance(1000);
    expect(controller.snapshot().state).toBe('waiting'); expect(sent.filter(action => action.type === 'stop')).toHaveLength(1);
  });
  it('does not resume a retained run on a different character', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings); step(); controller.disconnect(); controller.connect(true);
    receive({ type: 'enter', id: 9, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player, id: 9, name: 'Other' } }, { type: 'spawn', entity: { ...monster } }); step();
    expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(1);
    expect(controller.snapshot().reason).toContain('originally selected character');
  });
  it('resumes a canceled sit after the existing deadline without a permanent resource hold', () => {
    const { controller, receive, sent, step, advance } = setup(); const automation = policy(); automation.recovery.enabled = true;
    receive({ type: 'stats', level: 7, hp: 55, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 1, level: 2 }] });
    controller.start({ ...settings, automation }); step(); expect(sent.at(-1)).toEqual({ type: 'sit', sitting: true });
    controller.pause('Manual input', 2000); receive({ type: 'sit', id: 1, sitting: true }); advance(6000);
    expect(controller.engine.running).toBe(true); expect(controller.snapshot().reason).not.toContain('Stop and Start');
    expect(sent.filter(action => action.type === 'sit')).toHaveLength(1);
  });
  it('drains a late consumed-item receipt and respects its cooldown before continuing', () => {
    const { controller, receive, sent, packet, step, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 10 }];
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); step(); controller.pause('Manual input', 2000);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(10).bool(false));
    advance(9000); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    // Fresh HP update confirms the policy no longer needs another consumable.
    automation.items[0]!.belowPercent = 90;
    controller.engine.player!.hp = 100; controller.stop();
    expect(controller.runRequested).toBe(false);
  });
  it.each([false,true])('retains the shared HP potion cooldown after a late receipt with advanced rule=%s', advanced => {
    const { controller, receive, sent, packet, step, advance } = setup(); const automation = policy();
    automation.hpPotions = { mode: 'selected', itemIds: advanced ? [504] : [501, 504], belowPercent: 60, minStock: 0, cooldownSeconds: 10 };
    if(advanced)automation.items=[{itemId:501,resource:'hp',belowPercent:60,minStock:0,cooldownSeconds:1}];
    receive({ type: 'stats', level: 7, hp: 55, maxHp: 100 },
      { type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 1 }, { bagId: 504, itemId: 504, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); step(); controller.pause('Manual input', 2000);
    advance(7000); expect(sent.filter(action => action.type === 'useItem')).toEqual([{ type: 'useItem', itemId: 501 }]);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(10).bool(false));
    advance(9000); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    advance(2000); expect(sent.filter(action => action.type === 'useItem')).toEqual([{ type: 'useItem', itemId: 501 }, { type: 'useItem', itemId: 504 }]);
  });
  it('does not reopen an unresolved NPC request just because ten seconds elapsed', () => {
    const { controller, advance, packet } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('command', { type: 'npcAdvance' }); controller.stop(); advance(10_100);
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late').bool(false));
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('keeps the desired lock-map return through low HP and manual yielding', () => {
    const { controller, receive, step, packet } = setup(); const automation = policy(); automation.respawn.enabled = true; automation.travel.returnToLockMap = true;
    controller.start({ ...settings, automation }); step(); receive({ type: 'death', id: 1 });
    const travelStart = vi.spyOn(controller.travel, 'start').mockImplementation(() => {});
    packet(new BitWriter().u8(OP.map).string('prontera'));packet(ownPacket({...player,hp:20,sitting:false},1));
    controller.pause('Manual input', 2000); receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 });
    step(2000); expect(travelStart).toHaveBeenLastCalledWith('prontera', expect.anything(), 'prt_fild08', settings.route_step, settings.route_avoidWalls, DEFAULT_MAP_POLICY,'return');
    expect(controller.engine.running).toBe(false);
  });
  it('lets a 12-second manual or routine skill finish before its 30-second deadline', () => {
    const { controller, receive, sent, step, advance } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 2, level: 1 }] });
    controller.perform('routine', routine({ type: 'skill', mode: 'self', skillId: 2, level: 1 }, 60)); step(); advance(12_000);
    expect(controller.routine.snapshot()).toMatchObject({ state: 'waiting', actionsIssued: 1 });
    expect(sent).toHaveLength(1);
    receive({ type: 'skillResult', source: 1, skillId: 2, level: 1, mode: 'self', indirect: false, motionSeconds: 2, position: { x: 100, y: 100 } });
    expect(controller.routine.snapshot().actionsCompleted).toBe(1);
  });
  it('uses the existing owned travel path to leave a verified portal arrival', () => {
    const sent: Action[] = [];
    const portalGrid = { ...grid, portals: [{ x: 100, y: 100, halfWidth: 1, halfHeight: 1 }] };
    const controller = new CompanionController(action => sent.push(action as Action), () => 100_000, () => portalGrid);
    controller.connect(true); controller.engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }]);
    controller.world.reset('prt_fild08'); const start = vi.spyOn(controller.travel, 'start').mockImplementation(() => {});
    controller.start(settings); expect(start).toHaveBeenCalledWith('prt_fild08', expect.anything(), 'prt_fild08', settings.route_step, settings.route_avoidWalls,DEFAULT_MAP_POLICY);
    expect(sent).toEqual([]);
  });
  it('does not credit another character finishing a monster after an own nonlethal skill', () => {
    const { controller, receive, sent, step } = setup(); const automation = policy();
    automation.skills = [{ skillId: 3, level: 1, target: 'enemy', hpBelowPercent: 100, spAbovePercent: 0, cooldownSeconds: 10 }];
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    controller.start({ ...settings, automation }); step();
    receive({ type: 'skillResult', source: 1, target: 2, skillId: 3, level: 1, mode: 'target', indirect: false, motionSeconds: 0, position: { x: 100, y: 100 }, damage: 1 },
      { type: 'skillImpact', source: 9, target: 2, skillId: 3, position: { x: 101, y: 100 }, damage: 10, damageSeconds: 0, hits: 1, result: 0 },
      { type: 'death', id: 2 }, { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    step(150); expect(controller.engine.kills).toBe(0); expect(sent.some(action => action.type === 'pickup')).toBe(false);
  });
  it('confirms a vendor response with an owner ID distinct from its visible proxy without a focus packet', () => {
    const { controller, packet } = setup(); controller.engine.actors.set(7, { ...player, id: 7, kind: 2 });
    controller.perform('command', { type: 'vendingView', id: 7 });
    packet(new BitWriter().u8(WORLD_OP.vendingView).i32(999).string('Vendor').i32(0));
    expect(controller.active).toBe(false); expect(controller.world.viewedVending?.id).toBe(999);
  });
  it('confirms an exact vendor receipt when NPC end precedes inventory and balance updates', () => {
    const { controller, receive, packet } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'vendingViewed', id: 999, name: 'Vendor', entries: [{ item: { bagId: 501, itemId: 501, type: 1, count: 5 }, price: 10 }] });
    controller.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 2 }] });
    packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); expect(controller.active).toBe(true);
    controller.engine.receive([{ type: 'inventoryDelta', add: true, bagId: 501, change: 2, weight: 10, item: { bagId: 501, itemId: 501, type: 1, count: 2 } }, { type: 'currency', zeny: 80 }]);
    controller.receive(Uint8Array.of(200)); expect(controller.active).toBe(false); expect(controller.engine.reason).toContain('confirmed');
  });
  it('confirms a unique cart deposit with a new destination bag ID and matching GUID', () => {
    const { controller, receive, packet } = setup(); const guid = '000102030405060708090a0b0c0d0e0f';
    receive({ type: 'inventory', items: [{ bagId: 10001, itemId: 1101, type: 2, count: 1, guid }], cart: [], equipment: [], ammoId: -1 }, { type: 'skills', learned: [{ skillId: 73, level: 1 }] });
    controller.world.replaceCart([]); controller.perform('command', { type: 'cart', direction: 1, bagId: 10001, count: 1 });
    const moved = new BitWriter().u8(WORLD_OP.cart).u8(1).i32(10002).u8(2).i32(1101).i16(1).u8(0).u8(0).take(Uint8Array.from({ length: 16 }, (_, i) => i));
    for (let i = 0; i < 4; i++) moved.i32(0);
    packet(moved.i16(1).i32(100).i32(0)); expect(controller.active).toBe(true);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(10001).i16(1).i32(0).bool(false));
    expect(controller.active).toBe(false); expect(controller.world.cart.get(10002)?.guid).toBe(guid);
  });
});

describe('canceled world receipt reconciliation', () => {
  it('drains a canceled vendor-view response using its retained proxy ownership', () => {
    const { controller, packet, advance } = setup(); controller.engine.actors.set(7, { ...player, id: 7, kind: 2 });
    controller.perform('command', { type: 'vendingView', id: 7 }); controller.stop();
    packet(new BitWriter().u8(WORLD_OP.vendingView).i32(999).string('Vendor').i32(0));
    advance(10_000); controller.world.apply({ type: 'npcEnd' });
    expect(() => controller.perform('command', { type: 'vendingView', id: 7 })).not.toThrow();
  });
  it('drains canceled cart ownership only after its matching transfer and source decrease', () => {
    const { controller, receive, packet, advance } = setup();
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], cart: [], equipment: [], ammoId: -1 }, { type: 'skills', learned: [{ skillId: 73, level: 1 }] });
    controller.world.replaceCart([]); controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 }); controller.stop();
    packet(new BitWriter().u8(WORLD_OP.cart).u8(1).i32(501).u8(1).i32(501).i16(1).i16(1).i32(10).i32(30));
    advance(10_000); expect(() => controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 })).toThrow();
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(30).bool(false));
    expect(() => controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 })).not.toThrow();
  });
  it('drains a canceled vending purchase using its captured exact receipt', () => {
    const { controller, receive, advance } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'vendingViewed', id: 999, name: 'Vendor', entries: [{ item: { bagId: 501, itemId: 501, type: 1, count: 5 }, price: 10 }] });
    controller.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 1 }] }); controller.stop(); advance(10_000);
    controller.engine.receive([{ type: 'inventoryDelta', add: true, bagId: 501, change: 1, weight: 10, item: { bagId: 501, itemId: 501, type: 1, count: 1 } }, { type: 'currency', zeny: 90 }]);
    controller.receive(Uint8Array.of(200));
    expect(() => controller.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 1 }] })).not.toThrow();
  });
});

describe('world retirement and heartbeat deadline regressions', () => {
  it('keeps a confirmed consumable cooldown through the real one-second heartbeat cadence', () => {
    const { controller, receive, sent, packet, step, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 10 }];
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); step(); advance(6000);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(30).bool(false));
    for (let second = 0; second < 9; second++) { controller.heartbeat(true); advance(1000); }
    controller.heartbeat(true); advance(900); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    advance(100); step(); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(2);
  });
  it('keeps prerequisite retry backoff while the client heartbeat remains healthy', () => {
    const { controller, sent, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 80, minStock: 0, cooldownSeconds: 1 }];
    controller.start({ ...settings, automation }); advance(100);
    for (let second = 0; second < 4; second++) { controller.heartbeat(true); advance(1000); }
    expect(sent.filter(action => action.type === 'stop')).toHaveLength(1); expect(controller.engine.running).toBe(false);
  });
  it('retires a normally timed-out world request until its late response drains', () => {
    const { controller, advance, packet } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('command', { type: 'npcAdvance' }); advance(10_100);
    expect(controller.active).toBe(false);
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late first response').bool(false));
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('retires a sent workflow after failure, even when it has no manual pending wrapper', () => {
    const { controller, receive, step, advance, packet } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true }); controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('workflow', { name: 'Dialog', map: settings.map, npcId: 7, maxSpend: 0, minStock: [], steps: [{ type: 'advance' }] });
    step(); advance(10_100); expect(controller.workflow.snapshot().state).toBe('failed');
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late workflow response').bool(false));
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('retires a sent one-step resource workflow after its unconfirmed timeout', () => {
    const { controller, receive, step, advance, packet } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'shopOpened', mode: 'buy', discountLevel: 0, entries: [{ itemId: 501, price: 10 }] });
    controller.perform('command', { type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] }); step(); advance(10_100);
    expect(() => controller.perform('command', { type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); controller.start(settings);
    expect(controller.runRequested).toBe(true);
  });
  it('retains sent world ownership when its parent routine duration ends', () => {
    const { controller, step, packet } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('routine', routine({ type: 'npcAdvance' }, 1)); step(500); step(500);
    expect(controller.routine.snapshot().state).toBe('failed');
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late routine response').bool(false));
    // The original ten-second fence still applies even though the receipt drained.
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
  });
  it('does not create uncertain ownership for a queued resource step that was never sent', () => {
    const { controller, receive, step, packet, sent } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'shopOpened', mode: 'buy', discountLevel: 0, entries: [{ itemId: 501, price: 10 }] });
    controller.perform('routine', routine({ type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] }, 1)); step(500); step(500);
    expect(sent).toEqual([]); packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); controller.start(settings);
    expect(controller.engine.running).toBe(true);
  });
  it('captures Start as waiting behind a canceled cart fence and resumes after the exact late receipt', () => {
    const { controller, receive, packet, advance, step, sent } = setup();
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], cart: [], equipment: [], ammoId: -1 }, { type: 'skills', learned: [{ skillId: 73, level: 1 }] });
    controller.world.replaceCart([]); controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 }); controller.stop();
    expect(() => controller.start(settings)).not.toThrow(); expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true });
    packet(new BitWriter().u8(WORLD_OP.cart).u8(1).i32(501).u8(1).i32(501).i16(1).i16(1).i32(10).i32(30));
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(30).bool(false));
    expect(controller.engine.running).toBe(false); advance(10_000); step();
    expect(controller.engine.running).toBe(true); expect(sent.filter(action => action.type === 'attack')).toHaveLength(1);
    expect(sent.filter(action => action.type === 'cart')).toHaveLength(1);
  });
  it('still rejects Start while a manual command is actively awaiting its first result', () => {
    const { controller } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false }); controller.perform('command', { type: 'npcAdvance' });
    expect(() => controller.start(settings)).toThrow('Stop the current'); expect(controller.runRequested).toBe(false);
  });
});

describe('routine actor observations',()=>{
 it('passes typed cast evidence into routine decisions and ignores a superseded socket',()=>{
  const {controller,sent,receive,step,packet}=setup();
  receive({type:'spawn',entity:{...player,statuses:[]}});
  controller.perform('routine',{name:'Wait for idle cast',durationSeconds:30,maxActions:1,rules:[{name:'Stand',priority:0,cooldownSeconds:1,maxRuns:1,conditions:[{field:'actorCasting',actor:{scope:'self'},operator:'ne',value:true}],action:{type:'sit',sitting:false}}]});
  step();expect(sent).toEqual([]);
  packet(new BitWriter().u8(27).i32(1));step();expect(sent).toEqual([{type:'sit',sitting:false}]);
  controller.disconnect();controller.connect(true);
  controller.receive(new BitWriter().u8(27).i32(1).finish(),0);expect(controller.engine.snapshot().actorObservations.actors).toEqual([]);
 });
});

describe('persistent ammo and loadout receipts',()=>{
  function loadoutFixture(){const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.cooldownSeconds=1;automation.loadout.minAmmoStock=3;
    t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
    const inventory:FeatureEvent={type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:-1};
    t.receive(inventory);return {...t,automation,inventory};
  }
  it('keeps emergency escape behind an uncertain equipment receipt until exact reconciliation',()=>{
    const t=loadoutFixture();
    t.automation.escape={...DEFAULT_ESCAPE,enabled:true};
    t.receive({...t.inventory,items:[...t.inventory.items,{bagId:601,itemId:601,type:1,count:3}]});
    t.controller.start({...settings,automation:t.automation});t.step();
    expect(t.sent).toEqual([{type:'equip',bagId:1750,equipped:true}]);
    t.advance(7000);t.receive({type:'heal',id:1,hp:10,maxHp:100});t.advance(400);
    expect(t.controller.engine.featureActionsSettled).toBe(false);
    expect(t.sent.some(action=>action.type==='useItem')).toBe(false);
    t.receive({type:'equipment',bagId:1750,equipped:true,slot:13});t.advance(400);
    expect(t.sent.filter(action=>action.type==='equip')).toHaveLength(1);
    expect(t.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
  });
  it('never replays an unconfirmed automatic equip through persistent resume, deadlines, unchanged snapshots or map refresh',()=>{
    const t=loadoutFixture();t.controller.start({...settings,automation:t.automation});t.step();expect(t.sent).toEqual([{type:'equip',bagId:1750,equipped:true}]);
    t.advance(12000);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.controller.engine.snapshot().loadout.state).toBe('fault');
    t.receive(t.inventory);t.advance(3000);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);
    t.receive({type:'map',map:'prt_fild05'},{type:'spawn',entity:{...player,classId:5,level:50}},{type:'spawn',entity:{...monster}});t.advance(3000);
    expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);
    t.packet(new BitWriter().u8(OP.equipment).i32(1750).u8(13).bool(true));t.step();t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('keeps manual equipment overrides stopped until a new explicit Start',()=>{
    const t=loadoutFixture();t.controller.start({...settings,automation:t.automation});t.step();t.receive({type:'equipment',bagId:1750,slot:13,equipped:true});t.step();
    t.receive({type:'equipment',bagId:1750,slot:13,equipped:false});t.receive({type:'changeTarget',id:0});const count=t.sent.length;t.advance(6000);
    expect(t.sent).toHaveLength(count);expect(t.controller.engine.running).toBe(false);
    t.controller.stop();t.controller.start({...settings,automation:t.automation});t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(2);
  });
  it('does not admit unrelated ServerEvent ammo faults while loadout policy is disabled',()=>{
    const t=setup();t.receive({type:'serverEvent',event:4,value:0,text:''});expect(t.controller.engine.idleForActions()).toBe(true);expect(t.controller.engine.snapshot().loadout.state).toBe('off');
    t.controller.start(settings);t.step();expect(t.sent).toEqual([{type:'attack',id:2}]);
  });
  it('holds a fired reserve until both target clear and a new valid stock receipt, with no auto equip fallback',()=>{
    const t=loadoutFixture();t.inventory={...t.inventory,type:'inventory',ammoId:1750} as Extract<FeatureEvent,{type:'inventory'}>;t.receive(t.inventory);t.controller.start({...settings,automation:t.automation});t.step();
    t.receive({type:'inventoryDelta',add:false,bagId:1750,change:17,weight:0});t.receive({type:'changeTarget',id:0});t.advance(6000);
    expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(0);
    t.packet(new BitWriter().u8(OP.inventoryDelta).bool(true).u8(1).i32(1750).i16(17).i32(0).i32(1750).i16(20));t.step();
    expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(2);
  });
});
describe('loadout manual-yield intent',()=>{
 it('keeps an observation baseline during pointer yield, so manual equipment cancels automatic override until explicit Start',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.autoAmmo=false;automation.equipment=[{itemId:1701,hpBelowPercent:100,monsterClassId:0}];
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  t.receive({type:'inventory',items:[{bagId:1001,itemId:1101,type:2,count:1,guid:'sword'},{bagId:1002,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:1750});
  t.controller.start({...settings,automation});t.step();t.receive({type:'equipment',bagId:1001,slot:4,equipped:false},{type:'equipment',bagId:1002,slot:4,equipped:true});
  t.controller.pause('Yielding briefly to manual game input.',2000);
  t.receive({type:'equipment',bagId:1002,slot:4,equipped:false},{type:'equipment',bagId:1001,slot:4,equipped:true},{type:'changeTarget',id:0});t.advance(7000);
  expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1002,equipped:true}]);expect(t.controller.engine.running).toBe(false);
  t.controller.stop();t.controller.start({...settings,automation});t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(2);
 });
 it('selects a fresh compatible alternate stack only after target clear and waits for slot13 before a new attack',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.minAmmoStock=3;automation.loadout.cooldownSeconds=1;
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  const inventory:Extract<FeatureEvent,{type:'inventory'}>={type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:4}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:1750};
  t.receive(inventory);t.controller.start({...settings,automation});t.step();
  t.receive({type:'inventoryDelta',add:false,bagId:1750,change:1,weight:0});t.advance(6000);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(0);
  t.packet(new BitWriter().u8(OP.inventoryDelta).bool(true).u8(1).i32(1751).i16(20).i32(0).i32(1751).i16(20));t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(0);
  t.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));t.step();expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1751,equipped:true}]);expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  t.packet(new BitWriter().u8(OP.equipment).i32(1751).u8(13).bool(true));t.step();expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(2);
 });
});
describe('late manual equipment receipts',()=>{
 it('retains the observation baseline through persistent resume when a manual gear ACK arrives after the input yield',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.autoAmmo=false;automation.equipment=[{itemId:1701,hpBelowPercent:100,monsterClassId:0}];
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  t.receive({type:'inventory',items:[{bagId:1001,itemId:1101,type:2,count:1,guid:'sword'},{bagId:1002,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:1750});
  t.controller.start({...settings,automation});t.step();t.receive({type:'equipment',bagId:1001,slot:4,equipped:false},{type:'equipment',bagId:1002,slot:4,equipped:true});
  t.controller.pause('Yielding briefly to manual game input.',2000);t.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));t.advance(2500);
  expect(t.controller.engine.running).toBe(true);
  t.receive({type:'equipment',bagId:1002,slot:4,equipped:false},{type:'equipment',bagId:1001,slot:4,equipped:true},{type:'changeTarget',id:0});t.advance(7000);
  expect(t.controller.engine.running).toBe(false);expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1002,equipped:true}]);
 });
});
describe('loadout receipt survival through external revival',()=>{
 it('preserves an in-flight equip fence through death/resurrection until exact late readback, without resending',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.minAmmoStock=3;
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  t.receive({type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:-1});
  t.controller.start({...settings,automation});t.step();expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1750,equipped:true}]);
  t.receive({type:'death',id:1});t.receive({type:'resurrection',id:1,hp:100,position:{x:100,y:100}});t.advance(12000);
  expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.controller.engine.running).toBe(false);expect(t.controller.engine.snapshot().loadout.state).toBe('fault');
  t.packet(new BitWriter().u8(OP.equipment).i32(1750).u8(13).bool(true));t.step();t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);
 });
});

describe('maintenance settlement',()=>{
 it('admits a quiet connected own-zero-capable world while resource receipts and run intent still block',()=>{
  const f=setup();expect(f.controller.settledForMaintenance()).toBe(true);f.advance(20_000);expect(f.controller.settledForMaintenance()).toBe(true);
  f.controller.start(settings);expect(f.controller.settledForMaintenance()).toBe(false);f.controller.stop();f.advance(5000);expect(f.controller.settledForMaintenance()).toBe(true);
  f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100));
  f.controller.engine.receive([{type:'inventory',items:[{bagId:501,itemId:501,type:1,count:2}],equipment:Array(10).fill(0),ammoId:-1}]);
  f.controller.perform('command',{type:'useItem',itemId:501});expect(f.controller.settledForMaintenance()).toBe(false);f.advance(15000);expect(f.controller.settledForMaintenance()).toBe(false);
 });
 it('never admits an unacknowledged physical Walk after Stop and timer expiry',()=>{
  const f=setup();f.controller.perform('command',{type:'manualTarget',command:{type:'walk',destination:{x:105,y:100}},owner:f.controller.engine.manualActorIdentity(1),map:'prt_fild08',policy:manualTargetPolicy(settings),timeoutSeconds:10});f.step();expect(f.sent.some(a=>a.type==='walk')).toBe(true);f.controller.stop();f.advance(10000);expect(f.controller.settledForMaintenance()).toBe(false);
 });
});


describe('macro controller supervision',()=>{
  const farm:MacroStep={type:'farm',map:'prt_fild08',targets:[4000],timeoutSeconds:30};
  const script=(steps:MacroStep[]=[farm],extra:MacroScript['rules']=[]):MacroScript=>({version:1,name:'Training',durationSeconds:120,maxActions:20,maxSpend:1000,
    rules:[...extra,{name:'Initial field',priority:0,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:1}],steps}]});
  function fixture(){const f=setup();f.controller.engine.receive([{type:'remove',id:2,dead:false},{type:'inventory',items:[{bagId:501,itemId:501,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1},
    {type:'stats',level:7,jobLevel:3,hp:100,maxHp:100,sp:100,maxSp:100,zeny:1000,weight:50,maxWeight:1000}]);return f;}
  const macro=(f:ReturnType<typeof fixture>,value=script(),input=settings)=>f.controller.perform('macro',{script:value,settings:input});
  it('starts unlimited field supervision and preserves run counters through manual input until Stop',()=>{
    const f=fixture();macro(f,{...script(),durationSeconds:0,maxActions:0});
    f.controller.engine.kills=5;f.controller.engine.looted=4;f.controller.engine.deaths=1;
    f.controller.manualCommand();f.step();
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true,kills:5,looted:4,deaths:1,
      macro:{state:'monitoring',actionsIssued:1,actionsCompleted:1}});
    f.controller.stop();const count=f.sent.length;f.step(1000);
    expect(f.controller.snapshot()).toMatchObject({runRequested:false,running:false,macro:{state:'cancelled'}});
    expect(f.sent).toHaveLength(count);
  });
  it('retains configured field kill limits while macro counts are unlimited',()=>{
    const f=fixture(),automation=policy();automation.limits.kills=2;
    macro(f,{...script(),durationSeconds:0,maxActions:0},{...settings,automation});
    f.controller.engine.kills=2;f.step();f.controller.manualCommand();f.step();
    expect(f.controller.engine.running).toBe(false);
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,kills:2,
      macro:{state:'monitoring',actionsIssued:1,actionsCompleted:1}});
    expect(f.controller.snapshot().reason).toContain('Configured session limit reached');
  });
  it('keeps finite uncertain-item deadlines and never replays an unlimited repeating rule',()=>{
    const f=fixture(),value=script([{type:'useItem',itemId:501,timeoutSeconds:10}]);
    value.durationSeconds=0;value.maxActions=0;value.rules[0]!.maxRuns=0;macro(f,value);
    f.advance(11000);
    expect(f.controller.snapshot()).toMatchObject({runRequested:false,running:false,macro:{state:'failed'}});
    expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
    expect(f.controller.settledForMaintenance()).toBe(false);
  });
  it('keeps the same macro and run allowances when official gameplay input arrives',()=>{
    const f=fixture();macro(f);f.controller.engine.kills=5;f.controller.engine.looted=4;
    const before=f.controller.macro.snapshot();f.controller.manualCommand();f.step();
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true,kills:5,looted:4,
      macro:{state:'monitoring',actionsIssued:before.actionsIssued,actionsCompleted:before.actionsCompleted}});
    expect(f.sent.filter(a=>a.type==='stop')).toEqual([]);
  });
  it('keeps the original macro deadline through official input and a same-character field refresh',()=>{
    const f=fixture(),value={...script(),durationSeconds:5};macro(f,value);
    f.controller.engine.deaths=1;f.controller.engine.kills=7;f.controller.engine.looted=4;
    f.advance(1500);f.controller.manualCommand();f.packet(new BitWriter().u8(OP.clear));f.packet(ownPacket({...player},2));
    for(let i=0;i<20;i++){f.controller.manualInput();f.step(100);}
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,running:true,deaths:1,kills:7,looted:4,
      macro:{state:'monitoring',actionsIssued:1,actionsCompleted:1}});
    f.advance(1500);expect(f.controller.snapshot()).toMatchObject({runRequested:false,running:false,macro:{state:'completed'}});
    expect(f.controller.snapshot().macro.reason).toBe('Macro duration reached.');
  });
  it('does not let a foreign own replacement resume retained macro field intent',()=>{
    const f=fixture();macro(f);f.controller.manualCommand();f.packet(new BitWriter().u8(OP.clear));
    f.packet(ownPacket({...player,name:'Other character'},2));
    expect(f.controller.snapshot()).toMatchObject({runRequested:false,running:false,macro:{state:'failed'}});
  });
  it('keeps a physical macro trip through official Stop before replacement movement without replaying a leg',()=>{
    let now=100_000;const sent:Array<Action|ControllerAction>=[],c=new CompanionController(a=>sent.push(a),()=>now);
    const own={...player,x:170,y:370},packet=(w:BitWriter)=>c.receive(w.finish());
    c.connect(true);packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08'));packet(ownPacket(own,1));
    c.perform('macro',{settings,script:script([{type:'travel',map:'prontera',timeoutSeconds:30}])});
    expect(sent.filter(a=>a.type==='walk')).toHaveLength(1);const trip=c.travel.tripId;c.manualCommand(true);
    packet(new BitWriter().u8(OP.stop).i32(1));
    packet(new BitWriter().u8(OP.walk).i32(1).position(own).f32(own.x).f32(own.y).f32(.1).f32(.1).u8(2).u8(0x20).u8(0));
    for(let i=0;i<10;i++){now+=100;c.tick();}
    expect(c.travel.tripId).toBe(trip);expect(c.macro.snapshot()).toMatchObject({state:'waiting',actionsIssued:1,actionsCompleted:0});
    expect(sent.filter(a=>a.type==='stop')).toEqual([]);expect(sent.filter(a=>a.type==='walk').length).toBeGreaterThan(1);
    c.stop();const count=sent.length;now+=1000;c.tick();expect(sent).toHaveLength(count);expect(c.macro.snapshot().state).toBe('cancelled');
  });
  it('requires exact request fields, ready idle ownership and compatible map policy',()=>{
    const f=fixture();expect(()=>f.controller.perform('macro',{script:script(),settings,raw:true})).toThrow('exactly');
    const automation=policy();automation.follow={...automation.follow,mode:'partyLeader'};
    expect(()=>macro(f,script(),{...settings,automation})).toThrow('Party leader');
    automation.follow.mode='name';automation.mapPolicy={...DEFAULT_MAP_POLICY,lockArea:{map:'prontera',minX:95,maxX:105,minY:95,maxY:105}};
    expect(()=>macro(f,script(),{...settings,map:'prontera',automation})).toThrow('lock area');
    f.controller.start(settings);expect(()=>macro(f)).toThrow();
  });
  it('acknowledges a farm only after projected engine activation and stops it at the global deadline',()=>{
    const f=fixture(),input=structuredClone(settings);macro(f,script(),input);
    expect(f.controller.snapshot()).toMatchObject({runRequested:true,macro:{state:'monitoring',actionsCompleted:1},running:true});
    expect(f.controller.engine.running).toBe(true);expect(f.controller.engine.settings.targets).toEqual([4000]);
    input.targets=[9999];expect(f.controller.engine.settings.targets).toEqual([4000]);
    f.advance(120000);expect(f.controller.snapshot()).toMatchObject({runRequested:false,macro:{state:'completed'}});expect(f.controller.engine.running).toBe(false);
    expect(f.controller.settledForMaintenance()).toBe(true);
  });
  it('leaves farm activation unconfirmed while the HP guard blocks the field',()=>{
    const f=fixture();f.controller.engine.player!.hp=40;macro(f);
    expect(f.controller.macro.snapshot()).toMatchObject({actionsCompleted:0,pendingActionId:1});expect(f.controller.engine.running).toBe(false);
    f.advance(30000);expect(f.controller.macro.snapshot().state).toBe('failed');expect(f.controller.runRequested).toBe(false);
  });
  it('reacts to level changes while a field is running and preserves the run counters across farms',()=>{
    const f=fixture(),next:MacroScript['rules'][number]={name:'Next field',priority:100,cooldownSeconds:0,maxRuns:1,
      conditions:[{field:'level',operator:'gte',value:8}],steps:[{...farm,targets:[1002]}]};
    macro(f,script([farm],[next]));f.controller.engine.deaths=1;f.controller.engine.kills=5;f.controller.engine.looted=4;
    f.controller.engine.player!.level=8;f.step();
    expect(f.controller.macro.snapshot()).toMatchObject({actionsCompleted:2,sequencesCompleted:2,state:'monitoring'});
    expect(f.controller.engine.settings.targets).toEqual([1002]);expect(f.controller.snapshot()).toMatchObject({deaths:1,kills:5,looted:4});
    expect(f.sent.filter(action=>action.type==='stop')).toHaveLength(1);
  });
  it.each(['level','jobLevel'] as const)('reacts to a source-shaped %s update without changing player state directly',field=>{
    const f=fixture(),next:MacroScript['rules'][number]={name:'Next level',priority:100,cooldownSeconds:0,maxRuns:1,
      conditions:[{field,operator:'gte',value:field==='level'?8:4}],steps:[{...farm,targets:[4012]}]};
    const stats=(level:number,jobLevel:number)=>{
      const w=new BitWriter().u8(56);
      for(const value of [level,jobLevel,500,3,4,5,6,7,8,2,10,123])w.i32(value);
      for(const value of [100,100,50,50,...Array(16).fill(1),2000])w.i32(value);
      return w.f32(.5).i32(125).i32(0).bool(false).bool(false);
    };
    f.packet(stats(7,3));macro(f,script([farm],[next]));expect(f.controller.macro.snapshot().actionsCompleted).toBe(1);
    f.packet(stats(field==='level'?8:7,field==='jobLevel'?4:3));
    expect(f.controller.macro.snapshot()).toMatchObject({state:'monitoring',actionsCompleted:2});
    expect(f.controller.engine.settings.targets).toEqual([4012]);
    f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(40).i32(50));
    expect(f.controller.engine.player?.level).toBe(field==='level'?8:7);
    expect(f.controller.engine.character.stats?.jobLevel).toBe(field==='jobLevel'?4:3);
    expect(f.controller.macro.snapshot().actionsCompleted).toBe(2);
  });
  it('drains a selected reactive item receipt, then restores the captured farm without renewing session limits',()=>{
    const f=fixture(),automation=policy();automation.limits.kills=3;
    const reactive:MacroScript['rules'][number]={name:'Heal',priority:100,cooldownSeconds:0,maxRuns:1,conditions:[{field:'hpPercent',operator:'lt',value:90}],
      steps:[{type:'useItem',itemId:501,timeoutSeconds:20}]};
    macro(f,script([farm],[reactive]),{...settings,automation});f.controller.engine.player!.hp=80;f.step();
    expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);expect(f.controller.engine.running).toBe(false);
    f.step();expect(f.controller.macro.snapshot().actionsCompleted).toBe(1);
    f.packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(40).bool(false));f.advance(1100);
    expect(f.controller.macro.snapshot()).toMatchObject({actionsCompleted:2,fieldIntentActive:true,fieldSuspended:false});expect(f.controller.engine.running).toBe(true);
    f.controller.engine.kills=3;f.step();expect(f.controller.engine.running).toBe(false);expect(f.controller.snapshot().reason).toContain('session limit');
  });
  it('stops a stationary normal attack once before admitting a reactive potion while the monster is alive',()=>{
    const f=fixture(),reactive:MacroScript['rules'][number]={name:'Attack heal',priority:100,cooldownSeconds:0,maxRuns:1,conditions:[{field:'hpPercent',operator:'lt',value:90}],
      steps:[{type:'useItem',itemId:501,timeoutSeconds:20}]};
    macro(f,script([farm],[reactive]));f.controller.engine.receive([{type:'spawn',entity:{...monster}}]);f.step();
    expect(f.sent).toContainEqual({type:'attack',id:2});expect(f.controller.engine.stationaryForCastAvailability()).toBe(false);
    f.packet(new BitWriter().u8(OP.attack).i32(1).i32(2).i32(0).position(player));f.controller.engine.player!.hp=40;f.step();
    expect(f.sent.filter(action=>action.type==='stop')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
    expect(f.controller.engine.entities.get(2)?.dead).toBe(false);expect(f.controller.macro.snapshot()).toMatchObject({state:'waiting',actionsCompleted:1});
  });
  it('continues an existing supply owner while a reactive macro step waits for handoff',()=>{
    const f=fixture(),reactive:MacroScript['rules'][number]={name:'Supply response',priority:100,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:8}],
      steps:[{type:'useItem',itemId:501,timeoutSeconds:20}]};
    macro(f,script([farm],[reactive]));
    let owns=true,visits=0;
    // The real supply executor retains its intent; only its already-active ownership and empty next intent are isolated here.
    vi.spyOn(f.controller.supply,'ownsField','get').mockImplementation(()=>owns);
    vi.spyOn(f.controller.supply,'uncertain','get').mockReturnValue(false);
    vi.spyOn(f.controller.supply,'resumeIntent').mockImplementation(()=>{visits++;return null;});
    vi.spyOn(f.controller.supply,'next').mockReturnValue(null);
    f.controller.engine.player!.level=8;f.step();expect(visits).toBe(1);expect(f.sent.filter(action=>action.type==='useItem')).toEqual([]);
    expect(f.controller.macro.snapshot().pendingActionId).not.toBeNull();owns=false;f.step();
    expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
  });
  it.each(['accepted','unacknowledged','locked','foreign'] as const)('keeps a reactive item behind %s shortened field movement until authoritative settlement',receipt=>{
    const random=vi.spyOn(Math,'random').mockReturnValue(.7);
    try {
      const f=fixture(),reactive:MacroScript['rules'][number]={name:'Walking response',priority:100,cooldownSeconds:0,maxRuns:1,
        conditions:[{field:'elapsedSeconds',operator:'gte',value:5}],steps:[{type:'useItem',itemId:501,timeoutSeconds:10}]};
      macro(f,script([farm],[reactive]),{...settings,route_randomWalk:2});f.step();
      const requested=f.sent.find(action=>action.type==='walk');expect(requested?.type).toBe('walk');
      const cells=f.controller.engine.snapshot().navigation!.leg.slice(0,2);
      expect(cells).toHaveLength(2);expect(cells.at(-1)).not.toEqual(requested?.type==='walk'?requested.destination:null);
      const offsets=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
      const direction=offsets.findIndex(([x,y])=>cells[1]!.x-cells[0]!.x===x&&cells[1]!.y-cells[0]!.y===y);
      if(receipt!=='unacknowledged')f.packet(new BitWriter().u8(OP.walk).i32(receipt==='foreign'?2:1).position(cells[0]!)
        .f32(cells[0]!.x).f32(cells[0]!.y).f32(.1).f32(6).u8(2).u8(direction<<4).u8(receipt==='locked'?1:0));
      f.advance(5500);expect(f.sent.filter(action=>action.type==='useItem')).toEqual([]);
      if(receipt==='accepted'){
        f.advance(1500);expect(f.sent.filter(action=>action.type==='stop')).toHaveLength(1);
        expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
        expect(f.controller.macro.snapshot()).toMatchObject({state:'waiting',actionsCompleted:1});
      }else {
        f.advance(11000);expect(f.sent.filter(action=>action.type==='useItem')).toEqual([]);
        expect(f.controller.macro.snapshot()).toMatchObject({state:'failed',actionsCompleted:1});
      }
    }finally {random.mockRestore();}
  });
  it('waits for an existing field item before one Stop and the reactive child',()=>{
    const f=fixture(),automation=policy();automation.items=[{itemId:501,resource:'hp',belowPercent:90,minStock:0,cooldownSeconds:1}];
    const reactive:MacroScript['rules'][number]={name:'Level response',priority:100,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:8}],steps:[{type:'useItem',itemId:501,timeoutSeconds:20}]};
    macro(f,script([farm],[reactive]),{...settings,automation});f.controller.engine.player!.hp=80;f.step();
    expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);f.controller.engine.player!.level=8;f.step();
    expect(f.sent.filter(action=>action.type==='stop')).toEqual([]);expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);
    f.packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(40).bool(false));f.advance(1100);
    expect(f.sent.filter(action=>action.type==='stop')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(2);
  });
  it('Stop during a pending resource receipt retires the generation; late ACK cannot advance or restore farming',()=>{
    const f=fixture();macro(f,script([farm,{type:'useItem',itemId:501,timeoutSeconds:20},farm]));f.step();
    expect(f.sent.filter(action=>action.type==='useItem')).toHaveLength(1);f.controller.stop();const count=f.sent.length;
    f.packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(40).bool(false));f.advance(1000);
    expect(f.controller.macro.snapshot()).toMatchObject({state:'cancelled',actionsCompleted:1});expect(f.controller.runRequested).toBe(false);
    expect(f.controller.engine.running).toBe(false);expect(f.sent).toHaveLength(count);
  });
  it.each(['Stop','official command'] as const)('admits a macro after %s cancels manual Respawn and a fresh living own arrival settles',cancel=>{
    const f=fixture();f.controller.start(settings);f.packet(new BitWriter().u8(OP.death).i32(1));f.controller.stop();
    f.controller.perform('command',{type:'respawn'});f.step();
    if(cancel==='Stop')f.controller.stop();else f.controller.manualCommand();
    expect(f.controller.engine.actionResult).toMatchObject({sequence:1,status:'failed',reason:'Action canceled.'});
    expect(()=>macro(f)).toThrow();f.packet(new BitWriter().u8(OP.clear));f.packet(ownPacket({...player,hp:100},2));
    expect(()=>macro(f)).toThrow();f.advance(6100);
    expect(()=>macro(f,script([{type:'useItem',itemId:501,timeoutSeconds:20}]))).not.toThrow();
    expect(f.controller.macro.snapshot()).toMatchObject({state:'waiting',actionsIssued:1});
    expect(f.sent.filter(action=>action.type==='respawn')).toHaveLength(1);expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
  });
  it('releases a canceled non-resource posture receipt after its action deadline without requiring a field run',()=>{
    const f=fixture();f.controller.perform('command',{type:'sit',sitting:false});f.step();f.controller.stop();f.advance(6100);
    expect(()=>macro(f)).not.toThrow();expect(f.controller.engine.running).toBe(true);
    expect(f.sent.filter(action=>action.type==='sit')).toEqual([{type:'sit',sitting:false}]);
  });
  it('keeps a canceled consumable receipt blocked after its deadline and a fresh world arrival',()=>{
    const f=fixture();f.controller.perform('command',{type:'useItem',itemId:501});f.step();f.controller.stop();
    f.packet(new BitWriter().u8(OP.clear));f.packet(ownPacket({...player},2));f.advance(6100);
    expect(()=>macro(f)).toThrow('previous action receipts');expect(f.controller.macro.snapshot().state).toBe('idle');
    expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:501}]);
  });
  it.each(['map','clear'] as const)('retains a macro field through official %s, but reconnect retires it',kind=>{
    const f=fixture();macro(f);f.packet(kind==='map'?new BitWriter().u8(OP.map).string('prontera'):new BitWriter().u8(OP.clear));
    expect(f.controller.macro.snapshot().state).toBe('monitoring');expect(f.controller.runRequested).toBe(true);expect(f.controller.engine.running).toBe(false);
    f.packet(ownPacket({...player},kind==='map'?1:2));f.step();expect(f.controller.macro.snapshot().actionsCompleted).toBe(1);
    f.controller.connect(true);f.receive({type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}});f.step();expect(f.controller.active).toBe(false);
  });

  it.each([false,true])('moves a level-selected farm through a verified portal; stopped=%s',stopped=>{
    let now=100000;const sent:Array<Action|ControllerAction>=[],c=new CompanionController(action=>sent.push(action),()=>now);
    const packet=(w:BitWriter)=>c.receive(w.finish()),own={...player,x:170,y:370};
    c.connect(true);packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08'));packet(ownPacket(own,1));
    const next:MacroScript['rules'][number]={name:'Town field',priority:100,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:8}],
      steps:[{...farm,map:'prontera'}]};
    c.perform('macro',{settings,script:script([farm],[next])});expect(c.macro.snapshot().actionsCompleted).toBe(1);
    c.engine.deaths=1;c.engine.kills=4;c.engine.player!.level=8;now+=100;c.tick();
    expect(c.travel.active).toBe(true);expect(c.macro.snapshot().actionsCompleted).toBe(1);
    for(let i=0;i<20&&c.travel.snapshot().state==='walking';i++){
      const cells=c.travel.snapshot().leg;if(cells.length>1){
        const dirs=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]],w=new BitWriter().u8(OP.walk).i32(1)
          .position(cells[0]!).f32(cells[0]!.x).f32(cells[0]!.y).f32(.05).f32(0).u8(cells.length);
        const d=cells.slice(1).map((cell,j)=>dirs.findIndex(([x,y])=>cell.x-cells[j]!.x===x&&cell.y-cells[j]!.y===y));
        for(let j=0;j<d.length;j+=2)w.u8((d[j]!<<4)|(d[j+1]??0));packet(w.u8(0));
      }
      for(let j=0;j<15;j++){now+=100;c.tick();}
    }
    expect(c.travel.snapshot().state).toBe('transition');packet(new BitWriter().u8(OP.map).string('prontera'));
    expect(c.macro.snapshot()).toMatchObject({state:'waiting',actionsCompleted:1});expect(c.engine.running).toBe(false);
    if(stopped){c.stop();const count=sent.length;packet(ownPacket({...own,level:8,x:156,y:26},1));now+=100;c.tick();expect(c.macro.snapshot()).toMatchObject({state:'cancelled',actionsCompleted:1});expect(c.runRequested).toBe(false);expect(sent).toHaveLength(count);return;}
    packet(ownPacket({...own,id:99,level:8,x:156,y:26},1));expect(c.macro.snapshot().actionsCompleted).toBe(1);
    packet(ownPacket({...own,level:8,x:156,y:26},1));now+=100;c.tick();
    expect(c.macro.snapshot()).toMatchObject({state:'monitoring',actionsCompleted:2});expect(c.engine.running).toBe(true);
    expect(c.snapshot()).toMatchObject({map:'prontera',deaths:1,kills:4});
  });
  it('reserves a macro action identity and scheduler receipt before a transport exception',()=>{
    let now=100000,c!:CompanionController;const observed:number[]=[];
    c=new CompanionController(action=>{if(action.type==='useItem'){observed.push(c.macro.snapshot().pendingActionId!,c.engine.actionResult.sequence);throw Error('Synthetic failed write');}},()=>now,()=>grid);
    c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}},
      {type:'inventory',items:[{bagId:501,itemId:501,type:1,count:3}],equipment:Array(10).fill(0),ammoId:-1}]);c.world.reset('prt_fild08');
    c.perform('macro',{settings,script:script([{type:'useItem',itemId:501,timeoutSeconds:20}])});
    expect(observed).toEqual([1,1]);expect(c.macro.snapshot()).toMatchObject({state:'failed',actionsCompleted:0});expect(c.runRequested).toBe(false);
    expect(()=>c.perform('macro',{settings,script:script()})).toThrow('receipts');
    c.receive(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(0).bool(false).finish());
    expect(c.macro.snapshot().actionsCompleted).toBe(0);now+=1100;c.tick();expect(c.engine.running).toBe(false);
  });
  it.each(['trip','destination'] as const)('cannot acknowledge a destination after recovery replaces its %s',changed=>{
    const f=fixture();f.controller.engine.player!.x=170;f.controller.engine.player!.y=370;
    macro(f,script([{type:'travel',map:'prontera',timeoutSeconds:30}]));
    const original=f.controller.travel.tripId;expect(f.controller.travel.active).toBe(true);
    f.controller.travel.cancel('Death recovery took travel ownership.');
    vi.spyOn(f.controller.travel,'tripId','get').mockReturnValue(original+(changed==='trip'?1:0));
    if(changed==='trip')f.controller.engine.receive([{type:'map',map:'prontera'},{type:'spawn',entity:{...player,x:156,y:26}}]);
    vi.spyOn(f.controller.travel,'snapshot').mockReturnValue({...f.controller.travel.snapshot(),state:'complete',destination:changed==='trip'?'prontera':'prt_fild08'});
    f.step();expect(f.controller.macro.snapshot()).toMatchObject({state:'failed',actionsCompleted:0});expect(f.controller.runRequested).toBe(false);
  });
  it.each(['recovery','hpPotions','disposition','escape'] as const)('preserves the configured %s consumable reserve',source=>{
    const f=fixture(),automation=policy(),itemId=source==='escape'?601:501;
    if(source==='recovery')automation.items=[{itemId,resource:'hp',belowPercent:90,minStock:5,cooldownSeconds:1}];
    else if(source==='hpPotions')automation.hpPotions={mode:'selected',itemIds:[501],belowPercent:60,minStock:5,cooldownSeconds:5};
    else if(source==='escape')automation.escape={...DEFAULT_ESCAPE,enabled:true,minStock:5};
    else automation.disposition={maxSpend:0,rules:[{itemId,keep:5,minimum:5,desired:5,maximum:5,store:false,cart:false,sell:false,restock:'off',allowUnique:false}]};
    f.controller.engine.receive([{type:'inventory',items:[{bagId:itemId,itemId,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1}]);
    macro(f,script([{type:'useItem',itemId,timeoutSeconds:20}]),{...settings,automation});
    expect(f.sent.filter(action=>action.type==='useItem')).toEqual([]);expect(f.controller.macro.snapshot()).toMatchObject({state:'failed',actionsCompleted:0});
    expect(f.controller.macro.snapshot().reason).toContain('stock reserve');
  });
  it('retains macro supervision through an already-sent emergency escape clear, map and living arrival',()=>{
    const f=fixture(),automation=policy();automation.escape={...DEFAULT_ESCAPE,enabled:true,hpBelowPercent:60};
    f.controller.engine.receive([{type:'inventory',items:[{bagId:601,itemId:601,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1}]);
    macro(f,script(),{...settings,automation});f.controller.engine.player!.hp=50;for(let i=0;i<5;i++)f.step();
    expect(f.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);expect(f.controller.escape.snapshot().state).toBe('sent');
    f.packet(new BitWriter().u8(OP.clear));expect(f.controller.macro.active).toBe(true);expect(f.controller.escape.snapshot().state).toBe('refreshing');
    f.packet(new BitWriter().u8(OP.map).string('prt_fild08'));expect(f.controller.macro.active).toBe(true);
    f.packet(ownPacket({...player,hp:100},2));expect(f.controller.escape.snapshot().state).toBe('confirmed');
    expect(f.controller.macro.snapshot()).toMatchObject({state:'monitoring',actionsCompleted:1});expect(f.controller.runRequested).toBe(true);
  });
  it('uses current target eligibility and actor lifetime instead of a displayed name',()=>{
    const f=fixture();macro(f);f.controller.engine.receive([{type:'spawn',entity:{...monster}},{type:'changeTarget',id:2}]);
    const target=f.controller.engine.macroTargetIdentity();expect(target?.targetId).toBe(2);
    f.controller.engine.receive([{type:'spawn',entity:{...player,id:3,name:'Other'}},{type:'attack',source:3,target:2,position:player}]);
    expect(f.controller.engine.macroTargetIdentity()).toBeNull();
    f.controller.engine.receive([{type:'spawn',entity:{...monster,classId:9999}},{type:'changeTarget',id:2}]);
    expect(f.controller.engine.macroTargetIdentity()).toBeNull();
  });
  it('does not treat a macro Wing as an emergency escape owner or infer permission from its map result',()=>{
    const f=fixture();f.controller.engine.receive([{type:'inventory',items:[{bagId:601,itemId:601,type:1,count:3}],equipment:Array(10).fill(0),ammoId:-1}]);
    macro(f,script([{type:'useItem',itemId:601,timeoutSeconds:20},farm]));expect(f.sent).toContainEqual({type:'useItem',itemId:601});
    f.packet(new BitWriter().u8(OP.map).string('prontera'));expect(f.controller.macro.snapshot()).toMatchObject({state:'failed',actionsCompleted:0});
    expect(f.controller.runRequested).toBe(false);const count=f.sent.length;f.packet(ownPacket({...player,x:156,y:26},1));f.advance(1000);expect(f.sent).toHaveLength(count);
    expect(()=>macro(f)).toThrow();
  });
  it.each(['self','target'] as const)('uses the manual %s skill codec and waits for its exact execution before restoring the field',mode=>{
    const f=fixture(),skillId=mode==='self'?2:3;
    f.controller.engine.receive([{type:'skills',learned:[{skillId,level:1}]}]);
    const reactive:MacroScript['rules'][number]={name:'Level skill',priority:100,cooldownSeconds:0,maxRuns:1,conditions:[{field:'level',operator:'gte',value:8}],
      steps:[{type:'skill',skillId,level:1,mode,timeoutSeconds:20}]};
    macro(f,script([farm],[reactive]));f.controller.engine.receive([{type:'spawn',entity:{...monster}},{type:'changeTarget',id:2}]);f.controller.engine.player!.level=8;f.step();
    const action={type:'skill',skillId,level:1,mode,...(mode==='target'?{target:2}:{})};expect(f.sent.filter(row=>row.type==='skill')).toEqual([action]);
    f.controller.engine.receive([{type:'skillResult',source:9,skillId,level:1,mode,...(mode==='target'?{target:2}:{}),indirect:false,motionSeconds:1,position:player}]);f.step();
    expect(f.controller.macro.snapshot().actionsCompleted).toBe(1);
    f.controller.engine.receive([{type:'skillResult',source:1,skillId,level:1,mode,...(mode==='target'?{target:2}:{}),indirect:false,motionSeconds:1,position:player}]);f.step();
    expect(f.controller.macro.snapshot()).toMatchObject({actionsCompleted:2,fieldSuspended:false});expect(f.controller.engine.running).toBe(false);f.advance(3000);
    expect(f.controller.engine.running).toBe(true);expect(f.sent.filter(row=>row.type==='skill')).toHaveLength(1);
  });
  function serviceFixture(type:'buy'|'store'){
    const f=setup({width:400,height:400,walkable:()=>true}),definition=BUILTIN_SERVICES.find(service=>service.id===(type==='buy'?'tool-dealer-buy':'kafra-south-storage'))!;
    // Keep the catalog NPC/approach identity; the fixture grid only supplies open collision cells.
    f.controller.engine.receive([{type:'map',map:definition.map},{type:'spawn',entity:{...player,x:definition.approach.x,y:definition.approach.y}},
      {type:'spawn',entity:{...player,id:20,kind:2,classId:50,name:definition.identity.name,...definition.identity.anchor}},
      {type:'inventory',items:[{bagId:501,itemId:501,type:1,count:5}],equipment:Array(10).fill(0),ammoId:-1},
      {type:'stats',level:7,jobLevel:3,hp:100,maxHp:100,sp:100,maxSp:100,zeny:1000,weight:50,maxWeight:1000},
      {type:'skills',learned:[{skillId:1,level:5}]}]);
    f.controller.world.reset(definition.map);
    const start=(cap=100)=>macro(f,script([{type,serviceId:definition.id,itemId:501,quantity:2,...(type==='store'?{keep:3}:{}),maxSpend:cap,timeoutSeconds:30} as MacroStep]),{...settings,map:definition.map});
    const open=()=>{
      for(let i=0;i<8&&!f.sent.some(action=>action.type==='npcTalk');i++)f.step();
      expect(f.sent,JSON.stringify(f.controller.snapshot().macro)+' '+f.controller.snapshot().service.reason).toContainEqual({type:'npcTalk',id:20});
      f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true));
      for(const row of definition.workflow.steps.slice(1)){
        if(row.type==='advance')f.packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string(row.exactDialogue!.name).string(row.exactDialogue!.text).bool(false));
        else if(row.type==='option'){const labels=row.expectedOptions![0]!,w=new BitWriter().u8(WORLD_OP.npc).u8(2).i32(labels.length);for(const label of labels)w.string(label);f.packet(w);}
        f.step();
      }
      if(type==='buy')f.packet(new BitWriter().u8(WORLD_OP.shop).u8(1).u8(0).i32(1).i32(501).i32(10));
      else f.packet(new BitWriter().u8(WORLD_OP.storage).u8(1).i32(0).i32(0));
      for(let i=0;i<5;i++)f.step();
    };
    return {...f,definition,start,open};
  }
  it('Stop during the service opener retains its child receipt without running a transaction from late dialogue',()=>{
    const f=serviceFixture('buy');f.start();for(let i=0;i<8&&!f.sent.some(action=>action.type==='npcTalk');i++)f.step();
    expect(f.sent).toContainEqual({type:'npcTalk',id:20});f.controller.stop();const count=f.sent.length;
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true));f.packet(new BitWriter().u8(WORLD_OP.npc).u8(2).i32(3).string('Buy').string('Sell').string('Cancel'));f.advance(1000);
    expect(f.controller.macro.snapshot()).toMatchObject({state:'cancelled',actionsCompleted:0});expect(f.sent).toHaveLength(count);expect(f.controller.runRequested).toBe(false);
  });
  it('a buy opens the catalog shop, confirms inventory and balance, then waits for NPC close before ACK',()=>{
    const f=serviceFixture('buy');f.start();f.open();
    expect(f.sent).toContainEqual({type:'shop',mode:'buy',rows:[{id:501,count:2}]});expect(f.controller.macro.snapshot()).toMatchObject({actionsCompleted:0,spendReserved:100});
    f.controller.engine.receive([{type:'inventoryDelta',add:true,bagId:501,change:2,weight:70,item:{bagId:501,itemId:501,type:1,count:7}},{type:'currency',zeny:980}]);
    f.step();expect(f.sent.filter(action=>action.type==='shop'&&!action.rows.length)).toEqual([]);
    f.packet(new BitWriter().u8(WORLD_OP.shop).u8(1).u8(0).i32(1).i32(501).i32(10));f.step();f.step();
    expect(f.sent).toContainEqual({type:'shop',mode:'buy',rows:[]});expect(f.controller.macro.snapshot().actionsCompleted).toBe(0);
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(3));expect(f.controller.macro.snapshot()).toMatchObject({state:'completed',actionsCompleted:1,spendReserved:100});
    expect(f.controller.runRequested).toBe(false);
  });
  it('rejects a purchase quote exceeding the reserved visit cap and leaves no orphan field',()=>{
    const f=serviceFixture('buy');f.start(19);f.open();
    expect(f.sent.filter(action=>action.type==='shop'&&action.rows.length)).toEqual([]);
    expect(f.controller.macro.snapshot()).toMatchObject({state:'failed',spendReserved:19});expect(f.controller.runRequested).toBe(false);
  });
  it('accepts an authoritative natural shop close only after its exact purchase receipt',()=>{
    const f=serviceFixture('buy');f.start();f.open();f.packet(new BitWriter().u8(WORLD_OP.npc).u8(3));
    expect(f.controller.macro.snapshot().actionsCompleted).toBe(0);
    f.controller.engine.receive([{type:'inventoryDelta',add:true,bagId:501,change:2,weight:70,item:{bagId:501,itemId:501,type:1,count:7}},{type:'currency',zeny:980}]);f.step();f.step();
    expect(f.controller.macro.snapshot()).toMatchObject({state:'completed',actionsCompleted:1});expect(f.sent.filter(action=>action.type==='shop'&&!action.rows.length)).toEqual([]);
  });
  it('uses existing disposition protections for equipped storage items',()=>{
    const f=serviceFixture('store');f.controller.engine.character.equipment[0]=501;f.start();f.open();
    expect(f.sent.filter(action=>action.type==='storage'&&action.operation==='deposit')).toEqual([]);
    expect(f.controller.macro.snapshot().state).toBe('failed');expect(f.controller.runRequested).toBe(false);
  });
  it('stores only the semantic item excess, preserving keep and confirming both containers before close',()=>{
    const f=serviceFixture('store');f.start();f.open();
    expect(f.sent).toContainEqual({type:'storage',operation:'deposit',bagId:501,count:2});
    f.packet(new BitWriter().u8(WORLD_OP.storageMove).u8(1).i32(501).i16(2).i32(501).i16(2).i32(30).i32(2).bool(true));
    expect(f.sent.filter(action=>action.type==='storage'&&action.operation==='close')).toEqual([]);
    f.packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(2).i32(30).bool(false));f.step();f.step();
    expect(f.sent).toContainEqual({type:'storage',operation:'close'});expect(f.controller.macro.snapshot().actionsCompleted).toBe(0);
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(3));expect(f.controller.macro.snapshot()).toMatchObject({state:'completed',actionsCompleted:1});
    expect(f.controller.engine.character.count(501)).toBe(3);
  });
  it('retains a stopped buy receipt; late result plus contradictory balance cannot release ownership or advance',()=>{
    const f=serviceFixture('buy');f.start();f.open();f.controller.stop();const count=f.sent.length;
    f.packet(new BitWriter().u8(WORLD_OP.shop).u8(1).u8(0).i32(1).i32(501).i32(10));f.packet(new BitWriter().u8(WORLD_OP.npc).u8(3));f.advance(10000);
    expect(()=>macro(f)).toThrow();expect(f.controller.macro.snapshot()).toMatchObject({state:'cancelled',actionsCompleted:0});expect(f.sent).toHaveLength(count);
    f.controller.engine.receive([{type:'inventoryDelta',add:true,bagId:501,change:2,weight:70,item:{bagId:501,itemId:501,type:1,count:7}},{type:'currency',zeny:979}]);
    f.packet(new BitWriter().u8(WORLD_OP.npc).u8(3));expect(()=>macro(f)).toThrow();
  });
});

import { describe, expect, it, vi } from 'vitest';
import { CompanionController, type ControllerAction } from './controller';
import { BitWriter } from './binary';
import { OP, type Entity } from './protocol';
import type { Action } from './engine';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Settings } from './settings';
import { FEATURE_OP } from './protocol-feature';
import { searchGrid, type WalkGrid } from './navigation';
import { TRAVEL_PORTALS } from './travel';
import type { Position } from './protocol';
import type { DeathRecoveryGuard } from './death-recovery';
import { PersistentFieldRun } from './reconnect';

const own:Entity={id:0,classId:6,name:'Test',kind:0,level:15,hp:100,maxHp:100,sp:50,maxSp:50,x:100,y:100,dead:false,statuses:[],sitting:false};
const monster:Entity={...own,id:2,classId:4000,name:'Poring',kind:1,level:1,hp:10,maxHp:10,x:101};
function spawn(e:Entity,entry=0):Uint8Array {
  const name=new TextEncoder().encode(e.name),body=new BitWriter().u8(15).i32(e.id).i32(e.classId).i32(0)
    .i32(~name.length).i32(e.name.length).take(name).u8(e.kind).u8(0).u8(e.dead?3:e.sitting?2:0)
    .i32(e.x).i32(e.y).u8(e.level).i32(e.hp).i32(e.maxHp).i32(e.sp??0).i32(e.maxSp??0).i32(0).u8(0).finish();
  return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body).finish();
}
function settings():Settings {
  const automation=structuredClone(DEFAULT_AUTOMATION);automation.respawn={enabled:true,maxDeaths:2};
  automation.travel.returnToLockMap=true;automation.recovery={enabled:true,hpStart:60,hpEnd:85,spStart:0,spEnd:80,timeoutSeconds:30};
  return {...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation};
}
function fixture(map='prt_fild08',player=own,gridFor:(map:string)=>WalkGrid|null=()=>({width:400,height:400,walkable:p=>p.x>=0&&p.y>=0&&p.x<400&&p.y<400}),throws=false,throwPosture?:boolean){
  let now=100_000;const sent:Array<Action|ControllerAction>=[];const atThrow:DeathRecoveryGuard[]=[];let postureThrows=0;
  const c=new CompanionController(a=>{sent.push(a);if(throws&&a.type==='respawn')throw new Error('Synthetic send failure');if(a.type==='sit'&&a.sitting===throwPosture&&postureThrows++===0){atThrow.push(c.snapshot().deathRecoveryGuard!);throw new Error('Synthetic posture write failure');}},()=>now,gridFor);
  c.connect(true);const packet=(w:BitWriter|Uint8Array)=>c.receive(w instanceof BitWriter?w.finish():w);
  packet(new BitWriter().u8(OP.enter).i32(player.id).string(map));packet(spawn(player,1));packet(spawn(monster));
  const step=(ms=100)=>{now+=ms;c.tick();};
  const advance=(ms:number)=>{for(let elapsed=0;elapsed<ms;elapsed+=100)step(Math.min(100,ms-elapsed));};
  const fresh=()=>packet(new BitWriter().u8(OP.heal).i32(player.id).i32(0).i32(c.engine.player?.hp??0).i32(100));
  const die=()=>{packet(new BitWriter().u8(OP.death).i32(player.id));advance(2100);};
  const alive=(hp=10,arrivalMap=map)=>{const same=arrivalMap===c.engine.map;if(!same)packet(new BitWriter().u8(OP.map).string(arrivalMap));else packet(new BitWriter().u8(OP.clear));packet(spawn({...player,dead:false,hp,sp:0,maxSp:0},same?2:1));};
  const heal=(hp:number)=>packet(new BitWriter().u8(OP.heal).i32(player.id).i32(0).i32(hp).i32(100));
  const sit=(sitting:boolean)=>packet(new BitWriter().u8(FEATURE_OP.sit).i32(player.id).bool(sitting));
  return {c,sent,packet,step,advance,fresh,die,alive,heal,sit,atThrow,time:()=>now};
}

function guard(f:ReturnType<typeof fixture>,phase:DeathRecoveryGuard['phase']='revival'):DeathRecoveryGuard {
  return {version:1,character:'Test',destination:'prt_fild08',phase,uncertain:true,recoverySeconds:30,returnSeconds:1200,
    recoveryDeadline:phase==='recovery'?f.time()+30_000:0,returnDeadline:phase==='return'?f.time()+1200_000:0};
}
function walkPacket(cells:Position[]):BitWriter {
  const start=cells[0]!,dirs=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
  const steps=cells.slice(1).map((p,i)=>dirs.findIndex(([x,y])=>p.x-cells[i]!.x===x&&p.y-cells[i]!.y===y));
  expect(steps.every(d=>d>=0)).toBe(true);
  const w=new BitWriter().u8(OP.walk).i32(0).position(start).f32(start.x).f32(start.y).f32(0.1).f32(0.1).u8(cells.length);
  for(let i=0;i<steps.length;i+=2)w.u8((steps[i]!<<4)|(steps[i+1]??0));return w.u8(0);
}
function settleTravel(f:ReturnType<typeof fixture>):void {
  for(let i=0;i<100&&f.c.snapshot().deathRecoveryGuard;i++){
    f.step();const trip=f.c.travel.snapshot();
    if(trip.leg.length>1){f.packet(walkPacket(trip.leg));f.advance(trip.leg.length*150+200);}
    const next=f.c.travel.snapshot();
    if(next.state==='transition'){
      const destination=next.remainingMaps[0],edge=TRAVEL_PORTALS.find(e=>e.fromMap===f.c.engine.map&&e.toMap===destination);
      expect(edge).toBeDefined();f.packet(new BitWriter().u8(OP.map).string(edge!.toMap));
      f.packet(spawn({...own,...edge!.arrival,hp:100,sp:0,maxSp:0},1));
    }
    f.fresh();
  }
  expect(f.c.snapshot().deathRecoveryGuard).toBeUndefined();
}
describe('automatic respawn recovery and return',()=>{
  it('starts sitting recovery at a ready low-HP same-map respawn before field admission',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
    f.alive(10);f.step();expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});
    expect(f.c.engine.running).toBe(false);expect(f.c.runRequested).toBe(true);
  });
  it('never sends a second respawn for the same still-dead lifetime after timeout',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();
    for(let i=0;i<30;i++){f.advance(1000);f.fresh();}
    expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
  });
  it('captures the farming map before an initially dead Start at a different save point',()=>{
    const f=fixture('prontera',{...own,hp:0,dead:true}),s=settings();s.automation!.recovery.enabled=false;
    const travel=vi.spyOn(f.c.travel,'start').mockImplementation(()=>{});f.c.start(s);f.advance(2100);
    expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);f.alive(100);f.step();
    expect(travel).toHaveBeenCalledWith('prontera',expect.anything(),'prt_fild08',10,true,expect.anything(),'return');
  });
  it('preserves explicit journey destination B rather than original A or the reloaded save point',()=>{
    const run=new PersistentFieldRun(),s=settings();s.automation!.travel.destinationMap='prt_fild05';
    run.begin(s,'Test','old');const status={sessionId:'new',connected:true,compatible:true,map:'prontera',player:{name:'Test',dead:false}};
    expect(run.resumeFor(status)?.settings.map).toBe('prt_fild05');
  });
});

describe('bounded death episode and authoritative arrival',()=>{
  it('finishes the same-map raw Sit, health and Stand cycle before resuming the same combat counters',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();f.alive(1);expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});
    f.sit(true);f.heal(85);expect(f.sent.at(-1)).toEqual({type:'sit',sitting:false});
    const attacks=f.sent.filter(a=>a.type==='attack').length;f.step();expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(attacks);
    f.sit(false);f.packet(spawn(monster));f.step();
    expect(f.c.engine.running).toBe(true);expect(f.c.engine.deaths).toBe(1);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
    expect(f.c.snapshot().elapsedSeconds).toBeGreaterThanOrEqual(2);expect(f.c.snapshot().deathRecoveryGuard).toBeUndefined();
  });
  it('uses actual portal and walk receipts for cross-map return after low-HP recovery',()=>{
    const f=fixture('prt_fild08',{...own,x:170,y:370},searchGrid);f.c.start(settings());f.step();f.die();
    f.packet(new BitWriter().u8(OP.map).string('prontera'));f.packet(spawn({...own,x:156,y:26,hp:1,sp:0,maxSp:0},1));
    expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});f.sit(true);f.heal(90);f.sit(false);
    settleTravel(f);expect(f.c.engine.map).toBe('prt_fild08');expect(f.c.engine.running).toBe(true);expect(f.c.engine.deaths).toBe(1);
    const p=f.c.engine.player!;f.packet(spawn({...monster,x:p.x+1,y:p.y}));f.step();expect(f.sent.at(-1)).toEqual({type:'attack',id:2});
    expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
  });
  it.each([{refresh:'clear',entry:0},{refresh:'clear',entry:1},{refresh:'map',entry:0},{refresh:'map',entry:2},{refresh:'none',entry:2}])('rejects wrong or missing arrival order $refresh/$entry',({refresh,entry})=>{
    const f=fixture();f.c.start(settings());f.step();f.die();
    if(refresh==='clear')f.packet(new BitWriter().u8(OP.clear));else if(refresh==='map')f.packet(new BitWriter().u8(OP.map).string('prontera'));
    f.packet(spawn({...own,hp:1},entry));f.advance(7000);f.fresh();
    expect(f.sent.filter(a=>a.type==='sit'||a.type==='walk')).toEqual([]);expect(f.c.engine.running).toBe(false);
    expect(f.c.snapshot().deathRecoveryGuard?.uncertain).toBe(true);
  });
  it('rejects foreign or replaced own name while preserving actor zero',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();f.packet(new BitWriter().u8(OP.clear));
    f.packet(spawn({...own,id:9,hp:1},2));f.step();expect(f.sent.filter(a=>a.type==='sit')).toEqual([]);
    f.packet(spawn({...own,name:'Other',hp:1},2));f.step();expect(f.sent.filter(a=>a.type==='sit')).toEqual([]);
    expect(f.c.snapshot().deathRecoveryGuard?.uncertain).toBe(true);
  });
  it('map-only and foreign heal do not confirm the respawn',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();f.packet(new BitWriter().u8(OP.map).string('prontera'));
    f.packet(new BitWriter().u8(OP.heal).i32(9).i32(0).i32(100).i32(100));f.advance(7000);
    expect(f.sent.filter(a=>a.type==='sit'||a.type==='walk')).toEqual([]);expect(f.c.snapshot().deathRecoveryGuard?.uncertain).toBe(true);
  });
  it('accepts explicit authoritative own resurrection but no foreign resurrection',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();f.packet(new BitWriter().u8(OP.resurrection).i32(9).position(own).i32(1));
    expect(f.sent.filter(a=>a.type==='sit')).toEqual([]);f.packet(new BitWriter().u8(OP.resurrection).i32(0).position(own).i32(1));
    expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});
  });
  it('does not replay after a send exception or after a new Start while still dead',()=>{
    const f=fixture('prt_fild08',own,undefined,true);f.c.start(settings());f.step();f.die();
    for(let i=0;i<10;i++){f.advance(1000);f.fresh();}expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
    f.c.stop();f.c.start(settings());f.advance(3000);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
    f.c.stop();expect(()=>f.c.perform('command',{type:'respawn'})).toThrow();
  });
  it('keeps the original death quiet window through panel and official input',()=>{
    const f=fixture();f.c.start(settings());f.step();f.packet(new BitWriter().u8(OP.death).i32(0));
    f.advance(1000);expect(f.sent.filter(a=>a.type==='respawn')).toEqual([]);f.c.manualInput();f.advance(2000);
    expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
    const g=fixture();g.c.start(settings());g.step();g.packet(new BitWriter().u8(OP.death).i32(0));g.advance(1500);g.c.manualCommand();
    g.advance(1900);expect(g.sent.filter(a=>a.type==='respawn')).toHaveLength(1);g.advance(200);expect(g.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
  });
  it('holds canceled respawn uncertainty through actual takeover and drains a late ready arrival',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();f.c.manualCommand();f.advance(8000);f.fresh();
    expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);f.alive(1);f.advance(2000);expect(f.sent.filter(a=>a.type==='sit')).toHaveLength(1);
  });
  it.each(['before','respawn','sit','stand','travel'] as const)('Stop at $phase prevents all late continuation',phase=>{
    const f=fixture();f.c.start(settings());f.step();
    if(phase==='before'){f.packet(new BitWriter().u8(OP.death).i32(0));f.c.stop();f.advance(3000);expect(f.sent.filter(a=>a.type==='respawn')).toEqual([]);return;}
    f.die();if(phase!=='respawn'){f.alive(1,'prontera');if(phase==='stand'||phase==='travel'){f.sit(true);f.heal(90);if(phase==='travel')f.sit(false);}}
    f.c.stop();const count=f.sent.length;f.alive(100,'prontera');f.sit(false);f.heal(100);f.advance(4000);
    expect(f.sent).toHaveLength(count);expect(f.c.runRequested).toBe(false);expect(f.c.engine.running).toBe(false);
  });
  it('preserves known SP through ordinary 0/0 arrival but does not carry it across a connection',()=>{
    const f=fixture(),s=settings();s.automation!.recovery.spStart=10;s.automation!.recovery.spEnd=80;f.c.start(s);f.step();f.die();f.alive(1,'prontera');
    expect(f.c.engine.character.stats).toMatchObject({sp:50,maxSp:50});f.sit(true);f.heal(90);expect(f.sent.at(-1)).toEqual({type:'sit',sitting:false});
    const g=fixture('prt_fild08',{...own,hp:1,sp:0,maxSp:0});g.c.start(s,undefined,undefined,guard(g));g.step();
    expect(g.sent.filter(a=>a.type==='sit')).toEqual([]);expect(g.c.snapshot().reason).toContain('SP is unavailable');
    g.packet(new BitWriter().u8(FEATURE_OP.sp).i32(50).i32(50));g.step();expect(g.sent.at(-1)).toEqual({type:'sit',sitting:true});
  });
  it('bounds unknown novice skill and failed Sit without repeated posture requests',()=>{
    const f=fixture('prt_fild08',{...own,classId:0}),s=settings();s.automation!.recovery.timeoutSeconds=3;f.c.start(s);f.step();f.die();f.alive(1);
    expect(f.sent.filter(a=>a.type==='sit')).toEqual([]);expect(f.c.snapshot().reason).toContain('Basic Mastery');f.advance(3100);expect(f.c.snapshot().deathRecoveryGuard?.phase).toBe('failed');
    const g=fixture();g.c.start(settings());g.step();g.die();g.alive(1);g.advance(7100);g.fresh();g.advance(7000);
    expect(g.sent.filter(a=>a.type==='sit')).toHaveLength(1);expect(g.c.snapshot().deathRecoveryGuard?.phase).toBe('failed');
    g.sit(true);g.heal(100);g.step();expect(g.sent.filter(a=>a.type==='sit')).toHaveLength(1);
  });
  it('keeps a finite return attempt after route failure instead of refreshing the deadline',()=>{
    const f=fixture(),s=settings();s.automation!.recovery.enabled=false;f.c.start(s);f.step();f.die();f.alive(100,'prontera');f.step();
    const start=vi.spyOn(f.c.travel,'start');f.advance(4500);f.fresh();f.advance(5000);
    expect(f.c.snapshot().deathRecoveryGuard?.phase).toBe('failed');expect(start).not.toHaveBeenCalled();
  });
  it.each(['low','unknown'] as const)('stops automatic return at $health HP without another travel decision or a fresh return deadline',health=>{
    const f=fixture('prt_fild08',{...own,x:170,y:370},searchGrid),s=settings();s.automation!.recovery.enabled=false;
    f.c.start(s);f.step();f.die();f.packet(new BitWriter().u8(OP.map).string('prontera'));f.packet(spawn({...own,x:156,y:26,hp:100,sp:0,maxSp:0},1));
    expect(f.c.travel.active).toBe(true);const deadline=f.c.snapshot().deathRecoveryGuard!.returnDeadline;
    const tick=vi.spyOn(f.c.travel,'tick'),start=vi.spyOn(f.c.travel,'start'),walks=f.sent.filter(a=>a.type==='walk').length;
    if(health==='low')f.heal(10);else{f.c.engine.player!.maxHp=0;f.step();}
    expect(tick).not.toHaveBeenCalled();expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(walks);expect(f.sent.at(-1)).toEqual({type:'stop'});
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',returnDeadline:deadline});
    f.heal(100);f.advance(4000);expect(start).not.toHaveBeenCalled();expect(f.c.engine.running).toBe(false);
  });
  it('stops an accepted return walk at low HP and never dispatches its next leg',()=>{
    const f=fixture('prt_fild08',{...own,x:170,y:370},searchGrid),s=settings();s.automation!.recovery.enabled=false;
    f.c.start(s);f.step();f.die();f.packet(new BitWriter().u8(OP.map).string('prontera'));f.packet(spawn({...own,x:156,y:100,hp:100,sp:0,maxSp:0},1));f.step();
    const trip=f.c.travel.snapshot();expect(trip.leg.length).toBeGreaterThan(1);f.packet(walkPacket(trip.leg));
    const walks=f.sent.filter(a=>a.type==='walk').length,deadline=f.c.snapshot().deathRecoveryGuard!.returnDeadline;
    f.heal(1);expect(f.sent.at(-1)).toEqual({type:'stop'});f.advance(trip.leg.length*150+500);
    expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(walks);expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',returnDeadline:deadline});
  });
  it('holds missing maps and forbidden destinations without field activity',()=>{
    const f=fixture('prt_fild08',own,map=>map==='prontera'?null:{width:400,height:400,walkable:()=>true}),s=settings();s.automation!.recovery.enabled=false;
    f.c.start(s);f.step();f.die();f.alive(100,'unknown');f.advance(1000);expect(f.c.engine.running).toBe(false);expect(f.c.snapshot().deathRecoveryGuard?.phase).toBe('failed');
  });
  it('preserves the destination when death interrupts the initial entry journey',()=>{
    const f=fixture('prt_fild08',{...own,x:100,y:100}),s=settings();s.automation!.travel.destinationMap='prt_fild05';s.automation!.recovery.enabled=false;
    f.c.start(s);f.step();f.die();const start=vi.spyOn(f.c.travel,'start').mockImplementation(()=>{});f.alive(100,'prontera');f.step();
    expect(start).toHaveBeenLastCalledWith('prontera',expect.anything(),'prt_fild05',10,true,expect.anything(),'return');
  });
  it('allows a final already-counted dead Start but blocks the next genuine death',()=>{
    const f=fixture('prt_fild08',{...own,dead:true,hp:0}),s=settings();s.automation!.respawn.maxDeaths=0;s.automation!.recovery.enabled=false;
    f.c.start(s);f.advance(2100);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);expect(f.c.engine.deaths).toBe(0);
    f.alive(100);f.step();f.die();f.advance(7000);expect(f.c.engine.deaths).toBe(1);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);
  });
  it('rejects a wrong-character resume guard atomically before run intent',()=>{
    const f=fixture();expect(()=>f.c.start(settings(),undefined,undefined,{...guard(f),character:'Other'})).toThrow();f.advance(2500);
    expect(f.c.runRequested).toBe(false);expect(f.sent).toEqual([]);expect(f.c.snapshot().deathRecoveryGuard).toBeUndefined();
  });
});

describe('same requested run through replacement pages',()=>{
  function status(f:ReturnType<typeof fixture>,sessionId:string){return {sessionId,connected:true,compatible:true,map:f.c.engine.map,
    player:f.c.engine.player?{name:f.c.engine.player.name,dead:f.c.engine.player.dead}:null,runRequested:f.c.runRequested,deaths:f.c.engine.deaths,
    deathRecoveryGuard:f.c.snapshot().deathRecoveryGuard};}
  it.each([false,true])('holds an already-dead reload even when sent telemetry was published=$published',published=>{
    const f=fixture(),run=new PersistentFieldRun(f.time);run.begin(settings(),'Test','old');f.c.start(settings());f.step();f.die();
    if(published)run.observe(status(f,'old'));
    const g=fixture('prontera',{...own,hp:0,dead:true}),request=run.resumeFor(status(g,'new'))!;
    expect(request.settings.map).toBe('prt_fild08');expect(request.deathRecoveryGuard?.uncertain).toBe(true);
    g.c.start(request.settings,undefined,undefined,request.deathRecoveryGuard);run.completeResume(request,true);
    for(let i=0;i<10;i++){g.advance(1000);g.fresh();}expect(g.sent.filter(a=>a.type==='respawn')).toEqual([]);
    g.alive(1);expect(g.sent.at(-1)).toEqual({type:'sit',sitting:true});expect(g.c.engine.deaths).toBe(0);
  });
  it('reconciles an alive new Enter initialization at the save point and retains the farming destination',()=>{
    const run=new PersistentFieldRun(()=>100000),s=settings();run.begin(s,'Test','old');
    const g=fixture('prontera',{...own,hp:1}),request=run.resumeFor(status(g,'new'))!;
    g.c.start(request.settings,undefined,undefined,request.deathRecoveryGuard);run.completeResume(request,true);
    expect(g.sent.at(-1)).toEqual({type:'sit',sitting:true});g.sit(true);g.heal(90);g.sit(false);
    const start=vi.spyOn(g.c.travel,'start');g.step();expect(g.c.travel.snapshot().destination).toBe('prt_fild08');expect(start).not.toHaveBeenCalled();
  });
  it('transfers guard ownership to a successor so fresh reconciliation can clear uncertainty',()=>{
    const f=fixture(),run=new PersistentFieldRun(f.time);run.begin(settings(),'Test','old');run.observe({...status(f,'old'),deathRecoveryGuard:guard(f)});
    const g=fixture('prontera',{...own,hp:1}),request=run.resumeFor(status(g,'new'))!;run.completeResume(request,true);
    run.observe({...status(g,'new'),deathRecoveryGuard:{...request.deathRecoveryGuard!,phase:'recovery',uncertain:false,recoveryDeadline:g.time()+30000}});
    expect(run.deathGuardForStart(request.settings,'Test','new')?.uncertain).toBe(false);
  });
  it('does not replace a newer same-page sent/reconciled guard with a stale completion',()=>{
    const f=fixture(),run=new PersistentFieldRun(f.time);run.begin(settings(),'Test','old');const original=guard(f);
    run.observe({...status(f,'old'),deathRecoveryGuard:original});
    run.completeDeathStart('Test','new',original);
    const latest={...original,phase:'recovery' as const,recoveryDeadline:110000,returnDeadline:1310000};
    run.observe({...status(f,'new'),deathRecoveryGuard:latest});run.completeDeathStart('Test','new',original);
    expect(run.deathGuardForStart(settings(),'Test','new')).toMatchObject({phase:'recovery',recoveryDeadline:110000});
  });
  it('preserves an absolute recovery deadline through repeated page replacements and missed initial publication',()=>{
    const f=fixture('prontera',{...own,hp:1}),run=new PersistentFieldRun(f.time),s=settings();s.automation!.recovery.timeoutSeconds=3;run.begin(s,'Test','old');
    const first=run.resumeFor(status(f,'new'))!;run.completeResume(first,true);
    f.advance(2000);const next=run.resumeFor(status(f,'newer'))!;expect(next.deathRecoveryGuard?.recoveryDeadline).toBe(first.deathRecoveryGuard?.recoveryDeadline);
    f.c.start(next.settings,undefined,undefined,next.deathRecoveryGuard);f.advance(1100);
    expect(f.c.snapshot().deathRecoveryGuard?.phase).toBe('failed');expect(f.sent.filter(a=>a.type==='sit')).toHaveLength(1);
  });
  it('preserves the return deadline and failure latch across reload rather than starting fresh travel',()=>{
    const f=fixture('prontera'),run=new PersistentFieldRun(f.time);run.begin(settings(),'Test','old');
    const saved={...guard(f,'return'),uncertain:false,returnDeadline:f.time()+1000};run.observe({...status(f,'old'),deathRecoveryGuard:saved});
    f.advance(1500);const request=run.resumeFor(status(f,'new'))!;f.c.start(request.settings,undefined,undefined,request.deathRecoveryGuard);
    expect(f.c.snapshot().deathRecoveryGuard?.phase).toBe('failed');expect(f.sent.filter(a=>a.type==='walk')).toEqual([]);
  });
  it('bounds retained character guards at64 through telemetry and Start completion',()=>{
    const f=fixture(),run=new PersistentFieldRun(f.time);for(let i=0;i<64;i++)run.completeDeathStart('C'+i,'old',{...guard(f),character:'C'+i});
    run.completeDeathStart('Overflow','new',{...guard(f),character:'Overflow'});
    expect(run.deathGuardForStart(settings(),'Overflow','new',true)?.phase).toBe('failed');
  });
  it('discards old socket frames after reconnect before accepting new own readiness',()=>{
    const f=fixture();f.c.start(settings());f.step();f.die();const epoch=f.c.connectionGeneration;f.c.connect(true);
    f.c.receive(new BitWriter().u8(OP.enter).i32(0).string('prontera').finish(),epoch);
    f.c.receive(spawn({...own,hp:1},1),epoch);f.step();expect(f.sent.filter(a=>a.type==='sit')).toEqual([]);
    f.packet(new BitWriter().u8(OP.enter).i32(0).string('prontera'));f.packet(spawn({...own,hp:1,sp:0,maxSp:0},1));
    expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});
  });
  it('counts subsequent genuine death episodes without replaying the preceding one or replenishing allowance',()=>{
    const f=fixture(),s=settings();s.automation!.respawn.maxDeaths=1;s.automation!.recovery.enabled=false;f.c.start(s);f.step();f.die();f.alive(100);f.step();
    f.die();f.advance(5000);expect(f.c.engine.deaths).toBe(2);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(1);expect(f.c.snapshot().reason).toContain('Death limit');
  });
  it('admits a distinct confirmed death during return only within the original death allowance',()=>{
    const f=fixture(),s=settings();s.automation!.recovery.enabled=false;f.c.start(s);f.step();f.die();f.alive(100,'prontera');f.step();
    f.die();expect(f.c.engine.deaths).toBe(2);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(2);f.advance(6000);expect(f.sent.filter(a=>a.type==='respawn')).toHaveLength(2);
  });
});

describe('explicit restart and final allowance handoff',()=>{
  function status(f:ReturnType<typeof fixture>,sessionId:string){return {sessionId,connected:true,compatible:true,map:f.c.engine.map,player:{name:'Test',dead:f.c.engine.player?.dead??true},runRequested:f.c.runRequested,deathRecoveryGuard:f.c.snapshot().deathRecoveryGuard,deaths:f.c.engine.deaths};}
  it('preserves newer successor telemetry received before the native completion callback',()=>{
    const f=fixture(),run=new PersistentFieldRun(f.time);run.begin(settings(),'Test','A');run.observe({...status(f,'A'),deathRecoveryGuard:guard(f)});
    const request=run.resumeFor({...status(f,'B'),player:{name:'Test',dead:true}})!;
    run.observe({...status(f,'B'),deathRecoveryGuard:{...guard(f,'recovery'),uncertain:false,recoveryDeadline:130000,returnDeadline:1330000}});
    run.completeResume(request,true);f.advance(25000);
    const next=run.resumeFor({...status(f,'C'),player:{name:'Test',dead:false}})!;
    expect(next.deathRecoveryGuard).toMatchObject({phase:'recovery',uncertain:false,recoveryDeadline:130000,returnDeadline:1330000});
  });
  it.each(['recovery','return','failed'] as const)('explicit Start discards reconciled canceled $phase continuation while allowing a new destination',phase=>{
    const f=fixture(),run=new PersistentFieldRun(f.time),s=settings();run.begin(s,'Test','old');run.observe({...status(f,'old'),deathRecoveryGuard:{...guard(f,phase),uncertain:false}});
    run.stop();const changed=settings();changed.automation!.travel.destinationMap='prt_fild05';run.begin(changed,'Test','new');
    expect(run.deathGuardForStart(changed,'Test','new')).toBeUndefined();
  });
  it('Stop keeps unresolved respawn/posture guards through a new explicit request',()=>{
    const f=fixture(),run=new PersistentFieldRun(f.time);run.begin(settings(),'Test','old');run.observe({...status(f,'old'),deathRecoveryGuard:guard(f)});run.stop();run.begin(settings(),'Test','new');
    expect(run.deathGuardForStart(settings(),'Test','new')?.uncertain).toBe(true);
  });
  it('still recovers and returns after final counted death disables future automatic respawns on reload',()=>{
    const run=new PersistentFieldRun(()=>100000),s=settings();run.begin(s,'Test','old');
    run.observe({sessionId:'old',connected:true,compatible:true,map:s.map,player:{name:'Test',dead:true},deaths:2});
    const f=fixture('prontera',{...own,hp:1}),request=run.resumeFor(status(f,'new'))!;
    expect(request.settings.automation?.respawn).toEqual({enabled:false,maxDeaths:0});expect(request.deathRecoveryGuard).toBeDefined();
    f.c.start(request.settings,undefined,undefined,request.deathRecoveryGuard);expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});
    f.sit(true);f.heal(90);f.sit(false);expect(f.c.travel.snapshot().destination).toBe('prt_fild08');expect(f.c.engine.running).toBe(false);
  });
});

describe('capture-before-write recovery uncertainty',()=>{
  it.each([true,false])('reserves posture before a throwing transport and never retries sitting=$sitting',sitting=>{
    const f=fixture('prt_fild08',own,undefined,false,sitting),s=settings();
    if(!sitting)s.automation!.recovery.enabled=false;f.c.start(s);f.step();f.die();
    if(sitting)f.alive(1);else{
      f.packet(new BitWriter().u8(OP.clear));f.packet(spawn({...own,hp:100,sitting:true},2));
    }
    expect(f.atThrow).toHaveLength(1);expect(f.atThrow[0]?.uncertain).toBe(true);
    for(let i=0;i<10;i++){f.advance(1000);f.fresh();}
    expect(f.sent.filter(a=>a.type==='sit'&&a.sitting===sitting)).toHaveLength(1);
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:true});
    f.c.stop();f.c.start(s);f.advance(2500);expect(f.sent.filter(a=>a.type==='sit'&&a.sitting===sitting)).toHaveLength(1);
  });
});

describe('fresh initialization reconciles obsolete posture availability',()=>{
  function pendingPosture(){
    const f=fixture();f.c.start(settings());f.step();f.die();f.alive(1);f.advance(8100);f.fresh();
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:true});f.c.stop();return f;
  }
  it('clears an obsolete posture after a newer matching living initialization without resuming the stopped failed cycle',()=>{
    const f=pendingPosture(),count=f.sent.length;f.c.connect(true);
    f.packet(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08'));f.packet(spawn({...own,hp:100},1));f.advance(2000);
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:false});
    expect(f.c.runRequested).toBe(false);expect(f.c.engine.running).toBe(false);expect(f.sent).toHaveLength(count);
    f.c.start(settings());f.advance(2000);expect(f.c.snapshot().deathRecoveryGuard).toBeUndefined();expect(f.c.engine.running).toBe(true);
    expect(f.sent.filter(a=>a.type==='sit')).toHaveLength(1);
  });
  it.each(['clear','map','enter'] as const)('same-connection $transition is not a fresh-connection posture readback',transition=>{
    const f=pendingPosture();
    f.packet(transition==='clear'?new BitWriter().u8(OP.clear):transition==='map'?new BitWriter().u8(OP.map).string('prontera'):new BitWriter().u8(OP.enter).i32(0).string('prt_fild08'));
    f.packet(spawn({...own,hp:100},transition==='clear'?2:1));f.step();
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:true});
  });
  it.each(['ordinary','wrongActor','wrongName','dead'] as const)('rejects $kind after a new connection',kind=>{
    const f=pendingPosture();f.c.connect(true);f.packet(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08'));
    f.packet(spawn({...own,id:kind==='wrongActor'?9:0,name:kind==='wrongName'?'Other':'Test',hp:kind==='dead'?0:100,dead:kind==='dead'},kind==='ordinary'?0:1));f.step();
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:true});
  });
  it('ignores fresh-looking initialization from a stale socket epoch',()=>{
    const f=pendingPosture(),old=f.c.connectionGeneration;f.c.connect(true);
    f.c.receive(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish(),old);f.c.receive(spawn({...own,hp:100},1),old);f.step();
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:true});
  });
  it('reconciles a restored failed posture guard only with known fresh living posture',()=>{
    const f=fixture(),saved={...guard(f,'failed'),recoveryDeadline:f.time()-1};
    f.c.engine.character.sitting=null;f.c.start(settings(),undefined,undefined,saved);f.step();
    expect(f.c.snapshot().deathRecoveryGuard?.uncertain).toBe(true);f.c.stop();
    f.c.connect(true);f.packet(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08'));f.packet(spawn({...own,hp:100,sitting:false},1));
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'failed',uncertain:false});expect(f.c.runRequested).toBe(false);
    f.c.start(settings());f.step();expect(f.c.engine.running).toBe(true);
  });
  it('never uses the initial readback to reconcile a newly sent posture in that same restored connection',()=>{
    const f=fixture('prt_fild08',{...own,hp:1});f.c.start(settings(),undefined,undefined,guard(f,'recovery'));
    expect(f.sent.filter(a=>a.type==='sit')).toHaveLength(1);f.advance(1000);
    expect(f.c.snapshot().deathRecoveryGuard).toMatchObject({phase:'recovery',uncertain:true});
    f.c.stop();f.advance(8000);expect(f.c.snapshot().deathRecoveryGuard?.uncertain).toBe(true);
    expect(f.sent.filter(a=>a.type==='sit')).toHaveLength(1);
  });
});

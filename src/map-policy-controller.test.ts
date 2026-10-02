import { describe, expect, it, vi } from 'vitest';
import { CompanionController } from './controller';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Settings } from './settings';
import { DEFAULT_MAP_POLICY, insideLockArea } from './map-policy';
import { DEFAULT_SUPPLY } from './supply-trip';
import { BUILTIN_SERVICES, NpcServiceRuntime, previewService, validateServiceExecution, type ServiceContext } from './npc-services';
import { TravelController } from './travel-controller';
import { BitWriter } from './binary';
import { FEATURE_OP } from './protocol-feature';
import { OP, type Entity, type Position } from './protocol';
import { walkDuration } from './movement';
import { WorldState } from './world-state';
import type { WalkGrid } from './navigation';
const player:Entity={id:1,classId:1,name:'Test',kind:0,level:10,hp:100,maxHp:100,dead:false,x:8,y:4};
const grid:WalkGrid={width:12,height:12,walkable:p=>p.x>=0&&p.y>=0&&p.x<12&&p.y<12};
const policy=()=>({...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:4,maxY:4}});
const settings=():Settings=>({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:policy()}});
function walkPacket(cells:Position[],seconds=.1){
  const offsets=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
  const w=new BitWriter().u8(OP.walk).i32(1).position(cells[0]!).f32(cells[0]!.x).f32(cells[0]!.y).f32(seconds).f32(seconds).u8(cells.length);
  const directions=cells.slice(1).map((p,i)=>offsets.findIndex(([x,y])=>p.x-cells[i]!.x===x&&p.y-cells[i]!.y===y));
  for(let i=0;i<directions.length;i+=2)w.u8(directions[i]!<<4|(directions[i+1]??0));return w.u8(0).finish();
}
function statsPacket(){
  const w=new BitWriter().u8(FEATURE_OP.stats);for(const n of [10,1,1000,1,1,1,1,1,1,0,0,0,100,100,100,100,...Array(16).fill(0),10000])w.i32(n);
  w.f32(.4).i32(70).i32(0).bool(true).i16(1).i16(1).u8(5).i16(0).bool(true).u8(1).i32(1).i32(501).i16(1).i32(0).u8(0);
  for(let i=0;i<10;i++)w.i32(0);return w.i32(-1).finish();
}
function setup(physical=grid){
  let now=100000;const sent:Array<{type:string;destination?:Position}>=[];const c=new CompanionController(a=>sent.push(a),()=>now,()=>physical);
  c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}},{type:'spawn',entity:{...player,id:2,kind:1,classId:4000,name:'Poring',x:3,y:4}}]);c.world.reset('prt_fild08');c.receive(statsPacket());
  const step=(ms=100)=>{now+=ms;c.tick();};
  const settle=()=>{for(let n=0;n<20&&c.travel.active;n++){c.tick();const cells=c.travel.snapshot().leg;if(cells.length<2){step();continue;}c.receive(walkPacket(cells));const duration=walkDuration({origin:cells[0]!,cells,secondsPerCell:.1,firstSeconds:.1,locked:false})+110;for(let ms=0;ms<duration;ms+=100)step();}step();};
  return {c,sent,step,settle};
}
describe('controller lock entry and service ownership',()=>{
  it('waits for physical entry into a reachable rectangle before sending any attack',()=>{
    const {c,sent,settle}=setup();const value=settings();c.start(value);c.tick();expect(c.travel.snapshot()).toMatchObject({purpose:'field-entry',state:'walking'});expect(c.engine.running).toBe(false);
    expect(sent.some(a=>a.type==='attack')).toBe(false);value.automation!.mapPolicy!.deny.push('prt_fild08');settle();c.tick();
    expect(c.engine.running).toBe(true);expect(insideLockArea(policy(),'prt_fild08',c.engine.player!)).toBe(true);expect(sent.some(a=>a.type==='attack')).toBe(true);
  });
  it('does not arm or capture low-stock supply until field entry has confirmed',()=>{
    const {c,sent,settle}=setup();const value=settings();value.automation!.supply={...DEFAULT_SUPPLY,enabled:true,buyService:'trader.prt-fild05.tool-dealer.buy.v1'};
    value.automation!.disposition={maxSpend:1000,rules:[{itemId:501,keep:0,minimum:5,desired:10,maximum:10,store:false,cart:false,sell:false,restock:'buy',allowUnique:false}]};
    c.start(value);c.tick();expect(c.supply.snapshot()).toMatchObject({active:false,returnDestination:null});expect(sent.every(a=>a.type==='walk')).toBe(true);
    settle();c.tick();expect(c.supply.snapshot().returnDestination).toMatchObject({map:'prt_fild08'});expect(insideLockArea(policy(),'prt_fild08',c.supply.snapshot().returnDestination!.position)).toBe(true);
  });
  it('keeps a disconnected area waiting without combat or supply capture',()=>{
    const {c,sent}=setup({...grid,walkable:p=>grid.walkable(p)&&p.x!==5});c.start(settings());c.tick();expect(sent).toEqual([]);expect(c.snapshot().reason).toContain('No reachable safe cell');expect(c.engine.running).toBe(false);
  });
  it('respawns after death during first entry, preserves its debit, and waits for alive field entry',()=>{
    const {c,sent,step,settle}=setup();const value=settings();value.automation!.respawn={enabled:true,maxDeaths:1};
    c.start(value);c.tick();expect(c.travel.active).toBe(true);
    c.receive(new BitWriter().u8(OP.death).i32(1).finish());step();step();
    expect(sent.filter(a=>a.type==='respawn')).toHaveLength(1);expect(c.engine.deaths).toBe(1);expect(c.engine.settings.map).toBe('prt_fild08');
    c.engine.receive([{type:'resurrection',id:1,hp:100,position:{x:8,y:4}}]);step();
    expect(c.engine.running).toBe(false);expect(c.travel.snapshot().purpose).toBe('field-entry');expect(sent.some(a=>a.type==='attack')).toBe(false);
    settle();expect(c.engine.running).toBe(true);expect(c.engine.deaths).toBe(1);
    c.receive(new BitWriter().u8(OP.death).i32(1).finish());step();step();
    expect(c.engine.deaths).toBe(2);expect(sent.filter(a=>a.type==='respawn')).toHaveLength(1);expect(c.snapshot().reason).toContain('Death limit');
  });
  it.each([false,true])('admits only dead respawn on another lock map (forbidden=%s), then requires policy return',forbidden=>{
    const {c,sent,step}=setup();c.engine.receive([{type:'map',map:'prontera'},{type:'spawn',entity:{...player}}]);c.world.reset('prontera');
    const value=settings();value.automation!.respawn={enabled:true,maxDeaths:2};if(forbidden)value.automation!.mapPolicy!.deny=['prontera'];
    const travel=vi.spyOn(c.travel,'start').mockImplementation(()=>{});c.start(value);sent.length=0;
    c.receive(new BitWriter().u8(OP.death).i32(1).finish());step();step();expect(sent).toEqual([{type:'respawn'}]);expect(c.engine.deaths).toBe(1);
    expect(c.engine.settings.map).toBe('prt_fild08');expect(c.engine.settings.automation!.mapPolicy).toEqual(value.automation!.mapPolicy);
    c.engine.receive([{type:'resurrection',id:1,hp:100,position:{x:8,y:4}}]);step();
    expect(c.engine.running).toBe(false);expect(travel).toHaveBeenLastCalledWith('prontera',expect.anything(),'prt_fild08',10,true,value.automation!.mapPolicy,'travel');
    expect(sent.some(a=>a.type==='attack'||a.type==='walk')).toBe(false);
  });
  it('Stop cancels entry and late authoritative movement never starts combat',()=>{
    const {c,sent,step}=setup();c.start(settings());c.tick();const leg=c.travel.snapshot().leg;c.stop();c.receive(walkPacket(leg));step(1000);expect(c.runRequested).toBe(false);expect(sent.some(a=>a.type==='attack')).toBe(false);expect(sent.at(-1)).toEqual({type:'stop'});
  });
  it('retains policy, entry purpose, target and original deadline after a verified occupancy nudge',()=>{
    let now=100000;const travel=new TravelController(()=>{},()=>now,()=>grid),p={...player};travel.startApproach('prt_fild08',p,{x:4,y:4},1,policy(),'field-entry');travel.tick('prt_fild08',p);
    const cells=travel.snapshot().leg,accepted={origin:p,cells,secondsPerCell:1,firstSeconds:1,locked:false};travel.observe([{type:'walk',id:1,walk:accepted}]);
    const endpoint=cells.at(-1)!;travel.observe([{type:'walk',id:1,walk:{origin:endpoint,cells:[endpoint,{x:endpoint.x+1,y:endpoint.y}],secondsPerCell:.1,firstSeconds:.1,locked:false}}]);
    now+=200;travel.tick('prt_fild08',{...p,x:endpoint.x+1,y:endpoint.y});expect(travel.snapshot()).toMatchObject({purpose:'field-entry',policy:policy()});expect(travel.snapshot().route.at(-1)).toEqual({x:4,y:4});
    now+=300001;travel.tick('prt_fild08',p);expect(travel.snapshot().state).toBe('failed');
  });
  it('preserves explicit lock-map intent instead of farming a different reconnect map',()=>{
    const {c,sent,step}=setup();c.engine.player!.x=4;c.start(settings());step();c.disconnect();c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prontera'},{type:'spawn',entity:{...player}}]);c.world.reset('prontera');
    const start=vi.spyOn(c.travel,'start').mockImplementation(()=>{});step();expect(start).toHaveBeenCalledWith('prontera',expect.anything(),'prt_fild08',10,true,policy(),'travel');expect(c.engine.running).toBe(false);expect(sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('manual service wrappers validate the policy without changing the verified source definition',()=>{
    const service=BUILTIN_SERVICES[0]!;const request=validateServiceExecution({service,executionPolicy:policy()});expect(request.service).toEqual(service);expect(request.service).not.toHaveProperty('mapPolicy');
    expect(()=>validateServiceExecution({service,executionPolicy:null})).toThrow();expect(()=>validateServiceExecution({...service,mapPolicy:policy()})).toThrow();
    const preview=previewService(service,{map:service.map,player:service.approach,actors:[],inventoryKnown:true,zeny:1000,basicSkillLevel:5,stock:{}},{...policy(),deny:[service.map]});expect(preview.available).toBe(false);expect(preview.reasons.join(' ')).toContain('forbidden');
  });
  it('service final approach uses physical cells outside a field rectangle and refuses denied service/outcome maps',()=>{
    const service=BUILTIN_SERVICES[0]!,world=new WorldState();world.reset(service.map);let now=100000;const sent:unknown[]=[];
    const travel=new TravelController(a=>sent.push(a),()=>now),runtime=new NpcServiceRuntime(travel,()=>now);
    const context:ServiceContext={map:service.map,playerId:1,alive:true,idle:true,inventory:[],equipped:[],zeny:1000,world,visibleNpcIds:[],basicSkillLevel:5,player:{...player,...service.approach},actors:[],connection:1,inventoryKnown:true};
    const physicalPolicy={...policy(),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:1,maxY:1}};
    runtime.start(service,context,physicalPolicy);physicalPolicy.deny.push(service.map);runtime.tick(context);expect(runtime.snapshot().state).toBe('approach');expect(travel.snapshot().policy.deny).toEqual([]);expect(travel.snapshot().purpose).toBe('service');
    runtime.cancel();expect(()=>runtime.start(service,context,{...policy(),deny:[service.map]})).toThrow('forbidden');now+=100;
  });
});

import { describe, expect, it } from 'vitest';
import { TravelController, type TravelPlanningContext } from './travel-controller';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { routeBetweenMaps, TravelPlanner, type TravelStep } from './travel';
import * as travelRoutes from './travel';
import type { Entity, GameEvent } from '../protocol/protocol';
import type { Action } from '../automation/engine';
import type { PlanningScheduler } from './route-planning';
const player = (): Entity => ({id:1,x:170,y:370,name:'Fixture',classId:0,kind:0,level:1,hp:100,maxHp:100,dead:false});
const policy = {...DEFAULT_MAP_POLICY,mode:'weighted' as const};
const route = () => routeBetweenMaps('prt_fild08',player(),'prontera',false,policy)!;
function setup(continueRequested=false) {
  let clock=100_000;
  const sent:Action[]=[], pending:Array<{map:string;start:{x:number;y:number};resolve:(value:TravelStep[]|null)=>void;reject:(reason:unknown)=>void;signal?:AbortSignal}>=[];
  const context:TravelPlanningContext={identity:'connection-1/world-1/own-1',map:'prt_fild08',player:player()};
  const travel=new TravelController(a=>sent.push(a),()=>clock,undefined,{context:()=>context,continueRequested:()=>continueRequested,
    plan:(map,start,_destination,_walls,_policy,options)=>new Promise((resolve,reject)=>pending.push({map,start:{...start},resolve,reject,signal:options?.signal}))});
  const start=()=>travel.start(context.map,context.player!,'prontera',10,false,policy);
  return {travel,sent,pending,context,start,advance:(ms:number)=>{clock+=ms;}};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
function officialArrival(f:ReturnType<typeof setup>,map='prt_fild08',entryType:1|2=1) {
  f.context.identity=null;f.context.player=undefined;
  f.context.map=map;f.travel.observe([entryType===1?{type:'map',map}:{type:'clear'}]);
  f.context.identity='connection-1/world-2/own-2';f.context.player={...player(),x:171};
  f.travel.observe([{type:'spawn',entity:f.context.player,entryType}]);
}
const currentRoute=(f:ReturnType<typeof setup>)=>routeBetweenMaps(f.context.map,f.context.player!,'prontera',false,policy)!;

describe('weighted replanning after official movement',()=>{
  it.each([1,2] as const)('plans from the verified official arrival before a later dispatch (entry type %s)',async entryType=>{
    const f=setup(true);f.start();const trip=f.travel.tripId;
    officialArrival(f,'prt_fild08',entryType);
    expect(f.pending[0]!.signal?.aborted).toBe(true);
    expect(f.pending).toHaveLength(2);expect(f.pending[1]).toMatchObject({map:f.context.map,start:{x:171,y:370}});
    expect(f.travel.snapshot().state).toBe('planning');expect(f.travel.tripId).toBe(trip);expect(f.sent).toEqual([]);
    f.pending[1]!.resolve(currentRoute(f));await flush();
    expect(f.travel.snapshot().state).toBe('walking');expect(f.sent).toEqual([]);
    f.travel.tick(f.context.map,f.context.player);expect(f.sent.map(a=>a.type)).toEqual(['walk']);
  });
  it('waits for official accepted movement to settle before starting another weighted job',async()=>{
    const f=setup(true);f.start();const trip=f.travel.tripId;f.travel.officialGameplay();
    f.travel.observe([{type:'walk',id:1,walk:{origin:player(),cells:[{x:170,y:370},{x:171,y:370}],secondsPerCell:.1,firstSeconds:.1,locked:false}}]);
    expect(f.pending[0]!.signal?.aborted).toBe(true);f.advance(100);f.travel.tick(f.context.map,f.context.player);
    expect(f.pending).toHaveLength(1);f.advance(201);f.context.player!.x=171;f.travel.tick(f.context.map,f.context.player);
    expect(f.pending).toHaveLength(2);expect(f.travel.snapshot().state).toBe('planning');expect(f.travel.tripId).toBe(trip);
    f.pending[1]!.resolve(currentRoute(f));await flush();expect(f.sent).toEqual([]);
  });
  it.each(['resolve','reject'] as const)('Stop retires a replan and ignores its late %s after a new request',async outcome=>{
    const f=setup(true);f.start();officialArrival(f);f.travel.cancel();
    expect(f.pending[1]!.signal?.aborted).toBe(true);f.start();const trip=f.travel.tripId;
    if(outcome==='resolve')f.pending[1]!.resolve(currentRoute(f));else f.pending[1]!.reject(new Error('Retired replan'));
    f.pending[0]!.resolve(route());await flush();
    expect(f.travel.snapshot().state).toBe('planning');expect(f.travel.tripId).toBe(trip);expect(f.sent).toEqual([]);
    f.pending[2]!.resolve(currentRoute(f));await flush();f.travel.tick(f.context.map,f.context.player);
    expect(f.sent.map(a=>a.type)).toEqual(['walk']);
  });
  it.each(['identity','map','position','dead','missing'] as const)('rejects a replan when current %s changes before installation',async change=>{
    const f=setup(true);f.start();officialArrival(f);const planned=currentRoute(f);
    if(change==='identity')f.context.identity='connection-2/world-1/own-1';
    if(change==='map')f.context.map='prontera';
    if(change==='position')f.context.player!.x++;
    if(change==='dead')f.context.player!.dead=true;
    if(change==='missing')f.context.player=undefined;
    f.pending[1]!.resolve(planned);await flush();expect(f.pending[1]!.signal?.aborted).toBe(true);
    expect(f.travel.snapshot().state).toBe('failed');expect(f.sent).toEqual([]);
  });
  it.each(['identity','position'] as const)('revalidates a replanned %s immediately before movement',async change=>{
    const f=setup(true);f.start();officialArrival(f);f.pending[1]!.resolve(currentRoute(f));await flush();
    if(change==='identity')f.context.identity='replacement-own';else f.context.player!.x++;
    f.travel.tick(f.context.map,f.context.player);expect(f.travel.snapshot().state).toBe('failed');
    expect(f.sent.some(a=>a.type==='walk')).toBe(false);
  });
  it.each<GameEvent>([{type:'death',id:1},{type:'enter',id:1,map:'prt_fild08'},{type:'remove',id:1,dead:true}])('retires a replan on authoritative $type',async event=>{
    const f=setup(true);f.start();officialArrival(f);f.travel.observe([event]);
    expect(f.pending[1]!.signal?.aborted).toBe(true);f.pending[1]!.resolve(currentRoute(f));await flush();
    expect(f.travel.snapshot().state).toBe('failed');expect(f.sent).toEqual([]);
  });
  it('applies the original overall deadline while official replanning is stalled',async()=>{
    const f=setup(true);f.start();f.advance(1_199_000);officialArrival(f);
    f.advance(1001);f.travel.tick(f.context.map,f.context.player);
    expect(f.pending[1]!.signal?.aborted).toBe(true);
    expect(f.travel.snapshot()).toMatchObject({state:'failed',reason:'Travel reached its twenty-minute limit.'});
    f.pending[1]!.resolve(currentRoute(f));await flush();expect(f.sent).toEqual([]);
  });
  it.each(['unreachable','reject'] as const)('ends an unsuccessful official replan without movement (%s)',async outcome=>{
    const f=setup(true);f.start();officialArrival(f);
    if(outcome==='unreachable')f.pending[1]!.resolve(null);else f.pending[1]!.reject(new Error('Replan search failed'));
    await flush();expect(f.travel.snapshot()).toMatchObject({state:'failed',reason:outcome==='unreachable'
      ?'No verified route from the observed official movement destination.':'Replan search failed'});
    expect(f.pending[1]!.signal?.aborted).toBe(true);expect(f.sent).toEqual([]);
  });
  it('ends the current job if installing its arrival escape fails',async()=>{
    const f=setup(true);f.start();officialArrival(f);
    const escape=vi.spyOn(travelRoutes,'planArrivalEscape').mockImplementation(()=>{throw new Error('Arrival escape failed');});
    try{
      f.pending[1]!.resolve([]);await flush();expect(f.pending[1]!.signal?.aborted).toBe(true);
      expect(f.travel.snapshot()).toMatchObject({state:'failed',reason:'Arrival escape failed'});expect(f.sent).toEqual([]);
    }finally{escape.mockRestore();}
  });
  it('keeps legacy official replanning synchronous without creating a planning job',()=>{
    const f=setup(true);f.travel.start(f.context.map,f.context.player!,'prontera',10,false);const trip=f.travel.tripId;
    officialArrival(f);expect(f.pending).toHaveLength(0);expect(f.travel.tripId).toBe(trip);
    expect(f.travel.snapshot().state).toBe('walking');f.travel.tick(f.context.map,f.context.player);
    expect(f.sent.map(a=>a.type)).toEqual(['walk']);
  });
  it('returns from the official arrival handler before the existing scheduler performs search work',async()=>{
    let reads=0;const callbacks=new Set<()=>void>(),sent:Action[]=[];
    const edges=[{id:'bd',fromMap:'b',toMap:'d',area:{x:7,y:4,halfWidth:0,halfHeight:0},arrival:{x:1,y:1},source:{kind:'Warp' as const,commit:'fixture',path:'fixture',line:1}}];
    const planner=new TravelPlanner({edges,grid:map=>({width:10,height:10,portals:edges.filter(e=>e.fromMap===map).map(e=>e.area),walkable:p=>{reads++;return p.x>=0&&p.y>=0&&p.x<10&&p.y<10;}})});
    const context:TravelPlanningContext={identity:'old-own',map:'a',player:{...player(),x:1,y:1}};
    let travel!:TravelController;
    const scheduler:PlanningScheduler={now:()=>0,schedule:callback=>{
      expect(travel.snapshot().state).toBe('planning');callbacks.add(callback);return()=>callbacks.delete(callback);
    }};
    travel=new TravelController(a=>sent.push(a),()=>100_000,undefined,{context:()=>context,continueRequested:()=>true,scheduler,plan:planner.routeBetweenMapsAsync.bind(planner)});
    travel.start('a',context.player!,'d',10,false,policy);const trip=travel.tripId;
    context.map='b';context.identity=null;context.player=undefined;travel.observe([{type:'map',map:'b'}]);
    expect(callbacks.size).toBe(0);context.identity='new-own';context.player={...player(),x:1,y:1};
    travel.observe([{type:'spawn',entity:context.player,entryType:1}]);
    expect(travel.snapshot().state).toBe('planning');expect(travel.tripId).toBe(trip);
    expect(reads).toBe(0);expect(callbacks.size).toBe(1);expect(sent).toEqual([]);
    while(callbacks.size){const callback=callbacks.values().next().value!;callbacks.delete(callback);callback();}
    await flush();const expected=planner.routeBetweenMaps('b',{x:1,y:1},'d',false,policy)!;
    expect(travel.snapshot().route).toEqual(expected[0]!.cells);expect(travel.snapshot().state).toBe('walking');expect(sent).toEqual([]);
    travel.tick(context.map,context.player);expect(sent.map(a=>a.type)).toEqual(['walk']);
  });
});
describe('weighted planning owns travel before yielding',()=>{
  it.each(['stop','position'] as const)('retires planning before a trusted official %s replans the same trip',async type=>{
    const f=setup(true);f.start();const trip=f.travel.tripId;f.travel.officialGameplay();
    f.context.player={...player(),x:171};
    f.travel.observe([type==='stop'?{type,id:1}:{type,id:1,position:{x:171,y:370}}]);
    expect(f.pending[0]!.signal?.aborted).toBe(true);f.advance(301);f.travel.tick(f.context.map,f.context.player);
    f.pending[0]!.resolve(route());await flush();expect(f.travel.active).toBe(true);
    expect(f.travel.tripId).toBe(trip);expect(f.sent).toEqual([]);
    f.advance(1_200_000);f.travel.tick(f.context.map,f.context.player);
    expect(f.travel.snapshot()).toMatchObject({state:'failed',reason:'Travel reached its twenty-minute limit.'});
  });
  it.each(['resolve','reject'] as const)('retires a planner on official departure before its late %s can cancel the retained trip',async outcome=>{
    const f=setup(true);f.start();const trip=f.travel.tripId;
    const departure:GameEvent={type:'remove',id:1,dead:false,reason:0};
    f.travel.prepareObservation([departure]);f.context.identity=null;f.context.player=undefined;
    f.travel.observe([departure]);expect(f.pending[0]!.signal?.aborted).toBe(true);
    if(outcome==='resolve')f.pending[0]!.resolve(route());else f.pending[0]!.reject(new Error('Retired planner'));
    await flush();expect(f.travel.snapshot().state).toBe('transition');expect(f.travel.tripId).toBe(trip);expect(f.sent).toEqual([]);
    f.context.map='prontera';f.travel.observe([{type:'map',map:'prontera'}]);
    f.context.identity='connection-1/world-2/own-1';f.context.player={...player(),x:156,y:26};
    f.travel.observe([{type:'spawn',entity:f.context.player,entryType:1}]);
    expect(f.travel.snapshot().state).toBe('planning');f.pending[1]!.resolve([]);await flush();
    f.travel.tick(f.context.map,f.context.player);expect(f.travel.snapshot().state).toBe('complete');
    expect(f.travel.tripId).toBe(trip);expect(f.sent).toEqual([]);
  });
  it('claims ownership before invoking a planner, blocks duplicate and approach starts and dispatches only on a later tick',async()=>{
    const f=setup();f.start();
    expect(f.travel.snapshot()).toMatchObject({state:'planning',destination:'prontera',policy});expect(f.travel.active).toBe(true);
    expect(()=>f.start()).toThrow('Stop');expect(()=>f.travel.startApproach('prt_fild08',player(),{x:171,y:370})).toThrow('Stop');
    f.travel.tick(f.context.map,f.context.player);expect(f.sent).toEqual([]);
    f.pending[0]!.resolve(route());await flush();expect(f.travel.snapshot().state).toBe('walking');expect(f.sent).toEqual([]);
    f.travel.tick(f.context.map,f.context.player);expect(f.sent.map(a=>a.type)).toEqual(['walk']);
  });
  it.each(['identity','position'] as const)('revalidates %s again immediately before movement',async change=>{
    const f=setup();f.start();f.pending[0]!.resolve(route());await flush();
    if(change==='identity')f.context.identity='new-own-lifetime';else f.context.player!.x++;
    f.travel.tick(f.context.map,f.context.player);expect(f.travel.snapshot().state).toBe('failed');expect(f.sent.some(a=>a.type==='walk')).toBe(false);
  });
  it('Stop aborts promptly and late completion cannot overwrite or stop the newer owner',async()=>{
    const f=setup();f.start();f.travel.cancel();expect(f.pending[0]!.signal?.aborted).toBe(true);expect(f.travel.active).toBe(false);
    f.start();f.pending[0]!.resolve(route());await flush();expect(f.travel.snapshot().state).toBe('planning');expect(f.sent).toEqual([]);
    f.pending[1]!.resolve(route());await flush();f.travel.tick(f.context.map,f.context.player);expect(f.sent.map(a=>a.type)).toEqual(['walk']);
  });
  it.each(['identity','map','position','dead','missing'] as const)('rejects a result when %s changes without waiting for a controller tick',async(change)=>{
    const f=setup();f.start();
    if(change==='identity')f.context.identity='connection-2/world-1/own-1';
    if(change==='map')f.context.map='prontera';
    if(change==='position')f.context.player!.x++;
    if(change==='dead')f.context.player!.dead=true;
    if(change==='missing')f.context.player=undefined;
    f.pending[0]!.resolve(route());await flush();expect(f.travel.snapshot().state).toBe('failed');expect(f.sent).toEqual([]);
  });
  it.each<GameEvent>([{type:'map',map:'prontera'},{type:'enter',id:1,map:'prt_fild08'},{type:'clear'},
    {type:'remove',id:1,dead:false},{type:'death',id:1},{type:'spawn',entity:player()},
    {type:'position',id:1,position:{x:171,y:370}}])('cancels on own/world invalidation $type',async(event)=>{
    const f=setup();f.start();f.travel.observe([event]);expect(f.pending[0]!.signal?.aborted).toBe(true);
    f.pending[0]!.resolve(route());await flush();expect(f.travel.snapshot().state).toBe('failed');expect(f.sent).toEqual([]);
  });
  it('detaches policy and returns planner failures to a terminal state without issuing movement',async()=>{
    const f=setup(), mutable=structuredClone(policy);f.travel.start('prt_fild08',player(),'prontera',10,false,mutable);mutable.deny.push('prontera');
    expect(f.travel.snapshot().policy.deny).toEqual([]);f.pending[0]!.reject(new Error('injected search failure'));await flush();
    expect(f.travel.snapshot()).toMatchObject({state:'failed',reason:'injected search failure'});expect(f.sent).toEqual([]);
  });
  it('preserves the original trip deadline while a planner is stalled',async()=>{
    let now=100_000, signal:AbortSignal|undefined,resolve!: (steps:TravelStep[]|null)=>void;const sent:Action[]=[];
    const travel=new TravelController(a=>sent.push(a),()=>now,undefined,{plan:(_map,_from,_to,_walls,_policy,options)=>{
      signal=options?.signal;return new Promise(done=>{resolve=done;});
    }});
    travel.start('prt_fild08',player(),'payon',10,true,policy);now+=1_200_001;travel.tick('prt_fild08',player());
    expect(signal?.aborted).toBe(true);expect(travel.snapshot()).toMatchObject({state:'failed',reason:'Travel reached its twenty-minute limit.'});
    resolve(route());await flush();expect(travel.active).toBe(false);expect(sent).toEqual([]);
  });
  it('owns planning before the first real scheduled slice and cancellation removes that slice',async()=>{
    const callbacks=new Set<()=>void>();let travel!:TravelController;
    const scheduler:PlanningScheduler={now:()=>0,schedule:callback=>{expect(travel.active).toBe(true);expect(travel.snapshot().state).toBe('planning');callbacks.add(callback);return()=>callbacks.delete(callback);}};
    const sent:Action[]=[];travel=new TravelController(a=>sent.push(a),()=>100_000,undefined,{scheduler});
    travel.start('prt_fild08',player(),'payon',10,true,policy);expect(callbacks.size).toBe(1);travel.cancel();await flush();
    expect(callbacks.size).toBe(0);expect(travel.snapshot().state).toBe('cancelled');expect(sent).toEqual([]);
  });
});

import { vi } from 'vitest';
import { CompanionController } from '../runtime/controller';
import { DEFAULT_SETTINGS } from '../settings/settings';
import { BUILTIN_SERVICES } from '../services/npc-services';
describe('integrated planning arbitration',()=>{
  it('installs a finished route during panel yield without dispatching Walk until the two-second grace expires',async()=>{
    let now=100_000,resolve!: (steps:TravelStep[]|null)=>void;const sent:Action[]=[];
    const planned=route(),plan=vi.spyOn(travelRoutes,'routeBetweenMapsAsync').mockImplementation(()=>new Promise(done=>{resolve=done;}));
    const c=new CompanionController(a=>sent.push(a as Action),()=>now);
    try{
      c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player()}]);c.world.reset('prt_fild08');
      c.travel.start('prt_fild08',c.engine.player!,'prontera',10,false,policy);c.manualInput();
      expect(c.snapshot().travel.state).toBe('planning');resolve(planned);await flush();expect(c.snapshot().travel.state).toBe('walking');
      const tick=vi.spyOn(c.engine,'tick');
      now+=100;c.tick();now+=1899;c.tick();expect(tick).toHaveBeenNthCalledWith(1,false);expect(tick).toHaveBeenNthCalledWith(2,false);expect(sent).toEqual([]);
      now++;c.tick();expect(sent.map(a=>a.type)).toEqual(['walk']);
    }finally{c.stop();plan.mockRestore();}
  });
  it.each(['manualCommand','stop'] as const)('%s cancels planning during a panel yield and rejects a late route',async action=>{
    let now=100_000,resolve!: (steps:TravelStep[]|null)=>void,signal:AbortSignal|undefined;const sent:Action[]=[];
    const planned=route(),plan=vi.spyOn(travelRoutes,'routeBetweenMapsAsync').mockImplementation((_map,_from,_to,_walls,_policy,options)=>{
      signal=options?.signal;return new Promise(done=>{resolve=done;});
    });
    const c=new CompanionController(a=>sent.push(a as Action),()=>now);
    try{
      c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player()}]);c.world.reset('prt_fild08');
      c.travel.start('prt_fild08',c.engine.player!,'prontera',10,false,policy);c.manualInput();c[action]();expect(signal?.aborted).toBe(true);
      resolve(planned);await flush();now+=2000;c.tick();expect(c.snapshot().travel.state).toBe('cancelled');
      expect(c.active).toBe(false);expect(sent.every(a=>a.type==='stop')).toBe(true);
    }finally{c.stop();plan.mockRestore();}
  });
  it('expires a stalled plan at its original deadline while repeated panel input keeps decisions yielded',async()=>{
    let now=100_000,resolve!: (steps:TravelStep[]|null)=>void,signal:AbortSignal|undefined;const sent:Action[]=[];
    const planned=route(),plan=vi.spyOn(travelRoutes,'routeBetweenMapsAsync').mockImplementation((_map,_from,_to,_walls,_policy,options)=>{
      signal=options?.signal;return new Promise(done=>{resolve=done;});
    });
    const c=new CompanionController(a=>sent.push(a as Action),()=>now);
    try{
      c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player()}]);c.world.reset('prt_fild08');
      c.travel.start('prt_fild08',c.engine.player!,'prontera',10,false,policy);
      for(let second=0;second<1200;second++){c.manualInput();now+=1000;c.tick();}
      expect(c.snapshot().travel.state).toBe('planning');c.manualInput();now++;c.tick();
      expect(signal?.aborted).toBe(true);expect(c.snapshot().travel).toMatchObject({state:'failed',reason:'Travel reached its twenty-minute limit.'});
      resolve(planned);await flush();expect(c.active).toBe(false);expect(sent).toEqual([]);
    }finally{c.stop();plan.mockRestore();}
  });
  it('blocks duplicate Start, manual resource commands and service owners while planning, then Stop removes all pending slices',async()=>{
    vi.useFakeTimers();
    try {
      const sent:Action[]=[],c=new CompanionController(a=>sent.push(a as Action),()=>100_000);
      c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player()}]);c.world.reset('prt_fild08');
      c.travel.start('prt_fild08',c.engine.player!,'payon',10,true,policy);
      expect(c.snapshot().travel.state).toBe('planning');expect(c.active).toBe(true);
      expect(()=>c.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]})).toThrow('Stop');
      expect(()=>c.perform('command',{type:'useItem',itemId:501})).toThrow('Stop');
      expect(()=>c.perform('service',BUILTIN_SERVICES[0])).toThrow('current transaction');
      expect(vi.getTimerCount()).toBe(1);c.stop();await flush();expect(vi.getTimerCount()).toBe(0);
      expect(c.active).toBe(false);expect(sent.some(a=>a.type!=='stop')).toBe(false);
    } finally { vi.useRealTimers(); }
  });
  it.each(['replacement','world','connection'] as const)('binds the planner result to the merged own identity seam (%s)',async change=>{
    vi.useFakeTimers();
    try {
      const c=new CompanionController(()=>{},()=>100_000);c.connect(true);c.engine.receive([{type:'enter',id:0,map:'prt_fild08'},{type:'spawn',entity:{...player(),id:0}}]);c.world.reset('prt_fild08');
      c.travel.start('prt_fild08',c.engine.player!,'payon',10,true,policy);
      if(change==='replacement')c.engine.receive([{type:'remove',id:0,dead:false},{type:'spawn',entity:{...player(),id:0}}]);
      if(change==='world')c.world.reset('prt_fild08');
      if(change==='connection')c.connect(true);
      c.travel.tick(c.engine.map,c.engine.player);await flush();expect(c.travel.active).toBe(false);expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

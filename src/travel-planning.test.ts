import { describe, expect, it } from 'vitest';
import { TravelController, type TravelPlanningContext } from './travel-controller';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { routeBetweenMaps, type TravelStep } from './travel';
import * as travelRoutes from './travel';
import type { Entity, GameEvent } from './protocol';
import type { Action } from './engine';
import type { PlanningScheduler } from './route-planning';
const player = (): Entity => ({id:1,x:170,y:370,name:'Fixture',classId:0,kind:0,level:1,hp:100,maxHp:100,dead:false});
const policy = {...DEFAULT_MAP_POLICY,mode:'weighted' as const};
const route = () => routeBetweenMaps('prt_fild08',player(),'prontera',false,policy)!;
function setup() {
  const sent:Action[]=[], pending:Array<{resolve:(value:TravelStep[]|null)=>void;reject:(reason:unknown)=>void;signal?:AbortSignal}>=[];
  const context:TravelPlanningContext={identity:'connection-1/world-1/own-1',map:'prt_fild08',player:player()};
  const travel=new TravelController(a=>sent.push(a),()=>100_000,undefined,{context:()=>context,
    plan:(_map,_from,_destination,_walls,_policy,options)=>new Promise((resolve,reject)=>pending.push({resolve,reject,signal:options?.signal}))});
  const start=()=>travel.start(context.map,context.player!,'prontera',10,false,policy);
  return {travel,sent,pending,context,start};
}
const flush=async()=>{await Promise.resolve();await Promise.resolve();};
describe('weighted planning owns travel before yielding',()=>{
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
import { CompanionController } from './controller';
import { DEFAULT_SETTINGS } from './settings';
import { BUILTIN_SERVICES } from './npc-services';
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

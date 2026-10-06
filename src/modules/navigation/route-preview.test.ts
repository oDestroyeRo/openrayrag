import { describe, expect, it, vi } from 'vitest';
import { FeatureUi } from '../client/feature-ui';
import { DEFAULT_MAP_POLICY } from './map-policy';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
function setup() {
  const status={map:'prt_fild08',connected:true,compatible:true,sessionId:'fixture',connectionId:1,
    character:{inventoryKnown:true,skillsKnown:true,stats:{zeny:10000,hp:100},inventory:[{itemId:501,count:5}],learned:[{skillId:1,level:5}]},
    actors:[{id:7,kind:2,classId:99,name:'NPC',x:3,y:3,dead:false}],
    player:{id:0,x:169,y:193,dead:false},actorObservations:{world:'world1',actors:[{id:0,incarnation:1}]}};
  const automation={...structuredClone(DEFAULT_AUTOMATION),mapPolicy:structuredClone(DEFAULT_MAP_POLICY)},settings={...DEFAULT_SETTINGS,automation};
  const command=vi.fn(),service=vi.fn();
  const view:FeatureUi=Object.create(FeatureUi.prototype);
  Object.assign(view,{status,read:()=>automation,hooks:{map:()=>status.map,settings:()=>settings,command,service}});
  const output={textContent:''};
  const pending:Array<{resolve:(value:string)=>void;reject:(reason:unknown)=>void;signal:AbortSignal}>=[];
  const evidence=()=>Reflect.apply(Reflect.get(FeatureUi.prototype,'servicePreviewEvidence'),view,[]) as string;
  const start=(current?:()=>string)=>Reflect.apply(Reflect.get(FeatureUi.prototype,'previewRoute'),view,[output,(signal:AbortSignal)=>new Promise<string>((resolve,reject)=>pending.push({resolve,reject,signal})),current]) as Promise<void>;
  const cancel=()=>Reflect.apply(Reflect.get(FeatureUi.prototype,'cancelRoutePreview'),view,[]);
  return {view,status,automation,settings,command,service,output,pending,start,cancel,evidence};
}
describe('route preview lifetime',()=>{
  it('cancels the old preview and never installs its delayed result over a newer request',async()=>{
    const f=setup(),a=f.start(),b=f.start();expect(f.pending[0]!.signal.aborted).toBe(true);
    f.pending[0]!.resolve('Old route');await a;expect(f.output.textContent).toContain('Planning');
    f.pending[1]!.resolve('New route');await b;expect(f.output.textContent).toBe('New route');expect(f.command).not.toHaveBeenCalled();expect(f.service).not.toHaveBeenCalled();
  });
  it.each(['position','map','connection','world','incarnation','death','policy','walls'] as const)('does not install a successful preview after %s changed',async change=>{
    const f=setup(),result=f.start();
    if(change==='position')f.status.player.x++;
    if(change==='map')f.status.map='prontera';
    if(change==='connection')f.status.connectionId++;
    if(change==='world')f.status.actorObservations.world='world2';
    if(change==='incarnation')f.status.actorObservations.actors[0]!.incarnation++;
    if(change==='death')f.status.player.dead=true;
    if(change==='policy')f.automation.mapPolicy!.deny.push('prontera');
    if(change==='walls')f.settings.route_avoidWalls=false;
    f.pending[0]!.resolve('Stale successful route');await result;expect(f.output.textContent).toContain('cancelled');expect(f.command).not.toHaveBeenCalled();
  });
  it.each(['inventory','balance','mastery','npc'] as const)('invalidates service-specific %s prerequisites before publishing success',async change=>{
    const f=setup(),result=f.start(f.evidence);
    if(change==='inventory'){f.status.character.inventoryKnown=false;f.status.character.inventory[0]!.count=0;}
    if(change==='balance')f.status.character.stats.zeny=0;
    if(change==='mastery')f.status.character.learned[0]!.level=0;
    if(change==='npc')f.status.actors=[];
    f.pending[0]!.resolve('Service prerequisites passed');await result;
    expect(f.output.textContent).toContain('cancelled');expect(f.command).not.toHaveBeenCalled();expect(f.service).not.toHaveBeenCalled();
  });
  it('keeps service previews current through unrelated HP changes',async()=>{
    const f=setup(),result=f.start(f.evidence);f.status.character.stats.hp=75;f.pending[0]!.resolve('Current service preview');await result;
    expect(f.output.textContent).toBe('Current service preview');
  });
  it('keeps cancellation terminal when an old calculation rejects',async()=>{
    const f=setup(),result=f.start();f.cancel();const cancelled=f.output.textContent;f.pending[0]!.reject(new Error('Late failure'));await result;
    expect(f.output.textContent).toBe(cancelled);expect(f.pending[0]!.signal.aborted).toBe(true);expect(f.command).not.toHaveBeenCalled();expect(f.service).not.toHaveBeenCalled();
  });
});

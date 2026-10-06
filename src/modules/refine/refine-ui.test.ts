import {afterEach,describe,it,expect,vi} from 'vitest';
import {RefineUi,validRefineSnapshot} from './refine-ui';
import {DEFAULT_AUTOMATION} from '../settings/settings';
import type {RefineSnapshot} from './refine';
import type {RefinePreviewRequest,RefineRequest} from './refine-protocol';
class Element {
 children:Element[]=[];textContent='';value='';disabled=false;dataset:Record<string,string>={};attributes=new Map<string,string>();listeners=new Map<string,Array<()=>unknown>>();
 constructor(readonly tag:string){}
 append(...children:Element[]):void{this.children.push(...children);if(this.tag==='select'&&!this.value&&children[0])this.value=children[0].value;}
 replaceChildren(...children:Element[]):void{this.children=[];this.value='';this.append(...children);}
 setAttribute(name:string,value:string):void{this.attributes.set(name,value);}
 addEventListener(name:string,callback:()=>unknown):void{this.listeners.set(name,[...(this.listeners.get(name)??[]),callback]);}
 all():Element[]{return[this,...this.children.flatMap(child=>child.all())];}
 async emit(name:string):Promise<void>{for(const fn of this.listeners.get(name)??[])fn();await Promise.resolve();await Promise.resolve();}
}
function setup(){vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});const preview=vi.fn(async(_request:RefinePreviewRequest)=>{}),send=vi.fn(async(_request:RefineRequest)=>{}),close=vi.fn(async()=>{}),notify=vi.fn(),policy=structuredClone(DEFAULT_AUTOMATION);
 const ui=new RefineUi(()=>policy,preview,send,close,notify),root=ui.root as unknown as Element;
 const status={connected:true,compatible:true,sessionId:'test',connectionId:'one',player:{id:0,dead:false},world:{npc:{id:0,mode:'refine'}},actorObservations:{world:'life'},refine:{state:'idle',blocked:false,reason:'Ready',dialogueToken:'bb'.repeat(16),preview:null,candidates:[{bagId:700,itemId:1201,name:'<Knife>',refine:7}]} as RefineSnapshot};
 ui.render(status);ui.lock(false);
 const field=(name:string)=>root.all().find(node=>node.attributes.get('aria-label')===name)!;
 const button=(text:string)=>root.all().find(node=>node.tag==='button'&&node.textContent===text)!;
 const ready=async(failurePossible=true)=>{await button('Preview one refine').emit('click');status.refine={...status.refine,state:'preview',preview:{token:'aa'.repeat(16),targetBagId:700,itemId:1201,name:'<Knife>',startingRefine:7,oreItemId:1010,zenyCost:200,failurePossible,npcId:0}};ui.render(status);};
 return{ui,root,status,policy,preview,send,close,notify,field,button,ready};}
afterEach(()=>vi.unstubAllGlobals());
describe('one-attempt refine controls',()=>{
 it('requires separate preview and risk-labeled commit; passes current protection policy without sending on Enter',async()=>{const f=setup();await f.field('Refine equipment').emit('keydown');expect(f.send).not.toHaveBeenCalled();await f.ready();
  expect(f.field('Refine preview').textContent).toContain('<Knife> +7');expect(f.field('Refine preview').textContent).toContain('200 zeny');expect(f.field('Refine preview')).not.toHaveProperty('innerHTML');
  await f.button('Accept downgrade risk and spend once').emit('click');expect(f.send).toHaveBeenCalledOnce();expect(f.send.mock.calls[0]![0]).toMatchObject({targetBagId:700,catalystBagId:0,policy:f.policy,maxSpend:10000,minZeny:0,previewToken:'aa'.repeat(16)});
  await f.button('Accept downgrade risk and spend once').emit('click');expect(f.send).toHaveBeenCalledOnce();});
 it('invalidates edited amounts, policy and session without replay',async()=>{const f=setup();await f.ready();f.field('Refine spending limit').value='199';await f.field('Refine spending limit').emit('input');expect(f.button('Accept downgrade risk and spend once').disabled).toBe(true);
  f.field('Refine spending limit').value='10000';await f.ready();f.policy.items.push({itemId:1010,resource:'hp',belowPercent:50,minStock:3,cooldownSeconds:1});await f.button('Accept downgrade risk and spend once').emit('click');expect(f.send).not.toHaveBeenCalled();
  await f.ready();f.ui.render({...f.status,connectionId:'two'});expect(f.button('Accept downgrade risk and spend once').disabled).toBe(true);expect(f.send).not.toHaveBeenCalled();});
 it('blocks every resource action and NPC close while unresolved, and requires explicit advance',async()=>{const f=setup();await f.ready(false);f.ui.render({...f.status,refine:{...f.status.refine,state:'uncertain',blocked:true}});
  await f.button('Spend ore and zeny for one attempt').emit('click');await f.button('Advance / close refining dialogue').emit('click');expect(f.send).not.toHaveBeenCalled();expect(f.close).not.toHaveBeenCalled();
  f.ui.render(f.status);await f.button('Advance / close refining dialogue').emit('click');expect(f.close).toHaveBeenCalledOnce();});
 it('preserves a literal snapshot and rejects oversized or unknown telemetry',()=>{const f=setup();expect(validRefineSnapshot(f.status.refine)).toBe(true);
  for(const change of [{state:'sent'},{blocked:0},{reason:'x'.repeat(513)},{extra:{}},{preview:{}},{candidates:Array(201).fill(f.status.refine.candidates[0])}])expect(validRefineSnapshot({...f.status.refine,...change})).toBe(false);
  expect(validRefineSnapshot({...f.status.refine,candidates:[{...f.status.refine.candidates[0],guid:'private'}]})).toBe(false);f.ui.clear();expect(f.button('Preview one refine').disabled).toBe(true);});
});
it('holds updater admission while a preview request or displayed confirmation is outstanding',async()=>{const f=setup();expect(f.ui.settledForMaintenance()).toBe(true);
 let release:()=>void=()=>{};f.preview.mockImplementation(()=>new Promise<void>(resolve=>{release=resolve;}));await f.button('Preview one refine').emit('click');expect(f.ui.settledForMaintenance()).toBe(false);
 release();await Promise.resolve();await Promise.resolve();expect(f.ui.settledForMaintenance()).toBe(false);
 f.ui.clear();expect(f.ui.settledForMaintenance()).toBe(true);
});
it('keeps updater excluded through a displayed preview and uncertain receipt, then releases on reconciled state',async()=>{const f=setup();await f.ready();expect(f.ui.settledForMaintenance()).toBe(false);
 await f.button('Accept downgrade risk and spend once').emit('click');f.ui.render({...f.status,refine:{...f.status.refine,preview:null,blocked:true,state:'uncertain'}});expect(f.ui.settledForMaintenance()).toBe(false);
 f.ui.render({...f.status,refine:{...f.status.refine,preview:null,blocked:false,state:'reconciled'}});expect(f.ui.settledForMaintenance()).toBe(true);
});
it('retires local confirmation after authoritative preview invalidation and rejects it after current-form policy edits',async()=>{const f=setup();await f.ready();f.ui.render({...f.status,refine:{...f.status.refine,preview:null,state:'idle'}});expect(f.ui.settledForMaintenance()).toBe(true);
 await f.ready();f.policy.items.push({itemId:1010,resource:'hp',belowPercent:50,minStock:3,cooldownSeconds:1});f.ui.policyChanged();await f.button('Accept downgrade risk and spend once').emit('click');expect(f.send).not.toHaveBeenCalled();
});

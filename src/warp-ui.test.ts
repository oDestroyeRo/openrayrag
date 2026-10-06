import {afterEach,describe,expect,it,vi} from 'vitest';
import {WarpUi,validWarpSnapshot} from './warp-ui';
import {FeatureUi,validFeatureStatus} from './feature-ui';
import {DEFAULT_AUTOMATION} from './settings';
import {validateWarpRequest,type WarpRequest} from './warp-protocol';
import {incrementRevision,quantity,revisionFor} from './domain-values';
import {memoCell} from './memo-protocol';
import type {WarpSnapshot} from './warp';
class Element {
 children:Element[]=[];textContent='';value='';disabled=false;open=true;dataset:Record<string,string>={};attributes=new Map<string,string>();listeners=new Map<string,Array<()=>unknown>>();
 constructor(readonly tag:string){}append(...children:Element[]):void{this.children.push(...children);}setAttribute(k:string,v:string):void{this.attributes.set(k,v);}addEventListener(k:string,callback:()=>unknown):void{this.listeners.set(k,[...(this.listeners.get(k)??[]),callback]);}all():Element[]{return[this,...this.children.flatMap(child=>child.all())];}async emit(k:string):Promise<void>{for(const callback of this.listeners.get(k)??[])callback();await Promise.resolve();await Promise.resolve();}
}
const binding=validateWarpRequest({type:'warpActivate',preview:{world:'00000000-0000-4000-8000-000000000001',actorId:0,incarnation:1,connectionEpoch:1,revision:1,map:'prt_fild08',x:10,y:10,generation:1,level:4,inventoryRevision:1,equipmentRevision:1,spRevision:1,skillsRevision:1}}).preview;
function setup(){vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});const policy=structuredClone(DEFAULT_AUTOMATION),send=vi.fn(async()=>{}),prepare=vi.fn(async()=>{}),cancel=vi.fn(async()=>{}),notify=vi.fn();const ui=new WarpUi(send,notify,prepare,()=>policy,cancel),root=ui.root as unknown as Element;
 const snapshot:WarpSnapshot={generation:binding.generation,blocked:false,pending:false,state:'idle',reason:'Ready',ready:binding,activation:null,preview:null,slots:[{map:'prontera',x:100,y:100},null,null,null],cost:26,gems:quantity(3),reserve:quantity(1),selection:'unknown',resourceEvidence:'No request sent.',captured:null};
 const request:WarpRequest=validateWarpRequest({type:'warpGround',slot:0,target:{x:11,y:10},preview:binding});
 const status=(warp=snapshot)=>({sessionId:'page',connectionId:'socket',player:{id:0,name:'Synthetic'},warp});
 const render=(patch:Partial<WarpSnapshot>={})=>{Object.assign(snapshot,patch);ui.render(status());};
 const button=(name:string)=>root.all().find(n=>n.tag==='button'&&n.textContent===name)!,field=(name:string)=>root.all().find(n=>n.attributes.get('aria-label')===name)!;
 ui.render(status());ui.lock(false);field('Warp ground X').value='11';field('Warp ground Y').value='10';
 const groundPreview=async()=>{await button('Preview ground request').emit('click');render({preview:request});};
 return {ui,root,policy,send,prepare,cancel,notify,snapshot,request,status,render,button,field,groundPreview};
}
afterEach(()=>vi.unstubAllGlobals());
describe('explicit Warp UI and telemetry boundary',()=>{
 it('discloses resource and restrictive recovery before sending; preview does not send',async()=>{const s=setup();expect(s.root.all().map(n=>n.textContent).join(' ')).toContain('Automation stays held until verified death/revival');expect(s.button('Submit ground once').disabled).toBe(true);await s.groundPreview();expect(s.prepare).toHaveBeenCalledExactlyOnceWith({type:'warpGround',slot:0,target:{x:11,y:10},policy:s.policy});expect(s.send).not.toHaveBeenCalled();expect(s.field('Warp request preview').textContent).toContain('prontera (100, 100)');expect(s.field('Warp request preview').textContent).toContain('26');await s.button('Submit ground once').emit('click');await s.button('Submit ground once').emit('click');expect(s.send).toHaveBeenCalledExactlyOnceWith({...s.request,policy:s.policy});});
 it('requires a separate activation preview, uses the captured destination, and never automatically enters',async()=>{const s=setup(),preview={...binding,spRevision:incrementRevision(binding.spRevision)},activation:WarpRequest={type:'warpActivate',preview};s.render({ready:null,blocked:true,pending:true,state:'selectionObserved',activation,captured:{slot:0,ground:{x:memoCell(11),y:memoCell(10)},destination:{map:'prontera',x:100,y:100}}});expect(s.send).not.toHaveBeenCalled();await s.button('Activate once').emit('click');expect(s.send).not.toHaveBeenCalled();await s.button('Preview activation').emit('click');s.render({preview:activation});expect(s.field('Warp request preview').textContent).toContain('Second-stage SP cost: 0');expect(s.field('Warp request preview').textContent).toContain('including failure');await s.button('Activate once').emit('click');expect(s.send).toHaveBeenCalledExactlyOnceWith({...activation,policy:s.policy});expect(s.send).toHaveBeenCalledOnce();});
 it('retires ground or activation preview when policy, input, generation or resources change',async()=>{for(const why of ['policy','target','generation','resource']){const s=setup();await s.groundPreview();if(why==='policy'){s.policy.items=[{itemId:717,resource:'hp',belowPercent:50,minStock:3,cooldownSeconds:1}];s.ui.policyChanged();}if(why==='target')await s.field('Warp ground X').emit('input');if(why==='generation')s.render({generation:revisionFor('warp',2),ready:{...binding,generation:2},preview:null});if(why==='resource')s.render({ready:{...binding,inventoryRevision:2},preview:null});await s.button('Submit ground once').emit('click');expect(s.send).not.toHaveBeenCalled();}});
 it('sends only local cancellation on dismissal and does not resurrect a dismissed preview',async()=>{const s=setup();await s.groundPreview();s.root.open=false;await s.root.emit('toggle');expect(s.cancel).toHaveBeenCalledOnce();s.render({preview:s.request});await s.button('Submit ground once').emit('click');expect(s.send).not.toHaveBeenCalled();});
 it('does not consume an older response for a changed target or submit while locked',async()=>{const s=setup();await s.button('Preview ground request').emit('click');s.field('Warp ground X').value='12';await s.field('Warp ground X').emit('input');await s.button('Preview ground request').emit('click');s.render({preview:s.request});expect(s.button('Submit ground once').disabled).toBe(true);s.ui.lock(true);await s.button('Submit ground once').emit('click');expect(s.send).not.toHaveBeenCalled();});
 it('strictly validates bounded statuses and holds other UI owners',()=>{const s=setup();expect(validWarpSnapshot(s.snapshot)).toBe(true);for(const warp of [{...s.snapshot,extra:1},{...s.snapshot,reason:'x'.repeat(769)},{...s.snapshot,pending:true},{...s.snapshot,ready:{...binding,actorId:-1}},{...s.snapshot,slots:[]},{...s.snapshot,captured:{slot:0,ground:{x:512,y:1},destination:{map:'x',x:1,y:1}}},{...s.snapshot,activation:{type:'warpGround',slot:0,target:{x:11,y:10},preview:binding}}]){expect(validWarpSnapshot(warp)).toBe(false);expect(validFeatureStatus({warp})).toBe(false);}for(const method of [FeatureUi.prototype.active,FeatureUi.prototype.serviceBlocked])expect(Reflect.apply(method,{status:{warp:{blocked:true}}},[])).toBe(true);});
});


it('retires the controller preview on policy or coordinate edits so a hidden preview cannot hold updates',async()=>{
 for(const edit of ['policy','coordinate']){const s=setup();await s.groundPreview();if(edit==='policy')s.ui.policyChanged();else await s.field('Warp ground X').emit('input');expect(s.cancel).toHaveBeenCalledOnce();expect(s.send).not.toHaveBeenCalled();}
});
it('cancels again after a preview acknowledgment that arrives after dismissal',async()=>{
 const s=setup();let acknowledge!:()=>void;s.prepare.mockImplementation(()=>new Promise<void>(resolve=>{acknowledge=resolve;}));
 await s.button('Preview ground request').emit('click');s.root.open=false;await s.root.emit('toggle');expect(s.cancel).toHaveBeenCalledOnce();
 acknowledge();await Promise.resolve();await Promise.resolve();expect(s.cancel).toHaveBeenCalledTimes(2);s.render({preview:s.request});expect(s.button('Submit ground once').disabled).toBe(true);expect(s.send).not.toHaveBeenCalled();
});

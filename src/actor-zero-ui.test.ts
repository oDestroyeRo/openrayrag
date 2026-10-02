import {afterEach,describe,it,expect,vi} from 'vitest';
import {FeatureUi,actorInput} from './feature-ui';
import {ActorPredicateEditor} from './actor-predicate-ui';
import {ActorObservations} from './actor-observations';
import {socialContextFromStatus} from './social-ui';
class Element {
 children:Element[]=[];parentElement:Element|null=null;value='';textContent='';id='';dataset:Record<string,string>={};disabled=false;listeners=new Map<string,Array<()=>unknown>>();
 constructor(readonly tag:string){}
 append(...nodes:Element[]){for(const node of nodes){node.parentElement=this;if(this.tag==='select'&&!this.children.length)this.value=node.value;this.children.push(node);}}
 replaceChildren(...nodes:Element[]){this.children=[];this.append(...nodes);}
 setAttribute(){}
 addEventListener(name:string,callback:()=>unknown){this.listeners.set(name,[...(this.listeners.get(name)??[]),callback]);}
 all():Element[]{return[this,...this.children.flatMap(n=>n.all())];}
 querySelector(selector:string){return this.all().find(n=>selector.split(',').includes(n.tag))??null;}
 querySelectorAll(){return[];}
 async emit(name:string){for(const callback of this.listeners.get(name)??[])callback();await Promise.resolve();await Promise.resolve();}
}
afterEach(()=>vi.unstubAllGlobals());
describe('explicit zero actor UI inputs',()=>{
 it('keeps blank unknown and rejects malformed numeric values',()=>{expect(actorInput('',true)).toBeUndefined();expect(actorInput('  ',true)).toBeUndefined();expect(()=>actorInput('')).toThrow();expect(actorInput('0')).toBe(0);for(const value of ['-1','1.5','Infinity','2147483648'])expect(()=>actorInput(value)).toThrow();});
 it('uses the real manual button callbacks: blank item has no target, explicit zero survives, blank target skill emits nothing',async()=>{
  vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});const panels=new Map(['combat','recovery','travel','inventory','workflows'].map(key=>[key,new Element('section')]));const command=vi.fn(async(_action:unknown)=>{}),notify=vi.fn();const view=Object.create(FeatureUi.prototype);
  Object.assign(view,{panels,hooks:{command,notify},manualLocked:false,editor:()=>{}});Reflect.apply(Reflect.get(FeatureUi.prototype,'rules'),view,[]);
  const nodes=panels.get('inventory')!.all();const target=nodes.find(n=>n.id==='manual-target')!;const button=(name:string)=>nodes.find(n=>n.tag==='button'&&n.textContent===name)!;
  expect(target.value).toBe('');await button('Use item').emit('click');expect(command).toHaveBeenLastCalledWith({type:'useItem',itemId:501});
  target.value='0';await button('Use item').emit('click');expect(command).toHaveBeenLastCalledWith({type:'useItem',itemId:501,target:0});await button('Target skill').emit('click');expect(command).toHaveBeenLastCalledWith({type:'skill',mode:'target',skillId:1,level:1,target:0});
  target.value='';const count=command.mock.calls.length;await button('Target skill').emit('click');expect(command).toHaveBeenCalledTimes(count);expect(notify).toHaveBeenLastCalledWith('Choose an observed actor ID.',true);
 });
 it('uses blank versus zero NPC and workflow inputs in the actual workflow panel',async()=>{
  vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});const panel=new Element('section');const command=vi.fn(async(_action:unknown)=>{}),workflow=vi.fn(async(_spec:unknown)=>{}),notify=vi.fn();const view=Object.create(FeatureUi.prototype);
  Object.assign(view,{panels:new Map([['workflows',panel]]),hooks:{command,workflow,notify,map:()=>"prt_fild08"},manualLocked:false,status:{},locked:false});Reflect.apply(Reflect.get(FeatureUi.prototype,'workflows'),view,[]);
  const input=(id:string)=>panel.all().find(n=>n.id===id)!;const button=(name:string)=>panel.all().find(n=>n.tag==='button'&&n.textContent===name)!;
  expect(input('npc-id').value).toBe('');await button('Talk').emit('click');expect(command).not.toHaveBeenCalled();input('npc-id').value='0';await button('Talk').emit('click');expect(command).toHaveBeenLastCalledWith({type:'npcTalk',id:0});
  await button('＋ Add step').emit('click');await button('Start workflow').emit('click');expect(workflow).not.toHaveBeenCalled();input('workflow-npc').value='0';await button('Start workflow').emit('click');expect(workflow).toHaveBeenCalledWith(expect.objectContaining({npcId:0}));
 });
 it('edits resource thresholds and displays source, freshness and unavailable reasons',async()=>{
  vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});let at=1000;const o=new ActorObservations(()=>at);o.spawn({id:0,kind:0,classId:0,name:'Synthetic',level:1,hp:50,maxHp:100,x:1,y:1,dead:false,statuses:[]},0);o.frame();const editor=new ActorPredicateEditor(()=>o.snapshot(0,null,true),()=>{});editor.write([{field:'actorHpPercent',actor:{scope:'self'},operator:'lte',value:50}]);
  const root=editor.root as unknown as Element;expect(editor.read()).toEqual([{field:'actorHpPercent',actor:{scope:'self'},operator:'lte',value:50}]);expect(root.all().some(n=>n.textContent.includes('HP 50.00% from spawn'))).toBe(true);
  const threshold=root.all().find(n=>n.tag==='label'&&n.textContent==='Threshold %')!.children[0]!;threshold.value='25.5';await threshold.emit('input');expect(editor.read()![0]!.value).toBe(25.5);
  at+=15001;o.frame();await threshold.emit('input');expect(root.all().some(n=>n.textContent.includes('15-second limit'))).toBe(true);threshold.value='';await threshold.emit('input');expect(Number.isNaN(editor.read()![0]!.value)).toBe(true);
 });
 it('binds actor zero through the actual observed actor picker and leaves blank unbound',async()=>{
  vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});const o=new ActorObservations(()=>1000);o.spawn({id:0,kind:0,classId:0,name:'Synthetic',level:1,hp:10,maxHp:10,x:1,y:1,dead:false,statuses:[]});o.frame();const snap=o.snapshot(0,null,true);const editor=new ActorPredicateEditor(()=>snap,()=>{});editor.write([{field:'actorCasting',actor:{scope:'self'},operator:'eq',value:false}]);
  const root=editor.root as unknown as Element;const select=(label:string)=>root.all().find(n=>n.tag==='label'&&n.children.some(c=>c.textContent===label))!.children.find(n=>n.tag==='select')!;
  const scope=select('Actor');scope.value='actor';await scope.emit('change');const actors=select('Choose / rebind actor');expect(actors.children.some(n=>n.value==='0')).toBe(true);await actors.emit('change');expect(editor.read()![0]!.actor).not.toMatchObject({id:0});
  actors.value='0';await actors.emit('change');expect(editor.read()![0]!.actor).toEqual({scope:'actor',id:0,world:snap.world,incarnation:snap.actors[0]!.incarnation});
 });
 it('requires bounded appropriate own telemetry for social readiness without sending social actions',()=>{expect(socialContextFromStatus({connected:true,compatible:true,player:{id:0,kind:0}})).toMatchObject({ready:true,actorId:0});for(const player of [null,{id:0,kind:1},{id:-1,kind:0},{id:null,kind:0},{}])expect(socialContextFromStatus({connected:true,compatible:true,player})).toMatchObject({ready:false,actorId:null});});
});

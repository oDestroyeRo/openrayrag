import { partyMemberId } from '../../shared/domain-values';
import {describe,it,expect} from 'vitest';
import {CompanionController} from '../runtime/controller';
import {DEFAULT_AUTOMATION,DEFAULT_SETTINGS,DEFAULT_PARTY_HEAL,validateAutomation,type Settings} from '../settings/settings';
import {BitWriter} from '../../shared/binary';
import {type Entity,type GameEvent} from '../protocol/protocol';
import {FEATURE_OP,type SkillResult} from '../protocol/protocol-feature';
import {matchesPartyHealExecution} from '../combat/skill-execution';
import {GridNavigator,type WalkGrid} from '../navigation/navigation';
import {manualTargetPolicy} from '../combat/manual-target';
import {DEFAULT_MAP_POLICY} from '../navigation/map-policy';
import {BUILTIN_SERVICES} from '../services/npc-services';
import {vi} from 'vitest';
const own:Entity={id:0,kind:0,classId:3,name:'Acolyte',level:20,hp:100,maxHp:100,sp:100,maxSp:100,x:10,y:10,dead:false,statuses:[],partyId:5,partyName:'Party'};
const member:Entity={...own,id:2,name:'Member',hp:40,x:11};
const grid:WalkGrid={width:40,height:40,walkable:()=>true};
function joined(rows:Entity[]=[member]):Uint8Array {const w=new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(rows.length);for(const p of rows){w.i32(p.id+5).i32(p.id).i16(20).string(p.name).u8(0);if(p.id>0)w.string('prt_fild08').i32(p.hp).i32(p.maxHp).i32(30).i32(100);}return w.finish();}
function result(extra:Partial<SkillResult>={}):SkillResult{return {type:'skillResult',source:0,target:2,skillId:41,level:1,mode:'target',result:2,hits:0,damage:-20,indirect:false,motionSeconds:0,position:own,...extra};}
function resultPacket(e:SkillResult):Uint8Array{return new BitWriter().u8(FEATURE_OP.skill).u8(e.mode==='target'?1:5).i32(e.source).i32(e.attacker??-1).i32(e.target??-1).u8(e.skillId).u8(e.level).u8(0).position(e.position).i32(e.damage??-20).u8(e.result??2).u8(e.hits??0).f32(e.motionSeconds).f32(0).bool(e.indirect??false).finish();}
function statsPacket(sp:number,full=true):Uint8Array {
 const w=new BitWriter().u8(56);
 for(const value of [20,1,1000,1,1,1,1,1,1,0,0,0,100,100,sp,100,...Array(16).fill(0),1000])w.i32(value);
 w.f32(.4).i32(0).i32(0);if(full)w.bool(false).bool(false);return w.finish();
}
function spawnPacket(entity:Entity):Uint8Array {
 const name=new TextEncoder().encode(entity.name);
 const body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0).i32(~name.length).i32(entity.name.length).take(name)
  .u8(entity.kind).u8(0).u8(0).i32(entity.x).i32(entity.y).u8(entity.level).i32(entity.hp).i32(entity.maxHp)
  .i32(entity.sp??0).i32(entity.maxSp??0).i32(0).u8(entity.id===0?1:0).finish();
 return new BitWriter().u8(6).u8(0).i32(body.length).take(body).finish();
}
function setup(g=grid,rows=[member],sendHook?:(c:CompanionController)=>void){let at=100_000;const sent:unknown[]=[];let c:CompanionController;c=new CompanionController(action=>{sent.push(action);if(action.type==='skill')sendHook?.(c);},()=>at,()=>g);c.connect(true);c.engine.receive([{type:'enter',id:0,map:'prt_fild08'},{type:'spawn',entity:{...own}},...rows.map(entity=>({type:'spawn' as const,entity:{...entity}})),{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:41,level:10}]}]);c.world.reset('prt_fild08');c.receive(joined(rows));const a=structuredClone(DEFAULT_AUTOMATION);a.combat.mode='off';a.partyHeal={...DEFAULT_PARTY_HEAL,enabled:true,cooldownSeconds:1};const settings:Settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[],loot:false,automation:a};const step=(ms=100)=>{at+=ms;c.tick();};const event=(...events:GameEvent[])=>{c.engine.receive(events);c.tick();};const sp=(value=100)=>c.receive(new BitWriter().u8(39).i32(value).i32(100).finish());const hp=(id=7,value=40)=>c.receive(new BitWriter().u8(102).u8(8).i32(id).i32(value).i32(100).i32(30).i32(100).finish());return {c,sent,settings,step,event,sp,hp,time:()=>at};}
function freshConnection(f:ReturnType<typeof setup>):void {
 f.c.disconnect();f.c.connect(true);
 f.c.engine.receive([{type:'enter',id:0,map:'prt_fild08'},{type:'spawn',entity:{...own}},{type:'spawn',entity:{...member}},
  {type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:41,level:10}]}]);
 f.c.world.reset('prt_fild08');f.c.receive(joined());f.c.receive(statsPacket(100));f.sp(100);
}

it('update checkpoint retains Heal allowance and cooldown only after execution and fresh SP',()=>{
 const f=setup();f.settings.automation!.partyHeal!.cooldownSeconds=3;f.c.start(f.settings);f.step();
 f.c.prepareUpdate();expect(f.c.partyHeal.checkpoint()).toBeNull();f.c.receive(resultPacket(result()));
 expect(f.c.partyHeal.checkpoint()).toBeNull();f.sp();f.step();
 const checkpoint=f.c.partyHeal.checkpoint()!;expect(checkpoint).toEqual({version:1,attempts:1,confirmed:1,cooldownUntil:f.time()-100+3000});
 const next=setup();next.c.partyHeal.restore(checkpoint);expect(next.c.partyHeal.snapshot()).toMatchObject({attempts:1,confirmed:1,resourceReadback:false});
 expect(next.c.partyHeal.available(next.settings.automation!.partyHeal,true)).toBe(false);
 f.c.cancelUpdate();f.step();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
});
describe('stationary automatic party Heal',()=>{
 it('is absent/default-off and adds no route search or packet',()=>{const f=setup();delete f.settings.automation!.partyHeal;const spy=vi.spyOn(GridNavigator.prototype,'plan');f.c.start(f.settings);f.step();expect(f.sent).toEqual([]);expect(spy).not.toHaveBeenCalled();spy.mockRestore();expect(Object.hasOwn(validateAutomation(DEFAULT_AUTOMATION),'partyHeal')).toBe(false);});
 it('dispatches Heal at owner zero and captures its receipt before a reentrant transport',()=>{let captured=false;const f=setup(grid,[member],c=>{captured=c.partyHeal.snapshot().attempts===1&&c.partyHeal.snapshot().sequence===c.engine.actionResult.sequence;c.receive(resultPacket(result()));});f.c.start(f.settings);f.step();expect(captured).toBe(true);expect(f.sent).toEqual([{type:'skill',mode:'target',target:2,skillId:41,level:1}]);expect(f.c.snapshot().partyHeal).toMatchObject({attempts:1,confirmed:1});});
 it('ranks exact HP ratios then stable member ID, never a lower-HP monster',()=>{const f=setup(grid,[{...member,id:3,name:'Third',hp:20},{...member,hp:20}]);f.event({type:'spawn',entity:{...member,id:9,kind:1,hp:1}});f.c.start(f.settings);f.step();expect(f.sent.at(-1)).toMatchObject({target:2});});
 it.each([{source:1},{target:3},{skillId:42},{level:2},{mode:'self' as const},{result:0},{hits:1},{attacker:3},{indirect:true},{indirect:undefined}])('rejects wrong or indirect receipt %j',extra=>{expect(matchesPartyHealExecution({type:'skill',mode:'target',target:2,skillId:41,level:1},result(extra),0)).toBe(false);const f=setup();f.c.start(f.settings);f.step();f.c.receive(resultPacket(result({...extra,mode:'target'})));if(extra.mode==='self'||Object.hasOwn(extra,'indirect')&&extra.indirect===undefined)return;expect(f.c.snapshot().partyHeal?.confirmed).toBe(0);expect(f.c.engine.pendingFeatureAction?.type).toBe('skill');});
 it('requires one second after-cast at motion zero and fresh own SP before repeating',()=>{const f=setup();f.c.start(f.settings);f.step();f.c.receive(resultPacket(result()));f.step(999);expect(f.sent).toHaveLength(1);f.step(1);expect(f.sent).toHaveLength(1);f.sp();f.hp();f.step();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);});
 it('never uses HP recovery or SP debit as execution confirmation',()=>{const f=setup();f.c.start(f.settings);f.step();f.hp(7,60);f.sp();expect(f.c.snapshot().partyHeal?.confirmed).toBe(0);expect(f.c.partyHeal.busy).toBe(true);});
 it('preserves Stop uncertainty, admits only an exact late receipt and no implicit Start',()=>{const f=setup();f.c.start(f.settings);f.step();f.c.stop();expect(f.c.partyHeal.busy).toBe(true);expect(f.c.settledForMaintenance()).toBe(false);expect(()=>f.c.start(f.settings)).toThrow('previous party Heal');expect(()=>f.c.perform('command',{type:'sit',sitting:true})).toThrow();f.c.receive(resultPacket(result({hits:1})));expect(f.c.partyHeal.busy).toBe(true);f.c.receive(resultPacket(result()));expect(f.c.partyHeal.busy).toBe(false);expect(f.c.runRequested).toBe(false);f.step(1000);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);});
 it.each(['target','self','map','transport'] as const)('cannot credit a late result after %s lifetime changes',change=>{const f=setup();f.c.start(f.settings);f.step();f.c.stop();if(change==='target')f.event({type:'spawn',entity:{...member}});if(change==='self')f.event({type:'spawn',entity:{...own}});if(change==='map')f.event({type:'map',map:'prontera'});if(change==='transport'){f.c.connect(true);f.event({type:'enter',id:0,map:'prt_fild08'},{type:'spawn',entity:{...own}},{type:'spawn',entity:{...member}});}f.c.receive(resultPacket(result()));expect(f.c.partyHeal.busy).toBe(true);expect(f.c.snapshot().partyHeal?.confirmed).toBe(0);});
 it('retains run intent and attempt after a thrown send or unanswered deadline without retry',()=>{for(const fail of [true,false]){const f=setup(grid,[member],()=>{if(fail)throw new Error('synthetic');});f.c.start(f.settings);f.step();for(let i=0;i<31;i++){f.step(1000);f.hp();}expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);expect(f.c.snapshot()).toMatchObject({runRequested:true,partyHeal:{attempts:1,confirmed:0,state:'uncertain'}});}});
 it('exhausts finite dispatch attempts while keeping normal run intent',()=>{const f=setup();f.settings.automation!.partyHeal!.maxAttempts=1;f.c.start(f.settings);f.step();f.c.receive(resultPacket(result()));f.step(1000);f.sp();f.hp();f.step();expect(f.sent).toHaveLength(1);expect(f.c.snapshot().partyHeal?.reason).toContain('allowance');expect(f.c.runRequested).toBe(true);});
 it.each(['unlearned','inventory','stale-sp','stale-hp','reserve','body','cast','blind','range','los','field','dead','self','offline','affiliation'] as const)('holds unavailable stationary prerequisite %s without walking',cause=>{const f=setup(cause==='los'?{...grid,seeThrough:p=>p.x!==11}:grid);if(cause==='unlearned')f.event({type:'skills',learned:[]});if(cause==='inventory')f.c.engine.character.inventoryKnown=false;if(cause==='stale-sp'||cause==='stale-hp'){f.step(15_001);if(cause==='stale-sp')f.hp();else f.sp();}if(cause==='reserve')f.settings.automation!.partyHeal!.spReserve=88;if(cause==='body')f.event({type:'status',id:0,statusId:2,seconds:100});if(cause==='cast')f.event({type:'castStart',id:0,skillId:11,level:1,position:own,remainingSeconds:10,flags:0});if(cause==='los')f.event({type:'position',id:2,position:{x:12,y:10}});if(cause==='range')f.event({type:'position',id:2,position:{x:20,y:10}});if(cause==='blind'){f.event({type:'status',id:0,statusId:5,seconds:100},{type:'position',id:2,position:{x:16,y:10}});}if(cause==='field')f.settings.automation!.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:10,maxY:30}};if(cause==='dead')f.event({type:'death',id:2});if(cause==='self')f.c.receive(joined([own]));if(cause==='offline')f.c.receive(joined([{...member,id:0}]));if(cause==='affiliation')f.event({type:'partyAffiliation',id:2,partyId:-1,partyName:''});f.c.start(f.settings);f.step();expect(f.sent.filter(a=>['skill','walk'].includes((a as {type:string}).type))).toEqual([]);});
 it('retains an observed own cast through expired/adjusted uncertainty; foreign casting does not block',()=>{const f=setup();f.c.receive(new BitWriter().u8(24).i32(0).i32(2).u8(11).u8(1).u8(0).position(own).f32(.1).u8(0).finish());f.step(500);f.c.receive(new BitWriter().u8(26).i32(0).f32(-1).finish());f.c.start(f.settings);f.step();expect(f.sent).toEqual([]);f.c.receive(new BitWriter().u8(27).i32(0).finish());f.c.receive(new BitWriter().u8(24).i32(2).i32(0).u8(11).u8(1).u8(0).position(member).f32(10).u8(0).finish());f.step();expect(f.sent.at(-1)).toMatchObject({type:'skill',skillId:41});});
 it('retains existing item priority instead of using a separate concurrent cast owner',()=>{const f=setup();f.settings.automation!.items=[{itemId:501,resource:'sp',belowPercent:100,minStock:0,cooldownSeconds:1}];f.event({type:'inventory',items:[{bagId:1,itemId:501,count:2,type:1}],equipment:Array(10).fill(0),ammoId:-1});f.c.start(f.settings);f.step();expect(f.sent).toEqual([{type:'useItem',itemId:501}]);expect(f.c.snapshot().partyHeal?.attempts).toBe(0);});
 it('does not bypass an owned normal attack, pickup, explicit/accepted walk or retired manual owner',()=>{
  for(const owner of ['attack','pickup','walk','accepted','manual'] as const){const f=setup(grid,[{...member,x:30}]);
   if(owner==='attack'){f.settings.automation!.combat.mode='selected';f.settings.targets=[4000];f.event({type:'spawn',entity:{...member,id:9,kind:1,classId:4000,x:11}});}
   if(owner==='pickup'){f.settings.loot=true;f.settings.automation!.loot.ownership='all';f.event({type:'drop',drop:{id:99,itemId:501,count:1,isNew:true,x:11,y:10}});}
   if(owner==='walk'||owner==='accepted'){f.settings.automation!.travel.waypoints=[{map:'prt_fild08',x:20,y:10}];}
   if(owner==='manual'){f.c.perform('command',{type:'manualTarget',owner:f.c.engine.manualActorIdentity(0)!,command:{type:'walk',destination:{x:15,y:10}},map:'prt_fild08',timeoutSeconds:10,policy:manualTargetPolicy(f.settings)});f.step();f.c.stop();expect(()=>f.c.start(f.settings)).toThrow();continue;}
   // The member becomes reachable only after another action owns the field.
   f.c.start(f.settings);f.step();f.event({type:'position',id:2,position:{x:11,y:10}});
   if(owner==='accepted'){const cells=f.c.engine.snapshot().navigation!.leg;f.event({type:'walk',id:0,walk:{origin:cells[0]!,cells,secondsPerCell:1,firstSeconds:1,locked:false}});}
   f.step();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toEqual([]);
  }
 });
 it('uses the physical transport ledger after canceled travel even if the engine fence expires',()=>{const f=setup();f.c.perform('command',{type:'sit',sitting:true});f.c.receive(new BitWriter().u8(14).i32(0).bool(true).finish());f.c.engine.character.sitting=false;f.c.stop();
  // An outbound travel Walk is captured by the controller before its transport.
  Reflect.apply(Reflect.get(f.c,'send'),f.c,[{type:'walk',destination:{x:12,y:10}}]);f.c.start(f.settings);for(let i=0;i<5;i++)f.step(1000);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toEqual([]);
 });
 it('invalidates member loss/leave-rejoin intent without crediting partial health or rebinding namesakes',()=>{const f=setup();f.c.start(f.settings);f.step();f.c.receive(new BitWriter().u8(102).u8(9).i32(7).string('prontera').finish());f.hp();expect(f.c.partyHeal.snapshot().state).toBe('uncertain');expect(f.c.world.partyActors.get(partyMemberId(7))).toBeNull();f.c.receive(resultPacket(result({attacker:3})));expect(f.c.partyHeal.busy).toBe(true);f.c.receive(resultPacket(result()));expect(f.c.partyHeal.busy).toBe(false);f.step(1000);f.sp();f.hp();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);});
 it('keeps a prior allowance through temporary pause and a fresh connection after a confirmed cast',()=>{const f=setup();f.settings.automation!.partyHeal!.maxAttempts=1;f.c.start(f.settings);f.step();f.c.receive(resultPacket(result()));f.c.pause('temporary');for(let i=0;i<31;i++)f.step(1000);f.c.connect(true);f.event({type:'enter',id:0,map:'prt_fild08'},{type:'spawn',entity:{...own}},{type:'spawn',entity:{...member}},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:41,level:10}]});f.c.world.reset('prt_fild08');f.c.receive(joined());f.step();expect(f.c.snapshot().partyHeal?.attempts).toBe(1);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);expect(f.c.runRequested).toBe(true);});

 it('retains configured cooldown and fresh-SP prerequisite across Stop/new explicit run',()=>{const f=setup();f.settings.automation!.partyHeal!.cooldownSeconds=3;f.c.start(f.settings);f.step();f.c.stop();f.c.receive(resultPacket(result()));f.step(1000);f.c.start(f.settings);f.step();expect(f.c.snapshot().partyHeal?.attempts).toBe(0);f.sp();f.hp();f.step(1800);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);f.step(200);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);expect(f.c.snapshot().partyHeal?.attempts).toBe(1);});

 it('requires an own SP packet ordered after the exact execution, not a pre-result refresh',()=>{
  const f=setup();f.settings.automation!.partyHeal!.spReserve=80;f.c.start(f.settings);f.step();
  f.step(100);f.sp(100);f.c.receive(resultPacket(result()));f.step(1000);
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
  expect(f.c.snapshot().partyHeal?.reason).toContain('own SP readback');
  f.sp(87);f.step();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
  expect(f.c.snapshot().partyHeal?.reason).toContain('reserve');
 });
 it('accepts a post-result own SP observation in the same millisecond as dispatch/result',()=>{
  const f=setup();f.settings.automation!.partyHeal!.spReserve=0;f.c.start(f.settings);f.step(0);
  f.c.receive(resultPacket(result()));f.sp(87);f.step(1000);
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);
 });
 it('accepts complete own stats containing SP ordered after confirmation at the same timestamp',()=>{
  const f=setup();f.c.start(f.settings);f.step(0);f.c.receive(resultPacket(result()));
  f.c.receive(statsPacket(87));f.step(1000);
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);
 });
 it.each(['missing','legacy stats','own HP','foreign HP','party SP'] as const)('does not use %s as post-confirmation own SP evidence',packet=>{
  const f=setup();f.c.start(f.settings);f.step();f.c.receive(resultPacket(result()));
  if(packet==='legacy stats')f.c.receive(statsPacket(87,false));
  if(packet==='own HP'||packet==='foreign HP')f.c.receive(new BitWriter().u8(37).i32(packet==='own HP'?0:2).i32(20).i32(packet==='own HP'?100:40).i32(100).finish());
  if(packet==='party SP')f.hp();
  f.step(1000);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
  expect(f.c.snapshot().partyHeal?.reason).toContain('own SP readback');
  f.sp(87);f.step();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);
 });
 it('starts SP readback ordering only at the exact receipt, not a wrong-level result',()=>{
  const f=setup();f.c.start(f.settings);f.step();f.c.receive(resultPacket(result({level:2})));f.sp(87);
  f.c.receive(resultPacket(result()));f.step(1000);
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
  expect(f.c.snapshot().partyHeal?.reason).toContain('own SP readback');
  f.sp(87);f.step();expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);
 });
 it('rejects unresolved SP readback from a replacement own lifetime',()=>{
  const f=setup();f.c.start(f.settings);f.step();const identity=f.c.engine.actorActionIdentity();
  f.c.receive(resultPacket(result()));
  f.c.receive(spawnPacket({...own,sp:87}));f.sp(87);f.step(1000);
  expect(f.c.engine.actorActionIdentity()?.selfIncarnation).not.toBe(identity?.selfIncarnation);
  expect(f.c.partyHeal.resourcesReadBack(f.c.engine.actorObservation([]))).toBe(false);
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
  expect(f.c.runRequested).toBe(true);
 });
 it.each(['Stop','timeout','send exception'] as const)('refuses service acquisition with a retired Heal after %s without replacing field intent',cause=>{
  const f=setup(grid,[member],()=>{if(cause==='send exception')throw new Error('synthetic send');});
  f.event({type:'skills',learned:[{skillId:41,level:10},{skillId:1,level:5}]});
  f.c.receive(new BitWriter().u8(40).i32(1000).finish());
  f.c.start(f.settings);f.step();if(cause==='Stop')f.c.stop();
  // Keep the ready connection fresh while ordinary confirmation fences expire.
  for(let i=0;i<32;i++){f.step(1000);f.hp();}
  expect(f.c.engine.pendingFeatureAction).toBeNull();expect(f.c.partyHeal.busy).toBe(true);
  const intent=f.c.runRequested,settings=Reflect.get(f.c,'requestedSettings'),start=vi.spyOn(f.c.service,'start');
  expect(()=>f.c.perform('service',{service:BUILTIN_SERVICES[0],executionPolicy:DEFAULT_MAP_POLICY})).toThrow('party Heal');
  expect(start).not.toHaveBeenCalled();expect(f.c.runRequested).toBe(intent);expect(Reflect.get(f.c,'requestedSettings')).toBe(settings);
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
 });
 it('admits a normal service after an exact retired Heal receipt and the after-cast fence',()=>{
  const f=setup();f.event({type:'skills',learned:[{skillId:41,level:10},{skillId:1,level:5}]});
  f.c.receive(new BitWriter().u8(40).i32(1000).finish());f.c.start(f.settings);f.step();f.c.stop();
  for(let i=0;i<32;i++){f.step(1000);f.hp();}
  f.c.receive(resultPacket(result()));f.step(1000);expect(f.c.partyHeal.busy).toBe(false);
  expect(()=>f.c.perform('service',{service:BUILTIN_SERVICES[0],executionPolicy:DEFAULT_MAP_POLICY})).not.toThrow();
  expect(f.c.service.snapshot()).toMatchObject({active:true,state:'preparing'});
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
 });
 it.each(['running','stopped'] as const)('retires completed SP debt observed while %s before a fresh explicit run',state=>{
  const f=setup();f.settings.automation!.partyHeal!.maxAttempts=1;f.c.start(f.settings);f.step();
  f.c.receive(resultPacket(result()));if(state==='stopped')f.c.stop();f.sp(87);f.step(1000);
  f.c.stop();freshConnection(f);f.c.start(f.settings);f.step();
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);
  expect(f.c.snapshot().partyHeal?.attempts).toBe(1);expect(f.c.runRequested).toBe(true);
 });
 it('cannot retire outstanding old SP debt from fresh resources after reconnect and Start',()=>{
  const f=setup();f.c.start(f.settings);f.step();f.c.receive(resultPacket(result()));f.c.stop();f.step(1000);
  freshConnection(f);f.c.start(f.settings);f.step();
  expect(f.c.partyHeal.busy).toBe(false);expect(f.c.engine.partyHealReadiness(2,1,10)).toBeNull();
  expect(f.c.snapshot().partyHeal).toMatchObject({attempts:0,state:'waiting'});
  expect(f.c.snapshot().partyHeal?.reason).toContain('own SP readback');
  expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);expect(f.c.runRequested).toBe(true);
 });
 it('keeps the configured cooldown after completed SP debt and a fresh explicit run',()=>{
  const f=setup();f.settings.automation!.partyHeal!.maxAttempts=1;f.settings.automation!.partyHeal!.cooldownSeconds=3;
  f.c.start(f.settings);f.step();f.c.receive(resultPacket(result()));f.sp(87);f.c.stop();freshConnection(f);
  f.c.start(f.settings);f.step(1000);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(1);
  expect(f.c.snapshot().partyHeal?.reason).toContain('cooldown');
  f.step(2000);expect(f.sent.filter(a=>(a as {type:string}).type==='skill')).toHaveLength(2);
 });

});

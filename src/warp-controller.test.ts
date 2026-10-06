import { validateFormSettings } from './settings';
import { skillId as domainSkillId } from './domain-values';
import {describe,expect,it} from 'vitest';
import {CompanionController,validControllerAction} from './controller';
import {BitWriter} from './binary';
import {DEFAULT_SETTINGS,DEFAULT_AUTOMATION,DEFAULT_PARTY_HEAL,DEFAULT_RETREAT,validateSettings,validateAutomation,type AutomationSettings,type Settings} from './settings';
import {DEFAULT_MAP_POLICY} from './map-policy';
import {OP,type Entity} from './protocol';
import {manualTargetPolicy} from './manual-target';
import type {WarpWire} from './warp-protocol';
import type {MemoSlots} from './memo-protocol';
import type {WalkGrid} from './navigation';
import {validFeatureStatus} from './feature-ui';
import {validWarpSnapshot} from './warp-ui';
import {actionConfirmationTimeout} from './automation';
import {FEATURE_OP} from './protocol-feature';
const map='prt_fild08',slots:MemoSlots=[{map:'prontera',x:100,y:100},null,null,null];
const own:Entity={id:0,classId:4,name:'Synthetic',kind:0,level:30,hp:100,maxHp:100,x:10,y:10,dead:false,statuses:[]};
function initialization(gems=3,sp=100):BitWriter{
 const w=new BitWriter().u8(56);for(const v of [30,1,50,1,1,1,1,1,1,0,0,0])w.i32(v);for(const v of [100,100,sp,200,...Array(17).fill(0)])w.i32(v);
 w.f32(1).i32(0).i32(0).bool(true).i16(1).i16(55).u8(4).i16(0).bool(true).u8(1).i32(1).i32(717).i16(gems).i32(0).u8(0);for(let i=0;i<10;i++)w.i32(0);return w.i32(-1);
}
function spawn(entity=own,entryType=0):Uint8Array {const name=new TextEncoder().encode(entity.name);const body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0).i32(~name.length).i32(entity.name.length).take(name).u8(entity.kind).u8(0).u8(entity.dead?3:0).i32(entity.x).i32(entity.y).u8(entity.level).i32(entity.hp).i32(entity.maxHp).i32(0).i32(0).i32(0).u8(0).finish();return new BitWriter().u8(6).u8(entryType).i32(body.length).take(body).finish();}
function fixture(grid:WalkGrid={width:40,height:40,walkable:()=>true},initialize=true,id=0){let now=1000;const sent:WarpWire[]=[],generic:unknown[]=[];let held=false;const c=new CompanionController(a=>generic.push(a),()=>now,()=>grid,()=>{},()=>{},()=>{},()=>{},wire=>sent.push(wire),{read:()=>held,write:v=>{held=v;}});c.connect(true);
 const packet=(w:BitWriter|Uint8Array,epoch?:number)=>c.receive(w instanceof BitWriter?w.finish():w,epoch);
 const memo=(values=slots)=>{const w=new BitWriter().u8(94);for(const slot of values){w.u8(slot?1:0);if(slot)w.string(slot.map).i16(slot.x).i16(slot.y);}packet(w);};
 const enter=()=>packet(new BitWriter().u8(3).i32(id).string(map));
 if(initialize){enter();packet(initialization());memo();packet(spawn({...own,id},1));}
 const preview=(policy:AutomationSettings=DEFAULT_AUTOMATION,target={x:11,y:10})=>{c.perform('warpPreview',{type:'warpGround',slot:0,target,policy});return c.snapshot().warp.preview!;};
 const ground=(policy=DEFAULT_AUTOMATION)=>c.perform('warp',{...preview(policy),policy});
 const step=(ms=100)=>{now+=ms;c.tick();};
 const execution=()=>packet(new BitWriter().u8(29).u8(4).i32(id).i16(11).i16(10).u8(55).u8(4).u8(0).i16(10).i16(10).f32(1));
 const ready=()=>{packet(new BitWriter().u8(97).u8(1));execution();packet(new BitWriter().u8(39).i32(74).i32(200));step(1000);};
 const activate=(policy=DEFAULT_AUTOMATION)=>{c.perform('warpPreview',{type:'warpActivate',policy});c.perform('warp',{...c.snapshot().warp.preview,policy});};
 return {c,sent,generic,packet,memo,enter,preview,ground,step,execution,ready,activate};
}
describe('Warp Portal integration and ordinary player boundary',()=>{
 it('runs both explicit stages for own actor zero; engine generic skill receipt never owns Warp',()=>{const t=fixture();expect(t.c.engine.actorActionIdentity()?.selfId).toBe(0);t.ground();t.ready();expect(t.c.snapshot().warp.activation).not.toBeNull();expect(validFeatureStatus(t.c.snapshot() as unknown as Record<string,unknown>)).toBe(true);t.activate();expect(t.sent).toEqual([{stage:'ground',level:4,x:11,y:10},{stage:'activate',slot:0}]);expect(t.generic).toEqual([]);expect(t.c.engine.pendingFeatureAction).toBeNull();expect(t.c.snapshot().warp.reason).toContain('creation is unconfirmed');});
 it('uses currently visible field policy and both stock protections without Start or target settings',()=>{const t=fixture();for(const policy of [{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:{...DEFAULT_MAP_POLICY,deny:[map]}},{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:{...DEFAULT_MAP_POLICY,lockArea:{map,minX:10,minY:10,maxX:10,maxY:10}}}])expect(()=>t.preview(policy)).toThrow('Ground');const visible=structuredClone(DEFAULT_AUTOMATION);visible.items=[{itemId:717,resource:'hp',belowPercent:50,cooldownSeconds:1,minStock:3}];expect(()=>t.preview(visible)).toThrow('reserve');visible.items=[];const request=t.preview(visible);visible.mapPolicy={...DEFAULT_MAP_POLICY,deny:[map]};expect(()=>t.c.perform('warp',{...request,policy:visible})).toThrow('stale');expect(t.sent).toEqual([]);expect(t.c.runRequested).toBe(false);});
 it('rejects map-unknown cells, blocked cells, fixed portals, occupied ground and stationary own cell',()=>{for(const grid of [{width:40,height:40,walkable:(p:{x:number;y:number})=>p.x!==11},{width:40,height:40,walkable:()=>true,portals:[{x:11,y:10,halfWidth:0,halfHeight:0}]}]){const t=fixture(grid);expect(()=>t.preview()).toThrow('Ground');}const t=fixture();expect(()=>t.preview(DEFAULT_AUTOMATION,{x:10,y:10})).toThrow('Ground');t.packet(spawn({...own,id:1,kind:4,x:11}));expect(()=>t.preview()).toThrow('Ground');expect(t.sent).toEqual([]);});
 it('uses directional LOS, Blind range and effective SP/unknown equipment guards',()=>{const t=fixture();expect(()=>t.preview(DEFAULT_AUTOMATION,{x:19,y:10})).not.toThrow();t.packet(new BitWriter().u8(61).i32(0).u8(5).f32(10));expect(()=>t.preview(DEFAULT_AUTOMATION,{x:16,y:10})).toThrow('Ground');t.c.engine.character.equipment[0]=99999;expect(()=>t.preview()).toThrow('equipment');const line=fixture({width:40,height:40,walkable:()=>true,seeThrough:p=>p.x!==12});expect(()=>line.preview(DEFAULT_AUTOMATION,{x:14,y:10})).toThrow('Ground');});
 it('requires complete learned, body, inventory and ready own lifetime metadata',()=>{for(const mutate of [(t:ReturnType<typeof fixture>)=>{t.c.engine.character.learned.clear();t.c.engine.character.granted.set(domainSkillId(55),4);},(t:ReturnType<typeof fixture>)=>{t.c.engine.character.inventoryKnown=false;},(t:ReturnType<typeof fixture>)=>{t.c.engine.observations.remove(0);},(t:ReturnType<typeof fixture>)=>{t.packet(new BitWriter().u8(61).i32(0).u8(6).f32(10));}]){const t=fixture();mutate(t);expect(()=>t.preview()).toThrow();expect(t.sent).toEqual([]);}});
 it('unconditional trusted manual input retires idle preview and taints sent correlation',()=>{const t=fixture(),request=t.preview();expect(t.c.active).toBe(false);t.c.manualInput();expect(()=>t.c.perform('warp',{...request,policy:DEFAULT_AUTOMATION})).toThrow('stale');t.ground();t.c.manualInput();t.ready();expect(t.c.snapshot().warp.activation).toBeNull();expect(t.sent).toHaveLength(1);});
 it('fences every other owner and rejects generic skill/routine/profile bypasses',()=>{const t=fixture();for(const action of [{type:'skill',mode:'ground',skillId:55,level:4,position:{x:11,y:10}},{type:'skill',mode:'self',skillId:55,level:1}]){expect(validControllerAction(action)).toBe(false);expect(()=>t.c.perform('command',action)).toThrow();expect(()=>t.c.perform('routine',{name:'No Warp',durationSeconds:10,maxActions:1,rules:[{name:'Denied',priority:0,cooldownSeconds:0,maxRuns:1,conditions:[{field:'hpPercent',operator:'lte',value:100}],action}]})).toThrow();}expect(()=>validateSettings({...DEFAULT_SETTINGS,automation:{...structuredClone(DEFAULT_AUTOMATION),skills:[{skillId:55,level:1,target:'self',hpBelowPercent:100,spAbovePercent:0,cooldownSeconds:1}]}})).toThrow();t.ground();for(const mode of ['command','social','memo','service','workflow','routine'] as const)expect(()=>t.c.perform(mode,{type:'sit',sitting:true})).toThrow();expect(()=>t.c.start({...DEFAULT_SETTINGS,map,targets:[4000]})).toThrow();t.c.stop();expect(()=>t.c.start({...DEFAULT_SETTINGS,map,targets:[4000]})).toThrow();expect(t.sent).toHaveLength(1);});
 it('never releases on Fly Wing/map/clear, own replacement, socket UUID or old socket events',()=>{const t=fixture();t.ground();t.ready();t.activate();t.c.observeOfficialPacket(new BitWriter().u8(47).i32(601).i32(-1).finish());t.packet(new BitWriter().u8(16));t.packet(spawn());t.packet(new BitWriter().u8(18).string(map));t.packet(spawn());expect(t.c.warp.blocked).toBe(true);const old=t.c.connectionGeneration;t.c.disconnect();t.c.connect(true);t.enter();t.packet(initialization());t.memo();t.packet(spawn());t.packet(new BitWriter().u8(97).u8(0),old);expect(t.c.warp.blocked).toBe(true);expect(t.c.snapshot().warp.activation).toBeNull();expect(t.sent).toHaveLength(2);});
 it('releases a stopped ground hold only after proved death and ready revival with SP reconciliation; retains complete memo',()=>{const t=fixture();t.ground();t.c.stop();t.packet(new BitWriter().u8(36).i32(0).i16(10).i16(10));expect(t.c.warp.blocked).toBe(true);t.packet(new BitWriter().u8(16));t.packet(initialization(3,74));t.packet(spawn());expect(t.c.warp.blocked).toBe(false);expect(t.c.snapshot().memo.slots).toEqual(slots);expect(t.c.snapshot().warp.state).toBe('recovered');expect(t.sent).toHaveLength(1);});
 it('proves a fresh initialized Enter only with captured outbound Enter/Ready, fresh memo94 and subsequent own spawn',()=>{
  const t=fixture();t.ground();t.c.disconnect();t.c.connect(true);t.c.observeOfficialPacket(new BitWriter().u8(3).bool(false).string('Synthetic').finish());t.enter();t.packet(initialization());
  expect(t.c.warp.blocked).toBe(true);t.memo();t.c.observeOfficialPacket(new BitWriter().u8(2).finish());t.step();expect(t.c.warp.blocked).toBe(true);t.packet(spawn());expect(t.c.warp.blocked).toBe(false);expect(t.sent).toHaveLength(1);
 });
});

describe('Warp ready actor bounds and reconnect integration',()=>{
 it('keeps pre-Enter actor zero data-only and preserves own readiness at the 300-actor observation cap',()=>{
  const t=fixture(undefined,false);
  t.packet(initialization());t.memo();t.packet(spawn());expect(t.c.engine.actorActionIdentity()).toBeNull();expect(()=>t.preview()).toThrow();
  t.enter();t.packet(initialization());t.memo();
  for(let id=1;id<=305;id++)t.packet(spawn({...own,id,kind:1,classId:4001,name:'Monster',x:30,y:30}));
  expect(t.c.engine.observations.context(299).incarnation).toBeGreaterThan(0);expect(t.c.engine.observations.context(300).incarnation).toBe(0);
  expect(t.c.snapshot().warp.ready).toBeNull();t.packet(spawn());
  expect(t.c.engine.actorActionIdentity()?.selfId).toBe(0);t.ground();t.ready();t.activate();expect(t.sent).toHaveLength(2);expect(t.generic).toEqual([]);
 });
 it('taints a duplicate source-shaped own cast start even when the final ground result and SP match',()=>{
  const t=fixture();t.ground();
  const cast=()=>new BitWriter().u8(25).i32(0).i16(11).i16(10).u8(55).u8(4).u8(1).u8(0).i16(10).i16(10).f32(.5).u8(0);
  t.packet(cast());t.packet(cast());t.ready();
  expect(t.c.snapshot().warp).toMatchObject({state:'stopped',blocked:true,activation:null});expect(t.sent).toHaveLength(1);
 });
 it('does not reconcile a reconnect with old-epoch resource, memo, selection or execution packets',()=>{
  const t=fixture();t.ground();const old=t.c.connectionGeneration;t.c.disconnect();t.c.connect(true);
  t.c.observeOfficialPacket(new BitWriter().u8(3).bool(false).string('Synthetic').finish());t.enter();
  t.packet(initialization(),old);t.packet(new BitWriter().u8(94).u8(0).u8(0).u8(0).u8(0),old);t.packet(new BitWriter().u8(97).u8(1),old);
  t.packet(new BitWriter().u8(29).u8(4).i32(0).i16(11).i16(10).u8(55).u8(4).u8(0).i16(10).i16(10).f32(1),old);
  t.c.observeOfficialPacket(new BitWriter().u8(2).finish());t.packet(spawn());
  expect(t.c.warp.blocked).toBe(true);expect(t.c.snapshot().memo.slots).toBeNull();expect(t.c.engine.character.inventoryKnown).toBe(false);
  t.packet(initialization());t.memo();t.c.observeOfficialPacket(new BitWriter().u8(2).finish());t.packet(spawn());expect(t.c.warp.blocked).toBe(true);
  t.c.disconnect();t.c.connect(true);t.c.observeOfficialPacket(new BitWriter().u8(3).bool(false).string('Synthetic').finish());t.enter();t.packet(initialization());t.memo();t.c.observeOfficialPacket(new BitWriter().u8(2).finish());t.packet(spawn());
  expect(t.c.warp.blocked).toBe(false);expect(t.c.snapshot().warp.activation).toBeNull();expect(t.sent).toHaveLength(1);
 });
 it('keeps an external Warp guard through death until authoritative resources arrive, without resuming intent',()=>{
  const t=fixture();t.c.observeOfficialPacket(new BitWriter().u8(29).u8(5).i16(55).u8(1).finish());expect(t.c.warp.blocked).toBe(true);
  t.packet(new BitWriter().u8(36).i32(0).i16(10).i16(10));t.packet(new BitWriter().u8(16));t.packet(spawn());expect(t.c.warp.blocked).toBe(true);
  t.packet(initialization(2,70));expect(t.c.warp.blocked).toBe(false);expect(t.c.snapshot().memo.slots).toEqual(slots);expect(t.sent).toEqual([]);expect(t.generic).toEqual([]);
 });
});


describe('Warp maintenance settlement and new-owner exclusions',()=>{
 it('blocks updates for an idle preview until explicit dismissal, without requiring combat selections',()=>{
  const t=fixture();expect(t.c.settledForMaintenance()).toBe(true);t.preview();expect(t.c.active).toBe(false);expect(t.c.settledForMaintenance()).toBe(false);
  t.c.perform('warpCancel',{});expect(t.c.settledForMaintenance()).toBe(true);expect(t.sent).toEqual([]);expect(t.c.runRequested).toBe(false);
 });
 it('blocks updates during cast, ordered selection, activation preview and retired resource receipts',()=>{
  const t=fixture();t.ground();expect(t.c.settledForMaintenance()).toBe(false);
  t.packet(new BitWriter().u8(25).i32(0).i16(11).i16(10).u8(55).u8(4).u8(1).u8(0).i16(10).i16(10).f32(.5).u8(0));expect(t.c.settledForMaintenance()).toBe(false);
  t.ready();expect(t.c.snapshot().warp.activation).not.toBeNull();expect(t.c.settledForMaintenance()).toBe(false);
  t.c.perform('warpPreview',{type:'warpActivate',policy:DEFAULT_AUTOMATION});expect(t.c.settledForMaintenance()).toBe(false);
  t.c.perform('warp',{...t.c.snapshot().warp.preview,policy:DEFAULT_AUTOMATION});t.c.stop();t.step(30000);
  t.packet(new BitWriter().u8(39).i32(74).i32(200));t.packet(initialization(2,74));
  expect(t.c.snapshot().warp).toMatchObject({state:'activationSent',pending:false,blocked:true,preview:null});expect(t.c.settledForMaintenance()).toBe(false);expect(t.sent).toHaveLength(2);
 });
 it('requires proved reset and ready resources before an uncertain Warp owner permits updates',()=>{
  const t=fixture();t.ground();t.c.stop();t.packet(new BitWriter().u8(36).i32(0).i16(10).i16(10));t.packet(new BitWriter().u8(16));t.packet(spawn());
  expect(t.c.settledForMaintenance()).toBe(false);t.packet(initialization(3,74));expect(t.c.warp.blocked).toBe(false);expect(t.c.settledForMaintenance()).toBe(true);expect(t.sent).toHaveLength(1);expect(t.generic).toEqual([]);
 });
 it('excludes new manual target and socket owners while Warp receipts remain uncertain',()=>{
  const t=fixture();t.ground();t.c.stop();t.step(30000);
  const request={type:'manualTarget',command:{type:'walk',destination:{x:12,y:10}},owner:t.c.engine.manualActorIdentity(0),map,policy:manualTargetPolicy({...DEFAULT_SETTINGS,map,targets:[]}),timeoutSeconds:10};
  expect(()=>t.c.perform('command',request)).toThrow();expect(()=>t.c.perform('socketPreview',{targetBagId:20001,cardBagId:4002,policy:DEFAULT_AUTOMATION})).toThrow();expect(t.c.engine.manualTargetOwned).toBe(false);expect(t.generic).toEqual([]);expect(t.sent).toHaveLength(1);
 });
 it('refuses Warp during an active manual target and its canceled movement receipt',()=>{
  const t=fixture(),request={type:'manualTarget',command:{type:'walk',destination:{x:12,y:10}},owner:t.c.engine.manualActorIdentity(0),map,policy:manualTargetPolicy({...DEFAULT_SETTINGS,map,targets:[]}),timeoutSeconds:10};
  t.c.perform('command',request);t.step();expect(()=>t.preview()).toThrow();t.c.stop();expect(t.c.engine.manualTargetOwned).toBe(true);expect(()=>t.preview()).toThrow();expect(t.sent).toEqual([]);
 });
});

describe('Warp with merged party Heal and rendezvous owners',()=>{
 function party(t:ReturnType<typeof fixture>,id:number,leader=false,position={x:11,y:10}):void {
  t.packet(spawn({...own,id:2,name:leader?'Leader':'Member',hp:40,...position}));
  t.packet(new BitWriter().u8(103).i32(2).u8(1).i32(5).string('Party').bool(leader));
  const w=new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(id===0?2:1)
   .i32(7).i32(2).i16(20).string(leader?'Leader':'Member').u8(leader?1:0).string(map).i32(40).i32(100).i32(30).i32(100);
  if(id===0)w.i32(8).i32(0).i16(30).string(own.name).u8(0);
  t.packet(w);
 }
 function healFixture(id:number){
  const t=fixture(undefined,true,id);party(t,id);
  t.packet(new BitWriter().u8(57).u8(41).u8(1).i32(0));
  const automation=structuredClone(DEFAULT_AUTOMATION);automation.combat.mode='off';automation.partyHeal={...DEFAULT_PARTY_HEAL,enabled:true,level:1,cooldownSeconds:1};
  const settings:Settings={...DEFAULT_SETTINGS,map,targets:[],loot:false,route_randomWalk:0,automation};
  const result=(source=id,level=1)=>t.packet(new BitWriter().u8(29).u8(1).i32(source).i32(-1).i32(2).u8(41).u8(level).u8(0).position(own).i32(-20).u8(2).u8(0).f32(0).f32(0).bool(false));
  const heals=()=>t.generic.filter(a=>!!a&&typeof a==='object'&&'type' in a&&a.type==='skill'&&'skillId' in a&&a.skillId===41);
  return {...t,settings,result,heals};
 }
 const available=(id:number)=>[
  new BitWriter().u8(13).i32(id).i16(-1).i16(5000).u8(6).u8(1),
  new BitWriter().u8(7).i32(id).position(own).f32(10).f32(10).f32(.1).f32(.1).u8(2).u8(0x60).u8(0),
  new BitWriter().u8(FEATURE_OP.resetMotion).i32(id),
  new BitWriter().u8(FEATURE_OP.castStop).i32(id)
 ];
 it.each([0,1])('requires ordered own%s Heal SP readback before Warp can use the remaining resources',id=>{
  const t=healFixture(id);t.c.start(t.settings);t.step();expect(t.heals()).toHaveLength(1);t.c.stop();
  t.packet(new BitWriter().u8(39).i32(87).i32(200));t.result();t.step(1000);
  expect(t.c.partyHeal.busy).toBe(false);expect(t.c.partyHeal.awaitingSpReadback).toBe(true);expect(t.c.snapshot().warp.ready).toBeNull();
  const generation=t.c.warp.revision,receipt=t.c.snapshot().partyHeal;
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:12,y:10})).toThrow('Heal');
  for(const event of available(id)){t.packet(event);t.step(200);}
  expect(t.c.partyHeal.awaitingSpReadback).toBe(true);expect(t.c.snapshot().partyHeal).toEqual(receipt);
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:13,y:10})).toThrow('Heal');
  expect(t.c.warp.revision).toBe(generation);expect(t.c.snapshot().warp.preview).toBeNull();expect(t.sent).toEqual([]);
  t.packet(new BitWriter().u8(39).i32(87).i32(200));t.step(1000);
  expect(t.c.partyHeal.awaitingSpReadback).toBe(false);expect(t.c.runRequested).toBe(false);expect(t.heals()).toHaveLength(1);
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:13,y:10})).not.toThrow();expect(t.sent).toEqual([]);
 });
 it.each([0,1])('preserves own%s canceled Heal receipt and a separate external Warp hold through passive clocks',id=>{
  const t=healFixture(id);t.c.start(t.settings);t.step();t.c.stop();
  const receipt=t.c.snapshot().partyHeal;expect(receipt).toMatchObject({attempts:1,confirmed:0});
  for(const event of available(id)){t.packet(event);t.step(200);}
  t.result(id===0?1:0);t.result(id,2);t.packet(new BitWriter().u8(39).i32(87).i32(200));
  expect(t.c.partyHeal.busy).toBe(true);expect(t.c.snapshot().partyHeal).toEqual(receipt);
  const generation=t.c.warp.revision;expect(()=>t.preview(DEFAULT_AUTOMATION,{x:13,y:10})).toThrow();expect(t.c.warp.revision).toBe(generation);
  t.packet(new BitWriter().u8(97).u8(1));for(let i=0;i<301;i++)t.step(100);
  expect(t.c.engine.pendingFeatureAction).toBeNull();expect(t.c.partyHeal.busy).toBe(true);expect(t.c.warp.blocked).toBe(true);
  t.result();t.packet(new BitWriter().u8(39).i32(87).i32(200));t.step(1000);
  expect(t.c.partyHeal.busy).toBe(false);expect(t.c.partyHeal.awaitingSpReadback).toBe(false);
  expect(t.c.warp.blocked).toBe(true);expect(t.c.snapshot().warp.activation).toBeNull();expect(t.c.runRequested).toBe(false);
  expect(t.heals()).toHaveLength(1);expect(t.sent).toEqual([]);
 });
 function followFixture(id:number,lostSeconds=20){
  const t=fixture({width:400,height:400,walkable:()=>true},true,id);
  t.packet(new BitWriter().u8(OP.stopImmediate).i32(id).position({x:170,y:370}));party(t,id,true,{x:174,y:370});
  const automation=structuredClone(DEFAULT_AUTOMATION);automation.combat.mode='off';automation.follow={...automation.follow,mode:'partyLeader',rendezvous:true,lostSeconds};
  const settings:Settings={...DEFAULT_SETTINGS,map,targets:[],loot:false,route_randomWalk:0,automation};
  const depart=()=>t.packet(new BitWriter().u8(102).u8(9).i32(7).string('prontera'));
  return {...t,settings,depart};
 }
 it.each([0,1])('keeps own%s retired rendezvous movement ahead of Warp until the validated shortened walk settles',id=>{
  const t=followFixture(id);t.c.start(t.settings);t.depart();expect(t.c.snapshot().partyFollow).toMatchObject({state:'travelling',ownsTravel:true});
  const prefix=t.c.travel.snapshot().leg.slice(0,2);expect(prefix).toHaveLength(2);t.c.stop();
  const generation=t.c.warp.revision;expect(()=>t.preview(DEFAULT_AUTOMATION,{x:171,y:372})).toThrow();expect(t.c.warp.revision).toBe(generation);expect(t.sent).toEqual([]);
  const offsets=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]],direction=offsets.findIndex(([x,y])=>prefix[1]!.x-prefix[0]!.x===x&&prefix[1]!.y-prefix[0]!.y===y);
  t.packet(new BitWriter().u8(7).i32(id).position(prefix[0]!).f32(prefix[0]!.x).f32(prefix[0]!.y).f32(.1).f32(.1).u8(2).u8(direction<<4).u8(0));
  t.step(200);expect(()=>t.preview(DEFAULT_AUTOMATION,{x:171,y:372})).toThrow();for(let i=0;i<23;i++)t.step(100);
  expect(t.c.travel.movementSettled(map,t.c.engine.player)).toBe(true);expect(t.c.engine.idleForActions()).toBe(true);
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:171,y:372})).not.toThrow();expect(t.c.snapshot().partyFollow).toMatchObject({state:'cancelled',attemptUsed:true});
  expect(t.c.runRequested).toBe(false);expect(t.sent).toEqual([]);expect(t.generic.filter(a=>!!a&&typeof a==='object'&&'type' in a&&a.type==='walk')).toHaveLength(1);
 });
 it.each([0,1])('advances own%s original rendezvous loss deadline during an external Warp hold without a trip or query',id=>{
  const t=followFixture(id,2);t.c.start(t.settings);
  t.packet(new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(id).u8(11).u8(1).u8(6).position({x:170,y:370}).f32(10).u8(0));
  t.depart();expect(t.c.snapshot().partyFollow).toMatchObject({state:'preparing',ownsTravel:true,attemptUsed:true});
  t.packet(new BitWriter().u8(97).u8(1));for(let i=0;i<21;i++)t.step(100);
  expect(t.c.snapshot().partyFollow).toMatchObject({state:'expired',attemptUsed:true,remainingSeconds:0});expect(t.c.warp.blocked).toBe(true);
  t.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id));t.step();expect(t.c.snapshot().partyFollow.state).toBe('expired');
  expect(t.generic.filter(a=>!!a&&typeof a==='object'&&'type' in a&&['walk','look','skill','attack','pickup'].includes(String(a.type)))).toEqual([]);
  expect(t.sent).toEqual([]);expect(t.c.runRequested).toBe(true);t.c.stop();expect(t.c.runRequested).toBe(false);
 });
});


describe('Warp disposition reserve telemetry bounds',()=>{
 const policyFor=(keep:number):AutomationSettings=>({...structuredClone(DEFAULT_AUTOMATION),disposition:{maxSpend:0,rules:[{itemId:717,keep,minimum:keep,desired:keep,maximum:keep,store:false,cart:false,sell:false,restock:'off',allowUnique:false}]}});
 it.each([0,9999,10000,32767])('publishes a valid controller status for the accepted reserve %s',keep=>{
  const t=fixture();t.c.engine.settings=validateFormSettings({...DEFAULT_SETTINGS,map,automation:validateAutomation(policyFor(keep))});
  const snapshot=t.c.snapshot();expect(snapshot.warp.reserve).toBe(keep);
  expect(validWarpSnapshot(snapshot.warp)).toBe(true);expect(validFeatureStatus({...snapshot})).toBe(true);
  expect(t.sent).toEqual([]);expect(t.generic).toEqual([]);
 });
 it('rejects settings and telemetry reserves above the disposition ceiling',()=>{
  expect(()=>validateAutomation(policyFor(32768))).toThrow();
  const t=fixture();t.c.engine.settings=validateFormSettings({...DEFAULT_SETTINGS,map,automation:validateAutomation(policyFor(32767))});
  const snapshot=t.c.snapshot(),warp={...snapshot.warp,reserve:32768};
  expect(validWarpSnapshot(warp)).toBe(false);expect(validFeatureStatus({...snapshot,warp})).toBe(false);
  expect(t.sent).toEqual([]);expect(t.generic).toEqual([]);
 });
});

describe('Warp with merged refining and retreat owners',()=>{
 function resources():BitWriter {
  const w=new BitWriter().u8(56);for(const v of [30,1,10000,1,1,1,1,1,1,0,0,0])w.i32(v);for(const v of [100,100,100,200,...Array(16).fill(1),2000])w.i32(v);
  w.f32(.5).i32(100).i32(0).bool(false).bool(true).u8(1).i32(2).i32(717).i16(3).i32(1010).i16(3).i32(1).i32(700).i32(1201).i16(1).u8(0).u8(0);
  for(let i=0;i<16;i++)w.u8(1);for(let i=0;i<4;i++)w.i32(0);w.u8(0);for(let i=0;i<10;i++)w.i32(0);return w.i32(-1);
 }
 it.each([0,1])('invalidates own%s refining preview during an external Warp hold without sending or economic acknowledgment',id=>{
  const t=fixture(undefined,true,id);t.packet(resources());t.packet(spawn({...own,id:2,name:'Refiner',classId:123,kind:2,hp:0,maxHp:0,x:11}));
  t.packet(new BitWriter().u8(77).u8(0).i32(2).bool(true));t.packet(new BitWriter().u8(77).u8(5));
  const input={targetBagId:700,catalystBagId:0,policy:structuredClone(DEFAULT_AUTOMATION),maxSpend:200,minZeny:0};
  t.c.perform('refinePreview',input);const token=t.c.snapshot().refine.preview!.token;
  t.packet(new BitWriter().u8(97).u8(1));expect(t.c.warp.blocked).toBe(true);expect(t.c.snapshot().refine.preview).toBeNull();
  expect(()=>t.c.perform('refine',{...input,previewToken:token})).toThrow();expect(t.c.warp.blocked).toBe(true);
  expect(t.c.snapshot().refine.blocked).toBe(false);expect(t.generic).toEqual([]);expect(t.sent).toEqual([]);
 });
 it.each([0,1])('withholds own%s official refining initialization baseline while Warp remains held after Stop',id=>{
  const t=fixture(undefined,true,id);expect(t.c.officialRefineResourceRevision()).not.toBeNull();t.ground();t.c.stop();
  expect(t.c.officialRefineResourceRevision()).toBeNull();
  for(const packet of [new BitWriter().u8(13).i32(id).i16(-1).i16(5000).u8(6).u8(1),new BitWriter().u8(FEATURE_OP.castStop).i32(id),new BitWriter().u8(FEATURE_OP.resetMotion).i32(id)])t.packet(packet);
  t.step(1000);expect(t.c.officialRefineResourceRevision()).toBeNull();expect(t.c.warp.blocked).toBe(true);
  expect(t.c.snapshot().warp).toMatchObject({activation:null,resourceEvidence:expect.stringContaining('Waiting for ordered SP')});expect(t.sent).toHaveLength(1);expect(t.generic).toEqual([]);
 });
 function retreatFixture(id:number){
  const t=fixture(undefined,true,id),w=new BitWriter().u8(56);
  for(const v of [30,1,10000,1,1,1,1,1,1,0,0,0])w.i32(v);for(const v of [100,100,100,200,...Array(16).fill(1),2000])w.i32(v);
  w.f32(.5).i32(100).i32(0).bool(true).i16(3).i16(55).u8(4).i16(1).u8(2).i16(29).u8(5).i16(0).bool(true).u8(1).i32(2).i32(717).i16(3).i32(1750).i16(20).i32(1).i32(77).i32(1701).i16(1).u8(0).u8(0);
  for(let i=0;i<16;i++)w.u8(1);for(let i=0;i<4;i++)w.i32(0);w.u8(0);for(let i=0;i<10;i++)w.i32(i===4?77:0);t.packet(w.i32(1750));
  t.packet(spawn({...own,id:2,classId:4000,name:'Poring',kind:1,x:12,hp:50,maxHp:50}));
  const automation=structuredClone(DEFAULT_AUTOMATION);automation.retreat={...DEFAULT_RETREAT,enabled:true};
  const settings:Settings={...DEFAULT_SETTINGS,map,targets:[4000],loot:false,route_randomWalk:0,automation};
  t.c.start(settings);t.step();t.packet(new BitWriter().u8(OP.attack).i32(id).i32(2).i32(0).position(own));t.step();
  expect(t.c.engine.retreatOwned).toBe(true);t.c.engine.deaths=1;t.c.engine.kills=7;
  return t;
 }
 it.each([0,1].flatMap(id=>[false,true].map(walking=>({id,walking}))))('retains own$id canceled retreat walking=$walking before Warp without resetting allowances',({id,walking})=>{
  const t=retreatFixture(id);if(walking){t.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));t.step();}
  t.c.stop();const sent=t.generic.length,generation=t.c.warp.revision;
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:13,y:13})).toThrow();expect(t.c.warp.revision).toBe(generation);
  t.packet(new BitWriter().u8(13).i32(id).i16(-1).i16(5000).u8(6).u8(1));t.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id));t.step(200);
  expect(t.c.engine.retreatOwned).toBe(true);expect(()=>t.preview(DEFAULT_AUTOMATION,{x:13,y:13})).toThrow();
  if(walking){
   t.packet(new BitWriter().u8(OP.walk).i32(id).position(own).f32(10).f32(10).f32(.1).f32(.1).u8(2).u8(0x60).u8(0));t.step(500);
  }else{t.packet(new BitWriter().u8(OP.stop).i32(id));expect(t.c.engine.retreatOwned).toBe(true);t.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));t.step(100);}
  expect(t.c.engine.retreatOwned).toBe(false);expect(()=>t.preview(DEFAULT_AUTOMATION,{x:13,y:13})).not.toThrow();
  expect(t.c.snapshot()).toMatchObject({runRequested:false,deaths:1,kills:7});expect(t.c.engine.settings.automation).toMatchObject({respawn:{maxDeaths:1},recovery:{enabled:false}});
  expect(t.generic).toHaveLength(sent);expect(t.sent).toEqual([]);
 });
});


describe('Warp uses shared observed cast admission',()=>{
 const cast=(id:number,skillId=11,seconds=.01)=>new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(id).u8(skillId).u8(1).u8(0).i16(10).i16(10).f32(seconds).u8(0);
 const walk=(id:number)=>new BitWriter().u8(7).i32(id).i16(10).i16(10).f32(10).f32(10).f32(.1).f32(.1).u8(2).u8(0x60).u8(0);
 it.each([0,1].flatMap(id=>['deadline','extension'].map(edge=>({id,edge}))))('does not admit Warp after own$id cast $edge becomes a past timer',({id,edge})=>{
  const t=fixture(undefined,true,id);t.packet(cast(id));
  if(edge==='extension')t.packet(new BitWriter().u8(FEATURE_OP.castExtend).i32(id).f32(-10));
  t.step(100);expect(t.c.engine.observedOwnCastSettled()).toBe(false);
  expect(()=>t.preview()).toThrow('cast');expect(t.c.snapshot().warp.ready).toBeNull();
  expect(t.sent).toEqual([]);expect(t.generic).toEqual([]);
  t.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id));expect(t.c.engine.observedOwnCastSettled()).toBe(true);
  t.ground();expect(t.sent).toEqual([{stage:'ground',level:4,x:11,y:10}]);
 });
 it.each([0,1])('admits Warp for own%s after accepted movement proves availability even while the old cast timer is future',id=>{
  const t=fixture(undefined,true,id);t.packet(cast(id,11,10));t.packet(walk(id));t.step(500);
  expect(t.c.engine.observedOwnCastSettled()).toBe(true);expect(t.c.engine.idleForActions()).toBe(true);
  expect(t.c.engine.actorObservation([])?.actors.find(actor=>actor.id===id)?.cast).toMatchObject({state:'casting'});
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:12,y:10})).not.toThrow();
  t.c.perform('warp',{...t.c.snapshot().warp.preview,policy:DEFAULT_AUTOMATION});
  expect(t.sent).toEqual([{stage:'ground',level:4,x:12,y:10}]);expect(t.generic).toEqual([]);
 });
 it.each([0,1])('rechecks own%s shared cast admission at ground dispatch without sending or owning a request',id=>{
  const t=fixture(undefined,true,id),request=t.preview();t.packet(cast(id));t.step(100);
  expect(()=>t.c.perform('warp',{...request,policy:DEFAULT_AUTOMATION})).toThrow();
  expect(t.c.warp.blocked).toBe(false);expect(t.sent).toEqual([]);expect(t.generic).toEqual([]);
 });
 it.each([0,1])('keeps own%s Warp resources and intent unresolved after accepted walking clears only cast availability',id=>{
  const t=fixture(undefined,true,id);t.c.engine.deaths=1;t.c.engine.kills=7;t.c.engine.looted=9;t.ground();
  t.packet(new BitWriter().u8(25).i32(id).i16(11).i16(10).u8(55).u8(4).u8(1).u8(0).i16(10).i16(10).f32(.01).u8(0));
  expect(t.c.engine.observedOwnCastSettled()).toBe(false);
  t.c.stop();t.packet(walk(id===0?1:0));expect(t.c.engine.observedOwnCastSettled()).toBe(false);
  t.packet(walk(id));expect(t.c.engine.observedOwnCastSettled()).toBe(true);t.step(500);
  expect(t.c.snapshot().warp).toMatchObject({blocked:true,state:'stopped',activation:null,preview:null});
  expect(t.c.snapshot().warp.resourceEvidence).toContain('Waiting for ordered SP');
  expect(t.c.snapshot()).toMatchObject({runRequested:false,deaths:1,kills:7,looted:9});
  expect(t.sent).toHaveLength(1);expect(t.c.settledForMaintenance()).toBe(false);
  t.step(actionConfirmationTimeout({type:'skill'}));expect(t.c.warp.blocked).toBe(true);expect(t.sent).toHaveLength(1);
 });
 it.each(['ground','selection','activation'] as const)('advances the original %s Warp deadline through a socket-owner early return',stage=>{
  const t=fixture();t.ground();if(stage!=='ground')t.ready();if(stage==='activation')t.activate();
  // Model an already-held competing owner at the controller clock boundary.
  const busy=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(t.c.socket),'busy')!;
  Object.defineProperty(t.c.socket,'busy',{get:()=>true,configurable:true});
  const deadline=stage==='selection'?30_000:actionConfirmationTimeout({type:'skill'});
  for(let elapsed=0;elapsed<deadline;elapsed+=100){t.packet(new BitWriter().u8(40).i32(0));t.step(100);}
  Object.defineProperty(t.c.socket,'busy',busy);
  expect(t.c.snapshot().warp).toMatchObject({blocked:true,pending:false,activation:null,preview:null});
  expect(t.c.snapshot().warp.reason).toContain(stage==='activation'?'activation observation window ended':'observation window expired');
  expect(t.sent).toHaveLength(stage==='activation'?2:1);expect(t.c.runRequested).toBe(false);expect(t.generic).toEqual([]);
 });
});


describe('Warp ownership with merged stationary cast recovery',()=>{
 const cast=(id:number,skillId=42,seconds=1)=>new BitWriter().u8(FEATURE_OP.castStart).i32(id).i32(id).u8(skillId).u8(1).u8(6).i16(10).i16(10).f32(seconds).u8(0);
 const look=(id:number,head=1)=>new BitWriter().u8(13).i32(id).i16(-1).i16(5000).u8(6).u8(head);
 const walk=(id:number)=>new BitWriter().u8(7).i32(id).i16(10).i16(10).f32(10).f32(10).f32(.1).f32(.1).u8(2).u8(0x60).u8(0);
 const type=(action:unknown)=>action&&typeof action==='object'&&'type' in action?action.type:null;
 const advance=(t:ReturnType<typeof fixture>,ms:number)=>{while(ms>0){const delta=Math.min(100,ms);t.packet(new BitWriter().u8(40).i32(0));t.step(delta);ms-=delta;}};
 const fieldSettings=(automatic=false)=>{
  const automation=structuredClone(DEFAULT_AUTOMATION);automation.respawn={enabled:true,maxDeaths:1};automation.recovery.enabled=false;
  if(automatic)automation.skills=[{skillId:42,level:1,target:'self',hpBelowPercent:100,spAbovePercent:0,cooldownSeconds:30}];
  return {...DEFAULT_SETTINGS,map,targets:[4000],route_randomWalk:0 as const,automation};
 };
 const availability=(t:ReturnType<typeof fixture>,id:number,edge:string)=>{
  if(edge==='look')t.packet(look(id));
  else if(edge==='walk')t.packet(walk(id));
  else if(edge==='counter'){t.packet(cast(id,31));t.packet(new BitWriter().u8(FEATURE_OP.resetMotion).i32(id));}
  else t.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id));
 };
 it.each([0,1].flatMap(id=>['look','walk','counter','stopCast'].map(edge=>({id,edge}))))('holds Warp admission for own$id original six-query debt after $edge',({id,edge})=>{
  const t=fixture(undefined,true,id);t.c.start(fieldSettings());t.c.engine.deaths=1;t.c.engine.kills=7;t.c.engine.looted=9;
  t.packet(cast(id));advance(t,6300);expect(t.generic.filter(a=>type(a)==='look')).toHaveLength(6);
  t.c.stop();availability(t,id,edge);expect(t.c.engine.observedCast).toBeNull();expect(t.c.engine.observedOwnCastSettled()).toBe(false);
  expect(()=>t.preview(DEFAULT_AUTOMATION,{x:12,y:10})).toThrow();expect(t.sent).toEqual([]);
  advance(t,799);expect(()=>t.preview(DEFAULT_AUTOMATION,{x:12,y:10})).toThrow();expect(t.sent).toEqual([]);
  t.step(1);const request=t.preview(DEFAULT_AUTOMATION,{x:12,y:10});t.c.perform('warp',{...request,policy:DEFAULT_AUTOMATION});
  expect(t.sent).toEqual([{stage:'ground',level:4,x:12,y:10}]);expect(t.generic.filter(a=>type(a)==='look')).toHaveLength(6);
  expect(t.c.snapshot()).toMatchObject({runRequested:false,deaths:1,kills:7,looted:9});
  expect(t.c.engine.settings.automation?.respawn).toEqual({enabled:true,maxDeaths:1});expect(t.c.engine.settings.automation?.recovery.enabled).toBe(false);
 });
 it.each([0,1].flatMap(id=>['ground','activate'].map(stage=>({id,stage}))))('invalidates own$id $stage commit preview during observed Look input delay without resource acknowledgment',({id,stage})=>{
  const t=fixture(undefined,true,id);if(stage==='activate'){t.ground();t.ready();t.c.perform('warpPreview',{type:'warpActivate',policy:DEFAULT_AUTOMATION});}else t.preview();
  const request=t.c.snapshot().warp.preview,sp=t.c.engine.character.spRevision,inventory=t.c.engine.character.inventoryRevision,sent=t.sent.length;
  t.packet(look(id));expect(t.c.engine.observedCast).toBeNull();expect(t.c.engine.observedOwnCastSettled()).toBe(false);
  expect(()=>t.c.perform('warp',{...request,policy:DEFAULT_AUTOMATION})).toThrow();advance(t,199);
  expect(t.sent).toHaveLength(sent);expect(t.c.engine.character.spRevision).toBe(sp);expect(t.c.engine.character.inventoryRevision).toBe(inventory);
  t.step(1);expect(t.c.engine.observedOwnCastSettled()).toBe(true);expect(()=>t.c.perform('warp',{...request,policy:DEFAULT_AUTOMATION})).toThrow();
  if(stage==='activate')t.activate();else t.ground();expect(t.sent).toHaveLength(sent+1);expect(t.c.runRequested).toBe(false);
 });
 it.each([0,1].flatMap(id=>['look','walk','counter','stopCast'].map(edge=>({id,edge}))))('never acknowledges own$id canceled Warp resources or selection on $edge availability',({id,edge})=>{
  const t=fixture(undefined,true,id);t.c.engine.deaths=1;t.c.engine.kills=7;t.c.engine.looted=9;t.ground();
  t.packet(new BitWriter().u8(FEATURE_OP.areaCastStart).i32(id).i16(11).i16(10).u8(55).u8(4).u8(1).u8(6).i16(10).i16(10).f32(10).u8(0));
  const sp=t.c.engine.character.spRevision,inventory=t.c.engine.character.inventoryRevision;
  t.c.stop();const memo=t.c.snapshot().memo;availability(t,id,edge);advance(t,800);
  expect(t.c.engine.observedOwnCastSettled()).toBe(true);expect(t.c.engine.character.spRevision).toBe(sp);expect(t.c.engine.character.inventoryRevision).toBe(inventory);
  expect(t.c.snapshot().memo).toMatchObject({revision:memo.revision,slots:memo.slots});
  expect(t.c.snapshot().warp).toMatchObject({blocked:true,state:'stopped',selection:'unknown',activation:null,preview:null,gems:3});
  expect(t.c.snapshot().warp.resourceEvidence).toContain('Waiting for ordered SP');expect(t.c.settledForMaintenance()).toBe(false);
  expect(t.c.snapshot()).toMatchObject({runRequested:false,deaths:1,kills:7,looted:9});expect(t.sent).toHaveLength(1);
  expect(t.generic.filter(a=>type(a)==='look')).toEqual([]);expect(()=>t.c.start(fieldSettings())).toThrow();
 });
 it.each([0,1].flatMap(id=>[false,true].map(stopped=>({id,stopped}))))('advances the original own$id skill deadline while external Warp is held, stopped=$stopped',({id,stopped})=>{
  const t=fixture(undefined,true,id);t.packet(new BitWriter().u8(FEATURE_OP.learnedSkill).u8(42).u8(1).i32(0));
  t.c.start(fieldSettings(true));t.step();expect(t.c.engine.pendingFeatureAction).toMatchObject({type:'skill',skillId:42});
  const sequence=t.c.engine.actionResult.sequence;t.c.engine.deaths=1;t.c.engine.kills=7;t.c.engine.looted=9;
  t.packet(cast(id));t.packet(new BitWriter().u8(97).u8(1));expect(t.c.warp.blocked).toBe(true);if(stopped)t.c.stop();
  advance(t,actionConfirmationTimeout({type:'skill'})-1);
  if(stopped){expect(t.c.engine.featureActionsSettled).toBe(false);expect(t.c.runRequested).toBe(false);}
  else expect(t.c.engine.actionResult).toMatchObject({sequence,status:'pending'});
  t.step(1);expect(t.c.engine.actionResult).toMatchObject({sequence,status:'failed'});expect(t.c.engine.featureActionsSettled).toBe(true);
  expect(t.c.warp.blocked).toBe(true);expect(t.c.snapshot().warp).toMatchObject({activation:null,preview:null});expect(t.sent).toEqual([]);
  expect(t.generic.filter(a=>type(a)==='skill')).toHaveLength(1);expect(t.generic.filter(a=>type(a)==='look')).toEqual([]);
  expect(t.c.snapshot()).toMatchObject({runRequested:!stopped,deaths:1,kills:7,looted:9});expect(t.c.engine.settings.automation?.respawn).toEqual({enabled:true,maxDeaths:1});
  t.packet(look(id));advance(t,800);expect(t.c.warp.blocked).toBe(true);expect(t.c.snapshot().warp.activation).toBeNull();expect(t.generic.filter(a=>type(a)==='skill')).toHaveLength(1);
 });
 it.each([0,1])('does not release own%s Warp from foreign, center or obsolete Look, or report portal creation after a valid Look',id=>{
  const t=fixture(undefined,true,id);t.ground();t.ready();t.activate();t.packet(cast(id));
  t.packet(look(id===0?1:0));t.packet(look(id,0));t.packet(look(id),t.c.connectionGeneration-1);
  expect(t.c.engine.observedCast).not.toBeNull();const held=t.c.snapshot().warp;t.packet(look(id));advance(t,800);expect(t.c.engine.observedOwnCastSettled()).toBe(true);
  expect(t.c.snapshot().warp).toMatchObject({blocked:true,state:'activationSent',activation:null,preview:null});
  expect(t.c.snapshot().warp).toMatchObject({reason:held.reason,resourceEvidence:held.resourceEvidence,captured:held.captured,selection:held.selection});expect(t.sent).toHaveLength(2);expect(t.c.runRequested).toBe(false);
 });
});

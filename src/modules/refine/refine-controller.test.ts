import { validateFormSettings } from '../settings/settings';
import { inventoryItemDraft } from '../world/character-state-logic';
import { bagId as domainBagId } from '../../shared/domain-values';
import {describe,it,expect} from 'vitest';
import {CompanionController,type ControllerAction} from '../runtime/controller';
import type {Action} from '../automation/engine';
import {BitWriter} from '../../shared/binary';
import {manualTargetPolicy} from '../combat/manual-target';
import {DEFAULT_SETTINGS,DEFAULT_AUTOMATION,DEFAULT_PARTY_HEAL,DEFAULT_RETREAT} from '../settings/settings';
import {FEATURE_OP} from '../protocol/protocol-feature';
import {OP,type Entity} from '../protocol/protocol';
import type {RefinePacket} from './refine-protocol';
const player:Entity={id:1,classId:0,name:'Synthetic',kind:0,level:7,hp:100,maxHp:100,x:10,y:10,dead:false};
const npc:Entity={id:0,classId:123,name:'Refiner',kind:2,level:0,hp:0,maxHp:0,x:11,y:10,dead:false};
function unique(w:BitWriter,refine=0,guid=1){w.i32(1201).i16(1).u8(0).u8(refine);for(let i=0;i<16;i++)w.u8(guid);for(let i=0;i<4;i++)w.i32(0);return w;}
function full(zeny=10000,ore=3,refine=0):BitWriter {
 const w=new BitWriter().u8(56);for(const v of [7,7,zeny,1,1,1,1,1,1,0,0,0])w.i32(v);for(const v of [100,100,30,30,...Array(16).fill(1),2000])w.i32(v);
 w.f32(.5).i32(100).i32(0).bool(false).bool(true).u8(1).i32(ore?1:0);if(ore)w.i32(1010).i16(ore);w.i32(1).i32(700);unique(w,refine);w.u8(0);for(let i=0;i<10;i++)w.i32(0);return w.i32(-1);
}
function ownSpawn(entity:Entity,entry=1):BitWriter {
 const name=new TextEncoder().encode(entity.name),body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0)
  .i32(~name.length).i32(entity.name.length).take(name).u8(entity.kind).u8(0).u8(0).i32(entity.x).i32(entity.y).u8(entity.level)
  .i32(entity.hp).i32(entity.maxHp).i32(30).i32(30).i32(0).u8(0).finish();
 return new BitWriter().u8(6).u8(entry).i32(body.length).take(body);
}
function fixture(ownId=1,rawInitialization=false){let now=1000;const packets:RefinePacket[]=[],commands:Array<Action|ControllerAction>=[];
 const controller=new CompanionController(a=>commands.push(a),()=>now,()=>({width:30,height:30,walkable:()=>true}),()=>{},()=>{},()=>{},packet=>packets.push(packet));
 controller.connect(true);const own={...player,id:ownId},other={...npc,id:ownId===0?2:0};
 if(rawInitialization){controller.receive(new BitWriter().u8(3).i32(ownId).string('prt_in').finish());controller.receive(ownSpawn(own).finish());}
 else controller.engine.receive([{type:'enter',id:ownId,map:'prt_in'},{type:'spawn',entity:own}]);
 controller.engine.receive([{type:'spawn',entity:other}]);controller.world.reset('prt_in');
 const receive=(packet:BitWriter,epoch?:number)=>controller.receive(packet.finish(),epoch);
 const focus=()=>receive(new BitWriter().u8(77).u8(0).i32(other.id).bool(true));const prompt=()=>receive(new BitWriter().u8(77).u8(5));
 receive(full());focus();prompt();commands.length=0;
 const input={targetBagId:700,catalystBagId:0 as const,policy:structuredClone(DEFAULT_AUTOMATION),maxSpend:200,minZeny:0};
 const preview=()=>{controller.perform('refinePreview',input);return{...input,previewToken:controller.snapshot().refine.preview!.token};};
 const send=()=>controller.perform('refine',preview());
 const ore=()=>receive(new BitWriter().u8(50).bool(false).i32(1010).i16(1).i32(100).bool(false));
 const balance=()=>receive(new BitWriter().u8(40).i32(9800));const mutation=(refine=1,guid=1)=>receive(unique(new BitWriter().u8(63).i32(700),refine,guid));
 return{controller,packets,commands,own,other,receive,focus,prompt,input,preview,send,ore,balance,mutation,advance:(ms:number)=>{now+=ms;controller.tick();}};
}
describe('manual refine controller and shared protocol owner',()=>{
 it.each([0,1])('accepts ready own actor%s, NPC0, source-shaped double currency and exact shared opcode63 mutation',id=>{const f=fixture(id);f.send();expect(f.packets).toEqual([{targetBagId:700,oreItemId:1010,catalystBagId:0}]);expect(f.controller.snapshot().refine.state).toBe('pending');expect(f.controller.snapshot().running).toBe(true);
  f.ore();f.balance();f.balance();f.mutation();expect(f.controller.snapshot().refine.state).toBe('improved');expect(f.controller.engine.character.inventory.get(domainBagId(700))?.refine).toBe(1);expect(f.commands).toEqual([]);});
 it('captures current supplied visible stock/budget policy, independent of prior engine Start settings',()=>{const f=fixture();f.controller.engine.settings=validateFormSettings({...DEFAULT_SETTINGS,automation:{...structuredClone(DEFAULT_AUTOMATION),items:[]}});f.input.policy.items=[{itemId:1010,resource:'hp',belowPercent:50,minStock:3,cooldownSeconds:1}];expect(()=>f.preview()).toThrow('protected');expect(f.packets).toEqual([]);});
 it('fences all action owners and start/advance while pending and after Stop, then accepts a late exact receipt without restarting',()=>{const f=fixture();f.send();const token=f.controller.snapshot().refine.dialogueToken!;
  for(const [mode,request] of [['command',{type:'sit',sitting:true}],['social',{type:'chat',channel:0,text:'test'}],['refineAdvance',{promptToken:token}]] as const)expect(()=>f.controller.perform(mode,request)).toThrow();
  expect(()=>f.controller.start({...DEFAULT_SETTINGS,map:'prt_in',targets:[4000]})).toThrow();f.controller.stop();expect(f.controller.snapshot().refine.state).toBe('uncertain');expect(()=>f.preview()).toThrow();f.ore();f.balance();f.mutation();expect(f.controller.snapshot().refine.state).toBe('reconciled');expect(f.controller.runRequested).toBe(false);expect(f.packets).toHaveLength(1);});
 it.each(['npcEnd','map','clear','death','socket','ownReplacement','npcReplacement'] as const)('retains uncertainty across %s and never replays',kind=>{const f=fixture();f.send();
  if(kind==='npcEnd')f.receive(new BitWriter().u8(77).u8(3));else if(kind==='map')f.receive(new BitWriter().u8(18).string('prt_fild08'));else if(kind==='clear')f.receive(new BitWriter().u8(16));else if(kind==='death')f.receive(new BitWriter().u8(36).i32(f.own.id));
  else if(kind==='socket'){f.controller.disconnect();f.controller.connect(true);}else {f.controller.engine.receive([{type:'spawn',entity:kind==='ownReplacement'?{...f.own}:{...f.other}}]);f.receive(new BitWriter().u8(19).i32(f.own.id));}
  expect(f.controller.snapshot().refine.state).toBe('uncertain');expect(()=>f.preview()).toThrow();f.advance(500);expect(f.packets).toHaveLength(1);});
 it('rejects stale or foreign prompts and binds explicit advance to the displayed NPC generation',()=>{const f=fixture();const token=f.controller.snapshot().refine.dialogueToken!;f.prompt();expect(()=>f.controller.perform('refineAdvance',{promptToken:token})).toThrow('changed');
  const fresh=f.controller.snapshot().refine.dialogueToken!;f.controller.perform('refineAdvance',{promptToken:fresh});expect(f.commands).toEqual([{type:'npcAdvance'}]);expect(()=>f.controller.perform('refineAdvance',{promptToken:fresh})).toThrow();expect(f.packets).toEqual([]);});
 it('does not rebind a stale prompt to a replacement NPC or own lifetime',()=>{for(const own of [false,true]){const f=fixture(),request=f.preview(),token=f.controller.snapshot().refine.dialogueToken!;f.controller.engine.receive([{type:'spawn',entity:own?{...f.own}:{...f.other}}]);
  expect(()=>f.controller.perform('refine',request)).toThrow();expect(()=>f.controller.perform('refineAdvance',{promptToken:token})).toThrow();f.prompt();expect(()=>f.preview()).toThrow();expect(f.packets).toEqual([]);}});
 it('rejects aliases, stale revisions and shared opcode63 identity mismatches',()=>{const equipped=fixture();equipped.controller.engine.character.equipment[12]=700;expect(()=>equipped.preview()).toThrow('unequipped');
  const stale=fixture(),request=stale.preview();stale.balance();expect(()=>stale.controller.perform('refine',request)).toThrow();
  const bad=fixture();bad.send();bad.ore();bad.balance();bad.mutation(1,2);expect(bad.controller.engine.character.inventoryKnown).toBe(false);expect(bad.controller.snapshot().refine.blocked).toBe(true);});
 it('recognizes official-client own cast activity beyond scheduler idle and invalidates pre-cast previews',()=>{const f=fixture(),request=f.preview();const cast=new BitWriter().u8(24).i32(f.own.id).i32(-1).u8(11).u8(1).u8(0).position({x:10,y:10}).f32(2).u8(0);f.receive(cast);
  expect(f.controller.engine.idleForActions()).toBe(false);expect(()=>f.controller.perform('refine',request)).toThrow();expect(()=>f.preview()).toThrow();f.receive(new BitWriter().u8(27).i32(f.own.id));expect(()=>f.controller.perform('refine',request)).toThrow();expect(f.packets).toEqual([]);});
 it('reconciles init readbacks only after announced same character becomes ready, without replay or old-epoch evidence',()=>{const f=fixture();f.send();const old=f.controller.connectionGeneration;f.controller.disconnect();f.controller.connect(true);f.receive(new BitWriter().u8(3).i32(f.own.id).string('prt_in'));
  f.receive(full(9800,2,1));expect(f.controller.snapshot().refine.blocked).toBe(true);f.controller.engine.receive([{type:'spawn',entity:{...f.own}}]);f.receive(new BitWriter().u8(19).i32(f.own.id));expect(f.controller.snapshot().refine.state).toBe('reconciled');expect(f.controller.snapshot().refine.reason).toContain('remains unknown');f.receive(unique(new BitWriter().u8(63).i32(700),2),old);expect(f.packets).toHaveLength(1);});
 it('does not let fresh readbacks for another character drain the previous spend owner',()=>{const f=fixture();f.send();f.controller.disconnect();f.controller.connect(true);f.receive(new BitWriter().u8(3).i32(9).string('prt_in'));f.receive(full());f.controller.engine.receive([{type:'spawn',entity:{...f.own,id:9,name:'Another'}}]);f.receive(new BitWriter().u8(19).i32(9));expect(f.controller.snapshot().refine.blocked).toBe(true);expect(f.packets).toHaveLength(1);});
});

const availabilityLook=(id:number)=>new BitWriter().u8(13).i32(id).i16(-1).i16(5000).u8(0).u8(1);
describe('refining ownership with stationary cast recovery',()=>{
 it.each([0,1].flatMap(id=>['official','canceledReceipt'].map(owner=>({id,owner}))))(
  'separates requested-run availability from idle owned receipts for own$id $owner',({id,owner})=>{
   const f=fixture(id,true);expect(f.controller.engine.castAvailability.nonVending).toBe(false);
   if(owner==='canceledReceipt'){f.send();f.controller.stop();}
   f.receive(new BitWriter().u8(77).u8(3));expect(f.controller.engine.castAvailability.nonVending).toBe(true);
   if(owner==='official'){
    f.controller.start({...DEFAULT_SETTINGS,map:'prt_in',targets:[4000],route_randomWalk:0});
    ownCast(f,42);f.advance(400);expect(f.commands.filter(action=>action.type==='look')).toHaveLength(1);
    f.controller.officialRefineCommand(f.own.name);
   }else ownCast(f,42);
   const sent=f.commands.length;f.advance(1000);
   expect(f.controller.snapshot().refine.blocked).toBe(true);
   if(owner==='official'){
    expect(f.commands.slice(sent).some(action=>action.type==='look')).toBe(true);expect(f.controller.runRequested).toBe(true);
    expect(f.controller.refine.companionReceiptPending).toBe(false);
   }else{
    expect(f.commands.slice(sent).some(action=>action.type==='look')).toBe(false);
    expect(f.controller.engine.castAvailability.reason).toContain('Refining ownership');
    expect(f.controller.engine.castAvailability.take({cast:f.controller.engine.observedCast,requested:true,ready:true,exclusive:true,reason:''})).toBeNull();
    expect(f.controller.refine.companionReceiptPending).toBe(true);
   }
   expect(f.controller.engine.observedCast).not.toBeNull();expect(f.packets).toHaveLength(owner==='official'?0:1);
  });
 it.each([0,1])('keeps own%s official economic hold and rejects baseline reconciliation during Look cooldown',id=>{
  const f=fixture(id,true);f.receive(new BitWriter().u8(77).u8(3));
  const revision=f.controller.officialRefineResourceRevision();expect(revision).not.toBeNull();
  f.controller.start({...DEFAULT_SETTINGS,map:'prt_in',targets:[4000],route_randomWalk:0});ownCast(f,42);f.advance(400);
  expect(f.commands.filter(action=>action.type==='look')).toHaveLength(1);f.controller.officialRefineCommand(f.own.name);
  f.receive(availabilityLook(f.own.id));expect(f.controller.engine.observedCast).toBeNull();
  expect(f.controller.engine.observedOwnCastSettled()).toBe(false);expect(f.controller.officialRefineResourceRevision()).toBeNull();
  f.controller.reconcileOfficialRefineInitialization(revision!);expect(f.controller.snapshot().refine.blocked).toBe(true);
  f.controller.stop();f.advance(300);expect(f.controller.engine.observedOwnCastSettled()).toBe(true);
  expect(f.controller.snapshot().refine.blocked).toBe(true);expect(f.controller.runRequested).toBe(false);expect(f.packets).toEqual([]);
 });
 it.each([0,1])('keeps own%s canceled economic receipt through Look and cooldown, then requires all three actual resource receipts',id=>{
  const f=fixture(id,true);f.send();f.controller.stop();f.receive(new BitWriter().u8(77).u8(3));ownCast(f,42);
  const resources=f.controller.engine.character.inventoryRevision;f.receive(availabilityLook(f.own.id));
  expect(f.controller.engine.observedCast).toBeNull();expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
  expect(f.controller.engine.character.inventoryRevision).toBe(resources);expect(f.controller.snapshot().refine.blocked).toBe(true);
  expect(()=>f.preview()).toThrow();f.advance(200);expect(f.controller.engine.observedOwnCastSettled()).toBe(true);
  expect(f.controller.snapshot().refine).toMatchObject({state:'uncertain',blocked:true});
  f.ore();f.balance();expect(f.controller.snapshot().refine.blocked).toBe(true);f.mutation();
  expect(f.controller.snapshot().refine).toMatchObject({state:'reconciled',blocked:false});expect(f.packets).toHaveLength(1);expect(f.controller.runRequested).toBe(false);
 });
});


it('retires a preview after stale frames even if an unrelated packet makes the session fresh again',()=>{const f=fixture(),request=f.preview();f.advance(15001);
 expect(f.controller.snapshot().refine.preview).toBeNull();f.receive(new BitWriter().u8(19).i32(f.other.id));
 expect(()=>f.controller.perform('refine',request)).toThrow();expect(f.packets).toEqual([]);
});
it('retires a preview immediately on heartbeat loss before health returns',()=>{const f=fixture(),request=f.preview();f.controller.heartbeat(false);f.controller.heartbeat(true);
 expect(()=>f.controller.perform('refine',request)).toThrow();expect(f.packets).toEqual([]);
});
it('trusted manual input invalidates an inactive preview and fences a sent request through both sparse results',()=>{const f=fixture(),request=f.preview();expect(f.controller.active).toBe(false);
 f.controller.manualInput();expect(()=>f.controller.perform('refine',request)).toThrow();expect(f.packets).toEqual([]);
 f.send();f.controller.manualInput();f.ore();f.balance();f.balance();f.mutation();expect(f.controller.snapshot().refine.blocked).toBe(true);
 f.ore();f.receive(new BitWriter().u8(40).i32(9600));f.mutation(2);expect(f.controller.snapshot().refine.blocked).toBe(true);
 expect(()=>f.controller.perform('command',{type:'sit',sitting:true})).toThrow();f.receive(full(9600,1,2));
 expect(f.controller.snapshot().refine.state).toBe('reconciled');expect(f.controller.snapshot().refine.reason).toContain('remains unknown');expect(f.packets).toHaveLength(1);expect(f.commands).toEqual([]);
});
it.each(['stop','timeout','manual'] as const)('excludes updating after NPC closure while a %s refine receipt remains retained',kind=>{const f=fixture();const request=f.preview();expect(f.controller.settledForMaintenance()).toBe(false);
 f.controller.perform('refine',request);expect(f.controller.settledForMaintenance()).toBe(false);
 if(kind==='stop')f.controller.stop();else if(kind==='timeout')f.advance(10000);else f.controller.manualInput();
 f.receive(new BitWriter().u8(77).u8(3));f.advance(2000);expect(f.controller.settledForMaintenance()).toBe(false);
 f.ore();f.balance();f.mutation();expect(f.controller.settledForMaintenance()).toBe(kind!=='manual');
 if(kind==='manual'){f.receive(full(9800,2,1));expect(f.controller.settledForMaintenance()).toBe(true);expect(f.controller.snapshot().refine.reason).toContain('remains unknown');}
 expect(f.packets).toHaveLength(1);
});

it('does not acquire refining ownership over a current or retired manual Walk receipt',()=>{const f=fixture();f.receive(new BitWriter().u8(77).u8(3));
 f.controller.perform('command',{type:'manualTarget',map:'prt_in',owner:f.controller.engine.manualActorIdentity(f.own.id),command:{type:'walk',destination:{x:15,y:10}},timeoutSeconds:10,policy:manualTargetPolicy({...DEFAULT_SETTINGS,map:'prt_in',targets:[4000]})});f.controller.tick();
 expect(f.commands.some(action=>action.type==='walk')).toBe(true);f.focus();f.prompt();expect(()=>f.preview()).toThrow();
 f.controller.stop();f.advance(12000);f.focus();f.prompt();expect(()=>f.preview()).toThrow();expect(f.packets).toEqual([]);expect(f.controller.settledForMaintenance()).toBe(false);
});

it('retains an idle official refine spend before any receipt, timer or delayed pre-cost snapshot',()=>{
 const f=fixture();f.input.policy.items=[{itemId:1010,resource:'hp',belowPercent:50,minStock:2,cooldownSeconds:1}];
 const request=f.preview();f.controller.officialRefineCommand(f.own.name);
 expect(f.controller.snapshot().refine.blocked).toBe(true);
 for(const advance of [0,2001,10001]){
  f.advance(advance);f.receive(full());f.focus();f.prompt();
  expect(()=>f.preview()).toThrow();expect(()=>f.controller.perform('refine',request)).toThrow();
  expect(()=>f.controller.perform('refineAdvance',{promptToken:f.controller.snapshot().refine.dialogueToken})).toThrow();
 }
 f.controller.stop();f.receive(new BitWriter().u8(77).u8(3));f.ore();f.balance();f.mutation();f.receive(full(9800,2,1));
 expect(f.controller.snapshot().refine.blocked).toBe(true);expect(f.controller.settledForMaintenance()).toBe(false);
 expect(f.packets).toEqual([]);expect(f.controller.runRequested).toBe(false);
});

function ownCast(f:ReturnType<typeof fixture>,skillId=11,seconds=.1):void {
 f.receive(new BitWriter().u8(24).i32(f.own.id).i32(f.own.id).u8(skillId).u8(1).u8(0).position(f.own).f32(seconds).u8(0));
}
describe('refining uses shared observed cast availability',()=>{
 it.each([0,1])('retains preview and commit admission after own %s cast deadline and late Extend',id=>{
  const f=fixture(id),request=f.preview();ownCast(f);f.advance(500);
  f.receive(new BitWriter().u8(26).i32(f.own.id).f32(-10));
  expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
  expect(()=>f.preview()).toThrow('cast');expect(()=>f.controller.perform('refine',request)).toThrow('cast');expect(f.packets).toEqual([]);
  f.receive(new BitWriter().u8(27).i32(f.own.id));
  expect(f.controller.engine.observedOwnCastSettled()).toBe(true);
  expect(()=>f.controller.perform('refine',request)).toThrow('preview');
  f.controller.perform('refine',f.preview());expect(f.packets).toHaveLength(1);
 });
 it.each([0,1])('withholds a new initialization resource baseline during observed own %s cast uncertainty',id=>{
  const f=fixture(id);ownCast(f);f.advance(500);f.receive(new BitWriter().u8(26).i32(f.own.id).f32(-10));
  expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
  expect(f.controller.officialRefineResourceRevision()).toBeNull();expect(f.packets).toEqual([]);
 });
 it.each([0,1])('does not consume a captured initialization baseline while own %s cast remains unresolved',id=>{
  const f=fixture(id),revision=f.controller.officialRefineResourceRevision();expect(revision).not.toBeNull();
  f.controller.officialRefineCommand(f.own.name);ownCast(f);f.advance(500);f.receive(new BitWriter().u8(26).i32(f.own.id).f32(-10));
  f.controller.reconcileOfficialRefineInitialization(revision!);
  expect(f.controller.snapshot().refine.blocked).toBe(true);expect(f.controller.runRequested).toBe(false);expect(f.packets).toEqual([]);
 });
 it.each([0,1])('does not treat own %s accepted Walk or ResetMotion availability as an economic acknowledgment',id=>{
  for(const availability of ['walk','resetMotion'] as const){
   const f=fixture(id);f.send();ownCast(f,availability==='resetMotion'?31:42);
   if(availability==='walk')f.receive(new BitWriter().u8(7).i32(f.own.id).position(f.own).f32(10).f32(10).f32(.1).f32(.1).u8(2).u8(0x60).u8(0));
   else f.receive(new BitWriter().u8(111).i32(f.own.id));
   expect(f.controller.engine.observedOwnCastSettled()).toBe(true);expect(f.controller.snapshot().refine).toMatchObject({state:'pending',blocked:true});
   f.advance(10000);f.controller.stop();expect(f.controller.snapshot().refine.blocked).toBe(true);
   f.ore();f.balance();expect(f.controller.snapshot().refine.blocked).toBe(true);f.mutation();
   expect(f.controller.snapshot().refine).toMatchObject({state:'reconciled',blocked:false});expect(f.packets).toHaveLength(1);expect(f.controller.runRequested).toBe(false);
  }
 });
});

describe('refining with merged party owners',()=>{
 it.each([0,1].flatMap(id=>[false,true].map(confirmed=>({id,confirmed}))))('holds own$id refining through canceled Heal confirmed=$confirmed and ordered SP debt',({id,confirmed})=>{
  const f=fixture(id,true);f.receive(new BitWriter().u8(77).u8(3));
  const ally:Entity={...f.own,id:3,name:'Member',x:11,hp:40};f.receive(ownSpawn(ally,0));
  f.receive(new BitWriter().u8(103).i32(3).u8(1).i32(5).string('Party').bool(false));
  f.receive(new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(1).i32(7).i32(3).i16(7).string('Member').u8(0).string('prt_in').i32(40).i32(100).i32(30).i32(30));
  f.controller.engine.receive([{type:'skills',learned:[{skillId:41,level:1}]}]);
  const automation=structuredClone(DEFAULT_AUTOMATION);automation.combat.mode='off';automation.partyHeal={...DEFAULT_PARTY_HEAL,enabled:true,level:1,spReserve:0,cooldownSeconds:1,maxAttempts:1};
  f.controller.start({...DEFAULT_SETTINGS,map:'prt_in',targets:[],loot:false,automation});f.advance(100);
  expect(f.commands.filter(action=>action.type==='skill'&&action.skillId===41)).toHaveLength(1);
  f.controller.stop();expect(f.controller.partyHeal.busy).toBe(true);
  if(!confirmed){expect(f.controller.officialRefineResourceRevision()).toBeNull();expect(f.packets).toEqual([]);return;}
  f.receive(new BitWriter().u8(FEATURE_OP.skill).u8(1).i32(id).i32(-1).i32(3).u8(41).u8(1).u8(0).position(f.own).i32(-20).u8(2).u8(0).f32(0).f32(0).bool(false));
  expect(f.controller.partyHeal.busy).toBe(false);expect(f.controller.partyHeal.awaitingSpReadback).toBe(true);
  f.advance(2000);f.focus();f.prompt();expect(f.controller.engine.idleForActions()).toBe(true);
  expect(()=>f.preview()).toThrow();expect(f.controller.officialRefineResourceRevision()).toBeNull();expect(f.packets).toEqual([]);
  f.receive(new BitWriter().u8(FEATURE_OP.sp).i32(17).i32(30));expect(f.controller.partyHeal.awaitingSpReadback).toBe(false);
  expect(()=>f.preview()).not.toThrow();expect(f.controller.officialRefineResourceRevision()).not.toBeNull();expect(f.controller.runRequested).toBe(false);
 });
 it.each([0,1])('retains own%s canceled rendezvous movement for refining baseline admission until a valid shortened Walk settles',id=>{
  let now=100000;const sent:Array<Action|ControllerAction>=[],c=new CompanionController(action=>sent.push(action),()=>now,()=>({width:500,height:500,walkable:()=>true}));
  const own={...player,id,x:170,y:370},leader={...own,id:2,name:'Leader',x:174};
  c.connect(true);c.receive(new BitWriter().u8(3).i32(id).string('prt_fild08').finish());c.receive(ownSpawn(own).finish());c.receive(ownSpawn(leader,0).finish());
  c.receive(new BitWriter().u8(103).i32(2).u8(1).i32(5).string('Party').bool(true).finish());
  c.receive(new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(1).i32(7).i32(2).i16(7).string('Leader').u8(1).string('prt_fild08').i32(100).i32(100).i32(30).i32(30).finish());
  c.receive(full().finish());const automation=structuredClone(DEFAULT_AUTOMATION);automation.combat.mode='off';automation.follow={...automation.follow,mode:'partyLeader',rendezvous:true,lostSeconds:2};
  c.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[],loot:false,automation});c.engine.deaths=1;c.engine.kills=7;
  c.receive(new BitWriter().u8(102).u8(9).i32(7).string('prontera').finish());expect(c.partyFollow.ownsTravel).toBe(true);
  expect(c.officialRefineResourceRevision()).toBeNull();expect(sent.some(action=>action.type==='walk')).toBe(true);
  c.stop();expect(c.travel.movementSettled('prt_fild08',c.engine.player)).toBe(false);expect(c.officialRefineResourceRevision()).toBeNull();
  c.receive(new BitWriter().u8(7).i32(id).position(own).f32(170).f32(370).f32(.1).f32(.1).u8(2).u8(0x40).u8(0).finish());
  now+=500;c.tick();expect(c.travel.movementSettled('prt_fild08',c.engine.player)).toBe(true);expect(c.officialRefineResourceRevision()).not.toBeNull();
  expect(c.snapshot()).toMatchObject({runRequested:false,deaths:1,kills:7});
 });
});


function retreatFixture(id:number){
 const f=fixture(id,true),request=f.preview();f.receive(new BitWriter().u8(77).u8(3));
 f.controller.engine.receive([{type:'inventory',items:[...f.controller.engine.character.inventory.values()].map(inventoryItemDraft).concat([
  {bagId:77,itemId:1701,type:2,count:1,guid:'bow',flags:0,refine:0,slots:[0,0,0,0]},
  {bagId:1750,itemId:1750,type:1,count:20}]),equipment:[0,0,0,0,77,0,0,0,0,0],ammoId:1750},
  {type:'skills',learned:[{skillId:1,level:2},{skillId:29,level:5}]}]);
 f.receive(ownSpawn({...f.own,id:3,classId:4000,name:'Poring',kind:1,level:1,x:11},0));
 const automation=structuredClone(DEFAULT_AUTOMATION);automation.retreat={...DEFAULT_RETREAT,enabled:true};
 automation.respawn={enabled:true,maxDeaths:1};automation.recovery.enabled=false;
 const settings={...DEFAULT_SETTINGS,map:'prt_in',targets:[4000],automation};
 const engage=()=>{
  f.controller.start(settings);f.advance(100);f.controller.engine.deaths=1;f.controller.engine.kills=7;
  f.receive(new BitWriter().u8(OP.attack).i32(id).i32(3).i32(0).position(f.own));
  expect(f.commands.map(action=>action.type)).toEqual(['attack','stop']);expect(f.controller.engine.retreatOwned).toBe(true);
 };
 return {...f,request,settings,engage};
}
describe('refining with merged retreat ownership',()=>{
 it.each([0,1].flatMap(id=>[false,true].map(walking=>({id,walking}))))('withholds own$id economic baseline and mutation through canceled retreat walking=$walking',({id,walking})=>{
  const f=retreatFixture(id);expect(f.controller.officialRefineResourceRevision()).not.toBeNull();f.engage();
  expect(f.controller.officialRefineResourceRevision()).toBeNull();
  if(walking){f.receive(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));f.advance(100);expect(f.commands.filter(action=>action.type==='walk')).toHaveLength(1);}
  f.controller.stop();expect(f.controller.engine.retreatOwned).toBe(true);
  const sent=f.commands.length;
  // These are availability/posture evidence, not the retired Walk receipt or
  // target-clear acknowledgment required by the captured retreat owner.
  f.receive(new BitWriter().u8(OP.look).i32(id).i16(-1).i16(5000).u8(6).u8(1));
  f.receive(new BitWriter().u8(FEATURE_OP.castStop).i32(id));
  f.receive(full());f.advance(100);
  expect(f.controller.engine.retreatOwned).toBe(true);expect(f.controller.officialRefineResourceRevision()).toBeNull();
  expect(()=>f.controller.perform('command',{type:'manualTarget',map:'prt_in',owner:f.controller.engine.manualActorIdentity(id),command:{type:'walk',destination:{x:15,y:10}},timeoutSeconds:10,policy:manualTargetPolicy(f.settings)})).toThrow();
  f.focus();f.prompt();expect(()=>f.preview()).toThrow();expect(()=>f.controller.perform('refine',f.request)).toThrow();
  expect(f.packets).toEqual([]);expect(f.commands).toHaveLength(sent);
  if(walking){
   // The server may accept a shorter valid walk than the sent destination.
   f.receive(new BitWriter().u8(OP.walk).i32(id).position(f.own).f32(10).f32(10).f32(.1).f32(.1).u8(2).u8(0x60).u8(0));
   expect(f.controller.engine.retreatOwned).toBe(true);expect(f.controller.officialRefineResourceRevision()).toBeNull();f.advance(500);
  }else{
   f.receive(new BitWriter().u8(OP.stop).i32(id));expect(f.controller.engine.retreatOwned).toBe(true);
   f.receive(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));f.advance(100);
  }
  expect(f.controller.engine.retreatOwned).toBe(false);expect(f.controller.officialRefineResourceRevision()).not.toBeNull();
  expect(()=>f.preview()).not.toThrow();expect(f.controller.snapshot()).toMatchObject({runRequested:false,deaths:1,kills:7});
  expect(f.controller.engine.settings.automation).toMatchObject({respawn:{maxDeaths:1},recovery:{enabled:false}});
  expect(f.commands).toHaveLength(sent);expect(f.packets).toEqual([]);
 });
 it.each([0,1].flatMap(id=>[false,true].map(clearFirst=>({id,clearFirst}))))('keeps own$id unused retreat through Remove-before-map with clearFirst=$clearFirst',({id,clearFirst})=>{
  const f=retreatFixture(id);f.engage();expect(f.controller.officialRefineResourceRevision()).toBeNull();
  if(clearFirst)f.receive(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));
  f.receive(new BitWriter().u8(OP.remove).i32(id).u8(0).f32(-1));
  if(!clearFirst)f.receive(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));
  expect(f.controller.engine.player).toBeUndefined();expect(f.controller.engine.retreatOwned).toBe(true);
  expect(f.controller.officialRefineResourceRevision()).toBeNull();
  f.receive(new BitWriter().u8(OP.map).string('prontera'));
  f.receive(ownSpawn({...f.own,name:'Replacement'}));expect(f.controller.engine.retreatOwned).toBe(true);
  expect(f.controller.officialRefineResourceRevision()).toBeNull();expect(f.commands.some(action=>action.type==='walk')).toBe(false);
  expect(f.packets).toEqual([]);expect(f.controller.engine.deaths).toBe(1);expect(f.controller.engine.kills).toBe(7);
 });
});

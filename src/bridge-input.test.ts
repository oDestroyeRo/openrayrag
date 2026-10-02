import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionController } from './controller';
import { BitWriter } from './binary';
import { GAME_URL, OP, SOCKET_URL, VERIFIED_BUILD, walkCommand, lookCommand, command, type Entity } from './protocol';
import { FEATURE_OP, featureCommand } from './protocol-feature';
import { automationSettings, DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import type { Settings } from './settings';
import { worldCommand } from './world-protocol';
import { memoCommand } from './memo-protocol';
import { warpCommand } from './warp-protocol';
import { socketCommand } from './socket-protocol';
import { refineCommand } from './refine-protocol';
import { socialCommand } from './social-protocol';

const captured=vi.hoisted(()=>({controller:null as CompanionController|null,senders:[] as Array<(...args:never[])=>void>}));
vi.mock('./controller',async original=>{
  const actual=await original<typeof import('./controller')>();
  return {...actual,CompanionController:class extends actual.CompanionController {
    constructor(...args:ConstructorParameters<typeof actual.CompanionController>){
      super(args[0],args[1],()=>({width:200,height:200,walkable:()=>true}),args[3],args[4],args[5],args[6],args[7],args[8]);
      captured.controller=this;captured.senders=[args[0],args[3]!,args[4]!,args[5]!,args[6]!,args[7]!] as typeof captured.senders;
    }
  }};
});
vi.mock('./map-data',()=>({loadMapCatalog:async()=>null,currentMapInfo:()=>null}));

class NativeSocket extends EventTarget {
  static readonly OPEN=1;
  readyState=1;readonly writes:unknown[]=[];
  constructor(readonly url:string|URL,_protocols?:string|string[]){super();}
  send(data:string|Blob|BufferSource):void {this.writes.push(data);}
}
const player:Entity={id:0,classId:6,name:'Test',kind:0,level:15,hp:100,maxHp:100,sp:200,maxSp:200,x:100,y:100,dead:false,statuses:[]};
const monster:Entity={...player,id:2,classId:4000,name:'Poring',kind:1,level:1,hp:100,maxHp:100,x:101};
function spawn(e:Entity,entryType=0):Uint8Array {
  const name=new TextEncoder().encode(e.name);
  const body=new BitWriter().u8(15).i32(e.id).i32(e.classId).i32(0).i32(~name.length).i32(e.name.length).take(name)
    .u8(e.kind).u8(0).u8(0).i32(e.x).i32(e.y).u8(e.level).i32(e.hp).i32(e.maxHp).i32(e.sp??0).i32(e.maxSp??0).i32(0).u8(0).finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
type Page={WebSocket:typeof NativeSocket;buildUrl:string;__RAYRAG__?:{control:(action:'start'|'heartbeat',settings?:Settings)=>void;maintenance:(nonce:string,reserve:boolean|'commit')=>void;perform:(action:string,request:unknown)=>void}};
async function fixture(ready=true,ownId=0){
  const invoke=vi.fn(async(name:string)=>name==='update_ack'||name==='update_lease_alive'?true:undefined);
  const page:Page & Pick<Window,'addEventListener'> & {__TAURI_INTERNALS__:{invoke:typeof invoke}}={WebSocket:NativeSocket,buildUrl:VERIFIED_BUILD,addEventListener:()=>{},__TAURI_INTERNALS__:{invoke}},listeners=new Map<string,EventListener>();
  vi.stubGlobal('window',page);vi.stubGlobal('location',{origin:new URL(GAME_URL).origin,pathname:'/'});
  vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});
  vi.stubGlobal('document',{addEventListener:(type:string,listener:EventListener)=>listeners.set(type,listener)});
  vi.resetModules();await import('./bridge');
  const socket=new page.WebSocket(SOCKET_URL);socket.dispatchEvent(new Event('open'));
  const c=captured.controller!;
  const packetOn=async(current:NativeSocket,data:Uint8Array)=>{
    current.dispatchEvent(Object.assign(new Event('message'),{data:Uint8Array.from(data).buffer}));
    for(let i=0;i<12;i++)await Promise.resolve();
  };
  const packet=(data:Uint8Array)=>packetOn(socket,data);
  if(ready){await packet(new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());await packet(spawn({...player,id:ownId}));await packet(spawn(monster));}
  const input=(type='keydown',trusted=true)=>listeners.get(type)!({isTrusted:trusted} as Event);
  return {page,socket,c,packet,packetOn,input,invoke,start:(settings:Settings)=>page.__RAYRAG__!.control('start',settings),step:async(ms:number)=>vi.advanceTimersByTimeAsync(ms)};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100_000);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();captured.controller=null;captured.senders=[];});

function skillResources(warp=false,full=true):Uint8Array {
  const f=new BitWriter().u8(FEATURE_OP.stats);
  for(const value of [15,15,10000,1,1,1,1,1,1,0,0,0])f.i32(value);
  for(const value of [100,100,200,200,...Array(16).fill(1),2000])f.i32(value);
  f.f32(.5).i32(100).i32(0);
  if(!full)return f.bool(false).bool(false).finish();
  f.bool(true).i16(1).i16(warp?55:42).u8(warp?4:1).i16(0)
    .bool(true).u8(1).i32(warp?1:0);
  if(warp)f.i32(717).i16(3);f.i32(0).u8(0);
  for(let i=0;i<10;i++)f.i32(0);
  return f.i32(-1).finish();
}
describe('passive skill deadline during an official refine hold',()=>{
  it.each([0,1].flatMap(ownId=>[false,true].flatMap(obsolete=>[false,true].map(warpHold=>({ownId,obsolete,warpHold})))))('own $ownId, obsolete socket $obsolete, Warp hold $warpHold retains only the original skill deadline',async({ownId,obsolete,warpHold})=>{
    const f=await fixture(true,ownId);
    const current=new f.page.WebSocket(SOCKET_URL);current.dispatchEvent(new Event('open'));
    await f.packetOn(current,new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());
    await f.packetOn(current,skillResources());await f.packetOn(current,spawn({...player,id:ownId},1));
    expect(f.socket.readyState).toBe(NativeSocket.OPEN);expect(current.readyState).toBe(NativeSocket.OPEN);
    const counters=[f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted];
    f.c.perform('command',{type:'skill',mode:'self',skillId:42,level:1});
    expect(f.c.engine.actionResult).toMatchObject({sequence:1,status:'pending'});
    expect(current.writes).toHaveLength(1);
    const skill=current.writes[0];
    const economic=vi.spyOn(f.c,'officialRefineCommand'),takeover=vi.spyOn(f.c,'manualCommand');
    const frame=Uint8Array.from(refineCommand({targetBagId:700,oreItemId:1010,catalystBagId:0}));
    const native=NativeSocket.prototype.send;
    vi.spyOn(NativeSocket.prototype,'send').mockImplementation(function(this:NativeSocket,data){
      if(data===frame)expect(f.c.snapshot().refine.blocked).toBe(true);
      native.call(this,data);
    });
    if(warpHold)await f.packetOn(current,new BitWriter().u8(97).u8(1).finish());
    const writer=obsolete?f.socket:current;writer.send(frame);
    expect(economic).toHaveBeenCalledOnce();expect(takeover).toHaveBeenCalledTimes(obsolete?0:1);
    expect(writer.writes.at(-1)).toBe(frame);
    if(obsolete)expect(f.c.engine.pendingFeatureAction).toEqual({type:'skill',mode:'self',skillId:42,level:1});
    else expect(f.c.engine.pendingFeatureAction).toBeNull();
    for(let second=1;second<=31;second++){
      f.page.__RAYRAG__!.control('heartbeat');
      await f.packetOn(current,new BitWriter().u8(OP.stop).i32(ownId).finish());await f.step(1000);
      if(second===29){
        expect(f.c.engine.featureActionsSettled).toBe(false);
        if(obsolete)expect(f.c.engine.actionResult).toMatchObject({sequence:1,status:'pending'});
      }
      if(second===30)expect(f.c.engine.actionResult).toMatchObject({sequence:1,status:'failed'});
    }
    expect(f.c.engine.pendingFeatureAction).toBeNull();expect(f.c.engine.featureActionsSettled).toBe(true);
    expect(f.c.engine.actionResult.reason).toBe(obsolete?'No server confirmation for skill.':'Action canceled.');
    expect(f.c.snapshot()).toMatchObject({running:false,runRequested:false,refine:{blocked:true,state:'uncertain'}});
    expect(f.c.warp.blocked).toBe(warpHold);expect(f.c.snapshot().warp.activation).toBeNull();
    // Only the existing skill's Stop cancellation may accompany the original
    // official frame. No Look, retry, refine replay or other decision is sent.
    expect(current.writes).toEqual(obsolete?[skill,command('stop')]:[skill,command('stop'),frame]);
    expect(f.socket.writes).toEqual(obsolete?[frame]:[]);
    expect([f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted]).toEqual(counters);
    expect(automationSettings(f.c.engine.settings).respawn.maxDeaths).toBe(1);
    expect(automationSettings(f.c.engine.settings).recovery.enabled).toBe(false);
  });
  it.each([0,1])('advances own%s original Warp deadline while actual obsolete OPEN opcode80 retains its economic hold',async ownId=>{
    const f=await fixture(true,ownId),current=new f.page.WebSocket(SOCKET_URL);current.dispatchEvent(new Event('open'));
    await f.packetOn(current,new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());await f.packetOn(current,skillResources(true));
    await f.packetOn(current,new BitWriter().u8(94).u8(1).string('prontera').i16(100).i16(100).u8(0).u8(0).u8(0).finish());
    await f.packetOn(current,spawn({...player,id:ownId},1));
    const policy=structuredClone(DEFAULT_AUTOMATION);f.c.perform('warpPreview',{type:'warpGround',slot:0,target:{x:101,y:100},policy});f.c.perform('warp',{...f.c.snapshot().warp.preview,policy});
    expect(f.c.snapshot().warp).toMatchObject({blocked:true,pending:true});const ground=current.writes[0];
    const frame=Uint8Array.from(refineCommand({targetBagId:700,oreItemId:1010,catalystBagId:0}));f.socket.send(frame);
    expect(f.socket.readyState).toBe(NativeSocket.OPEN);expect(f.c.snapshot().refine.blocked).toBe(true);
    for(let second=1;second<=31;second++){
      f.page.__RAYRAG__!.control('heartbeat');
      await f.packetOn(current,new BitWriter().u8(OP.stop).i32(ownId).finish());await f.step(1000);
      if(second===29)expect(f.c.snapshot().warp.pending).toBe(true);
      if(second===30)expect(f.c.snapshot().warp).toMatchObject({blocked:true,pending:false,state:'stopped',activation:null});
    }
    expect(f.c.snapshot().warp.reason).toContain('observation window expired');expect(f.c.snapshot().warp.resourceEvidence).toContain('Waiting for ordered SP');
    expect(f.c.snapshot().refine).toMatchObject({blocked:true,state:'uncertain'});expect(f.c.settledForMaintenance()).toBe(false);f.c.stop();
    expect(f.c.runRequested).toBe(false);expect(current.writes).toEqual([ground]);expect(f.socket.writes).toEqual([frame]);
  });
});

describe('official page input and socket boundary',()=>{
  it('gives official Look manual grace without routing it through resource cancellation, and forwards exactly once',async()=>{
    const f=await fixture(),look=vi.spyOn(f.c,'officialLook'),takeover=vi.spyOn(f.c,'manualCommand');
    const frame=lookCommand({type:'look',direction:7,head:2});f.socket.send(frame);
    expect(look).toHaveBeenCalledOnce();expect(takeover).not.toHaveBeenCalled();expect(f.socket.writes).toEqual([frame]);
  });
  it('encodes Companion Look through the prototype transport and updater dispatch gate',async()=>{
    const f=await fixture(),look=vi.spyOn(f.c,'officialLook');Reflect.apply(captured.senders[0]!,null,[{type:'look',direction:6,head:1}]);
    expect(new Uint8Array(f.socket.writes[0] as ArrayBuffer)).toEqual(Uint8Array.of(13,6,1));expect(look).not.toHaveBeenCalled();
    expect(()=>Reflect.apply(captured.senders[0]!,null,[{type:'look',direction:8,head:1}])).toThrow();expect(f.socket.writes).toHaveLength(1);
  });
  it('preserves an actual own-zero opener through the trusted panel listener and normal raw result',async()=>{
    const f=await fixture(),a=structuredClone(DEFAULT_AUTOMATION);
    a.attackStrategies=[{id:'open',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
    f.c.engine.receive([{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:11,level:1}]}]);
    f.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:a});await f.step(100);
    f.input();await f.step(1000);
    await f.packet(new BitWriter().u8(FEATURE_OP.skill).u8(1).i32(0).i32(0).i32(2).u8(11).u8(1).u8(0)
      .position(player).i32(1).u8(0).u8(1).f32(1).f32(0).bool(false).finish());
    await f.step(1000);
    const ops=f.socket.writes.map(data=>new Uint8Array(data as ArrayBuffer)[0]);
    expect(ops).toEqual([FEATURE_OP.skill,OP.attack]);expect(f.c.runRequested).toBe(true);
  });
  it.each([walkCommand({x:102,y:100}),command('attack',2),featureCommand({type:'useItem',itemId:501}),
    featureCommand({type:'equip',bagId:1001,equipped:true}),worldCommand({type:'npcTalk',id:7}),memoCommand(0),
    socketCommand({type:'socket',targetBagId:20001,cardBagId:4002}),refineCommand({targetBagId:700,oreItemId:1010,catalystBagId:0})])('takes over before forwarding the same official gameplay frame once',async source=>{
    const frame=Uint8Array.from(source);
    const f=await fixture(),order:string[]=[];
    vi.spyOn(f.c,'manualCommand').mockImplementation(()=>{order.push('takeover');});
    vi.spyOn(NativeSocket.prototype,'send').mockImplementation(function(this:NativeSocket,data){order.push('send');this.writes.push(data);});
    f.socket.send(frame);expect(order).toEqual(['takeover','send']);expect(f.socket.writes).toEqual([frame]);
  });
  it('never classifies auth/keepalive/query/chat, inactive or unverified socket traffic as takeover',async()=>{
    const f=await fixture(),takeover=vi.spyOn(f.c,'manualCommand');
    const frames=[new Uint8Array([2]),new Uint8Array([3,7,48]),new Uint8Array([4]),new Uint8Array([55,0]),
      socialCommand({type:'chat',channel:0,text:'synthetic'}),'opaque authentication string'];
    for(const frame of frames)f.socket.send(frame);expect(takeover).not.toHaveBeenCalled();expect(f.socket.writes).toEqual(frames);
    const other=new f.page.WebSocket('wss://unrelated.invalid/ws');other.send(command('attack',2));expect(takeover).not.toHaveBeenCalled();
    f.page.buildUrl='other';f.socket.send(command('attack',2));expect(takeover).not.toHaveBeenCalled();
    f.page.buildUrl=VERIFIED_BUILD;f.c.engine.compatible=false;f.socket.send(command('attack',2));expect(takeover).not.toHaveBeenCalled();
    f.c.engine.compatible=true;f.socket.readyState=0;f.socket.send(command('attack',2));expect(takeover).not.toHaveBeenCalled();
  });
  it('excludes the unframed source version-8 login even after a prior entered session reconnects',async()=>{
    for(const entered of [false,true]){
      const f=await fixture(entered),takeover=vi.spyOn(f.c,'manualCommand');
      const socket=entered?new f.page.WebSocket(SOCKET_URL):f.socket;
      if(entered)socket.dispatchEvent(new Event('open'));
      // Login starts with server-version i16, not a PacketType opcode. Never
      // interpret even its first byte until this connection owns a ready actor.
      const auth=new BitWriter().i16(8).string('synthetic').string('not-a-real-credential').finish();
      socket.send(auth);expect(takeover).not.toHaveBeenCalled();expect(socket.writes).toEqual([auth]);
      expect(f.c.engine.actorActionIdentity()).toBeNull();
      vi.restoreAllMocks();
    }
  });
  it('bypasses the official hook for each Companion transport and ignores untrusted DOM events',async()=>{
    const f=await fixture(),takeover=vi.spyOn(f.c,'manualCommand'),input=vi.spyOn(f.c,'manualInput');
    const [field,social,memo,socket,refine,warp]=captured.senders;
    Reflect.apply(field!,null,[{type:'attack',id:2}]);Reflect.apply(social!,null,[{type:'emote',id:1}]);
    Reflect.apply(memo!,null,[0]);Reflect.apply(socket!,null,[{type:'socket',targetBagId:20001,cardBagId:4002}]);Reflect.apply(refine!,null,[{targetBagId:700,oreItemId:1010,catalystBagId:0}]);
    Reflect.apply(warp!,null,[{stage:'ground',level:4,x:101,y:100}]);
    f.input('keydown',false);expect(input).not.toHaveBeenCalled();expect(takeover).not.toHaveBeenCalled();expect(f.socket.writes).toHaveLength(6);
  });
  it('does not prevent or repeat the official send when the takeover hook throws',async()=>{
    const f=await fixture();vi.spyOn(f.c,'manualCommand').mockImplementation(()=>{throw new Error('synthetic hook failure');});
    const frame=command('attack',2);expect(()=>f.socket.send(frame)).not.toThrow();expect(f.socket.writes).toEqual([frame]);
  });
});

describe('update dispatch freeze',()=>{
  it('gates every official payload and all five prototype transports before forwarding, with no replay after release',async()=>{
    const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
    const nonce='a'.repeat(32);f.page.__RAYRAG__!.maintenance(nonce,true);
    for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);
    for(const packet of [command('attack',2),new Uint8Array([2]),'opaque',new Blob(['opaque'])])f.socket.send(packet);
    for(const [sender,args]of captured.senders.map((sender,i)=>[sender,[[{type:'attack',id:2}],[{type:'emote',id:1}],[0],[{type:'socket',targetBagId:20001,cardBagId:4002}],[{targetBagId:700,oreItemId:1010,catalystBagId:0}],[{stage:'ground',level:4,x:101,y:100}]][i]!] as const))expect(()=>Reflect.apply(sender,null,args)).toThrow('Client update');
    expect(()=>Reflect.apply(captured.senders[5]!,null,[{stage:'activate',slot:0}])).toThrow('Client update');
    const perform=vi.spyOn(f.c,'perform');for(const mode of ['warpPreview','warp','warpCancel'])f.page.__RAYRAG__!.perform(mode,{});expect(perform).not.toHaveBeenCalled();
    expect(f.socket.writes).toEqual([]);await f.step(5000);f.socket.send('still held');expect(f.socket.writes).toEqual([]);
    f.page.__RAYRAG__!.maintenance(nonce,false);f.socket.send('new payload');expect(f.socket.writes).toEqual(['new payload']);
  });
  it('does not ACK pre-Enter or an official outstanding action',async()=>{
    for(const ready of [false,true]){const f=await fixture(ready);if(ready)f.socket.send(featureCommand({type:'useItem',itemId:501}));f.page.__RAYRAG__!.maintenance('b'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);}
  });
});

it('invalidates a held acknowledgment on incoming world/own changes before a final commit ACK',async()=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);const nonce='c'.repeat(32);f.page.__RAYRAG__!.maintenance(nonce,true);for(let i=0;i<15;i++)await Promise.resolve();
 expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);await f.packet(new BitWriter().u8(OP.clear).finish());
 expect(f.invoke.mock.calls.some(c=>c[0]==='update_invalidate')).toBe(true);f.page.__RAYRAG__!.maintenance(nonce,'commit');for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_final_ack')).toBe(false);f.socket.send('must remain frozen');expect(f.socket.writes).toEqual([]);
});

it('freezes obsolete game sockets and rejects a second ACK after socket replacement',async()=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
 const nonce='d'.repeat(32);f.page.__RAYRAG__!.maintenance(nonce,true);for(let i=0;i<15;i++)await Promise.resolve();
 const replacement=new f.page.WebSocket(SOCKET_URL);replacement.dispatchEvent(new Event('open'));
 f.socket.send('obsolete queued game payload');replacement.send('new game payload');expect(f.socket.writes).toEqual([]);expect(replacement.writes).toEqual([]);
 const unrelated=new f.page.WebSocket('wss://unrelated.invalid');unrelated.send('unrelated');expect(unrelated.writes).toEqual(['unrelated']);
 f.page.__RAYRAG__!.maintenance(nonce,'commit');for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_final_ack')).toBe(false);
 expect(f.invoke.mock.calls.some(c=>c[0]==='update_invalidate')).toBe(true);
});

function initializedResources(ore?:number):Uint8Array {
 const f=new BitWriter().u8(FEATURE_OP.stats);
 for(const value of [15,7,500,3,4,5,6,7,8,0,0,123])f.i32(value);
 for(const value of [100,100,200,200,...Array(16).fill(1),2000])f.i32(value);
 f.f32(.5).i32(0).i32(0).bool(true).i16(0).i16(0).bool(true).u8(ore===undefined?0:1);
 if(ore!==undefined){f.i32(1).i32(1010).i16(ore).i32(1).i32(700).i32(1201).i16(1).u8(0).u8(0);for(let i=0;i<16;i++)f.u8(1);for(let i=0;i<4;i++)f.i32(0);}
 f.u8(0);
 for(let i=0;i<10;i++)f.i32(0);return f.i32(-1).finish();
}
it('reconciles official uncertainty only after closed old transport and complete first new initialization',async()=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
 f.socket.send(featureCommand({type:'useItem',itemId:501}));
 await f.packet(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packet(initializedResources());await f.packet(spawn(player));
 f.page.__RAYRAG__!.maintenance('e'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,initializedResources());await f.packetOn(next,spawn(player));
 f.page.__RAYRAG__!.maintenance('e'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 f.socket.dispatchEvent(new Event('close'));await f.packetOn(next,new BitWriter().u8(OP.heal).i32(0).i32(0).i32(100).i32(100).finish());
 f.page.__RAYRAG__!.maintenance('e'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 const initialized=new f.page.WebSocket(SOCKET_URL);initialized.dispatchEvent(new Event('open'));
 await f.packetOn(initialized,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(initialized,initializedResources());await f.packetOn(initialized,spawn(player,1));
 f.page.__RAYRAG__!.maintenance('e'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);expect(initialized.writes).toEqual([]);
});

it.each([0,1])('requires matching own entryType1 after complete resources (%s)',async entryType=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);f.socket.send(command('attack',2));f.socket.dispatchEvent(new Event('close'));
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,initializedResources());await f.packetOn(next,spawn(player,entryType));
 f.page.__RAYRAG__!.maintenance('f'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(entryType===1);
});
it('does not reconcile an own ready marker that predates full resources',async()=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);f.socket.send(command('attack',2));f.socket.dispatchEvent(new Event('close'));
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,spawn(player,1));await f.packetOn(next,initializedResources());
 f.page.__RAYRAG__!.maintenance('f'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
});

it.each([new Uint8Array([255]),'opaque payload',new Blob(['opaque payload'])])('synchronously holds obsolete verified-ready transport uncertainty without takeover or body reads',async frame=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);const takeover=vi.spyOn(f.c,'manualCommand');
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,initializedResources());await f.packetOn(next,spawn(player,1));
 const read=frame instanceof Blob?vi.spyOn(frame,'arrayBuffer'):null;
 f.socket.send(frame);f.page.__RAYRAG__!.maintenance('a'.repeat(32),true);
 for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);expect(takeover).not.toHaveBeenCalled();expect(f.socket.writes).toEqual([frame]);if(read)expect(read).not.toHaveBeenCalled();
});

it.each([false,true])('never reuses initialization after a new official send (pending reconciliation=%s)',async pending=>{
 const f=await fixture();const settled=vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
 f.socket.send(featureCommand({type:'useItem',itemId:501}));f.socket.dispatchEvent(new Event('close'));
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 if(pending)settled.mockReturnValue(false);
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,initializedResources());await f.packetOn(next,spawn(player,1));
 if(!pending){
  f.page.__RAYRAG__!.maintenance('a'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);
  f.page.__RAYRAG__!.maintenance('a'.repeat(32),false);f.invoke.mockClear();
 }
 next.send(featureCommand({type:'useItem',itemId:501}));settled.mockReturnValue(true);
 await f.packetOn(next,new BitWriter().u8(OP.heal).i32(0).i32(0).i32(100).i32(100).finish());
 f.page.__RAYRAG__!.maintenance('b'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 expect(next.writes).toHaveLength(1);
});

it('retains every uncertain open transport before capturing a newer initialization',async()=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
 const b=new f.page.WebSocket(SOCKET_URL);b.dispatchEvent(new Event('open'));
 await f.packetOn(b,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(b,initializedResources());await f.packetOn(b,spawn(player,1));
 f.socket.send(featureCommand({type:'useItem',itemId:501}));b.send(featureCommand({type:'useItem',itemId:501}));b.dispatchEvent(new Event('close'));
 const c=new f.page.WebSocket(SOCKET_URL);c.dispatchEvent(new Event('open'));
 await f.packetOn(c,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(c,initializedResources());await f.packetOn(c,spawn(player,1));
 f.page.__RAYRAG__!.maintenance('a'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 f.socket.dispatchEvent(new Event('close'));await f.packetOn(c,new BitWriter().u8(OP.heal).i32(0).i32(0).i32(100).i32(100).finish());
 f.page.__RAYRAG__!.maintenance('a'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 const d=new f.page.WebSocket(SOCKET_URL);d.dispatchEvent(new Event('open'));
 await f.packetOn(d,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(d,initializedResources());await f.packetOn(d,spawn(player,1));
 f.page.__RAYRAG__!.maintenance('b'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);
 expect(f.socket.writes).toHaveLength(1);expect(b.writes).toHaveLength(1);expect(c.writes).toEqual([]);expect(d.writes).toEqual([]);
});

it('retains updater uncertainty when the bounded transport tracker overflows',async()=>{
 const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
 const owners:NativeSocket[]=[f.socket];f.socket.send(new Uint8Array([255]));
 for(let i=0;i<32;i++){
  const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
  await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,initializedResources());await f.packetOn(next,spawn(player,1));
  next.send(new Uint8Array([255]));owners.push(next);
 }
 for(const owner of owners)owner.dispatchEvent(new Event('close'));
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await f.packetOn(next,initializedResources());await f.packetOn(next,spawn(player,1));
 f.page.__RAYRAG__!.maintenance('a'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
 expect(owners.every(owner=>owner.writes.length===1)).toBe(true);expect(next.writes).toEqual([]);
});


it('owns idle official80 before forwarding and never double-spends protected ore from delayed pre-cost state',async()=>{
 const f=await fixture(),npc={...player,id:3,kind:2 as const,name:'Refiner'};
 await f.packet(initializedResources(3));await f.packet(spawn(npc));
 const prompt=async()=>{await f.packet(new BitWriter().u8(77).u8(0).i32(3).bool(true).finish());await f.packet(new BitWriter().u8(77).u8(5).finish());};
 await prompt();const policy=structuredClone(DEFAULT_AUTOMATION);policy.items=[{itemId:1010,resource:'hp',belowPercent:50,minStock:2,cooldownSeconds:1}];
 const input={targetBagId:700,catalystBagId:0,policy,maxSpend:200,minZeny:0};f.c.perform('refinePreview',input);
 const request={...input,previewToken:f.c.snapshot().refine.preview!.token};
 const frame=Uint8Array.from(refineCommand({targetBagId:700,oreItemId:1010,catalystBagId:0}));
 vi.spyOn(NativeSocket.prototype,'send').mockImplementation(function(this:NativeSocket,data){expect(f.c.snapshot().refine.blocked).toBe(true);this.writes.push(data);});
 f.socket.send(frame);expect(f.socket.writes).toEqual([frame]);
 for(const elapsed of [0,2001,10001]){await f.step(elapsed);await f.packet(initializedResources(3));await prompt();expect(()=>f.c.perform('refinePreview',input)).toThrow();expect(()=>f.c.perform('refine',request)).toThrow();}
 f.c.stop();await f.packet(new BitWriter().u8(77).u8(3).finish());
 expect(f.c.settledForMaintenance()).toBe(false);expect(f.c.snapshot().refine.blocked).toBe(true);expect(f.socket.writes).toEqual([frame]);
});

it.each(['valid','oldOpen','sameSocket','wrongCharacter','preliminary','readyBeforeFull','entryType0','sparseAfterFull','newOfficial80','obsoleteOfficial80'] as const)(
 'releases official refine uncertainty only for one newer complete same-character initialization: %s',async kind=>{
 const f=await fixture(),frame=Uint8Array.from(refineCommand({targetBagId:700,oreItemId:1010,catalystBagId:0}));f.socket.send(frame);
 if(!['oldOpen','sameSocket','obsoleteOfficial80'].includes(kind))f.socket.dispatchEvent(new Event('close'));
 const next=kind==='sameSocket'?f.socket:new f.page.WebSocket(SOCKET_URL);if(next!==f.socket)next.dispatchEvent(new Event('open'));
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());
 if(kind==='readyBeforeFull')await f.packetOn(next,spawn(player,1));
 if(kind!=='preliminary')await f.packetOn(next,initializedResources(2));
 else await f.packetOn(next,new BitWriter().u8(40).i32(300).finish());
 if(kind==='sparseAfterFull')await f.packetOn(next,new BitWriter().u8(50).bool(false).i32(1010).i16(1).i32(0).bool(false).finish());
 if(kind==='newOfficial80')next.send(frame);
 if(kind==='obsoleteOfficial80'){f.socket.send(frame);f.socket.dispatchEvent(new Event('close'));}
 if(kind!=='readyBeforeFull')await f.packetOn(next,spawn(kind==='wrongCharacter'?{...player,name:'Another'}:player,kind==='entryType0'?0:1));
 expect(f.c.snapshot().refine.blocked).toBe(kind!=='valid');expect(f.c.runRequested).toBe(false);
 if(kind==='valid'){
  expect(f.c.snapshot().refine.reason).toContain('remains unknown');await f.step(2001);expect(f.c.settledForMaintenance()).toBe(true);expect(next.writes).toEqual([]);
  const npc={...player,id:3,kind:2 as const,name:'Refiner'};await f.packetOn(next,spawn(npc));await f.packetOn(next,new BitWriter().u8(77).u8(0).i32(3).bool(true).finish());await f.packetOn(next,new BitWriter().u8(77).u8(5).finish());
  f.c.perform('refinePreview',{targetBagId:700,catalystBagId:0,policy:structuredClone(DEFAULT_AUTOMATION),maxSpend:200,minZeny:0});expect(f.c.snapshot().refine.preview).not.toBeNull();expect(next.writes).toEqual([]);
 }else{
  // Delayed closure, renewed resources or a replacement own actor cannot repair
  // an invalid/consumed initialization baseline on that same transport.
  f.socket.dispatchEvent(new Event('close'));await f.packetOn(next,initializedResources(2));await f.packetOn(next,spawn(player,0));
  expect(f.c.snapshot().refine.blocked).toBe(true);
 }
});

it('keeps panel input and non-economic official commands free of the refine hold',async()=>{
 const f=await fixture();f.input();f.socket.send(command('attack',2));expect(f.c.snapshot().refine.blocked).toBe(false);
 const unrelated=new f.page.WebSocket('wss://unrelated.invalid');unrelated.send(new Uint8Array([80]));expect(f.c.snapshot().refine.blocked).toBe(false);
});

it('marks official Warp uncertainty before forwarding and retains it through Stop and maintenance settlement',async()=>{
 const f=await fixture(),frame=warpCommand({stage:'ground',level:4,x:101,y:100});
 vi.spyOn(NativeSocket.prototype,'send').mockImplementation(function(this:NativeSocket,data){expect(f.c.warp.blocked).toBe(true);this.writes.push(data);});
 f.socket.send(frame);expect(f.socket.writes).toEqual([frame]);f.c.stop();await f.step(5000);expect(f.c.warp.blocked).toBe(true);
 f.page.__RAYRAG__!.maintenance('a'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(false);
});
it('serializes Warp Ready evidence after inbound full resources and memo without reviving old intent',async()=>{
 const f=await fixture();f.socket.send(warpCommand({stage:'activate',slot:0}));f.socket.dispatchEvent(new Event('close'));
 const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
 next.send(new BitWriter().u8(3).bool(false).string('Test').finish());
 await f.packetOn(next,new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());
 const w=new BitWriter().u8(56);for(const n of [15,1,50,1,1,1,1,1,1,0,0,0])w.i32(n);for(const n of [100,100,200,200,...Array(17).fill(0)])w.i32(n);
 w.f32(1).i32(0).i32(0).bool(true).i16(1).i16(55).u8(4).i16(0).bool(true).u8(1).i32(1).i32(717).i16(3).i32(0).u8(0);for(let i=0;i<10;i++)w.i32(0);w.i32(-1);
 // Queue Ready immediately behind inbound messages, without awaiting their observers.
 for(const data of [w.finish(),new BitWriter().u8(94).u8(1).string('prontera').i16(100).i16(100).u8(0).u8(0).u8(0).finish()])next.dispatchEvent(Object.assign(new Event('message'),{data:data.buffer}));
 next.send(new Uint8Array([2]));expect(f.c.warp.blocked).toBe(true);await f.packetOn(next,spawn(player,1));
 expect(f.c.warp.blocked).toBe(false);expect(f.c.snapshot().warp).toMatchObject({state:'recovered',activation:null,preview:null});
 await f.step(2000);f.page.__RAYRAG__!.maintenance('b'.repeat(32),true);for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);expect(next.writes).toHaveLength(2);
});


describe('certified fresh initialization with coexisting Warp and official refining uncertainty',()=>{
 const memo=()=>new BitWriter().u8(94).u8(1).string('prontera').i16(100).i16(100).u8(0).u8(0).u8(0).finish();
 const refine=()=>Uint8Array.from(refineCommand({targetBagId:700,oreItemId:1010,catalystBagId:0}));
 async function held(ownId:number,owners:'warpOnly'|'refineOnly'|'bothManual'|'bothOfficial',stop=true){
  const f=await fixture(true,ownId);await f.packet(skillResources(true));await f.packet(memo());
  if(owners==='bothManual'){
   const policy=structuredClone(DEFAULT_AUTOMATION);f.c.perform('warpPreview',{type:'warpGround',slot:0,target:{x:102,y:100},policy});
   f.c.perform('warp',{...f.c.snapshot().warp.preview,policy});
  }else if(owners!=='refineOnly')f.socket.send(warpCommand({stage:'ground',level:4,x:102,y:100}));
  if(owners!=='warpOnly')f.socket.send(refine());if(stop)f.c.stop();
  expect(f.c.warp.blocked).toBe(owners!=='refineOnly');expect(f.c.snapshot().refine.blocked).toBe(owners!=='warpOnly');
  return f;
 }
 async function enter(f:Awaited<ReturnType<typeof held>>,ownId:number,close=true){
  if(close){f.socket.readyState=3;f.socket.dispatchEvent(new Event('close'));}
  const next=new f.page.WebSocket(SOCKET_URL);next.dispatchEvent(new Event('open'));
  next.send(new BitWriter().u8(3).bool(false).string('Test').finish());
  await f.packetOn(next,new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());return next;
 }
 it.each([0,1].flatMap(ownId=>(['warpOnly','refineOnly','bothManual','bothOfficial'] as const).map(owners=>({ownId,owners}))))('own$ownId $owners retries the retained certificate after grace with no later packet',async({ownId,owners})=>{
  // Match the original independent bridge transcript, including its absence of
  // client Stop: Stop would clear the retained official-input grace period.
  const f=await held(ownId,owners,false),counters=[f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted],next=await enter(f,ownId);
  await f.packetOn(next,skillResources(true));await f.packetOn(next,memo());next.send(Uint8Array.of(2));await f.packetOn(next,spawn({...player,id:ownId},1));
  f.page.__RAYRAG__!.control('heartbeat');
  if(owners==='bothManual'){
   expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
   await f.step(1999);expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
   await f.step(501);
  }else await f.step(2500);
  expect(f.c.engine.idleForActions()).toBe(true);expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  expect(f.c.snapshot().refine.blocked).toBe(false);expect(f.c.warp.blocked).toBe(false);expect(f.c.runRequested).toBe(false);
  expect(f.c.snapshot().warp.activation).toBeNull();expect(f.c.snapshot().warp.preview).toBeNull();
  expect([f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted]).toEqual(counters);
  expect(next.writes.map(data=>(data as Uint8Array)[0])).toEqual([3,2]);
 });
 it.each([0,1].flatMap(ownId=>(['warpOnly','refineOnly','bothManual','bothOfficial'] as const).map(owners=>({ownId,owners}))))('own$ownId $owners retires only availability after one complete reset',async({ownId,owners})=>{
  const f=await held(ownId,owners),counters=[f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted];
  const next=await enter(f,ownId);await f.packetOn(next,skillResources(true));await f.packetOn(next,memo());
  // Ordinary readback and admission remain unavailable while both holds exist.
  if(owners.startsWith('both')){expect(f.c.officialRefineResourceRevision()).toBeNull();expect(()=>f.c.perform('refinePreview',{})).toThrow();}
  next.send(Uint8Array.of(2));await f.packetOn(next,spawn({...player,id:ownId},1));
  f.page.__RAYRAG__!.control('heartbeat');await f.step(2500);
  expect(f.c.engine.observedOwnCastSettled()).toBe(true);expect(f.c.engine.idleForActions()).toBe(true);
  expect(f.c.snapshot().refine.blocked).toBe(false);expect(f.c.warp.blocked).toBe(false);expect(f.c.runRequested).toBe(false);
  expect([f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted]).toEqual(counters);
  expect(f.c.snapshot().warp.activation).toBeNull();expect(f.c.snapshot().warp.preview).toBeNull();
  if(owners!=='warpOnly')expect(f.c.snapshot().refine.reason).toContain('remains unknown');
  expect(next.writes.map(data=>(data as Uint8Array)[0])).toEqual([3,2]);
  next.readyState=3;next.dispatchEvent(new Event('close'));
  const again=await enter(f,ownId,false);await f.packetOn(again,skillResources(true));await f.packetOn(again,memo());again.send(Uint8Array.of(2));await f.packetOn(again,spawn({...player,id:ownId},1));
  expect(f.c.warp.blocked).toBe(false);expect(f.c.snapshot().refine.blocked).toBe(false);expect(f.c.runRequested).toBe(false);
  expect(again.writes.map(data=>(data as Uint8Array)[0])).toEqual([3,2]);
 });
 it.each([0,1].flatMap(ownId=>(['oldOpen','staleResources','new80','ordinaryLook','obsolete80','duplicateEnter','inventoryChanged','spChanged','zenyChanged','secondFull','foreign','hp0','entry0','entry2','duplicateReady','missingReady','missingMemo','readyBeforeFull','firstSparse','ordinaryReadback'] as const).map(fault=>({ownId,fault}))))('own$ownId $fault cannot certify dual-owner reset',async({ownId,fault})=>{
  const f=await held(ownId,'bothOfficial');
  const next=['ordinaryReadback','ordinaryLook'].includes(fault)?f.socket:await enter(f,ownId,fault!=='oldOpen'&&fault!=='obsolete80');
  if(fault==='readyBeforeFull')next.send(Uint8Array.of(2));
  if(fault==='firstSparse'){await f.packetOn(next,skillResources(true,false));expect(f.c.engine.character.inventoryKnown).toBe(false);}
  if(fault==='duplicateEnter'){next.send(new BitWriter().u8(3).bool(false).string('Test').finish());await f.packetOn(next,new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish());}
  await f.packetOn(fault==='staleResources'?f.socket:next,skillResources(true));if(fault!=='missingMemo')await f.packetOn(next,memo());
  if(fault==='new80')next.send(refine());
  if(fault==='ordinaryLook'){next.send(lookCommand({type:'look',direction:1,head:1}));await f.packetOn(next,new BitWriter().u8(13).i32(ownId).i16(100).i16(100).u8(1).u8(1).finish());}
  if(fault==='obsolete80'){f.socket.send(refine());f.socket.readyState=3;f.socket.dispatchEvent(new Event('close'));}
  if(fault==='inventoryChanged')await f.packetOn(next,new BitWriter().u8(50).bool(false).i32(717).i16(1).i32(0).bool(false).finish());
  if(fault==='spChanged')await f.packetOn(next,new BitWriter().u8(39).i32(199).i32(200).finish());
  if(fault==='zenyChanged')await f.packetOn(next,new BitWriter().u8(40).i32(9999).finish());
  if(fault==='secondFull')await f.packetOn(next,skillResources(true));
  if(fault!=='missingReady'&&fault!=='readyBeforeFull')next.send(Uint8Array.of(2));
  if(fault==='duplicateReady')next.send(Uint8Array.of(2));
  await f.packetOn(next,spawn({...player,id:ownId,hp:fault==='hp0'?0:100,name:fault==='foreign'?'Another':'Test'},fault==='entry0'?0:fault==='entry2'?2:1));
  f.page.__RAYRAG__!.control('heartbeat');await f.step(2500);
  expect(f.c.snapshot().refine.blocked).toBe(true);expect(f.c.warp.blocked).toBe(true);expect(f.c.runRequested).toBe(false);
  expect(f.c.officialRefineResourceRevision()).toBeNull();
  expect(f.c.snapshot().warp.activation).toBeNull();expect(f.c.snapshot().warp.preview).toBeNull();
  // Renewed resources/readiness cannot repair that first initialization certificate.
  await f.packetOn(next,skillResources(true));await f.packetOn(next,memo());next.send(Uint8Array.of(2));await f.packetOn(next,spawn({...player,id:ownId},1));
  expect(f.c.snapshot().refine.blocked).toBe(true);expect(f.c.warp.blocked).toBe(true);
 });
 it.each([0,1].flatMap(ownId=>(['cast','walk'] as const).map(physical=>({ownId,physical}))))('own$ownId certified resources cannot bypass $physical physical ownership',async({ownId,physical})=>{
  const f=await held(ownId,'bothOfficial'),next=await enter(f,ownId);
  await f.packetOn(next,skillResources(true));await f.packetOn(next,memo());
  await f.packetOn(next,new BitWriter().u8(77).u8(0).i32(3).bool(true).finish());
  next.send(Uint8Array.of(2));await f.packetOn(next,spawn({...player,id:ownId},1));
  expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
  if(physical==='cast')await f.packetOn(next,new BitWriter().u8(FEATURE_OP.castStart).i32(ownId).i32(ownId).u8(42).u8(1).u8(0).i16(100).i16(100).f32(10).u8(0).finish());
  else await f.packetOn(next,new BitWriter().u8(7).i32(ownId).i16(100).i16(100).f32(100).f32(100).f32(.1).f32(.1).u8(2).u8(0x60).u8(0).finish());
  await f.packetOn(next,new BitWriter().u8(77).u8(3).finish());
  if(physical==='cast')expect(f.c.engine.observedOwnCastSettled()).toBe(false);
  else expect(f.c.engine.idleForActions()).toBe(false);
  expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);expect(f.c.runRequested).toBe(false);
  expect(next.writes.map(data=>(data as Uint8Array)[0])).toEqual([3,2]);
 });
 it.each([0,1])('own%s unavailable heartbeat cannot consume the certified reset before readiness',async ownId=>{
  const f=await held(ownId,'bothOfficial'),next=await enter(f,ownId);
  await f.packetOn(next,skillResources(true));await f.packetOn(next,memo());next.send(Uint8Array.of(2));
  f.c.heartbeat(false);await f.packetOn(next,spawn({...player,id:ownId},1));
  expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
  f.page.__RAYRAG__!.control('heartbeat');for(let i=0;i<12;i++)await Promise.resolve();
  expect(f.c.warp.blocked).toBe(false);expect(f.c.snapshot().refine.blocked).toBe(false);expect(f.c.runRequested).toBe(false);
  expect(next.writes.map(data=>(data as Uint8Array)[0])).toEqual([3,2]);
 });
 it.each([0,1].flatMap(ownId=>(['benign','spChanged','new80','oldOpen','socketSwitch','stop','heartbeat','maintenance','lateSp','lateFull','lateMap','lateReady'] as const).map(edge=>({ownId,edge}))))('own$ownId $edge revalidates only after a pending current-socket decode',async({ownId,edge})=>{
  const f=await held(ownId,'bothManual',false),next=await enter(f,ownId,edge!=='oldOpen'),counters=[f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted];
  await f.packetOn(next,skillResources(true));await f.packetOn(next,memo());next.send(Uint8Array.of(2));await f.packetOn(next,spawn({...player,id:ownId},1));
  expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
  const frame=edge==='spChanged'?new BitWriter().u8(39).i32(199).i32(200).finish():new BitWriter().u8(OP.stop).i32(ownId).finish();
  let release!:(data:ArrayBuffer)=>void;const pending=new Promise<ArrayBuffer>(resolve=>{release=resolve;});
  const blob=new Blob([Uint8Array.from(frame).buffer]);vi.spyOn(blob,'arrayBuffer').mockReturnValue(pending);
  next.dispatchEvent(Object.assign(new Event('message'),{data:blob}));await Promise.resolve();
  f.page.__RAYRAG__!.control('heartbeat');
  if(edge==='new80')next.send(refine());
  if(edge==='socketSwitch'){next.readyState=3;next.dispatchEvent(new Event('close'));const newer=new f.page.WebSocket(SOCKET_URL);newer.dispatchEvent(new Event('open'));}
  if(edge==='stop')f.c.stop();
  if(edge==='heartbeat')f.c.heartbeat(false);
  const nonce='c'.repeat(32);if(edge==='maintenance')f.page.__RAYRAG__!.maintenance(nonce,true);
  await f.step(2500);
  // The grace period has elapsed, but the already queued decode still owns the
  // observation order. The retry cannot use its predecessor's resource tuple.
  expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
  expect(f.invoke.mock.calls.some(call=>call[0]==='update_ack')).toBe(false);
  // These arrivals append behind the already queued retry while Blob decoding
  // still waits. Both that retry and the earlier receive-local attempt must
  // yield to the newer observation before considering the certificate.
  const late=edge==='lateSp'?new BitWriter().u8(39).i32(199).i32(200).finish()
   :edge==='lateFull'?skillResources(true):edge==='lateMap'?new BitWriter().u8(OP.map).string('prontera').finish():null;
  if(late)next.dispatchEvent(Object.assign(new Event('message'),{data:Uint8Array.from(late).buffer}));
  if(edge==='lateReady')next.send(Uint8Array.of(2));
  release(Uint8Array.from(frame).buffer);for(let i=0;i<20;i++)await Promise.resolve();await f.step(100);
  if(edge==='heartbeat'){
   expect(f.c.warp.blocked).toBe(true);expect(f.c.snapshot().refine.blocked).toBe(true);
   f.page.__RAYRAG__!.control('heartbeat');for(let i=0;i<12;i++)await Promise.resolve();
  }
  const invalid=['spChanged','new80','oldOpen','socketSwitch','lateSp','lateFull','lateMap','lateReady'].includes(edge);
  expect(f.c.warp.blocked).toBe(invalid);expect(f.c.snapshot().refine.blocked).toBe(invalid);expect(f.c.runRequested).toBe(false);
  expect(f.c.snapshot().warp.activation).toBeNull();expect(f.c.snapshot().warp.preview).toBeNull();
  expect([f.c.engine.deaths,f.c.engine.kills,f.c.engine.looted]).toEqual(counters);
  expect(next.writes.map(data=>(data as Uint8Array)[0])).toEqual(edge==='new80'?[3,2,80]:edge==='lateReady'?[3,2,2]:[3,2]);
  if(edge==='maintenance'){
   f.page.__RAYRAG__!.maintenance(nonce,true);for(let i=0;i<15;i++)await Promise.resolve();
   expect(f.invoke.mock.calls.some(call=>call[0]==='update_ack')).toBe(true);
   const reconcile=vi.spyOn(f.c,'reconcileOfficialInitialization');await f.step(1000);expect(reconcile).not.toHaveBeenCalled();
   expect(next.writes.map(data=>(data as Uint8Array)[0])).toEqual([3,2]);
   f.page.__RAYRAG__!.maintenance(nonce,false);
  }
 });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CompanionController } from './controller';
import { BitWriter } from './binary';
import { GAME_URL, OP, SOCKET_URL, VERIFIED_BUILD, walkCommand, command, type Entity } from './protocol';
import { FEATURE_OP, featureCommand } from './protocol-feature';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import type { Settings } from './settings';
import { worldCommand } from './world-protocol';
import { memoCommand } from './memo-protocol';
import { socketCommand } from './socket-protocol';
import { socialCommand } from './social-protocol';

const captured=vi.hoisted(()=>({controller:null as CompanionController|null,senders:[] as Array<(...args:never[])=>void>}));
vi.mock('./controller',async original=>{
  const actual=await original<typeof import('./controller')>();
  return {...actual,CompanionController:class extends actual.CompanionController {
    constructor(...args:ConstructorParameters<typeof actual.CompanionController>){
      super(args[0],args[1],()=>({width:200,height:200,walkable:()=>true}),args[3],args[4],args[5]);
      captured.controller=this;captured.senders=[args[0],args[3]!,args[4]!,args[5]!] as typeof captured.senders;
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
type Page={WebSocket:typeof NativeSocket;buildUrl:string;__RAYRAG__?:{control:(action:'start',settings:Settings)=>void;maintenance:(nonce:string,reserve:boolean|'commit')=>void}};
async function fixture(ready=true){
  const invoke=vi.fn(async(name:string)=>name==='update_ack'||name==='update_lease_alive'?true:undefined);
  const page:Page & Pick<Window,'addEventListener'> & {__TAURI_INTERNALS__:{invoke:typeof invoke}}={WebSocket:NativeSocket,buildUrl:VERIFIED_BUILD,addEventListener:()=>{},__TAURI_INTERNALS__:{invoke}},listeners=new Map<string,EventListener>();
  vi.stubGlobal('window',page);vi.stubGlobal('location',{origin:new URL(GAME_URL).origin,pathname:'/'});
  vi.stubGlobal('document',{addEventListener:(type:string,listener:EventListener)=>listeners.set(type,listener)});
  vi.resetModules();await import('./bridge');
  const socket=new page.WebSocket(SOCKET_URL);socket.dispatchEvent(new Event('open'));
  const c=captured.controller!;
  const packetOn=async(current:NativeSocket,data:Uint8Array)=>{
    current.dispatchEvent(Object.assign(new Event('message'),{data:Uint8Array.from(data).buffer}));
    for(let i=0;i<12;i++)await Promise.resolve();
  };
  const packet=(data:Uint8Array)=>packetOn(socket,data);
  if(ready){await packet(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await packet(spawn(player));await packet(spawn(monster));}
  const input=(type='keydown',trusted=true)=>listeners.get(type)!({isTrusted:trusted} as Event);
  return {page,socket,c,packet,packetOn,input,invoke,start:(settings:Settings)=>page.__RAYRAG__!.control('start',settings),step:async(ms:number)=>vi.advanceTimersByTimeAsync(ms)};
}
beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(100_000);});
afterEach(()=>{vi.useRealTimers();vi.unstubAllGlobals();vi.restoreAllMocks();captured.controller=null;captured.senders=[];});

describe('official page input and socket boundary',()=>{
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
    socketCommand({type:'socket',targetBagId:20001,cardBagId:4002})])('takes over before forwarding the same official gameplay frame once',async source=>{
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
    const [field,social,memo,socket]=captured.senders;
    Reflect.apply(field!,null,[{type:'attack',id:2}]);Reflect.apply(social!,null,[{type:'emote',id:1}]);
    Reflect.apply(memo!,null,[0]);Reflect.apply(socket!,null,[{type:'socket',targetBagId:20001,cardBagId:4002}]);
    f.input('keydown',false);expect(input).not.toHaveBeenCalled();expect(takeover).not.toHaveBeenCalled();expect(f.socket.writes).toHaveLength(4);
  });
  it('does not prevent or repeat the official send when the takeover hook throws',async()=>{
    const f=await fixture();vi.spyOn(f.c,'manualCommand').mockImplementation(()=>{throw new Error('synthetic hook failure');});
    const frame=command('attack',2);expect(()=>f.socket.send(frame)).not.toThrow();expect(f.socket.writes).toEqual([frame]);
  });
});

describe('update dispatch freeze',()=>{
  it('gates every official payload and all four prototype transports before forwarding, with no replay after release',async()=>{
    const f=await fixture();vi.spyOn(f.c,'settledForMaintenance').mockReturnValue(true);
    const nonce='a'.repeat(32);f.page.__RAYRAG__!.maintenance(nonce,true);
    for(let i=0;i<15;i++)await Promise.resolve();expect(f.invoke.mock.calls.some(c=>c[0]==='update_ack')).toBe(true);
    for(const packet of [command('attack',2),new Uint8Array([2]),'opaque',new Blob(['opaque'])])f.socket.send(packet);
    for(const [sender,args]of captured.senders.map((sender,i)=>[sender,[[{type:'attack',id:2}],[{type:'emote',id:1}],[0],[{type:'socket',targetBagId:20001,cardBagId:4002}]][i]!] as const))expect(()=>Reflect.apply(sender,null,args)).toThrow('Client update');
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

function initializedResources():Uint8Array {
 const f=new BitWriter().u8(FEATURE_OP.stats);
 for(const value of [15,7,500,3,4,5,6,7,8,0,0,123])f.i32(value);
 for(const value of [100,100,200,200,...Array(16).fill(1),2000])f.i32(value);
 f.f32(.5).i32(0).i32(0).bool(true).i16(0).i16(0).bool(true).u8(0).u8(0);
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

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
function spawn(e:Entity):Uint8Array {
  const name=new TextEncoder().encode(e.name);
  const body=new BitWriter().u8(15).i32(e.id).i32(e.classId).i32(0).i32(~name.length).i32(e.name.length).take(name)
    .u8(e.kind).u8(0).u8(0).i32(e.x).i32(e.y).u8(e.level).i32(e.hp).i32(e.maxHp).i32(e.sp??0).i32(e.maxSp??0).i32(0).u8(0).finish();
  return new BitWriter().u8(OP.spawn).u8(0).i32(body.length).take(body).finish();
}
type Page={WebSocket:typeof NativeSocket;buildUrl:string;__RAYRAG__?:{control:(action:'start',settings:Settings)=>void}};
async function fixture(ready=true){
  const page:Page & Pick<Window,'addEventListener'>={WebSocket:NativeSocket,buildUrl:VERIFIED_BUILD,addEventListener:()=>{}},listeners=new Map<string,EventListener>();
  vi.stubGlobal('window',page);vi.stubGlobal('location',{origin:new URL(GAME_URL).origin,pathname:'/'});
  vi.stubGlobal('document',{addEventListener:(type:string,listener:EventListener)=>listeners.set(type,listener)});
  vi.resetModules();await import('./bridge');
  const socket=new page.WebSocket(SOCKET_URL);socket.dispatchEvent(new Event('open'));
  const c=captured.controller!;
  const packet=async(data:Uint8Array)=>{
    socket.dispatchEvent(Object.assign(new Event('message'),{data:Uint8Array.from(data).buffer}));
    for(let i=0;i<12;i++)await Promise.resolve();
  };
  if(ready){await packet(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());await packet(spawn(player));await packet(spawn(monster));}
  const input=(type='keydown',trusted=true)=>listeners.get(type)!({isTrusted:trusted} as Event);
  return {page,socket,c,packet,input,start:(settings:Settings)=>page.__RAYRAG__!.control('start',settings),step:async(ms:number)=>vi.advanceTimersByTimeAsync(ms)};
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

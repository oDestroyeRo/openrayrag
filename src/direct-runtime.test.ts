import { describe,it,expect,vi } from 'vitest';
import { DirectRuntime, type DirectEvent } from './direct-runtime';
import { BitWriter } from './binary';
import { OP, type Entity } from './protocol';
import { DEFAULT_SETTINGS } from './settings';

const player:Entity={id:0,classId:6,name:'Synthetic',kind:0,level:15,hp:100,maxHp:100,sp:200,maxSp:200,x:100,y:100,dead:false,statuses:[]};
function spawn(e=player,entryType=1){
 const name=new TextEncoder().encode(e.name);
 const body=new BitWriter().u8(15).i32(e.id).i32(e.classId).i32(0).i32(~name.length).i32(e.name.length).take(name).u8(e.kind).u8(0).u8(0).i32(e.x).i32(e.y).u8(e.level).i32(e.hp).i32(e.maxHp).i32(e.sp??0).i32(e.maxSp??0).i32(0).u8(0).finish();
 return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
function resources(full=true){
 const f=new BitWriter().u8(56);for(const v of [15,15,10000,1,1,1,1,1,1,0,0,0])f.i32(v);
 for(const v of [100,100,200,200,...Array(16).fill(1),2000])f.i32(v);f.f32(.5).i32(100).i32(0);
 if(!full)return f.bool(false).bool(false).finish();
 f.bool(true).i16(1).i16(55).u8(4).i16(0).bool(true).u8(1).i32(1).i32(717).i16(3).i32(0).u8(0);
 for(let i=0;i<10;i++)f.i32(0);return f.i32(-1).finish();
}
const memo=()=>new BitWriter().u8(94).u8(1).string('prontera').i16(100).i16(100).u8(0).u8(0).u8(0).finish();
const enter=(actor=0)=>new BitWriter().u8(OP.enter).i32(actor).string('prt_fild08').finish();
const selected=()=>new BitWriter().u8(3).bool(false).string('Synthetic').finish();
function fixture(held=false){
 let now=100000;let marker=held;let events:DirectEvent[]=[];
 const invoke=vi.fn(async(name:string,_args:unknown):Promise<unknown>=>name==='direct_poll'?{events:events.splice(0,16),delivery:1}:name==='update_ack'||name==='update_lease_alive'?true:undefined);
 const runtime=new DirectRuntime({invoke,now:()=>now,store:{read:()=>marker,write:value=>{marker=value;}}},'11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222');
 const frame=(packet:Uint8Array)=>runtime.receive([{kind:'frame',bytes:[...packet]}]);
 const open=()=>runtime.receive([{kind:'opened'},{kind:'enterSent',bytes:[...selected()]}]);
 const ready=async(actor=0)=>{await open();await frame(enter(actor));await frame(resources());await frame(memo());await runtime.receive([{kind:'readySent'}]);await frame(spawn({...player,id:actor}));};
 return{runtime,invoke,frame,open,ready,setEvents:(value:DirectEvent[])=>{events=value;},step:(ms:number)=>{now+=ms;},marker:()=>marker,writes:()=>invoke.mock.calls.filter(([name])=>name==='direct_send').map(([,args])=>(args as {bytes:number[]}).bytes)};
}
async function flush(){for(let i=0;i<20;i++)await Promise.resolve();}
describe('clientless shared-controller runtime',()=>{
 it.each([0,1])('processes real first full resources + memo before Ready, own entry actor %s before guard reset',async actor=>{
  const f=fixture(true);await f.open();await f.frame(enter(actor));expect(f.writes()).toEqual([]);
  await f.frame(resources());expect(f.writes()).toEqual([]);expect(f.marker()).toBe(true);
  await f.frame(memo());await f.runtime.receive([{kind:'readySent'}]);expect(f.writes()).toEqual([[2]]);expect(f.marker()).toBe(true);
  await f.frame(spawn({...player,id:actor}));f.step(1200);await f.runtime.cycle();
  expect(f.runtime.snapshot().player?.id).toBe(actor);expect(f.marker()).toBe(false);expect(f.writes()).toEqual([[2]]);
  await f.frame(new BitWriter().u8(OP.map).string('prontera').finish());expect(f.writes()).toEqual([[2],[2]]);
  await f.frame(new BitWriter().u8(OP.clear).finish());expect(f.writes()).toHaveLength(2);
 });
 it.each(['partial','missingMemo','wrongEntry','replacedActor','changedResources'])('retains uncertainty for %s; no timer grants missing proof',async fault=>{
  const f=fixture(true);await f.open();await f.frame(enter());await f.frame(resources(fault!=='partial'));
  if(fault!=='missingMemo'){await f.frame(memo());if(fault!=='partial')await f.runtime.receive([{kind:'readySent'}]);}
  if(fault==='changedResources')await f.frame(resources());
  await f.frame(spawn({...player,id:fault==='replacedActor'?1:0},fault==='wrongEntry'?0:1));f.step(5000);await f.runtime.cycle();
  expect(f.marker()).toBe(true);if(fault==='partial'||fault==='missingMemo')expect(f.writes()).toEqual([]);
 });
 it('ignores fresh approval as settlement and keeps authentication out of the runtime API',async()=>{
  const f=fixture(true);await f.runtime.connect();expect(f.invoke).toHaveBeenCalledWith('direct_connect',{sessionId:f.runtime.sessionId,connectionId:f.runtime.connectionId});
  await f.open();expect(f.runtime.snapshot().player).toBeNull();expect(f.marker()).toBe(true);expect(f.writes()).toEqual([]);
  await f.frame(new Uint8Array([3]));expect(f.runtime.snapshot().connected).toBe(false);expect(f.marker()).toBe(true);
 });
 it('Stop retains in-world connection for receipts; write failures remain unresolved and never confirm an action',async()=>{
  const f=fixture();await f.ready();f.runtime.control('stop',DEFAULT_SETTINGS);await flush();expect(f.runtime.snapshot().connected).toBe(true);expect(f.runtime.snapshot().runRequested).toBe(false);
  f.invoke.mockImplementation(async name=>{if(name==='direct_send')throw Error('synthetic write failure');return undefined;});
  f.runtime.perform('command',{type:'skill',mode:'self',skillId:55,level:1});await flush();
  // Rejection or transport failure cannot manufacture a confirmed action receipt.
  expect(f.runtime.snapshot().actionResult?.status).not.toBe('confirmed');
 });
 it('freeze gates dispatch, reads frames while held, invalidates final ACK and settles native deliveries after apply',async()=>{
  const f=fixture();await f.ready();f.step(1200);await f.runtime.cycle();f.runtime.maintenance('a'.repeat(32),true);await flush();
  expect(f.invoke.mock.calls.some(([n])=>n==='update_ack')).toBe(true);
  expect(()=>f.runtime.control('heartbeat',DEFAULT_SETTINGS)).toThrow(/update/);
  f.setEvents([{kind:'frame',bytes:[...new BitWriter().u8(OP.stop).i32(0).finish()]}]);await f.runtime.cycle();
  expect(f.invoke.mock.calls.some(([n])=>n==='update_invalidate')).toBe(true);expect(f.invoke.mock.calls.some(([n])=>n==='direct_observed')).toBe(true);
  f.runtime.maintenance('a'.repeat(32),'commit');await flush();expect(f.invoke.mock.calls.filter(([n])=>n==='update_final_ack')).toEqual([]);
 });
 it('pending poll application or actual send completion blocks update ACK',async()=>{
  const f=fixture();await f.ready();f.step(1200);await f.runtime.cycle();let release!:(value:unknown)=>void;
  f.invoke.mockImplementation(name=>name==='direct_poll'?new Promise(resolve=>{release=resolve;}):Promise.resolve(undefined));
  const pending=f.runtime.cycle();f.runtime.maintenance('b'.repeat(32),true);await flush();expect(f.invoke.mock.calls.some(([n])=>n==='update_ack')).toBe(false);
  release({events:[],delivery:null});await pending;
  f.invoke.mockImplementation(name=>name==='direct_send'?new Promise(resolve=>{release=resolve;}):Promise.resolve(undefined));
  f.runtime.perform('command',{type:'sit',sitting:true});f.runtime.maintenance('b'.repeat(32),true);await flush();expect(f.invoke.mock.calls.some(([n])=>n==='update_ack')).toBe(false);release(undefined);await flush();
 });
 it('an own spawn queued before the native Ready flush never supplies the initialization certificate',async()=>{
  const f=fixture(true);await f.open();await f.frame(enter());await f.frame(resources());await f.frame(memo());
  await f.frame(spawn());await f.runtime.receive([{kind:'readySent'}]);f.step(5000);await f.runtime.cycle();expect(f.marker()).toBe(true);
 });
 it('terminal events publish disconnected truth, and later stale frames cannot replace the character',async()=>{
  const f=fixture();await f.ready();await f.runtime.receive([{kind:'closed',reason:'synthetic disconnected'}]);await f.frame(spawn({...player,id:1}));
  expect(f.runtime.snapshot().connected).toBe(false);expect(f.runtime.snapshot().player).toBeNull();
  expect(f.invoke.mock.calls.some(([n,args])=>n==='bridge_status'&&(args as {status:{connected:boolean}}).status.connected===false)).toBe(true);
 });
});

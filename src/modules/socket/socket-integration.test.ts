import {describe,expect,it,vi} from 'vitest';
import {BitWriter} from '../../shared/binary';
import {CompanionController} from '../runtime/controller';
import {OP,type Entity} from '../protocol/protocol';
import {FEATURE_OP} from '../protocol/protocol-feature';
import {DEFAULT_AUTOMATION} from '../settings/settings';
import {memoPreview} from '../memo/memo';
import type {MemoSlot,MemoSlots} from '../memo/memo-protocol';
import type {SocketAction} from './socket-protocol';
import {DEFAULT_MAP_POLICY} from '../navigation/map-policy';

const map='prt_fild08',guid='00112233445566778899aabbccddeeff';
const own:Entity={id:0,classId:0,name:'Synthetic',kind:0,level:7,hp:100,maxHp:100,sp:200,maxSp:200,x:10,y:10,dead:false,statuses:[]};
const empty:MemoSlots=[null,null,null,null];
function spawn(entity:Entity):Uint8Array {
 const name=new TextEncoder().encode(entity.name);
 const body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0).i32(~name.length).i32(entity.name.length).take(name)
  .u8(entity.kind).u8(0).u8(entity.dead?3:0).i32(entity.x).i32(entity.y).u8(entity.level).i32(entity.hp).i32(entity.maxHp)
  .i32(entity.sp??0).i32(entity.maxSp??0).i32(0).u8(0).finish();
 return new BitWriter().u8(OP.spawn).u8(0).i32(body.length).take(body).finish();
}
function item(w:BitWriter,slots=[4002,0,0,0]):BitWriter {
 w.i32(1102).i16(1).u8(0).u8(4);for(const byte of guid.match(/../g)!)w.u8(parseInt(byte,16));for(const slot of slots)w.i32(slot);return w;
}
function initialization(consumed=false):BitWriter {
 const w=new BitWriter().u8(FEATURE_OP.stats);
 for(const value of [7,1,50,1,1,1,1,1,1,0,0,0])w.i32(value);
 for(const value of [100,100,100,200,...Array(17).fill(0)])w.i32(value);
 w.f32(1).i32(0).i32(0).bool(true).i16(1).i16(55).u8(4).i16(0).bool(true)
  .u8(1).i32(1).i32(4002).i16(consumed?2:3).i32(1).i32(20001);
 item(w,consumed?[4002,4002,0,0]:undefined);w.u8(0);for(let i=0;i<10;i++)w.i32(0);return w.i32(-1);
}
function setup(ready=true) {
 let now=100_000;const actions:unknown[]=[],memos:MemoSlot[]=[],sockets:SocketAction[]=[];
 const c=new CompanionController(action=>actions.push(action),()=>now,()=>({width:40,height:40,walkable:()=>true}),
  ()=>{throw new Error('No social sends in combined tests.');},slot=>memos.push(slot),action=>sockets.push(action));c.connect(true);
 const packet=(w:BitWriter|Uint8Array)=>c.receive(w instanceof BitWriter?w.finish():w);
 const enter=()=>packet(new BitWriter().u8(OP.enter).i32(0).string(map));
 const slots=(values:MemoSlots=empty)=>{const w=new BitWriter().u8(94);for(const loc of values){w.u8(loc?1:0);if(loc)w.string(loc.map).i16(loc.x).i16(loc.y);}packet(w);};
 if(ready){enter();packet(initialization());slots();packet(spawn(own));}
 const socketPreview=()=>{c.perform('socketPreview',{targetBagId:20001,cardBagId:4002,policy:DEFAULT_AUTOMATION});return c.snapshot().socket.preview!;};
 const socketRequest=()=>({...socketPreview(),policy:DEFAULT_AUTOMATION});
 const request=(preview:ReturnType<typeof socketPreview>)=>({targetBagId:preview.targetBagId,cardBagId:preview.cardBagId,previewToken:preview.previewToken,policy:DEFAULT_AUTOMATION});
 return {c,actions,memos,sockets,packet,enter,slots,socketPreview,request,
  socketDispatch:()=>c.perform('socket',request(socketRequest())),memoRequest:()=>memoPreview(c.snapshot().memo,0).request!,
  delta:()=>packet(new BitWriter().u8(50).bool(false).i32(4002).i16(1).i32(0).bool(false)),
  mutation:()=>packet(item(new BitWriter().u8(63).i32(20001),[4002,4002,0,0])),elapse:(ms:number)=>{now+=ms;},step:(ms=100)=>{now+=ms;c.tick();}};
}
describe('memo and socket integration under one controller owner',()=>{
 it('holds memo and socket admission during panel input, then official gameplay cancels pending planning',async()=>{
  vi.useFakeTimers();
  try{
   const s=setup(),memo=s.memoRequest(),socket=s.request(s.socketPreview());
   s.c.travel.start(map,s.c.engine.player!,'payon',10,true,{...DEFAULT_MAP_POLICY,mode:'weighted'});
   expect(s.c.snapshot().travel.state).toBe('planning');expect(s.c.active).toBe(true);expect(vi.getTimerCount()).toBe(1);
   expect(()=>s.c.perform('memo',memo)).toThrow('Stop');expect(()=>s.c.perform('socket',socket)).toThrow();expect(()=>s.socketPreview()).toThrow();
   s.c.manualInput();expect(s.c.snapshot().travel.state).toBe('planning');expect(vi.getTimerCount()).toBe(1);
   s.c.manualCommand();expect(s.c.snapshot().travel.state).toBe('cancelled');expect(vi.getTimerCount()).toBe(0);
   await vi.runAllTimersAsync();expect(s.c.active).toBe(false);expect(s.sockets).toEqual([]);expect(s.memos).toEqual([]);
   expect(s.actions.every(action=>(action as {type:string}).type==='stop')).toBe(true);
  }finally{vi.useRealTimers();}
 });
 it('keeps pending and canceled memo ownership until a fresh readback before any socket send',()=>{
  const s=setup();s.c.perform('memo',s.memoRequest());expect(s.memos).toEqual([0]);
  expect(()=>s.socketPreview()).toThrow();s.c.stop();expect(s.c.memo.blocked).toBe(true);expect(()=>s.socketPreview()).toThrow();
  s.slots();expect(s.c.memo.blocked).toBe(false);s.socketDispatch();expect(s.sockets).toHaveLength(1);expect(s.actions).toEqual([]);
 });
 it('keeps pending and uncertain socket ownership against memo until the exact late Stop receipt',()=>{
  const s=setup(),memo=s.memoRequest();s.socketDispatch();expect(()=>s.c.perform('memo',memo)).toThrow();
  expect(s.c.snapshot().memo.ready).toBeNull();s.c.stop();expect(()=>s.c.perform('memo',memo)).toThrow();
  s.delta();s.mutation();expect(s.c.snapshot().socket.state).toBe('confirmed');expect(s.c.runRequested).toBe(false);
  s.c.perform('memo',s.memoRequest());expect(s.memos).toEqual([0]);expect(s.sockets).toHaveLength(1);
 });
 it('retires both idle previews immediately on trusted official input without sending anything',()=>{
  const s=setup(),socket=s.request(s.socketPreview()),memo=s.memoRequest();expect(s.c.active).toBe(false);s.c.manualInput();
  expect(s.c.snapshot().socket.preview).toBeNull();expect(()=>s.c.perform('socket',socket)).toThrow('stale');
  expect(()=>s.c.perform('memo',memo)).toThrow('stale');expect(s.actions).toEqual([]);expect(s.sockets).toEqual([]);expect(s.memos).toEqual([]);
 });
 it('cannot attribute sparse pairs after cancellation plus possible official second socketing; full state reconciles only',()=>{
  const s=setup();s.socketDispatch();s.c.stop();s.c.manualInput();s.delta();s.mutation();
  expect(s.c.snapshot().socket).toMatchObject({state:'uncertain',pending:true});expect(()=>s.c.perform('memo',s.memoRequest())).toThrow();
  s.packet(initialization(true));expect(s.c.snapshot().socket).toMatchObject({state:'reconciled',pending:false});
  expect(s.c.snapshot().socket.reason).toContain('not inferred');expect(s.c.runRequested).toBe(false);expect(s.sockets).toHaveLength(1);expect(s.memos).toEqual([]);
 });
 it('retires an idle token when heartbeat fails even if restored before the next tick',()=>{
  const s=setup(),request=s.request(s.socketPreview());s.c.heartbeat(false);s.c.heartbeat(true);
  expect(s.c.snapshot().socket.preview).toBeNull();expect(()=>s.c.perform('socket',request)).toThrow('stale');expect(s.sockets).toEqual([]);
 });
 it('a stale rejected commit immediately retires its token before a fresh frame can restore admission',()=>{
  const s=setup(),request=s.request(s.socketPreview());s.elapse(15_001);
  expect(()=>s.c.perform('socket',request)).toThrow();s.packet(new BitWriter().u8(OP.stop).i32(0));
  expect(s.c.snapshot().socket.preview).toBeNull();expect(()=>s.c.perform('socket',request)).toThrow('stale');expect(s.sockets).toEqual([]);
 });
 it('requires announced own readiness, preserves actor zero at the cap and rechecks castStop/current policy',()=>{
  const s=setup(false);s.packet(spawn(own));s.packet(initialization());expect(s.c.engine.playerId).toBeNull();expect(()=>s.socketPreview()).toThrow();
  s.enter();s.packet(initialization());s.slots();expect(s.c.engine.actorActionIdentity()).toBeNull();expect(()=>s.socketPreview()).toThrow();s.packet(spawn(own));
  for(let id=1;id<=305;id++)s.packet(spawn({...own,id,kind:1,classId:4001,name:'Monster'}));expect(s.c.engine.actorActionIdentity()?.selfId).toBe(0);
  const old=s.request(s.socketPreview());s.packet(new BitWriter().u8(FEATURE_OP.castStart).i32(0).i32(-1).u8(11).u8(1).u8(0).position(own).f32(5).u8(0));
  expect(s.c.snapshot().socket.preview).toBeNull();expect(()=>s.c.perform('socket',old)).toThrow();s.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(0));
  const preview=s.socketPreview(),policy=structuredClone(DEFAULT_AUTOMATION);policy.disposition={maxSpend:0,rules:[{itemId:4002,keep:2,minimum:2,desired:2,maximum:2,store:false,sell:false,cart:false,restock:'off',allowUnique:false}]};
  expect(()=>s.c.perform('socket',{...s.request(preview),policy})).toThrow('stale');expect(()=>s.c.perform('socket',s.request(preview))).toThrow('stale');
  s.socketDispatch();expect(s.sockets).toHaveLength(1);expect(s.memos).toEqual([]);
 });
 it('stages reconnect initialization for the announced lifetime and drains only after the original own character arrives',()=>{
  const s=setup();s.socketDispatch();s.c.manualInput();s.c.disconnect();s.c.connect(true);s.enter();s.packet(initialization(true));
  expect(s.c.socket.busy).toBe(true);s.packet(spawn({...own,name:'Other'}));s.step();expect(s.c.socket.busy).toBe(true);
  s.packet(spawn(own));s.step();expect(s.c.socket.busy).toBe(true);s.packet(initialization(true));
  expect(s.c.snapshot().socket.state).toBe('reconciled');expect(s.c.runRequested).toBe(false);expect(s.sockets).toHaveLength(1);
 });
 it('requires a fresh full readback in the same initial lifetime after sparse changes before readiness',()=>{
  const s=setup();s.socketDispatch();s.c.manualInput();s.c.disconnect();s.c.connect(true);s.enter();s.packet(initialization());s.delta();
  s.packet(spawn(own));s.step();expect(s.c.socket.busy).toBe(true);s.packet(initialization(true));
  expect(s.c.snapshot().socket.state).toBe('reconciled');expect(s.sockets).toHaveLength(1);expect(s.memos).toEqual([]);
 });
});

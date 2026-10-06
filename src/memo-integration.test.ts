import { skillId as domainSkillId } from './domain-values';
import {describe,expect,it} from 'vitest';
import {BitWriter} from './binary';
import {CompanionController} from './controller';
import {OP,type Entity} from './protocol';
import {FEATURE_OP} from './protocol-feature';
import {DEFAULT_SETTINGS,DEFAULT_AUTOMATION,type Settings} from './settings';
import {DEFAULT_MAP_POLICY} from './map-policy';
import {memoPreview} from './memo';
import type {MemoSlot,MemoSlots} from './memo-protocol';
import type {WalkGrid} from './navigation';
import type {Action} from './engine';
import type {WorldAction} from './world-protocol';

const map='prt_fild08';
const own:Entity={id:0,classId:0,name:'Synthetic',kind:0,level:7,hp:100,maxHp:100,sp:200,maxSp:200,x:10,y:10,dead:false,statuses:[]};
const empty:MemoSlots=[null,null,null,null];
// Source-shaped MemoryPack spawn and full initialization; all data is synthetic.
function spawn(entity:Entity):Uint8Array {
 const name=new TextEncoder().encode(entity.name);
 const body=new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0).i32(~name.length).i32(entity.name.length).take(name)
  .u8(entity.kind).u8(0).u8(entity.dead?3:0).i32(entity.x).i32(entity.y).u8(entity.level).i32(entity.hp).i32(entity.maxHp)
  .i32(entity.sp??0).i32(entity.maxSp??0).i32(0).u8(0).finish();
 return new BitWriter().u8(OP.spawn).u8(0).i32(body.length).take(body).finish();
}
function initialization():BitWriter {
 const w=new BitWriter().u8(FEATURE_OP.stats);
 for(const v of [7,1,50,1,1,1,1,1,1,0,0,0])w.i32(v);
 for(const v of [100,100,100,200,...Array(17).fill(0)])w.i32(v);
 w.f32(1).i32(0).i32(0).bool(true).i16(1).i16(55).u8(4).i16(0).bool(true).u8(0).u8(0);
 for(let i=0;i<10;i++)w.i32(0);
 return w.i32(-1);
}
function walking(id:number,cells:Array<{x:number;y:number}>):BitWriter {
 const directions=[[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
 const w=new BitWriter().u8(OP.walk).i32(id).position(cells[0]!).f32(cells[0]!.x).f32(cells[0]!.y).f32(.1).f32(.1).u8(cells.length);
 for(let i=1;i<cells.length;i+=2){const a=directions.findIndex(([x,y])=>cells[i]!.x-cells[i-1]!.x===x&&cells[i]!.y-cells[i-1]!.y===y);
  const b=i+1<cells.length?directions.findIndex(([x,y])=>cells[i+1]!.x-cells[i]!.x===x&&cells[i+1]!.y-cells[i]!.y===y):0;w.u8(a<<4|b);}
 return w.u8(0);
}
function setup(id=0,ready=true,grid:WalkGrid={width:40,height:40,walkable:()=>true}) {
 let now=100_000;const actions:Array<Action|WorldAction>=[],sent:MemoSlot[]=[];
 const c=new CompanionController(a=>actions.push(a),()=>now,()=>grid,()=>{throw new Error('No social sends in memo tests.');},slot=>sent.push(slot));c.connect(true);
 const packet=(w:BitWriter|Uint8Array,epoch?:number)=>c.receive(w instanceof BitWriter?w.finish():w,epoch);
 const slots=(values:MemoSlots=empty,epoch?:number)=>{const w=new BitWriter().u8(94);for(const loc of values){w.u8(loc?1:0);if(loc)w.string(loc.map).i16(loc.x).i16(loc.y);}packet(w,epoch);};
 const enter=()=>packet(new BitWriter().u8(OP.enter).i32(id).string(map));
 if(ready){enter();packet(initialization());slots();packet(spawn({...own,id}));}
 return {c,actions,sent,packet,slots,enter,preview:(slot:MemoSlot=0)=>memoPreview(c.snapshot().memo,slot).request!,
  ack:(slot:MemoSlot=0)=>packet(new BitWriter().u8(91).u8(8).i32(slot).string('')),step:(ms=100)=>{now+=ms;c.tick();}};
}
describe('memo integration with ready actor identity and field movement',()=>{
 it('keeps pre-Enter actor zero and initialization data-only, then stages full94 until own spawn',()=>{
  const s=setup(0,false);s.packet(spawn(own));s.packet(initialization());s.slots();
  expect(s.c.engine.playerId).toBeNull();expect(s.c.engine.actorActionIdentity()).toBeNull();expect(s.c.engine.character.skillsKnown).toBe(false);
  expect(s.c.snapshot().memo.ready).toBeNull();expect(()=>s.preview()).toThrow();
  s.enter();s.packet(initialization());s.slots();
  expect(s.c.engine.character.learned.get(domainSkillId(55))).toBe(4);expect(s.c.engine.character.inventoryKnown).toBe(true);
  expect(s.c.snapshot().memo.slots).toEqual(empty);expect(s.c.snapshot().memo.ready).toBeNull();
  expect(()=>s.c.perform('command',{type:'sit',sitting:false})).toThrow();expect(()=>s.preview()).toThrow();
  s.packet(spawn(own));const request=s.preview(3);expect(request.preview.actorId).toBe(0);
  expect(request.preview.incarnation).toBe(s.c.engine.actorActionIdentity()?.selfIncarnation);
  s.c.perform('memo',request);expect(()=>s.c.perform('memo',request)).toThrow();s.ack(3);
  s.slots([null,null,null,{map,x:10,y:10}]);expect(s.c.snapshot().memo.state).toBe('confirmed');expect(s.sent).toEqual([3]);expect(s.actions).toEqual([]);
 });
 it('does not use a foreign actor zero as self or reconcile a replaced own lifetime as confirmation',()=>{
  const s=setup(1);s.packet(spawn(own));const request=s.preview();expect(request.preview.actorId).toBe(1);
  s.c.perform('memo',request);s.packet(spawn({...own,id:1}));
  expect(s.c.memo.blocked).toBe(true);expect(s.c.snapshot().memo.slots).toBeNull();expect(()=>s.c.start({...DEFAULT_SETTINGS,map,targets:[4000]})).toThrow();
  s.ack();s.slots([{map,x:10,y:10},null,null,null]);expect(s.c.memo.blocked).toBe(false);
  expect(s.c.snapshot().memo.state).toBe('uncertain');expect(s.sent).toEqual([0]);
 });
 it('retains ready own zero at the 300-actor bound and fences an old world/socket preview',()=>{
  const s=setup();for(let id=1;id<=305;id++)s.packet(spawn({...own,id,kind:1,classId:4001,name:'Monster'}));
  expect(s.c.engine.observations.context(299).incarnation).toBeGreaterThan(0);expect(s.c.engine.observations.context(300).incarnation).toBe(0);
  expect(s.c.engine.actorActionIdentity()?.selfId).toBe(0);
  const old=s.preview(),epoch=s.c.connectionGeneration;s.c.disconnect();s.c.connect(true);s.enter();s.packet(initialization());s.packet(spawn(own));s.slots(empty,epoch);
  expect(s.c.snapshot().memo.slots).toBeNull();s.slots();expect(()=>s.c.perform('memo',old)).toThrow('stale');expect(s.sent).toEqual([]);
 });
 it('uses physical CanMemo/current cell independently of a denied field map and lock rectangle',()=>{
  const s=setup(),automation=structuredClone(DEFAULT_AUTOMATION);
  automation.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),deny:[map],lockArea:{map,minX:20,minY:20,maxX:21,maxY:21}};
  s.c.start({...DEFAULT_SETTINGS,map,targets:[4000],route_randomWalk:0,automation});s.step();
  expect(s.c.engine.running).toBe(false);expect(s.c.snapshot().memo.ready).toBeNull();s.c.stop();
  expect(s.c.snapshot().memo.ready).toMatchObject({map,x:10,y:10});s.c.perform('memo',s.preview());expect(s.sent).toEqual([0]);
 });
 it.each([0,1])('requires an actual canceled field Walk to settle before own %s may save, beyond Stop/time/old receipts',id=>{
  const s=setup(id,true,{width:40,height:40,walkable:p=>p.x!==14||p.y===14}),target=id===0?2:0;
  const mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map,minX:9,minY:9,maxX:20,maxY:20}};
  const settings:Settings={...DEFAULT_SETTINGS,map,targets:[4000],route_randomWalk:0,route_avoidWalls:false,automation:{...structuredClone(DEFAULT_AUTOMATION),mapPolicy}};
  const stale=s.preview();s.packet(spawn({...own,id:target,kind:1,classId:4000,name:'Monster',x:18}));s.c.start(settings);s.step();
  const walk=s.actions.at(-1);expect(walk?.type).toBe('walk');if(walk?.type!=='walk')throw new Error('Expected an explicit field walk.');
  const cells=s.c.engine.snapshot().navigation!.leg;expect(cells.at(-1)).toEqual(walk.destination);s.c.stop();
  s.packet(new BitWriter().u8(OP.attack).i32(id).i32(0).i32(1).position(own));expect(s.c.engine.idleForActions()).toBe(false);
  s.step(4500);expect(s.c.engine.idleForActions()).toBe(true);
  s.packet(new BitWriter().u8(OP.move).i32(id).position(own));s.packet(new BitWriter().u8(OP.attack).i32(id).i32(target).i32(0).position(own));
  expect(s.c.snapshot().memo.ready).toBeNull();expect(()=>s.c.perform('memo',stale)).toThrow();
  s.packet(walking(id,cells));expect(s.c.snapshot().memo.ready).toBeNull();s.step(1000);s.packet(new BitWriter().u8(OP.stop).i32(id));
  expect(s.c.snapshot().memo.ready).toMatchObject(walk.destination);expect(()=>s.c.perform('memo',stale)).toThrow('stale');
  const request=s.preview();s.c.perform('memo',request);s.ack();s.slots([{map,...walk.destination},null,null,null]);
  expect(s.c.snapshot().memo.state).toBe('confirmed');expect(s.sent).toEqual([0]);expect(s.actions.filter(a=>a.type==='walk')).toHaveLength(1);
 });
});

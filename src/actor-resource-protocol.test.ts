import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { decode, OP } from './protocol';
import { CompanionController } from './controller';
import { evaluateActorPredicate } from './actor-observations';
function memoryString(w:BitWriter,value:string|null):void {
  if(value===null){w.i32(-1);return;}const bytes=new TextEncoder().encode(value);w.i32(~bytes.length).i32(value.length).take(bytes);
}
function player(id=2,partyId=5,partyName:string|null='Party',state=0,classId=0,entryType=0):Uint8Array {
  const entity=new BitWriter().u8(15).i32(id).i32(classId).i32(0);memoryString(entity,'Member');
  entity.u8(0).u8(0).u8(state).i32(10).i32(10).u8(10).i32(100).i32(100).i32(0).i32(0).i32(-1).u8(0);
  const body=entity.finish();const appearance=new BitWriter().u8(13).u8(1).i32(7).u8(2).u8(3).u8(4);
  for(const id of [11,12,13,14,15])appearance.i32(id);appearance.i32(partyId);memoryString(appearance,partyName);appearance.i32(64);
  const look=appearance.finish(),packet=new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).i32(look.length).take(look);
  if(state===1)packet.i16(10).i16(10).f32(10).f32(10).f32(0.15).f32(0.15).u8(1).u8(0);
  return packet.finish();
}
function joined(map='prontera',partyName='Party'):Uint8Array {
  return new BitWriter().u8(101).u8(0).i32(5).string(partyName).i32(1).i32(7).i32(2).i16(10).string('Member').u8(0).string(map).i32(100).i32(100).i32(50).i32(100).finish();
}
const health=()=>new BitWriter().u8(102).u8(8).i32(7).i32(80).i32(100).i32(40).i32(100).finish();
describe('pinned resource identity protocol',()=>{
 it.each([0,1])('retains initial stats56 SP through own %i EnterServer arrival with wire 0/0 placeholders',id=>{
  let at=1000;const sent:unknown[]=[];const c=new CompanionController(action=>sent.push(action),()=>at);c.connect(true);
  c.receive(new BitWriter().u8(OP.enter).i32(id).string('prontera').finish());
  const stats=new BitWriter().u8(56);for(const value of [10,1,0,1,1,1,1,1,1,0,0,0])stats.i32(value);
  for(const value of [100,100,50,100,...Array(17).fill(0)])stats.i32(value);stats.f32(1).i32(0).i32(0).bool(false).bool(false);c.receive(stats.finish());
  expect(c.engine.actorActionIdentity()).toBeNull();at++;c.receive(player(id,5,'Party',0,6,1));
  expect(evaluateActorPredicate({field:'actorSpPercent',actor:{scope:'self'},operator:'eq',value:50},c.engine.actorObservation()).state).toBe('matched');
  expect(c.engine.actorObservation().actors.find(actor=>actor.id===id)?.sp).toMatchObject({at:1000,source:'own-stats'});expect(sent).toEqual([]);
 });
 it('decodes the 13-field appearance, null affiliation and walking trailer at exact offsets',()=>{
  expect(decode(player())[0]).toMatchObject({type:'spawn',entity:{partyId:5,partyName:'Party'}});
  expect(decode(player(2,-1,null))[0]).toMatchObject({type:'spawn',entity:{partyId:-1,partyName:''}});
  expect(decode(player(2,5,'Party',1))[1]).toMatchObject({type:'walk',id:2});
  const changed=player();const entitySize=new DataView(changed.buffer).getInt32(2,true);changed[10+entitySize]=14;expect(()=>decode(changed)).toThrow('appearance schema');
  expect(()=>decode(player(2,5,null))).toThrow('affiliation');expect(()=>decode(player().subarray(0,-1))).toThrow();
 });
 it('preserves a leading BOM through MemoryPack, roster and actor affiliation identity',()=>{
  const name='\uFEFFParty';expect(decode(player(2,5,name))[0]).toMatchObject({type:'spawn',entity:{partyName:name}});
  const c=new CompanionController(()=>{},()=>1000);c.connect(true);c.receive(new BitWriter().u8(OP.enter).i32(1).string('prontera').finish());c.receive(player(2,5,name));c.receive(joined('prontera',name));expect(c.world.party?.name).toBe(name);expect(c.world.partyActors.get(7)).not.toBeNull();
  c.receive(new BitWriter().u8(103).i32(2).u8(1).i32(5).string(name).bool(false).finish());expect(c.engine.observations.partyActor(2)?.partyName).toBe(name);expect(c.world.partyActors.get(7)).not.toBeNull();
 });
 it('decodes actor-zero join and leave notifications with a one-bit owner flag',()=>{
  expect(decode(new BitWriter().u8(103).i32(0).u8(1).i32(5).string('Party').bool(true).finish())).toEqual([{type:'partyAffiliation',id:0,partyId:5,partyName:'Party'}]);
  expect(decode(new BitWriter().u8(103).i32(0).u8(0).finish())).toEqual([{type:'partyAffiliation',id:0,partyId:-1,partyName:''}]);
  for(const packet of [new BitWriter().u8(103).i32(2).u8(2).finish(),new BitWriter().u8(103).i32(2).u8(1).i32(-1).string('Party').bool(false).finish()])expect(()=>decode(packet)).toThrow();
 });
 it('wires raw party resources to visible observation lifetimes without issuing any action',()=>{
  let at=1000;const sent:unknown[]=[];const c=new CompanionController(action=>sent.push(action),()=>at);c.connect(true);
  c.receive(new BitWriter().u8(OP.enter).i32(1).string('prontera').finish());c.receive(player());c.receive(joined());
  const trace=(value=50)=>evaluateActorPredicate({field:'actorSpPercent',actor:{scope:'actor',id:2,world:c.engine.observations.context().world,incarnation:c.engine.observations.context(2).incarnation!},operator:'eq',value},c.engine.observations.snapshot(1,2,true));
  expect(trace().state).toBe('matched');at+=100;c.receive(health());expect(trace(40).state).toBe('matched');
  c.receive(player());c.receive(health());expect(trace(40).state).toBe('unavailable');c.receive(joined());expect(trace().state).toBe('matched');
  c.receive(new BitWriter().u8(103).i32(2).u8(0).finish());expect(trace().state).toBe('unavailable');expect(sent).toEqual([]);
 });
 it('keeps cross-map resource packets and map-only rows unable to establish binding',()=>{
  const c=new CompanionController(()=>{},()=>1000);c.connect(true);c.receive(new BitWriter().u8(OP.enter).i32(1).string('prontera').finish());c.receive(player());c.receive(joined('geffen'));c.receive(health());
  c.receive(new BitWriter().u8(102).u8(9).i32(7).string('prontera').finish());c.receive(health());expect(c.world.partyActors.get(7)).toBeNull();expect(c.engine.observations.snapshot(1,2,true).actors[0]?.sp).toBeUndefined();
 });
 it('does not create or settle action ownership when party resources update during maintenance checks',()=>{
  let at=1000;const sent:unknown[]=[];const c=new CompanionController(action=>sent.push(action),()=>at);c.connect(true);
  c.receive(new BitWriter().u8(OP.enter).i32(1).string('prontera').finish());c.receive(player(1,5,'Party',0,6));c.receive(player());c.receive(joined());
  expect(c.settledForMaintenance()).toBe(true);c.receive(health());expect(c.settledForMaintenance()).toBe(true);expect(sent).toEqual([]);
  c.perform('command',{type:'sit',sitting:true});expect(c.settledForMaintenance()).toBe(false);
  c.receive(health());expect(sent).toEqual([{type:'sit',sitting:true}]);at+=20_000;c.receive(health());
  expect(c.settledForMaintenance()).toBe(false);expect(sent).toEqual([{type:'sit',sitting:true},{type:'stop'}]);
 });
});

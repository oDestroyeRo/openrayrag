import { describe, expect, it } from 'vitest';
import { decode, featureCommand, FeatureProtocolError, OP, validateExpandedAction } from './protocol';
import { BitReader } from './binary';
import { readInventory, readItem } from './protocol-feature';

// Independent fixture builder: scalar bytes are produced with DataView, then
// expanded to a bit array following the pinned Lidgren bool/write contracts.
class Fixture {
  readonly bits: number[] = [];
  raw(bytes: Uint8Array): this { for (const byte of bytes) for (let bit=0;bit<8;bit++) this.bits.push((byte >> bit)&1); return this; }
  bool(value: boolean): this { this.bits.push(value?1:0); return this; }
  u8(value: number): this { return this.raw(Uint8Array.of(value)); }
  i16(value: number): this { const bytes=new Uint8Array(2);new DataView(bytes.buffer).setInt16(0,value,true);return this.raw(bytes); }
  i32(value: number): this { const bytes=new Uint8Array(4);new DataView(bytes.buffer).setInt32(0,value,true);return this.raw(bytes); }
  f32(value: number): this { const bytes=new Uint8Array(4);new DataView(bytes.buffer).setFloat32(0,value,true);return this.raw(bytes); }
  position(x=10,y=20): this { return this.i16(x).i16(y); }
  // Pinned OutboundMessage.Clear leaves old bytes in the pooled buffer;
  // NetBitWriter.WriteByte changes written bits while preserving unused bits.
  finish(previousByte=0): Uint8Array {
    const bytes=new Uint8Array(Math.ceil(this.bits.length/8)).fill(previousByte);
    for(let i=0;i<this.bits.length;i++) {
      const mask=1<<(i&7);bytes[i>>3]=(bytes[i>>3]!&~mask)|(this.bits[i]!<<(i&7));
    }
    return bytes;
  }
}
function stats(): Fixture {
  const f=new Fixture().u8(OP.stats);
  for(const value of [9,7,500,3,4,5,6,7,8,2,10,123]) f.i32(value);
  for(const value of [50,100,15,40,...Array(16).fill(1),2000]) f.i32(value);
  return f.f32(.5).i32(125).i32(0);
}
function unique(f:Fixture,itemId=1101,count=1):Fixture {
  f.i32(itemId).i16(count).u8(1).u8(4).raw(Uint8Array.from({length:16},(_,i)=>i));
  for(const slot of [0,4001,-1,0]) f.i32(slot);return f;
}

describe('expanded source-defined feature packets', () => {
  it('parses stats, skills, inventory and equipment atomically across two unaligned flags', () => {
    const f=stats().bool(true).i16(2).i16(1).u8(2).i16(2).u8(1).i16(1).i16(20).u8(5).bool(true);
    f.u8(1).i32(1).i32(501).i16(6).i32(1).i32(10001);unique(f);
    f.u8(1).u8(0);for(let i=0;i<10;i++)f.i32(i===4?10001:0);f.i32(-1);
    const events=decode(f.finish());
    expect(events[0]).toMatchObject({type:'stats',level:9,jobLevel:7,zeny:500,hp:50,maxHp:100,sp:15,maxSp:40,weight:125,maxWeight:2000,attributes:[3,4,5,6,7,8],attackDelay:.5});
    expect(events[1]).toEqual({type:'skills',learned:[{skillId:1,level:2},{skillId:2,level:1}],granted:[{skillId:20,level:5}]});
    expect(events[2]).toMatchObject({type:'inventory',items:[{bagId:501,itemId:501,type:1,count:6},{bagId:10001,itemId:1101,type:2,count:1,flags:1,refine:4,guid:'000102030405060708090a0b0c0d0e0f',slots:[0,4001,-1,0]}],cart:[],equipment:[0,0,0,0,10001,0,0,0,0,0],ammoId:-1});
    expect(()=>decode(f.finish().slice(0,-1))).toThrow(FeatureProtocolError);
  });
  it('does not invent empty skills or inventory when those optional flags are false', () => {
    const events=decode(stats().bool(false).bool(false).finish());
    expect(events).toHaveLength(1);expect(events[0]).toMatchObject({type:'stats',sp:15,maxSp:40});
    expect(decode(stats().finish())).toEqual([{type:'stats',level:9,hp:50,maxHp:100}]);
  });
  it('accepts int.MaxValue currency and HP/SP in full player data', () => {
    // Player.AddZeny explicitly saturates at int.MaxValue in the pinned source.
    const maximum=0x7fffffff;
    expect(decode(new Fixture().u8(OP.currency).i32(maximum).finish())).toEqual([{type:'currency',zeny:maximum}]);
    const packet=stats().bool(false).bool(false).finish();const view=new DataView(packet.buffer);
    view.setInt32(9,maximum,true);
    for(const offset of [49,53,57,61])view.setInt32(offset,maximum,true);
    expect(decode(packet)[0]).toMatchObject({type:'stats',zeny:maximum,hp:maximum,maxHp:maximum,sp:maximum,maxSp:maximum});
    expect(decode(new Fixture().u8(OP.sp).i32(maximum).i32(maximum).finish())).toEqual([{type:'sp',sp:maximum,maxSp:maximum}]);
  });
  it('uses authoritative absolute item count on add and a separate removal count', () => {
    const add=new Fixture().u8(OP.inventoryDelta).bool(true).u8(1).i32(501).i16(2).i32(150).i32(501).i16(8);
    expect(decode(add.finish())).toEqual([{type:'inventoryDelta',add:true,bagId:501,change:2,weight:150,item:{bagId:501,itemId:501,count:8,type:1}}]);
    const remove=new Fixture().u8(OP.inventoryDelta).bool(false).i32(501).i16(3).i32(75).bool(true);
    expect(decode(remove.finish())).toEqual([{type:'inventoryDelta',add:false,bagId:501,change:3,weight:75}]);
    const addUnique=new Fixture().u8(OP.inventoryDelta).bool(true).u8(2).i32(10001).i16(1).i32(500);unique(addUnique);
    expect(decode(addUnique.finish())[0]).toMatchObject({item:{bagId:10001,itemId:1101,type:2,refine:4}});
  });
  it('bounds all collection counts and rejects duplicate bag/skill identities', () => {
    expect(()=>decode(stats().bool(true).i16(513).finish())).toThrow('skill count');
    expect(()=>decode(stats().bool(true).i16(2).i16(2).u8(1).i16(2).u8(2).finish())).toThrow('Duplicate');
    expect(()=>readInventory(new BitReader(new Fixture().u8(1).i32(601).finish()))).toThrow('inventory count');
    expect(()=>readInventory(new BitReader(new Fixture().u8(1).i32(2).i32(501).i16(1).i32(501).i16(1).i32(0).finish()))).toThrow('entry');
    expect(()=>readInventory(new BitReader(new Fixture().u8(1).i32(0).i32(601).finish()))).toThrow('inventory count');
    expect(()=>decode(new Fixture().u8(OP.inventoryDelta).bool(true).u8(0).i32(501).i16(1).i32(0).finish())).toThrow('item type');
    expect(()=>readItem(new BitReader(new Fixture().i32(501).i16(-1).finish()),1)).toThrow('item count');
    expect(readItem(new BitReader(new Fixture().i32(501).i16(1).finish()),1,-1).bagId).toBe(501);
    expect(readItem(new BitReader(unique(new Fixture()).finish()),2,-1).bagId).toBe(-1);
  });
  it('decodes recovery, equipment, status, aggro and economy confirmations', () => {
    expect(decode(Uint8Array.of(OP.sit,1,0,0,0,1))).toEqual([{type:'sit',id:1,sitting:true}]);
    expect(decode(new Fixture().u8(OP.sp).i32(3).i32(20).finish())).toEqual([{type:'sp',sp:3,maxSp:20}]);
    expect(decode(new Fixture().u8(OP.equipment).i32(10001).u8(13).bool(true).finish())).toEqual([{type:'equipment',bagId:10001,slot:13,equipped:true}]);
    expect(decode(new Fixture().u8(OP.status).i32(1).u8(5).f32(30).finish())).toEqual([{type:'status',id:1,statusId:5,seconds:30}]);
    const permanent=3.4028234663852886e38;
    expect(decode(new Fixture().u8(OP.status).i32(1).u8(5).f32(permanent).finish())).toEqual([{type:'status',id:1,statusId:5,seconds:permanent}]);
    expect(()=>decode(new Fixture().u8(OP.status).i32(1).u8(5).f32(Infinity).finish())).toThrow('float');
    expect(decode(new Fixture().u8(OP.removeStatus).i32(1).u8(5).bool(true).finish())).toEqual([{type:'status',id:1,statusId:5,seconds:null,refresh:true}]);
    expect(decode(new Fixture().u8(OP.targeted).i32(25).finish())).toEqual([{type:'targeted',id:25}]);
    expect(decode(new Fixture().u8(OP.experience).i32(100).i32(-10).i32(90).i32(0).finish())).toEqual([{type:'experience',baseTotal:100,baseGained:-10,jobTotal:90,jobGained:0}]);
    expect(decode(new Fixture().u8(OP.currency).i32(1000).finish())).toEqual([{type:'currency',zeny:1000}]);
  });
  it('decodes learned/granted skills and successful self/target/ground casts', () => {
    expect(decode(new Fixture().u8(OP.learnedSkill).u8(2).u8(1).i32(3).finish())).toEqual([{type:'learnedSkill',skillId:2,level:1,points:3}]);
    expect(decode(new Fixture().u8(OP.grantedSkills).i16(1).i16(300).u8(2).finish())).toEqual([{type:'skills',granted:[{skillId:300,level:2}]}]);
    const self=new Fixture().u8(OP.skill).u8(5).i32(1).u8(2).u8(1).u8(0).position().f32(.5).bool(false);
    expect(decode(self.finish())).toEqual([{type:'skillResult',mode:'self',source:1,skillId:2,level:1,position:{x:10,y:20},motionSeconds:.5,indirect:false}]);
    const target=new Fixture().u8(OP.skill).u8(2).i32(1).i32(-1).i32(2).u8(3).u8(5).u8(7).position().i32(-30).u8(2).u8(1).f32(.5).f32(.25).bool(true);
    expect(decode(target.finish())[0]).toMatchObject({type:'skillResult',mode:'target',source:1,target:2,attacker:-1,damage:-30,result:2,hits:1,indirect:true,damageSeconds:.25});
    const ground=new Fixture().u8(OP.skill).u8(4).i32(1).position(11,22).u8(4).u8(3).u8(0).position().f32(.5);
    expect(decode(ground.finish())[0]).toMatchObject({mode:'ground',targetPosition:{x:11,y:22}});
    expect(decode(Uint8Array.of(OP.skillFailure,3))).toEqual([{type:'skillFailure',reason:3}]);
    expect(decode(Uint8Array.of(OP.requestFailure,2))).toEqual([{type:'requestFailure',reason:2}]);
    const impact=new Fixture().u8(OP.skillImpact).i32(1).i32(2).position().i32(30).f32(.25).u8(4).u8(2).u8(0);
    expect(decode(impact.finish())).toEqual([{type:'skillImpact',source:1,target:2,position:{x:10,y:20},damage:30,damageSeconds:.25,skillId:4,hits:2,result:0}]);
    const masked=new Fixture().u8(OP.maskedSkill).i32(1).position(11,22).u8(4).u8(3).u8(0).position().u8(1).f32(.5).bool(false);
    for(let i=0;i<9;i++)masked.bool(i===4);
    expect(decode(masked.finish())[0]).toMatchObject({type:'skillResult',mode:'ground',source:1,indirect:false,targetPosition:{x:11,y:22}});
    expect(()=>decode(masked.finish().slice(0,-1))).toThrow('mask');
  });
  it('accepts pooled-buffer padding after terminal bools and full stats flags', () => {
    for(const sitting of [false,true]) {
      const reused=new Fixture().u8(OP.sit).i32(1).bool(sitting).finish(255);
      expect(reused[reused.length-1]).toBe(sitting?255:254);
      expect(decode(reused)).toEqual([{type:'sit',id:1,sitting}]);
    }
    const flags=stats().bool(false).bool(false);
    const reused=flags.finish(255);expect(reused[reused.length-1]).toBe(252);
    expect(decode(reused)).toEqual(decode(flags.finish()));
  });
  it('accepts elapsed server uptime in Blessing and Sanctuary damage results', () => {
    // SupportSkillResult and Sanctuary leave DamageInfo.Time at zero. The
    // serializer writes Time - server uptime, not a bounded future duration.
    const delay = -86400;
    const support = new Fixture().u8(OP.skill).u8(1).i32(1).i32(-1).i32(2)
      .u8(44).u8(5).u8(0).position().i32(0).u8(7).u8(0).f32(0).f32(delay).bool(false);
    const sanctuary = new Fixture().u8(OP.skillImpact).i32(1).i32(2).position()
      .i32(25).f32(delay).u8(41).u8(1).u8(0);
    expect(decode(support.finish())[0]).toMatchObject({ type: 'skillResult', skillId: 44, damage: 0, result: 7, damageSeconds: delay });
    expect(decode(sanctuary.finish())[0]).toMatchObject({ type: 'skillImpact', skillId: 41, damage: 25, damageSeconds: delay });
  });
  it('still rejects non-finite or excessive future skill delays and motion', () => {
    for (const delay of [NaN, Infinity, -Infinity, 61]) {
      const support = new Fixture().u8(OP.skill).u8(2).i32(1).i32(-1).i32(2)
        .u8(3).u8(5).u8(0).position().i32(-30).u8(2).u8(1).f32(.5).f32(delay).bool(false);
      const impact = new Fixture().u8(OP.skillImpact).i32(1).i32(2).position()
        .i32(-30).f32(delay).u8(4).u8(1).u8(2);
      expect(() => decode(support.finish())).toThrow(FeatureProtocolError);
      expect(() => decode(impact.finish())).toThrow(FeatureProtocolError);
    }
    const motion = new Fixture().u8(OP.skill).u8(5).i32(1).u8(2).u8(1).u8(0).position().f32(-61).bool(false);
    expect(() => decode(motion.finish())).toThrow('Invalid skill timing');
  });
  it('rejects malformed fields and complete trailing bytes without emitting partial state', () => {
    for(const packet of [stats().bool(false).bool(false).finish(),new Fixture().u8(OP.inventoryDelta).bool(false).i32(501).i16(3).i32(75).bool(false).finish()]) {
      expect(()=>decode(Uint8Array.from([...packet,0]))).toThrow('trailer');
      const reused=packet.slice();reused[reused.length-1]!|=128;expect(decode(reused)).toEqual(decode(packet));
    }
    expect(()=>decode(new Fixture().u8(OP.sp).i32(30).i32(20).finish())).toThrow('SP');
    expect(()=>decode(new Fixture().u8(OP.equipment).i32(1).u8(14).bool(false).finish())).toThrow('slot');
    expect(()=>decode(new Fixture().u8(OP.currency).i32(-1).finish())).toThrow('zeny');
  });
});

describe('normal expanded client commands', () => {
  it('writes exact pinned commands without privileged movement or respawn modes', () => {
    expect([...featureCommand({type:'sit',sitting:true})]).toEqual([14,1]);
    expect([...featureCommand({type:'useItem',itemId:501})]).toEqual([47,245,1,0,0,255,255,255,255]);
    expect([...featureCommand({type:'equip',bagId:10001,equipped:true})]).toEqual([48,17,39,0,0,1]);
    expect([...featureCommand({type:'respawn'})]).toEqual([41,0]);
    expect([...featureCommand({type:'skill',mode:'self',skillId:300,level:2})]).toEqual([29,5,44,1,2]);
    expect([...featureCommand({type:'skill',mode:'target',skillId:3,level:2,target:42})]).toEqual([29,1,42,0,0,0,3,2]);
    expect([...featureCommand({type:'skill',mode:'ground',skillId:4,level:3,position:{x:300,y:256}})]).toEqual([29,4,44,1,0,1,4,3]);
    expect([...featureCommand({type:'allocateSkill',skillId:1})]).toEqual([57,1]);
    expect([...featureCommand({type:'allocateStats',attributes:[1,0,0,0,0,0]})]).toEqual([58,1,0,0,0,...Array(20).fill(0)]);
  });
  it('strictly rejects unknown fields and invalid nested actions at the boundary', () => {
    const invalid:unknown[]=[null,[],{type:'sit',sitting:1},{type:'respawn',inPlace:true},{type:'useItem',itemId:501,target:-2},
      {type:'equip',bagId:-1,equipped:true},{type:'skill',mode:'self',skillId:1,level:0},
      {type:'skill',mode:'target',skillId:256,level:1,target:1},{type:'skill',mode:'ground',skillId:1,level:1,position:{x:1,y:1,z:1}},
      {type:'allocateStats',attributes:[0,0,0,0,0,0]},{type:'allocateStats',attributes:[100,0,0,0,0,0]},
      {type:'allocateSkill',skillId:256},{type:'adminMove',x:1,y:1}];
    for(const action of invalid)expect(()=>validateExpandedAction(action)).toThrow();
    expect(validateExpandedAction({type:'useItem',itemId:501,target:-1})).toEqual({type:'useItem',itemId:501,target:-1});
  });
});

describe('source actor cast and owner target packets',()=>{
  it('decodes target and area casts without treating them as skill results',()=>{
    const target=new Fixture().u8(24).i32(123).i32(-1).u8(20).u8(5).u8(7).position(10,20).f32(3.5).u8(15).finish();
    expect(decode(target)).toEqual([{type:'castStart',id:123,target:-1,skillId:20,level:5,position:{x:10,y:20},remainingSeconds:3.5,flags:15}]);
    const area=new Fixture().u8(25).i32(123).position(30,40).u8(20).u8(5).u8(9).u8(0).position(10,20).f32(3.5).u8(3).finish();
    expect(decode(area)).toEqual([{type:'castStart',id:123,targetPosition:{x:30,y:40},size:9,skillId:20,level:5,position:{x:10,y:20},remainingSeconds:3.5,flags:3}]);
  });
  it('decodes signed cast-time deltas, stop and authoritative owner target clear',()=>{
    expect(decode(new Fixture().u8(26).i32(123).f32(-1.5).finish())).toEqual([{type:'castExtend',id:123,deltaSeconds:-1.5}]);
    expect(decode(new Fixture().u8(27).i32(123).finish())).toEqual([{type:'castStop',id:123}]);
    for(const id of [0,123])expect(decode(new Fixture().u8(33).i32(id).finish())).toEqual([{type:'changeTarget',id}]);
    expect(decode(Uint8Array.of(28))).toEqual([]); // circle has no actor identity
  });
  it('decodes only the exact source ResetMotion111 actor layout',()=>{
    for(const id of [0,1,0x7fffffff])expect(decode(new Fixture().u8(111).i32(id).finish())).toEqual([{type:'resetMotion',id}]);
    for(const bytes of [Uint8Array.of(111),new Fixture().u8(111).i32(-1).finish(),new Fixture().u8(111).i32(1).finish().slice(0,-1),new Fixture().u8(111).i32(1).u8(0).finish()])expect(()=>decode(bytes)).toThrow(FeatureProtocolError);
  });
  it('rejects malformed bounds, flags, clocks, truncation and whole-byte trailers atomically',()=>{
    const cast=(id=1,target=-1,direction=0,seconds=1,flags=0)=>new Fixture().u8(24).i32(id).i32(target).u8(20).u8(1).u8(direction).position().f32(seconds).u8(flags).finish();
    for(const bytes of [cast(-1),cast(1,-2),cast(1,-1,8),cast(1,-1,0,NaN),cast(1,-1,0,Infinity),cast(1,-1,0,1,16),cast().slice(0,-1),Uint8Array.from([...cast(),0]),new Fixture().u8(33).i32(-1).finish()])expect(()=>decode(bytes)).toThrow(FeatureProtocolError);
  });
});

describe('full ServerEvent91 wire layout',()=>{
  it.each([2,3,4])('decodes ammo event%s with source default value and empty UTF8 string',event=>{
    const bytes=new Fixture().u8(91).u8(event).i32(0).i16(0).finish();expect(bytes.length).toBe(8);
    expect(decode(bytes)).toEqual([{type:'serverEvent',event,value:0,text:''}]);
    for(let length=1;length<8;length++)expect(()=>decode(bytes.slice(0,length))).toThrow(FeatureProtocolError);
    expect(()=>decode(Uint8Array.from([...bytes,0]))).toThrow(FeatureProtocolError);
  });
  it('keeps non-ammo subtype/value/text and validates UTF8/trailing bytes',()=>{
    const text='Zeny ✓',body=new TextEncoder().encode(text);
    expect(decode(new Fixture().u8(91).u8(5).i32(100).i16(body.length).raw(body).finish())).toEqual([{type:'serverEvent',event:5,value:100,text}]);
    expect(()=>decode(new Fixture().u8(91).u8(4).i32(0).i16(1).raw(Uint8Array.of(255)).finish())).toThrow(FeatureProtocolError);
  });
});

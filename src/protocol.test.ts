import { describe, expect, it } from 'vitest';
import { command, walkCommand, decode, OP } from './protocol';

const bytes = (base64: string) => Uint8Array.from(atob(base64), c => c.charCodeAt(0));
// Public-world Poring packet observed on the deployed build; contains no account data.
const poring = bytes('BgA8AAAAD2YGAACgDwAAAAAAAPn///8GAAAAUG9yaW5nAQMBQAEAAJkAAAABMwAAADMAAAAAAAAAAAAAAP////8AQQGYAEJ/oEN7ARlDzczMPkMkjz4JMzMiIgA=');
describe('deployed Rebuild V8 protocol', () => {
  it('decodes the observed MemoryPack monster schema', () => {
    expect(decode(poring)[0]).toEqual({ type:'spawn', entity: { id:1638, classId:4000, name:'Poring', kind:1, x:320,y:153,level:1,hp:51,maxHp:51,sp:0,maxSp:0,sitting:false,statuses:[],dead:false } });
    expect(decode(poring)[1]).toMatchObject({type:'walk', id:1638, walk:{cells:[{x:321,y:152},{x:320,y:153},{x:319,y:154},{x:318,y:155},{x:317,y:156},{x:316,y:156},{x:315,y:156},{x:314,y:156},{x:313,y:156}]}});
  });
  it('handles subarrays without reading another packet', () => {
    const padded = new Uint8Array(poring.length+8); padded.set(poring,4);
    expect(decode(padded.subarray(4,-4))).toEqual(decode(poring));
  });
  it('omits placeholder player SP from nearby-entity broadcasts', () => {
    const packet = poring.slice();
    // MemoryPack header, three i32 IDs, two string lengths and six UTF-8 bytes.
    const kindOffset = 6 + 1 + 12 + 8 + 6;
    packet[kindOffset] = 0;
    packet[kindOffset + 2] = 0;
    const event = decode(packet)[0];
    expect(event).toMatchObject({ type: 'spawn', entity: { kind: 0, hp: 51 } });
    if (event?.type !== 'spawn') throw new Error('Expected spawn');
    expect(event.entity.sp).toBeUndefined();
    expect(event.entity.maxSp).toBeUndefined();
  });
  it('accepts the full positive int32 range for authoritative spawn HP and SP', () => {
    const packet=poring.slice();const view=new DataView(packet.buffer);
    const entityEnd=6+view.getInt32(2,true);
    // This fixture has a null status dictionary and terminal main-character byte.
    for(const beforeEnd of [21,17,13,9])view.setInt32(entityEnd-beforeEnd,0x7fffffff,true);
    expect(decode(packet)[0]).toMatchObject({type:'spawn',entity:{hp:0x7fffffff,maxHp:0x7fffffff,sp:0x7fffffff,maxSp:0x7fffffff}});
  });
  it('fails closed on a changed schema or truncated spawn', () => {
    const changed = poring.slice(); changed[6] = 16;
    expect(() => decode(changed)).toThrow('schema');
    for (let i=1;i<66;i++) expect(() => decode(poring.slice(0,i))).toThrow();
  });
  it('decodes padded unmanaged status pairs and rejects malformed status payloads', () => {
    const withStatuses = (count: number, seconds?: number) => {
      const originalSize = new DataView(poring.buffer).getInt32(2, true);
      const result = new Uint8Array(poring.length + count * 8);
      const view = new DataView(result.buffer);
      result.set(poring.subarray(0, 6 + originalSize - 1));
      view.setInt32(2, originalSize + count * 8, true);
      view.setInt32(6 + originalSize - 5, count, true);
      for (let i=0;i<count;i++) {
        const at=6+originalSize-1+i*8;
        result.set([i+1, 231, 87, 142], at); view.setFloat32(at+4, seconds ?? 60+i, true);
      }
      result.set(poring.subarray(6+originalSize-1), 6+originalSize-1+count*8);
      return result;
    };
    for (const count of [0,1,2]) {
      expect(decode(withStatuses(count))[0]).toMatchObject({type:'spawn',entity:{statuses:Array.from({length:count},(_,i)=>({id:i+1,seconds:60+i}))}});
      expect(decode(withStatuses(count))[1]).toEqual(decode(poring)[1]);
    }
    // CloakingHandler uses float.MaxValue for its permanent status duration.
    const permanent=3.4028234663852886e38;
    expect(decode(withStatuses(1,permanent))[0]).toMatchObject({type:'spawn',entity:{statuses:[{id:1,seconds:permanent}]}});
    expect(()=>decode(withStatuses(1,Infinity))).toThrow('float');
    const truncated=withStatuses(2);new DataView(truncated.buffer).setInt32(2,67,true);
    expect(()=>decode(truncated)).toThrow();
    const trailer=withStatuses(1);new DataView(trailer.buffer).setInt32(2,69,true);
    expect(()=>decode(trailer)).toThrow('Invalid entity');
  });
  it('encodes ordinary client attack, pickup and stop commands', () => {
    expect([...command('attack',1638)]).toEqual([11,102,6,0,0]);
    expect([...command('pickup',65537)]).toEqual([82,1,0,1,0]);
    expect([...command('stop')]).toEqual([19]);
    for (const id of [0,-1,NaN,Infinity,1.2,2**32]) expect(() => command('attack',id)).toThrow();
  });
  it('ignores authentication and chat payloads', () => {
    expect(decode(Uint8Array.of(0,1,2,3))).toEqual([]);
    expect(decode(Uint8Array.of(44,1,2,3))).toEqual([]);
  });
  it('bounds position tracking before allocating', () => {
    expect(() => decode(Uint8Array.of(OP.tracking,255,255))).toThrow();
    expect(decode(Uint8Array.of(OP.tracking,1,0,1,0,0,0,10,0,20,0,1)))
      .toEqual([{type:'tracking',id:1,position:{x:10,y:20}}]);
  });
  it('accepts minimap removals and variable-length effect records', () => {
    expect(decode(Uint8Array.of(OP.tracking,1,0,1,0,0,0,255,255,255,255,1))).toEqual([]);
    expect(decode(Uint8Array.of(OP.tracking,1,0,1,0,0,0,10,0,20,0,8,3,0,102,111,111))).toEqual([]);
    expect(() => decode(Uint8Array.of(OP.tracking,1,0,1,0,0,0,10,0,20,0,8,3,0))).toThrow();
  });
  it('decodes in-place resurrection without resuming automation', () => {
    expect(decode(Uint8Array.of(OP.resurrection,1,0,0,0,10,0,20,0,30,0,0,0)))
      .toEqual([{type:'resurrection',id:1,position:{x:10,y:20},hp:30}]);
  });
  it('reads player health at the verified stat offsets', () => {
    const packet=new Uint8Array(145); packet[0]=OP.stats; const v=new DataView(packet.buffer);
    v.setInt32(1,7,true);v.setInt32(49,63,true);v.setInt32(53,70,true);
    expect(decode(packet)).toEqual([{type:'stats',level:7,hp:63,maxHp:70}]);
    v.setInt32(49,100,true); expect(() => decode(packet)).toThrow('health');
  });
  it('distinguishes a newly created drop from an old item entering view', () => {
    const packet=new Uint8Array(20);packet[0]=OP.drop;const v=new DataView(packet.buffer);
    v.setInt32(1,9,true);v.setFloat32(5,103,true);v.setFloat32(9,100,true);v.setInt32(13,909,true);v.setInt16(17,1,true);
    expect(decode(packet)).toEqual([{type:'drop',drop:{id:9,x:103,y:100,itemId:909,count:1,isNew:false}}]);
    packet[19]=1;
    expect(decode(packet)).toEqual([{type:'drop',drop:{id:9,x:103,y:100,itemId:909,count:1,isNew:true}}]);
  });
});

describe('walking protocol', () => {
  function packet(directions: number[], count: number): Uint8Array {
    const bytes = new Uint8Array(27 + directions.length); bytes[0] = OP.walk;
    const v = new DataView(bytes.buffer); v.setInt32(1, 1, true);
    v.setInt16(5, 100, true); v.setInt16(7, 100, true);
    v.setFloat32(9, 100.5, true); v.setFloat32(13, 100.5, true);
    v.setFloat32(17, 0.5, true); v.setFloat32(21, 0.25, true);
    bytes[25] = count; bytes.set(directions, 26);
    return bytes;
  }
  it('encodes only bounded ordinary tile movement', () => {
    expect([...walkCommand({x:360,y:251})]).toEqual([7,104,1,251,0]);
    for (const x of [-1,4097,NaN,Infinity,1.5]) expect(()=>walkCommand({x,y:10})).toThrow();
  });
  it('decodes high nibble first with odd and even direction counts', () => {
    expect(decode(packet([0x64,0x20],4))).toEqual([{type:'walk',id:1,walk:{
      origin:{x:100.5,y:100.5},cells:[{x:100,y:100},{x:101,y:100},{x:101,y:101},{x:100,y:101}],
      secondsPerCell:0.5,firstSeconds:0.25,locked:false,
    }}]);
    expect(decode(packet([0x71],3))[0]).toMatchObject({walk:{cells:[{x:100,y:100},{x:101,y:99},{x:100,y:98}]}});
  });
  it('bounds malformed routes and does not confuse the move-lock bit', () => {
    const locked=packet([0x60],2);locked[27]=1;
    expect(decode(locked)[0]).toMatchObject({walk:{locked:true}});
    expect(()=>decode(packet([0x80],2))).toThrow('direction');
    expect(()=>decode(locked.slice(0,-1))).toThrow('Truncated');
    new DataView(locked.buffer).setFloat32(17,NaN,true);expect(()=>decode(locked)).toThrow('float');
  });
  it('reads action stop and stopping-hit corrections', () => {
    expect(decode(Uint8Array.of(19,1,0,0,0))).toEqual([{type:'stop',id:1}]);
    expect(decode(Uint8Array.of(23,1,0,0,0,5,0,0,0,10,0,20,0,1)))
      .toEqual([{type:'hit',id:1,damage:5,position:{x:10,y:20},stops:true}]);
  });
});

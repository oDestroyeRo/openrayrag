import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { decodeMemo, decodeMemoNotification, memoCommand, validateMemoRequest } from './memo-protocol';
import { canMemoMap } from './memo-map-catalog';
import catalog from './data/memo-map-catalog.json';
import cases from './data/memo-request-cases.json';
import { decode } from './protocol';

export const memoRequest={type:'memoSave' as const,slot:0 as const,preview:{world:'00000000-0000-4000-8000-000000000001',actorId:1,incarnation:1,connectionEpoch:1,revision:1,map:'prontera',x:10,y:20}};
describe('source-pinned memo wire and permission',()=>{
 it('sends only opcode and slot; decodes every one of the four records',()=>{
  expect([...memoCommand(3)]).toEqual([94,3]);
  expect(decodeMemo(Uint8Array.from([94,0,1,1,0,97,10,0,20,0,0,0]))).toEqual([{type:'memoSlots',slots:[null,{map:'a',x:10,y:20},null,null]}]);
  expect(decode(Uint8Array.from([94,0,0,0,0]))).toEqual([{type:'memoSlots',slots:[null,null,null,null]}]);
  expect(decodeMemo(new BitWriter().u8(94).u8(1).string('prontera').i16(32767).i16(0).u8(0).u8(0).u8(0).finish())?.[0]?.slots[0]?.x).toBe(32767);
  expect(decodeMemo(new Uint8Array())).toBeNull();
 });
 it('rejects malformed presence, map, UTF8, coordinates, missing slots and trailers completely',()=>{
  const packet=Uint8Array.from([94,0,1,1,0,97,10,0,20,0,0,0]);
  for(let n=1;n<packet.length;n++)expect(()=>decodeMemo(packet.slice(0,n))).toThrow();
  for(const data of [Uint8Array.from([...packet,0]),Uint8Array.from([94,2,0,0,0]),Uint8Array.from([94,1,1,0,255,0,0,0,0,0,0,0]),new BitWriter().u8(94).u8(1).string('').i16(1).i16(2).u8(0).u8(0).u8(0).finish(),new BitWriter().u8(94).u8(1).string('\ufeffa').i16(1).i16(2).u8(0).u8(0).u8(0).finish(),new BitWriter().u8(94).u8(1).string('a').i16(-1).i16(2).u8(0).u8(0).u8(0).finish(),new BitWriter().u8(94).u8(1).string('a'.repeat(65)).i16(1).i16(2).u8(0).u8(0).u8(0).finish()])expect(()=>decodeMemo(data)).toThrow();
 });
 it('strictly validates the data-only preview, including observed actor zero',()=>{
  expect(validateMemoRequest({...memoRequest,preview:{...memoRequest.preview,actorId:0}}).preview.actorId).toBe(0);
  for(const fixture of cases)expect((()=>{try{validateMemoRequest(fixture.request);return true;}catch{return false;}})(),fixture.name).toBe(fixture.valid);
  for(const input of [{...memoRequest,slot:4},{...memoRequest,slot:-1},{...memoRequest,map:'other'},{...memoRequest,preview:{...memoRequest.preview,extra:1}},{...memoRequest,preview:{...memoRequest.preview,x:512}},{...memoRequest,preview:{...memoRequest.preview,incarnation:0}},{...memoRequest,preview:{...memoRequest.preview,world:'unknown'}}])expect(()=>validateMemoRequest(input)).toThrow();
 });
 it('preserves literal BOM notification text and validates its complete bounded payload',()=>{
  const bom=Uint8Array.from([91,8,0,0,0,0,3,0,239,187,191]);
  expect(decode(bom)).toEqual([{type:'serverEvent',event:8,value:0,text:'\ufeff'}]);
  expect(decodeMemoNotification(new BitWriter().u8(91).u8(8).i32(3).string('').finish())).toEqual([{type:'serverEvent',event:8,value:3,text:''}]);
  expect(decodeMemoNotification(new BitWriter().u8(91).u8(7).i32(3).string('other').finish())).toBeNull();
  expect(decode(new BitWriter().u8(91).u8(7).i32(3).string('other').finish())).toEqual([{type:'serverEvent',event:7,value:3,text:'other'}]);
  for(let size=2;size<bom.length;size++)expect(()=>decodeMemoNotification(bom.slice(0,size))).toThrow();
  for(const bad of [Uint8Array.from([...bom,0]),Uint8Array.from([91,8,0,0,0,0,1,0,255]),new BitWriter().u8(91).u8(8).i32(0).string('x'.repeat(4097),65535).finish()])expect(()=>decodeMemoNotification(bad)).toThrow();
 });
 it('uses explicit pinned flags, with unknown maps remaining unknown',()=>{
  expect(catalog.items).toHaveLength(272);expect(catalog.items.filter(map=>map.canMemo)).toHaveLength(111);
  for(const map of catalog.items)expect(canMemoMap(map.map)).toBe(map.canMemo);
  expect(canMemoMap('unknown_map')).toBeNull();expect(canMemoMap('prt_fild08')).toBe(true);expect(canMemoMap('pay_dun00')).toBe(false);
 });
});

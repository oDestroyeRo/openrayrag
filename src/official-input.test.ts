import { describe, expect, it, vi } from 'vitest';
import { isOfficialGameplayCommand, isOfficialLookCommand, couldOwnOfficialGameplay } from './official-input';

describe('pinned official outgoing command ownership', () => {
  it('classifies only the Look opcode for manual grace without inspecting or retaining its private body',()=>{
    const bytes=new Uint8Array([3,13,255,255,7]);
    expect(isOfficialLookCommand(bytes.subarray(1,4))).toBe(true);expect(couldOwnOfficialGameplay(bytes.subarray(1,4))).toBe(true);
    expect(isOfficialLookCommand(new DataView(bytes.buffer,1,2))).toBe(true);
    for(const data of [bytes,new Uint8Array(),new Uint8Array([7]),'13',{},new Blob([bytes])])expect(isOfficialLookCommand(data)).toBe(false);
  });
  it.each([
    ['movement', [7,8,9,19,21,41,110,111]], ['combat', [11,14,29,33,104]],
    ['character and resources', [45,47,48,57,58,59,62,63,90,94,97,112]],
    ['NPC and inventory', [76,78,79,80,81,82,86,87,88,89]],
    ['party and vending', [99,100,101,102,105,106,107,109]],
  ])('recognizes %s opcodes without interpreting any payload', (_family, opcodes) => {
    for(const opcode of opcodes as number[])expect(isOfficialGameplayCommand(new Uint8Array([opcode,255,255]).buffer)).toBe(true);
  });
  it.each([0,1,2,3,4,6,10,13,17,24,27,37,40,44,50,54,55,56,64,77,83,84,91,95,108,255])(
    'ignores auth/readiness/keepalive, cosmetic/social/query or incoming-only opcode %s', opcode => {
      expect(isOfficialGameplayCommand(new Uint8Array([opcode,255,255]))).toBe(false);
    });
  it('uses the view offset and only its first byte, without retaining a copy', () => {
    const bytes=new Uint8Array([3,7,4]);
    expect(isOfficialGameplayCommand(bytes.subarray(1,2))).toBe(true);
    expect(isOfficialGameplayCommand(new DataView(bytes.buffer,2,1))).toBe(false);
    expect(isOfficialGameplayCommand(new Uint8Array())).toBe(false);
    expect(isOfficialGameplayCommand(new ArrayBuffer(0))).toBe(false);
  });
  it('never parses strings, arbitrary objects or asynchronously reads a Blob', () => {
    const blob=new Blob([new Uint8Array([7])]),read=vi.spyOn(blob,'arrayBuffer');
    for(const value of [blob,'7','credential-like text',null,{},[7]])expect(isOfficialGameplayCommand(value)).toBe(false);
    expect(read).not.toHaveBeenCalled();
  });
});

it('identifies only binary official refine opcode 80 at the view offset',async()=>{
 const {isOfficialRefineCommand}=await import('./official-input');
 expect(isOfficialRefineCommand(new Uint8Array([3,80,1]).subarray(1,2))).toBe(true);
 expect(isOfficialRefineCommand(new Uint8Array([80]).buffer)).toBe(true);
 const blob=new Blob([new Uint8Array([80])]),read=vi.spyOn(blob,'arrayBuffer');
 for(const value of [new Uint8Array([3,80]),new Uint8Array([63,80]),new ArrayBuffer(0),blob,'80',null])expect(isOfficialRefineCommand(value)).toBe(false);
 expect(read).not.toHaveBeenCalled();
});

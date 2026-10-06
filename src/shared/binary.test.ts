import { describe, expect, it } from 'vitest';
import { BitReader, BitWriter } from './binary';

describe('Rayrag unaligned binary stream', () => {
  it('uses the source-defined one-bit boolean before an unaligned int32', () => {
    const sourceBytes = Uint8Array.of(0xf1, 0xac, 0x68, 0x24, 0);
    const r = new BitReader(sourceBytes);
    expect(r.bool()).toBe(true); expect(r.i32()).toBe(0x12345678); r.finish();
    expect(new BitWriter().bool(true).i32(0x12345678).finish()).toEqual(sourceBytes);
    const negative = new BitReader(Uint8Array.of(255,255,255,255,1));
    expect(negative.bool()).toBe(true); expect(negative.i32()).toBe(-1); negative.finish();
  });
  it('keeps field alignment after multiple flags and UTF8 strings', () => {
    const w = new BitWriter().bool(false).i16(-32768).bool(true).u16(65535).f32(.25).string('ไทย');
    const r = new BitReader(w.finish());
    expect(r.bool()).toBe(false); expect(r.i16()).toBe(-32768); expect(r.bool()).toBe(true);
    expect(r.u16()).toBe(65535); expect(r.f32()).toBe(.25); expect(r.string()).toBe('ไทย'); r.finish();
  });
  it('reads only the actual subarray and ignores unused bits from pooled bytes', () => {
    const padded = Uint8Array.of(99,0xf1,0xac,0x68,0x24,0,99);
    const r = new BitReader(padded.subarray(1,6)); r.bool(); expect(r.i32()).toBe(0x12345678); r.finish();
    const reused = new BitReader(Uint8Array.of(255)); expect(reused.bool()).toBe(true); reused.finish();
    expect(reused.remainingBits).toBe(0);
    const reusedFalse = new BitReader(Uint8Array.of(254)); expect(reusedFalse.bool()).toBe(false); reusedFalse.finish();
    const trailing = new BitReader(Uint8Array.of(0,0)); trailing.u8(); expect(()=>trailing.finish()).toThrow('trailer');
  });
  it('rejects truncation, nonfinite floats, oversized strings and invalid writers', () => {
    expect(()=>new BitReader(Uint8Array.of(1)).i16()).toThrow('Truncated');
    expect(()=>new BitReader(Uint8Array.of(0,0,128,127)).f32()).toThrow('float');
    expect(()=>new BitReader(Uint8Array.of(1,16)).string()).toThrow('Oversized');
    expect(()=>new BitReader(Uint8Array.of(1,0,255)).string()).toThrow();
    for (const value of [-1,256,NaN,1.5]) expect(()=>new BitWriter().u8(value)).toThrow();
    expect(()=>new BitWriter().i32(2147483648)).toThrow();
    expect(()=>new BitWriter().f32(Infinity)).toThrow();
    expect(()=>new BitWriter().f32(1e100)).toThrow();
  });
});

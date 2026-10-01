// Rayrag uses a little-endian, least-significant-bit-first stream. A boolean
// consumes one bit and never aligns the following field to a byte boundary.
function integer(value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error('Invalid integer');
}

export class BitReader {
  bitOffset = 0;
  constructor(readonly data: Uint8Array) {
    if (!data.length || data.length > 1_000_000) throw new Error('Invalid packet size');
  }
  get remainingBits(): number { return this.data.length * 8 - this.bitOffset; }
  bits(count: number): number {
    integer(count, 1, 32);
    if (count > this.remainingBits) throw new Error('Truncated packet');
    let value = 0;
    for (let i = 0; i < count; i++, this.bitOffset++) {
      value += ((this.data[this.bitOffset >>> 3]! >>> (this.bitOffset & 7)) & 1) * 2 ** i;
    }
    return value;
  }
  bool(): boolean { return this.bits(1) === 1; }
  u8(): number { return this.bits(8); }
  u16(): number { return this.bits(16); }
  i16(): number { const value = this.u16(); return value >= 0x8000 ? value - 0x10000 : value; }
  i32(): number { const value = this.bits(32); return value >= 0x80000000 ? value - 0x100000000 : value; }
  f32(): number {
    const buffer = new ArrayBuffer(4); const view = new DataView(buffer);
    view.setUint32(0, this.bits(32), true);
    const value = view.getFloat32(0, true);
    if (!Number.isFinite(value)) throw new Error('Invalid float');
    return value;
  }
  take(count: number): Uint8Array<ArrayBuffer> {
    integer(count, 0, 1_000_000);
    if (count * 8 > this.remainingBits) throw new Error('Truncated packet');
    const value = new Uint8Array(count);
    for (let i = 0; i < count; i++) value[i] = this.u8();
    return value;
  }
  string(maxBytes = 4096): string {
    integer(maxBytes, 0, 65535);
    const count = this.u16();
    if (count > maxBytes) throw new Error('Oversized string');
    return new TextDecoder('utf-8', { fatal: true }).decode(this.take(count));
  }
  position(): { x: number; y: number } {
    const x = this.i16(); const y = this.i16();
    if (x < 0 || y < 0 || x > 4096 || y > 4096) throw new Error('Invalid position');
    return { x, y };
  }
  finish(): void {
    if (this.remainingBits >= 8) throw new Error('Unknown packet trailer');
    // OutboundMessage.Clear resets the cursor, but reuses its pooled byte
    // buffer. NetBitWriter preserves unused bits in the final partial byte.
    // Those bits have no wire meaning, regardless of their previous contents.
    this.bitOffset += this.remainingBits;
  }
}

export class BitWriter {
  private readonly data: number[] = [];
  private bitOffset = 0;
  bits(value: number, count: number): this {
    integer(count, 1, 32); integer(value, 0, 2 ** count - 1);
    if (this.bitOffset + count > 8_000_000) throw new Error('Oversized packet');
    for (let i = 0; i < count; i++, this.bitOffset++) {
      const at = this.bitOffset >>> 3;
      this.data[at] = (this.data[at] ?? 0) | ((Math.floor(value / 2 ** i) & 1) << (this.bitOffset & 7));
    }
    return this;
  }
  bool(value: boolean): this {
    if (typeof value !== 'boolean') throw new Error('Invalid boolean');
    return this.bits(value ? 1 : 0, 1);
  }
  u8(value: number): this { return this.bits(value, 8); }
  u16(value: number): this { return this.bits(value, 16); }
  i16(value: number): this { integer(value, -32768, 32767); return this.bits(value < 0 ? value + 65536 : value, 16); }
  i32(value: number): this { integer(value, -2147483648, 2147483647); return this.bits(value < 0 ? value + 4294967296 : value, 32); }
  f32(value: number): this {
    if (!Number.isFinite(value)) throw new Error('Invalid float');
    const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, true);
    if (!Number.isFinite(view.getFloat32(0, true))) throw new Error('Invalid float');
    return this.bits(view.getUint32(0, true), 32);
  }
  take(value: Uint8Array): this { for (const byte of value) this.u8(byte); return this; }
  string(value: string, maxBytes = 4096): this {
    if (typeof value !== 'string') throw new Error('Invalid string');
    integer(maxBytes, 0, 65535);
    const encoded = new TextEncoder().encode(value);
    if (encoded.length > maxBytes) throw new Error('Oversized string');
    return this.u16(encoded.length).take(encoded);
  }
  position(value: { x: number; y: number }): this {
    integer(value.x, 0, 4096); integer(value.y, 0, 4096);
    return this.i16(value.x).i16(value.y);
  }
  finish(): Uint8Array<ArrayBuffer> { return Uint8Array.from(this.data); }
}

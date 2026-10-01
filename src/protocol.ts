// RayRag's deployed V8 build. This is a deliberately small, bounded decoder.
// Numeric IDs are from the pre-July Rebuild enum, NOT current upstream master.
export const GAME_URL = 'https://websea01.rayrag.com/';
export const SOCKET_URL = 'wss://gamesea01.rayrag.com/ws';
export const VERIFIED_BUILD = 'Build_2569-09-01-01-55';
export const OP = {
  enter: 3, spawn: 6, walk: 7, move: 10, attack: 11, remove: 15,
  clear: 16, map: 18, stop: 19, stopImmediate: 20, hit: 23,
  death: 36, heal: 37, resurrection: 46, stats: 56, tracking: 60, drop: 81, pickup: 82,
} as const;

export interface Position { x: number; y: number }
export interface Entity extends Position {
  id: number; classId: number; name: string; kind: number; level: number;
  hp: number; maxHp: number; dead: boolean;
}
export interface Walk { origin: Position; cells: Position[]; secondsPerCell: number; firstSeconds: number; locked: boolean }
export interface Drop extends Position { id: number; itemId: number; count: number; isNew: boolean }
export type GameEvent =
  | { type: 'enter'; id: number; map: string }
  | { type: 'map'; map: string }
  | { type: 'spawn'; entity: Entity }
  | { type: 'remove'; id: number; dead: boolean }
  | { type: 'clear' }
  | { type: 'stop'; id: number }
  | { type: 'position' | 'tracking'; id: number; position: Position }
  | { type: 'walk'; id: number; walk: Walk }
  | { type: 'attack'; source: number; target: number; position: Position }
  | { type: 'hit'; id: number; damage: number; position: Position; stops?: boolean }
  | { type: 'death'; id: number }
  | { type: 'resurrection'; id: number; hp: number; position: Position }
  | { type: 'heal'; id: number; hp: number; maxHp: number }
  | { type: 'stats'; hp: number; maxHp: number; level: number }
  | { type: 'drop'; drop: Drop }
  | { type: 'pickup'; picker: number; id: number };

class Reader {
  offset = 0;
  readonly view: DataView;
  constructor(readonly data: Uint8Array) {
    this.view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  }
  take(n: number): Uint8Array {
    if (!Number.isInteger(n) || n < 0 || this.offset + n > this.data.length) throw new Error('Truncated packet');
    const value = this.data.subarray(this.offset, this.offset + n);
    this.offset += n;
    return value;
  }
  u8(): number { return this.take(1)[0]!; }
  i16(): number { const at = this.offset; this.take(2); return this.view.getInt16(at, true); }
  u16(): number { const at = this.offset; this.take(2); return this.view.getUint16(at, true); }
  i32(): number { const at = this.offset; this.take(4); return this.view.getInt32(at, true); }
  f32(): number {
    const at = this.offset; this.take(4);
    const value = this.view.getFloat32(at, true);
    if (!Number.isFinite(value)) throw new Error('Invalid float');
    return value;
  }
  string(): string { return this.text(this.u16()); }
  text(bytes: number, encoding = 'utf-8'): string {
    if (bytes > 1024) throw new Error('Oversized string');
    return new TextDecoder(encoding, { fatal: true }).decode(this.take(bytes));
  }
  memoryString(): string {
    const length = this.i32();
    if (length === -1) return '';
    if (length >= 0) return this.text(length * 2, 'utf-16le');
    const chars = this.i32();
    const value = this.text(~length);
    if (value.length !== chars) throw new Error('Invalid string length');
    return value;
  }
  position(): Position { return position(this.i16(), this.i16()); }
}

function position(x: number, y: number): Position {
  if (x < 0 || y < 0 || x > 4096 || y > 4096) throw new Error('Invalid position');
  return { x, y };
}
function health(hp: number, maxHp: number): void {
  if (hp < 0 || maxHp < 0 || hp > maxHp || maxHp > 2_000_000_000) throw new Error('Invalid health');
}
function mapName(value: string): string {
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(value)) throw new Error('Unknown map format');
  return value;
}

function spawn(r: Reader): GameEvent[] {
  const event = r.u8();
  if (event > 5) throw new Error('Unknown spawn event');
  if (event === 3) r.position();
  const size = r.i32();
  if (size < 40 || size > 4096) throw new Error('Unknown entity layout');
  const e = new Reader(r.take(size));
  if (e.u8() !== 15) throw new Error('Unknown entity schema');
  const id = e.i32();
  const classId = e.i32();
  e.i32(); // Optional appearance override; targeting uses the actual class.
  const name = e.memoryString();
  const kind = e.u8();
  e.u8(); // Facing.
  const state = e.u8();
  const pos = position(e.i32(), e.i32());
  const level = e.u8();
  const hp = e.i32();
  const maxHp = e.i32();
  e.i32(); e.i32(); // SP and maximum SP.
  const statuses = e.i32();
  if (statuses < -1 || statuses > 128) throw new Error('Unknown status layout');
  // MemoryPack 1.21.4 writes unmanaged KeyValuePair<byte,float> with 3 padding bytes.
  for (let i = 0; i < statuses; i++) { e.u8(); e.take(3); e.f32(); }
  e.u8(); // IsMainCharacter; actual identity comes from EnterServer.
  if (e.offset !== size || id <= 0 || classId < 0 || kind > 4 || state > 4) throw new Error('Invalid entity');
  health(hp, maxHp);
  const events: GameEvent[] = [{ type: 'spawn', entity: { id, classId, name, kind, level, ...pos, hp, maxHp, dead: state === 3 } }];
  // Only the player and monsters are retained. Appearance blocks are skipped.
  if (state === 1 && (kind === 0 || kind === 1)) {
    if (kind === 0) {
      const appearanceSize = r.i32();
      if (appearanceSize < 1 || appearanceSize > 4096) throw new Error('Unknown player appearance layout');
      r.take(appearanceSize);
    }
    events.push({ type: 'walk', id, walk: readWalk(r) });
  }
  return events;
}

function readWalk(r: Reader): Walk {
  const start = r.position();
  const origin = position(r.f32(), r.f32());
  const secondsPerCell = r.f32();
  const firstSeconds = r.f32();
  const count = r.u8();
  if (secondsPerCell <= 0 || secondsPerCell > 10 || Math.abs(firstSeconds) > 20
    || Math.abs(origin.x - start.x) > 2 || Math.abs(origin.y - start.y) > 2) throw new Error('Invalid walk timing or origin');
  const cells = count ? [start] : [];
  const offsets = [[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]] as const;
  for (let i = 1; i < count;) {
    const packed = r.u8();
    for (const direction of [packed >> 4, packed & 15]) {
      if (i >= count) break;
      const offset = offsets[direction];
      if (!offset) throw new Error('Invalid walk direction');
      const previous = cells[i - 1]!;
      cells.push(position(previous.x + offset[0], previous.y + offset[1])); i++;
    }
  }
  const locked = (r.u8() & 1) !== 0;
  return { origin, cells, secondsPerCell, firstSeconds, locked };
}

export function decode(data: Uint8Array): GameEvent[] {
  if (!data.length || data.length > 1_000_000) throw new Error('Invalid packet size');
  const r = new Reader(data);
  const opcode = r.u8();
  switch (opcode) {
    case OP.enter: return [{ type: 'enter', id: r.i32(), map: mapName(r.string()) }];
    case OP.map: return [{ type: 'map', map: mapName(r.string()) }];
    case OP.spawn: return spawn(r);
    case OP.remove: return [{ type: 'remove', id: r.i32(), dead: r.u8() === 3 }];
    case OP.clear: return [{ type: 'clear' }];
    case OP.stop: return [{ type: 'stop', id: r.i32() }];
    case OP.walk: {
      const id = r.i32();
      const walk = readWalk(r);
      if (r.offset !== data.length) throw new Error('Unknown walk trailer');
      return [{ type: 'walk', id, walk }];
    }
    case OP.move:
    case OP.stopImmediate: return [{ type: 'position', id: r.i32(), position: r.position() }];
    case OP.tracking: {
      const count = r.u16();
      if (count > 4096) throw new Error('Unknown tracking layout');
      const events: GameEvent[] = [];
      for (let i = 0; i < count; i++) {
        const id = r.i32(); const x = r.i16(); const y = r.i16(); const kind = r.u8();
        if (kind === 8) { r.string(); continue; } // Map effect asset name.
        // Negative positions remove a minimap marker; they do not remove a world entity.
        if (x >= 0 && y >= 0) events.push({ type: 'tracking', id, position: position(x,y) });
      }
      if (r.offset !== data.length) throw new Error('Unknown tracking trailer');
      return events;
    }
    case OP.attack: {
      const source = r.i32(); const target = r.i32(); r.take(4);
      return [{ type: 'attack', source, target, position: r.position() }];
    }
    case OP.hit: {
      const id = r.i32(); const damage = r.i32();
      const pos = r.position();
      return [{ type: 'hit', id, damage, position: pos, stops: (r.u8() & 1) !== 0 }];
    }
    case OP.death: return [{ type: 'death', id: r.i32() }];
    case OP.resurrection: {
      const id = r.i32(); const pos = r.position(); const hp = r.i32();
      if (hp <= 0) throw new Error('Invalid resurrection health');
      return [{ type: 'resurrection', id, hp, position: pos }];
    }
    case OP.heal: {
      const id = r.i32(); r.i32();
      const hp = r.i32(); const maxHp = r.i32(); health(hp, maxHp);
      return [{ type: 'heal', id, hp, maxHp }];
    }
    case OP.stats: {
      const level = r.i32(); r.take(44);
      const hp = r.i32(); const maxHp = r.i32(); health(hp, maxHp);
      return [{ type: 'stats', level, hp, maxHp }];
    }
    case OP.drop: {
      const id = r.i32(); const pos = position(r.f32(), r.f32());
      const itemId = r.i32(); const count = r.i16();
      const isNew = (r.u8() & 1) === 1;
      if (id <= 0 || itemId <= 0 || count <= 0) throw new Error('Invalid drop');
      return [{ type: 'drop', drop: { id, ...pos, itemId, count, isNew } }];
    }
    case OP.pickup: return [{ type: 'pickup', picker: r.i32(), id: r.i32() }];
    // Login responses, chat, inventory, trade and unknown packet payloads are ignored.
    default: return [];
  }
}

export function command(action: 'attack' | 'pickup' | 'stop', id?: number): Uint8Array<ArrayBuffer> {
  if (action === 'stop') return Uint8Array.of(OP.stop);
  if (!Number.isInteger(id) || id! <= 0 || id! > 0x7fffffff) throw new Error('Invalid target');
  const result = new Uint8Array(5);
  result[0] = OP[action];
  new DataView(result.buffer).setInt32(1, id!, true);
  return result;
}

export function walkCommand(destination: Position): Uint8Array<ArrayBuffer> {
  const { x, y } = destination;
  position(x, y);
  if (!Number.isInteger(x) || !Number.isInteger(y)) throw new Error('Invalid walk destination');
  const result = new Uint8Array(5); result[0] = OP.walk;
  const view = new DataView(result.buffer); view.setInt16(1, x, true); view.setInt16(3, y, true);
  return result;
}

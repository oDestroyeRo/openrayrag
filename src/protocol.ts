import { BitReader, BitWriter } from './binary';
import {actorId,optionalWireActorId} from './actor-identity';
import { decodeFeatures, FEATURE_OP } from './protocol-feature';
import type { FeatureEvent } from './protocol-feature';
import { decodeSocial, type SocialEvent } from './social-protocol';
import { decodeMemo, decodeMemoNotification, type MemoEvent } from './memo-protocol';
export { featureCommand, validateExpandedAction, decodeFeatures, FEATURE_OP, FeatureProtocolError } from './protocol-feature';
export type { ExpandedAction, FeatureEvent, InventoryItem, SkillLevel, PlayerStats, Attributes } from './protocol-feature';

// RayRag's deployed V8 build. Packet readers are deliberately bounded.
// Numeric IDs are from the pre-July Rebuild enum, NOT current upstream master.
export const GAME_URL = 'https://websea01.rayrag.com/';
export const SOCKET_URL = 'wss://gamesea01.rayrag.com/ws';
export const VERIFIED_BUILD = 'Build_2569-09-01-01-55';
export const OP = {
  enter: 3, spawn: 6, walk: 7, move: 10, attack: 11, remove: 15,
  look:13, clear: 16, map: 18, stop: 19, stopImmediate: 20, hit: 23,
  partyAffiliation: 103, death: 36, heal: 37, resurrection: 46, tracking: 60, drop: 81, pickup: 82,
  ...FEATURE_OP,
} as const;

export interface Position { x: number; y: number }
export interface LookAction {type:'look';direction:number;head:number}
export interface Entity extends Position {
  id: number; classId: number; name: string; kind: number; level: number;
  hp: number; maxHp: number; dead: boolean;
  partyId?: number; partyName?: string;
  sp?: number; maxSp?: number; sitting?: boolean; statuses?: { id: number; seconds: number }[];
}
export interface Walk { origin: Position; cells: Position[]; secondsPerCell: number; firstSeconds: number; locked: boolean }
export interface Drop extends Position { id: number; itemId: number; count: number; isNew: boolean }
export type GameEvent = FeatureEvent | SocialEvent | MemoEvent
  | {type:'look';id:number;lookAt:Position;direction:number;head:number}
  | { type: 'partyAffiliation'; id: number; partyId: number; partyName: string }
  | { type: 'enter'; id: number; map: string }
  | { type: 'map'; map: string }
  | { type: 'spawn'; entity: Entity; entryType?: number }
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
    return new TextDecoder(encoding, { fatal: true, ignoreBOM: true }).decode(this.take(bytes));
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
  if (hp < 0 || maxHp < 0 || hp > maxHp || maxHp > 0x7fffffff) throw new Error('Invalid health');
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
  const sp = e.i32(); const maxSp = e.i32(); health(sp, maxSp);
  const statusCount = e.i32();
  if (statusCount < -1 || statusCount > 128) throw new Error('Unknown status layout');
  const statuses: { id: number; seconds: number }[] = []; const statusIds = new Set<number>();
  // MemoryPack 1.21.4 writes unmanaged KeyValuePair<byte,float> with 3 padding bytes.
  for (let i = 0; i < statusCount; i++) {
    const id = e.u8(); e.take(3); const seconds = e.f32();
    if (statusIds.has(id)) throw new Error('Invalid status');
    statusIds.add(id); statuses.push({ id, seconds });
  }
  e.u8(); // IsMainCharacter; actual identity comes from EnterServer.
  if (e.offset !== size || id < 0 || classId < 0 || kind > 4 || state > 4) throw new Error('Invalid entity');
  health(hp, maxHp);
  // Non-self player broadcasts can reach the owner with placeholder SP. Match
  // the official client: only a positive maximum establishes a player SP value.
  const resources = kind === 0 && maxSp === 0 ? {} : { sp, maxSp };
  const events: GameEvent[] = [{ type: 'spawn', entryType: event, entity: { id, classId, name, kind, level, ...pos, hp, maxHp, ...resources, sitting: state === 2, statuses, dead: state === 3 } }];
  // Older synthetic/entity-only captures remain valid, with unknown affiliation.
  // Only a complete pinned PlayerSpawnParameters block can establish party identity.
  if (kind === 0 && r.offset < r.data.length) {
    const appearanceSize = r.i32();
    if (appearanceSize < 41 || appearanceSize > 4096) throw new Error('Unknown player appearance layout');
    const appearance = new Reader(r.take(appearanceSize));
    if (appearance.u8() !== 13) throw new Error('Unknown player appearance schema');
    appearance.take(28); // bool, int32 weapon class, three bytes, five int32 equipment IDs.
    const partyId = appearance.i32();
    const partyName = appearance.memoryString();
    appearance.i32(); // CharacterFollowerState is an int32 flags enum.
    if (appearance.offset !== appearanceSize || partyId < -1 || partyName.length > 128
      || (partyId > 0 && !partyName) || (partyId <= 0 && partyName)) throw new Error('Invalid player affiliation');
    const spawned = events[0]!;
    if (spawned.type === 'spawn') Object.assign(spawned.entity,{partyId,partyName});
  }
  if (state === 1 && (kind === 0 || kind === 1)) events.push({ type: 'walk', id, walk: readWalk(r) });
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
  const memoNotification=decodeMemoNotification(data);
  if(memoNotification!==null)return memoNotification;
  const features = decodeFeatures(data);
  if (features !== null) return features;
  const social = decodeSocial(data);
  if (social !== null) return social;
  const memo = decodeMemo(data);
  if (memo !== null) return memo;
  switch (opcode) {
    case OP.look: {
      if(data.length!==11)throw new Error('Invalid Look packet length');
      const id=actorId(r.i32()),lookAt={x:r.i16(),y:r.i16()},direction=r.u8(),head=r.u8();
      if(direction>7||head>2)throw new Error('Invalid Look facing');
      return [{type:'look',id,lookAt,direction,head}];
    }
    case OP.partyAffiliation: {
      const party = new BitReader(data);party.u8();const id = actorId(party.i32());const joined=party.u8();
      if(joined!==0&&joined!==1)throw new Error('Invalid party affiliation');
      const partyId=joined?party.i32():-1;const partyName=joined?party.string(128):'';
      if(joined){if(partyId<=0||!partyName)throw new Error('Invalid party affiliation');party.bool();}
      party.finish();return [{type:'partyAffiliation',id,partyId,partyName}];
    }
    case OP.enter: return [{ type: 'enter', id: actorId(r.i32()), map: mapName(r.string()) }];
    case OP.map: return [{ type: 'map', map: mapName(r.string()) }];
    case OP.spawn: return spawn(r);
    case OP.remove: return [{ type: 'remove', id: actorId(r.i32()), dead: r.u8() === 3 }];
    case OP.clear: return [{ type: 'clear' }];
    case OP.stop: return [{ type: 'stop', id: actorId(r.i32()) }];
    case OP.walk: {
      const id = actorId(r.i32());
      const walk = readWalk(r);
      if (r.offset !== data.length) throw new Error('Unknown walk trailer');
      return [{ type: 'walk', id, walk }];
    }
    case OP.move:
    case OP.stopImmediate: return [{ type: 'position', id: actorId(r.i32()), position: r.position() }];
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
      const source = optionalWireActorId(r.i32()); const target = actorId(r.i32()); r.take(4);
      return [{ type: 'attack', source, target, position: r.position() }];
    }
    case OP.hit: {
      const id = actorId(r.i32()); const damage = r.i32();
      const pos = r.position();
      return [{ type: 'hit', id, damage, position: pos, stops: (r.u8() & 1) !== 0 }];
    }
    case OP.death: return [{ type: 'death', id: actorId(r.i32()) }];
    case OP.resurrection: {
      const id = actorId(r.i32()); const pos = r.position(); const hp = r.i32();
      if (hp <= 0) throw new Error('Invalid resurrection health');
      return [{ type: 'resurrection', id, hp, position: pos }];
    }
    case OP.heal: {
      const id = actorId(r.i32()); r.i32();
      const hp = r.i32(); const maxHp = r.i32(); health(hp, maxHp);
      return [{ type: 'heal', id, hp, maxHp }];
    }
    case OP.drop: {
      const id = r.i32(); const pos = position(r.f32(), r.f32());
      const itemId = r.i32(); const count = r.i16();
      const isNew = (r.u8() & 1) === 1;
      if (id <= 0 || itemId <= 0 || count <= 0) throw new Error('Invalid drop');
      return [{ type: 'drop', drop: { id, ...pos, itemId, count, isNew } }];
    }
    case OP.pickup: {const picker=optionalWireActorId(r.i32());const id=r.i32();if(id<=0)throw new Error('Invalid drop ID');return [{type:'pickup',picker,id}];}
    // Unsupported login/other packet payloads are ignored.
    default: return [];
  }
}

export function command(action: 'attack' | 'pickup' | 'stop', id?: number): Uint8Array<ArrayBuffer> {
  if (action === 'stop') return Uint8Array.of(OP.stop);
  if (!Number.isInteger(id) || id! < (action==='attack'?0:1) || id! > 0x7fffffff) throw new Error('Invalid target');
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

export function lookCommand(action:LookAction):Uint8Array<ArrayBuffer> {
  const fields=['type','direction','head'];
  if(typeof action!=='object'||action===null||Array.isArray(action)||!fields.every(key=>Object.hasOwn(action,key))
    ||Object.keys(action).some(key=>!fields.includes(key))||action.type!=='look'||!Number.isInteger(action.direction)||action.direction<0||action.direction>7
    ||!Number.isInteger(action.head)||action.head<0||action.head>2)throw new Error('Invalid Look action');
  return new BitWriter().u8(OP.look).u8(action.direction).u8(action.head).finish();
}

import {actorId,optionalWireActorId} from './actor-identity';
import { BitReader, BitWriter } from './binary';
import type { Position } from './protocol';

// Source: Rebuild pin 4099e2c000c3c550516760b9c1241595aac9aceb.
export const FEATURE_OP = {
  castStart: 24, areaCastStart: 25, castExtend: 26, castStop: 27, changeTarget: 33,
  sit: 14, skill: 29, skillImpact: 30, skillFailure: 31, featureError: 32, experience: 34, sp: 39,
  serverEvent: 91, currency: 40, respawn: 41, requestFailure: 42, targeted: 43, useItem: 47,
  equipment: 48, inventoryDelta: 50, stats: 56, learnedSkill: 57,
  allocateStats: 58, status: 61, removeStatus: 62, inventoryItem: 63, grantedSkills: 98, maskedSkill: 104, resetMotion: 111,
} as const;

export type Attributes = [number, number, number, number, number, number];
export interface SkillLevel { skillId: number; level: number }
export interface InventoryItem {
  bagId: number; itemId: number; count: number; type: 1 | 2;
  flags?: number; refine?: number; guid?: string; slots?: number[];
}
export interface PlayerStats {
  level: number; hp: number; maxHp: number;
  jobLevel?: number; zeny?: number; attributes?: Attributes;
  skillPoints?: number; statPoints?: number; jobExperience?: number;
  sp?: number; maxSp?: number; maxWeight?: number; weight?: number;
  cartWeight?: number; attackDelay?: number; combatStats?: number[];
}
export interface SkillResult {
  type: 'skillResult'; mode: 'self' | 'target' | 'ground'; source: number;
  skillId: number; level: number; position: Position; motionSeconds: number;
  target?: number; targetPosition?: Position; attacker?: number; damage?: number;
  result?: number; hits?: number; damageSeconds?: number; indirect?: boolean;
}
export type FeatureEvent =
  | { type: 'castStart'; id: number; skillId: number; level: number; position: Position; remainingSeconds: number; flags: number; facing?:number; target?: number; targetPosition?: Position; size?: number }
  | { type: 'castExtend'; id: number; deltaSeconds: number }
  | { type: 'castStop'; id: number }
  | { type: 'resetMotion'; id: number }
  | { type:'serverEvent'; event:number; value:number; text:string }
  | { type: 'changeTarget'; id: number }
  | ({ type: 'stats' } & PlayerStats)
  | { type: 'sp'; sp: number; maxSp: number }
  | { type: 'sit'; id: number; sitting: boolean }
  | { type: 'status'; id: number; statusId: number; seconds: number | null; refresh?: boolean }
  | { type: 'skills'; learned?: SkillLevel[]; granted?: SkillLevel[] }
  | { type: 'learnedSkill'; skillId: number; level: number; points: number }
  | { type: 'inventory'; items: InventoryItem[]; cart?: InventoryItem[]; equipment: number[]; ammoId: number }
  | { type: 'inventoryDelta'; add: boolean; bagId: number; change: number; weight: number; item?: InventoryItem }
  | { type: 'inventoryItem'; item: InventoryItem }
  | { type: 'equipment'; bagId: number; slot: number; equipped: boolean }
  | { type: 'targeted'; id: number }
  | { type: 'experience'; baseTotal: number; baseGained: number; jobTotal: number; jobGained: number }
  | { type: 'currency'; zeny: number }
  | SkillResult
  | { type: 'skillImpact'; source: number; target: number; position: Position; damage: number; damageSeconds: number; skillId: number; hits: number; result: number }
  | { type: 'featureError'; message: string }
  | { type: 'skillFailure' | 'requestFailure'; reason: number };

export type ExpandedAction =
  | { type: 'sit'; sitting: boolean }
  | { type: 'useItem'; itemId: number; target?: number }
  | { type: 'skill'; mode: 'self'; skillId: number; level: number }
  | { type: 'skill'; mode: 'target'; skillId: number; level: number; target: number }
  | { type: 'skill'; mode: 'ground'; skillId: number; level: number; position: Position }
  | { type: 'equip'; bagId: number; equipped: boolean }
  | { type: 'respawn' }
  | { type: 'allocateSkill'; skillId: number }
  | { type: 'allocateStats'; attributes: Attributes };

function bounded(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) throw new Error(`Invalid ${name}`);
  return value;
}
function positive(value: number, name = 'ID'): number { return bounded(value, 1, 0x7fffffff, name); }
function resource(value: number, name: string): number { return bounded(value, 0, 0x7fffffff, name); }
function health(value: number, max: number, name: string): void {
  resource(value, name); resource(max, name);
  if (value > max) throw new Error(`Invalid ${name}`);
}

// Each item is explicit scalar fields, not a MemoryPack object. GUID is the
// opaque 16-byte wire key, so its representation deliberately keeps wire order.
export function readItem(r: BitReader, type: number, bagId?: number): InventoryItem {
  if (type !== 1 && type !== 2) throw new Error('Unknown item type');
  const itemId = positive(r.i32(), 'item ID'); const count = bounded(r.i16(), 0, 32767, 'item count');
  const result: InventoryItem = { itemId, count, type, bagId: type === 1 ? itemId : bagId === -1 ? -1 : positive(bagId ?? itemId, 'bag ID') };
  if (type === 2) {
    result.flags = r.u8(); result.refine = r.u8();
    result.guid = Array.from(r.take(16), byte => byte.toString(16).padStart(2, '0')).join('');
    result.slots = Array.from({ length: 4 }, () => r.i32());
  }
  return result;
}

export function readInventory(r: BitReader): InventoryItem[] {
  const present = r.u8();
  if (present === 0) return [];
  if (present !== 1) throw new Error('Unknown inventory layout');
  const result: InventoryItem[] = []; const ids = new Set<number>();
  const append = (item: InventoryItem) => {
    if (!item.count || ids.has(item.bagId)) throw new Error('Invalid inventory entry');
    ids.add(item.bagId); result.push(item);
  };
  const regular = bounded(r.i32(), 0, 600, 'inventory count');
  if (regular * 48 > r.remainingBits) throw new Error('Truncated inventory');
  for (let i = 0; i < regular; i++) append(readItem(r, 1));
  const unique = bounded(r.i32(), 0, 600 - regular, 'inventory count');
  if (unique * 352 > r.remainingBits) throw new Error('Truncated inventory');
  for (let i = 0; i < unique; i++) { const bagId = positive(r.i32(), 'bag ID'); append(readItem(r, 2, bagId)); }
  return result;
}

function readSkills(r: BitReader): SkillLevel[] {
  const count = bounded(r.i16(), 0, 512, 'skill count');
  if (count * 24 > r.remainingBits) throw new Error('Truncated skills');
  const result: SkillLevel[] = []; const ids = new Set<number>();
  for (let i = 0; i < count; i++) {
    const skillId = bounded(r.i16(), 1, 32767, 'skill ID'); const level = bounded(r.u8(), 1, 255, 'skill level');
    if (ids.has(skillId)) throw new Error('Duplicate skill ID');
    ids.add(skillId); result.push({ skillId, level });
  }
  return result;
}

function readStats(r: BitReader, legacy: boolean): FeatureEvent[] {
  const data = Array.from({ length: 12 }, () => r.i32());
  const stats = Array.from({ length: 21 }, () => r.i32());
  const attackDelay = r.f32(); const weight = resource(r.i32(), 'weight'); const cartWeight = resource(r.i32(), 'cart weight');
  const level = bounded(data[0]!, 0, 1000, 'level');
  const hp = stats[0]!; const maxHp = stats[1]!; health(hp, maxHp, 'health');
  // Older source fixtures contain only the byte-aligned stat prefix. These
  // cannot imply that skills or inventory are known or empty.
  if (legacy) { r.finish(); return [{ type: 'stats', level, hp, maxHp }]; }
  const sp = stats[2]!; const maxSp = stats[3]!; health(sp, maxSp, 'SP');
  if (attackDelay < 0 || attackDelay > 60) throw new Error('Invalid attack delay');
  const event: FeatureEvent = {
    type: 'stats', level, hp, maxHp, sp, maxSp,
    jobLevel: bounded(data[1]!, 0, 1000, 'job level'), zeny: resource(data[2]!, 'zeny'),
    attributes: data.slice(3, 9) as Attributes, skillPoints: resource(data[9]!, 'skill points'),
    statPoints: resource(data[10]!, 'stat points'), jobExperience: resource(data[11]!, 'job experience'),
    maxWeight: resource(stats[20]!, 'maximum weight'), weight, cartWeight, attackDelay,
    combatStats: stats.slice(4, 20),
  };
  const events: FeatureEvent[] = [event];
  if (r.bool()) events.push({ type: 'skills', learned: readSkills(r), granted: readSkills(r) });
  if (r.bool()) {
    const items = readInventory(r); const hasCart = r.u8();
    if (hasCart > 1) throw new Error('Unknown cart layout');
    const cart = hasCart ? readInventory(r) : undefined;
    const equipment = Array.from({ length: 10 }, () => bounded(r.i32(), 0, 0x7fffffff, 'equipment ID'));
    const ammoId = bounded(r.i32(), -1, 0x7fffffff, 'ammo ID');
    events.push({ type: 'inventory', items, ...(cart ? { cart } : {}), equipment, ammoId });
  }
  r.finish(); return events;
}

function readSkillResult(r: BitReader): SkillResult {
  const mode = r.u8();
  if (mode !== 1 && mode !== 2 && mode !== 3 && mode !== 4 && mode !== 5) throw new Error('Unknown skill mode');
  const source = actorId(r.i32());
  let target: number | undefined; let attacker: number | undefined; let targetPosition: Position | undefined;
  if (mode === 4) targetPosition = r.position();
  else if (mode !== 5) { attacker = optionalWireActorId(r.i32()); target = optionalWireActorId(r.i32()); }
  const skillId = r.u8(); const level = r.u8(); const facing = r.u8(); const position = r.position();
  if (facing > 7) throw new Error('Invalid facing');
  let damage: number | undefined; let result: number | undefined; let hits: number | undefined;
  if (mode !== 4 && mode !== 5) { damage = r.i32(); result = bounded(r.u8(), 0, 8, 'skill result'); hits = r.u8(); }
  const motionSeconds = r.f32();
  const damageSeconds = mode !== 4 && mode !== 5 ? r.f32() : undefined;
  const indirect = mode === 4 ? undefined : r.bool();
  // Support results leave DamageInfo.Time at zero; the server serializes
  // Time - uptime, so their finite damage delay can be arbitrarily negative.
  if (Math.abs(motionSeconds) > 60 || (damageSeconds !== undefined && damageSeconds > 60)) throw new Error('Invalid skill timing');
  r.finish();
  return { type: 'skillResult', mode: mode === 5 ? 'self' : mode === 4 ? 'ground' : 'target', source, skillId, level,
    position, motionSeconds, ...(target !== undefined ? { target, attacker, damage, result, hits, damageSeconds } : {}),
    ...(targetPosition ? { targetPosition } : {}), ...(indirect !== undefined ? { indirect } : {}) };
}

// null means this decoder does not own the opcode. No event escapes until the
// complete supported payload (including final padding) has been validated.
function parseFeatures(data: Uint8Array): FeatureEvent[] | null {
  const r = new BitReader(data); const opcode = r.u8(); let events: FeatureEvent[];
  switch (opcode) {
    case FEATURE_OP.castStart:
    case FEATURE_OP.areaCastStart: {
      const id=actorId(r.i32());
      const target=opcode===FEATURE_OP.castStart?bounded(r.i32(),-1,0x7fffffff,'cast target'):undefined;
      const targetPosition=opcode===FEATURE_OP.areaCastStart?r.position():undefined;
      const skillId=r.u8();const level=r.u8();const size=opcode===FEATURE_OP.areaCastStart?r.u8():undefined;
      const facing=bounded(r.u8(),0,7,'cast facing');const position=r.position();const remainingSeconds=r.f32();const flags=bounded(r.u8(),0,15,'cast flags');
      events=[{type:'castStart',id,skillId,level,position,remainingSeconds,flags,facing,...(target!==undefined?{target}:{}),...(targetPosition?{targetPosition,size}:{})}];break;
    }
    case FEATURE_OP.castExtend: events=[{type:'castExtend',id:actorId(r.i32()),deltaSeconds:r.f32()}];break;
    case FEATURE_OP.changeTarget: events=[{type:'changeTarget',id:bounded(r.i32(),0,0x7fffffff,'current target')}];break;
    case FEATURE_OP.castStop: events=[{type:'castStop',id:actorId(r.i32())}];break;
    case FEATURE_OP.resetMotion: events=[{type:'resetMotion',id:actorId(r.i32())}];break;
    case FEATURE_OP.stats: return readStats(r, data.length === 145);
    case FEATURE_OP.sit: events = [{ type: 'sit', id: actorId(r.i32()), sitting: r.bool() }]; break;
    case FEATURE_OP.sp: { const sp = r.i32(); const maxSp = r.i32(); health(sp, maxSp, 'SP'); events = [{ type: 'sp', sp, maxSp }]; break; }
    case FEATURE_OP.status: {
      const id = actorId(r.i32()); const statusId = r.u8(); const seconds = r.f32();
      events = [{ type: 'status', id, statusId, seconds }]; break;
    }
    case FEATURE_OP.removeStatus: events = [{ type: 'status', id: actorId(r.i32()), statusId: r.u8(), seconds: null, refresh: r.bool() }]; break;
    case FEATURE_OP.grantedSkills: events = [{ type: 'skills', granted: readSkills(r) }]; break;
    case FEATURE_OP.learnedSkill: events = [{ type: 'learnedSkill', skillId: positive(r.u8(), 'skill ID'), level: positive(r.u8(), 'skill level'), points: resource(r.i32(), 'skill points') }]; break;
    case FEATURE_OP.inventoryDelta: {
      const add = r.bool(); const type = add ? r.u8() : undefined;
      const bagId = positive(r.i32(), 'bag ID'); const change = bounded(r.i16(), 1, 32767, 'item change'); const weight = resource(r.i32(), 'weight');
      const item = type === undefined ? undefined : readItem(r, type, bagId);
      if (item && item.bagId !== bagId) throw new Error('Invalid inventory identity');
      if (!add) r.bool();
      events = [{ type: 'inventoryDelta', add, bagId, change, weight, ...(item ? { item } : {}) }]; break;
    }
    case FEATURE_OP.inventoryItem: { const bagId=positive(r.i32(),'bag ID'); events=[{type:'inventoryItem',item:readItem(r,2,bagId)}]; break; }
    case FEATURE_OP.equipment: events = [{ type: 'equipment', bagId: positive(r.i32(), 'bag ID'), slot: bounded(r.u8(), 0, 13, 'equipment slot'), equipped: r.bool() }]; break;
    case FEATURE_OP.targeted: events = [{ type: 'targeted', id: actorId(r.i32()) }]; break;
    case FEATURE_OP.experience: events = [{ type: 'experience', baseTotal: resource(r.i32(), 'experience'), baseGained: r.i32(), jobTotal: resource(r.i32(), 'job experience'), jobGained: r.i32() }]; break;
    case FEATURE_OP.serverEvent: { const event=r.u8(),value=r.i32(),text=r.string(); events=[{type:'serverEvent',event,value,text}]; break; }
    case FEATURE_OP.currency: events = [{ type: 'currency', zeny: resource(r.i32(), 'zeny') }]; break;
    case FEATURE_OP.skill: return [readSkillResult(r)];
    case FEATURE_OP.skillImpact: {
      const source = actorId(r.i32()); const target = actorId(r.i32()); const position = r.position();
      const damage = r.i32(); const damageSeconds = r.f32(); const skillId = r.u8(); const hits = r.u8(); const result = bounded(r.u8(), 0, 8, 'skill result');
      if (damageSeconds > 60) throw new Error('Invalid skill timing');
      events = [{ type: 'skillImpact', source, target, position, damage, damageSeconds, skillId, hits, result }]; break;
    }
    case FEATURE_OP.maskedSkill: {
      const source = actorId(r.i32()); const targetPosition = r.position(); const skillId = r.u8(); const level = r.u8();
      const facing = r.u8(); const position = r.position(); const range = bounded(r.u8(), 0, 31, 'skill mask range');
      const motionSeconds = r.f32(); const indirect = r.bool();
      if (facing > 7 || Math.abs(motionSeconds) > 60) throw new Error('Invalid skill timing or facing');
      const cells = (1 + 2 * range) ** 2;
      if (cells > r.remainingBits) throw new Error('Truncated skill mask');
      for (let i = 0; i < cells; i++) r.bool();
      events = [{ type: 'skillResult', mode: 'ground', source, targetPosition, skillId, level, position, motionSeconds, indirect }]; break;
    }
    case FEATURE_OP.skillFailure: events = [{ type: 'skillFailure', reason: r.u8() }]; break;
    case FEATURE_OP.requestFailure: events = [{ type: 'requestFailure', reason: r.u8() }]; break;
    case FEATURE_OP.featureError: events = [{ type: 'featureError', message: r.string() }]; break;
    default: return null;
  }
  r.finish(); return events;
}

export class FeatureProtocolError extends Error {
  constructor(readonly opcode: number, message: string) { super(message); this.name = 'FeatureProtocolError'; }
}
export function decodeFeatures(data: Uint8Array): FeatureEvent[] | null {
  // Error classification lets the controller disable newly observed feature
  // state without confusing a feature-layout failure with movement corruption.
  // The controller must stop any rule that depends on the unavailable state.
  try { return parseFeatures(data); }
  catch (error) {
    if (Object.values(FEATURE_OP).includes(data[0] as typeof FEATURE_OP[keyof typeof FEATURE_OP])) {
      throw new FeatureProtocolError(data[0]!, error instanceof Error ? error.message : 'Invalid feature packet');
    }
    throw error;
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid feature action');
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (required.some(key => !Object.hasOwn(value, key)) || Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))) throw new Error('Unknown feature action fields');
}
function number(value: unknown, min: number, max: number, name: string): number {
  if (typeof value !== 'number') throw new Error(`Invalid ${name}`);
  return bounded(value, min, max, name);
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new Error('Invalid boolean');
  return value;
}
export function validateExpandedAction(value: unknown): ExpandedAction {
  const action = record(value);
  switch (action.type) {
    case 'sit': keys(action, ['type', 'sitting']); return { type: 'sit', sitting: boolean(action.sitting) };
    case 'useItem': {
      keys(action, ['type', 'itemId'], ['target']);
      const itemId = number(action.itemId, 1, 0x7fffffff, 'item ID');
      if (!Object.hasOwn(action, 'target')) return { type: 'useItem', itemId };
      const target = action.target === -1 ? -1 : number(action.target, 0, 0x7fffffff, 'target');
      return { type: 'useItem', itemId, target };
    }
    case 'equip': keys(action, ['type', 'bagId', 'equipped']); return { type: 'equip', bagId: number(action.bagId, 1, 0x7fffffff, 'bag ID'), equipped: boolean(action.equipped) };
    case 'respawn': keys(action, ['type']); return { type: 'respawn' };
    case 'allocateSkill': keys(action, ['type', 'skillId']); return { type: 'allocateSkill', skillId: number(action.skillId, 1, 255, 'skill ID') };
    case 'allocateStats': {
      keys(action, ['type', 'attributes']);
      if (!Array.isArray(action.attributes) || action.attributes.length !== 6) throw new Error('Invalid stat allocation');
      const attributes = action.attributes.map(item => number(item, 0, 99, 'stat allocation')) as Attributes;
      if (!attributes.some(item => item > 0)) throw new Error('Invalid stat allocation');
      return { type: 'allocateStats', attributes };
    }
    case 'skill': {
      if(action.skillId===55)throw new Error('Warp Portal requires the dedicated staged manual owner.');
      const level = number(action.level, 1, 255, 'skill level');
      if (action.mode === 'self') {
        keys(action, ['type', 'mode', 'skillId', 'level']);
        return { type: 'skill', mode: 'self', skillId: number(action.skillId, 1, 32767, 'skill ID'), level };
      }
      const skillId = number(action.skillId, 1, 255, 'skill ID');
      if (action.mode === 'target') {
        keys(action, ['type', 'mode', 'skillId', 'level', 'target']);
        return { type: 'skill', mode: 'target', skillId, level, target: number(action.target, 0, 0x7fffffff, 'target') };
      }
      if (action.mode === 'ground') {
        keys(action, ['type', 'mode', 'skillId', 'level', 'position']);
        const position = record(action.position); keys(position, ['x', 'y']);
        return { type: 'skill', mode: 'ground', skillId, level, position: { x: number(position.x, 0, 4096, 'position'), y: number(position.y, 0, 4096, 'position') } };
      }
      throw new Error('Unknown skill mode');
    }
    default: throw new Error('Unknown feature action');
  }
}

export function featureCommand(value: ExpandedAction): Uint8Array<ArrayBuffer> {
  const action = validateExpandedAction(value);
  const w = new BitWriter();
  switch (action.type) {
    case 'sit': return w.u8(FEATURE_OP.sit).bool(action.sitting).finish();
    case 'useItem': {
      const target = action.target ?? -1;
      if (target !== -1) actorId(target, 'target');
      return w.u8(FEATURE_OP.useItem).i32(positive(action.itemId, 'item ID')).i32(target).finish();
    }
    case 'equip': return w.u8(FEATURE_OP.equipment).i32(positive(action.bagId, 'bag ID')).bool(action.equipped).finish();
    case 'respawn': return w.u8(FEATURE_OP.respawn).u8(0).finish();
    case 'allocateSkill': return w.u8(FEATURE_OP.learnedSkill).u8(bounded(action.skillId, 1, 255, 'skill ID')).finish();
    case 'allocateStats': {
      if (!Array.isArray(action.attributes) || action.attributes.length !== 6 || !action.attributes.some(value => value > 0)) throw new Error('Invalid stat allocation');
      w.u8(FEATURE_OP.allocateStats);
      for (const value of action.attributes) w.i32(bounded(value, 0, 99, 'stat allocation'));
      return w.finish();
    }
    case 'skill': {
      const level = bounded(action.level, 1, 255, 'skill level');
      w.u8(FEATURE_OP.skill);
      if (action.mode === 'self') return w.u8(5).i16(bounded(action.skillId, 1, 32767, 'skill ID')).u8(level).finish();
      const skillId = bounded(action.skillId, 1, 255, 'skill ID');
      if (action.mode === 'target') return w.u8(1).i32(actorId(action.target, 'target')).u8(skillId).u8(level).finish();
      if (action.mode === 'ground') return w.u8(4).position(action.position).u8(skillId).u8(level).finish();
      throw new Error('Unknown skill mode');
    }
    default: throw new Error('Unknown feature action');
  }
}

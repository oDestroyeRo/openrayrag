import { map, take } from 'remeda';
import type { Entity } from './protocol';
import { addQuantities, mapCode as admittedMapCode, quantity, speciesId, type MapCode, type Quantity, type SpeciesId } from './domain-values';

export interface MapMonster {
  classId: number; name: string; level: number; maxHp: number;
  spawnCount: number | null; visibleCount: number;
}
export interface MapInfo {
  code: string; name: string; source: 'loading' | 'database' | 'observed'; monsters: MapMonster[];
}
/** Database admission is stricter than the live telemetry projection below. */
export interface CatalogMonster {
  readonly classId: SpeciesId; readonly name: string; readonly level: Quantity; readonly maxHp: Quantity;
  readonly spawnCount: Quantity; readonly visibleCount: Quantity;
}
export type MapCatalog = ReadonlyMap<MapCode, { readonly name: string; readonly monsters: readonly CatalogMonster[] }>;
type CatalogMonsterDraft = { -readonly [Key in keyof CatalogMonster]: CatalogMonster[Key] };
const mapCode = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);
const text = (value: unknown, limit = 128): value is string => typeof value === 'string' && value.length > 0 && value.length <= limit && !/[\x00-\x1f]/.test(value);
const integer = (value: unknown, min: number, max: number): value is number => typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid map database');
  return value as Record<string, unknown>;
}
function items(value: unknown): unknown[] {
  const list = record(value).Items;
  if (!Array.isArray(list) || list.length > 4096) throw new Error('Invalid map database');
  return list;
}

export function parseMapCatalog(mapData: unknown, monsterData: unknown): MapCatalog {
  const catalog = new Map<MapCode, { name: string; monsters: CatalogMonsterDraft[] }>();
  for (const value of items(mapData)) {
    const row = record(value);
    if (!mapCode(row.Code) || !text(row.Name) || catalog.has(admittedMapCode(row.Code))) throw new Error('Invalid map metadata');
    catalog.set(admittedMapCode(row.Code), { name: row.Name, monsters: [] });
  }
  const ids = new Set<number>();
  for (const value of items(monsterData)) {
    const row = record(value);
    if (!integer(row.Id, 1, 2_147_483_647) || ids.has(row.Id) || !text(row.Name, 64)
      || !integer(row.Level, 0, 9999) || !integer(row.HP, 0, 2_000_000_000)
      || !Array.isArray(row.Spawns) || row.Spawns.length > 4096) throw new Error('Invalid monster metadata');
    ids.add(row.Id);
    for (const value of row.Spawns) {
      const spawn = record(value);
      if (!mapCode(spawn.Map) || !integer(spawn.Count, 0, 1_000_000)) throw new Error('Invalid spawn metadata');
      if (!spawn.Count) continue;
      // Some published spawns refer to maps absent from the map-name export.
      const code = admittedMapCode(spawn.Map);
      if (!catalog.has(code)) catalog.set(code, { name: spawn.Map, monsters: [] });
      const monsters = catalog.get(code)!.monsters;
      const existing = monsters.find(monster => monster.classId === row.Id);
      if (existing) existing.spawnCount = addQuantities(existing.spawnCount, quantity(spawn.Count));
      else monsters.push({ classId: speciesId(row.Id), name: row.Name, level: quantity(row.Level), maxHp: quantity(row.HP), spawnCount: quantity(spawn.Count), visibleCount: quantity(0) });
      if (monsters.length > 128) throw new Error('Map roster exceeds its limit');
    }
  }
  return catalog;
}

export function currentMapInfo(code: string, entities: Iterable<Entity>, catalog: MapCatalog | null, loading: boolean): MapInfo {
  const metadata = mapCode(code) ? catalog?.get(admittedMapCode(code)) : undefined;
  const monsters = new Map(map(metadata?.monsters ?? [], (monster): [number, MapMonster] => [monster.classId, { ...monster }]));
  const observed = new Set<number>();
  // Aggregate before the radar's 150-entity cap; these counts are visible live
  // entities, while spawnCount is the database's configured map population.
  for (const entity of entities) {
    if (entity.kind !== 1 || entity.dead || entity.hp <= 0) continue;
    let monster = monsters.get(entity.classId);
    if (!monster) {
      monster = { classId: entity.classId, name: entity.name, level: entity.level, maxHp: entity.maxHp, spawnCount: null, visibleCount: 0 };
      monsters.set(entity.classId, monster);
    }
    if (!observed.has(entity.classId)) {
      monster.name = entity.name; monster.level = entity.level; monster.maxHp = entity.maxHp;
      observed.add(entity.classId);
    } else {
      monster.level = Math.max(monster.level, entity.level); monster.maxHp = Math.max(monster.maxHp, entity.maxHp);
    }
    monster.visibleCount++;
  }
  return { code, name: metadata?.name ?? code, source: loading ? 'loading' : metadata ? 'database' : 'observed', monsters: take([...monsters.values()],128) };
}

export function validMapInfo(value: unknown, code: string): value is MapInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Partial<MapInfo>;
  if (info.code !== code || typeof info.name !== 'string' || info.name.length > 128
    || !['loading','database','observed'].includes(info.source ?? '') || !Array.isArray(info.monsters) || info.monsters.length > 128) return false;
  const ids = new Set<number>();
  return info.monsters.every(value => {
    if (!value || typeof value !== 'object') return false;
    const m = value as Partial<MapMonster>;
    if (!integer(m.classId, 1, 2_147_483_647) || ids.has(m.classId) || !text(m.name,64)
      || !integer(m.level,0,9999) || !integer(m.maxHp,0,2_000_000_000)
      || !(m.spawnCount === null || integer(m.spawnCount,0,1_000_000_000)) || !integer(m.visibleCount,0,100_000)) return false;
    ids.add(m.classId); return true;
  });
}
/** Decode bounded HTTP response text without performing the request. */
export function parseMapDataText(data: string): unknown {
  if (data.length > 2_000_000) throw new Error('Map database exceeds its limit');
  return JSON.parse(data) as unknown;
}

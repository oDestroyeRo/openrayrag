import type { Position } from './protocol';

export const MAX_TARGETS = 64;
export interface MonsterRule { classId: number; action: 'attack' | 'ignore'; priority: number }
export interface LootRule { itemId: number; action: 'pickup' | 'ignore'; priority: number }
export interface ItemRule { itemId: number; resource: 'hp' | 'sp'; belowPercent: number; minStock: number; cooldownSeconds: number }
export interface SkillRule { skillId: number; level: number; target: 'self' | 'enemy'; hpBelowPercent: number; spAbovePercent: number; cooldownSeconds: number }
export interface EquipmentRule { itemId: number; hpBelowPercent: number; monsterClassId: number }
export interface EscapeSettings {
  enabled: boolean; hpBelowPercent: number; mode: 'random' | 'save'; method: 'item' | 'skill';
  minStock: number; cooldownSeconds: number;
}
export const DEFAULT_ESCAPE: EscapeSettings = { enabled: false, hpBelowPercent: 20, mode: 'random', method: 'item', minStock: 0, cooldownSeconds: 60 };
export interface AutomationSettings {
  combat: { mode: 'off' | 'selected' | 'retaliate' | 'both'; levelDifference: number; rules: MonsterRule[] };
  loot: { ownership: 'own' | 'all'; defaultAction: 'pickup' | 'ignore'; rules: LootRule[] };
  recovery: { enabled: boolean; hpStart: number; hpEnd: number; spStart: number; spEnd: number; timeoutSeconds: number };
  escape?: EscapeSettings;
  items: ItemRule[];
  skills: SkillRule[];
  equipment: EquipmentRule[];
  allocation: { stats: Array<{ stat: number; target: number }>; skills: Array<{ skillId: number; target: number }> };
  follow: { name: string; distance: number; lostSeconds: number };
  travel: { destinationMap: string; returnToLockMap: boolean; waypoints: Array<Position & { map: string }>; loop: boolean };
  limits: { minutes: number; kills: number; pickups: number; weightPercent: number };
  respawn: { enabled: boolean; maxDeaths: number };
  schedule: { enabled: boolean; startHour: number; endHour: number };
}
export interface Settings {
  map: string; targets: number[]; radius: number; minHpPercent: number; loot: boolean;
  route_randomWalk: 0 | 2; route_step: number; route_avoidWalls: boolean;
  route_randomWalk_maxRouteTime: number; attackRouteMaxPathDistance: number; attackMaxRouteTime: number;
  automation?: AutomationSettings;
}
export const DEFAULT_AUTOMATION: AutomationSettings = {
  combat: { mode: 'selected', levelDifference: 1, rules: [] },
  loot: { ownership: 'own', defaultAction: 'pickup', rules: [] },
  recovery: { enabled: false, hpStart: 60, hpEnd: 85, spStart: 10, spEnd: 80, timeoutSeconds: 300 },
  escape: { ...DEFAULT_ESCAPE },
  items: [], skills: [], equipment: [], allocation: { stats: [], skills: [] },
  follow: { name: '', distance: 4, lostSeconds: 10 },
  travel: { destinationMap: '', returnToLockMap: false, waypoints: [], loop: false },
  limits: { minutes: 0, kills: 0, pickups: 0, weightPercent: 0 },
  respawn: { enabled: false, maxDeaths: 1 }, schedule: { enabled: false, startHour: 0, endHour: 0 },
};
export const DEFAULT_SETTINGS: Settings = {
  map: '', targets: [], radius: 12, minHpPercent: 45, loot: true,
  route_randomWalk: 0, route_step: 10, route_avoidWalls: true,
  route_randomWalk_maxRouteTime: 75, attackRouteMaxPathDistance: 20, attackMaxRouteTime: 4,
};
const bounded = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
const id = (v: number) => bounded(v, 1, 2_147_483_647);
const map = (v: string, empty = false) => typeof v === 'string' && ((empty && v === '') || /^[a-zA-Z0-9_-]{1,64}$/.test(v));
const list = <T>(v: T[], max: number, valid: (entry: T) => boolean, key: (entry: T) => number) => Array.isArray(v)
  && v.length <= max && v.every(valid) && new Set(v.map(key)).size === v.length;
function strictKeys(v: unknown, keys: string[]): void {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k=>!keys.includes(k))) throw new Error('Unknown settings field.');
}
export function automationSettings(settings: Settings): AutomationSettings { return settings.automation ?? DEFAULT_AUTOMATION; }
export function escapeSettings(settings: Settings): EscapeSettings { return automationSettings(settings).escape ?? DEFAULT_ESCAPE; }
export function validateAutomation(a: AutomationSettings): AutomationSettings {
  try {
    strictKeys(a,['combat','loot','recovery','escape','items','skills','equipment','allocation','follow','travel','limits','respawn','schedule']);
    const escape = a.escape === undefined ? DEFAULT_ESCAPE : a.escape;
    strictKeys(escape,['enabled','hpBelowPercent','mode','method','minStock','cooldownSeconds']);
    if (typeof escape.enabled !== 'boolean' || !bounded(escape.hpBelowPercent,1,95) || !['random','save'].includes(escape.mode)
      || !['item','skill'].includes(escape.method) || !bounded(escape.minStock,0,9999) || !bounded(escape.cooldownSeconds,1,3600)) throw new Error();
    strictKeys(a.combat,['mode','levelDifference','rules']); strictKeys(a.loot,['ownership','defaultAction','rules']);
    strictKeys(a.recovery,['enabled','hpStart','hpEnd','spStart','spEnd','timeoutSeconds']); strictKeys(a.allocation,['stats','skills']);
    strictKeys(a.follow,['name','distance','lostSeconds']); strictKeys(a.travel,['destinationMap','returnToLockMap','waypoints','loop']);
    strictKeys(a.limits,['minutes','kills','pickups','weightPercent']); strictKeys(a.respawn,['enabled','maxDeaths']); strictKeys(a.schedule,['enabled','startHour','endHour']);
    for(const r of a.combat.rules) strictKeys(r,['classId','action','priority']); for(const r of a.loot.rules) strictKeys(r,['itemId','action','priority']);
    for(const r of a.items) strictKeys(r,['itemId','resource','belowPercent','minStock','cooldownSeconds']);
    for(const r of a.skills) strictKeys(r,['skillId','level','target','hpBelowPercent','spAbovePercent','cooldownSeconds']);
    for(const r of a.equipment) strictKeys(r,['itemId','hpBelowPercent','monsterClassId']);
    for(const r of a.allocation.stats) strictKeys(r,['stat','target']); for(const r of a.allocation.skills) strictKeys(r,['skillId','target']);
    for(const r of a.travel.waypoints) strictKeys(r,['map','x','y']);
    if (!['off','selected','retaliate','both'].includes(a.combat.mode) || !bounded(a.combat.levelDifference,-100,100)
      || !list(a.combat.rules,64,r=>id(r.classId)&&['attack','ignore'].includes(r.action)&&bounded(r.priority,-100,100),r=>r.classId)
      || !['own','all'].includes(a.loot.ownership) || !['pickup','ignore'].includes(a.loot.defaultAction)
      || !list(a.loot.rules,128,r=>id(r.itemId)&&['pickup','ignore'].includes(r.action)&&bounded(r.priority,-100,100),r=>r.itemId)
      || typeof a.recovery.enabled !== 'boolean' || !bounded(a.recovery.hpStart,1,95) || !bounded(a.recovery.hpEnd,2,100)
      || !bounded(a.recovery.spStart,0,95) || !bounded(a.recovery.spEnd,1,100)
      || !bounded(a.recovery.timeoutSeconds,1,3600) || a.recovery.hpStart >= a.recovery.hpEnd || a.recovery.spStart >= a.recovery.spEnd
      || !list(a.items,32,r=>id(r.itemId)&&['hp','sp'].includes(r.resource)&&bounded(r.belowPercent,1,100)&&bounded(r.minStock,0,9999)&&bounded(r.cooldownSeconds,1,3600),r=>r.itemId)
      || !list(a.skills,32,r=>bounded(r.skillId,1,255)&&bounded(r.level,1,10)&&['self','enemy'].includes(r.target)&&bounded(r.hpBelowPercent,1,100)&&bounded(r.spAbovePercent,0,100)&&bounded(r.cooldownSeconds,1,3600),r=>r.skillId)
      || !list(a.equipment,32,r=>id(r.itemId)&&bounded(r.hpBelowPercent,1,100)&&bounded(r.monsterClassId,0,2_147_483_647),r=>r.itemId)
      || !list(a.allocation.stats,6,r=>bounded(r.stat,0,5)&&bounded(r.target,1,99),r=>r.stat)
      || !list(a.allocation.skills,64,r=>bounded(r.skillId,1,255)&&bounded(r.target,1,10),r=>r.skillId)
      || typeof a.follow.name !== 'string' || a.follow.name.length > 48 || /[\u0000-\u001f]/.test(a.follow.name)
      || !bounded(a.follow.distance,1,20) || !bounded(a.follow.lostSeconds,1,120)
      || !map(a.travel.destinationMap,true) || typeof a.travel.returnToLockMap !== 'boolean' || typeof a.travel.loop !== 'boolean'
      || !Array.isArray(a.travel.waypoints) || a.travel.waypoints.length > 64
      || a.travel.waypoints.some(p=>!map(p.map)||!bounded(p.x,0,511)||!bounded(p.y,0,511))
      || !bounded(a.limits.minutes,0,1440) || !bounded(a.limits.kills,0,1_000_000) || !bounded(a.limits.pickups,0,1_000_000)
      || !bounded(a.limits.weightPercent,0,100) || typeof a.respawn.enabled !== 'boolean' || !bounded(a.respawn.maxDeaths,0,100)
      || typeof a.schedule.enabled !== 'boolean' || !bounded(a.schedule.startHour,0,23) || !bounded(a.schedule.endHour,0,23)) throw new Error();
  } catch { throw new Error('Invalid automation settings. Check rules, recovery thresholds and session limits.'); }
  return structuredClone({ ...a, escape: a.escape ?? DEFAULT_ESCAPE });
}
export function validateSettings(value: Settings): Settings {
  strictKeys(value,['map','targets','radius','minHpPercent','loot','route_randomWalk','route_step','route_avoidWalls','route_randomWalk_maxRouteTime','attackRouteMaxPathDistance','attackMaxRouteTime','automation']);
  if (!bounded(value.radius,1,20) || !bounded(value.minHpPercent,20,95)
    || ![0,2].includes(value.route_randomWalk) || !bounded(value.route_step,1,20)
    || typeof value.route_avoidWalls !== 'boolean' || !bounded(value.route_randomWalk_maxRouteTime,1,600)
    || !bounded(value.attackRouteMaxPathDistance,1,200) || !bounded(value.attackMaxRouteTime,1,60)
    || typeof value.loot !== 'boolean' || !map(value.map)
    || !Array.isArray(value.targets) || (value.targets.length < 1 && !value.automation) || value.targets.length > MAX_TARGETS
    || new Set(value.targets).size !== value.targets.length || value.targets.some(v=>!id(v))) {
    throw new Error('Invalid settings. Choose current-map monsters and valid combat and routing limits.');
  }
  const automation = value.automation ? validateAutomation(value.automation) : undefined;
  if (!value.targets.length && automation && ['selected','both'].includes(automation.combat.mode) && !automation.combat.rules.some(r=>r.action==='attack')) throw new Error('Choose selected monsters or disable selected combat.');
  if (automation?.recovery.enabled && automation.recovery.hpStart <= value.minHpPercent) throw new Error('Recovery HP start must be above the emergency HP stop limit.');
  return { ...value, targets: value.targets.slice(), ...(automation ? { automation } : {}) };
}

import { validateMapPolicy, type MapPolicy } from './map-policy-logic';
import { validateHpPotions, type HpPotionSettings } from './hp-potions';
import { validateRecoveryItems, type RecoveryItemSettings } from './recovery-items';
import type { Position } from './protocol';
import { validActorConditions, type ActorPredicate } from './actor-observations-logic';
import { validateDispositionPolicy, type DispositionPolicy, type ValidatedDispositionPolicy } from './disposition';
import { validateSupplySettings, type SupplySettings } from './supply-trip-logic';
import { itemId, skillId, speciesId, quantity, percentage, seconds, minutes, mapCode,
  type ItemId, type SkillId, type SpeciesId, type Quantity, type Percentage, type Seconds, type Minutes, type MapCode } from './domain-values';

export const MAX_TARGETS = 64;
export interface MonsterRule { classId: number; action: 'attack' | 'ignore'; priority: number; conditions?: ActorPredicate[] }
export interface LootRule { itemId: number; action: 'pickup' | 'ignore'; priority: number }
export interface ItemRule { itemId: number; resource: 'hp' | 'sp'; belowPercent: number; minStock: number; cooldownSeconds: number; conditions?: ActorPredicate[] }
export interface SkillRule { skillId: number; level: number; target: 'self' | 'enemy'; hpBelowPercent: number; spAbovePercent: number; cooldownSeconds: number; conditions?: ActorPredicate[] }
export interface AttackStrategyRule {id:string;speciesIds:number[];skillId:11|12|16;level:number;behavior:'opener'|'repeat';maxAttempts:number;maxUses:number;cooldownSeconds:number;conditions?:ActorPredicate[]}
export interface EquipmentRule { itemId: number; hpBelowPercent: number; monsterClassId: number; conditions?: ActorPredicate[] }
export interface EscapeSettings {
  enabled: boolean; hpBelowPercent: number; mode: 'random' | 'save'; method: 'item' | 'skill';
  minStock: number; cooldownSeconds: number;
  hpEnabled?: boolean; threatEnabled?: boolean; threatCount?: number; threatWindowSeconds?: number;
}
export const DEFAULT_ESCAPE: EscapeSettings = { enabled: false, hpBelowPercent: 20, mode: 'random', method: 'item', minStock: 0, cooldownSeconds: 60, hpEnabled: true, threatEnabled: false, threatCount: 3, threatWindowSeconds: 10 };
export interface LoadoutSettings { enabled: boolean; autoAmmo: boolean; minAmmoStock: number; ammoPreferences: Array<{itemId:number}>; restore: 'conditionEnd' | 'never'; cooldownSeconds: number }
export interface PartyHealSettings { enabled:boolean; level:number; hpBelowPercent:number; spReserve:number; cooldownSeconds:number; maxAttempts:number }
export const DEFAULT_PARTY_HEAL:PartyHealSettings={enabled:false,level:1,hpBelowPercent:80,spReserve:10,cooldownSeconds:3,maxAttempts:20};
export interface RetreatSettings {enabled:boolean;triggerDistance:number;desiredDistance:number;maxPathSteps:number;maxAttempts:number}
export const DEFAULT_RETREAT:RetreatSettings={enabled:false,triggerDistance:2,desiredDistance:5,maxPathSteps:12,maxAttempts:3};
export interface AutomationSettings {
  partyHeal?:PartyHealSettings;
  loadout: LoadoutSettings;
  combat: { mode: 'off' | 'selected' | 'retaliate' | 'both'; levelDifference: number; partyEngagement?: boolean; rules: MonsterRule[] };
  loot: { ownership: 'own' | 'all'; defaultAction: 'pickup' | 'ignore'; rules: LootRule[] };
  recovery: { enabled: boolean; hpStart: number; hpEnd: number; spStart: number; spEnd: number; timeoutSeconds: number };
  escape?: EscapeSettings;
  items: ItemRule[];
  hpPotions?: HpPotionSettings;
  spPotions?: RecoveryItemSettings;
  skills: SkillRule[];
  equipment: EquipmentRule[];
  attackStrategies?: AttackStrategyRule[];
  retreat?: RetreatSettings;
  allocation: { stats: Array<{ stat: number; target: number }>; skills: Array<{ skillId: number; target: number }> };
  follow: { mode?: 'name' | 'partyLeader'; rendezvous?: boolean; name: string; distance: number; lostSeconds: number };
  travel: { destinationMap: string; returnToLockMap: boolean; waypoints: Array<Position & { map: string }>; loop: boolean };
  limits: { minutes: number; kills: number; pickups: number; weightPercent: number };
  respawn: { enabled: boolean; maxDeaths: number };
  schedule: { enabled: boolean; startHour: number; endHour: number };
  disposition?: DispositionPolicy;
  supply?: SupplySettings;
  mapPolicy?: MapPolicy;
}
export interface Settings {
  map: string; targets: number[]; radius: number; minHpPercent: number; loot: boolean;
  route_randomWalk: 0 | 2; route_step: number; route_avoidWalls: boolean;
  route_randomWalk_maxRouteTime: number; attackRouteMaxPathDistance: number; attackMaxRouteTime: number;
  automation?: AutomationSettings;
}

/** Drafts and external JSON keep their original mutable scalar schema. */
export type SettingsDraft = Settings;
export type ReadonlyData<T> = T extends string | number | boolean | bigint | symbol | null | undefined ? T
  : T extends readonly (infer Value)[] ? readonly ReadonlyData<Value>[]
  : T extends object ? { readonly [Key in keyof T]: ReadonlyData<T[Key]> } : T;
export type SettingsInput = ReadonlyData<Settings>;
export type AutomationSettingsInput = ReadonlyData<AutomationSettings>;

type DomainItemRule = Omit<ItemRule, 'itemId' | 'belowPercent' | 'minStock' | 'cooldownSeconds'>
  & { itemId: ItemId; belowPercent: Percentage; minStock: Quantity; cooldownSeconds: Seconds };
type DomainSkillRule = Omit<SkillRule, 'skillId' | 'hpBelowPercent' | 'spAbovePercent' | 'cooldownSeconds'>
  & { skillId: SkillId; hpBelowPercent: Percentage; spAbovePercent: Percentage; cooldownSeconds: Seconds };
type DomainEscape = Omit<EscapeSettings, 'hpBelowPercent' | 'minStock' | 'cooldownSeconds' | 'threatWindowSeconds'>
  & { hpBelowPercent: Percentage; minStock: Quantity; cooldownSeconds: Seconds; threatWindowSeconds?: Seconds };
type DomainRecoveryItems = Omit<RecoveryItemSettings, 'itemIds' | 'belowPercent' | 'minStock' | 'cooldownSeconds'>
  & { itemIds: ItemId[]; belowPercent: Percentage; minStock: Quantity; cooldownSeconds: Seconds };
type DomainAttackStrategy = Omit<AttackStrategyRule, 'speciesIds' | 'skillId' | 'maxAttempts' | 'maxUses' | 'cooldownSeconds'>
  & { speciesIds: SpeciesId[]; skillId: SkillId & (11 | 12 | 16); maxAttempts: Quantity; maxUses: Quantity; cooldownSeconds: Seconds };
type DomainAutomation = Omit<AutomationSettings, 'loadout' | 'combat' | 'loot' | 'recovery' | 'escape' | 'items'
  | 'hpPotions' | 'spPotions' | 'skills' | 'equipment' | 'attackStrategies' | 'allocation' | 'follow' | 'travel' | 'limits' | 'partyHeal' | 'disposition'> & {
  disposition?: ValidatedDispositionPolicy;
  loadout: Omit<LoadoutSettings, 'minAmmoStock' | 'ammoPreferences' | 'cooldownSeconds'>
    & { minAmmoStock: Quantity; ammoPreferences: { itemId: ItemId }[]; cooldownSeconds: Seconds };
  combat: Omit<AutomationSettings['combat'], 'rules'> & { rules: (Omit<MonsterRule, 'classId'> & { classId: SpeciesId })[] };
  loot: Omit<AutomationSettings['loot'], 'rules'> & { rules: (Omit<LootRule, 'itemId'> & { itemId: ItemId })[] };
  recovery: Omit<AutomationSettings['recovery'], 'hpStart' | 'hpEnd' | 'spStart' | 'spEnd' | 'timeoutSeconds'>
    & { hpStart: Percentage; hpEnd: Percentage; spStart: Percentage; spEnd: Percentage; timeoutSeconds: Seconds };
  escape?: DomainEscape; items: DomainItemRule[]; hpPotions?: DomainRecoveryItems; spPotions?: DomainRecoveryItems;
  skills: DomainSkillRule[]; equipment: (Omit<EquipmentRule, 'itemId' | 'hpBelowPercent' | 'monsterClassId'>
    & { itemId: ItemId; hpBelowPercent: Percentage; monsterClassId: SpeciesId | 0 })[];
  attackStrategies?: DomainAttackStrategy[];
  allocation: Omit<AutomationSettings['allocation'], 'skills'> & { skills: { skillId: SkillId; target: number }[] };
  follow: Omit<AutomationSettings['follow'], 'lostSeconds'> & { lostSeconds: Seconds };
  travel: Omit<AutomationSettings['travel'], 'destinationMap' | 'waypoints'>
    & { destinationMap: MapCode | ''; waypoints: (Position & { map: MapCode })[] };
  limits: Omit<AutomationSettings['limits'], 'minutes' | 'kills' | 'pickups' | 'weightPercent'>
    & { minutes: Minutes; kills: Quantity; pickups: Quantity; weightPercent: Percentage };
  partyHeal?: Omit<PartyHealSettings, 'hpBelowPercent' | 'spReserve' | 'cooldownSeconds' | 'maxAttempts'>
    & { hpBelowPercent: Percentage; spReserve: Quantity; cooldownSeconds: Seconds; maxAttempts: Quantity };
};
// Erased private fields disappear from object spreads, so an edited structural
// copy must pass aggregate admission again without changing the JSON model.
declare class AutomationAdmission { private readonly automationAdmission: void }
/** Read-only decision view supports safe field filtering without claiming aggregate admission. */
export type AutomationPolicy = ReadonlyData<Omit<DomainAutomation,'disposition'>>
  & {readonly disposition?:ValidatedDispositionPolicy};
export type ValidatedAutomationSettings = AutomationPolicy & AutomationAdmission;
type DomainSettings = Omit<Settings, 'map' | 'targets' | 'minHpPercent' | 'route_randomWalk_maxRouteTime' | 'attackMaxRouteTime' | 'automation'>
  & { map: MapCode | ''; targets: SpeciesId[]; minHpPercent: Percentage;
    route_randomWalk_maxRouteTime: Seconds; attackMaxRouteTime: Seconds; automation?: ValidatedAutomationSettings };
declare class FormAdmission { private readonly formAdmission: void }
declare class RunAdmission { private readonly runAdmission: void }
export type ValidatedFormSettings = ReadonlyData<Omit<DomainSettings,'automation'>>
  & {readonly automation?:ValidatedAutomationSettings} & FormAdmission;
export type RunSettings = ValidatedFormSettings & RunAdmission;

/** Mutable editor projections are detached; admitted models remain read-only. */
export function settingsDraft(value: SettingsInput): Settings { return structuredClone(value) as Settings; }
export function automationDraft(value: AutomationSettingsInput): AutomationSettings { return structuredClone(value) as AutomationSettings; }
export const DEFAULT_LOADOUT: LoadoutSettings = { enabled:false, autoAmmo:true, minAmmoStock:0, ammoPreferences:[], restore:'conditionEnd', cooldownSeconds:3 };
export const DEFAULT_AUTOMATION: AutomationSettings = {
  loadout: DEFAULT_LOADOUT,
  combat: { mode: 'selected', levelDifference: 1, partyEngagement: false, rules: [] },
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
const list = <T>(v: readonly T[], max: number, valid: (entry: T) => boolean, key: (entry: T) => number) => Array.isArray(v)
  && v.length <= max && v.every(valid) && new Set(v.map(key)).size === v.length;
function strictKeys(v: unknown, keys: string[]): void {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k=>!keys.includes(k))) throw new Error('Unknown settings field.');
}
export function automationSettings(settings: Pick<ValidatedFormSettings, 'automation'>): ValidatedAutomationSettings;
export function automationSettings(settings: SettingsInput): AutomationSettingsInput;
export function automationSettings(settings: SettingsInput | Pick<ValidatedFormSettings, 'automation'>): AutomationSettingsInput { return settings.automation ?? VALIDATED_DEFAULT_AUTOMATION; }
export function escapeSettings(settings: SettingsInput): ReadonlyData<EscapeSettings> { return { ...DEFAULT_ESCAPE, ...automationSettings(settings).escape }; }
export function retreatSettings(settings:SettingsInput):ReadonlyData<RetreatSettings> {return automationSettings(settings).retreat??DEFAULT_RETREAT;}
export function validateRetreat(value:RetreatSettings):RetreatSettings {
  strictKeys(value,['enabled','triggerDistance','desiredDistance','maxPathSteps','maxAttempts']);
  if(typeof value.enabled!=='boolean'||!bounded(value.triggerDistance,1,13)||!bounded(value.desiredDistance,2,14)
    ||value.desiredDistance<=value.triggerDistance||!bounded(value.maxPathSteps,1,20)||!bounded(value.maxAttempts,1,10))throw new Error('Invalid ranged retreat settings.');
  return {...value};
}
export function validateAutomation(a: AutomationSettingsInput): ValidatedAutomationSettings {
  let disposition: ValidatedDispositionPolicy | undefined;
  try {
    strictKeys(a,['loadout','combat','loot','recovery','escape','items','skills','equipment','allocation','follow','travel','limits','respawn','schedule','disposition','supply','attackStrategies','mapPolicy','partyHeal','retreat','hpPotions','spPotions']);
    if(Object.hasOwn(a,'partyHeal')) {
      const h=a.partyHeal!;strictKeys(h,['enabled','level','hpBelowPercent','spReserve','cooldownSeconds','maxAttempts']);
      if(typeof h.enabled!=='boolean'||!bounded(h.level,1,10)||!bounded(h.hpBelowPercent,1,100)||!bounded(h.spReserve,0,0x7fffffff)||!bounded(h.cooldownSeconds,1,3600)||!bounded(h.maxAttempts,1,100))throw new Error();
    }
    if(Object.hasOwn(a,'hpPotions'))validateHpPotions(a.hpPotions);
    if(Object.hasOwn(a,'spPotions'))validateRecoveryItems(a.spPotions,'sp');
    if(Object.hasOwn(a,'retreat'))validateRetreat(a.retreat!);
    if (Object.hasOwn(a,'mapPolicy')) validateMapPolicy(a.mapPolicy);
    if (Object.hasOwn(a,'supply')) validateSupplySettings(a.supply);
    const escape = a.escape === undefined ? DEFAULT_ESCAPE : a.escape;
    strictKeys(escape,['enabled','hpBelowPercent','mode','method','minStock','cooldownSeconds','hpEnabled','threatEnabled','threatCount','threatWindowSeconds']);
    if (Object.hasOwn(escape,'hpEnabled') && typeof escape.hpEnabled !== 'boolean'
      || Object.hasOwn(escape,'threatEnabled') && typeof escape.threatEnabled !== 'boolean'
      || Object.hasOwn(escape,'threatCount') && !bounded(escape.threatCount!,1,64)
      || Object.hasOwn(escape,'threatWindowSeconds') && !bounded(escape.threatWindowSeconds!,1,60)) throw new Error();
    if (typeof escape.enabled !== 'boolean' || !bounded(escape.hpBelowPercent,1,95) || !['random','save'].includes(escape.mode)
      || !['item','skill'].includes(escape.method) || !bounded(escape.minStock,0,9999) || !bounded(escape.cooldownSeconds,1,3600)) throw new Error();
    if (Object.hasOwn(a,'disposition')) disposition = validateDispositionPolicy(a.disposition);
    if(Object.hasOwn(a,'attackStrategies')) {
      if(!Array.isArray(a.attackStrategies)||a.attackStrategies.length>32||new Set(a.attackStrategies.map(r=>r.id)).size!==a.attackStrategies.length)throw new Error();
      for(const r of a.attackStrategies){
        strictKeys(r,['id','speciesIds','skillId','level','behavior','maxAttempts','maxUses','cooldownSeconds','conditions']);
        if(typeof r.id!=='string'||! /^[a-zA-Z0-9_-]{1,48}$/.test(r.id)||!list(r.speciesIds,64,id,v=>v)||!r.speciesIds.length||![11,12,16].includes(r.skillId)||!bounded(r.level,1,10)||!['opener','repeat'].includes(r.behavior)||!bounded(r.maxAttempts,1,100)||!bounded(r.maxUses,1,r.maxAttempts)||!bounded(r.cooldownSeconds,1,3600)||Object.hasOwn(r,'conditions')&&!validActorConditions(r.conditions))throw new Error();
      }
    }
    if (a.loadout === undefined) a = {...a,loadout:structuredClone(DEFAULT_LOADOUT)};
    strictKeys(a.loadout,['enabled','autoAmmo','minAmmoStock','ammoPreferences','restore','cooldownSeconds']);
    for(const r of a.loadout.ammoPreferences) strictKeys(r,['itemId']);
    strictKeys(a.combat,['mode','levelDifference','rules','partyEngagement']); strictKeys(a.loot,['ownership','defaultAction','rules']);
    strictKeys(a.recovery,['enabled','hpStart','hpEnd','spStart','spEnd','timeoutSeconds']); strictKeys(a.allocation,['stats','skills']);
    strictKeys(a.follow,['name','distance','lostSeconds','mode','rendezvous']); strictKeys(a.travel,['destinationMap','returnToLockMap','waypoints','loop']);
    strictKeys(a.limits,['minutes','kills','pickups','weightPercent']); strictKeys(a.respawn,['enabled','maxDeaths']); strictKeys(a.schedule,['enabled','startHour','endHour']);
    for(const r of a.combat.rules) strictKeys(r,['classId','action','priority','conditions']); for(const r of a.loot.rules) strictKeys(r,['itemId','action','priority']);
    for(const r of a.items) strictKeys(r,['itemId','resource','belowPercent','minStock','cooldownSeconds','conditions']);
    for(const r of a.skills) strictKeys(r,['skillId','level','target','hpBelowPercent','spAbovePercent','cooldownSeconds','conditions']);
    for(const r of a.equipment) strictKeys(r,['itemId','hpBelowPercent','monsterClassId','conditions']);
    for(const r of [...a.combat.rules,...a.items,...a.skills,...a.equipment]) if(Object.hasOwn(r,'conditions')&&!validActorConditions(r.conditions,a.combat.rules.includes(r as MonsterRule))) throw new Error('Invalid actor conditions.');
    for(const r of a.allocation.stats) strictKeys(r,['stat','target']); for(const r of a.allocation.skills) strictKeys(r,['skillId','target']);
    for(const r of a.travel.waypoints) strictKeys(r,['map','x','y']);
    if (typeof a.loadout.enabled !== 'boolean' || typeof a.loadout.autoAmmo !== 'boolean'
      || !bounded(a.loadout.minAmmoStock,0,9999) || !bounded(a.loadout.cooldownSeconds,1,3600)
      || !['conditionEnd','never'].includes(a.loadout.restore) || !list(a.loadout.ammoPreferences,40,r=>id(r.itemId),r=>r.itemId)
      || a.combat.partyEngagement !== undefined && typeof a.combat.partyEngagement !== 'boolean'
      || !['off','selected','retaliate','both'].includes(a.combat.mode) || !bounded(a.combat.levelDifference,-100,100)
      || !list(a.combat.rules,64,r=>id(r.classId)&&['attack','ignore'].includes(r.action)&&bounded(r.priority,-100,100),r=>r.classId)
      || !['own','all'].includes(a.loot.ownership) || !['pickup','ignore'].includes(a.loot.defaultAction)
      || !list(a.loot.rules,128,r=>id(r.itemId)&&['pickup','ignore'].includes(r.action)&&bounded(r.priority,-100,100),r=>r.itemId)
      || typeof a.recovery.enabled !== 'boolean' || !bounded(a.recovery.hpStart,1,95) || !bounded(a.recovery.hpEnd,2,100)
      || !bounded(a.recovery.spStart,0,95) || !bounded(a.recovery.spEnd,1,100)
      || !bounded(a.recovery.timeoutSeconds,1,3600) || a.recovery.hpStart >= a.recovery.hpEnd || a.recovery.spStart >= a.recovery.spEnd
      || !list(a.items,32,r=>id(r.itemId)&&['hp','sp'].includes(r.resource)&&bounded(r.belowPercent,1,100)&&bounded(r.minStock,0,9999)&&bounded(r.cooldownSeconds,1,3600),r=>r.itemId)
      || !list(a.skills,32,r=>r.skillId!==55&&bounded(r.skillId,1,255)&&bounded(r.level,1,10)&&['self','enemy'].includes(r.target)&&bounded(r.hpBelowPercent,1,100)&&bounded(r.spAbovePercent,0,100)&&bounded(r.cooldownSeconds,1,3600),r=>r.skillId)
      || !list(a.equipment,32,r=>id(r.itemId)&&bounded(r.hpBelowPercent,1,100)&&bounded(r.monsterClassId,0,2_147_483_647),r=>r.itemId)
      || !list(a.allocation.stats,6,r=>bounded(r.stat,0,5)&&bounded(r.target,1,99),r=>r.stat)
      || !list(a.allocation.skills,64,r=>bounded(r.skillId,1,255)&&bounded(r.target,1,10),r=>r.skillId)
      || typeof a.follow.name !== 'string' || a.follow.name.length > 48 || /[\u0000-\u001f]/.test(a.follow.name)
      || Object.hasOwn(a.follow,'mode') && !['name','partyLeader'].includes(a.follow.mode!)
      || Object.hasOwn(a.follow,'rendezvous') && typeof a.follow.rendezvous !== 'boolean'
      || a.follow.mode === 'partyLeader' && a.follow.name !== ''
      || a.follow.rendezvous === true && a.follow.mode !== 'partyLeader'
      || !bounded(a.follow.distance,1,20) || !bounded(a.follow.lostSeconds,1,120)
      || !map(a.travel.destinationMap,true) || typeof a.travel.returnToLockMap !== 'boolean' || typeof a.travel.loop !== 'boolean'
      || !Array.isArray(a.travel.waypoints) || a.travel.waypoints.length > 64
      || a.travel.waypoints.some(p=>!map(p.map)||!bounded(p.x,0,511)||!bounded(p.y,0,511))
      || !bounded(a.limits.minutes,0,1440) || !bounded(a.limits.kills,0,1_000_000) || !bounded(a.limits.pickups,0,1_000_000)
      || !bounded(a.limits.weightPercent,0,100) || typeof a.respawn.enabled !== 'boolean' || !bounded(a.respawn.maxDeaths,0,100)
      || typeof a.schedule.enabled !== 'boolean' || !bounded(a.schedule.startHour,0,23) || !bounded(a.schedule.endHour,0,23)) throw new Error();
  } catch { throw new Error('Invalid automation settings. Check rules, recovery thresholds and session limits.'); }
  return admitAutomation(structuredClone({ ...a, escape: a.escape ?? DEFAULT_ESCAPE }), disposition);
}
function admitRecoveryItems(value: ReadonlyData<RecoveryItemSettings>): DomainRecoveryItems {
  return { ...value, itemIds: value.itemIds.map(value => itemId(value)), belowPercent: percentage(value.belowPercent),
    minStock: quantity(value.minStock), cooldownSeconds: seconds(value.cooldownSeconds) };
}
function admitEscape(value: ReadonlyData<EscapeSettings>): ReadonlyData<DomainEscape> {
  const { threatWindowSeconds, ...base } = value;
  return { ...base, hpBelowPercent: percentage(value.hpBelowPercent), minStock: quantity(value.minStock),
    cooldownSeconds: seconds(value.cooldownSeconds), ...(threatWindowSeconds !== undefined ? { threatWindowSeconds: seconds(threatWindowSeconds) } : {}) };
}
/** Called only after the original ordered schema checks have all succeeded. */
function admitAutomation(a: AutomationSettingsInput, disposition: ValidatedDispositionPolicy | undefined): ValidatedAutomationSettings {
  const { escape, hpPotions, spPotions, attackStrategies, partyHeal, disposition: _rawDisposition, ...base } = a;
  const domain: AutomationPolicy = { ...base,
    ...(disposition ? { disposition } : {}),
    loadout: { ...a.loadout, minAmmoStock: quantity(a.loadout.minAmmoStock), cooldownSeconds: seconds(a.loadout.cooldownSeconds),
      ammoPreferences: a.loadout.ammoPreferences.map(row => ({ itemId: itemId(row.itemId) })) },
    combat: { ...a.combat, rules: a.combat.rules.map(rule => ({ ...rule, classId: speciesId(rule.classId) })) },
    loot: { ...a.loot, rules: a.loot.rules.map(rule => ({ ...rule, itemId: itemId(rule.itemId) })) },
    recovery: { ...a.recovery, hpStart: percentage(a.recovery.hpStart), hpEnd: percentage(a.recovery.hpEnd),
      spStart: percentage(a.recovery.spStart), spEnd: percentage(a.recovery.spEnd), timeoutSeconds: seconds(a.recovery.timeoutSeconds) },
    ...(escape ? { escape: admitEscape(escape) } : {}),
    items: a.items.map(rule => ({ ...rule, itemId: itemId(rule.itemId), belowPercent: percentage(rule.belowPercent),
      minStock: quantity(rule.minStock), cooldownSeconds: seconds(rule.cooldownSeconds) })),
    skills: a.skills.map(rule => ({ ...rule, skillId: skillId(rule.skillId), hpBelowPercent: percentage(rule.hpBelowPercent),
      spAbovePercent: percentage(rule.spAbovePercent), cooldownSeconds: seconds(rule.cooldownSeconds) })),
    equipment: a.equipment.map(rule => ({ ...rule, itemId: itemId(rule.itemId), hpBelowPercent: percentage(rule.hpBelowPercent),
      monsterClassId: rule.monsterClassId === 0 ? 0 : speciesId(rule.monsterClassId) })),
    ...(hpPotions ? { hpPotions: admitRecoveryItems(hpPotions) } : {}),
    ...(spPotions ? { spPotions: admitRecoveryItems(spPotions) } : {}),
    ...(attackStrategies ? { attackStrategies: attackStrategies.map(rule => ({ ...rule, speciesIds: rule.speciesIds.map(value => speciesId(value)),
      skillId: skillId(rule.skillId) as SkillId & (11 | 12 | 16), maxAttempts: quantity(rule.maxAttempts), maxUses: quantity(rule.maxUses),
      cooldownSeconds: seconds(rule.cooldownSeconds) })) } : {}),
    allocation: { ...a.allocation, skills: a.allocation.skills.map(rule => ({ ...rule, skillId: skillId(rule.skillId) })) },
    follow: { ...a.follow, lostSeconds: seconds(a.follow.lostSeconds) },
    travel: { ...a.travel, destinationMap: a.travel.destinationMap === '' ? '' : mapCode(a.travel.destinationMap),
      waypoints: a.travel.waypoints.map(point => ({ ...point, map: mapCode(point.map) })) },
    limits: { ...a.limits, minutes: minutes(a.limits.minutes), kills: quantity(a.limits.kills), pickups: quantity(a.limits.pickups), weightPercent: percentage(a.limits.weightPercent) },
    ...(partyHeal ? { partyHeal: { ...partyHeal, hpBelowPercent: percentage(partyHeal.hpBelowPercent), spReserve: quantity(partyHeal.spReserve),
      cooldownSeconds: seconds(partyHeal.cooldownSeconds), maxAttempts: quantity(partyHeal.maxAttempts) } } : {}),
  };
  return { ...a, ...domain } as ValidatedAutomationSettings;
}
const VALIDATED_DEFAULT_AUTOMATION = validateAutomation(DEFAULT_AUTOMATION);
export function validateSettings(value: SettingsInput): RunSettings { return checkSettings(value, false) as RunSettings; }
/** A form can be configured before a map or monsters are available; Start remains stricter. */
export function validateFormSettings(value: SettingsInput): ValidatedFormSettings { return checkSettings(value, true) as ValidatedFormSettings; }
function checkSettings(value: SettingsInput, form: boolean): ReadonlyData<DomainSettings> {
  strictKeys(value,['map','targets','radius','minHpPercent','loot','route_randomWalk','route_step','route_avoidWalls','route_randomWalk_maxRouteTime','attackRouteMaxPathDistance','attackMaxRouteTime','automation']);
  if (!bounded(value.radius,1,20) || !bounded(value.minHpPercent,20,95)
    || ![0,2].includes(value.route_randomWalk) || !bounded(value.route_step,1,20)
    || typeof value.route_avoidWalls !== 'boolean' || !bounded(value.route_randomWalk_maxRouteTime,1,600)
    || !bounded(value.attackRouteMaxPathDistance,1,200) || !bounded(value.attackMaxRouteTime,1,60)
    || typeof value.loot !== 'boolean' || !map(value.map,form)
    || !Array.isArray(value.targets) || (!form && value.targets.length < 1 && !value.automation) || value.targets.length > MAX_TARGETS
    || new Set(value.targets).size !== value.targets.length || value.targets.some(v=>!id(v))) {
    throw new Error('Invalid settings. Choose current-map monsters and valid combat and routing limits.');
  }
  const automation = value.automation ? validateAutomation(value.automation) : undefined;
  if (!form && !value.targets.length && automation && ['selected','both'].includes(automation.combat.mode) && !automation.combat.rules.some(r=>r.action==='attack')) throw new Error('Choose selected monsters or disable selected combat.');
  if (automation?.mapPolicy?.lockArea && (automation.mapPolicy.lockArea.map !== value.map || (automation.travel.destinationMap && automation.travel.destinationMap !== value.map))) throw new Error('The field lock map, rectangle map and field destination must match.');
  if (automation?.recovery.enabled && automation.recovery.hpStart <= value.minHpPercent) throw new Error('Recovery HP start must be above the emergency HP stop limit.');
  const { automation: _automation, ...base } = value;
  return { ...base, map: value.map === '' ? '' : mapCode(value.map), targets: value.targets.map(value => speciesId(value)),
    minHpPercent: percentage(value.minHpPercent), route_randomWalk_maxRouteTime: seconds(value.route_randomWalk_maxRouteTime),
    attackMaxRouteTime: seconds(value.attackMaxRouteTime), ...(automation ? { automation } : {}) };
}

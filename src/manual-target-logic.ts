import { bagId as domainBagId } from './domain-values';
import type { EngagementIdentity } from './attack-strategy-logic';
import type { ActorObservationSnapshot } from './actor-observations-logic';
import type { CharacterSnapshot } from './character-state-logic';
import type { CharacterState } from './character-state';
import { AMMO_CATALOG, WEAPON_CATALOG } from './loadout-logic';
import { validateMapPolicy, type MapPolicyInput as MapPolicy } from './map-policy-logic';
import { mapDimensions } from './navigation-logic';
import type { Entity, Position } from './protocol';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, validateAutomation, type MonsterRule, type ReadonlyData, type SettingsInput as Settings } from './settings';
/** Command-only policy. No automatic action, saved run, or selected-species list. */
export interface ManualTargetPolicy {
  minHpPercent:number; routeStep:number; avoidWalls:boolean; walkSeconds:number;
  approachSeconds:number; maxPathDistance:number; levelDifference:number;
  monsterRules:ReadonlyData<MonsterRule>[]; minAmmoStock:number; mapPolicy?:MapPolicy;
}

export interface ManualTargetRequest {
  type:'manualTarget'; map:string; owner:EngagementIdentity;
  command:{type:'walk';destination:Position}|{type:'attack';target:EngagementIdentity};
  timeoutSeconds:number; policy:ManualTargetPolicy;
}

export interface ManualTargetSnapshot {
  sequence:number; kind:'walk'|'attack'|null;
  state:'idle'|'walking'|'approaching'|'attacking'|'complete'|'failed'|'cancelled';
  active:boolean; settling:boolean; reason:string; map:string;
  goal:Position|null; target:EngagementIdentity|null;
  elapsedSeconds:number; remainingSeconds:number;
}

export const IDLE_MANUAL_TARGET:ManualTargetSnapshot={sequence:0,kind:null,state:'idle',active:false,settling:false,reason:'Ready for a bounded manual command.',map:'',goal:null,target:null,elapsedSeconds:0,remainingSeconds:0};

const keys=(v:unknown,allowed:string[]):Record<string,unknown>=>{
  if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!allowed.includes(k)))throw new Error('Invalid manual target command.');
  return v as Record<string,unknown>;
};

const integer=(v:unknown,min:number,max:number):boolean=>typeof v==='number'&&Number.isInteger(v)&&v>=min&&v<=max;

export function validateActionIdentity(value:unknown):EngagementIdentity {
  const v=keys(value,['world','id','incarnation']);
  if(typeof v.world!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v.world)||!integer(v.id,0,0x7fffffff)||!integer(v.incarnation,1,0x7fffffff))throw new Error('Invalid observed actor identity.');
  return structuredClone(value) as EngagementIdentity;
}

export function validateManualTargetPolicy(value:unknown):ManualTargetPolicy {
  const v=keys(value,['minHpPercent','routeStep','avoidWalls','walkSeconds','approachSeconds','maxPathDistance','levelDifference','monsterRules','minAmmoStock','mapPolicy']);
  if(!integer(v.minHpPercent,20,95)||!integer(v.routeStep,1,20)||typeof v.avoidWalls!=='boolean'||!integer(v.walkSeconds,1,600)||!integer(v.approachSeconds,1,60)||!integer(v.maxPathDistance,1,200)||!integer(v.levelDifference,-100,100)||!integer(v.minAmmoStock,0,9999))throw new Error('Invalid bounded manual policy.');
  const automation=validateAutomation({...structuredClone(DEFAULT_AUTOMATION),combat:{mode:'selected',levelDifference:v.levelDifference as number,rules:v.monsterRules as MonsterRule[]}});
  const mapPolicy=Object.hasOwn(v,'mapPolicy')?validateMapPolicy(v.mapPolicy):undefined;
  return {minHpPercent:v.minHpPercent as number,routeStep:v.routeStep as number,avoidWalls:v.avoidWalls,
    walkSeconds:v.walkSeconds as number,approachSeconds:v.approachSeconds as number,maxPathDistance:v.maxPathDistance as number,
    levelDifference:v.levelDifference as number,minAmmoStock:v.minAmmoStock as number,
    monsterRules:automation.combat.rules.map(rule=>({...rule,conditions:rule.conditions?.map(condition=>({...condition}))})),...(mapPolicy?{mapPolicy}:{})};
}

export function manualTargetPolicy(settings:Settings):ManualTargetPolicy {
  const a=settings.automation??DEFAULT_AUTOMATION;
  return validateManualTargetPolicy({minHpPercent:settings.minHpPercent,routeStep:settings.route_step,avoidWalls:settings.route_avoidWalls,walkSeconds:settings.route_randomWalk_maxRouteTime,approachSeconds:settings.attackMaxRouteTime,maxPathDistance:settings.attackRouteMaxPathDistance,levelDifference:a.combat.levelDifference,monsterRules:a.combat.rules,minAmmoStock:a.loadout.minAmmoStock,...(a.mapPolicy?{mapPolicy:a.mapPolicy}:{})});
}

export function validateManualTargetRequest(value:unknown):ManualTargetRequest {
  if(new TextEncoder().encode(JSON.stringify(value)).length>65_536)throw new Error('Manual command exceeds its size limit.');
  const v=keys(value,['type','map','owner','command','timeoutSeconds','policy']);
  if(v.type!=='manualTarget'||typeof v.map!=='string'||!mapDimensions(v.map)||!integer(v.timeoutSeconds,1,120))throw new Error('Invalid manual command map or deadline.');
  const owner=validateActionIdentity(v.owner),policy=validateManualTargetPolicy(v.policy);
  const command=keys(v.command,['type',...(keys(v.command,['type','destination','target']).type==='walk'?['destination']:['target'])]);
  if(command.type==='walk'){
    const destination=keys(command.destination,['x','y']),grid=mapDimensions(v.map)!;
    if(!integer(destination.x,0,grid.width-1)||!integer(destination.y,0,grid.height-1))throw new Error('Destination is outside the current map.');
  } else if(command.type==='attack'){
    const target=validateActionIdentity(command.target);
    if(target.world!==owner.world)throw new Error('Target belongs to another world.');
  } else throw new Error('Unknown manual target command.');
  if(policy.mapPolicy?.lockArea&&policy.mapPolicy.lockArea.map!==v.map)throw new Error('Manual commands require the current lock map.');
  return structuredClone({...v,owner,policy}) as ManualTargetRequest;
}

/** Detached settings let existing physical route owners share exactly one navigator. */
export function manualTargetSettings(request:ManualTargetRequest):Settings {
  const p=request.policy;
  return {...DEFAULT_SETTINGS,map:request.map,targets:[],loot:false,route_step:p.routeStep,route_avoidWalls:p.avoidWalls,route_randomWalk_maxRouteTime:p.walkSeconds,attackMaxRouteTime:p.approachSeconds,attackRouteMaxPathDistance:p.maxPathDistance,minHpPercent:p.minHpPercent,automation:{...structuredClone(DEFAULT_AUTOMATION),combat:{mode:'selected',levelDifference:p.levelDifference,rules:structuredClone(p.monsterRules)},loadout:{...DEFAULT_AUTOMATION.loadout,enabled:true,autoAmmo:false,minAmmoStock:p.minAmmoStock},...(p.mapPolicy?{mapPolicy:structuredClone(p.mapPolicy)}:{})}};
}

export function manualAmmoGuard(policy:Pick<ManualTargetPolicy,'minAmmoStock'>,player:Entity,state:CharacterState|CharacterSnapshot):string|null {
  if(!state.inventoryKnown||state.equipment.length<10)return 'Verify weapon and ammo inventory before attacking.';
  const inventory=state.inventory instanceof Map?state.inventory:new Map(state.inventory.map(item=>[item.bagId,item]));
  const weaponId=state.equipment[4]??0;if(!weaponId)return null;
  const weaponItem=inventory.get(domainBagId(weaponId)),weapon=weaponItem?WEAPON_CATALOG[weaponItem.itemId]:undefined;
  if(!weapon)return 'Normal-attack weapon compatibility is not verified.';
  if(weapon.weaponClass!==12)return null;
  const item=state.ammoId>0?inventory.get(domainBagId(state.ammoId)):undefined,ammo=item?AMMO_CATALOG[item.itemId]:undefined;
  if(!item||!ammo||ammo.ammoType!==0)return 'Equip verified arrows before attacking.';
  if(player.level<ammo.minLevel)return `Ammo needs level ${ammo.minLevel}.`;
  return item.count<=policy.minAmmoStock?`Observed arrows ${item.count} reached reserve ${policy.minAmmoStock}.`:null;
}

export interface ManualPreviewContext {
  map:string; player:Entity|null; owner:EngagementIdentity|null; target:Entity|null;
  targetIdentity:EngagementIdentity|null; character:CharacterState|CharacterSnapshot;
  observations?:ActorObservationSnapshot; foreignTarget?:boolean; interactionBusy?:boolean;
  /** Engine admission can supply its receipt-bound cast fence; other callers keep observation defaults. */
  observedOwnCastSettled?:boolean;
}

export function sameActionIdentity(a:EngagementIdentity|null,b:EngagementIdentity|null):boolean {return !!a&&!!b&&a.world===b.world&&a.id===b.id&&a.incarnation===b.incarnation;}

/** Known rejection states block dispatch; unknown spawn casting does not imply idle. */
export function manualStateBlocker(kind:'walk'|'attack',c:Pick<ManualPreviewContext,'owner'|'character'|'observations'|'interactionBusy'|'observedOwnCastSettled'>,checkCast=true):string|null {
  if(c.interactionBusy)return 'Finish the NPC or vending interaction before a manual command.';
  if(kind==='attack'&&c.character.sitting===true)return 'Stand before attacking a monster.';
  const own=c.observations?.actors.find(actor=>actor.id===c.owner?.id&&actor.incarnation===c.owner.incarnation);
  return checkCast&&(c.observedOwnCastSettled===false||c.observedOwnCastSettled===undefined&&own?.cast.state==='casting')?'Wait for the observed own cast to complete or be canceled.':null;
}

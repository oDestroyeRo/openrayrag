import { validateAutomation } from '../settings/settings';
import { acceptsMonster } from '../automation/automation-logic';
import { normalAttackProfile } from './combat';
import { DEFAULT_MAP_POLICY, fieldGrid, insideLockArea, mapAllowed } from '../navigation/map-policy-logic';
import { GridNavigator, searchGrid } from '../navigation/navigation';
import type { WalkGrid } from '../navigation/navigation-logic';
import type { Position } from '../protocol/protocol';

import { type ManualTargetRequest, manualTargetSettings, manualAmmoGuard, type ManualPreviewContext, sameActionIdentity, manualStateBlocker } from './manual-target-logic';

export { type ManualTargetPolicy, type ManualTargetRequestInput, type ManualTargetRequest, type ManualTargetSnapshot, IDLE_MANUAL_TARGET, validateActionIdentity, validateManualTargetPolicy, manualTargetPolicy, validateManualTargetRequest, manualTargetSettings, manualEngineSettings, type ManualEngineSettings, manualAmmoGuard, type ManualPreviewContext, sameActionIdentity, manualStateBlocker } from './manual-target-logic';

export function previewManualTarget(request:ManualTargetRequest,c:ManualPreviewContext,gridFor:(map:string)=>WalkGrid|null=searchGrid):Position[] {
  const p=c.player,policy=request.policy,area=policy.mapPolicy??DEFAULT_MAP_POLICY;
  if(request.map!==c.map||!sameActionIdentity(request.owner,c.owner))throw new Error('Character or world changed. Preview the command again.');
  if(!p||p.dead||p.hp<=0||p.maxHp<=0||p.hp/p.maxHp*100<=policy.minHpPercent)throw new Error('A living character above the HP stop limit is required.');
  const blocker=manualStateBlocker(request.command.type,c);if(blocker)throw new Error(blocker);
  if(!mapAllowed(area,request.map)||!insideLockArea(area,request.map,p))throw new Error('Enter the allowed field area before a manual command.');
  const grid=gridFor(c.map);if(!grid)throw new Error('Map collision data is unavailable.');
  // Keep physical portal/corner checks while masking the field rectangle.
  const nav=new GridNavigator(fieldGrid(c.map,grid,area));
  if(!nav.safe(p))throw new Error('Character is outside verified walkable ground.');
  if(request.command.type==='walk'){
    const goal=request.command.destination;
    if(!insideLockArea(area,c.map,goal))throw new Error('Destination is outside the field lock area.');
    const route=nav.plan(p,goal,{avoidWalls:policy.avoidWalls});
    if(!route||!nav.validRoute(route))throw new Error('Destination has no verified safe walking route.');
    return route;
  }
  const target=c.target;
  if(!sameActionIdentity(request.command.target,c.targetIdentity)||!target||target.kind!==1||target.dead||target.hp<=0||c.foreignTarget)throw new Error('Selected monster is absent, replaced, dead or already engaged.');
  if(!insideLockArea(area,c.map,target))throw new Error('Monster is outside the field lock area.');
  const a=validateAutomation(manualTargetSettings(request).automation!);
  if(!acceptsMonster(a,target,p,[target.classId],false,c.observations))throw new Error('Monster level or conditional rules do not permit this attack.');
  const ammo=manualAmmoGuard(policy,p,c.character);if(ammo)throw new Error(ammo);
  const range=normalAttackProfile(c.character).range;
  const route=nav.plan(p,target,{range,goal:'attack',maxDistance:policy.maxPathDistance,avoidWalls:policy.avoidWalls});
  if(!route||!nav.validRoute(route))throw new Error('Monster has no verified attack approach within the path cap.');
  return route;
}

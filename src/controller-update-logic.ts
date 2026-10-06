import type { CompanionSnapshot } from './controller';
import { validateMacroCheckpoint, type MacroCheckpoint } from './macros-logic';
import { validatePartyHealCheckpoint, type PartyHealCheckpoint } from './party-heal-logic';
import { validateSettings, type Settings } from './settings';
import type { EscapeResumeGuard } from './escape-logic';
import type { SupplyResumeGuard } from './supply-trip-logic';
import type { DeathRecoveryGuard } from './death-recovery';
export interface ControllerUpdateCheckpoint {
  version:1;
  frozenAt:number;
  status:CompanionSnapshot;
  settings:Settings|null;
  macro:MacroCheckpoint|null;
  partyHeal:PartyHealCheckpoint;
  run:{startedAt:number;kills:number;pickups:number;deaths:number}|null;
}

export interface ControllerUpdateRestore {
  requestId:string; checkpoint:unknown; settings?:Settings; escapeGuard?:EscapeResumeGuard;
  supplyGuard?:SupplyResumeGuard; deathRecoveryGuard?:DeathRecoveryGuard;
}

/** Resource owners and actor observations are deliberately absent from restore authority. */
export function validateControllerUpdateCheckpoint(value:unknown,now:number):ControllerUpdateCheckpoint {
  const c=value as ControllerUpdateCheckpoint;
  if(!c||typeof c!=='object'||Array.isArray(c)||Object.keys(c).length!==7||c.version!==1
    ||!Number.isSafeInteger(c.frozenAt)||c.frozenAt<0||c.frozenAt>now
    ||!c.status||typeof c.status!=='object'||Array.isArray(c.status)||!c.status.player||typeof c.status.player.name!=='string'
    ||c.status.connected!==true||c.status.compatible!==true||c.status.running!==false||typeof c.status.runRequested!=='boolean'
    ||!c.status.macro||typeof c.status.macro.state!=='string')throw new Error('Invalid controller update checkpoint.');
  const settings=c.settings===null?null:validateSettings(c.settings);
  const macro=c.macro===null?null:validateMacroCheckpoint(c.macro);
  const partyHeal=validatePartyHealCheckpoint(c.partyHeal);
  const run=c.run;
  if(run!==null&&(!run||typeof run!=='object'||Object.keys(run).length!==4
    ||!Number.isSafeInteger(run.startedAt)||run.startedAt<0||run.startedAt>c.frozenAt
    ||![run.kills,run.pickups,run.deaths].every(n=>Number.isSafeInteger(n)&&n>=0)))throw new Error('Invalid controller run allowance checkpoint.');
  if((c.status.runRequested||macro!==null)&&(!settings||!run))throw new Error('Update continuation settings and run allowances are missing.');
  if(macro&&(macro.startedAt>c.frozenAt||macro.lastTime>c.frozenAt||macro.selector.lastTime>c.frozenAt)
    ||c.status.macro&&['running','waiting','monitoring'].includes(c.status.macro.state)!==(macro!==null)
    ||c.status.running||c.status.partyHeal&&['pending','uncertain'].includes(c.status.partyHeal.state))throw new Error('Update checkpoint has unresolved or inconsistent active ownership.');
  const cooldownSeconds=settings?.automation?.partyHeal?.enabled?settings.automation.partyHeal.cooldownSeconds:3600;
  if(partyHeal.cooldownUntil>c.frozenAt+Math.max(1,cooldownSeconds)*1000)throw new Error('Update party Heal cooldown exceeds its configured allowance.');
  return {version:1,frozenAt:c.frozenAt,status:structuredClone(c.status),settings,macro,partyHeal,run:structuredClone(run)};
}

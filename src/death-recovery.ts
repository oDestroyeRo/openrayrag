import type { Settings } from './settings';
import { mapPolicy } from './map-policy';

/** Runtime-only state: profiles contain policy, never an outstanding request. */
export interface DeathRecoveryGuard {
  version: 1; character: string; destination: string;
  phase: 'revival' | 'recovery' | 'return' | 'failed';
  uncertain: boolean; recoverySeconds: number; returnSeconds: number; recoveryDeadline: number; returnDeadline: number;
}
export function farmingDestination(settings: Settings): string {
  return mapPolicy(settings).lockArea?.map || settings.automation?.travel.destinationMap || settings.map;
}
export function deathLimitGuidance(deaths: number, allowance: number): string {
  return `Automatic respawn paused (${deaths} deaths; limit ${allowance}). Press Stop, then Start to begin a new run. Any pending game action must finish first.`;
}
export function validateDeathRecoveryGuard(value: unknown): DeathRecoveryGuard {
  const keys=['version','character','destination','phase','uncertain','recoverySeconds','returnSeconds','recoveryDeadline','returnDeadline'];
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid death recovery state.');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).length!==keys.length||Object.keys(v).some(k=>!keys.includes(k))||v.version!==1
    ||typeof v.character!=='string'||! /[^\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]/u.test(v.character)||v.character.length>64||/[\u0000-\u001f\u007f]/u.test(v.character)
    ||/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v.character)
    ||typeof v.destination!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(v.destination)
    ||typeof v.phase!=='string'||!['revival','recovery','return','failed'].includes(v.phase)||typeof v.uncertain!=='boolean'
    ||!Number.isInteger(v.recoverySeconds)||Number(v.recoverySeconds)<0||Number(v.recoverySeconds)>3600
    ||!Number.isInteger(v.returnSeconds)||Number(v.returnSeconds)<0||Number(v.returnSeconds)>1200
    ||v.phase==='recovery'&&Number(v.recoveryDeadline)<=0||v.phase==='return'&&Number(v.returnDeadline)<=0
    ||!['recoveryDeadline','returnDeadline'].every(k=>Number.isSafeInteger(v[k])&&Number(v[k])>=0&&Number(v[k])<=8640000000000000))
    throw new Error('Invalid death recovery state.');
  return structuredClone(value) as DeathRecoveryGuard;
}
export interface DeathCycle {
  guard: DeathRecoveryGuard; recoveryUntil: number | null; returnUntil: number | null;
  refresh: 'same' | 'cross' | null; ownId: number | null; reason: string;
  posture: { sitting: boolean; sequence: number; identity: string } | null;
}
export function deathCycle(guard: DeathRecoveryGuard, now: number): DeathCycle {
  guard=validateDeathRecoveryGuard(guard);
  // A caller-owned future timestamp cannot expand the finite policy duration.
  if(guard.recoveryDeadline)guard.recoveryDeadline=Math.min(guard.recoveryDeadline,now+guard.recoverySeconds*1000);
  if(guard.returnDeadline)guard.returnDeadline=Math.min(guard.returnDeadline,now+(guard.phase==='return'?guard.returnSeconds:guard.recoverySeconds+guard.returnSeconds)*1000);
  return {guard,recoveryUntil:guard.recoveryDeadline||null,
    returnUntil:guard.returnDeadline||null,refresh:null,ownId:null,reason:'',posture:null};
}
export function deathGuard(cycle: DeathCycle): DeathRecoveryGuard { return structuredClone(cycle.guard); }

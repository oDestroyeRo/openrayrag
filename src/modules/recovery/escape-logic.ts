import type { ActionIdentity } from '../world/actor-identity';
import type { ThreatSnapshot } from '../world/observed-threats-logic';
import type { CharacterState } from '../world/character-state';
import type { Entity } from '../protocol/protocol';
import type { ExpandedAction } from '../protocol/protocol-feature';
import { automationSettings, escapeSettings, type EscapeSettings, type SettingsInput as Settings } from '../settings/settings';
// These are normal player actions at protocol pin 4099e2c. Opcode 21 is an
// unrelated privileged command and is deliberately absent from this owner.
export type EscapeAction = Extract<ExpandedAction, { type: 'useItem' }> | Extract<ExpandedAction, { type: 'skill'; mode: 'self' }>;

export function escapeAction(policy: EscapeSettings): EscapeAction {
  return policy.method === 'item' ? { type: 'useItem', itemId: policy.mode === 'random' ? 601 : 602 }
    : { type: 'skill', mode: 'self', skillId: policy.mode === 'random' ? 53 : 54, level: 1 };
}

export interface EscapeContext {
  connected: boolean; compatible: boolean; fresh: boolean; map: string; playerId: number | null;
  player: Entity | undefined; character: CharacterState; connection: number;
  ready: boolean; blocker: string; movementSettled: boolean; castSettled: boolean; identity: ActionIdentity | null;
  threats: (windowSeconds: number) => ThreatSnapshot;
}

export interface EscapeSnapshot {
  state: 'idle' | 'preparing' | 'sent' | 'refreshing' | 'confirmed' | 'rejected' | 'uncertain' | 'canceled';
  reason: string; pending: boolean; consumed: boolean; cooldownSeconds: number; latched: boolean;
  recovery?: EscapeRecovery; threats?: ThreatSnapshot & { enabled: boolean; threshold: number }; trigger?: string;
}

/** Ephemeral controller-window state; never part of settings or profile export. */
export interface EscapeRecovery { hpPercent: number; threatCount: number; quietSeconds: number }

export interface EscapeResumeGuard { cooldownSeconds: number; latched: boolean; recovery?: EscapeRecovery }

export const CONSERVATIVE_ESCAPE_RECOVERY: EscapeRecovery = { hpPercent: 100, threatCount: 1, quietSeconds: 60 };

export function escapeRecovery(settings: Settings): EscapeRecovery {
  const policy = escapeSettings(settings), recovery = automationSettings(settings).recovery;
  return { hpPercent: Math.min(100, Math.max(policy.hpBelowPercent + 10, settings.minHpPercent + 1, recovery.enabled ? recovery.hpEnd : 0)),
    threatCount: policy.threatEnabled ? policy.threatCount! : 0, quietSeconds: policy.threatEnabled ? policy.threatWindowSeconds! : 0 };
}

export function validateEscapeResumeGuard(guard: EscapeResumeGuard): void {
  const recovery = guard?.recovery;
  const validRecovery = recovery === undefined && !Object.hasOwn(guard ?? {}, 'recovery') || !!recovery && typeof recovery === 'object'
    && !Array.isArray(recovery) && Object.keys(recovery).length === 3 && Object.keys(recovery).every(key => ['hpPercent','threatCount','quietSeconds'].includes(key))
    && Number.isInteger(recovery.hpPercent) && recovery.hpPercent >= 1 && recovery.hpPercent <= 100
    && Number.isInteger(recovery.threatCount) && recovery.threatCount >= 0 && recovery.threatCount <= 64
    && Number.isInteger(recovery.quietSeconds) && recovery.quietSeconds >= 0 && recovery.quietSeconds <= 60
    && (recovery.threatCount === 0 ? recovery.quietSeconds === 0 : recovery.quietSeconds >= 1);
  if (!guard || typeof guard !== 'object' || Array.isArray(guard)
    || Object.keys(guard).some(key => !['cooldownSeconds','latched','recovery'].includes(key)) || !validRecovery
    || !Number.isInteger(guard.cooldownSeconds) || guard.cooldownSeconds < 0 || guard.cooldownSeconds > 3600 || typeof guard.latched !== 'boolean')
    throw new Error('Invalid escape resume guard.');
}

export interface Request {
  action: EscapeAction; policy: EscapeSettings; identity: ActionIdentity; recovery: EscapeRecovery; name: string; id: number; map: string; connection: number;
  readyAt: number; sentAt: number | null; deadline: number; count: number; sp: number;
  refresh: 'clear' | 'map' | null; arrivalMap: string; consumed: boolean;
  reconnect: boolean; entered: boolean; spawned: boolean; resources: boolean;
  died: boolean;
}

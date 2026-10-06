import { deathLimitGuidance } from '../recovery/death-recovery';

export interface FieldIdentityState {
  connected: boolean; compatible: boolean; hasPlayer: boolean; map: string;
  dead: boolean; ownActorObserved: boolean;
}
export function fieldIdentityWaitReason(state: FieldIdentityState): string | null {
  if (!state.connected) return 'Waiting for the game to reconnect.';
  if (!state.compatible) return 'Waiting for a verified game build and protocol.';
  if (!state.hasPlayer || !state.map) return 'Waiting for the character and map to load.';
  if (!state.dead && !state.ownActorObserved) return 'Waiting for the current own actor lifetime to be observed.';
  return null;
}
export interface FieldResumeState {
  now: number; lastFrame: number; retryAt: number; originalCharacter: string; character: string;
  unresolvedWorld: boolean; weightLimit: number; weight: number | undefined; maxWeight: number | undefined;
  databasePreparing: boolean; databaseReason: string; dead: boolean; respawnEnabled: boolean;
  deaths: number; maxDeaths: number; hp: number; maxHp: number; minHpPercent: number;
  npcMode: string; npcId: number | null; vending: boolean;
}
export type FieldResumeDecision = { type: 'resume' | 'hold' } | { type: 'wait' | 'database-wait'; reason: string };
/** Decide only after the orchestration owner has settled cast/movement receipts. */
export function fieldResumeDecision(state: FieldResumeState): FieldResumeDecision {
  const wait = (reason: string): FieldResumeDecision => ({ type: 'wait', reason });
  if (state.character !== state.originalCharacter) return wait('Waiting for the originally selected character.');
  if (state.unresolvedWorld) return wait('Waiting for the canceled world request to settle or its interaction to close.');
  if (state.weightLimit) {
    if (state.weight === undefined || !state.maxWeight) return wait('Waiting for a confirmed weight update.');
    if (state.weight / state.maxWeight * 100 >= state.weightLimit) return wait('Waiting for carried weight to fall below the configured limit.');
  }
  if (state.now - state.lastFrame > 15_000) return state.databasePreparing
    ? { type: 'database-wait', reason: state.databaseReason } : wait('Waiting for a fresh server update.');
  if (state.dead && (!state.respawnEnabled || state.deaths > state.maxDeaths)) return wait(state.respawnEnabled
    ? `Death limit reached. ${deathLimitGuidance(state.deaths, state.maxDeaths)}` : 'Waiting for revival.');
  if (!state.dead && (!state.maxHp || state.hp / state.maxHp * 100 <= state.minHpPercent)) return wait('Waiting for HP to recover above the configured limit.');
  if (state.npcMode !== 'idle' || state.npcId !== null || state.vending) return wait('Waiting for the current NPC or vending interaction to finish.');
  return { type: state.now < state.retryAt ? 'hold' : 'resume' };
}

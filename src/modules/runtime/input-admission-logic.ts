import type { Action } from '../automation/engine';
import type { WorldAction } from '../protocol/world-protocol';

// Rebuild 4099e2c: InputActionDelay and Player.InInputActionCooldown.
// Keep 200 ms below the server's >1,000 ms rejection boundary. This is a
// first-request scheduling margin, not a user-configured recovery cooldown.
const RECOVERY_INPUT_BUDGET_MS = 800;
const ITEM_INPUT_COST_MS = 200;

export interface InputDebt {
  readonly milliseconds: number;
  readonly at: number | null;
  readonly active: boolean;
  readonly pending: number;
}

/** Only fixed, source-qualified costs; unsupported/variable effects stay unknown. */
export function opcodeInputCost(opcode: number | undefined): number {
  switch (opcode) {
    case 7: // destination walk
    case 11: // attack
    case 14: // sit/stand
    case 76: // NPC click
    case 78: // NPC advance
    case 107: // vending view
      return 250;
    case 8: // directional move, distinct from destination walk
      return 150;
    case 19: // Stop bypasses admission but still adds debt
    case 82: // successful immediate pickup; reserve even if unsuccessful
      return 200;
    case 47: // body is opaque: cover the known Butterfly Wing + item cost
      return 1_200;
    case 29: // body is opaque: cover the known Return-to-save skill cost
      return 1_000;
    case 13:
      return 100;
    case 41: // return-to-save respawn
    case 64: // Database adds 500 ms plus cross-map WarpPlayer's 500 ms
      return 1_000;
    default:
      return 0;
  }
}

export function actionInputCost(action: Action | WorldAction): number {
  switch (action.type) {
    case 'walk':
    case 'attack':
    case 'sit':
    case 'npcTalk':
    case 'npcAdvance':
    case 'vendingView':
      return 250;
    case 'stop':
    case 'pickup':
      return 200;
    case 'useItem':
      return action.itemId === 601 ? 700 : action.itemId === 602 ? 1_200 : 200;
    case 'skill':
      return action.skillId === 53 ? 500 : action.skillId === 54 ? 1_000 : 0;
    case 'look':
      return 100;
    case 'respawn':
      return 1_000;
    default:
      return 0;
  }
}

/** Never credit loading, stale observations, pending writes or a reversed clock. */
export function advanceInputDebt(state: InputDebt, now: number, active: boolean): InputDebt {
  if (!Number.isFinite(now)) return { ...state, active: false };
  if (state.at !== null && now < state.at) return { ...state, active: false };
  const elapsed =
    state.at !== null && state.active && active && state.pending === 0 ? now - state.at : 0;
  return {
    ...state,
    milliseconds: Math.max(0, state.milliseconds - elapsed),
    at: now,
    active,
  };
}

export function recoveryInputAvailable(state: InputDebt): boolean {
  return (
    state.active &&
    state.pending === 0 &&
    state.milliseconds + ITEM_INPUT_COST_MS <= RECOVERY_INPUT_BUDGET_MS
  );
}

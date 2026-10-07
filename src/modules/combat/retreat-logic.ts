import type { ActionIdentity } from '../world/actor-identity';
import type { Position } from '../protocol/protocol';
export interface RetreatEntry {
  identity: ActionIdentity;
  since: number;
  progress: number;
  accepted: boolean;
  attempts: number;
}

export const key = (identity: ActionIdentity) =>
  `${identity.world}:${identity.targetId}:${identity.targetIncarnation}`;

export interface RetreatPlan {
  destination: Position;
  cells: Position[];
  cost: number;
}

export interface RetreatSnapshot {
  state: 'off' | 'watching' | 'stopping' | 'walking' | 'waiting' | 'resumed' | 'skipped';
  reason: string;
  targetId: number | null;
  attempts: number;
  destination: Position | null;
  settling: boolean;
}

export const IDLE_RETREAT: RetreatSnapshot = {
  state: 'off',
  reason: 'Normal attack retreat is off.',
  targetId: null,
  attempts: 0,
  destination: null,
  settling: false,
};

export interface RetreatTask {
  identity: ActionIdentity;
  entry: RetreatEntry;
  targetPosition: Position;
  destination: Position;
  cells: Position[];
  phase: 'stopping' | 'walking' | 'cancelled';
  cleared: boolean;
  walkPending: boolean;
  walkSent: boolean;
  stopRetried: boolean;
  steps: number;
  since: number;
  movementSince: number | null;
  reason: string;
  unsentRemoval?: {
    id: number;
    name: string;
    map: string;
    world: string;
    incarnation: number;
    reason: 0 | 1;
  };
  unsentArrival?: { id: number; name: string; map: string; entry: 1 | 2 };
}

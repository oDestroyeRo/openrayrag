import type { ActionIdentity } from './actor-identity';
export const THREAT_LIMIT = 64;

export const MAX_THREAT_WINDOW_SECONDS = 60;

export interface ThreatSnapshot {
  count: number | null;
  windowSeconds: number;
  truncated: boolean;
}

export interface Observation {
  identity: ActionIdentity;
  at: number;
}

import type { ActionIdentity } from '../world/actor-identity';
import type { ActorObservations } from '../world/actor-observations';
import type { PartyActorBinding } from './party-actors-logic';
import type { PartyActorBindings } from './party-actors';
import type { MapPolicyInput as MapPolicy } from '../navigation/map-policy-logic';
import type { Entity } from '../protocol/protocol';
import type { SettingsInput as Settings } from '../settings/settings';
import type { PartyMember } from '../protocol/world-protocol';
export interface PartyFollowSnapshot {
  state:
    | 'disabled'
    | 'selecting'
    | 'following'
    | 'waiting'
    | 'preparing'
    | 'travelling'
    | 'awaitingLeader'
    | 'failed'
    | 'cancelled'
    | 'expired';
  reason: string;
  destination: string;
  remainingSeconds: number;
  attemptUsed: boolean;
  ownsTravel: boolean;
}

export function validPartyFollowSnapshot(value: unknown): value is PartyFollowSnapshot {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    Object.keys(v).length === 6 &&
    typeof v.state === 'string' &&
    [
      'disabled',
      'selecting',
      'following',
      'waiting',
      'preparing',
      'travelling',
      'awaitingLeader',
      'failed',
      'cancelled',
      'expired',
    ].includes(String(v.state)) &&
    typeof v.reason === 'string' &&
    v.reason.length <= 512 &&
    typeof v.destination === 'string' &&
    /^(?:[a-zA-Z0-9_-]{1,64})?$/.test(v.destination) &&
    typeof v.remainingSeconds === 'number' &&
    Number.isFinite(v.remainingSeconds) &&
    v.remainingSeconds >= 0 &&
    v.remainingSeconds <= 120 &&
    typeof v.attemptUsed === 'boolean' &&
    typeof v.ownsTravel === 'boolean'
  );
}

export type Party = { id: number; name: string; members: Map<number, PartyMember> } | null;

export interface PartyFollowContext {
  party: Party;
  bindings: PartyActorBindings;
  observations: ActorObservations;
  actors: ReadonlyMap<number, Entity>;
  admissionReady?: boolean;
  map: string;
  player: Entity | undefined;
  own: ActionIdentity | null;
  connection: number;
}

export interface Leader extends PartyActorBinding {
  name: string;
  partyName: string;
  epoch: number;
}

export interface MapObservation {
  partyId: number;
  entityId: number;
  map: string;
  at: number;
  revision: number;
}

export interface RendezvousAttempt {
  id: number;
  leader: Leader;
  destination: string;
  mapRevision: number;
  mapObservedAt: number;
  deadline: number;
  policy: MapPolicy;
  settings: Settings;
  connection: number;
  ownId: number;
  ownName: string;
}

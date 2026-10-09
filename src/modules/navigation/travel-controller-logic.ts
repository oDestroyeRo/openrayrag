import type { PlanningOptions } from './route-planning';
import type { MapPolicyInput as MapPolicy } from './map-policy-logic';
import type { Entity, GameEvent, Position } from '../protocol/protocol';
import type { routeBetweenMapsAsync } from './travel';
import { mapCode, milliseconds, type MapCode, type Milliseconds } from '../../shared/domain-values';
import { supportsDatabaseTravel } from './database-travel-protocol';

/** An unsent field trip carries intent and clock debt, never transport authority. */
export interface DatabaseTravelInput {
  destination: string;
  purpose: 'travel' | 'return' | 'field-entry';
  preparedAt: number;
  deadline: number;
  failed: boolean;
}
export interface DatabaseTravelCheckpoint {
  readonly destination: MapCode;
  readonly purpose: 'travel' | 'return' | 'field-entry';
  readonly preparedAt: Milliseconds;
  readonly deadline: Milliseconds;
  readonly teleportUntil: Milliseconds;
  readonly quietUntil: Milliseconds;
  readonly failed: boolean;
}
export function validateDatabaseTravelCheckpoint(
  value: unknown,
  frozenAt: number,
): DatabaseTravelCheckpoint {
  const c = value as DatabaseTravelCheckpoint;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).length !== 7 ||
    ![
      'destination',
      'purpose',
      'preparedAt',
      'deadline',
      'teleportUntil',
      'quietUntil',
      'failed',
    ].every((key) => Object.hasOwn(c, key)) ||
    !supportsDatabaseTravel(c.destination) ||
    typeof c.failed !== 'boolean' ||
    !['travel', 'return', 'field-entry'].includes(c.purpose) ||
    ![c.preparedAt, c.deadline, c.teleportUntil, c.quietUntil].every(
      (n) => Number.isSafeInteger(n) && n >= 0,
    ) ||
    c.preparedAt > frozenAt ||
    c.deadline !== c.preparedAt + 60_000 ||
    c.teleportUntil > frozenAt + 61_000 ||
    c.quietUntil > frozenAt + 2_000
  )
    throw new Error('Invalid unsent Database travel checkpoint.');
  return {
    destination: mapCode(c.destination),
    purpose: c.purpose,
    preparedAt: milliseconds(c.preparedAt),
    deadline: milliseconds(c.deadline),
    teleportUntil: milliseconds(c.teleportUntil),
    quietUntil: milliseconds(c.quietUntil),
    failed: c.failed,
  };
}
export interface TravelSnapshot {
  state: 'idle' | 'planning' | 'walking' | 'transition' | 'complete' | 'failed' | 'cancelled';
  destination: string;
  reason: string;
  policy: MapPolicy;
  purpose: 'travel' | 'service' | 'return' | 'field-entry' | 'party-follow';
  remainingMaps: string[];
  route: Position[];
  leg: Position[];
}

export interface TravelTransition {
  trip: number;
  phase: 'remove' | 'clear' | 'map' | 'spawn';
  fromMap: string;
  toMap: string;
  event: GameEvent;
}

export interface DatabaseTravelTransport {
  supported: (map: string) => boolean;
  /** Wait for server input cooldown before reserving or writing another request. */
  ready?: () => boolean;
  waitReason?: () => string;
  /** Reserve an existing owner's finite command allowance before any write. */
  reserve?: () => boolean;
  send: (map: string) => void;
}

export interface DatabaseTrip {
  trip: number;
  fromMap: string;
  toMap: string;
  ownId: number;
  ownName: string;
  identity: string;
  connection: string;
  sent: boolean;
  phase: 'source' | 'departed' | 'map';
  ready: boolean;
  contradictory: boolean;
}

export interface MovementReceipt {
  map: string;
  ownId: number;
  ownName: string;
  identity: string | null;
  requestedEnd: Position;
  cells: Position[];
  acceptedUntil: number | null;
  expectedMap: string | null;
  expectedArrival: Position | null;
  portalArea: { x: number; y: number; halfWidth: number; halfHeight: number } | null;
  awaitingSpawn: boolean;
}

export interface TravelPlanningContext {
  /** Connection, world and observed own-actor lifetime, independent of actor ID reuse. */
  identity: string | null;
  /** Stable across map/actor replacement, changed on every transport reconnect. */
  connection?: string;
  map: string;
  player: Entity | undefined;
}

export interface TravelPlanningOptions {
  context?: () => TravelPlanningContext;
  dispatchReady?: () => boolean;
  /** Retain a requested trip through current-character official movement. */
  continueRequested?: () => boolean;
  databaseTravel?: DatabaseTravelTransport;
  /** The same verified retired walk may reconcile the transport's original endpoint owner. */
  retiredWalkAccepted?: (requested: Position, accepted: Position) => void;
  scheduler?: PlanningOptions['scheduler'];
  plan?: typeof routeBetweenMapsAsync;
}

export interface PlanningRequest {
  generation: number;
  abort: AbortController;
  identity: string | null;
  start: Position;
  policy: string;
}

export const cell = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y) });

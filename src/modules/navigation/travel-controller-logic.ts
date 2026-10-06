import type { PlanningOptions } from './route-planning';
import type { MapPolicyInput as MapPolicy } from './map-policy-logic';
import type { Entity, GameEvent, Position } from '../protocol/protocol';
import type { routeBetweenMapsAsync } from './travel';
export interface TravelSnapshot {
  state: 'idle' | 'planning' | 'walking' | 'transition' | 'complete' | 'failed' | 'cancelled';
  destination: string; reason: string; policy: MapPolicy; purpose: 'travel' | 'service' | 'return' | 'field-entry' | 'party-follow'; remainingMaps: string[]; route: Position[]; leg: Position[];
}

export interface TravelTransition {
  trip:number; phase:'remove'|'clear'|'map'|'spawn'; fromMap:string; toMap:string; event:GameEvent;
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
  trip:number; fromMap:string; toMap:string; ownId:number; ownName:string; identity:string; connection:string;
  sent:boolean; phase:'source'|'departed'|'map'; ready:boolean; contradictory:boolean;
}

export interface MovementReceipt {
  map:string; ownId:number; ownName:string; identity:string|null; requestedEnd:Position; cells:Position[]; acceptedUntil:number|null;
  expectedMap:string|null; expectedArrival:Position|null; portalArea:{x:number;y:number;halfWidth:number;halfHeight:number}|null; awaitingSpawn:boolean;
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
  retiredWalkAccepted?: (requested:Position,accepted:Position) => void;
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

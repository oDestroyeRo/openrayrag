import type { ActionIdentity } from '../world/actor-identity';
export interface ObservedCast {
  identity:ActionIdentity; revision:number; capturedAt:number; remainingSeconds:number; facing:number|undefined; ambiguous:boolean;
}

export interface AvailabilityContext {
  cast:ObservedCast|null; requested:boolean; ready:boolean; exclusive:boolean; reason:string;
}

export interface Probe { cast:ObservedCast; readyAt:number; deadline:number; attempts:number; lastSent:number|null; stopped:boolean; reason:string }

export const CAST_AVAILABILITY_ATTEMPTS=6;

export const CAST_AVAILABILITY_INTERVAL=1000;

export const CAST_AVAILABILITY_WINDOW=10_000;

export const CAST_SCHEDULING_MARGIN=250;

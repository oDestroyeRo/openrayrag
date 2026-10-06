import type { AttackStrategyRule, ReadonlyData } from './settings';
import type { ObservationContext } from './actor-observations-logic';
import type { CastProfile } from './cast-policy';
import { actorId, incarnation, DomainValueError, type ActorId, type Incarnation, type WorldId } from './domain-values';

declare const engagementWorld: unique symbol;
/** Observation worlds are correlation strings, including injected non-UUID worlds. */
export type EngagementWorld = string & { readonly [engagementWorld]: true };
declare class EngagementAdmission { private readonly engagementAdmission: void }
export type EngagementIdentity = EngagementAdmission & Readonly<{
  world: EngagementWorld; id: ActorId; incarnation: Incarnation;
}>;
/** Manual requests additionally admit the existing case-insensitive UUID syntax. */
export type UuidEngagementIdentity = EngagementIdentity & Readonly<{ world: WorldId }>;

export function checkedEngagementIdentity(value: Readonly<{ world: WorldId; id: unknown; incarnation: unknown }>): UuidEngagementIdentity;
export function checkedEngagementIdentity(value: Readonly<{ world: unknown; id: unknown; incarnation: unknown }>): EngagementIdentity;
export function checkedEngagementIdentity(value: Readonly<{ world: unknown; id: unknown; incarnation: unknown }>): EngagementIdentity {
  if (typeof value.world !== 'string') throw new DomainValueError('EngagementWorld', 'type', 'engagement world');
  const identity = { world: value.world, id: actorId(value.id), incarnation: incarnation(value.incarnation) };
  // Sole constructor of the detached, erased aggregate proof; world syntax stays permissive.
  return identity as EngagementIdentity;
}

interface RuleLedger {attempts:number;uses:number;lastDispatch:number|null;uncertain:boolean;rejected:boolean}

export interface Engagement {identity:EngagementIdentity;normalStarted:boolean;rules:Map<string,RuleLedger>}

export type StrategyChoice = {state:'cast';rule:ReadonlyData<AttackStrategyRule>;profile:CastProfile;identity:EngagementIdentity}
  | {state:'wait';reason:string} | {state:'normal'};

export interface AttackStrategySnapshot {pending:boolean;entries:Array<Readonly<Pick<EngagementIdentity,'world'|'id'|'incarnation'>> & {normalStarted:boolean;rules:Array<{id:string;attempts:number;uses:number;uncertain:boolean;rejected:boolean}>}>;truncated:boolean}

export const key=(identity:EngagementIdentity)=>`${identity.world}:${identity.id}:${identity.incarnation}`;

export function engagementIdentity(id:number,context:Readonly<ObservationContext>):EngagementIdentity|null {
  return context.incarnation ? checkedEngagementIdentity({world:context.world,id,incarnation:context.incarnation}) : null;
}

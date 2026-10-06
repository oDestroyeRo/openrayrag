import type { AttackStrategyRule } from './settings';
import type { ObservationContext } from './actor-observations-logic';
import type { CastProfile } from './cast-policy';
export interface EngagementIdentity {world:string;id:number;incarnation:number}

interface RuleLedger {attempts:number;uses:number;lastDispatch:number|null;uncertain:boolean;rejected:boolean}

export interface Engagement {identity:EngagementIdentity;normalStarted:boolean;rules:Map<string,RuleLedger>}

export type StrategyChoice = {state:'cast';rule:AttackStrategyRule;profile:CastProfile;identity:EngagementIdentity}
  | {state:'wait';reason:string} | {state:'normal'};

export interface AttackStrategySnapshot {pending:boolean;entries:Array<EngagementIdentity & {normalStarted:boolean;rules:Array<{id:string;attempts:number;uses:number;uncertain:boolean;rejected:boolean}>}>;truncated:boolean}

export const key=(identity:EngagementIdentity)=>`${identity.world}:${identity.id}:${identity.incarnation}`;

export function engagementIdentity(id:number,context:ObservationContext):EngagementIdentity|null {
  return context.incarnation ? {world:context.world,id,incarnation:context.incarnation} : null;
}

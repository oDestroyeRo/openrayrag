import { filter } from 'effect/Array';
import {
  actorId,
  partyId,
  partyMemberId,
  worldId,
  incarnation,
  mapCode,
  revisionFor,
  type ActorId,
  type PartyId,
  type PartyMemberId,
  type WorldId,
  type Incarnation,
  type MapCode,
  type Revision,
} from '../../shared/domain-values';
import type { ObservationContext, PartyActorEvidence } from '../world/actor-observations-logic';
import type { PartyMember } from '../protocol/world-protocol';
export interface PartyActorBinding {
  readonly partyId: PartyId;
  readonly memberId: PartyMemberId;
  readonly entityId: ActorId;
  readonly map: MapCode;
  readonly world: WorldId;
  readonly incarnation: Incarnation;
  readonly affiliationRevision: Revision<'affiliation'>;
}

/** Admit an association only after the roster/visible lifetime owner proves it. */
export function partyActorBinding(input: {
  partyId: number;
  memberId: number;
  entityId: number;
  map: string;
  world: string;
  incarnation: number;
  affiliationRevision: number;
}): PartyActorBinding {
  if (input.entityId <= 0) throw new Error('Party actor binding requires an online member.');
  return {
    partyId: partyId(input.partyId),
    memberId: partyMemberId(input.memberId),
    entityId: actorId(input.entityId),
    map: mapCode(input.map),
    world: worldId(input.world),
    incarnation: incarnation(input.incarnation),
    affiliationRevision: revisionFor('affiliation', input.affiliationRevision),
  };
}

export type Party = { id: number; name: string; members: Map<number, PartyMember> } | null;

export interface Association {
  member: PartyMember;
  context: ObservationContext;
  actor: PartyActorEvidence | null;
  binding: PartyActorBinding | null;
  resourcesApplied: boolean;
}

/** Roster identity checks share this detached list; zero denotes offline membership. */
export const onlinePartyMembers = (members: readonly PartyMember[]): PartyMember[] =>
  filter(members, (member) => member.entityId > 0);

export const distinctPartyActors = (members: readonly PartyMember[]): boolean =>
  new Set(members.map((member) => member.entityId)).size === members.length;

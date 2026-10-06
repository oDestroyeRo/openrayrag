import { filter, uniqueBy } from 'remeda';
import type { ObservationContext, PartyActorEvidence } from './actor-observations-logic';
import type { PartyMember } from './world-protocol';
export interface PartyActorBinding {
  partyId: number; memberId: number; entityId: number; map: string;
  world: string; incarnation: number; affiliationRevision: number;
}

export type Party = { id: number; name: string; members: Map<number,PartyMember> } | null;

export interface Association {
  member: PartyMember; context: ObservationContext; actor: PartyActorEvidence | null;
  binding: PartyActorBinding | null; resourcesApplied: boolean;
}

/** Roster identity checks share this detached list; zero denotes offline membership. */
export const onlinePartyMembers = (members: readonly PartyMember[]): PartyMember[] =>
  filter(members, member => member.entityId > 0);

export const distinctPartyActors = (members: readonly PartyMember[]): boolean =>
  uniqueBy(members, member => member.entityId).length === members.length;

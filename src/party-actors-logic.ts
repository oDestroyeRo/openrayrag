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

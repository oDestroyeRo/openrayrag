import { filter, map, partition, unique } from 'remeda';
import type { EngagementIdentity } from '../combat/attack-strategy-logic';
import type { PartyActorBinding } from './party-actors-logic';
export const PARTY_ENGAGEMENT_LIMITS = { monsters: 150, sources: 8 } as const;

export const sameMonster = (a: EngagementIdentity, b: EngagementIdentity) => a.id === b.id && a.world === b.world && a.incarnation === b.incarnation;

export const samePartyBinding = (a: PartyActorBinding, b: PartyActorBinding | null): boolean => !!b
  && a.partyId === b.partyId && a.memberId === b.memberId && a.entityId === b.entityId && a.map === b.map
  && a.world === b.world && a.incarnation === b.incarnation && a.affiliationRevision === b.affiliationRevision;

export type Blocker = 'unverified source' | 'indirect or conflicting damage owner' | 'revoked party membership' | 'source capacity';

export interface PartyEngagementSnapshot { enabled: boolean; accepted: number; blocked: number; reasons: string[] }

export interface Claims { monster: EngagementIdentity; sources: Map<number, PartyActorBinding>; blocker: Blocker | null }

export const partyEngagementReason = (blocker: Blocker | null | undefined): string =>
  `Party engagement unavailable: ${blocker ?? 'no verified current party attack source'}.`;

export function partyEngagementSnapshot({ enabled, claims }: { enabled: boolean; claims: readonly Claims[] }): PartyEngagementSnapshot {
  const [blocked, unblocked] = partition(claims, row => !!row.blocker);
  return { enabled, accepted: filter(unblocked, row => row.sources.size > 0).length,
    blocked: blocked.length, reasons: unique(map(blocked, row => partyEngagementReason(row.blocker))) };
}

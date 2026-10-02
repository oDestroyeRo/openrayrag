import type { EngagementIdentity } from './attack-strategy';
import type { PartyActorBinding } from './party-actors';

export const PARTY_ENGAGEMENT_LIMITS = { monsters: 150, sources: 8 } as const;
const sameMonster = (a: EngagementIdentity, b: EngagementIdentity) => a.id === b.id && a.world === b.world && a.incarnation === b.incarnation;
export const samePartyBinding = (a: PartyActorBinding, b: PartyActorBinding | null): boolean => !!b
  && a.partyId === b.partyId && a.memberId === b.memberId && a.entityId === b.entityId && a.map === b.map
  && a.world === b.world && a.incarnation === b.incarnation && a.affiliationRevision === b.affiliationRevision;
type Blocker = 'unverified source' | 'indirect or conflicting damage owner' | 'revoked party membership' | 'source capacity';
export interface PartyEngagementSnapshot { enabled: boolean; accepted: number; blocked: number; reasons: string[] }
interface Claims { monster: EngagementIdentity; sources: Map<number, PartyActorBinding>; blocker: Blocker | null }
/** Permission evidence only. Outside participation must still prevent own kill/drop credit. */
export class PartyEngagements {
  private readonly claims = new Map<number, Claims>();
  clear(): void { this.claims.clear(); }
  remove(id: number): void { this.claims.delete(id); }
  observe(monster: EngagementIdentity, binding: PartyActorBinding | null, alreadyForeign: boolean, blocker: Blocker = 'unverified source'): void {
    let claims = this.claims.get(monster.id);
    if (claims && !sameMonster(claims.monster, monster)) { this.remove(monster.id); claims = undefined; }
    if (!claims) {
      if (this.claims.size >= PARTY_ENGAGEMENT_LIMITS.monsters) return;
      // The owner retains foreign participation even when this bounded cache was full.
      // Missing earlier provenance can never authorize a later party-only claim.
      claims = { monster: {...monster}, sources: new Map(), blocker: alreadyForeign ? 'source capacity' : null }; this.claims.set(monster.id, claims);
    }
    if (claims.blocker) return; // A later party join cannot erase an earlier foreign claim.
    if (!binding) { claims.blocker = blocker; return; }
    const old = claims.sources.get(binding.memberId);
    if (old && !samePartyBinding(old, binding)) { claims.blocker = 'revoked party membership'; return; }
    if (!old && claims.sources.size >= PARTY_ENGAGEMENT_LIMITS.sources) { claims.blocker = 'source capacity'; return; }
    claims.sources.set(binding.memberId, {...binding});
  }
  invalidateMember(memberId?: number): number[] {
    const revoked: number[] = [];
    for (const claims of this.claims.values()) if (!claims.blocker && (memberId === undefined || claims.sources.has(memberId))) {
      claims.blocker = 'revoked party membership'; revoked.push(claims.monster.id);
    }
    return revoked;
  }
  /** Call at every membership edge, including a leave/rejoin within one decision tick. */
  refresh(bindingFor: (entityId: number) => PartyActorBinding | null): number[] {
    const revoked: number[] = [];
    for (const claims of this.claims.values()) if (!claims.blocker) {
      for (const binding of claims.sources.values()) if (!samePartyBinding(binding, bindingFor(binding.entityId))) {
        claims.blocker = 'revoked party membership'; revoked.push(claims.monster.id); break;
      }
    }
    return revoked;
  }
  allows(monster: EngagementIdentity): boolean {
    const claims = this.claims.get(monster.id);
    return !!claims && sameMonster(claims.monster, monster) && !claims.blocker && claims.sources.size > 0;
  }
  snapshot(enabled: boolean): PartyEngagementSnapshot {
    const values = [...this.claims.values()], reasons = [...new Set(values.flatMap(row => row.blocker ? [this.reason(row.monster.id)] : []))];
    return { enabled, accepted: values.filter(row => !row.blocker && row.sources.size > 0).length,
      blocked: values.filter(row => !!row.blocker).length, reasons };
  }
  reason(id: number): string {
    return `Party engagement unavailable: ${this.claims.get(id)?.blocker ?? 'no verified current party attack source'}.`;
  }
}

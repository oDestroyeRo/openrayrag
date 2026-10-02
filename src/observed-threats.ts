import { sameActionIdentity, type ActionIdentity } from './actor-identity';

export const THREAT_LIMIT = 64;
export const MAX_THREAT_WINDOW_SECONDS = 60;
export interface ThreatSnapshot { count: number | null; windowSeconds: number; truncated: boolean }
interface Observation { identity: ActionIdentity; at: number }
/** Recent decoded Attack observations, never a claim about server aggro. */
export class ObservedThreats {
  private own: ActionIdentity | null = null;
  private readonly records = new Map<number, Observation>();
  private lastAt = 0;
  private truncatedUntil = 0;
  reset(): void { this.own = null; this.records.clear(); this.truncatedUntil = 0; }
  private synchronize(own: ActionIdentity | null, now: number, current: (id: number) => ActionIdentity | null): void {
    if (!sameActionIdentity(this.own, own) || now < this.lastAt) this.reset();
    this.own = own; this.lastAt = now;
    for (const [id, observation] of this.records) {
      if (now < observation.at || now - observation.at >= MAX_THREAT_WINDOW_SECONDS * 1000
        || !sameActionIdentity(observation.identity, current(id))) this.records.delete(id);
    }
  }
  observe(source: number, target: number, own: ActionIdentity | null, identity: ActionIdentity | null,
    observedAt: number, now: number, current: (id: number) => ActionIdentity | null): void {
    this.synchronize(own, now, current);
    if (!own || target !== own.selfId || source < 0 || !Number.isSafeInteger(observedAt) || observedAt < 0 || observedAt > now) return;
    if (!identity || identity.targetId !== source || !sameActionIdentity(identity, current(source))
      || identity.world !== own.world || identity.selfId !== own.selfId || identity.selfIncarnation !== own.selfIncarnation) return;
    if (this.records.has(source) && observedAt < this.records.get(source)!.at) return;
    if (!this.records.has(source) && this.records.size >= THREAT_LIMIT) {
      this.truncatedUntil = Math.max(this.truncatedUntil, observedAt + MAX_THREAT_WINDOW_SECONDS * 1000); return;
    }
    this.records.set(source, { identity: { ...identity }, at: observedAt });
  }
  unavailable(now: number): void { this.truncatedUntil = Math.max(this.truncatedUntil, now + MAX_THREAT_WINDOW_SECONDS * 1000); }
  snapshot(windowSeconds: number, own: ActionIdentity | null, now: number, current: (id: number) => ActionIdentity | null): ThreatSnapshot {
    this.synchronize(own, now, current);
    const truncated = now < this.truncatedUntil;
    return { count: !own || truncated ? null : [...this.records.values()].filter(record => now - record.at < windowSeconds * 1000).length,
      windowSeconds, truncated };
  }
}

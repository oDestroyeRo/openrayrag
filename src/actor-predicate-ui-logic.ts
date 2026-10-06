import { validActorSnapshot, type ActorObservationSnapshot, type ActorSelector } from './actor-observations-logic';

/** Refresh observation time in a detached snapshot without reading the clock. */
export function actorSnapshotAt(value: unknown, at: number): ActorObservationSnapshot | undefined {
  return validActorSnapshot(value) ? { ...structuredClone(value), at } : undefined;
}
export function observedActorChoices(snapshot: ActorObservationSnapshot | undefined): { value: string; label: string }[] {
  return (snapshot?.actors ?? []).filter(actor => actor.kind === 0 || actor.kind === 1)
    .map(actor => ({ value: String(actor.id), label: `${actor.name || 'Actor'} · #${actor.id}` }));
}
export function bindObservedActor(snapshot: ActorObservationSnapshot | undefined, value: string): ActorSelector | undefined {
  const selected = snapshot?.actors.find(actor => String(actor.id) === value);
  return snapshot && selected ? { scope: 'actor', id: selected.id, world: snapshot.world, incarnation: selected.incarnation } : undefined;
}

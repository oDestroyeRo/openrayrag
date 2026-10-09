import {
  actorPredicateEvaluator,
  type ActorObservationSnapshot,
  type ActorPredicate,
} from '../world/actor-observations-logic';

// Rebuild 4099e2c: these effects add Disabled, or the item's explicit Hidden
// rejection. Cloaking and Petrifying have distinct body flags and are excluded.
const blockers = [
  { id: 2, name: 'Stun' },
  { id: 3, name: 'Sleep' },
  { id: 4, name: 'Frozen' },
  { id: 10, name: 'Stone' },
  { id: 26, name: 'Hiding' },
] as const;

export const RECOVERY_ITEM_CONDITIONS: readonly ActorPredicate[] = blockers.map(({ id }) => ({
  field: 'actorStatus',
  actor: { scope: 'self' },
  statusId: id,
  operator: 'eq',
  value: true,
}));

/** Unknown, expired or stale evidence never becomes a positive rejection hint. */
export function recoveryItemStatusWait(observations: ActorObservationSnapshot): string | null {
  const evaluate = actorPredicateEvaluator(observations);
  for (let i = 0; i < blockers.length; i++)
    if (evaluate(RECOVERY_ITEM_CONDITIONS[i]!).state === 'matched')
      return `Waiting while ${blockers[i]!.name} is observed before automatic recovery.`;
  return null;
}

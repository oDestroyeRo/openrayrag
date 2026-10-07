import { map } from 'effect/Array';
import type { ConditionState } from '../../shared/condition-logic';
import { SUPPORTED_STATUS_IDS } from './actor-status-catalog';
import {
  resourceFresh,
  compareResource,
  validResourceObservation,
  RESOURCE_OPERATORS,
  type ResourceObservation,
  type ResourceOperator,
} from './actor-resources';
export const ACTOR_OBSERVATION_LIMITS = {
  actors: 300,
  publishedActors: 64,
  publishedStatuses: 128,
  evaluatedStatuses: 512,
  conditionReports: 8,
  conditionsPerReport: 4,
  conditions: 16,
  staleMs: 15_000,
} as const;

export const PERMANENT_STATUS_SECONDS = Math.fround(3.4028234663852886e38);

export type ActorSelector =
  | { scope: 'self' }
  | { scope: 'target' }
  | { scope: 'candidate' }
  | { scope: 'actor'; id: number; world: string; incarnation: number };

export type ActorPredicate =
  | {
      field: 'actorStatus';
      actor: ActorSelector;
      statusId: number;
      operator: 'eq' | 'ne';
      value: boolean;
    }
  | {
      field: 'actorCasting';
      actor: ActorSelector;
      skillId?: number;
      operator: 'eq' | 'ne';
      value: boolean;
    }
  | { field: 'actorHpPercent'; actor: ActorSelector; operator: ResourceOperator; value: number }
  | { field: 'actorSpPercent'; actor: ActorSelector; operator: ResourceOperator; value: number };

export interface PredicateTrace {
  condition: ActorPredicate;
  state: ConditionState;
  reason: string;
}

export interface StatusObservation {
  id: number;
  known: boolean;
  present: boolean;
  observedAt: number;
  expiresAt: number | null;
}

interface CastObservation {
  state: 'unknown' | 'casting' | 'idle';
  observedAt: number | null;
  deadline: number | null;
  skillId: number | null;
}

export interface ActorObservation {
  id: number;
  incarnation: number;
  kind: number;
  name: string;
  observedAt: number;
  statusesKnown: boolean;
  statuses: StatusObservation[];
  cast: CastObservation;
  hp?: ResourceObservation;
  sp?: ResourceObservation;
}

export interface ActorObservationSnapshot {
  world: string;
  at: number;
  lastFrameAt: number | null;
  connected: boolean;
  selfId: number | null;
  targetId: number | null;
  candidateId?: number | null;
  truncated?: boolean;
  actors: ActorObservation[];
}

export interface ObservationContext {
  world: string;
  at: number;
  incarnation?: number;
  sequence?: number;
}

export interface PartyActorEvidence {
  world: string;
  incarnation: number;
  kind: number;
  name: string;
  partyId: number | null;
  partyName: string | null;
  affiliationRevision: number;
}

export interface RecordState extends Omit<ActorObservation, 'statuses'> {
  statuses: Map<number, StatusObservation>;
  startedAt: number;
  visibleAt: number;
  hpSequence: number;
  spSequence: number;
  hpUsesParty: boolean;
  partyId: number | null;
  partyName: string | null;
  affiliationRevision: number;
  affiliationSequence: number;
  affiliationAt: number;
  partyHp?: ResourceObservation;
  partySp?: ResourceObservation;
}

const uuid = (v: unknown): v is string =>
  typeof v === 'string' && /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/.test(v);

const integer = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

export const keys = (v: Record<string, unknown>, required: string[], optional: string[] = []) =>
  required.every((key) => Object.hasOwn(v, key)) &&
  Object.keys(v).every((key) => required.includes(key) || optional.includes(key));

export function validActorSelector(value: unknown): value is ActorSelector {
  if (!record(value)) return false;
  if (value.scope === 'self' || value.scope === 'target' || value.scope === 'candidate')
    return keys(value, ['scope']);
  return (
    value.scope === 'actor' &&
    keys(value, ['scope', 'id', 'world', 'incarnation']) &&
    uuid(value.world) &&
    integer(value.id, 0, 0x7fffffff) &&
    integer(value.incarnation, 1, 0x7fffffff)
  );
}

export function validActorPredicate(
  value: unknown,
  allowCandidate = false,
): value is ActorPredicate {
  if (
    !record(value) ||
    !validActorSelector(value.actor) ||
    (value.actor.scope === 'candidate' && !allowCandidate)
  )
    return false;
  if (value.field === 'actorHpPercent' || value.field === 'actorSpPercent')
    return (
      keys(value, ['field', 'actor', 'operator', 'value']) &&
      RESOURCE_OPERATORS.includes(value.operator as ResourceOperator) &&
      typeof value.value === 'number' &&
      Number.isFinite(value.value) &&
      value.value >= 0 &&
      value.value <= 100
    );
  if ((value.operator !== 'eq' && value.operator !== 'ne') || typeof value.value !== 'boolean')
    return false;
  if (value.field === 'actorStatus')
    return (
      keys(value, ['field', 'actor', 'statusId', 'operator', 'value']) &&
      integer(value.statusId, 1, 255)
    );
  return (
    value.field === 'actorCasting' &&
    keys(value, ['field', 'actor', 'operator', 'value'], ['skillId']) &&
    (!Object.hasOwn(value, 'skillId') || integer(value.skillId, 1, 255))
  );
}

export function validActorConditions(
  value: unknown,
  allowCandidate = false,
): value is ActorPredicate[] {
  return (
    Array.isArray(value) &&
    value.length <= ACTOR_OBSERVATION_LIMITS.conditions &&
    value.every((condition) => validActorPredicate(condition, allowCandidate))
  );
}

export const clock = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isFinite(value) &&
  value >= 0 &&
  value <= Number.MAX_SAFE_INTEGER;

export function validActorSnapshot(value: unknown): value is ActorObservationSnapshot {
  if (
    !record(value) ||
    !keys(
      value,
      ['world', 'at', 'lastFrameAt', 'connected', 'selfId', 'targetId', 'actors'],
      ['candidateId', 'truncated'],
    ) ||
    !uuid(value.world) ||
    !clock(value.at) ||
    !(value.lastFrameAt === null || clock(value.lastFrameAt)) ||
    typeof value.connected !== 'boolean' ||
    !(value.selfId === null || integer(value.selfId, 0, 0x7fffffff)) ||
    !(value.truncated === undefined || typeof value.truncated === 'boolean') ||
    !(
      value.candidateId === undefined ||
      value.candidateId === null ||
      integer(value.candidateId, 0, 0x7fffffff)
    ) ||
    !(value.targetId === null || integer(value.targetId, 0, 0x7fffffff)) ||
    !Array.isArray(value.actors) ||
    value.actors.length > 64
  )
    return false;
  let statuses = 0;
  const actorIds = new Set<number>();
  return value.actors.every((actor) => {
    if (
      !record(actor) ||
      !keys(
        actor,
        ['id', 'incarnation', 'kind', 'name', 'observedAt', 'statusesKnown', 'statuses', 'cast'],
        ['hp', 'sp'],
      ) ||
      !integer(actor.id, 0, 0x7fffffff) ||
      !integer(actor.incarnation, 1, 0x7fffffff) ||
      !integer(actor.kind, 0, 4) ||
      typeof actor.name !== 'string' ||
      actor.name.length > 64 ||
      !clock(actor.observedAt) ||
      typeof actor.statusesKnown !== 'boolean' ||
      !Array.isArray(actor.statuses) ||
      actor.statuses.length > 128 ||
      (statuses += actor.statuses.length) > 512 ||
      !record(actor.cast) ||
      (Object.hasOwn(actor, 'hp') && !validResourceObservation(actor.hp)) ||
      (Object.hasOwn(actor, 'sp') && !validResourceObservation(actor.sp))
    )
      return false;
    if (actorIds.has(actor.id)) return false;
    actorIds.add(actor.id);
    const statusIds = new Set<number>();
    if (
      !actor.statuses.every((status) => {
        if (!record(status) || typeof status.id !== 'number' || statusIds.has(status.id))
          return false;
        statusIds.add(status.id);
        return true;
      })
    )
      return false;
    const cast = actor.cast;
    if (!keys(cast, ['state', 'observedAt', 'deadline', 'skillId'])) return false;
    return (
      (cast.state === 'unknown' || cast.state === 'casting' || cast.state === 'idle') &&
      (cast.observedAt === null || clock(cast.observedAt)) &&
      (cast.deadline === null || clock(cast.deadline)) &&
      (cast.skillId === null || integer(cast.skillId, 0, 255)) &&
      actor.statuses.every(
        (status) =>
          record(status) &&
          keys(status, ['id', 'known', 'present', 'observedAt', 'expiresAt']) &&
          integer(status.id, 1, 255) &&
          typeof status.known === 'boolean' &&
          typeof status.present === 'boolean' &&
          clock(status.observedAt) &&
          (status.expiresAt === null || clock(status.expiresAt)),
      )
    );
  });
}

/** Bind read-only observation inputs for one synchronous evaluation pass.
 * Do not retain this evaluator across ticks or mutate its snapshot while using it. */
export function actorPredicateEvaluator(
  snapshot: ActorObservationSnapshot | undefined,
): (condition: ActorPredicate) => PredicateTrace {
  return (condition) => {
    const trace = (state: PredicateTrace['state'], reason: string): PredicateTrace => ({
      condition: structuredClone(condition),
      state,
      reason,
    });
    if (!validActorPredicate(condition, true))
      return trace('unavailable', 'Actor condition has invalid fields or threshold.');
    if (
      !snapshot ||
      !snapshot.connected ||
      snapshot.lastFrameAt === null ||
      snapshot.at < snapshot.lastFrameAt ||
      snapshot.at - snapshot.lastFrameAt > ACTOR_OBSERVATION_LIMITS.staleMs
    )
      return trace('unavailable', 'Actor observations need a fresh connected world.');
    const selector = condition.actor;
    if (selector.scope === 'actor' && selector.world !== snapshot.world)
      return trace(
        'unavailable',
        'Observed actor belongs to an earlier world. Rebind this condition.',
      );
    const id =
      selector.scope === 'self'
        ? snapshot.selfId
        : selector.scope === 'target'
          ? snapshot.targetId
          : selector.scope === 'candidate'
            ? snapshot.candidateId
            : selector.id;
    const actor = snapshot.actors.find((actor) => actor.id === id);
    if (!actor && snapshot.truncated)
      return trace('unavailable', 'Actor observations were truncated; inspect fewer actors.');
    if (!actor || (selector.scope === 'actor' && actor.incarnation !== selector.incarnation))
      return trace(
        'unavailable',
        'Actor is absent or its lifetime changed. Rebind an observed actor.',
      );
    if (actor.kind !== 0 && actor.kind !== 1)
      return trace('unavailable', 'Actor evidence is supported for players and monsters only.');
    if (actor.observedAt > snapshot.at)
      return trace('unavailable', 'Actor observation clock is unavailable.');
    if (condition.field === 'actorHpPercent' || condition.field === 'actorSpPercent') {
      if (selector.scope === 'candidate' && actor.kind !== 1)
        return trace('unavailable', 'Candidate resources require a monster.');
      const resource = condition.field === 'actorHpPercent' ? actor.hp : actor.sp;
      const label = condition.field === 'actorHpPercent' ? 'HP' : 'SP';
      if (!resource || resource.reason !== null)
        return trace(
          'unavailable',
          `${label} unavailable: ${resource?.reason ?? 'no verified resource source'}${resource?.source ? ` (source: ${resource.source})` : ''}.`,
        );
      if (
        condition.field === 'actorSpPercent' &&
        (actor.kind !== 0 ||
          (actor.id === snapshot.selfId &&
            !['spawn', 'own-stats', 'own-sp'].includes(resource.source ?? '')) ||
          (actor.id !== snapshot.selfId && (actor.id <= 0 || resource.source !== 'party')))
      )
        return trace(
          'unavailable',
          'SP requires verified own state or a visible current-party player binding.',
        );
      if (!resourceFresh(resource, snapshot.at))
        return trace(
          'unavailable',
          `${label} from ${resource.source} is stale or its observation clock is unavailable (15-second limit).`,
        );
      if (actor.hp?.value === 0)
        return trace('unavailable', 'A living actor HP observation is required.');
      const percent = (resource.value! / resource.max!) * 100;
      const matched = compareResource(
        resource.value! * 100,
        condition.operator,
        condition.value * resource.max!,
      );
      return trace(
        matched ? 'matched' : 'unmatched',
        `${label} ${percent.toFixed(2)}% from ${resource.source}, observed ${snapshot.at - resource.at!} ms ago.`,
      );
    }
    let actual: boolean;
    if (condition.field === 'actorStatus') {
      if (!SUPPORTED_STATUS_IDS.has(condition.statusId))
        return trace('unavailable', 'This status has no reliable visible add/remove contract.');
      const status = actor.statuses.find((status) => status.id === condition.statusId);
      if (
        status &&
        (!status.known ||
          status.observedAt > snapshot.at ||
          (status.present && status.expiresAt !== null && snapshot.at >= status.expiresAt))
      )
        return trace(
          'unavailable',
          'Status refresh or predicted expiry is unresolved; wait for removal or a new snapshot.',
        );
      if (!status && !actor.statusesKnown)
        return trace('unavailable', 'A complete supported status snapshot is unavailable.');
      actual = !!status?.present;
    } else {
      const cast = actor.cast;
      if (
        cast.state === 'unknown' ||
        cast.observedAt === null ||
        cast.observedAt > snapshot.at ||
        (cast.state === 'casting' && (cast.deadline === null || snapshot.at >= cast.deadline))
      )
        return trace(
          'unavailable',
          'Casting is unknown or its deadline ended without a completion observation.',
        );
      actual =
        cast.state === 'casting' &&
        (condition.skillId === undefined || condition.skillId === cast.skillId);
    }
    const matched =
      condition.operator === 'eq' ? actual === condition.value : actual !== condition.value;
    return trace(
      matched ? 'matched' : 'unmatched',
      matched ? 'Actor condition matched.' : 'Actor condition did not match.',
    );
  };
}

/** Compatibility entrypoint for callers evaluating a single condition. */
export function evaluateActorPredicate(
  condition: ActorPredicate,
  snapshot: ActorObservationSnapshot | undefined,
): PredicateTrace {
  return actorPredicateEvaluator(snapshot)(condition);
}

export function actorConditionsMatch(
  conditions: readonly ActorPredicate[] | undefined,
  snapshot: ActorObservationSnapshot | undefined,
): boolean {
  if (!conditions?.length) return true;
  const evaluate = actorPredicateEvaluator(snapshot);
  return conditions.every((condition) => evaluate(condition).state === 'matched');
}

export const unknownCast = (): CastObservation => ({
  state: 'unknown',
  observedAt: null,
  deadline: null,
  skillId: null,
});

export interface PublishedConditionReport {
  rule: string;
  conditions: PredicateTrace[];
  truncated?: boolean;
}

export function publishConditionReports(
  reports: Array<{ rule: string; conditions: PredicateTrace[] }>,
): PublishedConditionReport[] {
  const published: PublishedConditionReport[] = map(
    reports.slice(0, ACTOR_OBSERVATION_LIMITS.conditionReports),
    (report) => ({
      rule: report.rule,
      conditions: structuredClone(
        report.conditions.slice(0, ACTOR_OBSERVATION_LIMITS.conditionsPerReport),
      ),
      ...(report.conditions.length > ACTOR_OBSERVATION_LIMITS.conditionsPerReport
        ? { truncated: true }
        : {}),
    }),
  );
  if (reports.length > published.length)
    published.push({
      rule: `${reports.length - published.length} additional condition reports omitted.`,
      conditions: [],
      truncated: true,
    });
  return published;
}

import { gitTagObjectSha, reservationTagValues } from '../shared/tooling-domain-values.mjs';
// Durable, create-only release orchestration. GitHub effects use the injected API.
import { serializePlan, parsePlan } from './semantic-release-policy.mjs';
import {
  MAX_RESERVATIONS,
  planRefName,
  serializeReservation,
  validateContext,
  validateLedger,
  validateRef,
  parseReservation,
} from './release-reservation-policy.mjs';
export {
  PLAN_REF_PREFIX,
  MAX_RESERVATIONS,
  MAX_RESERVATION_BYTES,
  planRefName,
  serializeReservation,
} from './release-reservation-policy.mjs';
/** @param {unknown} condition @param {string} message @returns {asserts condition} */
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const validSha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);

/** @param {Pick<import('../shared/tooling-domain-values.mjs').ReleaseApi, "tagObject">} api @param {import('../shared/tooling-domain-values.mjs').ReservationRefDto} ref @param {string} [expectedName] */
async function readRef(api, ref, expectedName) {
  const checkedRef = structuredClone(validateRef(ref, expectedName));
  const tag = await api.tagObject(checkedRef.object.sha);
  requireValue(tag?.sha === checkedRef.object.sha, 'Release tag object SHA differs from its ref.');
  requireValue(
    tag.tag === checkedRef.ref.slice('refs/tags/'.length),
    'Annotated release tag name differs from its ref.',
  );
  requireValue(
    tag.object?.type === 'commit' && validSha(tag.object.sha),
    'Annotated release tag must target a commit directly.',
  );
  const checkedTag = reservationTagValues(tag);
  const plan = parseReservation(checkedTag.message);
  requireValue(planRefName(plan) === checkedRef.ref, 'Release plan version differs from its ref.');
  requireValue(
    plan.sourceSha === checkedTag.object.sha,
    'Release plan source differs from its tag target.',
  );
  return plan;
}

/** @param {import('../shared/tooling-domain-values.mjs').ReservationReadContext} ctx */
export async function readReservations(ctx) {
  validateContext(ctx);
  ctx = { ...ctx, history: [...ctx.history], bridge: { ...ctx.bridge } };
  const refs = structuredClone(await ctx.api.planRefs());
  requireValue(
    Array.isArray(refs) && refs.length <= MAX_RESERVATIONS,
    'Invalid or oversized release reservation ref list.',
  );
  const names = new Set(),
    plans = [];
  for (const ref of refs) {
    validateRef(ref);
    requireValue(!names.has(ref.ref), 'Duplicate release reservation ref.');
    names.add(ref.ref);
    plans.push(await readRef(ctx.api, ref));
  }
  return validateLedger(ctx, plans);
}

/** @param {import('../shared/tooling-domain-values.mjs').ReservationContext} ctx @param {import('../shared/tooling-domain-values.mjs').ReleasePlan} plan @param {string} message */
async function confirmReservation(ctx, plan, message) {
  // A complete ledger read catches a competing reservation or rewritten history;
  // direct readback also confirms that the exact ref still targets these bytes.
  const ledger = await readReservations(ctx);
  const name = planRefName(plan),
    ref = await ctx.api.planRef(name);
  requireValue(ref, 'Release reservation creation was not confirmed; retry the same frozen plan.');
  const confirmed = await readRef(ctx.api, ref, name);
  requireValue(
    serializeReservation(confirmed) === message,
    'Release reservation conflicts with the frozen plan.',
  );
  requireValue(
    ledger.some((entry) => serializePlan(entry) === serializePlan(confirmed)),
    'Confirmed release reservation is absent from the complete ledger.',
  );
  return confirmed;
}

/** @param {import('../shared/tooling-domain-values.mjs').ReservationContext} ctx @param {import('../shared/tooling-domain-values.mjs').ReleasePlan} plan */
export async function reservePlan(ctx, plan) {
  // Snapshot before the first effect: neither retries nor caller mutation can
  // change the version, policy, notes or predecessor of this attempt.
  const frozen = parsePlan(JSON.parse(serializePlan(plan))),
    message = serializeReservation(frozen);
  validateContext(ctx);
  ctx = { ...ctx, history: [...ctx.history], bridge: { ...ctx.bridge } };
  const ledger = await readReservations(ctx);
  const existing = ledger.find(
    (entry) => entry.sourceSha === frozen.sourceSha || entry.version === frozen.version,
  );
  if (existing) {
    requireValue(
      serializePlan(existing) === serializePlan(frozen),
      'Release reservation conflicts with an existing source or version.',
    );
    return confirmReservation(ctx, frozen, message);
  }
  validateLedger(ctx, [...ledger, frozen]);
  const name = planRefName(frozen);
  let created;
  try {
    created = await ctx.api.createPlanTag(
      name.slice('refs/tags/'.length),
      message,
      frozen.sourceSha,
      frozen.pubDate,
    );
  } catch {
    // An object POST without a known SHA cannot be retried safely in this call.
    return confirmReservation(ctx, frozen, message);
  }
  if (!validSha(created?.sha)) return confirmReservation(ctx, frozen, message);
  const createdSha = gitTagObjectSha(created.sha);
  const objectPlan = await readRef(ctx.api, {
    ref: name,
    object: { type: 'tag', sha: createdSha },
  });
  requireValue(
    serializeReservation(objectPlan) === message,
    'Created release tag differs from the frozen plan.',
  );
  try {
    await ctx.api.createPlanRef(name, createdSha);
  } catch {
    // Ref creation is a compare-and-set: reconcile an existing exact winner.
  }
  return confirmReservation(ctx, frozen, message);
}

// Downstream stages verify the one frozen plan transported by the trusted
// planner. Only queued planning scans/validates the full predecessor ledger.
/** @param {import('../shared/tooling-domain-values.mjs').ReservationContext} ctx @param {import('../shared/tooling-domain-values.mjs').ReleasePlan} plan */
export async function verifyReservedPlan(ctx, plan) {
  validateContext(ctx);
  plan = parsePlan(plan);
  requireValue(
    ctx.history[plan.firstParentCount - 1] === plan.sourceSha &&
      plan.firstParentCount > ctx.bridge.firstParentCount,
    'Reserved plan source is outside main ancestry.',
  );
  const name = planRefName(plan),
    ref = await ctx.api.planRef(name);
  requireValue(ref, 'Exact release reservation is missing.');
  const reserved = await readRef(ctx.api, ref, name);
  requireValue(
    serializePlan(reserved) === serializePlan(plan),
    'Exact release reservation changed.',
  );
  return reserved;
}

import { find } from "remeda";
// Durable, create-only release orchestration. GitHub effects use the injected API.
import { serializePlan, validatePlan } from "./semantic-release-policy.mjs";
import {
  MAX_RESERVATIONS, planRefName, serializeReservation,
  validateContext, validateLedger, validateRef, parseReservation,
} from "./release-reservation-policy.mjs";
export { PLAN_REF_PREFIX, MAX_RESERVATIONS, MAX_RESERVATION_BYTES, planRefName, serializeReservation } from "./release-reservation-policy.mjs";
function requireValue(condition, message) { if (!condition) throw new Error(message); }
const validSha = value => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);

async function readRef(api, ref, expectedName) {
  validateRef(ref, expectedName);
  const tag = await api.tagObject(ref.object.sha);
  requireValue(
    tag?.sha === ref.object.sha,
    "Release tag object SHA differs from its ref.",
  );
  requireValue(
    tag.tag === ref.ref.slice("refs/tags/".length),
    "Annotated release tag name differs from its ref.",
  );
  requireValue(
    tag.object?.type === "commit" && validSha(tag.object.sha),
    "Annotated release tag must target a commit directly.",
  );
  const plan = parseReservation(tag.message);
  requireValue(
    planRefName(plan) === ref.ref,
    "Release plan version differs from its ref.",
  );
  requireValue(
    plan.sourceSha === tag.object.sha,
    "Release plan source differs from its tag target.",
  );
  return plan;
}

export async function readReservations(ctx) {
  validateContext(ctx);
  const refs = await ctx.api.planRefs();
  requireValue(
    Array.isArray(refs) && refs.length <= MAX_RESERVATIONS,
    "Invalid or oversized release reservation ref list.",
  );
  const names = new Set(),
    plans = [];
  for (const ref of refs) {
    validateRef(ref);
    requireValue(!names.has(ref.ref), "Duplicate release reservation ref.");
    names.add(ref.ref);
    plans.push(await readRef(ctx.api, ref));
  }
  return validateLedger(ctx, plans);
}

async function confirmReservation(ctx, plan, message) {
  // A complete ledger read catches a competing reservation or rewritten history;
  // direct readback also confirms that the exact ref still targets these bytes.
  const ledger = await readReservations(ctx);
  const name = planRefName(plan),
    ref = await ctx.api.planRef(name);
  requireValue(
    ref,
    "Release reservation creation was not confirmed; retry the same frozen plan.",
  );
  const confirmed = await readRef(ctx.api, ref, name);
  requireValue(
    serializeReservation(confirmed) === message,
    "Release reservation conflicts with the frozen plan.",
  );
  requireValue(
    ledger.some((entry) => serializePlan(entry) === serializePlan(confirmed)),
    "Confirmed release reservation is absent from the complete ledger.",
  );
  return confirmed;
}

export async function reservePlan(ctx, plan) {
  // Snapshot before the first effect: neither retries nor caller mutation can
  // change the version, policy, notes or predecessor of this attempt.
  const frozen = JSON.parse(serializePlan(plan)),
    message = serializeReservation(frozen);
  const ledger = await readReservations(ctx);
  const existing = find(ledger,
    (entry) =>
      entry.sourceSha === frozen.sourceSha || entry.version === frozen.version,
  );
  if (existing) {
    requireValue(
      serializePlan(existing) === serializePlan(frozen),
      "Release reservation conflicts with an existing source or version.",
    );
    return confirmReservation(ctx, frozen, message);
  }
  validateLedger(ctx, [...ledger, frozen]);
  const name = planRefName(frozen);
  let created;
  try {
    created = await ctx.api.createPlanTag(
      name.slice("refs/tags/".length),
      message,
      frozen.sourceSha,
      frozen.pubDate,
    );
  } catch {
    // An object POST without a known SHA cannot be retried safely in this call.
    return confirmReservation(ctx, frozen, message);
  }
  if (!validSha(created?.sha)) return confirmReservation(ctx, frozen, message);
  const objectPlan = await readRef(ctx.api, {
    ref: name,
    object: { type: "tag", sha: created.sha },
  });
  requireValue(
    serializeReservation(objectPlan) === message,
    "Created release tag differs from the frozen plan.",
  );
  try {
    await ctx.api.createPlanRef(name, created.sha);
  } catch {
    // Ref creation is a compare-and-set: reconcile an existing exact winner.
  }
  return confirmReservation(ctx, frozen, message);
}

// Downstream stages verify the one frozen plan transported by the trusted
// planner. Only queued planning scans/validates the full predecessor ledger.
export async function verifyReservedPlan(ctx, plan) {
  validateContext(ctx);
  validatePlan(plan);
  requireValue(
    ctx.history[plan.firstParentCount - 1] === plan.sourceSha &&
      plan.firstParentCount > ctx.bridge.firstParentCount,
    "Reserved plan source is outside main ancestry.",
  );
  const name = planRefName(plan),
    ref = await ctx.api.planRef(name);
  requireValue(ref, "Exact release reservation is missing.");
  const reserved = await readRef(ctx.api, ref, name);
  requireValue(
    serializePlan(reserved) === serializePlan(plan),
    "Exact release reservation changed.",
  );
  return reserved;
}

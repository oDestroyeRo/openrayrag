import { reservationRefValues } from './tooling-domain-values.mjs';
import { sort } from "remeda";
// Pure reservation encoding, ref validation and complete ledger contracts.
import { canonicalJson } from "../release.config.mjs";
import {
  validatePlan,
  serializePlan,
  planSha256,
  stableVersion,
  compareVersions,
  bumpVersion,
  MAX_PLAN_BYTES,
} from "./semantic-release-policy.mjs";

export const PLAN_REF_PREFIX = "refs/tags/rayrag-release-plan/";
export const MAX_RESERVATIONS = 10_000;
export const MAX_RESERVATION_BYTES = MAX_PLAN_BYTES + 256;
const bridgeKeys = ["version", "sourceSha", "firstParentCount", "tag"];
const envelopeKeys = ["schemaVersion", "plan", "planSha256"];
const validSha = (value) =>
  typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys(value, keys, label) {
  requireValue(
    value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      sort(Object.keys(value), compareKeys).join("|") === sort(keys, compareKeys).join("|"),
    `Invalid ${label} fields.`,
  );
}
const compareKeys = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const baseOf = ({ sourceSha, version, tag }) => ({ sourceSha, version, tag });
const sameBase = (a, b) => canonicalJson(a) === canonicalJson(baseOf(b));

/** @param {import('./tooling-domain-values.mjs').ReleasePlan} plan */
export function planRefName(plan) {
  return `${PLAN_REF_PREFIX}v${stableVersion(plan.version)}`;
}
/** @param {import('./tooling-domain-values.mjs').ReleasePlan} plan */
export function serializeReservation(plan) {
  validatePlan(plan);
  return (
    canonicalJson({ schemaVersion: 1, plan, planSha256: planSha256(plan) }) +
    "\n"
  );
}

/** @param {Pick<import('./tooling-domain-values.mjs').ReservationContext, "history" | "bridge">} context */
export function validateContext({ history, bridge }) {
  requireValue(
    Array.isArray(history) &&
      history.length > 0 &&
      history.every(validSha) &&
      new Set(history).size === history.length,
    "Invalid first-parent history.",
  );
  exactKeys(bridge, bridgeKeys, "release bridge");
  stableVersion(bridge.version);
  requireValue(
    bridge.tag === `v${bridge.version}` &&
      validSha(bridge.sourceSha) &&
      Number.isSafeInteger(bridge.firstParentCount) &&
      bridge.firstParentCount > 0 &&
      history[bridge.firstParentCount - 1] === bridge.sourceSha,
    "Release bridge differs from current first-parent history.",
  );
}
/** @param {Pick<import('./tooling-domain-values.mjs').ReservationContext, "history" | "bridge">} ctx @param {readonly import('./tooling-domain-values.mjs').ReleasePlan[]} plans */
export function validateLedger(ctx, plans) {
  validateContext(ctx);
  requireValue(
    plans.length <= MAX_RESERVATIONS,
    "Release reservation ledger exceeds its bound.",
  );
  const sorted = sort(plans,
    (a, b) => a.firstParentCount - b.firstParentCount,
  );
  const sources = new Set(),
    versions = new Set();
  const bases = new Map([[ctx.bridge.sourceSha, ctx.bridge]]);
  let previous = ctx.bridge;
  /** @type {import('./tooling-domain-values.mjs').PlanDigest | null} */
  let predecessorHash = null;
  for (const plan of sorted) {
    validatePlan(plan);
    requireValue(!sources.has(plan.sourceSha), "Duplicate reserved source.");
    requireValue(!versions.has(plan.version), "Duplicate reserved version.");
    sources.add(plan.sourceSha);
    versions.add(plan.version);
    requireValue(
      ctx.history[plan.firstParentCount - 1] === plan.sourceSha,
      "Reserved source differs from current first-parent history.",
    );
    requireValue(
      plan.firstParentCount > previous.firstParentCount,
      "Reserved source must follow its predecessor and release bridge.",
    );
    requireValue(
      compareVersions(plan.version, stableVersion(previous.version)) > 0,
      "Reserved versions must increase with first-parent history.",
    );
    requireValue(
      sameBase(plan.analysisBase, previous),
      "Reservation analysis base differs from its predecessor.",
    );
    requireValue(
      plan.version === bumpVersion(stableVersion(previous.version), plan.releaseType),
      "Reservation version differs from its predecessor and release type.",
    );
    requireValue(
      plan.predecessorPlanSha256 === predecessorHash,
      "Reservation predecessor hash is missing or differs from the ledger.",
    );
    const notesBase = bases.get(plan.notesBase.sourceSha);
    requireValue(
      notesBase &&
        notesBase.firstParentCount <= previous.firstParentCount &&
        sameBase(plan.notesBase, notesBase),
      "Reservation notes base is not the bridge or an earlier ledger entry.",
    );
    previous = plan;
    predecessorHash = planSha256(plan);
    bases.set(plan.sourceSha, plan);
  }
  return sorted;
}
/** @param {import('./tooling-domain-values.mjs').ReservationRefDto} ref @param {string} [expectedName] @returns {import('./tooling-domain-values.mjs').ReservationRef} */
export function validateRef(ref, expectedName) {
  requireValue(
    ref !== null &&
      typeof ref === "object" &&
      typeof ref.ref === "string" &&
      ref.ref.startsWith(PLAN_REF_PREFIX),
    "Foreign or malformed release plan ref.",
  );
  const versionTag = ref.ref.slice(PLAN_REF_PREFIX.length);
  requireValue(versionTag.startsWith("v"), "Malformed release plan ref name.");
  stableVersion(versionTag.slice(1));
  requireValue(
    !expectedName || ref.ref === expectedName,
    "Release plan ref name differs from its lookup.",
  );
  requireValue(
    ref.object?.type === "tag" && validSha(ref.object.sha),
    "Release plan ref must point to an annotated tag object.",
  );
  return reservationRefValues(ref);
}
/** @param {string} message @returns {import('./tooling-domain-values.mjs').ReleasePlan} */
export function parseReservation(message) {
  requireValue(
    typeof message === "string" &&
      Buffer.byteLength(message) <= MAX_RESERVATION_BYTES &&
      Buffer.from(message, "utf8").toString("utf8") === message,
    "Invalid release reservation message size or encoding.",
  );
  let envelope;
  try {
    envelope = JSON.parse(message);
  } catch {
    throw new Error("Invalid release reservation JSON.");
  }
  exactKeys(envelope, envelopeKeys, "release reservation envelope");
  requireValue(
    envelope.schemaVersion === 1,
    "Unsupported release reservation envelope.",
  );
  envelope.plan = validatePlan(envelope.plan);
  requireValue(
    envelope.planSha256 === planSha256(envelope.plan),
    "Release reservation plan hash differs.",
  );
  requireValue(
    message === serializeReservation(envelope.plan),
    "Noncanonical release reservation envelope.",
  );
  return envelope.plan;
}

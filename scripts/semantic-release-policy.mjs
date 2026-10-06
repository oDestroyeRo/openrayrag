import { map, sort } from "remeda";
// Pure semantic release contracts. No plugin loading, filesystem or network effects.
import { createHash } from "node:crypto";
import policyHistory from "../release-policy-history.json" with { type: "json" };
import {
  canonicalJson, RELEASE_POLICY, RELEASE_POLICY_VERSION, RELEASE_POLICY_SHA256,
} from "../release.config.mjs";
export { RELEASE_POLICY, RELEASE_POLICY_VERSION, RELEASE_POLICY_SHA256, RELEASE_ENGINE_VERSIONS } from "../release.config.mjs";

export const MAX_PLAN_BYTES = 128 * 1024;
// Leave room for signed feed fields and JSON escaping under the client's 64,000-byte bound.
export const MAX_NOTES_BYTES = 48_000;
const MAX_COMMITS = 10_000;
const MAX_COMMIT_BYTES = 16 * 1024;
const MAX_SUBJECT_BYTES = 1024;
const MAX_LINE_BYTES = 4096;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const MAX_STABLE_VERSION_LENGTH = 3 * String(Number.MAX_SAFE_INTEGER).length + 2;
const baseKeys = ["sourceSha", "version", "tag"];
const planKeys = [
  "schemaVersion",
  "repository",
  "sourceSha",
  "firstParentCount",
  "pubDate",
  "version",
  "tag",
  "releaseType",
  "analysisBase",
  "notesBase",
  "policyVersion",
  "policySha256",
  "predecessorPlanSha256",
  "notes",
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
const compareKeys = (a, b) => a < b ? -1 : a > b ? 1 : 0;
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
function validSha(value) {
  requireValue(
    typeof value === "string" && /^[a-f0-9]{40}$/.test(value),
    "Invalid source SHA.",
  );
}
// Release contracts accept only canonical stable triples. Keep arithmetic within
// the same safe-integer boundary as the pinned semver engine used by plugins.
export function stableVersion(value) {
  requireValue(
    typeof value === "string" && value.length <= MAX_STABLE_VERSION_LENGTH &&
      /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
      value.split(".").every(part => Number.isSafeInteger(Number(part)) && String(Number(part)) === part),
    "Invalid stable release version.",
  );
  return value;
}
export function compareVersions(a, b) {
  const left = map(stableVersion(a).split("."), Number),
    right = map(stableVersion(b).split("."), Number);
  for (let i = 0; i < left.length; i++) {
    if (left[i] !== right[i]) return left[i] > right[i] ? 1 : -1;
  }
  return 0;
}
export function bumpVersion(version, releaseType) {
  const parts = map(stableVersion(version).split("."), Number);
  requireValue(["major", "minor", "patch"].includes(releaseType), "Invalid release type.");
  const index = ["major", "minor", "patch"].indexOf(releaseType);
  parts[index]++;
  for (let i = index + 1; i < parts.length; i++) parts[i] = 0;
  return stableVersion(parts.join("."));
}
function validText(value, maxBytes, label) {
  requireValue(
    typeof value === "string" &&
      value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= maxBytes &&
      Buffer.from(value, "utf8").toString("utf8") === value &&
      !value.includes("\0"),
    `Invalid ${label}.`,
  );
}
function validSource(source) {
  validSha(source.sourceSha);
  requireValue(
    Number.isSafeInteger(source.firstParentCount) &&
      source.firstParentCount > 0,
    "Invalid first-parent count.",
  );
  requireValue(
    typeof source.pubDate === "string" &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(source.pubDate) &&
      Number.isFinite(Date.parse(source.pubDate)) &&
      new Date(source.pubDate).toISOString() === source.pubDate,
    "Invalid source date.",
  );
}
function validBase(base, label) {
  exactKeys(base, baseKeys, label);
  validSha(base.sourceSha);
  stableVersion(base.version);
  requireValue(base.tag === `v${base.version}`, `Invalid ${label} tag.`);
}
function validBases(analysisBase, notesBase) {
  validBase(analysisBase, "analysis base");
  validBase(notesBase, "notes base");
  requireValue(
    compareVersions(analysisBase.version, notesBase.version) >= 0,
    "Analysis base precedes the published notes base.",
  );
  requireValue(
    analysisBase.version !== notesBase.version ||
      analysisBase.sourceSha === notesBase.sourceSha,
    "Equal baseline versions refer to different sources.",
  );
}

export function validatePlan(plan) {
  exactKeys(plan, planKeys, "release plan");
  requireValue(
    plan.schemaVersion === 1 && plan.repository === RELEASE_POLICY.repository,
    "Unsupported release plan identity.",
  );
  validSource(plan);
  stableVersion(plan.version);
  requireValue(plan.tag === `v${plan.version}`, "Invalid release plan tag.");
  validBases(plan.analysisBase, plan.notesBase);
  requireValue(
    ["major", "minor", "patch"].includes(plan.releaseType) &&
      bumpVersion(plan.analysisBase.version, plan.releaseType) ===
        plan.version &&
      plan.sourceSha !== plan.analysisBase.sourceSha,
    "Release version does not match its analysis base and release type.",
  );
  requireValue(
    Number.isSafeInteger(plan.policyVersion) &&
      plan.policyVersion > 0 &&
      typeof plan.policySha256 === "string" &&
      /^[a-f0-9]{64}$/.test(plan.policySha256) &&
      trustedPolicies.has(plan.policySha256) &&
      trustedPolicies.get(plan.policySha256).version === plan.policyVersion,
    "Release plan differs from the trusted policy.",
  );
  requireValue(
    plan.predecessorPlanSha256 === null ||
      (typeof plan.predecessorPlanSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(plan.predecessorPlanSha256)),
    "Invalid predecessor plan hash.",
  );
  validText(plan.notes, MAX_NOTES_BYTES, "release notes");
  requireValue(plan.notes.trim().length > 0, "Empty release notes.");
  requireValue(
    Buffer.byteLength(JSON.stringify(plan.notes)) <= MAX_NOTES_BYTES,
    "Serialized release notes exceed the client metadata budget.",
  );
  requireValue(
    !/rayrag-release(?:-plan)?:/i.test(plan.notes),
    "Release notes contain a reserved provenance marker.",
  );
  requireValue(
    Buffer.byteLength(canonicalJson(plan) + "\n") <= MAX_PLAN_BYTES,
    "Release plan exceeds its size bound.",
  );
  return plan;
}

export function serializePlan(plan) {
  validatePlan(plan);
  return canonicalJson(plan) + "\n";
}
export function planSha256(plan) {
  return createHash("sha256").update(serializePlan(plan)).digest("hex");
}
function validCommits(commits, label) {
  requireValue(
    Array.isArray(commits) && commits.length <= MAX_COMMITS,
    `Invalid ${label}.`,
  );
  const hashes = new Set();
  let bytes = 0;
  for (const commit of commits) {
    exactKeys(commit, ["hash", "message"], "commit");
    validSha(commit.hash);
    requireValue(!hashes.has(commit.hash), `Duplicate commit in ${label}.`);
    hashes.add(commit.hash);
    validText(commit.message, MAX_COMMIT_BYTES, "commit message");
    const lines = commit.message.split("\n");
    requireValue(
      Buffer.byteLength(lines[0]) <= MAX_SUBJECT_BYTES &&
        lines.every((line) => Buffer.byteLength(line) <= MAX_LINE_BYTES),
      "Commit subject or line exceeds the parser budget.",
    );
    bytes += Buffer.byteLength(commit.message);
  }
  requireValue(bytes <= MAX_RANGE_BYTES, `${label} exceeds its size bound.`);
}
const baseOf = ({ sourceSha, version, tag }) => ({ sourceSha, version, tag });

export function validatePlanningInput(input, cwd) {
  exactKeys(
    input,
    ["source", "published", "reservation", "analysisCommits", "notesCommits"],
    "planning input",
  );
  exactKeys(
    input.source,
    ["sourceSha", "firstParentCount", "pubDate"],
    "source",
  );
  validSource(input.source);
  validBase(input.published, "published base");
  validCommits(input.analysisCommits, "analysis commits");
  validCommits(input.notesCommits, "notes commits");
  const notesMessages = new Map(
    map(input.notesCommits, ({ hash, message }) => [hash, message]),
  );
  requireValue(
    input.analysisCommits.every(
      ({ hash, message }) => notesMessages.get(hash) === message,
    ),
    "Notes range omits or changes an analyzed commit.",
  );
  requireValue(
    typeof cwd === "string" && cwd.length > 0,
    "Invalid planning directory.",
  );
  if (input.reservation !== null) {
    validatePlan(input.reservation);
    requireValue(
      input.source.firstParentCount > input.reservation.firstParentCount &&
        input.source.sourceSha !== input.reservation.sourceSha,
      "Source must follow the reserved source.",
    );
  }
  const analysisBase = baseOf(input.reservation ?? input.published);
  const notesBase = baseOf(input.published);
  validBases(analysisBase, notesBase);
  return { analysisBase, notesBase };
}

export function analyzerVersion(analysisBase, releaseType) {
  requireValue(["major", "minor", "patch"].includes(releaseType), "Invalid analyzer release type.");
  return bumpVersion(analysisBase.version, releaseType);
}

export function finalizePlan(input, { analysisBase, notesBase, releaseType, version }, notes) {
  const tag = `v${version}`;
  const plan = {
    schemaVersion: 1,
    repository: RELEASE_POLICY.repository,
    ...input.source,
    version,
    tag,
    releaseType,
    analysisBase,
    notesBase,
    policyVersion: RELEASE_POLICY_VERSION,
    policySha256: RELEASE_POLICY_SHA256,
    predecessorPlanSha256:
      input.reservation === null ? null : planSha256(input.reservation),
    notes,
  };
  validatePlan(plan);
  return plan;
}

// Preserve reviewed policy snapshots when engine versions change. Old durable
// plans remain readable; planning always uses the current pinned configuration.
function trustedPolicySnapshots(history) {
  requireValue(
    Array.isArray(history) && history.length > 0 && history.length <= 100,
    "Invalid release policy history.",
  );
  const policies = new Map();
  for (const entry of history) {
    exactKeys(entry, ["sha256", "policy"], "policy snapshot");
    requireValue(
      entry.policy &&
        entry.policy.repository === RELEASE_POLICY.repository &&
        Number.isSafeInteger(entry.policy.version) &&
        entry.policy.version > 0 &&
        entry.policy.version <= RELEASE_POLICY_VERSION &&
        createHash("sha256")
          .update(canonicalJson(entry.policy) + "\n")
          .digest("hex") === entry.sha256 &&
        !policies.has(entry.sha256),
      "Invalid or duplicate release policy snapshot.",
    );
    policies.set(entry.sha256, entry.policy);
  }
  requireValue(
    policies.has(RELEASE_POLICY_SHA256),
    "Current release policy snapshot is missing.",
  );
  return policies;
}
const trustedPolicies = trustedPolicySnapshots(policyHistory);

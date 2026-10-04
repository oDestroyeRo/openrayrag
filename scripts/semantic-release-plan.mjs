// Pure planning only: callers own commit ranges, ancestry, durable reservations,
// signing and publication. Neither plugin is allowed to mutate Git or use APIs.
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  canonicalJson,
  RELEASE_POLICY,
  RELEASE_POLICY_VERSION,
  RELEASE_POLICY_SHA256,
} from "../release.config.mjs";

// The release tools have an isolated install so application builds never install
// publishing plugins. Resolve official public exports from that pinned package.
const toolRequire = createRequire(new URL("../tools/release/package.json", import.meta.url));
const [analyzerModule, notesModule] = await Promise.all([
  import(pathToFileURL(toolRequire.resolve("@semantic-release/commit-analyzer")).href),
  import(pathToFileURL(toolRequire.resolve("@semantic-release/release-notes-generator")).href),
]);
const { analyzeCommits } = analyzerModule;
const { generateNotes } = notesModule;
const semver = toolRequire("semver");
export {
  RELEASE_POLICY,
  RELEASE_POLICY_VERSION,
  RELEASE_POLICY_SHA256,
  RELEASE_ENGINE_VERSIONS,
} from "../release.config.mjs";

export const MAX_PLAN_BYTES = 128 * 1024;
export const MAX_NOTES_BYTES = 64 * 1024;
const MAX_COMMITS = 10_000;
const MAX_COMMIT_BYTES = 64 * 1024;
const MAX_RANGE_BYTES = 8 * 1024 * 1024;
const logger = Object.freeze({ log() {} });
const baseKeys = ["sourceSha", "version", "tag"];
const planKeys = [
  "schemaVersion", "repository", "sourceSha", "firstParentCount", "pubDate",
  "version", "tag", "releaseType", "analysisBase", "notesBase", "policyVersion",
  "policySha256", "predecessorPlanSha256", "notes",
];

function requireValue(condition, message) {
  if (!condition) throw new Error(message);
}
function exactKeys(value, keys, label) {
  requireValue(
    value !== null && typeof value === "object" && !Array.isArray(value) &&
      [Object.prototype, null].includes(Object.getPrototypeOf(value)) &&
      Object.keys(value).sort().join("|") === [...keys].sort().join("|"),
    `Invalid ${label} fields.`,
  );
}
function validSha(value) {
  requireValue(typeof value === "string" && /^[a-f0-9]{40}$/.test(value), "Invalid source SHA.");
}
export function stableVersion(value) {
  requireValue(
    typeof value === "string" && /^\d+\.\d+\.\d+$/.test(value) && semver.valid(value) === value,
    "Invalid stable release version.",
  );
  return value;
}
export function compareVersions(a, b) {
  return semver.compare(stableVersion(a), stableVersion(b));
}
export function bumpVersion(version, releaseType) {
  stableVersion(version);
  requireValue(["major", "minor", "patch"].includes(releaseType), "Invalid release type.");
  return stableVersion(semver.inc(version, releaseType));
}
function validText(value, maxBytes, label) {
  requireValue(
    typeof value === "string" && value.length > 0 &&
      Buffer.byteLength(value, "utf8") <= maxBytes &&
      Buffer.from(value, "utf8").toString("utf8") === value && !value.includes("\0"),
    `Invalid ${label}.`,
  );
}
function validSource(source) {
  validSha(source.sourceSha);
  requireValue(Number.isSafeInteger(source.firstParentCount) && source.firstParentCount > 0,
    "Invalid first-parent count.");
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
  requireValue(compareVersions(analysisBase.version, notesBase.version) >= 0,
    "Analysis base precedes the published notes base.");
  requireValue(
    analysisBase.version !== notesBase.version || analysisBase.sourceSha === notesBase.sourceSha,
    "Equal baseline versions refer to different sources.",
  );
}

export function validatePlan(plan) {
  exactKeys(plan, planKeys, "release plan");
  requireValue(plan.schemaVersion === 1 && plan.repository === RELEASE_POLICY.repository,
    "Unsupported release plan identity.");
  validSource(plan);
  stableVersion(plan.version);
  requireValue(plan.tag === `v${plan.version}`, "Invalid release plan tag.");
  validBases(plan.analysisBase, plan.notesBase);
  requireValue(
    ["major", "minor", "patch"].includes(plan.releaseType) &&
      bumpVersion(plan.analysisBase.version, plan.releaseType) === plan.version &&
      plan.sourceSha !== plan.analysisBase.sourceSha,
    "Release version does not match its analysis base and release type.",
  );
  requireValue(
    plan.policyVersion === RELEASE_POLICY_VERSION && plan.policySha256 === RELEASE_POLICY_SHA256,
    "Release plan differs from the trusted policy.",
  );
  requireValue(
    plan.predecessorPlanSha256 === null ||
      (typeof plan.predecessorPlanSha256 === "string" && /^[a-f0-9]{64}$/.test(plan.predecessorPlanSha256)),
    "Invalid predecessor plan hash.",
  );
  validText(plan.notes, MAX_NOTES_BYTES, "release notes");
  requireValue(plan.notes.trim().length > 0, "Empty release notes.");
  requireValue(!/rayrag-release(?:-plan)?:/i.test(plan.notes),
    "Release notes contain a reserved provenance marker.");
  requireValue(Buffer.byteLength(canonicalJson(plan) + "\n") <= MAX_PLAN_BYTES,
    "Release plan exceeds its size bound.");
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
  requireValue(Array.isArray(commits) && commits.length <= MAX_COMMITS, `Invalid ${label}.`);
  const hashes = new Set();
  let bytes = 0;
  for (const commit of commits) {
    exactKeys(commit, ["hash", "message"], "commit");
    validSha(commit.hash);
    requireValue(!hashes.has(commit.hash), `Duplicate commit in ${label}.`);
    hashes.add(commit.hash);
    validText(commit.message, MAX_COMMIT_BYTES, "commit message");
    bytes += Buffer.byteLength(commit.message);
  }
  requireValue(bytes <= MAX_RANGE_BYTES, `${label} exceeds its size bound.`);
}
const baseOf = ({ sourceSha, version, tag }) => ({ sourceSha, version, tag });

export async function planRelease(input, {
  cwd = fileURLToPath(new URL("../tools/release/", import.meta.url)),
  analyzer = analyzeCommits, notesGenerator = generateNotes,
} = {}) {
  exactKeys(input, ["source", "published", "reservation", "analysisCommits", "notesCommits"], "planning input");
  exactKeys(input.source, ["sourceSha", "firstParentCount", "pubDate"], "source");
  validSource(input.source);
  validBase(input.published, "published base");
  validCommits(input.analysisCommits, "analysis commits");
  validCommits(input.notesCommits, "notes commits");
  const notesMessages = new Map(input.notesCommits.map(({ hash, message }) => [hash, message]));
  requireValue(input.analysisCommits.every(({ hash, message }) => notesMessages.get(hash) === message),
    "Notes range omits or changes an analyzed commit.");
  requireValue(typeof cwd === "string" && cwd.length > 0, "Invalid planning directory.");
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
  const context = {
    cwd, logger, commits: structuredClone(input.analysisCommits),
  };
  const releaseType = await analyzer(structuredClone(RELEASE_POLICY.analyzer), context);
  if (releaseType === null) return { state: "skip", reason: "No releasable changes." };
  requireValue(["major", "minor", "patch"].includes(releaseType), "Invalid analyzer release type.");
  const version = bumpVersion(analysisBase.version, releaseType);
  const tag = `v${version}`;
  const date = input.source.pubDate.slice(0, 10);
  const notes = await notesGenerator({
    ...structuredClone(RELEASE_POLICY.notesGenerator),
    writerOpts: {
      // The writer otherwise takes today's date. Retries must reserve the same bytes.
      formatDate: () => date,
      finalizeContext: (value) => ({ ...value, date }),
    },
  }, {
    cwd, logger, commits: structuredClone(input.notesCommits),
    options: { repositoryUrl: `https://github.com/${RELEASE_POLICY.repository}.git` },
    lastRelease: { gitHead: notesBase.sourceSha, gitTag: notesBase.tag },
    nextRelease: { gitHead: input.source.sourceSha, gitTag: tag, version },
  });
  const plan = {
    schemaVersion: 1, repository: RELEASE_POLICY.repository,
    ...input.source, version, tag, releaseType, analysisBase, notesBase,
    policyVersion: RELEASE_POLICY_VERSION, policySha256: RELEASE_POLICY_SHA256,
    predecessorPlanSha256: input.reservation === null ? null : planSha256(input.reservation),
    notes,
  };
  validatePlan(plan);
  return { state: "release", plan };
}

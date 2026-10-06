import { filter, map, sort } from "remeda";
import { publicOptionsValues } from "../shared/tooling-domain-values.mjs";

// Pure public release metadata, workflow evidence and option contracts.
const REPOSITORY = "oDestroyeRo/openrayrag";
/** @param {unknown} ok @param {string} message @returns {asserts ok} */
function requireValue(ok, message) { if (!ok) throw new Error(message); }
const compareAssetRows = (a, b) => {
  const left = String(a), right = String(b);
  return left < right ? -1 : left > right ? 1 : 0;
};

export const MAX_PUBLIC_TOTAL = 512 * 1024 * 1024;
export const MAX_PUBLICATION_ATTEMPTS = 20;
export const HELP = `Usage: bun run release:verify --source <40-character SHA> --tag <vX.Y.Z>
  [--repo oDestroyeRo/openrayrag] [--run-id <ID>] [--run-attempt <attempt>]
  [--latest] [--skip-native]

Verifies an immutable published semantic release, including an ancestor of main.
--latest additionally requires it to be GitHub's latest stable release and checks
both moving updater URLs. Otherwise the feeds are its immutable public assets.
--skip-native omits macOS DMG/archive/code-signing inspection and records that gap;
it is required when running on Windows or Linux. No app is launched or installed.

Requires Git, Bun, Python and authenticated gh read access to Actions metadata
and its original artifact ZIP. Public assets and Git are downloaded anonymously.
Reports and downloads use a new private temporary directory; existing files are
never overwritten. Expired Actions artifacts cannot receive a complete proof.
Run arguments identify the original artifact producer. Publication can be proved
from a later attempt or a separate exact-source dispatch; its identity is recorded
separately. Discovery checks at most 20 attempts from 100 recent same-source runs.
`;

/** @param {readonly string[]} args @returns {import("../shared/tooling-domain-values.mjs").PublicCommand} */
export function parseOptions(args) {
  /** @type {import("../shared/tooling-domain-values.mjs").PublicOptionsDto} */
  const options = { repository: REPOSITORY, latest: false, skipNative: false };
  /** @type {Map<string, "sourceSha" | "tag" | "repository" | "runId" | "runAttempt">} */
  const keys = new Map([["--source", "sourceSha"], ["--tag", "tag"], ["--repo", "repository"], ["--run-id", "runId"], ["--run-attempt", "runAttempt"]]);
  const seen = new Set();
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--help" && args.length === 1) return { help: true };
    requireValue(!seen.has(flag), `Duplicate argument: ${flag}.`);
    seen.add(flag);
    if (["--latest", "--skip-native"].includes(flag)) {
      options[flag === "--latest" ? "latest" : "skipNative"] = true;
    } else {
      const key = keys.get(flag);
      requireValue(key && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--"), `Unknown argument or missing value: ${flag}.`);
      options[key] = args[++i];
    }
  }
  requireValue(options.repository === REPOSITORY, "Only the authoritative release repository is supported.");
  requireValue(/^[a-f0-9]{40}$/.test(options.sourceSha ?? ""), "Expected a full lowercase source SHA.");
  requireValue(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(options.tag ?? ""), "Expected a canonical stable release tag.");
  /** @type {readonly ("runId" | "runAttempt")[]} */
  const runKeys = ["runId", "runAttempt"];
  for (const key of runKeys)
    requireValue(options[key] === undefined || /^[1-9]\d*$/.test(options[key]), `Invalid ${key}.`);
  requireValue(!options.runAttempt || options.runId, "--run-attempt requires --run-id.");
  return publicOptionsValues(options);
}

/** @param {import("../shared/tooling-domain-values.mjs").ReleaseDto} release */
export function releaseSnapshot(release) {
  requireValue(Array.isArray(release.assets), "Missing release assets.");
  return JSON.stringify({
    id: release.id, tag: release.tag_name, body: release.body, draft: release.draft,
    prerelease: release.prerelease, publishedAt: release.published_at,
    assets: sort(map(release.assets, a => [a.id, a.name, a.state, a.size, a.digest, a.browser_download_url, a.updated_at]),
      compareAssetRows),
  });
}

/** @param {Pick<import("../shared/tooling-domain-values.mjs").PublicOptions, "sourceSha">} options @returns {(run: import("../shared/tooling-domain-values.mjs").SourceWorkflowDto) => boolean} */
export function sourceWorkflowMatches({ sourceSha }) {
  return run => Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.head_sha === sourceSha && run.head_branch === "main" &&
    ["push", "workflow_dispatch"].includes(run.event) && run.path === ".github/workflows/release.yml";
}

/** @param {import("../shared/tooling-domain-values.mjs").SourceWorkflowDto} run @param {import("../shared/tooling-domain-values.mjs").PublicOptions} options */
export function sameSourceWorkflow(run, options) {
  return sourceWorkflowMatches(options)(run);
}

/** @param {string} name @returns {(job: import("../shared/tooling-domain-values.mjs").PublicationJobDto) => boolean} */
const jobNamed = name => job => typeof job.name === "string" && job.name.split(" / ").at(-1) === name;
/** @param {string} platform @returns {(job: import("../shared/tooling-domain-values.mjs").PublicationJobDto) => boolean} */
const platformBuilder = platform => job => (job.name.split(" / ").at(-1) ?? "").startsWith(`release-platforms (${platform},`);
/** @param {string} name @returns {(step: {name: string, conclusion: string | null}) => boolean} */
const successfulStepNamed = name => step => step.name === name && step.conclusion === "success";

/** @param {import("../shared/tooling-domain-values.mjs").PublicationJobsDto} jobs @param {string} name */
function namedJobs(jobs, name) {
  requireValue(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length, "Incomplete hosted job list.");
  return filter(jobs.jobs, jobNamed(name));
}
/** @param {import("../shared/tooling-domain-values.mjs").PublicationJobDto | undefined} job */
const completed = job => job?.status === "completed" && job.conclusion === "success";

/** @param {import("../shared/tooling-domain-values.mjs").SourceWorkflowDto} run @param {import("../shared/tooling-domain-values.mjs").PublicationJobsDto} jobs @param {import("../shared/tooling-domain-values.mjs").ActionsArtifactDto} artifact @param {import("../shared/tooling-domain-values.mjs").Provenance} provenance @param {import("../shared/tooling-domain-values.mjs").ReleaseMetadata} marker @param {import("../shared/tooling-domain-values.mjs").PublicOptions} options */
export function validateArtifactProduction(run, jobs, artifact, provenance, marker, options) {
  requireValue(sameSourceWorkflow(run, options) && String(run.id) === provenance.runId &&
    String(run.run_attempt) === provenance.runAttempt && run.status === "completed", "Artifact-producing workflow source, attempt or completed state differs.");
  for (const name of ["build", "assemble"]) {
    const matches = namedJobs(jobs, name);
    requireValue(matches.length === 1 && completed(matches[0]), `Missing successful artifact gate: ${name}.`);
  }
  const assembler = namedJobs(jobs, "assemble")[0];
  requireValue(assembler.steps?.some(step => step.name.includes("actions/upload-artifact@") && step.conclusion === "success"), "Assembly artifact upload did not succeed.");
  for (const platform of ["windows", "linux"]) {
    const matches = filter(jobs.jobs, platformBuilder(platform));
    requireValue(matches.length === 1 && completed(matches[0]), `Missing successful ${platform} builder.`);
  }
  requireValue(String(artifact.id) === marker.artifact.id && artifact.name === provenance.artifactName &&
    artifact.digest === marker.artifact.digest && !artifact.expired &&
    String(artifact.workflow_run?.id) === provenance.runId &&
    artifact.workflow_run?.head_sha === options.sourceSha, "Actions artifact metadata differs or has expired.");
}

/** @param {import("../shared/tooling-domain-values.mjs").SourceWorkflowDto} run @param {import("../shared/tooling-domain-values.mjs").PublicationJobsDto} jobs @param {import("../shared/tooling-domain-values.mjs").PublicOptions} options */
export function hasSuccessfulPublisher(run, jobs, options) {
  const publisher = namedJobs(jobs, "publish");
  return sameSourceWorkflow(run, options) && run.status === "completed" && run.conclusion === "success" &&
    publisher.length === 1 && completed(publisher[0]) &&
    publisher[0].steps?.some(successfulStepNamed("Restore and verify the exact workflow artifact")) &&
    publisher[0].steps?.some(successfulStepNamed("Stage, verify and publish without moving latest backwards"));
}

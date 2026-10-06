// Public artifact proof only. Never publishes, installs or starts the application.
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY, requireValue, createReportDirectory, privateWriter,
  githubMetadata, anonymousBytes, downloadActionsZip, privateEnvironment, runReadOnly, bunInstallCommand,
} from "./release-public-io.mjs";
import { peelTag, verifySource } from "./release-public-source.mjs";

const MAX_PUBLIC_TOTAL = 512 * 1024 * 1024;
const MAX_PUBLICATION_ATTEMPTS = 20;
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

export function parseOptions(args) {
  const options = { repository: REPOSITORY, latest: false, skipNative: false };
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
      requireValue(keys.has(flag) && typeof args[i + 1] === "string" && !args[i + 1].startsWith("--"), `Unknown argument or missing value: ${flag}.`);
      options[keys.get(flag)] = args[++i];
    }
  }
  requireValue(options.repository === REPOSITORY, "Only the authoritative release repository is supported.");
  requireValue(/^[a-f0-9]{40}$/.test(options.sourceSha ?? ""), "Expected a full lowercase source SHA.");
  requireValue(/^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(options.tag ?? ""), "Expected a canonical stable release tag.");
  for (const key of ["runId", "runAttempt"])
    requireValue(options[key] === undefined || /^[1-9]\d*$/.test(options[key]), `Invalid ${key}.`);
  requireValue(!options.runAttempt || options.runId, "--run-attempt requires --run-id.");
  return options;
}

export function releaseSnapshot(release) {
  requireValue(Array.isArray(release.assets), "Missing release assets.");
  return JSON.stringify({
    id: release.id, tag: release.tag_name, body: release.body, draft: release.draft,
    prerelease: release.prerelease, publishedAt: release.published_at,
    assets: release.assets.map(a => [a.id, a.name, a.state, a.size, a.digest, a.browser_download_url, a.updated_at]).sort(),
  });
}

function sameSourceWorkflow(run, options) {
  return Number.isSafeInteger(run.id) && run.id > 0 &&
    Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0 &&
    run.head_sha === options.sourceSha && run.head_branch === "main" &&
    ["push", "workflow_dispatch"].includes(run.event) && run.path === ".github/workflows/release.yml";
}

function namedJobs(jobs, name) {
  requireValue(Array.isArray(jobs.jobs) && jobs.total_count === jobs.jobs.length, "Incomplete hosted job list.");
  return jobs.jobs.filter(job => typeof job.name === "string" && job.name.split(" / ").at(-1) === name);
}
const completed = job => job?.status === "completed" && job.conclusion === "success";
const stepSucceeded = (job, name) => job.steps?.some(step => step.name === name && step.conclusion === "success");

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
    const matches = jobs.jobs.filter(job => job.name.split(" / ").at(-1).startsWith(`release-platforms (${platform},`));
    requireValue(matches.length === 1 && completed(matches[0]), `Missing successful ${platform} builder.`);
  }
  requireValue(String(artifact.id) === marker.artifact.id && artifact.name === provenance.artifactName &&
    artifact.digest === marker.artifact.digest && !artifact.expired &&
    String(artifact.workflow_run?.id) === provenance.runId &&
    artifact.workflow_run?.head_sha === options.sourceSha, "Actions artifact metadata differs or has expired.");
}

function hasSuccessfulPublisher(run, jobs, options) {
  const publisher = namedJobs(jobs, "publish");
  return sameSourceWorkflow(run, options) && run.status === "completed" && run.conclusion === "success" &&
    publisher.length === 1 && completed(publisher[0]) &&
    stepSucceeded(publisher[0], "Restore and verify the exact workflow artifact") &&
    stepSucceeded(publisher[0], "Stage, verify and publish without moving latest backwards");
}

export async function publicationEvidence(api, originalRun, originalJobs, options) {
  if (hasSuccessfulPublisher(originalRun, originalJobs, options))
    return { runId: String(originalRun.id), runAttempt: String(originalRun.run_attempt), recoveredOriginalArtifact: false };
  // Rerunning only a failed publisher may omit previously successful assembly
  // jobs from this attempt. Its restore step revalidates the original marker,
  // ZIP digest and signed payload; original build/assembly proof remains separate.
  const listed = await api(`/actions/workflows/release.yml/runs?head_sha=${options.sourceSha}&per_page=100`);
  requireValue(Array.isArray(listed.workflow_runs) && listed.workflow_runs.length <= 100, "Invalid or oversized publication run list.");
  const candidates = listed.workflow_runs.filter(run => sameSourceWorkflow(run, options));
  let checked = 0;
  for (const candidate of candidates) {
    const first = candidate.id === originalRun.id ? originalRun.run_attempt + 1 : 1;
    for (let attempt = candidate.run_attempt; attempt >= first && checked < MAX_PUBLICATION_ATTEMPTS; attempt--) {
      checked++;
      const runId = String(candidate.id);
      const run = attempt === candidate.run_attempt ? candidate : await api(`/actions/runs/${runId}/attempts/${attempt}`);
      requireValue(sameSourceWorkflow(run, options) && run.id === candidate.id && run.run_attempt === attempt, "Publication attempt has a different source or identity.");
      if (run.status !== "completed" || run.conclusion !== "success") continue;
      const jobs = await api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
      if (hasSuccessfulPublisher(run, jobs, options))
        return { runId, runAttempt: String(attempt), recoveredOriginalArtifact: true };
    }
  }
  throw new Error(`No successful exact-source publication with original artifact restoration found within ${MAX_PUBLICATION_ATTEMPTS} attempts.`);
}

async function checkMovingFeeds(io, source, release, files, final = false) {
  const latest = await io.api("/releases/latest", { fresh: final });
  requireValue(latest.id === release.id && latest.tag_name === release.tag_name && !latest.draft && !latest.prerelease, "Selected release is no longer the public latest stable release.");
  for (const name of ["latest.json", "latest-semver.json"]) {
    const url = source.core.ENDPOINT.replace(/latest\.json$/, name);
    const bytes = await io.download(url, source.core.MAX_UPDATER_METADATA);
    requireValue(bytes.equals(files.get(name)), `Moving updater feed differs: ${name}.`);
    await io.write(`${final ? "final-" : ""}public-${name}`, bytes);
  }
}

export async function verifyPublishedRelease(options, io) {
  const source = await (io.verifySource ?? verifySource)(options, io);
  const { core, identity, planner, plan } = source;
  requireValue(await peelTag(io.api, options.tag) === options.sourceSha, "Public release tag targets a different source.");
  const release = await io.api(`/releases/tags/${options.tag}`);
  const marker = core.releaseMetadata(release);
  requireValue(!release.draft && marker.schemaVersion === 3 && marker.sourceSha === options.sourceSha &&
    marker.version === identity.version && marker.firstParentCount === identity.firstParentCount &&
    marker.planSha256 === planner.planSha256(plan), "Public release marker differs from the reserved semantic source.");
  const snapshot = releaseSnapshot(release);
  const names = core.expectedNames(identity.version, marker.schemaVersion).sort();
  requireValue(release.assets.length === names.length && release.assets.map(a => a.name).sort().join("|") === names.join("|"), "Public release asset set differs.");
  let total = 0;
  for (const asset of release.assets) {
    requireValue(/^[A-Za-z0-9_.-]+$/.test(asset.name) && asset.state === "uploaded" &&
      Number.isSafeInteger(asset.size) && asset.size > 0 && asset.size <= core.MAX_RELEASE_ASSET &&
      asset.browser_download_url === `https://github.com/${options.repository}/releases/download/${options.tag}/${asset.name}`, "Invalid public asset metadata or immutable URL.");
    total += asset.size;
  }
  requireValue(total <= Math.min(MAX_PUBLIC_TOTAL, core.MAX_RELEASE_BUNDLE), "Public bundle exceeds its byte bound.");
  const files = new Map();
  for (const asset of release.assets) {
    const bytes = await io.download(asset.browser_download_url, Math.min(asset.size, core.MAX_RELEASE_ASSET));
    requireValue(bytes.length === asset.size && (!asset.digest || asset.digest === `sha256:${core.sha256(bytes)}`), `Public asset size/digest differs: ${asset.name}.`);
    files.set(asset.name, bytes);
    await io.write(asset.name, bytes);
    io.progress?.(`Downloaded anonymously: ${asset.name}.`);
  }
  const provenance = core.validateBundle(files, identity, source.config.plugins.updater.pubkey);
  requireValue(provenance.runId === marker.artifact.runId &&
    (!options.runId || provenance.runId === options.runId) &&
    (!options.runAttempt || provenance.runAttempt === options.runAttempt), "Build run differs from release marker or requested identity.");
  const [run, jobs, artifact] = await Promise.all([
    io.api(`/actions/runs/${provenance.runId}/attempts/${provenance.runAttempt}`),
    io.api(`/actions/runs/${provenance.runId}/attempts/${provenance.runAttempt}/jobs?per_page=100`),
    io.api(`/actions/artifacts/${marker.artifact.id}`),
  ]);
  validateArtifactProduction(run, jobs, artifact, provenance, marker, options);
  const publication = await publicationEvidence(io.api, run, jobs, options);
  const assets = release.assets.map(a => ({ name: a.name, size: a.size, sha256: core.sha256(files.get(a.name)) }));
  const zip = await io.verifyZip({ assets, artifactId: marker.artifact.id, artifactDigest: marker.artifact.digest, limit: total + 1024 * 1024 });
  requireValue(zip.zipDigest === marker.artifact.digest && zip.publicAssetCount === assets.length, "Actions ZIP proof differs from public assets.");
  if (options.latest) await checkMovingFeeds(io, source, release, files);
  if (!options.skipNative) await io.verifyNative(source, identity.version);

  // Confirm the immutable source, reservation and asset identities after every
  // expensive check. A newer main is allowed; latest is only asserted on request.
  await source.confirmReservations();
  requireValue(await peelTag(io.api, options.tag, true) === options.sourceSha, "Release tag changed during verification.");
  const finalRelease = await io.api(`/releases/tags/${options.tag}`, { fresh: true });
  requireValue(releaseSnapshot(finalRelease) === snapshot, "Release metadata or assets changed during verification.");
  if (options.latest) await checkMovingFeeds(io, source, release, files, true);
  const result = {
    schemaVersion: 1, verifiedAt: new Date().toISOString(), repository: options.repository,
    sourceSha: options.sourceSha, tag: options.tag, version: identity.version,
    releaseId: release.id, runId: provenance.runId, runAttempt: provenance.runAttempt,
    publicationRunId: publication.runId, publicationRunAttempt: publication.runAttempt,
    publicationRecoveredOriginalArtifact: publication.recoveredOriginalArtifact,
    originalRunConclusion: run.conclusion,
    artifactId: marker.artifact.id, artifactDigest: marker.artifact.digest,
    metadataAuthenticated: true, publicAssetsAnonymous: true, sourceGitAnonymous: true,
    feedScope: options.latest ? "immutable assets and moving latest URLs" : "immutable release assets",
    latestReleaseChecked: options.latest, nativeMacOSContainersVerified: !options.skipNative,
    semanticSourceProof: source.proof, actionsZipProof: zip, assets,
    proofs: ["exact-source tag and first-parent ancestry", "source-pinned semantic ledger and regenerated plan/notes",
      "anonymous release assets, feeds, checksums, updater signature and platform containers",
      "successful exact-source original build/assembly and Actions artifact metadata",
      "successful exact-source publication and original artifact restoration", "original Actions ZIP digest and identical public entries",
      "final immutable metadata/tag/reservation readback"],
    unproven: [
      ...(options.skipNative ? ["macOS archive/DMG app contents and Apple code signatures"] : []),
      ...(!options.latest ? ["currently selected latest release and moving updater endpoints"] : []),
      "Windows/Linux application contents rely on source-bound native build receipts; local proof checks container formats",
      "installed updater behavior", "application installation/runtime", "real game behavior",
    ],
  };
  await io.write("final-verification.json", JSON.stringify(result, null, 2) + "\n");
  return result;
}

export async function main(args = process.argv.slice(2)) {
  const options = parseOptions(args);
  if (options.help) { console.log(HELP); return; }
  bunInstallCommand(); // Reject a different runtime before downloads or writes.
  requireValue(options.skipNative || process.platform === "darwin", "macOS container verification requires macOS; use --skip-native to record that gap.");
  const folder = await createReportDirectory();
  console.log(`Evidence directory: ${folder}`);
  const write = privateWriter(folder);
  await write("request.json", JSON.stringify(options, null, 2) + "\n");
  const python = process.platform === "win32" ? "python" : "python3";
  const environment = privateEnvironment(folder);
  try {
    const result = await verifyPublishedRelease(options, {
      folder, write, api: githubMetadata(options.repository), download: anonymousBytes,
      progress: message => console.log(message),
      async verifyZip({ assets, artifactId, artifactDigest, limit }) {
        await write("public-assets.json", JSON.stringify(assets) + "\n");
        const archive = join(folder, "actions-artifact.zip");
        await downloadActionsZip(options.repository, artifactId, archive, limit);
        const bytes = runReadOnly(python, [fileURLToPath(new URL("./release-public-zip.py", import.meta.url)), archive, join(folder, "public-assets.json"), artifactDigest], { env: environment });
        await write("actions-artifact-proof.json", bytes);
        return JSON.parse(bytes.toString("utf8"));
      },
      async verifyNative(source, version) {
        runReadOnly(python, [join(source.sourceFolder, "scripts/release-native.py"), "verify", folder, version], { env: environment });
      },
    });
    console.log(`PASS: ${result.tag} from ${result.sourceSha}. Report: ${join(folder, "final-verification.json")}`);
  } catch (error) {
    await write("failure.json", JSON.stringify({ verified: false, message: error.message }) + "\n");
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });

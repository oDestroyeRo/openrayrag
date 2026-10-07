import { filter, map, sort } from "effect/Array";
import { workflowRunId, workflowAttemptText, publicReleaseValues } from "../shared/tooling-domain-values.mjs";
import { fileBytes } from "./release-policy.mjs";
// Public artifact proof only. Never publishes, installs or starts the application.
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY, requireValue, createReportDirectory, privateWriter,
  githubMetadata, anonymousBytes, downloadActionsZip, privateEnvironment, runReadOnly, bunInstallCommand,
} from "./release-public-io.mjs";
import { peelTag, verifySource } from "./release-public-source.mjs";

import {
  MAX_PUBLIC_TOTAL, MAX_PUBLICATION_ATTEMPTS, HELP, parseOptions,
  releaseSnapshot, sourceWorkflowMatches, validateArtifactProduction, hasSuccessfulPublisher,
} from "./release-public-policy.mjs";
export { HELP, parseOptions, releaseSnapshot, validateArtifactProduction } from "./release-public-policy.mjs";

const compareNames = (a, b) => a < b ? -1 : a > b ? 1 : 0;

/** @param {import("../shared/tooling-domain-values.mjs").PublicMetadataApi} api @param {import("../shared/tooling-domain-values.mjs").SourceWorkflowDto} originalRun @param {import("../shared/tooling-domain-values.mjs").PublicationJobsDto} originalJobs @param {import("../shared/tooling-domain-values.mjs").PublicOptions} options @returns {Promise<import("../shared/tooling-domain-values.mjs").PublicationEvidence>} */
export async function publicationEvidence(api, originalRun, originalJobs, options) {
  if (hasSuccessfulPublisher(originalRun, originalJobs, options))
    return { runId: workflowRunId(originalRun.id), runAttempt: workflowAttemptText(originalRun.run_attempt), recoveredOriginalArtifact: false };
  // Rerunning only a failed publisher may omit previously successful assembly
  // jobs from this attempt. Its restore step revalidates the original marker,
  // ZIP digest and signed payload; original build/assembly proof remains separate.
  const matchesSource = sourceWorkflowMatches(options);
  const listed = await api(`/actions/workflows/release.yml/runs?head_sha=${options.sourceSha}&per_page=100`);
  requireValue(Array.isArray(listed.workflow_runs) && listed.workflow_runs.length <= 100, "Invalid or oversized publication run list.");
  const candidates = filter(listed.workflow_runs, matchesSource);
  let checked = 0;
  for (const candidate of candidates) {
    const first = candidate.id === originalRun.id ? originalRun.run_attempt + 1 : 1;
    for (let attempt = candidate.run_attempt; attempt >= first && checked < MAX_PUBLICATION_ATTEMPTS; attempt--) {
      checked++;
      const runId = workflowRunId(candidate.id);
      const run = attempt === candidate.run_attempt ? candidate : await api(`/actions/runs/${runId}/attempts/${attempt}`);
      requireValue(matchesSource(run) && run.id === candidate.id && run.run_attempt === attempt, "Publication attempt has a different source or identity.");
      if (run.status !== "completed" || run.conclusion !== "success") continue;
      const jobs = await api(`/actions/runs/${runId}/attempts/${attempt}/jobs?per_page=100`);
      if (hasSuccessfulPublisher(run, jobs, options))
        return { runId, runAttempt: workflowAttemptText(attempt), recoveredOriginalArtifact: true };
    }
  }
  throw new Error(`No successful exact-source publication with original artifact restoration found within ${MAX_PUBLICATION_ATTEMPTS} attempts.`);
}

/** @param {import("../shared/tooling-domain-values.mjs").PublicVerificationIo} io @param {Awaited<ReturnType<typeof verifySource>>} source @param {import("../shared/tooling-domain-values.mjs").ReleaseDto} release @param {Map<string, Buffer>} files @param {boolean} [final] */
async function checkMovingFeeds(io, source, release, files, final = false) {
  const latest = await io.api("/releases/latest", { fresh: final });
  requireValue(latest.id === release.id && latest.tag_name === release.tag_name && !latest.draft && !latest.prerelease, "Selected release is no longer the public latest stable release.");
  for (const name of ["latest.json", "latest-semver.json"]) {
    const url = source.core.ENDPOINT.replace(/latest\.json$/, name);
    const bytes = await io.download(url, source.core.MAX_UPDATER_METADATA);
    requireValue(bytes.equals(fileBytes(files, name)), `Moving updater feed differs: ${name}.`);
    await io.write(`${final ? "final-" : ""}public-${name}`, bytes);
  }
}

/** @param {import("../shared/tooling-domain-values.mjs").PublicOptions} options @param {import("../shared/tooling-domain-values.mjs").PublicVerificationIo} io */
export async function verifyPublishedRelease(options, io) {
  const source = await (io.verifySource ?? verifySource)(options, io);
  const { core, identity, planner, plan } = source;
  requireValue(await peelTag(io.api, options.tag) === options.sourceSha, "Public release tag targets a different source.");
  const releaseDto = await io.api(`/releases/tags/${options.tag}`);
  const marker = source.core.releaseMetadata(releaseDto);

  requireValue(!releaseDto.draft && marker.schemaVersion === 3 && marker.sourceSha === options.sourceSha &&
    marker.version === identity.version && marker.firstParentCount === identity.firstParentCount &&
    marker.planSha256 === planner.planSha256(plan), "Public release marker differs from the reserved semantic source.");
  const snapshot = releaseSnapshot(releaseDto);
  const release = publicReleaseValues(releaseDto);
  const names = sort(core.expectedNames(identity.version, marker.schemaVersion), compareNames);
  requireValue(release.assets.length === names.length && sort(map(release.assets, a => a.name), compareNames).join("|") === names.join("|"), "Public release asset set differs.");
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
    const bytes = await io.download(asset.browser_download_url ?? "", Math.min(asset.size, core.MAX_RELEASE_ASSET));
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
  const assets = map(release.assets, a => ({ name: a.name, size: a.size, sha256: core.sha256(fileBytes(files, a.name)) }));
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
        runReadOnly(python, [join(source.sourceFolder, source.scriptDirectory ?? "scripts", "release-native.py"), "verify", folder, version], { env: environment });
      },
    });
    console.log(`PASS: ${result.tag} from ${result.sourceSha}. Report: ${join(folder, "final-verification.json")}`);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    await write("failure.json", JSON.stringify({ verified: false, message: error.message }) + "\n");
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error.message); process.exitCode = 1; });

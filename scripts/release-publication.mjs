import { releaseTagFor, releaseId, ownedReleaseDto } from './tooling-domain-values.mjs';
import { find, map } from "remeda";
// Publication orchestration. API, dates, reservations and native verification
// are injected; release-policy owns all deterministic bundle/source contracts.
import { compareVersions, planSha256 } from "./semantic-release-policy.mjs";
import {
  requireValue, identity, countOf, expectedNames, validateBundle, validateArtifact,
  releaseBody, releaseMetadata, parseJson, sourceCount, isNewer, fileBytes,
  validateReleaseAncestry,
} from "./release-policy.mjs";

/** @param {import('./tooling-domain-values.mjs').ReleaseContext} ctx @param {import('./tooling-domain-values.mjs').ReleaseDto} release @param {import('./tooling-domain-values.mjs').ReleaseMetadata} [metadata] */
async function assertRelease(ctx, release, metadata) {
  const meta = metadata ?? validateReleaseAncestry(ctx.history, release);
  requireValue(
    (await ctx.api.tagSha(releaseTagFor(meta.version))) === meta.sourceSha,
    "Existing release tag points to another commit.",
  );
  return meta;
}
/** @param {import('./tooling-domain-values.mjs').ReleaseContext} ctx @param {import('./tooling-domain-values.mjs').ReleaseDto} release */
export async function verifiedRelease(ctx, release) {
  const metadata = validateReleaseAncestry(ctx.history, release);
  ctx = { ...ctx, history: Array.isArray(ctx.history) ? [...ctx.history] : ctx.history };
  release = structuredClone(release);
  const meta = await assertRelease(ctx, release, metadata);
  /** @type {import('./tooling-domain-values.mjs').ReleaseIdentity} */
  let id =
      meta.schemaVersion === 3
        ? {
            sourceSha: meta.sourceSha,
            firstParentCount: meta.firstParentCount,
            version: meta.version,
            tag: releaseTagFor(meta.version),
            pubDate: await ctx.dateFor(meta.sourceSha),
          }
        : identity(
            ctx.history,
            meta.sourceSha,
            await ctx.dateFor(meta.sourceSha),
          );
  const files = await ctx.api.downloadRelease(
    release,
    expectedNames(id.version, meta.schemaVersion),
  );
  const p = validateBundle(files, id, ctx.publicKey);
  requireValue(
    p.runId === meta.artifact.runId && p.schemaVersion === meta.schemaVersion,
    "Release and build run provenance differ.",
  );
  if (meta.schemaVersion === 3 && p.schemaVersion === 3) {
    requireValue(
      typeof ctx.verifyPlan === "function" &&
        planSha256(p.releasePlan) === meta.planSha256,
      "Published release is missing its exact reserved plan.",
    );
    await ctx.verifyPlan(p.releasePlan);
    id = { ...id, releasePlan: p.releasePlan };
  }
  await ctx.verifyNative(files, id);
  return { meta, id, files };
}
/** @param {import('./tooling-domain-values.mjs').CandidateContext} ctx @returns {Promise<import('./tooling-domain-values.mjs').PreflightResult>} */
export async function preflight(ctx) {
  ctx = { ...ctx, history: Array.isArray(ctx.history) ? [...ctx.history] : ctx.history, id: structuredClone(ctx.id) };
  const rawRelease = await ctx.api.release(ctx.id.tag);
  const release = rawRelease && ownedReleaseDto(rawRelease);
  if (!release) {
    const tag = await ctx.api.tagSha(ctx.id.tag);
    requireValue(
      !tag || tag === ctx.id.sourceSha,
      "Version tag already points to another commit.",
    );
    return { state: "build" };
  }
  const meta = await assertRelease(ctx, release);
  requireValue(
    meta.sourceSha === ctx.id.sourceSha &&
      (!ctx.id.releasePlan ||
        (meta.schemaVersion === 3 &&
          meta.planSha256 === planSha256(ctx.id.releasePlan))),
    "Release source or plan conflict.",
  );
  if (!release.draft) {
    await verifiedRelease(ctx, release);
    return { state: "published", artifact: meta.artifact };
  }
  return { state: "reuse", artifact: meta.artifact };
}
/** @param {import('./tooling-domain-values.mjs').ReleaseContext} ctx */
async function latestState(ctx) {
  const rawLatest = await ctx.api.latest();
  const latest = rawLatest && ownedReleaseDto(rawLatest);
  if (!latest) return null;
  requireValue(!latest.draft, "Latest release cannot be a draft.");
  const { meta } = await verifiedRelease(ctx, latest);
  return {
    release: latest,
    count:
      meta.schemaVersion === 3 ? meta.firstParentCount : countOf(meta.version),
    version: meta.version,
  };
}
/** @param {import('./tooling-domain-values.mjs').PublicationContext} ctx */
export async function publishRelease(ctx) {
  ctx = { ...ctx, history: Array.isArray(ctx.history) ? [...ctx.history] : ctx.history, id: structuredClone(ctx.id), artifact: ctx.artifact && { ...ctx.artifact } };
  requireValue(
    ctx.history[sourceCount(ctx.id) - 1] === ctx.id.sourceSha,
    "Candidate is not the current main first-parent version.",
  );
  let latest = await latestState(ctx),
    release = await ctx.api.release(ctx.id.tag);
  if (release) release = ownedReleaseDto(release);
  if (release && !release.draft) {
    await verifiedRelease(ctx, release);
    requireValue(
      releaseMetadata(release).sourceSha === ctx.id.sourceSha,
      "Published source conflict.",
    );
    if (!latest || isNewer(ctx.id, latest))
      await promote(ctx, release, true, latest);
    return "already-published";
  }
  requireValue(
    ctx.files instanceof Map,
    "Original complete signed bundle is required to resume a draft.",
  );
  const candidate = validateBundle(ctx.files, ctx.id, ctx.publicKey);
  if (candidate.schemaVersion === 3) {
    requireValue(
      typeof ctx.verifyPlan === "function",
      "Release plan verification is required.",
    );
    await ctx.verifyPlan(candidate.releasePlan);
  }
  await ctx.verifyNative(ctx.files, ctx.id);
  requireValue(ctx.artifact, "Invalid workflow artifact fields.");
  validateArtifact(ctx.artifact);
  const provenance = parseJson(ctx.files.get("provenance.json"), "provenance");
  requireValue(
    provenance.runId === ctx.artifact.runId,
    "Original artifact run differs from signed bundle provenance.",
  );
  let tag = await ctx.api.tagSha(ctx.id.tag);
  requireValue(
    !tag || tag === ctx.id.sourceSha,
    "Version tag already points to another commit.",
  );
  if (!tag) {
    try {
      await ctx.api.createTag(ctx.id.tag, ctx.id.sourceSha);
    } catch {
      /* An uncertain create must be reconciled by exact readback. */
    }
    tag = await ctx.api.tagSha(ctx.id.tag);
    requireValue(
      tag === ctx.id.sourceSha,
      "Tag creation not confirmed; nothing was published.",
    );
  }
  if (!release) {
    try {
      release = await ctx.api.createDraft(
        ctx.id,
        releaseBody(ctx.id, ctx.artifact, provenance.schemaVersion),
      );
    } catch {
      release = await ctx.api.release(ctx.id.tag);
    }
    requireValue(
      release,
      "Draft creation not confirmed; rerun with the same workflow artifact.",
    );
  }
  release = ownedReleaseDto(release);
  const meta = await assertRelease(ctx, release);
  requireValue(
    release.draft &&
      meta.sourceSha === ctx.id.sourceSha &&
      meta.schemaVersion === provenance.schemaVersion &&
      (meta.schemaVersion !== 3 ||
        meta.planSha256 === planSha256(provenance.releasePlan)) &&
      JSON.stringify(meta.artifact) === JSON.stringify(ctx.artifact),
    "Draft belongs to another build. Reuse its original artifact; never mix rebuilds.",
  );
  const releaseNames = expectedNames(ctx.id.version, provenance.schemaVersion);
  for (const name of releaseNames) {
    let assets = await ctx.api.assets(releaseId(release.id));
    requireValue(
      assets.length <= releaseNames.length &&
        new Set(map(assets, (a) => a.name)).size === assets.length &&
        assets.every((a) => releaseNames.includes(a.name)),
      "Unexpected or duplicate draft assets.",
    );
    let asset = find(assets, (a) => a.name === name);
    if (!asset) {
      try {
        await ctx.api.upload(releaseId(release.id), name, fileBytes(ctx.files, name));
      } catch {
        /* Reconcile a lost upload response without replacing any asset. */
      }
      assets = await ctx.api.assets(releaseId(release.id));
      asset = find(assets, (a) => a.name === name);
    }
    requireValue(
      asset && asset.state === "uploaded",
      `Upload ${name} is incomplete. Rerun the original artifact; do not overwrite assets.`,
    );
    const bytes = await ctx.api.downloadAsset(asset);
    requireValue(
      bytes !== null && bytes.equals(fileBytes(ctx.files, name)),
      `Asset ${name} conflicts with the original bundle. Draft left unpublished.`,
    );
  }
  release = await ctx.api.release(ctx.id.tag);
  requireValue(release?.draft, "Draft changed while staging.");
  release = ownedReleaseDto(release);
  await verifiedRelease(ctx, release);
  latest = await latestState(ctx);
  const makeLatest = !latest || isNewer(ctx.id, latest);
  await promote(ctx, release, makeLatest, latest);
  return makeLatest ? "published-latest" : "published-older";
}
/** @param {import('./tooling-domain-values.mjs').CandidateContext} ctx @param {import('./tooling-domain-values.mjs').ReleaseDto} release @param {boolean} makeLatest @param {Awaited<ReturnType<typeof latestState>>} minimumLatest */
async function promote(ctx, release, makeLatest, minimumLatest) {
  release = ownedReleaseDto(release);
  try {
    await ctx.api.publish(releaseId(release.id), {
      draft: false,
      prerelease: false,
      make_latest: makeLatest ? "true" : "false",
    });
  } catch {
    /* Publication may have succeeded: confirm the same immutable asset set below. */
  }
  const after = await ctx.api.release(ctx.id.tag);
  requireValue(
    after && after.id === release.id && !after.draft,
    "Publication not confirmed; retry the original workflow artifact.",
  );
  await verifiedRelease(ctx, after);
  const latest = await latestState(ctx);
  requireValue(
    latest &&
      (!minimumLatest ||
        (latest.count >= minimumLatest.count &&
          compareVersions(latest.version, minimumLatest.version) >= 0)) &&
      (!makeLatest ||
        (latest.count >= sourceCount(ctx.id) &&
          compareVersions(latest.version, ctx.id.version) >= 0)),
    "Latest promotion was not confirmed or moved backwards.",
  );
}

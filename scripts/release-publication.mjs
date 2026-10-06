// Publication orchestration. API, dates, reservations and native verification
// are injected; release-policy owns all deterministic bundle/source contracts.
import { compareVersions, planSha256 } from "./semantic-release-policy.mjs";
import {
  requireValue, identity, countOf, expectedNames, validateBundle, validateArtifact,
  releaseBody, releaseMetadata, parseJson, sourceCount, isNewer,
  validateReleaseAncestry,
} from "./release-policy.mjs";

async function assertRelease(ctx, release) {
  const meta = validateReleaseAncestry(ctx.history, release);
  requireValue(
    (await ctx.api.tagSha(release.tag_name)) === meta.sourceSha,
    "Existing release tag points to another commit.",
  );
  return meta;
}
export async function verifiedRelease(ctx, release) {
  const meta = await assertRelease(ctx, release),
    id =
      meta.schemaVersion === 3
        ? {
            sourceSha: meta.sourceSha,
            firstParentCount: meta.firstParentCount,
            version: meta.version,
            tag: `v${meta.version}`,
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
  if (meta.schemaVersion === 3) {
    requireValue(
      typeof ctx.verifyPlan === "function" &&
        planSha256(p.releasePlan) === meta.planSha256,
      "Published release is missing its exact reserved plan.",
    );
    await ctx.verifyPlan(p.releasePlan);
    id.releasePlan = p.releasePlan;
  }
  await ctx.verifyNative(files, id);
  return { meta, id, files };
}
export async function preflight(ctx) {
  const release = await ctx.api.release(ctx.id.tag);
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
async function latestState(ctx) {
  const latest = await ctx.api.latest();
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
export async function publishRelease(ctx) {
  requireValue(
    ctx.history[sourceCount(ctx.id) - 1] === ctx.id.sourceSha,
    "Candidate is not the current main first-parent version.",
  );
  let latest = await latestState(ctx),
    release = await ctx.api.release(ctx.id.tag);
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
    let assets = await ctx.api.assets(release.id);
    requireValue(
      assets.length <= releaseNames.length &&
        new Set(assets.map((a) => a.name)).size === assets.length &&
        assets.every((a) => releaseNames.includes(a.name)),
      "Unexpected or duplicate draft assets.",
    );
    let asset = assets.find((a) => a.name === name);
    if (!asset) {
      try {
        await ctx.api.upload(release.id, name, ctx.files.get(name));
      } catch {
        /* Reconcile a lost upload response without replacing any asset. */
      }
      assets = await ctx.api.assets(release.id);
      asset = assets.find((a) => a.name === name);
    }
    requireValue(
      asset && asset.state === "uploaded",
      `Upload ${name} is incomplete. Rerun the original artifact; do not overwrite assets.`,
    );
    const bytes = await ctx.api.downloadAsset(asset);
    requireValue(
      bytes.equals(ctx.files.get(name)),
      `Asset ${name} conflicts with the original bundle. Draft left unpublished.`,
    );
  }
  release = await ctx.api.release(ctx.id.tag);
  requireValue(release?.draft, "Draft changed while staging.");
  await verifiedRelease(ctx, release);
  latest = await latestState(ctx);
  const makeLatest = !latest || isNewer(ctx.id, latest);
  await promote(ctx, release, makeLatest, latest);
  return makeLatest ? "published-latest" : "published-older";
}
async function promote(ctx, release, makeLatest, minimumLatest) {
  try {
    await ctx.api.publish(release.id, {
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

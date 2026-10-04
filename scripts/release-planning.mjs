// Trusted-source orchestration. The pure engines and reservation ledger own policy;
// callers inject Git history, commit ranges, API access and native verification.
import {
  planRelease,
  validatePlan,
  serializePlan,
  planSha256,
  MAX_PLAN_BYTES,
} from "./semantic-release-plan.mjs";
import {
  readReservations,
  reservePlan,
  verifyReservedPlan,
} from "./release-reservations.mjs";
import {
  requireValue,
  migrationBridge,
  legacyFeed,
  verifiedRelease,
  preflight,
} from "./release-core.mjs";
const baseOf = ({ sourceSha, version, tag }) => ({ sourceSha, version, tag });
export const planIdentity = (plan) => ({
  sourceSha: plan.sourceSha,
  firstParentCount: plan.firstParentCount,
  version: plan.version,
  tag: plan.tag,
  pubDate: plan.pubDate,
  releasePlan: plan,
});

export async function reservationContext(ctx, bridge = migrationBridge) {
  requireValue(
    ctx.history[bridge.firstParentCount - 1] === bridge.sourceSha,
    "Migration bridge is outside current main ancestry.",
  );
  const plans = await readReservations({ ...ctx, bridge });
  const verifyPlan = async (plan) => {
    validatePlan(plan);
    const reserved = plans.find((p) => p.sourceSha === plan.sourceSha);
    requireValue(
      reserved && planSha256(reserved) === planSha256(plan),
      "Release does not match its durable reservation.",
    );
  };
  return { ...ctx, bridge, plans, verifyPlan };
}
export async function planProduction(
  ctx,
  { bridge = migrationBridge, feed = legacyFeed } = {},
) {
  const index = ctx.history.indexOf(ctx.sha);
  requireValue(index >= 0, "Release source is outside current main ancestry.");
  let context = await reservationContext(ctx, bridge);
  const anchor = await ctx.api.release(context.bridge.tag);
  requireValue(
    anchor && !anchor.draft,
    "Published migration bridge is required.",
  );
  const verifiedBridge = await verifiedRelease(context, anchor);
  requireValue(
    verifiedBridge.id.sourceSha === context.bridge.sourceSha &&
      verifiedBridge.files.get("latest.json").equals(feed()),
    "Migration bridge/feed changed.",
  );
  const latest = await ctx.api.latest();
  requireValue(
    latest && !latest.draft,
    "Verified published baseline is required.",
  );
  const published = await verifiedRelease(context, latest);
  const publishedCount = ctx.history.indexOf(published.id.sourceSha) + 1;
  requireValue(
    publishedCount >= context.bridge.firstParentCount &&
      (published.meta.schemaVersion === 3 ||
        published.id.sourceSha === context.bridge.sourceSha),
    "Published baseline is outside the semantic migration.",
  );
  let plan = context.plans.find((p) => p.sourceSha === ctx.sha);
  if (plan) {
    const release = await ctx.api.release(plan.tag);
    // Preserve an existing draft's original artifact even after a later release.
    if (publishedCount > index + 1 && !release)
      return {
        state: "skip",
        reason: "Source was superseded by a published release.",
      };
  } else {
    const previous = context.plans.at(-1);
    if (index + 1 <= Math.max(publishedCount, previous?.firstParentCount ?? 0))
      return {
        state: "skip",
        reason: "Source was already published or superseded.",
      };
    const analysisBase = previous ?? published.id;
    const result = await planRelease({
      source: {
        sourceSha: ctx.sha,
        firstParentCount: index + 1,
        pubDate: await ctx.dateFor(ctx.sha),
      },
      published: baseOf(published.id),
      reservation: previous ?? null,
      analysisCommits: await ctx.commitsBetween(
        analysisBase.sourceSha,
        ctx.sha,
      ),
      notesCommits: await ctx.commitsBetween(published.id.sourceSha, ctx.sha),
    });
    if (result.state === "skip") return result;
    plan = await reservePlan({ ...ctx, bridge: context.bridge }, result.plan);
    context = await reservationContext(ctx, bridge);
  }
  const id = planIdentity(plan);
  return { ...(await preflight({ ...context, id })), id, plan };
}
export async function loadProductionPlan(ctx, bytes) {
  requireValue(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= MAX_PLAN_BYTES,
    "Invalid transported plan size.",
  );
  let plan;
  try {
    plan = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("Malformed transported plan.");
  }
  validatePlan(plan);
  requireValue(
    bytes.equals(Buffer.from(serializePlan(plan))) &&
      plan.sourceSha === ctx.sha &&
      ctx.history[plan.firstParentCount - 1] === ctx.sha &&
      plan.pubDate === (await ctx.dateFor(ctx.sha)),
    "Transported plan differs from the exact workflow source.",
  );
  requireValue(
    ctx.history[migrationBridge.firstParentCount - 1] ===
      migrationBridge.sourceSha,
    "Migration bridge is outside current main ancestry.",
  );
  const verifyPlan = (candidate) =>
    verifyReservedPlan({ ...ctx, bridge: migrationBridge }, candidate);
  await verifyPlan(plan);
  return {
    ...ctx,
    bridge: migrationBridge,
    verifyPlan,
    id: planIdentity(plan),
  };
}

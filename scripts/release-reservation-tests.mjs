import test from "node:test";
import assert from "node:assert/strict";
import { canonicalJson } from "../release.config.mjs";
import {
  planRelease,
  planSha256,
  serializePlan,
  MAX_NOTES_BYTES,
} from "./semantic-release-plan.mjs";
import {
  readReservations,
  reservePlan,
  serializeReservation,
  planRefName,
  PLAN_REF_PREFIX,
  MAX_RESERVATIONS,
  MAX_RESERVATION_BYTES,
} from "./release-reservations.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
const history = Array.from({ length: 8 }, (_, i) => sha(i + 1));
const bridge = {
  version: "0.2.63",
  tag: "v0.2.63",
  sourceSha: history[0],
  firstParentCount: 1,
};
const baseOf = ({ sourceSha, version, tag }) => ({ sourceSha, version, tag });
async function planAt(
  n = 2,
  predecessor = null,
  published = bridge,
  releaseType = "patch",
) {
  const commits = [
    {
      hash: sha(n),
      message: `${releaseType === "minor" ? "feat" : "fix"}: source ${n}`,
    },
  ];
  const { plan } = await planRelease(
    {
      source: {
        sourceSha: sha(n),
        firstParentCount: n,
        pubDate: "2026-10-04T00:00:00.000Z",
      },
      published: baseOf(published),
      reservation: predecessor,
      analysisCommits: commits,
      notesCommits: commits,
    },
    {
      analyzer: () => releaseType,
      notesGenerator: () => `Release source ${n}\n`,
    },
  );
  return plan;
}
class FakeApi {
  constructor() {
    this.refs = new Map();
    this.tags = new Map();
    this.calls = [];
    this.nextSha = 100;
  }
  tag(name, message, sourceSha) {
    const object = {
      sha: sha(this.nextSha++),
      tag: name,
      message,
      object: { type: "commit", sha: sourceSha },
    };
    this.tags.set(object.sha, object);
    return object;
  }
  install(plan, message = serializeReservation(plan)) {
    const name = planRefName(plan);
    const tag = this.tag(
      name.slice("refs/tags/".length),
      message,
      plan.sourceSha,
    );
    this.refs.set(name, { ref: name, object: { type: "tag", sha: tag.sha } });
    return tag;
  }
  async planRefs() {
    this.calls.push(["planRefs"]);
    return structuredClone(
      this.listedRefs ?? [...this.refs.values()].reverse(),
    );
  }
  async tagObject(objectSha) {
    this.calls.push(["tagObject", objectSha]);
    return structuredClone(this.tags.get(objectSha) ?? null);
  }
  async createPlanTag(name, message, sourceSha) {
    this.calls.push(["createPlanTag", name, message, sourceSha]);
    if (this.onCreateTag) return this.onCreateTag(name, message, sourceSha);
    return structuredClone(this.tag(name, message, sourceSha));
  }
  async createPlanRef(name, objectSha) {
    this.calls.push(["createPlanRef", name, objectSha]);
    if (this.onCreateRef) return this.onCreateRef(name, objectSha);
    assert.equal(
      this.refs.has(name),
      false,
      "Ref creation never overwrites an existing ref.",
    );
    const ref = { ref: name, object: { type: "tag", sha: objectSha } };
    this.refs.set(name, ref);
    return structuredClone(ref);
  }
  async planRef(name) {
    this.calls.push(["planRef", name]);
    return structuredClone(this.lookupRef ?? this.refs.get(name) ?? null);
  }
}
const context = (api = new FakeApi()) => ({
  api,
  history: [...history],
  bridge: { ...bridge },
});
const writes = (api) =>
  api.calls.filter(([method]) => method.startsWith("create"));
const tagFor = (api, plan) =>
  api.tags.get(api.refs.get(planRefName(plan)).object.sha);

test("failed A build still reserves A; B increments from A and A retry reuses its frozen bytes", async () => {
  const ctx = context();
  const a = await planAt();
  const confirmedA = await reservePlan(ctx, a);
  assert.equal(serializePlan(confirmedA), serializePlan(a));
  // Build effects are outside this ledger. Nothing deletes A after a failure.
  const b = await planAt(4, confirmedA, bridge, "minor");
  b.notes = "Unpublished fix from A\nFeature from B\n";
  assert.equal(b.version, "0.3.0");
  assert.deepEqual(b.analysisBase, baseOf(a));
  assert.deepEqual(b.notesBase, baseOf(bridge));
  assert.equal(b.predecessorPlanSha256, planSha256(a));
  await reservePlan(ctx, b);
  const writeCount = writes(ctx.api).length;
  const retry = await reservePlan(ctx, JSON.parse(serializePlan(a)));
  assert.equal(serializePlan(retry), serializePlan(a));
  assert.equal(writes(ctx.api).length, writeCount);
  assert.deepEqual(await readReservations(ctx), [a, b]);
  assert.deepEqual(
    writes(ctx.api).map(([method]) => method),
    ["createPlanTag", "createPlanRef", "createPlanTag", "createPlanRef"],
  );
});

test("canonical envelope sorts every key, binds the plan hash and ends with one LF", async () => {
  const plan = await planAt();
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  reordered.analysisBase = Object.fromEntries(
    Object.entries(plan.analysisBase).reverse(),
  );
  const message = serializeReservation(reordered);
  assert.equal(message, serializeReservation(plan));
  assert.equal(
    message,
    canonicalJson({ schemaVersion: 1, plan, planSha256: planSha256(plan) }) +
      "\n",
  );
  const ctx = context();
  await reservePlan(ctx, plan);
  assert.deepEqual(writes(ctx.api)[0], [
    "createPlanTag",
    "rayrag-release-plan/v0.2.64",
    message,
    plan.sourceSha,
  ]);
  assert.equal(writes(ctx.api)[1][1], "refs/tags/rayrag-release-plan/v0.2.64");
});

test("reservation snapshots caller bytes before any asynchronous effects", async () => {
  const ctx = context(),
    plan = await planAt(),
    before = serializePlan(plan);
  const original = ctx.api.planRefs.bind(ctx.api);
  ctx.api.planRefs = async () => {
    plan.notes = "Caller changed notes during the request\n";
    return original();
  };
  assert.equal(serializePlan(await reservePlan(ctx, plan)), before);
});

test("retry rejects a recomputed plan for the same source without writes", async () => {
  const ctx = context(),
    a = await planAt();
  ctx.api.install(a);
  await assert.rejects(
    reservePlan(ctx, { ...a, notes: "New notes\n" }),
    /conflicts/,
  );
  const differentVersion = await planAt(2, null, bridge, "minor");
  await assert.rejects(reservePlan(ctx, differentVersion), /conflicts/);
  assert.deepEqual(writes(ctx.api), []);
});

test("an exact competing ref winner is accepted without overwrite", async () => {
  const ctx = context(),
    a = await planAt();
  ctx.api.onCreateRef = async () => {
    ctx.api.install(a);
    throw new Error("Ref already exists");
  };
  assert.deepEqual(await reservePlan(ctx, a), a);
  assert.equal(writes(ctx.api).length, 2);
});

test("a competing source for the same version stops reservation", async () => {
  const ctx = context(),
    a = await planAt(),
    competing = await planAt(3);
  ctx.api.onCreateRef = async () => {
    ctx.api.install(competing);
    throw new Error("Ref already exists");
  };
  await assert.rejects(reservePlan(ctx, a), /conflicts with the frozen plan/);
  assert.deepEqual(await readReservations(ctx), [competing]);
  assert.equal(writes(ctx.api).length, 2);
});

test("lost ref POST response is reconciled by complete ledger and exact ref readback", async () => {
  const ctx = context(),
    a = await planAt();
  ctx.api.onCreateRef = async (name, objectSha) => {
    ctx.api.refs.set(name, {
      ref: name,
      object: { type: "tag", sha: objectSha },
    });
    throw new Error("Lost response");
  };
  assert.deepEqual(await reservePlan(ctx, a), a);
  assert.equal(
    ctx.api.calls.filter(([method]) => method === "planRefs").length,
    2,
  );
  assert.ok(
    ctx.api.calls.some(
      ([method, name]) => method === "planRef" && name === planRefName(a),
    ),
  );
});

test("uncertain tag POST accepts an exact ref created concurrently and never repeats POST", async () => {
  const ctx = context(),
    a = await planAt();
  ctx.api.onCreateTag = async () => {
    ctx.api.install(a);
    throw new Error("Lost tag response");
  };
  assert.deepEqual(await reservePlan(ctx, a), a);
  assert.deepEqual(
    writes(ctx.api).map(([method]) => method),
    ["createPlanTag"],
  );
});

test("uncertain tag POST without a confirming ref fails and leaves an orphan object alone", async () => {
  const ctx = context(),
    a = await planAt();
  ctx.api.onCreateTag = async (name, message, sourceSha) => {
    ctx.api.tag(name, message, sourceSha);
    throw new Error("Lost tag response");
  };
  await assert.rejects(reservePlan(ctx, a), /creation was not confirmed/);
  assert.equal(ctx.api.tags.size, 1);
  assert.equal(ctx.api.refs.size, 0);
  assert.deepEqual(
    writes(ctx.api).map(([method]) => method),
    ["createPlanTag"],
  );
});

test("missing tag SHA and an uncertain unsuccessful ref POST fail without retries", async () => {
  for (const stage of ["tag", "ref"]) {
    const ctx = context(),
      a = await planAt();
    if (stage === "tag") ctx.api.onCreateTag = async () => ({});
    else
      ctx.api.onCreateRef = async () => {
        throw new Error("Request failed");
      };
    await assert.rejects(reservePlan(ctx, a), /creation was not confirmed/);
    assert.equal(
      writes(ctx.api).filter(([method]) => method === "createPlanTag").length,
      1,
    );
    assert.equal(
      writes(ctx.api).filter(([method]) => method === "createPlanRef").length,
      stage === "tag" ? 0 : 1,
    );
  }
});

test("created tag metadata is checked before any ref write", async () => {
  const ctx = context(),
    a = await planAt();
  ctx.api.onCreateTag = async (name, message, sourceSha) => {
    const object = ctx.api.tag(name, message, sourceSha);
    object.object.type = "tag";
    return { sha: object.sha };
  };
  await assert.rejects(reservePlan(ctx, a), /target a commit directly/);
  assert.deepEqual(
    writes(ctx.api).map(([method]) => method),
    ["createPlanTag"],
  );
});

test("ledger accepts a published notes base at an earlier reservation", async () => {
  const ctx = context(),
    a = await planAt(),
    b = await planAt(3, a),
    c = await planAt(4, b, a);
  for (const plan of [c, a, b]) ctx.api.install(plan);
  assert.deepEqual(await readReservations(ctx), [a, b, c]);
  assert.deepEqual(c.notesBase, baseOf(a));
});

test("a deleted or missing predecessor fails rather than freeing its version", async () => {
  const ctx = context(),
    a = await planAt(),
    b = await planAt(3, a);
  ctx.api.install(b);
  await assert.rejects(readReservations(ctx), /analysis base differs/);
  assert.deepEqual(writes(ctx.api), []);
});

test("ledger detects rewritten source ancestry, ordinals and bridge history", async () => {
  const a = await planAt();
  for (const mutate of [
    (ctx) => {
      ctx.history[1] = sha(99);
    },
    (ctx) => {
      ctx.history.reverse();
    },
    (ctx) => {
      ctx.bridge.firstParentCount = 2;
    },
    (ctx) => {
      ctx.history.push(ctx.history[0]);
    },
  ]) {
    const ctx = context();
    ctx.api.install(a);
    mutate(ctx);
    await assert.rejects(readReservations(ctx), /history/);
  }
  const ctx = context();
  ctx.api.install({ ...a, firstParentCount: 3 });
  await assert.rejects(readReservations(ctx), /source differs/);
});

test("new reservations cannot precede the bridge or insert before the ledger head", async () => {
  const a = await planAt(3),
    ctx = context();
  const oldBridge = {
    ...bridge,
    sourceSha: sha(0),
    version: "0.2.62",
    tag: "v0.2.62",
  };
  const before = await planAt(1, null, oldBridge);
  await assert.rejects(
    reservePlan(ctx, before),
    /existing source|follow its predecessor/,
  );
  ctx.api.install(a);
  const earlier = await planAt(2);
  await assert.rejects(reservePlan(ctx, earlier), /existing source or version/);
  const inserted = await planAt(2, null, bridge, "minor");
  await assert.rejects(reservePlan(ctx, inserted), /increase|analysis base/);
  assert.deepEqual(writes(ctx.api), []);
});

test("ledger rejects a replaced predecessor hash, foreign notes base and unchained analysis base", async () => {
  const a = await planAt(),
    b = await planAt(3, a);
  for (const corruption of [
    { predecessorPlanSha256: null },
    { predecessorPlanSha256: "f".repeat(64) },
    { notesBase: { ...baseOf(bridge), sourceSha: sha(7) } },
    {
      analysisBase: baseOf(bridge),
      version: "0.3.0",
      tag: "v0.3.0",
      releaseType: "minor",
    },
  ]) {
    const ctx = context();
    ctx.api.install(a);
    ctx.api.install({ ...b, ...corruption });
    await assert.rejects(readReservations(ctx), /predecessor|notes base/);
  }
});

test("ledger rejects duplicate reserved source, version and returned ref", async () => {
  const a = await planAt();
  const ctx = context();
  ctx.api.install(a);
  const sameSource = await planAt(2, null, bridge, "minor");
  ctx.api.install(sameSource);
  await assert.rejects(readReservations(ctx), /Duplicate reserved source/);
  const duplicate = context();
  duplicate.api.install(a);
  duplicate.api.listedRefs = [
    ...duplicate.api.refs.values(),
    ...duplicate.api.refs.values(),
  ];
  await assert.rejects(
    readReservations(duplicate),
    /Duplicate release reservation ref/,
  );
  const versionCollision = context();
  versionCollision.api.install(a);
  await assert.rejects(
    reservePlan(versionCollision, await planAt(3)),
    /existing source or version/,
  );
  assert.deepEqual(writes(versionCollision.api), []);
});

test("malformed foreign ref names and nonannotated refs are rejected", async () => {
  const a = await planAt();
  for (const name of [
    "refs/tags/v0.2.64",
    "refs/tags/rayrag-release-plan-bad/v0.2.64",
    `${PLAN_REF_PREFIX}0.2.64`,
    `${PLAN_REF_PREFIX}v00.2.64`,
    `${PLAN_REF_PREFIX}v0.2.64/extra`,
    `${PLAN_REF_PREFIX}v0.2.64-rc.1`,
    `${PLAN_REF_PREFIX}v0.2.64+build`,
  ]) {
    const ctx = context();
    ctx.api.install(a);
    ctx.api.listedRefs = [{ ...ctx.api.refs.get(planRefName(a)), ref: name }];
    await assert.rejects(readReservations(ctx), /ref|stable release version/);
  }
  for (const object of [
    { type: "commit", sha: a.sourceSha },
    { type: "tag", sha: "bad" },
  ]) {
    const ctx = context();
    ctx.api.install(a);
    ctx.api.refs.get(planRefName(a)).object = object;
    await assert.rejects(readReservations(ctx), /annotated tag/);
  }
});

test("object SHA, internal tag name, target type and source must match exactly", async () => {
  const a = await planAt();
  for (const mutate of [
    (tag) => {
      tag.sha = sha(999);
    },
    (tag) => {
      tag.tag = "v0.2.64";
    },
    (tag) => {
      tag.object.type = "tag";
    },
    (tag) => {
      tag.object.sha = sha(4);
    },
  ]) {
    const ctx = context();
    ctx.api.install(a);
    mutate(tagFor(ctx.api, a));
    await assert.rejects(
      readReservations(ctx),
      /SHA differs|tag name|target a commit|source differs/,
    );
  }
  const ctx = context();
  ctx.api.install(a);
  const ref = ctx.api.refs.get(planRefName(a));
  ctx.api.tags.delete(ref.object.sha);
  await assert.rejects(readReservations(ctx), /SHA differs/);
});

test("canonical envelopes reject missing LF, pretty JSON, duplicate keys, hash and metadata injection", async () => {
  const a = await planAt(),
    message = serializeReservation(a),
    envelope = JSON.parse(message);
  for (const bad of [
    message.trimEnd(),
    JSON.stringify(envelope, null, 2) + "\n",
    message.replace(
      '"schemaVersion":1}',
      '"schemaVersion":1,"schemaVersion":1}',
    ),
    canonicalJson({ ...envelope, schemaVersion: 2 }) + "\n",
    canonicalJson({ ...envelope, planSha256: "f".repeat(64) }) + "\n",
    canonicalJson({ ...envelope, extra: true }) + "\n",
    "{bad json",
    "a".repeat(MAX_RESERVATION_BYTES + 1),
  ]) {
    const ctx = context();
    ctx.api.install(a, bad);
    await assert.rejects(
      readReservations(ctx),
      /canonical|envelope|hash|JSON|size/,
    );
  }
});

test("plan policy, identity, schema, notes and version increments cannot be forged", async () => {
  const a = await planAt();
  for (const corruption of [
    { repository: "other/repo" },
    { schemaVersion: 2 },
    { policyVersion: 2 },
    { policySha256: "f".repeat(64) },
    { version: "0.2.65", tag: "v0.2.65" },
    { tag: "v0.2.65" },
    { notes: "<!-- rayrag-release-plan:{} -->" },
    { notes: "a".repeat(MAX_NOTES_BYTES + 1) },
    { notes: "bad\0notes" },
    { extra: true },
  ]) {
    const ctx = context(),
      plan = { ...a, ...corruption };
    const forged =
      canonicalJson({ schemaVersion: 1, plan, planSha256: "f".repeat(64) }) +
      "\n";
    ctx.api.install(a, forged);
    await assert.rejects(readReservations(ctx));
    await assert.rejects(reservePlan(context(), plan));
    assert.deepEqual(writes(ctx.api), []);
  }
});

test("confirmation rejects incomplete listing and mismatched direct ref lookup", async () => {
  const a = await planAt();
  const ctx = context();
  ctx.api.onCreateRef = async (name, objectSha) => {
    ctx.api.refs.set(name, {
      ref: name,
      object: { type: "tag", sha: objectSha },
    });
    ctx.api.listedRefs = [];
  };
  await assert.rejects(reservePlan(ctx, a), /absent from the complete ledger/);
  const lookup = context();
  lookup.api.install(a);
  lookup.api.lookupRef = {
    ...lookup.api.refs.get(planRefName(a)),
    ref: `${PLAN_REF_PREFIX}v0.2.65`,
  };
  await assert.rejects(reservePlan(lookup, a), /name differs from its lookup/);
});

test("complete ref list is bounded and must be an array", async () => {
  const ctx = context();
  for (const listed of [null, {}, new Array(MAX_RESERVATIONS + 1).fill(null)]) {
    ctx.api.listedRefs = listed;
    if (listed === null) ctx.api.planRefs = async () => null;
    else ctx.api.planRefs = FakeApi.prototype.planRefs.bind(ctx.api);
    await assert.rejects(readReservations(ctx), /ref list/);
  }
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  identity,
  assetNames,
  expectedNames,
  createBundle,
  validateBundle,
  verifyUpdaterSignature,
  releaseBody,
  releaseMetadata,
  preflight,
  publishRelease,
  countOf,
  sha256,
} from "./release-core.mjs";
import { stampVersions, GitHubReleaseApi } from "./release.mjs";
// Ephemeral synthetic test key, never a release key and never serialized/logged.
const pair = generateKeyPairSync("ed25519"),
  keyId = Buffer.alloc(8, 7);
const publicBytes = pair.publicKey
  .export({ format: "der", type: "spki" })
  .subarray(-32);
const publicKey = Buffer.from(
  `untrusted comment: synthetic test public key\n${Buffer.concat([Buffer.from("Ed"), keyId, publicBytes]).toString("base64")}\n`,
).toString("base64");
const history = Array.from({ length: 4 }, (_, i) =>
  (i + 1).toString(16).padStart(40, "0"),
);
const dateFor = async () => "2026-10-02T00:00:00.000Z";
const id = (n) => identity(history, history[n - 1], "2026-10-02T00:00:00.000Z");
function signature(data, version, commentVersion = version) {
  const raw = sign(
      null,
      createHash("blake2b512").update(data).digest(),
      pair.privateKey,
    ),
    comment = `timestamp:1\tfile:Rayrag Companion.app.tar.gz\tversion:${commentVersion}`;
  return Buffer.from(
    `untrusted comment: synthetic test signature\n${Buffer.concat([Buffer.from("ED"), keyId, raw]).toString("base64")}\ntrusted comment: ${comment}\n${sign(null, Buffer.concat([raw, Buffer.from(comment)]), pair.privateKey).toString("base64")}\n`,
  ).toString("base64");
}
function bundle(n = 2, dmg = "synthetic dmg") {
  const ident = id(n),
    names = assetNames(ident.version),
    archive = Buffer.from(`synthetic archive for ${ident.version}`),
    runId = String(100 + n);
  return createBundle(
    ident,
    new Map([
      [names.archive, archive],
      [names.signature, Buffer.from(signature(archive, ident.version) + "\n")],
      [names.dmg, Buffer.from(dmg)],
    ]),
    {
      runId,
      runAttempt: "1",
      artifactName: `release-${ident.sourceSha}-${runId}-1`,
    },
    publicKey,
  );
}
const artifact = (n) => ({
  id: String(1000 + n),
  runId: String(100 + n),
  digest: `sha256:${"a".repeat(64)}`,
});
class FakeApi {
  tags = new Map();
  releases = new Map();
  stored = new Map();
  next = 1;
  latestTag = null;
  events = [];
  loseCreate = false;
  loseUpload = false;
  losePublish = false;
  failUpload = null;
  async tagSha(tag) {
    return this.tags.get(tag) ?? null;
  }
  async createTag(tag, sha) {
    this.events.push(["tag", tag]);
    this.tags.set(tag, sha);
  }
  async release(tag) {
    const r = this.releases.get(tag);
    return r ? { ...r } : null;
  }
  async latest() {
    return this.latestTag ? this.release(this.latestTag) : null;
  }
  async createDraft(ident, body) {
    const r = {
      id: this.next++,
      tag_name: ident.tag,
      body,
      draft: true,
      prerelease: false,
    };
    this.releases.set(ident.tag, r);
    this.stored.set(r.id, []);
    this.events.push(["draft", ident.tag]);
    if (this.loseCreate) {
      this.loseCreate = false;
      throw new Error("Lost create response");
    }
    return { ...r };
  }
  async assets(releaseId) {
    return this.stored.get(releaseId).map((a) => ({ ...a }));
  }
  async upload(releaseId, name, bytes) {
    this.events.push(["upload", name]);
    if (this.failUpload === name) throw new Error("Upload failed");
    this.stored.get(releaseId).push({
      id: this.next++,
      name,
      bytes: Buffer.from(bytes),
      size: bytes.length,
      state: "uploaded",
    });
    if (this.loseUpload) {
      this.loseUpload = false;
      throw new Error("Lost upload response");
    }
  }
  async downloadAsset(asset) {
    return Buffer.from(asset.bytes);
  }
  async downloadRelease(release, names) {
    const rows = await this.assets(release.id);
    assert.deepEqual(rows.map((a) => a.name).sort(), [...names].sort());
    return new Map(rows.map((a) => [a.name, Buffer.from(a.bytes)]));
  }
  async publish(releaseId, options) {
    const release = [...this.releases.values()].find((r) => r.id === releaseId);
    assert.equal(
      this.stored.get(releaseId).length,
      6,
      "publish occurs only after completeness",
    );
    assert.deepEqual(Object.keys(options).sort(), [
      "draft",
      "make_latest",
      "prerelease",
    ]);
    Object.assign(release, {
      draft: options.draft,
      prerelease: options.prerelease,
    });
    if (options.make_latest === "true") this.latestTag = release.tag_name;
    this.events.push(["publish", release.tag_name, options.make_latest]);
    if (this.losePublish) {
      this.losePublish = false;
      throw new Error("Lost publish response");
    }
  }
}
function context(api, n = 2) {
  return {
    api,
    history,
    id: id(n),
    dateFor,
    publicKey,
    files: bundle(n),
    artifact: artifact(n),
    verifyNative: async () => {},
  };
}
const json = (value) => Buffer.from(JSON.stringify(value, null, 2) + "\n");
function changeJson(files, name, change) {
  const data = JSON.parse(files.get(name));
  change(data);
  files.set(name, json(data));
}

test("version follows exact first-parent position, stable across later merges", () => {
  assert.equal(id(2).version, "0.2.2");
  assert.deepEqual(
    identity(history.slice(0, 2), history[1], id(2).pubDate),
    id(2),
  );
  assert.throws(
    () => identity(history, "f".repeat(40), id(2).pubDate),
    /first-parent/,
  );
  assert.throws(() => countOf("0.2.02"));
  assert.throws(() => countOf("0.2.9007199254740992"));
});
test("signature verifies archive, committed key and authenticated version", () => {
  const data = Buffer.from("payload"),
    sig = signature(data, "0.2.2");
  verifyUpdaterSignature(data, sig, publicKey, "0.2.2");
  assert.throws(
    () =>
      verifyUpdaterSignature(Buffer.from("changed"), sig, publicKey, "0.2.2"),
    /signature rejected/,
  );
  assert.throws(
    () => verifyUpdaterSignature(data, sig, publicKey, "0.2.3"),
    /authenticate/,
  );
  assert.throws(
    () => verifyUpdaterSignature(data, sig + "!", publicKey, "0.2.2"),
    /encoding/,
  );
  const box = Buffer.from(sig, "base64")
    .toString()
    .replace("timestamp:1", "timestamp:2");
  assert.throws(
    () =>
      verifyUpdaterSignature(
        data,
        Buffer.from(box).toString("base64"),
        publicKey,
        "0.2.2",
      ),
    /comment.*rejected/,
  );
});
test("complete bundle uses immutable tag archive and signature contents", () => {
  const files = bundle();
  validateBundle(files, id(2), publicKey);
  const latest = JSON.parse(files.get("latest.json"));
  assert.match(
    latest.platforms["darwin-aarch64"].url,
    /\/v0\.2\.2\/Rayrag_Companion_0\.2\.2_aarch64\.app\.tar\.gz$/,
  );
  assert.equal(
    latest.platforms["darwin-aarch64"].signature,
    files.get(assetNames("0.2.2").signature).toString().trim(),
  );
});
for (const [name, change] of [
  [
    "mutable URL",
    (files) =>
      changeJson(files, "latest.json", (m) => {
        m.platforms["darwin-aarch64"].url = m.platforms[
          "darwin-aarch64"
        ].url.replace("/download/v0.2.2/", "/latest/download/");
      }),
  ],
  [
    "wrong architecture",
    (files) =>
      changeJson(files, "provenance.json", (m) => {
        m.target = "x86_64-apple-darwin";
      }),
  ],
  [
    "wrong source",
    (files) =>
      changeJson(files, "provenance.json", (m) => {
        m.sourceSha = history[0];
      }),
  ],
  [
    "wrong manifest version",
    (files) =>
      changeJson(files, "latest.json", (m) => {
        m.version = "0.2.3";
      }),
  ],
  [
    "extra platform",
    (files) =>
      changeJson(files, "latest.json", (m) => {
        m.platforms.other = {};
      }),
  ],
  ["bad checksum", (files) => files.set("SHA256SUMS", Buffer.from("bad"))],
  ["missing signature", (files) => files.delete(assetNames("0.2.2").signature)],
  ["extra asset", (files) => files.set("extra", Buffer.from("extra"))],
  ["malformed metadata", (files) => files.set("latest.json", Buffer.from("{"))],
  [
    "empty artifact",
    (files) => files.set(assetNames("0.2.2").dmg, Buffer.alloc(0)),
  ],
])
  test(`rejects ${name}`, () => {
    const files = bundle();
    change(files);
    assert.throws(() => validateBundle(files, id(2), publicKey));
  });
test("new publish creates exact tag, finishes uploads, verifies and promotes", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  assert.equal((await preflight(ctx)).state, "build");
  assert.equal(await publishRelease(ctx), "published-latest");
  assert.equal(await api.tagSha(id(2).tag), id(2).sourceSha);
  assert.equal(api.events.filter((e) => e[0] === "upload").length, 6);
  assert.deepEqual(api.events.at(-1), ["publish", "v0.2.2", "true"]);
});
test("published rerun is verified no-op even if a competing rebuild differs", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  await publishRelease(ctx);
  const events = api.events.length;
  assert.equal((await preflight(ctx)).state, "published");
  ctx.files = bundle(2, "rebuilt bytes");
  ctx.artifact = { ...artifact(2), id: "9999" };
  assert.equal(await publishRelease(ctx), "already-published");
  assert.equal(api.events.length, events);
});
test("older build finishing last is published but cannot roll latest backwards", async () => {
  const api = new FakeApi();
  await publishRelease(context(api, 3));
  assert.equal(await publishRelease(context(api, 2)), "published-older");
  assert.equal(api.latestTag, "v0.2.3");
  assert.deepEqual(api.events.at(-1), ["publish", "v0.2.2", "false"]);
});
test("newer successful build promotes after older release", async () => {
  const api = new FakeApi();
  await publishRelease(context(api, 2));
  await publishRelease(context(api, 3));
  assert.equal(api.latestTag, "v0.2.3");
});
test("uncertain create/upload/publish responses reconcile by exact readback", async () => {
  const api = new FakeApi();
  api.loseCreate = api.loseUpload = api.losePublish = true;
  assert.equal(await publishRelease(context(api)), "published-latest");
  assert.equal(api.releases.size, 1);
  assert.equal(api.events.filter((e) => e[0] === "upload").length, 6);
});
test("partial upload stays draft and rerun resumes the same original bundle", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  api.failUpload = "latest.json";
  await assert.rejects(publishRelease(ctx), /incomplete/);
  assert.equal((await api.release(ctx.id.tag)).draft, true);
  assert.equal(api.latestTag, null);
  assert.equal((await preflight(ctx)).state, "reuse");
  api.failUpload = null;
  assert.equal(await publishRelease(ctx), "published-latest");
  assert.equal(
    api.events.filter(
      (e) => e[0] === "upload" && e[1] === assetNames(ctx.id.version).archive,
    ).length,
    1,
  );
});
test("draft cannot mix a new build artifact with old assets", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  api.failUpload = "latest.json";
  await assert.rejects(publishRelease(ctx));
  const before = api.events.length;
  await assert.rejects(
    publishRelease({ ...ctx, artifact: { ...ctx.artifact, id: "999" } }),
    /another build/,
  );
  assert.equal(api.events.length, before);
  assert.equal(api.latestTag, null);
});
test("conflicting draft bytes are never replaced", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  api.failUpload = "latest.json";
  await assert.rejects(publishRelease(ctx));
  api.stored.get(1)[0].bytes = Buffer.from("corrupt");
  api.failUpload = null;
  await assert.rejects(publishRelease(ctx), /conflicts/);
  assert.equal(
    api.events.filter(
      (e) => e[0] === "upload" && e[1] === assetNames(ctx.id.version).archive,
    ).length,
    1,
  );
  assert.equal(api.latestTag, null);
});
test("incomplete uploaded state is not published or silently replaced", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  api.failUpload = "latest.json";
  await assert.rejects(publishRelease(ctx));
  api.stored.get(1)[0].state = "new";
  api.failUpload = null;
  await assert.rejects(publishRelease(ctx), /incomplete/);
  assert.equal(api.latestTag, null);
});
test("conflicting exact version tag rejects before release writes", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  api.tags.set(ctx.id.tag, history[0]);
  await assert.rejects(preflight(ctx), /another commit/);
  await assert.rejects(publishRelease(ctx), /another commit/);
  assert.equal(api.events.length, 0);
});
test("rewritten previous release ancestry fails closed", async () => {
  const api = new FakeApi();
  await publishRelease(context(api, 2));
  const before = api.events.length,
    ctx = context(api, 3);
  ctx.history = [history[0], "f".repeat(40), history[2], history[3]];
  await assert.rejects(publishRelease(ctx), /rewritten/);
  assert.equal(api.events.length, before);
});
test("malformed latest metadata cannot be displaced by a seemingly newer version", async () => {
  const api = new FakeApi();
  await publishRelease(context(api, 2));
  api.releases.get("v0.2.2").body = "missing provenance";
  const before = api.events.length;
  await assert.rejects(publishRelease(context(api, 3)), /provenance/);
  assert.equal(api.events.length, before);
});
test("published incomplete asset set rejects rerun without repairing published files", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  await publishRelease(ctx);
  api.stored.get(1).pop();
  const before = api.events.length;
  await assert.rejects(preflight(ctx));
  assert.equal(api.events.length, before);
});
test("native verification failure prevents any write", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  ctx.verifyNative = async () => {
    throw new Error("Wrong binary architecture");
  };
  await assert.rejects(publishRelease(ctx), /architecture/);
  assert.equal(api.events.length, 0);
});
test("CI stamping synchronizes all five files and leaves dependency versions alone", async () => {
  const root = await mkdtemp(join(tmpdir(), "rayrag-stamp-test-"));
  try {
    await mkdir(join(root, "src-tauri"));
    const files = {
      "package.json": json({
        name: "rayrag-companion",
        version: "0.1.0",
        dependencies: { test: "9.0.0" },
      }),
      "package-lock.json": json({
        version: "0.1.0",
        packages: {
          "": { version: "0.1.0" },
          "node_modules/test": { version: "9.0.0" },
        },
      }),
      "src-tauri/tauri.conf.json": json({
        version: "0.1.0",
        identifier: "com.rayrag.companion",
      }),
      "src-tauri/Cargo.toml":
        '[package]\nname = "rayrag-companion"\nversion = "0.1.0"\n[dependencies]\ntest = "9.0.0"\n',
      "src-tauri/Cargo.lock":
        'version = 4\n\n[[package]]\nname = "rayrag-companion"\nversion = "0.1.0"\n\n[[package]]\nname = "test"\nversion = "9.0.0"\n',
    };
    await Promise.all(
      Object.entries(files).map(([p, b]) => writeFile(join(root, p), b)),
    );
    await stampVersions(root, "0.2.7");
    await stampVersions(root, "0.2.7");
    assert.equal(
      JSON.parse(await readFile(join(root, "package-lock.json"))).packages[""]
        .version,
      "0.2.7",
    );
    assert.match(
      await readFile(join(root, "src-tauri/Cargo.lock"), "utf8"),
      /name = "test"\nversion = "9.0.0"/,
    );
    assert.equal(
      JSON.parse(await readFile(join(root, "src-tauri/tauri.conf.json")))
        .version,
      "0.2.7",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
test("GitHub adapter peels annotated tags instead of trusting target_commitish", async () => {
  const original = global.fetch;
  const paths = [];
  global.fetch = async (url) => {
    paths.push(String(url));
    return new Response(
      JSON.stringify(
        paths.length === 1
          ? { object: { type: "tag", sha: "a".repeat(40) } }
          : { object: { type: "commit", sha: history[1] } },
      ),
      { status: 200 },
    );
  };
  try {
    assert.equal(
      await new GitHubReleaseApi("synthetic-token").tagSha("v0.2.2"),
      history[1],
    );
    assert.match(paths[1], /git\/tags\/a{40}$/);
  } finally {
    global.fetch = original;
  }
});
test("workflow pins actions, separates signing from PR checks and queues every publisher", async () => {
  const source = await readFile(
    new URL("../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    [...source.matchAll(/uses: [^\n]+@([^\s]+)/g)].every((m) =>
      /^[a-f0-9]{40}$/.test(m[1]),
    ),
    true,
  );
  assert.match(source, /queue: max/);
  assert.match(source, /cancel-in-progress: false/);
  assert.doesNotMatch(
    source.slice(source.indexOf("  verify:"), source.indexOf("  build:")),
    /secrets\./,
  );
  assert.match(source, /ref: \$\{\{ github.sha \}\}/);
  assert.match(source, /cargo test --locked/);
  assert.match(source, /--bundles app,dmg --ci -- --locked/);
});

test("GitHub draft lookup paginates and rejects duplicate tags", async () => {
  const original = global.fetch,
    calls = [];
  let duplicate = false;
  global.fetch = async (url) => {
    calls.push(String(url));
    const page = new URL(url).searchParams.get("page");
    const rows =
      page === "1"
        ? Array.from({ length: 100 }, (_, i) => ({
            id: i + 1,
            tag_name: duplicate && i === 0 ? "v0.2.2" : `other-${i}`,
          }))
        : [{ id: 101, tag_name: "v0.2.2", draft: true }];
    return new Response(JSON.stringify(rows), { status: 200 });
  };
  try {
    const api = new GitHubReleaseApi("synthetic-token");
    assert.equal((await api.release("v0.2.2")).draft, true);
    assert.equal(calls.length, 2);
    assert.ok(calls.every((url) => !url.includes("/releases/tags/")));
    duplicate = true;
    await assert.rejects(api.release("v0.2.2"), /Multiple releases/);
  } finally {
    global.fetch = original;
  }
});

test("artifact restore rejects missing, expired or conflicting original provenance", async () => {
  const original = global.fetch;
  try {
    for (const mutate of [
      () => null,
      (m) => ({ ...m, expired: true }),
      (m) => ({ ...m, id: 777 }),
      (m) => ({ ...m, digest: "sha256:" + "b".repeat(64) }),
      (m) => ({ ...m, workflow_run: { ...m.workflow_run, id: 999 } }),
      (m) => ({
        ...m,
        workflow_run: { ...m.workflow_run, head_sha: history[0] },
      }),
    ]) {
      let calls = 0;
      global.fetch = async () => {
        calls++;
        return new Response(
          JSON.stringify(
            mutate({
              id: 1002,
              expired: false,
              digest: artifact(2).digest,
              workflow_run: { id: 102, head_sha: id(2).sourceSha },
            }),
          ),
          { status: 200 },
        );
      };
      await assert.rejects(
        new GitHubReleaseApi("synthetic-token").restoreArtifact(
          artifact(2),
          id(2),
          "/not-used",
        ),
        /expired or.*conflicting/,
      );
      assert.equal(calls, 1);
    }
  } finally {
    global.fetch = original;
  }
});

test("artifact restore checks the actual ZIP digest before extracting", async () => {
  const original = global.fetch;
  let calls = 0;
  global.fetch = async () =>
    ++calls === 1
      ? new Response(
          JSON.stringify({
            id: 1002,
            expired: false,
            digest: artifact(2).digest,
            workflow_run: { id: 102, head_sha: id(2).sourceSha },
          }),
          { status: 200 },
        )
      : new Response("different ZIP bytes", { status: 200 });
  try {
    await assert.rejects(
      new GitHubReleaseApi("synthetic-token").restoreArtifact(
        artifact(2),
        id(2),
        "/not-used",
      ),
      /ZIP checksum/,
    );
    assert.equal(calls, 2);
  } finally {
    global.fetch = original;
  }
});

test("Actions ZIP requests use the JSON API media type before a credential-free binary redirect", async () => {
  const original = global.fetch;
  const calls = [];
  const location = "https://synthetic.blob.core.windows.net/artifact.zip";
  global.fetch = async (url, options) => {
    calls.push({ url: String(url), options });
    if (String(url).endsWith("/actions/artifacts/1002")) {
      return new Response(
        JSON.stringify({
          id: 1002,
          expired: false,
          digest: artifact(2).digest,
          workflow_run: { id: 102, head_sha: id(2).sourceSha },
        }),
        { status: 200 },
      );
    }
    if (String(url).endsWith("/actions/artifacts/1002/zip")) {
      // Mirror the hosted endpoint's 415 when binary handling is confused with Accept.
      return options.headers.Accept === "application/vnd.github+json"
        ? new Response(null, { status: 302, headers: { location } })
        : new Response(null, { status: 415 });
    }
    assert.equal(String(url), location);
    return new Response("different ZIP bytes", { status: 200 });
  };
  try {
    // Reaching checksum verification proves the redirected response remained bytes.
    await assert.rejects(
      new GitHubReleaseApi("synthetic-token").restoreArtifact(
        artifact(2),
        id(2),
        "/not-used",
      ),
      /ZIP checksum/,
    );
    assert.equal(calls.length, 3);
    for (const call of calls.slice(0, 2)) {
      assert.equal(call.options.headers.Accept, "application/vnd.github+json");
      assert.equal(
        call.options.headers.Authorization,
        "Bearer synthetic-token",
      );
      assert.equal(call.options.redirect, "manual");
    }
    assert.equal(calls[2].options.headers, undefined);
    assert.equal(calls[2].options.body, undefined);
  } finally {
    global.fetch = original;
  }
});

test("download credentials never follow a CDN redirect and unknown hosts reject", async () => {
  const original = global.fetch,
    seen = [];
  let location = "https://release-assets.githubusercontent.com/synthetic";
  global.fetch = async (url, options) => {
    seen.push(options);
    return String(url).startsWith("https://api.github.com/")
      ? new Response(null, { status: 302, headers: { location } })
      : new Response("asset", { status: 200 });
  };
  try {
    const api = new GitHubReleaseApi("synthetic-token");
    assert.equal(
      (
        await api.downloadAsset({ id: 1, state: "uploaded", size: 5 })
      ).toString(),
      "asset",
    );
    assert.equal(seen[0].headers.Accept, "application/octet-stream");
    assert.equal(seen[0].headers.Authorization, "Bearer synthetic-token");
    assert.equal(seen[0].redirect, "manual");
    assert.equal(seen[1].headers, undefined);
    location = "https://untrusted.invalid/asset";
    await assert.rejects(
      api.downloadAsset({ id: 1, state: "uploaded", size: 5 }),
      /Unexpected.*redirect/,
    );
  } finally {
    global.fetch = original;
  }
});

test("duplicate JSON fields are rejected instead of accepting last-wins metadata", () => {
  const files = bundle();
  files.set(
    "latest.json",
    Buffer.from(
      files
        .get("latest.json")
        .toString()
        .replace(
          '"version": "0.2.2",',
          '"version": "0.2.2",\n  "version": "0.2.2",',
        ),
    ),
  );
  assert.throws(() => validateBundle(files, id(2), publicKey), /noncanonical/);
  const release = {
    id: 1,
    draft: true,
    prerelease: false,
    tag_name: id(2).tag,
    body: releaseBody(id(2), artifact(2)).replace(
      '"schemaVersion":1',
      '"schemaVersion":1,"schemaVersion":1',
    ),
  };
  assert.throws(() => releaseMetadata(release), /Malformed/);
});

test("release cannot exceed the installed client archive or signature bounds", () => {
  const archive = Buffer.alloc(128 * 1024 * 1024 + 1);
  assert.throws(
    () => verifyUpdaterSignature(archive, "signature", publicKey, "0.2.2"),
    /client download bound/,
  );
  assert.throws(
    () =>
      verifyUpdaterSignature(
        Buffer.from("payload"),
        "x".repeat(4097),
        publicKey,
        "0.2.2",
      ),
    /signature.*client bound/,
  );
});

test("release metadata uses main while the precreated tag retains the exact historical SHA", async () => {
  const api = new GitHubReleaseApi("synthetic-token"),
    requests = [];
  api.request = async (method, path, body) => {
    requests.push({ method, path, body });
    return {};
  };
  await api.createTag(id(2).tag, id(2).sourceSha);
  await api.createDraft(id(2), "provenance");
  await api.publish(9, {
    draft: false,
    prerelease: false,
    make_latest: "false",
  });
  assert.deepEqual(requests[0], {
    method: "POST",
    path: "git/refs",
    body: { ref: "refs/tags/v0.2.2", sha: history[1] },
  });
  assert.equal(requests[1].body.target_commitish, "main");
  assert.equal(requests[1].body.tag_name, id(2).tag);
  assert.deepEqual(requests[2], {
    method: "PATCH",
    path: "releases/9",
    body: {
      draft: false,
      prerelease: false,
      make_latest: "false",
      target_commitish: "main",
    },
  });
});

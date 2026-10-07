import { test } from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign, createHash } from "node:crypto";
import { mkdtemp, writeFile, readFile, readdir, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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
  WINDOWS_TARGET,
  LINUX_TARGET,
  platformReceipt,
  validatePlatformBuild,
  validateInstaller,
} from "./release-core.mjs";
import {
  stampVersions,
  GitHubReleaseApi,
  readLocalTagObject,
} from "./release.mjs";
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
function installers(version) {
  const names = assetNames(version),
    pe = Buffer.alloc(128),
    appimage = Buffer.alloc(64);
  pe.write("MZ");
  pe.writeUInt32LE(64, 60);
  pe.set([80, 69, 0, 0], 64);
  pe.writeUInt16LE(0x14c, 68);
  pe.writeUInt16LE(0x10b, 88);
  appimage.set([127, 69, 76, 70, 2, 1, 1], 0);
  appimage.set([65, 73, 2], 8);
  appimage.writeUInt16LE(62, 18);
  const ar = (name, data) =>
    Buffer.concat([
      Buffer.from(
        name.padEnd(16) +
          "0".padEnd(12) +
          "0".padEnd(6) +
          "0".padEnd(6) +
          "100644".padEnd(8) +
          String(data.length).padEnd(10) +
          "`\n",
      ),
      data,
      ...(data.length % 2 ? [Buffer.from("\n")] : []),
    ]);
  const deb = Buffer.concat([
    Buffer.from("!<arch>\n"),
    ar("debian-binary/", Buffer.from("2.0\n")),
    ar("control.tar.gz/", Buffer.from("control")),
    ar("data.tar.gz/", Buffer.from("data")),
  ]);
  return new Map([
    [names.windows, pe],
    [names.appimage, appimage],
    [names.deb, deb],
  ]);
}
function bundle(n = 2, dmg = "synthetic dmg", schemaVersion = 2) {
  const ident = id(n),
    names = assetNames(ident.version),
    archive = Buffer.from(`synthetic archive for ${ident.version}`),
    runId = String(100 + n);
  const payload = new Map([
    [names.archive, archive],
    [names.signature, Buffer.from(signature(archive, ident.version) + "\n")],
    [names.dmg, Buffer.from(dmg)],
  ]);
  const build = {
    runId,
    runAttempt: "1",
    artifactName: `release-${ident.sourceSha}-${runId}-1`,
    schemaVersion,
  };
  if (schemaVersion === 2) {
    for (const [name, bytes] of installers(ident.version))
      payload.set(name, bytes);
    build.platforms = [WINDOWS_TARGET, LINUX_TARGET].map((target) =>
      platformReceipt(payload, ident, build, target),
    );
  }
  return createBundle(ident, payload, build, publicKey);
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
      expectedNames(
        releaseMetadata(release).version,
        releaseMetadata(release).schemaVersion,
      ).length,
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
  assert.equal(files.size, 9);
  assert.deepEqual(Object.keys(latest.platforms), ["darwin-aarch64"]);
  assert.equal(JSON.parse(files.get("provenance.json")).platforms.length, 3);
});
test("new bundles record Bun while immutable Node releases remain verifiable", () => {
  const files = bundle();
  assert.deepEqual(validateBundle(files, id(2), publicKey).toolchain, { bun: "1.4.2", rust: "1.98.1" });
  changeJson(files, "provenance.json", p => { p.toolchain = { node: "26.10.0", rust: "1.98.1" }; });
  files.set("SHA256SUMS", Buffer.from(files.get("SHA256SUMS").toString()
    .replace(/[a-f0-9]{64}  provenance\.json/, `${sha256(files.get("provenance.json"))}  provenance.json`)));
  assert.deepEqual(validateBundle(files, id(2), publicKey).toolchain, { node: "26.10.0", rust: "1.98.1" });
  for (const toolchain of [
    { bun: "1.4.1", rust: "1.98.1" },
    { node: "26.3.0", rust: "1.98.1" },
    { bun: "1.4.2", node: "26.10.0", rust: "1.98.1" },
    { bun: "1.4.2", rust: "1.99.0" },
    { other: "1.4.2", rust: "1.98.1" },
  ]) {
    changeJson(files, "provenance.json", p => { p.toolchain = toolchain; });
    assert.throws(() => validateBundle(files, id(2), publicKey), /toolchain/);
  }
});
test("legacy six-asset bundles remain valid without Windows or Linux receipts", () => {
  const files = bundle(2, "legacy dmg", 1);
  assert.equal(validateBundle(files, id(2), publicKey).schemaVersion, 1);
  assert.equal(files.size, 6);
  assert.throws(
    () =>
      validateBundle(
        new Map([
          ...files,
          [assetNames(id(2).version).windows, Buffer.from("extra")],
        ]),
        id(2),
        publicKey,
      ),
    /asset set/,
  );
});
test("new payload cannot omit a platform or claim legacy metadata with extra installers", () => {
  const files = bundle();
  files.delete(assetNames(id(2).version).deb);
  assert.throws(() => validateBundle(files, id(2), publicKey), /asset set/);
  const forged = bundle();
  changeJson(forged, "provenance.json", (p) => {
    p.schemaVersion = 1;
    delete p.platforms;
  });
  assert.throws(() => validateBundle(forged, id(2), publicKey), /asset set/);
});
for (const [name, mutate] of [
  ["different source", (m) => (m.sourceSha = history[0])],
  ["different version", (m) => (m.version = "0.2.3")],
  ["different target", (m) => (m.target = LINUX_TARGET)],
  ["different run", (m) => (m.runId = "999")],
  ["different attempt", (m) => (m.runAttempt = "2")],
  ["missing checks", (m) => m.checks.pop()],
  ["duplicate checks", (m) => m.checks.push("package-contents")],
  ["different bytes", (m) => m.files[0].bytes++],
  ["different hash", (m) => (m.files[0].sha256 = "0".repeat(64))],
  ["foreign name", (m) => (m.files[0].name = "foreign.exe")],
])
  test(`platform receipts reject ${name}`, () => {
    const all = installers(id(2).version),
      name = assetNames(id(2).version).windows,
      files = new Map([[name, all.get(name)]]),
      build = { runId: "102", runAttempt: "1" };
    const receipt = platformReceipt(files, id(2), build, WINDOWS_TARGET);
    mutate(receipt);
    files.set("platform-build.json", json(receipt));
    assert.throws(() =>
      validatePlatformBuild(files, id(2), build, WINDOWS_TARGET),
    );
  });
test("platform receipt validation binds actual installer bytes and canonical metadata", () => {
  const all = installers(id(2).version),
    name = assetNames(id(2).version).windows,
    files = new Map([[name, all.get(name)]]),
    build = { runId: "102", runAttempt: "1" };
  const receipt = platformReceipt(files, id(2), build, WINDOWS_TARGET);
  files.set("platform-build.json", json(receipt));
  assert.deepEqual(
    validatePlatformBuild(files, id(2), build, WINDOWS_TARGET),
    receipt,
  );
  files.set("foreign.exe", Buffer.from("extra"));
  assert.throws(
    () => validatePlatformBuild(files, id(2), build, WINDOWS_TARGET),
    /unexpected files/,
  );
  files.delete("foreign.exe");
  files.get(name)[120] ^= 1;
  assert.throws(
    () => validatePlatformBuild(files, id(2), build, WINDOWS_TARGET),
    /hashes/,
  );
  files.get(name)[120] ^= 1;
  files.set("platform-build.json", Buffer.from(JSON.stringify(receipt)));
  assert.throws(
    () => validatePlatformBuild(files, id(2), build, WINDOWS_TARGET),
    /noncanonical/,
  );
});
for (const [name, mutate] of [
  ["missing platform", (p) => p.platforms.pop()],
  ["duplicate target", (p) => (p.platforms[2] = p.platforms[1])],
  ["foreign platform run", (p) => (p.platforms[1].runId = "999")],
  ["foreign platform source", (p) => (p.platforms[1].sourceSha = history[0])],
])
  test(`complete release rejects ${name}`, () => {
    const files = bundle();
    changeJson(files, "provenance.json", mutate);
    assert.throws(() => validateBundle(files, id(2), publicKey));
  });
test("installer containers reject a renamed foreign architecture or malformed header", () => {
  const files = installers("0.2.2"),
    n = assetNames("0.2.2");
  for (const [name, bytes] of files) validateInstaller(name, bytes, "0.2.2");
  const pe = Buffer.from(files.get(n.windows));
  pe.writeUInt32LE(0xffffffff, 60);
  assert.throws(() => validateInstaller(n.windows, pe, "0.2.2"), /PE header/);
  const arm = Buffer.from(files.get(n.appimage));
  arm.writeUInt16LE(183, 18);
  assert.throws(() => validateInstaller(n.appimage, arm, "0.2.2"), /x86_64/);
  const noImage = Buffer.from(files.get(n.appimage));
  noImage[10] = 1;
  assert.throws(
    () => validateInstaller(n.appimage, noImage, "0.2.2"),
    /type 2/,
  );
  const deb = Buffer.from(files.get(n.deb));
  deb.write("foreign-binary", 8);
  assert.throws(() => validateInstaller(n.deb, deb, "0.2.2"), /members/);
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
  assert.equal(api.events.filter((e) => e[0] === "upload").length, 9);
  assert.deepEqual(api.events.at(-1), ["publish", "v0.2.2", "true"]);
});
test('preflight owns release state before asynchronous tag verification', async () => {
  const api = new FakeApi(), ctx = context(api);
  await publishRelease(ctx);
  const read = api.release.bind(api), readTag = api.tagSha.bind(api);
  let borrowed;
  api.release = async tag => {
    borrowed = await read(tag);
    return borrowed;
  };
  api.tagSha = async tag => {
    if (borrowed) { borrowed.draft = true; borrowed.id = -1; borrowed.body = 'changed after API read'; }
    return readTag(tag);
  };
  assert.equal((await preflight(ctx)).state, 'published');
});
test('publisher owns created draft and staged release identities across verification effects', async () => {
  const api = new FakeApi(), ctx = context(api);
  const create = api.createDraft.bind(api), read = api.release.bind(api), readTag = api.tagSha.bind(api);
  const borrowed = [];
  api.createDraft = async (...args) => { const value = await create(...args); borrowed.push(value); return value; };
  api.release = async tag => { const value = await read(tag); if (value) borrowed.push(value); return value; };
  api.tagSha = async tag => {
    for (const value of borrowed) { value.id = -1; value.body = 'changed API alias'; value.draft = false; }
    borrowed.length = 0;
    return readTag(tag);
  };
  assert.equal(await publishRelease(ctx), 'published-latest');
  assert.equal(api.events.filter(event => event[0] === 'upload').length, 9);
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
  assert.equal(api.events.filter((e) => e[0] === "upload").length, 9);
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
test("legacy incomplete drafts resume six original assets and the next release publishes nine", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  ctx.files = bundle(2, "original legacy", 1);
  api.failUpload = "latest.json";
  await assert.rejects(publishRelease(ctx), /incomplete/);
  const originalUploads = api.events.filter(
    (e) => e[0] === "upload" && e[1].endsWith(".app.tar.gz"),
  ).length;
  assert.equal((await preflight(ctx)).state, "reuse");
  await assert.rejects(
    publishRelease({ ...ctx, files: bundle(2) }),
    /another build/,
  );
  api.failUpload = null;
  assert.equal(await publishRelease(ctx), "published-latest");
  assert.equal(api.stored.get(1).length, 6);
  assert.equal(
    api.events.filter((e) => e[0] === "upload" && e[1].endsWith(".app.tar.gz"))
      .length,
    originalUploads,
  );
  assert.equal(await publishRelease(context(api, 3)), "published-latest");
  assert.equal(api.stored.get(api.releases.get("v0.2.3").id).length, 9);
  assert.equal(api.latestTag, "v0.2.3");
});
test("a failed Linux upload leaves the new release draft until all nine assets verify", async () => {
  const api = new FakeApi(),
    ctx = context(api);
  api.failUpload = assetNames(ctx.id.version).deb;
  await assert.rejects(publishRelease(ctx), /incomplete/);
  assert.equal(api.latestTag, null);
  assert.equal((await api.release(ctx.id.tag)).draft, true);
  assert.equal(
    api.events.some((e) => e[0] === "publish"),
    false,
  );
  api.failUpload = null;
  assert.equal(await publishRelease(ctx), "published-latest");
  assert.equal(api.stored.get(1).length, 9);
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
for (const ending of ["\n", "\r\n"])
  test(`CI stamping synchronizes app versions without changing the dependency lock with ${ending.length === 2 ? "CRLF" : "LF"} and leaves dependency versions alone`, async () => {
    const root = await mkdtemp(join(tmpdir(), "rayrag-stamp-test-"));
    try {
      await mkdir(join(root, "src-tauri"));
      const files = {
        "package.json": json({
          name: "rayrag-companion",
          version: "0.1.0",
          dependencies: { test: "9.0.0" },
        }),
        "bun.lock": '{\n  "lockfileVersion": 2,\n  "workspaces": {"": {"name": "rayrag-companion", "dependencies": {"test": "9.0.0",},},},\n  "packages": {},\n}\n',
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
        Object.entries(files).map(([p, b]) =>
          writeFile(join(root, p), b.toString().replaceAll("\n", ending)),
        ),
      );
      await stampVersions(root, "0.2.7");
      await stampVersions(root, "0.2.7");
      assert.equal(await readFile(join(root, "bun.lock"), "utf8"), files["bun.lock"].replaceAll("\n", ending));
      assert.equal(JSON.parse(await readFile(join(root, "package.json"))).version, "0.2.7");
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
test("workflow pins third-party actions, separates signing from PR checks and queues every publisher", async () => {
  const source = await readFile(
    new URL("../../.github/workflows/release.yml", import.meta.url),
    "utf8",
  );
  assert.equal(
    [...source.matchAll(/uses: ([^\s]+)@([^\s]+)/g)].every((m) =>
      (/^(actions|github)\//.test(m[1]) ? /^v\d+\.\d+\.\d+$/ : /^[a-f0-9]{40}$/).test(m[2]),
    ),
    true,
  );
  assert.match(source, /queue: max/);
  assert.match(source, /cancel-in-progress: false/);
  const quality = source.slice(
    source.indexOf("  quality:"),
    source.indexOf("  verify:"),
  );
  assert.doesNotMatch(quality, /secrets\./);
  assert.doesNotMatch(quality, /contents: write|actions: write/);
  for (const target of ["aarch64-apple-darwin", WINDOWS_TARGET, LINUX_TARGET])
    assert.ok(
      quality.includes(`target: ${target}`),
      `Missing platform ${target}`,
    );
  assert.match(quality, /fail-fast: false/);
  assert.match(quality, /bun scripts\/quality\/ci-platform\.mjs build/);
  assert.match(quality, /--smoke/);
  assert.match(
    await readFile(new URL("../quality/ci-platform.mjs", import.meta.url), "utf8"),
    /nativeSmoke/,
  );
  const gate = source.slice(
    source.indexOf("  verify:"),
    source.indexOf("  release:"),
  );
  assert.match(gate, /name: CI \/ required/);
  assert.match(gate, /needs: \[quality, security\]/);
  assert.match(gate, /if: always\(\)/);
  assert.match(gate, /QUALITY_RESULT: \$\{\{ needs\.quality\.result \}\}/);
  assert.match(
    gate,
    /test "\$QUALITY_RESULT" = success && test "\$SECURITY_RESULT" = success/,
  );
  const production = await readFile(
    new URL("../../.github/workflows/release-publish.yml", import.meta.url),
    "utf8",
  );
  assert.match(production, /release-platforms:/);
  assert.match(production, /needs: \[reconcile, build, release-platforms\]/);
  assert.match(production, /path: platform-bundles\/windows/);
  assert.match(production, /path: platform-bundles\/linux/);
  assert.match(source, /ref: \$\{\{ github.sha \}\}/);
  assert.match(quality, /bun run check/);
  assert.match(production, /--bundles app,dmg --ci -- --locked/);
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
test("artifact restore extracts the immutable original legacy, multiplatform or semantic ZIP", async () => {
  for (const schemaVersion of [1, 2, 3]) {
    const context = schemaVersion === 3 ? await semanticFixture(new PlannedApi()) : null,
      ident = context?.id ?? id(2),
      files = context?.files ?? bundle(2, "original", schemaVersion);
    const root = await mkdtemp(join(tmpdir(), "rayrag-restore-test-"));
    try {
      const source = join(root, "source"),
        destination = join(root, "restored"),
        zip = join(root, "artifact.zip");
      await mkdir(source);
      for (const [name, bytes] of files)
        await writeFile(join(source, name), bytes);
      execFileSync("python3", [
        "-c",
        "import pathlib,sys,zipfile\nroot=pathlib.Path(sys.argv[1])\nwith zipfile.ZipFile(sys.argv[2],'w') as out:\n for item in sorted(root.iterdir()): out.write(item,item.name)",
        source,
        zip,
      ]);
      const bytes = await readFile(zip),
        original = { ...artifact(2), digest: `sha256:${sha256(bytes)}` },
        api = new GitHubReleaseApi("synthetic-token");
      api.request = async (_method, path) =>
        path.endsWith("/zip")
          ? bytes
          : {
              id: Number(original.id),
              expired: false,
              digest: original.digest,
              workflow_run: {
                id: Number(original.runId),
                head_sha: ident.sourceSha,
              },
            };
      await api.restoreArtifact(original, ident, destination);
      const restored = new Map(
        await Promise.all(
          [...files.keys()].map(async (name) => [
            name,
            await readFile(join(destination, name)),
          ]),
        ),
      );
      assert.deepEqual(restored, files);
      assert.equal(
        validateBundle(restored, ident, publicKey).schemaVersion,
        schemaVersion,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("artifact restore rejects a digest-matched malformed ZIP without writing downloaded bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "rayrag-invalid-restore-test-"));
  try {
    const bytes = Buffer.from("not a ZIP archive"),
      original = { ...artifact(2), digest: `sha256:${sha256(bytes)}` },
      api = new GitHubReleaseApi("synthetic-token");
    api.request = async (_method, path) => path.endsWith("/zip") ? bytes : {
      id: Number(original.id), expired: false, digest: original.digest,
      workflow_run: { id: Number(original.runId), head_sha: id(2).sourceSha },
    };
    await assert.rejects(api.restoreArtifact(original, id(2), root), /Command failed/);
    assert.deepEqual(await readdir(root), []);
  } finally {
    await rm(root, { recursive: true, force: true });
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
      '"schemaVersion":2',
      '"schemaVersion":2,"schemaVersion":2',
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

// Semantic assets and publication retain the old signed-container state machine.
// The migration feed is copied exactly, while the new feed follows the plan.
import {
  migrationBridge,
  legacyFeed,
  verifiedRelease,
} from "./release-core.mjs";
import { planRelease, planSha256 } from "./semantic-release-plan.mjs";
import { readReservations, reservePlan } from "./release-reservations.mjs";
import {
  planProduction,
  planIdentity,
  loadProductionPlan,
} from "./release-planning.mjs";
import { serializePlan } from "./semantic-release-plan.mjs";
class PlannedApi extends FakeApi {
  planReferences = new Map();
  planObjects = new Map();
  async planRefs() {
    return [...this.planReferences.values()];
  }
  async planRef(ref) {
    return this.planReferences.get(ref) ?? null;
  }
  async tagObject(sha) {
    return this.planObjects.get(sha) ?? null;
  }
  async createPlanTag(tag, message, sourceSha) {
    const sha = sha256(Buffer.from(message)).slice(0, 40);
    const object = {
      sha,
      tag,
      message,
      object: { type: "commit", sha: sourceSha },
    };
    this.planObjects.set(sha, object);
    return object;
  }
  async createPlanRef(ref, sha) {
    assert.ok(
      !this.planReferences.has(ref),
      "reservation cannot be overwritten",
    );
    this.planReferences.set(ref, { ref, object: { type: "tag", sha } });
  }
}
const semanticHistory = Array.from(
  { length: migrationBridge.firstParentCount + 4 },
  (_, i) =>
    i === migrationBridge.firstParentCount - 1
      ? migrationBridge.sourceSha
      : String(i + 1).padStart(40, "0"),
);
async function semanticFixture(
  api,
  offset = 1,
  previous = null,
  type = "feat",
) {
  const n = migrationBridge.firstParentCount + offset;
  const result = await planRelease({
    source: {
      sourceSha: semanticHistory[n - 1],
      firstParentCount: n,
      pubDate: await dateFor(),
    },
    published: {
      sourceSha: migrationBridge.sourceSha,
      version: migrationBridge.version,
      tag: migrationBridge.tag,
    },
    reservation: previous,
    analysisCommits: [
      {
        hash: semanticHistory[n - 1],
        message: `${type}: improve app behavior`,
      },
    ],
    notesCommits: [
      ...(previous
        ? [{ hash: previous.sourceSha, message: "feat: earlier app behavior" }]
        : []),
      {
        hash: semanticHistory[n - 1],
        message: `${type}: improve app behavior`,
      },
    ],
  });
  const plan = await reservePlan(
    { api, history: semanticHistory, bridge: migrationBridge },
    result.plan,
  );
  const ident = planIdentity(plan),
    names = assetNames(ident.version),
    bytes = Buffer.from("synthetic semantic app");
  const payload = new Map([
    [names.archive, bytes],
    [names.signature, Buffer.from(signature(bytes, ident.version))],
    [names.dmg, Buffer.from("synthetic semantic DMG")],
    ...installers(ident.version),
  ]);
  const build = {
    runId: String(100 + offset),
    runAttempt: "1",
    schemaVersion: 3,
    artifactName: `release-${ident.sourceSha}-${100 + offset}-1`,
  };
  build.platforms = [WINDOWS_TARGET, LINUX_TARGET].map((target) =>
    platformReceipt(payload, ident, build, target),
  );
  const files = createBundle(ident, payload, build, publicKey);
  return {
    api,
    history: semanticHistory,
    id: ident,
    publicKey,
    dateFor,
    files,
    artifact: artifact(offset),
    verifyNative: async () => {},
    verifyPlan: async (candidate) => {
      const all = await readReservations({
        api,
        history: semanticHistory,
        bridge: migrationBridge,
      });
      assert.equal(
        planSha256(all.find((p) => p.sourceSha === candidate.sourceSha)),
        planSha256(candidate),
      );
    },
    plan,
  };
}
test("semantic bundle binds plan/source ordinal and preserves exact legacy bridge feed", async () => {
  const ctx = await semanticFixture(new PlannedApi());
  assert.equal(ctx.id.version, "0.3.0");
  assert.equal(ctx.files.size, 10);
  assert.ok(ctx.files.get("latest.json").equals(legacyFeed()));
  const current = JSON.parse(ctx.files.get("latest-semver.json"));
  assert.equal(current.version, ctx.plan.version);
  assert.equal(current.notes, ctx.plan.notes);
  assert.equal(
    validateBundle(ctx.files, ctx.id, publicKey).firstParentCount,
    ctx.plan.firstParentCount,
  );
  const swapped = new Map(ctx.files);
  swapped.set("latest.json", ctx.files.get("latest-semver.json"));
  assert.throws(
    () => validateBundle(swapped, ctx.id, publicKey),
    /Legacy bridge/,
  );
  const foreign = structuredClone(ctx.id);
  foreign.releasePlan.notes += " changed";
  assert.throws(
    () => validateBundle(ctx.files, foreign, publicKey),
    /Bundle plan/,
  );
  assert.throws(
    () =>
      validateBundle(ctx.files, { ...ctx.id, firstParentCount: 1 }, publicKey),
    /Bundle plan/,
  );
});
test("semantic publish and retry use ten original assets and exact frozen reservation", async () => {
  const api = new PlannedApi(),
    ctx = await semanticFixture(api);
  api.loseCreate = api.loseUpload = api.losePublish = true;
  assert.equal(await publishRelease(ctx), "published-latest");
  const meta = releaseMetadata(await api.latest());
  assert.equal(meta.schemaVersion, 3);
  assert.equal(meta.planSha256, planSha256(ctx.plan));
  assert.equal(meta.firstParentCount, ctx.plan.firstParentCount);
  assert.equal(
    await publishRelease({ ...ctx, files: undefined, artifact: undefined }),
    "already-published",
  );
  assert.equal(
    (await verifiedRelease(ctx, await api.latest())).id.version,
    ctx.plan.version,
  );
  const source = {
    api,
    history: semanticHistory,
    sha: ctx.plan.sourceSha,
    dateFor,
  };
  assert.equal(
    (await loadProductionPlan(source, Buffer.from(serializePlan(ctx.plan)))).id
      .version,
    ctx.plan.version,
  );
  await assert.rejects(
    loadProductionPlan(
      { ...source, sha: migrationBridge.sourceSha },
      Buffer.from(serializePlan(ctx.plan)),
    ),
    /workflow source/,
  );
  await assert.rejects(
    loadProductionPlan(source, Buffer.from(JSON.stringify(ctx.plan))),
    /workflow source/,
  );
});
test("transported plan rejection precedes all source and reservation verification effects", async () => {
  const api = new PlannedApi(), ctx = await semanticFixture(api);
  const observed = [];
  const source = {
    api: { planRefs: async () => { observed.push("reservation"); throw new Error("Unexpected reservation read."); } },
    history: semanticHistory,
    sha: ctx.plan.sourceSha,
    dateFor: async () => { observed.push("date"); return dateFor(); },
  };
  for (const [bytes, message] of [
    [Buffer.alloc(0), /transported plan size/],
    [Buffer.from("not JSON"), /Malformed transported plan/],
    [Buffer.from("{}"), /release plan fields/],
    [Buffer.from(JSON.stringify(ctx.plan)), /workflow source/],
  ]) {
    await assert.rejects(loadProductionPlan(source, bytes), message);
    assert.deepEqual(observed, []);
  }
  await assert.rejects(loadProductionPlan({ ...source, sha: migrationBridge.sourceSha }, Buffer.from(serializePlan(ctx.plan))), /workflow source/);
  assert.deepEqual(observed, []);
  await assert.rejects(loadProductionPlan({ ...source, dateFor: async () => {
    observed.push("date");
    return "2026-01-01T00:00:00.000Z";
  } }, Buffer.from(serializePlan(ctx.plan))), /workflow source/);
  assert.deepEqual(observed, ["date"]);
});
test("later semantic release cannot let an older source roll latest backwards", async () => {
  const api = new PlannedApi(),
    a = await semanticFixture(api),
    b = await semanticFixture(api, 2, a.plan, "fix");
  assert.equal(b.id.version, "0.3.1");
  assert.equal(await publishRelease(b), "published-latest");
  assert.equal(await publishRelease(a), "published-older");
  assert.equal((await api.latest()).tag_name, b.id.tag);
});
test("semantic drafts resume original bytes and reject mixed artifact or altered plan marker", async () => {
  const api = new PlannedApi(),
    ctx = await semanticFixture(api);
  api.failUpload = "latest-semver.json";
  await assert.rejects(publishRelease(ctx), /incomplete/);
  assert.equal((await preflight(ctx)).state, "reuse");
  await assert.rejects(
    publishRelease({ ...ctx, artifact: artifact(2) }),
    /artifact run/,
  );
  const release = api.releases.get(ctx.id.tag),
    marker = releaseMetadata(release);
  const original = release.body;
  release.body = original.replace(marker.planSha256, "f".repeat(64));
  await assert.rejects(preflight(ctx), /plan conflict/);
  release.body = original;
  api.failUpload = null;
  assert.equal(await publishRelease(ctx), "published-latest");
});
test("semantic publisher rejects crossed source/version ordering before promotion", async () => {
  const api = new PlannedApi(),
    a = await semanticFixture(api),
    b = await semanticFixture(api, 2, a.plan, "fix");
  await publishRelease(b);
  // A false ordinal cannot be promoted even with an otherwise valid plan.
  await assert.rejects(
    publishRelease({
      ...a,
      id: { ...a.id, firstParentCount: b.plan.firstParentCount + 1 },
    }),
    /Candidate/,
  );
});
function filesForPlan(plan, runId = "200") {
  const ident = planIdentity(plan),
    names = assetNames(plan.version),
    bytes = Buffer.from("synthetic planned app");
  const payload = new Map([
    [names.archive, bytes],
    [names.signature, Buffer.from(signature(bytes, plan.version))],
    [names.dmg, Buffer.from("synthetic planned DMG")],
    ...installers(plan.version),
  ]);
  const build = {
    runId,
    runAttempt: "1",
    schemaVersion: 3,
    artifactName: `release-${plan.sourceSha}-${runId}-1`,
  };
  build.platforms = [WINDOWS_TARGET, LINUX_TARGET].map((target) =>
    platformReceipt(payload, ident, build, target),
  );
  return createBundle(ident, payload, build, publicKey);
}
async function planningFixture(messages) {
  const api = new PlannedApi();
  await publishRelease(context(api, 1));
  const bridge = { ...id(1), firstParentCount: 1 };
  delete bridge.pubDate;
  const inputs = [];
  const source = (n) => ({
    api,
    publicKey,
    history,
    sha: history[n - 1],
    dateFor,
    verifyNative: async () => {},
    commitsBetween: async (base, head) => {
      inputs.push([base, head]);
      const lo = history.indexOf(base),
        hi = history.indexOf(head);
      return history
        .slice(lo + 1, hi + 1)
        .map((hash, i) => ({ hash, message: messages[lo + 1 + i] }))
        .reverse();
    },
  });
  return {
    api,
    bridge,
    source,
    inputs,
    options: { bridge, feed: () => bundle(1).get("latest.json") },
  };
}
test("docs and CI-only introduced commits skip production without reserving a version", async () => {
  const fixture = await planningFixture([
    "baseline",
    "docs: clarify settings",
    "ci(deps): update action",
  ]);
  const before = fixture.api.events.length;
  assert.equal(
    (await planProduction(fixture.source(3), fixture.options)).state,
    "skip",
  );
  assert.equal(fixture.api.events.length, before);
  assert.equal(fixture.api.planReferences.size, 0);
});
test("failed build reservation is frozen on retry and remains included in subsequent notes", async () => {
  const fixture = await planningFixture([
    "baseline",
    "fix: correct item recovery",
    "feat: add travel controls",
  ]);
  const a = await planProduction(fixture.source(2), fixture.options);
  assert.equal(a.state, "build");
  assert.equal(a.id.version, "0.2.2");
  const retry = await planProduction(fixture.source(2), fixture.options);
  assert.equal(serializePlan(retry.plan), serializePlan(a.plan));
  const b = await planProduction(fixture.source(3), fixture.options);
  assert.equal(b.id.version, "0.3.0");
  assert.equal(b.plan.analysisBase.sourceSha, a.plan.sourceSha);
  assert.equal(b.plan.notesBase.sourceSha, fixture.bridge.sourceSha);
  assert.ok(b.plan.notes.includes("correct item recovery"));
  assert.ok(b.plan.notes.includes("add travel controls"));
});
test("out-of-order unplanned source is skipped after a later reservation", async () => {
  const fixture = await planningFixture([
    "baseline",
    "fix: correct recovery",
    "feat: travel",
  ]);
  await planProduction(fixture.source(3), fixture.options);
  const older = await planProduction(fixture.source(2), fixture.options);
  assert.equal(older.state, "skip");
  assert.match(older.reason, /superseded/);
  assert.equal(fixture.api.planReferences.size, 1);
});
test("existing older published sources are verified; older unbuilt sources skip; drafts recover", async () => {
  const fixture = await planningFixture([
    "baseline",
    "fix: recovery",
    "feat: travel",
  ]);
  const a = await planProduction(fixture.source(2), fixture.options);
  const b = await planProduction(fixture.source(3), fixture.options);
  const artifactFor = (runId) => ({
    id: runId + "0",
    runId,
    digest: "sha256:" + "a".repeat(64),
  });
  const ctxFor = (planned, runId) => ({
    ...fixture.source(planned.plan.firstParentCount),
    id: planned.id,
    files: filesForPlan(planned.plan, runId),
    artifact: artifactFor(runId),
    verifyPlan: async (plan) => {
      const all = await readReservations({
        api: fixture.api,
        history,
        bridge: fixture.bridge,
      });
      assert.equal(
        planSha256(all.find((p) => p.sourceSha === plan.sourceSha)),
        planSha256(plan),
      );
    },
  });
  // B publishes first. Unbuilt A is now superseded and receives no public tag.
  await publishRelease(ctxFor(b, "203"));
  assert.equal(
    (await planProduction(fixture.source(2), fixture.options)).state,
    "skip",
  );
  await fixture.api.createTag(a.id.tag, a.id.sourceSha);
  const draft = await fixture.api.createDraft(
    a.id,
    releaseBody(a.id, artifactFor("202"), 3),
  );
  const recovery = await planProduction(fixture.source(2), fixture.options);
  assert.equal(recovery.state, "reuse");
  assert.equal(recovery.artifact.runId, "202");
  await publishRelease(ctxFor(a, "202"));
  assert.equal(
    (await planProduction(fixture.source(2), fixture.options)).state,
    "published",
  );
  // A historical rerun cannot silently skip a corrupted published tag.
  fixture.api.tags.set(a.id.tag, history[3]);
  await assert.rejects(
    planProduction(fixture.source(2), fixture.options),
    /tag points/,
  );
  assert.equal((await fixture.api.release(a.id.tag)).id, draft.id);
});
test("downstream plan verification reads only the exact ref instead of rescanning history", async () => {
  const api = new PlannedApi(),
    ctx = await semanticFixture(api);
  api.planRefs = async () => {
    throw new Error("Downstream must not scan the complete ledger.");
  };
  const loaded = await loadProductionPlan(
    { api, history: semanticHistory, sha: ctx.id.sourceSha, dateFor },
    Buffer.from(serializePlan(ctx.plan)),
  );
  assert.equal(loaded.id.version, ctx.id.version);
  api.planReferences.delete([...api.planReferences.keys()][0]);
  await assert.rejects(loaded.verifyPlan(ctx.plan), /missing/);
});
test("GitHub reservation listing finds existing plans using the matching-ref wire contract", async () => {
  const original = global.fetch;
  const ref = {
    ref: "refs/tags/rayrag-release-plan/v0.3.0",
    object: { type: "tag", sha: "a".repeat(40) },
  };
  global.fetch = async (url, options) => {
    assert.equal(options.method, "GET");
    // GitHub returns an empty list for the unmatched refs/tags/... namespace.
    // Its endpoint takes tags/..., while response ref names retain refs/tags/.
    return Response.json(
      String(url) ===
        "https://api.github.com/repos/oDestroyeRo/openrayrag/git/matching-refs/tags/rayrag-release-plan/"
        ? [ref]
        : [],
    );
  };
  try {
    assert.deepEqual(
      await new GitHubReleaseApi("synthetic-only").planRefs(),
      [ref],
    );
  } finally {
    global.fetch = original;
  }
});

test("GitHub reservation adapter uses canonical tag objects, create-only refs and immutable cache", async () => {
  const original = global.fetch,
    calls = [],
    sha = "a".repeat(40),
    sourceSha = "b".repeat(40);
  global.fetch = async (url, options) => {
    calls.push({
      url: String(url),
      method: options.method,
      body: options.body && JSON.parse(options.body),
    });
    if (String(url).includes("matching-refs")) return Response.json([]);
    if (options.method === "POST") return Response.json({ sha });
    return Response.json({
      sha,
      tag: "rayrag-release-plan/v0.3.0",
      message: "canonical\n",
      object: { type: "commit", sha: sourceSha },
    });
  };
  try {
    const api = new GitHubReleaseApi("synthetic-only");
    assert.deepEqual(await api.planRefs(), []);
    await api.createPlanTag(
      "rayrag-release-plan/v0.3.0",
      "canonical\n",
      sourceSha,
      await dateFor(),
    );
    await api.createPlanRef("refs/tags/rayrag-release-plan/v0.3.0", sha);
    await api.tagObject(sha);
    await api.tagObject(sha);
    assert.equal(
      calls.filter(
        (c) => c.method === "GET" && c.url.endsWith(`git/tags/${sha}`),
      ).length,
      1,
    );
    assert.equal(calls[1].body.message, "canonical\n");
    assert.equal(calls[1].body.object, sourceSha);
    assert.equal(calls[2].body.ref, "refs/tags/rayrag-release-plan/v0.3.0");
    assert.ok(calls.every((c) => ["GET", "POST"].includes(c.method)));
  } finally {
    global.fetch = original;
  }
});

test("fetched annotated reservations preserve exact message bytes without per-object REST calls", async () => {
  const root = await mkdtemp(join(tmpdir(), "rayrag-git-reservation-"));
  try {
    execFileSync("git", ["init", "--quiet", root], { stdio: "pipe" });
    const source = "a".repeat(40),
      message = '{"canonical":"message"}\n';
    const object = `object ${source}\ntype commit\ntag rayrag-release-plan/v0.3.0\ntagger CI <ci@example.invalid> 1 +0000\n\n${message}`;
    const sha = execFileSync(
      "git",
      ["hash-object", "-t", "tag", "-w", "--stdin"],
      { cwd: root, input: object, encoding: "utf8", stdio: "pipe" },
    ).trim();
    const tag = readLocalTagObject(root, sha);
    assert.equal(tag.message, message);
    assert.equal(tag.object.sha, source);
    assert.equal(tag.tag, "rayrag-release-plan/v0.3.0");
    assert.equal(readLocalTagObject(root, "b".repeat(40)), null);
    const api = new GitHubReleaseApi("synthetic-only", (objectSha) =>
      readLocalTagObject(root, objectSha),
    );
    api.request = async () => {
      throw new Error("Fetched immutable object must not use REST.");
    };
    assert.deepEqual(await api.tagObject(sha), tag);
    assert.deepEqual(await api.tagObject(sha), tag);
    const blob = execFileSync("git", ["hash-object", "-w", "--stdin"], {
      cwd: root,
      input: "blob",
      encoding: "utf8",
      stdio: "pipe",
    }).trim();
    assert.throws(() => readLocalTagObject(root, blob), /annotated Git tag/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

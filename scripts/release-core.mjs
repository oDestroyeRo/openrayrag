// Release contracts and state transitions. All network/native effects are injected.
import { createHash, createPublicKey, verify } from "node:crypto";
export const REPOSITORY = "oDestroyeRo/openrayrag";
export const TARGET = "aarch64-apple-darwin";
export const IDENTIFIER = "com.rayrag.companion";
// Match the installed client's download and signature limits before publishing.
export const MAX_UPDATER_ARCHIVE = 128 * 1024 * 1024;
export const NODE_VERSION = "26.10.0",
  RUST_VERSION = "1.98.1";
export const ENDPOINT = `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`;
export const sha256 = (data) => createHash("sha256").update(data).digest("hex");
export function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function exactKeys(value, keys, label) {
  requireValue(
    plain(value) &&
      Object.keys(value).sort().join("|") === [...keys].sort().join("|"),
    `Invalid ${label} fields.`,
  );
}
export function countOf(version) {
  requireValue(
    typeof version === "string" && /^0\.2\.[1-9]\d*$/.test(version),
    "Invalid release version.",
  );
  const count = Number(version.slice(4));
  requireValue(Number.isSafeInteger(count), "Invalid version count.");
  return count;
}
export function validSha(sha) {
  requireValue(
    typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha),
    "Invalid source SHA.",
  );
  return sha;
}
export function identity(history, sha, pubDate) {
  validSha(sha);
  requireValue(
    Array.isArray(history) &&
      history.length > 0 &&
      history.every((s) => /^[a-f0-9]{40}$/.test(s)) &&
      new Set(history).size === history.length,
    "Invalid first-parent history.",
  );
  const index = history.indexOf(sha);
  requireValue(
    index >= 0,
    "Source is not on current main first-parent ancestry.",
  );
  requireValue(
    typeof pubDate === "string" && new Date(pubDate).toISOString() === pubDate,
    "Invalid source date.",
  );
  return {
    version: `0.2.${index + 1}`,
    tag: `v0.2.${index + 1}`,
    sourceSha: sha,
    pubDate,
  };
}
export function assetNames(version) {
  countOf(version);
  const base = `Rayrag_Companion_${version}_aarch64`;
  return {
    archive: `${base}.app.tar.gz`,
    signature: `${base}.app.tar.gz.sig`,
    dmg: `${base}.dmg`,
  };
}
export function expectedNames(version) {
  const n = assetNames(version);
  return [
    n.archive,
    n.signature,
    n.dmg,
    "provenance.json",
    "SHA256SUMS",
    "latest.json",
  ];
}
function base64(text, maxBytes) {
  requireValue(
    typeof text === "string" &&
      text.length > 0 &&
      text.length <= maxBytes * 2 &&
      /^[A-Za-z0-9+/]+={0,2}$/.test(text),
    "Invalid signature encoding.",
  );
  const bytes = Buffer.from(text, "base64");
  requireValue(
    bytes.length <= maxBytes && bytes.toString("base64") === text,
    "Noncanonical signature encoding.",
  );
  return bytes;
}
function textBox(encoded, maxBytes) {
  return new TextDecoder("utf-8", { fatal: true })
    .decode(base64(encoded, maxBytes))
    .trimEnd()
    .split("\n");
}
export function verifyUpdaterSignature(data, signature, publicKey, version) {
  requireValue(
    Buffer.isBuffer(data) &&
      data.length > 0 &&
      data.length <= MAX_UPDATER_ARCHIVE,
    "Updater archive exceeds the client download bound.",
  );
  requireValue(
    typeof signature === "string" && signature.trim().length <= 4096,
    "Updater signature exceeds the client bound.",
  );
  countOf(version);
  const keyLines = textBox(publicKey.trim(), 4096),
    sigLines = textBox(signature.trim(), 8192);
  requireValue(
    keyLines.length === 2 && keyLines[0].startsWith("untrusted comment: "),
    "Invalid updater public key.",
  );
  requireValue(
    sigLines.length === 4 &&
      sigLines[0].startsWith("untrusted comment: ") &&
      sigLines[2].startsWith("trusted comment: "),
    "Invalid updater signature box.",
  );
  const key = base64(keyLines[1], 42),
    sig = base64(sigLines[1], 74),
    global = base64(sigLines[3], 64);
  requireValue(
    key.length === 42 &&
      key.subarray(0, 2).toString() === "Ed" &&
      sig.length === 74 &&
      sig.subarray(0, 2).toString() === "ED" &&
      global.length === 64,
    "Unsupported updater signature format.",
  );
  requireValue(
    key.subarray(2, 10).equals(sig.subarray(2, 10)),
    "Updater signing key differs from the committed public key.",
  );
  const comment = sigLines[2].slice("trusted comment: ".length),
    versions = comment
      .split("\t")
      .filter((field) => field.startsWith("version:"));
  requireValue(
    versions.length === 1 && versions[0] === `version:${version}`,
    "Signature does not authenticate this release version.",
  );
  const ed25519 = createPublicKey({
    key: Buffer.concat([
      Buffer.from("302a300506032b6570032100", "hex"),
      key.subarray(10),
    ]),
    format: "der",
    type: "spki",
  });
  requireValue(
    verify(
      null,
      createHash("blake2b512").update(data).digest(),
      ed25519,
      sig.subarray(10),
    ),
    "Updater archive signature rejected.",
  );
  requireValue(
    verify(
      null,
      Buffer.concat([sig.subarray(10), Buffer.from(comment)]),
      ed25519,
      global,
    ),
    "Updater trusted-comment signature rejected.",
  );
}
const compareNames = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const jsonBuffer = (value) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
function parseJson(bytes, label) {
  requireValue(
    Buffer.isBuffer(bytes) && bytes.length <= 128 * 1024,
    `Invalid ${label} size.`,
  );
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    requireValue(
      bytes.equals(jsonBuffer(value)),
      `Noncanonical ${label} JSON.`,
    );
    return value;
  } catch {
    throw new Error(`Invalid or noncanonical ${label} JSON.`);
  }
}
function fileRecord(name, bytes) {
  return { name, bytes: bytes.length, sha256: sha256(bytes) };
}
function checksums(files) {
  return Buffer.from(
    [...files]
      .filter(([name]) => name !== "SHA256SUMS")
      .sort(([a], [b]) => compareNames(a, b))
      .map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`)
      .join(""),
  );
}
const numericId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
export function validateArtifact(artifact) {
  exactKeys(artifact, ["id", "runId", "digest"], "workflow artifact");
  requireValue(
    numericId(artifact.id) &&
      numericId(artifact.runId) &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
    "Invalid original workflow artifact identity.",
  );
  return artifact;
}
export function createBundle(id, payload, build, publicKey) {
  const names = assetNames(id.version);
  requireValue(
    payload.size === 3 &&
      [names.archive, names.signature, names.dmg].every((n) =>
        Buffer.isBuffer(payload.get(n)),
      ),
    "Incomplete build payload.",
  );
  const files = new Map(payload),
    signature = files.get(names.signature).toString("utf8").trim();
  verifyUpdaterSignature(
    files.get(names.archive),
    signature,
    publicKey,
    id.version,
  );
  files.set(
    "latest.json",
    jsonBuffer({
      version: id.version,
      notes: `Source ${id.sourceSha}. Install automatically only when fully stopped.`,
      pub_date: id.pubDate,
      platforms: {
        "darwin-aarch64": {
          url: `https://github.com/${REPOSITORY}/releases/download/${id.tag}/${names.archive}`,
          signature,
        },
      },
    }),
  );
  files.set(
    "provenance.json",
    jsonBuffer({
      schemaVersion: 1,
      repository: REPOSITORY,
      sourceSha: id.sourceSha,
      firstParentCount: countOf(id.version),
      version: id.version,
      target: TARGET,
      identifier: IDENTIFIER,
      runId: build.runId,
      runAttempt: build.runAttempt,
      artifactName: build.artifactName,
      toolchain: { node: NODE_VERSION, rust: RUST_VERSION },
      files: [...files]
        .map(([name, bytes]) => fileRecord(name, bytes))
        .sort((a, b) => compareNames(a.name, b.name)),
    }),
  );
  files.set("SHA256SUMS", checksums(files));
  validateBundle(files, id, publicKey);
  return files;
}
export function validateBundle(files, id, publicKey) {
  const names = assetNames(id.version);
  requireValue(
    files instanceof Map &&
      [...files.keys()].sort().join("|") ===
        expectedNames(id.version).sort().join("|"),
    "Release asset set is incomplete or has unexpected files.",
  );
  for (const bytes of files.values())
    requireValue(
      Buffer.isBuffer(bytes) &&
        bytes.length > 0 &&
        bytes.length <= 256 * 1024 * 1024,
      "Release asset is empty or exceeds the limit.",
    );
  const latest = parseJson(files.get("latest.json"), "latest.json");
  exactKeys(
    latest,
    ["version", "notes", "pub_date", "platforms"],
    "latest.json",
  );
  exactKeys(latest.platforms, ["darwin-aarch64"], "platforms");
  const platform = latest.platforms["darwin-aarch64"];
  exactKeys(platform, ["url", "signature"], "platform");
  requireValue(
    latest.version === id.version &&
      latest.pub_date === id.pubDate &&
      latest.notes ===
        `Source ${id.sourceSha}. Install automatically only when fully stopped.`,
    "Release metadata differs from the exact source.",
  );
  requireValue(
    platform.url ===
      `https://github.com/${REPOSITORY}/releases/download/${id.tag}/${names.archive}`,
    "Updater URL is not the immutable versioned archive.",
  );
  requireValue(
    platform.signature === files.get(names.signature).toString("utf8").trim(),
    "Manifest and detached signatures differ.",
  );
  verifyUpdaterSignature(
    files.get(names.archive),
    platform.signature,
    publicKey,
    id.version,
  );
  const p = parseJson(files.get("provenance.json"), "provenance");
  exactKeys(
    p,
    [
      "schemaVersion",
      "repository",
      "sourceSha",
      "firstParentCount",
      "version",
      "target",
      "identifier",
      "runId",
      "runAttempt",
      "artifactName",
      "toolchain",
      "files",
    ],
    "provenance",
  );
  requireValue(
    p.schemaVersion === 1 &&
      p.repository === REPOSITORY &&
      p.sourceSha === id.sourceSha &&
      p.firstParentCount === countOf(id.version) &&
      p.version === id.version &&
      p.target === TARGET &&
      p.identifier === IDENTIFIER,
    "Provenance does not identify this source/target.",
  );
  requireValue(
    numericId(p.runId) &&
      numericId(p.runAttempt) &&
      p.artifactName === `release-${id.sourceSha}-${p.runId}-${p.runAttempt}`,
    "Invalid build provenance.",
  );
  exactKeys(p.toolchain, ["node", "rust"], "toolchain");
  requireValue(
    p.toolchain.node === NODE_VERSION && p.toolchain.rust === RUST_VERSION,
    "Unexpected release toolchain.",
  );
  const expected = [names.archive, names.signature, names.dmg, "latest.json"]
    .sort()
    .map((name) => fileRecord(name, files.get(name)));
  requireValue(
    JSON.stringify(p.files) === JSON.stringify(expected),
    "Provenance asset hashes or sizes differ.",
  );
  requireValue(
    files.get("SHA256SUMS").equals(checksums(files)),
    "Release checksums differ.",
  );
  return p;
}
export function releaseBody(id, artifact) {
  validateArtifact(artifact);
  return `Rayrag Companion ${id.version} for Apple Silicon (ARM64).\n\nBootstrap: download the DMG. Existing updater-enabled clients use the signed archive. Apple signing is ad-hoc; this build is not notarized.\n\nSource: ${id.sourceSha}\n\n<!-- rayrag-release:${JSON.stringify({ schemaVersion: 1, version: id.version, sourceSha: id.sourceSha, artifact })} -->`;
}
export function releaseMetadata(release) {
  requireValue(
    plain(release) &&
      Number.isSafeInteger(release.id) &&
      release.id > 0 &&
      typeof release.draft === "boolean" &&
      release.prerelease === false &&
      typeof release.body === "string",
    "Invalid release record.",
  );
  const matches = [...release.body.matchAll(/<!-- rayrag-release:(.*?) -->/g)];
  requireValue(
    matches.length === 1,
    "Missing or duplicate release provenance marker.",
  );
  let meta;
  try {
    meta = JSON.parse(matches[0][1]);
    requireValue(
      JSON.stringify(meta) === matches[0][1],
      "Noncanonical provenance marker.",
    );
  } catch {
    throw new Error("Malformed release provenance marker.");
  }
  exactKeys(
    meta,
    ["schemaVersion", "version", "sourceSha", "artifact"],
    "release provenance",
  );
  requireValue(
    meta.schemaVersion === 1 && release.tag_name === `v${meta.version}`,
    "Release tag/metadata conflict.",
  );
  countOf(meta.version);
  validSha(meta.sourceSha);
  validateArtifact(meta.artifact);
  return meta;
}
async function assertRelease(ctx, release) {
  const meta = releaseMetadata(release),
    n = countOf(meta.version);
  requireValue(
    ctx.history[n - 1] === meta.sourceSha,
    "Published history was rewritten or version/tag ancestry conflicts.",
  );
  requireValue(
    (await ctx.api.tagSha(release.tag_name)) === meta.sourceSha,
    "Existing release tag points to another commit.",
  );
  return meta;
}
async function verifiedRelease(ctx, release) {
  const meta = await assertRelease(ctx, release),
    id = identity(
      ctx.history,
      meta.sourceSha,
      await ctx.dateFor(meta.sourceSha),
    );
  const files = await ctx.api.downloadRelease(
    release,
    expectedNames(id.version),
  );
  const p = validateBundle(files, id, ctx.publicKey);
  requireValue(
    p.runId === meta.artifact.runId,
    "Release and build run provenance differ.",
  );
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
  requireValue(meta.sourceSha === ctx.id.sourceSha, "Release source conflict.");
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
  return { release: latest, count: countOf(meta.version) };
}
export async function publishRelease(ctx) {
  requireValue(
    ctx.history[countOf(ctx.id.version) - 1] === ctx.id.sourceSha,
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
    if (!latest || latest.count < countOf(ctx.id.version))
      await promote(ctx, release, true, latest?.count ?? 0);
    return "already-published";
  }
  requireValue(
    ctx.files instanceof Map,
    "Original complete signed bundle is required to resume a draft.",
  );
  validateBundle(ctx.files, ctx.id, ctx.publicKey);
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
        releaseBody(ctx.id, ctx.artifact),
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
      JSON.stringify(meta.artifact) === JSON.stringify(ctx.artifact),
    "Draft belongs to another build. Reuse its original artifact; never mix rebuilds.",
  );
  for (const name of expectedNames(ctx.id.version)) {
    let assets = await ctx.api.assets(release.id);
    requireValue(
      assets.length <= 6 &&
        new Set(assets.map((a) => a.name)).size === assets.length &&
        assets.every((a) => expectedNames(ctx.id.version).includes(a.name)),
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
  const makeLatest = !latest || countOf(ctx.id.version) > latest.count;
  await promote(ctx, release, makeLatest, latest?.count ?? 0);
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
      latest.count >=
        Math.max(minimumLatest, makeLatest ? countOf(ctx.id.version) : 0),
    "Latest promotion was not confirmed or moved backwards.",
  );
}

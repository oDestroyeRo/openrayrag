import { filter, map, sort } from "effect/Array";
import { pipe } from "effect/Function";
// Deterministic release contracts. Inputs are bytes, metadata and source history.
import { createHash, createPublicKey, verify } from "node:crypto";
import { sourceCommitSha, firstParentCount, fileDigest, releaseTagFor, artifactIdentityValues, platformReceiptValues, provenanceValues, releaseMetadataValues } from '../shared/tooling-domain-values.mjs';
import {
  stableVersion,
  compareVersions,
  validatePlan,
  planSha256,
} from "./semantic-release-policy.mjs";
import migration from "../../release-migration.json" with { type: "json" };
export const REPOSITORY = "oDestroyeRo/openrayrag";
export const TARGET = "aarch64-apple-darwin";
export const WINDOWS_TARGET = "x86_64-pc-windows-msvc";
export const LINUX_TARGET = "x86_64-unknown-linux-gnu";
export const PLATFORM_CHECKS = [
  "frontend-build",
  "native-package",
  "package-contents",
];
export const MAX_RELEASE_ASSET = 256 * 1024 * 1024;
export const MAX_RELEASE_BUNDLE = 10 * MAX_RELEASE_ASSET;
export const IDENTIFIER = "com.rayrag.companion";
// Match the installed client's download and signature limits before publishing.
export const MAX_UPDATER_METADATA = 64_000;
export const MAX_UPDATER_ARCHIVE = 128 * 1024 * 1024;
export const BUN_VERSION = "1.4.2",
  RUST_VERSION = "1.98.1";
// Retained for verification/recovery of immutable releases made before Bun.
const LEGACY_NODE_VERSION = "26.10.0";
export const ENDPOINT = `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`;
/** @param {string | NodeJS.ArrayBufferView} data @returns {import('../shared/tooling-domain-values.mjs').FileDigest} */
export const sha256 = (data) => fileDigest(createHash("sha256").update(data).digest("hex"));
/**
 * @param {unknown} ok
 * @param {string} message
 * @returns {asserts ok}
 */
export function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}
const plain = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);
export function exactKeys(value, keys, label) {
  requireValue(
    plain(value) &&
      sort(Object.keys(value), compareNames).join("|") === sort(keys, compareNames).join("|"),
    `Invalid ${label} fields.`,
  );
}
/** @param {string} version @returns {import('../shared/tooling-domain-values.mjs').FirstParentCount} */
export function countOf(version) {
  requireValue(
    typeof version === "string" && /^0\.2\.[1-9]\d*$/.test(version),
    "Invalid release version.",
  );
  const count = Number(version.slice(4));
  requireValue(Number.isSafeInteger(count), "Invalid version count.");
  return firstParentCount(count, "Invalid version count.");
}
export const validSha = sourceCommitSha;
/** @param {readonly string[]} history @param {import('../shared/tooling-domain-values.mjs').SourceCommitSha} sha @param {string} pubDate @returns {import('../shared/tooling-domain-values.mjs').ReleaseIdentity} */
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
  const version = stableVersion(`0.2.${index + 1}`);
  return {
    version,
    tag: releaseTagFor(version),
    sourceSha: sha,
    pubDate,
  };
}
/** @param {import('../shared/tooling-domain-values.mjs').StableReleaseVersion} version */
export function assetNames(version) {
  stableVersion(version);
  const base = `Rayrag_Companion_${version}_aarch64`;
  return {
    archive: `${base}.app.tar.gz`,
    signature: `${base}.app.tar.gz.sig`,
    dmg: `${base}.dmg`,
    windows: `Rayrag_Companion_${version}_x64-setup.exe`,
    deb: `Rayrag_Companion_${version}_amd64.deb`,
    appimage: `Rayrag_Companion_${version}_x86_64.AppImage`,
  };
}
/** @param {import('../shared/tooling-domain-values.mjs').StableReleaseVersion} version @param {number} [schemaVersion] */
export function expectedNames(version, schemaVersion = 2) {
  requireValue(
    [1, 2, 3].includes(schemaVersion),
    "Unsupported release schema.",
  );
  const n = assetNames(version);
  return [
    n.archive,
    n.signature,
    n.dmg,
    ...(schemaVersion >= 2 ? [n.windows, n.deb, n.appimage] : []),
    "provenance.json",
    "SHA256SUMS",
    "latest.json",
    ...(schemaVersion === 3 ? ["latest-semver.json"] : []),
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
  stableVersion(version);
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
const fileRecordFor = files => name => fileRecord(name, fileBytes(files, name));
const jsonBuffer = (value) =>
  Buffer.from(JSON.stringify(value, null, 2) + "\n");
/** @param {Buffer | undefined} bytes @param {string} label */
export function parseJson(bytes, label) {
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
/** @param {Map<string, Buffer>} files @param {string} name @returns {Buffer} */
export function fileBytes(files, name) {
  const bytes = files.get(name);
  requireValue(bytes !== undefined, "Missing release file.");
  return bytes;
}
function checksums(files) {
  return Buffer.from(
    pipe([...files],
      filter(([name]) => name !== "SHA256SUMS"),
      sort(([a], [b]) => compareNames(a, b)),
      map(([name, bytes]) => `${sha256(bytes)}  ${name}\n`),
    ).join(""),
  );
}
const numericId = (value) =>
  typeof value === "string" && /^[1-9]\d{0,19}$/.test(value);
/** @param {import('../shared/tooling-domain-values.mjs').ArtifactIdentityDto} artifact @returns {import('../shared/tooling-domain-values.mjs').ArtifactIdentity} */
export function validateArtifact(artifact) {
  exactKeys(artifact, ["id", "runId", "digest"], "workflow artifact");
  requireValue(
    numericId(artifact.id) &&
      numericId(artifact.runId) &&
      /^sha256:[a-f0-9]{64}$/.test(artifact.digest),
    "Invalid original workflow artifact identity.",
  );
  return artifactIdentityValues(artifact);
}
/** @param {import('../shared/tooling-domain-values.mjs').StableReleaseVersion} version @param {import('../shared/tooling-domain-values.mjs').PackageTarget} target */
export function platformNames(version, target) {
  const n = assetNames(version);
  requireValue(
    [TARGET, WINDOWS_TARGET, LINUX_TARGET].includes(target),
    "Unexpected platform target.",
  );
  return target === TARGET
    ? [n.archive, n.signature, n.dmg]
    : target === WINDOWS_TARGET
      ? [n.windows]
      : sort([n.appimage, n.deb], compareNames);
}
/** @param {import('../shared/tooling-domain-values.mjs').PlatformReceiptDto} receipt @param {import('../shared/tooling-domain-values.mjs').PackageIdentity} id @param {import('../shared/tooling-domain-values.mjs').BuildDto} build @param {import('../shared/tooling-domain-values.mjs').PackageTarget} target */
function validateBuildIdentity(receipt, id, build, target) {
  exactKeys(
    receipt,
    [
      "schemaVersion",
      "sourceSha",
      "version",
      "target",
      "runId",
      "runAttempt",
      "files",
      "checks",
    ],
    "platform build",
  );
  requireValue(
    receipt.schemaVersion === 1 &&
      receipt.sourceSha === id.sourceSha &&
      receipt.version === id.version &&
      receipt.target === target &&
      numericId(receipt.runId) &&
      numericId(receipt.runAttempt) &&
      receipt.runId === build.runId &&
      receipt.runAttempt === build.runAttempt,
    "Platform build source, version, target or workflow run differs.",
  );
  requireValue(
    JSON.stringify(receipt.checks) === JSON.stringify(PLATFORM_CHECKS),
    "Platform package verification is incomplete.",
  );
}
/** @param {Map<string, Buffer>} files @param {import('../shared/tooling-domain-values.mjs').PackageIdentity} id @param {import('../shared/tooling-domain-values.mjs').BuildDto} build @param {import('../shared/tooling-domain-values.mjs').PackageTarget} target @returns {import('../shared/tooling-domain-values.mjs').PlatformReceiptDto} */
export function platformReceipt(files, id, build, target) {
  return {
    schemaVersion: 1,
    sourceSha: id.sourceSha,
    version: id.version,
    target,
    runId: build.runId,
    runAttempt: build.runAttempt,
    files: pipe(platformNames(id.version, target), sort(compareNames), map(fileRecordFor(files))),
    checks: [...PLATFORM_CHECKS],
  };
}
/** @param {string} name @param {Buffer} bytes @param {import('../shared/tooling-domain-values.mjs').StableReleaseVersion} version */
export function validateInstaller(name, bytes, version) {
  requireValue(
    Buffer.isBuffer(bytes) &&
      bytes.length > 0 &&
      bytes.length <= MAX_RELEASE_ASSET,
    "Invalid platform installer size.",
  );
  const n = assetNames(version);
  if (name === n.windows) {
    requireValue(
      bytes.length >= 64 && bytes.subarray(0, 2).toString() === "MZ",
      "Windows installer is not PE.",
    );
    const offset = bytes.readUInt32LE(60);
    requireValue(
      offset >= 64 &&
        offset <= bytes.length - 26 &&
        bytes.subarray(offset, offset + 4).equals(Buffer.from([80, 69, 0, 0])),
      "Invalid Windows PE header.",
    );
    const machine = bytes.readUInt16LE(offset + 4),
      format = bytes.readUInt16LE(offset + 24);
    // NSIS can use a 32-bit installer stub for a verified 64-bit application payload.
    requireValue(
      (machine === 0x14c && format === 0x10b) ||
        (machine === 0x8664 && format === 0x20b),
      "Unexpected Windows installer architecture.",
    );
  } else if (name === n.appimage) {
    requireValue(
      bytes.length >= 64 &&
        bytes.subarray(0, 4).equals(Buffer.from([127, 69, 76, 70])) &&
        bytes[4] === 2 &&
        bytes[5] === 1 &&
        bytes[6] === 1 &&
        bytes.readUInt16LE(18) === 62 &&
        bytes.subarray(8, 11).equals(Buffer.from([65, 73, 2])),
      "AppImage is not type 2 ELF64 x86_64.",
    );
  } else if (name === n.deb) {
    requireValue(
      bytes.subarray(0, 8).toString() === "!<arch>\n",
      "Debian package is not ar.",
    );
    let offset = 8;
    const members = new Map();
    while (offset < bytes.length) {
      requireValue(offset <= bytes.length - 60, "Truncated Debian ar header.");
      const header = bytes.subarray(offset, offset + 60),
        member = header.subarray(0, 16).toString().trim().replace(/\/$/, ""),
        sizeText = header.subarray(48, 58).toString().trim(),
        size = Number(sizeText);
      requireValue(
        header.subarray(58).toString() === "`\n" &&
          /^\d+$/.test(sizeText) &&
          Number.isSafeInteger(size) &&
          size > 0 &&
          !members.has(member) &&
          offset + 60 + size <= bytes.length,
        "Invalid Debian ar member.",
      );
      members.set(member, bytes.subarray(offset + 60, offset + 60 + size));
      offset += 60 + size;
      if (size % 2) {
        requireValue(bytes[offset] === 10, "Invalid Debian ar padding.");
        offset++;
      }
    }
    const keys = [...members.keys()];
    requireValue(
      keys.length === 3 &&
        keys[0] === "debian-binary" &&
        /^control\.tar\.(gz|xz|zst)$/.test(keys[1]) &&
        /^data\.tar\.(gz|xz|zst)$/.test(keys[2]) &&
        members.get("debian-binary").toString() === "2.0\n",
      "Unexpected Debian package members.",
    );
  } else throw new Error("Unexpected platform installer name.");
}
/** @param {Map<string, Buffer>} files @param {import('../shared/tooling-domain-values.mjs').PackageIdentity} id @param {import('../shared/tooling-domain-values.mjs').BuildDto} build @param {import('../shared/tooling-domain-values.mjs').PackageTarget} target @returns {import('../shared/tooling-domain-values.mjs').PlatformReceipt} */
export function validatePlatformBuild(files, id, build, target) {
  requireValue(
    files instanceof Map && [WINDOWS_TARGET, LINUX_TARGET].includes(target),
    "Invalid platform bundle.",
  );
  const names = platformNames(id.version, target);
  requireValue(
    sort([...files.keys()], compareNames).join("|") ===
      sort([...names, "platform-build.json"], compareNames).join("|"),
    "Platform bundle has missing or unexpected files.",
  );
  const receipt = parseJson(files.get("platform-build.json"), "platform build");
  validateBuildIdentity(receipt, id, build, target);
  for (const name of names)
    validateInstaller(name, fileBytes(files, name), id.version);
  requireValue(
    JSON.stringify(receipt.files) ===
      JSON.stringify(
        pipe(names, sort(compareNames), map(fileRecordFor(files))),
      ),
    "Platform package hashes or sizes differ.",
  );
  return platformReceiptValues(receipt);
}
/** @param {import('../shared/tooling-domain-values.mjs').ReleaseIdentity} id @param {Map<string, Buffer>} payload @param {import('../shared/tooling-domain-values.mjs').BuildDto} build @param {string} publicKey @returns {Map<string, Buffer>} */
export function createBundle(id, payload, build, publicKey) {
  const names = assetNames(id.version);
  const schemaVersion = build.schemaVersion ?? 2;
  const payloadNames = filter(expectedNames(id.version, schemaVersion),
    (n) =>
      ![
        "provenance.json",
        "SHA256SUMS",
        "latest.json",
        "latest-semver.json",
      ].includes(n),
  );
  requireValue(
    payload.size === payloadNames.length &&
      payloadNames.every((n) => Buffer.isBuffer(payload.get(n))),
    "Incomplete build payload.",
  );
  const files = new Map(payload),
    signature = fileBytes(files, names.signature).toString("utf8").trim();
  verifyUpdaterSignature(
    fileBytes(files, names.archive),
    signature,
    publicKey,
    id.version,
  );
  files.set(
    schemaVersion === 3 ? "latest-semver.json" : "latest.json",
    jsonBuffer({
      version: id.version,
      notes:
        schemaVersion === 3
          ? validatePlan(id.releasePlan).notes
          : `Source ${id.sourceSha}. Install automatically only when fully stopped.`,
      pub_date: id.pubDate,
      platforms: {
        "darwin-aarch64": {
          url: `https://github.com/${REPOSITORY}/releases/download/${id.tag}/${names.archive}`,
          signature,
        },
      },
    }),
  );
  if (schemaVersion === 3) files.set("latest.json", legacyFeed());
  files.set(
    "provenance.json",
    jsonBuffer({
      schemaVersion,
      repository: REPOSITORY,
      sourceSha: id.sourceSha,
      firstParentCount:
        schemaVersion === 3 ? sourceCount(id) : countOf(id.version),
      version: id.version,
      target: TARGET,
      identifier: IDENTIFIER,
      runId: build.runId,
      runAttempt: build.runAttempt,
      artifactName: build.artifactName,
      toolchain: { bun: BUN_VERSION, rust: RUST_VERSION },
      ...(schemaVersion >= 2
        ? {
            platforms: sort([
              platformReceipt(payload, id, build, TARGET),
              ...(build.platforms ?? []),
            ], (a, b) => compareNames(a.target, b.target)),
          }
        : {}),
      ...(schemaVersion === 3
        ? { releasePlan: validatePlan(id.releasePlan) }
        : {}),
      files: sort(map([...files], ([name, bytes]) => fileRecord(name, bytes)),
        (a, b) => compareNames(a.name, b.name)),
    }),
  );
  files.set("SHA256SUMS", checksums(files));
  validateBundle(files, id, publicKey);
  return files;
}
/** @param {Map<string, Buffer>} files @param {import('../shared/tooling-domain-values.mjs').ReleaseIdentity} id @param {string} publicKey @returns {import('../shared/tooling-domain-values.mjs').Provenance} */
export function validateBundle(files, id, publicKey) {
  const names = assetNames(id.version);
  requireValue(files instanceof Map, "Release asset set must be a map.");
  const p = parseJson(files.get("provenance.json"), "provenance");
  requireValue(
    sort([...files.keys()], compareNames).join("|") ===
      sort(expectedNames(id.version, p.schemaVersion), compareNames).join("|"),
    "Release asset set is incomplete or has unexpected files.",
  );
  for (const bytes of files.values())
    requireValue(
      Buffer.isBuffer(bytes) &&
        bytes.length > 0 &&
        bytes.length <= MAX_RELEASE_ASSET,
      "Release asset is empty or exceeds the limit.",
    );
  for (const name of [
    "latest.json",
    ...(p.schemaVersion === 3 ? ["latest-semver.json"] : []),
  ])
    requireValue(
      Buffer.isBuffer(fileBytes(files, name)) &&
        fileBytes(files, name).length <= MAX_UPDATER_METADATA,
      "Updater metadata exceeds the installed client bound.",
    );
  const latest = parseJson(
    fileBytes(files, p.schemaVersion === 3 ? "latest-semver.json" : "latest.json"),
    "updater feed",
  );
  if (p.schemaVersion === 3) {
    requireValue(
      fileBytes(files, "latest.json").equals(legacyFeed()),
      "Legacy bridge feed changed.",
    );
    validatePlan(p.releasePlan);
    requireValue(
      p.releasePlan.sourceSha === id.sourceSha &&
        p.releasePlan.version === id.version &&
        p.releasePlan.pubDate === id.pubDate &&
        p.releasePlan.firstParentCount === id.firstParentCount &&
        (!id.releasePlan ||
          planSha256(p.releasePlan) === planSha256(validatePlan(id.releasePlan))),
      "Bundle plan differs from its reserved source/version.",
    );
  }
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
        (p.schemaVersion === 3
          ? p.releasePlan.notes
          : `Source ${id.sourceSha}. Install automatically only when fully stopped.`),
    "Release metadata differs from the exact source.",
  );
  requireValue(
    platform.url ===
      `https://github.com/${REPOSITORY}/releases/download/${id.tag}/${names.archive}`,
    "Updater URL is not the immutable versioned archive.",
  );
  requireValue(
    platform.signature === fileBytes(files, names.signature).toString("utf8").trim(),
    "Manifest and detached signatures differ.",
  );
  verifyUpdaterSignature(
    fileBytes(files, names.archive),
    platform.signature,
    publicKey,
    id.version,
  );
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
      ...(p.schemaVersion >= 2 ? ["platforms"] : []),
      ...(p.schemaVersion === 3 ? ["releasePlan"] : []),
    ],
    "provenance",
  );
  requireValue(
    [1, 2, 3].includes(p.schemaVersion) &&
      p.repository === REPOSITORY &&
      p.sourceSha === id.sourceSha &&
      p.firstParentCount ===
        (p.schemaVersion === 3 ? sourceCount(id) : countOf(id.version)) &&
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
  const runtime = Object.hasOwn(p.toolchain ?? {}, "bun") ? "bun" : "node";
  exactKeys(p.toolchain, [runtime, "rust"], "toolchain");
  requireValue(
    p.toolchain[runtime] === (runtime === "bun" ? BUN_VERSION : LEGACY_NODE_VERSION) &&
      p.toolchain.rust === RUST_VERSION,
    "Unexpected release toolchain.",
  );
  const expected = pipe(expectedNames(id.version, p.schemaVersion),
    filter((name) => !["provenance.json", "SHA256SUMS"].includes(name)),
    sort(compareNames),
    map(fileRecordFor(files)),
  );
  requireValue(
    JSON.stringify(p.files) === JSON.stringify(expected),
    "Provenance asset hashes or sizes differ.",
  );
  if (p.schemaVersion >= 2) {
    requireValue(
      Array.isArray(p.platforms) &&
        p.platforms.length === 3 &&
        p.platforms.map((receipt) => receipt?.target).join("|") ===
          sort([TARGET, WINDOWS_TARGET, LINUX_TARGET], compareNames).join("|"),
      "Release platform receipt set is incomplete or duplicated.",
    );
    for (const receipt of p.platforms) {
      validateBuildIdentity(receipt, id, p, receipt.target);
      const platformFiles = pipe(platformNames(id.version, receipt.target), sort(compareNames), map(fileRecordFor(files)));
      requireValue(
        JSON.stringify(receipt.files) === JSON.stringify(platformFiles),
        "Platform receipt asset hashes or sizes differ.",
      );
      if (receipt.target !== TARGET)
        for (const name of platformNames(id.version, receipt.target))
          validateInstaller(name, fileBytes(files, name), id.version);
    }
  }
  requireValue(
    fileBytes(files, "SHA256SUMS").equals(checksums(files)),
    "Release checksums differ.",
  );
  return provenanceValues(p);
}
/** @param {import('../shared/tooling-domain-values.mjs').ReleaseIdentity} id @param {import('../shared/tooling-domain-values.mjs').ArtifactIdentity} artifact @param {number} [schemaVersion] */
export function releaseBody(id, artifact, schemaVersion = 2) {
  validateArtifact(artifact);
  requireValue(
    [1, 2, 3].includes(schemaVersion),
    "Unsupported release schema.",
  );
  const platforms =
    schemaVersion >= 2
      ? "Apple Silicon macOS, Windows x64 and Linux x86_64"
      : "Apple Silicon (ARM64)";
  const installers =
    schemaVersion >= 2
      ? " Download the Windows NSIS installer, Linux DEB or AppImage for those systems; their updater remains disabled."
      : "";
  return `Rayrag Companion ${id.version} for ${platforms}.\n\nBootstrap: download the DMG for macOS.${installers} Existing updater-enabled macOS clients use the signed archive. Apple signing is ad-hoc; this build is not notarized.\n\n${schemaVersion === 3 ? validatePlan(id.releasePlan).notes + "\n\n" : ""}Source: ${id.sourceSha}\n\n<!-- rayrag-release:${JSON.stringify({ schemaVersion, version: id.version, sourceSha: id.sourceSha, artifact, ...(schemaVersion === 3 ? { firstParentCount: sourceCount(id), planSha256: planSha256(validatePlan(id.releasePlan)) } : {}) })} -->`;
}
/** @param {import('../shared/tooling-domain-values.mjs').ReleaseDto} release @returns {import('../shared/tooling-domain-values.mjs').ReleaseMetadata} */
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
    [
      "schemaVersion",
      "version",
      "sourceSha",
      "artifact",
      ...(meta.schemaVersion === 3 ? ["firstParentCount", "planSha256"] : []),
    ],
    "release provenance",
  );
  requireValue(
    [1, 2, 3].includes(meta.schemaVersion) &&
      release.tag_name === `v${meta.version}`,
    "Release tag/metadata conflict.",
  );
  if (meta.schemaVersion === 3) {
    stableVersion(meta.version);
    requireValue(
      Number.isSafeInteger(meta.firstParentCount) &&
        meta.firstParentCount > 0 &&
        typeof meta.planSha256 === "string" &&
        /^[a-f0-9]{64}$/.test(meta.planSha256),
      "Invalid release plan marker.",
    );
  } else countOf(meta.version);
  validSha(meta.sourceSha);
  validateArtifact(meta.artifact);
  return releaseMetadataValues(meta);
}
/** @param {import('../shared/tooling-domain-values.mjs').ReleaseIdentity} id @returns {import('../shared/tooling-domain-values.mjs').FirstParentCount} */
export function sourceCount(id) {
  if (!id.releasePlan && id.firstParentCount === undefined)
    return countOf(id.version);
  requireValue(
    typeof id.firstParentCount === 'number' && Number.isSafeInteger(id.firstParentCount) && id.firstParentCount > 0,
    "Invalid release source ordinal.",
  );
  return firstParentCount(id.firstParentCount, "Invalid release source ordinal.");
}
/** @param {import('../shared/tooling-domain-values.mjs').ReleaseIdentity} id @param {{readonly count: import('../shared/tooling-domain-values.mjs').FirstParentCount, readonly version: import('../shared/tooling-domain-values.mjs').StableReleaseVersion}} latest */
export function isNewer(id, latest) {
  const order = Math.sign(sourceCount(id) - latest.count),
    semantic = Math.sign(compareVersions(id.version, latest.version));
  requireValue(
    order === semantic,
    "Release source and semantic version order conflict.",
  );
  return order > 0;
}
/** @type {import('../shared/tooling-domain-values.mjs').ReleaseBridgeDto} */
export const migrationBridge = Object.freeze({
  sourceSha: migration.bridge.sourceSha,
  firstParentCount: migration.bridge.firstParentCount,
  version: migration.bridge.version,
  tag: migration.bridge.tag,
});
export function legacyFeed() {
  const bytes = jsonBuffer(migration.legacyFeed);
  const bridge = migrationBridge;
  requireValue(
    bridge.tag === `v${bridge.version}` &&
      countOf(bridge.version) === bridge.firstParentCount &&
      sha256(bytes) === migration.bridge.feedSha256 &&
      migration.legacyFeed.version === bridge.version &&
      migration.legacyFeed.platforms?.["darwin-aarch64"]?.url ===
        `https://github.com/${REPOSITORY}/releases/download/${bridge.tag}/${assetNames(stableVersion(bridge.version)).archive}`,
    "Invalid frozen bridge feed.",
  );
  validSha(bridge.sourceSha);
  return bytes;
}

/** @param {readonly string[]} history @param {import('../shared/tooling-domain-values.mjs').ReleaseDto} release */
export function validateReleaseAncestry(history, release) {
  const meta = releaseMetadata(release),
    n = meta.schemaVersion === 3 ? meta.firstParentCount : countOf(meta.version);
  requireValue(
    history[n - 1] === meta.sourceSha,
    "Published history was rewritten or version/tag ancestry conflicts.",
  );
  return meta;
}

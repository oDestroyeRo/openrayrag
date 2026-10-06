// Pure transforms for source content. Reading and writing remain in release.mjs.
import { stableVersion } from "./semantic-release-policy.mjs";
import { requireValue, IDENTIFIER, ENDPOINT } from "./release-policy.mjs";

export const VERSION_PATHS = Object.freeze([
  "package.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
  "src-tauri/tauri.conf.json",
]);

export function versionContents(values, version) {
  stableVersion(version);
  const pkg = JSON.parse(values[0]), config = JSON.parse(values[3]);
  const old = pkg.version;
  requireValue(
    pkg.name === "rayrag-companion" &&
      config.version === old,
    "Source versions are inconsistent.",
  );
  const cargo = values[1].replaceAll("\r\n", "\n").split("\n");
  let section = "",
    changed = 0;
  for (let i = 0; i < cargo.length; i++) {
    if (cargo[i].startsWith("[")) section = cargo[i];
    if (section === "[package]" && /^version = /.test(cargo[i])) {
      requireValue(
        cargo[i] === `version = "${old}"`,
        "Cargo package version differs.",
      );
      cargo[i] = `version = "${version}"`;
      changed++;
    }
  }
  requireValue(changed === 1, "Expected one Cargo package version.");
  let packages = 0;
  const cargoLock = values[2]
    .replaceAll("\r\n", "\n")
    .split("[[package]]")
    .map((block) => {
      if (/^\nname = "rayrag-companion"\n/m.test(block)) {
        packages++;
        requireValue(
          block.includes(`\nversion = "${old}"\n`),
          "Cargo lock version differs.",
        );
        return block.replace(
          `\nversion = "${old}"\n`,
          `\nversion = "${version}"\n`,
        );
      }
      return block;
    })
    .join("[[package]]");
  requireValue(packages === 1, "Expected one root package in Cargo.lock.");
  // Bun's dependency lock has no root package version; keep it byte-identical.
  pkg.version = config.version = version;
  return [
    JSON.stringify(pkg, null, 2) + "\n",
    cargo.join("\n"),
    cargoLock,
    JSON.stringify(config, null, 2) + "\n",
  ];
}

export function validateUpdaterConfig(c) {
  requireValue(
    c.identifier === IDENTIFIER &&
      c.bundle?.createUpdaterArtifacts === true &&
      typeof c.plugins?.updater?.pubkey === "string" &&
      c.plugins.updater.pubkey.length > 20,
    "Updater configuration/public key is not ready.",
  );
  requireValue(
    JSON.stringify(c.plugins.updater.endpoints) === JSON.stringify([ENDPOINT]) &&
      c.plugins.updater.requireSignedVersion === true,
    "Updater endpoint/signed-version contract differs.",
  );
  return c;
}

/** @param {string} sha @param {Buffer} output */
export function tagResponseBytes(sha, output) {
  const end = output.indexOf(10);
  requireValue(end >= 0, "Malformed Git object response.");
  const response = output.subarray(0, end).toString("ascii");
  if (response === `${sha} missing`) return null;
  const match = response.match(/^([a-f0-9]{40}) tag ([1-9]\d*)$/);
  requireValue(
    match && match[1] === sha,
    "Reservation is not an annotated Git tag.",
  );
  const size = Number(match[2]);
  requireValue(
    Number.isSafeInteger(size) &&
      size <= 130 * 1024 &&
      output.length === end + 1 + size + 1 &&
      output.at(-1) === 10,
    "Invalid annotated Git object size.",
  );
  return output.subarray(end + 1, end + 1 + size);
}

/** @param {string} sha @param {Buffer} bytes */
export function annotatedTag(sha, bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    split = text.indexOf("\n\n");
  requireValue(split >= 0, "Annotated Git object headers are missing.");
  const headers = new Map();
  for (const line of text.slice(0, split).split("\n")) {
    const space = line.indexOf(" ");
    requireValue(
      space > 0 && !headers.has(line.slice(0, space)),
      "Invalid annotated Git object headers.",
    );
    headers.set(line.slice(0, space), line.slice(space + 1));
  }
  requireValue(
    [...headers.keys()].sort().join("|") === "object|tag|tagger|type",
    "Unexpected annotated Git object headers.",
  );
  return {
    sha,
    tag: headers.get("tag"),
    message: text.slice(split + 2),
    object: { type: headers.get("type"), sha: headers.get("object") },
  };
}

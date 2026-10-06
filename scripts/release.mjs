// CI-only entry point. Importing this module never reads signing keys or contacts GitHub.
import { execFileSync } from "node:child_process";
import {
  readFile,
  writeFile,
  readdir,
  mkdtemp,
  mkdir,
  rm,
  appendFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY,
  TARGET,
  WINDOWS_TARGET,
  LINUX_TARGET,
  BUN_VERSION,
  RUST_VERSION,
  MAX_RELEASE_ASSET,
  MAX_RELEASE_BUNDLE,
  sha256,
  requireValue,
  assetNames,
  expectedNames,
  createBundle,
  validateBundle,
  validateArtifact,
  validatePlatformBuild,
  publishRelease,
} from "./release-core.mjs";
import { stableVersion, serializePlan } from "./semantic-release-plan.mjs";
import { planProduction, loadProductionPlan } from "./release-planning.mjs";
import { PLAN_REF_PREFIX, MAX_RESERVATIONS } from "./release-reservations.mjs";
import { VERSION_PATHS, versionContents, validateUpdaterConfig, tagResponseBytes, annotatedTag } from "./release-source-policy.mjs";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const exec = (file, args, cwd = repositoryRoot) =>
  execFileSync(file, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
export async function stampVersions(root, version) {
  stableVersion(version);
  const values = await Promise.all(VERSION_PATHS.map(p => readFile(join(root, p), "utf8")));
  // Validate and transform every source before the first write.
  const updates = versionContents(values, version);
  await Promise.all(VERSION_PATHS.map((p, i) => writeFile(join(root, p), updates[i])));
}
async function readConfig() {
  const c = JSON.parse(
    await readFile(join(repositoryRoot, "src-tauri/tauri.conf.json"), "utf8"),
  );
  return validateUpdaterConfig(c);
}
async function filesAt(folder, version) {
  const names = await readdir(folder);
  requireValue(
    names.includes("provenance.json") && names.length <= 10,
    "Invalid release bundle directory.",
  );
  const schemaVersion = JSON.parse(
    await readFile(join(folder, "provenance.json"), "utf8"),
  ).schemaVersion;
  requireValue(
    names.sort().join("|") ===
      expectedNames(version, schemaVersion).sort().join("|"),
    "Unexpected files in release bundle directory.",
  );
  return new Map(
    await Promise.all(
      names.map(async (name) =>
        /** @type {[string, Buffer]} */ (
          [name, await readFile(join(folder, name))]
        ),
      ),
    ),
  );
}
async function writeFiles(folder, files) {
  await mkdir(folder, { recursive: true });
  requireValue(
    (await readdir(folder)).length === 0,
    "Release output directory must be empty.",
  );
  for (const [name, bytes] of files) await writeFile(join(folder, name), bytes);
}
async function verifyNative(files, id) {
  const folder = await mkdtemp(join(tmpdir(), "rayrag-release-verify-"));
  try {
    const names = assetNames(id.version);
    for (const name of [names.archive, names.dmg])
      await writeFile(join(folder, name), files.get(name));
    execFileSync(
      "python3",
      [
        join(repositoryRoot, "scripts/release-native.py"),
        "verify",
        folder,
        id.version,
      ],
      { stdio: "inherit" },
    );
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}
function trustedContext() {
  requireValue(
    process.env.GITHUB_REPOSITORY === REPOSITORY &&
      process.env.GITHUB_REF === "refs/heads/main" &&
      ["push", "workflow_dispatch"].includes(process.env.GITHUB_EVENT_NAME ?? ""),
    "Release effects require the trusted main workflow.",
  );
  const sha = process.env.GITHUB_SHA;
  requireValue(
    typeof sha === "string" && /^[a-f0-9]{40}$/.test(sha) &&
      exec("git", ["rev-parse", "HEAD"]) === sha,
    "Checkout is not the exact triggering SHA.",
  );
  requireValue(
    exec("git", ["rev-parse", "--is-shallow-repository"]) === "false",
    "Full Git ancestry is required.",
  );
  requireValue(
    /^https:\/\/github\.com\/oDestroyeRo\/openrayrag(?:\.git)?$/.test(
      exec("git", ["remote", "get-url", "origin"]),
    ),
    "Unexpected release origin.",
  );
  exec("git", [
    "fetch",
    "--no-tags",
    "origin",
    "refs/heads/main:refs/remotes/origin/main",
  ]);
  // Fetch only the reservation namespace into this disposable CI checkout.
  // Existing refs are never forced; a divergent remote tag fails closed.
  exec("git", [
    "fetch",
    "--no-tags",
    "origin",
    `${PLAN_REF_PREFIX}*:${PLAN_REF_PREFIX}*`,
  ]);
  const history = exec("git", [
    "rev-list",
    "--first-parent",
    "--reverse",
    "refs/remotes/origin/main",
  ]).split("\n");
  const dateFor = async (commit) =>
    new Date(exec("git", ["show", "-s", "--format=%cI", commit])).toISOString();
  return {
    history,
    sha,
    dateFor,
    readTagObject: (objectSha) => readLocalTagObject(repositoryRoot, objectSha),
  };
}
/** @param {string} root @param {string} sha */
export function readLocalTagObject(root, sha) {
  requireValue(/^[a-f0-9]{40}$/.test(sha), "Invalid annotated tag SHA.");
  const output = execFileSync("git", ["cat-file", "--batch"], {
    cwd: root,
    input: `${sha}\n`,
    maxBuffer: 256 * 1024,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const bytes = tagResponseBytes(sha, output);
  if (bytes === null) return null;
  requireValue(
    execFileSync("git", ["hash-object", "-t", "tag", "--stdin"], {
      cwd: root,
      input: bytes,
      encoding: "utf8",
      maxBuffer: 1024,
      stdio: ["pipe", "pipe", "pipe"],
    }).trim() === sha,
    "Annotated Git object checksum differs.",
  );
  return annotatedTag(sha, bytes);
}
export class GitHubReleaseApi {
  /**
   * @param {string | undefined} token
   * @param {((sha: string) => ReturnType<typeof readLocalTagObject>) | null} readTagObject
   */
  constructor(token, readTagObject = null) {
    requireValue(
      typeof token === "string" && token.length > 0,
      "GitHub job token is missing.",
    );
    this.token = token;
    this.tagObjects = new Map();
    this.readTagObject = readTagObject;
  }
  /**
   * JSON responses remain untrusted and are validated by the release engines.
   * @param {"GET" | "POST" | "PATCH"} method
   * @param {string} path
   * @param {Record<string, unknown> | Buffer} [body]
   * @param {{bytes?: boolean, accept?: string}} [options]
   */
  async request(
    method,
    path,
    body,
    { bytes = false, accept = "application/vnd.github+json" } = {},
  ) {
    const url = path.startsWith("https://uploads.github.com/")
      ? path
      : `https://api.github.com/repos/${REPOSITORY}/${path}`;
    requireValue(
      url.startsWith(`https://api.github.com/repos/${REPOSITORY}/`) ||
        url.startsWith(
          `https://uploads.github.com/repos/${REPOSITORY}/releases/`,
        ),
      "Unexpected GitHub API URL.",
    );
    const response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${this.token}`,
        Accept: accept,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body
          ? {
              "Content-Type": Buffer.isBuffer(body)
                ? "application/octet-stream"
                : "application/json",
            }
          : {}),
      },
      body: body
        ? Buffer.isBuffer(body)
          ? body
          : JSON.stringify(body)
        : undefined,
      redirect: "manual",
      signal: AbortSignal.timeout(120_000),
    });
    if (response.status === 404 && method === "GET") return null;
    if (bytes && response.status === 302) {
      const header = response.headers.get("location");
      requireValue(header !== null, "Artifact download redirect is missing.");
      const location = new URL(header);
      requireValue(
        location.protocol === "https:" &&
          (location.hostname.endsWith(".githubusercontent.com") ||
            location.hostname.endsWith(".blob.core.windows.net")),
        "Unexpected artifact download redirect.",
      );
      const download = await fetch(location, {
        signal: AbortSignal.timeout(120_000),
      });
      requireValue(download.ok, "Artifact download failed.");
      return boundedBytes(download);
    }
    requireValue(
      response.ok,
      `GitHub ${method} request failed (${response.status}); no response body or credentials logged.`,
    );
    return bytes
      ? boundedBytes(response)
      : JSON.parse(
          (await boundedBytes(response, 8 * 1024 * 1024)).toString("utf8"),
        );
  }
  /** @param {string} tag */
  async release(tag) {
    // The tag endpoint promises published releases only. Authenticated release
    // listing is required to recover drafts, including drafts on later pages.
    const matches = [];
    for (let page = 1; page <= 100; page++) {
      const releases = await this.request(
        "GET",
        `releases?per_page=100&page=${page}`,
      );
      requireValue(Array.isArray(releases), "Invalid release listing.");
      matches.push(...releases.filter((release) => release.tag_name === tag));
      requireValue(
        matches.length <= 1,
        "Multiple releases claim the same version tag.",
      );
      if (releases.length < 100) return matches[0] ?? null;
    }
    throw new Error(
      "Release listing exceeds the bounded reconciliation limit.",
    );
  }
  latest() {
    return this.request("GET", "releases/latest");
  }
  /** @param {string} tag */
  async tagSha(tag) {
    const ref = await this.request(
      "GET",
      `git/ref/tags/${encodeURIComponent(tag)}`,
    );
    if (!ref) return null;
    let obj = ref.object;
    for (let n = 0; n < 8 && obj?.type === "tag"; n++)
      obj = (await this.request("GET", `git/tags/${obj.sha}`))?.object;
    requireValue(
      obj?.type === "commit" && /^[a-f0-9]{40}$/.test(obj.sha),
      "Tag cannot be resolved to a commit.",
    );
    return obj.sha;
  }
  async planRefs() {
    const refs = await this.request(
      "GET",
      `git/matching-refs/${PLAN_REF_PREFIX.slice("refs/".length)}`,
    );
    requireValue(
      Array.isArray(refs) && refs.length < MAX_RESERVATIONS,
      "Invalid or oversized reservation listing.",
    );
    return refs;
  }
  /** @param {string} ref */
  planRef(ref) {
    requireValue(
      ref.startsWith(PLAN_REF_PREFIX),
      "Unexpected reservation ref.",
    );
    return this.request("GET", `git/ref/${ref.slice("refs/".length)}`);
  }
  /** @param {string} sha */
  async tagObject(sha) {
    requireValue(/^[a-f0-9]{40}$/.test(sha), "Invalid annotated tag SHA.");
    // Git objects are immutable by SHA. Refs are always read afresh.
    if (!this.tagObjects.has(sha))
      this.tagObjects.set(
        sha,
        this.readTagObject?.(sha) ??
          (await this.request("GET", `git/tags/${sha}`)),
      );
    return this.tagObjects.get(sha);
  }
  /**
   * @param {string} tag
   * @param {string} message
   * @param {string} sourceSha
   * @param {string} pubDate
   */
  createPlanTag(tag, message, sourceSha, pubDate) {
    requireValue(
      tag.startsWith(PLAN_REF_PREFIX.slice("refs/tags/".length)),
      "Unexpected reservation tag.",
    );
    requireValue(
      typeof pubDate === "string" &&
        new Date(pubDate).toISOString() === pubDate,
      "Invalid reservation tagger date.",
    );
    return this.request("POST", "git/tags", {
      tag,
      message,
      object: sourceSha,
      type: "commit",
      tagger: {
        name: "github-actions[bot]",
        email: "41898282+github-actions[bot]@users.noreply.github.com",
        date: pubDate,
      },
    });
  }
  /** @param {string} ref @param {string} sha */
  createPlanRef(ref, sha) {
    requireValue(
      ref.startsWith(PLAN_REF_PREFIX),
      "Unexpected reservation ref.",
    );
    return this.request("POST", "git/refs", { ref, sha });
  }
  /** @param {string} tag @param {string} sha */
  createTag(tag, sha) {
    return this.request("POST", "git/refs", { ref: `refs/tags/${tag}`, sha });
  }
  /** @param {{tag: string, version: string}} id @param {string} body */
  createDraft(id, body) {
    return this.request("POST", "releases", {
      tag_name: id.tag,
      // The exact tag has already been created and read back. GitHub ignores
      // this field for existing tags; a historical SHA here would unnecessarily
      // require Workflows:write when main's workflow files have since changed.
      target_commitish: "main",
      name: `Rayrag Companion ${id.version}`,
      body,
      draft: true,
      prerelease: false,
      make_latest: "false",
    });
  }
  /** @param {number} id */
  async assets(id) {
    const assets = await this.request(
      "GET",
      `releases/${id}/assets?per_page=100`,
    );
    requireValue(
      Array.isArray(assets) && assets.length <= 10,
      "Unexpected release asset list.",
    );
    return assets;
  }
  downloadAsset(asset) {
    requireValue(
      Number.isSafeInteger(asset.id) &&
        asset.id > 0 &&
        asset.state === "uploaded" &&
        Number.isSafeInteger(asset.size) &&
        asset.size > 0 &&
        asset.size <= MAX_RELEASE_ASSET,
      "Invalid uploaded asset.",
    );
    return this.request("GET", `releases/assets/${asset.id}`, undefined, {
      bytes: true,
      accept: "application/octet-stream",
    });
  }
  async downloadRelease(release, names) {
    const assets = await this.assets(release.id);
    requireValue(
      assets.length === names.length &&
        new Set(assets.map((a) => a.name)).size === names.length &&
        assets.every((a) => names.includes(a.name)),
      "Published release asset set is incomplete.",
    );
    return new Map(
      await Promise.all(
        assets.map(async (asset) => {
          const bytes = await this.downloadAsset(asset);
          requireValue(
            bytes && bytes.length === asset.size,
            "Asset size changed during download.",
          );
          return /** @type {[string, Buffer]} */ ([asset.name, bytes]);
        }),
      ),
    );
  }
  /** @param {number} id @param {string} name @param {Buffer} bytes */
  upload(id, name, bytes) {
    return this.request(
      "POST",
      `https://uploads.github.com/repos/${REPOSITORY}/releases/${id}/assets?name=${encodeURIComponent(name)}`,
      bytes,
    );
  }
  /** @param {number} id @param {Record<string, unknown>} body */
  publish(id, body) {
    // Also normalize older drafts' metadata; tag/provenance remain authoritative.
    return this.request("PATCH", `releases/${id}`, {
      ...body,
      target_commitish: "main",
    });
  }
  async restoreArtifact(artifact, id, folder) {
    validateArtifact(artifact);
    const meta = await this.request("GET", `actions/artifacts/${artifact.id}`);
    requireValue(
      meta &&
        !meta.expired &&
        String(meta.id) === artifact.id &&
        String(meta.workflow_run?.id) === artifact.runId &&
        meta.workflow_run?.head_sha === id.sourceSha &&
        meta.digest === artifact.digest,
      "Original signed workflow artifact expired or has conflicting provenance. Recover it manually; do not rebuild into the draft.",
    );
    const bytes = await this.request(
      "GET",
      `actions/artifacts/${artifact.id}/zip`,
      undefined,
      // Actions returns a ZIP redirect through the JSON API media type.
      { bytes: true },
    );
    requireValue(
      bytes && `sha256:${sha256(bytes)}` === artifact.digest,
      "Workflow artifact ZIP checksum differs.",
    );
    const temporary = await mkdtemp(join(tmpdir(), "rayrag-release-artifact-"));
    try {
      const zip = join(temporary, "bundle.zip");
      await writeFile(zip, bytes);
      await mkdir(folder, { recursive: true });
      requireValue(
        (await readdir(folder)).length === 0,
        "Artifact destination must be empty.",
      );
      execFileSync(
        "python3",
        [
          join(repositoryRoot, "scripts/release-native.py"),
          "extract-zip",
          zip,
          folder,
          JSON.stringify([
            expectedNames(id.version, 1),
            expectedNames(id.version, 2),
            expectedNames(id.version, 3),
          ]),
        ],
        { stdio: "inherit" },
      );
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}
/** @param {Response} response @param {number} [limit] @returns {Promise<Buffer>} */
async function boundedBytes(
  response,
  limit = MAX_RELEASE_BUNDLE + 1024 * 1024,
) {
  const chunks = [];
  let size = 0;
  requireValue(response.body !== null, "Download response body is missing.");
  for await (const chunk of response.body) {
    size += chunk.length;
    requireValue(size <= limit, "Download exceeds release size bound.");
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
async function outputs(values) {
  if (!process.env.GITHUB_OUTPUT) return;
  for (const [key, value] of Object.entries(values)) {
    requireValue(
      /^[a-z-]+$/.test(key) && !/[\r\n]/.test(String(value)),
      "Invalid workflow output.",
    );
    await appendFile(process.env.GITHUB_OUTPUT, `${key}=${value}\n`);
  }
}
function artifactFromEnv() {
  const digest = process.env.RELEASE_ARTIFACT_DIGEST ?? "";
  return validateArtifact({
    id: process.env.RELEASE_ARTIFACT_ID,
    runId: process.env.RELEASE_ARTIFACT_RUN_ID,
    digest: digest.startsWith("sha256:") ? digest : `sha256:${digest}`,
  });
}
async function main() {
  const command = process.argv[2],
    source = trustedContext(),
    config = await readConfig(),
    publicKey = config.plugins.updater.pubkey;
  const context = {
    ...source,
    publicKey,
    verifyNative,
    commitsBetween: async (base, head) => {
      requireValue(
        source.history.includes(base) &&
          source.history.includes(head) &&
          source.history.indexOf(base) < source.history.indexOf(head),
        "Invalid introduced commit range.",
      );
      const output = execFileSync(
        "git",
        ["log", "--format=%H%x00%B%x00", `${base}..${head}`],
        { cwd: repositoryRoot, encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
      const fields = output.split("\0");
      requireValue(
        fields.at(-1)?.trim() === "" && fields.length % 2 === 1,
        "Invalid Git commit range output.",
      );
      return Array.from({ length: (fields.length - 1) / 2 }, (_, i) => ({
        hash: fields[2 * i].trim(),
        message: fields[2 * i + 1].trimEnd(),
      }));
    },
    api: new GitHubReleaseApi(process.env.GITHUB_TOKEN, source.readTagObject),
  };
  if (command === "preflight") {
    const result = await planProduction(context);
    if (result.plan)
      await writeFile(
        join(repositoryRoot, "release-plan.json"),
        serializePlan(result.plan),
        { flag: "wx" },
      );
    await outputs({
      state: result.state,
      version: result.id?.version ?? "",
      "artifact-id": result.artifact?.id ?? "",
      "artifact-run-id": result.artifact?.runId ?? "",
      "artifact-digest": result.artifact?.digest ?? "",
    });
    console.log(
      `Release ${result.id?.version ?? "none"}: ${result.state}${result.reason ? ` (${result.reason})` : ""}.`,
    );
    return;
  }
  const loaded = await loadProductionPlan(
    context,
    await readFile(join(repositoryRoot, "release-plan.json")),
  );
  const { id } = loaded;
  if (command === "stamp") {
    await stampVersions(repositoryRoot, id.version);
    exec(
      "cargo",
      ["metadata", "--locked", "--no-deps", "--format-version", "1"],
      join(repositoryRoot, "src-tauri"),
    );
    console.log(
      `CI checkout stamped ${id.version}; source commit ${id.sourceSha}.`,
    );
  } else if (command === "prepare") {
    requireValue(
      config.version === id.version &&
        process.arch === "arm64" &&
        process.platform === "darwin",
      "Release must be built as the stamped ARM64 macOS app.",
    );
    requireValue(
      process.versions.bun === BUN_VERSION &&
        exec("rustc", ["--version"]).startsWith(`rustc ${RUST_VERSION} `),
      "Release toolchain differs from the pinned versions.",
    );
    const folder = join(
        repositoryRoot,
        "src-tauri/target",
        TARGET,
        "release/bundle",
      ),
      mac = join(folder, "macos"),
      dmgFiles = (await readdir(join(folder, "dmg"))).filter((name) =>
        name.endsWith(".dmg"),
      );
    requireValue(dmgFiles.length === 1, "Expected exactly one bootstrap DMG.");
    const names = assetNames(id.version);
    /** @type {Map<string, Buffer>} */
    const payload = new Map([
      [
        names.archive,
        await readFile(join(mac, "Rayrag Companion.app.tar.gz")),
      ],
      [
        names.signature,
        await readFile(join(mac, "Rayrag Companion.app.tar.gz.sig")),
      ],
      [names.dmg, await readFile(join(folder, "dmg", dmgFiles[0]))],
    ]);
    const runId = process.env.GITHUB_RUN_ID,
      runAttempt = process.env.GITHUB_RUN_ATTEMPT,
      artifactName = `release-${id.sourceSha}-${runId}-${runAttempt}`;
    const build = { runId, runAttempt, artifactName, schemaVersion: 3 },
      platforms = [];
    for (const [platform, target] of [
      ["windows", WINDOWS_TARGET],
      ["linux", LINUX_TARGET],
    ]) {
      const directory = join(repositoryRoot, "platform-bundles", platform);
      const platformFiles = new Map(
        await Promise.all(
          (await readdir(directory)).map(async (name) =>
            /** @type {[string, Buffer]} */ (
              [name, await readFile(join(directory, name))]
            ),
          ),
        ),
      );
      platforms.push(validatePlatformBuild(platformFiles, id, build, target));
      for (const [name, bytes] of platformFiles)
        if (name !== "platform-build.json") payload.set(name, bytes);
    }
    const files = createBundle(id, payload, { ...build, platforms }, publicKey);
    await verifyNative(files, id);
    await writeFiles(join(repositoryRoot, "release-bundle"), files);
    console.log(
      `Verified complete macOS, Windows and Linux release ${id.version}.`,
    );
  } else if (command === "restore") {
    await loaded.api.restoreArtifact(
      artifactFromEnv(),
      id,
      join(repositoryRoot, "release-bundle"),
    );
    const files = await filesAt(
      join(repositoryRoot, "release-bundle"),
      id.version,
    );
    validateBundle(files, id, publicKey);
    await verifyNative(files, id);
    console.log(
      `Original signed bundle restored and verified for ${id.version}.`,
    );
  } else if (command === "publish") {
    const files =
      process.env.RELEASE_STATE === "published"
        ? undefined
        : await filesAt(join(repositoryRoot, "release-bundle"), id.version);
    const result = await publishRelease({
      ...loaded,
      files,
      artifact: files ? artifactFromEnv() : undefined,
    });
    console.log(`Release ${id.version}: ${result}.`);
  } else
    throw new Error("Expected preflight, stamp, prepare, restore or publish.");
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

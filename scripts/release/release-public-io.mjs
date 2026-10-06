import { filter, fromEntries } from "remeda";
// Read-only transports. Public downloads never receive gh credentials.
import { spawn, execFileSync } from "node:child_process";
import { chmod, mkdtemp, open, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const REPOSITORY = "oDestroyeRo/openrayrag";
export const MAX_METADATA = 16 * 1024 * 1024;
const PUBLIC_HOSTS = new Set([
  "github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com",
]);

/** @param {unknown} ok @param {string} message @returns {asserts ok} */
export function requireValue(ok, message) {
  if (!ok) throw new Error(message);
}

export function privateEnvironment(folder, environment = process.env) {
  const clean = fromEntries(filter(Object.entries(environment), ([key]) =>
    !/TOKEN|PASSWORD|SECRET|AUTH|COOKIE|GITHUB|GH_|TAURI_SIGNING|GIT_|NPM_CONFIG|NODE_OPTIONS|NODE_PATH|^BUN_/i.test(key),
  ));
  return {
    ...clean,
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(folder, "empty-config"),
    GIT_TERMINAL_PROMPT: "0", PYTHONDONTWRITEBYTECODE: "1",
    NPM_CONFIG_USERCONFIG: join(folder, "empty-config"),
    NPM_CONFIG_GLOBALCONFIG: join(folder, "empty-global-config"),
    NPM_CONFIG_REGISTRY: "https://registry.npmjs.org/",
    // Bun merges global package-manager config even with an explicit --config.
    XDG_CONFIG_HOME: folder,
    BUN_INSTALL_CACHE_DIR: join(folder, "bun-cache"),
  };
}

export async function createReportDirectory() {
  const folder = await mkdtemp(join(tmpdir(), "rayrag-public-proof-"));
  await chmod(folder, 0o700);
  for (const name of ["empty-config", "empty-global-config", ".bunfig.toml", ".npmrc"])
    await writeFile(join(folder, name), "", { flag: "wx", mode: 0o600 });
  return folder;
}

export function privateWriter(folder) {
  return async (name, bytes) => {
    requireValue(/^[A-Za-z0-9_.-]+$/.test(name) && ![".", ".."].includes(name), "Invalid report file name.");
    await writeFile(join(folder, name), bytes, { flag: "wx", mode: 0o600 });
  };
}

export function runReadOnly(command, args, options = {}) {
  try {
    return execFileSync(command, args, {
      stdio: ["ignore", "pipe", "pipe"], timeout: 180_000,
      // Callers may adjust env/cwd/timeout, but cannot enable shell evaluation.
      maxBuffer: MAX_METADATA, ...options, shell: false,
    });
  } catch (error) {
    // Child stderr can contain environment/configuration data. Keep it private.
    throw new Error(`${command} verification command failed (exit ${(typeof error === "object" && error !== null && "status" in error ? error.status : undefined) ?? "unavailable"}).`);
  }
}

export function bunInstallCommand(migrate = false, versions = process.versions) {
  requireValue(typeof versions.bun === "string", "Run verification with Bun: bun run release:verify.");
  // Spawn Bun itself, including bun.exe on Windows, without a shell or shim.
  // Historical npm locks are imported only inside this private proof directory.
  return { file: process.execPath, args: [
    "install", ...(migrate ? ["--lockfile-only", "--save-text-lockfile"] : ["--frozen-lockfile"]),
    "--ignore-scripts", "--omit=peer", "--no-env-file", "--config=bunfig.toml",
    "--registry=https://registry.npmjs.org/",
  ] };
}

/** @param {string} [repository] @param {typeof runReadOnly} [execute] @returns {import("../shared/tooling-domain-values.mjs").PublicMetadataApi} */
export function githubMetadata(repository = REPOSITORY, execute = runReadOnly) {
  requireValue(repository === REPOSITORY, "Only the authoritative release repository is supported.");
  const cache = new Map();
  return async (path, { fresh = false } = {}) => {
    requireValue(typeof path === "string" && /^\/[A-Za-z0-9_./?=&-]+$/.test(path) && !path.includes(".."), "Invalid metadata path.");
    if (!fresh && cache.has(path)) return cache.get(path);
    const bytes = execute("gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}${path}`], { timeout: 60_000 });
    requireValue(bytes.length <= MAX_METADATA, "Metadata exceeds its bound.");
    const result = JSON.parse(bytes.toString("utf8"));
    cache.set(path, result);
    return result;
  };
}

export async function anonymousBytes(url, limit, fetchImpl = fetch) {
  requireValue(Number.isSafeInteger(limit) && limit > 0, "Invalid public download bound.");
  let current = new URL(url);
  for (let hop = 0; hop < 6; hop++) {
    requireValue(current.protocol === "https:" && !current.username && !current.password && !current.port && PUBLIC_HOSTS.has(current.hostname), "Unexpected public download origin.");
    const response = await fetchImpl(current, {
      headers: { "User-Agent": "rayrag-public-release-proof", Accept: "application/octet-stream" },
      redirect: "manual", credentials: "omit", signal: AbortSignal.timeout(180_000),
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      await response.body?.cancel();
      requireValue(location, "Missing public download redirect.");
      current = new URL(location, current);
      continue;
    }
    requireValue(response.ok, `Anonymous download failed: HTTP ${response.status}.`);
    const declared = response.headers.get("content-length");
    if (declared !== null) {
      requireValue(/^\d+$/.test(declared) && Number(declared) <= limit, "Public response exceeds its declared bound.");
    }
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body ?? []) {
      size += chunk.length;
      requireValue(size <= limit, "Public response exceeds its byte bound.");
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }
  throw new Error("Public download redirect limit exceeded.");
}

// gh authenticates only the read-only Actions ZIP endpoint. Stream to a private
// exclusive file so a compressed artifact cannot exhaust process memory.
/** @param {string} repository @param {import("../shared/tooling-domain-values.mjs").ActionsArtifactId} artifactId @param {string} destination @param {number} limit @param {typeof spawn} [spawnImpl] */
export async function downloadActionsZip(repository, artifactId, destination, limit, spawnImpl = spawn) {
  requireValue(repository === REPOSITORY && /^[1-9]\d*$/.test(artifactId), "Invalid Actions artifact identity.");
  requireValue(Number.isSafeInteger(limit) && limit > 0, "Invalid Actions ZIP bound.");
  const output = await open(destination, "wx", 0o600);
  let child;
  try {
    child = spawnImpl("gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}/actions/artifacts/${artifactId}/zip`], {
      stdio: ["ignore", "pipe", "ignore"], timeout: 180_000,
    });
    const completed = new Promise(/** @param {(value?: void) => void} resolve */ (resolve, reject) => {
      child.once("error", () => reject(new Error("Actions ZIP download could not start.")));
      child.once("close", (code, signal) => code === 0 ? resolve() : reject(new Error(`Actions ZIP download failed (${signal ?? code}).`)));
    });
    // A bounded-stream failure must not leave a rejected child promise unobserved.
    completed.catch(() => {});
    let size = 0;
    for await (const chunk of child.stdout) {
      size += chunk.length;
      requireValue(size <= limit, "Actions ZIP exceeds its byte bound.");
      await output.writeFile(chunk);
    }
    await completed;
    requireValue(size > 0, "Actions ZIP is empty.");
    return size;
  } finally {
    if (child && child.exitCode === null) child.kill();
    await output.close();
  }
}

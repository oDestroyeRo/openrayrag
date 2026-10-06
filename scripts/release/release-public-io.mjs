import { filter, fromEntries } from "remeda";
// Read-only transports. Public downloads never receive gh credentials.
import { spawn, execFile, execFileSync } from "node:child_process";
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

// Metadata reads may run concurrently. Other verification commands retain their
// existing synchronous execution and ordering.
/** @param {string} command @param {readonly string[]} args @param {import("node:child_process").ExecFileOptions} [options] @param {typeof execFile} [execute] @returns {Promise<Buffer>} */
export function runReadOnlyAsync(command, args, options = {}, execute = execFile) {
  return new Promise((resolve, reject) => {
    const fail = error => {
      // Never expose child stderr, configuration or launch error text.
      const exit = typeof error?.code === "number" ? error.code : "unavailable";
      reject(new Error(`${command} verification command failed (exit ${exit}).`));
    };
    try {
      const child = execute(command, args, {
        timeout: 60_000, maxBuffer: MAX_METADATA,
        ...options, encoding: "buffer", shell: false,
      }, (error, stdout) => error ? fail(error) : resolve(stdout));
      child?.stdin?.end();
    } catch (error) { fail(error); }
  });
}

// Attempt every cleanup operation, retaining an established primary failure,
// including arbitrary thrown values such as undefined.
async function finishResources(cleanups, primaryFailed) {
  let cleanupFailed = false, failure;
  for (const cleanup of cleanups) {
    try { await cleanup(); }
    catch (error) {
      if (!cleanupFailed) { cleanupFailed = true; failure = error; }
    }
  }
  if (!primaryFailed && cleanupFailed) throw failure;
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

/** @param {string} [repository] @param {(command: string, args: readonly string[], options: import("node:child_process").ExecFileOptions) => Buffer | Promise<Buffer>} [execute] @returns {import("../shared/tooling-domain-values.mjs").PublicMetadataApi} */
export function githubMetadata(repository = REPOSITORY, execute = runReadOnlyAsync) {
  requireValue(repository === REPOSITORY, "Only the authoritative release repository is supported.");
  const cache = new Map();
  return async (path, { fresh = false } = {}) => {
    requireValue(typeof path === "string" && /^\/[A-Za-z0-9_./?=&-]+$/.test(path) && !path.includes(".."), "Invalid metadata path.");
    if (!fresh && cache.has(path)) return cache.get(path);
    const pending = (async () => {
      const bytes = await execute("gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${repository}${path}`], {
        timeout: 60_000, maxBuffer: MAX_METADATA, shell: false,
      });
      requireValue(bytes.length <= MAX_METADATA, "Metadata exceeds its bound.");
      return JSON.parse(bytes.toString("utf8"));
    })();
    cache.set(path, pending);
    try { return await pending; }
    catch (error) {
      if (cache.get(path) === pending) cache.delete(path);
      throw error;
    }
  };
}

export async function anonymousBytes(url, limit, fetchImpl = fetch, timers = { setTimeout, clearTimeout }) {
  requireValue(Number.isSafeInteger(limit) && limit > 0, "Invalid public download bound.");
  let current = new URL(url);
  const controller = new AbortController();
  let timer;
  const deadline = new Promise((resolve, reject) => {
    timer = timers.setTimeout(() => {
      const reason = new DOMException("Public download timed out.", "TimeoutError");
      controller.abort(reason);
      reject(reason);
    }, 180_000);
  });
  deadline.catch(() => {});
  try {
    for (let hop = 0; hop < 6; hop++) {
      controller.signal.throwIfAborted();
      requireValue(current.protocol === "https:" && !current.username && !current.password && !current.port && PUBLIC_HOSTS.has(current.hostname), "Unexpected public download origin.");
      const fetched = Promise.resolve(fetchImpl(current, {
        headers: { "User-Agent": "rayrag-public-release-proof", Accept: "application/octet-stream" },
        redirect: "manual", credentials: "omit", signal: controller.signal,
      }));
      // An injected transport may return a body after ignoring its abort signal.
      fetched.then(response => {
        if (controller.signal.aborted) {
          try { response.body?.cancel().catch(() => {}); } catch {}
        }
      }, () => {});
      const response = await Promise.race([fetched, deadline]);
      let reader, complete = false, failed = false;
      try {
        controller.signal.throwIfAborted();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get("location");
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
        reader = response.body?.getReader();
        while (reader) {
          controller.signal.throwIfAborted();
          const { done, value } = await Promise.race([reader.read(), deadline]);
          controller.signal.throwIfAborted();
          if (done) { complete = true; break; }
          size += value.length;
          requireValue(size <= limit, "Public response exceeds its byte bound.");
          chunks.push(value);
        }
        return Buffer.concat(chunks);
      } catch (error) { failed = true; throw error; }
      finally {
        const cancel = () => {
          if (complete) return;
          const canceled = reader ? reader.cancel() : response.body?.cancel();
          // Failed cleanup must not prolong the operation or replace its cause.
          if (failed) { canceled?.catch(() => {}); return; }
          return canceled ? Promise.race([canceled, deadline]) : undefined;
        };
        await finishResources(reader ? [cancel, () => reader.releaseLock()] : [cancel], failed);
      }
    }
    throw new Error("Public download redirect limit exceeded.");
  } finally { timers.clearTimeout(timer); }
}

// gh authenticates only the read-only Actions ZIP endpoint. Stream to a private
// exclusive file so a compressed artifact cannot exhaust process memory.
/** @param {string} repository @param {import("../shared/tooling-domain-values.mjs").ActionsArtifactId} artifactId @param {string} destination @param {number} limit @param {typeof spawn} [spawnImpl] @param {typeof open} [openImpl] */
export async function downloadActionsZip(repository, artifactId, destination, limit, spawnImpl = spawn, openImpl = open) {
  requireValue(repository === REPOSITORY && /^[1-9]\d*$/.test(artifactId), "Invalid Actions artifact identity.");
  requireValue(Number.isSafeInteger(limit) && limit > 0, "Invalid Actions ZIP bound.");
  const output = await openImpl(destination, "wx", 0o600);
  let child, failed = false;
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
  } catch (error) { failed = true; throw error; }
  finally {
    await finishResources([
      () => { if (child && child.exitCode === null) child.kill(); },
      () => output.close(),
    ], failed);
  }
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY, MAX_METADATA, anonymousBytes, githubMetadata, privateWriter, privateEnvironment,
  createReportDirectory, downloadActionsZip, runReadOnly, runReadOnlyAsync, bunInstallCommand,
} from "./release-public-io.mjs";
import { parseOptions, releaseSnapshot, verifyPublishedRelease, publicationEvidence } from "./release-public.mjs";
import { sourceWorkflowMatches, sameSourceWorkflow, validateArtifactProduction, hasSuccessfulPublisher } from "./release-public-policy.mjs";
import { peelTag, commitsBetween, verifySource, sourceDependencyFiles, sourceScriptDirectory, loadSourceValidators } from "./release-public-source.mjs";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";

const sha = value => createHash("sha256").update(value).digest("hex");
const sourceSha = "a".repeat(40);
const options = () => parseOptions(["--source", sourceSha, "--tag", "v1.8.4", "--skip-native"]);

test("read-only process execution keeps metacharacters literal even when a caller requests a shell", () => {
  const literal = "-n spaces & | ; $(printf should-not-run)";
  const output = runReadOnly(process.execPath,
    ["-e", "process.stdout.write(process.argv.at(-1))", "--", literal],
    { shell: true });
  assert.equal(output.toString("utf8"), literal);
});

test("asynchronous metadata runner preserves bounds, literal arguments and private failures", async () => {
  const literal = "spaces & | ; $(printf should-not-run)";
  assert.equal((await runReadOnlyAsync(process.execPath,
    ["-e", "process.stdout.write(process.argv.at(-1))", "--", literal],
    { shell: true })).toString("utf8"), literal);
  const calls = [];
  const execute = (command, args, options, callback) => {
    calls.push({ command, args, options });
    queueMicrotask(() => callback(null, Buffer.from("metadata")));
  };
  assert.equal((await runReadOnlyAsync("gh", ["api"], {}, execute)).toString(), "metadata");
  assert.equal(calls[0].options.timeout, 60_000);
  assert.equal(calls[0].options.maxBuffer, MAX_METADATA);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.encoding, "buffer");
  const failure = Object.assign(new Error("private launch detail"), { code: 3, stderr: "private child output" });
  await assert.rejects(runReadOnlyAsync("gh", ["api"], {}, (command, args, options, callback) => {
    callback(failure, Buffer.alloc(0));
  }), { message: "gh verification command failed (exit 3)." });
});

test("source dependency installation and historical lock migration use Bun without a command shell", () => {
  const command = bunInstallCommand();
  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, ["install", "--frozen-lockfile", "--ignore-scripts", "--omit=peer", "--no-env-file", "--config=bunfig.toml", "--registry=https://registry.npmjs.org/"]);
  assert.deepEqual(bunInstallCommand(true).args.slice(0, 3), ["install", "--lockfile-only", "--save-text-lockfile"]);
  assert.throws(() => bunInstallCommand(false, {}), /Bun/);
});

test("CLI help requires Bun and works without an npm launch context", () => {
  const env = { ...process.env };
  delete env.npm_execpath;
  const output = execFileSync(process.execPath,
    [fileURLToPath(new URL("./release-public.mjs", import.meta.url)), "--help"],
    { env, stdio: ["ignore", "pipe", "pipe"] }).toString("utf8");
  assert.match(output, /Requires Git, Bun, Python/);
  assert.doesNotMatch(output, /Requires .*npm/);
});

test("selected source extraction supports original npm locks and current Bun locks, and rejects unexpected files", () => {
  for (const names of [
    ["tools/release/package-lock.json", "tools/release/.npmrc"],
    ["tools/release/bun.lock", "tools/release/bunfig.toml"],
  ]) {
    assert.deepEqual(sourceDependencyFiles(sourceSha, args => {
      assert.deepEqual(args.slice(0, 4), ["ls-tree", "--name-only", sourceSha, "--"]);
      return Buffer.from(names.join("\n") + "\n");
    }), names);
  }
  for (const text of ["", "tools/release/package.json", "tools/release/bun.lock\ntools/release/bun.lock"])
    assert.throws(() => sourceDependencyFiles(sourceSha, () => Buffer.from(text)));
});

async function validatorSnapshot(layout = "modules") {
  const names = [
    "scripts/release/release-core.mjs", "scripts/release/release-native.py", "scripts/release/semantic-release-plan.mjs",
    "scripts/release/release-reservations.mjs", "scripts/release/release-planning.mjs", "scripts/release/release.mjs",
    "release.config.mjs", "release-policy-history.json", "release-migration.json",
    "tools/release/package.json", "tools/release/bun.lock", "tools/release/bunfig.toml",
    "scripts/release/release-policy.mjs", "scripts/release/release-publication.mjs", "scripts/release/release-source-policy.mjs",
    "scripts/release/release-reservation-policy.mjs", "scripts/release/release_policy.py", "scripts/release/semantic-release-policy.mjs", "scripts/shared/tooling-domain-values.mjs",
  ];
  const files = new Map(await Promise.all(names.map(async currentName => {
    const name = layout === "legacy" ? currentName.replace("scripts/release/", "scripts/").replace("scripts/shared/", "scripts/") : currentName;
    const bytes = layout === "legacy"
      ? execFileSync("git", ["show", `7d68d08:${name}`], { cwd: fileURLToPath(new URL("../..", import.meta.url)), maxBuffer: 16 * 1024 * 1024 })
      : await readFile(new URL(`../../${name}`, import.meta.url));
    return [name, bytes];
  })));
  const git = args => {
    if (args[0] === "ls-tree") return Buffer.from(args.slice(4).filter(name => files.has(name)).join("\n") + "\n");
    assert.equal(args[0], "show");
    assert.equal(args[1].slice(0, 40), sourceSha);
    const bytes = files.get(args[1].slice(41));
    assert.ok(bytes, `Snapshot has no ${args[1]}`);
    return bytes;
  };
  return { files, git };
}

test("isolated source tools share the root exact Remeda pin", async () => {
  const root = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  const tools = JSON.parse(await readFile(new URL("../../tools/release/package.json", import.meta.url), "utf8"));
  assert.equal(tools.devDependencies.remeda, root.dependencies.remeda);
  assert.match(tools.devDependencies.remeda, /^\d+\.\d+\.\d+$/);
});

for (const layout of ["legacy", "modules"]) test(`reconstructed ${layout} source computes a nonempty plan with locked Remeda and no app install or lifecycle hooks`, async () => {
  const parent = await createReportDirectory(), folder = join(parent, "source");
  try {
    const snapshot = await validatorSnapshot(layout);
    const manifest = JSON.parse(snapshot.files.get("tools/release/package.json"));
    manifest.scripts = { postinstall: `${JSON.stringify(process.execPath)} -e "require('node:fs').writeFileSync('lifecycle-ran','unsafe')"` };
    snapshot.files.set("tools/release/package.json", Buffer.from(JSON.stringify(manifest)));
    const { core, planner, reservations, scriptDirectory } = await loadSourceValidators(folder, sourceSha, snapshot.git);
    const bridge = core.migrationBridge;
    const result = await planner.planRelease({
      source: { sourceSha, firstParentCount: bridge.firstParentCount + 1, pubDate: "2026-10-06T00:00:00.000Z" },
      published: { sourceSha: bridge.sourceSha, version: bridge.version, tag: bridge.tag }, reservation: null,
      analysisCommits: [{ hash: sourceSha, message: "fix: reconstruct the locked source policy" }],
      notesCommits: [{ hash: sourceSha, message: "fix: reconstruct the locked source policy" }],
    });
    assert.equal(result.state, "release");
    assert.equal(result.plan.version, planner.bumpVersion(bridge.version, "patch"));
    assert.match(result.plan.notes, /reconstruct the locked source policy/);
    assert.equal(planner.validatePlan(result.plan), result.plan);
    assert.equal(reservations.planRefName(result.plan), `refs/tags/rayrag-release-plan/${result.plan.tag}`);
    assert.equal(await realpath(join(folder, "node_modules")), await realpath(join(folder, "tools/release/node_modules")));
    assert.equal(JSON.parse(await readFile(join(folder, "node_modules/remeda/package.json"), "utf8")).version, manifest.devDependencies.remeda);
    await assert.rejects(stat(join(folder, "tools/release/lifecycle-ran")), { code: "ENOENT" });
    await assert.rejects(stat(join(folder, "node_modules/esbuild")), { code: "ENOENT" });
    await assert.rejects(stat(join(folder, "package.json")), { code: "ENOENT" });
    // The extracted native validator keeps its own pure module available too.
    execFileSync(process.platform === "win32" ? "python" : "python3", ["-c", "import runpy; runpy.run_path('release-native.py')",], {
      cwd: join(folder, scriptDirectory), env: privateEnvironment(parent), stdio: "pipe",
    });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("source reconstruction rejects floating Remeda before installing and never replaces a root module path", async () => {
  for (const floating of [true, false]) {
    const parent = await createReportDirectory(), folder = join(parent, "source");
    try {
      const snapshot = await validatorSnapshot();
      if (floating) {
        const manifest = JSON.parse(snapshot.files.get("tools/release/package.json"));
        manifest.devDependencies.remeda = "^2.51.0";
        snapshot.files.set("tools/release/package.json", Buffer.from(JSON.stringify(manifest)));
        await assert.rejects(loadSourceValidators(folder, sourceSha, snapshot.git), /exact Remeda version/);
        await assert.rejects(stat(join(folder, "tools/release/node_modules")), { code: "ENOENT" });
      } else {
        await mkdir(join(folder, "node_modules"), { recursive: true });
        await writeFile(join(folder, "node_modules/preserved"), "owned by the caller");
        await assert.rejects(loadSourceValidators(folder, sourceSha, snapshot.git), { code: "EEXIST" });
        assert.equal(await readFile(join(folder, "node_modules/preserved"), "utf8"), "owned by the caller");
      }
    } finally { await rm(parent, { recursive: true, force: true }); }
  }
});

test("historical validators without Remeda retain their isolated tool layout", async () => {
  const parent = await createReportDirectory(), folder = join(parent, "source");
  try {
    const snapshot = await validatorSnapshot();
    for (const name of snapshot.files.keys())
      if (name.startsWith("scripts/") && name.endsWith(".mjs")) snapshot.files.set(name, Buffer.from("export const historical = true;\n"));
    const manifest = JSON.parse(snapshot.files.get("tools/release/package.json"));
    delete manifest.devDependencies.remeda;
    snapshot.files.set("tools/release/package.json", Buffer.from(JSON.stringify(manifest)));
    snapshot.files.set("tools/release/bun.lock", Buffer.from(snapshot.files.get("tools/release/bun.lock")
      .toString("utf8").replace(/^\s*"remeda":.*\n/gm, "")));
    const modules = await loadSourceValidators(folder, sourceSha, snapshot.git);
    for (const name of ["core", "planner", "reservations", "tags"]) assert.equal(modules[name].historical, true);
    await assert.rejects(stat(join(folder, "node_modules")), { code: "ENOENT" });
  } finally { await rm(parent, { recursive: true, force: true }); }
});

test("CLI accepts dynamic canonical source/tag/run inputs and makes latest opt-in", () => {
  assert.equal(options().latest, false);
  assert.equal(options().tag, "v1.8.4");
  assert.equal(parseOptions(["--source", sourceSha, "--tag", "v12.0.19", "--run-id", "123", "--run-attempt", "2", "--latest"]).runAttempt, "2");
  assert.deepEqual(parseOptions(["--help"]), { help: true });
  for (const args of [
    ["--source", sourceSha, "--tag", "v01.8.4"],
    ["--source", sourceSha, "--tag", "v1.8.4-beta.1"],
    ["--source", sourceSha, "--tag", "v1.8.4", "--repo", "foreign/repo"],
    ["--source", sourceSha, "--tag", "v1.8.4", "--run-attempt", "2"],
    ["--source", sourceSha, "--tag", "v1.8.4", "--latest", "--latest"],
    ["--source", sourceSha, "--tag", "v1.8.4", "--output", "existing"],
  ]) assert.throws(() => parseOptions(args));
});

test("anonymous download validates every redirect and sends no credentials", async () => {
  const requests = [];
  const bytes = await anonymousBytes(`https://github.com/${REPOSITORY}/releases/download/v1.8.4/a`, 8, async (url, init) => {
    requests.push([url.href, init]);
    return requests.length === 1
      ? new Response(null, { status: 302, headers: { location: "https://release-assets.githubusercontent.com/path?signature=public" } })
      : new Response("proof");
  });
  assert.equal(bytes.toString(), "proof");
  assert.equal(requests.length, 2);
  assert.equal(requests[0][1].signal, requests[1][1].signal);
  for (const [, init] of requests) {
    assert.equal(init.credentials, "omit");
    assert.equal(init.redirect, "manual");
    assert.equal(Object.keys(init.headers).some(key => /authorization|cookie/i.test(key)), false);
  }
  let calls = 0;
  await assert.rejects(anonymousBytes("https://github.com/a", 8, async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "https://attacker.example/path" } });
  }), /origin/);
  assert.equal(calls, 1);
  for (const url of ["http://github.com/a", "https://user:password@github.com/a", "https://github.com:8443/a", "https://api.github.com/a"])
    await assert.rejects(anonymousBytes(url, 8, () => { throw new Error("must not fetch"); }), /origin/);
});

test("public downloads bound declared/streamed bytes and redirects", async () => {
  await assert.rejects(anonymousBytes("https://github.com/a", 4, async () => new Response("five!")), /byte bound/);
  await assert.rejects(anonymousBytes("https://github.com/a", 4, async () => new Response("ok", { headers: { "content-length": "9" } })), /declared bound/);
  await assert.rejects(anonymousBytes("https://github.com/a", 4, async () => new Response(null, { status: 302 })), /Missing/);
  let calls = 0;
  await assert.rejects(anonymousBytes("https://github.com/a", 4, async () => {
    calls++; return new Response(null, { status: 302, headers: { location: "/a" } });
  }), /redirect limit/);
  assert.equal(calls, 6);
});

test("public download failures cancel bodies and preserve their primary diagnostic", async () => {
  for (const [init, expected] of [
    [{ status: 503 }, /HTTP 503/],
    [{ headers: { "content-length": "invalid" } }, /declared bound/],
    [{ headers: { "content-length": "9" } }, /declared bound/],
    [{ status: 302 }, /Missing public download redirect/],
  ]) {
    let canceled = 0;
    const body = new ReadableStream({ cancel() { canceled++; throw new Error("secondary cancellation failure"); } });
    await assert.rejects(anonymousBytes("https://github.com/a", 4,
      async () => new Response(body, init)), expected);
    assert.equal(canceled, 1);
    assert.equal(body.locked, false);
  }
  let canceled = 0;
  const overflow = new ReadableStream({
    start(controller) { controller.enqueue(Buffer.from("oversized")); },
    cancel() { canceled++; throw new Error("secondary cancellation failure"); },
  });
  await assert.rejects(anonymousBytes("https://github.com/a", 4,
    async () => new Response(overflow)), /byte bound/);
  assert.equal(canceled, 1);
  assert.equal(overflow.locked, false);
  const streamFailure = new Error("primary stream failure");
  const broken = new ReadableStream({ pull(controller) { controller.error(streamFailure); } });
  await assert.rejects(anonymousBytes("https://github.com/a", 4,
    async () => new Response(broken)), error => error === streamFailure);
  assert.equal(broken.locked, false);
});

test("public reader cleanup attempts cancellation and lock release for arbitrary thrown values", async () => {
  const calls = [];
  const body = { getReader: () => ({
    read: async () => { throw undefined; },
    cancel: async () => { calls.push("cancel"); throw new Error("secondary cancellation failure"); },
    releaseLock: () => { calls.push("release"); throw new Error("secondary release failure"); },
  }) };
  let rejected = false;
  try {
    await anonymousBytes("https://github.com/a", 4,
      async () => ({ status: 200, ok: true, headers: new Headers(), body }));
  } catch (error) { rejected = true; assert.equal(error, undefined); }
  assert.equal(rejected, true);
  assert.deepEqual(calls, ["cancel", "release"]);
});

test("public downloads share one operation deadline and dispose it on every outcome", async () => {
  for (const outcome of ["success", "timeout", "fetch-failure", "origin-failure"]) {
    const token = {}, scheduled = [], cleared = [], signals = [];
    const timers = {
      setTimeout(callback, delay) { scheduled.push({ callback, delay }); return token; },
      clearTimeout(timer) { cleared.push(timer); },
    };
    const download = anonymousBytes(outcome === "origin-failure" ? "https://attacker.example/a" : "https://github.com/a", 8,
      async (url, init) => {
        signals.push(init.signal);
        if (outcome === "fetch-failure") throw new Error("fetch failed");
        if (signals.length === 1) return new Response(null, { status: 302, headers: { location: "/b" } });
        if (outcome === "timeout") { scheduled[0].callback(); throw init.signal.reason; }
        return new Response("proof");
      }, timers);
    if (outcome === "success") assert.equal((await download).toString(), "proof");
    else await assert.rejects(download, outcome === "timeout" ? { name: "TimeoutError" } : /fetch failed|origin/);
    assert.equal(scheduled.length, 1);
    assert.equal(scheduled[0].delay, 180_000);
    assert.deepEqual(cleared, [token]);
    if (signals.length === 2) assert.equal(signals[0], signals[1]);
  }
});

test("deadline cancels stalled delivered bodies and releases locks without awaiting failed cleanup", async () => {
  for (const outcome of ["stalled-read", "stalled-redirect", "http-failure"]) {
    let expire, observed, canceled = 0, fetches = 0, cleared = 0;
    const owned = new Promise(resolve => { observed = resolve; });
    const body = new ReadableStream({
      pull: () => new Promise(() => {}),
      cancel() {
        canceled++;
        if (outcome === "stalled-redirect") observed();
        return new Promise(() => {});
      },
    });
    if (outcome === "stalled-read") {
      const getReader = body.getReader.bind(body);
      body.getReader = () => { const reader = getReader(); observed(); return reader; };
    }
    const pending = anonymousBytes("https://github.com/a", 8, async () => {
      fetches++;
      return new Response(body, outcome === "stalled-redirect"
        ? { status: 302, headers: { location: "/b" } }
        : outcome === "http-failure" ? { status: 503 } : {});
    }, {
      setTimeout(callback, delay) { expire = callback; assert.equal(delay, 180_000); return 1; },
      clearTimeout() { cleared++; },
    });
    if (outcome === "http-failure") await assert.rejects(pending, /HTTP 503/);
    else {
      await owned;
      if (outcome === "stalled-read") assert.equal(body.locked, true);
      expire();
      await assert.rejects(pending, { name: "TimeoutError" });
    }
    assert.equal(body.locked, false);
    assert.equal(canceled, 1);
    assert.equal(fetches, 1);
    assert.equal(cleared, 1);
  }
});

test("deadline disposes bodies returned late by a transport that ignores cancellation", async () => {
  let expire, deliver, canceled = 0;
  const body = new ReadableStream({ cancel() { canceled++; return new Promise(() => {}); } });
  const pending = anonymousBytes("https://github.com/a", 8,
    () => new Promise(resolve => { deliver = resolve; }), {
      setTimeout(callback) { expire = callback; return 1; }, clearTimeout() {},
    });
  expire();
  await assert.rejects(pending, { name: "TimeoutError" });
  deliver(new Response(body));
  await Promise.resolve();
  assert.equal(canceled, 1);
  assert.equal(body.locked, false);
});

test("tiny and empty download chunks retain one timeout subscription and preserve exact bytes", async () => {
  let active = 0, peak = 0, delivered = 0, cleared = 0;
  const expected = Buffer.from(Array.from({ length: 70_000 }, (_, index) => index % 256));
  const bytes = await anonymousBytes("https://github.com/a", expected.length, async (_url, init) => {
    const signal = init.signal;
    const add = signal.addEventListener.bind(signal), remove = signal.removeEventListener.bind(signal);
    signal.addEventListener = (...args) => { active++; peak = Math.max(peak, active); return add(...args); };
    signal.removeEventListener = (...args) => { active--; return remove(...args); };
    return new Response(new ReadableStream({
      pull(controller) {
        if (delivered === expected.length * 2) { controller.close(); return; }
        const index = Math.floor(delivered / 2);
        controller.enqueue(delivered++ % 2 === 0 ? new Uint8Array(0) : expected.subarray(index, index + 1));
      },
    }));
  }, { setTimeout: () => 1, clearTimeout: () => { cleared++; } });
  assert.deepEqual(bytes, expected);
  assert.equal(peak, 1);
  assert.equal(active, 0);
  assert.equal(cleared, 1);
});

test("metadata uses exact read-only gh routes, a cache, and explicit fresh reads", async () => {
  const requests = [];
  const api = githubMetadata(REPOSITORY, (command, args, options) => {
    requests.push([command, args, options]); return Buffer.from(JSON.stringify({ count: requests.length }));
  });
  const route = "/git/matching-refs/tags/rayrag-release-plan/";
  assert.equal((await api(route)).count, 1);
  assert.equal((await api(route)).count, 1);
  assert.equal((await api(route, { fresh: true })).count, 2);
  assert.deepEqual(requests[0], ["gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${REPOSITORY}${route}`],
    { timeout: 60_000, maxBuffer: MAX_METADATA, shell: false }]);
  await assert.rejects(api("/../../another-repo"), /path/);
});

test("independent metadata reads make progress together and fresh reads own the cache", async () => {
  const pending = [];
  const api = githubMetadata(REPOSITORY, (command, args) => new Promise((resolve, reject) => {
    pending.push({ args, resolve, reject });
  }));
  const routes = ["/actions/runs/123/attempts/2", "/actions/runs/123/attempts/2/jobs?per_page=100", "/actions/artifacts/345"];
  const grouped = Promise.all(routes.map(route => api(route)));
  assert.equal(pending.length, 3);
  assert.deepEqual(pending.map(call => call.args.at(-1)), routes.map(route => `repos/${REPOSITORY}${route}`));
  const cached = api(routes[0]);
  assert.equal(pending.length, 3);
  const fresh = api(routes[0], { fresh: true });
  assert.equal(pending.length, 4);
  pending[3].resolve(Buffer.from('{"value":"fresh"}'));
  assert.deepEqual(await fresh, { value: "fresh" });
  pending.slice(0, 3).forEach((call, index) => call.resolve(Buffer.from(JSON.stringify({ value: index }))));
  assert.deepEqual(await grouped, [{ value: 0 }, { value: 1 }, { value: 2 }]);
  assert.deepEqual(await cached, { value: 0 });
  assert.deepEqual(await api(routes[0]), { value: "fresh" });
});

test("failed and invalid metadata reads leave no rejected cached value", async () => {
  for (const invalid of [() => { throw new Error("transient read failure"); }, () => Buffer.from("invalid JSON"),
    () => Buffer.alloc(MAX_METADATA + 1)]) {
    let calls = 0;
    const api = githubMetadata(REPOSITORY, async () => {
      calls++;
      return calls === 1 ? invalid() : Buffer.from('{"recovered":true}');
    });
    await assert.rejects(api("/releases/latest"));
    assert.deepEqual(await api("/releases/latest"), { recovered: true });
    assert.equal(calls, 2);
  }
});

test("private reports are exclusive and sanitized child environments remove credentials", async () => {
  const folder = await createReportDirectory();
  try {
    if (process.platform !== "win32") assert.equal((await stat(folder)).mode & 0o777, 0o700);
    const write = privateWriter(folder);
    await write("evidence.json", "first");
    await assert.rejects(write("evidence.json", "replacement"), { code: "EEXIST" });
    assert.equal(await readFile(join(folder, "evidence.json"), "utf8"), "first");
    await assert.rejects(write("../escape", "bad"), /file name/);
    const env = privateEnvironment(folder, { PATH: "tools", GH_TOKEN: "synthetic", COOKIE: "synthetic", NODE_OPTIONS: "synthetic", GIT_CONFIG_COUNT: "1", TAURI_SIGNING_PRIVATE_KEY: "synthetic", BUN_OPTIONS: "--preload=synthetic", BUN_CONFIG_VERBOSE_FETCH: "1", BUN_INSTALL_CACHE_DIR: "unsafe-cache", BUN_INSTALL_REGISTRY: "https://unsafe.invalid" });
    assert.equal(env.PATH, "tools");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.BUN_OPTIONS, undefined);
    assert.equal(env.BUN_CONFIG_VERBOSE_FETCH, undefined);
    assert.equal(env.BUN_INSTALL_REGISTRY, undefined);
    assert.equal(env.BUN_INSTALL_CACHE_DIR, join(folder, "bun-cache"));
    assert.equal(env.XDG_CONFIG_HOME, folder);
    assert.equal(env.GIT_CONFIG_GLOBAL, join(folder, "empty-config"));
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("source installs ignore inherited global Bun configuration", async () => {
  const folder = await createReportDirectory();
  try {
    const inherited = join(folder, "inherited"), project = join(folder, "project");
    await mkdir(inherited);
    await mkdir(project);
    await writeFile(join(inherited, ".bunfig.toml"), '[install]\nminimumReleaseAge = "invalid inherited setting"\n');
    await writeFile(join(project, "package.json"), '{"name":"isolated-proof","private":true}');
    await writeFile(join(project, "bunfig.toml"), '[install]\npeer = false\n');
    const command = bunInstallCommand(true);
    const environment = { ...process.env, XDG_CONFIG_HOME: inherited };
    assert.throws(() => execFileSync(command.file, command.args, { cwd: project, env: environment, stdio: "pipe" }));
    runReadOnly(command.file, command.args, { cwd: project, env: privateEnvironment(folder, environment) });
    assert.equal(await readFile(join(folder, ".bunfig.toml"), "utf8"), "");
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Actions ZIP streaming is bounded and the command is explicitly GET", async () => {
  const folder = await mkdtemp(join(tmpdir(), "rayrag-zip-test-"));
  const calls = [];
  function childFactory(command, args) {
    calls.push([command, args]);
    const child = new EventEmitter();
    child.stdout = Readable.from([Buffer.from("archive")]);
    child.exitCode = null;
    child.kill = () => { child.exitCode = 1; };
    child.stdout.on("end", () => setImmediate(() => { child.exitCode = 0; child.emit("close", 0); }));
    return child;
  }
  try {
    assert.equal(await downloadActionsZip(REPOSITORY, "123", join(folder, "artifact.zip"), 7, childFactory), 7);
    assert.equal(await readFile(join(folder, "artifact.zip"), "utf8"), "archive");
    assert.deepEqual(calls[0][1], ["api", "--hostname", "github.com", "--method", "GET", `repos/${REPOSITORY}/actions/artifacts/123/zip`]);
    await assert.rejects(downloadActionsZip(REPOSITORY, "123", join(folder, "overflow.zip"), 3, childFactory), /bound/);
    await assert.rejects(downloadActionsZip(REPOSITORY, "123", join(folder, "artifact.zip"), 7, childFactory), { code: "EEXIST" });
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("Actions ZIP cleanup cannot mask primary failures and attempts every owned release", async () => {
  for (const primary of [new Error("primary launch failure"), undefined]) {
    let closed = 0, rejected = false;
    const open = async (destination, flags, mode) => {
      assert.equal(flags, "wx"); assert.equal(mode, 0o600);
      return { close: async () => { closed++; throw new Error("secondary close failure"); } };
    };
    try {
      await downloadActionsZip(REPOSITORY, "123", "private.zip", 7, () => { throw primary; }, open);
    } catch (error) { rejected = true; assert.equal(error, primary); }
    assert.equal(rejected, true);
    assert.equal(closed, 1);
  }
  for (const outcome of ["overflow", "write", "success"]) {
    const released = [];
    const primary = new Error("primary write failure"), closeFailure = new Error("close failure");
    const child = new EventEmitter();
    child.stdout = Readable.from([Buffer.from("archive")]);
    child.exitCode = null;
    child.kill = () => { released.push("kill"); throw new Error("secondary kill failure"); };
    if (outcome === "success") child.stdout.on("end", () => setImmediate(() => { child.exitCode = 0; child.emit("close", 0); }));
    const open = async () => ({
      writeFile: async () => { if (outcome === "write") throw primary; },
      close: async () => { released.push("close"); throw closeFailure; },
    });
    await assert.rejects(downloadActionsZip(REPOSITORY, "123", "private.zip", outcome === "overflow" ? 3 : 7,
      () => child, open), error => outcome === "overflow" ? /byte bound/.test(error.message)
      : error === (outcome === "write" ? primary : closeFailure));
    assert.deepEqual(released, outcome === "success" ? ["close"] : ["kill", "close"]);
  }
});

function fixture() {
  const opt = options(), requests = [], writes = new Map();
  const names = ["latest.json", "latest-semver.json", "payload.bin"];
  const content = new Map(names.map(name => [name, Buffer.from(name)]));
  const marker = { schemaVersion: 3, sourceSha, version: "1.8.4", firstParentCount: 91,
    planSha256: "plan-hash", artifact: { id: "345", runId: "123", digest: `sha256:${"e".repeat(64)}` } };
  const release = { id: 31, tag_name: opt.tag, body: "immutable marker", draft: false, prerelease: false,
    assets: names.map((name, i) => ({ id: i + 1, name, state: "uploaded", size: content.get(name).length, digest: `sha256:${sha(content.get(name))}`,
      browser_download_url: `https://github.com/${REPOSITORY}/releases/download/${opt.tag}/${name}` })) };
  const provenance = { runId: "123", runAttempt: "2", artifactName: "release-name" };
  const successful = name => ({ name: `Release lifecycle / ${name}`, status: "completed", conclusion: "success", steps: [] });
  const jobs = { total_count: 5, jobs: ["build", "assemble", "publish", "release-platforms (windows, new-runner, target)", "release-platforms (linux, new-runner, target)"].map(successful) };
  jobs.jobs[1].steps.push({ name: "Run actions/upload-artifact@v99", conclusion: "success" });
  jobs.jobs[2].steps.push(
    { name: "Restore and verify the exact workflow artifact", conclusion: "success" },
    { name: "Stage, verify and publish without moving latest backwards", conclusion: "success" },
  );
  const run = { id: 123, run_attempt: 2, head_sha: sourceSha, head_branch: "main", event: "push", status: "completed", conclusion: "success", path: ".github/workflows/release.yml" };
  const artifact = { id: 345, name: provenance.artifactName, digest: marker.artifact.digest, expired: false, workflow_run: { id: 123, head_sha: sourceSha } };
  const source = {
    plan: {}, identity: { version: "1.8.4", sourceSha, tag: opt.tag, firstParentCount: 91 },
    config: { plugins: { updater: { pubkey: "public" } } }, proof: { mainShaAtFetch: "b".repeat(40), independentlyRegenerated: true },
    core: {
      ENDPOINT: `https://github.com/${REPOSITORY}/releases/latest/download/latest.json`, MAX_RELEASE_ASSET: 1000,
      MAX_RELEASE_BUNDLE: 10_000, MAX_UPDATER_METADATA: 1000, expectedNames: () => [...names], sha256: sha,
      releaseMetadata: () => marker,
      validateBundle: (files, identity, key) => {
        assert.equal(files.size, names.length); assert.equal(identity.version, "1.8.4"); assert.equal(key, "public");
        return provenance;
      },
    }, planner: { planSha256: () => "plan-hash" },
    async confirmReservations() { requests.push("reservation readback"); },
  };
  const io = {
    verifySource: async () => source,
    api: async (path, flags) => {
      requests.push([path, flags]);
      if (path.startsWith("/git/ref/tags/")) return { object: { type: "commit", sha: sourceSha } };
      if (path === `/releases/tags/${opt.tag}` || path === "/releases/latest") return release;
      if (path.endsWith("/jobs?per_page=100")) return jobs;
      if (path.startsWith("/actions/runs/")) return run;
      if (path.startsWith("/actions/artifacts/")) return artifact;
      throw new Error(`Unexpected request: ${path}`);
    },
    download: async url => content.get(url.split("/").at(-1)),
    write: async (name, bytes) => { assert.equal(writes.has(name), false); writes.set(name, bytes); },
    verifyZip: async ({ assets, artifactId, artifactDigest, limit }) => {
      assert.equal(assets.length, 3); assert.equal(artifactId, "345"); assert(limit > 1024 * 1024);
      return { zipDigest: artifactDigest, publicAssetCount: assets.length };
    },
    verifyNative: async () => { requests.push("native"); },
  };
  return { opt, io, source, requests, writes, release, marker, provenance, jobs, run, artifact, content };
}

test("source workflow predicates reuse a captured source without mutating inputs", () => {
  const { opt, run } = fixture(), before = structuredClone({ opt, run });
  const matchesSource = sourceWorkflowMatches(opt);
  Object.freeze(run);
  const dispatched = Object.freeze({ ...run, event: "workflow_dispatch" });
  const foreign = Object.freeze({ ...run, head_sha: "b".repeat(40) });
  const runs = Object.freeze([run, dispatched, foreign]);
  assert.deepEqual(runs.filter(matchesSource), [run, dispatched]);
  assert.deepEqual(runs.filter(matchesSource), [run, dispatched]);
  assert.equal(matchesSource(run), true);
  assert.equal(sameSourceWorkflow(run, opt), true);
  assert.deepEqual({ opt, run }, before);

  opt.sourceSha = foreign.head_sha;
  assert.equal(matchesSource(run), true);
  assert.equal(matchesSource(foreign), false);
  assert.equal(sameSourceWorkflow(run, opt), false);
  assert.equal(sameSourceWorkflow(foreign, opt), true);
});

test("source workflow predicates retain the trusted run identity and event contract", () => {
  const { opt, run } = fixture(), matchesSource = sourceWorkflowMatches(opt);
  for (const changed of [
    { id: 0 }, { id: "123" }, { id: Number.MAX_SAFE_INTEGER + 1 },
    { run_attempt: 0 }, { run_attempt: "2" },
    { head_sha: "b".repeat(40) }, { head_branch: "other" },
    { event: "pull_request" }, { path: ".github/workflows/other.yml" },
  ]) {
    const candidate = Object.freeze({ ...run, ...changed });
    assert.equal(matchesSource(candidate), false);
    assert.equal(sameSourceWorkflow(candidate, opt), false);
  }
});

test("nested job labels preserve exact leaf gates and successful publication steps", () => {
  const { opt, run, jobs, artifact, provenance, marker } = fixture();
  for (const job of jobs.jobs) job.name = `Outer workflow / ${job.name}`;
  const before = structuredClone({ opt, run, jobs, artifact, provenance, marker });
  for (let repeat = 0; repeat < 2; repeat++) {
    validateArtifactProduction(run, jobs, artifact, provenance, marker, opt);
    assert.equal(hasSuccessfulPublisher(run, jobs, opt), true);
  }
  assert.deepEqual({ opt, run, jobs, artifact, provenance, marker }, before);

  for (const name of ["build", "assemble", "publish", "release-platforms (windows, new-runner, target)", "release-platforms (linux, new-runner, target)"]) {
    const target = jobs.jobs.find(job => job.name.endsWith(` / ${name}`));
    for (const entries of [jobs.jobs.filter(job => job !== target), [...jobs.jobs, target]]) {
      const changed = { jobs: entries, total_count: entries.length };
      if (name === "publish") assert.equal(hasSuccessfulPublisher(run, changed, opt), false);
      else assert.throws(() => validateArtifactProduction(run, changed, artifact, provenance, marker, opt), /Missing successful/);
    }
  }

  const publisher = jobs.jobs.find(job => job.name.endsWith(" / publish"));
  for (const steps of [[], undefined, publisher.steps.map(step => ({ ...step, conclusion: "skipped" })),
    publisher.steps.map(step => ({ ...step, name: `Outer workflow / ${step.name}` }))]) {
    const changed = { ...jobs, jobs: jobs.jobs.map(job => job === publisher ? { ...job, steps } : job) };
    assert.notEqual(hasSuccessfulPublisher(run, changed, opt), true);
  }
});

test("immutable ancestor proof supports dynamic counts/assets/runners and no latest dependency", async () => {
  const f = fixture();
  const result = await verifyPublishedRelease(f.opt, f.io);
  assert.equal(result.assets.length, 3);
  assert.equal(result.semanticSourceProof.mainShaAtFetch, "b".repeat(40));
  assert.equal(result.latestReleaseChecked, false);
  assert.equal(result.nativeMacOSContainersVerified, false);
  assert.equal(f.requests.some(item => item[0] === "/releases/latest"), false);
  assert.equal(f.requests.includes("native"), false);
  assert(f.requests.includes("reservation readback"));
  assert(f.writes.has("final-verification.json"));
});

test("latest mode checks both moving feeds twice and native inspection is optional separately", async () => {
  const f = fixture(); f.opt.latest = true; f.opt.skipNative = false;
  const result = await verifyPublishedRelease(f.opt, f.io);
  assert.equal(result.latestReleaseChecked, true);
  assert.equal(result.nativeMacOSContainersVerified, true);
  assert.equal(f.requests.filter(item => item[0] === "/releases/latest").length, 2);
  for (const name of ["public-latest.json", "public-latest-semver.json", "final-public-latest.json", "final-public-latest-semver.json"])
    assert(f.writes.has(name));
  assert(f.requests.includes("native"));
});

test("source, run, artifact, complete jobs and public bytes must all match", async () => {
  for (const mutate of [
    f => { f.marker.sourceSha = "c".repeat(40); },
    f => { f.opt.runId = "999"; },
    f => { f.opt.runAttempt = "1"; },
    f => { f.run.head_sha = "c".repeat(40); },
    f => { f.artifact.expired = true; },
    f => { f.artifact.digest = `sha256:${"f".repeat(64)}`; },
    f => { f.jobs.total_count = 6; },
    f => { f.jobs.jobs[0].conclusion = "skipped"; },
    f => { f.content.set("payload.bin", Buffer.from("bad bytes")); },
    f => { f.release.assets[0].browser_download_url = "https://github.com/foreign/repo/a"; },
    f => { f.io.verifyZip = async () => ({ zipDigest: "wrong", publicAssetCount: 3 }); },
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(verifyPublishedRelease(f.opt, f.io));
    assert.equal(f.writes.has("final-verification.json"), false);
  }
});

function recoveredFixture() {
  const f = fixture(), api = f.io.api;
  f.provenance.runAttempt = "1"; f.run.run_attempt = 1;
  f.run.conclusion = "failure"; f.jobs.jobs[2].conclusion = "failure";
  const recoveryRun = { ...f.run, run_attempt: 2, conclusion: "success" };
  const recoveryJobs = { total_count: 3, jobs: [
    { name: "Release lifecycle / reconcile", status: "completed", conclusion: "success", steps: [] },
    { name: "Release lifecycle / assemble", status: "completed", conclusion: "success", steps: [
      { name: "Restore the original signed bundle for an incomplete draft", conclusion: "success" },
    ] },
    { name: "Release lifecycle / publish", status: "completed", conclusion: "success", steps: [
      { name: "Restore and verify the exact workflow artifact", conclusion: "success" },
      { name: "Stage, verify and publish without moving latest backwards", conclusion: "success" },
    ] },
  ] };
  f.io.api = async (path, flags) => {
    if (path === `/actions/workflows/release.yml/runs?head_sha=${sourceSha}&per_page=100`) return { workflow_runs: [recoveryRun] };
    if (path === "/actions/runs/123" || path === "/actions/runs/123/attempts/2") return recoveryRun;
    if (path === "/actions/runs/123/attempts/2/jobs?per_page=100") return recoveryJobs;
    return api(path, flags);
  };
  return { ...f, recoveryRun, recoveryJobs };
}

test("failed original publication can recover with the original artifact on a later exact-source attempt", async () => {
  const f = recoveredFixture();
  const result = await verifyPublishedRelease(f.opt, f.io);
  assert.equal(result.runAttempt, "1");
  assert.equal(result.artifactId, "345");
  assert.equal(result.artifactDigest, f.marker.artifact.digest);
  assert.equal(result.publicationRunId, "123");
  assert.equal(result.publicationRunAttempt, "2");
  assert.equal(result.publicationRecoveredOriginalArtifact, true);
  assert.equal(result.originalRunConclusion, "failure");
});

test("separate exact-source dispatch publication preserves original provenance arguments", async () => {
  const f = recoveredFixture(), api = f.io.api;
  f.opt.runId = "123"; f.opt.runAttempt = "1";
  f.recoveryRun.id = 456; f.recoveryRun.run_attempt = 1; f.recoveryRun.event = "workflow_dispatch";
  // A publisher-only retry uses assembly outputs from its successful original
  // job; the exact original bundle is rechecked by the publisher's restore step.
  f.recoveryJobs = { total_count: 1, jobs: [f.recoveryJobs.jobs[2]] };
  f.io.api = async (path, flags) => {
    if (path === "/actions/runs/456/attempts/1/jobs?per_page=100") return f.recoveryJobs;
    return api(path, flags);
  };
  const result = await verifyPublishedRelease(f.opt, f.io);
  assert.equal(result.runId, "123"); assert.equal(result.runAttempt, "1");
  assert.equal(result.publicationRunId, "456"); assert.equal(result.publicationRunAttempt, "1");
  assert.equal(result.publicationRecoveredOriginalArtifact, true);
});

test("publication discovery finds the restoring attempt behind a later already-published no-op", async () => {
  const f = recoveredFixture(), api = f.io.api;
  const restoredRun = { ...f.recoveryRun };
  f.recoveryRun.run_attempt = 3;
  const noOpJobs = { total_count: 1, jobs: [{ ...f.recoveryJobs.jobs[2], steps: [
    { name: "Restore and verify the exact workflow artifact", conclusion: "skipped" },
    { name: "Stage, verify and publish without moving latest backwards", conclusion: "success" },
  ] }] };
  f.io.api = async (path, flags) => {
    if (path === "/actions/runs/123/attempts/3/jobs?per_page=100") return noOpJobs;
    if (path === "/actions/runs/123/attempts/2") return restoredRun;
    return api(path, flags);
  };
  assert.equal((await verifyPublishedRelease(f.opt, f.io)).publicationRunAttempt, "2");
});

test("missing publication and large retry histories fail within a fixed metadata budget", async () => {
  const f = recoveredFixture();
  await assert.rejects(publicationEvidence(async () => ({ workflow_runs: [] }), f.run, f.jobs, f.opt), /No successful/);
  const latest = { ...f.run, run_attempt: 1000 }, calls = [];
  await assert.rejects(publicationEvidence(async path => {
    calls.push(path);
    if (path.includes("/workflows/")) return { workflow_runs: [latest] };
    return { ...latest, run_attempt: Number(path.split("/").at(-1)) };
  }, f.run, f.jobs, f.opt), /within 20 attempts/);
  assert.equal(calls.length, 20); // One listing + 19 preceding attempt records.
});

test("recovered publication requires the same source, successful restoration and publication", async () => {
  for (const mutate of [
    f => { f.recoveryRun.run_attempt = 1; },
    f => { f.recoveryRun.head_sha = "c".repeat(40); },
    f => { f.recoveryRun.id = 999; },
    f => { f.recoveryRun.conclusion = "failure"; },
    f => { f.recoveryJobs.jobs[2].steps[0].conclusion = "skipped"; },
    f => { f.recoveryJobs.jobs[2].steps[1].conclusion = "failure"; },
    f => { f.jobs.jobs[0].conclusion = "failure"; },
    f => { f.artifact.digest = `sha256:${"f".repeat(64)}`; },
  ]) {
    const f = recoveredFixture(); mutate(f);
    await assert.rejects(verifyPublishedRelease(f.opt, f.io));
    assert.equal(f.writes.has("final-verification.json"), false);
  }
});

test("metadata final readback catches changed release assets and ignores download counters", async () => {
  const f = fixture(), api = f.io.api;
  f.io.api = async (path, flags) => {
    const data = await api(path, flags);
    if (path.startsWith("/releases/tags/") && flags?.fresh) return { ...data, assets: data.assets.map(a => ({ ...a, digest: `sha256:${"f".repeat(64)}` })) };
    return data;
  };
  await assert.rejects(verifyPublishedRelease(f.opt, f.io), /changed/);
  const release = fixture().release;
  assert.equal(releaseSnapshot(release), releaseSnapshot({ ...release, assets: release.assets.map(a => ({ ...a, download_count: 99 })) }));
});

test("tag peeling rejects cycles/different targets and commit parsing retains messages", async () => {
  await assert.rejects(peelTag(async () => ({ object: { type: "tag", sha: sourceSha } }), "v1.8.4"), /Cyclic/);
  assert.equal(await peelTag(async () => ({ object: { type: "commit", sha: sourceSha } }), "v1.8.4"), sourceSha);
  assert.deepEqual(commitsBetween(() => Buffer.from(`${sourceSha}\0feat: useful\n\nbody\n\0\n`), "b".repeat(40), sourceSha), [{ hash: sourceSha, message: "feat: useful\n\nbody" }]);
});

async function sourceFixture() {
  const [core, planner, reservations] = await Promise.all([
    import("./release-core.mjs"), import("./semantic-release-plan.mjs"), import("./release-reservations.mjs"),
  ]);
  const history = Array.from({ length: 7 }, (_, i) => (i + 1).toString(16).padStart(40, "0"));
  const bridge = { version: "0.2.1", tag: "v0.2.1", sourceSha: history[0], firstParentCount: 1 };
  const base = { version: bridge.version, tag: bridge.tag, sourceSha: bridge.sourceSha };
  const commits = (from, through) => history.slice(history.indexOf(from) + 1, history.indexOf(through) + 1)
    .map((hash, i) => ({ hash, message: `fix: source ${hash}` }));
  const plans = [];
  for (let n = 2; n <= 5; n++) {
    const previous = plans.at(-1) ?? null;
    plans.push((await planner.planRelease({
      source: { sourceSha: history[n - 1], firstParentCount: n, pubDate: "2026-10-05T00:00:00.000Z" },
      published: base, reservation: previous,
      analysisCommits: commits(previous?.sourceSha ?? bridge.sourceSha, history[n - 1]),
      notesCommits: commits(bridge.sourceSha, history[n - 1]),
    })).plan);
  }
  const objects = new Map(), refs = [];
  for (let i = 0; i < plans.length; i++) {
    const plan = plans[i], objectSha = (100 + i).toString(16).padStart(40, "0");
    const ref = { ref: reservations.planRefName(plan), object: { type: "tag", sha: objectSha } };
    refs.push(ref);
    objects.set(objectSha, { sha: objectSha, tag: ref.ref.slice("refs/tags/".length), object: { type: "commit", sha: plan.sourceSha }, message: reservations.serializeReservation(plan) });
  }
  const futureSha = "f".repeat(40);
  refs.push({ ref: "refs/tags/rayrag-release-plan/v2.0.0", object: { type: "tag", sha: futureSha } });
  objects.set(futureSha, { sha: futureSha, tag: "rayrag-release-plan/v2.0.0", object: { type: "commit", sha: history[5] }, message: "future policy envelope; intentionally not parsed" });
  const published = { id: 1, draft: false, prerelease: false, tag_name: bridge.tag,
    body: core.releaseBody({ ...bridge, pubDate: "2026-10-05T00:00:00.000Z" }, { id: "1", runId: "1", digest: `sha256:${"a".repeat(64)}` }, 2) };
  const config = { plugins: { updater: { requireSignedVersion: true, endpoints: [core.ENDPOINT], pubkey: "public" } }, bundle: { createUpdaterArtifacts: true } };
  const opt = { ...options(), sourceSha: history[4], tag: plans[3].tag };
  const commands = [];
  const io = {
    api: async path => {
      if (path === "/git/ref/heads/main") return { object: { type: "commit", sha: history[6] } };
      if (path === "/git/matching-refs/tags/rayrag-release-plan/") return refs;
      if (path === `/releases/tags/${bridge.tag}`) return published;
      if (path === `/git/ref/tags/${bridge.tag}`) return { object: { type: "commit", sha: bridge.sourceSha } };
      throw new Error(`Unexpected source metadata route: ${path}`);
    },
    git: args => {
      commands.push(args);
      if (["init", "fetch"].includes(args[0])) return Buffer.from("");
      if (args[0] === "rev-parse") return Buffer.from(history[6]);
      if (args[0] === "rev-list") return Buffer.from(history.join("\n"));
      if (args[0] === "show") return Buffer.from(args.includes("--format=%cI") ? "2026-10-05T00:00:00Z" : JSON.stringify(config));
      if (args[0] === "log") {
        const [from, through] = args.at(-1).split("..");
        return Buffer.from(commits(from, through).map(c => `${c.hash}\0${c.message}\0\n`).join(""));
      }
      if (args[0] === "cat-file") return Buffer.from(objects.get(args.at(-1)).message);
      throw new Error(`Unexpected Git command: ${args}`);
    },
    loadValidators: async () => ({ core: { ...core, migrationBridge: bridge }, planner, reservations,
      tags: { readLocalTagObject: (_, sha) => objects.get(sha) } }),
  };
  return { opt, io, plans, refs, objects, commands, history };
}

test("source proof reconstructs a dynamic four-plan historical prefix with real validators", async () => {
  const f = await sourceFixture(), folder = await mkdtemp(join(tmpdir(), "rayrag-source-test-"));
  try {
    f.io.folder = folder; f.io.write = privateWriter(folder);
    const source = await verifySource(f.opt, f.io);
    assert.equal(source.proof.firstParentCount, 5);
    assert.equal(source.proof.historicalReservationCount, 4);
    assert.equal(source.proof.newerReservationsNotPolicyValidated, 1);
    assert.equal(source.proof.mainShaAtFetch, f.history[6]);
    assert.equal(source.proof.independentlyRegenerated, true);
    assert.equal(source.proof.predecessorPlanSha256, source.planner.planSha256(f.plans[2]));
    await source.confirmReservations();
    f.refs[0].object.sha = "e".repeat(40);
    await assert.rejects(source.confirmReservations(), /changed/);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test("source proof rejects missing main ancestry and changed historical reservation content", async () => {
  for (const mutate of [
    f => { f.opt.sourceSha = "d".repeat(40); },
    f => { f.objects.get(f.refs[1].object.sha).message = "{}\n"; },
    f => { f.objects.get(f.refs[2].object.sha).object.sha = f.history[6]; },
    f => { f.refs.push(f.refs[0]); },
  ]) {
    const f = await sourceFixture(), folder = await mkdtemp(join(tmpdir(), "rayrag-source-test-"));
    try {
      mutate(f); f.io.folder = folder; f.io.write = privateWriter(folder);
      await assert.rejects(verifySource(f.opt, f.io));
    } finally { await rm(folder, { recursive: true, force: true }); }
  }
});

test("Python ZIP boundary tests", () => {
  execFileSync(process.platform === "win32" ? "python" : "python3", [fileURLToPath(new URL("./release-public-zip-tests.py", import.meta.url))], {
    stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, PYTHONDONTWRITEBYTECODE: "1" }, timeout: 30_000,
  });
});


test("immutable source layout selection rejects missing, mixed, duplicate and foreign owners", () => {
  for (const [file, directory] of [["scripts/release-core.mjs", "scripts"], ["scripts/release/release-core.mjs", "scripts/release"]]) {
    assert.equal(sourceScriptDirectory(sourceSha, () => Buffer.from(file)), directory);
  }
  for (const files of ["", "scripts/release-core.mjs\nscripts/release/release-core.mjs", "scripts/release-core.mjs\nscripts/release-core.mjs", "scripts/foreign.mjs"])
    assert.throws(() => sourceScriptDirectory(sourceSha, () => Buffer.from(files)), /validator layout/);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  REPOSITORY, anonymousBytes, githubMetadata, privateWriter, privateEnvironment,
  createReportDirectory, downloadActionsZip, runReadOnly,
} from "./release-public-io.mjs";
import { parseOptions, releaseSnapshot, verifyPublishedRelease, publicationEvidence } from "./release-public.mjs";
import { peelTag, commitsBetween, verifySource } from "./release-public-source.mjs";
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

test("metadata uses exact read-only gh routes, a cache, and explicit fresh reads", async () => {
  const requests = [];
  const api = githubMetadata(REPOSITORY, (command, args) => {
    requests.push([command, args]); return Buffer.from(JSON.stringify({ count: requests.length }));
  });
  const route = "/git/matching-refs/tags/rayrag-release-plan/";
  assert.equal((await api(route)).count, 1);
  assert.equal((await api(route)).count, 1);
  assert.equal((await api(route, { fresh: true })).count, 2);
  assert.deepEqual(requests[0], ["gh", ["api", "--hostname", "github.com", "--method", "GET", `repos/${REPOSITORY}${route}`]]);
  await assert.rejects(api("/../../another-repo"), /path/);
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
    const env = privateEnvironment(folder, { PATH: "tools", GH_TOKEN: "synthetic", COOKIE: "synthetic", NODE_OPTIONS: "synthetic", GIT_CONFIG_COUNT: "1", TAURI_SIGNING_PRIVATE_KEY: "synthetic" });
    assert.equal(env.PATH, "tools");
    assert.equal(env.GH_TOKEN, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.GIT_CONFIG_COUNT, undefined);
    assert.equal(env.GIT_CONFIG_GLOBAL, join(folder, "empty-config"));
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

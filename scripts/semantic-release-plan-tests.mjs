import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import config, { canonicalJson } from "../release.config.mjs";
import {
  planRelease, validatePlan, serializePlan, planSha256,
  RELEASE_POLICY, RELEASE_POLICY_SHA256, RELEASE_ENGINE_VERSIONS,
  MAX_NOTES_BYTES,
  stableVersion, compareVersions, bumpVersion,
} from "./semantic-release-plan.mjs";

const sha = (n) => n.toString(16).padStart(40, "0");
const published = { sourceSha: sha(1), version: "0.2.63", tag: "v0.2.63" };
const source = { sourceSha: sha(3), firstParentCount: 64, pubDate: "2026-10-02T23:59:58.000Z" };
const commit = (message, n = 2) => ({ hash: sha(n), message });
const inputFor = (messages = ["fix: recover a stopped update"]) => {
  const commits = messages.map((message, i) => commit(message, i + 10));
  return { source: { ...source }, published: { ...published }, reservation: null,
    analysisCommits: commits, notesCommits: structuredClone(commits) };
};
async function planFor(messages) {
  const result = await planRelease(inputFor(messages));
  assert.equal(result.state, "release");
  return result.plan;
}

test("trusted policy uses only pinned pure plugins with a compatible current writer", async () => {
  const pkg = JSON.parse(await readFile(new URL("../tools/release/package.json", import.meta.url), "utf8"));
  const lock = JSON.parse(await readFile(new URL("../tools/release/package-lock.json", import.meta.url), "utf8"));
  for (const [name, version] of Object.entries(RELEASE_ENGINE_VERSIONS)) {
    assert.equal(name === "conventional-changelog-writer" ? pkg.overrides[name] : pkg.devDependencies[name], version);
    assert.equal(lock.packages[`node_modules/${name}`].version, version);
  }
  assert.deepEqual(config.plugins.map(([name]) => name), [
    "@semantic-release/commit-analyzer", "@semantic-release/release-notes-generator",
  ]);
  assert.equal(lock.packages["node_modules/semantic-release"], undefined);
  assert.equal(lock.packages["node_modules/@semantic-release/npm"], undefined);
  assert.equal(lock.packages["node_modules/@semantic-release/github"], undefined);
  const rootLock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
  assert.ok(!Object.keys(rootLock.packages).some((path) => /\/node_modules\/(?:braces|micromatch)$/.test(`/${path}`)));
  assert.equal(RELEASE_POLICY_SHA256, createHash("sha256").update(canonicalJson(RELEASE_POLICY) + "\n").digest("hex"));
  assert.ok(Object.isFrozen(RELEASE_POLICY.analyzer.releaseRules));
});

for (const [message, releaseType, version, note] of [
  ["fix: recover update", "patch", "0.2.64", "Bug Fixes"],
  ["perf: reduce bot polling", "patch", "0.2.64", "Performance Improvements"],
  ["feat: add macro conditions", "minor", "0.3.0", "Features"],
  ["feat!: replace settings schema", "major", "1.0.0", "BREAKING CHANGES"],
  ["fix: replace settings\n\nBREAKING CHANGE: profiles require migration", "major", "1.0.0", "profiles require migration"],
  ["chore(deps): update Tauri", "patch", "0.2.64", "Dependencies"],
  ["chore(deps-dev): update TypeScript", "patch", "0.2.64", "Dependencies"],
  ["build(deps): update runtime", "patch", "0.2.64", "Dependencies"],
  ["build(deps-dev): update bundler", "patch", "0.2.64", "Dependencies"],
  ["chore(deps)!: replace native API", "major", "1.0.0", "replace native API"],
  ["build(deps): replace library\n\nBREAKING CHANGE: old plugin API removed", "major", "1.0.0", "old plugin API removed"],
  ["docs!: change supported configuration", "major", "1.0.0", "change supported configuration"],
]) {
  test(`real engines: ${message.split("\n")[0]}`, async () => {
    const plan = await planFor([message]);
    assert.equal(plan.releaseType, releaseType);
    assert.equal(plan.version, version);
    assert.equal(plan.tag, `v${version}`);
    assert.ok(plan.notes.includes(note), plan.notes);
    assert.match(plan.notes, /\(2026-10-02\)/);
    assert.deepEqual(plan.analysisBase, published);
    assert.deepEqual(plan.notesBase, published);
    assert.equal(plan.predecessorPlanSha256, null);
  });
}

for (const messages of [
  [], ["docs: explain macros"], ["ci: speed builds"], ["ci(deps): update checkout"],
  ["chore: organize scripts"], ["build: clarify local command"],
  ["refactor: rename internal field"], ["test: cover updater"],
  ["docs: explain macros", "ci(deps): update actions"],
]) {
  test(`real analyzer skips ${messages.join(" + ") || "an empty range"}`, async () => {
    const result = await planRelease(inputFor(messages), {
      notesGenerator: () => { throw new Error("Skipped plans must not generate notes."); },
    });
    assert.deepEqual(result, { state: "skip", reason: "No releasable changes." });
  });
}

test("real analyzer uses the highest release type across introduced commits", async () => {
  const plan = await planFor(["fix: recover update", "feat: add macro conditions", "ci: speed builds"]);
  assert.equal(plan.version, "0.3.0");
  assert.match(plan.notes, /recover update/);
  assert.match(plan.notes, /add macro conditions/);
  assert.doesNotMatch(plan.notes, /speed builds/);
});

test("real analyzer filters a feature and its revert, and releases a standalone revert", async () => {
  const feature = commit("feat: add macro conditions", 20);
  const revert = commit(`revert: feat: add macro conditions\n\nThis reverts commit ${feature.hash}.`, 21);
  const input = inputFor();
  // The official engine expects Git log order: newest commit first.
  input.analysisCommits = [revert, feature];
  input.notesCommits = structuredClone(input.analysisCommits);
  assert.equal((await planRelease(input)).state, "skip");
  input.analysisCommits = [revert];
  input.notesCommits = [revert];
  const { plan } = await planRelease(input);
  assert.equal(plan.releaseType, "patch");
  assert.match(plan.notes, /Reverts/);
});

test("source date fixes real release notes regardless of wall clock or time zone", async () => {
  const input = inputFor();
  const before = structuredClone(input);
  const first = (await planRelease(input)).plan;
  await new Promise((resolve) => setTimeout(resolve, 15));
  const second = (await planRelease(input)).plan;
  assert.equal(serializePlan(first), serializePlan(second));
  assert.equal(planSha256(first), planSha256(second));
  assert.match(first.notes, /2026-10-02/);
  assert.deepEqual(input, before);
});

test("reservation advances the version while unpublished changes remain in release notes", async () => {
  const reservation = await planFor(["feat: add macro conditions"]);
  const input = inputFor(["fix: restore connection"]);
  input.source = { ...source, sourceSha: sha(4), firstParentCount: 65 };
  input.reservation = reservation;
  input.notesCommits.unshift(commit("feat: add macro conditions", 9));
  const { plan } = await planRelease(input);
  assert.equal(plan.version, "0.3.1");
  assert.deepEqual(plan.analysisBase, { sourceSha: source.sourceSha, version: "0.3.0", tag: "v0.3.0" });
  assert.deepEqual(plan.notesBase, published);
  assert.equal(plan.predecessorPlanSha256, planSha256(reservation));
  assert.match(plan.notes, /add macro conditions/);
  assert.match(plan.notes, /restore connection/);
  assert.match(plan.notes, /compare\/v0\.2\.63\.\.\.v0\.3\.1/);
});

test("planning rejects reordered, stale or mismatched reservation baselines", async () => {
  const reservation = await planFor();
  for (const badSource of [source, { ...source, firstParentCount: 63 }, { ...source, firstParentCount: 65 }]) {
    await assert.rejects(planRelease({ ...inputFor(), source: badSource, reservation }), /follow the reserved source/);
  }
  const input = { ...inputFor(), reservation, source: { ...source, sourceSha: sha(4), firstParentCount: 65 } };
  await assert.rejects(planRelease({ ...input, published: { ...published, version: "0.3.0", tag: "v0.3.0" } }), /precedes/);
  await assert.rejects(planRelease({ ...input, published: { ...published, version: "0.2.64", tag: "v0.2.64" } }), /different sources/);
});

test("canonical reservation bytes and hash survive parsed key reordering", async () => {
  const plan = await planFor();
  const reordered = Object.fromEntries(Object.entries(plan).reverse());
  reordered.analysisBase = Object.fromEntries(Object.entries(reordered.analysisBase).reverse());
  assert.equal(serializePlan(reordered), serializePlan(plan));
  assert.equal(planSha256(reordered), planSha256(plan));
  assert.ok(serializePlan(plan).endsWith("\n"));
  assert.equal(serializePlan(JSON.parse(serializePlan(plan))), serializePlan(plan));
});

test("plan validation rejects tampered identities, policy, increments and metadata injection", async () => {
  const valid = await planFor();
  const corruptions = [
    { extra: true }, { schemaVersion: 2 }, { repository: "other/repo" },
    { sourceSha: "A".repeat(40) }, { sourceSha: valid.analysisBase.sourceSha },
    { firstParentCount: 0 }, { firstParentCount: Number.MAX_SAFE_INTEGER + 1 },
    { pubDate: "2026-02-30T00:00:00.000Z" }, { pubDate: "2026-10-02T23:59:58Z" },
    { version: "v0.2.64" }, { version: "00.2.64" }, { version: "0.2.64+build" },
    { version: "0.2.64-rc.1" }, { version: "0.2.65", tag: "v0.2.65" },
    { tag: "v1.0.0" }, { releaseType: "prerelease" }, { releaseType: "minor" },
    { policyVersion: 2 }, { policySha256: "a".repeat(64) },
    { predecessorPlanSha256: "bad" },
    { analysisBase: { ...published, extra: true } },
    { notesBase: { ...published, sourceSha: sha(8) } },
    { notes: "" }, { notes: " \n" }, { notes: "bad\0notes" }, { notes: "bad\ud800notes" },
    { notes: "a".repeat(MAX_NOTES_BYTES + 1) },
    { notes: "<!-- rayrag-release:{} -->" }, { notes: "RAYRAG-RELEASE-PLAN:{}" },
  ];
  for (const corruption of corruptions) {
    assert.throws(() => validatePlan({ ...structuredClone(valid), ...corruption }), undefined,
      JSON.stringify(corruption).slice(0, 200));
  }
  assert.equal(validatePlan(valid), valid);
});

test("planner fails closed on malformed input or mismatched analysis and notes ranges", async () => {
  const mutations = [
    (input) => { input.extra = true; },
    (input) => { input.source.extra = true; },
    (input) => { input.source.pubDate = "not a date"; },
    (input) => { input.published.version = "0.2.63+build"; },
    (input) => { input.published.tag = "v0.2.62"; },
    (input) => { input.analysisCommits[0].hash = "bad"; },
    (input) => { input.analysisCommits[0].message = null; },
    (input) => { input.analysisCommits.push(input.analysisCommits[0]); },
    (input) => { input.analysisCommits[0].message = "a".repeat(64 * 1024 + 1); },
    (input) => { input.notesCommits = []; },
    (input) => { input.notesCommits[0].message = "fix: replaced message"; },
  ];
  for (const mutate of mutations) {
    const input = inputFor();
    mutate(input);
    await assert.rejects(planRelease(input, { analyzer: () => { throw new Error("Engine should not run."); } }),
      (error) => error.message !== "Engine should not run.");
  }
});

test("planner rejects unexpected plugin output before any plan can be reserved", async () => {
  await assert.rejects(planRelease(inputFor(), { analyzer: () => "prerelease" }), /analyzer release type/);
  await assert.rejects(planRelease(inputFor(), { notesGenerator: () => "<!-- rayrag-release:{} -->" }), /reserved provenance/);
  await assert.rejects(planRelease(inputFor(), { notesGenerator: () => "x".repeat(MAX_NOTES_BYTES + 1) }), /release notes/);
});

test("untrusted nested brace subjects stay strings; only trusted literal policy patterns are matched", async () => {
  const subject = `${"{".repeat(500)}unsafe${"}".repeat(500)}`;
  const plan = await planFor([`fix: ${subject}`]);
  assert.equal(plan.releaseType, "patch");
  assert.ok(plan.notes.includes(subject));
  for (const rule of RELEASE_POLICY.analyzer.releaseRules) {
    for (const key of ["type", "scope"]) if (rule[key]) assert.match(rule[key], /^[a-z-]+$/);
  }
});

test("official engines never call vulnerable braces walkers and use only trusted matcher patterns", () => {
  // Run before any plugin imports so even captured CommonJS exports are trapped.
  const script = `
    import assert from 'node:assert/strict';
    import { createRequire } from 'node:module';
    const require = createRequire(new URL('./tools/release/package.json', import.meta.url));
    const bracesPath = require.resolve('braces');
    const braces = require(bracesPath);
    let calls = 0;
    const trap = () => { calls++; throw new Error('Vulnerable braces walker was called.'); };
    require.cache[bracesPath].exports = new Proxy(braces, {
      apply: trap,
      get: (value, property) => typeof value[property] === 'function' ? trap : value[property],
    });
    const matcher = require('micromatch');
    const original = matcher.isMatch;
    const patterns = new Set();
    matcher.isMatch = (value, pattern, ...args) => {
      patterns.add(pattern);
      return original(value, pattern, ...args);
    };
    const {planRelease, RELEASE_POLICY} = await import('./scripts/semantic-release-plan.mjs');
    // This depth actually exhausts braces@3.0.3 when used as a pattern.
    const nested = '{'.repeat(4900) + 'payload' + '}'.repeat(4900);
    const messages = [
      'fix(' + nested + '): ' + nested + '\\n\\n' + nested,
      'docs: nonrelease ' + nested,
      'chore(' + nested + '): unmatched custom scope',
      'revert: fix: prior change\\n\\nThis reverts commit ' + 'c'.repeat(40) + '.',
      'chore(deps): upgrade library\\n\\nBREAKING CHANGE: ' + nested,
    ];
    const commits = messages.map((message, i) => ({hash: String(i+10).padStart(40, '0'), message}));
    const result = await planRelease({
      source: {sourceSha:'a'.repeat(40), firstParentCount:64, pubDate:'2026-10-02T00:00:00.000Z'},
      published: {sourceSha:'b'.repeat(40), version:'0.2.63', tag:'v0.2.63'},
      reservation:null, analysisCommits:commits, notesCommits:commits,
    });
    assert.equal(result.plan.releaseType, 'major');
    assert.ok(result.plan.notes.includes(nested));
    const allowed = new Set(RELEASE_POLICY.analyzer.releaseRules.flatMap(rule => [rule.type,rule.scope]).filter(Boolean));
    // Official fallback rules are constants too; no commit content supplies a glob.
    for (const pattern of [':racehorse:',':bug:',':penguin:',':apple:',':checkered_flag:',
      'BUGFIX','FEATURE','SECURITY','Breaking','Fix','Update','New','perf','deps','FEAT','FIX']) allowed.add(pattern);
    for (const pattern of patterns) assert.ok(allowed.has(pattern), 'Untrusted glob: ' + pattern);
    assert.ok(patterns.size > 0);
    assert.equal(calls, 0);
  `;
  execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    cwd: fileURLToPath(new URL("../", import.meta.url)), stdio: "pipe", timeout: 60_000,
  });
});

test("shared SemVer boundary rejects unstable, noncanonical and unsafe numeric versions", () => {
  assert.equal(stableVersion("0.0.0"), "0.0.0");
  assert.equal(compareVersions("0.3.0", "0.2.100"), 1);
  assert.equal(compareVersions("1.0.0", "1.0.0"), 0);
  assert.equal(compareVersions("1.0.9", "1.1.0"), -1);
  assert.equal(bumpVersion("0.2.63", "minor"), "0.3.0");
  assert.equal(bumpVersion("0.2.63", "major"), "1.0.0");
  for (const value of ["v1.0.0", "01.0.0", "1.0.0-beta", "1.0.0+build", "9007199254740992.0.0", null]) {
    assert.throws(() => stableVersion(value), /stable release version/);
    assert.throws(() => compareVersions("1.0.0", value), /stable release version/);
    assert.throws(() => bumpVersion(value, "patch"), /stable release version/);
  }
  assert.throws(() => bumpVersion("1.0.0", "preminor"), /release type/);
  assert.throws(() => bumpVersion("9007199254740991.0.0", "major"), /stable release version/);
});

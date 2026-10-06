import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { createVerificationPlan, createInvocation } from './check-policy.mjs';
import { bridgeBuildOptions } from './build-bridge-policy.mjs';
import { buildBridge } from './build-bridge.mjs';
import { VERSION_PATHS, versionContents, validateUpdaterConfig, tagResponseBytes, annotatedTag } from './release-source-policy.mjs';
import { stampVersions } from './release.mjs';
import { ENDPOINT, IDENTIFIER, isNewer } from './release-policy.mjs';
import { packageBuildArgs } from './ci-platform-policy.mjs';
import { createRunSnapshot } from './hosted-status-policy.mjs';
import { median, rendererOptions, compareRenderingReports, packetReport, validatePacketReport } from './benchmark-policy.mjs';
import { sourceModuleFiles } from './release-public-source.mjs';
import { responsiveFixtureBuildOptions } from './responsive-fixture-policy.mjs';

const run = promisify(execFile);
const sourceValues = () => [
  JSON.stringify({ name: 'rayrag-companion', version: '0.1.0', dependencies: { retained: '9.0.0' } }),
  '[package]\nname = "rayrag-companion"\nversion = "0.1.0"\n[dependencies]\nretained = "9.0.0"\n',
  'version = 4\n\n[[package]]\nname = "rayrag-companion"\nversion = "0.1.0"\n\n[[package]]\nname = "retained"\nversion = "9.0.0"\n',
  JSON.stringify({ version: '0.1.0', identifier: IDENTIFIER }),
];

test('source checks are deterministic from supplied platform and script names', () => {
  const names = ['z-tests.mjs', 'README.md', 'a-tests.mjs'];
  const original = [...names];
  const plan = createVerificationPlan('linux', names);
  assert.deepEqual(plan.find(step => step.report === 'scripts.log').args, ['test', '--timeout', '120000', './scripts/a-tests.mjs', './scripts/z-tests.mjs']);
  assert.deepEqual(names, original);
  assert.deepEqual(createVerificationPlan('linux', names), plan);
  assert.throws(() => createVerificationPlan('freebsd', names), /Unsupported/);
  assert.throws(() => createVerificationPlan('darwin', ['README.md']), /No script tests/);
  assert.deepEqual(createInvocation({ tool: 'bun', args: ['test'] }, 'win32', 'C:\\bun.exe'), { file: 'C:\\bun.exe', args: ['test'] });
});

test('bridge build wires fresh pure options into one effect and propagates failure', async () => {
  const options = bridgeBuildOptions();
  assert.equal(options.target, 'safari16');
  assert.equal(options.outfile, 'src-tauri/generated/game-bridge.js');
  options.entryPoints.push('discarded.ts');
  let calls = 0;
  const result = await buildBridge(async config => {
    calls++;
    assert.deepEqual(config.entryPoints, ['src/bridge.ts']);
    return { built: true };
  });
  assert.deepEqual(result, { built: true });
  assert.equal(calls, 1);
  await assert.rejects(buildBridge(async () => { throw new Error('controlled build failure'); }), /controlled build failure/);
});

test('source version transform is idempotent, leaves inputs/dependencies intact and rejects all mismatched sources', () => {
  const values = sourceValues(), before = [...values];
  const updated = versionContents(values, '0.2.7');
  assert.deepEqual(values, before);
  assert.equal(JSON.parse(updated[0]).version, '0.2.7');
  assert.equal(JSON.parse(updated[3]).version, '0.2.7');
  assert.equal(JSON.parse(updated[0]).dependencies.retained, '9.0.0');
  assert.match(updated[1], /retained = "9.0.0"/);
  assert.match(updated[2], /name = "retained"\nversion = "9.0.0"/);
  assert.deepEqual(versionContents(updated, '0.2.7'), updated);
  assert.throws(() => versionContents(values, '0.2.7-beta'), /stable release version/);
  for (const index of [1, 2, 3]) {
    const invalid = [...values];
    invalid[index] = invalid[index].replace('0.1.0', '0.1.1');
    assert.throws(() => versionContents(invalid, '0.2.7'), /inconsistent|differs/);
  }
  const duplicate = [...values];
  duplicate[2] += '\n[[package]]\nname = "rayrag-companion"\nversion = "0.1.0"\n';
  assert.throws(() => versionContents(duplicate, '0.2.7'), /one root package/);
});

test('invalid version content fails before any source file write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayrag-source-policy-'));
  try {
    await mkdir(join(root, 'src-tauri'));
    const values = sourceValues();
    values[2] = values[2].replace('version = "0.1.0"', 'version = "0.1.1"');
    await Promise.all(VERSION_PATHS.map((path, i) => writeFile(join(root, path), values[i])));
    await assert.rejects(stampVersions(root, '0.2.7'), /Cargo lock version differs/);
    const after = await Promise.all(VERSION_PATHS.map(path => readFile(join(root, path), 'utf8')));
    assert.deepEqual(after, values);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('annotated tag parsing rejects truncated responses and duplicate headers while retaining exact message bytes', () => {
  const sha = 'a'.repeat(40), sourceSha = 'b'.repeat(40);
  const bytes = Buffer.from(`object ${sourceSha}\ntype commit\ntag rayrag-release-plan/v0.3.0\ntagger CI <ci@example.invalid> 1 +0000\n\n{"frozen":true}\n`);
  const reply = Buffer.concat([Buffer.from(`${sha} tag ${bytes.length}\n`), bytes, Buffer.from('\n')]);
  assert.deepEqual(tagResponseBytes(sha, reply), bytes);
  assert.equal(tagResponseBytes(sha, Buffer.from(`${sha} missing\n`)), null);
  assert.throws(() => tagResponseBytes(sha, reply.subarray(0, -1)), /size/);
  assert.throws(() => tagResponseBytes(sha, Buffer.from(`${sha} blob 1\nx\n`)), /annotated Git tag/);
  assert.deepEqual(annotatedTag(sha, bytes), { sha, tag: 'rayrag-release-plan/v0.3.0', message: '{"frozen":true}\n', object: { type: 'commit', sha: sourceSha } });
  assert.throws(() => annotatedTag(sha, Buffer.from(`object ${sourceSha}\nobject ${sourceSha}\n\nmessage`)), /headers/);
});

test('updater config, source ordering and package arguments remain pure guarded contracts', () => {
  const config = { identifier: IDENTIFIER, bundle: { createUpdaterArtifacts: true }, plugins: { updater: { pubkey: 'synthetic-public-key-long-enough', endpoints: [ENDPOINT], requireSignedVersion: true } } };
  assert.equal(validateUpdaterConfig(config), config);
  assert.throws(() => validateUpdaterConfig({ ...config, plugins: { updater: { ...config.plugins.updater, requireSignedVersion: false } } }), /contract differs/);
  assert.equal(isNewer({ version: '0.3.1', firstParentCount: 12 }, { version: '0.3.0', count: 11 }), true);
  assert.throws(() => isNewer({ version: '0.2.1', firstParentCount: 12 }, { version: '0.3.0', count: 11 }), /order conflict/);
  const smoke = packageBuildArgs('linux', true), release = packageBuildArgs('linux', false);
  assert.deepEqual(smoke.slice(-4), ['--features', 'ci-smoke', '--', '--locked']);
  assert.equal(release.includes('--features'), false);
  assert.equal(JSON.parse(release[release.indexOf('--config') + 1]).bundle.createUpdaterArtifacts, false);
  assert.throws(() => packageBuildArgs('unknown', false), /Unsupported/);
});

test('hosted snapshot sorting preserves supplied job records', () => {
  const jobs = [{ id: '10' }, { id: '2' }], original = structuredClone(jobs);
  const state = createRunSnapshot('1', { head_sha: 'a'.repeat(40), run_attempt: 1, status: 'completed' }, jobs, 2);
  assert.deepEqual(state.jobs.map(job => job.id), ['2', '10']);
  assert.deepEqual(jobs, original);
  assert.throws(() => createRunSnapshot('1', {}, [jobs[0], jobs[0]], 2), /duplicate/);
});

test('benchmark report policies compare outcomes and reject mismatched workloads without browser effects', () => {
  const inputs = [9, 1, 5];
  assert.equal(median(inputs), 5);
  assert.deepEqual(inputs, [9, 1, 5]);
  assert.deepEqual(rendererOptions([]), { options: new Map(), samples: 5, iterations: 100 });
  for (const args of [['--samples', '0'], ['--iterations', '1.5'], ['--chrome'], ['--unknown', 'x']]) assert.throws(() => rendererOptions(args));
  const baseline = { schemaVersion: 2, harness: { hash: 'same' }, machine: {}, methodology: { samples: 3, iterations: 10 }, workload: ['render'], scenarios: [{ name: 'render', medianElapsedMs: 4, medianRendererTaskMs: 6, samples: [{ outcome: { html: 'same' } }] }] };
  const candidate = structuredClone(baseline);
  candidate.methodology.samples = 5;
  candidate.scenarios[0].medianElapsedMs = 2;
  assert.deepEqual(compareRenderingReports(candidate, baseline), [{ name: 'render', elapsedRatio: 0.5, rendererTaskRatio: 1, sameVisibleOutcome: true }]);
  candidate.scenarios[0].samples[0].outcome.html = 'changed';
  assert.throws(() => compareRenderingReports(candidate, baseline), /Visible outcome differs/);
  assert.throws(() => compareRenderingReports({ ...baseline, workload: ['different'] }, baseline), /same harness/);
  const counts = { frames: 2, gameClient: { counts: { general: 2, world: 2 }, snapshot: { state: 'same' }, writes: [[1]] }, botOnly: { counts: { general: 2, world: 2 }, snapshot: { state: 'same' }, writes: [[1]] } };
  const times = { gameClient: { medianMs: 1, samplesMs: [1] }, botOnly: { medianMs: 1, samplesMs: [1] } };
  const report = packetReport('baseline', counts, counts, times, times);
  assert.doesNotThrow(() => validatePacketReport(report));
  report.modes.botOnly.worldDecodes.after++;
  assert.throws(() => validatePacketReport(report), /decoded more than once/);
});

test('anonymous source module discovery supports old releases and bounds new validator dependencies', () => {
  const sha = 'a'.repeat(40);
  assert.deepEqual(sourceModuleFiles(sha, () => Buffer.alloc(0)), []);
  const files = ['scripts/release-policy.mjs', 'scripts/release-publication.mjs', 'scripts/release-source-policy.mjs', 'scripts/release-reservation-policy.mjs'];
  assert.deepEqual(sourceModuleFiles(sha, args => {
    assert.deepEqual(args.slice(0, 4), ['ls-tree', '--name-only', sha, '--']);
    for (const name of files) assert.ok(args.slice(4).includes(name));
    return Buffer.from(files.join('\n') + '\n');
  }), files);
  for (const text of ['scripts/foreign.mjs', 'scripts/release-policy.mjs\nscripts/release-policy.mjs']) assert.throws(() => sourceModuleFiles(sha, () => Buffer.from(text)), /Unexpected/);
});

test('fixture configuration uses supplied directories and creates no output by itself', () => {
  const config = responsiveFixtureBuildOptions('/project', '/output');
  assert.equal(config.stdin.resolveDir, '/project');
  assert.equal(config.outfile, '/output/fixture.js');
  assert.equal(config.write, false);
  assert.equal(config.target, 'safari16');
  assert.match(config.stdin.contents, /Offline route planning/);
});

test('importing tooling entrypoints launches no commands, prints no output and needs no CLI arguments', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-tooling-import-'));
  try {
    const names = ['build-bridge', 'build-responsive-fixture', 'check', 'ci-platform', 'dependabot-auto-merge', 'hosted-status', 'native-smoke', 'release', 'release-public', 'benchmark-client-rendering', 'benchmark-packet-processing', 'benchmark-routing', 'benchmark-map-policy', 'benchmark-responsive-routing', 'benchmark-weighted-routing', 'test-weighted-routing-oracle'];
    const urls = names.map(name => new URL(`./${name}.mjs`, import.meta.url).href);
    const result = await run(process.execPath, ['--eval', `for (const url of ${JSON.stringify(urls)}) await import(url);`], { cwd: folder, timeout: 30_000 });
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  } finally { await rm(folder, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sourceCommitSha, gitTagObjectSha, fileDigest, planDigest, policyDigest,
  artifactDigest, workflowRunId, workflowJobId, actionsArtifactId,
  pullRequestNumber, workflowAttempt, workflowAttemptText, firstParentCount,
  stableReleaseVersion, releaseTagFor, releaseId, publicReleaseValues, smokeResultValues,
} from './tooling-domain-values.mjs';
import { parsePlan, validatePlan, serializePlan, planSha256 } from '../release/semantic-release-policy.mjs';
import { planRelease } from '../release/semantic-release-plan.mjs';
import { validateBundle } from '../release/release-policy.mjs';
import { parseOptions } from '../release/release-public-policy.mjs';
import { validateRun, parseHostedRun } from '../quality/hosted-status-policy.mjs';
import { validateResult } from '../quality/native-smoke-policy.mjs';

const sha = '1'.repeat(40), hash = '2'.repeat(64);
const input = () => ({
  source: {sourceSha: '3'.repeat(40), firstParentCount: 64, pubDate: '2026-10-02T23:59:58.000Z'},
  published: {sourceSha: sha, version: '0.2.63', tag: 'v0.2.63'},
  reservation: null,
  analysisCommits: [{hash: '4'.repeat(40), message: 'fix: recover update'}],
  notesCommits: [{hash: '4'.repeat(40), message: 'fix: recover update'}],
});
const engines = {analyzer: async () => 'patch', notesGenerator: async () => 'Release notes.'};

test('domain constructors retain exact wire primitives and separate formats', () => {
  assert.equal(sourceCommitSha(sha), sha);
  assert.equal(gitTagObjectSha(sha), sha);
  for (const constructor of [fileDigest, planDigest, policyDigest]) {
    assert.equal(constructor(hash), hash);
    assert.throws(() => constructor(`sha256:${hash}`));
  }
  assert.equal(artifactDigest(`sha256:${hash}`), `sha256:${hash}`);
  assert.throws(() => artifactDigest(hash), /Invalid artifact digest/);
  for (const constructor of [workflowRunId, workflowJobId, actionsArtifactId, pullRequestNumber, workflowAttemptText]) {
    assert.equal(constructor(123), '123');
    for (const bad of ['0', '01', '-1', '1.5', undefined]) assert.throws(() => constructor(bad));
  }
  assert.equal(workflowAttempt(2), 2);
  assert.equal(firstParentCount(64), 64);
  assert.equal(releaseId(9), 9);
  for (const constructor of [workflowAttempt, firstParentCount, releaseId]) {
    for (const bad of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, '2']) assert.throws(() => constructor(bad));
  }
  assert.equal(JSON.stringify({sha: sourceCommitSha(sha), digest: artifactDigest(`sha256:${hash}`), run: workflowRunId(123), tag: releaseTagFor(stableReleaseVersion('1.2.3'))}),
    `{"sha":"${sha}","digest":"sha256:${hash}","run":"123","tag":"v1.2.3"}`);
});

test('plan admission detaches nested lineage while compatibility validation keeps identity', async () => {
  const {plan} = await planRelease(input(), engines);
  const raw = structuredClone(plan);
  assert.equal(validatePlan(raw), raw);
  const admitted = parsePlan(raw), bytes = serializePlan(admitted), digest = planSha256(admitted);
  raw.analysisBase.version = '9.9.9';
  raw.notesBase.sourceSha = '9'.repeat(40);
  raw.notes = 'changed after admission';
  assert.equal(serializePlan(admitted), bytes);
  assert.equal(planSha256(admitted), digest);
  assert.notEqual(admitted.analysisBase, raw.analysisBase);
  assert.notEqual(admitted.notesBase, raw.notesBase);
  assert.equal(Object.isFrozen(raw), false);
});

test('planner owns source, lineage and commit arrays before awaiting the analyzer', async () => {
  const raw = input(), expected = structuredClone(raw);
  let resume;
  const suspended = new Promise(done => { resume = done; });
  let entered;
  const analyzing = new Promise(done => { entered = done; });
  const pending = planRelease(raw, {
    async analyzer(_config, context) {
      assert.deepEqual(context.commits, expected.analysisCommits);
      entered();
      await suspended;
      return 'patch';
    },
    async notesGenerator(_config, context) {
      assert.deepEqual(context.commits, expected.notesCommits);
      assert.equal(context.lastRelease.gitHead, expected.published.sourceSha);
      assert.equal(context.nextRelease.gitHead, expected.source.sourceSha);
      return 'Release notes.';
    },
  });
  await analyzing;
  raw.source.sourceSha = '8'.repeat(40);
  raw.published.version = '9.9.9';
  raw.notesCommits[0].message = 'feat!: tamper with future notes';
  raw.analysisCommits.push({hash: '5'.repeat(40), message: 'feat: mutate caller array'});
  resume();
  const result = await pending;
  assert.equal(result.state, 'release');
  assert.equal(result.plan.sourceSha, expected.source.sourceSha);
  assert.equal(result.plan.analysisBase.version, expected.published.version);
  assert.equal(result.plan.version, '0.2.64');
  assert.equal(Object.isFrozen(raw), false);
});

test('public release admission owns nested assets without freezing the API DTO', () => {
  const raw = {id: 9, tag_name: 'v1.2.3', body: 'marker', draft: false, prerelease: false,
    assets: [{id: 1, name: 'bundle.zip', state: 'uploaded', size: 2}]};
  const admitted = publicReleaseValues(raw);
  raw.assets[0].name = 'changed.zip';
  raw.assets.push({id: 2, name: 'extra.zip', state: 'uploaded', size: 1});
  assert.deepEqual(admitted.assets, [{id: 1, name: 'bundle.zip', state: 'uploaded', size: 2}]);
  assert.equal(Object.isFrozen(raw.assets), false);
});

test('hosted admission owns metadata while the validation facade retains its void result', () => {
  const raw = {id: 123, head_sha: sha, status: 'in_progress', run_attempt: 2, conclusion: null};
  assert.equal(validateRun(workflowRunId(123), raw, sourceCommitSha(sha)), undefined);
  const admitted = parseHostedRun(workflowRunId(123), raw, sourceCommitSha(sha));
  raw.head_sha = '9'.repeat(40);
  raw.run_attempt = 3;
  assert.equal(admitted.head_sha, sha);
  assert.equal(admitted.run_attempt, 2);
  assert.equal(Object.isFrozen(raw), false);
});

test('smoke admission owns nested settings while validation retains document identity', () => {
  const raw = {protocol: 1, stage: 'save', token: 'test-token', passed: true,
    checks: ['webview-boot', 'offline-controller', 'native-settings-ipc', 'window-close-save'],
    document: {version: 1, revision: 1, selectedProfileId: null, settings: {radius: 17, loot: false, route_step: 7}}};
  assert.equal(validateResult(raw, 'save', raw.token), raw.document);
  const admitted = smokeResultValues(raw);
  raw.document.settings.radius = 99;
  raw.checks.length = 0;
  assert.equal(admitted.document.settings.radius, 17);
  assert.equal(admitted.checks.length, 4);
  assert.equal(Object.isFrozen(raw.document.settings), false);
});

test('ordered owner validation retains the first failure across simultaneous invalid values', async () => {
  const raw = input();
  raw.source.sourceSha = 'bad'; raw.source.firstParentCount = 0;
  raw.published.version = 'not-a-version';
  await assert.rejects(planRelease(raw, engines), /Invalid source SHA\./);
  assert.throws(() => parseOptions(['--source', 'bad', '--tag', 'bad', '--run-id', '0']), /Expected a full lowercase source SHA\./);
  assert.throws(() => parseOptions(['--source', sha, '--tag', 'bad', '--run-id', '0']), /Expected a canonical stable release tag\./);
});


test('missing provenance retains its ordered bundle-admission diagnostic', () => {
  const id = {sourceSha: sourceCommitSha(sha), version: stableReleaseVersion('0.2.64'), tag: releaseTagFor(stableReleaseVersion('0.2.64')), pubDate: 'date'};
  assert.throws(() => validateBundle(new Map(), id, ''), {message: 'Invalid provenance size.'});
});

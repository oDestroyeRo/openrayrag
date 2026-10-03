import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runStage, validateResult, verifyReopened } from './native-smoke.mjs';

const token = '00000000-0000-4000-8000-000000000001';
const result = () => ({
  protocol: 1, stage: 'save', token, passed: true,
  checks: ['webview-boot', 'offline-controller', 'native-settings-ipc', 'window-close-save'],
  document: { version: 1, revision: 2, selectedProfileId: null, settings: { radius: 17, loot: false, route_step: 7 } },
});

test('a passing exit is insufficient without all packaged assertions and current settings', () => {
  assert.doesNotThrow(() => validateResult(result(), 'save', token));
  for (const mutate of [
    r => { r.token = 'another-run'; }, r => { r.stage = 'reopen'; },
    r => { r.passed = false; }, r => { r.checks.pop(); },
    r => { r.document.settings.radius = 12; }, r => { r.document.password = 'synthetic'; },
  ]) {
    const invalid = result(); mutate(invalid);
    assert.throws(() => validateResult(invalid, 'save', token));
  }
});

test('reopening may confirm a new revision but must preserve every saved setting', () => {
  const saved = result().document;
  const reopened = structuredClone(saved); reopened.revision++;
  assert.doesNotThrow(() => verifyReopened(saved, reopened));
  reopened.settings.route_step = 10;
  assert.throws(() => verifyReopened(saved, reopened));
  const stale = structuredClone(saved); stale.revision--;
  assert.throws(() => verifyReopened(saved, stale));
  const incomplete = result(); incomplete.stage = 'reopen';
  assert.throws(() => validateResult(incomplete, 'reopen', token));
});

test('runner requires the child result and bounds a stuck native process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayrag-smoke-runner-test-'));
  const data = join(root, 'data'); await mkdir(data);
  const fixture = join(root, 'fixture.mjs'), output = join(root, 'result.json');
  try {
    await writeFile(fixture, "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.RAYRAG_CI_RESULT, process.env.FIXTURE_RESULT);\n");
    const options = { root, data, result: output, token, prefixArgs: [fixture], env: { ...process.env, FIXTURE_RESULT: JSON.stringify(result()) } };
    assert.equal((await runStage(process.execPath, 'save', options)).passed, true);
    await rm(output);
    await writeFile(fixture, 'process.exit(0);\n');
    await assert.rejects(runStage(process.execPath, 'save', options), /ENOENT/);
    await writeFile(fixture, 'setInterval(() => {}, 1000);\n');
    await assert.rejects(runStage(process.execPath, 'save', { ...options, timeoutMs: 80 }), /timed out/);
    await writeFile(fixture, 'process.exit(9);\n');
    await assert.rejects(runStage(process.execPath, 'save', options), /exited with 9/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { readApi, snapshot, saveFailedLog, parseOptions, watchRun } from './hosted-status.mjs';

const sha = 'a'.repeat(40);
const run = { id: 123, head_sha: sha, run_attempt: 2, status: 'in_progress', conclusion: null };
const failure = { id: 456, name: 'Platform / macos', status: 'completed', conclusion: 'failure' };
const read = async path => path.endsWith('/123') ? run : { total_count: 1, jobs: [failure] };

test('colored logs use the binary CLI wire contract and are never decoded into console output', async () => {
  const raw = Buffer.from('\u001b[31mcontrolled log\u001b[0m');
  const result = await readApi('actions/jobs/456/logs', true, async (file, args, options) => {
    assert.equal(file, 'gh');
    assert.deepEqual(args, ['api', '--hostname', 'github.com', 'repos/oDestroyeRo/openrayrag/actions/jobs/456/logs', '--allow-escape-sequences']);
    assert.equal(options.encoding, 'buffer');
    assert.equal(options.maxBuffer, 16 * 1024 * 1024);
    return { stdout: raw };
  });
  assert.equal(result, raw);
});

test('snapshots pin the run attempt and source and retain only compact job fields', async () => {
  const calls = [];
  const state = await snapshot('123', async path => { calls.push(path); return read(path); }, sha);
  assert.deepEqual(calls, ['actions/runs/123', 'actions/runs/123/attempts/2/jobs?per_page=100&page=1']);
  assert.equal(state.sourceSha, sha);
  assert.deepEqual(state.jobs, [{ ...failure, id: '456' }]);
  await assert.rejects(snapshot('123', read, 'b'.repeat(40)), /source differs/);
});

test('pagination rejects duplicate, incomplete and changing job listings', async () => {
  await assert.rejects(snapshot('123', async path => path.endsWith('/123') ? run : { total_count: 2, jobs: [failure, failure] }), /duplicate/);
  await assert.rejects(snapshot('123', async path => path.endsWith('/123') ? run : { total_count: 2, jobs: [failure] }), /Incomplete/);
  const jobs = Array.from({ length: 100 }, (_, i) => ({ ...failure, id: i + 1 }));
  await assert.rejects(snapshot('123', async path => path.endsWith('/123') ? run : { total_count: path.endsWith('page=1') ? 101 : 102, jobs }), /changed/);
});

test('a completed failed job log is privately accessible while the run is still in progress', async () => {
  const state = await snapshot('123', read);
  const calls = [];
  const result = await saveFailedLog(state, '456', async (path, binary) => { calls.push([path, binary]); return Buffer.from('controlled log'); });
  try {
    assert.deepEqual(calls, [['actions/jobs/456/logs', true]]);
    assert.equal(await readFile(result.path, 'utf8'), 'controlled log');
    if (process.platform !== 'win32') {
      assert.equal((await stat(dirname(result.path))).mode & 0o777, 0o700);
      assert.equal((await stat(result.path)).mode & 0o777, 0o600);
    }
  } finally { await rm(dirname(result.path), { recursive: true, force: true }); }
  await assert.rejects(saveFailedLog(state, '999', read), /completed failing job/);
});

test('one watch prints only changed states and ends when the run completes', async () => {
  let iteration = 0;
  const output = [], delays = [];
  const state = await watchRun({ runId: '123', watch: true }, {
    read: async path => path.endsWith('/123') ? { ...run, ...(iteration++ >= 2 ? { status: 'completed', conclusion: 'success' } : {}) } : { total_count: 1, jobs: [failure] },
    output: text => output.push(JSON.parse(text)), wait: async ms => delays.push(ms),
  });
  assert.equal(output.length, 2);
  assert.deepEqual(delays, [45_000, 45_000]);
  assert.equal(state.conclusion, 'success');
});

test('CLI options reject arbitrary API paths, ambiguous modes and invalid source identities', () => {
  assert.deepEqual(parseOptions(['--help']), { help: true });
  assert.deepEqual(parseOptions(['123', '--sha', sha, '--watch']), { runId: '123', expectedSha: sha, watch: true });
  for (const args of [[], ['../logs'], ['123', '--sha', 'a'], ['123', '--watch', '--failed-log', '456'], ['123', '--failed-log'], ['123', '--watch', '--watch']]) assert.throws(() => parseOptions(args));
});

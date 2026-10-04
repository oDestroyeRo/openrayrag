import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { mergeDependabotUpdate } from './dependabot-auto-merge.mjs';

const repo = 'oDestroyeRo/openrayrag';
const root = `/repos/${repo}`;
const head = 'a'.repeat(40), merge = 'b'.repeat(40);

function fixture() {
  const run = {
    repository: { id: 1, full_name: repo }, head_repository: { full_name: repo },
    path: '.github/workflows/release.yml', event: 'pull_request', status: 'completed',
    conclusion: 'success', head_sha: head,
    pull_requests: [{ number: 7, base: { ref: 'main', repo: { id: 1 } }, head: { sha: head, repo: { id: 1 } } }],
  };
  const pr = {
    user: { login: 'dependabot[bot]', type: 'Bot' },
    base: { ref: 'main', repo: { full_name: repo } },
    head: { sha: head, ref: 'dependabot/cargo/example-2.0.0', repo: { full_name: repo } },
    state: 'open', draft: false, merged: false, mergeable: true, mergeable_state: 'clean',
  };
  const jobs = { jobs: [{ name: 'CI / required', status: 'completed', conclusion: 'success' }] };
  const commit = { parents: [{ sha: 'c'.repeat(40) }, { sha: head }] };
  const calls = [];
  const request = async (method, path, body) => {
    calls.push({ method, path, body });
    if (path === `${root}/actions/runs/9`) return run;
    if (path === `${root}/commits/${head}/pulls?per_page=100`) return [];
    if (path === `${root}/pulls/7`) return pr;
    if (path === `${root}/actions/runs/9/jobs?filter=latest&per_page=100`) return jobs;
    if (path === `${root}/pulls/7/merge`) return { merged: true, sha: merge };
    if (path === `${root}/commits/${merge}`) return commit;
    if (path === `${root}/actions/workflows/release.yml/dispatches`) return undefined;
    throw new Error(`Unexpected request: ${method} ${path}`);
  };
  return { run, pr, jobs, commit, calls, request };
}
const writes = f => f.calls.filter(call => call.method !== 'GET');

test('successful Dependabot updates use a protected exact-head merge commit then explicitly release main', async () => {
  const f = fixture();
  const result = await mergeDependabotUpdate({ request: f.request, runId: 9 });
  assert.deepEqual(result, { outcome: 'release-dispatched', number: 7, runId: 9, headSha: head, mergeSha: merge });
  assert.deepEqual(writes(f), [
    { method: 'PUT', path: `${root}/pulls/7/merge`, body: {
      sha: head, merge_method: 'merge', commit_title: 'chore(deps): merge Dependabot PR #7',
    } },
    { method: 'POST', path: `${root}/actions/workflows/release.yml/dispatches`, body: { ref: 'main' } },
  ]);
});

test('unrelated, failed, stale, fork, human, draft and protected PRs never write', async t => {
  const cases = {
    'wrong repository': f => { f.run.repository.full_name = 'other/repo'; },
    'fork run': f => { f.run.head_repository.full_name = 'other/repo'; },
    'wrong workflow': f => { f.run.path = '.github/workflows/other.yml'; },
    'push run': f => { f.run.event = 'push'; },
    'incomplete run': f => { f.run.status = 'in_progress'; },
    'failed run': f => { f.run.conclusion = 'failure'; },
    'cancelled run': f => { f.run.conclusion = 'cancelled'; },
    'skipped run': f => { f.run.conclusion = 'skipped'; },
    'missing PR': f => { f.run.pull_requests = []; },
    'ambiguous PR': f => { f.run.pull_requests.push(f.run.pull_requests[0]); },
    'unmatched head': f => { f.run.pull_requests[0].head.sha = merge; },
    'human author': f => { f.pr.user.login = 'maintainer'; },
    'spoofed bot name': f => { f.pr.user.type = 'User'; },
    'other base': f => { f.pr.base.ref = 'develop'; },
    'fork PR': f => { f.pr.head.repo.full_name = 'other/repo'; },
    'wrong branch': f => { f.pr.head.ref = 'feature/update'; },
    'changed head': f => { f.pr.head.sha = merge; },
    'draft': f => { f.pr.draft = true; },
    'closed unmerged': f => { f.pr.state = 'closed'; },
    'missing gate': f => { f.jobs.jobs = []; },
    'duplicate gate': f => { f.jobs.jobs.push(f.jobs.jobs[0]); },
    'pending gate': f => { f.jobs.jobs[0].status = 'in_progress'; },
    'failed gate': f => { f.jobs.jobs[0].conclusion = 'failure'; },
    'neutral gate': f => { f.jobs.jobs[0].conclusion = 'neutral'; },
    'skipped gate': f => { f.jobs.jobs[0].conclusion = 'skipped'; },
    'conflict': f => { f.pr.mergeable = false; },
    'behind main': f => { f.pr.mergeable_state = 'behind'; },
    'blocked rules': f => { f.pr.mergeable_state = 'blocked'; },
    'unknown merge state': f => { f.pr.mergeable = null; },
  };
  for (const [name, change] of Object.entries(cases)) await t.test(name, async () => {
    const f = fixture(); change(f);
    assert.equal((await mergeDependabotUpdate({ request: f.request, runId: 9, pause: async () => {} })).outcome, 'ignored');
    assert.deepEqual(writes(f), []);
  });
});

test('dry run validates eligibility without merging or dispatching', async () => {
  const f = fixture();
  assert.equal((await mergeDependabotUpdate({ request: f.request, runId: 9, dryRun: true })).outcome, 'eligible');
  assert.deepEqual(writes(f), []);
});

test('dispatch failure can be retried after the confirmed merge without a second merge', async () => {
  const f = fixture();
  const failing = async (method, path, body) => {
    const result = await f.request(method, path, body);
    if (method === 'POST') throw new Error('dispatch unavailable');
    return result;
  };
  await assert.rejects(mergeDependabotUpdate({ request: failing, runId: 9 }), /dispatch unavailable/);
  f.pr.merged = true; f.pr.state = 'closed'; f.pr.merge_commit_sha = merge;
  const associated = f.run.pull_requests;
  f.run.pull_requests = [];
  f.calls.length = 0;
  const retry = async (method, path, body) => path === `${root}/commits/${head}/pulls?per_page=100` ?
    associated : f.request(method, path, body);
  assert.equal((await mergeDependabotUpdate({ request: retry, runId: 9 })).outcome, 'release-dispatched');
  assert.deepEqual(writes(f).map(call => call.method), ['POST']);
});

test('transient mergeability retries revalidate the live head and remain bounded', async () => {
  for (const mode of ['ready', 'changed', 'timeout']) {
    const f = fixture();
    f.pr.mergeable = null;
    let waits = 0;
    const pause = async milliseconds => {
      assert.equal(milliseconds, 1_000);
      waits++;
      if (mode === 'ready') f.pr.mergeable = true;
      if (mode === 'changed') f.pr.head.sha = merge;
    };
    const result = await mergeDependabotUpdate({ request: f.request, runId: 9, pause });
    assert.equal(result.outcome, mode === 'ready' ? 'release-dispatched' : 'ignored');
    assert.equal(waits, mode === 'timeout' ? 3 : 1);
    if (mode !== 'ready') assert.deepEqual(writes(f), []);
  }
});

test('merge rejection, API failure and invalid merge parent never dispatch a release', async () => {
  for (const mode of ['rejected', 'denied', 'missing-sha', 'wrong-parent', 'squash']) {
    const f = fixture();
    const request = async (method, path, body) => {
      if (method === 'PUT' && mode === 'rejected') return { merged: false };
      if (method === 'PUT' && mode === 'denied') throw new Error('protected merge denied');
      if (method === 'PUT' && mode === 'missing-sha') return { merged: true };
      return f.request(method, path, body);
    };
    if (mode === 'wrong-parent') f.commit.parents[1].sha = merge;
    if (mode === 'squash') f.commit.parents.pop();
    await assert.rejects(mergeDependabotUpdate({ request, runId: 9 }));
    assert.equal(f.calls.some(call => call.method === 'POST'), false);
  }
});

test('run ID validation rejects shell or path input before making API requests', async () => {
  for (const runId of ['', undefined, '../9', '9;echo bad', '9/merge']) {
    const f = fixture();
    await assert.rejects(mergeDependabotUpdate({ request: f.request, runId }), /numeric/);
    assert.deepEqual(f.calls, []);
  }
});

test('privileged completion workflow executes trusted main code without PR artifacts, installs or release secrets', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/dependabot-auto-merge.yml', import.meta.url), 'utf8'));
  assert.deepEqual(workflow.on.workflow_run, { workflows: ['Desktop CI and release'], types: ['completed'] });
  assert.equal(workflow.on.workflow_dispatch.inputs.run_id.required, true);
  assert.deepEqual(workflow.permissions, { contents: 'read' });
  assert.deepEqual(workflow.concurrency, { group: 'dependabot-auto-merge', queue: 'max', 'cancel-in-progress': false });
  const job = workflow.jobs.merge;
  assert.equal(job['timeout-minutes'], 5);
  for (const condition of ["github.ref == 'refs/heads/main'", "github.event.workflow_run.conclusion == 'success'", "github.event.workflow_run.event == 'pull_request'"]) {
    assert.ok(job.if.includes(condition));
  }
  assert.deepEqual(job.permissions, { contents: 'write', 'pull-requests': 'write', actions: 'write' });
  assert.equal(job.steps.length, 2);
  assert.match(job.steps[0].uses, /^actions\/checkout@v\d+\.\d+\.\d+$/);
  assert.deepEqual(job.steps[0].with, { ref: '${{ github.sha }}', 'persist-credentials': false });
  assert.equal(job.steps[1].run, 'node scripts/dependabot-auto-merge.mjs');
  assert.equal(job.steps[1].env.GITHUB_TOKEN, '${{ github.token }}');
  assert.ok(!JSON.stringify(workflow).includes('secrets.'));
  assert.equal(job.environment, undefined);
});

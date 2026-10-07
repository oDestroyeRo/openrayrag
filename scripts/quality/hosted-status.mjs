import {
  workflowRunId,
  workflowJobId,
  pullRequestNumber,
  hostedJobValues,
} from '../shared/tooling-domain-values.mjs';
// Read-only hosted status; one owner can watch a run without repeated full logs.
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
import {
  repository,
  statuses,
  requireValue,
  createPullRequestStatus,
  parseHostedRun,
  createRunSnapshot,
  parseOptions,
} from './hosted-status-policy.mjs';
export { parseOptions } from './hosted-status-policy.mjs';

export async function readApi(path, binary = false, execute = exec) {
  // Colored job logs are raw bytes saved privately, never rendered in a terminal.
  const { stdout } = await execute(
    'gh',
    [
      'api',
      '--hostname',
      'github.com',
      `repos/${repository}/${path}`,
      ...(binary ? ['--allow-escape-sequences'] : []),
    ],
    {
      encoding: binary ? 'buffer' : 'utf8',
      maxBuffer: 16 * 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
    },
  );
  return binary ? stdout : JSON.parse(stdout.toString());
}

/** @param {import('../shared/tooling-domain-values.mjs').PullRequestNumber} number @param {import('../shared/tooling-domain-values.mjs').SourceCommitSha} expectedSha @param {typeof exec} [execute] */
export async function pullRequestStatus(number, expectedSha, execute = exec) {
  const { stdout } = await execute(
    'gh',
    [
      'pr',
      'view',
      pullRequestNumber(number),
      '--repo',
      repository,
      '--json',
      'headRefOid,state,mergeStateStatus,reviewDecision,statusCheckRollup',
    ],
    {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 60_000,
      windowsHide: true,
      shell: false,
    },
  );
  return createPullRequestStatus(number, JSON.parse(stdout.toString()), expectedSha);
}

/** @param {import('../shared/tooling-domain-values.mjs').WorkflowRunId} runId @param {typeof readApi} [read] @param {import('../shared/tooling-domain-values.mjs').SourceCommitSha} [expectedSha] */
export async function snapshot(runId, read = readApi, expectedSha) {
  runId = workflowRunId(runId);
  const run = parseHostedRun(runId, await read(`actions/runs/${runId}`), expectedSha);
  const jobs = [];
  let count;
  for (let page = 1; page <= 5; page++) {
    const response = await read(
      `actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`,
    );
    requireValue(
      Array.isArray(response.jobs) &&
        Number.isSafeInteger(response.total_count) &&
        response.total_count >= 0 &&
        response.total_count <= 500,
      'Unexpected workflow jobs metadata.',
    );
    count ??= response.total_count;
    requireValue(
      response.total_count === count,
      'Job listing changed during the snapshot; refresh once.',
    );
    for (const job of response.jobs) {
      requireValue(
        typeof job.name === 'string' && job.name.length <= 512 && statuses.has(job.status),
        'Unexpected job metadata.',
      );
      jobs.push(
        hostedJobValues({
          id: workflowJobId(job.id),
          name: job.name,
          status: job.status,
          conclusion: job.conclusion ?? null,
        }),
      );
    }
    if (jobs.length === count) break;
    requireValue(response.jobs.length === 100 && jobs.length < count, 'Incomplete job listing.');
  }
  return createRunSnapshot(runId, run, jobs, count);
}

/** @param {import('../shared/tooling-domain-values.mjs').RunSnapshot} state @param {import('../shared/tooling-domain-values.mjs').WorkflowJobId} jobId @param {typeof readApi} [read] */
export async function saveFailedLog(state, jobId, read = readApi) {
  jobId = workflowJobId(jobId);
  const job = state.jobs.find((candidate) => candidate.id === jobId);
  requireValue(
    job?.status === 'completed' &&
      job.conclusion !== null &&
      ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(
        job.conclusion,
      ),
    'Select a completed failing job from this run attempt.',
  );
  const bytes = await read(`actions/jobs/${jobId}/logs`, true);
  requireValue(
    Buffer.isBuffer(bytes) && bytes.length <= 16 * 1024 * 1024,
    'Unexpected or oversized job log.',
  );
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-hosted-log-'));
  await chmod(directory, 0o700);
  const path = join(directory, `job-${jobId}.log`);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  // Logs stay private; console output contains only the path and job identity.
  return { jobId, path, bytes: bytes.length };
}

/** @param {Readonly<import('../shared/tooling-domain-values.mjs').HostedOptions>} options @param {{read?: typeof readApi, readPullRequest?: typeof pullRequestStatus, output?: (value: string) => void, wait?: (milliseconds: number) => Promise<void>, maxSnapshots?: number}} [effects] */
export async function watchRun(
  options,
  {
    read = readApi,
    readPullRequest = pullRequestStatus,
    output = console.log,
    wait = (milliseconds) => new Promise((done) => setTimeout(done, milliseconds)),
    maxSnapshots = 160,
  } = {},
) {
  let previous;
  for (let index = 0; index < maxSnapshots; index++) {
    let state = await snapshot(options.runId, read, options.expectedSha);
    if (options.pullRequest)
      state = {
        ...state,
        pullRequest: await readPullRequest(options.pullRequest, state.sourceSha),
      };
    const encoded = JSON.stringify(state);
    if (encoded !== previous) output(encoded);
    previous = encoded;
    if (options.jobId) output(JSON.stringify(await saveFailedLog(state, options.jobId, read)));
    const pendingPolicy =
      state.pullRequest &&
      (state.pullRequest.mergeState === 'UNKNOWN' ||
        state.pullRequest.checks.some((check) => check.status !== 'completed'));
    if (!options.watch || (state.status === 'completed' && !pendingPolicy)) return state;
    await wait(45_000);
  }
  throw new Error('Watch reached its two-hour bound; take a fresh snapshot to continue.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help)
    console.log(
      'bun run ci:status <run-id> [--sha <source-sha>] [--pr <number>] [--watch | --failed-log <job-id>]\nRead-only metadata. Watch polls every 45 seconds and prints changes. --pr includes merge eligibility and external checks such as the CodeQL policy summary. Failed logs are saved privately, including when other jobs still run.',
    );
  else {
    const state = await watchRun(options);
    if (
      state.status === 'completed' &&
      (state.conclusion !== 'success' ||
        (state.pullRequest && state.pullRequest.mergeState !== 'CLEAN'))
    )
      process.exitCode = 1;
  }
}

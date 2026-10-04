// Read-only hosted status; one owner can watch a run without repeated full logs.
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const repository = 'oDestroyeRo/openrayrag';
const statuses = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
function requireValue(ok, message) { if (!ok) throw new Error(message); }
function id(value) { requireValue(/^[1-9]\d*$/.test(String(value)), 'Expected a positive numeric GitHub ID.'); return String(value); }

export async function readApi(path, binary = false, execute = exec) {
  // Colored job logs are raw bytes saved privately, never rendered in a terminal.
  const { stdout } = await execute('gh', ['api', '--hostname', 'github.com', `repos/${repository}/${path}`, ...(binary ? ['--allow-escape-sequences'] : [])], {
    encoding: binary ? 'buffer' : 'utf8', maxBuffer: 16 * 1024 * 1024, timeout: 60_000, windowsHide: true,
  });
  return binary ? stdout : JSON.parse(stdout);
}

export async function snapshot(runId, read = readApi, expectedSha) {
  runId = id(runId);
  const run = await read(`actions/runs/${runId}`);
  requireValue(String(run.id) === runId && /^[a-f0-9]{40}$/.test(run.head_sha ?? '') && statuses.has(run.status), 'Unexpected workflow run metadata.');
  if (expectedSha) requireValue(run.head_sha === expectedSha, 'Workflow source differs from the expected SHA.');
  requireValue(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing workflow attempt.');
  const jobs = [];
  let count;
  for (let page = 1; page <= 5; page++) {
    const response = await read(`actions/runs/${runId}/attempts/${run.run_attempt}/jobs?per_page=100&page=${page}`);
    requireValue(Array.isArray(response.jobs) && Number.isSafeInteger(response.total_count) && response.total_count >= 0 && response.total_count <= 500, 'Unexpected workflow jobs metadata.');
    count ??= response.total_count;
    requireValue(response.total_count === count, 'Job listing changed during the snapshot; refresh once.');
    for (const job of response.jobs) {
      requireValue(typeof job.name === 'string' && job.name.length <= 512 && statuses.has(job.status), 'Unexpected job metadata.');
      jobs.push({ id: id(job.id), name: job.name, status: job.status, conclusion: job.conclusion ?? null });
    }
    if (jobs.length === count) break;
    requireValue(response.jobs.length === 100 && jobs.length < count, 'Incomplete job listing.');
  }
  requireValue(jobs.length === count && new Set(jobs.map(job => job.id)).size === count, 'Incomplete or duplicate job listing.');
  jobs.sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { repository, runId, sourceSha: run.head_sha, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion ?? null, url: `https://github.com/${repository}/actions/runs/${runId}`, jobs };
}

export async function saveFailedLog(state, jobId, read = readApi) {
  jobId = id(jobId);
  const job = state.jobs.find(candidate => candidate.id === jobId);
  requireValue(job?.status === 'completed' && ['failure', 'timed_out', 'cancelled', 'action_required', 'startup_failure'].includes(job.conclusion), 'Select a completed failing job from this run attempt.');
  const bytes = await read(`actions/jobs/${jobId}/logs`, true);
  requireValue(Buffer.isBuffer(bytes) && bytes.length <= 16 * 1024 * 1024, 'Unexpected or oversized job log.');
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-hosted-log-'));
  await chmod(directory, 0o700);
  const path = join(directory, `job-${jobId}.log`);
  await writeFile(path, bytes, { flag: 'wx', mode: 0o600 });
  // Logs stay private; console output contains only the path and job identity.
  return { jobId, path, bytes: bytes.length };
}

export function parseOptions(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  const options = { runId: id(args[0]), watch: false };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--watch' && !options.watch) options.watch = true;
    else if (flag === '--sha' && !options.expectedSha) {
      const sha = args[++index];
      requireValue(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Expected a complete source SHA.');
      options.expectedSha = sha;
    } else if (flag === '--failed-log' && !options.jobId) options.jobId = id(args[++index]);
    else throw new Error('Usage: npm run ci:status -- <run-id> [--sha <source-sha>] [--watch | --failed-log <job-id>]');
  }
  requireValue(!(options.watch && options.jobId), 'Download one failed log from a snapshot, or watch status changes.');
  return options;
}

export async function watchRun(options, { read = readApi, output = console.log, wait = milliseconds => new Promise(done => setTimeout(done, milliseconds)), maxSnapshots = 160 } = {}) {
  let previous;
  for (let index = 0; index < maxSnapshots; index++) {
    const state = await snapshot(options.runId, read, options.expectedSha);
    const encoded = JSON.stringify(state);
    if (encoded !== previous) output(encoded);
    previous = encoded;
    if (options.jobId) output(JSON.stringify(await saveFailedLog(state, options.jobId, read)));
    if (!options.watch || state.status === 'completed') return state;
    await wait(45_000);
  }
  throw new Error('Watch reached its two-hour bound; take a fresh snapshot to continue.');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const options = parseOptions(process.argv.slice(2));
  if (options.help) console.log('npm run ci:status -- <run-id> [--sha <source-sha>] [--watch | --failed-log <job-id>]\nRead-only metadata. Watch polls every 45 seconds and prints changes. Failed logs are saved privately, including when other jobs still run.');
  else {
    const state = await watchRun(options);
    if (state.status === 'completed' && state.conclusion !== 'success') process.exitCode = 1;
  }
}

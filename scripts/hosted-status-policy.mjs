// Pure hosted metadata validation, normalization and CLI parsing.
export const repository = 'oDestroyeRo/openrayrag';
export const statuses = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
export function requireValue(ok, message) { if (!ok) throw new Error(message); }
export function id(value) { requireValue(/^[1-9]\d*$/.test(String(value)), 'Expected a positive numeric GitHub ID.'); return String(value); }

export function createPullRequestStatus(number, result, expectedSha) {
  requireValue(result.headRefOid === expectedSha, 'Pull request head differs from the workflow source.');
  requireValue(Array.isArray(result.statusCheckRollup) && typeof result.mergeStateStatus === 'string', 'Missing pull request check metadata.');
  const checks = result.statusCheckRollup.map(check => ({
    name: check.name ?? check.context,
    status: check.status?.toLowerCase() ?? (['PENDING', 'EXPECTED'].includes(check.state) ? 'pending' : 'completed'),
    conclusion: check.conclusion?.toLowerCase() ?? (check.state === 'SUCCESS' ? 'success' : check.state === 'FAILURE' || check.state === 'ERROR' ? 'failure' : null),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { number: id(number), state: result.state, mergeState: result.mergeStateStatus, reviewDecision: result.reviewDecision ?? null, checks };
}

export function validateRun(runId, run, expectedSha) {
  requireValue(String(run.id) === runId && /^[a-f0-9]{40}$/.test(run.head_sha ?? '') && statuses.has(run.status), 'Unexpected workflow run metadata.');
  if (expectedSha) requireValue(run.head_sha === expectedSha, 'Workflow source differs from the expected SHA.');
  requireValue(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing workflow attempt.');
}

export function createRunSnapshot(runId, run, jobs, count) {
  requireValue(jobs.length === count && new Set(jobs.map(job => job.id)).size === count, 'Incomplete or duplicate job listing.');
  const sorted = [...jobs].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { repository, runId, sourceSha: run.head_sha, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion ?? null, url: `https://github.com/${repository}/actions/runs/${runId}`, jobs: sorted };
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
    else if (flag === '--pr' && !options.pullRequest) options.pullRequest = id(args[++index]);
    else throw new Error('Usage: bun run ci:status <run-id> [--sha <source-sha>] [--pr <number>] [--watch | --failed-log <job-id>]');
  }
  requireValue(!(options.watch && options.jobId), 'Download one failed log from a snapshot, or watch status changes.');
  return options;
}

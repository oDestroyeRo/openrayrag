import { workflowRunId, workflowJobId, pullRequestNumber, sourceCommitSha, hostedRunValues } from '../shared/tooling-domain-values.mjs';
import { map } from 'effect/Array';

// Pure hosted metadata validation, normalization and CLI parsing.
export const repository = 'oDestroyeRo/openrayrag';
export const statuses = new Set(['queued', 'in_progress', 'completed', 'waiting', 'pending', 'requested']);
export function requireValue(ok, message) { if (!ok) throw new Error(message); }
export const id = workflowRunId;

/** @param {import('../shared/tooling-domain-values.mjs').PullRequestNumber} number @param {import('../shared/tooling-domain-values.mjs').PullRequestStatusDto} result @param {import('../shared/tooling-domain-values.mjs').SourceCommitSha} expectedSha @returns {import('../shared/tooling-domain-values.mjs').PullRequestStatus} */
export function createPullRequestStatus(number, result, expectedSha) {
  requireValue(result.headRefOid === expectedSha, 'Pull request head differs from the workflow source.');
  requireValue(Array.isArray(result.statusCheckRollup) && typeof result.mergeStateStatus === 'string', 'Missing pull request check metadata.');
  const checks = map(result.statusCheckRollup, check => ({
    name: check.name ?? check.context,
    status: check.status?.toLowerCase() ?? ((check.state === 'PENDING' || check.state === 'EXPECTED') ? 'pending' : 'completed'),
    conclusion: check.conclusion?.toLowerCase() ?? (check.state === 'SUCCESS' ? 'success' : check.state === 'FAILURE' || check.state === 'ERROR' ? 'failure' : null),
  })).sort((a, b) => String(a.name).localeCompare(String(b.name)));
  return { number: pullRequestNumber(number), state: result.state, mergeState: result.mergeStateStatus, reviewDecision: result.reviewDecision ?? null, checks };
}

/** @param {import('../shared/tooling-domain-values.mjs').WorkflowRunId} runId @param {import('../shared/tooling-domain-values.mjs').HostedRunDto} run @param {import('../shared/tooling-domain-values.mjs').SourceCommitSha} [expectedSha] @returns {void} */
export function validateRun(runId, run, expectedSha) {
  requireValue(String(run.id) === runId && /^[a-f0-9]{40}$/.test(run.head_sha ?? '') && statuses.has(run.status), 'Unexpected workflow run metadata.');
  if (expectedSha) requireValue(run.head_sha === expectedSha, 'Workflow source differs from the expected SHA.');
  requireValue(Number.isSafeInteger(run.run_attempt) && run.run_attempt > 0, 'Missing workflow attempt.');
}

/** Own admitted metadata before waiting for the job listing.
 * @param {import('../shared/tooling-domain-values.mjs').WorkflowRunId} runId @param {import('../shared/tooling-domain-values.mjs').HostedRunDto} run @param {import('../shared/tooling-domain-values.mjs').SourceCommitSha} [expectedSha] @returns {import('../shared/tooling-domain-values.mjs').HostedRun}
 */
export function parseHostedRun(runId, run, expectedSha) {
  validateRun(runId, run, expectedSha);
  return hostedRunValues(structuredClone(run));
}

/** @param {import('../shared/tooling-domain-values.mjs').WorkflowRunId} runId @param {import('../shared/tooling-domain-values.mjs').HostedRun} run @param {readonly import('../shared/tooling-domain-values.mjs').HostedJob[]} jobs @param {number} count @returns {import('../shared/tooling-domain-values.mjs').RunSnapshot} */
export function createRunSnapshot(runId, run, jobs, count) {
  requireValue(jobs.length === count && new Set(map(jobs, job => job.id)).size === count, 'Incomplete or duplicate job listing.');
  const sorted = [...jobs].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }));
  return { repository, runId, sourceSha: run.head_sha, attempt: run.run_attempt, status: run.status, conclusion: run.conclusion ?? null, url: `https://github.com/${repository}/actions/runs/${runId}`, jobs: sorted };
}

/** @param {readonly string[]} args @returns {import('../shared/tooling-domain-values.mjs').HostedCommand} */
export function parseOptions(args) {
  if (args.length === 1 && args[0] === '--help') return { help: true };
  /** @type {import('../shared/tooling-domain-values.mjs').HostedOptions} */
  const options = { runId: workflowRunId(args[0]), watch: false };
  for (let index = 1; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--watch' && !options.watch) options.watch = true;
    else if (flag === '--sha' && !options.expectedSha) {
      const sha = args[++index];
      requireValue(/^[a-f0-9]{40}$/.test(sha ?? ''), 'Expected a complete source SHA.');
      options.expectedSha = sourceCommitSha(sha);
    } else if (flag === '--failed-log' && !options.jobId) options.jobId = workflowJobId(args[++index]);
    else if (flag === '--pr' && !options.pullRequest) options.pullRequest = pullRequestNumber(args[++index]);
    else throw new Error('Usage: bun run ci:status <run-id> [--sha <source-sha>] [--pr <number>] [--watch | --failed-log <job-id>]');
  }
  requireValue(!(options.watch && options.jobId), 'Download one failed log from a snapshot, or watch status changes.');
  return options;
}

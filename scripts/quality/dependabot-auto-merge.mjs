import { filter } from 'remeda';
import { sourceCommitSha } from '../shared/tooling-domain-values.mjs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { repository, mergeTitle, rejectionReason } from './dependabot-policy.mjs';
const workflowPath = '.github/workflows/release.yml';
const delay = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));

// All inputs are API metadata. No PR code, artifacts or package hooks execute here.
/** @param {{request: import("../shared/tooling-domain-values.mjs").DependabotRequest, runId: string | number | undefined, dryRun?: boolean, pause?: (milliseconds: number) => Promise<void>}} options @returns {Promise<import("../shared/tooling-domain-values.mjs").DependabotOutcome>} */
export async function mergeDependabotUpdate({ request, runId, dryRun = false, pause = delay }) {
  if (!/^\d+$/.test(String(runId))) throw new Error('A numeric desktop CI run ID is required');
  /** @type {`/repos/${string}`} */
  const root = `/repos/${repository}`;
  const run = structuredClone(await request('GET', `${root}/actions/runs/${runId}`));
  /** @param {string} reason @returns {Extract<import('../shared/tooling-domain-values.mjs').DependabotOutcome, {outcome: 'ignored'}>} */
  const ignored = reason => ({ outcome: 'ignored', reason, runId });
  if (run.repository?.full_name !== repository || run.head_repository?.full_name !== repository ||
      run.path !== workflowPath || run.event !== 'pull_request') return ignored('unrelated CI run');
  if (run.status !== 'completed' || run.conclusion !== 'success') return ignored('CI did not succeed');

  // GitHub removes run.pull_requests after merge. Commit association preserves
  // the recovery path when the release dispatch failed after a successful merge.
  const candidates = run.pull_requests?.length ? run.pull_requests :
    await request('GET', `${root}/commits/${run.head_sha}/pulls?per_page=100`);
  const associated = filter(candidates, pr =>
    pr.base?.ref === 'main' && pr.base?.repo?.id === run.repository?.id &&
    pr.head?.repo?.id === run.repository?.id && pr.head?.sha === run.head_sha);
  if (associated.length !== 1) return ignored('no unique matching main PR');
  const number = associated[0].number;
  let pr = structuredClone(await request('GET', `${root}/pulls/${number}`));
  let rejection = rejectionReason(pr, run.head_sha);
  if (rejection) return ignored(rejection);

  const jobs = await request('GET', `${root}/actions/runs/${runId}/jobs?filter=latest&per_page=100`);
  const gates = filter(jobs.jobs, job => job.name === 'CI / required');
  if (gates.length !== 1 || gates[0].status !== 'completed' || gates[0].conclusion !== 'success') {
    return ignored('required desktop and security gate did not succeed');
  }
  // mergeable:null means GitHub is computing it, rather than a rejected merge.
  for (let attempt = 0; !pr.merged && pr.mergeable === null && attempt < 3; attempt++) {
    await pause(1_000);
    pr = structuredClone(await request('GET', `${root}/pulls/${number}`));
    rejection = rejectionReason(pr, run.head_sha);
    if (rejection) return ignored(rejection);
  }
  if (!pr.merged && (pr.mergeable !== true || pr.mergeable_state !== 'clean')) {
    return ignored('branch protection, conflicts or a newer main block this merge');
  }
  if (dryRun) return { outcome: 'eligible', number, runId, headSha: run.head_sha, alreadyMerged: pr.merged };

  let mergeSha = pr.merge_commit_sha;
  if (!pr.merged) {
    // GitHub enforces strict required checks, code-scanning rules and head equality.
    const merged = await request('PUT', `${root}/pulls/${number}/merge`, {
      sha: run.head_sha,
      merge_method: 'merge',
      commit_title: mergeTitle(pr),
    });
    if (merged.merged !== true) throw new Error(`GitHub did not merge Dependabot PR #${number}`);
    mergeSha = merged.sha;
  }
  if (!/^[a-f0-9]{40}$/.test(mergeSha ?? '')) throw new Error('Confirmed merge commit is missing');
  const commit = await request('GET', `${root}/commits/${mergeSha}`);
  if (commit.parents?.length !== 2 || commit.parents[1].sha !== run.head_sha) {
    throw new Error('Merge commit does not contain the tested Dependabot head');
  }

  // GITHUB_TOKEN merges suppress push workflows. Dispatch also works on retry
  // after a merge succeeded but this API call failed. It builds current main;
  // the existing release pipeline reconciles duplicates and concurrent advances.
  await request('POST', `${root}/actions/workflows/release.yml/dispatches`, { ref: 'main' });
  return { outcome: 'release-dispatched', number, runId, headSha: run.head_sha, mergeSha: sourceCommitSha(mergeSha) };
}

/** @type {import("../shared/tooling-domain-values.mjs").DependabotRequest}
 * @param {"GET" | "PUT" | "POST"} method @param {string} path @param {unknown} [body]
 */
const githubRequest = async (method, path, body = undefined) => {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN is required');
  const response = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`GitHub ${method} ${path} failed (${response.status})`);
  return response.status === 204 ? undefined : JSON.parse(await response.text());
};

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!['true', 'false'].includes(process.env.DRY_RUN ?? 'false')) throw new Error('DRY_RUN must be true or false');
    console.log(JSON.stringify(await mergeDependabotUpdate({
      request: githubRequest, runId: process.env.RUN_ID, dryRun: process.env.DRY_RUN === 'true',
    })));
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    console.error(error.message);
    process.exitCode = 1;
  }
}

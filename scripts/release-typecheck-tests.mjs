import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, symlink, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin/tsc",
);
const configuration = join(root, "tsconfig.release.json");

function compile(project) {
  const result = spawnSync(
    process.execPath,
    [compiler, "--project", project, "--pretty", "false"],
    { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

async function compileMutation(mutate) {
  const folder = await mkdtemp(join(tmpdir(), "rayrag-release-typecheck-"));
  try {
    await mkdir(join(folder, "scripts"));
    // rootDirs resolves relative source overlays, while packages resolve from
    // their own node_modules ancestry. Keep the pure library available here.
    await mkdir(join(folder, "node_modules"));
    await symlink(join(root, "node_modules/remeda"), join(folder, "node_modules/remeda"),
      process.platform === "win32" ? "junction" : "dir");
    const source = await readFile(join(root, "scripts/release.mjs"), "utf8");
    const changed = mutate(source);
    assert.notEqual(changed, source, "The fixture must mutate production code.");
    const entrypoint = join(folder, "scripts/release.mjs");
    await writeFile(entrypoint, changed);
    const project = join(folder, "tsconfig.json");
    await writeFile(
      project,
      JSON.stringify({
        extends: configuration,
        compilerOptions: {
          // Resolve the unchanged production dependencies beside this overlay.
          rootDirs: [folder, root],
          typeRoots: [join(root, "node_modules/@types")],
        },
        files: [entrypoint],
      }),
    );
    return compile(project);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("release entrypoint and its production dependency graph type-check", () => {
  const result = compile(configuration);
  assert.equal(result.status, 0, result.output);
});

test("compiler rejects the original string argument to reservation slice", async () => {
  const result = await compileMutation((source) =>
    source.replace(
      'PLAN_REF_PREFIX.slice("refs/".length)',
      'PLAN_REF_PREFIX.slice("refs/")',
    ),
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /scripts[/\\]release\.mjs\(\d+,\d+\): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'/,
  );
  assert.equal((result.output.match(/error TS/g) ?? []).length, 1, result.output);
});

test("request method, path and uploaded bytes have checked input contracts", async () => {
  const result = await compileMutation(
    (source) => `${source}
const apiTypeFixture = new GitHubReleaseApi("synthetic-token");
apiTypeFixture.request("DELETE", "releases/latest");
apiTypeFixture.request("GET", 42);
apiTypeFixture.upload(releaseId(1), "bundle.zip", "invalid-byte-body");
`,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Argument of type '"DELETE"'/);
  assert.match(result.output, /Argument of type 'number'.*parameter of type 'string'/);
  assert.match(result.output, /Argument of type 'string'.*parameter of type 'Buffer/);
  assert.equal((result.output.match(/error TS/g) ?? []).length, 3, result.output);
});

test("compiler rejects identity and digest swaps in actual API and policy consumers", async () => {
  const result = await compileMutation(source => `${source}
import { workflowRunId, workflowJobId, actionsArtifactId, pullRequestNumber,
  fileDigest, policyDigest, releaseTag, stableReleaseVersion, workflowAttempt } from './tooling-domain-values.mjs';
import { downloadActionsZip } from './release-public-io.mjs';
import { validateRun, createPullRequestStatus } from './hosted-status-policy.mjs';
import { compareVersions, parsePlan, planSha256 } from './semantic-release-policy.mjs';
import { releaseBody } from './release-policy.mjs';
const domainApi = new GitHubReleaseApi('synthetic-token');
const sourceValue = sourceCommitSha('${'1'.repeat(40)}');
const tagObjectValue = gitTagObjectSha('${'1'.repeat(40)}');
domainApi.tagObject(sourceValue);
annotatedTag(sourceValue, Buffer.alloc(0));
domainApi.createPlanRef('refs/tags/fixture', sourceValue);
domainApi.createTag(releaseTag('v1.2.3'), tagObjectValue);
domainApi.createPlanTag('fixture', 'message', tagObjectValue, 'date');
domainApi.assets(workflowAttempt(1));
downloadActionsZip('oDestroyeRo/openrayrag', workflowRunId(1), '/tmp/fixture.zip', 10);
validateRun(workflowJobId(1), {id: 1, head_sha: sourceValue, status: 'completed', run_attempt: 1});
createPullRequestStatus(workflowRunId(1), {headRefOid: sourceValue, state: 'OPEN', mergeStateStatus: 'CLEAN', statusCheckRollup: []}, sourceValue);
compareVersions(releaseTag('v1.2.3'), stableReleaseVersion('1.2.3'));
/** @type {import('./tooling-domain-values.mjs').ReleasePlan} */
const checkedPlan = parsePlan(JSON.parse('{}'));
planSha256({...checkedPlan, policySha256: fileDigest('${'2'.repeat(64)}')});
planSha256({...checkedPlan, predecessorPlanSha256: policyDigest('${'2'.repeat(64)}')});
releaseBody({sourceSha: sourceValue, version: stableReleaseVersion('1.2.3'), tag: releaseTag('v1.2.3'), pubDate: 'date'},
  {id: actionsArtifactId(1), runId: workflowRunId(1), digest: fileDigest('${'2'.repeat(64)}')});
/** @type {import('./tooling-domain-values.mjs').FirstParentCount} */
const countSwap = workflowAttempt(1);
checkedPlan.analysisBase.version = stableReleaseVersion('9.9.9');
`);
  assert.notEqual(result.status, 0);
  for (const name of ['GitTagObjectSha', 'SourceCommitSha', 'ActionsArtifactId', 'WorkflowRunId',
    'PullRequestNumber', 'StableReleaseVersion', 'PolicyDigest', 'PlanDigest', 'ArtifactDigest', 'FirstParentCount']) {
    assert.match(result.output, new RegExp(name), result.output);
  }
  assert.match(result.output, /read-only property/, result.output);
  assert.equal((result.output.match(/error TS/g) ?? []).length, 15, result.output);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { parse } from 'yaml';

const readYaml = async path => parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const desktop = await readYaml('../.github/workflows/release.yml');
const release = await readYaml('../.github/workflows/release-publish.yml');
const security = await readYaml('../.github/workflows/security.yml');
const dependabot = await readYaml('../.github/dependabot.yml');

function succeeds(script, variables) {
  try {
    execFileSync('bash', ['-e', '-c', script], { env: { ...process.env, ...variables }, stdio: 'pipe' });
    return true;
  } catch (error) {
    if (error.code === 'ENOENT') throw error;
    return false;
  }
}

test('native security is shared by PR, merge queue, main release and daily scans', () => {
  assert.equal(desktop.jobs.security.uses, './.github/workflows/security.yml');
  assert.equal(desktop.jobs.security.if, undefined);
  assert.equal(desktop.jobs.security.secrets, undefined);
  assert.deepEqual(desktop.jobs.verify.needs, ['quality', 'security']);
  assert.ok(Object.hasOwn(security.on, 'workflow_call'));
  assert.deepEqual(security.on.schedule, [{ cron: '37 2 * * *' }]);
  assert.ok(Object.hasOwn(security.on, 'workflow_dispatch'));
  assert.deepEqual(security.jobs.codeql.strategy.matrix.language, ['actions', 'javascript-typescript', 'python', 'rust']);
  assert.equal(security.jobs.codeql.strategy['fail-fast'], false);
  const init = security.jobs.codeql.steps.find(step => step.uses?.startsWith('github/codeql-action/init@'));
  assert.equal(init.with['build-mode'], 'none');
  assert.equal(init.with.queries, 'security-extended');
  const setup = security.jobs.codeql.steps.find(step => step.run?.includes('rustup'));
  assert.equal(setup.if, "matrix.language == 'rust'");
  assert.ok(setup.run.includes('npm run bridge'));
  assert.ok(setup.run.includes('libwebkit2gtk-4.1-dev'));
});

test('dependency review covers development, runtime and unknown packages on PRs and merge groups', () => {
  const job = security.jobs['dependency-review'];
  assert.equal(job.if, "github.event_name == 'pull_request' || github.event_name == 'merge_group'");
  const review = job.steps.find(step => step.uses?.startsWith('actions/dependency-review-action@'));
  assert.equal(review.with['base-ref'], '${{ github.event.pull_request.base.sha || github.event.merge_group.base_sha }}');
  assert.equal(review.with['head-ref'], '${{ github.event.pull_request.head.sha || github.event.merge_group.head_sha }}');
  assert.equal(review.with['fail-on-severity'], 'high');
  assert.equal(review.with['fail-on-scopes'], 'runtime,development,unknown');
  assert.equal(review.with['comment-summary-in-pr'], 'never');
  assert.equal(review.with['allow-ghsas'], 'GHSA-vfj7-8cjw-p6xm');
  assert.equal(review.with['allow-dependencies'], undefined);
  assert.notEqual(review.with['warn-only'], true);
  assert.notEqual(review.with['vulnerability-check'], false);
});

test('required gates reject failed, cancelled, skipped or missing applicable security checks', () => {
  const outcomes = ['success', 'failure', 'cancelled', 'skipped', ''];
  for (const quality of outcomes) for (const scans of outcomes) {
    assert.equal(succeeds(desktop.jobs.verify.steps[0].run, {
      QUALITY_RESULT: quality, SECURITY_RESULT: scans,
    }), quality === 'success' && scans === 'success');
  }
  const gate = security.jobs.verify;
  assert.equal(gate.if, 'always()');
  assert.deepEqual(gate.needs, ['codeql', 'dependency-review']);
  for (const event of ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']) {
    for (const scans of outcomes) for (const review of outcomes) {
      const applicable = event === 'pull_request' || event === 'merge_group';
      assert.equal(succeeds(gate.steps[0].run, {
        EVENT_NAME: event, CODEQL_RESULT: scans, DEPENDENCY_RESULT: review,
      }), scans === 'success' && review === (applicable ? 'success' : 'skipped'));
    }
  }
});

test('versioned actions and scan permissions preserve the release trust boundary', () => {
  for (const workflow of [desktop, release, security]) {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(job.uses || job['timeout-minutes'] > 0);
      for (const step of job.steps ?? []) {
        if (step.uses) assert.match(step.uses, /@v\d+\.\d+\.\d+$/);
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(step.with.ref, '${{ github.sha }}');
          assert.equal(step.with['persist-credentials'], false);
        }
        if (step.uses?.startsWith('actions/upload-artifact@')) assert.equal(step.with.archive, true);
        if (step.uses?.startsWith('Swatinem/rust-cache@')) {
          assert.equal(step.with['save-if'], "${{ github.repository == 'oDestroyeRo/openrayrag' && github.ref == 'refs/heads/main' }}");
        }
      }
    }
  }
  assert.deepEqual(security.jobs.codeql.permissions, {
    contents: 'read', actions: 'read', 'security-events': 'write',
  });
  assert.ok(!JSON.stringify(security).includes('secrets.'));
  assert.ok(!JSON.stringify(security).includes('environment'));
  assert.ok(!Object.hasOwn(desktop.on, 'pull_request_target'));
});

test('Dependabot checks all shipped ecosystems every calendar day without bypassing CI', () => {
  assert.equal(dependabot.version, 2);
  assert.deepEqual(dependabot.updates.map(update => [update['package-ecosystem'], update.directory]), [
    ['npm', '/'], ['npm', '/tools/release'], ['cargo', '/src-tauri'], ['github-actions', '/'],
  ]);
  for (const update of dependabot.updates) {
    assert.deepEqual(update.schedule, { interval: 'cron', cronjob: '17 9 * * *', timezone: 'Asia/Bangkok' });
    assert.equal(update['target-branch'], undefined);
    assert.ok(update['open-pull-requests-limit'] > 0);
    for (const group of Object.values(update.groups)) {
      assert.equal(group['applies-to'], 'version-updates');
      assert.deepEqual(group['update-types'], ['minor', 'patch']);
    }
  }
  const tools = dependabot.updates.find(update => update.directory === '/tools/release');
  assert.deepEqual(tools['commit-message'], { prefix: 'chore', 'prefix-development': 'chore', include: 'scope' });
  const actions = dependabot.updates.find(update => update['package-ecosystem'] === 'github-actions');
  assert.deepEqual(actions['commit-message'], { prefix: 'ci', include: 'scope' });
});

test('the braces advisory exception cannot reach the desktop dependency graph or publisher plugins', async () => {
  const root = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  for (const path of Object.keys(root.packages)) {
    assert.doesNotMatch(path, /(?:^|\/)node_modules\/(?:braces|micromatch)(?:\/|$)/, path);
    assert.doesNotMatch(path, /(?:^|\/)node_modules\/@semantic-release\//, path);
  }
  const manifest = JSON.parse(await readFile(new URL('../tools/release/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), [
    '@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator',
    'conventional-changelog-conventionalcommits', 'semver',
  ]);
  assert.equal(manifest.overrides['conventional-changelog-writer'], '9.2.1');
  const lock = JSON.parse(await readFile(new URL('../tools/release/package-lock.json', import.meta.url), 'utf8'));
  for (const path of Object.keys(lock.packages)) {
    assert.doesNotMatch(path, /(?:^|\/)node_modules\/(?:semantic-release|@semantic-release\/(?:npm|github|git))(?:\/|$)/, path);
  }
  const npmrc = (await readFile(new URL('../tools/release/.npmrc', import.meta.url), 'utf8'))
    .split(/\r?\n/).map(line => line.trim()).filter(line => line && !/^[#;]/.test(line));
  assert.deepEqual(npmrc, ['legacy-peer-deps=true']);
});

test('required quality checks execute the installed official-engine zero-braces guard', async () => {
  const guard = await readFile(new URL('./semantic-release-plan-tests.mjs', import.meta.url), 'utf8');
  assert.ok(guard.includes('official engines never call vulnerable braces walkers and use only trusted matcher patterns'));
  const quality = desktop.jobs.quality.steps.map(step => step.run ?? '').join('\n');
  assert.ok(quality.includes('npm run check'));
  const { verificationPlan } = await import('./check.mjs');
  const plan = await verificationPlan();
  const install = plan.findIndex(step => step.tool === 'npm' && step.args.join(' ').startsWith('ci --prefix tools/release'));
  const tests = plan.findIndex(step => step.tool === 'node' && step.args.includes('scripts/semantic-release-plan-tests.mjs'));
  assert.ok(install >= 0 && tests > install);
  assert.deepEqual(desktop.jobs.verify.needs, ['quality', 'security']);
  assert.equal(desktop.jobs.release.needs, 'verify');
});

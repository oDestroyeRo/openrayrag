import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';

const readYaml = async path => Bun.YAML.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const desktop = await readYaml('../../.github/workflows/release.yml');
const release = await readYaml('../../.github/workflows/release-publish.yml');
const security = await readYaml('../../.github/workflows/security.yml');
const dependabot = await readYaml('../../.github/dependabot.yml');
const autoMerge = await readYaml('../../.github/workflows/dependabot-auto-merge.yml');

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
  assert.ok(setup.run.includes('bun run bridge'));
  const dependencies = security.jobs.codeql.steps.find(step => step.uses === './.github/actions/linux-dependencies');
  assert.equal(dependencies.if, "matrix.language == 'rust'");
  assert.ok(security.jobs.codeql.steps.indexOf(dependencies) < security.jobs.codeql.steps.indexOf(setup));
});

test('Rust extraction restores only its Cargo dependencies and still creates a fresh security database', () => {
  const job = security.jobs.codeql;
  const prepare = job.steps.findIndex(step => step.run?.includes('rustup'));
  const cache = job.steps.findIndex(step => step.uses?.startsWith('Swatinem/rust-cache@'));
  const init = job.steps.findIndex(step => step.uses?.startsWith('github/codeql-action/init@'));
  const analyze = job.steps.findIndex(step => step.uses?.startsWith('github/codeql-action/analyze@'));
  assert.ok(prepare < cache && cache < init && init < analyze);
  const step = job.steps[cache];
  assert.equal(step.if, "matrix.language == 'rust'");
  const [workspace, target] = step.with.workspaces.split(' -> ');
  assert.equal(workspace, 'src-tauri');
  const cachePath = posix.resolve('/checkout', workspace, target);
  const extractorPath = posix.resolve(job.env.CODEQL_EXTRACTOR_RUST_OPTION_CARGO_TARGET_DIR.replace('${{ github.workspace }}', '/checkout'));
  assert.equal(cachePath, extractorPath);
  // Generated dependency sources must remain outside the scanned checkout.
  assert.equal(cachePath.startsWith('/checkout/'), false);
  assert.equal(step.with['env-vars'], 'CODEQL_EXTRACTOR_RUST_OPTION_');
  assert.equal(step.with.key, `codeql-rust-${job.steps[init].uses.split('@')[1]}-` + "${{ hashFiles('vendor/glib/**') }}");
  assert.equal(step.with['shared-key'], undefined);
  assert.equal(step.with['cache-directories'], undefined);
  assert.notEqual(step.with['cache-workspace-crates'], true);
  assert.notEqual(step.with['cache-all-crates'], true);
  // A cold or missing cache must never skip extraction or query evaluation.
  assert.equal(job.steps[init].if, undefined);
  assert.equal(job.steps[analyze].if, undefined);
  const bunCache=job.steps.findIndex(step=>step.id==='bun-cache');
  assert.ok(bunCache>=0 && bunCache<prepare);
  assert.equal(job.steps[bunCache].if,"matrix.language == 'rust'");
  assert.equal(job.env.BUN_INSTALL_CACHE_DIR,desktop.env.BUN_INSTALL_CACHE_DIR);
  assert.deepEqual(job.steps[bunCache].with,desktop.jobs.quality.steps.find(step=>step.id==='bun-cache').with);
  assert.ok(!job.steps.some(step=>step.uses?.startsWith('actions/cache/save@')));
});

test('only superseded scans for the same PR and language cancel each other', () => {
  const concurrency = security.jobs.codeql.concurrency;
  function group(github, matrix) {
    return concurrency.group.replace(/\$\{\{\s*(.*?)\s*\}\}/g,
      (_, expression) => new Function('github', 'matrix', `return (${expression});`)(github, matrix));
  }
  const pr = { event_name: 'pull_request', ref: 'refs/pull/1/merge', run_id: 1 };
  const rust = { language: 'rust' };
  assert.equal(group(pr, rust), group({ ...pr, run_id: 2 }, rust));
  assert.notEqual(group(pr, rust), group({ ...pr, ref: 'refs/pull/2/merge' }, rust));
  assert.notEqual(group(pr, rust), group(pr, { language: 'python' }));
  for (const event of ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']) {
    const github = { ...pr, event_name: event, ref: event === 'pull_request' ? pr.ref : 'refs/heads/main' };
    const cancel = new Function('github', `return (${concurrency['cancel-in-progress'].slice(3, -2)});`)(github);
    assert.equal(cancel, event === 'pull_request');
    if (!cancel) assert.notEqual(group(github, rust), group({ ...github, run_id: 2 }, rust));
  }
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

test('Bun audits both complete locks with the exception confined to isolated release tools', () => {
  const job = security.jobs['bun-audit'];
  assert.equal(job.if, undefined);
  const setup = job.steps.find(step => step.uses?.startsWith('oven-sh/setup-bun@'));
  assert.equal(setup.with['bun-version-file'], '.bun-version');
  const audits = job.steps.filter(step => step.run);
  assert.deepEqual(audits.map(step => [step['working-directory'] ?? '.', step.run]), [
    ['.', 'bun audit --audit-level=high'],
    ['tools/release', 'bun audit --audit-level=high --ignore=GHSA-vfj7-8cjw-p6xm'],
  ]);
  assert.equal(security.jobs.verify.steps[0].env.BUN_AUDIT_RESULT, '${{ needs.bun-audit.result }}');
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
  assert.deepEqual(gate.needs, ['codeql', 'dependency-review', 'bun-audit']);
  for (const event of ['pull_request', 'merge_group', 'push', 'schedule', 'workflow_dispatch']) {
    for (const scans of outcomes) for (const review of outcomes) for (const audit of outcomes) {
      const applicable = event === 'pull_request' || event === 'merge_group';
      assert.equal(succeeds(gate.steps[0].run, {
        EVENT_NAME: event, CODEQL_RESULT: scans, DEPENDENCY_RESULT: review, BUN_AUDIT_RESULT: audit,
      }), scans === 'success' && audit === 'success' && review === (applicable ? 'success' : 'skipped'));
    }
  }
});

test('immutable third-party actions and scan permissions preserve the release trust boundary', () => {
  for (const workflow of [desktop, release, security, autoMerge]) {
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    for (const job of Object.values(workflow.jobs)) {
      assert.ok(job.uses || job['timeout-minutes'] > 0);
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('./')) assert.equal(step.uses, './.github/actions/linux-dependencies');
        else if (step.uses) {
          assert.match(step.uses, /^(actions|github)\//.test(step.uses)
            ? /@v\d+\.\d+\.\d+$/ : /@[a-f0-9]{40}$/);
        }
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
    ['bun', '/'], ['bun', '/tools/release'], ['cargo', '/src-tauri'], ['github-actions', '/'],
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
  const root = Bun.JSONC.parse(await readFile(new URL('../../bun.lock', import.meta.url), 'utf8'));
  for (const path of Object.keys(root.packages)) {
    assert.doesNotMatch(path, /(?:^|\/)(?:braces|micromatch)(?:\/|$)/, path);
    assert.doesNotMatch(path, /(?:^|\/)@semantic-release\//, path);
  }
  const manifest = JSON.parse(await readFile(new URL('../../tools/release/package.json', import.meta.url), 'utf8'));
  assert.equal(manifest.dependencies, undefined);
  assert.deepEqual(Object.keys(manifest.devDependencies).sort(), [
    '@semantic-release/commit-analyzer', '@semantic-release/release-notes-generator',
    'conventional-changelog-conventionalcommits', 'effect', 'semver',
  ]);
  assert.equal(manifest.overrides['conventional-changelog-writer'], '9.2.1');
  const lock = Bun.JSONC.parse(await readFile(new URL('../../tools/release/bun.lock', import.meta.url), 'utf8'));
  assert.equal(manifest.devDependencies.effect, root.workspaces[''].dependencies.effect);
  assert.deepEqual(lock.packages.effect[2], {}, 'Effect must add no runtime dependency to the isolated tools graph');
  assert.equal(root.packages.remeda, undefined);
  assert.equal(root.packages.yaml, undefined);
  assert.equal(lock.packages.remeda, undefined);
  for (const path of Object.keys(lock.packages)) {
    assert.doesNotMatch(path, /(?:^|\/)(?:semantic-release|@semantic-release\/(?:npm|github|git))(?:\/|$)/, path);
  }
  const config = Bun.TOML.parse(await readFile(new URL('../../tools/release/bunfig.toml', import.meta.url), 'utf8'));
  assert.equal(config.install.peer, false);
  assert.equal(config.run.bun, true);
});

test('required quality checks execute the installed official-engine zero-braces guard', async () => {
  const guard = await readFile(new URL('../release/semantic-release-plan-tests.mjs', import.meta.url), 'utf8');
  assert.ok(guard.includes('official engines never call vulnerable braces walkers and use only trusted matcher patterns'));
  const quality = desktop.jobs.quality.steps.map(step => step.run ?? '').join('\n');
  assert.ok(quality.includes('bun run check'));
  const { verificationPlan } = await import('./check.mjs');
  const plan = await verificationPlan();
  const install = plan.findIndex(step => step.tool === 'bun' && step.args.join(' ').startsWith('install --cwd tools/release --frozen-lockfile'));
  const tests = plan.findIndex(step => step.tool === 'bun' && step.args.includes('./scripts/release/semantic-release-plan-tests.mjs'));
  assert.ok(install >= 0 && tests > install);
  assert.deepEqual(desktop.jobs.verify.needs, ['quality', 'security']);
  assert.equal(desktop.jobs.release.needs, 'verify');
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { verificationPlan, invocation, executePlan } from './check.mjs';
import { ProcessExecutionError, runLoggedProcess } from './process-diagnostics.mjs';
import { BUN_VERSION } from './release-core.mjs';

test('the local, hosted, package-manager and release runtime pins agree', async () => {
  assert.equal((await readFile(new URL('../.bun-version', import.meta.url), 'utf8')).trim(), BUN_VERSION);
  for (const name of ['../package.json', '../tools/release/package.json']) {
    const pkg = JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
    assert.equal(pkg.packageManager, `bun@${BUN_VERSION}`);
  }
});

test('source verification installs policy tools before script checks and covers both Rust feature configurations', async () => {
  const plan = await verificationPlan('darwin');
  assert.deepEqual(plan[0].args, ['install', '--cwd', 'tools/release', '--frozen-lockfile', '--ignore-scripts']);
  assert.ok(plan[0].args.includes('--ignore-scripts'));
  assert.deepEqual(plan[1].args, ['run', 'typecheck:release']);
  const scripts = plan.find(step => step.report === 'scripts.log');
  assert.equal(scripts.tool, 'bun');
  const expected = (await readdir(new URL('./', import.meta.url)))
    .filter(name => name.endsWith('-tests.mjs')).sort().map(name => `./scripts/${name}`);
  assert.deepEqual(scripts.args, ['test', '--timeout', '120000', ...expected]);
  const cargo = plan.filter(step => step.tool === 'cargo' && step.args[0] !== 'fmt');
  assert.equal(cargo.length, 4);
  for (const step of cargo) assert.ok(step.args.includes('--locked'));
  assert.equal(cargo.filter(step => step.args.includes('ci-smoke')).length, 2);
  for (const step of cargo.filter(step => step.args[0] === 'clippy')) assert.ok(step.args.includes('--all-targets'));
  assert.ok(plan.some(step => step.args.includes('--check')));
  assert.ok(plan.some(step => step.args.includes('catalog_logic_test.py')));
  assert.ok(plan.some(step => step.args.includes('scripts/release-public-zip-tests.py')));
});

test('platform-specific checks remain explicit, and Bun uses its shell-free executable on Windows', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const plan = await verificationPlan(platform);
    const glib = plan.find(step => step.args[0] === 'vendor/glib/verify.py');
    assert.equal(glib.args.includes('--test'), platform === 'linux');
    assert.equal(plan.some(step => step.args.includes('release_test.py')), platform === 'darwin');
  }
  const command = invocation({ tool: 'bun', args: ['install', '--frozen-lockfile'] }, {}, 'win32');
  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, ['install', '--frozen-lockfile']);
  assert.equal(invocation({ tool: 'python', args: [] }, {}, 'win32').file, 'python');
  const config = Bun.TOML.parse(await readFile(new URL('../bunfig.toml', import.meta.url), 'utf8'));
  assert.equal(config.run.bun, true);
});

test('verification stops at the first failure and retains the failing step report', async () => {
  const ran = [];
  const steps = ['first', 'failure', 'unrun'].map(name => ({ tool: 'bun', args: [name], report: `${name}.log` }));
  await assert.rejects(executePlan(steps, async (file, args, options) => {
    ran.push(args[0]);
    assert.equal(file, process.execPath);
    assert.ok(options.report.endsWith(`${args[0]}.log`));
    if (args[0] === 'failure') throw new Error('controlled failure');
  }), /controlled failure/);
  assert.deepEqual(ran, ['first', 'failure']);
});

test('verification awaits each real child and propagates its typed failure before any later step', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-check-outcomes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const steps = [
    { tool: 'bun', args: ['-e', 'setTimeout(() => console.log("completed first"), 10);'], report: 'first.log' },
    { tool: 'bun', args: ['-e', 'console.error("failed second"); process.exitCode = 7;'], report: 'failure.log' },
    { tool: 'bun', args: ['-e', 'console.log("unrun");'], report: 'unrun.log' },
  ];
  const ran = [];
  let active = false, failure;
  const discard = () => new Writable({ write(_chunk, _encoding, done) { done(); } });
  await assert.rejects(executePlan(steps, async (file, args, options) => {
    assert.equal(active, false);
    active = true;
    ran.push(options.report);
    if (ran.length === 2) assert.match(await readFile(join(directory, 'reports', 'first.log'), 'utf8'), /completed first[\s\S]*exit=0/);
    try { return await runLoggedProcess(file, args, { ...options, stdout: discard(), stderr: discard() }); }
    catch (error) { failure = error; throw error; }
    finally { active = false; }
  }, directory), error => {
    assert.equal(error, failure);
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.message, `Process exited with 7. See ${join(directory, 'reports', 'failure.log')}.`);
    assert.deepEqual(error.failure, { kind: 'exit', exitCode: 7 });
    return true;
  });
  assert.equal(active, false);
  assert.deepEqual(ran, [join(directory, 'reports', 'first.log'), join(directory, 'reports', 'failure.log')]);
  assert.deepEqual((await readdir(join(directory, 'reports'))).sort(), ['failure.log', 'first.log']);
  assert.match(await readFile(join(directory, 'reports', 'failure.log'), 'utf8'), /failed second[\s\S]*exit=7/);
});

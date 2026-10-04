import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationPlan, invocation, executePlan } from './check.mjs';

test('source verification installs policy tools before script checks and covers both Rust feature configurations', async () => {
  const plan = await verificationPlan('darwin');
  assert.deepEqual(plan[0].args.slice(0, 3), ['ci', '--prefix', 'tools/release']);
  assert.ok(plan[0].args.includes('--ignore-scripts'));
  assert.deepEqual(plan[1].args, ['run', 'typecheck:release']);
  const scripts = plan.find(step => step.tool === 'node');
  assert.ok(scripts.args.includes('scripts/release-tests.mjs'));
  assert.ok(scripts.args.includes('scripts/security-tests.mjs'));
  const cargo = plan.filter(step => step.tool === 'cargo' && step.args[0] !== 'fmt');
  assert.equal(cargo.length, 4);
  for (const step of cargo) assert.ok(step.args.includes('--locked'));
  assert.equal(cargo.filter(step => step.args.includes('ci-smoke')).length, 2);
  for (const step of cargo.filter(step => step.args[0] === 'clippy')) assert.ok(step.args.includes('--all-targets'));
  assert.ok(plan.some(step => step.args.includes('--check')));
});

test('platform-specific checks remain explicit, and Windows npm uses a shell-free JS entry point', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const plan = await verificationPlan(platform);
    const glib = plan.find(step => step.args[0] === 'vendor/glib/verify.py');
    assert.equal(glib.args.includes('--test'), platform === 'linux');
    assert.equal(plan.some(step => step.args.includes('release_test.py')), platform === 'darwin');
  }
  const command = invocation({ tool: 'npm', args: ['ci'] }, { npm_execpath: 'C:\\Program Files\\nodejs\\npm-cli.js' }, 'win32');
  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, ['C:\\Program Files\\nodejs\\npm-cli.js', 'ci']);
  assert.equal(invocation({ tool: 'python', args: [] }, {}, 'win32').file, 'python');
  assert.throws(() => invocation({ tool: 'npm', args: [] }, {}), /npm run check/);
});

test('verification stops at the first failure and retains the failing step report', async () => {
  const ran = [];
  const steps = ['first', 'failure', 'unrun'].map(name => ({ tool: 'node', args: [name], report: `${name}.log` }));
  await assert.rejects(executePlan(steps, async (file, args, options) => {
    ran.push(args[0]);
    assert.equal(file, process.execPath);
    assert.ok(options.report.endsWith(`${args[0]}.log`));
    if (args[0] === 'failure') throw new Error('controlled failure');
  }), /controlled failure/);
  assert.deepEqual(ran, ['first', 'failure']);
});

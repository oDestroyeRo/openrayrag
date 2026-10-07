import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Writable } from 'node:stream';
import { verificationPlan, invocation, executePlan } from './check.mjs';
import { ProcessExecutionError, runLoggedProcess } from '../shared/process-diagnostics.mjs';
import { BUN_VERSION } from '../release/release-core.mjs';

test('the local, hosted, package-manager and release runtime pins agree', async () => {
  assert.equal(
    (await readFile(new URL('../../.bun-version', import.meta.url), 'utf8')).trim(),
    BUN_VERSION,
  );
  for (const name of ['../../package.json', '../../tools/release/package.json']) {
    const pkg = JSON.parse(await readFile(new URL(name, import.meta.url), 'utf8'));
    assert.equal(pkg.packageManager, `bun@${BUN_VERSION}`);
  }
});

test('source verification prepares tooling and checks types, lint and formatting before script checks and both Rust configurations', async () => {
  const plan = await verificationPlan('darwin');
  assert.deepEqual(
    plan.slice(0, 5).map((step) => ({ tool: step.tool, args: step.args })),
    [
      {
        tool: 'bun',
        args: ['install', '--cwd', 'tools/release', '--frozen-lockfile', '--ignore-scripts'],
      },
      { tool: 'bun', args: ['run', 'tooling:prepare'] },
      { tool: 'bun', args: ['run', 'typecheck:release'] },
      { tool: 'bun', args: ['run', 'lint'] },
      { tool: 'bun', args: ['run', 'fmt:check'] },
    ],
  );
  assert.ok(plan[0].args.includes('--ignore-scripts'));
  const scripts = plan.find((step) => step.report === 'scripts.log');
  assert.equal(scripts.tool, 'bun');
  const expected = (await readdir(new URL('../', import.meta.url), { recursive: true }))
    .filter((name) => name.endsWith('-tests.mjs'))
    .map((name) => name.replaceAll('\\', '/'))
    .sort()
    .map((name) => `./scripts/${name}`);
  assert.deepEqual(scripts.args, ['test', '--timeout', '120000', ...expected]);
  const cargo = plan.filter((step) => step.tool === 'cargo' && step.args[0] !== 'fmt');
  assert.equal(cargo.length, 4);
  for (const step of cargo) assert.ok(step.args.includes('--locked'));
  assert.equal(cargo.filter((step) => step.args.includes('ci-smoke')).length, 2);
  for (const step of cargo.filter((step) => step.args[0] === 'clippy'))
    assert.ok(step.args.includes('--all-targets'));
  assert.ok(plan.some((step) => step.args.includes('--check')));
  assert.ok(plan.some((step) => step.args.includes('catalog_logic_test.py')));
  assert.ok(plan.some((step) => step.args.includes('scripts/release/release-public-zip-tests.py')));
});

test('platform-specific checks remain explicit, and Bun uses its shell-free executable on Windows', async () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const plan = await verificationPlan(platform);
    const glib = plan.find((step) => step.args[0] === 'vendor/glib/verify.py');
    assert.equal(glib.args.includes('--test'), platform === 'linux');
    assert.equal(glib.cargoTargetDirectory, platform === 'linux' ? 'src-tauri/target' : undefined);
    assert.ok(plan.every((step) => step === glib || step.cargoTargetDirectory === undefined));
    assert.equal(
      plan.some((step) => step.args.includes('release_test.py')),
      platform === 'darwin',
    );
  }
  const command = invocation({ tool: 'bun', args: ['install', '--frozen-lockfile'] }, {}, 'win32');
  assert.equal(command.file, process.execPath);
  assert.deepEqual(command.args, ['install', '--frozen-lockfile']);
  assert.equal(invocation({ tool: 'python', args: [] }, {}, 'win32').file, 'python');
  const config = Bun.TOML.parse(
    await readFile(new URL('../../bunfig.toml', import.meta.url), 'utf8'),
  );
  assert.equal(config.run.bun, true);
});

test('GLib dependency reuse resolves against the checkout without changing later steps or explicit caller targets', async () => {
  const plan = await verificationPlan('linux');
  const glib = plan.find((step) => step.report === 'glib.log');
  const native = plan.find((step) => step.report === 'native.log');
  const directory = resolve(tmpdir(), 'rayrag-target-fixture');
  for (const inherited of [undefined, '/caller/target']) {
    const env = inherited === undefined ? {} : { CARGO_TARGET_DIR: inherited };
    const before = { ...env },
      observed = [];
    await executePlan(
      [glib, native],
      async (_file, _args, options) => {
        observed.push(options.env.CARGO_TARGET_DIR);
        assert.equal(options.env.PYTHONDONTWRITEBYTECODE, '1');
      },
      directory,
      env,
    );
    assert.deepEqual(observed, [inherited ?? join(directory, 'src-tauri', 'target'), inherited]);
    assert.deepEqual(env, before);
  }
});

test('verification stops at the first failure and retains the failing step report', async () => {
  const ran = [];
  const steps = ['first', 'failure', 'unrun'].map((name) => ({
    tool: 'bun',
    args: [name],
    report: `${name}.log`,
  }));
  await assert.rejects(
    executePlan(steps, async (file, args, options) => {
      ran.push(args[0]);
      assert.equal(file, process.execPath);
      assert.ok(options.report.endsWith(`${args[0]}.log`));
      if (args[0] === 'failure') throw new Error('controlled failure');
    }),
    /controlled failure/,
  );
  assert.deepEqual(ran, ['first', 'failure']);
});

test('verification awaits each real child and propagates its typed failure before any later step', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-check-outcomes-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const steps = [
    {
      tool: 'bun',
      args: ['-e', 'setTimeout(() => console.log("completed first"), 10);'],
      report: 'first.log',
    },
    {
      tool: 'bun',
      args: ['-e', 'console.error("failed second"); process.exitCode = 7;'],
      report: 'failure.log',
    },
    { tool: 'bun', args: ['-e', 'console.log("unrun");'], report: 'unrun.log' },
  ];
  const ran = [];
  let active = false,
    failure;
  const discard = () =>
    new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
  await assert.rejects(
    executePlan(
      steps,
      async (file, args, options) => {
        assert.equal(active, false);
        active = true;
        ran.push(options.report);
        if (ran.length === 2)
          assert.match(
            await readFile(join(directory, 'reports', 'first.log'), 'utf8'),
            /completed first[\s\S]*exit=0/,
          );
        try {
          return await runLoggedProcess(file, args, {
            ...options,
            stdout: discard(),
            stderr: discard(),
          });
        } catch (error) {
          failure = error;
          throw error;
        } finally {
          active = false;
        }
      },
      directory,
    ),
    (error) => {
      assert.equal(error, failure);
      assert.ok(error instanceof ProcessExecutionError);
      assert.equal(
        error.message,
        `Process exited with 7. See ${join(directory, 'reports', 'failure.log')}.`,
      );
      assert.deepEqual(error.failure, { kind: 'exit', exitCode: 7 });
      return true;
    },
  );
  assert.equal(active, false);
  assert.deepEqual(ran, [
    join(directory, 'reports', 'first.log'),
    join(directory, 'reports', 'failure.log'),
  ]);
  assert.deepEqual((await readdir(join(directory, 'reports'))).sort(), [
    'failure.log',
    'first.log',
  ]);
  assert.match(
    await readFile(join(directory, 'reports', 'failure.log'), 'utf8'),
    /failed second[\s\S]*exit=7/,
  );
});

test('verification discovers nested module tests once and skips generated dependency folders', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-nested-checks-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  for (const name of [
    'quality/a-tests.mjs',
    'catalogs/nested/z-tests.mjs',
    'shared/not-a-test.mjs',
    'node_modules/excluded-tests.mjs',
    'catalogs/__pycache__/excluded-tests.mjs',
  ]) {
    await mkdir(join(directory, 'scripts', name, '..'), { recursive: true });
    await writeFile(join(directory, 'scripts', name), '');
  }
  const step = (await verificationPlan('darwin', directory)).find(
    (step) => step.report === 'scripts.log',
  );
  assert.deepEqual(step.args, [
    'test',
    '--timeout',
    '120000',
    './scripts/catalogs/nested/z-tests.mjs',
    './scripts/quality/a-tests.mjs',
  ]);
});

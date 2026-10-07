import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { runStage, smokeLaunch, validateResult, verifyReopened } from './native-smoke.mjs';

const token = '00000000-0000-4000-8000-000000000001';
const result = () => ({
  protocol: 1,
  stage: 'save',
  token,
  passed: true,
  checks: ['webview-boot', 'offline-controller', 'native-settings-ipc', 'window-close-save'],
  document: {
    version: 1,
    revision: 2,
    selectedProfileId: null,
    settings: { radius: 17, loot: false, route_step: 7 },
  },
});

test('parallel Linux packages have independent GTK sessions and WebKit stores while reopening keeps its context', () => {
  const env = { DISPLAY: ':99', XDG_DATA_HOME: '/shared/data', XDG_CACHE_HOME: '/shared/cache' };
  const binary = join(tmpdir(), 'first-package'),
    root = join(tmpdir(), 'first-smoke');
  const first = smokeLaunch(binary, root, 'linux', env);
  const second = smokeLaunch(
    join(tmpdir(), 'second-package'),
    join(tmpdir(), 'second-smoke'),
    'linux',
    env,
  );
  assert.equal(first.binary, 'dbus-run-session');
  assert.deepEqual(first.prefixArgs, ['--', resolve(binary)]);
  assert.equal(first.env.XDG_DATA_HOME, join(root, 'xdg-data'));
  assert.equal(first.env.XDG_CACHE_HOME, join(root, 'xdg-cache'));
  assert.equal(first.env.DISPLAY, ':99');
  assert.notEqual(first.env.XDG_DATA_HOME, second.env.XDG_DATA_HOME);
  assert.notEqual(first.env.XDG_CACHE_HOME, second.env.XDG_CACHE_HOME);
  assert.deepEqual(smokeLaunch(binary, root, 'linux', env), first);
  assert.equal(env.XDG_DATA_HOME, '/shared/data');
  for (const platform of ['darwin', 'win32']) {
    assert.deepEqual(smokeLaunch(binary, root, platform, env), {
      binary: resolve(binary),
      prefixArgs: [],
      env,
    });
  }
});

test('a passing exit is insufficient without all packaged assertions and current settings', () => {
  assert.doesNotThrow(() => validateResult(result(), 'save', token));
  for (const mutate of [
    (r) => {
      r.token = 'another-run';
    },
    (r) => {
      r.stage = 'reopen';
    },
    (r) => {
      r.passed = false;
    },
    (r) => {
      r.checks.pop();
    },
    (r) => {
      r.document.settings.radius = 12;
    },
    (r) => {
      r.document.password = 'synthetic';
    },
  ]) {
    const invalid = result();
    mutate(invalid);
    assert.throws(() => validateResult(invalid, 'save', token));
  }
});

test('reopening may confirm a new revision but must preserve every saved setting', () => {
  const saved = result().document;
  const reopened = structuredClone(saved);
  reopened.revision++;
  assert.doesNotThrow(() => verifyReopened(saved, reopened));
  reopened.settings.route_step = 10;
  assert.throws(() => verifyReopened(saved, reopened));
  const stale = structuredClone(saved);
  stale.revision--;
  assert.throws(() => verifyReopened(saved, stale));
  const incomplete = result();
  incomplete.stage = 'reopen';
  assert.throws(() => validateResult(incomplete, 'reopen', token));
});

test('runner requires the child result and bounds a stuck native process', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayrag-smoke-runner-test-'));
  const data = join(root, 'data');
  await mkdir(data);
  const fixture = join(root, 'fixture.mjs'),
    output = join(root, 'result.json');
  try {
    await writeFile(
      fixture,
      "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.RAYRAG_CI_RESULT, process.env.FIXTURE_RESULT);\n",
    );
    const options = {
      root,
      data,
      result: output,
      token,
      prefixArgs: [fixture],
      env: { ...process.env, FIXTURE_RESULT: JSON.stringify(result()) },
    };
    assert.equal((await runStage(process.execPath, 'save', options)).passed, true);
    await rm(output);
    await writeFile(fixture, 'process.exit(0);\n');
    await assert.rejects(runStage(process.execPath, 'save', options), /ENOENT/);
    await writeFile(fixture, 'setInterval(() => {}, 1000);\n');
    await assert.rejects(
      runStage(process.execPath, 'save', { ...options, timeoutMs: 80 }),
      /timed out/,
    );
    await writeFile(fixture, 'process.exit(9);\n');
    await assert.rejects(runStage(process.execPath, 'save', options), /exited with 9/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('a failed native child retains its matching diagnostic without accepting stale or passing reports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayrag-smoke-failure-test-'));
  const fixture = join(root, 'failure.mjs'),
    output = join(root, 'result.json');
  try {
    await writeFile(
      fixture,
      "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.RAYRAG_CI_RESULT, process.env.FIXTURE_RESULT); process.exit(1);\n",
    );
    const failure = {
      protocol: 1,
      stage: 'save',
      token,
      passed: false,
      message: 'Packaged WebView smoke timed out',
      milestone: 'main-webview-building',
    };
    const run = (outcome) =>
      runStage(process.execPath, 'save', {
        root,
        data: root,
        result: output,
        token,
        prefixArgs: [fixture],
        env: { ...process.env, FIXTURE_RESULT: JSON.stringify(outcome) },
      });
    await assert.rejects(run(failure), (error) => {
      assert.match(error.message, /exited with 1/);
      assert.match(error.message, /Native result: Packaged WebView smoke timed out/);
      assert.match(error.message, /Milestone: main-webview-building/);
      assert.ok(!error.message.includes(token));
      return true;
    });
    for (const outcome of [
      { ...failure, token: 'another-run' },
      { ...failure, stage: 'reopen' },
      { ...failure, passed: true },
      { ...failure, message: 'x'.repeat(20_000) },
    ]) {
      await assert.rejects(run(outcome), (error) => {
        assert.match(error.message, /exited with 1/);
        assert.ok(!error.message.includes('Native result:'));
        return true;
      });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'a timed-out DBus session terminates its application before cleanup',
  {
    skip:
      process.platform === 'win32' || spawnSync('dbus-run-session', ['--help']).error !== undefined,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'rayrag-smoke-session-test-'));
    const fixture = join(root, 'hanging-app.mjs'),
      pidFile = join(root, 'app.pid');
    const busConfig = join(root, 'session.conf');
    let pid;
    try {
      await writeFile(
        fixture,
        "import {writeFileSync} from 'node:fs'; writeFileSync(process.env.FIXTURE_PID, String(process.pid)); setInterval(() => {}, 1000);\n",
      );
      await writeFile(
        busConfig,
        '<busconfig><type>session</type><listen>unix:tmpdir=/tmp</listen><policy context="default"><allow send_destination="*"/><allow own="*"/></policy></busconfig>\n',
      );
      await assert.rejects(
        runStage('dbus-run-session', 'save', {
          root,
          data: root,
          result: join(root, 'result.json'),
          token,
          timeoutMs: 2_000,
          prefixArgs: [`--config-file=${busConfig}`, '--', process.execPath, fixture],
          env: { ...process.env, FIXTURE_PID: pidFile },
        }),
        /timed out/,
      );
      pid = Number(await readFile(pidFile, 'utf8'));
      assert.ok(Number.isSafeInteger(pid) && pid > 0);
      // Linux can retain a killed orphan as a zombie until PID 1 reaps it.
      if (process.platform === 'linux') {
        const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch((error) => {
          if (error.code !== 'ENOENT') throw error;
          return '';
        });
        assert.ok(stat === '' || /\) Z /.test(stat), 'wrapped application is still running');
      } else assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' });
    } finally {
      if (pid) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch (error) {
          // The smoke test must fail if its fixture process cannot be retired.
          // oxlint-disable-next-line eslint/no-unsafe-finally
          if (error.code !== 'ESRCH') throw error;
        }
      }
      await rm(root, { recursive: true, force: true });
    }
  },
);

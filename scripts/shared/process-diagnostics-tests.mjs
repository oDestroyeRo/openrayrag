import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { Writable } from 'node:stream';
import { EventEmitter } from 'node:events';
import { isFailure, isSuccess } from 'effect/Result';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  ProcessExecutionError,
  runLoggedProcess,
  smokePackagingEnvironment,
} from './process-diagnostics.mjs';
import {
  classifyProcessOutcome,
  classifyProcessResult,
  processErrorCode,
} from './process-outcome-policy.mjs';

function collectedOutput() {
  const chunks = [];
  return {
    stream: new Writable({
      write(chunk, _encoding, done) {
        chunks.push(Buffer.from(chunk));
        done();
      },
    }),
    text: () => Buffer.concat(chunks).toString(),
  };
}

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-process-diagnostics-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const report = join(folder, 'reports', 'package.log');
  const out = collectedOutput(),
    err = collectedOutput();
  return { folder, report, out, err, options: { report, stdout: out.stream, stderr: err.stream } };
}

function processFailure(failure, message) {
  return (error) => {
    assert.ok(error instanceof ProcessExecutionError);
    assert.equal(error.message, message);
    assert.deepEqual(error.failure, failure);
    assert.ok(Object.isFrozen(error.failure));
    assert.equal(error.cause, undefined);
    return true;
  };
}

test('pure process outcomes preserve error precedence and distinguish signals, exits and success', () => {
  const observations = [
    [
      { failureCode: null, exitCode: 0, signal: null, discardedBytes: 24 },
      { kind: 'success', exitCode: 0, signal: null, discardedBytes: 24 },
    ],
    [
      { failureCode: null, exitCode: 7, signal: null, discardedBytes: 0 },
      { kind: 'exit', exitCode: 7 },
    ],
    [
      { failureCode: null, exitCode: null, signal: 'SIGTERM', discardedBytes: 0 },
      { kind: 'signal', signal: 'SIGTERM' },
    ],
    [
      { failureCode: null, exitCode: null, signal: null, discardedBytes: 0 },
      { kind: 'exit', exitCode: null },
    ],
    [
      { failureCode: 'ENOENT', exitCode: 0, signal: 'SIGTERM', discardedBytes: 0 },
      { kind: 'process-error', code: 'ENOENT' },
    ],
    [
      { failureCode: 'synthetic-sensitive-error', exitCode: 7, signal: null, discardedBytes: 0 },
      { kind: 'process-error', code: 'unknown' },
    ],
    [
      { failureCode: null, exitCode: 0, signal: 'SIGTERM', discardedBytes: 0 },
      { kind: 'success', exitCode: 0, signal: 'SIGTERM', discardedBytes: 0 },
    ],
  ];
  for (const [observation, expected] of observations) {
    Object.freeze(observation);
    assert.deepEqual(classifyProcessOutcome(observation), expected);
    assert.deepEqual(classifyProcessOutcome(observation), expected);
    const result = classifyProcessResult(observation);
    if (expected.kind === 'success') {
      assert.ok(isSuccess(result));
      assert.deepEqual(result.success, expected);
    } else {
      assert.ok(isFailure(result));
      assert.deepEqual(result.failure, expected);
    }
  }
  assert.equal(
    processErrorCode({
      toString() {
        throw new Error('Must not coerce raw errors.');
      },
    }),
    'unknown',
  );
  assert.equal(processErrorCode(7), '7');
  assert.equal(processErrorCode(0), 'unknown');
});

test('typed process failures detach only safe scalar fields from their input', () => {
  const secret = 'synthetic-sensitive-error-context';
  const raw = {
    kind: 'process-error',
    code: 'EPIPE',
    cause: new Error(secret),
    args: [secret],
    env: { SECRET: secret },
    stderr: secret,
  };
  const error = new ProcessExecutionError(raw, 'reports/check.log');
  raw.code = 'ENOENT';
  assert.equal(error.name, 'ProcessExecutionError');
  assert.equal(
    error.message,
    'Process launch or diagnostic output failed (EPIPE). See reports/check.log.',
  );
  assert.deepEqual(error.failure, { kind: 'process-error', code: 'EPIPE' });
  assert.notEqual(error.failure, raw);
  assert.ok(Object.isFrozen(error.failure));
  for (const key of ['cause', 'args', 'env', 'stderr']) assert.equal(error[key], undefined);
  assert.doesNotMatch(
    `${error.stack}\n${JSON.stringify(error)}`,
    /synthetic-sensitive-error-context/,
  );
  assert.deepEqual(new ProcessExecutionError({ ...raw, code: secret }, 'report.log').failure, {
    kind: 'process-error',
    code: 'unknown',
  });
});

test('compiler rejects invalid outcome variants and values, including success as a failure', async (t) => {
  const { folder } = await fixture(t);
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const policy = JSON.stringify(
    fileURLToPath(new URL('./process-outcome-policy.mjs', import.meta.url)).replaceAll('\\', '/'),
  );
  const runner = JSON.stringify(
    fileURLToPath(new URL('./process-diagnostics.mjs', import.meta.url)).replaceAll('\\', '/'),
  );
  const source = join(folder, 'invalid-process-outcomes.mjs');
  await writeFile(
    source,
    `
import { classifyProcessOutcome } from ${policy};
import { ProcessExecutionError } from ${runner};
/** @type {import(${policy}).ProcessOutcome} */
const unsupported = { kind: 'retry' };
classifyProcessOutcome({ failureCode: null, exitCode: '7', signal: null, discardedBytes: 0 });
/** @type {import(${policy}).ProcessSuccess} */
const success = { kind: 'success', exitCode: 0, signal: null, discardedBytes: 0 };
new ProcessExecutionError(success, 'report.log');
`,
  );
  const project = join(folder, 'tsconfig.json');
  await writeFile(
    project,
    JSON.stringify({
      extends: join(root, 'tsconfig.release.json'),
      compilerOptions: { typeRoots: [join(root, 'node_modules', '@types')] },
      files: [source],
    }),
  );
  const compiler = join(
    dirname(createRequire(import.meta.url).resolve('typescript/package.json')),
    'bin',
    'tsc',
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [compiler, '--project', project, '--pretty', 'false'], {
      cwd: root,
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
    }),
    (error) => {
      const output = error.stdout + error.stderr;
      assert.match(output, /Type '"retry"' is not assignable/);
      assert.match(output, /Type 'string' is not assignable to type 'number'/);
      assert.match(output, /Type '"success"' is not assignable/);
      assert.equal((output.match(/error TS/g) ?? []).length, 3, output);
      return true;
    },
  );
});

test('real child output streams to its consoles and a retained bounded log on success', async (t) => {
  const { report, out, err, options } = await fixture(t);
  const outcome = await runLoggedProcess(
    process.execPath,
    ['-e', 'console.log("built"); console.error("diagnostic");'],
    options,
  );
  assert.equal(out.text(), 'built\n');
  assert.equal(err.text(), 'diagnostic\n');
  assert.deepEqual(outcome, { exitCode: 0, signal: null, discardedBytes: 0 });
  const log = await readFile(report, 'utf8');
  assert.match(log, /built/);
  assert.match(log, /diagnostic/);
  assert.match(log, /process status: exit=0; signal=none/);
  if (process.platform !== 'win32') assert.equal((await stat(report)).mode & 0o777, 0o600);
});

test('nonzero exit and launch failure retain diagnostics and identify their statuses', async (t) => {
  const { folder, report, options } = await fixture(t);
  await assert.rejects(
    runLoggedProcess(
      process.execPath,
      ['-e', 'console.error("failed to attach image"); process.exitCode = 7;'],
      options,
    ),
    processFailure({ kind: 'exit', exitCode: 7 }, `Process exited with 7. See ${report}.`),
  );
  assert.match(await readFile(report, 'utf8'), /failed to attach image[\s\S]*exit=7/);
  await assert.rejects(
    runLoggedProcess(join(folder, 'absent-executable'), [], options),
    processFailure(
      { kind: 'process-error', code: 'ENOENT' },
      `Process launch or diagnostic output failed (ENOENT). See ${report}.`,
    ),
  );
  assert.equal(await readFile(report, 'utf8'), '\n[process error: ENOENT]\n');
  assert.deepEqual(await readdir(join(folder, 'reports')), ['package.log']);
});

test(
  'signal termination is distinct from an exit status',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { report, options } = await fixture(t);
    await assert.rejects(
      runLoggedProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM");'], options),
      processFailure(
        { kind: 'signal', signal: 'SIGTERM' },
        `Process exited with SIGTERM. See ${report}.`,
      ),
    );
    assert.match(await readFile(report, 'utf8'), /exit=null; signal=SIGTERM/);
  },
);

test('large output keeps memory and report bounded while slow consoles receive every byte', async (t) => {
  const { report, options } = await fixture(t);
  let received = 0;
  options.stdout = new Writable({
    highWaterMark: 64,
    write(chunk, _encoding, done) {
      received += chunk.length;
      setImmediate(done);
    },
  });
  const script =
    'import {once} from "node:events"; for(let i=0;i<256;i++) { if(!process.stdout.write("x".repeat(8192))) await once(process.stdout,"drain"); } process.stdout.write("FINAL PACKAGING ERROR");';
  const result = await runLoggedProcess(process.execPath, ['--input-type=module', '-e', script], {
    ...options,
    maxBytes: 1024,
  });
  assert.equal(received, 256 * 8192 + 'FINAL PACKAGING ERROR'.length);
  assert.ok(result.discardedBytes > 0);
  const bytes = await readFile(report);
  assert.ok(bytes.length <= 1024);
  const log = bytes.toString('utf8');
  assert.match(log, /^x+/);
  assert.match(log, /diagnostic output truncated/);
  assert.match(log, /FINAL PACKAGING ERROR[\s\S]*exit=0/);
});

test(
  'reruns replace only the report entry and never follow an existing link',
  { skip: process.platform === 'win32' },
  async (t) => {
    const { folder, report, options } = await fixture(t);
    await runLoggedProcess(process.execPath, ['-e', 'console.log("first");'], options);
    const outside = join(folder, 'preserved');
    await writeFile(outside, 'preserved');
    await rm(report);
    await symlink(outside, report);
    await runLoggedProcess(process.execPath, ['-e', 'console.log("second");'], options);
    assert.equal(await readFile(outside, 'utf8'), 'preserved');
    assert.match(await readFile(report, 'utf8'), /second/);
    assert.deepEqual(await readdir(join(folder, 'reports')), ['package.log']);
  },
);

test('argument metacharacters remain literal without invoking a shell', async (t) => {
  const { out, options } = await fixture(t);
  const argument = 'literal; $(printf injected) & | > `printf injected`';
  await runLoggedProcess(
    process.execPath,
    ['-e', 'console.log(process.argv[1]);', argument],
    options,
  );
  assert.equal(out.text(), `${argument}\n`);
});

test('smoke environment refuses signing inputs without revealing their values', () => {
  for (const key of [
    'TAURI_SIGNING_PRIVATE_KEY',
    'TAURI_SIGNING_PRIVATE_KEY_PASSWORD',
    'APPLE_CERTIFICATE',
    'APPLE_API_KEY_PATH',
    'WINDOWS_CERTIFICATE_PASSWORD',
    'apple_password',
  ]) {
    assert.throws(
      () => smokePackagingEnvironment({ [key]: 'synthetic-sensitive-value' }),
      (error) => error.message === 'Smoke packaging refuses signing credentials.',
    );
  }
});

test('smoke debug child cannot print inherited environment credentials', async (t) => {
  const { report, out, options } = await fixture(t);
  const inherited = {
    ...process.env,
    GITHUB_TOKEN: 'synthetic-github-token',
    GH_TOKEN: 'synthetic-gh-token',
    DATABASE_PASSWORD: 'synthetic-database-password',
    AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret',
    TAURI_SIGNING_PRIVATE_KEY: '',
    TAURI_CLI_VERBOSITY: '0',
    GITHUB_SHA: 'source-sha',
    RUSTUP_HOME: 'rustup-location',
    NO_STRIP: '1',
  };
  const env = smokePackagingEnvironment(inherited);
  assert.equal(env.TAURI_CLI_VERBOSITY, '1');
  assert.equal(env.GITHUB_SHA, 'source-sha');
  assert.equal(env.RUSTUP_HOME, 'rustup-location');
  assert.equal(env.NO_STRIP, '1');
  assert.equal(inherited.TAURI_CLI_VERBOSITY, '0');
  const script =
    'for(const key of ["GITHUB_TOKEN","GH_TOKEN","DATABASE_PASSWORD","AWS_SECRET_ACCESS_KEY","TAURI_SIGNING_PRIVATE_KEY"]) console.log(key + ":" + (process.env[key] ?? "absent")); console.log("debug=" + process.env.TAURI_CLI_VERBOSITY);';
  await runLoggedProcess(process.execPath, ['-e', script], { ...options, env });
  assert.match(out.text(), /debug=1/);
  assert.doesNotMatch(await readFile(report, 'utf8'), /synthetic-(?:github|gh|database|aws)/);
  for (const key of [
    'GITHUB_TOKEN',
    'GH_TOKEN',
    'DATABASE_PASSWORD',
    'AWS_SECRET_ACCESS_KEY',
    'TAURI_SIGNING_PRIVATE_KEY',
  ])
    assert.equal(env[key], undefined);
});

test('diagnostic runner is neutral about environment and never dumps it or arguments', async (t) => {
  const { report, options } = await fixture(t);
  await runLoggedProcess(
    process.execPath,
    [
      '-e',
      'console.log(process.env.TAURI_CLI_VERBOSITY ?? "no-debug");',
      'synthetic-argument-secret',
    ],
    {
      ...options,
      env: { ...process.env, TAURI_CLI_VERBOSITY: '0', TEST_PASSWORD: 'synthetic-env-secret' },
    },
  );
  const log = await readFile(report, 'utf8');
  assert.match(log, /0/);
  assert.doesNotMatch(log, /synthetic-(?:argument|env)-secret/);
});

test('console failure terminates the child and retains a safe diagnostic error', async (t) => {
  const { report, options } = await fixture(t);
  const stdout = new Writable({
    write(_chunk, _encoding, done) {
      const error = new Error('synthetic-sensitive-console-error');
      error.code = 'EPIPE';
      done(error);
    },
  });
  await assert.rejects(
    runLoggedProcess(
      process.execPath,
      ['-e', 'console.log("starting build"); setInterval(() => {}, 1000);'],
      {
        ...options,
        stdout,
        env: { ...process.env, TEST_SECRET: 'synthetic-env-secret' },
      },
    ),
    (error) => {
      processFailure(
        { kind: 'process-error', code: 'EPIPE' },
        `Process launch or diagnostic output failed (EPIPE). See ${report}.`,
      )(error);
      assert.doesNotMatch(
        `${error.stack}\n${JSON.stringify(error)}`,
        /synthetic-(?:sensitive-console-error|env-secret)|starting build|setInterval/,
      );
      return true;
    },
  );
  const log = await readFile(report, 'utf8');
  assert.match(log, /process error: EPIPE/);
  assert.doesNotMatch(log, /synthetic-sensitive-console-error/);
});

test('the first observed console error survives later stream failures and child cancellation', async (t) => {
  const { report, options } = await fixture(t);
  const observed = [];
  const failures = [];
  const failingConsole = (code) =>
    new Writable({
      write(_chunk, _encoding, done) {
        const error = new Error(`synthetic-private-${code}`);
        error.code = code;
        // Let both pipes reach their consoles before either failure kills the child.
        failures.push(() => {
          observed.push(code);
          done(error);
        });
        if (failures.length === 2) for (const fail of failures) fail();
      },
    });
  await assert.rejects(
    runLoggedProcess(
      process.execPath,
      ['-e', 'console.log("out"); console.error("err"); setInterval(() => {}, 1000);'],
      {
        ...options,
        stdout: failingConsole('EPIPE'),
        stderr: failingConsole('EIO'),
      },
    ),
    (error) => {
      assert.equal(observed.length, 2);
      return processFailure(
        { kind: 'process-error', code: observed[0] },
        `Process launch or diagnostic output failed (${observed[0]}). See ${report}.`,
      )(error);
    },
  );
  assert.match(await readFile(report, 'utf8'), new RegExp(`process error: ${observed[0]}`));
});

test('a console throwing undefined remains a failed observation after child cancellation', async (t) => {
  const { report, options } = await fixture(t);
  for (const failure of [
    undefined,
    {
      get code() {
        throw new Error('synthetic-sensitive-code-accessor');
      },
    },
  ]) {
    const stdout = new EventEmitter();
    stdout.write = () => {
      throw failure;
    };
    await assert.rejects(
      runLoggedProcess(
        process.execPath,
        ['-e', 'console.log("starting build"); setInterval(() => {}, 1000);'],
        {
          ...options,
          stdout,
        },
      ),
      (error) => {
        processFailure(
          { kind: 'process-error', code: 'unknown' },
          `Process launch or diagnostic output failed (unknown). See ${report}.`,
        )(error);
        assert.doesNotMatch(
          `${error.stack}\n${JSON.stringify(error)}`,
          /synthetic-sensitive-code-accessor/,
        );
        return true;
      },
    );
    assert.match(await readFile(report, 'utf8'), /starting build[\s\S]*process error: unknown/);
    assert.equal(stdout.listenerCount('error'), 0);
  }
});

test('an undefined console failure keeps priority over a later coded failure', async (t) => {
  const { report, options } = await fixture(t);
  const stdout = new EventEmitter(),
    stderr = new EventEmitter(),
    failures = [];
  const coded = new Error('synthetic-private-later-failure');
  coded.code = 'EIO';
  stdout.write = () => {
    failures[0] = () => stdout.emit('error', undefined);
    if (failures[1]) {
      failures[0]();
      failures[1]();
    }
  };
  stderr.write = () => {
    failures[1] = () => stderr.emit('error', coded);
    if (failures[0]) {
      failures[0]();
      failures[1]();
    }
  };
  await assert.rejects(
    runLoggedProcess(
      process.execPath,
      ['-e', 'console.log("out"); console.error("err"); setInterval(() => {}, 1000);'],
      {
        ...options,
        stdout,
        stderr,
      },
    ),
    processFailure(
      { kind: 'process-error', code: 'unknown' },
      `Process launch or diagnostic output failed (unknown). See ${report}.`,
    ),
  );
  assert.match(await readFile(report, 'utf8'), /process error: unknown/);
});

test('a thrown Proxy cannot disrupt stream settlement through prototype inspection', async (t) => {
  const { folder, report, options } = await fixture(t);
  let prototypeReads = 0;
  const failure = new Proxy(
    { code: 'EIO' },
    {
      getPrototypeOf() {
        prototypeReads++;
        throw new Error('synthetic-sensitive-prototype-error');
      },
    },
  );
  const stdout = new EventEmitter();
  stdout.write = () => {
    throw failure;
  };
  await assert.rejects(
    runLoggedProcess(
      process.execPath,
      ['-e', 'console.log("starting build"); setInterval(() => {}, 1000);'],
      {
        ...options,
        stdout,
      },
    ),
    (error) => {
      processFailure(
        { kind: 'process-error', code: 'EIO' },
        `Process launch or diagnostic output failed (EIO). See ${report}.`,
      )(error);
      assert.doesNotMatch(
        `${error.stack}\n${JSON.stringify(error)}`,
        /synthetic-sensitive-prototype-error/,
      );
      return true;
    },
  );
  assert.equal(prototypeReads, 0);
  assert.equal(stdout.listenerCount('error'), 0);
  assert.match(await readFile(report, 'utf8'), /starting build[\s\S]*process error: EIO/);
  assert.deepEqual(await readdir(join(folder, 'reports')), ['package.log']);
});

test('report publication failure takes precedence over process outcome and removes its temporary file', async (t) => {
  const { folder, report, options } = await fixture(t);
  await mkdir(report, { recursive: true });
  const stdout = new EventEmitter();
  stdout.write = () => {
    throw undefined;
  };
  for (const [script, console] of [
    ['process.exitCode = 7;', options.stdout],
    ['console.log("starting build"); setInterval(() => {}, 1000);', stdout],
  ]) {
    await assert.rejects(
      runLoggedProcess(process.execPath, ['-e', script], { ...options, stdout: console }),
      (error) => {
        assert.ok(!(error instanceof ProcessExecutionError));
        assert.ok(['EISDIR', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code));
        return true;
      },
    );
  }
  assert.deepEqual(await readdir(join(folder, 'reports')), ['package.log']);
  assert.deepEqual(await readdir(report), []);
});

test(
  'actual smoke entry point rejects signing credentials before any version stamping',
  {
    skip: !(
      (process.platform === 'darwin' && process.arch === 'arm64') ||
      (['win32', 'linux'].includes(process.platform) && process.arch === 'x64')
    ),
  },
  async () => {
    const sourceFiles = [
      'package.json',
      'bun.lock',
      'src-tauri/Cargo.toml',
      'src-tauri/Cargo.lock',
      'src-tauri/tauri.conf.json',
    ];
    const paths = sourceFiles.map((path) => new URL(`../../${path}`, import.meta.url));
    const before = await Promise.all(paths.map((path) => readFile(path)));
    const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
    const entry = fileURLToPath(new URL('../quality/ci-platform.mjs', import.meta.url));
    await assert.rejects(
      promisify(execFile)(process.execPath, [entry, 'build', platform, '--smoke'], {
        env: {
          ...process.env,
          GITHUB_SHA: 'intentionally-invalid-source',
          TAURI_SIGNING_PRIVATE_KEY: 'synthetic-entry-point-secret',
        },
      }),
      (error) => {
        assert.match(error.stderr, /Smoke packaging refuses signing credentials/);
        assert.doesNotMatch(error.stderr, /synthetic-entry-point-secret/);
        return true;
      },
    );
    assert.deepEqual(await Promise.all(paths.map((path) => readFile(path))), before);
  },
);

import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { runLoggedProcess, smokePackagingEnvironment } from './process-diagnostics.mjs';

function collectedOutput() {
  const chunks = [];
  return { stream: new Writable({ write(chunk, _encoding, done) { chunks.push(Buffer.from(chunk)); done(); } }),
    text: () => Buffer.concat(chunks).toString() };
}

async function fixture(t) {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-process-diagnostics-'));
  t.after(() => rm(folder, { recursive: true, force: true }));
  const report = join(folder, 'reports', 'package.log');
  const out = collectedOutput(), err = collectedOutput();
  return { folder, report, out, err, options: { report, stdout: out.stream, stderr: err.stream } };
}

test('real child output streams to its consoles and a retained bounded log on success', async t => {
  const { report, out, err, options } = await fixture(t);
  const outcome = await runLoggedProcess(process.execPath, ['-e', 'console.log("built"); console.error("diagnostic");'], options);
  assert.equal(out.text(), 'built\n');
  assert.equal(err.text(), 'diagnostic\n');
  assert.equal(outcome.exitCode, 0);
  const log = await readFile(report, 'utf8');
  assert.match(log, /built/);
  assert.match(log, /diagnostic/);
  assert.match(log, /process status: exit=0; signal=none/);
  if (process.platform !== 'win32') assert.equal((await stat(report)).mode & 0o777, 0o600);
});

test('nonzero exit and launch failure retain diagnostics and identify their statuses', async t => {
  const { folder, report, options } = await fixture(t);
  await assert.rejects(runLoggedProcess(process.execPath, ['-e', 'console.error("failed to attach image"); process.exitCode = 7;'], options), /exited with 7/);
  assert.match(await readFile(report, 'utf8'), /failed to attach image[\s\S]*exit=7/);
  await assert.rejects(runLoggedProcess(join(folder, 'absent-executable'), [], options), /failed \(ENOENT\)/);
  assert.equal(await readFile(report, 'utf8'), '\n[process error: ENOENT]\n');
  assert.deepEqual(await readdir(join(folder, 'reports')), ['package.log']);
});

test('signal termination is distinct from an exit status', { skip: process.platform === 'win32' }, async t => {
  const { report, options } = await fixture(t);
  await assert.rejects(runLoggedProcess(process.execPath, ['-e', 'process.kill(process.pid, "SIGTERM");'], options), /exited with SIGTERM/);
  assert.match(await readFile(report, 'utf8'), /exit=null; signal=SIGTERM/);
});

test('large output keeps memory and report bounded while slow consoles receive every byte', async t => {
  const { report, options } = await fixture(t);
  let received = 0;
  options.stdout = new Writable({ highWaterMark: 64, write(chunk, _encoding, done) {
    received += chunk.length;
    setImmediate(done);
  } });
  const script = 'import {once} from "node:events"; for(let i=0;i<256;i++) { if(!process.stdout.write("x".repeat(8192))) await once(process.stdout,"drain"); } process.stdout.write("FINAL PACKAGING ERROR");';
  const result = await runLoggedProcess(process.execPath, ['--input-type=module', '-e', script], { ...options, maxBytes: 1024 });
  assert.equal(received, 256 * 8192 + 'FINAL PACKAGING ERROR'.length);
  assert.ok(result.discardedBytes > 0);
  const bytes = await readFile(report);
  assert.ok(bytes.length <= 1024);
  const log = bytes.toString('utf8');
  assert.match(log, /^x+/);
  assert.match(log, /diagnostic output truncated/);
  assert.match(log, /FINAL PACKAGING ERROR[\s\S]*exit=0/);
});

test('reruns replace only the report entry and never follow an existing link', { skip: process.platform === 'win32' }, async t => {
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
});

test('argument metacharacters remain literal without invoking a shell', async t => {
  const { out, options } = await fixture(t);
  const argument = 'literal; $(printf injected) & | > `printf injected`';
  await runLoggedProcess(process.execPath, ['-e', 'console.log(process.argv[1]);', argument], options);
  assert.equal(out.text(), `${argument}\n`);
});

test('smoke environment refuses signing inputs without revealing their values', () => {
  for (const key of ['TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD', 'APPLE_CERTIFICATE', 'APPLE_API_KEY_PATH', 'WINDOWS_CERTIFICATE_PASSWORD', 'apple_password']) {
    assert.throws(() => smokePackagingEnvironment({ [key]: 'synthetic-sensitive-value' }), error =>
      error.message === 'Smoke packaging refuses signing credentials.');
  }
});

test('smoke debug child cannot print inherited environment credentials', async t => {
  const { report, out, options } = await fixture(t);
  const inherited = { ...process.env, GITHUB_TOKEN: 'synthetic-github-token', GH_TOKEN: 'synthetic-gh-token',
    DATABASE_PASSWORD: 'synthetic-database-password', AWS_SECRET_ACCESS_KEY: 'synthetic-aws-secret',
    TAURI_SIGNING_PRIVATE_KEY: '', TAURI_CLI_VERBOSITY: '0', GITHUB_SHA: 'source-sha',
    RUSTUP_HOME: 'rustup-location', NO_STRIP: '1' };
  const env = smokePackagingEnvironment(inherited);
  assert.equal(env.TAURI_CLI_VERBOSITY, '1');
  assert.equal(env.GITHUB_SHA, 'source-sha');
  assert.equal(env.RUSTUP_HOME, 'rustup-location');
  assert.equal(env.NO_STRIP, '1');
  assert.equal(inherited.TAURI_CLI_VERBOSITY, '0');
  const script = 'for(const key of ["GITHUB_TOKEN","GH_TOKEN","DATABASE_PASSWORD","AWS_SECRET_ACCESS_KEY","TAURI_SIGNING_PRIVATE_KEY"]) console.log(key + ":" + (process.env[key] ?? "absent")); console.log("debug=" + process.env.TAURI_CLI_VERBOSITY);';
  await runLoggedProcess(process.execPath, ['-e', script], { ...options, env });
  assert.match(out.text(), /debug=1/);
  assert.doesNotMatch(await readFile(report, 'utf8'), /synthetic-(?:github|gh|database|aws)/);
  for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'DATABASE_PASSWORD', 'AWS_SECRET_ACCESS_KEY', 'TAURI_SIGNING_PRIVATE_KEY']) assert.equal(env[key], undefined);
});

test('diagnostic runner is neutral about environment and never dumps it or arguments', async t => {
  const { report, options } = await fixture(t);
  await runLoggedProcess(process.execPath, ['-e', 'console.log(process.env.TAURI_CLI_VERBOSITY ?? "no-debug");', 'synthetic-argument-secret'], {
    ...options, env: { ...process.env, TAURI_CLI_VERBOSITY: '0', TEST_PASSWORD: 'synthetic-env-secret' },
  });
  const log = await readFile(report, 'utf8');
  assert.match(log, /0/);
  assert.doesNotMatch(log, /synthetic-(?:argument|env)-secret/);
});

test('console failure terminates the child and retains a safe diagnostic error', async t => {
  const { report, options } = await fixture(t);
  const stdout = new Writable({ write(_chunk, _encoding, done) {
    const error = new Error('synthetic-sensitive-console-error');
    error.code = 'EPIPE';
    done(error);
  } });
  await assert.rejects(runLoggedProcess(process.execPath, ['-e', 'console.log("starting build"); setInterval(() => {}, 1000);'], {
    ...options, stdout,
  }), /failed \(EPIPE\)/);
  const log = await readFile(report, 'utf8');
  assert.match(log, /process error: EPIPE/);
  assert.doesNotMatch(log, /synthetic-sensitive-console-error/);
});

test('actual smoke entry point rejects signing credentials before any version stamping', {
  skip: !((process.platform === 'darwin' && process.arch === 'arm64')
    || (['win32', 'linux'].includes(process.platform) && process.arch === 'x64')),
}, async () => {
  const sourceFiles = ['package.json', 'bun.lock', 'src-tauri/Cargo.toml', 'src-tauri/Cargo.lock', 'src-tauri/tauri.conf.json'];
  const paths = sourceFiles.map(path => new URL(`../${path}`, import.meta.url));
  const before = await Promise.all(paths.map(path => readFile(path)));
  const platform = { darwin: 'macos', win32: 'windows', linux: 'linux' }[process.platform];
  const entry = fileURLToPath(new URL('./ci-platform.mjs', import.meta.url));
  await assert.rejects(promisify(execFile)(process.execPath, [entry, 'build', platform, '--smoke'], {
    env: { ...process.env, GITHUB_SHA: 'intentionally-invalid-source', TAURI_SIGNING_PRIVATE_KEY: 'synthetic-entry-point-secret' },
  }), error => {
    assert.match(error.stderr, /Smoke packaging refuses signing credentials/);
    assert.doesNotMatch(error.stderr, /synthetic-entry-point-secret/);
    return true;
  });
  assert.deepEqual(await Promise.all(paths.map(path => readFile(path))), before);
});

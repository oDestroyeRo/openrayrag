#!/usr/bin/env bun
import { map } from 'remeda';
/** Launch only a CI-feature package with temporary data; never use a real account. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { createSmokeLaunch, validateResult, verifyReopened } from './native-smoke-policy.mjs';
export { validateResult, verifyReopened } from './native-smoke-policy.mjs';

export function smokeLaunch(binary, root, platform = process.platform, env = process.env) {
  return createSmokeLaunch(resolve(binary), root, platform, env);
}

export async function runStage(binary, stage, { root, data, result, token, timeoutMs = 45_000, prefixArgs = [], env = process.env }) {
  // A session wrapper may outlive or exit before its application. Own the whole
  // POSIX process group so a timeout also closes descendants' inherited pipes.
  const processGroup = process.platform !== 'win32';
  const child = spawn(binary, [...prefixArgs, `--ci-smoke-test=${stage}`], {
    shell: false,
    detached: processGroup,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...env, RAYRAG_CI_ROOT: root, RAYRAG_CI_DATA_DIR: data, RAYRAG_CI_RESULT: result, RAYRAG_CI_TOKEN: token },
  });
  let output = '';
  const capture = chunk => { output = (output + chunk.toString()).slice(-12_000); };
  child.stdout.on('data', capture);
  child.stderr.on('data', capture);
  await new Promise((resolveStage, reject) => {
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (processGroup && child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); }
        catch (error) { if (error.code !== 'ESRCH') reject(error); }
      } else child.kill('SIGKILL');
    }, timeoutMs);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    // Wait for all owned output pipes to close before temporary-data cleanup.
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`Native ${stage} smoke timed out after ${timeoutMs} ms.`));
      else if (code !== 0) reject(new Error(`Native ${stage} smoke exited with ${signal ?? code}.${output ? `\n${output}` : ''}`));
      else resolveStage();
    });
  }).catch(async error => {
    // A failing child may already have recorded the watchdog/assertion cause.
    // Read only this launch's bounded result before temporary data is removed.
    let detail = '';
    try {
      const file = await open(result, 'r');
      try {
        const buffer = Buffer.alloc(16_385);
        const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
        if (bytesRead <= 16_384) {
          const outcome = JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
          if (outcome?.protocol === 1 && outcome.stage === stage && outcome.token === token
              && outcome.passed === false && typeof outcome.message === 'string') {
            detail = `\nNative result: ${outcome.message.slice(0, 1_000)}`;
            if (typeof outcome.milestone === 'string') detail += `\nMilestone: ${outcome.milestone.slice(0, 100)}`;
          }
        }
      } finally { await file.close(); }
    } catch { /* Preserve the process failure when its result is unavailable. */ }
    throw detail ? new Error(error.message + detail, { cause: error }) : error;
  });
  const outcome = JSON.parse(await readFile(result, 'utf8'));
  validateResult(outcome, stage, token);
  return outcome;
}

export async function nativeSmoke(binary, outputFile) {
  if (process.env.CI !== 'true') throw new Error('Packaged native smoke launches only on CI runners.');
  const root = await mkdtemp(join(tmpdir(), 'rayrag-native-smoke-'));
  const data = join(root, 'data');
  await mkdir(data, { mode: 0o700 });
  // Keep each package's GTK session and WebKit stores private, including reopen.
  const launch = smokeLaunch(binary, root);
  try {
    const outcomes = [];
    for (const stage of ['save', 'reopen']) {
      outcomes.push(await runStage(launch.binary, stage, {
        root, data, result: join(root, `${stage}.json`), token: randomUUID(),
        prefixArgs: launch.prefixArgs, env: launch.env,
      }));
    }
    const [saved, reopened] = map(outcomes, outcome => outcome.document);
    verifyReopened(saved, reopened);
    await mkdir(dirname(resolve(outputFile)), { recursive: true });
    await writeFile(outputFile, JSON.stringify({ protocol: 1, platform: process.platform, passed: true, stages: outcomes }, null, 2) + '\n');
    console.log(`Packaged ${process.platform} smoke passed: WebView boot, native settings save, immediate close, restore, and offline state.`);
  } catch (error) {
    await mkdir(dirname(resolve(outputFile)), { recursive: true });
    await writeFile(outputFile, JSON.stringify({ protocol: 1, platform: process.platform, passed: false, message: error.message.slice(-16_384) }, null, 2) + '\n');
    throw error;
  } finally {
    // This root was created by this invocation and contains only synthetic settings.
    await rm(root, { recursive: true, force: true });
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2);
  if (args.length !== 4 || args[0] !== '--binary' || args[2] !== '--output') {
    console.error('Usage: bun scripts/native-smoke.mjs --binary <CI-feature executable> --output <result.json>');
    process.exitCode = 1;
  } else {
    await nativeSmoke(args[1], args[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

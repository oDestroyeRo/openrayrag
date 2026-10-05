#!/usr/bin/env node
/** Launch only a CI-feature package with temporary data; never use a real account. */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

const EXPECTED_CHECKS = ['webview-boot', 'offline-controller', 'native-settings-ipc', 'window-close-save'];

export function smokeLaunch(binary, root, platform = process.platform, env = process.env) {
  if (platform !== 'linux') return { binary: resolve(binary), prefixArgs: [], env };
  return {
    binary: 'dbus-run-session', prefixArgs: ['--', resolve(binary)],
    env: { ...env, XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CACHE_HOME: join(root, 'xdg-cache') },
  };
}

export function validateResult(result, stage, token) {
  if (result?.protocol !== 1 || result.stage !== stage || result.token !== token || result.passed !== true
      || !EXPECTED_CHECKS.every(check => result.checks?.includes(check))) {
    throw new Error(`Native ${stage} smoke did not return a complete passing result.`);
  }
  if (stage === 'reopen' && !result.checks.includes('settings-restore')) throw new Error('Native reopening did not prove settings restoration.');
  const document = result.document;
  if (document?.version !== 1 || !Number.isSafeInteger(document.revision) || document.revision < 1
      || document.selectedProfileId !== null || document.settings?.radius !== 17
      || document.settings.loot !== false || document.settings.route_step !== 7
      || Object.keys(document).sort().join(',') !== 'revision,selectedProfileId,settings,version') {
    throw new Error(`Native ${stage} smoke did not retain the edited settings.`);
  }
  return document;
}

export function verifyReopened(saved, reopened) {
  // Startup may advance the save revision while confirming identical contents.
  const { revision: savedRevision, ...savedContents } = saved;
  const { revision: reopenedRevision, ...reopenedContents } = reopened;
  if (reopenedRevision < savedRevision || !isDeepStrictEqual(savedContents, reopenedContents)) {
    throw new Error('Native reopening changed the saved settings.');
  }
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
      if ((await stat(result)).size <= 16_384) {
        const outcome = JSON.parse(await readFile(result, 'utf8'));
        if (outcome?.protocol === 1 && outcome.stage === stage && outcome.token === token
            && outcome.passed === false && typeof outcome.message === 'string') {
          detail = `\nNative result: ${outcome.message.slice(0, 1_000)}`;
          if (typeof outcome.milestone === 'string') detail += `\nMilestone: ${outcome.milestone.slice(0, 100)}`;
        }
      }
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
    const [saved, reopened] = outcomes.map(outcome => outcome.document);
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
    console.error('Usage: node scripts/native-smoke.mjs --binary <CI-feature executable> --output <result.json>');
    process.exitCode = 1;
  } else {
    await nativeSmoke(args[1], args[3]).catch(error => { console.error(error.message); process.exitCode = 1; });
  }
}

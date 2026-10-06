import { filter, fromEntries } from 'remeda';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { classifyProcessOutcome, processErrorCode, processFailureDetails, processFailureMessage } from './process-outcome-policy.mjs';

export class ProcessExecutionError extends Error {
  /** @param {import('./process-outcome-policy.mjs').ProcessFailure} failure @param {string} report */
  constructor(failure, report) {
    const details = processFailureDetails(failure);
    super(processFailureMessage(details, report));
    this.name = 'ProcessExecutionError';
    this.failure = Object.freeze(details);
  }
}

const FOOTER_RESERVE = 512;
const SIGNING_CREDENTIAL = /^(TAURI_SIGNING_PRIVATE_KEY(?:_PASSWORD)?|APPLE_(?:CERTIFICATE(?:_PASSWORD)?|ID|PASSWORD|API_KEY(?:_PATH)?|API_ISSUER)|WINDOWS_CERTIFICATE(?:_PASSWORD)?)$/i;
const CREDENTIAL_NAME = /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PRIVATE_KEY|CERTIFICATE|API_KEY|AUTHORIZATION|CREDENTIALS?)(?:_|$)/i;

export function smokePackagingEnvironment(environment) {
  // Debug output is allowed only for unsigned builds. Do not forward unrelated
  // CI authentication into a child whose build tools can print their context.
  if (Object.entries(environment).some(([key, value]) => SIGNING_CREDENTIAL.test(key) && value)) {
    throw new Error('Smoke packaging refuses signing credentials.');
  }
  const safe = fromEntries(filter(Object.entries(environment), ([key]) => !CREDENTIAL_NAME.test(key)));
  return { ...safe, TAURI_CLI_VERBOSITY: '1' };
}

async function writeConsole(stream, chunk) {
  /** @type {Promise<void>} */
  const written = new Promise((resolve, reject) => {
    const failed = error => { stream.off('error', failed); reject(error); };
    stream.once('error', failed);
    try {
      stream.write(chunk, error => {
        if (error) reject(error); // The following error event removes its listener.
        else { stream.off('error', failed); resolve(); }
      });
    } catch (error) { stream.off('error', failed); reject(error); }
  });
  await written;
}

/** Stream a child without a shell; retain a bounded report even when it fails. */
export async function runLoggedProcess(file, args, {
  cwd, env = process.env, report, stdout = process.stdout, stderr = process.stderr,
  maxBytes = 8 * 1024 * 1024,
}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1024) throw new Error('Diagnostic log limit must be at least 1024 bytes.');
  await mkdir(dirname(report), { recursive: true });
  const temporary = `${report}.${randomUUID()}.tmp`;
  const log = await open(temporary, 'wx', 0o600);
  const tailLimit = Math.min(64 * 1024, Math.floor((maxBytes - FOOTER_RESERVE) / 4));
  const prefixLimit = maxBytes - FOOTER_RESERVE - tailLimit;
  let prefixBytes = 0, discardedBytes = 0;
  let tail = Buffer.alloc(0);
  let pending = Promise.resolve();
  let child;
  let failure;
  let exitCode = null, signal = null;
  const capture = (chunk, consoleStream) => {
    // Serialize the two pipes' file writes. Each pipe applies backpressure,
    // keeping queued chunks bounded even if the terminal or disk is slow.
    const saved = pending.then(async () => {
      const count = Math.min(chunk.length, prefixLimit - prefixBytes);
      if (count) { await log.writeFile(chunk.subarray(0, count)); prefixBytes += count; }
      if (count < chunk.length) {
        const rest = chunk.subarray(count);
        const combined = Buffer.concat([tail, rest]);
        discardedBytes += Math.max(0, combined.length - tailLimit);
        tail = Buffer.from(combined.subarray(-tailLimit));
      }
    });
    pending = saved;
    return saved.then(() => writeConsole(consoleStream, chunk));
  };
  try {
    child = spawn(file, args, { cwd, env, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    /** @type {Promise<void>} */
    const completed = new Promise(resolve => {
      child.once('error', error => { failure ??= error; });
      child.once('close', (code, stoppedBy) => { exitCode = code; signal = stoppedBy; resolve(); });
    });
    const pump = (source, target) => pipeline(source, new Writable({
      write(chunk, _encoding, callback) {
        capture(chunk, target).then(() => callback(), callback);
      },
    })).catch(error => {
      failure ??= error;
      child.kill();
    });
    await Promise.all([completed, pump(child.stdout, stdout), pump(child.stderr, stderr)]);
    await pending;
  } catch (error) {
    failure ??= error;
  } finally {
    try {
      if (discardedBytes) await log.writeFile(`\n[diagnostic output truncated: ${discardedBytes} bytes omitted; final output follows]\n`);
      if (tail.length) await log.writeFile(tail);
      const launchCode = processErrorCode(failure?.code);
      await log.writeFile(failure
        ? `\n[process error: ${launchCode}]\n`
        : `\n[process status: exit=${exitCode}; signal=${signal ?? 'none'}]\n`);
    } finally {
      await log.close();
      // Replace the report entry itself, never follow an existing symlink. Only
      // the exclusive temporary file created by this invocation is cleaned up.
      try { await rename(temporary, report); }
      finally { await rm(temporary, { force: true }); }
    }
  }
  const outcome = classifyProcessOutcome({
    failureCode: failure ? processErrorCode(failure.code) : null, exitCode, signal, discardedBytes,
  });
  if (outcome.kind !== 'success') throw new ProcessExecutionError(outcome, report);
  return { exitCode: outcome.exitCode, signal: outcome.signal, discardedBytes: outcome.discardedBytes };
}

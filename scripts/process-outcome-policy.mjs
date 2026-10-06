// Pure process observations. Reports and promise settlement stay in the runner.

/** @typedef {{ kind: 'success', exitCode: 0, signal: string | null, discardedBytes: number }} ProcessSuccess */
/** @typedef {{ kind: 'process-error', code: string }} ProcessError */
/** @typedef {{ kind: 'signal', signal: string }} ProcessSignal */
/** @typedef {{ kind: 'exit', exitCode: number | null }} ProcessExit */
/** @typedef {ProcessError | ProcessSignal | ProcessExit} ProcessFailure */
/** @typedef {ProcessSuccess | ProcessFailure} ProcessOutcome */

/** @param {unknown} code */
export function processErrorCode(code) {
  return (typeof code === 'string' || typeof code === 'number') && code && /^[A-Z0-9_]+$/.test(String(code))
    ? String(code) : 'unknown';
}

/**
 * @param {{ failureCode: string | null, exitCode: number | null, signal: string | null, discardedBytes: number }} observation
 * @returns {ProcessOutcome}
 */
export function classifyProcessOutcome({ failureCode, exitCode, signal, discardedBytes }) {
  if (failureCode !== null) return { kind: 'process-error', code: processErrorCode(failureCode) };
  if (exitCode === 0) return { kind: 'success', exitCode, signal, discardedBytes };
  if (signal !== null) return { kind: 'signal', signal };
  return { kind: 'exit', exitCode };
}

/** Pick only scalar failure fields, even if a caller supplies extra properties.
 * @param {ProcessFailure} failure
 * @returns {ProcessFailure}
 */
export function processFailureDetails(failure) {
  switch (failure.kind) {
    case 'process-error': return { kind: failure.kind, code: processErrorCode(failure.code) };
    case 'signal': return { kind: failure.kind, signal: typeof failure.signal === 'string' ? failure.signal : 'unknown' };
    case 'exit': return { kind: failure.kind, exitCode: typeof failure.exitCode === 'number' ? failure.exitCode : null };
    default: throw new TypeError('Expected a failed process outcome.');
  }
}

/** @param {ProcessFailure} failure @param {string} report */
export function processFailureMessage(failure, report) {
  switch (failure.kind) {
    case 'process-error': return `Process launch or diagnostic output failed (${failure.code}). See ${report}.`;
    case 'signal': return `Process exited with ${failure.signal}. See ${report}.`;
    case 'exit': return `Process exited with ${failure.exitCode}. See ${report}.`;
  }
}

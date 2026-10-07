import { planningScheduler } from './route-scheduling-effects';

/** Each yield releases a bounded piece of map analysis, heuristic work or A*. */
export type PlanningPhase =
  | 'map-analysis'
  | 'local-search'
  | 'heuristic'
  | 'world-search'
  | 'route-copy';
export type PlanningWork<T> = Generator<PlanningPhase | void, T>;
export interface PlanningScheduler {
  now(): number;
  /** Schedule a macrotask, so input, sockets and controller ticks can run. */
  schedule(callback: () => void): () => void;
}
export interface PlanningSlice {
  durationMs: number;
  schedulingDelayMs: number;
  complete: boolean;
  phase?: PlanningPhase;
}
export interface PlanningOptions {
  signal?: AbortSignal;
  scheduler?: PlanningScheduler;
  sliceMs?: number;
  onSlice?: (slice: PlanningSlice) => void;
}
export class PlanningCancelled extends Error {
  constructor() {
    super('Route planning cancelled.');
    this.name = 'AbortError';
  }
}
// No waiting queue: each runtime retains at most four independent jobs. Callers
// cancel their previous request before starting another, so previews cannot
// accumulate work or displace an executing controller's job.
export const MAX_PLANNING_JOBS = 4;
let activeJobs = 0;
type PlanningSettlement<T> = { type: 'completed'; value: T } | { type: 'failed'; cause: unknown };
export function completePlanning<T>(work: PlanningWork<T>): T {
  let result = work.next();
  while (!result.done) result = work.next();
  return result.value;
}
export function runPlanning<T>(work: PlanningWork<T>, options: PlanningOptions = {}): Promise<T> {
  const runtime = options.scheduler ?? planningScheduler;
  const budget = options.sliceMs ?? 8;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 16)
    return Promise.reject(
      new RangeError('Planning slice must be greater than 0 and at most 16 ms.'),
    );
  if (options.signal?.aborted) return Promise.reject(new PlanningCancelled());
  if (activeJobs >= MAX_PLANNING_JOBS)
    return Promise.reject(new Error('Too many route plans. Cancel an existing preview first.'));
  activeJobs++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelScheduled: (() => void) | undefined;
    const finish = (outcome: PlanningSettlement<T>) => {
      if (settled) return;
      settled = true;
      cancelScheduled?.();
      options.signal?.removeEventListener('abort', abort);
      activeJobs--;
      try {
        work.return(undefined as T);
      } catch (cause) {
        // A thrown value may itself be undefined. Preserve the first failure
        // explicitly instead of treating its value as a completion sentinel.
        if (outcome.type === 'completed') outcome = { type: 'failed', cause };
      }
      if (outcome.type === 'failed') reject(outcome.cause);
      else resolve(outcome.value);
    };
    const abort = () => finish({ type: 'failed', cause: new PlanningCancelled() });
    const schedule = () => {
      const queuedAt = runtime.now();
      cancelScheduled = runtime.schedule(() => {
        cancelScheduled = undefined;
        if (settled) return;
        const start = runtime.now();
        try {
          // The operation cap also bounds slices under a deterministic/frozen clock.
          let result: IteratorResult<PlanningPhase | void, T>;
          let operations = 0;
          do {
            if (options.signal?.aborted) {
              abort();
              return;
            }
            result = work.next();
          } while (!result.done && ++operations < 4096 && runtime.now() - start < budget);
          options.onSlice?.({
            durationMs: runtime.now() - start,
            schedulingDelayMs: start - queuedAt,
            complete: result.done === true,
            ...(!result.done && result.value ? { phase: result.value } : {}),
          });
          if (settled) return;
          if (result.done) finish({ type: 'completed', value: result.value });
          else schedule();
        } catch (cause) {
          finish({ type: 'failed', cause });
        }
      });
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try {
      schedule();
    } catch (cause) {
      finish({ type: 'failed', cause });
    }
  });
}

/** Each yield releases a bounded piece of map analysis, heuristic work or A*. */
export type PlanningPhase = 'map-analysis' | 'local-search' | 'heuristic' | 'world-search' | 'route-copy';
export type PlanningWork<T> = Generator<PlanningPhase | void, T>;
export interface PlanningScheduler {
  now(): number;
  /** Schedule a macrotask, so input, sockets and controller ticks can run. */
  schedule(callback: () => void): () => void;
}
export interface PlanningSlice { durationMs: number; schedulingDelayMs: number; complete: boolean; phase?: PlanningPhase }
export interface PlanningOptions {
  signal?: AbortSignal;
  scheduler?: PlanningScheduler;
  sliceMs?: number;
  onSlice?: (slice: PlanningSlice) => void;
}
export class PlanningCancelled extends Error {
  constructor() { super('Route planning cancelled.'); this.name = 'AbortError'; }
}
const scheduler: PlanningScheduler = {
  now: () => performance.now(),
  schedule(callback) { const handle = setTimeout(callback, 0); return () => clearTimeout(handle); },
};
// No waiting queue: each runtime retains at most four independent jobs. Callers
// cancel their previous request before starting another, so previews cannot
// accumulate work or displace an executing controller's job.
export const MAX_PLANNING_JOBS = 4;
let activeJobs = 0;
export function completePlanning<T>(work: PlanningWork<T>): T {
  let result = work.next();
  while (!result.done) result = work.next();
  return result.value;
}
export function runPlanning<T>(work: PlanningWork<T>, options: PlanningOptions = {}): Promise<T> {
  const runtime = options.scheduler ?? scheduler;
  const budget = options.sliceMs ?? 8;
  if (!Number.isFinite(budget) || budget <= 0 || budget > 16) return Promise.reject(new RangeError('Planning slice must be greater than 0 and at most 16 ms.'));
  if (options.signal?.aborted) return Promise.reject(new PlanningCancelled());
  if (activeJobs >= MAX_PLANNING_JOBS) return Promise.reject(new Error('Too many route plans. Cancel an existing preview first.'));
  activeJobs++;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    let cancelScheduled: (() => void) | undefined;
    const finish = (error: unknown, result?: T) => {
      if (settled) return;
      settled = true;
      cancelScheduled?.();
      options.signal?.removeEventListener('abort', abort);
      activeJobs--;
      try { work.return(undefined as T); } catch (closingError) { error ??= closingError; }
      if (error !== undefined) reject(error); else resolve(result!);
    };
    const abort = () => finish(new PlanningCancelled());
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
            if (options.signal?.aborted) { abort(); return; }
            result = work.next();
          } while (!result.done && ++operations < 4096 && runtime.now() - start < budget);
          options.onSlice?.({ durationMs: runtime.now() - start, schedulingDelayMs: start - queuedAt, complete: result.done === true, ...(!result.done && result.value ? {phase: result.value} : {}) });
          if (settled) return;
          if (result.done) finish(undefined, result.value); else schedule();
        } catch (error) { finish(error); }
      });
    };
    options.signal?.addEventListener('abort', abort, { once: true });
    try { schedule(); } catch (error) { finish(error); }
  });
}

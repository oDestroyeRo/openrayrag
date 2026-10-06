import type { PlanningScheduler } from './route-planning';

/** The production clock/timer adapter; planner orchestration may inject a deterministic scheduler. */
export const planningScheduler: PlanningScheduler = {
  now: () => performance.now(),
  schedule(callback) {
    const handle = setTimeout(callback, 0);
    return () => clearTimeout(handle);
  },
};

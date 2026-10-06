import { afterEach, describe, expect, it, vi } from 'vitest';
import { planningScheduler } from './route-scheduling-effects';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
describe('route scheduler effects', () => {
  it('uses the monotonic clock and queues a cancellable macrotask', () => {
    vi.useFakeTimers(); vi.spyOn(performance, 'now').mockReturnValue(123);
    expect(planningScheduler.now()).toBe(123);
    const completed: number[] = [];
    const cancel = planningScheduler.schedule(() => completed.push(1));
    planningScheduler.schedule(() => completed.push(2));
    expect(completed).toEqual([]);
    cancel(); vi.runOnlyPendingTimers();
    expect(completed).toEqual([2]);
  });
});

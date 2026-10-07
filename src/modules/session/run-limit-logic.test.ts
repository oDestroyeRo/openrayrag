import { describe, expect, it } from 'vitest';
import { controlStopReason, reachedRunLimit, runLimitReason } from './run-limit-logic';
import { DEFAULT_AUTOMATION } from '../settings/settings';

describe('run limit causes', () => {
  it('uses original finite allowances, boundary precedence and the existing death policy without mutating inputs', () => {
    const input = {
      limits: { ...DEFAULT_AUTOMATION.limits, minutes: 1, kills: 2, pickups: 3 },
      elapsedMilliseconds: 59_999,
      kills: 1,
      pickups: 2,
      respawn: { enabled: true, maxDeaths: 1 },
      deaths: 1,
    };
    const before = structuredClone(input);
    expect(reachedRunLimit(input)).toBeNull();
    expect(reachedRunLimit({ ...input, elapsedMilliseconds: 60_000, kills: 2, pickups: 3 })).toBe(
      'minutes',
    );
    expect(reachedRunLimit({ ...input, kills: 2, pickups: 3 })).toBe('kills');
    expect(reachedRunLimit({ ...input, pickups: 3 })).toBe('pickups');
    expect(reachedRunLimit({ ...input, deaths: 2 })).toBe('deaths');
    expect(
      reachedRunLimit({
        ...input,
        limits: DEFAULT_AUTOMATION.limits,
        respawn: { enabled: false, maxDeaths: 0 },
        elapsedMilliseconds: 999_999,
        kills: 99,
        pickups: 99,
        deaths: 99,
      }),
    ).toBeNull();
    expect(input).toEqual(before);
  });
  it.each(['minutes', 'kills', 'pickups', 'deaths'] as const)(
    'attributes %s to the configured allowance and explains a new explicit run',
    (cause) => {
      const reason = controlStopReason('stop', cause);
      expect(reason).toBe(runLimitReason(cause));
      expect(reason).not.toContain('Stopped by you');
      expect(reason).toContain('Press Stop to end this run');
      expect(reason).toContain('Start for a new run');
      expect(() => controlStopReason('start', cause)).toThrow();
    },
  );
  it('reserves the manual reason for an ordinary Stop and rejects malformed causes before admission', () => {
    expect(controlStopReason('stop', undefined)).toBe('Stopped by you.');
    expect(controlStopReason('stop', null)).toBe('Stopped by you.');
    for (const cause of ['manual', 'weight', 1, {}, ['minutes']])
      expect(() => controlStopReason('stop', cause)).toThrow();
  });
});

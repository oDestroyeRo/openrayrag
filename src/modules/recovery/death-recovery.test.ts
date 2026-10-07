import { describe, it, expect } from 'vitest';
import corpus from '../../data/death-recovery-guards.json';
import { validateDeathRecoveryGuard, farmingDestination, deathCycle } from './death-recovery';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION } from '../settings/settings';
describe('strict config-free death recovery guard', () => {
  for (const c of corpus)
    it(c.name, () => {
      if (c.valid) expect(() => validateDeathRecoveryGuard(JSON.parse(c.json))).not.toThrow();
      else expect(() => validateDeathRecoveryGuard(JSON.parse(c.json))).toThrow();
    });
  it('captures lock, explicit journey, then starting map in that order', () => {
    const settings = {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      automation: structuredClone(DEFAULT_AUTOMATION),
    };
    expect(farmingDestination(settings)).toBe('prt_fild08');
    settings.automation.travel.destinationMap = 'prt_fild05';
    expect(farmingDestination(settings)).toBe('prt_fild05');
    settings.automation.mapPolicy = structuredClone(DEFAULT_MAP_POLICY);
    settings.automation.mapPolicy.lockArea = {
      map: 'prontera',
      minX: 10,
      minY: 10,
      maxX: 20,
      maxY: 20,
    };
    expect(farmingDestination(settings)).toBe('prontera');
  });
});

it('clamps future recovery/return guards without replenishing any earlier absolute deadline', () => {
  const base = validateDeathRecoveryGuard(JSON.parse(corpus[0]!.json)),
    now = 100000;
  const recovery = deathCycle(
    { ...base, phase: 'recovery', recoverySeconds: 1, recoveryDeadline: 8640000000000000 },
    now,
  );
  expect(recovery.recoveryUntil).toBe(now + 1000);
  const returned = deathCycle(
    { ...base, phase: 'return', returnSeconds: 2, returnDeadline: 8640000000000000 },
    now,
  );
  expect(returned.returnUntil).toBe(now + 2000);
  expect(
    deathCycle({ ...base, phase: 'recovery', recoveryDeadline: 90000 }, now).recoveryUntil,
  ).toBe(90000);
});

import { describe, expect, it } from 'vitest';
import { PersistentFieldRun, validateFieldRunCheckpoint, type RunSession } from './reconnect';
import { RunIntentDispatch } from './run-intent-dispatch';
import { ReconnectPolicy } from './reconnect';
import { DEFAULT_SETTINGS } from '../settings/settings';
import { addExperience, signedExperience, validRunExperience } from './run-experience-logic';
import { liveSettingsGuard } from '../settings/live-settings-logic';

const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
function status(
  baseGained = 0,
  jobGained = 0,
  revision = 0,
  sessionId = 'first',
  run = 1,
): RunSession {
  return {
    sessionId,
    connected: true,
    compatible: true,
    map: settings.map,
    player: { name: 'Test' },
    runRequested: true,
    runExperience: { character: 'Test', run, revision, baseGained, jobGained },
  };
}

describe('retained confirmed run EXP', () => {
  it('retains signed EXP with acknowledged settings and resource clocks in one updater checkpoint', () => {
    const field = new PersistentFieldRun(() => 100_000);
    field.begin(settings, 'Test', 'first');
    field.observe(status());
    field.observe(status(-20, 40, 1));
    const id = 'a'.repeat(32),
      applied = { ...settings, radius: 8 };
    field.registerSettingsApply(id, status(-20, 40, 1));
    field.observe({
      ...status(-20, 40, 1),
      activeSettings: applied,
      settingsApply: {
        id,
        state: 'applied',
        applied: ['radius'],
        pending: [],
        nextRun: [],
        reason: '',
      },
      liveSettingsGuard: liveSettingsGuard(
        applied,
        null,
        'Test',
        [{ key: 'item:501', at: 99_000 }],
        100_000,
      ),
    });
    const saved = JSON.parse(JSON.stringify(field.checkpoint()));
    const restored = new PersistentFieldRun(() => 100_000);
    restored.restore(saved);
    expect(restored.experienceFor(status())).toMatchObject({ baseGained: -20, jobGained: 40 });
    const resume = restored.resumeFor({ ...status(0, 0, 0, 'replacement'), runRequested: false })!;
    expect(resume.settings.radius).toBe(8);
    expect(resume.liveSettingsGuard?.cooldowns).toEqual([{ key: 'item:501', at: 99_000 }]);
    expect(saved.experience.gains).toEqual({ baseGained: -20, jobGained: 40 });
  });
  it('accepts a newer terminal cursor only from the established character and run', () => {
    const field = new PersistentFieldRun(() => 100_000);
    field.begin(settings, 'Test', 'first');
    field.observe(status());
    field.observe(status(10, 5, 1));
    const terminal: RunSession = {
      ...status(30, 15, 2),
      connected: false,
      compatible: false,
      player: null,
    };
    field.observe(terminal);
    field.observe(terminal);
    field.observe({ ...terminal, runExperience: status(10, 5, 1).runExperience });
    expect(field.experienceFor(terminal)).toMatchObject({ baseGained: 30, jobGained: 15 });
    field.observe({ ...terminal, runExperience: status(999, 999, 1, 'first', 2).runExperience });
    field.observe({
      ...terminal,
      sessionId: 'replacement',
      runExperience: status(999, 999, 1).runExperience,
    });
    field.observe({
      ...terminal,
      runExperience: { ...status(999, 999, 3).runExperience!, character: 'Other' },
    });
    field.observe({ ...terminal, runExperience: undefined });
    expect(field.experienceFor(terminal)).toMatchObject({ baseGained: 30, jobGained: 15 });
    field.stop();
    field.observe({ ...terminal, runExperience: status(35, 16, 3).runExperience });
    expect(field.experienceFor(terminal)).toMatchObject({ baseGained: 35, jobGained: 16 });
  });
  it('ignores repeat/stale snapshots and preserves signed totals across runtime replacement and Stop', () => {
    const field = new PersistentFieldRun(() => 100_000);
    field.begin(settings, 'Test', 'first');
    field.observe(status());
    field.observe(status(100, 40, 1));
    field.observe(status(100, 40, 1));
    field.observe(status(10, 5, 0));
    field.observe(status(80, 30, 2));
    expect(field.experienceFor(status())).toMatchObject({ baseGained: 80, jobGained: 30 });
    field.observe({ ...status(21, 18, 1, 'second'), runRequested: false }); // Old reward in reconnect initialization.
    const resume = field.resumeFor({ ...status(21, 18, 1, 'second'), runRequested: false })!;
    expect(field.completeResume(resume, true)).toBe(true);
    field.observe(status(0, 0, 0, 'second'));
    field.observe(status(42, 36, 2, 'second'));
    field.observe(status(100, 40, 1)); // Retired page publications cannot recount its rewards.
    expect(field.experienceFor(status(0, 0, 0, 'second'))).toMatchObject({
      baseGained: 122,
      jobGained: 66,
    });
    field.stop();
    field.observe({ ...status(42, 36, 2, 'second'), runRequested: false });
    expect(
      field.experienceFor({ ...status(42, 36, 2, 'second'), runRequested: false }),
    ).toMatchObject({ baseGained: 122, jobGained: 66 });
    expect(field.experienceFor({ ...status(), player: { name: 'Other' } })).toBeNull();
    field.begin(settings, 'Other', 'third');
    expect(field.experienceFor({ ...status(), player: { name: 'Other' } })).toMatchObject({
      baseGained: 0,
      jobGained: 0,
    });
  });
  it('keeps an unobserved active run unknown and leaves a distinct macro run visible', () => {
    const field = new PersistentFieldRun(() => 100_000);
    field.begin(settings, 'Test', 'first');
    field.observe({ ...status(), runExperience: undefined });
    expect(field.experienceFor(status())).toMatchObject({ baseGained: null, jobGained: null });
    field.observe(status(10, 5, 1));
    field.stop();
    expect(field.experienceFor(status(0, 0, 0, 'first', 2))).toMatchObject({
      run: 2,
      baseGained: 0,
      jobGained: 0,
    });
    expect(field.experienceFor(status(0, 0, 0, 'macroPage'))).toMatchObject({
      baseGained: 0,
      jobGained: 0,
    });
  });
  it('roundtrips signed checkpoint gains and does not put the EXP cursor in native counter records', async () => {
    const field = new PersistentFieldRun(() => 100_000),
      dispatch = new RunIntentDispatch(field, new ReconnectPolicy(), async () => {});
    await dispatch.start(settings, { ...status(90, 10, 4), runRequested: false });
    field.observe(status(0, 0, 0, 'first', 2));
    field.observe(status(-20, 40, 1, 'first', 2));
    field.observe(status(90, 10, 4)); // A retired explicit run cannot replace the current cursor.
    const saved = JSON.parse(JSON.stringify(field.checkpoint()));
    expect(Object.keys(saved.previous).sort()).toEqual(['attacks', 'deaths', 'kills', 'looted']);
    const checked = validateFieldRunCheckpoint(saved, 100_000),
      restored = new PersistentFieldRun(() => 100_000);
    restored.restore(checked);
    restored.observe(status(-20, 40, 1, 'first', 2));
    expect(restored.experienceFor(status())).toMatchObject({ baseGained: -20, jobGained: 40 });
    saved.experience.previous.character = 'Other';
    expect(() => validateFieldRunCheckpoint(saved, 100_000)).toThrow('experience');
  });
  it('keeps missing/overflowing evidence unknown and formats signed losses', () => {
    expect(
      addExperience(
        { baseGained: Number.MAX_SAFE_INTEGER, jobGained: null },
        { baseGained: 1, jobGained: 10 },
      ),
    ).toEqual({ baseGained: null, jobGained: null });
    expect(
      validRunExperience({ ...status().runExperience, revision: Number.MAX_SAFE_INTEGER + 1 }),
    ).toBe(false);
    expect(validRunExperience({ ...status().runExperience, unexpected: true })).toBe(false);
    expect(signedExperience(-21)).toBe('-21');
    expect(signedExperience(0)).toBe('+0');
    expect(signedExperience(null)).toBe('—');
  });
});

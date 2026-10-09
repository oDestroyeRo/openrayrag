import { expect, it, vi } from 'vitest';
import { CurrentForm, formDocument } from './current-form';
import { DEFAULT_SETTINGS, validateSettings } from './settings';
import { MapTargets } from './targets';
it('retains configured target IDs before map/level/catalog readiness without weakening Start', () => {
  const targets = new MapTargets();
  targets.restore('prt_fild08', [4000]);
  targets.update('', { code: '', name: '', source: 'observed', monsters: [] }, null);
  targets.select(4000, true);
  expect(targets.configuredMap).toBe('prt_fild08');
  expect(targets.configuredIds).toEqual([4000]);
  expect(targets.ids).toEqual([]);
  targets.update(
    'session',
    {
      code: 'prt_fild08',
      name: 'map',
      source: 'observed',
      monsters: [
        { classId: 4000, name: 'Poring', level: 1, maxHp: 1, spawnCount: 1, visibleCount: 1 },
      ],
    },
    null,
  );
  expect(targets.checked(4000)).toBe(true);
  expect(targets.ids).toEqual([]);
  targets.update(
    'session',
    { code: 'prt_fild08', name: 'map', source: 'observed', monsters: [] },
    10,
  );
  expect(targets.ids).toEqual([4000]);
  expect(() => validateSettings(DEFAULT_SETTINGS)).toThrow();
  expect(
    formDocument({ version: 1, revision: 0, selectedProfileId: null, settings: DEFAULT_SETTINGS })
      .settings,
  ).toEqual(DEFAULT_SETTINGS);
});
it('restores legacy current forms with the cutoff removed and metadata retained', () => {
  const input = {
    version: 1,
    revision: 53,
    selectedProfileId: 'saved',
    settings: { ...DEFAULT_SETTINGS, minHpPercent: 95 },
  };
  const restored = formDocument(input);
  expect(restored).toMatchObject({ revision: 53, selectedProfileId: 'saved' });
  expect(restored.settings).toEqual(DEFAULT_SETTINGS);
  expect(restored.settings).not.toHaveProperty('minHpPercent');
  expect(input.settings.minHpPercent).toBe(95);
});
it('manual edits win a delayed restore and saves are serialized by revision', async () => {
  let radius = 13;
  const writes: number[] = [];
  let release: () => void = () => {};
  const form = new CurrentForm(
    () => ({ settings: { ...DEFAULT_SETTINGS, radius }, selectedProfileId: null }),
    async (d) => {
      writes.push(d.settings.radius);
      if (writes.length === 1)
        await new Promise<void>((r) => {
          release = r;
        });
      return d.revision;
    },
  );
  form.touch();
  const apply = vi.fn();
  form.restore(
    { version: 1, revision: 10, selectedProfileId: null, settings: DEFAULT_SETTINGS },
    apply,
  );
  expect(apply).not.toHaveBeenCalled();
  const a = form.flush();
  await Promise.resolve();
  await Promise.resolve();
  radius = 18;
  form.touch();
  const b = form.flush();
  expect(writes).toEqual([13]);
  release();
  await a;
  const saved = await b;
  expect(writes).toEqual([13, 18]);
  expect(saved.revision).toBe(12);
});
it('unknown secret/intent fields and invalid dirty input reject without writing', async () => {
  const save = vi.fn();
  const form = new CurrentForm(
    () => ({ settings: { ...DEFAULT_SETTINGS, radius: 99 }, selectedProfileId: null }),
    save,
  );
  await expect(form.flush()).rejects.toThrow();
  expect(save).not.toHaveBeenCalled();
  for (const key of [
    'password',
    'running',
    'runRequested',
    'refine',
    'previewToken',
    'refineReceipt',
    'refineConfirmation',
  ])
    expect(() =>
      formDocument({
        version: 1,
        revision: 0,
        selectedProfileId: null,
        settings: DEFAULT_SETTINGS,
        [key]: true,
      }),
    ).toThrow();
});
it('an assistant save has an explicit callback without tagging later human saves or replacing newer drafts', async () => {
  let radius = 14;
  const uiSave = vi.fn(async (document) => document.revision);
  const form = new CurrentForm(
    () => ({ settings: { ...DEFAULT_SETTINGS, radius }, selectedProfileId: null }),
    uiSave,
  );
  form.restore(null, () => {});
  let release!: () => void;
  const saved: number[] = [];
  const assistant = form.flush(async (document) => {
    saved.push(document.settings.radius);
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return document.revision;
  });
  await Promise.resolve();
  await Promise.resolve();
  radius = 18;
  form.touch();
  const human = form.flush();
  release();
  await assistant;
  await human;
  expect(saved).toEqual([14]);
  expect(uiSave).toHaveBeenCalledOnce();
  expect(uiSave.mock.calls[0]?.[0].settings.radius).toBe(18);
  expect(radius).toBe(18);
});

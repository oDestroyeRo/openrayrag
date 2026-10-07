import { describe, expect, it } from 'vitest';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, settingsDraft } from './settings';
import {
  acknowledgedLiveSettings,
  liveSettingLabel,
  planLiveSettings,
  settingsChanges,
} from './live-settings-logic';

function settings() {
  return {
    ...DEFAULT_SETTINGS,
    map: 'prt_fild08',
    targets: [4000],
    automation: structuredClone(DEFAULT_AUTOMATION),
  };
}
describe('live settings admission', () => {
  it('recognizes unchanged native rule values across property order and acknowledgements', () => {
    const active = settings(),
      draft = settings();
    active.automation.items = [
      { belowPercent: 60, cooldownSeconds: 5, itemId: 512, minStock: 0, resource: 'hp' },
    ];
    draft.automation.items = [
      { itemId: 512, resource: 'hp', belowPercent: 60, minStock: 0, cooldownSeconds: 5 },
    ];
    const plan = planLiveSettings(active, draft);
    expect(plan.live).toEqual([]);
    expect(plan.nextRun).toEqual([]);
    const acknowledgement = acknowledgedLiveSettings(active, plan.settings);
    expect(planLiveSettings(acknowledgement, draft).live).toEqual([]);
    draft.automation.items = draft.automation.items.map((rule) => ({ ...rule, belowPercent: 65 }));
    expect(planLiveSettings(active, draft).live).toEqual(['automation.items']);
  });
  it('retains rule order as a meaningful settings change', () => {
    const first = {
      itemId: 512,
      resource: 'hp',
      belowPercent: 60,
      minStock: 0,
      cooldownSeconds: 5,
    };
    const second = { ...first, itemId: 501 };
    expect(settingsChanges({ items: [first, second] }, { items: [second, first] })).toEqual([
      'items',
    ]);
  });
  it('formats field names for player decisions', () => {
    expect(liveSettingLabel('automation.hpPotions.belowPercent')).toBe('HP items · Threshold');
    expect(liveSettingLabel('automation.hpPotions.minStock')).toBe('HP items · Stock reserve');
    expect(liveSettingLabel('automation.limits.minutes')).toBe('Limits · Minutes');
    expect(liveSettingLabel('route_step')).toBe('Route step');
  });
  it('detaches supported changes while retaining original budgets, maps and equipment', () => {
    const active = settings(),
      draft = settings();
    draft.targets = [4007];
    draft.radius = 8;
    draft.loot = false;
    draft.automation.limits.kills = 99;
    draft.automation.travel.destinationMap = 'prontera';
    draft.automation.equipment = [{ itemId: 1201, hpBelowPercent: 60, monsterClassId: 4000 }];
    draft.automation.hpPotions = {
      mode: 'selected',
      itemIds: [501],
      belowPercent: 70,
      minStock: 2,
      cooldownSeconds: 10,
    };
    const plan = planLiveSettings(active, draft);
    expect(plan.settings).toMatchObject({
      targets: [4007],
      radius: 8,
      loot: false,
      automation: {
        limits: active.automation.limits,
        travel: active.automation.travel,
        equipment: [],
        hpPotions: draft.automation.hpPotions,
      },
    });
    expect(plan.live).toEqual(
      expect.arrayContaining(['targets', 'radius', 'loot', 'automation.hpPotions']),
    );
    expect(plan.nextRun).toEqual(
      expect.arrayContaining([
        'automation.limits.kills',
        'automation.travel.destinationMap',
        'automation.equipment',
      ]),
    );
    draft.targets.push(9999);
    draft.automation.hpPotions.itemIds.push(504);
    expect(plan.settings.targets).toEqual([4007]);
    expect(plan.settings.automation?.hpPotions?.itemIds).toEqual([501]);
  });
  it('rejects an invalid unsupported setting before projecting any live edit', () => {
    const draft = settings();
    draft.radius = 7;
    draft.automation.limits.minutes = 1441;
    expect(() => planLiveSettings(settings(), draft)).toThrow('Invalid automation');
  });
  it('rejects a valid full draft when the supported subset breaks active relationships', () => {
    const active = settings(),
      draft = settings();
    draft.targets = [];
    expect(() => planLiveSettings(active, draft)).toThrow('Choose selected monsters');
  });
  it('protects original reserves and cooldowns when moving a carried item between rule owners', () => {
    const active = settings();
    active.automation.hpPotions = {
      mode: 'selected',
      itemIds: [501],
      belowPercent: 60,
      minStock: 3,
      cooldownSeconds: 20,
    };
    const draft = settings();
    draft.automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 80, minStock: 0, cooldownSeconds: 1 },
    ];
    const plan = planLiveSettings(active, draft);
    expect(plan.settings.automation?.items[0]).toMatchObject({
      belowPercent: 80,
      minStock: 3,
      cooldownSeconds: 20,
    });
    expect(plan.nextRun).toContain('automation.items');
    const removed = settingsDraft(plan.settings);
    removed.automation!.items = [];
    const again = planLiveSettings(removed, draft, active);
    expect(again.settings.automation?.items[0]).toMatchObject({ minStock: 3, cooldownSeconds: 20 });
  });
});

import { describe, it, expect } from 'vitest';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  validateAutomation,
  type AutomationSettings,
} from '../settings/settings';
import { ProfileStore } from '../settings/profiles';
const rule = {
  id: 'first',
  speciesIds: [4000, 4001],
  skillId: 11 as const,
  level: 1,
  behavior: 'opener' as const,
  maxAttempts: 2,
  maxUses: 1,
  cooldownSeconds: 1,
};
describe('attack strategy schema and profile compatibility', () => {
  it('keeps legacy omission and accepts independent duplicate skills in ordered rules', () => {
    expect(
      Object.hasOwn(validateAutomation(structuredClone(DEFAULT_AUTOMATION)), 'attackStrategies'),
    ).toBe(false);
    const a = {
      ...structuredClone(DEFAULT_AUTOMATION),
      attackStrategies: [rule, { ...rule, id: 'second' }],
    };
    expect(validateAutomation(a).attackStrategies?.map((entry) => entry.id)).toEqual([
      'first',
      'second',
    ]);
  });
  it.each([
    { skillId: 19 },
    { level: 0 },
    { maxAttempts: 0 },
    { maxUses: 3 },
    { cooldownSeconds: 3601 },
    { id: 'bad id' },
    { speciesIds: [] },
    { speciesIds: [4000, 4000] },
    { behavior: 'combo' },
    { behavior: { opener: null } },
    { behavior: { repeat: null } },
    { conditions: null },
    {
      conditions: [
        {
          field: 'actorStatus',
          actor: { scope: 'candidate' },
          statusId: 1,
          operator: 'eq',
          value: true,
        },
      ],
    },
    { rawPacket: [1] },
  ])('rejects malformed or unsupported rules %j', (change) => {
    const value = {
      ...structuredClone(DEFAULT_AUTOMATION),
      attackStrategies: [{ ...rule, ...change }],
    };
    expect(() => validateAutomation(value as AutomationSettings)).toThrow();
  });
  it('rejects duplicate identities, null lists and unbounded lists', () => {
    for (const attackStrategies of [
      null,
      [rule, rule],
      Array.from({ length: 33 }, (_, n) => ({ ...rule, id: `rule-${n}` })),
    ])
      expect(() =>
        validateAutomation({
          ...structuredClone(DEFAULT_AUTOMATION),
          attackStrategies,
        } as AutomationSettings),
      ).toThrow();
  });
  it('round trips profiles without inventing a strategy list in legacy profiles', () => {
    let text: string | null = null,
      n = 0;
    const store = new ProfileStore(
      {
        getItem: () => text,
        setItem: (_, value) => {
          text = value;
        },
      },
      () => `profile-${++n}`,
      () => 1000,
    );
    const settings = {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      automation: structuredClone(DEFAULT_AUTOMATION),
    };
    const saved = store.save('Legacy', 'Mage', settings);
    expect(Object.hasOwn(saved.settings.automation!, 'attackStrategies')).toBe(false);
    settings.automation.attackStrategies = [rule, { ...rule, id: 'second' }];
    const next = store.save('Bolts', 'Mage', settings);
    expect(store.import(store.export(next.id))[0]!.settings.automation!.attackStrategies).toEqual([
      rule,
      { ...rule, id: 'second' },
    ]);
  });
});

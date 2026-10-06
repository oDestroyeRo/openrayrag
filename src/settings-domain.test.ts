import type { BotEngine } from './engine';
import type { ManualEngineSettings } from './manual-target-logic';
import { describe, expect, it } from 'vitest';
import { percentage, seconds, type ItemId, type Percentage, type Seconds, type SkillId } from './domain-values';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, automationDraft, automationSettings, settingsDraft,
  validateAutomation, validateFormSettings, validateSettings, type AutomationSettings, type RunSettings,
  type Settings, type AutomationSettingsInput, type ValidatedAutomationSettings, type ValidatedFormSettings } from './settings';

const draft = (): Settings => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000],
  automation: structuredClone(DEFAULT_AUTOMATION) });

describe('settings domain admission', () => {
  it('preserves the JSON representation and detaches nested editable projections', () => {
    const raw = draft();
    raw.automation!.items = [{ itemId: 501, resource: 'hp', belowPercent: 70, minStock: 2, cooldownSeconds: 3 }];
    const admitted = validateSettings(raw);
    expect(JSON.stringify(admitted)).toBe(JSON.stringify(raw));
    expect(Object.getOwnPropertySymbols(admitted)).toEqual([]);
    expect(Object.getOwnPropertySymbols(admitted.automation!)).toEqual([]);
    const edited = settingsDraft(admitted);
    edited.targets.push(4001);
    edited.automation!.items[0]!.itemId = 502;
    const automation = automationDraft(automationSettings(admitted));
    automation.items[0]!.minStock = 9;
    raw.automation!.items[0]!.belowPercent = 80;
    expect(admitted.targets).toEqual([4000]);
    expect(admitted.automation!.items[0]).toEqual({ itemId: 501, resource: 'hp', belowPercent: 70, minStock: 2, cooldownSeconds: 3 });
  });

  it('keeps form admission separate from the stricter run admission', () => {
    expect(validateFormSettings(DEFAULT_SETTINGS).map).toBe('');
    expect(() => validateSettings(DEFAULT_SETTINGS)).toThrow('Invalid settings. Choose current-map monsters and valid combat and routing limits.');
    expect(validateSettings(draft()).map).toBe('prt_fild08');
  });

  it('retains first-error ordering and aggregate recovery validation', () => {
    const invalid = draft();
    invalid.radius = 0;
    invalid.automation!.recovery.hpStart = invalid.automation!.recovery.hpEnd;
    expect(() => validateSettings(invalid)).toThrow('Invalid settings. Choose current-map monsters and valid combat and routing limits.');
    invalid.radius = 12;
    expect(() => validateSettings(invalid)).toThrow('Invalid automation settings. Check rules, recovery thresholds and session limits.');
    expect(() => validateAutomation({ ...DEFAULT_AUTOMATION, recovery: { ...DEFAULT_AUTOMATION.recovery, hpStart: 85, hpEnd: 60 } })).toThrow('Invalid automation settings. Check rules, recovery thresholds and session limits.');
    invalid.automation!.recovery = { ...DEFAULT_AUTOMATION.recovery, enabled: true, hpStart: invalid.minHpPercent };
    expect(() => validateSettings(invalid)).toThrow('Recovery HP start must be above the emergency HP stop limit.');
  });
});

// Compile-time contracts run through the same tsc gate as production consumers.
function typeContracts(raw: Settings, rawAutomation: AutomationSettings, form: ValidatedFormSettings,
  run: RunSettings, automation: ValidatedAutomationSettings, engine:BotEngine, manual:ManualEngineSettings) {
  // @ts-expect-error Recovery ticks consume settings admitted once at run entry.
  engine.recoveryOnly(raw);
  engine.settings=manual;
  // @ts-expect-error A structural manual settings copy must pass its own aggregate admission.
  engine.settings={...manual};
  // @ts-expect-error Unrelated policy edits cannot forge manual settings admission at the real engine consumer.
  engine.settings={...manual,minHpPercent:percentage(0)};
  const acceptsRun = (_value: RunSettings) => undefined;
  const acceptsForm = (_value: ValidatedFormSettings) => undefined;
  const acceptsAutomation = (_value: ValidatedAutomationSettings) => undefined;
  const acceptsPercentage = (_value: Percentage) => undefined;
  const acceptsSeconds = (_value: Seconds) => undefined;
  const acceptsItem = (_value: ItemId) => undefined;
  const acceptsSkill = (_value: SkillId) => undefined;
  // @ts-expect-error Raw settings have not passed aggregate admission.
  acceptsRun(raw);
  // @ts-expect-error A stopped form can lack the fields required for a run.
  acceptsRun(form);
  acceptsForm(run);
  // @ts-expect-error A spread removes aggregate admission even if branded scalar fields are unchanged.
  acceptsForm({...form});
  const invalidAutomation={...automation,recovery:{...automation.recovery,hpStart:percentage(90),hpEnd:percentage(50)}};
  // @ts-expect-error A cross-field invalid edit must pass the aggregate parser again.
  acceptsAutomation(invalidAutomation);
  // @ts-expect-error The real helper cannot manufacture aggregate admission from an edited structural copy.
  acceptsAutomation(automationSettings({automation:invalidAutomation}));
  // @ts-expect-error Scalar structure alone does not establish automation admission.
  acceptsAutomation(rawAutomation);
  const structural: AutomationSettingsInput = automation;
  // @ts-expect-error A structural input must still pass aggregate admission.
  acceptsAutomation(structural);
  acceptsPercentage(run.minHpPercent);
  acceptsSeconds(run.attackMaxRouteTime);
  // @ts-expect-error Percentages cannot be used as durations.
  acceptsSeconds(run.minHpPercent);
  // @ts-expect-error Wire durations cannot be used as percentages.
  acceptsPercentage(seconds(45));
  acceptsItem(automation.items[0]!.itemId);
  acceptsSkill(automation.skills[0]!.skillId);
  // @ts-expect-error Item and skill identifiers are distinct domains.
  acceptsItem(automation.skills[0]!.skillId);
  // @ts-expect-error An admitted model cannot be edited as a draft.
  run.targets.push(4001);
}
void typeContracts;

import { describe, expect, it } from 'vitest';
import { isFailure } from 'effect/Result';
import cases from '../../data/macro-script-cases.json';
import {
  BOT_SCRIPT_LIMITS,
  BotScriptError,
  formatBotScript,
  parseBotScript,
  parseBotScriptResult,
  replaceBotScriptSettings,
  updateBotScriptSettings,
} from './bot-script';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_ESCAPE,
  DEFAULT_LOADOUT,
  DEFAULT_PARTY_HEAL,
  DEFAULT_RETREAT,
  DEFAULT_SETTINGS,
  validateFormSettings,
  type Settings,
} from './settings';
import { validateMacroScript, type MacroScript } from '../automation/macros';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy';
import { DEFAULT_SUPPLY } from '../services/supply-trip';
import {
  DEFAULT_RECOVERY_ITEMS,
  DEFAULT_SP_ITEMS,
  RECOVERY_ITEM_IDS,
} from '../recovery/recovery-items';
import type { ActorPredicate, ActorSelector } from '../world/actor-observations';
import type { RoutineCondition } from '../automation/routines';

const world = '00000000-0000-0000-0000-000000000001';
const actor: ActorSelector = { scope: 'actor', id: 0, world, incarnation: 2147483647 };
const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  map: 'prt_fild08',
  targets: [4000, 4012],
});
function macro(
  conditions: RoutineCondition[] = [{ field: 'level', operator: 'gte', value: 1 }],
): MacroScript {
  return {
    version: 1,
    name: 'Train #1',
    durationSeconds: 3600,
    maxActions: 20,
    maxSpend: 0,
    rules: [
      {
        name: 'Farm',
        priority: 0,
        cooldownSeconds: 0,
        maxRuns: 1,
        conditions,
        steps: [{ type: 'farm', map: 'prt_fild08', targets: [4000], timeoutSeconds: 300 }],
      },
    ],
  };
}
function populatedSettings(): Settings {
  const value = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
  const a = value.automation;
  a.loadout = {
    ...DEFAULT_LOADOUT,
    enabled: true,
    minAmmoStock: 20,
    ammoPreferences: [{ itemId: 1752 }, { itemId: 1750 }],
  };
  a.partyHeal = { ...DEFAULT_PARTY_HEAL, enabled: true };
  a.combat.rules = [
    {
      classId: 4000,
      action: 'attack',
      priority: 15,
      conditions: [
        { field: 'actorHpPercent', actor: { scope: 'candidate' }, operator: 'lte', value: 70.5 },
      ],
    },
    { classId: 4012, action: 'ignore', priority: -5, conditions: [] },
  ];
  a.loot.rules = [
    { itemId: 909, action: 'pickup', priority: 3 },
    { itemId: 910, action: 'ignore', priority: -2 },
  ];
  a.recovery.enabled = true;
  a.escape = { ...DEFAULT_ESCAPE, enabled: true };
  a.items = [
    {
      itemId: 501,
      resource: 'hp',
      belowPercent: 60,
      minStock: 4,
      cooldownSeconds: 5,
      conditions: [
        {
          field: 'actorStatus',
          actor: { scope: 'self' },
          statusId: 29,
          operator: 'ne',
          value: true,
        },
      ],
    },
    { itemId: 505, resource: 'sp', belowPercent: 40, minStock: 3, cooldownSeconds: 7 },
  ];
  a.hpPotions = {
    ...DEFAULT_RECOVERY_ITEMS,
    mode: 'selected',
    itemIds: [...RECOVERY_ITEM_IDS.hp.slice(0, 3)].reverse(),
  };
  a.spPotions = {
    ...DEFAULT_SP_ITEMS,
    mode: 'selected',
    itemIds: [...RECOVERY_ITEM_IDS.sp.slice(0, 3)].reverse(),
  };
  a.skills = [
    {
      skillId: 2,
      level: 1,
      target: 'self',
      hpBelowPercent: 80,
      spAbovePercent: 20,
      cooldownSeconds: 5,
      conditions: [{ field: 'actorSpPercent', actor, operator: 'gte', value: 20.125 }],
    },
  ];
  a.equipment = [
    {
      itemId: 1201,
      hpBelowPercent: 70,
      monsterClassId: 4000,
      conditions: [
        {
          field: 'actorCasting',
          actor: { scope: 'target' },
          skillId: 28,
          operator: 'eq',
          value: false,
        },
      ],
    },
  ];
  a.attackStrategies = [
    {
      id: 'opener',
      speciesIds: [4012, 4000],
      skillId: 11,
      level: 3,
      behavior: 'opener',
      maxAttempts: 5,
      maxUses: 2,
      cooldownSeconds: 10,
      conditions: [{ field: 'actorCasting', actor, operator: 'ne', value: true }],
    },
  ];
  a.retreat = { ...DEFAULT_RETREAT, enabled: true };
  a.allocation = {
    stats: [
      { stat: 2, target: 20 },
      { stat: 0, target: 10 },
    ],
    skills: [
      { skillId: 2, target: 1 },
      { skillId: 3, target: 5 },
    ],
  };
  a.follow = { mode: 'partyLeader', rendezvous: true, name: '', distance: 3, lostSeconds: 15 };
  a.travel = {
    destinationMap: 'prt_fild08',
    returnToLockMap: true,
    waypoints: [
      { map: 'prontera', x: 120, y: 100 },
      { map: 'prt_fild08', x: 50, y: 30 },
    ],
    loop: false,
  };
  a.limits = { minutes: 90, kills: 1000, pickups: 500, weightPercent: 85 };
  a.respawn = { enabled: true, maxDeaths: 0 };
  a.schedule = { enabled: true, startHour: 21, endHour: 6 };
  a.disposition = {
    maxSpend: 1000,
    rules: [
      {
        itemId: 501,
        keep: 1,
        minimum: 2,
        desired: 10,
        maximum: 20,
        store: true,
        sell: false,
        cart: true,
        restock: 'buy',
        allowUnique: false,
      },
      {
        itemId: 909,
        keep: 0,
        minimum: 0,
        desired: 0,
        maximum: 10,
        store: false,
        sell: true,
        cart: false,
        restock: 'off',
        allowUnique: false,
      },
    ],
  };
  a.supply = {
    ...DEFAULT_SUPPLY,
    enabled: true,
    storageService: 'kafra-south-storage',
    buyService: 'tool-dealer-buy',
    maxSpend: 1000,
  };
  a.mapPolicy = {
    ...DEFAULT_MAP_POLICY,
    mode: 'weighted',
    allow: ['prt_fild08', 'prontera'],
    deny: ['prt_fild07'],
    penalties: [
      { map: 'prontera', cost: 12.5 },
      { map: 'prt_fild08', cost: 100 },
    ],
    lockArea: { map: 'prt_fild08', minX: 10, minY: 20, maxX: 30, maxY: 40 },
  };
  validateFormSettings(value);
  return value;
}
function lineError(source: string, line: number, message?: string): void {
  try {
    parseBotScript(source);
    expect.fail('Expected invalid source.');
  } catch (error) {
    expect(error).toBeInstanceOf(BotScriptError);
    expect((error as BotScriptError).line).toBe(line);
    if (message) expect((error as Error).message).toContain(message);
  }
}
const withRule = (body: string): string => `script "Test"\nrule "Run"\n${body}\nend`;

describe('approachable bot scripts', () => {
  it('round-trips zero HP cooldown and retains it when importing legacy JSON macros', () => {
    const document = parseBotScript(
      'script "HP recovery"\nset automation.hpPotions.mode = selected\nset automation.hpPotions.itemIds = [501]\nset automation.hpPotions.cooldownSeconds = 0s',
    );
    expect(document.settings.automation?.hpPotions).toMatchObject({
      mode: 'selected',
      itemIds: [501],
      cooldownSeconds: 0,
    });
    expect(parseBotScript(formatBotScript(document))).toEqual(document);
    expect(parseBotScript(JSON.stringify(macro()), document.settings).settings).toEqual(
      document.settings,
    );
    for (const cooldown of ['-1s', '0.5s', '3601s'])
      lineError(`script "HP recovery"\nset automation.hpPotions.cooldownSeconds = ${cooldown}`, 2);
    lineError('script "SP recovery"\nset automation.spPotions.cooldownSeconds = 0s', 2);
  });
  it('retains BotScriptError line and message in total admission and the throwing adapter', () => {
    const source = 'script "Invalid"\nset radius = 99';
    const admitted = parseBotScriptResult(source);
    expect(isFailure(admitted)).toBe(true);
    if (isFailure(admitted)) {
      expect(admitted.failure).toBeInstanceOf(BotScriptError);
      expect(admitted.failure).toMatchObject({
        line: 2,
        message: 'Line 2: Use a whole number from 1 to 20.',
      });
      expect(() => parseBotScript(source)).toThrow((admitted.failure as Error).message);
    }
  });
  it('short-circuits dependent document admission before reading rules or retained legacy settings', () => {
    let rules = 0,
      retained = 0;
    const document = {
      settings: { ...DEFAULT_SETTINGS, radius: 99 },
      get script(): MacroScript | null {
        rules++;
        throw new Error('Rules should not be read.');
      },
    };
    expect(() => formatBotScript(document)).toThrow(BotScriptError);
    expect(rules).toBe(0);
    const legacySettings = {
      ...DEFAULT_SETTINGS,
      get map(): string {
        retained++;
        throw new Error('Retained settings should not be read.');
      },
    };
    const admitted = parseBotScriptResult('{"version":2}', legacySettings);
    expect(isFailure(admitted)).toBe(true);
    if (isFailure(admitted)) expect(admitted.failure).toBeInstanceOf(BotScriptError);
    expect(retained).toBe(0);
  });
  it('compiles one settings/rules document with safe bounded defaults and readable units', () => {
    const document = parseBotScript(
      `# Poring field\nscript "Poring field"\nset map = prt_fild08\nset targets = [4000, 4012]\nset radius = 12\nset emergency-hp = 45%\nset route-time = 2m\nset automation.combat.mode = selected\nset automation.limits.minutes = 1.5h\nrule "Farm"\nwhen level >= 1\nfarm prt_fild08 targets [4000, 4012]\nend\nrule "First Aid"\npriority 100\ncooldown 10s\nruns unlimited\nwhen hp < 60%\nwhen sp >= 30%\nskill 2 level 1 self\nend`,
    );
    expect(document.settings).toMatchObject({
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000, 4012],
      route_randomWalk_maxRouteTime: 120,
      automation: { combat: { mode: 'selected' }, limits: { minutes: 90 } },
    });
    expect(document.script).toMatchObject({
      durationSeconds: 3600,
      maxActions: 20,
      maxSpend: 0,
      rules: [
        { priority: 0, cooldownSeconds: 0, maxRuns: 1, steps: [{ timeoutSeconds: 300 }] },
        { priority: 100, cooldownSeconds: 10, maxRuns: 0, steps: [{ timeoutSeconds: 30 }] },
      ],
    });
    expect(parseBotScript(formatBotScript(document))).toEqual(document);
  });

  it('accepts offline settings-only drafts without selecting a map or monsters', () => {
    expect(parseBotScript('script "My setup"')).toEqual({
      settings: DEFAULT_SETTINGS,
      script: null,
    });
    const draft = parseBotScript(
      'script "Offline"\nset map = ""\nset targets = []\nset automation.follow.name = "Friend #1"',
    );
    expect(draft.script).toBeNull();
    expect(draft.settings).toMatchObject({
      map: '',
      targets: [],
      automation: { follow: { name: 'Friend #1' } },
    });
    expect(parseBotScript(formatBotScript(draft))).toEqual(draft);
  });

  it('keeps all populated optional sections, ordered complex arrays, actor conditions and null locks', () => {
    const full = populatedSettings(),
      before = structuredClone(full);
    const source = formatBotScript({ settings: full, script: macro() });
    expect(source).toContain(
      'set automation.combat.rules[0].conditions[0].actor.scope = "candidate"',
    );
    expect(source).toContain('set automation.mapPolicy.penalties[0].cost = 12.5');
    expect(source).not.toContain(' = {');
    expect(parseBotScript(source)).toEqual({ settings: full, script: macro() });
    expect(full).toEqual(before);
    full.automation!.mapPolicy!.lockArea = null;
    expect(parseBotScript(formatBotScript({ settings: full, script: null })).settings).toEqual(
      full,
    );
  });

  it('retains absent optional fields instead of inventing explicit policy settings', () => {
    const full = populatedSettings();
    for (const key of [
      'escape',
      'partyHeal',
      'retreat',
      'attackStrategies',
      'hpPotions',
      'spPotions',
      'mapPolicy',
      'supply',
      'disposition',
    ] as const)
      delete full.automation![key];
    delete full.automation!.combat.partyEngagement;
    full.automation!.follow = { name: '', distance: 4, lostSeconds: 10 };
    const parsed = parseBotScript(formatBotScript({ settings: full, script: null })).settings;
    expect(parsed).toEqual(full);
    expect(parsed.automation).not.toHaveProperty('escape');
    const legacy = structuredClone(full);
    delete (legacy.automation as Partial<typeof legacy.automation>)!.loadout;
    expect(parseBotScript(formatBotScript({ settings: legacy, script: null })).settings).toEqual(
      legacy,
    );
    expect(
      parseBotScript(formatBotScript({ settings: settings(), script: null })).settings,
    ).not.toHaveProperty('automation');
  });

  it('preserves quoted hashes, escaped quotes, Unicode names and comments', () => {
    const doc = parseBotScript(
      'script "เก็บ \\"items\\" #1" # comment\nset automation.follow.name = "Friend #1" # another comment\nrule "Recover #1"\nwhen map != "prontera"\nuse item 501 # send once\nend',
    );
    expect(doc.script!.name).toBe('เก็บ "items" #1');
    expect(doc.settings.automation!.follow.name).toBe('Friend #1');
    expect(parseBotScript(formatBotScript(doc))).toEqual(doc);
  });

  it('compiles every action with finite defaults and exact ordered parameters', () => {
    const document = parseBotScript(
      'script "Services"\nduration 2h\nactions 0\nspend 1000\nrule "Route"\nruns 0\nwhen level >= 1\nfarm prt_fild08 targets [4012,4000] timeout 5m\ntravel prontera\nbuy 501 quantity 3 from tool-dealer-buy spend 500\nstore 909 quantity 10 keep 2 at kafra-south-storage spend 0\nuse item 501\nskill 28 level 3 target\nend',
    );
    expect(document.script).toMatchObject({
      durationSeconds: 7200,
      maxActions: 0,
      maxSpend: 1000,
      rules: [
        {
          maxRuns: 0,
          steps: [
            { type: 'farm', map: 'prt_fild08', targets: [4012, 4000], timeoutSeconds: 300 },
            { type: 'travel', map: 'prontera', timeoutSeconds: 300 },
            {
              type: 'buy',
              itemId: 501,
              quantity: 3,
              serviceId: 'tool-dealer-buy',
              maxSpend: 500,
              timeoutSeconds: 600,
            },
            {
              type: 'store',
              itemId: 909,
              quantity: 10,
              keep: 2,
              serviceId: 'kafra-south-storage',
              maxSpend: 0,
              timeoutSeconds: 600,
            },
            { type: 'useItem', itemId: 501, timeoutSeconds: 30 },
            { type: 'skill', skillId: 28, level: 3, mode: 'target', timeoutSeconds: 30 },
          ],
        },
      ],
    });
    expect(parseBotScript(formatBotScript(document))).toEqual(document);
  });

  it('retains each legal zero/unlimited value without making zero spending unlimited', () => {
    const document = parseBotScript(
      'script "Unbounded time"\nset automation.limits.minutes = unlimited\nset automation.limits.kills = unlimited\nset automation.limits.pickups = unlimited\nduration unlimited\nactions unlimited\nspend 0\nrule "Farm"\nruns unlimited\nwhen elapsed >= 1.5m\nfarm prt_fild08 targets [4000]\nend',
    );
    expect(document.script).toMatchObject({
      durationSeconds: 0,
      maxActions: 0,
      maxSpend: 0,
      rules: [{ maxRuns: 0, conditions: [{ field: 'elapsedSeconds', value: 90 }] }],
    });
    expect(parseBotScript(formatBotScript(document))).toEqual(document);
    lineError('script "No spending"\nspend unlimited', 2, 'number');
  });

  it.each(['duration 1m', 'actions 1', 'spend 0'])(
    'rejects unused macro limits in settings-only source: %s',
    (limit) => {
      lineError(
        `script "Field"\nset map = prt_fild08\n${limit}\nset targets = [4000]`,
        3,
        'Macro limits require a rule',
      );
      const document = parseBotScript('script "Field"\nset automation.limits.minutes = 1m');
      expect(document.script).toBeNull();
      expect(document.settings.automation!.limits.minutes).toBe(1);
    },
  );

  it.each(cases.filter((test) => test.valid))(
    'roundtrips existing valid macro corpus: $name',
    (test) => {
      const script = validateMacroScript(test.script),
        retained = settings();
      const original = structuredClone(script);
      const imported = parseBotScript(JSON.stringify(test.script), retained);
      expect(imported).toEqual({ settings: retained, script });
      expect(parseBotScript(formatBotScript(imported))).toEqual(imported);
      expect(script).toEqual(original);
    },
  );
  it.each(cases.filter((test) => !test.valid))('rejects invalid legacy corpus: $name', (test) => {
    expect(() => parseBotScript(JSON.stringify(test.script), settings())).toThrow(BotScriptError);
  });

  const actorConditions: ActorPredicate[] = [];
  for (const selector of [{ scope: 'self' }, { scope: 'target' }, actor] as ActorSelector[]) {
    for (const operator of ['eq', 'ne'] as const) {
      actorConditions.push(
        { field: 'actorStatus', actor: selector, statusId: 255, operator, value: true },
        { field: 'actorCasting', actor: selector, operator, value: false },
        { field: 'actorCasting', actor: selector, skillId: 255, operator, value: true },
      );
    }
    for (const field of ['actorHpPercent', 'actorSpPercent'] as const) {
      for (const operator of ['lt', 'lte', 'eq', 'gte', 'gt'] as const)
        actorConditions.push({ field, actor: selector, operator, value: 12.125 });
    }
  }
  it.each(actorConditions.map((condition, index) => ({ condition, index })))(
    'roundtrips complete actor predicate variant $index',
    ({ condition }) => {
      const document = { settings: settings(), script: macro([condition]) };
      expect(parseBotScript(formatBotScript(document))).toEqual(document);
    },
  );
  const numericConditions: RoutineCondition[] = [];
  for (const operator of ['lt', 'lte', 'eq', 'gte', 'gt'] as const) {
    numericConditions.push(
      { field: 'hpPercent', operator, value: 12.125 },
      { field: 'spPercent', operator, value: 0 },
      { field: 'weightPercent', operator, value: 100 },
      { field: 'level', operator, value: 1000 },
      { field: 'jobLevel', operator, value: 1 },
      { field: 'zeny', operator, value: 2147483647 },
      { field: 'elapsedSeconds', operator, value: 1.125 },
      { field: 'inventory', itemId: 2147483647, operator, value: 0 },
    );
  }
  numericConditions.push(
    { field: 'map', operator: 'eq', value: 'prontera' },
    { field: 'map', operator: 'ne', value: 'prt_fild08' },
  );
  it.each(numericConditions.map((condition, index) => ({ condition, index })))(
    'roundtrips numeric/map/inventory condition variant $index',
    ({ condition }) => {
      const document = { settings: settings(), script: macro([condition]) };
      expect(parseBotScript(formatBotScript(document))).toEqual(document);
    },
  );

  it('imports legacy JSON with cloned retained settings, and leaves its inputs unchanged', () => {
    const retained = populatedSettings(),
      script = macro(),
      before = structuredClone(retained);
    const document = parseBotScript(JSON.stringify(script), retained);
    document.settings.targets.reverse();
    document.settings.automation!.follow.name = 'Changed';
    expect(retained).toEqual(before);
    expect(parseBotScript(JSON.stringify(script)).settings).toEqual(DEFAULT_SETTINGS);
    lineError('{ not JSON }', 1, 'legacy JSON');
  });
});

describe('bot script diagnostics and boundaries', () => {
  it.each([
    ['set radius = 12', 1, 'Begin with'],
    ['script "Test"\nset unknown = true', 2, 'Unknown setting'],
    ['script "Test"\nset loot = "true"', 2, 'true or false'],
    ['script "Test"\nset radius = 45%', 2, 'Unit'],
    ['script "Test"\nset minHpPercent = 1m', 2, 'Unit'],
    ['script "Test"\nset route-time = 2d', 2, 'Unit'],
    ['script "Test"\nset automation.limits.minutes = 1s', 2, 'whole number'],
    ['script "Test"\nset radius = 1.1', 2, 'whole number'],
    ['script "Test"\nset radius = 21', 2, 'from 1 to 20'],
    ['script "Test"\nset random-walk = 1\nset radius = 12', 2, '0 or 2'],
    ['script "Test"\nset radius = NaN', 2, 'number'],
    ['script "Test"\nset radius = 1e999', 2, 'from 1 to 20'],
    ['script "Test"\nset radius = 12\nset radius = 11', 3, 'only once'],
    ['script "Test"\nset emergency-hp = 45%\nset minHpPercent = 40%', 3, 'only once'],
    [
      'script "Test"\nset automation.items = []\nset automation.items[0].itemId = 501',
      3,
      'parent paths',
    ],
    ['script "Test"\nset targets[1] = 4000', 2, 'consecutive'],
    ['script "Test"\nset automation.items[32].itemId = 501', 2, 'out of range'],
    ['script "Test"\nset targets[-1] = 4000', 2, 'whole array indexes'],
    ['script "Test"\nset targets[01] = 4000', 2, 'whole array indexes'],
    ['script "Test"\nset targets[0.5] = 4000', 2, 'whole array indexes'],
    ['script "Test"\nset automation.constructor.prototype.enabled = true', 2, 'not allowed'],
    ['script "Test"\nset automation.__proto__.enabled = true', 2, 'setting path'],
    ['script "Test"\nset automation.combat = {}', 2, 'individually'],
    ['script "Test"\nset automation.combat.rules = [{"classId":4000}]', 2, 'individually'],
    ['script "Test"\nset map = "Unclosed', 2, 'Close the quoted'],
    ['script "Test"\nset loot = true extra', 2, 'Unexpected text'],
    ['script "Test"\nscript "Second"', 2, 'only one'],
    ['script "Test"\nduration 1h\nduration 2h', 3, 'only once'],
    ['script "Test"\nend', 2, 'open rule'],
    ['script "Test"\nrule "Empty"\nuse item 501\nend', 2, 'when condition'],
    ['script "Test"\nrule "Empty"\nwhen level >= 1\nend', 2, 'action'],
    ['script "Test"\nrule "Open"\nwhen level >= 1\nuse item 501', 2, 'Close this rule'],
    ['script "Test"\nrule "Nested"\nrule "Second"', 3, 'previous rule'],
    [withRule('set radius = 10\nwhen level >= 1\nuse item 501'), 3, 'outside rule'],
    [withRule('when hp != 20%\nuse item 501'), 3, 'does not support'],
    [withRule('when map > prontera\nuse item 501'), 3, 'does not support'],
    [withRule('when inventory 501 >= 1.5\nuse item 501'), 3, 'whole number'],
    [withRule('when inventory 501 >= 10%\nuse item 501'), 3, 'Unit'],
    [withRule('when level >= 1\nuse item 501 timeout unlimited'), 4, 'number'],
    [withRule('when level >= 1\nuse item 501 timeout 121s'), 4, 'from 1 to 120'],
    [withRule('when level >= 1\nskill 55 level 1 self'), 4, 'Invalid action'],
    [withRule('when level >= 1\nskill 300 level 1 target'), 4, 'Invalid action'],
    [withRule('when level >= 1\ntravel prontera timeout 0'), 4, 'from 1'],
    [
      withRule('when level >= 1\nbuy 501 quantity 1 from kafra-south-storage spend 0'),
      4,
      'NPC service',
    ],
    [
      withRule('when level >= 1\nbuy 501 quantity 1 from tool-dealer-buy spend 1'),
      4,
      'spend limit',
    ],
    [withRule('when level >= 1\nfarm prt_fild08 targets [4000,4000]'), 4, 'Invalid action'],
    [withRule('when level >= 1\neval "alert(1)"'), 4, 'Unknown action'],
    [withRule('when actor candidate hp < 50%\nuse item 501'), 3, 'number'],
    [
      withRule('when actor 1 world "stale" incarnation 1 hp < 50%\nuse item 501'),
      3,
      'does not support',
    ],
    [withRule('when actor self status 29 < true\nuse item 501'), 3, 'does not support'],
    [withRule('when actor self casting == "false"\nuse item 501'), 3, 'true or false'],
  ] as const)('reports precise line errors for %s', (source, line, message) =>
    lineError(source, line, message),
  );

  it('rejects oversized authoring, line counts and compiled settings/actions', () => {
    lineError(
      `script "Test"\n#${'a'.repeat(BOT_SCRIPT_LIMITS.authoringBytes)}`,
      1,
      'source is too large',
    );
    lineError(`script "Test"${'\n'.repeat(BOT_SCRIPT_LIMITS.lines)}`, 1, 'too many lines');
    const full = populatedSettings();
    full.automation!.mapPolicy!.lockArea = null;
    full.automation!.combat.rules = Array.from({ length: 64 }, (_, index) => ({
      classId: index + 1,
      action: 'attack',
      priority: 0,
      conditions: Array.from({ length: 16 }, () => ({
        field: 'actorSpPercent',
        actor,
        operator: 'gte',
        value: 20,
      })),
    }));
    validateFormSettings(full);
    expect(() => formatBotScript({ settings: full, script: null })).toThrow(
      'Compiled settings are too large',
    );
    const targets = Array.from({ length: 64 }, (_, index) => index + 1).join(',');
    const source = `script "Large"\n${Array.from({ length: 32 }, (_, index) => `rule "Rule ${index}"\nwhen level >= 1\n${`farm prt_fild08 targets [${targets}]\n`.repeat(16)}end`).join('\n')}`;
    expect(new TextEncoder().encode(source).length).toBeLessThan(BOT_SCRIPT_LIMITS.authoringBytes);
    expect(() => parseBotScript(source)).toThrow('Macro document is too large');
  });

  it('applies existing cross-field setting safety and macro action bounds', () => {
    lineError(
      'script "Test"\nset emergency-hp = 60%\nset automation.recovery.enabled = true',
      3,
      'Rest below HP % (60%) must be above Emergency HP stop (60%).',
    );
    lineError(
      withRule(`when level >= 1\n${'use item 501\n'.repeat(17).trim()}`),
      20,
      'at most 16 actions',
    );
    lineError(
      withRule(`${'when level >= 1\n'.repeat(17)}use item 501`),
      19,
      'at most 16 conditions',
    );
    const rule = 'rule "One"\nwhen level >= 1\nuse item 501\nend';
    lineError(`script "Test"\n${rule}\n${rule}`, 6, 'unique');
  });

  it('does not mutate objects or global prototypes when a path is rejected', () => {
    expect(() =>
      parseBotScript('script "Bad"\nset automation.constructor.prototype.polluted = true'),
    ).toThrow();
    expect(Object.prototype).not.toHaveProperty('polluted');
  });
});

describe('synchronizing the graphical settings view', () => {
  it('returns matching validated source and document while preserving authored rules and detached settings', () => {
    const source =
      '# retained\r\nscript "Field #1" # title\r\nset radius = 12 # radius note\r\nduration\t1h\r\nrule "Farm"\r\n  when level >= 1 # condition\r\n  farm prt_fild08 targets [4000] timeout 5m # action\r\nend\r\n';
    const retained = populatedSettings();
    delete retained.automation!.escape;
    const before = structuredClone(retained);
    const updated = updateBotScriptSettings(source, retained);
    expect(updated.text).toBe(replaceBotScriptSettings(source, retained));
    expect(updated.document).toEqual(parseBotScript(updated.text));
    expect(updated.document.settings).not.toHaveProperty('automation.escape');
    expect(updated.text.slice(updated.text.indexOf('duration'))).toBe(
      source.slice(source.indexOf('duration')),
    );
    expect(updated.text).toContain('# radius note\r\n');
    updated.document.settings.targets.reverse();
    updated.document.settings.automation!.follow.name = 'Changed';
    expect(retained).toEqual(before);
  });
  it('returns a matching readable document for legacy imports and rejects invalid external source', () => {
    const retained = populatedSettings(),
      script = macro();
    const updated = updateBotScriptSettings(JSON.stringify(script), retained);
    expect(updated.text).toMatch(/^script /);
    expect(updated.document).toEqual({ settings: retained, script });
    expect(updated.document).toEqual(parseBotScript(updated.text));
    expect(() => updateBotScriptSettings('script "Bad"\nset radius = nope', retained)).toThrow(
      'Line 2:',
    );
    expect(() => updateBotScriptSettings('script "Valid"', { ...retained, radius: 30 })).toThrow(
      BotScriptError,
    );
    expect(() =>
      updateBotScriptSettings(
        `script "Large"\n#${'x'.repeat(BOT_SCRIPT_LIMITS.authoringBytes)}`,
        retained,
      ),
    ).toThrow('source is too large');
  });
  it('replaces settings while preserving every rule/limit line and all comments', () => {
    const source =
      '# My notes\r\nscript "Field #1" # title\r\nset map = prt_fild08 # selected map\r\nset targets = [4000]\r\n# routing note\r\nset radius = 12\r\nduration 1h # allowance\r\nrule "Farm"\r\n  when level >= 1 # condition\r\n  farm prt_fild08 targets [4000] timeout 5m # action\r\nend\r\n';
    const updated = replaceBotScriptSettings(source, populatedSettings());
    expect(parseBotScript(updated).settings).toEqual(populatedSettings());
    expect(parseBotScript(updated).script).toEqual(parseBotScript(source).script);
    for (const line of source.split('\r\n').filter((line) => !line.startsWith('set ')))
      expect(updated).toContain(line);
    expect(updated).toContain('# selected map');
    expect(updated).toContain('\r\n');
    expect(updated.split('\r\n').filter((line) => line === 'set radius = 12')).toHaveLength(1);
  });
  it('inserts offline settings into a settings-only header without losing its comments', () => {
    const source = '# offline\nscript "Offline"\n# choose a map later\n';
    const updated = replaceBotScriptSettings(source, { ...DEFAULT_SETTINGS, radius: 15 });
    expect(parseBotScript(updated)).toEqual({
      settings: { ...DEFAULT_SETTINGS, radius: 15 },
      script: null,
    });
    expect(updated).toContain('script "Offline"');
    expect(updated).toContain('# choose a map later');
  });
  it('refuses invalid drafts/settings and explicitly converts a valid legacy macro', () => {
    const bad = 'script "Bad"\nset radius = nope';
    expect(() => replaceBotScriptSettings(bad, settings())).toThrow(BotScriptError);
    const source = formatBotScript({ settings: settings(), script: macro() });
    expect(() => replaceBotScriptSettings(source, { ...settings(), radius: 30 })).toThrow(
      BotScriptError,
    );
    const updated = replaceBotScriptSettings(JSON.stringify(macro()), populatedSettings());
    expect(updated).toMatch(/^script /);
    expect(parseBotScript(updated)).toEqual({ settings: populatedSettings(), script: macro() });
  });
});

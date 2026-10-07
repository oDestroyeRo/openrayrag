import { describe, expect, it } from 'vitest';
import { CompanionController } from '../runtime/controller';
import { DEFAULT_SETTINGS, validateFormSettings } from '../settings/settings';
import { formatBotScript } from '../settings/bot-script';
import { ProfileStore } from '../settings/profiles';
import {
  mcpObserved,
  mcpReadResult,
  retainedMcpObservation,
  type McpQuery,
  type McpReadContext,
} from './mcp-logic';

const query = (tool: McpQuery['tool'], args: Record<string, unknown> = {}): McpQuery => ({
  id: 'fixture',
  tool,
  arguments: args,
  runtimeGeneration: 2,
});
function fixture(mode: 'botOnly' | 'gameClient') {
  const actions: unknown[] = [];
  const controller = new CompanionController(
    (action) => {
      actions.push(action);
    },
    () => 100_000,
  );
  controller.connect(true);
  controller.engine.receive([
    { type: 'enter', id: 1, map: 'prt_fild08' },
    {
      type: 'spawn',
      entity: {
        id: 1,
        kind: 0,
        classId: 0,
        name: 'Fixture',
        level: 1,
        hp: 100,
        maxHp: 100,
        x: 169,
        y: 193,
        dead: false,
        statuses: [],
      },
    },
  ]);
  controller.world.reset('prt_fild08');
  const settings = validateFormSettings({
    ...DEFAULT_SETTINGS,
    map: 'prt_fild08',
    targets: [4000],
  });
  const context: McpReadContext = {
    now: 101_000,
    runtimeGeneration: 2,
    observation: { generation: 2, sequence: 4, observedAt: 100_000 },
    status: {
      ...controller.snapshot(),
      activeSettings: settings,
      sessionId: 'fixture',
      connectionMode: mode,
      login: { phase: 'complete', message: '' },
      reconnectAvailable: false,
      mapInfo: { code: 'prt_fild08', name: 'Field', source: 'observed', monsters: [] },
    },
    gameOpen: true,
    runRequested: true,
    limitReason: '',
    updateBusy: false,
    updateContinuationPending: false,
    form: { settings: validateFormSettings({ ...settings, radius: 6 }), selectedProfileId: null },
    formInitialized: true,
    profiles: [],
  };
  return { context, controller, actions };
}

describe('MCP read-only projection', () => {
  for (const mode of ['botOnly', 'gameClient'] as const)
    it(`identifies ${mode} observations and retires stale/replaced gameplay`, () => {
      const { context } = fixture(mode);
      expect(mcpReadResult(query('get_status'), context)).toMatchObject({
        observation: { state: 'current', ageMs: 1000 },
        connection: { mode },
        character: { name: 'Fixture' },
      });
      for (const changed of [
        { now: 107_000 },
        { now: 99_999 },
        { runtimeGeneration: 3 },
        { observation: null },
        { status: null },
      ]) {
        expect(mcpReadResult(query('get_status'), { ...context, ...changed })).toMatchObject({
          character: null,
          map: null,
          receipts: { action: null },
        });
        expect(mcpReadResult(query('get_settings'), { ...context, ...changed })).toMatchObject({
          activeRun: null,
        });
      }
      expect(
        mcpReadResult(query('get_status'), {
          ...context,
          gameOpen: false,
          observation: null,
          status: null,
        }),
      ).toMatchObject({ observation: { state: 'disconnected' } });
    });
  it('detaches allowlisted form, active run and profile data and omits secrets/raw logs', () => {
    const { context } = fixture('botOnly');
    const writes: unknown[] = [];
    const store = new ProfileStore(
      {
        getItem: () => null,
        setItem: (...args) => {
          writes.push(args);
        },
      },
      () => 'fixture',
      () => 100_000,
    );
    store.save('Field', 'Fixture', context.form!.settings);
    context.profiles = store.list();
    Object.assign(context.status!, {
      password: 'secret-fixture',
      token: 'secret-fixture',
      log: [{ at: 1, text: 'secret-fixture' }],
      connectionId: 'secret-fixture',
    });
    const before = JSON.stringify(context);
    const savedWrites = writes.length;
    const result = mcpReadResult(query('get_settings'), context);
    expect(result).toMatchObject({
      settingsForm: { settings: { radius: 6 }, revision: null },
      activeRun: { settings: { radius: DEFAULT_SETTINGS.radius }, revision: null },
    });
    for (const tool of ['get_status', 'get_settings', 'list_profiles'] as const)
      expect(JSON.stringify(mcpReadResult(query(tool), context))).not.toContain('secret-fixture');
    const profiles = mcpReadResult(query('list_profiles'), context) as {
      profiles: { settings: { targets: number[] } }[];
    };
    profiles.profiles[0]!.settings.targets.push(4012);
    expect(JSON.stringify(context)).toBe(before);
    expect(store.list()[0]!.settings.targets).toEqual([4000]);
    expect(writes.length).toBe(savedWrites);
  });
  it('validates script data without persistence/gameplay effects even during update maintenance', () => {
    const { context, actions } = fixture('gameClient');
    context.updateBusy = true;
    const source = formatBotScript({ settings: context.form!.settings, script: null });
    const before = JSON.stringify(context);
    const result = mcpReadResult(query('validate_script', { script: source }), context);
    expect(result).toMatchObject({
      valid: true,
      startReady: true,
      normalized: { settings: { radius: 6 } },
    });
    const invalid = 'script "Test"\nset emergency-hp = 60%\nset automation.recovery.enabled = true';
    expect(mcpReadResult(query('validate_script', { script: invalid }), context)).toMatchObject({
      valid: false,
      normalized: null,
      diagnostics: [{ message: expect.stringContaining('Emergency HP stop') }],
    });
    expect(JSON.stringify(context)).toBe(before);
    expect(actions).toEqual([]);
    expect(
      mcpReadResult(query('validate_script', { script: 'x'.repeat(262_145) }), context),
    ).toMatchObject({ valid: false });
  });
  it('keeps the retained form as the explicit legacy JSON baseline', () => {
    const { context } = fixture('botOnly');
    const macro = {
      version: 1,
      name: 'Fixture',
      durationSeconds: 30,
      maxActions: 1,
      maxSpend: 0,
      rules: [],
    };
    // Existing parser requires a rule; a valid one uses only bounded data.
    const source = JSON.stringify({
      ...macro,
      rules: [
        {
          name: 'Farm',
          priority: 0,
          cooldownSeconds: 0,
          maxRuns: 1,
          conditions: [{ field: 'level', operator: 'gte', value: 1 }],
          steps: [{ type: 'farm', map: 'prt_fild08', targets: [4000], timeoutSeconds: 30 }],
        },
      ],
    });
    expect(mcpReadResult(query('validate_script', { script: source }), context)).toMatchObject({
      valid: true,
      legacyBaseline: 'retained settings form',
      normalized: { settings: { radius: 6 } },
    });
  });
  it('validates self-contained text with unavailable Form, requiring a baseline only for legacy JSON', () => {
    const { context } = fixture('botOnly');
    const source = formatBotScript({ settings: context.form!.settings, script: null });
    const unavailable = { ...context, form: null };
    expect(mcpReadResult(query('validate_script', { script: source }), unavailable)).toMatchObject({
      valid: true,
    });
    expect(mcpReadResult(query('validate_script', { script: '{}' }), unavailable)).toMatchObject({
      valid: false,
      diagnostics: [{ message: expect.stringContaining('retained settings form is unavailable') }],
    });
  });
  it('uses the same macro Start admission for farm and noncombat scripts with empty retained targets', () => {
    const { context } = fixture('botOnly');
    const settings = validateFormSettings({ ...context.form!.settings, targets: [] });
    for (const steps of [
      [{ type: 'farm' as const, map: 'prt_fild08', targets: [4000], timeoutSeconds: 30 }],
      [{ type: 'skill' as const, skillId: 2, level: 1, mode: 'self' as const, timeoutSeconds: 10 }],
    ]) {
      const source = formatBotScript({
        settings,
        script: {
          version: 1,
          name: 'Fixture',
          durationSeconds: 30,
          maxActions: 1,
          maxSpend: 0,
          rules: [
            {
              name: 'Task',
              priority: 0,
              cooldownSeconds: 0,
              maxRuns: 1,
              conditions: [{ field: 'level', operator: 'gte', value: 1 }],
              steps,
            },
          ],
        },
      });
      expect(mcpReadResult(query('validate_script', { script: source }), context)).toMatchObject({
        valid: true,
        startReady: true,
      });
    }
  });
  it('retains freshness when a previous-session terminal observation is rejected', () => {
    const { context } = fixture('gameClient');
    const retained = retainedMcpObservation({
      status: {
        sessionId: 'retired-page',
        mcpObservation: { generation: 3, sequence: 20, observedAt: context.now },
      },
      previousSession: 'retired-page',
      retained: context.observation,
    });
    expect(retained).toBe(context.observation);
    expect(
      mcpReadResult(query('get_status'), { ...context, observation: retained, now: 108_000 }),
    ).toMatchObject({ observation: { state: 'stale', observedAt: 100_000 }, character: null });
  });
  it('reports observed macro intent independently of retained field ownership and receipt outcomes', () => {
    const { context } = fixture('gameClient');
    context.runRequested = false;
    context.status = {
      ...context.status!,
      runRequested: true,
      state: 'waiting',
      running: false,
      actionResult: { sequence: 3, status: 'confirmed', reason: 'Action confirmed.' },
    };
    expect(mcpReadResult(query('get_status'), context)).toMatchObject({
      run: { requested: true, retainedFieldRequested: false, state: 'waiting' },
      receipts: { action: { sequence: 3, status: 'confirmed', reason: 'Action confirmed.' } },
    });
  });
  it('admits only valid native observation metadata', () => {
    expect(
      mcpObserved({ mcpObservation: { generation: 2, sequence: 3, observedAt: 100_000 } }),
    ).toEqual({ generation: 2, sequence: 3, observedAt: 100_000 });
    for (const mcpObservation of [
      null,
      { generation: -1, sequence: 3, observedAt: 1 },
      { generation: 2, sequence: '3', observedAt: 1 },
    ])
      expect(mcpObserved({ mcpObservation })).toBeNull();
  });
});

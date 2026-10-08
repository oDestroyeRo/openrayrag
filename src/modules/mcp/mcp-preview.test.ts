import { afterEach, describe, expect, it, vi } from 'vitest';
import { mcpPreview } from './mcp-preview';
import { CompanionController } from '../runtime/controller';
import { DEFAULT_SETTINGS, validateFormSettings } from '../settings/settings';
import { formatBotScript } from '../settings/bot-script';
import { macroExample } from '../automation/macro-ui-logic';
import { BUILTIN_SERVICES } from '../services/npc-services-logic';
import type { McpQuery, McpReadContext } from './mcp-logic';
const planning = vi.hoisted(() => ({ route: vi.fn(async () => []) }));
vi.mock('../navigation/travel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../navigation/travel')>()),
  routeBetweenMapsAsync: planning.route,
}));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
  planning.route.mockResolvedValue([]);
});
function fixture() {
  const controller = new CompanionController(
    () => {},
    () => 1000,
  );
  const settings = validateFormSettings({
    ...DEFAULT_SETTINGS,
    map: 'prt_fild08',
    targets: [4000],
  });
  const context: McpReadContext = {
    now: 1001,
    runtimeGeneration: 2,
    observation: { generation: 2, sequence: 1, observedAt: 1000 },
    status: {
      ...controller.snapshot(),
      sessionId: 'fixture',
      connected: true,
      compatible: true,
      map: 'prt_fild08',
      player: {
        id: 1,
        kind: 0,
        classId: 1,
        name: 'Fixture',
        x: 169,
        y: 193,
        hp: 100,
        maxHp: 100,
        level: 1,
        dead: false,
      },
      login: { phase: 'complete', message: '' },
      reconnectAvailable: false,
      mapInfo: { code: 'prt_fild08', name: 'Field', source: 'observed', monsters: [] },
    },
    gameOpen: true,
    runRequested: false,
    limitReason: '',
    updateBusy: false,
    updateContinuationPending: false,
    form: { settings, selectedProfileId: null },
    formInitialized: true,
    profiles: [],
  };
  return context;
}
const query = (kind: string, request: Record<string, unknown>): McpQuery => ({
  id: 'preview',
  tool: 'preview_bot',
  arguments: { kind, request },
  runtimeGeneration: 2,
});
describe('existing bot preview owners', () => {
  it('validates workflow/routine/macro and plans disposition/supply without changing drafts or gameplay', async () => {
    const context = fixture(),
      before = JSON.stringify(context);
    const results = await Promise.all([
      mcpPreview(
        query('workflow', {
          spec: {
            name: 'Talk',
            map: 'prt_fild08',
            npcId: 1,
            maxSpend: 0,
            minStock: [],
            steps: [{ type: 'talk' }],
          },
        }),
        context,
      ),
      mcpPreview(
        query('routine', {
          spec: {
            name: 'Rest',
            durationSeconds: 30,
            maxActions: 1,
            rules: [
              {
                name: 'Rest',
                priority: 1,
                cooldownSeconds: 1,
                maxRuns: 1,
                conditions: [{ field: 'hpPercent', operator: 'lt', value: 60 }],
                action: { type: 'sit', sitting: true },
              },
            ],
          },
        }),
        context,
      ),
      mcpPreview(
        query('macro', {
          script: formatBotScript({
            settings: context.form!.settings,
            script: macroExample('item'),
          }),
        }),
        context,
      ),
      mcpPreview(query('disposition', {}), context),
      mcpPreview(query('supply', {}), context),
    ]);
    expect(results.every((result) => result.sendsCommands === false)).toBe(true);
    expect(JSON.stringify(context)).toBe(before);
    expect(planning.route).not.toHaveBeenCalled();
  });
  it('uses missing evidence for stale dry runs and refuses stale route/service planning', async () => {
    const context = fixture();
    context.now = 9000;
    const result = await mcpPreview(
      query('macro', {
        script: formatBotScript({ settings: context.form!.settings, script: macroExample('item') }),
      }),
      context,
    );
    expect(result).toMatchObject({ trace: { rules: [{ state: 'unavailable' }] } });
    for (const input of [
      query('route', { destinationMap: 'prontera' }),
      query('service', { definition: BUILTIN_SERVICES[0] }),
    ])
      await expect(mcpPreview(input, context)).rejects.toThrow('fresh verified');
    expect(planning.route).not.toHaveBeenCalled();
  });
  it('reuses current route/service validators and rejects arbitrary URL destinations before planning', async () => {
    const context = fixture();
    expect(await mcpPreview(query('route', { destinationMap: 'prontera' }), context)).toEqual({
      route: [],
      sendsCommands: false,
    });
    expect(planning.route).toHaveBeenCalledWith(
      'prt_fild08',
      { x: 169, y: 193 },
      'prontera',
      context.form!.settings.route_avoidWalls,
      expect.any(Object),
      { signal: expect.any(AbortSignal) },
    );
    expect(await mcpPreview(query('service', { definition: {} }), context)).toMatchObject({
      available: false,
      sendsCommands: false,
    });
    await expect(
      mcpPreview(query('route', { destinationMap: 'https://arbitrary.example' }), context),
    ).rejects.toThrow('valid destination');
  });
  it('cancels slow route planning at four seconds without retaining a timer', async () => {
    vi.useFakeTimers();
    planning.route.mockImplementationOnce(async (...arguments_: unknown[]) => {
      const options = arguments_[5] as { signal: AbortSignal };
      await new Promise<void>((_resolve, reject) =>
        options.signal.addEventListener('abort', () => reject(new Error('cancelled')), {
          once: true,
        }),
      );
      return [];
    });
    const promise = mcpPreview(query('route', { destinationMap: 'prontera' }), fixture());
    const rejected = expect(promise).rejects.toThrow('cancelled');
    await vi.advanceTimersByTimeAsync(4000);
    await rejected;
    expect(vi.getTimerCount()).toBe(0);
  });
});

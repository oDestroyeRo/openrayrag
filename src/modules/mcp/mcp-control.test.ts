import { describe, expect, it, vi } from 'vitest';
import { McpControl } from './mcp-control';
import {
  MCP_WRITE_TOOLS,
  type McpQuery,
  type McpReadContext,
  type McpWriteTool,
} from './mcp-logic';
import { MCP_CLIENT_ACTIONS } from './mcp-control-logic';
import { RunIntentDispatch } from '../session/run-intent-dispatch';
import { PersistentFieldRun, ReconnectPolicy } from '../session/reconnect';
import { DEFAULT_SETTINGS } from '../settings/settings';
import { CompanionController } from '../runtime/controller';

const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
const args: Record<McpWriteTool, Record<string, unknown>> = {
  set_settings: { expectedDraftRevision: 4, settings },
  set_script: { expectedDraftRevision: 4, script: 'script "Example"' },
  profile: { expectedDraftRevision: 4, operation: 'save', name: 'Field' },
  service_definition: { expectedDraftRevision: 4, operation: 'save', definition: {} },
  connect: {
    expectedDraftRevision: 4,
    username: 'Fixture',
    password: 'private-fixture',
    characterSlot: 0,
    mode: 'botOnly',
  },
  disconnect: { expectedGeneration: 2 },
  start_bot: { expectedDraftRevision: 4, expectedGeneration: 2 },
  stop_bot: {},
  apply_settings: { expectedDraftRevision: 4, expectedGeneration: 2 },
  set_reconnect: { expectedDraftRevision: 4, enabled: true },
  forget_login: { expectedDraftRevision: 4 },
  client_action: {
    expectedGeneration: 2,
    action: 'command',
    request: { type: 'sit', sitting: true },
  },
};
const query = (tool: McpWriteTool, overrides: Record<string, unknown> = {}): McpQuery => ({
  id: 'native-query',
  tool,
  arguments: { requestId: tool, ...args[tool], ...overrides },
  runtimeGeneration: 2,
});
function fixture(mode: 'botOnly' | 'gameClient' = 'botOnly') {
  const context: McpReadContext = {
    now: 1000,
    runtimeGeneration: 2,
    observation: { generation: 2, sequence: 1, observedAt: 999 },
    status: {
      ...new CompanionController(() => {}).snapshot(),
      connected: true,
      connectionMode: mode,
      sessionId: 'fixture',
      login: { phase: 'complete', message: '' },
      reconnectAvailable: false,
      mapInfo: { code: '', name: '', source: 'observed', monsters: [] },
    },
    gameOpen: true,
    runRequested: false,
    limitReason: '',
    updateBusy: false,
    updateContinuationPending: false,
    form: null,
    formInitialized: true,
    profiles: [],
    draftRevision: 4,
    controls: {
      busy: false,
      ready: true,
      startReady: true,
      applyReady: true,
      disconnectReady: true,
    },
  };
  const claim = vi.fn(async (_query: McpQuery) => {});
  const perform = vi.fn(
    async (
      _tool: McpWriteTool,
      _arguments: Record<string, unknown>,
      _operation: string,
    ): Promise<Record<string, unknown>> => ({ dispatch: 'accepted' }),
  );
  return {
    context,
    claim,
    perform,
    control: new McpControl({ claim, perform, read: () => context }),
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((yes) => {
    resolve = yes;
  });
  return { promise, resolve };
}

describe('claimed MCP controls', () => {
  for (const mode of ['botOnly', 'gameClient'] as const)
    it.each(MCP_WRITE_TOOLS)(
      `routes admitted %s through the same owner seam in ${mode}`,
      async (tool) => {
        const f = fixture(mode);
        expect(await f.control.execute(query(tool))).toEqual({ dispatch: 'accepted' });
        expect(f.claim).toHaveBeenCalledWith(query(tool));
        expect(f.perform).toHaveBeenCalledWith(tool, query(tool).arguments, 'native-query');
        expect(f.control.busy).toBe(false);
      },
    );
  it.each(MCP_WRITE_TOOLS)(
    'records malformed %s rejection after claim without effects',
    async (tool) => {
      const f = fixture();
      expect(await f.control.execute(query(tool, { unknown: true }))).toHaveProperty('error');
      expect(f.claim).toHaveBeenCalledOnce();
      expect(f.perform).not.toHaveBeenCalled();
    },
  );
  it.each(MCP_CLIENT_ACTIONS)(
    'admits the existing %s action envelope without inventing its game contract',
    async (action) => {
      const f = fixture();
      await f.control.execute(query('client_action', { action, request: {} }));
      expect(f.perform).toHaveBeenCalledOnce();
      expect(
        await f.control.execute(query('client_action', { action: 'rawPacket', request: {} })),
      ).toHaveProperty('error');
      expect(f.perform).toHaveBeenCalledOnce();
    },
  );
  it('denies stale, replaced, busy and invalid CAS requests without entering effects', async () => {
    for (const mutate of [
      (c: McpReadContext) => {
        c.now = 8000;
      },
      (c: McpReadContext) => {
        c.observation!.generation = 1;
      },
      (c: McpReadContext) => {
        c.controls!.busy = true;
      },
      (c: McpReadContext) => {
        c.updateBusy = true;
      },
      (c: McpReadContext) => {
        c.draftRevision = 5;
      },
    ]) {
      const f = fixture();
      mutate(f.context);
      expect(await f.control.execute(query('start_bot'))).toHaveProperty('error');
      expect(f.perform).not.toHaveBeenCalled();
    }
    const f = fixture();
    expect(await f.control.execute(query('disconnect', { expectedGeneration: 1 }))).toHaveProperty(
      'error',
    );
    expect(f.perform).not.toHaveBeenCalled();
  });
  it('rechecks invalid and valid human edits after a deferred claim and never queues a competitor', async () => {
    const f = fixture(),
      claimed = deferred();
    f.claim.mockImplementation(async (input?: McpQuery) => {
      if (input?.tool === 'set_settings') await claimed.promise;
    });
    const pending = f.control.execute(query('set_settings'));
    expect(f.control.busy).toBe(true);
    expect(await f.control.execute(query('set_script'))).toHaveProperty('error');
    expect(f.claim).toHaveBeenCalledTimes(2);
    f.context.draftRevision = 5;
    f.context.form = null;
    claimed.resolve();
    expect(await pending).toMatchObject({ error: expect.stringContaining('draft changed') });
    expect(f.perform).not.toHaveBeenCalled();
    expect(f.control.busy).toBe(false);
  });
  it('Stop overtakes an unclaimed write with invalid Form and unavailable gameplay', async () => {
    const f = fixture(),
      claimed = deferred();
    f.claim.mockImplementation(async (input?: McpQuery) => {
      if (input?.tool !== 'stop_bot') await claimed.promise;
    });
    const pending = f.control.execute(query('start_bot'));
    Object.assign(f.context, {
      status: null,
      observation: null,
      gameOpen: false,
      form: null,
      updateBusy: true,
    });
    expect(await f.control.execute(query('stop_bot'))).toEqual({ dispatch: 'accepted' });
    claimed.resolve();
    expect(await pending).toMatchObject({ error: expect.stringContaining('cancelled by Stop') });
    expect(f.perform.mock.calls.map((call) => call[0])).toEqual(['stop_bot']);
  });
  it('never mirrors credential-bearing native or owner failures', async () => {
    const f = fixture();
    f.perform.mockRejectedValue(new Error('username Fixture password private-fixture'));
    const result = await f.control.execute(query('connect'));
    expect(result).toHaveProperty('error');
    expect(JSON.stringify(result)).not.toContain('private-fixture');
    expect(JSON.stringify(result)).not.toContain('Fixture');
  });
  it('scopes both real Stop fences while retiring a pending Start and updater continuation', async () => {
    const f = fixture(),
      activation = deferred(),
      cancellation = deferred();
    const native = vi.fn(async (_command: string, arguments_?: Record<string, unknown>) => {
      if (arguments_?.action === 'start') await activation.promise;
    });
    const field = new PersistentFieldRun(),
      dispatch = new RunIntentDispatch(field, new ReconnectPolicy(), native);
    const continuationCancel = vi.fn(() => cancellation.promise);
    const control = new McpControl({
      claim: f.claim,
      read: () => f.context,
      perform: async (tool, _args, operation) => {
        if (tool === 'start_bot')
          return {
            dispatch: (
              await dispatch.start(
                settings,
                {
                  sessionId: 's',
                  player: { name: 'Fixture' },
                  connected: true,
                  compatible: true,
                  map: 'prt_fild08',
                },
                operation,
              )
            ).outcome.status,
          };
        return { dispatch: (await dispatch.stop(continuationCancel(), operation)).outcome.status };
      },
    });
    const started = control.execute(query('start_bot'));
    await Promise.resolve();
    await Promise.resolve();
    const stopped = control.execute(query('stop_bot'));
    await Promise.resolve();
    await Promise.resolve();
    expect(field.requested).toBe(false);
    expect(continuationCancel).toHaveBeenCalledOnce();
    cancellation.resolve();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
    expect(native.mock.calls.map((call) => call[1]?.action)).toEqual(['start', 'stop']);
    activation.resolve();
    expect(await started).toEqual({ dispatch: 'retired' });
    expect(await stopped).toEqual({ dispatch: 'accepted' });
    expect(native.mock.calls.map((call) => call[1]?.action)).toEqual(['start', 'stop', 'stop']);
    expect(native.mock.calls.every((call) => call[1]?.mcpOperation === 'native-query')).toBe(true);
  });
});

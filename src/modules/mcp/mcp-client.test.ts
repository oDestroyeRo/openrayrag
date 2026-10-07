import { afterEach, describe, expect, it, vi } from 'vitest';
import type { McpQuery, McpReadContext } from './mcp-logic';
const native = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn() }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: native.invoke }));
vi.mock('@tauri-apps/api/event', () => ({ listen: native.listen }));
import { mountMcp } from './mcp-client';

class Node {
  disabled = true;
  hidden = true;
  value = '';
  textContent = '';
  listeners = new Map<string, () => void>();
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback);
  }
}
function panel() {
  const nodes = Object.fromEntries(
    [
      'mcp-toggle',
      'mcp-connection',
      'mcp-endpoint',
      'mcp-token',
      'mcp-status',
      'mcp-copy-token',
    ].map((id) => [id, new Node()]),
  );
  return {
    nodes,
    host: {
      querySelector: (selector: string) => nodes[selector.slice(1)],
    } as unknown as HTMLElement,
  };
}
afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllGlobals();
});
const settled = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('main MCP bridge and optional connection panel', () => {
  it('leaves optional MCP disabled and completes initialization when its listener fails', async () => {
    const { nodes, host } = panel();
    native.listen.mockRejectedValue(new Error('fixture listener failure'));
    await expect(
      mountMcp(host, () => {
        throw new Error('must not read');
      }),
    ).resolves.toBeUndefined();
    expect(nodes['mcp-toggle']!.disabled).toBe(true);
    expect(nodes['mcp-status']!.textContent).toContain('could not initialize');
    expect(native.invoke).not.toHaveBeenCalled();
  });
  it('registers the query owner before enabling, returns only replies, and clears token on disable/page closure', async () => {
    const { nodes, host } = panel();
    let receive: ((event: { payload: McpQuery }) => void) | undefined;
    const unlisten = vi.fn();
    const pagehide = vi.fn();
    vi.stubGlobal('addEventListener', pagehide);
    native.listen.mockImplementation(async (_name, callback) => {
      receive = callback;
      return unlisten;
    });
    native.invoke.mockImplementation(async (command) =>
      command === 'mcp_set_enabled'
        ? { endpoint: 'http://127.0.0.1:123/mcp', token: 'private-fixture' }
        : null,
    );
    await mountMcp(
      host,
      () =>
        ({
          now: 1000,
          runtimeGeneration: 2,
          status: null,
          observation: null,
          gameOpen: false,
          runRequested: false,
          limitReason: '',
          updateBusy: true,
          updateContinuationPending: false,
          form: null,
          formInitialized: false,
          profiles: [],
        }) satisfies McpReadContext,
    );
    expect(native.invoke).not.toHaveBeenCalled();
    nodes['mcp-toggle']!.listeners.get('click')!();
    await settled();
    expect(nodes['mcp-token']!.value).toBe('private-fixture');
    receive!({ payload: { id: 'query', tool: 'get_status', arguments: {}, runtimeGeneration: 2 } });
    await settled();
    expect(native.invoke.mock.calls.map((call) => call[0])).toEqual([
      'mcp_set_enabled',
      'mcp_reply',
    ]);
    expect(JSON.stringify(native.invoke.mock.calls[1])).not.toContain('private-fixture');
    native.invoke.mockResolvedValue(null);
    nodes['mcp-toggle']!.listeners.get('click')!();
    await settled();
    expect(nodes['mcp-token']!.value).toBe('');
    expect(nodes['mcp-connection']!.hidden).toBe(true);
    pagehide.mock.calls[0]![1]();
    await settled();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(native.invoke).toHaveBeenLastCalledWith('mcp_set_enabled', { enabled: false });
  });
});

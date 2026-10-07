import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { mcpReadResult, type McpQuery, type McpReadContext } from './mcp-logic';

interface Connection {
  endpoint: string;
  token: string;
  control: boolean;
}
/** Main-view bridge. Native grant and claimed operation ownership precede control effects. */
export async function mountMcp(
  host: HTMLElement,
  read: (query: McpQuery) => McpReadContext,
  execute?: (query: McpQuery) => Promise<Record<string, unknown>>,
): Promise<void> {
  const toggle = host.querySelector<HTMLButtonElement>('#mcp-toggle')!;
  const details = host.querySelector<HTMLElement>('#mcp-connection')!;
  const endpoint = host.querySelector<HTMLInputElement>('#mcp-endpoint')!;
  const token = host.querySelector<HTMLInputElement>('#mcp-token')!;
  const status = host.querySelector<HTMLElement>('#mcp-status')!;
  const control = host.querySelector<HTMLInputElement>('#mcp-control');
  let enabled = false;
  const unlisten = await listen<McpQuery>('mcp-query', (event) => {
    const query = event.payload;
    void Promise.resolve()
      .then(() => (execute ? execute(query) : mcpReadResult(query, read(query))))
      .catch(() => ({
        error:
          'The requested configuration is unavailable. Correct invalid Form inputs or retry after initialization.',
      }))
      .then((result) =>
        invoke('mcp_reply', {
          id: query.id,
          runtimeGeneration: query.runtimeGeneration,
          result,
        }),
      )
      .catch(() => {});
  }).catch(() => null);
  if (!unlisten) {
    status.textContent = 'MCP could not initialize. Reopen the app to enable assistant access.';
    return;
  }
  toggle.disabled = false;
  toggle.addEventListener('click', () => {
    toggle.disabled = true;
    void invoke<Connection | null>('mcp_set_enabled', {
      enabled: !enabled,
      control: control?.checked ?? false,
    })
      .then((connection) => {
        enabled = connection !== null;
        endpoint.value = connection?.endpoint ?? '';
        token.value = connection?.token ?? '';
        details.hidden = !enabled;
        if (control) control.disabled = enabled;
        toggle.textContent = enabled ? 'Disable MCP server' : 'Enable MCP server';
        status.textContent = enabled
          ? connection?.control
            ? 'Bot controls enabled for this app launch. This token can change configuration and send existing client actions.'
            : 'Read-only access enabled for this app launch.'
          : 'Disabled. Previous access tokens are revoked.';
      })
      .catch(() => {
        status.textContent = 'Could not change the local MCP server. Retry or reopen the app.';
      })
      .finally(() => {
        toggle.disabled = false;
      });
  });
  host.querySelector<HTMLButtonElement>('#mcp-copy-token')!.addEventListener('click', () => {
    if (enabled)
      void navigator.clipboard
        .writeText(token.value)
        .then(() => {
          status.textContent = 'Access token copied. Keep it private.';
        })
        .catch(() => {
          status.textContent =
            'Could not copy the token. Select the token field and copy it manually.';
        });
  });
  globalThis.addEventListener(
    'pagehide',
    () => {
      unlisten();
      token.value = '';
      endpoint.value = '';
      void invoke('mcp_set_enabled', { enabled: false }).catch(() => {});
    },
    { once: true },
  );
}

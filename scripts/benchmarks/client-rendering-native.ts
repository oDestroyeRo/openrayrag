// Benchmark-only Tauri replacement. Never opens the app, a socket, or credentials.
type Listener = (event: { payload: unknown }) => void;
const listeners = new Map<string, Set<Listener>>();
export const calls: string[] = [];
export const isTauri = () => true;
export async function listen(name: string, listener: Listener): Promise<() => void> {
  const rows = listeners.get(name) ?? new Set<Listener>();
  rows.add(listener); listeners.set(name, rows);
  return () => rows.delete(listener);
}
export function emit(name: string, payload?: unknown): void {
  for (const listener of listeners.get(name) ?? []) listener({ payload });
}
export async function invoke(name: string, args?: Record<string, unknown>): Promise<unknown> {
  calls.push(name);
  if (name === 'settings_close_ready' || name === 'current_form' || name === 'saved_login') return null;
  if (name === 'save_current_form') return (args?.document as { revision: number }).revision;
  if (name === 'update_status') return { version: 'benchmark', phase: 'current', message: 'Offline benchmark', availableVersion: null };
  if (name === 'update_initialized') return undefined;
  if (name === 'control_bot' && args?.action === 'heartbeat') return undefined;
  throw new Error(`Unexpected native command in offline benchmark: ${name}`);
}

import { afterEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ invoke: vi.fn(), listen: vi.fn(async () => () => {}) }));
vi.mock('@tauri-apps/api/core', () => ({ invoke: ipc.invoke, isTauri: () => true }));
vi.mock('@tauri-apps/api/event', () => ({ listen: ipc.listen }));
vi.mock('./feature-ui', async () => {
  const { DEFAULT_AUTOMATION } = await import('./settings');
  return { FeatureUi: class {
    active(): boolean { return false; }
    serviceBlocked(): boolean { return false; }
    read() { return structuredClone(DEFAULT_AUTOMATION); }
    lock(): void {}
  }, validFeatureStatus: () => true };
});

// Exercise the actual main-window form callbacks with native IPC replaced.
// No browser, app data, real account or persistent frontend store is involved.
class Element {
  value = ''; checked = false; disabled = false; hidden = false; textContent = ''; placeholder = '';
  id = ''; className = ''; style: Record<string, string> = {}; width = 400; height = 400;
  classList = { toggle() {}, add() {}, remove() {} };
  listeners = new Map<string, Array<(event: { preventDefault(): void }) => unknown>>();
  markup = '';
  constructor(private readonly elements: Map<string, Element>) {}
  set innerHTML(html: string) {
    this.markup = html;
    for (const match of html.matchAll(/<(\w+)\b([^>]*\bid="([^"]+)"[^>]*)>/g)) {
      const node = new Element(this.elements); node.id = match[3]!;
      node.checked = /\bchecked\b/.test(match[2]!); node.disabled = /\bdisabled\b/.test(match[2]!); node.hidden = /\bhidden\b/.test(match[2]!);
      node.value = /\bvalue="([^"]*)"/.exec(match[2]!)?.[1] ?? (match[1] === 'select' ? '0' : '');
      this.elements.set(node.id, node);
    }
  }
  append(): void {}
  replaceChildren(): void {}
  getContext() { return { clearRect() {}, fillText() {} }; }
  addEventListener(type: string, callback: (event: { preventDefault(): void }) => unknown): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), callback]);
  }
  async emit(type: string): Promise<void> {
    for (const callback of this.listeners.get(type) ?? []) callback({ preventDefault() {} });
    for (let i = 0; i < 12; i++) await Promise.resolve();
  }
}
async function fixture(saved: { username: string; characterSlot: number; autoLogin: boolean } | null = null, readFails = false) {
  const elements = new Map<string, Element>(), root = new Element(elements), main = new Element(elements);
  vi.useFakeTimers(); vi.stubGlobal('document', {
    querySelector: (selector: string) => selector === '#app' ? root : main,
    getElementById: (id: string) => elements.get(id), createElement: () => new Element(elements),
  });
  ipc.invoke.mockReset(); ipc.listen.mockClear();
  ipc.invoke.mockImplementation(async (command: string) => {
    if (command === 'saved_login') { if (readFails) throw 'synthetic store failure'; return saved; }
    return undefined;
  });
  vi.resetModules(); await import('./main');
  for (let i = 0; i < 15; i++) await Promise.resolve();
  return { root, get: (id: string) => elements.get(id)!, calls: (command: string) => ipc.invoke.mock.calls.filter(call => call[0] === command) };
}
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('native local-login form and metadata', () => {
  it('starts session-only and discloses unencrypted local storage without accessing frontend persistence', async () => {
    const f = await fixture();
    expect(f.root.markup).toContain('Save login on this Mac');
    expect(f.root.markup).toContain('local file with user-only access');
    expect(f.root.markup).toContain('The app does not encrypt them.');
    expect(f.root.markup).not.toContain('Keychain');
    expect(f.get('remember-login').checked).toBe(false);
    expect(f.get('auto-login').checked).toBe(false); expect(f.get('auto-login').disabled).toBe(true);
    expect(f.calls('login_game')).toHaveLength(0);
    f.get('username').value = 'synthetic-user'; f.get('password').value = 'synthetic-only-password'; f.get('character-slot').value = '2';
    await f.get('signin-form').emit('submit');
    expect(f.calls('login_game')).toEqual([['login_game', { request: {
      credentials: { username: 'synthetic-user', password: 'synthetic-only-password', characterSlot: 2 },
      characterSlot: 2, remember: false, autoLogin: false,
    } }]]);
    expect(f.get('password').value).toBe(''); expect(f.get('saved-account').textContent).toBe('Session only');
  });
  it('requires explicit remember opt-in and clears automatic launch preference on uncheck', async () => {
    const f = await fixture();
    f.get('remember-login').checked = true; await f.get('remember-login').emit('change');
    expect(f.get('auto-login').disabled).toBe(false);
    f.get('auto-login').checked = true; f.get('remember-login').checked = false; await f.get('remember-login').emit('change');
    expect(f.get('auto-login').checked).toBe(false); expect(f.get('auto-login').disabled).toBe(true);
  });
  it('restores only metadata and saved slot, with password reused natively on explicit sign-in', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: false });
    expect(f.get('username').value).toBe('synthetic-user'); expect(f.get('character-slot').value).toBe('2');
    expect(f.get('password').value).toBe(''); expect(f.calls('login_game')).toHaveLength(0);
    f.get('character-slot').value = '1'; await f.get('signin-form').emit('submit');
    expect(f.calls('login_game')).toEqual([['login_game', { request: { credentials: null, characterSlot: 1, remember: true, autoLogin: false } }]]);
  });
  it('auto-login uses native reuse and the saved slot without returning a password to the form', async () => {
    const f = await fixture({ username: 'synthetic-user', characterSlot: 2, autoLogin: true });
    expect(f.calls('login_game')).toEqual([['login_game', { request: { credentials: null, characterSlot: 2, remember: true, autoLogin: true } }]]);
    expect(f.get('password').value).toBe('');
  });
  it('Forget deletes the local profile and clears launch preference, including after unreadable metadata', async () => {
    for (const readFails of [false, true]) {
      const f = await fixture(readFails ? null : { username: 'synthetic-user', characterSlot: 1, autoLogin: false }, readFails);
      expect(f.get('forget-login').hidden).toBe(false);
      await f.get('forget-login').emit('click');
      expect(f.calls('forget_login')).toHaveLength(1); expect(f.get('forget-login').hidden).toBe(true);
      expect(f.get('remember-login').checked).toBe(false); expect(f.get('auto-login').checked).toBe(false);
      expect(f.get('notice').textContent).toBe('Local saved login and app-open sign-in preference removed.');
      expect(f.get('password').value).toBe('');
    }
  });
});

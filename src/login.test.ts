import { characterSlot } from './login-logic';
import { describe, expect, it, vi } from 'vitest';
import { characterSlots, LoginController, loginDriver, loginReady, unityMessage, type LoginDriver, type UnityClient } from './login';

function list(slots: number[], token = false): Uint8Array {
  const bits: number[] = [];
  const write = (value: number, count: number) => {
    for (let i = 0; i < count; i++) bits.push(Math.floor(value / 2 ** i) & 1);
  };
  const string = (value: string) => {
    const bytes = new TextEncoder().encode(value);
    write(bytes.length, 16); for (const byte of bytes) write(byte, 8);
  };
  write(0, 8); write(Number(token), 1);
  if (token) { write(3, 32); write(0x030201, 24); }
  write(slots.length, 32);
  for (const slot of slots) {
    string(`Character ${slot}`); write(slot, 32); string('prt_fild05');
    write(8, 32); write(8, 32); write(70, 32);
  }
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, i) => { bytes[i >>> 3]! |= bit << (i & 7); });
  return bytes;
}

function profile(characterSlot = 0) {
  return { username: 'test-user', password: 'synthetic-password', characterSlot };
}

function setup(overrides: Partial<LoginDriver> = {}) {
  let now = 1000;
  const driver = {
    prepare: vi.fn(async () => {}), submit: vi.fn(),
    selectionReady: vi.fn(() => false), select: vi.fn(), ...overrides,
  };
  const login = new LoginController(driver, () => now);
  const start = (slot = 0) => login.start(profile(slot));
  const step = (ms = 500) => { now += ms; login.tick(); };
  return { login, driver, start, step };
}

describe('Unity login interface', () => {
  it('requires positive active-object confirmation, not merely a resolved factory or silent call', () => {
    expect(loginReady({ SendMessage() {} })).toBe(false);
    const missing: UnityClient = { SendMessage(object) { console.log(`SendMessage: object ${object} not found!`); } };
    expect(loginReady(missing)).toBe(false);
    const ready: UnityClient = { SendMessage(object, method) {
      console.log(`SendMessage: object ${object} does not have receiver for function ${method}!`);
    } };
    expect(loginReady(ready)).toBe(true);
    expect(loginReady({ SendMessage() { throw new Error('Not initialized'); } })).toBe(false);
  });
  it('restores console methods and suppresses native dispatch errors', () => {
    const original = console.log;
    expect(unityMessage({ SendMessage() { console.log('SendMessage: object missing not found!'); } }, 'missing', 'AttemptLogin')).toBe(false);
    expect(console.log).toBe(original);
  });
  it('activates the server tab before filling it, then submits official login exactly once', async () => {
    const calls: Parameters<UnityClient['SendMessage']>[] = [];
    const driver = loginDriver({ SendMessage: (...args) => { calls.push(args); } });
    const login = new LoginController(driver);
    const input = profile();
    await login.start(input);
    expect(input.password).toBe('');
    expect(calls.map(c => c[1])).toEqual([
      'ChangeTabs', 'SetTextWithoutNotify', 'ChangeTabs',
      'SetTextWithoutNotify', 'SetTextWithoutNotify', 'AttemptLogin',
    ]);
    expect(calls[0]?.[2]).toBe(2);
    expect(calls[1]?.[0]).toContain('Server Settings');
    expect(calls[1]?.[2]).toBe('wss://gamesea01.rayrag.com/ws');
    expect(calls[2]?.[2]).toBe(0);
    expect(calls[3]?.[0]).toContain('/Login/Username/');
    expect(calls[4]?.[0]).toContain('/Login/Password/');
  });
  it('requires the selection pane and its OK control, not only their shared parent', () => {
    let pane = false, button = false;
    const driver = loginDriver({ SendMessage(object, method) {
      if (object.endsWith('/CharacterSelectPane') && !pane || object.endsWith('/OkButton') && !button) {
        console.log(`SendMessage: object ${object} not found!`); return;
      }
      console.log(`SendMessage: object ${object} does not have receiver for function ${method}!`);
    } });
    expect(driver.selectionReady()).toBe(false); pane = true;
    expect(driver.selectionReady()).toBe(false); button = true;
    expect(driver.selectionReady()).toBe(true);
  });
  it('prepares the slot once and dispatches enter only on a later ready tick', () => {
    const calls: string[] = [];
    const driver = loginDriver({ SendMessage(object, method) {
      if (method === '__rayrag_login_ready_probe__') console.log(`SendMessage: object ${object} does not have receiver for function ${method}!`);
      else calls.push(method);
    } });
    expect(driver.select(characterSlot(2))).toBe(false);
    expect(calls).toEqual(['SetCharacterInfo']);
    expect(driver.select(characterSlot(2))).toBe(true);
    expect(driver.select(characterSlot(2))).toBe(true);
    expect(calls).toEqual(['SetCharacterInfo','ClickOk']);
  });
  it('rechecks readiness after slot preparation and never resends the slot', () => {
    let ready = true;
    const calls: string[] = [];
    const driver = loginDriver({ SendMessage(object, method) {
      if (method === '__rayrag_login_ready_probe__') console.log(ready
        ? `SendMessage: object ${object} does not have receiver for function ${method}!`
        : `SendMessage: object ${object} not found!`);
      else calls.push(method);
    } });
    expect(driver.select(characterSlot(0))).toBe(false); ready = false;
    expect(driver.select(characterSlot(0))).toBe(false); expect(calls).toEqual(['SetCharacterInfo']);
    ready = true; expect(driver.select(characterSlot(0))).toBe(true);
    expect(calls).toEqual(['SetCharacterInfo','ClickOk']);
  });
  it('does not submit credentials when a required input no longer exists', async () => {
    const submit = vi.fn();
    const driver = loginDriver({ SendMessage(object, method) {
      if (method === 'AttemptLogin') submit();
      if (object.includes('/Password/')) console.log(`SendMessage: object ${object} not found!`);
    } });
    const login = new LoginController(driver);
    const input = profile(); await login.start(input);
    expect(login.status.phase).toBe('failed');
    expect(input.password).toBe('');
    expect(submit).not.toHaveBeenCalled();
  });
});

describe('automatic login and character selection', () => {
  it('reads unaligned character slots and skips tokens without returning them', () => {
    expect(characterSlots(list([0, 2]))).toEqual([0, 2]);
    expect(characterSlots(list([1], true))).toEqual([1]);
    expect(characterSlots(list([]))).toEqual([]);
  });
  it('rejects malformed, duplicate and invalid character slots', () => {
    expect(() => characterSlots(list([0]).slice(0, -2))).toThrow();
    expect(() => characterSlots(list([0, 0]))).toThrow();
    expect(() => characterSlots(list([3]))).toThrow();
    expect(() => characterSlots(list([0, 1, 2, 3]))).toThrow();
  });
  it('waits for the selection screen, then selects the populated requested slot once', async () => {
    let ready = false;
    const { login, driver, start, step } = setup({ selectionReady: () => ready });
    await start(2); login.receive(list([0, 2])); step(5000);
    expect(driver.select).not.toHaveBeenCalled();
    ready = true; step(); step();
    expect(driver.select).toHaveBeenCalledExactlyOnceWith(2);
    expect(login.status.phase).toBe('entering');
    login.complete(); expect(login.status.phase).toBe('complete');
  });
  it('waits through read-only readiness failures and requires stable readiness', async () => {
    let ready = false, throws = true;
    const { login, driver, start, step } = setup({ selectionReady: () => { if (throws) throw new Error('UI loading'); return ready; } });
    await start(); login.receive(list([0])); step();
    expect(login.status.phase).toBe('selecting'); expect(driver.select).not.toHaveBeenCalled();
    throws = false; ready = true; step(100); step(100);
    expect(driver.select).not.toHaveBeenCalled();
    ready = false; step(100); ready = true; step(100); step(199);
    expect(driver.select).not.toHaveBeenCalled(); step(1);
    expect(driver.select).toHaveBeenCalledOnce(); expect(login.status.phase).toBe('entering');
  });
  it('cancels between slot preparation and enter without clicking or resending', async () => {
    let now = 1000;
    const calls: string[] = [];
    const driver = loginDriver({ SendMessage(object, method) {
      if (method === '__rayrag_login_ready_probe__') console.log(`SendMessage: object ${object} does not have receiver for function ${method}!`);
      else calls.push(method);
    } });
    const login = new LoginController(driver, () => now);
    await login.start(profile()); login.receive(list([0])); login.tick(); now += 200; login.tick();
    expect(calls.filter(method => method === 'SetCharacterInfo')).toHaveLength(1);
    expect(calls).not.toContain('ClickOk'); login.cancel(); now += 1000; login.tick();
    expect(login.status.phase).toBe('cancelled'); expect(calls).not.toContain('ClickOk');
  });
  it('keeps dispatched selection failures terminal and names the failed stage', async () => {
    for (const failedMethod of ['SetCharacterInfo','ClickOk']) {
      let now = 1000;
      const calls: string[] = [];
      const login = new LoginController(loginDriver({ SendMessage(object, method) {
        if (method === '__rayrag_login_ready_probe__') console.log(`SendMessage: object ${object} does not have receiver for function ${method}!`);
        else {
          calls.push(method);
          if (method === failedMethod) throw new Error('Synthetic unavailable interface');
        }
      } }), () => now);
      await login.start(profile()); login.receive(list([0]));
      for (let i = 0; i < 10; i++) { now += 200; login.tick(); }
      expect(login.status.phase).toBe('failed');
      expect(login.status.message).toContain(failedMethod === 'ClickOk' ? 'enter with' : 'requested slot');
      expect(calls.filter(method => method === failedMethod)).toHaveLength(1);
      if (failedMethod === 'SetCharacterInfo') expect(calls).not.toContain('ClickOk');
    }
  });
  it('expires the selection deadline after slot preparation without dispatching enter', async () => {
    const { login, driver, start, step } = setup({ selectionReady: () => true, select: vi.fn(() => false) });
    await start(); login.receive(list([0])); step(200); step(200);
    expect(driver.select).toHaveBeenCalledOnce(); step(30_000);
    expect(login.status.phase).toBe('failed'); expect(driver.select).toHaveBeenCalledOnce();
  });
  it('never opens character creation for an empty slot', async () => {
    const { login, driver, start, step } = setup({ selectionReady: () => true });
    await start(1); login.receive(list([0])); step();
    expect(login.status.phase).toBe('failed');
    expect(driver.select).not.toHaveBeenCalled();
  });
  it('cancellation during asynchronous preparation prevents login submission', async () => {
    let ready!: () => void;
    const { login, driver } = setup({ prepare: () => new Promise(resolve => { ready = resolve; }) });
    const input = profile(); const pending = login.start(input);
    login.cancel(); ready(); await pending;
    expect(driver.submit).not.toHaveBeenCalled();
    expect(login.status.phase).toBe('cancelled');
    expect(input.password).toBe('');
  });
  it('cancellation and rejection prevent subsequent selection and retries', async () => {
    for (const cancel of [true, false]) {
      const { login, driver, start, step } = setup({ selectionReady: () => true });
      await start();
      if (cancel) login.cancel(); else login.receive(Uint8Array.of(1));
      login.receive(list([0])); step(50_000);
      expect(login.status.phase).toBe(cancel ? 'cancelled' : 'failed');
      expect(driver.submit).toHaveBeenCalledTimes(1);
      expect(driver.select).not.toHaveBeenCalled();
    }
  });
  it('times out once and rejects a second attempt in the same client session', async () => {
    const { login, driver, start, step } = setup(); await start(); step(31_000);
    expect(login.status.phase).toBe('failed');
    await expect(start()).rejects.toThrow('Reopen');
    expect(driver.submit).toHaveBeenCalledTimes(1);
  });
  it('times out while waiting for a selection screen without clicking', async () => {
    const { login, driver, start, step } = setup(); await start(); login.receive(list([0])); step(31_000);
    expect(login.status.phase).toBe('failed');
    expect(driver.select).not.toHaveBeenCalled();
  });
  it('treats disconnects and malformed lists as terminal failures', async () => {
    const a = setup(); await a.start(); a.login.disconnect(); a.login.receive(list([0])); a.step();
    expect(a.login.status.phase).toBe('failed');
    const b = setup(); await b.start(); b.login.receive(Uint8Array.of(0, 0)); b.step();
    expect(b.login.status.phase).toBe('failed');
    expect(b.driver.select).not.toHaveBeenCalled();
  });
});

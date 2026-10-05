import { describe, expect, it, vi } from 'vitest';
import { PersistentFieldRun, ReconnectPolicy, type RunSession } from './reconnect';
import { RunIntentDispatch } from './run-intent-dispatch';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';

function deferred() {
  let resolve!: (value?: unknown) => void, reject!: (error: unknown) => void;
  const promise = new Promise<unknown>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fixture() {
  let now = 0;
  const field = new PersistentFieldRun(() => now), reconnect = new ReconnectPolicy();
  const queued = new Map<string, ReturnType<typeof deferred>[]>();
  const native = vi.fn((command: string, args?: Record<string, unknown>): Promise<unknown> => {
    return queued.get(`${command}:${args?.action ?? ''}`)?.shift()?.promise ?? Promise.resolve('confirmed');
  });
  const dispatch = new RunIntentDispatch(field, reconnect, native, () => now);
  return {
    dispatch, field, reconnect, native,
    advance: (milliseconds: number) => { now += milliseconds; },
    defer(command: string, action = '') {
      const task = deferred(), key = `${command}:${action}`;
      queued.set(key, [...queued.get(key) ?? [], task]);
      return task;
    },
    actions: () => native.mock.calls.filter(call => call[0] === 'control_bot').map(call => call[1]?.action),
  };
}

const settings = () => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [1002] });
const ready = (sessionId = 'old'): RunSession => ({
  sessionId, connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Synthetic' },
  kills: 0, looted: 0, deaths: 0, attacks: 0,
});
async function settle() { for (let i = 0; i < 20; i++) await Promise.resolve(); }

describe('run intent dispatch', () => {
  it('retires intent immediately but holds Stop until updater cancellation releases admission', async () => {
    const f = fixture();await f.dispatch.start(settings(),ready());
    const cancelled=deferred(), stopped=f.dispatch.stop(cancelled.promise);
    expect(f.field.requested).toBe(false);expect(f.dispatch.stopping).toBe(true);
    expect(f.actions()).toEqual(['start']);
    expect((await f.dispatch.start(settings(),ready())).outcome.status).toBe('retired');
    cancelled.resolve();await stopped;
    expect(f.actions()).toEqual(['start','stop']);expect(f.dispatch.stopping).toBe(false);
  });
  it('still attempts Stop when updater cancellation fails', async () => {
    const f=fixture(),cancelled=deferred(),stopped=f.dispatch.stop(cancelled.promise);
    cancelled.reject(new Error('Cancellation unavailable'));await stopped;
    expect(f.actions()).toEqual(['stop']);expect(f.field.requested).toBe(false);
  });
  it.each(['login', 'start', 'resume', 'reconnect'] as const)('Stop drains a deferred %s and compensates before releasing controls', async kind => {
    const f = fixture();
    if (kind === 'resume') await f.dispatch.start(settings(), ready());
    f.reconnect.configure(true, true, true);
    f.reconnect.observe(true, true, 'complete', 0);
    f.reconnect.observe(false, false, 'idle', 1);
    const sent = f.defer(kind === 'login' ? 'login_game' : kind === 'reconnect' ? 'reconnect_game' : 'control_bot',
      kind === 'start' || kind === 'resume' ? 'start' : '');
    const activation = kind === 'login' ? f.dispatch.login({ characterSlot: 0 })
      : kind === 'reconnect' ? f.dispatch.reconnect()
      : kind === 'start' ? f.dispatch.start(settings(), ready()) : f.dispatch.resume(ready('new'))!;
    const stopped = f.dispatch.stop();
    expect(f.field.requested).toBe(false); expect(f.reconnect.waitingUntil).toBeNull();
    expect(f.dispatch.stopping).toBe(true);
    expect(f.actions().at(-1)).toBe('stop');
    await settle(); expect(f.dispatch.stopping).toBe(true);
    sent.resolve();
    expect((await activation)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.actions().slice(-2)).toEqual(['stop', 'stop']);
    expect(f.dispatch.stopping).toBe(false);
    expect(f.dispatch.pending).toEqual({ login: false, resume: false, service: false, manual: false, limit: false });
    expect(f.dispatch.resume(ready('later'))).toBeNull();
  });

  it('drains activation and retries Stop after the immediate Stop fails', async () => {
    const f = fixture(), activation = f.defer('login_game'), firstStop = f.defer('control_bot', 'stop');
    const login = f.dispatch.login({}), stopped = f.dispatch.stop();
    firstStop.reject('Controller temporarily unavailable'); await settle();
    expect(f.dispatch.stopping).toBe(true); expect(f.dispatch.pending.login).toBe(true);
    activation.resolve();
    expect((await login)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.actions()).toEqual(['stop', 'stop']); expect(f.dispatch.stopping).toBe(false);
  });

  it('reports an unavailable final Stop after draining failed activation without renewing intent', async () => {
    const f = fixture(), activation = f.defer('control_bot', 'start');
    const started = f.dispatch.start(settings(), ready());
    f.defer('control_bot', 'stop').reject('First failure');
    f.defer('control_bot', 'stop').reject('Final failure');
    const stopped = f.dispatch.stop();
    activation.reject('Start failure');
    expect((await started)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toEqual({ status: 'failed', error: 'Final failure' });
    expect(f.field.requested).toBe(false); expect(f.dispatch.stopping).toBe(false);
    expect(f.dispatch.pending.resume).toBe(false);
  });

  it('does not confuse login UI timeout or a retired completion with replacement native work', async () => {
    const f = fixture(), old = f.defer('login_game'), replacement = f.defer('login_game');
    const previous = f.dispatch.login({ characterSlot: 0 });
    f.advance(120_001); f.reconnect.networkFailure(120_001);
    expect(f.dispatch.pending.login).toBe(true);
    const current = f.dispatch.login({ characterSlot: 1 });
    old.resolve(); expect((await previous)!.outcome).toEqual({ status: 'retired' });
    expect(f.dispatch.pending.login).toBe(true);
    replacement.resolve(); expect((await current)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.dispatch.pending.login).toBe(false);
  });

  it.each(['success', 'failure'])('rechecks %s ownership when a login receipt crosses promise delivery', async outcome => {
    const f = fixture(), sent = f.defer('login_game'), requested = f.dispatch.login({});
    // Native completion runs first; retirement runs before the outer receipt is delivered.
    void sent.promise.then(() => f.dispatch.gameClosed(), () => f.dispatch.gameClosed());
    if (outcome === 'success') sent.resolve(); else sent.reject('Old login failure');
    expect((await requested).outcome).toEqual({ status: 'retired' });
  });

  it('rechecks Stop ownership when its receipt crosses promise delivery', async () => {
    const f = fixture(), sent = f.defer('control_bot', 'stop'), stopped = f.dispatch.stop();
    void sent.promise.then(() => f.dispatch.gameClosed()); sent.resolve();
    expect((await stopped).outcome).toEqual({ status: 'retired' });
    expect(f.dispatch.stopping).toBe(false);
  });

  it('keeps an immutable receipt current only for the intent that produced it', async () => {
    const f = fixture(), receipt = await f.dispatch.login({});
    expect(Object.isFrozen(receipt)).toBe(true); expect(Object.isFrozen(receipt.outcome)).toBe(true);
    expect(receipt.outcome.status).toBe('accepted');
    f.dispatch.gameClosed(); expect(receipt.outcome).toEqual({ status: 'retired' });
  });

  it('keeps physical work after game closure and fences an old Stop from a replacement run', async () => {
    const f = fixture(), old = f.defer('control_bot', 'start');
    const previous = f.dispatch.start(settings(), ready()), stopped = f.dispatch.stop();
    f.dispatch.gameClosed(); expect(f.dispatch.pending.resume).toBe(true);
    old.resolve(); expect((await previous)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toEqual({ status: 'retired' });
    expect(f.actions()).toEqual(['start', 'stop']);
    await f.dispatch.start(settings(), ready('replacement'));
    expect(f.field.requested).toBe(true); expect(f.actions()).toEqual(['start', 'stop', 'start']);
  });

  it('retiring a native connection does not let an old Start clear a replacement pending Start', async () => {
    const f = fixture(), old = f.defer('control_bot', 'start'), replacement = f.defer('control_bot', 'start');
    const previous = f.dispatch.start(settings(), ready()); f.dispatch.gameClosed();
    const current = f.dispatch.start(settings(), ready('replacement'));
    old.reject('Old connection failure'); expect((await previous)!.outcome).toEqual({ status: 'retired' });
    expect(f.dispatch.pending.resume).toBe(true); expect(f.field.requested).toBe(true);
    replacement.resolve(); expect((await current)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.dispatch.pending.resume).toBe(false); expect(f.dispatch.resume(ready('replacement'))).toBeNull();
  });

  it('holds the original limit while a resume finishes and compensates without starting a new allowance', async () => {
    const f = fixture(), configured = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    configured.automation.limits.kills = 2;
    await f.dispatch.start(configured, ready());
    const sent = f.defer('control_bot', 'start'), resuming = f.dispatch.resume(ready('new'))!;
    f.field.observe(ready('new')); f.field.observe({ ...ready('new'), kills: 2 });
    const held = f.dispatch.holdAtRunLimit(true)!;
    expect(f.dispatch.pending.limit).toBe(true); expect(f.dispatch.holdAtRunLimit(true)).toBeNull();
    sent.resolve(); await resuming; expect((await held)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.actions().slice(-2)).toEqual(['stop', 'stop']);
    expect(f.field.requested).toBe(true); expect(f.field.metrics.kills).toBe(2);
    expect(f.dispatch.limitHeld).toBe(true); expect(f.dispatch.resume(ready('later'))).toBeNull();
  });

  it('retries a failed limit hold and never marks a replacement connection held', async () => {
    const f = fixture(), configured = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    configured.automation.limits.minutes = 1;
    await f.dispatch.start(configured, ready()); f.advance(60_000);
    f.defer('control_bot', 'stop').reject('Unavailable');
    expect((await f.dispatch.holdAtRunLimit(true))!.outcome).toEqual({ status: 'failed', error: 'Unavailable' });
    expect(f.dispatch.limitHeld).toBe(false);
    const sent = f.defer('control_bot', 'stop'), held = f.dispatch.holdAtRunLimit(true)!;
    f.dispatch.gameClosed(); await f.dispatch.start(settings(), ready('replacement'));
    sent.resolve(); expect((await held)!.outcome).toEqual({ status: 'retired' });
    expect(f.dispatch.limitHeld).toBe(false); expect(f.field.requested).toBe(true);
  });

  it('Stop can drain a limit hold waiting for resume without a barrier cycle', async () => {
    const f = fixture(), configured = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    configured.automation.limits.minutes = 1;
    await f.dispatch.start(configured, ready());
    const sent = f.defer('control_bot', 'start'), resumed = f.dispatch.resume(ready('new'))!;
    f.advance(60_000); const held = f.dispatch.holdAtRunLimit(true)!, stopped = f.dispatch.stop();
    sent.resolve(); await resumed;
    expect((await held)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.dispatch.pending.limit).toBe(false); expect(f.dispatch.stopping).toBe(false);
    expect(f.actions().slice(-3)).toEqual(['stop', 'stop', 'stop']);
  });

  it.each(['service', 'macro'])('Stop cancels a %s waiting for resume before its native dispatch', async action => {
    const f = fixture(); await f.dispatch.start(settings(), ready());
    const sent = f.defer('control_bot', 'start'), resumed = f.dispatch.resume(ready('new'))!;
    const requested = f.dispatch.feature(action, { synthetic: true }), stopped = f.dispatch.stop();
    expect(f.field.requested).toBe(false); sent.resolve(); await resumed;
    expect((await requested)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.actions()).not.toContain(action); expect(f.dispatch.stopping).toBe(false);
  });

  it.each(['macro', 'manualTarget'])('Stop includes the compensating %s action without a barrier cycle', async kind => {
    const f = fixture(), action = kind === 'macro' ? 'macro' : 'command';
    const sent = f.defer('control_bot', action);
    const requested = f.dispatch.feature(action, { type: kind }), stopped = f.dispatch.stop();
    sent.resolve(); expect((await requested)!.outcome).toEqual({ status: 'retired' });
    expect((await stopped)!.outcome).toMatchObject({ status: 'accepted' });
    expect(f.actions()).toEqual([action, 'stop', 'stop', 'stop']);
    expect(f.dispatch.pending.manual).toBe(false); expect(f.dispatch.stopping).toBe(false);
  });

  it.each(['macro', 'manualTarget'])('distinguishes retired %s compensation after Stop is no longer active', async kind => {
    const f = fixture(), action = kind === 'macro' ? 'macro' : 'command';
    const sent = f.defer('control_bot', action), requested = f.dispatch.feature(action, { type: kind });
    // A service replaces run ownership without holding the explicit Stop barrier.
    await f.dispatch.feature('service', {});
    sent.resolve(); expect((await requested)!.outcome).toEqual({ status: 'retired' });
    expect(f.actions()).toEqual(kind === 'macro' ? ['macro', 'service', 'stop'] : ['command', 'service']);
  });

  it('an old macro cannot stop a replacement native connection', async () => {
    const f = fixture(), sent = f.defer('control_bot', 'macro'), requested = f.dispatch.feature('macro', {});
    f.dispatch.gameClosed(); await f.dispatch.start(settings(), ready('replacement'));
    sent.resolve(); expect((await requested)!.outcome).toEqual({ status: 'retired' });
    expect(f.actions()).toEqual(['macro', 'start']); expect(f.field.requested).toBe(true);
  });

  it('returns accepted dispatch failures and retires old login failures without changing the reconnect policy', async () => {
    const f = fixture(); f.reconnect.configure(true, true, true);
    f.defer('reconnect_game').reject('Sign in with your account');
    expect((await f.dispatch.reconnect())!.outcome).toEqual({ status: 'failed', error: 'Sign in with your account' });
    expect(f.reconnect.requiresSignIn).toBe(true);
    const sent = f.defer('reconnect_game'), previous = f.dispatch.reconnect();
    await f.dispatch.login({}); sent.reject('Old account failure');
    expect((await previous)!.outcome).toEqual({ status: 'retired' }); expect(f.reconnect.requiresSignIn).toBe(false);
    f.defer('control_bot', 'start').reject('Start unavailable');
    expect((await f.dispatch.start(settings(), ready()))!.outcome).toEqual({ status: 'failed', error: 'Start unavailable' });
    expect(f.field.requested).toBe(false); expect(f.dispatch.pending.resume).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { ReconnectPolicy, PersistentFieldRun } from './reconnect';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION } from './settings';
import { CompanionController } from './controller';

describe('session reconnect', () => {
  it('requires account access and a previously ready character', () => {
    const p = new ReconnectPolicy(); p.configure(true, false, true);
    p.observe(true, true, 'complete', 0); p.observe(false, false, 'idle', 1);
    expect(p.takeDue(100_000)).toBeNull();
    p.configure(true, true); p.observe(false, false, 'idle', 2);
    expect(p.takeDue(100_000)).toBeNull();
    p.observe(true, true, 'complete', 3); p.observe(false, false, 'idle', 10);
    expect(p.takeDue(5_009)).toBeNull(); expect(p.takeDue(5_010)).toBe(1);
    expect(p.takeDue(100_000)).toBeNull();
  });
  it('backs off persistent failures without exhausting run intent or concurrent retries', () => {
    const p = new ReconnectPolicy(); p.configure(true, true, true);
    p.observe(true, true, 'complete', 0); p.observe(false, false, 'idle', 0);
    let now = 5_000;
    for (let attempt = 1; attempt <= 10; attempt++) {
      expect(p.takeDue(now)).toBe(attempt); expect(p.takeDue(now + 1)).toBeNull();
      p.networkFailure(now);
      const due = p.waitingUntil!;
      expect(due - now).toBeLessThanOrEqual(60_000);
      expect(p.takeDue(due - 1)).toBeNull(); now = due;
    }
  });
  it('keeps the optional non-running reconnect budget bounded', () => {
    const p = new ReconnectPolicy(); p.configure(true, true);
    p.observe(true, true, 'complete', 0); p.observe(false, false, 'idle', 0);
    expect(p.takeDue(5_000)).toBe(1); p.networkFailure(5_000);
    expect(p.takeDue(15_000)).toBe(2); p.networkFailure(15_000);
    expect(p.takeDue(35_000)).toBe(3); p.networkFailure(35_000);
    expect(p.takeDue(1_000_000)).toBeNull();
  });
  it('retries known network sign-in failures once and blocks authentication failures', () => {
    const p = new ReconnectPolicy(); p.configure(true, true, true);
    p.observe(true, true, 'complete', 0); p.observe(false, false, 'idle', 0);
    expect(p.takeDue(5_000)).toBe(1);
    p.observe(false, false, 'failed', 6_000, 'Game disconnected during sign-in. No automatic retry will run.');
    p.observe(false, false, 'failed', 7_000, 'Game disconnected during sign-in. No automatic retry will run.');
    expect(p.waitingUntil).toBe(16_000); expect(p.takeDue(16_000)).toBe(2);
    p.observe(false, false, 'failed', 17_000, 'Sign-in was rejected. Check the game window and try again explicitly.');
    expect(p.requiresSignIn).toBe(true); expect(p.takeDue(1_000_000)).toBeNull();
    p.signIn(); p.observe(true, true, 'complete', 18_000); p.observe(false, false, 'idle', 19_000);
    expect(p.takeDue(24_000)).toBe(1);
  });
  it('keeps retry ownership when an explicit sign-in recovers a requested run', () => {
    const p = new ReconnectPolicy(); p.configure(true, true, true);
    p.observe(true, true, 'complete', 0); p.observe(false, false, 'idle', 0);
    p.signIn();
    p.observe(false, false, 'failed', 1_000, 'Sign-in timed out. Check the game window; no automatic retry will run.');
    expect(p.takeDue(6_000)).toBe(1);
  });
  it('cancels queued attempts on Stop, opt-out or cancelled login', () => {
    for (const reason of ['cancelled', 'manual', 'disabled']) {
      const p = new ReconnectPolicy(); p.configure(true, true, true);
      p.observe(true, true, 'complete', 0); p.observe(false, false, 'idle', 0);
      if (reason === 'manual') p.cancel(); else if (reason === 'disabled') p.configure(false, true);
      else p.observe(false, false, reason, 1);
      expect(p.takeDue(100_000)).toBeNull();
    }
  });
});

describe('field run across game reloads', () => {
  const settings = () => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [1002, 1007] });
  const ready = (sessionId = 'new', name = 'Test') => ({ sessionId, connected: true, compatible: true, map: 'prontera', player: { name } });
  it('validates and captures settings while preserving target classes on a new map', () => {
    const run = new PersistentFieldRun(), value = settings(); run.begin(value, 'Test', 'old'); value.targets.push(9999);
    expect(run.resumeFor(ready('old'))).toBeNull();
    const request = run.resumeFor(ready())!;
    expect(request.settings.map).toBe('prontera'); expect(request.settings.targets).toEqual([1002,1007]);
    expect(run.resumeFor(ready())).toBeNull(); expect(run.completeResume(request, true)).toBe(true);
    expect(run.resumeFor(ready())).toBeNull();
  });
  it('waits for verified self character and rejects another character', () => {
    const run = new PersistentFieldRun(); run.begin(settings(), 'Test', 'old');
    expect(run.resumeFor({ ...ready(), connected: false })).toBeNull();
    expect(run.resumeFor({ ...ready(), compatible: false })).toBeNull();
    expect(run.resumeFor({ ...ready(), player: null })).toBeNull();
    expect(run.resumeFor(ready('new','Other'))).toBeNull();
    expect(run.resumeFor(ready())).not.toBeNull();
  });
  it('preserves cumulative limits across reconnect, counter reset and fractional time', () => {
    let now = 0;
    const run = new PersistentFieldRun(() => now);
    const value = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    value.automation.limits = { minutes: 2, kills: 5, pickups: 7, weightPercent: 0 };
    value.automation.respawn = { enabled: true, maxDeaths: 3 };
    run.begin(value, 'Test', 'old', { kills: 10, looted: 20, deaths: 0 });
    run.observe({ ...ready('old'), kills: 12, looted: 23, deaths: 1 });
    run.observe({ ...ready(), kills: 0, looted: 0, deaths: 0 }); now = 80_000;
    const request = run.resumeFor(ready())!;
    expect(request.settings.automation?.limits).toEqual({ minutes: 1, kills: 3, pickups: 4, weightPercent: 0 });
    expect(request.settings.automation?.respawn.maxDeaths).toBe(2);
    run.completeResume(request, true);
    run.observe({ ...ready(), kills: 3, looted: 1, deaths: 0 });
    expect(run.limitReason).toContain('monster limit'); expect(run.requested).toBe(true);
    expect(run.resumeFor(ready('third'))).toBeNull();
  });
  it('allows the final permitted respawn and disables further respawns after reload', () => {
    const run = new PersistentFieldRun(), value = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    value.automation.respawn = { enabled: true, maxDeaths: 1 };
    run.begin(value, 'Test', 'old'); run.observe({ ...ready('old'), deaths: 1 });
    expect(run.limitReason).toBe('');
    run.observe({ ...ready(), deaths: 0 });
    const request = run.resumeFor(ready())!;
    expect(request.settings.automation?.respawn.enabled).toBe(false);
    expect(request.settings.automation?.respawn.maxDeaths).toBe(0);
    run.completeResume(request, true); run.observe({ ...ready(), deaths: 1 });
    expect(run.limitReason).toContain('death limit');
    expect(run.requested).toBe(true);
  });
  it('carries the final pending respawn on a dead reload without granting a future death', () => {
    const run = new PersistentFieldRun(), value = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    value.automation.respawn = { enabled: true, maxDeaths: 1 };
    run.begin(value, 'Test', 'old'); run.observe({ ...ready('old'), deaths: 1 });
    const dead = { ...ready(), player: { name: 'Test', dead: true }, deaths: 0 };
    run.observe(dead);
    const request = run.resumeFor(dead)!;
    expect(request.settings.automation?.respawn).toEqual({ enabled: true, maxDeaths: 0 });
    run.completeResume(request, true);
    run.observe({ ...ready(), player: { name: 'Test', dead: false }, deaths: 0 });
    run.observe({ ...ready(), player: { name: 'Test', dead: true }, deaths: 1 });
    expect(run.limitReason).toContain('death limit');
    expect(run.resumeFor({ ...dead, sessionId: 'third' })).toBeNull();
  });
  it('does not replay an uncertain dead reload allowance and retains the counted death limit', () => {
    let now = 100_000;
    const run = new PersistentFieldRun(() => now), value = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    value.automation.respawn = { enabled: true, maxDeaths: 1 };
    run.begin(value, 'Test', 'old'); run.observe({ ...ready('old'), deaths: 1 });
    const dead = { ...ready(), player: { name: 'Test', dead: true }, deaths: 0 };
    run.observe(dead);
    const request = run.resumeFor(dead)!;
    const sent: Array<{ type: string }> = [];
    const controller = new CompanionController(action => sent.push(action), () => now,
      () => ({ width: 200, height: 200, walkable: () => true }));
    controller.connect(true);
    controller.engine.receive([{ type: 'enter', id: 1, map: 'prontera' },
      { type: 'spawn', entity: { id: 1, classId: 0, name: 'Test', kind: 0, level: 7, hp: 0, maxHp: 100, x: 100, y: 100, dead: true } }]);
    controller.start(request.settings,undefined,undefined,request.deathRecoveryGuard); run.completeResume(request, true);
    for (let i = 0; i < 3; i++) { now += 100; controller.tick(); }
    expect(controller.engine.deaths).toBe(0);
    expect(sent.filter(action => action.type === 'respawn')).toHaveLength(0);
    controller.engine.receive([{ type: 'resurrection', id: 1, hp: 100, position: { x: 100, y: 100 } }]);
    now += 100; controller.tick();
    expect(controller.engine.player?.dead).toBe(false);
    controller.engine.receive([{ type: 'death', id: 1 }]);
    now += 100; controller.tick();
    expect(controller.engine.deaths).toBe(1);
    expect(controller.snapshot()).toMatchObject({ runRequested: true, state: 'waiting' });
    expect(sent.filter(action => action.type === 'respawn')).toHaveLength(0);
    run.observe({ ...dead, deaths: controller.engine.deaths });
    expect(run.limitReason).toContain('death limit');
  });
  it('holds at the original wall deadline even while disconnected', () => {
    let now = 0;
    const run = new PersistentFieldRun(() => now), value = { ...settings(), automation: structuredClone(DEFAULT_AUTOMATION) };
    value.automation.limits.minutes = 1;
    run.begin(value, 'Test', 'old'); now = 60_000;
    expect(run.limitReason).toContain('time limit'); expect(run.resumeFor(ready())).toBeNull();
  });
  it('Stop invalidates a late resume and cannot start again from telemetry', () => {
    const run = new PersistentFieldRun(); run.begin(settings(), 'Test', 'old');
    const request = run.resumeFor(ready())!; run.stop();
    expect(run.requested).toBe(false); expect(run.completeResume(request,true)).toBe(false);
    expect(run.resumeFor(ready())).toBeNull();
  });
  it('retries a failed dispatch and rejects stale completion after a replacement run', () => {
    const run = new PersistentFieldRun(); run.begin(settings(), 'Test', 'old');
    const request = run.resumeFor(ready())!; expect(run.completeResume(request,false)).toBe(true);
    expect(run.resumeFor(ready())).not.toBeNull(); run.begin(settings(),'Test','replacement');
    expect(run.completeResume(request,true)).toBe(false);
  });
});

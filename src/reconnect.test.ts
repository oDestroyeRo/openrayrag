import { describe, expect, it } from 'vitest';
import { ReconnectPolicy, PersistentFieldRun, validateFieldRunCheckpoint, type FieldRunCheckpoint } from './reconnect';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION } from './settings';
import { CompanionController } from './controller';
import { DEFAULT_SUPPLY, type SupplyResumeGuard } from './supply-trip';
import type { DeathRecoveryGuard } from './death-recovery';
import { BitWriter } from './binary';
import { OP } from './protocol';

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

it('automatic reconnect disarms rendezvous without changing saved user policy',()=>{
 const run=new PersistentFieldRun(),automation=structuredClone(DEFAULT_AUTOMATION);automation.follow={...automation.follow,mode:'partyLeader',rendezvous:true};
 run.begin({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[1002],automation},'Test','old');
 const request=run.resumeFor({sessionId:'new',connected:true,compatible:true,map:'prontera',player:{name:'Test'}})!;
 expect(request.settings.automation!.follow.rendezvous).toBe(false);expect(automation.follow.rendezvous).toBe(true);
});

describe('field run updater checkpoints', () => {
  const ready = (sessionId = 'old', name = 'Test') => ({ sessionId, connected: true, compatible: true,
    map: 'prt_fild08', player: { name, dead: false }, runRequested: true });
  function settings() {
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.limits = { minutes: 5, kills: 10, pickups: 12, weightPercent: 0 };
    automation.respawn = { enabled: true, maxDeaths: 3 };
    automation.escape!.enabled = true;
    automation.supply = { ...DEFAULT_SUPPLY, enabled: true, maxTrips: 3 };
    return { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [1002], automation };
  }
  const supply = (): SupplyResumeGuard => ({ version: 1, character: 'Test', latched: true, remainingTrips: 2,
    actions: 4, spent: 50, reserved: 20, intervalSeconds: 300, deadlineSeconds: 500,
    interrupted: false, uncertain: false, returnDestination: null });
  const death = (now: number): DeathRecoveryGuard => ({ version: 1, character: 'Test', destination: 'prt_fild08',
    phase: 'revival', uncertain: false, recoverySeconds: 300, returnSeconds: 1200,
    recoveryDeadline: now + 300_000, returnDeadline: now + 1_500_000 });
  function fixture() {
    let now = 100_000;
    const run = new PersistentFieldRun(() => now);
    run.begin(settings(), 'Test', 'old', { kills: 10, looted: 20, deaths: 2, attacks: 3 });
    run.observe({ ...ready(), kills: 13, looted: 24, deaths: 3, attacks: 8, supplyGuard: supply(),
      deathRecoveryGuard: death(now), escape: { state: 'confirmed', reason: '', pending: false,
        consumed: true, cooldownSeconds: 120, latched: true, recovery: { hpPercent: 100, threatCount: 1, quietSeconds: 60 } } });
    return { run, now: () => now, advance: (elapsed: number) => { now += elapsed; } };
  }
  const roundtrip = (checkpoint: FieldRunCheckpoint) => JSON.parse(JSON.stringify(checkpoint)) as FieldRunCheckpoint;

  it('returns a defensive data-only checkpoint only for active intent and restores without begin resets', () => {
    const f = fixture(), original = f.run.checkpoint()!;
    const copied = f.run.checkpoint()!;
    Array.prototype.push.call(copied.desired.targets,999); copied.totals.kills = 0; copied.supplyGuard!.guard.remainingTrips = 100;
    expect(f.run.checkpoint()).toEqual(original);
    const restored = new PersistentFieldRun(f.now), input = roundtrip(original);
    restored.restore(input);
    input.previous.kills = 0; Array.prototype.push.call(input.desired.targets,999); input.supplyGuard!.guard.remainingTrips = 100;
    expect(restored.checkpoint()).toEqual({ ...original, generation: original.generation + 1 });
    expect(restored.metrics).toEqual({ kills: 3, looted: 4, deaths: 1, attacks: 5 });
    expect(restored.targetIds).toEqual([1002]);
    expect(original.supplyGuard!.guard.character).toBe('Test');
    restored.stop(); expect(restored.checkpoint()).toBeNull();
  });

  it('includes update downtime in the original wall deadline and retains cumulative limits', () => {
    const f = fixture(), checkpoint = roundtrip(f.run.checkpoint()!);
    f.advance(140_000);
    const restored = new PersistentFieldRun(f.now); restored.restore(checkpoint);
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.settings.automation?.limits).toEqual({ minutes: 3, kills: 7, pickups: 8, weightPercent: 0 });
    expect(request.settings.automation?.respawn.maxDeaths).toBe(2);
    f.advance(160_000);
    expect(restored.limitReason).toContain('time limit');
    expect(restored.resumeFor(ready('third'), { settledUpdate: true })).toBeNull();
  });

  it('adds final frozen counter deltas exactly once before the successor resets counters', () => {
    const f = fixture(), checkpoint = roundtrip(f.run.checkpoint()!);
    f.advance(20_000); const frozenAt = f.now(); f.advance(80_000);
    const restored = new PersistentFieldRun(f.now); restored.restore(checkpoint);
    const final = { ...ready(), kills: 15, looted: 25, deaths: 4, attacks: 11 };
    restored.observe(final, frozenAt); restored.observe(final, frozenAt);
    expect(restored.metrics).toEqual({ kills: 5, looted: 5, deaths: 2, attacks: 8 });
    restored.observe({ ...ready('new'), kills: 0, looted: 0, deaths: 0, attacks: 0 });
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.settings.automation?.limits.kills).toBe(5);
    expect(request.settings.automation?.respawn.maxDeaths).toBe(1);
    restored.completeResume(request, true);
    restored.observe({ ...ready('new'), kills: 5, looted: 1, deaths: 0, attacks: 2 });
    expect(restored.limitReason).toContain('monster limit');
  });

  it('ages final frozen cooldowns and supply deadlines through update downtime', () => {
    const f = fixture(), checkpoint = roundtrip(f.run.checkpoint()!);
    f.advance(20_000); const frozenAt = f.now(); f.advance(80_000);
    const restored = new PersistentFieldRun(f.now); restored.restore(checkpoint);
    restored.observe({ ...ready(), supplyGuard: { ...supply(), intervalSeconds: 280, deadlineSeconds: 480 },
      escape: { state: 'confirmed', reason: '', pending: false, consumed: true, cooldownSeconds: 100, latched: true } }, frozenAt);
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.supplyGuard).toMatchObject({ remainingTrips: 2, actions: 4, spent: 50, reserved: 20,
      intervalSeconds: 200, deadlineSeconds: 400, uncertain: false, interrupted: false });
    expect(request.escapeGuard).toMatchObject({ latched: true, cooldownSeconds: 20 });
  });

  it('transfers settled guards without consuming a supply trip or inventing revival uncertainty', () => {
    const f = fixture(), checkpoint = roundtrip(f.run.checkpoint()!);
    f.advance(10_000);
    const restored = new PersistentFieldRun(f.now); restored.restore(checkpoint);
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.supplyGuard).toMatchObject({ remainingTrips: 2, uncertain: false });
    expect(request.deathRecoveryGuard).toEqual(checkpoint.deathGuard!.guard);
    expect(restored.completeResume(request, true)).toBe(true);
    expect(restored.supplyGuardForStart(request.settings, 'Test', 'new', true)).toMatchObject({ remainingTrips: 2, uncertain: false });
    const next = restored.resumeFor(ready('third'), { settledUpdate: true })!;
    expect(next.supplyGuard).toMatchObject({ remainingTrips: 1, uncertain: true, interrupted: true });
    expect(next.deathRecoveryGuard?.uncertain).toBe(true);
  });

  it.each([false, true])('keeps clean allowances after a known failed activation with retained episodes=%s', retained => {
    const f = fixture(), source = retained ? f.run : new PersistentFieldRun(f.now);
    if (!retained) source.begin(settings(), 'Test', 'old');
    const restored = new PersistentFieldRun(f.now); restored.restore(roundtrip(source.checkpoint()!));
    const first = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(restored.resumeFor(ready('new'), { settledUpdate: true })).toBeNull();
    expect(restored.completeResume(first, false)).toBe(true);
    f.advance(1_000);
    const retry = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(retry.supplyGuard).toEqual({ ...first.supplyGuard!,
      intervalSeconds: Math.max(0, first.supplyGuard!.intervalSeconds - 1),
      deadlineSeconds: Math.max(0, first.supplyGuard!.deadlineSeconds - 1) });
    expect(retry.supplyGuard).toMatchObject({ remainingTrips: retained ? 2 : 3, uncertain: false });
    expect(retry.deathRecoveryGuard).toEqual(first.deathRecoveryGuard);
    expect(retry.escapeGuard).toEqual(first.escapeGuard ? {
      ...first.escapeGuard, cooldownSeconds: first.escapeGuard.cooldownSeconds - 1,
    } : undefined);
    expect(restored.completeResume(retry, true)).toBe(true);
    const later = restored.resumeFor(ready('third'), { settledUpdate: true })!;
    expect(later.supplyGuard).toMatchObject({ remainingTrips: retained ? 1 : 2, interrupted: true, uncertain: true });
    expect(later.deathRecoveryGuard?.uncertain).toBe(true);
    expect(later.escapeGuard?.latched).toBe(true);
  });

  it('forfeits clean provenance when an ordinary reconnect attempt is chosen', () => {
    const f = fixture(), restored = new PersistentFieldRun(f.now); restored.restore(roundtrip(f.run.checkpoint()!));
    const ordinary = restored.resumeFor(ready('new'))!;
    expect(ordinary.supplyGuard).toMatchObject({ remainingTrips: 1, uncertain: true });
    expect(restored.completeResume(ordinary, false)).toBe(true);
    const retry = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(retry.supplyGuard).toMatchObject({ remainingTrips: 1, uncertain: true });
    expect(retry.deathRecoveryGuard?.uncertain).toBe(true);
  });

  it('allows a fresh settled character with no death episode to retain its normal next respawn', () => {
    let now = 100_000;
    const value = settings(); value.automation.supply!.enabled = false;
    const run = new PersistentFieldRun(() => now); run.begin(value, 'Test', 'old');
    const restored = new PersistentFieldRun(() => now); restored.restore(roundtrip(run.checkpoint()!));
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.deathRecoveryGuard).toBeUndefined();
    expect(request.escapeGuard).toBeUndefined();
    expect(request.supplyGuard).toBeUndefined();
    const sent: Array<{ type: string }> = [];
    const controller = new CompanionController(action => sent.push(action), () => now,
      () => ({ width: 200, height: 200, walkable: () => true }));
    controller.connect(true);
    controller.receive(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish());
    const name = new TextEncoder().encode('Test');
    const body = new BitWriter().u8(15).i32(1).i32(6).i32(0).i32(~name.length).i32(4).take(name)
      .u8(0).u8(0).u8(0).i32(100).i32(100).u8(7).i32(100).i32(100).i32(50).i32(50).i32(0).u8(0).finish();
    controller.receive(new BitWriter().u8(OP.spawn).u8(1).i32(body.length).take(body).finish());
    controller.start(request.settings, request.escapeGuard, request.supplyGuard, request.deathRecoveryGuard);
    expect(sent.filter(action => action.type === 'respawn')).toHaveLength(0);
    controller.receive(new BitWriter().u8(OP.death).i32(1).finish());
    for (let i = 0; i < 21; i++) { now += 100; controller.tick(); }
    expect(sent.filter(action => action.type === 'respawn'), JSON.stringify({ reason: controller.snapshot().reason,
      guard: controller.snapshot().deathRecoveryGuard, player: controller.engine.player })).toHaveLength(1);
  });

  it('does not grant clean-update treatment without restore or to retained older-session guards', () => {
    const f = fixture();
    const ordinary = f.run.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(ordinary.supplyGuard).toMatchObject({ remainingTrips: 1, uncertain: true });
    expect(ordinary.deathRecoveryGuard?.uncertain).toBe(true);
    const saved = roundtrip(f.run.checkpoint()!);
    saved.supplyGuard!.session = 'earlier'; saved.deathGuard!.session = 'earlier'; saved.escapeGuard!.session = 'earlier';
    const restored = new PersistentFieldRun(f.now); restored.restore(saved);
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.supplyGuard).toMatchObject({ remainingTrips: 1, uncertain: true });
    expect(request.deathRecoveryGuard?.uncertain).toBe(true);
    expect(request.escapeGuard?.cooldownSeconds).toBeGreaterThanOrEqual(saved.desired.automation!.escape!.cooldownSeconds);
  });

  it('rejects an active restore atomically and keeps generations monotonic through Stop and restore', () => {
    const f = fixture(), saved = roundtrip(f.run.checkpoint()!);
    const pending = f.run.resumeFor(ready('new'))!;
    expect(() => f.run.restore(saved)).toThrow('Stop');
    expect(f.run.completeResume(pending, false)).toBe(true);
    f.run.stop(); f.run.restore(saved);
    expect(f.run.checkpoint()!.generation).toBeGreaterThan(pending.generation);
    expect(f.run.completeResume(pending, true)).toBe(false);
    const request = f.run.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(f.run.completeResume(request, false)).toBe(true);
    expect(f.run.resumeFor(ready('new'), { settledUpdate: true })?.supplyGuard?.uncertain).toBe(false);
  });

  it('waits for compatible same-character readiness without consuming the settled provenance', () => {
    const f = fixture(), restored = new PersistentFieldRun(f.now); restored.restore(roundtrip(f.run.checkpoint()!));
    expect(restored.resumeFor(ready('new', 'Other'), { settledUpdate: true })).toBeNull();
    expect(restored.resumeFor({ ...ready('new'), compatible: false }, { settledUpdate: true })).toBeNull();
    expect(restored.resumeFor({ ...ready('new'), connected: false }, { settledUpdate: true })).toBeNull();
    expect(restored.resumeFor(ready('old'), { settledUpdate: true })).toBeNull();
    expect(restored.resumeFor(ready('new'), { settledUpdate: true })?.supplyGuard?.uncertain).toBe(false);
  });

  const corruptions: Array<[string, (value: FieldRunCheckpoint) => void]> = [
    ['unknown protocol', value => { (value as { version: number }).version = 2; }],
    ['extra credential', value => { Object.assign(value, { password: 'forbidden' }); }],
    ['executable queue', value => { Object.assign(value, { queue: [{ type: 'useItem' }] }); }],
    ['corrupt settings', value => { Object.assign(value.desired,{radius:99}); }],
    ['wrong metrics session', value => { value.metricsSession = 'Other'; }],
    ['empty session', value => { value.session = ''; }],
    ['wrong supply character', value => { value.supplyGuard!.guard.character = 'Other'; }],
    ['wrong death character', value => { value.deathGuard!.guard.character = 'Other'; }],
    ['wrong death destination', value => { value.deathGuard!.guard.destination = 'prontera'; }],
    ['corrupt supply counter', value => { value.supplyGuard!.guard.remainingTrips = 101; }],
    ['corrupt escape recovery', value => { value.escapeGuard!.recovery!.hpPercent = 0; }],
    ['extra guard receipt', value => { Object.assign(value.supplyGuard!.guard, { receipt: 'forbidden' }); }],
    ['negative counter', value => { value.totals.kills = -1; }],
    ['fractional counter', value => { value.previous.attacks = 1.5; }],
    ['unsafe counter', value => { value.totals.looted = Number.MAX_SAFE_INTEGER + 1; }],
    ['unsafe generation', value => { value.generation = Number.MAX_SAFE_INTEGER; }],
    ['future start', value => { value.startedAt = 100_001; }],
    ['future guard timestamp', value => { value.supplyGuard!.at = 100_001; }],
    ['unbounded cooldown', value => { value.escapeGuard!.cooldownUntil = 3_700_001; }],
    ['expanded death deadline', value => { value.deathGuard!.guard.returnDeadline = 1_600_001; }],
    ['missing supply allowance', value => { value.supplyGuard = null; }],
    ['missing escape allowance', value => { value.escapeGuard = null; }],
    ['missing counters', value => { delete (value.previous as Partial<typeof value.previous>).deaths; }],
  ];
  it.each(corruptions)('rejects %s before mutation and can still restore a valid checkpoint', (_label, corrupt) => {
    const f = fixture(), saved = roundtrip(f.run.checkpoint()!), invalid = roundtrip(saved), restored = new PersistentFieldRun(f.now);
    corrupt(invalid);
    expect(() => validateFieldRunCheckpoint(invalid, f.now())).toThrow();
    expect(() => restored.restore(invalid)).toThrow();
    expect(restored.requested).toBe(false); expect(restored.metrics).toEqual({ kills: 0, looted: 0, deaths: 0, attacks: 0 });
    expect(restored.checkpoint()).toBeNull();
    restored.restore(saved);
    expect(restored.checkpoint()).toEqual({ ...saved, generation: saved.generation + 1 });
  });

  it('retains bounded overflow protection when only the active character crosses the update', () => {
    const f = fixture(), saved = roundtrip(f.run.checkpoint()!);
    saved.escapeGuard = null; saved.supplyGuard = null; saved.deathGuard = null;
    saved.escapeOverflowUncertain = true; saved.supplyOverflow = true; saved.deathOverflow = true;
    const restored = new PersistentFieldRun(f.now); restored.restore(saved);
    const request = restored.resumeFor(ready('new'), { settledUpdate: true })!;
    expect(request.escapeGuard).toMatchObject({ latched: true, cooldownSeconds: 3600 });
    expect(request.supplyGuard).toMatchObject({ remainingTrips: 0, uncertain: true });
    expect(request.deathRecoveryGuard).toMatchObject({ phase: 'failed', uncertain: true });
  });
});

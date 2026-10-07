import { actionIdentity } from '../world/actor-identity';
import { describe, expect, it } from 'vitest';
import { CastAvailability, type ObservedCast } from './cast-availability';
import type { Entity } from '../protocol/protocol';

const own: Entity = {
  id: 0,
  classId: 6,
  name: 'Test',
  kind: 0,
  level: 15,
  hp: 100,
  maxHp: 100,
  x: 100,
  y: 100,
  dead: false,
};
const identity = actionIdentity({
  world: '00000000-0000-0000-0000-000000000001',
  selfId: 0,
  selfIncarnation: 1,
});
function fixture(initialized = true) {
  let now = 100_000;
  const owner = new CastAvailability(() => now);
  owner.connectionChanged();
  owner.allowRun();
  if (initialized) {
    owner.observe({ type: 'enter', id: 0, map: 'prt_fild08' }, undefined);
    owner.observe({ type: 'spawn', entity: own, entryType: 1 }, own);
  }
  let cast: ObservedCast | null = {
    identity,
    revision: 1,
    capturedAt: now,
    remainingSeconds: 1,
    facing: 6,
    ambiguous: true,
  };
  owner.capture(cast);
  const take = (extra: Partial<Parameters<typeof owner.take>[0]> = {}) =>
    owner.take({
      cast,
      requested: true,
      ready: true,
      exclusive: true,
      reason: 'conflicting owner',
      ...extra,
    });
  return {
    owner,
    take,
    time: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    setCast: (next: ObservedCast | null) => {
      cast = next;
    },
    cast: () => cast,
  };
}
describe('bounded stationary availability owner', () => {
  it('reserves six attempts at least one second apart without renewing the original window', () => {
    const f = fixture();
    f.advance(1249);
    expect(f.take()).toBeNull();
    f.advance(1);
    for (let n = 1; n <= 6; n++) {
      expect(f.take()).toEqual({ type: 'look', direction: 6, head: 1 });
      expect(f.owner.attempts).toBe(n);
      f.advance(999);
      expect(f.take()).toBeNull();
      f.advance(1);
    }
    expect(f.take()).toBeNull();
    expect(f.owner.reason).toContain('exhausted');
    f.advance(60_000);
    expect(f.take()).toBeNull();
  });
  it('expires the immutable window while transient readiness keeps probes delayed', () => {
    const f = fixture();
    f.advance(11_249);
    expect(f.take({ ready: false })).toBeNull();
    f.advance(1);
    expect(f.take()).toBeNull();
    expect(f.owner.attempts).toBe(0);
    expect(f.owner.reason).toContain('exhausted');
  });
  it.each(['Stop', 'official Look', 'send then throw', 'another owner'])(
    'never reopens a canceled cast episode after %s',
    (reason) => {
      const f = fixture();
      f.advance(1250);
      expect(f.take()).not.toBeNull();
      f.owner.cancel(reason);
      f.advance(1000);
      expect(f.take()).toBeNull();
      expect(f.owner.attempts).toBe(1);
      f.owner.allowRun();
      expect(f.take()).toBeNull();
    },
  );
  it('requires renewed explicit permission after a new transport initialization', () => {
    const f = fixture();
    f.owner.connectionChanged();
    f.owner.observe({ type: 'enter', id: 0, map: 'prt_fild08' }, undefined);
    f.owner.observe({ type: 'spawn', entity: own, entryType: 1 }, own);
    f.owner.capture(f.cast()!);
    f.advance(1250);
    expect(f.owner.nonVending).toBe(true);
    expect(f.take()).toBeNull();
    expect(f.owner.attempts).toBe(0);
  });
  it.each([
    { ...identity, selfIncarnation: 2 },
    { ...identity, world: '00000000-0000-0000-0000-000000000002' },
    { ...identity, selfId: 1 },
  ])('rejects replacement actor ownership %j', (next) => {
    const f = fixture();
    f.setCast({ ...f.cast()!, identity: actionIdentity(next) });
    f.advance(1250);
    expect(f.take()).toBeNull();
  });
  it('does not attribute a retired episode to a newer cast revision', () => {
    const f = fixture();
    f.advance(1250);
    expect(f.take()).not.toBeNull();
    f.setCast({ ...f.cast()!, revision: 2 });
    expect(f.take()).toBeNull();
  });
  it('includes all possibly transmitted and retired probes in the positive availability input hold', () => {
    const f = fixture();
    f.advance(1250);
    for (let n = 0; n < 3; n++) {
      expect(f.take()).not.toBeNull();
      f.advance(1000);
    }
    f.owner.cancel('retired');
    const next = { ...f.cast()!, revision: 2, capturedAt: f.time(), remainingSeconds: 0 };
    f.setCast(next);
    f.owner.capture(next);
    f.advance(250);
    expect(f.take()).toBeNull();
    f.owner.available();
    expect(f.owner.cooldownSettled()).toBe(false);
    f.advance(499);
    expect(f.owner.cooldownSettled()).toBe(false);
    f.advance(1);
    expect(f.owner.cooldownSettled()).toBe(true);
  });
  it('starts one independent retirement drain without renewing it on unrelated repeated retirement frames', () => {
    const f = fixture();
    f.advance(1250);
    for (let n = 0; n < 6; n++) {
      expect(f.take()).not.toBeNull();
      f.advance(1000);
    }
    f.owner.retire('same-connection cast/lifetime retirement');
    f.advance(799);
    f.owner.retire('another field frame');
    expect(f.owner.cooldownSettled()).toBe(false);
    f.advance(1);
    expect(f.owner.cooldownSettled()).toBe(true);
    f.owner.retire('later field frame');
    expect(f.owner.cooldownSettled()).toBe(true);
  });
  it('does not add a retirement delay when no automatic Look could have been transmitted', () => {
    const f = fixture();
    f.owner.retire('own StopCast without any probes');
    expect(f.owner.cooldownSettled()).toBe(true);
  });
  it('requires real transport Enter and matching own player entry1 for the initial baseline', () => {
    const f = fixture(false);
    expect(f.owner.nonVending).toBe(false);
    f.owner.observe({ type: 'spawn', entity: own, entryType: 1 }, own);
    expect(f.owner.nonVending).toBe(false);
    f.owner.observe({ type: 'enter', id: 0, map: 'prt_fild08' }, undefined);
    for (const entity of [
      { ...own, id: 1 },
      { ...own, kind: 1 },
    ])
      f.owner.observe({ type: 'spawn', entity, entryType: 1 }, own);
    f.owner.observe({ type: 'spawn', entity: own, entryType: 0 }, own);
    expect(f.owner.nonVending).toBe(false);
    f.owner.observe({ type: 'spawn', entity: own, entryType: 1 }, own);
    expect(f.owner.nonVending).toBe(true);
  });
  it('establishes a fresh dead-login runtime baseline while refusing probes until the actor is ready', () => {
    const f = fixture(false),
      dead = { ...own, dead: true, hp: 0 };
    f.owner.observe({ type: 'enter', id: 0, map: 'prt_fild08' }, undefined);
    f.owner.observe({ type: 'spawn', entity: dead, entryType: 1 }, dead);
    expect(f.owner.nonVending).toBe(true);
    f.advance(1250);
    expect(f.take({ ready: false })).toBeNull();
    expect(f.owner.attempts).toBe(0);
    f.owner.observe({ type: 'clear' }, dead);
    f.owner.observe({ type: 'spawn', entity: own, entryType: 2 }, own);
    expect(f.owner.nonVending).toBe(true);
    expect(f.take()).toEqual({ type: 'look', direction: 6, head: 1 });
  });
  it('preserves vending and NPC activity that precede initialization', () => {
    const f = fixture(false);
    f.owner.observe({ type: 'enter', id: 0, map: 'prt_fild08' }, undefined);
    f.owner.observeWorld({
      type: 'vendingStarted',
      name: 'shop',
      rows: [{ id: 1, count: 1, price: 1 }],
    });
    f.owner.observe({ type: 'spawn', entity: own, entryType: 1 }, own);
    expect(f.owner.nonVending).toBe(false);
    f.owner.observeWorld({ type: 'vendingStopped' });
    expect(f.owner.nonVending).toBe(false);
    f.owner.observeWorld({ type: 'npcEnd' });
    expect(f.owner.nonVending).toBe(true);
  });
  it.each(['map', 'clear', 'death', 'remove', 'resurrection'] as const)(
    'retains vending authority across %s rather than trusting field defaults',
    (edge) => {
      const f = fixture();
      f.owner.observeWorld({
        type: 'vendingStarted',
        name: 'shop',
        rows: [{ id: 1, count: 1, price: 1 }],
      });
      if (edge === 'map') f.owner.observe({ type: edge, map: 'prontera' }, own);
      else if (edge === 'clear') f.owner.observe({ type: edge }, own);
      else if (edge === 'remove') f.owner.observe({ type: edge, id: 0, dead: false }, own);
      else if (edge === 'resurrection')
        f.owner.observe({ type: edge, id: 0, hp: 100, position: own }, own);
      else f.owner.observe({ type: edge, id: 0 }, own);
      f.owner.observe({ type: 'spawn', entity: own, entryType: 1 }, own);
      expect(f.owner.nonVending).toBe(false);
      f.owner.observeWorld({ type: 'npcEnd' });
      expect(f.owner.nonVending).toBe(true);
    },
  );
  it('does not let NPC exit alone manufacture an unknown transport baseline', () => {
    const f = fixture(false);
    f.owner.observeWorld({ type: 'npcEnd' });
    expect(f.owner.nonVending).toBe(false);
  });
});

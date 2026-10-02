import { describe, expect, it } from 'vitest';
import { ObservedThreats, THREAT_LIMIT } from './observed-threats';
import type { ActionIdentity } from './actor-identity';
import { BotEngine } from './engine';
import type { Entity, GameEvent } from './protocol';
import { evaluateActorPredicate } from './actor-observations';

const self: Entity = { id: 0, kind: 0, classId: 1, name: 'Self', x: 20, y: 20, level: 1, hp: 100, maxHp: 100, dead: false };
const monster = (id = 1): Entity => ({ ...self, id, kind: 1, name: 'Monster' });
const attack = (source = 1, target = 0): GameEvent => ({ type: 'attack', source, target, position: { x: 20, y: 20 } });
function fixture() {
  let now = 100_000;
  const engine = new BotEngine(() => {}, () => now);
  engine.connect(true); engine.receive([{ type: 'enter', id: 0, map: 'prt_fild08' }, { type: 'spawn', entity: { ...self } }, { type: 'spawn', entity: monster() }]);
  return { engine, at: (value: number) => { now = value; }, receive: (...events: GameEvent[]) => engine.receive(events), sample: (seconds = 10) => engine.observedThreats(seconds) };
}
describe('bounded received Attack observations', () => {
  it('counts distinct living monster lifetimes, expires at the exact boundary, and never refreshes on unrelated traffic', () => {
    const f = fixture(); expect(f.sample().count).toBe(0);
    f.receive(attack(), attack()); expect(f.sample().count).toBe(1);
    f.at(109_999); f.receive({ type: 'spawn', entity: monster(2) }, attack(2)); expect(f.sample().count).toBe(2);
    f.at(110_000); f.receive({ type: 'position', id: 1, position: { x: 21, y: 21 } }); expect(f.sample().count).toBe(1);
    f.at(119_999); expect(f.sample().count).toBe(0);
  });
  it('preserves resource observation provenance without treating resource updates or skill displays as attacks', () => {
    const f = fixture(); f.receive(attack()); f.at(101_000);
    f.receive({ type: 'sp', sp: 25, maxSp: 100 }, { type: 'heal', id: 1, hp: 80, maxHp: 100 },
      { type: 'skillImpact', source: 1, target: 0, skillId: 11, damage: 20, damageSeconds: 0, hits: 1, result: 1, position: { x: 20, y: 20 } });
    const snapshot = f.engine.actorObservation([], null, 1);
    expect(evaluateActorPredicate({ field: 'actorSpPercent', actor: { scope: 'self' }, operator: 'eq', value: 25 }, snapshot).state).toBe('matched');
    expect(evaluateActorPredicate({ field: 'actorHpPercent', actor: { scope: 'candidate' }, operator: 'eq', value: 80 }, snapshot).state).toBe('matched');
    expect(snapshot.actors.find(actor => actor.id === 0)?.sp).toMatchObject({ source: 'own-sp', at: 101_000 });
    expect(f.sample(2).count).toBe(1); f.at(102_000); expect(f.sample(2).count).toBe(0);
  });
  it('accepts monster actor zero but ignores negative/unknown sources, bystanders, players, NPCs and unattributed hits', () => {
    const f = fixture();
    f.receive({ type: 'enter', id: 2, map: 'prt_fild08' }, { type: 'spawn', entity: { ...self, id: 2 } }, { type: 'spawn', entity: monster(0) },
      { type: 'spawn', entity: { ...self, id: 3 } }, { type: 'spawn', entity: { ...self, id: 4, kind: 2 } });
    f.receive(attack(-1, 2), attack(99, 2), attack(3, 2), attack(4, 2), attack(0, 3)); expect(f.sample().count).toBe(0);
    f.receive(attack(0, 2)); expect(f.sample().count).toBe(1);
  });
  it.each(['replacement', 'death', 'remove', 'dead-hit'] as const)('drops evidence on monster %s', change => {
    const f = fixture(); f.receive(attack());
    if (change === 'replacement') f.receive({ type: 'spawn', entity: monster() });
    if (change === 'death') f.receive({ type: 'death', id: 1 });
    if (change === 'remove') f.receive({ type: 'remove', id: 1, dead: false });
    if (change === 'dead-hit') f.receive({ type: 'hit', id: 1, damage: 100, stops: false, position: { x: 20, y: 20 } });
    expect(f.sample().count).toBe(0);
  });
  it.each(['replacement', 'death', 'remove', 'world', 'connection'] as const)('drops evidence on own %s without transferring it to a new lifetime', change => {
    const f = fixture(); f.receive(attack());
    if (change === 'replacement') f.receive({ type: 'spawn', entity: { ...self } });
    if (change === 'death') f.receive({ type: 'death', id: 0 });
    if (change === 'remove') f.receive({ type: 'remove', id: 0, dead: false });
    if (change === 'world') f.receive({ type: 'clear' });
    if (change === 'connection') { f.engine.disconnect(); f.engine.connect(true); }
    expect(f.sample().count).not.toBe(1);
    f.receive({ type: 'enter', id: 0, map: 'prt_fild08' }, { type: 'spawn', entity: { ...self } }, { type: 'spawn', entity: monster() });
    expect(f.sample().count).toBe(0);
  });
  it('respects within-frame replacement order and fails unavailable when actor observation capacity is exhausted', () => {
    const f = fixture();
    f.receive(attack(2), { type: 'spawn', entity: monster(2) }); expect(f.sample().count).toBe(0);
    f.receive(attack(2), { type: 'spawn', entity: monster(2) }); expect(f.sample().count).toBe(0);
    for (let id = 3; id < 303; id++) f.receive({ type: 'spawn', entity: monster(id) });
    f.receive(attack(302)); expect(f.sample()).toMatchObject({ count: null, truncated: true });
  });
  it('bounds attacker storage and keeps truncated counts unavailable for the maximum evidence window', () => {
    const f = fixture();
    for (let id = 1; id <= THREAT_LIMIT + 1; id++) f.receive({ type: 'spawn', entity: monster(id) }, attack(id));
    expect(f.sample()).toMatchObject({ count: null, truncated: true });
    f.at(159_999); expect(f.sample(1).count).toBeNull();
    f.at(160_000); expect(f.sample().count).toBe(0);
  });
  it('invalidates receipt evidence when the receive clock rolls back', () => {
    const f = fixture(); f.receive(attack()); f.at(99_999); expect(f.sample().count).toBe(0);
    f.receive(attack()); expect(f.sample().count).toBeNull();
  });
  it('rejects stale world, incarnation and observation-time contexts', () => {
    const store = new ObservedThreats(), own: ActionIdentity = { world: 'world', selfId: 0, selfIncarnation: 1 };
    const current = () => ({ ...own, targetId: 1, targetIncarnation: 2 });
    for (const identity of [{ ...current(), world: 'old' }, { ...current(), selfIncarnation: 9 }, { ...current(), targetIncarnation: 1 }])
      store.observe(1, 0, own, identity, 100, 100, current);
    store.observe(1, 0, own, current(), 101, 100, current);
    expect(store.snapshot(10, own, 100, current).count).toBe(0);
    store.observe(1, 0, own, current(), 100, 100, current);
    store.observe(1, 0, own, current(), 99, 101, current);
    expect(store.snapshot(1, own, 1100, current).count).toBe(0);
  });
});


it('discards own attack evidence on contradictory zero HP even before an explicit death packet', () => {
  const f = fixture(); f.receive(attack());
  f.receive({ type: 'heal', id: 0, hp: 0, maxHp: 100 }); expect(f.sample().count).toBeNull();
  f.receive({ type: 'heal', id: 0, hp: 100, maxHp: 100 }); expect(f.sample().count).toBe(0);
});

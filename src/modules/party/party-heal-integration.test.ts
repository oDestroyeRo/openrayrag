import { partyMemberId } from '../../shared/domain-values';
import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../shared/binary';
import { CompanionController } from '../runtime/controller';
import type { Action } from '../automation/engine';
import { OP, type Entity } from '../protocol/protocol';
import { FEATURE_OP } from '../protocol/protocol-feature';
import { DEFAULT_AUTOMATION, DEFAULT_PARTY_HEAL, DEFAULT_SETTINGS } from '../settings/settings';
import type { WorldAction } from '../protocol/world-protocol';

const map = 'prt_fild08';
const own: Entity = {
  id: 0,
  kind: 0,
  classId: 3,
  name: 'Acolyte',
  level: 20,
  hp: 100,
  maxHp: 100,
  sp: 100,
  maxSp: 100,
  x: 10,
  y: 10,
  dead: false,
};
const ally: Entity = { ...own, id: 2, name: 'Member', hp: 40, x: 11 };
function spawn(entity: Entity, entryType = 0): Uint8Array {
  const name = new TextEncoder().encode(entity.name);
  const body = new BitWriter()
    .u8(15)
    .i32(entity.id)
    .i32(entity.classId)
    .i32(0)
    .i32(~name.length)
    .i32(entity.name.length)
    .take(name)
    .u8(entity.kind)
    .u8(0)
    .u8(0)
    .i32(entity.x)
    .i32(entity.y)
    .u8(entity.level)
    .i32(entity.hp)
    .i32(entity.maxHp)
    .i32(entity.sp ?? 0)
    .i32(entity.maxSp ?? 0)
    .i32(0)
    .u8(0)
    .finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
const joined = () =>
  new BitWriter()
    .u8(101)
    .u8(0)
    .i32(5)
    .string('Party')
    .u8(0)
    .i32(1)
    .i32(7)
    .i32(2)
    .i16(20)
    .string('Member')
    .u8(0)
    .string(map)
    .i32(40)
    .i32(100)
    .i32(30)
    .i32(100)
    .finish();
const affiliation = () =>
  new BitWriter().u8(OP.partyAffiliation).i32(2).u8(1).i32(5).string('Party').bool(false).finish();
const cast = (id: number, skillId = 42, level = 1, target = id, seconds = 10) =>
  new BitWriter()
    .u8(FEATURE_OP.castStart)
    .i32(id)
    .i32(target)
    .u8(skillId)
    .u8(level)
    .u8(6)
    .position(own)
    .f32(seconds)
    .u8(0)
    .finish();
const execution = (id: number, skillId = 41, level = 1, target = 2, heal = true) =>
  new BitWriter()
    .u8(FEATURE_OP.skill)
    .u8(1)
    .i32(id)
    .i32(-1)
    .i32(target)
    .u8(skillId)
    .u8(level)
    .u8(0)
    .position(own)
    .i32(heal ? -20 : 0)
    .u8(heal ? 2 : 0)
    .u8(heal ? 0 : 1)
    .f32(0)
    .f32(0)
    .bool(false)
    .finish();
const walk = (id: number) =>
  new BitWriter()
    .u8(OP.walk)
    .i32(id)
    .position(own)
    .f32(10)
    .f32(10)
    .f32(0.1)
    .f32(0.1)
    .u8(2)
    .u8(0x60)
    .u8(0)
    .finish();
const look = (id: number, head = 1) =>
  new BitWriter().u8(OP.look).i32(id).i16(-1).i16(5000).u8(6).u8(head).finish();
function fixture(id = 0) {
  let at = 100_000;
  const sent: Array<Action | WorldAction> = [];
  const c = new CompanionController(
    (action) => sent.push(action),
    () => at,
    () => ({ width: 40, height: 40, walkable: () => true }),
  );
  c.connect(true);
  c.receive(new BitWriter().u8(OP.enter).i32(id).string(map).finish());
  c.receive(spawn({ ...own, id }, 1));
  c.receive(spawn(ally));
  c.receive(affiliation());
  c.receive(joined());
  c.engine.receive([
    { type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 },
    { type: 'skills', learned: [{ skillId: 41, level: 10 }] },
  ]);
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.combat.mode = 'off';
  automation.partyHeal = { ...DEFAULT_PARTY_HEAL, enabled: true, cooldownSeconds: 1 };
  const settings = { ...DEFAULT_SETTINGS, map, targets: [], loot: false, automation };
  const step = (ms = 100) => {
    at += ms;
    c.tick();
  };
  const advance = (ms: number) => {
    while (ms > 0) {
      const n = Math.min(100, ms);
      step(n);
      ms -= n;
    }
  };
  const sp = () => c.receive(new BitWriter().u8(FEATURE_OP.sp).i32(87).i32(100).finish());
  const hp = () =>
    c.receive(new BitWriter().u8(102).u8(8).i32(7).i32(40).i32(100).i32(30).i32(100).finish());
  const heals = () => sent.filter((action) => action.type === 'skill' && action.skillId === 41);
  return { c, sent, settings, step, advance, sp, hp, heals };
}
const shapes = [
  { skillId: 42, level: 1, self: true },
  { skillId: 43, level: 1 },
  { skillId: 43, level: 3 },
  { skillId: 96, level: 3 },
  { skillId: 96, level: 5 },
  { skillId: 96, level: 10 },
];
describe('party Heal with shared cast availability', () => {
  it.each(shapes.flatMap((shape) => [0, 1].map((id) => ({ ...shape, id }))))(
    'holds proc-ambiguous $skillId/$level for own$id and heals only after accepted own walking settles',
    (shape) => {
      const f = fixture(shape.id);
      f.c.start(f.settings);
      f.c.receive(cast(shape.id, shape.skillId, shape.level, shape.self ? shape.id : 2));
      f.c.receive(
        execution(shape.id, shape.skillId, shape.level, shape.self ? shape.id : 2, false),
      );
      f.step(500);
      expect(f.c.engine.observedOwnCastSettled()).toBe(false);
      expect(f.heals()).toEqual([]);
      f.c.receive(walk(shape.id === 0 ? 1 : 0));
      expect(f.c.engine.observedOwnCastSettled()).toBe(false);
      f.c.receive(walk(shape.id));
      expect(f.c.engine.observedOwnCastSettled()).toBe(true);
      f.step(50);
      expect(f.heals()).toEqual([]);
      f.step(150);
      expect(f.heals()).toHaveLength(1);
      expect(f.c.snapshot()).toMatchObject({
        runRequested: true,
        partyHeal: { attempts: 1, confirmed: 0 },
      });
    },
  );
  it.each([0, 1])('uses accepted own%s Walk rather than an old still-casting predicate', (id) => {
    const f = fixture(id);
    f.c.start(f.settings);
    f.c.receive(cast(id, 11, 1, 2));
    f.step();
    f.c.receive(walk(id));
    f.step(200);
    expect(f.heals()).toHaveLength(1);
  });
  it.each([0, 1])(
    'uses eligible own%s Look and waits its shared input cooldown before Heal',
    (id) => {
      const f = fixture(id);
      f.c.start(f.settings);
      f.c.receive(cast(id));
      f.c.receive(look(id, 0));
      f.step();
      expect(f.heals()).toEqual([]);
      f.c.receive(look(id));
      expect(f.c.engine.observedOwnCastSettled()).toBe(false);
      f.step(199);
      expect(f.heals()).toEqual([]);
      f.step(1);
      expect(f.heals()).toHaveLength(1);
    },
  );
  it.each([0, 1])(
    'uses only current own%s CounterAttack completion as shared availability',
    (id) => {
      const f = fixture(id);
      f.c.start(f.settings);
      f.c.receive(cast(id, 31));
      f.c.receive(
        new BitWriter()
          .u8(FEATURE_OP.resetMotion)
          .i32(id === 0 ? 1 : 0)
          .finish(),
      );
      f.step();
      expect(f.heals()).toEqual([]);
      f.c.receive(new BitWriter().u8(FEATURE_OP.resetMotion).i32(id).finish());
      f.step();
      expect(f.heals()).toHaveLength(1);
    },
  );
  it.each(['Look', 'Walk', 'CounterAttack', 'StopCast'] as const)(
    'never uses %s to confirm a canceled Heal or its later SP debt',
    (availability) => {
      const f = fixture();
      f.c.start(f.settings);
      f.step();
      f.c.stop();
      f.c.receive(
        cast(
          0,
          availability === 'CounterAttack' ? 31 : 41,
          1,
          availability === 'CounterAttack' ? 0 : 2,
        ),
      );
      if (availability === 'Look') f.c.receive(look(0));
      else if (availability === 'Walk') f.c.receive(walk(0));
      else
        f.c.receive(
          new BitWriter()
            .u8(availability === 'CounterAttack' ? FEATURE_OP.resetMotion : FEATURE_OP.castStop)
            .i32(0)
            .finish(),
        );
      f.advance(1000);
      f.sp();
      expect(f.c.partyHeal.busy).toBe(true);
      expect(f.c.snapshot().partyHeal).toMatchObject({ attempts: 1, confirmed: 0 });
      expect(f.c.settledForMaintenance()).toBe(false);
      expect(() => f.c.start(f.settings)).toThrow('previous party Heal');
      f.c.receive(execution(0));
      f.advance(1000);
      expect(f.c.partyHeal.busy).toBe(false);
      f.c.start(f.settings);
      f.step();
      expect(f.heals()).toHaveLength(1);
      expect(f.c.partyHeal.awaitingSpReadback).toBe(true);
      f.sp();
      f.hp();
      f.step();
      expect(f.heals()).toHaveLength(2);
    },
  );
  it.each([0, 1])(
    'drains all six possibly sent Looks before own%s Heal even after StopCast',
    (id) => {
      const f = fixture(id);
      f.c.start(f.settings);
      f.c.receive(cast(id, 42, 1, id, 1));
      f.advance(6300);
      expect(f.sent.filter((action) => action.type === 'look')).toHaveLength(6);
      f.c.receive(new BitWriter().u8(FEATURE_OP.castStop).i32(id).finish());
      expect(f.c.engine.observedOwnCastSettled()).toBe(false);
      f.advance(799);
      expect(f.heals()).toEqual([]);
      f.step(1);
      expect(f.heals()).toHaveLength(1);
      expect(f.c.runRequested).toBe(true);
    },
  );
});

const followOwn: Entity = { ...own, x: 170, y: 370 };
const followLeader: Entity = { ...ally, name: 'Leader', x: 174, y: 370 };
function followFixture(id: number) {
  let at = 100_000;
  const sent: Array<Action | WorldAction> = [];
  const c = new CompanionController(
    (action) => sent.push(action),
    () => at,
  );
  c.connect(true);
  c.receive(new BitWriter().u8(OP.enter).i32(id).string(map).finish());
  c.receive(spawn({ ...followOwn, id }, 1));
  c.receive(spawn(followLeader));
  c.receive(
    new BitWriter().u8(OP.partyAffiliation).i32(2).u8(1).i32(5).string('Party').bool(true).finish(),
  );
  const roster = new BitWriter().u8(101).u8(0).i32(5).string('Party').u8(0).i32(2);
  roster.i32(7).i32(2).i16(20).string('Leader').u8(1).string(map).i32(40).i32(100).i32(30).i32(100);
  roster.i32(8).i32(3).i16(20).string('Member').u8(0).string(map).i32(40).i32(100).i32(30).i32(100);
  c.receive(spawn({ ...ally, id: 3, x: 171, y: 370 }));
  c.receive(
    new BitWriter()
      .u8(OP.partyAffiliation)
      .i32(3)
      .u8(1)
      .i32(5)
      .string('Party')
      .bool(false)
      .finish(),
  );
  c.receive(roster.finish());
  c.engine.receive([
    { type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 },
    { type: 'skills', learned: [{ skillId: 41, level: 10 }] },
  ]);
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.combat.mode = 'off';
  automation.partyHeal = { ...DEFAULT_PARTY_HEAL, enabled: true, cooldownSeconds: 1 };
  automation.follow = {
    ...automation.follow,
    mode: 'partyLeader',
    rendezvous: true,
    lostSeconds: 20,
  };
  const settings = { ...DEFAULT_SETTINGS, map, targets: [], loot: false, automation };
  const step = (ms = 100) => {
    at += ms;
    c.tick();
  };
  const advance = (ms: number) => {
    while (ms > 0) {
      const n = Math.min(100, ms);
      step(n);
      ms -= n;
    }
  };
  const depart = () => c.receive(new BitWriter().u8(102).u8(9).i32(7).string('prontera').finish());
  const arrive = () => {
    c.receive(new BitWriter().u8(OP.map).string('prontera').finish());
    c.receive(spawn({ ...followOwn, id, x: 156, y: 26 }, 1));
  };
  const leaderArrival = () => {
    c.receive(spawn({ ...followLeader, x: 158, y: 26 }));
    c.receive(
      new BitWriter()
        .u8(OP.partyAffiliation)
        .i32(2)
        .u8(1)
        .i32(5)
        .string('Party')
        .bool(true)
        .finish(),
    );
  };
  const leaderHp = (hp: number) =>
    c.receive(new BitWriter().u8(102).u8(8).i32(7).i32(hp).i32(100).i32(30).i32(100).finish());
  const heals = () => sent.filter((action) => action.type === 'skill' && action.skillId === 41);
  return { c, sent, settings, step, advance, depart, arrive, leaderArrival, leaderHp, heals };
}
describe('party Heal with rendezvous ownership', () => {
  it.each([0, 1])(
    'keeps Heal behind own%s preparation, travelling and leader reacquisition',
    (id) => {
      const f = followFixture(id);
      f.c.start(f.settings);
      expect(f.c.world.partyActors.get(partyMemberId(8))).not.toBeNull();
      f.c.receive(
        new BitWriter()
          .u8(FEATURE_OP.castStart)
          .i32(id)
          .i32(id)
          .u8(11)
          .u8(1)
          .u8(6)
          .position(followOwn)
          .f32(10)
          .u8(0)
          .finish(),
      );
      f.depart();
      expect(f.c.snapshot().partyFollow).toMatchObject({ state: 'preparing', ownsTravel: true });
      expect(f.heals()).toEqual([]);
      expect(f.c.snapshot().partyHeal?.attempts).toBe(0);
      f.c.receive(new BitWriter().u8(FEATURE_OP.castStop).i32(id).finish());
      f.step();
      expect(f.c.snapshot().partyFollow).toMatchObject({ state: 'travelling', ownsTravel: true });
      expect(f.sent.some((action) => action.type === 'walk')).toBe(true);
      expect(f.heals()).toEqual([]);
      f.arrive();
      expect(f.c.snapshot().partyFollow).toMatchObject({
        state: 'awaitingLeader',
        ownsTravel: true,
      });
      f.step(500);
      expect(f.heals()).toEqual([]);
      expect(f.c.snapshot().partyHeal?.attempts).toBe(0);
      expect(f.c.runRequested).toBe(true);
    },
  );
  it.each([0, 1])('keeps canceled own%s rendezvous movement held before a new Heal run', (id) => {
    const f = followFixture(id);
    f.c.start(f.settings);
    f.depart();
    f.c.stop();
    f.advance(1200);
    expect(f.c.travel.movementSettled(map, f.c.engine.player)).toBe(false);
    const settings = {
      ...f.settings,
      automation: {
        ...f.settings.automation,
        follow: { ...f.settings.automation.follow, mode: 'name' as const, rendezvous: false },
      },
    };
    expect(() => f.c.start(settings)).toThrow('movement');
    expect(f.c.snapshot().partyHeal?.attempts).toBe(0);
    expect(f.heals()).toEqual([]);
    expect(f.c.settledForMaintenance()).toBe(false);
    f.arrive();
    expect(f.c.travel.movementSettled('prontera', f.c.engine.player)).toBe(true);
    expect(f.c.runRequested).toBe(false);
    expect(f.heals()).toEqual([]);
  });
  it.each([0, 1])(
    'does not use detached own%s leader arrival or partial HP to grant Heal',
    (id) => {
      const f = followFixture(id);
      f.c.start(f.settings);
      f.depart();
      f.arrive();
      f.leaderArrival();
      expect(f.c.snapshot().partyFollow.state).toBe('following');
      expect(f.c.engine.running).toBe(true);
      expect(f.c.world.partyActors.get(partyMemberId(7))).toBeNull();
      f.step();
      expect(f.heals()).toEqual([]);
      f.leaderHp(0);
      expect(f.c.snapshot().partyFollow.state).toBe('waiting');
      f.leaderHp(40);
      expect(f.c.snapshot().partyFollow.state).toBe('following');
      expect(f.c.world.partyActors.get(partyMemberId(7))).toBeNull();
      expect(
        f.c.engine.observations.snapshot(null, 2, true, [], false).actors[0]?.sp,
      ).toBeUndefined();
      f.step();
      expect(f.heals()).toEqual([]);
      f.c.receive(
        new BitWriter()
          .u8(102)
          .u8(2)
          .i32(7)
          .i32(2)
          .i16(20)
          .string('Leader')
          .u8(1)
          .string('prontera')
          .i32(40)
          .i32(100)
          .i32(30)
          .i32(100)
          .finish(),
      );
      expect(f.c.world.partyActors.get(partyMemberId(7))).not.toBeNull();
      f.advance(1100);
      expect(f.heals()).toHaveLength(1);
      expect(f.heals()[0]).toMatchObject({ target: 2, skillId: 41 });
    },
  );
});

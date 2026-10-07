import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../shared/binary';
import { CompanionController } from '../runtime/controller';
import type { Action } from '../automation/engine';
import { OP, type Entity } from '../protocol/protocol';
import { FEATURE_OP } from '../protocol/protocol-feature';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_SETTINGS } from '../settings/settings';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy';
import type { WorldAction } from '../protocol/world-protocol';

const own: Entity = {
  id: 1,
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
function spawn(entity: Entity, entryType = 0): Uint8Array {
  const name = new TextEncoder().encode(entity.name),
    body = new BitWriter()
      .u8(15)
      .i32(entity.id)
      .i32(entity.classId)
      .i32(0)
      .i32(~name.length)
      .i32(entity.name.length)
      .take(name)
      .u8(entity.kind)
      .u8(0)
      .u8(entity.dead ? 3 : 0)
      .i32(entity.x)
      .i32(entity.y)
      .u8(entity.level)
      .i32(entity.hp)
      .i32(entity.maxHp)
      .i32(200)
      .i32(200)
      .i32(0)
      .u8(0)
      .finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
const cast = (id: number, skillId = 42, level = 1, target = id, seconds = 1, facing = 6) =>
  new BitWriter()
    .u8(FEATURE_OP.castStart)
    .i32(id)
    .i32(target)
    .u8(skillId)
    .u8(level)
    .u8(facing)
    .position(own)
    .f32(seconds)
    .u8(0)
    .finish();
const result = (id: number, skillId = 42, level = 1, target = id) =>
  new BitWriter()
    .u8(FEATURE_OP.skill)
    .u8(2)
    .i32(id)
    .i32(-1)
    .i32(target)
    .u8(skillId)
    .u8(level)
    .u8(0)
    .position(own)
    .i32(0)
    .u8(0)
    .u8(1)
    .f32(0)
    .f32(0)
    .bool(false)
    .finish();
const look = (id: number, head = 1) =>
  new BitWriter().u8(13).i32(id).i16(-1).i16(5000).u8(6).u8(head).finish();
function fixture(id = 1, automatic = false, throwLook = false, initiallyDead = false) {
  let now = 100_000;
  const sent: Array<Action | WorldAction> = [],
    c = new CompanionController(
      (action) => {
        sent.push(action);
        if (throwLook && action.type === 'look') throw new Error('send then throw');
      },
      () => now,
      () => ({ width: 200, height: 200, walkable: () => true }),
    );
  c.connect(true);
  const packet = (data: Uint8Array) => c.receive(data);
  packet(new BitWriter().u8(OP.enter).i32(id).string('prt_fild08').finish());
  packet(spawn({ ...own, id, ...(initiallyDead ? { dead: true, hp: 0 } : {}) }, 1));
  packet(
    spawn({ ...own, id: 2, classId: 4000, name: 'Poring', kind: 1, x: 101, hp: 10, maxHp: 10 }),
  );
  c.engine.receive([
    {
      type: 'inventory',
      items: [
        { bagId: 501, itemId: 501, type: 1, count: 4 },
        { bagId: 601, itemId: 601, type: 1, count: 4 },
      ],
      equipment: Array(10).fill(0),
      ammoId: -1,
    },
    { type: 'stats', level: 15, hp: 100, maxHp: 100, sp: 200, maxSp: 200 },
    { type: 'skills', learned: [{ skillId: 42, level: 1 }] },
  ]);
  const a = structuredClone(DEFAULT_AUTOMATION);
  a.loot.ownership = 'all';
  if (automatic)
    a.skills = [
      {
        skillId: 42,
        level: 1,
        target: 'self',
        hpBelowPercent: 100,
        spAbovePercent: 0,
        cooldownSeconds: 30,
      },
    ];
  const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], automation: a };
  const step = (ms = 100) => {
    now += ms;
    c.tick();
  };
  const advance = (ms: number) => {
    while (ms > 0) {
      const part = Math.min(100, ms);
      step(part);
      ms -= part;
    }
  };
  return {
    c,
    sent,
    packet,
    settings,
    start: () => c.start(settings),
    step,
    advance,
    time: () => now,
  };
}
describe('stationary cast availability through the real controller', () => {
  it.each([0, 1])(
    'retains intervening NPC/vending and rejects foreign or partial dead initialization for own%s',
    (id) => {
      for (const event of [
        new BitWriter().u8(105).string('shop').i32(1).i32(501).i32(1).i32(1).finish(),
        new BitWriter().u8(77).u8(0).i32(7).bool(true).finish(),
      ]) {
        const sent: Array<Action | WorldAction> = [],
          c = new CompanionController(
            (a) => sent.push(a),
            () => 100_000,
            () => ({ width: 200, height: 200, walkable: () => true }),
          );
        c.connect(true);
        c.receive(new BitWriter().u8(OP.enter).i32(id).string('prt_fild08').finish());
        c.receive(spawn({ ...own, id: 9, dead: true, hp: 0 }, 1));
        c.receive(spawn({ ...own, id, dead: true, hp: 0 }, 2));
        expect(c.engine.castAvailability.nonVending).toBe(false);
        c.receive(event);
        c.receive(spawn({ ...own, id, dead: true, hp: 0 }, 1));
        expect(c.engine.castAvailability.nonVending).toBe(false);
        c.receive(Uint8Array.of(77, 3));
        expect(c.engine.castAvailability.nonVending).toBe(true);
        expect(sent.filter((a) => a.type === 'look')).toHaveLength(0);
      }
    },
  );
  it.each([0, 1])(
    'keeps dead-login own%s baseline through one revival and recovers only the original living run',
    (id) => {
      const f = fixture(id, false, false, true);
      expect(f.c.engine.castAvailability.nonVending).toBe(true);
      f.settings.automation.respawn = { enabled: true, maxDeaths: 1 };
      f.settings.automation.recovery.enabled = false;
      f.start();
      f.c.engine.deaths = 1;
      f.c.engine.kills = 7;
      f.packet(cast(id));
      f.advance(2300);
      expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(0);
      expect(f.sent.filter((a) => a.type === 'respawn')).toHaveLength(1);
      f.packet(Uint8Array.of(OP.clear));
      f.packet(spawn({ ...own, id }, 2));
      f.packet(cast(id));
      f.packet(
        spawn({ ...own, id: 2, classId: 4000, name: 'Poring', kind: 1, x: 101, hp: 10, maxHp: 10 }),
      );
      f.advance(1300);
      expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
      f.packet(look(id));
      f.advance(300);
      expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
      expect(f.c.snapshot()).toMatchObject({ runRequested: true, deaths: 1, kills: 7 });
      f.packet(new BitWriter().u8(OP.death).i32(id).finish());
      f.advance(2300);
      expect(f.c.engine.deaths).toBe(2);
      expect(f.sent.filter((a) => a.type === 'respawn')).toHaveLength(1);
      expect(f.c.snapshot().reason).toContain('Death limit reached');
    },
  );
  it.each([0, 1])(
    'drains six possibly sent Looks before field dispatch after own%s StopCast without a Look reply',
    (id) => {
      const f = fixture(id);
      f.start();
      f.c.engine.deaths = 1;
      f.c.engine.kills = 7;
      f.packet(cast(id));
      f.advance(6300);
      expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
      const before = f.sent.length;
      f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(id).finish());
      expect(f.c.engine.observedCast).toBeNull();
      expect(f.c.engine.observedOwnCastSettled()).toBe(false);
      expect(f.sent.slice(before)).toEqual([]);
      f.advance(799);
      expect(f.sent.slice(before)).toEqual([]);
      f.step(1);
      expect(f.sent.slice(before)).toEqual([{ type: 'attack', id: 2 }]);
      expect(f.c.snapshot()).toMatchObject({ runRequested: true, deaths: 1, kills: 7 });
    },
  );
  it.each([0, 1])(
    'retains six-Look input debt across own%s clear/entry2 before one actual resource dispatch',
    (id) => {
      const f = fixture(id);
      f.settings.automation.items = [
        { itemId: 501, resource: 'hp', belowPercent: 90, minStock: 0, cooldownSeconds: 10 },
      ];
      f.start();
      f.c.engine.deaths = 1;
      f.c.engine.kills = 7;
      f.packet(cast(id));
      f.advance(6300);
      const before = f.sent.length;
      f.packet(Uint8Array.of(OP.clear));
      f.packet(spawn({ ...own, id, hp: 70 }, 2));
      f.step(100);
      expect(f.c.engine.observedCast).toBeNull();
      expect(f.sent.slice(before).some((a) => a.type === 'useItem')).toBe(false);
      expect(f.c.engine.actionResult.status).toBe('idle');
      f.advance(699);
      expect(f.sent.slice(before).some((a) => a.type === 'useItem')).toBe(false);
      f.advance(201);
      expect(f.sent.filter((a) => a.type === 'useItem')).toEqual([
        { type: 'useItem', itemId: 501 },
      ]);
      const sequence = f.c.engine.actionResult.sequence;
      expect(f.c.engine.actionResult).toMatchObject({ sequence, status: 'pending' });
      f.packet(
        new BitWriter()
          .u8(FEATURE_OP.inventoryDelta)
          .bool(false)
          .i32(501)
          .i16(1)
          .i32(0)
          .bool(false)
          .finish(),
      );
      expect(f.c.engine.actionResult).toMatchObject({ sequence, status: 'confirmed' });
      expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
      expect(f.c.snapshot()).toMatchObject({ runRequested: true, deaths: 1, kills: 7 });
    },
  );
  it.each([0, 1])('retains six-Look input debt across own%s replacement lifetime', (id) => {
    const f = fixture(id);
    f.start();
    f.packet(cast(id));
    f.advance(6300);
    const before = f.sent.length;
    f.packet(spawn({ ...own, id }, 0));
    expect(f.c.engine.observedCast).toBeNull();
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.advance(799);
    expect(f.sent.slice(before).some((a) => a.type === 'attack')).toBe(false);
    f.step(1);
    expect(f.sent.slice(before).some((a) => a.type === 'attack')).toBe(true);
    expect(f.c.runRequested).toBe(true);
  });
  it.each(
    [0, 1].flatMap((id) =>
      ['walk', 'counter', 'reliableCompletion'].map((terminal) => ({ id, terminal })),
    ),
  )('drains retired Look input after actual own$id $terminal availability', ({ id, terminal }) => {
    const f = fixture(id);
    f.start();
    f.packet(cast(id));
    f.advance(6300);
    const before = f.sent.length;
    if (terminal === 'walk')
      f.packet(
        new BitWriter()
          .u8(OP.walk)
          .i32(id)
          .position(own)
          .f32(100)
          .f32(100)
          .f32(0.1)
          .f32(0.1)
          .u8(2)
          .u8(0x60)
          .u8(0)
          .finish(),
      );
    else if (terminal === 'counter') {
      f.packet(cast(id, 31));
      f.packet(new BitWriter().u8(FEATURE_OP.resetMotion).i32(id).finish());
    } else {
      f.packet(cast(id, 11, 1, 2));
      f.packet(result(id, 11, 1, 2));
    }
    expect(f.c.engine.observedCast).toBeNull();
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.advance(799);
    expect(f.sent.slice(before).some((a) => a.type === 'attack')).toBe(false);
    f.step(1);
    expect(f.sent.slice(before).some((a) => a.type === 'attack')).toBe(true);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
  });
  it.each([0, 1])(
    'keeps retired input debt across own%s same-connection map entry and honors the original field restriction',
    (id) => {
      const f = fixture(id);
      f.settings.automation.mapPolicy = { ...DEFAULT_MAP_POLICY, allow: ['prt_fild08'] };
      f.start();
      f.packet(cast(id));
      f.advance(6300);
      const before = f.sent.length;
      f.packet(new BitWriter().u8(OP.map).string('prontera').finish());
      f.packet(spawn({ ...own, id }, 1));
      expect(f.c.engine.observedCast).toBeNull();
      expect(f.c.engine.observedOwnCastSettled()).toBe(false);
      f.advance(800);
      expect(f.c.engine.observedOwnCastSettled()).toBe(true);
      expect(
        f.sent
          .slice(before)
          .some((a) => a.type === 'attack' || a.type === 'useItem' || a.type === 'walk'),
      ).toBe(false);
      expect(f.c.runRequested).toBe(true);
      expect(f.c.snapshot().reason).toContain('allowed');
    },
  );
  it('drains a send-then-throw probe before a later own StopCast admits any attack', () => {
    const f = fixture(1, false, true);
    f.start();
    f.packet(cast(1));
    f.advance(1300);
    const before = f.sent.length;
    f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());
    f.advance(299);
    expect(f.sent.slice(before)).toEqual([]);
    f.step(1);
    expect(f.sent.slice(before)).toEqual([{ type: 'attack', id: 2 }]);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
  });
  it('keeps Stop intent canceled through a generic cast retirement and its input drain', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(6300);
    f.c.stop();
    f.packet(new BitWriter().u8(FEATURE_OP.castStop).i32(1).finish());
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.advance(800);
    expect(f.c.engine.observedOwnCastSettled()).toBe(true);
    expect(f.c.runRequested).toBe(false);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
  });
  it('does not renew the probe window or clear the fence when the cast is extended', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(1200);
    f.packet(new BitWriter().u8(FEATURE_OP.castExtend).i32(1).f32(60).finish());
    f.advance(11_000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    expect(f.c.engine.observedCast).not.toBeNull();
    expect(f.c.snapshot().reason).toContain('exhausted');
  });
  it('keeps original run counters and its absolute minute limit while availability waits', () => {
    const f = fixture();
    f.settings.automation.limits.minutes = 1;
    f.start();
    f.c.engine.deaths = 1;
    f.c.engine.kills = 7;
    f.packet(cast(1));
    for (let n = 0; n < 65; n++) {
      f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(200).i32(200).finish());
      f.advance(1000);
    }
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
    expect(f.c.snapshot()).toMatchObject({
      runRequested: true,
      deaths: 1,
      kills: 7,
      elapsedSeconds: 65,
    });
    expect(f.c.snapshot().reason).toContain('Configured session limit reached');
    f.packet(look(1));
    f.advance(800);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    expect(f.c.engine.deaths).toBe(1);
  });
  it('retains the bounded availability recovery through official input', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(1300);
    f.c.manualCommand();
    f.advance(3000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(4);
    expect(f.c.engine.observedCast).not.toBeNull();
    expect(f.c.runRequested).toBe(true);
  });
  it('waits through all possible Look input-delay additions before dispatching combat', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(6300);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
    f.packet(look(1));
    expect(f.c.engine.observedCast).toBeNull();
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.advance(799);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    f.step(1);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
  });
  it('keeps the cast held and reports bounded exhaustion when the server silently rejects every query', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(12_000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    expect(f.c.snapshot().reason).toContain('exhausted');
    expect(f.c.runRequested).toBe(true);
    f.packet(look(1));
    f.advance(800);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
  });
  it('counts a possible send that throws once and retains uncertainty without replay', () => {
    const f = fixture(1, false, true);
    f.start();
    f.packet(cast(1));
    f.advance(4000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    expect(f.c.snapshot().reason).toContain('uncertain');
    f.packet(look(1));
    f.advance(300);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
  });
  it('treats an independently accepted own manual/earlier Look as availability without a private query match', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.packet(look(1, 0));
    expect(f.c.engine.observedCast).not.toBeNull();
    f.packet(look(1, 2));
    expect(f.c.engine.observedCast).toBeNull();
    f.advance(200);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
    expect(f.sent.some((a) => a.type === 'look')).toBe(false);
  });
  it('applies older Look before a newer CastStart and does not clear the newer fence', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.packet(look(1));
    f.packet(cast(1, 43, 3, 2));
    expect(f.c.engine.observedCast).toMatchObject({ revision: 2 });
    f.advance(1300);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    f.packet(look(1));
    f.advance(300);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
  });
  it('continues bounded availability recovery during repeated panel input without renewing its deadline', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    for (let n = 0; n < 12; n++) {
      f.c.manualInput();
      f.advance(1000);
    }
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
    f.advance(2000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(6);
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    expect(f.c.runRequested).toBe(true);
    expect(f.c.snapshot().reason).toContain('exhausted');
  });
  it('keeps bounded automatic recovery through official Look until its ordered reply settles availability', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(1300);
    f.c.officialLook();
    f.advance(2000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(3);
    f.packet(look(1));
    f.advance(800);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
    expect(f.c.runRequested).toBe(true);
  });
  it('never resumes a stopped run when late availability arrives', () => {
    const f = fixture();
    f.start();
    f.packet(cast(1));
    f.advance(1300);
    f.c.stop();
    f.packet(look(1));
    f.advance(2000);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    expect(f.c.runRequested).toBe(false);
    expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  });
  it('ignores old-socket Look after own ID reuse and does not arm automatic queries on reconnect', () => {
    const f = fixture(),
      old = f.c.connectionGeneration;
    f.start();
    f.packet(cast(1));
    f.advance(1300);
    f.c.disconnect();
    f.c.connect(true);
    f.packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish());
    f.packet(spawn(own, 1));
    f.packet(cast(1));
    f.c.receive(look(1), old);
    f.advance(4000);
    expect(f.c.engine.observedCast).not.toBeNull();
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
  });
  it('keeps a pending resource receipt unchanged while recovering only availability', () => {
    const f = fixture();
    f.settings.automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 30 },
    ];
    f.start();
    f.step();
    f.c.manualCommand();
    const sequence = f.c.engine.actionResult.sequence;
    f.packet(cast(1));
    f.advance(2300);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(2);
    f.packet(look(1));
    f.advance(300);
    expect(f.c.engine.observedCast).toBeNull();
    expect(f.c.engine.actionResult).toMatchObject({ sequence, status: 'pending' });
    expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    f.packet(
      new BitWriter()
        .u8(FEATURE_OP.inventoryDelta)
        .bool(false)
        .i32(501)
        .i16(1)
        .i32(0)
        .bool(false)
        .finish(),
    );
    f.advance(1000);
    expect(f.c.engine.actionResult.status).toBe('confirmed');
    expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
  });
  it('retains canceled resource uncertainty after positive availability instead of replaying or restarting', () => {
    const f = fixture();
    f.settings.automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 30 },
    ];
    f.start();
    f.step();
    f.c.manualCommand();
    const sequence = f.c.engine.actionResult.sequence;
    f.packet(cast(1));
    f.advance(7000);
    expect(f.c.engine.actionResult).toMatchObject({ sequence, status: 'failed' });
    f.packet(look(1));
    f.advance(1000);
    expect(f.c.engine.observedCast).toBeNull();
    expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
    expect(f.c.snapshot().reason).toContain('confirmed result');
    expect(f.c.runRequested).toBe(true);
  });
  it('preserves vending authority across field clear/reset and accepts only the authoritative NPC exit', () => {
    const f = fixture();
    f.start();
    f.packet(new BitWriter().u8(105).string('shop').i32(1).i32(501).i32(1).i32(1).finish());
    f.packet(Uint8Array.of(OP.clear));
    f.packet(spawn(own, 2));
    f.packet(cast(1));
    f.packet(look(1));
    f.advance(1300);
    expect(f.c.world.vending).toBeNull();
    expect(f.c.engine.observedCast).not.toBeNull();
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(0);
    f.packet(Uint8Array.of(106));
    f.packet(look(1));
    expect(f.c.engine.observedCast).not.toBeNull();
    f.packet(Uint8Array.of(77, 3));
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
    f.packet(look(1));
    f.advance(300);
    expect(f.c.engine.observedOwnCastSettled()).toBe(true);
  });
  it.each([0, 1])(
    'recovers an unsent threat-only escape preparation without an early-return cycle for own%s',
    (id) => {
      const f = fixture(id);
      f.settings.automation.escape = {
        ...DEFAULT_ESCAPE,
        enabled: true,
        hpEnabled: false,
        threatEnabled: true,
        threatCount: 1,
        threatWindowSeconds: 10,
      };
      f.start();
      f.packet(cast(id));
      f.packet(
        new BitWriter().u8(OP.attack).i32(2).i32(id).u8(0).u8(0).u8(1).u8(0).position(own).finish(),
      );
      f.advance(1300);
      expect(f.c.snapshot().escape).toMatchObject({
        state: 'preparing',
        pending: true,
        latched: false,
      });
      expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
      f.packet(look(id));
      f.advance(300);
      expect(f.sent.filter((a) => a.type === 'useItem')).toEqual([
        { type: 'useItem', itemId: 601 },
      ]);
      f.advance(3000);
      expect(f.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
    },
  );
  it.each([0, 1])('retains the one-death limit after recovery queries and own%s death', (id) => {
    const f = fixture(id);
    f.settings.automation.respawn = { enabled: true, maxDeaths: 1 };
    f.settings.automation.recovery.enabled = false;
    f.settings.automation.escape = {
      ...DEFAULT_ESCAPE,
      enabled: true,
      hpEnabled: false,
      threatEnabled: true,
      threatCount: 1,
      threatWindowSeconds: 60,
    };
    f.start();
    f.packet(cast(id));
    f.packet(
      new BitWriter().u8(OP.attack).i32(2).i32(id).u8(0).u8(0).u8(1).u8(0).position(own).finish(),
    );
    f.advance(1300);
    f.packet(new BitWriter().u8(OP.death).i32(id).finish());
    f.advance(2300);
    expect(f.sent.filter((a) => a.type === 'respawn')).toHaveLength(1);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
    f.packet(Uint8Array.of(OP.clear));
    f.packet(spawn({ ...own, id }, 2));
    f.advance(500);
    f.packet(new BitWriter().u8(OP.death).i32(id).finish());
    f.advance(2300);
    expect(f.c.engine.deaths).toBe(2);
    expect(f.sent.filter((a) => a.type === 'respawn')).toHaveLength(1);
    expect(f.c.snapshot().reason).toContain('Death limit reached');
    expect(f.c.runRequested).toBe(true);
  });
  it.each([0, 1])(
    'continues actual automatic Increase Agility into combat and pickup for own%s',
    (id) => {
      const f = fixture(id, true);
      f.start();
      f.step();
      expect(f.sent[0]).toEqual({ type: 'skill', mode: 'self', skillId: 42, level: 1 });
      f.packet(cast(id));
      f.packet(result(id));
      expect(f.c.engine.actionResult.status).toBe('confirmed');
      f.advance(1300);
      expect(f.sent.filter((a) => a.type === 'look')).toEqual([
        { type: 'look', direction: 6, head: 1 },
      ]);
      expect(f.sent.some((a) => a.type === 'attack')).toBe(false);
      f.packet(look(id));
      f.advance(400);
      expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
      expect(f.c.runRequested).toBe(true);
      f.packet(new BitWriter().u8(OP.remove).i32(2).u8(3).finish());
      f.packet(
        new BitWriter().u8(OP.drop).i32(9).f32(101).f32(100).i32(909).i16(1).bool(true).finish(),
      );
      f.advance(500);
      expect(f.sent.some((a) => a.type === 'pickup')).toBe(true);
    },
  );
  it.each(
    [
      { skillId: 42, level: 1, self: true },
      { skillId: 43, level: 1 },
      { skillId: 43, level: 3 },
      { skillId: 96, level: 3 },
      { skillId: 96, level: 5 },
      { skillId: 96, level: 10 },
    ].flatMap((shape) => [0, 1].map((id) => ({ ...shape, id }))),
  )('recovers $skillId/$level own$id without acknowledging an early proc', (shape) => {
    const f = fixture(shape.id);
    f.start();
    f.packet(cast(shape.id, shape.skillId, shape.level, shape.self ? shape.id : 2));
    f.packet(result(shape.id, shape.skillId, shape.level, shape.self ? shape.id : 2));
    f.advance(1300);
    expect(f.sent.filter((a) => a.type === 'look')).toHaveLength(1);
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.packet(look(shape.id === 0 ? 1 : 0));
    expect(f.c.engine.observedOwnCastSettled()).toBe(false);
    f.packet(look(shape.id));
    f.advance(400);
    expect(f.sent.some((a) => a.type === 'attack')).toBe(true);
  });
});

import { skillId as domainSkillId } from '../../shared/domain-values';
import { describe, it, expect } from 'vitest';
import requestCases from '../../data/actor-zero-request-cases.json';
import { actorId } from './actor-identity';
import { BitWriter } from '../../shared/binary';
import { decode, command, OP, type Entity, type GameEvent } from '../protocol/protocol';
import { validateExpandedAction, featureCommand, FEATURE_OP } from '../protocol/protocol-feature';
import { decodeWorld, worldCommand, validateWorldAction } from '../protocol/world-protocol';
import {
  ActorObservations,
  evaluateActorPredicate,
  validActorSnapshot,
  validActorConditions,
  type ActorPredicate,
} from './actor-observations';
import { CompanionController, type ControllerAction } from '../runtime/controller';
import { type Action } from '../automation/engine';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION, type Settings } from '../settings/settings';
import { worldActionBlockers } from '../services/workflows';
import { dispositionContextFromStatus } from '../services/disposition-ui';
import type { ManualSocialAction } from '../social/social-protocol';
import type { WalkGrid } from '../navigation/navigation';
import { DEFAULT_MAP_POLICY, insideLockArea } from '../navigation/map-policy';

const own: Entity = {
  id: 0,
  classId: 0,
  name: 'Synthetic',
  kind: 0,
  level: 7,
  hp: 100,
  maxHp: 100,
  sp: 200,
  maxSp: 200,
  x: 10,
  y: 10,
  dead: false,
  statuses: [],
};
const enemy: Entity = { ...own, id: 2, classId: 4000, kind: 1, name: 'Monster', x: 11 };
const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
// Source-shaped MemoryPack scalars, no private data or live allocator wrap.
function spawn(entity: Entity, entry = 0): Uint8Array {
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
    .u8(entity.dead ? 3 : 0)
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
  return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body).finish();
}
function setup(
  id = 0,
  ready = true,
  grid: WalkGrid = { width: 40, height: 40, walkable: () => true },
) {
  let now = 100_000;
  const sent: Array<Action | ControllerAction> = [],
    socialSent: ManualSocialAction[] = [];
  const c = new CompanionController(
    (a) => sent.push(a),
    () => now,
    () => grid,
    (a) => socialSent.push(a),
  );
  c.connect(true);
  const packet = (w: BitWriter | Uint8Array) => c.receive(w instanceof BitWriter ? w.finish() : w);
  if (ready) {
    packet(new BitWriter().u8(OP.enter).i32(id).string(settings.map));
    packet(spawn({ ...own, id }));
  }
  return {
    c,
    sent,
    socialSent,
    packet,
    step: (ms = 100) => {
      now += ms;
      c.tick();
    },
    events: (...events: GameEvent[]) => c.engine.receive(events),
  };
}
const execution = (source = 0, target = 2, level = 1) =>
  new BitWriter()
    .u8(FEATURE_OP.skill)
    .u8(1)
    .i32(source)
    .i32(source)
    .i32(target)
    .u8(11)
    .u8(level)
    .u8(0)
    .position({ x: 10, y: 10 })
    .i32(1)
    .u8(0)
    .u8(1)
    .f32(0)
    .f32(0)
    .bool(false);
function learned(s: ReturnType<typeof setup>) {
  s.events(
    { type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 },
    { type: 'skills', learned: [{ skillId: 11, level: 1 }] },
  );
}
function walking(id: number, cells: Array<{ x: number; y: number }>): BitWriter {
  const directions = [
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1],
  ];
  const w = new BitWriter()
    .u8(OP.walk)
    .i32(id)
    .position(cells[0]!)
    .f32(cells[0]!.x)
    .f32(cells[0]!.y)
    .f32(0.1)
    .f32(0.1)
    .u8(cells.length);
  for (let i = 1; i < cells.length; i += 2) {
    const a = directions.findIndex(
      ([x, y]) => cells[i]!.x - cells[i - 1]!.x === x && cells[i]!.y - cells[i - 1]!.y === y,
    );
    const b =
      i + 1 < cells.length
        ? directions.findIndex(
            ([x, y]) => cells[i + 1]!.x - cells[i]!.x === x && cells[i + 1]!.y - cells[i]!.y === y,
          )
        : 0;
    w.u8((a << 4) | b);
  }
  return w.u8(0);
}

describe('field-specific actor-zero wire contracts', () => {
  it('shares exact valid and invalid native request fixtures', () => {
    const validate = (v: unknown) => {
      try {
        return validateExpandedAction(v);
      } catch {
        return validateWorldAction(v);
      }
    };
    for (const action of requestCases.valid) expect(validate(action)).toEqual(action);
    for (const action of requestCases.invalid) expect(() => validate(action)).toThrow();
  });
  it('decodes literal zero enter, spawn and core lifecycle packets', () => {
    expect(decode(Uint8Array.of(3, 0, 0, 0, 0, 1, 0, 109))).toEqual([
      { type: 'enter', id: 0, map: 'm' },
    ]);
    for (const kind of [0, 1, 2])
      expect(decode(spawn({ ...own, kind }))[0]).toMatchObject({
        type: 'spawn',
        entity: { id: 0, kind },
      });
    const rows: Array<[number[], object]> = [
      [[15, 0, 0, 0, 0, 0], { type: 'remove', id: 0, reason: 0, dead: false }],
      [[19, 0, 0, 0, 0], { type: 'stop', id: 0 }],
      [[10, 0, 0, 0, 0, 10, 0, 11, 0], { type: 'position', id: 0, position: { x: 10, y: 11 } }],
      [[36, 0, 0, 0, 0], { type: 'death', id: 0 }],
      [
        [46, 0, 0, 0, 0, 10, 0, 11, 0, 50, 0, 0, 0],
        { type: 'resurrection', id: 0, hp: 50, position: { x: 10, y: 11 } },
      ],
      [[82, 0, 0, 0, 0, 1, 0, 0, 0], { type: 'pickup', picker: 0, id: 1 }],
    ];
    for (const [bytes, event] of rows) expect(decode(Uint8Array.from(bytes))).toEqual([event]);
    expect(
      decode(
        new BitWriter()
          .u8(OP.walk)
          .i32(0)
          .position({ x: 10, y: 10 })
          .f32(10)
          .f32(10)
          .f32(0.2)
          .f32(0.2)
          .u8(1)
          .u8(0)
          .finish(),
      )[0],
    ).toMatchObject({ type: 'walk', id: 0 });
    expect(
      decode(
        new BitWriter().u8(OP.attack).i32(-1).i32(0).i32(0).position({ x: 10, y: 10 }).finish(),
      )[0],
    ).toMatchObject({ source: -1, target: 0 });
  });
  it('decodes zero actor status, casts, direct results and targeted notifications', () => {
    for (const [bytes, type] of [
      [Uint8Array.of(14, 0, 0, 0, 0, 1), 'sit'],
      [Uint8Array.of(27, 0, 0, 0, 0), 'castStop'],
      [Uint8Array.of(43, 0, 0, 0, 0), 'targeted'],
    ] as const)
      expect(decode(bytes)[0]).toMatchObject({ type, id: 0 });
    expect(decode(new BitWriter().u8(61).i32(0).u8(1).f32(30).finish())[0]).toMatchObject({
      type: 'status',
      id: 0,
      statusId: 1,
    });
    expect(decode(new BitWriter().u8(62).i32(0).u8(1).bool(true).finish())[0]).toMatchObject({
      type: 'status',
      id: 0,
      refresh: true,
    });
    expect(
      decode(
        new BitWriter()
          .u8(24)
          .i32(0)
          .i32(0)
          .u8(11)
          .u8(1)
          .u8(0)
          .position({ x: 10, y: 10 })
          .f32(1)
          .u8(0)
          .finish(),
      )[0],
    ).toMatchObject({ type: 'castStart', id: 0, target: 0 });
    expect(decode(new BitWriter().u8(26).i32(0).f32(-0.5).finish())[0]).toMatchObject({
      type: 'castExtend',
      id: 0,
    });
    expect(decode(execution(0, 0).finish())[0]).toMatchObject({
      type: 'skillResult',
      source: 0,
      target: 0,
      attacker: 0,
    });
  });
  it('retains malformed actor and unrelated positive identifier bounds', () => {
    for (const id of [-1, NaN, Infinity, 0.5, 0x80000000, '0', null])
      expect(() => actorId(id)).toThrow();
    expect(() => decode(spawn({ ...own, id: -1 }))).toThrow();
    expect(() => decode(Uint8Array.of(27, 255, 255, 255, 255))).toThrow();
    expect(() => decode(Uint8Array.of(82, 0, 0, 0, 0, 0, 0, 0, 0))).toThrow('drop');
    for (const action of [
      { type: 'useItem', itemId: 0 },
      { type: 'equip', bagId: 0, equipped: true },
      { type: 'skill', mode: 'target', target: 0, skillId: 0, level: 1 },
      { type: 'allocateSkill', skillId: 0 },
    ])
      expect(() => validateExpandedAction(action)).toThrow();
    expect(() => command('pickup', 0)).toThrow();
  });
  it('round trips zero actor requests while party-create invite and nonactor IDs remain positive', () => {
    expect([...command('attack', 0)]).toEqual([11, 0, 0, 0, 0]);
    const skill = { type: 'skill', mode: 'target', skillId: 11, level: 1, target: 0 } as const;
    expect(validateExpandedAction(skill)).toEqual(skill);
    expect([...featureCommand(skill)]).toEqual([29, 1, 0, 0, 0, 0, 11, 1]);
    expect(validateExpandedAction({ type: 'useItem', itemId: 501, target: 0 })).toEqual({
      type: 'useItem',
      itemId: 501,
      target: 0,
    });
    for (const type of ['npcTalk', 'partyInviteId', 'vendingView'] as const)
      expect(validateWorldAction({ type, id: 0 })).toEqual({ type, id: 0 });
    expect([...worldCommand({ type: 'partyInviteId', id: 0 })]).toEqual([100, 0, 0, 0, 0, 0]);
    expect(() =>
      validateWorldAction({ type: 'partyCreate', name: 'Synthetic', inviteId: 0 }),
    ).toThrow();
    for (const action of [
      { type: 'partyAccept', partyId: 0 },
      { type: 'partyLeader', memberId: 0 },
      { type: 'storage', operation: 'deposit', bagId: 0, count: 1 },
    ])
      expect(() => validateWorldAction(action)).toThrow();
  });
  it('preserves zero NPC/vendor scalars and retires ambiguous party state on known own-zero removal', () => {
    expect(decodeWorld(Uint8Array.of(77, 0, 0, 0, 0, 0, 1))).toEqual([
      { type: 'npcFocus', id: 0, focus: true },
    ]);
    expect(decodeWorld(new BitWriter().u8(107).i32(0).string('Synthetic').i32(0).finish())).toEqual(
      [{ type: 'vendingViewed', id: 0, name: 'Synthetic', entries: [] }],
    );
    const s = setup();
    s.c.world.apply({
      type: 'partyJoined',
      partyId: 3,
      name: 'Synthetic',
      login: true,
      members: [{ memberId: 1, entityId: 0, name: 'Offline', level: -1, leader: true }],
    });
    expect(worldActionBlockers({ type: 'partyLeave' }, s.c.context()).join(' ')).toContain(
      'ambiguous',
    );
    // The official client clears the association for a removed EntityId matching own0; this never authorizes an offline-zero member.
    s.c.world.apply({ type: 'partyRemove', memberId: 1 }, 0);
    expect(s.c.world.party).toBeNull();
  });
});

describe('ready own identity and action lifetime fences', () => {
  it.each([0, 1])('keeps social echoes and repetition limits on the own %s lifetime', (id) => {
    const action = { type: 'chat', channel: 0, text: 'Synthetic lifetime test' } as const;
    const echo = (s: ReturnType<typeof setup>) =>
      s.packet(new BitWriter().u8(44).i32(id).string(action.text).string(own.name).u8(0));
    const unchanged = setup(id);
    unchanged.c.perform('social', action);
    echo(unchanged);
    expect(unchanged.c.social.snapshot().state).toBe('echo');
    for (const change of ['remove', 'replace', 'resurrect'] as const) {
      const s = setup(id);
      s.c.perform('social', action);
      const original = s.c.engine.actorActionIdentity();
      if (change === 'remove') s.packet(new BitWriter().u8(OP.remove).i32(id).u8(0));
      if (change === 'resurrect') {
        s.packet(new BitWriter().u8(OP.death).i32(id));
        s.packet(new BitWriter().u8(OP.resurrection).i32(id).position(own).i32(100));
      } else s.packet(spawn({ ...own, id }));
      expect(s.c.engine.actorActionIdentity()).not.toEqual(original);
      expect(s.c.social.busy).toBe(false);
      echo(s);
      expect(s.c.social.snapshot().state, change).toBe('unconfirmed');
      expect(s.socialSent).toEqual([action]);
      s.c.perform('social', action);
      echo(s);
      expect(s.c.social.snapshot().state).toBe('sent');
      expect(s.c.social.snapshot().reason).toContain('ambiguous');
    }
  });
  it('preserves emote cooldown when a same-name own zero lifetime is replaced', () => {
    const s = setup();
    s.events({ type: 'skills', learned: [{ skillId: 1, level: 1 }] });
    s.c.perform('social', { type: 'emote', id: 0 });
    s.packet(spawn(own));
    expect(() => s.c.perform('social', { type: 'emote', id: 1 })).toThrow('1.8 seconds');
    expect(s.socialSent).toHaveLength(1);
  });
  it.each([0, 2])(
    'cancels normal attack evidence on target %s replacement without accepting late acknowledgements',
    (id) => {
      const s = setup(id === 0 ? 1 : 0);
      s.packet(spawn({ ...enemy, id, x: 18 }));
      s.c.start({ ...settings, route_randomWalk: 0 });
      s.step();
      expect(s.sent).toContainEqual({ type: 'attack', id });
      s.packet(spawn({ ...enemy, id, classId: 4001, name: 'Unselected replacement', x: 18 }));
      expect(s.sent.at(-1)).toEqual({ type: 'stop' });
      expect(s.c.engine.snapshot().target).not.toContain('Unselected');
      s.packet(
        new BitWriter().u8(OP.attack).i32(s.c.engine.player!.id).i32(id).i32(1).position(own),
      );
      expect(s.c.engine.idleForActions()).toBe(false);
      s.packet(new BitWriter().u8(OP.death).i32(id));
      expect(s.c.engine.kills).toBe(0);
      expect(s.c.engine.attacks).toBe(1);
      expect(s.c.engine.running).toBe(true);
      s.step(4000);
      expect(s.c.engine.reason).toContain('Waiting for a reachable');
    },
  );
  it('requires a fresh eligible selection after target reuse and retains legitimate zero kill credit after a hit', () => {
    const s = setup(1);
    s.packet(spawn({ ...enemy, id: 0 }));
    s.c.start({ ...settings, route_randomWalk: 0 });
    s.step();
    s.packet(spawn({ ...enemy, id: 0 }));
    expect(s.c.engine.attacks).toBe(1);
    s.step(4000);
    expect(s.c.engine.attacks).toBe(2);
    s.events({ type: 'hit', id: 0, damage: 100, stops: false, position: enemy });
    s.packet(new BitWriter().u8(OP.death).i32(0));
    expect(s.c.engine.kills).toBe(1);
  });
  it.each(['target', 'self'] as const)(
    'cancels a normal walk on %s replacement and preserves the missing-acknowledgement fence',
    (replace) => {
      const s = setup(1, true, {
        width: 40,
        height: 40,
        walkable: (p) => p.x !== 14 || p.y === 14,
      });
      s.packet(spawn({ ...enemy, id: 0, x: 18 }));
      s.c.start({ ...settings, route_randomWalk: 0, route_avoidWalls: false });
      s.step();
      expect(s.sent.at(-1)?.type).toBe('walk');
      expect(s.c.engine.snapshot().navigation!.mode).toBe('attack');
      s.packet(
        spawn(replace === 'target' ? { ...enemy, id: 0, x: 18, classId: 4001 } : { ...own, id: 1 }),
      );
      expect(s.sent.at(-1)).toEqual({ type: 'stop' });
      expect(s.c.engine.snapshot().navigation!.leg).toEqual([]);
      s.packet(new BitWriter().u8(OP.attack).i32(1).i32(0).i32(1).position(own));
      s.step();
      expect(s.sent.filter((a) => a.type === 'walk')).toHaveLength(1);
      expect(s.c.engine.kills).toBe(0);
    },
  );
  it('clears normal kill ownership when the own zero lifetime is replaced', () => {
    const s = setup();
    s.packet(spawn(enemy));
    s.c.start({ ...settings, route_randomWalk: 0 });
    s.step();
    s.packet(spawn(own));
    s.packet(new BitWriter().u8(OP.death).i32(2));
    expect(s.c.engine.kills).toBe(0);
    expect(s.c.engine.attacks).toBe(1);
    expect(s.sent.at(-1)).toEqual({ type: 'stop' });
  });
  it('drops skill kill evidence when the target or own lifetime is replaced', () => {
    for (const replacing of ['target', 'self', 'none'] as const) {
      const s = setup();
      learned(s);
      s.packet(spawn(enemy));
      const automation = structuredClone(DEFAULT_AUTOMATION);
      automation.attackStrategies = [
        {
          id: 'open',
          speciesIds: [4000],
          skillId: 11,
          level: 1,
          behavior: 'opener',
          maxAttempts: 1,
          maxUses: 1,
          cooldownSeconds: 1,
        },
      ];
      s.c.start({ ...settings, route_randomWalk: 0, automation });
      s.step();
      expect(s.sent.at(-1)).toEqual({
        type: 'skill',
        mode: 'target',
        skillId: 11,
        level: 1,
        target: 2,
      });
      s.packet(execution());
      expect(s.c.engine.actionResult.status).toBe('confirmed');
      if (replacing !== 'none')
        s.packet(spawn(replacing === 'target' ? { ...enemy, classId: 4001 } : own));
      s.packet(new BitWriter().u8(OP.death).i32(2));
      expect(s.c.engine.kills, replacing).toBe(replacing === 'none' ? 1 : 0);
    }
  });
  it.each([false, true])(
    'drains a canceled vending receipt only on its captured own lifetime (replace=%s)',
    (replace) => {
      const s = setup();
      s.events(
        { type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 },
        { type: 'inventory', items: [], equipment: [], ammoId: -1 },
      );
      s.c.world.apply({
        type: 'vendingViewed',
        id: 99,
        name: 'Vendor',
        entries: [{ item: { bagId: 501, itemId: 501, type: 1, count: 5 }, price: 10 }],
      });
      s.c.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 1 }] });
      s.c.stop();
      s.step(10000);
      if (replace) {
        s.packet(new BitWriter().u8(OP.remove).i32(0).u8(0));
        s.packet(spawn(own));
      }
      s.events(
        {
          type: 'inventoryDelta',
          add: true,
          bagId: 501,
          change: 1,
          weight: 10,
          item: { bagId: 501, itemId: 501, type: 1, count: 1 },
        },
        { type: 'currency', zeny: 90 },
      );
      s.packet(Uint8Array.of(200));
      const sit = () => s.c.perform('command', { type: 'sit', sitting: false });
      if (replace) expect(sit).toThrow('wait');
      else expect(sit).not.toThrow();
    },
  );
  it.each([false, true])(
    'drains canceled NPC-end only on its captured NPC-zero lifetime (replace=%s)',
    (replace) => {
      const s = setup(1),
        npc = { ...own, id: 0, kind: 2, hp: 0, maxHp: 0 };
      s.packet(spawn(npc));
      s.c.perform('command', { type: 'npcTalk', id: 0 });
      s.c.stop();
      s.step(10000);
      if (replace) {
        s.packet(new BitWriter().u8(OP.remove).i32(0).u8(0));
        s.packet(spawn(npc));
      }
      s.packet(Uint8Array.of(77, 3));
      const talk = () => s.c.perform('command', { type: 'npcTalk', id: 0 });
      if (replace) expect(talk).toThrow('wait');
      else expect(talk).not.toThrow();
    },
  );
  it('never treats an actor-zero spawn before enter or a wrong kind as self', () => {
    const s = setup(0, false);
    s.packet(spawn(own));
    s.packet(execution());
    expect(s.c.engine.playerId).toBeNull();
    expect(s.c.engine.player).toBeUndefined();
    expect(s.c.context().playerId).toBeNull();
    expect(() => s.c.engine.manualAction({ type: 'sit', sitting: false })).toThrow();
    s.c.start(settings);
    expect(s.c.engine.running).toBe(false);
    expect(s.sent).toEqual([]);
    s.packet(new BitWriter().u8(OP.enter).i32(0).string(settings.map));
    s.packet(spawn({ ...own, kind: 1 }));
    expect(s.c.engine.player).toBeUndefined();
    expect(() => s.c.engine.manualAction({ type: 'sit', sitting: false })).toThrow();
    expect(s.sent).toEqual([]);
  });
  it('preserves post-enter initialization without allowing pre-spawn actions or receipts', () => {
    const s = setup(0, false);
    s.packet(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(200));
    expect(s.c.engine.character.stats).toBeNull();
    s.packet(new BitWriter().u8(OP.enter).i32(0).string(settings.map));
    const stats = new BitWriter().u8(FEATURE_OP.stats);
    for (const value of [7, 1, 50, 1, 1, 1, 1, 1, 1, 0, 0, 0]) stats.i32(value);
    for (const value of [100, 100, 100, 200, ...Array(17).fill(0)]) stats.i32(value);
    stats.f32(1).i32(0).i32(0).bool(false).bool(false);
    s.packet(stats);
    learned(s);
    expect(s.c.engine.character.stats).toMatchObject({ sp: 100, maxSp: 200, zeny: 50 });
    expect(s.c.engine.character.inventoryKnown).toBe(true);
    expect(s.c.engine.character.skillLevel(domainSkillId(11))).toBe(1);
    expect(s.c.engine.player).toBeUndefined();
    expect(() => s.c.engine.manualAction({ type: 'sit', sitting: false })).toThrow();
    s.packet(spawn(own));
    expect(s.c.engine.character.skillLevel(domainSkillId(11))).toBe(1);
    s.c.perform('command', { type: 'sit', sitting: false });
    s.packet(Uint8Array.of(14, 0, 0, 0, 0, 0));
    expect(s.c.engine.actionResult.status).toBe('confirmed');
  });
  it.each([0, 1])(
    'can attack with own ID %s and target zero without inferring ChangeTarget0',
    (id) => {
      const s = setup(id);
      s.packet(spawn({ ...enemy, id: id === 0 ? 2 : 0 }));
      s.c.start(settings);
      s.step();
      expect(s.sent).toContainEqual({ type: 'attack', id: id === 0 ? 2 : 0 });
      s.packet(Uint8Array.of(33, 0, 0, 0, 0));
      expect(s.c.engine.actorObservation().targetId).toBeNull();
      const snapshot = s.c.engine.actorObservation([], null, id === 0 ? 2 : 0);
      expect(snapshot.candidateId).toBe(id === 0 ? 2 : 0);
    },
  );
  it('confirms exact zero-source casts but rejects wrong source, level and reused target receipts', () => {
    const s = setup();
    learned(s);
    s.packet(spawn(enemy));
    s.c.perform('command', { type: 'skill', mode: 'target', skillId: 11, level: 1, target: 2 });
    s.packet(execution(2, 2));
    s.packet(execution(0, 2, 2));
    expect(s.c.engine.actionResult.status).toBe('pending');
    s.packet(execution());
    expect(s.c.engine.actionResult.status).toBe('confirmed');
    const t = setup(1);
    learned(t);
    t.packet(spawn({ ...enemy, id: 0 }));
    t.c.perform('command', { type: 'skill', mode: 'target', skillId: 11, level: 1, target: 0 });
    t.packet(Uint8Array.of(15, 0, 0, 0, 0, 0));
    t.packet(spawn({ ...enemy, id: 0 }));
    t.packet(execution(1, 0));
    expect(t.c.engine.actionResult.status).toBe('pending');
  });
  it('never rebinds pending or canceled cast receipts to a reused own zero lifetime', () => {
    const s = setup();
    learned(s);
    s.packet(spawn(enemy));
    s.c.perform('command', { type: 'skill', mode: 'target', skillId: 11, level: 1, target: 2 });
    const original = s.c.engine.pendingActionIdentity;
    s.packet(Uint8Array.of(15, 0, 0, 0, 0, 0));
    s.packet(spawn(own));
    expect(
      s.c.engine.actionIdentity({
        type: 'skill',
        mode: 'target',
        skillId: 11,
        level: 1,
        target: 2,
      }),
    ).not.toEqual(original);
    s.packet(execution());
    expect(s.c.engine.actionResult.status).not.toBe('confirmed');
  });
  it('requires fresh own spawn after clear, re-entry and socket replacement', () => {
    const s = setup();
    for (const reset of [
      () => s.packet(Uint8Array.of(16)),
      () => s.c.connect(true),
      () => s.packet(new BitWriter().u8(3).i32(0).string(settings.map)),
    ]) {
      reset();
      expect(s.c.engine.player).toBeUndefined();
      expect(() => s.c.engine.manualAction({ type: 'sit', sitting: false })).toThrow();
    }
    expect(s.sent).toEqual([]);
    s.c.disconnect();
    expect(s.c.engine.playerId).toBeNull();
  });
  it('fences an NPC-zero request across departure/reuse and clears cross-kind stale stores', () => {
    const s = setup(1);
    const npc = { ...own, id: 0, kind: 2, hp: 0, maxHp: 0, sp: 0, maxSp: 0 };
    s.packet(spawn(npc));
    expect(s.c.engine.actorActionIdentity(0)?.targetIncarnation).toBeGreaterThan(0);
    s.c.perform('command', { type: 'npcTalk', id: 0 });
    s.packet(Uint8Array.of(15, 0, 0, 0, 0, 0));
    s.packet(spawn(npc));
    s.packet(Uint8Array.of(77, 0, 0, 0, 0, 0, 1));
    expect(s.c.active).toBe(true);
    for (let n = 0; n < 100; n++) s.step(100);
    expect(s.c.engine.reason).toContain('not confirmed');
    const t = setup(1);
    t.packet(spawn(npc));
    t.packet(spawn({ ...enemy, id: 0 }));
    expect(t.c.context().visibleNpcIds).not.toContain(0);
    expect(() => t.c.perform('command', { type: 'npcTalk', id: 0 })).toThrow('visible NPC');
  });
  it('cancels an NPC-zero workflow when its observed lifetime changes before an acknowledgement', () => {
    const s = setup(1);
    s.packet(spawn({ ...own, id: 0, kind: 2, hp: 0, maxHp: 0, sp: 0, maxSp: 0 }));
    learned(s);
    s.events({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 });
    s.c.perform('workflow', {
      name: 'Synthetic',
      map: settings.map,
      npcId: 0,
      maxSpend: 0,
      minStock: [],
      steps: [{ type: 'talk' }, { type: 'advance' }],
    });
    s.step();
    expect(s.sent.at(-1)).toEqual({ type: 'npcTalk', id: 0 });
    s.packet(Uint8Array.of(15, 0, 0, 0, 0, 0));
    s.packet(spawn({ ...own, id: 0, kind: 2, hp: 0, maxHp: 0, sp: 0, maxSp: 0 }));
    s.packet(Uint8Array.of(77, 0, 0, 0, 0, 0, 1));
    expect(s.c.workflow.snapshot().state).toBe('cancelled');
    expect(s.sent.some((a) => a.type === 'npcAdvance')).toBe(false);
  });
  it('keeps canceled resource evidence bound to the old self lifetime', () => {
    const s = setup();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.mode = 'off';
    automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 1 },
    ];
    s.events(
      {
        type: 'inventory',
        items: [{ bagId: 501, itemId: 501, type: 1, count: 2 }],
        equipment: [],
        ammoId: -1,
      },
      { type: 'heal', id: 0, hp: 50, maxHp: 100 },
    );
    s.c.start({ ...settings, automation });
    s.step();
    expect(s.sent).toContainEqual({ type: 'useItem', itemId: 501 });
    s.packet(Uint8Array.of(15, 0, 0, 0, 0, 0));
    s.packet(spawn(own));
    s.events({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 0 });
    s.packet(new BitWriter().u8(FEATURE_OP.sp).i32(200).i32(200));
    expect(s.c.snapshot().reason).toContain('Waiting for a confirmed result');
    expect(s.sent.filter((a) => a.type === 'useItem')).toHaveLength(1);
  });
  it('confirms actor-zero same-map respawn only after the refreshed alive own spawn', () => {
    const s = setup();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.respawn.enabled = true;
    s.c.start({ ...settings, automation });
    s.packet(Uint8Array.of(36, 0, 0, 0, 0));
    s.step(2100);
    expect(s.sent.at(-1)).toEqual({ type: 'respawn' });
    s.packet(Uint8Array.of(16));
    s.packet(spawn(enemy));
    expect(s.c.engine.actionResult.status).toBe('pending');
    s.packet(spawn(own, 2));
    expect(s.c.engine.actionResult.status).toBe('confirmed');
  });
  it('permits observed NPC zero and requires independent observed-player evidence for a zero party invitation', () => {
    const s = setup(1);
    s.packet(spawn({ ...own, id: 0, kind: 2 }));
    s.c.perform('command', { type: 'npcTalk', id: 0 });
    expect(s.sent.at(-1)).toEqual({ type: 'npcTalk', id: 0 });
    const t = setup(1);
    t.c.world.apply({
      type: 'partyJoined',
      partyId: 3,
      name: 'Synthetic',
      login: true,
      members: [{ memberId: 1, entityId: 1, name: own.name, level: 7, leader: true }],
    });
    expect(
      worldActionBlockers({ type: 'partyInviteId', id: 0 }, t.c.context()).join(' '),
    ).toContain('currently observed player');
    t.packet(spawn(own));
    expect(worldActionBlockers({ type: 'partyInviteId', id: 0 }, t.c.context())).toEqual([]);
  });
});

describe('zero actor predicates and telemetry', () => {
  it('keeps self, explicit, candidate and independent target zero distinct from unknown', () => {
    const o = new ActorObservations(() => 1000);
    o.spawn(own);
    o.frame();
    o.apply({ type: 'castStop', id: 0 });
    const snap = o.snapshot(0, 0, true, [], true, 0);
    expect(validActorSnapshot(snap)).toBe(true);
    for (const actor of [
      { scope: 'self' },
      { scope: 'target' },
      { scope: 'candidate' },
      { scope: 'actor', id: 0, world: snap.world, incarnation: snap.actors[0]!.incarnation },
    ] as const) {
      const condition: ActorPredicate = {
        field: 'actorCasting',
        actor,
        operator: 'eq',
        value: false,
      };
      expect(validActorConditions([condition], true)).toBe(true);
      expect(evaluateActorPredicate(condition, snap).state).toBe('matched');
    }
    expect(
      evaluateActorPredicate(
        { field: 'actorCasting', actor: { scope: 'self' }, operator: 'eq', value: false },
        o.snapshot(null, null, true),
      ).state,
    ).toBe('unavailable');
  });
  it('preserves NPC zero in the read-only disposition adapter and leaves absent own identity null', () => {
    const status = { world: { npc: { id: 0, mode: 'dialog' } }, player: { id: 0, kind: 0 } };
    expect(dispositionContextFromStatus(status).workflow.world.npc.id).toBe(0);
    expect(dispositionContextFromStatus({}).workflow.playerId).toBeNull();
  });
});

describe('actor zero and field-area ownership integration', () => {
  it('reserves own zero observation through a full-table death and external resurrection before automatic recovery', () => {
    const s = setup(),
      automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.mode = 'off';
    automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 1 },
    ];
    s.events(
      ...Array.from(
        { length: 299 },
        (_, i) => ({ type: 'spawn', entity: { ...enemy, id: i + 1, classId: 4001 } }) as const,
      ),
      {
        type: 'inventory',
        items: [{ bagId: 501, itemId: 501, type: 1, count: 2 }],
        equipment: [],
        ammoId: -1,
      },
    );
    s.c.start({ ...settings, route_randomWalk: 0, automation });
    s.packet(new BitWriter().u8(OP.death).i32(0));
    s.packet(spawn({ ...enemy, id: 300, classId: 4001 }));
    expect(s.c.engine.observations.context(300).incarnation).toBe(0);
    expect(() =>
      s.packet(new BitWriter().u8(OP.resurrection).i32(0).position(own).i32(50)),
    ).not.toThrow();
    expect(s.c.engine.actorActionIdentity()?.selfId).toBe(0);
    expect(() => s.step()).not.toThrow();
    s.step();
    expect(s.sent.filter((a) => a.type === 'useItem')).toEqual([{ type: 'useItem', itemId: 501 }]);
    expect(s.c.runRequested).toBe(true);
  });
  it.each(['normal', 'skill'] as const)(
    'skips beyond-cap selected actor zero before %s dispatch without a null action owner',
    (mode) => {
      const s = setup(1),
        automation = structuredClone(DEFAULT_AUTOMATION);
      if (mode === 'skill')
        automation.skills = [
          {
            skillId: 3,
            level: 1,
            target: 'enemy',
            hpBelowPercent: 100,
            spAbovePercent: 0,
            cooldownSeconds: 10,
          },
        ];
      s.events(
        ...Array.from(
          { length: 299 },
          (_, i) => ({ type: 'spawn', entity: { ...enemy, id: i + 2, classId: 4001 } }) as const,
        ),
        { type: 'skills', learned: [{ skillId: 3, level: 1 }] },
      );
      s.packet(spawn({ ...enemy, id: 0 }));
      expect(s.c.engine.actorActionIdentity(0)).toBeNull();
      expect(() => s.c.start({ ...settings, route_randomWalk: 0, automation })).not.toThrow();
      expect(() => s.step()).not.toThrow();
      expect(s.sent).toEqual([]);
      expect(s.c.runRequested).toBe(true);
      expect(s.c.engine.reason).toContain('Waiting for a reachable');
      s.packet(new BitWriter().u8(OP.remove).i32(300).u8(0));
      s.packet(spawn({ ...enemy, id: 0 }));
      s.step();
      expect(s.sent.at(-1)).toEqual(
        mode === 'skill'
          ? { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 0 }
          : { type: 'attack', id: 0 },
      );
    },
  );
  it('does not cast a legacy enemy skill at an owned zero target whose hit removed its live observation', () => {
    const s = setup(1),
      automation = structuredClone(DEFAULT_AUTOMATION);
    automation.skills = [
      {
        skillId: 3,
        level: 1,
        target: 'enemy',
        hpBelowPercent: 60,
        spAbovePercent: 0,
        cooldownSeconds: 10,
      },
    ];
    s.events({ type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    s.packet(spawn({ ...enemy, id: 0 }));
    s.c.start({ ...settings, route_randomWalk: 0, automation });
    s.step();
    expect(s.sent.at(-1)).toEqual({ type: 'attack', id: 0 });
    s.events(
      { type: 'hit', id: 0, damage: 100, position: { x: enemy.x, y: enemy.y }, stops: false },
      { type: 'heal', id: 1, hp: 50, maxHp: 100 },
    );
    expect(s.c.engine.actorActionIdentity(0)).toBeNull();
    expect(() => s.step()).not.toThrow();
    expect(s.sent.filter((a) => a.type === 'skill')).toEqual([]);
  });
  it('holds field admission and an existing run when own observation becomes unavailable', () => {
    const s = setup(),
      value = { ...settings, route_randomWalk: 0 as const };
    s.c.engine.observations.remove(0);
    expect(() => s.c.engine.start(value)).toThrow('own actor lifetime');
    expect(() => s.c.start(value)).not.toThrow();
    expect(s.c.snapshot().state).toBe('waiting');
    expect(s.sent).toEqual([]);
    s.packet(spawn(own));
    s.step();
    expect(s.c.engine.running).toBe(true);
    s.c.engine.observations.remove(0);
    expect(() => s.step()).not.toThrow();
    expect(s.c.runRequested).toBe(true);
    expect(s.c.snapshot().state).toBe('waiting');
    expect(s.sent.every((a) => a.type === 'stop')).toBe(true);
  });
  it('uses ready own zero for physical field entry before admitting normal combat', () => {
    const s = setup();
    const mapPolicy = {
      ...structuredClone(DEFAULT_MAP_POLICY),
      lockArea: { map: settings.map, minX: 8, minY: 8, maxX: 9, maxY: 12 },
    };
    s.packet(spawn({ ...enemy, x: 8, y: 9 }));
    s.c.start({
      ...settings,
      route_randomWalk: 0,
      automation: { ...structuredClone(DEFAULT_AUTOMATION), mapPolicy },
    });
    s.c.tick();
    expect(s.c.engine.running).toBe(false);
    expect(s.c.travel.snapshot().purpose).toBe('field-entry');
    expect(s.sent.some((a) => a.type === 'attack')).toBe(false);
    const cells = s.c.travel.snapshot().leg;
    expect(cells.length).toBeGreaterThan(1);
    s.packet(walking(0, cells));
    s.step(500);
    s.step();
    s.step();
    expect(s.c.engine.player?.id).toBe(0);
    expect(insideLockArea(mapPolicy, settings.map, s.c.engine.player!)).toBe(true);
    expect(s.c.engine.running).toBe(true);
    expect(s.sent, s.c.engine.reason).toContainEqual({ type: 'attack', id: 2 });
  });
  it('requires target zero to be inside the configured field area and cancels it on exit', () => {
    const s = setup(1);
    const mapPolicy = {
      ...structuredClone(DEFAULT_MAP_POLICY),
      lockArea: { map: settings.map, minX: 8, minY: 8, maxX: 12, maxY: 12 },
    };
    s.packet(spawn({ ...enemy, id: 0, x: 14 }));
    s.c.start({
      ...settings,
      route_randomWalk: 0,
      automation: { ...structuredClone(DEFAULT_AUTOMATION), mapPolicy },
    });
    s.step();
    expect(s.sent).toEqual([]);
    s.packet(spawn({ ...enemy, id: 0, x: 11 }));
    s.step();
    expect(s.sent).toContainEqual({ type: 'attack', id: 0 });
    s.packet(new BitWriter().u8(OP.move).i32(0).position({ x: 14, y: 10 }));
    s.step();
    expect(s.sent.at(-1)).toEqual({ type: 'stop' });
    s.step();
    expect(s.sent.filter((a) => a.type === 'attack')).toHaveLength(1);
    expect(s.c.runRequested).toBe(true);
  });
  it.each([0, 1])(
    'keeps a canceled explicit field walk targetless with own %s, including a late target-zero Attack',
    (ownId) => {
      const target = ownId === 0 ? 2 : 0,
        s = setup(ownId, true, {
          width: 40,
          height: 40,
          walkable: (p) => p.x !== 14 || p.y === 14,
        });
      const mapPolicy = {
        ...structuredClone(DEFAULT_MAP_POLICY),
        lockArea: { map: settings.map, minX: 9, minY: 9, maxX: 20, maxY: 20 },
      };
      const value: Settings = {
        ...settings,
        route_randomWalk: 0,
        route_avoidWalls: false,
        automation: { ...structuredClone(DEFAULT_AUTOMATION), mapPolicy },
      };
      s.packet(spawn({ ...enemy, id: target, x: 18 }));
      s.c.start(value);
      s.step();
      expect(s.sent.at(-1)?.type).toBe('walk');
      s.c.stop();
      for (const lateTarget of [target, 0]) {
        s.packet(new BitWriter().u8(OP.attack).i32(ownId).i32(lateTarget).i32(1).position(own));
        expect(s.c.engine.idleForActions()).toBe(false);
        expect(() => s.c.engine.start(value)).toThrow('Wait');
      }
      expect(s.sent.map((a) => a.type)).toEqual(['walk', 'stop']);
      s.step(4000);
      expect(s.c.engine.idleForActions()).toBe(true);
      expect(s.c.runRequested).toBe(false);
    },
  );
});

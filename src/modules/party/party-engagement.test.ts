import { checkedEngagementIdentity } from '../combat/attack-strategy-logic';
import { actorId, partyMemberId } from '../../shared/domain-values';
import { partyActorBinding } from './party-actors-logic';
import { describe, expect, it } from 'vitest';
import { BotEngine, type Action } from '../automation/engine';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, validateAutomation } from '../settings/settings';
import { WorldState } from '../world/world-state';
import type { Entity, GameEvent } from '../protocol/protocol';
import type { SkillResult } from '../protocol/protocol-feature';
import type { PartyMember, WorldEvent } from '../protocol/world-protocol';
import { PartyEngagements, PARTY_ENGAGEMENT_LIMITS } from './party-engagement';
import { partyEngagementSnapshot, type Claims } from './party-engagement-logic';
import type { PartyActorBinding } from './party-actors';
import cases from '../../data/party-engagement-settings-cases.json';
const map = 'prt_fild08';
const own: Entity = {
  id: 1,
  kind: 0,
  classId: 6,
  name: 'Own',
  level: 10,
  hp: 100,
  maxHp: 100,
  sp: 100,
  maxSp: 100,
  x: 100,
  y: 100,
  dead: false,
  statuses: [],
};
const monster: Entity = { ...own, id: 2, kind: 1, classId: 4000, name: 'Poring', x: 101 };
const ally: Entity = { ...own, id: 3, name: 'Ally', partyId: 5, partyName: 'Party' };
const member: PartyMember = {
  memberId: 7,
  entityId: 3,
  level: 10,
  name: 'Ally',
  leader: false,
  map,
  hp: 100,
  maxHp: 100,
  sp: 100,
  maxSp: 100,
};
function fixture(grid = (p: { x: number; y: number }) => p.x >= 0 && p.y >= 0) {
  let at = 100_000;
  const sent: Action[] = [];
  const world = new WorldState();
  world.reset(map);
  const engine = new BotEngine(
    (a) => sent.push(a),
    () => at,
    () => ({ width: 200, height: 200, walkable: grid }),
    (id) => {
      const rows = [...(world.party?.members.values() ?? [])].filter((row) => row.entityId === id);
      return rows.length === 1 ? world.partyActors.get(partyMemberId(rows[0]!.memberId)) : null;
    },
  );
  const sync = () => {
    world.refreshPartyActors(engine.observations, engine.player?.id ?? null);
    engine.partyChanged();
  };
  const receive = (...events: GameEvent[]) => {
    engine.receive(events);
    sync();
  };
  const event = (e: WorldEvent) => {
    if (e.type === 'partyJoined' || e.type === 'partyLeft') engine.partyMembershipChanged();
    else if (e.type === 'partyMember') engine.partyMembershipChanged(e.member.memberId);
    else if (e.type === 'partyRemove' || e.type === 'partyMap')
      engine.partyMembershipChanged(e.memberId);
    world.observe(e, engine.observations, engine.player?.id ?? null);
    engine.partyChanged();
  };
  const join = (members = [member]) =>
    event({ type: 'partyJoined', partyId: 5, name: 'Party', login: false, members });
  engine.connect(true);
  receive(
    { type: 'enter', id: 1, map },
    { type: 'spawn', entity: { ...own } },
    { type: 'spawn', entity: { ...monster } },
    { type: 'spawn', entity: { ...ally } },
  );
  join();
  const attack = (source = 3, target = 2) =>
    receive({ type: 'attack', source, target, position: { x: 100, y: 100 } });
  const skill = (changes: Partial<SkillResult> = {}) =>
    receive({
      type: 'skillResult',
      mode: 'target',
      source: 3,
      target: 2,
      skillId: 11,
      level: 1,
      position: { x: 100, y: 100 },
      motionSeconds: 0.1,
      damage: 1,
      hits: 1,
      result: 0,
      damageSeconds: 0,
      indirect: false,
      ...changes,
    });
  const start = (enabled: boolean | 'omitted' = true, extra = {}) => {
    const automation = structuredClone(DEFAULT_AUTOMATION);
    if (enabled === 'omitted') delete automation.combat.partyEngagement;
    else automation.combat.partyEngagement = enabled;
    engine.start({ ...DEFAULT_SETTINGS, map, targets: [4000], automation, ...extra });
  };
  const step = (ms = 100) => {
    at += ms;
    receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 });
    engine.tick();
  };
  return { engine, sent, world, receive, event, join, sync, attack, skill, start, step };
}
const attacks = (sent: Action[]) =>
  sent.filter((action) => action.type === 'attack' || action.type === 'skill');
describe('observed party combat eligibility', () => {
  it('keeps omitted/false defaults and only admits current verified party evidence when enabled', () => {
    expect(DEFAULT_AUTOMATION.combat.partyEngagement).toBe(false);
    for (const enabled of ['omitted', false, true] as const) {
      const f = fixture();
      f.attack();
      f.start(enabled);
      f.step();
      expect(attacks(f.sent)).toHaveLength(enabled === true ? 1 : 0);
    }
  });
  it('shares strict optional settings cases with native validation', () => {
    for (const row of cases) {
      const a = structuredClone(DEFAULT_AUTOMATION);
      Object.assign(a.combat, row.value);
      if (row.omit) delete a.combat.partyEngagement;
      if (row.valid) expect(() => validateAutomation(a), row.name).not.toThrow();
      else expect(() => validateAutomation(a), row.name).toThrow();
    }
  });
  it.each(['unknown', 'outsider', 'mixed', 'joined later'] as const)(
    'never rehabilitates %s participation',
    (kind) => {
      const f = fixture();
      if (kind === 'mixed') f.attack();
      if (kind === 'joined later') f.event({ type: 'partyLeft', disbanded: false });
      f.attack(kind === 'unknown' ? 99 : kind === 'joined later' ? 3 : 4);
      f.join();
      f.attack();
      f.start();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
      expect(f.engine.snapshot().partyEngagement.blocked).toBe(1);
    },
  );
  it.each(['leave', 'remove', 'logout', 'map', 'affiliation', 'replacement', 'dead'] as const)(
    'permanently revokes permission on %s even if membership reappears before a tick',
    (kind) => {
      const f = fixture();
      f.attack();
      if (kind === 'leave') f.event({ type: 'partyLeft', disbanded: false });
      if (kind === 'remove') f.event({ type: 'partyRemove', memberId: 7 });
      if (kind === 'logout')
        f.event({
          type: 'partyMember',
          change: 'logout',
          member: { ...member, entityId: 0, map: '', level: -1 },
        });
      if (kind === 'map') f.event({ type: 'partyMap', memberId: 7, map: 'prontera' });
      if (kind === 'affiliation')
        f.receive({ type: 'partyAffiliation', id: 3, partyId: -1, partyName: '' });
      if (kind === 'replacement') f.receive({ type: 'spawn', entity: { ...ally } });
      if (kind === 'dead') f.receive({ type: 'death', id: 3 });
      f.receive({ type: 'spawn', entity: { ...ally } });
      f.join();
      f.attack();
      f.start();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
      expect(f.engine.snapshot().partyEngagement.reasons).toContain(
        'Party engagement unavailable: revoked party membership.',
      );
    },
  );
  it('does not bind duplicate, offline-zero, missing affiliation, stale or map-only roster evidence', () => {
    const changes = [
      () => [{ ...member }, { ...member, memberId: 8 }],
      () => [{ ...member, entityId: 0, level: -1, map: '' }],
      () => [{ ...member, name: 'Namesake' }],
      () => [{ ...member, map: 'prontera' }],
    ];
    for (const rows of changes) {
      const f = fixture();
      f.join(rows());
      f.attack();
      f.start();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
    }
    for (const name of ['', 'Other']) {
      const f = fixture();
      f.receive({ type: 'spawn', entity: { ...ally, partyName: name } });
      f.join();
      f.attack();
      f.start();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
    }
    const f = fixture();
    f.receive({ type: 'remove', id: 3, dead: false });
    f.join();
    f.step(16000);
    f.receive({ type: 'spawn', entity: { ...ally } });
    f.event({ type: 'partyMap', memberId: 7, map });
    f.attack();
    f.start();
    f.step();
    expect(attacks(f.sent)).toHaveLength(0);
  });
  it('revokes a visible member when authoritative party HP reaches zero', () => {
    for (const hp of [0]) {
      const f = fixture();
      f.attack();
      f.event({ type: 'partyHealth', memberId: 7, hp, maxHp: 100, sp: 100, maxSp: 100 });
      f.start();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
    }
  });
  it('keeps actor zero valid for self while party entity zero cannot authorize', () => {
    const f = fixture();
    f.receive(
      { type: 'enter', id: 0, map },
      { type: 'spawn', entity: { ...own, id: 0 } },
      { type: 'spawn', entity: { ...monster } },
      { type: 'spawn', entity: { ...ally } },
    );
    f.join();
    f.attack();
    f.start();
    f.step();
    expect(attacks(f.sent)).toHaveLength(1);
    const g = fixture();
    g.receive({ type: 'spawn', entity: { ...ally, id: 0 } });
    g.join([{ ...member, entityId: 0, map: '', level: -1 }]);
    g.attack(0);
    g.start();
    g.step();
    expect(attacks(g.sent)).toHaveLength(0);
  });
  it.each([
    {},
    { attacker: -1 },
    { attacker: 3 },
    { attacker: 4 },
    { attacker: 1 },
    { indirect: true },
    { mode: 'ground' as const },
  ])('admits only direct nonconflicting targeted player skill %j', (changes) => {
    const f = fixture();
    f.skill(changes);
    f.start();
    f.step();
    expect(attacks(f.sent)).toHaveLength(
      Object.keys(changes).length === 0 || changes.attacker === -1 || changes.attacker === 3
        ? 1
        : 0,
    );
  });
  it('keeps standalone impacts foreign even with a party source and rejects source-less damage ownership', () => {
    for (const source of [3, 99]) {
      const f = fixture();
      f.receive({
        type: 'skillImpact',
        source,
        target: 2,
        skillId: 11,
        position: { x: 101, y: 100 },
        damage: 1,
        hits: 1,
        result: 0,
        damageSeconds: 0,
      });
      f.start();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
    }
  });
  it('retires old monster claims only on replacement, removal or world change', () => {
    const f = fixture();
    f.attack(99);
    f.receive({ type: 'spawn', entity: { ...monster } });
    f.attack();
    f.start();
    f.step();
    expect(attacks(f.sent)).toHaveLength(1);
    const g = fixture();
    g.attack();
    g.receive({ type: 'spawn', entity: { ...monster } });
    g.start();
    g.step();
    expect(attacks(g.sent)).toHaveLength(1); // fresh unclaimed lifetime remains ordinarily eligible
  });
  it('cancels a party direct approach once while retaining run clocks and late movement settlement', () => {
    const f = fixture();
    f.receive({ type: 'spawn', entity: { ...monster, x: 110 } });
    f.attack();
    f.start();
    f.step();
    expect(attacks(f.sent)).toEqual([{ type: 'attack', id: 2 }]);
    const elapsed = f.engine.snapshot().elapsedSeconds;
    f.event({ type: 'partyLeft', disbanded: false });
    f.join();
    expect(f.engine.running).toBe(true);
    expect(f.engine.runIntent).toBe(true);
    expect(f.sent.filter((a) => a.type === 'stop')).toHaveLength(1);
    f.receive({ type: 'attack', source: 1, target: 2, position: { x: 100, y: 100 } });
    f.step();
    expect(attacks(f.sent)).toHaveLength(1);
    f.step(4000);
    expect(f.engine.snapshot().elapsedSeconds).toBeGreaterThanOrEqual(elapsed);
    expect(attacks(f.sent)).toHaveLength(1);
  });
  it.each([false, true])(
    'cancels an explicit %s accepted walk without admitting another target before its original settlement',
    (accepted) => {
      const f = fixture((p) => !(p.x === 102 && p.y >= 99 && p.y <= 101));
      f.receive({ type: 'spawn', entity: { ...monster, x: 105 } });
      f.attack();
      f.start();
      f.step();
      expect(f.sent[0]?.type).toBe('walk');
      const leg = f.engine.snapshot().navigation!.leg;
      expect(leg.length).toBeGreaterThan(1);
      if (accepted)
        f.receive({
          type: 'walk',
          id: 1,
          walk: { origin: leg[0]!, cells: leg, secondsPerCell: 1, firstSeconds: 1, locked: false },
        });
      f.event({ type: 'partyLeft', disbanded: false });
      expect(f.sent.filter((a) => a.type === 'stop')).toHaveLength(1);
      expect(f.engine.runIntent).toBe(true);
      expect(f.engine.running).toBe(true);
      f.receive({ type: 'spawn', entity: { ...monster, id: 8, x: 100, y: 102 } });
      if (!accepted)
        f.receive({
          type: 'walk',
          id: 1,
          walk: { origin: leg[0]!, cells: leg, secondsPerCell: 1, firstSeconds: 1, locked: false },
        });
      f.step(1000);
      expect(attacks(f.sent)).toHaveLength(0);
      expect(f.sent.filter((a) => a.type === 'walk')).toHaveLength(1);
      if (leg.length > 6) {
        for (let i = 0; i < 4; i++) f.step(1000);
        expect(attacks(f.sent)).toHaveLength(0);
      }
      f.engine.stop();
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
    },
  );
  it('holds a canceled accepted strategy cast through late replies and Stop without new casts or normal attacks', () => {
    const f = fixture();
    f.receive(
      { type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 },
      { type: 'skills', learned: [{ skillId: 11, level: 1 }] },
    );
    f.attack();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.partyEngagement = true;
    automation.attackStrategies = [
      {
        id: 'bolt',
        speciesIds: [4000],
        skillId: 11,
        level: 1,
        behavior: 'opener',
        maxAttempts: 1,
        maxUses: 1,
        cooldownSeconds: 1,
      },
    ];
    f.start(true, { automation });
    f.step();
    expect(attacks(f.sent)).toHaveLength(1);
    expect(attacks(f.sent)[0]?.type).toBe('skill');
    f.receive({
      type: 'castStart',
      id: 1,
      skillId: 11,
      level: 1,
      target: 2,
      position: { x: 100, y: 100 },
      remainingSeconds: 1,
      flags: 0,
    });
    f.event({ type: 'partyLeft', disbanded: false });
    expect(f.engine.snapshot().task.pending).toBe(true);
    expect(f.engine.runIntent).toBe(true);
    f.skill({ source: 1 });
    for (let i = 0; i < 40; i++) f.step(1000);
    expect(attacks(f.sent)).toHaveLength(1);
    expect(f.engine.snapshot().attackStrategies.entries[0]?.rules[0]?.uncertain).toBe(true);
    f.engine.stop();
    f.step();
    expect(attacks(f.sent)).toHaveLength(1);
  });
  it.each([9999, 4, 3])(
    'retains a first unrecorded overflow claim from source %i after capacity becomes available',
    (source) => {
      const f = fixture();
      f.receive({
        type: 'spawn',
        entity: { ...ally, id: 4, name: 'Outsider', partyId: -1, partyName: '' },
      });
      for (let id = 10; id < 160; id++) {
        f.receive({ type: 'spawn', entity: { ...monster, id } });
        f.attack(3, id);
      }
      expect(f.engine.snapshot().partyEngagement.accepted).toBe(150);
      f.receive({ type: 'spawn', entity: { ...monster, id: 160, classId: 4002 } });
      f.attack(source, 160);
      f.receive({ type: 'remove', id: 10, dead: false });
      f.attack(3, 160);
      f.start(true, { targets: [4002] });
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
      f.receive({ type: 'spawn', entity: { ...monster, id: 160, classId: 4002 } });
      f.attack(3, 160);
      f.step();
      expect(attacks(f.sent)).toEqual([{ type: 'attack', id: 160 }]);
    },
  );
  it('preserves the original finite session clock after party revocation', () => {
    const f = fixture();
    f.attack();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.partyEngagement = true;
    automation.limits.minutes = 1;
    f.start(true, { automation });
    f.step();
    f.event({ type: 'partyLeft', disbanded: false });
    for (let i = 0; i < 60; i++) f.step(1000);
    expect(f.engine.running).toBe(false);
    expect(f.engine.runIntent).toBe(false);
    expect(f.engine.reason).toContain('session limit');
    expect(attacks(f.sent)).toHaveLength(1);
  });
  it('never grants party-only or mixed damage own kill/drop credit', () => {
    for (const mixed of [false, true]) {
      const f = fixture();
      f.attack();
      f.start();
      f.step();
      if (mixed) f.attack(99);
      f.receive(
        { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } },
        { type: 'remove', id: 2, dead: true },
      );
      f.step(200);
      expect(f.engine.kills).toBe(0);
      expect(f.sent.some((a) => a.type === 'pickup')).toBe(false);
    }
  });
  it('does not override target priority, level or field-lock restrictions', () => {
    const f = fixture();
    f.receive({ type: 'spawn', entity: { ...monster, id: 8, classId: 4002, x: 103 } });
    f.attack();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.partyEngagement = true;
    automation.combat.rules = [{ classId: 4002, action: 'attack', priority: 10 }];
    f.start(true, { automation, targets: [4000, 4002] });
    f.step();
    expect(attacks(f.sent)).toEqual([{ type: 'attack', id: 8 }]);
    const g = fixture();
    g.receive({ type: 'spawn', entity: { ...monster, level: 100 } });
    g.attack();
    g.start();
    g.step();
    expect(attacks(g.sent)).toHaveLength(0);
    const h = fixture();
    h.attack();
    const locked = structuredClone(DEFAULT_AUTOMATION);
    locked.combat.partyEngagement = true;
    locked.mapPolicy = {
      mode: 'legacy',
      allow: [],
      deny: [],
      lockArea: { map, minX: 99, maxX: 100, minY: 99, maxY: 100 },
      penalties: [],
    };
    h.start(true, { automation: locked });
    h.step();
    expect(attacks(h.sent)).toHaveLength(0);
  });
  it('retains selection, level, radius, field and combat-off gates', () => {
    for (const change of [
      { targets: [4002] },
      { radius: 1 },
      {
        automation: {
          ...structuredClone(DEFAULT_AUTOMATION),
          combat: { mode: 'off' as const, levelDifference: 1, partyEngagement: true, rules: [] },
        },
      },
    ]) {
      const f = fixture();
      f.receive({ type: 'spawn', entity: { ...monster, x: 105 } });
      f.attack();
      f.start(true, change);
      f.step();
      expect(attacks(f.sent)).toHaveLength(0);
    }
  });
});
describe('bounded monster claim provenance', () => {
  const binding = (memberId = 7): PartyActorBinding =>
    partyActorBinding({
      partyId: 5,
      memberId,
      entityId: memberId,
      map,
      world: '11111111-1111-1111-1111-111111111111',
      incarnation: 1,
      affiliationRevision: 0,
    });
  const monster = (id = 2, lifetime = 1) =>
    checkedEngagementIdentity({ id, world: 'world', incarnation: lifetime });
  it.each([null, binding(), { ...binding(), entityId: actorId(99) }])(
    'retains unknown/outside/party first overflow evidence after capacity frees: %j',
    (source) => {
      const policy = new PartyEngagements();
      for (let i = 0; i < PARTY_ENGAGEMENT_LIMITS.monsters; i++)
        policy.observe(monster(i), binding(), false);
      policy.observe(monster(999), source, false);
      expect(policy.allows(monster(999))).toBe(false);
      policy.remove(0);
      policy.observe(monster(999), binding(), true);
      expect(policy.allows(monster(999))).toBe(false);
      expect(policy.snapshot(true).blocked).toBe(1);
      policy.remove(999);
      const fresh = monster(999, 2);
      policy.observe(fresh, binding(), false);
      expect(policy.allows(fresh)).toBe(true);
      for (let i = 0; i <= PARTY_ENGAGEMENT_LIMITS.sources; i++)
        policy.observe(fresh, binding(100 + i), true);
      expect(policy.allows(fresh)).toBe(false);
      expect(policy.snapshot(true).blocked).toBe(1);
    },
  );
  it('cannot erase revoked or unknown claims with replacement membership; a new monster incarnation starts fresh', () => {
    const policy = new PartyEngagements();
    policy.observe(monster(), binding(), false);
    policy.refresh(() => null);
    policy.observe(monster(), binding(), false);
    expect(policy.allows(monster())).toBe(false);
    policy.observe(monster(2, 2), binding(), false);
    expect(policy.allows(monster(2, 2))).toBe(true);
    policy.observe(monster(2, 2), null, true);
    policy.observe(monster(2, 2), binding(), false);
    expect(policy.allows(monster(2, 2))).toBe(false);
  });
});

describe('party engagement projection', () => {
  it('counts accepted and blocked claims separately and keeps distinct reasons in encounter order', () => {
    const binding = partyActorBinding({
      partyId: 5,
      memberId: 7,
      entityId: 3,
      map,
      world: '11111111-1111-1111-1111-111111111111',
      incarnation: 1,
      affiliationRevision: 1,
    });
    const claim = (id: number, blocker: Claims['blocker'], accepted = false): Claims => ({
      monster: checkedEngagementIdentity({ id, world: 'world', incarnation: 1 }),
      blocker,
      sources: new Map(accepted ? [[7, binding]] : []),
    });
    const claims = [
      claim(1, 'unverified source'),
      claim(2, null, true),
      claim(3, 'source capacity'),
      claim(4, 'unverified source'),
      claim(5, null),
    ];
    const before = structuredClone(claims);
    const snapshot = partyEngagementSnapshot({ enabled: true, claims });
    expect(snapshot).toEqual({
      enabled: true,
      accepted: 1,
      blocked: 3,
      reasons: [
        'Party engagement unavailable: unverified source.',
        'Party engagement unavailable: source capacity.',
      ],
    });
    snapshot.reasons.reverse();
    expect(partyEngagementSnapshot({ enabled: false, claims }).reasons[0]).toBe(
      'Party engagement unavailable: unverified source.',
    );
    expect(claims).toEqual(before);
  });
});

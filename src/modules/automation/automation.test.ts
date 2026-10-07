import { validateAutomation } from '../settings/settings';
import { actionIdentity } from '../world/actor-identity';
import { itemId as domainItemId } from '../../shared/domain-values';
import { describe, it, expect } from 'vitest';
import {
  BotEngine,
  DEFAULT_SETTINGS,
  DEFAULT_AUTOMATION,
  type Action,
  type Settings,
} from './engine';
import { CharacterState } from '../world/character-state';
import { AutomationScheduler, inSchedule, actionConfirmationTimeout } from './automation';
import type { Entity, GameEvent, Walk } from '../protocol/protocol';
import type { FeatureEvent, SkillResult } from '../protocol/protocol-feature';
import { acceptsMonster } from './automation-logic';
import type { ActorObservationSnapshot, ActorPredicate } from '../world/actor-observations-logic';
import { STATUS_CATALOG } from '../world/actor-status-catalog';
const player: Entity = {
  id: 1,
  classId: 0,
  name: 'Player',
  kind: 0,
  level: 7,
  hp: 70,
  maxHp: 100,
  x: 100,
  y: 100,
  dead: false,
  sp: 15,
  maxSp: 20,
  sitting: false,
};
const monster: Entity = {
  id: 2,
  classId: 4000,
  name: 'Poring',
  kind: 1,
  level: 1,
  hp: 51,
  maxHp: 51,
  x: 101,
  y: 100,
  dead: false,
};
function setup() {
  let time = 100_000;
  const sent: Action[] = [];
  const engine = new BotEngine(
    (a) => sent.push(a),
    () => time,
    () => ({ width: 200, height: 200, walkable: () => true }),
  );
  engine.connect(true);
  engine.receive([
    { type: 'enter', id: 1, map: 'prt_fild08' },
    { type: 'spawn', entity: { ...player } },
    { type: 'spawn', entity: { ...monster } },
  ]);
  engine.receive([{ type: 'skills', learned: [{ skillId: 1, level: 2 }] }]);
  const settings: Settings = {
    ...DEFAULT_SETTINGS,
    map: 'prt_fild08',
    targets: [4000],
    automation: structuredClone(DEFAULT_AUTOMATION),
  };
  const step = (ms = 1000) => {
    time += ms;
    engine.tick();
  };
  const receive = (event: GameEvent | FeatureEvent) => engine.receive([event]);
  const inventory = () =>
    receive({
      type: 'inventory',
      items: [
        { bagId: 501, itemId: 501, count: 4, type: 1 },
        { bagId: 900, itemId: 1201, count: 1, type: 2 },
      ],
      equipment: Array(10).fill(0),
      ammoId: -1,
    });
  return { engine, settings, sent, step, receive, inventory };
}
describe('field automation policy and owner', () => {
  it('retaliates only after a monster attacks the player and honors ignore rules', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.combat.mode = 'retaliate';
    engine.start(settings);
    step();
    expect(sent).toEqual([]);
    receive({ type: 'attack', source: 2, target: 1, position: { x: 101, y: 100 } });
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    engine.stop();
    settings.automation!.combat.rules = [{ classId: 4000, action: 'ignore', priority: 0 }];
    engine.start(settings);
    sent.length = 0;
    step();
    expect(sent).toEqual([]);
  });
  it('uses monster priority before distance and applies a configurable level gate', () => {
    const { engine, settings, sent, step, receive } = setup();
    receive({ type: 'spawn', entity: { ...monster, id: 3, classId: 4001, x: 102, level: 12 } });
    settings.automation!.combat.levelDifference = 5;
    settings.automation!.combat.rules = [{ classId: 4001, action: 'attack', priority: 10 }];
    engine.start(settings);
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 3 });
    expect(engine.snapshot().target).toBe('Poring');
    expect(engine.snapshot().navigation?.goal).toEqual({ x: 102, y: 100 });
  });
  it('applies loot deny rules and priority without changing default own-kill attribution', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.loot.rules = [
      { itemId: 909, action: 'ignore', priority: 100 },
      { itemId: 910, action: 'pickup', priority: 10 },
    ];
    engine.start(settings);
    step();
    receive({ type: 'death', id: 2 });
    receive({ type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    receive({ type: 'drop', drop: { id: 10, itemId: 910, count: 3, isNew: true, x: 101, y: 100 } });
    step();
    expect(sent.at(-1)).toEqual({ type: 'pickup', id: 10 });
    receive({ type: 'pickup', picker: 1, id: 10 });
    expect(engine.snapshot().lootStats).toEqual([{ itemId: 910, count: 3 }]);
  });
  it('ends a run at a confirmed kill limit before scheduling loot', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.limits.kills = 1;
    engine.start(settings);
    step();
    receive({ type: 'death', id: 2 });
    step();
    expect(engine.running).toBe(false);
    expect(engine.reason).toContain('session limit');
    expect(sent.at(-1)).toEqual({ type: 'stop' });
  });
  it('stops when weight is unknown or reaches the configured limit', () => {
    const { engine, settings, step, receive } = setup();
    settings.automation!.limits.weightPercent = 50;
    engine.start(settings);
    step();
    expect(engine.reason).toContain('unavailable');
    receive({ type: 'stats', level: 7, hp: 70, maxHp: 100, weight: 50, maxWeight: 100 });
    engine.start(settings);
    step();
    expect(engine.reason).toContain('weight limit');
  });
  it('stops combat, waits for sit confirmation, and stands after both recovery thresholds', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.recovery.enabled = true;
    engine.start(settings);
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    receive({ type: 'heal', id: 1, hp: 55, maxHp: 100 });
    step();
    expect(sent.at(-1)).toEqual({ type: 'stop' });
    step();
    expect(sent.at(-1)).toEqual({ type: 'sit', sitting: true });
    step();
    expect(sent.filter((a) => a.type === 'attack')).toHaveLength(1);
    receive({ type: 'sit', id: 1, sitting: true });
    receive({ type: 'heal', id: 1, hp: 90, maxHp: 100 });
    step();
    expect(sent.at(-1)).toEqual({ type: 'sit', sitting: true });
    receive({ type: 'sp', sp: 20, maxSp: 20 });
    step();
    expect(sent.at(-1)).toEqual({ type: 'sit', sitting: false });
    receive({ type: 'sit', id: 1, sitting: false });
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
  });
  it('uses a recovery item before sitting and preserves one outstanding action', () => {
    const { engine, settings, sent, step, receive, inventory } = setup();
    inventory();
    settings.automation!.recovery.enabled = true;
    settings.automation!.items = [
      { itemId: 501, resource: 'hp', belowPercent: 60, minStock: 1, cooldownSeconds: 10 },
    ];
    engine.player!.hp = 55;
    engine.start(settings);
    step();
    expect(sent).toEqual([{ type: 'useItem', itemId: 501 }]);
    step();
    expect(sent).toHaveLength(1);
    receive({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 });
    step();
    expect(sent.at(-1)).toEqual({ type: 'sit', sitting: true });
  });
  it('bounds resting when regeneration cannot reach the end thresholds', () => {
    const { engine, settings, step, receive } = setup();
    settings.automation!.recovery.enabled = true;
    settings.automation!.recovery.timeoutSeconds = 2;
    engine.player!.hp = 55;
    engine.start(settings);
    step();
    receive({ type: 'sit', id: 1, sitting: true });
    step();
    step();
    expect(engine.running).toBe(false);
    expect(engine.reason).toContain('Recovery time limit');
  });
  it('requires a complete inventory and consumes one confirmed item at a time with reserve and cooldown', () => {
    const { engine, settings, sent, step, receive, inventory } = setup();
    settings.automation!.items = [
      { itemId: 501, resource: 'hp', belowPercent: 80, minStock: 2, cooldownSeconds: 10 },
    ];
    engine.start(settings);
    step();
    expect(engine.reason).toContain('Inventory is unavailable');
    inventory();
    engine.start(settings);
    sent.length = 0;
    step();
    expect(sent).toEqual([{ type: 'useItem', itemId: 501 }]);
    step();
    expect(sent).toHaveLength(1);
    receive({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 });
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    expect(engine.character.count(domainItemId(501))).toBe(3);
  });
  it('requires a learned active skill, sufficient SP and an exact server confirmation', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.skills = [
      {
        skillId: 2,
        level: 1,
        target: 'self',
        hpBelowPercent: 80,
        spAbovePercent: 0,
        cooldownSeconds: 10,
      },
    ];
    receive({ type: 'skills', learned: [{ skillId: 2, level: 1 }], granted: [] });
    engine.start(settings);
    step();
    expect(sent).toEqual([{ type: 'skill', mode: 'self', skillId: 2, level: 1 }]);
    receive({
      type: 'skillResult',
      source: 99,
      skillId: 2,
      level: 1,
      mode: 'self',
      position: { x: 100, y: 100 },
      motionSeconds: 1,
    });
    step();
    expect(sent).toHaveLength(1);
    receive({
      type: 'skillResult',
      source: 1,
      skillId: 2,
      level: 1,
      mode: 'self',
      position: { x: 100, y: 100 },
      motionSeconds: 1,
    });
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
  });
  it('uses the server effective level and SP cost for nonadjustable buffs', () => {
    const { engine, settings, sent, step, receive } = setup();
    receive({ type: 'skills', learned: [{ skillId: 4, level: 10 }] });
    settings.automation!.skills = [
      {
        skillId: 4,
        level: 1,
        target: 'self',
        hpBelowPercent: 100,
        spAbovePercent: 0,
        cooldownSeconds: 10,
      },
    ];
    receive({ type: 'sp', sp: 5, maxSp: 20 });
    engine.start(settings);
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    engine.stop();
    receive({ type: 'sp', sp: 15, maxSp: 20 });
    engine.start(settings);
    sent.length = 0;
    step();
    expect(sent.at(-1)).toEqual({ type: 'skill', mode: 'self', skillId: 4, level: 10 });
    receive({
      type: 'skillResult',
      source: 1,
      skillId: 4,
      level: 10,
      mode: 'self',
      position: { x: 100, y: 100 },
      motionSeconds: 2,
    });
    expect(engine.actionResult.status).toBe('confirmed');
    step();
    expect(sent).toHaveLength(1);
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
  });
  it('rejects passive skills instead of sending unsupported cast commands', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.skills = [
      {
        skillId: 1,
        level: 1,
        target: 'self',
        hpBelowPercent: 100,
        spAbovePercent: 0,
        cooldownSeconds: 1,
      },
    ];
    receive({ type: 'skills', learned: [{ skillId: 1, level: 1 }] });
    engine.start(settings);
    step();
    expect(engine.running).toBe(false);
    expect(sent).toEqual([{ type: 'stop' }]);
  });
  it('equips an owned unique item only once after matching equipment confirmation', () => {
    const { engine, settings, sent, step, receive, inventory } = setup();
    inventory();
    settings.automation!.equipment = [{ itemId: 1201, hpBelowPercent: 100, monsterClassId: 0 }];
    engine.start(settings);
    step();
    expect(sent.at(-1)).toEqual({ type: 'equip', bagId: 900, equipped: true });
    receive({ type: 'equipment', bagId: 900, slot: 0, equipped: true });
    step();
    expect(sent.filter((a) => a.type === 'equip')).toHaveLength(1);
  });
  it('allocates attributes in profile order and waits for changed authoritative attributes', () => {
    const { engine, settings, sent, step, receive } = setup();
    receive({
      type: 'stats',
      hp: 70,
      maxHp: 100,
      level: 7,
      attributes: [1, 1, 1, 1, 1, 1],
      statPoints: 2,
    });
    settings.automation!.allocation.stats = [
      { stat: 0, target: 2 },
      { stat: 1, target: 2 },
    ];
    engine.start(settings);
    step();
    expect(sent.at(-1)).toEqual({ type: 'allocateStats', attributes: [1, 0, 0, 0, 0, 0] });
    receive({
      type: 'stats',
      hp: 70,
      maxHp: 100,
      level: 7,
      attributes: [1, 1, 1, 1, 1, 1],
      statPoints: 2,
    });
    step();
    expect(sent.filter((a) => a.type === 'allocateStats')).toHaveLength(1);
    receive({
      type: 'stats',
      hp: 70,
      maxHp: 100,
      level: 7,
      attributes: [2, 1, 1, 1, 1, 1],
      statPoints: 0,
    });
    step();
    expect(sent.filter((a) => a.type === 'allocateStats')).toHaveLength(1);
  });
  it('uses the verified job skill tree and waits when prerequisites are unmet', () => {
    const { engine, settings, sent, step, receive } = setup();
    receive({ type: 'stats', hp: 70, maxHp: 100, level: 7, skillPoints: 1 });
    receive({ type: 'skills', learned: [{ skillId: 1, level: 1 }] });
    settings.automation!.allocation.skills = [{ skillId: 2, target: 1 }];
    engine.start(settings);
    step();
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    engine.stop();
    receive({ type: 'skills', learned: [{ skillId: 1, level: 2 }] });
    engine.start(settings);
    sent.length = 0;
    step();
    expect(sent.at(-1)).toEqual({ type: 'allocateSkill', skillId: 2 });
    receive({ type: 'stats', hp: 70, maxHp: 100, level: 7, skillPoints: 0 });
    receive({
      type: 'skills',
      learned: [
        { skillId: 1, level: 2 },
        { skillId: 2, level: 1 },
      ],
    });
    expect(engine.actionResult.status).toBe('confirmed');
  });
  it('follows a named visible actor with no combat and stops after bounded visibility loss', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.targets = [];
    settings.automation!.combat.mode = 'off';
    settings.automation!.follow = { name: 'Leader', distance: 2, lostSeconds: 2 };
    receive({ type: 'spawn', entity: { ...player, id: 3, name: 'Leader', x: 110 } });
    engine.start(settings);
    step();
    expect(sent.at(-1)?.type).toBe('walk');
    receive({ type: 'remove', id: 3, dead: false });
    step();
    step();
    step();
    expect(engine.running).toBe(false);
    expect(engine.reason).toContain('no longer visible');
  });
  it('walks same-map waypoints and stops explicitly for a different map', () => {
    const { engine, settings, sent, step } = setup();
    settings.targets = [];
    settings.automation!.combat.mode = 'off';
    settings.automation!.travel.waypoints = [
      { map: 'prt_fild08', x: 100, y: 100 },
      { map: 'prt_fild05', x: 100, y: 100 },
    ];
    engine.start(settings);
    step();
    expect(sent).toEqual([]);
    step();
    expect(engine.running).toBe(false);
    expect(engine.reason).toContain('another map');
  });
  it('opt-in respawn is confirmed separately and never resumes combat after the map change', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.respawn.enabled = true;
    engine.start(settings);
    step();
    receive({ type: 'death', id: 1 });
    step();
    expect(sent.at(-1)).toEqual({ type: 'respawn' });
    receive({ type: 'map', map: 'prontera' });
    expect(engine.running).toBe(false);
    expect(engine.runIntent).toBe(true);
    expect(engine.actionResult.status).toBe('pending');
    receive({ type: 'spawn', entryType: 1, entity: { ...player } });
    expect(engine.actionResult.status).toBe('confirmed');
    expect(engine.map).toBe('prontera');
  });
  it('keeps unexpected world refresh stopped without a resume intent', () => {
    const { engine, settings, receive } = setup();
    engine.start(settings);
    receive({ type: 'clear' });
    expect(engine.running).toBe(false);
    expect(engine.runIntent).toBe(false);
  });
  it('preserves death and session budgets through an authorized return and rejects resume after manual cancellation', () => {
    const { engine, settings, sent, step, receive } = setup();
    settings.automation!.respawn = { enabled: true, maxDeaths: 1 };
    settings.automation!.travel.returnToLockMap = true;
    engine.start(settings);
    step();
    receive({ type: 'death', id: 1 });
    step();
    receive({ type: 'map', map: 'prontera' });
    receive({ type: 'spawn', entryType: 1, entity: { ...player } });
    receive({ type: 'map', map: 'prt_fild08' });
    receive({ type: 'spawn', entryType: 1, entity: { ...player } });
    engine.resumeAfterReturn(settings);
    expect(engine.deaths).toBe(1);
    expect(engine.snapshot().elapsedSeconds).toBe(2);
    receive({ type: 'death', id: 1 });
    step();
    expect(engine.running).toBe(false);
    expect(engine.reason).toContain('Death limit');
    expect(sent.filter((a) => a.type === 'respawn')).toHaveLength(1);
    engine.stop('Stopped by you.');
    expect(() => engine.resumeAfterReturn(settings)).toThrow('No automatic return');
  });
  it('rejects concurrent manual actions and cancels pending confirmation on manual stop', () => {
    const { engine, sent, receive, step, inventory } = setup();
    inventory();
    engine.manualAction({ type: 'useItem', itemId: 501 });
    expect(engine.actionResult.status).toBe('pending');
    expect(() => engine.manualAction({ type: 'sit', sitting: true })).toThrow('wait');
    receive({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 });
    expect(engine.actionResult.status).toBe('confirmed');
    engine.manualAction({ type: 'sit', sitting: true });
    engine.stop('Manual input detected.');
    receive({ type: 'sit', id: 1, sitting: true });
    step();
    expect(engine.actionResult.status).toBe('failed');
    expect(sent.filter((a) => a.type === 'sit')).toHaveLength(1);
  });
  it('keeps a canceled action fenced until its confirmation deadline so late responses cannot confirm a replacement', () => {
    const { engine, inventory, step, receive } = setup();
    inventory();
    engine.manualAction({ type: 'useItem', itemId: 501 });
    engine.stop('Stopped by you.');
    expect(engine.idleForActions()).toBe(false);
    expect(() => engine.manualAction({ type: 'useItem', itemId: 501 })).toThrow();
    receive({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 });
    expect(engine.actionResult.status).toBe('failed');
    step(4000);
    step(2000);
    expect(engine.idleForActions()).toBe(true);
  });
  it('services timeout and server failure while stopped without retrying an action', () => {
    const { engine, sent, step, inventory, receive } = setup();
    inventory();
    engine.manualAction({ type: 'useItem', itemId: 501 });
    step(4000);
    step(2000);
    expect(engine.actionResult.status).toBe('failed');
    expect(engine.reason).toContain('No server confirmation');
    expect(sent).toHaveLength(1);
    engine.manualAction({ type: 'sit', sitting: true });
    receive({ type: 'requestFailure', reason: 3 });
    expect(engine.actionResult.status).toBe('failed');
    expect(engine.reason).toContain('rejected');
  });
  it('does not issue a manual action while server movement is still settling after stop', () => {
    const { engine, receive, step } = setup();
    const walk: Walk = {
      origin: { x: 100, y: 100 },
      cells: [
        { x: 100, y: 100 },
        { x: 101, y: 100 },
      ],
      secondsPerCell: 1,
      firstSeconds: 1,
      locked: false,
    };
    receive({ type: 'walk', id: 1, walk });
    expect(engine.idleForActions()).toBe(false);
    expect(() => engine.manualAction({ type: 'sit', sitting: true })).toThrow();
    step(1200);
    expect(engine.idleForActions()).toBe(true);
  });
});
describe('automation condition precedence', () => {
  it.each([false, true])(
    'evaluates the complete trace and prioritizes unavailable evidence with reversed=%s',
    (reverse) => {
      const { settings } = setup();
      const snapshot: ActorObservationSnapshot = {
        world: '11111111-1111-1111-1111-111111111111',
        at: 1000,
        lastFrameAt: 1000,
        connected: true,
        selfId: 1,
        targetId: null,
        actors: [
          {
            id: 1,
            incarnation: 1,
            kind: 0,
            name: 'Player',
            observedAt: 1000,
            statusesKnown: true,
            statuses: [],
            cast: { state: 'unknown', observedAt: null, deadline: null, skillId: null },
          },
        ],
      };
      const conditions: ActorPredicate[] = [
        {
          field: 'actorStatus',
          actor: { scope: 'self' },
          statusId: STATUS_CATALOG[0]!.id,
          operator: 'eq',
          value: true,
        },
        { field: 'actorCasting', actor: { scope: 'self' }, operator: 'eq', value: false },
      ];
      if (reverse) conditions.reverse();
      const before = structuredClone({ snapshot, conditions });
      const scheduler = new AutomationScheduler(
        () => {},
        () => 1000,
      );
      expect(scheduler.conditionState('Item 501', conditions, snapshot)).toBe('unavailable');
      expect(scheduler.ruleConditions[0]!.conditions.map((trace) => trace.state)).toEqual(
        reverse ? ['unavailable', 'unmatched'] : ['unmatched', 'unavailable'],
      );
      const automation = settings.automation!;
      automation.combat.rules = [{ classId: 4000, action: 'ignore', priority: 0, conditions }];
      // A known-false ignore rule would normally leave selection in control;
      // missing evidence must still prevent admission regardless of its position.
      expect(
        acceptsMonster(validateAutomation(automation), monster, player, [4000], false, snapshot),
      ).toBe(false);
      expect({ snapshot, conditions }).toEqual(before);
    },
  );
});
describe('character state and schedule boundaries', () => {
  it('preserves inventory, skills and cart across map and clear until a new connection', () => {
    const { engine, inventory, receive } = setup();
    inventory();
    receive({
      type: 'inventory',
      items: [{ bagId: 501, itemId: 501, count: 4, type: 1 }],
      cart: [{ bagId: 502, itemId: 502, count: 2, type: 1 }],
      equipment: [],
      ammoId: -1,
    });
    receive({ type: 'skills', learned: [{ skillId: 2, level: 1 }] });
    receive({
      type: 'inventory',
      items: [{ bagId: 501, itemId: 501, count: 3, type: 1 }],
      equipment: [],
      ammoId: -1,
    });
    expect(engine.character.cart?.[0]?.itemId).toBe(502);
    receive({ type: 'map', map: 'prontera' });
    receive({ type: 'clear' });
    expect(engine.character.inventoryKnown).toBe(true);
    expect(engine.character.skillsKnown).toBe(true);
    expect(engine.character.cart?.[0]?.count).toBe(2);
    engine.disconnect();
    expect(engine.character.inventoryKnown).toBe(false);
    expect(engine.character.skillsKnown).toBe(false);
  });
  it('does not mistake an inventory delta for a complete inventory', () => {
    const state = new CharacterState();
    state.apply(
      {
        type: 'inventoryDelta',
        add: true,
        bagId: 501,
        change: 1,
        weight: 10,
        item: { bagId: 501, itemId: 501, count: 1, type: 1 },
      },
      1,
    );
    expect(state.inventoryKnown).toBe(false);
  });
  it('invalidates a known inventory on an impossible unknown removal', () => {
    const state = new CharacterState();
    state.apply({ type: 'inventory', items: [], equipment: [], ammoId: -1 }, 1);
    state.apply({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 }, 1);
    expect(state.inventoryKnown).toBe(false);
  });
  it('supports an overnight schedule without restarting outside it', () => {
    const a = structuredClone(DEFAULT_AUTOMATION);
    a.schedule = { enabled: true, startHour: 22, endHour: 6 };
    expect(inSchedule(a, new Date(2026, 1, 1, 23).getTime())).toBe(true);
    expect(inSchedule(a, new Date(2026, 1, 1, 5).getTime())).toBe(true);
    expect(inSchedule(a, new Date(2026, 1, 1, 12).getTime())).toBe(false);
  });
  it('does not confirm an item from an unrelated inventory change', () => {
    let now = 1000;
    const state = new CharacterState();
    state.apply(
      {
        type: 'inventory',
        items: [
          { bagId: 501, itemId: 501, count: 4, type: 1 },
          { bagId: 502, itemId: 502, count: 4, type: 1 },
        ],
        equipment: [],
        ammoId: -1,
      },
      1,
    );
    const scheduler = new AutomationScheduler(
      () => {},
      () => now,
    );
    scheduler.submit({ type: 'useItem', itemId: 501 }, state);
    const event: FeatureEvent = {
      type: 'inventoryDelta',
      add: false,
      bagId: 502,
      change: 1,
      weight: 10,
    };
    state.apply(event, 1);
    expect(scheduler.observe(event, state, 1).state).toBe('ignored');
    now += 6000;
    expect(scheduler.timeout()).toContain('No server confirmation');
  });
});

describe('captured action receipts', () => {
  function inventory(count = 4): FeatureEvent {
    return {
      type: 'inventory',
      items: [{ bagId: 501, itemId: 501, count, type: 1 }],
      equipment: [],
      ammoId: -1,
    };
  }
  it.each([
    [{ type: 'requestFailure', reason: 3 }, 'Server rejected useItem (code 3).'],
    [{ type: 'skillFailure', reason: 4 }, 'Server rejected useItem (code 4).'],
    [
      { type: 'featureError', message: 'x'.repeat(130) },
      `Server rejected useItem: ${'x'.repeat(120)}`,
    ],
  ] as const)('tags rejection from %j without publishing the internal cause', (event, reason) => {
    const state = new CharacterState();
    state.apply(inventory(), 1);
    const scheduler = new AutomationScheduler(
      () => {},
      () => 1000,
    );
    scheduler.submit({ type: 'useItem', itemId: 501 }, state);
    const settlement = scheduler.observe(event, state, 1);
    expect(settlement).toEqual({
      state: 'rejected',
      failure: { type: 'server-rejection', reason },
    });
    expect(scheduler.result).toEqual({ sequence: 1, status: 'failed', reason });
    if (settlement.state === 'rejected') settlement.failure.reason = 'Changed observation text.';
    scheduler.result.reason = 'Translated display message.';
    expect(scheduler.result.reason).toBe(reason);
    expect(scheduler.retireReceipt(true)).toBe('rejected');
    expect(scheduler.receipt).toBeNull();
  });
  it.each(['cancel', 'timeout', 'send-failure'] as const)(
    'keeps %s resource uncertainty despite rejection-like display text',
    (cause) => {
      let now = 1000;
      const state = new CharacterState();
      state.apply(inventory(), 1);
      const scheduler = new AutomationScheduler(
        () => {
          if (cause === 'send-failure') throw Error('Send failed.');
        },
        () => now,
      );
      if (cause === 'send-failure')
        expect(() => scheduler.submit({ type: 'useItem', itemId: 501 }, state)).toThrow(
          'Send failed.',
        );
      else {
        scheduler.submit({ type: 'useItem', itemId: 501 }, state);
        if (cause === 'cancel') scheduler.reset();
        else {
          now += 6000;
          scheduler.timeout();
        }
      }
      const reason =
        cause === 'cancel'
          ? 'Action canceled.'
          : cause === 'timeout'
            ? 'No server confirmation for useItem.'
            : 'Connection failed while sending action.';
      expect(scheduler.result).toEqual({ sequence: 1, status: 'failed', reason });
      scheduler.result.reason = 'Server rejected useItem (code 3).';
      expect(scheduler.retireReceipt(true)).toBe('uncertain');
      expect(scheduler.receipt).toEqual({ sequence: 1, action: { type: 'useItem', itemId: 501 } });
    },
  );
  it('reserves the observed identity and receipt before a synchronous transport confirmation', () => {
    const identity = actionIdentity({
      world: '00000000-0000-0000-0000-000000000001',
      selfId: 1,
      selfIncarnation: 1,
      targetId: 2,
      targetIncarnation: 1,
    });
    const action = { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 } as const;
    const response: SkillResult = {
      type: 'skillResult',
      mode: 'target',
      source: 1,
      target: 2,
      skillId: 3,
      level: 1,
      motionSeconds: 0,
      position: { x: 100, y: 100 },
    };
    const state = new CharacterState(),
      order: string[] = [];
    const scheduler = new AutomationScheduler(
      () => {
        expect(order).toEqual(['reserved']);
        expect(scheduler.pendingIdentity).toEqual(identity);
        expect(scheduler.receipt).toEqual({ sequence: 1, action });
        order.push('send');
        expect(scheduler.observe(response, state, 1)).toEqual({ state: 'confirmed' });
      },
      () => 1000,
      () => identity,
    );
    scheduler.submit(action, state, undefined, 0, {
      receipt: () => true,
      reserved: (sequence, observed) => {
        expect(sequence).toBe(1);
        expect(observed).toEqual(identity);
        order.push('reserved');
      },
    });
    expect(order).toEqual(['reserved', 'send']);
    expect(scheduler.result).toEqual({
      sequence: 1,
      status: 'confirmed',
      reason: 'skill confirmed by the server.',
    });
    expect(scheduler.receipt).toBeNull();
    expect(scheduler.observe(response, state, 1)).toEqual({ state: 'ignored' });
  });
  it('captures before transport reentry and keeps the original baseline after cancellation', () => {
    let now = 1000;
    const state = new CharacterState();
    state.apply(inventory(), 1);
    const scheduler = new AutomationScheduler(
      () => {
        expect(scheduler.receipt).toEqual({
          sequence: 1,
          action: { type: 'useItem', itemId: 501 },
        });
        state.apply(inventory(3), 1);
        scheduler.reset();
      },
      () => now,
    );
    scheduler.submit({ type: 'useItem', itemId: 501 }, state);
    expect(scheduler.reconcileReceipt([], state, 1, validateAutomation(DEFAULT_AUTOMATION))).toBe(
      1,
    );
    expect(scheduler.receipt).toBeNull();
    expect(scheduler.result.status).toBe('failed');
    expect(scheduler.busy).toBe(true);
    now += 6000;
    expect(scheduler.busy).toBe(false);
  });
  it('requires active item event evidence but accepts complete late inventory readback', () => {
    let now = 1000;
    const state = new CharacterState();
    state.apply(inventory(), 1);
    const scheduler = new AutomationScheduler(
      () => {},
      () => now,
    );
    scheduler.submit({ type: 'useItem', itemId: 501 }, state);
    const readback = inventory(3);
    state.apply(readback, 1);
    expect(scheduler.observe(readback, state, 1).state).toBe('ignored');
    expect(
      scheduler.reconcileReceipt([readback], state, 1, validateAutomation(DEFAULT_AUTOMATION)),
    ).toBeNull();
    now += 6000;
    expect(scheduler.timeout()).toContain('No server confirmation');
    expect(scheduler.retireReceipt(true)).toBe('uncertain');
    expect(
      scheduler.reconcileReceipt([readback], state, 1, validateAutomation(DEFAULT_AUTOMATION)),
    ).toBe(1);
    expect(scheduler.result.status).toBe('failed');
  });
  it('retains transmitted resource uncertainty when sending throws', () => {
    const state = new CharacterState();
    state.apply(inventory(), 1);
    const scheduler = new AutomationScheduler(
      () => {
        throw new Error('Socket write failed.');
      },
      () => 1000,
    );
    expect(() => scheduler.submit({ type: 'useItem', itemId: 501 }, state)).toThrow(
      'Socket write failed',
    );
    expect(scheduler.retireReceipt(true)).toBe('uncertain');
    state.apply(inventory(3), 1);
    expect(scheduler.reconcileReceipt([], state, 1, validateAutomation(DEFAULT_AUTOMATION))).toBe(
      1,
    );
  });
  it('keeps late skill identity, exact execution, motion and the canceled deadline', () => {
    let now = 1000,
      identity = actionIdentity({
        world: '00000000-0000-0000-0000-000000000001',
        selfId: 0,
        selfIncarnation: 1,
        targetId: 2,
        targetIncarnation: 1,
      });
    const state = new CharacterState(),
      scheduler = new AutomationScheduler(
        () => {},
        () => now,
        () => identity,
      );
    scheduler.submit(
      { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 },
      state,
      undefined,
      1,
    );
    scheduler.reset();
    const response: SkillResult = {
      type: 'skillResult',
      mode: 'target',
      source: 0,
      target: 2,
      skillId: 3,
      level: 1,
      motionSeconds: 2,
      position: { x: 100, y: 100 },
      indirect: false,
    };
    identity = actionIdentity({ ...identity, targetId: 2, targetIncarnation: 2 });
    expect(
      scheduler.reconcileReceipt([response], state, 0, validateAutomation(DEFAULT_AUTOMATION)),
    ).toBeNull();
    identity = actionIdentity({ ...identity, targetIncarnation: 1 });
    expect(
      scheduler.reconcileReceipt(
        [{ ...response, target: 3 }],
        state,
        0,
        validateAutomation(DEFAULT_AUTOMATION),
      ),
    ).toBeNull();
    expect(
      scheduler.reconcileReceipt([response], state, 0, validateAutomation(DEFAULT_AUTOMATION)),
    ).toBe(1);
    expect(scheduler.result.status).toBe('failed');
    now += 29999;
    expect(scheduler.busy).toBe(true);
    now++;
    expect(scheduler.busy).toBe(false);
  });
  it('applies configured late after-cast motion even when an active rule used the default', () => {
    let now = 1000;
    const state = new CharacterState(),
      scheduler = new AutomationScheduler(
        () => {},
        () => now,
      );
    scheduler.submit(
      { type: 'skill', mode: 'ground', skillId: 19, level: 1, position: { x: 100, y: 100 } },
      state,
    );
    scheduler.reset();
    now += 30000;
    const response: SkillResult = {
      type: 'skillResult',
      mode: 'ground',
      source: 1,
      skillId: 19,
      level: 1,
      motionSeconds: 0,
      position: { x: 100, y: 100 },
      targetPosition: { x: 100, y: 100 },
      indirect: false,
    };
    expect(
      scheduler.reconcileReceipt([response], state, 1, validateAutomation(DEFAULT_AUTOMATION)),
    ).toBe(1);
    now += 1499;
    expect(scheduler.busy).toBe(true);
    now++;
    expect(scheduler.busy).toBe(false);
  });
});

describe('self cast server response correlation', () => {
  it.each([41, 42, 44])(
    'confirms direct targeted-on-self response for support skill %i',
    (skillId) => {
      let now = 1000;
      const state = new CharacterState();
      const scheduler = new AutomationScheduler(
        () => {},
        () => now,
      );
      scheduler.submit({ type: 'skill', mode: 'self', skillId, level: 3 }, state);
      // Heal and the generic support-skill handler emit the targeted form even
      // when AttemptStartSelfTargetSkill selected the source as its own target.
      const response: SkillResult = {
        type: 'skillResult',
        mode: 'target',
        source: 1,
        target: 1,
        attacker: 1,
        skillId,
        level: 3,
        position: { x: 100, y: 100 },
        motionSeconds: 2,
        damage: 0,
        result: 0,
        hits: 1,
        damageSeconds: 0,
        indirect: false,
      };
      for (const mismatch of [
        { ...response, target: 2 },
        { ...response, source: 2 },
        { ...response, skillId: 99 },
        { ...response, level: 2 },
        { ...response, indirect: true },
      ])
        expect(scheduler.observe(mismatch, state, 1).state).toBe('ignored');
      expect(scheduler.observe(response, state, 1).state).toBe('confirmed');
      expect(scheduler.result.status).toBe('confirmed');
      expect(scheduler.busy).toBe(true);
      now += 2000;
      expect(scheduler.busy).toBe(false);
      expect(scheduler.timeout()).toBeNull();
    },
  );
  it('keeps explicitly targeted casts correlated to the requested target', () => {
    const state = new CharacterState(),
      scheduler = new AutomationScheduler(
        () => {},
        () => 1000,
      );
    scheduler.submit({ type: 'skill', mode: 'target', skillId: 41, level: 1, target: 2 }, state);
    const response: SkillResult = {
      type: 'skillResult',
      mode: 'target',
      source: 1,
      target: 1,
      skillId: 41,
      level: 1,
      position: { x: 100, y: 100 },
      motionSeconds: 0,
      indirect: false,
    };
    expect(scheduler.observe(response, state, 1).state).toBe('ignored');
    expect(scheduler.observe({ ...response, target: 2 }, state, 1).state).toBe('confirmed');
  });
});

describe('bounded skill confirmation deadlines', () => {
  it('allows the source twelve-second Magnus cast to finish without retrying', () => {
    let now = 1000,
      sends = 0;
    const scheduler = new AutomationScheduler(
        () => {
          sends++;
        },
        () => now,
      ),
      state = new CharacterState();
    scheduler.submit(
      { type: 'skill', mode: 'ground', skillId: 85, level: 1, position: { x: 100, y: 100 } },
      state,
    );
    now += 6000;
    expect(scheduler.timeout()).toBeNull();
    expect(scheduler.result.status).toBe('pending');
    now += 6000;
    expect(
      scheduler.observe(
        {
          type: 'skillResult',
          mode: 'ground',
          source: 1,
          skillId: 85,
          level: 1,
          position: { x: 100, y: 100 },
          targetPosition: { x: 100, y: 100 },
          motionSeconds: 0,
          indirect: false,
        },
        state,
        1,
      ).state,
    ).toBe('confirmed');
    expect(scheduler.result.status).toBe('confirmed');
    expect(sends).toBe(1);
  });
  it('fails a skill exactly at the thirty-second policy limit without resending', () => {
    let now = 1000,
      sends = 0;
    const scheduler = new AutomationScheduler(
        () => {
          sends++;
        },
        () => now,
      ),
      state = new CharacterState();
    scheduler.submit({ type: 'skill', mode: 'self', skillId: 4, level: 1 }, state);
    now += 29999;
    expect(scheduler.timeout()).toBeNull();
    now++;
    expect(scheduler.timeout()).toContain('No server confirmation for skill');
    expect(scheduler.result.status).toBe('failed');
    expect(sends).toBe(1);
  });
  it('keeps a canceled skill fenced through its original skill deadline', () => {
    let now = 1000;
    const scheduler = new AutomationScheduler(
        () => {},
        () => now,
      ),
      state = new CharacterState();
    scheduler.submit({ type: 'skill', mode: 'self', skillId: 4, level: 1 }, state);
    now += 3000;
    scheduler.reset();
    now += 3000;
    expect(scheduler.busy).toBe(true);
    expect(() =>
      scheduler.submit({ type: 'skill', mode: 'self', skillId: 4, level: 1 }, state),
    ).toThrow();
    now = 30999;
    expect(scheduler.busy).toBe(true);
    now++;
    expect(scheduler.busy).toBe(false);
    expect(scheduler.result.status).toBe('failed');
  });
  it('keeps ordinary actions at six seconds and clears canceled ownership on a new connection', () => {
    expect(actionConfirmationTimeout({ type: 'skill' })).toBe(30000);
    for (const type of ['sit', 'useItem', 'equip', 'respawn', 'allocateSkill', 'allocateStats'])
      expect(actionConfirmationTimeout({ type })).toBe(6000);
    let now = 1000;
    const scheduler = new AutomationScheduler(
        () => {},
        () => now,
      ),
      state = new CharacterState();
    scheduler.submit({ type: 'sit', sitting: true }, state);
    now += 5999;
    expect(scheduler.timeout()).toBeNull();
    now++;
    expect(scheduler.timeout()).toContain('No server confirmation for sit');
    scheduler.submit({ type: 'skill', mode: 'self', skillId: 4, level: 1 }, state);
    scheduler.reset();
    expect(scheduler.busy).toBe(true);
    scheduler.reset(true);
    expect(scheduler.busy).toBe(false);
  });
});

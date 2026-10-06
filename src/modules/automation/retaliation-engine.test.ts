import { describe, expect, it, vi } from 'vitest';
import { BotEngine, DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Action, type Settings } from './engine';
import { GridNavigator, type WalkGrid } from '../navigation/navigation';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy';
import type { Entity, GameEvent } from '../protocol/protocol';
import type { FeatureEvent, SkillResult } from '../protocol/protocol-feature';

const player: Entity = { id: 1, kind: 0, classId: 2, name: 'Mage', level: 10, hp: 100, maxHp: 100, sp: 200, maxSp: 200, x: 2, y: 2, dead: false, statuses: [] };
const selected: Entity = { id: 2, kind: 1, classId: 4000, name: 'Selected', level: 1, hp: 100, maxHp: 100, x: 3, y: 2, dead: false, statuses: [] };
const attacker: Entity = { ...selected, id: 3, classId: 4001, name: 'Attacker', x: 4 };
const openGrid: WalkGrid = { width: 30, height: 30, walkable: () => true };
function setup(grid = openGrid) {
  let now = 100_000;
  const sent: Action[] = [];
  const engine = new BotEngine(action => sent.push(action), () => now, () => grid);
  const receive = (...events: Array<GameEvent | FeatureEvent>) => engine.receive(events);
  engine.connect(true);
  receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } },
    { type: 'spawn', entity: { ...selected } }, { type: 'spawn', entity: { ...attacker } });
  const settings: Settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [selected.classId], radius: 20,
    route_avoidWalls: false, automation: structuredClone(DEFAULT_AUTOMATION) };
  settings.automation!.combat.mode = 'both';
  settings.automation!.combat.rules = [{ classId: selected.classId, action: 'attack', priority: 100 }];
  const step = (ms = 100) => { now += ms; engine.tick(); };
  const observeAttack = (source = attacker.id, target = player.id) => receive({ type: 'attack', source, target, position: { x: attacker.x, y: attacker.y } });
  const enableSkills = () => {
    receive({ type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 }, { type: 'skills', learned: [{ skillId: 11, level: 1 }] });
    settings.automation!.attackStrategies = [{ id: 'bolt', speciesIds: [selected.classId, attacker.classId], skillId: 11, level: 1,
      behavior: 'opener', maxAttempts: 2, maxUses: 1, cooldownSeconds: 1 }];
  };
  const acceptLeg = () => {
    const cells = engine.snapshot().navigation!.leg;
    expect(cells.length).toBeGreaterThan(1);
    receive({ type: 'walk', id: player.id, walk: { origin: cells[0]!, cells, secondsPerCell: .1, firstSeconds: .1, locked: false } });
    return cells;
  };
  return { engine, settings, sent, receive, step, observeAttack, enableSkills, acceptLeg };
}
const damagingSkill = (extra: Partial<SkillResult> = {}): SkillResult => ({ type: 'skillResult', mode: 'target', source: attacker.id,
  target: player.id, skillId: 11, level: 1, position: { x: attacker.x, y: attacker.y }, motionSeconds: 0, indirect: false, damage: 5, ...extra });

describe('own-character monster defense', () => {
  it('prioritizes an unselected observed attacker over a maximum-priority selected nonattacker', () => {
    const f = setup(); f.observeAttack(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'attack', id: attacker.id }]);
  });

  it('defends before starting a new loot action', () => {
    const f = setup(); f.settings.automation!.loot.ownership = 'all';
    f.receive({ type: 'drop', drop: { id: 900, itemId: 909, count: 1, isNew: false, x: 2, y: 2 } });
    f.observeAttack(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'attack', id: attacker.id }]);
  });

  it('does not carry aggression into a replacement own-character lifetime', () => {
    const f = setup(); f.settings.automation!.combat.mode = 'retaliate'; f.observeAttack();
    f.receive({ type: 'spawn', entity: { ...player } }); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([]);
  });

  it.each(['retaliate', 'both'] as const)('attacks an unselected monster after actual own-character attack in %s mode', mode => {
    const f = setup(); f.settings.automation!.combat = { mode, levelDifference: 1, rules: [] };
    f.receive({ type: 'remove', id: selected.id, dead: false });
    f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([]);
    f.observeAttack(); f.step(); expect(f.sent).toEqual([{ type: 'attack', id: attacker.id }]);
  });

  it.each(['selected', 'off'] as const)('preserves %s mode instead of opting in to defense', mode => {
    const f = setup(); f.settings.automation!.combat.mode = mode; f.observeAttack(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual(mode === 'selected' ? [{ type: 'attack', id: selected.id }] : []);
  });

  it('preserves the legacy default selection mode', () => {
    const f = setup(); f.settings.automation = undefined; f.observeAttack(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'attack', id: selected.id }]);
  });

  it.each(['normal', 'skill'] as const)('falls back to a reachable selected target when the %s attacker is unreachable', strategy => {
    const f = setup({ width: 30, height: 30, walkable: p => p.x !== 6, seeThrough: p => p.x !== 6 });
    if (strategy === 'skill') f.enableSkills();
    f.receive({ type: 'position', id: attacker.id, position: { x: 10, y: 2 } });
    f.receive({ type: 'attack', source: attacker.id, target: player.id, position: { x: 10, y: 2 } });
    f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual(strategy === 'normal' ? [{ type: 'attack', id: selected.id }]
      : [{ type: 'skill', mode: 'target', skillId: 11, level: 1, target: selected.id }]);
  });

  it('uses the same attacker-first tier for a learned attack skill', () => {
    const f = setup(); f.enableSkills(); f.observeAttack(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'skill', mode: 'target', skillId: 11, level: 1, target: attacker.id }]);
  });

  it.each([undefined, -1, attacker.id])('admits a direct damaging monster skill with damage owner %s', owner => {
    const f = setup(); f.receive(damagingSkill({ attacker: owner })); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'attack', id: attacker.id }]);
  });

  it.each([
    { indirect: true }, { indirect: undefined }, { attacker: selected.id }, { damage: 0 }, { damage: -10 },
    { mode: 'ground' as const }, { mode: 'self' as const }, { target: 99 }, { source: 99 },
  ])('rejects ambiguous or nondamaging skill evidence %j', extra => {
    const f = setup(); f.settings.automation!.combat.mode = 'retaliate'; f.receive(damagingSkill(extra));
    f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([]);
  });

  it.each(['no attack', 'other player', 'unknown source', 'player source', 'NPC source', 'hit', 'marker', 'skill impact'] as const)
    ('does not infer own-character aggression from %s', evidence => {
      const f = setup(); f.settings.automation!.combat.mode = 'retaliate';
      if (evidence === 'other player') f.observeAttack(attacker.id, 99);
      if (evidence === 'unknown source') f.observeAttack(99);
      if (evidence === 'player source' || evidence === 'NPC source') {
        f.receive({ type: 'spawn', entity: { ...attacker, kind: evidence === 'player source' ? 0 : 2 } }); f.observeAttack();
      }
      if (evidence === 'hit') f.receive({ type: 'hit', id: player.id, damage: 1, position: { x: player.x, y: player.y } });
      if (evidence === 'marker') f.receive({ type: 'tracking', id: attacker.id, position: { x: attacker.x, y: attacker.y } });
      if (evidence === 'skill impact') f.receive({ type: 'skillImpact', source: attacker.id, target: player.id,
        position: { x: player.x, y: player.y }, damage: 5, damageSeconds: 0, skillId: 11, hits: 1, result: 0 });
      f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([]);
    });

  it('never lends a later source spawn to an earlier attack', () => {
    const f = setup(); f.settings.automation!.combat.mode = 'retaliate';
    f.receive({ type: 'remove', id: attacker.id, dead: false });
    f.receive({ type: 'attack', source: attacker.id, target: player.id, position: { x: 4, y: 2 } }, { type: 'spawn', entity: { ...attacker } });
    f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([]);
    f.observeAttack(); f.step(); expect(f.sent).toEqual([{ type: 'attack', id: attacker.id }]);
  });

  it.each([{ selfId: 0, targetId: 3 }, { selfId: 1, targetId: 0 }])('defends with protocol actor zero (%j)', ids => {
    const f = setup();
    f.receive({ type: 'enter', id: ids.selfId, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player, id: ids.selfId } },
      { type: 'spawn', entity: { ...selected } }, { type: 'spawn', entity: { ...attacker, id: ids.targetId } },
      { type: 'attack', source: ids.targetId, target: ids.selfId, position: { x: 4, y: 2 } });
    f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([{ type: 'attack', id: ids.targetId }]);
  });

  it.each(['target spawn', 'target removal', 'target death', 'target zero HP', 'self removal', 'self death', 'self resurrection', 'clear', 'map', 'disconnect'] as const)
    ('retires attack evidence across %s', boundary => {
      const f = setup(); f.settings.automation!.combat.mode = 'retaliate'; f.observeAttack();
      if (boundary === 'target spawn') f.receive({ type: 'spawn', entity: { ...attacker } });
      if (boundary === 'target removal' || boundary === 'target death') f.receive({ type: 'remove', id: attacker.id, dead: boundary === 'target death' }, { type: 'spawn', entity: { ...attacker } });
      if (boundary === 'target zero HP') f.receive({ type: 'hit', id: attacker.id, damage: attacker.hp, position: { x: attacker.x, y: attacker.y } }, { type: 'heal', id: attacker.id, hp: attacker.hp, maxHp: attacker.maxHp });
      if (boundary === 'self removal') f.receive({ type: 'remove', id: player.id, dead: false }, { type: 'spawn', entity: { ...player } });
      if (boundary === 'self death') f.receive({ type: 'death', id: player.id }, { type: 'resurrection', id: player.id, hp: player.hp, position: { x: player.x, y: player.y } });
      if (boundary === 'self resurrection') f.receive({ type: 'resurrection', id: player.id, hp: player.hp, position: { x: player.x, y: player.y } });
      if (boundary === 'clear' || boundary === 'map' || boundary === 'disconnect') {
        if (boundary === 'clear') f.receive({ type: 'clear' });
        if (boundary === 'map') f.receive({ type: 'map', map: 'prt_fild08' });
        if (boundary === 'disconnect') { f.engine.disconnect(); f.engine.connect(true); f.receive({ type: 'enter', id: 1, map: 'prt_fild08' }); }
        f.receive({ type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...selected } }, { type: 'spawn', entity: { ...attacker } });
      }
      f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([]);
    });

  it.each(['ignore', 'level', 'radius', 'area', 'foreign engagement', 'zero HP', 'dead', 'unmatched condition', 'unknown condition'] as const)
    ('preserves the %s eligibility guard while defending', guard => {
      const f = setup();
      if (guard === 'ignore') f.settings.automation!.combat.rules.push({ classId: attacker.classId, action: 'ignore', priority: 0 });
      if (guard === 'level') f.receive({ type: 'spawn', entity: { ...attacker, level: player.level + 2 } });
      if (guard === 'radius') f.settings.radius = 1;
      if (guard === 'area') f.settings.automation!.mapPolicy = { ...structuredClone(DEFAULT_MAP_POLICY), lockArea: { map: 'prt_fild08', minX: 0, minY: 0, maxX: 3, maxY: 20 } };
      if (guard === 'foreign engagement') f.observeAttack(99, attacker.id);
      if (guard === 'zero HP' || guard === 'dead') f.receive({ type: 'spawn', entity: { ...attacker, hp: 0, dead: guard === 'dead' } });
      if (guard === 'unmatched condition' || guard === 'unknown condition') {
        f.settings.automation!.combat.rules.push({ classId: attacker.classId, action: 'attack', priority: 0,
          conditions: [{ field: 'actorHpPercent', actor: { scope: 'candidate' }, operator: 'lt', value: 50 }] });
        if (guard === 'unknown condition') f.receive({ type: 'spawn', entity: { ...attacker, maxHp: 0 } });
      }
      f.observeAttack(); f.engine.start(f.settings); f.step();
      expect(f.sent).toEqual([{ type: 'attack', id: selected.id }]);
    });

  it('keeps the HP safety stop ahead of retaliation', () => {
    const f = setup(); f.engine.start(f.settings); f.observeAttack();
    f.receive({ type: 'hit', id: player.id, damage: 60, position: { x: player.x, y: player.y } }); f.step();
    expect(f.engine.running).toBe(false); expect(f.sent).toEqual([{ type: 'stop' }]);
  });

  it('preserves the original run kill budget while an attacker is waiting', () => {
    const f = setup(); f.settings.automation!.limits.kills = 1; f.engine.start(f.settings); f.step(); f.observeAttack();
    f.receive({ type: 'remove', id: selected.id, dead: true }); f.step();
    expect(f.engine.running).toBe(false); expect(f.engine.reason).toBe('Configured session limit reached.');
    expect(f.sent).toEqual([{ type: 'attack', id: selected.id }, { type: 'stop' }]);
  });

  it('preserves species priority and stable routing ties among attackers', () => {
    const f = setup(); f.observeAttack(selected.id); f.observeAttack(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'attack', id: selected.id }]);
  });

  it('lets an accepted pickup settle before defense and does not repeatedly Stop', () => {
    const f = setup(); f.settings.automation!.loot.ownership = 'all';
    f.receive({ type: 'drop', drop: { id: 900, itemId: 909, count: 1, isNew: false, x: 2, y: 2 } });
    f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([{ type: 'pickup', id: 900 }]);
    f.observeAttack(); f.step(); f.step(); expect(f.sent).toHaveLength(1);
    f.receive({ type: 'pickup', id: 900, picker: player.id }); f.step();
    expect(f.sent).toEqual([{ type: 'pickup', id: 900 }, { type: 'attack', id: attacker.id }]);
  });

  it('keeps a dispatched normal engagement until its receipt settles', () => {
    const f = setup(); f.engine.start(f.settings); f.step();
    f.receive({ type: 'attack', source: player.id, target: selected.id, position: { x: player.x, y: player.y } });
    f.observeAttack(); f.step(); f.step(); expect(f.sent).toEqual([{ type: 'attack', id: selected.id }]);
    f.receive({ type: 'remove', id: selected.id, dead: true }); f.step();
    expect(f.sent).toEqual([{ type: 'attack', id: selected.id }, { type: 'attack', id: attacker.id }]);
    expect(f.engine.kills).toBe(1); expect(f.engine.runIntent).toBe(true);
  });

  it('waits for an in-flight attack skill and its cooldown before selecting defense', () => {
    const f = setup(); f.enableSkills(); f.engine.start(f.settings); f.step();
    expect(f.sent).toEqual([{ type: 'skill', mode: 'target', skillId: 11, level: 1, target: selected.id }]);
    f.observeAttack(); f.step(); expect(f.sent).toHaveLength(1);
    f.receive(damagingSkill({ source: player.id, target: selected.id })); f.step(500); expect(f.sent).toHaveLength(1);
    f.receive({ type: 'sp', sp: 200, maxSp: 200 }); f.step(600);
    expect(f.sent.at(-1)).toEqual({ type: 'skill', mode: 'target', skillId: 11, level: 1, target: attacker.id });
    expect(f.engine.snapshot().attackStrategies.entries.find(entry => entry.id === selected.id)?.rules[0]?.uses).toBe(1);
  });

  it('waits for a pending potion receipt before selecting defense', () => {
    const f = setup(); f.settings.automation!.items = [{ itemId: 501, resource: 'hp', belowPercent: 90, minStock: 1, cooldownSeconds: 10 }];
    f.receive({ type: 'inventory', items: [{ bagId: 77, itemId: 501, count: 2, type: 1 }], equipment: [], ammoId: -1 },
      { type: 'hit', id: player.id, damage: 25, position: { x: player.x, y: player.y } });
    f.engine.start(f.settings); f.step(); expect(f.sent).toEqual([{ type: 'useItem', itemId: 501 }]);
    f.observeAttack(); f.step(); f.step(); expect(f.sent).toHaveLength(1);
    f.receive({ type: 'inventoryDelta', add: false, bagId: 77, change: 1, weight: 0 }); f.step();
    expect(f.sent).toEqual([{ type: 'useItem', itemId: 501 }, { type: 'attack', id: attacker.id }]);
  });

  it('waits for an observed official movement before selecting defense', () => {
    const f = setup(); f.settings.automation!.combat.mode = 'retaliate'; f.engine.start(f.settings);
    f.engine.officialGameplay();
    f.receive({ type: 'walk', id: player.id, walk: { origin: { x: 2, y: 2 }, cells: [{ x: 2, y: 2 }, { x: 3, y: 2 }], secondsPerCell: 1, firstSeconds: 1, locked: false } });
    f.observeAttack(); f.step(); expect(f.sent).toEqual([]); f.step(1100);
    expect(f.sent).toEqual([{ type: 'attack', id: attacker.id }]);
  });

  it('fences an unacknowledged walk when an unsent search route becomes defense', () => {
    const f = setup(); f.settings.targets = []; f.settings.automation!.combat = { mode: 'retaliate', levelDifference: 1, rules: [] };
    f.settings.route_randomWalk = 2;
    const random = vi.spyOn(GridNavigator.prototype, 'randomGoal').mockReturnValue({ x: 15, y: 2 });
    try {
      f.engine.start(f.settings); f.step(); f.observeAttack();
      for (let n = 0; n < 4; n++) f.step(1000);
      expect(f.sent).toHaveLength(1); f.step(100); expect(f.sent.map(action => action.type)).toEqual(['walk', 'stop']);
      f.receive({ type: 'attack', source: player.id, target: attacker.id, position: { x: 2, y: 2 } }); f.step();
      expect(f.sent.map(action => action.type)).toEqual(['walk', 'stop']);
      f.receive({ type: 'stop', id: player.id }); f.step();
      expect(f.sent.at(-1)).toEqual({ type: 'attack', id: attacker.id });
      expect(f.engine.running).toBe(true); expect(f.engine.runIntent).toBe(true);
    } finally { random.mockRestore(); }
  });

  it.each(['search', 'follow', 'pickup', 'skill', 'attack'] as const)
    ('replaces unsent %s route intent while retaining its accepted walk leg', route => {
      const barrier: WalkGrid = { width: 30, height: 30, walkable: p => p.x !== 6 || p.y === 10, seeThrough: p => p.x !== 6 || p.y === 10 };
      const f = setup(route === 'attack' ? barrier : openGrid);
      const random = vi.spyOn(GridNavigator.prototype, 'randomGoal').mockReturnValue({ x: 15, y: 2 });
      try {
        f.settings.attackMaxRouteTime = 10;
        if (route === 'skill') { f.enableSkills(); f.receive({ type: 'position', id: selected.id, position: { x: 20, y: 2 } }); }
        else if (route === 'attack') f.receive({ type: 'position', id: selected.id, position: { x: 10, y: 2 } });
        else {
          f.settings.targets = []; f.settings.automation!.combat.rules = []; f.settings.automation!.combat.mode = 'retaliate';
          if (route === 'search') f.settings.route_randomWalk = 2;
          if (route === 'follow') {
            f.settings.automation!.follow = { name: 'Leader', distance: 2, lostSeconds: 30 };
            f.receive({ type: 'spawn', entity: { ...player, id: 4, name: 'Leader', x: 15 } });
          }
          if (route === 'pickup') {
            f.settings.automation!.loot.ownership = 'all';
            f.receive({ type: 'drop', drop: { id: 900, itemId: 909, count: 1, isNew: false, x: 15, y: 2 } });
          }
        }
        f.engine.start(f.settings); f.step(); expect(f.sent[0]?.type).toBe('walk');
        const cells = f.acceptLeg(); f.observeAttack(); f.step();
        expect(f.sent).toHaveLength(1); expect(f.engine.snapshot().navigation!.leg).toEqual(cells);
        expect(f.engine.snapshot().navigation!.mode).toBe(route === 'skill' ? 'skill' : 'attack');
        f.step(1200);
        expect(f.sent.some(action => action.type === 'stop' || action.type === 'pickup' || action.type === 'attack' && action.id === selected.id)).toBe(false);
        expect(f.sent.at(-1)).toEqual(route === 'skill' ? { type: 'skill', mode: 'target', skillId: 11, level: 1, target: attacker.id } : { type: 'attack', id: attacker.id });
        expect(f.engine.runIntent).toBe(true);
      } finally { random.mockRestore(); }
    });
});

import { expect, it, vi } from 'vitest';
import { BotEngine, DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Action } from '../automation/engine';
import { GridNavigator, minimumRouteCost, type RouteOptions, type WalkGrid } from './navigation';
import type { Entity, Position } from '../protocol/protocol';
import { attackDistance } from '../combat/combat';

const at = (x: number, y: number): Position => ({ x, y });
const movementCost = (cells: Position[]) =>
  cells.reduce(
    (cost, p, i) => cost + (i ? (p.x !== cells[i - 1]!.x && p.y !== cells[i - 1]!.y ? 14 : 10) : 0),
    0,
  );

it('separates attack goal and range cache entries and defensively copies firing routes', () => {
  const grid: WalkGrid = {
    width: 12,
    height: 10,
    walkable: (p) => p.x !== 3 || p.y === 8,
    seeThrough: () => true,
  };
  const nav = new GridNavigator(grid),
    from = at(1, 2),
    to = at(6, 2);
  const walk = nav.plan(from, to, { range: 5, avoidWalls: false })!;
  expect(walk.length).toBeGreaterThan(1);
  const firing = nav.plan(from, to, { range: 5, goal: 'attack', avoidWalls: false })!;
  expect(firing).toEqual([from]);
  firing[0]!.x = -1;
  expect(nav.plan(from, to, { range: 5, goal: 'attack', avoidWalls: false })).toEqual([from]);
  for (const options of [
    { range: 2, goal: 'attack' },
    { range: 5, goal: 'attack', maxDistance: 0 },
    { range: 5, goal: 'attack', avoidWalls: true },
    { range: 5, goal: 'walk', avoidWalls: false },
  ] satisfies RouteOptions[])
    expect(nav.plan(from, to, options)).toEqual(new GridNavigator(grid).plan(from, to, options));
  expect(nav.plan(to, from, { range: 5, goal: 'attack' })).toEqual([to]);
});

it('uses projectile firing goals in capped preflight across separate walking components', () => {
  const grid: WalkGrid = {
    width: 400,
    height: 400,
    walkable: (p) => p.x !== 200,
    seeThrough: () => true,
  };
  const nav = new GridNavigator(grid),
    from = at(199, 200),
    to = at(202, 200);
  expect(nav.plan(from, to, { range: 3, maxDistance: 0 })).toBeNull();
  expect(nav.plan(from, to, { range: 3, maxDistance: 0, goal: 'attack' })).toEqual([from]);
  expect(nav.plan(from, to, { range: 1, maxDistance: 20, goal: 'attack' })).toBeNull();
});

it('invalidates positive and negative ranged caches when temporary movement blocks change or expire', () => {
  const grid: WalkGrid = {
    width: 8,
    height: 5,
    walkable: (p) => p.x !== 4,
    seeThrough: () => true,
  };
  const nav = new GridNavigator(grid),
    from = at(1, 2),
    to = at(6, 2);
  const options: RouteOptions = { range: 3, maxDistance: 2, avoidWalls: false, goal: 'attack' };
  nav.time(1000);
  const clear = nav.plan(from, to, options)!;
  expect(clear.length).toBe(3);
  for (let y = 0; y < 5; y++) nav.temporaryBlocked(at(2, y), 2000);
  expect(nav.plan(from, to, options)).toBeNull();
  const calls = vi.spyOn(nav, 'connected');
  expect(nav.plan(from, to, options)).toBeNull();
  expect(calls).not.toHaveBeenCalled();
  for (let y = 0; y < 5; y++) nav.temporaryBlocked(at(2, y), 3000);
  nav.time(2000);
  expect(nav.plan(from, to, options)).toBeNull();
  expect(calls).not.toHaveBeenCalled();
  nav.time(3000);
  expect(nav.plan(from, to, options)).toEqual(clear);
  expect(calls).toHaveBeenCalled();
});

it('bounds attack cache entries while preserving recent exact firing plans', () => {
  const nav = new GridNavigator({ width: 40, height: 12, walkable: () => true });
  const from = at(2, 5),
    to = at(14, 5),
    options: RouteOptions = { range: 5, goal: 'attack', avoidWalls: false };
  const initial = nav.plan(from, to, options);
  for (let cap = 100; cap < 360; cap++)
    expect(nav.plan(from, to, { ...options, maxDistance: cap })).toEqual(initial);
  expect(Reflect.get(nav, 'routeCache').size).toBeLessThanOrEqual(256);
  expect(Reflect.get(nav, 'cachedCells')).toBeLessThanOrEqual(4096);
  const calls = vi.spyOn(nav, 'connected');
  expect(nav.plan(from, to, { ...options, maxDistance: 359 })).toEqual(initial);
  expect(calls).not.toHaveBeenCalled();
  expect(nav.plan(from, to, options)).toEqual(initial);
  expect(calls).toHaveBeenCalled();
});

it('keeps scratch reuse and capped fallback equal to fresh searches for mixed goal modes', () => {
  const grid: WalkGrid = {
    width: 80,
    height: 80,
    walkable: (p) => !(p.x === 40 && p.y > 35 && p.y < 45),
    seeThrough: (p) => !(p.x === 40 && p.y > 38 && p.y < 43),
  };
  const nav = new GridNavigator(grid);
  for (let i = 0; i < 90; i++) {
    const from = at(36 + (i % 2), 37 + (i % 5)),
      to = at(44 + (i % 3), 37 + (i % 7));
    const options: RouteOptions = {
      range: i % 6,
      maxDistance: i % 14,
      avoidWalls: i % 2 === 0,
      goal: i % 3 === 0 ? 'walk' : 'attack',
    };
    expect(nav.plan(from, to, options)).toEqual(new GridNavigator(grid).plan(from, to, options));
  }
});

it('retains an admissible square bound for every rounded Euclidean attack goal', () => {
  for (let range = 1; range <= 14; range++)
    for (let x = -15; x <= 15; x++)
      for (let y = -15; y <= 15; y++) {
        if (attackDistance(at(0, 0), at(x, y)) <= range)
          expect(minimumRouteCost(at(0, 0), at(x, y), range)).toBe(0);
      }
});

it('matches unpruned ranged target selection across deterministic obstacles, priorities and ties', () => {
  let seed = 1513;
  const random = (max: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % max;
  };
  const origin = at(20, 20);
  for (let trial = 0; trial < 80; trial++) {
    const blocked = new Set(Array.from({ length: random(180) }, () => random(1600)));
    blocked.delete(820);
    const grid: WalkGrid = {
      width: 40,
      height: 40,
      walkable: (p) => !blocked.has(p.x + p.y * 40),
      seeThrough: (p) => !blocked.has(p.x + p.y * 40) || p.y % 3 === 0,
    };
    const targets: Entity[] = Array.from({ length: 3 + random(14) }, (_, i) => ({
      id: i + 2,
      classId: 4000 + random(3),
      name: `Target ${i}`,
      kind: 1,
      level: 1,
      hp: 50,
      maxHp: 50,
      dead: false,
      ...at(10 + random(21), 10 + random(21)),
    }));
    const range = 5 + random(10),
      cap = 1 + random(11),
      avoidWalls = random(2) === 0;
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.rules = [0, 1, 2].map((i) => ({
      classId: 4000 + i,
      action: 'attack',
      priority: random(4),
    }));
    const nav = new GridNavigator(grid);
    let expected: { target: Entity; rank: number; cost: number } | null = null;
    for (const target of targets) {
      const cells = nav.plan(origin, target, {
        range,
        maxDistance: cap,
        avoidWalls,
        goal: 'attack',
      });
      if (!cells) continue;
      const rank = automation.combat.rules.find(
          (rule) => rule.classId === target.classId,
        )!.priority,
        cost = movementCost(cells);
      if (!expected || rank > expected.rank || (rank === expected.rank && cost < expected.cost))
        expected = { target, rank, cost };
    }
    const sent: Action[] = [],
      engine = new BotEngine(
        (action) => sent.push(action),
        () => 100_000,
        () => grid,
      );
    engine.connect(true);
    engine.receive([
      { type: 'enter', id: 1, map: 'prt_fild08' },
      {
        type: 'spawn',
        entity: {
          id: 1,
          classId: 1,
          name: 'Archer',
          kind: 0,
          level: 7,
          hp: 70,
          maxHp: 70,
          dead: false,
          ...origin,
        },
      },
      ...targets.map((entity) => ({ type: 'spawn' as const, entity })),
      {
        type: 'inventory',
        items: [{ bagId: 77, itemId: 1701, count: 1, type: 1 }],
        equipment: [0, 0, 0, 0, 77],
        ammoId: -1,
      },
      { type: 'skills', learned: [{ skillId: 29, level: range - 5 }] },
    ]);
    engine.start({
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      radius: 20,
      attackRouteMaxPathDistance: cap,
      route_avoidWalls: avoidWalls,
      automation,
    });
    engine.tick();
    expect(engine.snapshot().target).toBe(expected?.target.name ?? '');
    if (!expected) expect(sent).toEqual([]);
  }
});

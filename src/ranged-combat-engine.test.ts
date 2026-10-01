import { expect, it } from 'vitest';
import { BotEngine, DEFAULT_SETTINGS, type Action } from './engine';
import { type WalkGrid } from './navigation';
import type { Entity, Position } from './protocol';
import type { FeatureEvent } from './protocol-feature';

const at = (x: number, y: number): Position => ({ x, y });
const player: Entity = { id: 1, classId: 0, name: 'Archer', kind: 0, level: 7, hp: 70, maxHp: 70, dead: false, ...at(1, 2) };
const monster: Entity = { id: 2, classId: 4000, name: 'Poring', kind: 1, level: 1, hp: 51, maxHp: 51, dead: false, ...at(5, 2) };
const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], route_avoidWalls: false };
const inventory = (itemId = 1701): FeatureEvent => ({ type: 'inventory', items: [{ bagId: 77, itemId, count: 1, type: 1 }], equipment: [0, 0, 0, 0, 77], ammoId: -1 });
function setup(grid: WalkGrid, from = player, to = monster) {
  let now = 100_000;
  const sent: Action[] = [];
  const engine = new BotEngine(action => sent.push(action), () => now, () => grid);
  engine.connect(true);
  engine.receive([{ type: 'enter', id: 1, map: settings.map }, { type: 'spawn', entity: { ...from } }, { type: 'spawn', entity: { ...to } }, inventory(), { type: 'skills', learned: [] }]);
  const step = (ms = 100) => { now += ms; engine.tick(); };
  const finishLeg = () => {
    const cells = engine.snapshot().navigation!.leg;
    engine.receive([{ type: 'walk', id: 1, walk: { origin: cells[0]!, cells, secondsPerCell: .01, firstSeconds: .01, locked: false } }]);
    step(200);
  };
  return { engine, sent, step, finishLeg };
}

it('normal-attacks from verified bow range across a snipable-only barrier with no approach walk', () => {
  const f = setup({ width: 8, height: 6, walkable: p => p.x !== 3, seeThrough: () => true });
  f.engine.start({ ...settings, attackRouteMaxPathDistance: 1 }); f.step();
  expect(f.sent).toEqual([{ type: 'attack', id: 2 }]);
  f.step(); expect(f.sent).toHaveLength(1);
  f.engine.stop(); expect(f.sent.at(-1)).toEqual({ type: 'stop' });
  expect(f.engine.idleForActions()).toBe(true);
});

it('uses a reachable firing tile around an opaque wall and avoids walking to adjacency', () => {
  const f = setup({ width: 12, height: 7, walkable: p => !(p.x === 5 && p.y < 5), seeThrough: p => !(p.x === 5 && p.y < 5) },
    { ...player, ...at(2, 2) }, { ...monster, ...at(9, 2) });
  f.engine.start(settings); f.step();
  const firing = f.engine.snapshot().navigation!.route.at(-1)!;
  expect(Math.max(Math.abs(firing.x - 9), Math.abs(firing.y - 2))).toBeGreaterThan(1);
  expect(f.sent[0]!.type).toBe('walk');
  for (let i = 0; i < 8 && f.sent.at(-1)?.type !== 'attack'; i++) f.finishLeg();
  expect(f.sent.at(-1)).toEqual({ type: 'attack', id: 2 });
});

it('retains direct server approach on a clear walking corridor outside known range', () => {
  const f = setup({ width: 20, height: 8, walkable: () => true }, player, { ...monster, x: 11 });
  f.engine.start(settings); f.step();
  expect(f.sent).toEqual([{ type: 'attack', id: 2 }]);
  f.engine.stop();
  expect(f.engine.idleForActions()).toBe(false);
  f.engine.receive([{ type: 'stop', id: 1 }]);
  expect(f.engine.idleForActions()).toBe(true);
});

it('does not invent ranged access for unknown weapons, and retains stable equal-cost ties', () => {
  const grid: WalkGrid = { width: 8, height: 6, walkable: p => p.x !== 3, seeThrough: () => true };
  const f = setup(grid); f.engine.receive([inventory(13100)]);
  f.engine.start(settings); f.step(); expect(f.sent).toEqual([]);
  const bow = setup(grid); bow.engine.receive([{ type: 'spawn', entity: { ...monster, id: 3, y: 3 } }]);
  bow.engine.start(settings); bow.step();
  expect(bow.sent).toEqual([{ type: 'attack', id: 2 }]);
});

it('prunes using the live bow range so a later zero-movement target can win', () => {
  const f = setup({ width: 20, height: 8, walkable: () => true }, player, { ...monster, x: 7 });
  f.engine.receive([{ type: 'spawn', entity: { ...monster, id: 3, x: 5 } }]);
  f.engine.start(settings); f.step();
  expect(f.sent).toEqual([{ type: 'attack', id: 3 }]);
});

it('waits for an owned route leg before using a new learned range', () => {
  const f = setup({ width: 16, height: 7, walkable: p => p.x !== 5 || p.y === 5, seeThrough: () => true },
    { ...player, ...at(1, 2) }, { ...monster, ...at(10, 2) });
  f.engine.start(settings); f.step();
  expect(f.sent[0]!.type).toBe('walk');
  f.engine.receive([{ type: 'skills', learned: [{ skillId: 29, level: 5 }] }]);
  f.step(); expect(f.sent).toHaveLength(1);
  f.finishLeg();
  expect(f.sent.at(-1)).toEqual({ type: 'attack', id: 2 });
});

it('rechecks a moving target after an acknowledged ranged attack and preserves ownership through Stop', () => {
  const f = setup({ width: 8, height: 6, walkable: p => p.x !== 3, seeThrough: p => p.x !== 3 || p.y === 2 });
  f.engine.start(settings); f.step();
  f.engine.receive([{ type: 'attack', source: 1, target: 2, position: at(1, 2) }, { type: 'position', id: 2, position: at(5, 4) }]);
  f.step(); expect(f.sent.at(-1)).toEqual({ type: 'stop' });
  f.step(); expect(f.sent).toHaveLength(2);
  f.engine.stop(); expect(f.engine.idleForActions()).toBe(false);
  f.engine.receive([{ type: 'stop', id: 1 }]);
  expect(f.engine.idleForActions()).toBe(true);
});

it('replans an equipped weapon change without dispatching across an unresolved movement owner', () => {
  const f = setup({ width: 8, height: 6, walkable: p => p.x !== 3, seeThrough: () => true });
  f.engine.start(settings); f.step();
  f.engine.receive([{ type: 'attack', source: 1, target: 2, position: at(1, 2) }, inventory(1101)]);
  f.step(); expect(f.sent.at(-1)).toEqual({ type: 'stop' });
  f.step(); expect(f.sent).toHaveLength(2);
  f.engine.receive([{ type: 'stop', id: 1 }]); f.step();
  expect(f.sent.filter(action => action.type === 'attack')).toHaveLength(1);
});

it('resumes after an idle Stop with no movement acknowledgment and starts timing only an actual approach', () => {
  const f = setup({ width: 8, height: 6, walkable: p => p.x !== 3, seeThrough: p => p.x !== 3 || p.y === 2 });
  f.engine.start(settings); f.step();
  f.engine.receive([{ type: 'attack', source: 1, target: 2, position: at(1, 2) }, { type: 'position', id: 2, position: at(5, 4) }]);
  f.step(); expect(f.sent.at(-1)).toEqual({ type: 'stop' });
  // PacketStopAction clears an idle target without stop19/walk7. Its bounded
  // cancellation fence must not consume the default four-second pursuit budget.
  for (let i = 0; i < 39; i++) f.step();
  expect(f.sent).toHaveLength(2);
  f.step(); expect(f.sent.at(-1)!.type).toBe('walk');
  expect(f.engine.snapshot().task.since).toBe(104_200);
  expect(f.engine.log.some(entry => entry.text.includes('time limit') || entry.text.includes('Walk did not complete'))).toBe(false);
  f.finishLeg(); expect(f.sent.at(-1)).toEqual({ type: 'attack', id: 2 });
});

it('re-attacks after a learned range update with no idle Stop acknowledgment', () => {
  const f = setup({ width: 8, height: 6, walkable: p => p.x !== 3, seeThrough: () => true });
  f.engine.start(settings); f.step();
  f.engine.receive([{ type: 'attack', source: 1, target: 2, position: at(1, 2) }, { type: 'skills', learned: [{ skillId: 29, level: 1 }] }]);
  f.step(); expect(f.sent.at(-1)).toEqual({ type: 'stop' });
  for (let i = 0; i < 40; i++) f.step();
  expect(f.sent).toEqual([{ type: 'attack', id: 2 }, { type: 'stop' }, { type: 'attack', id: 2 }]);
  expect(f.engine.log.some(entry => entry.text.includes('time limit'))).toBe(false);
});

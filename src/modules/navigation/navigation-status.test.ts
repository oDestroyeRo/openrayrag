import { describe, expect, it } from 'vitest';
import { BotEngine, DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Action } from '../automation/engine';
import { validNavigationStatus } from './navigation-status';

function skillApproach() {
  let now = 100_000;
  const sent: Action[] = [];
  const engine = new BotEngine(action => sent.push(action), () => now,
    () => ({ width: 30, height: 30, walkable: () => true }));
  engine.connect(true);
  engine.receive([
    { type: 'enter', id: 1, map: 'prt_fild08' },
    { type: 'spawn', entity: { id: 1, kind: 0, classId: 2, name: 'Mage', level: 10, hp: 100, maxHp: 100, sp: 200, maxSp: 200, x: 2, y: 2, dead: false, statuses: [] } },
    { type: 'spawn', entity: { id: 2, kind: 1, classId: 4000, name: 'Poring', level: 1, hp: 100, maxHp: 100, x: 17, y: 2, dead: false, statuses: [] } },
    { type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 },
    { type: 'skills', learned: [{ skillId: 11, level: 10 }] },
  ]);
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.attackStrategies = [{ id: 'opener', speciesIds: [4000], skillId: 11, level: 1,
    behavior: 'opener', maxAttempts: 1, maxUses: 1, cooldownSeconds: 1 }];
  engine.start({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], radius: 20, automation });
  now += 100;
  engine.tick();
  return { engine, sent };
}

describe('main window navigation telemetry boundary', () => {
  it('accepts a real learned bolt approach before and after movement acknowledgement', () => {
    const { engine, sent } = skillApproach();
    expect(sent[0]?.type).toBe('walk');
    const before = engine.snapshot().navigation!;
    expect(before.mode).toBe('skill');
    expect(before.leg.length).toBeGreaterThan(1);
    expect(validNavigationStatus(before)).toBe(true);
    engine.receive([{ type: 'walk', id: 1, walk: { origin: before.leg[0]!, cells: before.leg,
      secondsPerCell: 0.1, firstSeconds: 0.1, locked: false } }]);
    expect(validNavigationStatus(engine.snapshot().navigation)).toBe(true);
    engine.stop();
    expect(validNavigationStatus(engine.snapshot().navigation)).toBe(true);
  });

  it('retains absent navigation and rejects unknown or malformed telemetry', () => {
    const { engine } = skillApproach();
    const n = engine.snapshot().navigation!;
    expect(validNavigationStatus(null)).toBe(true);
    for (const invalid of [undefined, [], {},
      { ...n, mode: 'arbitrary' }, { ...n, mode: 'toString' }, { ...n, mode: null },
      { ...n, ready: 'true' }, { ...n, width: Infinity }, { ...n, routeLength: -1 },
      { ...n, goal: { x: 512, y: 0 } }, { ...n, goal: { x: 0.5, y: 0 } },
      { ...n, route: Array(513).fill({ x: 0, y: 0 }) },
      { ...n, leg: Array(22).fill({ x: 0, y: 0 }) },
      { ...n, leg: [{ x: -1, y: 0 }] }, { ...n, route: [{ x: 0, y: NaN }] },
    ]) expect(validNavigationStatus(invalid)).toBe(false);
  });
});

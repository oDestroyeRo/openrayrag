import { describe, expect, it } from 'vitest';
import { attackDistance, normalAttackProfile, projectileLineOfSight } from './combat';
import { CharacterState } from '../world/character-state';
import { GridNavigator, searchGrid, type WalkGrid } from '../navigation/navigation';
import type { Position } from '../protocol/protocol';
import weapons from '../../data/weapon-catalog.json';
import catalog from '../../data/navigation-maps.json';

const at = (x: number, y: number): Position => ({ x, y });
function trace(from: Position, to: Position): Position[] {
  const cells: Position[] = [];
  expect(projectileLineOfSight(from, to, p => { cells.push(p); return true; })).toBe(true);
  return cells;
}
function equipped(itemId: number): CharacterState {
  const state = new CharacterState();
  state.apply({ type: 'inventory', items: [{ bagId: 77, itemId, count: 1, type: 1 }], equipment: [0, 0, 0, 0, 77], ammoId: -1 }, 1);
  return state;
}
function wallGrid(snipable: boolean): WalkGrid {
  return { width: 7, height: 5, walkable: p => p.x !== 3, seeThrough: p => snipable || p.x !== 3 };
}

describe('pinned normal attack geometry', () => {
  it('rounds Euclidean range separately from square walking distance', () => {
    expect(attackDistance(at(0, 0), at(1, 1))).toBe(1);
    expect(attackDistance(at(0, 0), at(2, 2))).toBe(3);
    expect(attackDistance(at(0, 0), at(4, 3))).toBe(5);
    expect(attackDistance(at(0, 0), at(5, 2))).toBe(5);
  });
  it('preserves source tall, shallow and reverse Bresenham edge cases', () => {
    expect(trace(at(0, 0), at(1, 3))).toEqual([at(0, 0), at(0, 1), at(1, 2)]);
    expect(trace(at(0, 0), at(2, 1))).toEqual([at(0, 0), at(1, 0)]);
    expect(trace(at(2, 1), at(0, 0))).toEqual([at(2, 1), at(1, 1)]);
    expect(trace(at(1, 3), at(0, 0))).toEqual([at(1, 3), at(1, 2), at(0, 1)]);
    expect(trace(at(3, 3), at(2, 0))).toEqual([at(3, 3), at(3, 2), at(2, 1)]);
  });
  it('checks the start and intermediate cells and excludes the destination', () => {
    expect(projectileLineOfSight(at(0, 0), at(2, 0), p => p.x !== 0)).toBe(false);
    expect(projectileLineOfSight(at(0, 0), at(2, 0), p => p.x !== 1)).toBe(false);
    expect(projectileLineOfSight(at(0, 0), at(2, 0), p => p.x !== 2)).toBe(true);
    expect(projectileLineOfSight(at(2, 0), at(2, 0), () => false)).toBe(true);
    expect(projectileLineOfSight(at(0.5, 0), at(2, 0), () => true)).toBe(false);
  });
  it('shoots over snipable-only barriers without crossing them and rejects opaque barriers', () => {
    const nav = new GridNavigator(wallGrid(true));
    expect(nav.plan(at(1, 2), at(5, 2), { range: 5, goal: 'attack', maxDistance: 0 })).toEqual([at(1, 2)]);
    expect(nav.plan(at(1, 2), at(5, 2), { range: 5 })).toBeNull();
    expect(new GridNavigator(wallGrid(false)).plan(at(1, 2), at(5, 2), { range: 5, goal: 'attack' })).toBeNull();
  });
  it('retains diagonal melee corners and portal exclusions even when projectile sight is clear', () => {
    const grid: WalkGrid = { width: 5, height: 5, walkable: p => !(p.x === 2 && p.y === 1), seeThrough: () => true };
    const nav = new GridNavigator(grid);
    expect(nav.canAttack(at(1, 1), at(2, 2), 1)).toBe(false);
    expect(nav.canAttack(at(1, 1), at(2, 2), 5)).toBe(true);
    const portal = new GridNavigator(grid, [{ ...at(2, 2), halfWidth: 0, halfHeight: 0 }]);
    expect(portal.canAttack(at(1, 1), at(2, 2), 5)).toBe(false);
  });
  it('finds a reachable firing position before melee and respects the route step cap', () => {
    const grid: WalkGrid = { width: 12, height: 7, walkable: p => !(p.x === 5 && p.y < 5), seeThrough: p => !(p.x === 5 && p.y < 5) };
    const nav = new GridNavigator(grid);
    const from = at(2, 2), target = at(9, 2);
    const route = nav.plan(from, target, { range: 5, goal: 'attack', avoidWalls: false })!;
    expect(nav.validRoute(route)).toBe(true);
    expect(nav.canAttack(route.at(-1)!, target, 5)).toBe(true);
    expect(attackDistance(route.at(-1)!, target)).toBeGreaterThan(1);
    expect(nav.plan(from, target, { range: 5, goal: 'attack', maxDistance: 1 })).toBeNull();
  });
  it('retains every published visibility bit with walking and snipable-only flags disjoint', () => {
    let snipable = 0;
    let invalid = 0;
    for (const [map, data] of Object.entries(catalog)) {
      const walk = Uint8Array.from(atob(data.walkableBitsBase64), c => c.charCodeAt(0));
      const sight = Uint8Array.from(atob(data.snipableOnlyBitsBase64), c => c.charCodeAt(0));
      expect(sight.length).toBe(walk.length);
      for (let i = 0; i < sight.length; i++) {
        if (walk[i]! & sight[i]!) invalid++;
        for (let bit = 0; bit < 8; bit++) if (sight[i]! & (1 << bit)) {
          snipable++;
          const cell = i * 8 + bit;
          const p = at(cell % data.width, Math.floor(cell / data.width));
          if (searchGrid(map)!.walkable(p) || !searchGrid(map)!.seeThrough!(p)) invalid++;
        }
      }
    }
    expect(snipable).toBe(782419);
    expect(invalid).toBe(0);
  });
});

describe('verified weapon range', () => {
  it('requires the main-hand bag mapping and handles unknown equipment conservatively', () => {
    expect(normalAttackProfile(new CharacterState()).sourceRange).toBeNull();
    const unarmed = equipped(1701); unarmed.equipment[4] = 0;
    expect(normalAttackProfile(unarmed)).toMatchObject({ range: 1, sourceRange: 1, source: 'Unarmed' });
    const missing = equipped(1701); missing.equipment[4] = 1701;
    expect(normalAttackProfile(missing)).toMatchObject({ range: 1, sourceRange: null });
    expect(normalAttackProfile(equipped(13100))).toMatchObject({ range: 1, sourceRange: null });
    expect(Object.keys(weapons.items)).toHaveLength(493);
    expect(Object.keys(weapons.unknown)).toHaveLength(10);
  });
  it('adds only verified learned Vulture Eye to bows and labels unknown skills', () => {
    const bow = equipped(1701);
    expect(normalAttackProfile(bow)).toMatchObject({ range: 5, sourceRange: null });
    bow.apply({ type: 'skills', learned: [{ skillId: 29, level: 4 }], granted: [{ skillId: 29, level: 10 }] }, 1);
    expect(normalAttackProfile(bow)).toMatchObject({ range: 9, sourceRange: 9 });
    expect(normalAttackProfile(bow.snapshot())).toEqual(normalAttackProfile(bow));
    const sword = equipped(1101); sword.apply({ type: 'skills', learned: [{ skillId: 29, level: 10 }] }, 1);
    expect(normalAttackProfile(sword)).toMatchObject({ range: 1, sourceRange: 1 });
  });
  it('keeps raw normal range separate from conservative fourteen and Blind caps', () => {
    const bow = equipped(1701); bow.apply({ type: 'skills', learned: [{ skillId: 29, level: 10 }] }, 1);
    expect(normalAttackProfile(bow)).toMatchObject({ range: 14, sourceRange: 15 });
    bow.apply({ type: 'status', id: 1, statusId: 5, seconds: 10 }, 1);
    expect(normalAttackProfile(bow)).toMatchObject({ range: 5, sourceRange: 15 });
    bow.apply({ type: 'status', id: 1, statusId: 5, seconds: null }, 1);
    expect(normalAttackProfile(bow).range).toBe(14);
  });
});

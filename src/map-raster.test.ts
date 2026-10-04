import { describe, expect, it } from 'vitest';
import { GridNavigator, searchGrid, type WalkGrid } from './navigation';
import { paintMapCollision } from './map-raster';

function oracle(grid: WalkGrid): Uint8ClampedArray {
  const nav = new GridNavigator(grid), pixels = new Uint8ClampedArray(grid.width * grid.height * 4);
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const state = nav.tileState({ x, y }), color = state === 'blocked' ? [9, 17, 34] : state === 'portal' ? [121, 79, 48] : [41, 67, 58];
    pixels.set([...color, 255], (x + (grid.height - 1 - y) * grid.width) * 4);
  }
  return pixels;
}
function check(grid: WalkGrid): void {
  const pixels = new Uint8ClampedArray(grid.width * grid.height * 4); paintMapCollision(grid, pixels);
  expect(pixels).toEqual(oracle(grid));
}
describe('collision raster', () => {
  it('matches planner tile colors exactly, including Y inversion, blocked portal overlap and inclusive margins', () => {
    check({ width: 5, height: 4, walkable: ({ x, y }) => !(x === 0 && y === 0 || x === 2 && y === 2),
      seeThrough: () => true, portals: [{ x: 1, y: 1, halfWidth: 1, halfHeight: 1 }, { x: 3, y: 3, halfWidth: 0, halfHeight: 0 }] });
    check({ width: 3, height: 2, walkable: () => true });
  });
  it('matches full catalog collision on the measured field and a different-sized map', () => {
    check(searchGrid('prt_fild08')!); check(searchGrid('pay_fild01')!);
  });
  it('rejects invalid dimensions or a mismatched pixel buffer before painting', () => {
    for (const width of [0, -1, 1.5, 513]) expect(() => paintMapCollision({ width, height: 1, walkable: () => true }, new Uint8ClampedArray())).toThrow(RangeError);
    expect(() => paintMapCollision({ width: 1, height: 1, walkable: () => true }, new Uint8ClampedArray(3))).toThrow('buffer');
  });
});

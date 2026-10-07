import { expect, it } from 'vitest';
import { walkDuration, walkPosition } from './movement';
import { type Walk } from '../protocol/protocol';
const route: Walk = {
  origin: { x: 100.5, y: 100.5 },
  cells: [
    { x: 100, y: 100 },
    { x: 101, y: 100 },
    { x: 102, y: 101 },
  ],
  secondsPerCell: 1,
  firstSeconds: 0.5,
  locked: false,
};
it('tracks the partial first leg and later diagonal without jumping to the endpoint', () => {
  expect(walkPosition(route, 0)).toEqual({ x: 100, y: 100 });
  expect(walkPosition(route, 500)).toEqual({ x: 101, y: 100 });
  expect(walkPosition(route, 1100)).toEqual({ x: 101, y: 100 });
  expect(walkPosition(route, 1915)).toEqual({ x: 102, y: 101 });
  expect(walkDuration(route)).toBeCloseTo(1914.2);
});
it('handles zero-duration, empty and locked routes without advancing locked movement', () => {
  expect(walkPosition({ ...route, firstSeconds: -0.05 }, 0)).toEqual({ x: 101, y: 100 });
  expect(walkPosition({ ...route, locked: true }, 10000)).toEqual({ x: 100, y: 100 });
  expect(walkPosition({ ...route, cells: [] }, 10000)).toEqual({ x: 100, y: 100 });
  expect(walkDuration({ ...route, cells: [] })).toBe(0);
});

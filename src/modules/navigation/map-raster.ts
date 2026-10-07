import { MAX_MAP_DIMENSION, type WalkGrid } from './navigation-logic';

/** Collision colors only: route clearance/components are unnecessary for paint. */
export function paintMapCollision(grid: WalkGrid, pixels: Uint8ClampedArray): void {
  if (
    !Number.isInteger(grid.width) ||
    !Number.isInteger(grid.height) ||
    grid.width < 1 ||
    grid.height < 1 ||
    grid.width > MAX_MAP_DIMENSION ||
    grid.height > MAX_MAP_DIMENSION
  ) {
    throw new RangeError(
      `Navigation grid dimensions must be integers from 1 to ${MAX_MAP_DIMENSION}`,
    );
  }
  if (pixels.length !== grid.width * grid.height * 4)
    throw new RangeError('Collision raster buffer must match the grid dimensions.');
  for (let y = 0; y < grid.height; y++)
    for (let x = 0; x < grid.width; x++) {
      const point = { x, y },
        walkable = grid.walkable(point);
      const portal =
        walkable &&
        grid.portals?.some(
          (area) =>
            Math.abs(x - area.x) <= area.halfWidth && Math.abs(y - area.y) <= area.halfHeight,
        );
      const offset = (x + (grid.height - 1 - y) * grid.width) * 4;
      pixels[offset] = !walkable ? 9 : portal ? 121 : 41;
      pixels[offset + 1] = !walkable ? 17 : portal ? 79 : 67;
      pixels[offset + 2] = !walkable ? 34 : portal ? 48 : 58;
      pixels[offset + 3] = 255;
    }
}

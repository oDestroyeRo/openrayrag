import type { NavigationStatus } from './engine';
import { MAX_MAP_DIMENSION } from './navigation';

// Exhaustive keys make a new engine mode a compile-time boundary change.
const modes: Record<NavigationStatus['mode'], true> = {
  idle: true, skill: true, search: true, attack: true, pickup: true,
  follow: true, waypoint: true, recover: true, travel: true,
};
const position = (value: unknown): boolean => !!value && typeof value === 'object'
  && ['x', 'y'].every(key => {
    const coordinate = (value as Record<string, unknown>)[key];
    return typeof coordinate === 'number' && Number.isInteger(coordinate)
      && coordinate >= 0 && coordinate < MAX_MAP_DIMENSION;
  });

/** Validate remote navigation telemetry before the main window renders it. */
export function validNavigationStatus(value: unknown): value is NavigationStatus | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const n = value as Record<string, unknown>;
  return typeof n.ready === 'boolean' && typeof n.mode === 'string' && Object.hasOwn(modes, n.mode)
    && ['width', 'height', 'walkable', 'blocked', 'excluded', 'reachable', 'routeLength'].every(key => {
      const count = n[key];
      return typeof count === 'number' && Number.isInteger(count) && count >= 0 && count <= MAX_MAP_DIMENSION ** 2;
    })
    && (n.goal === null || position(n.goal))
    && Array.isArray(n.route) && n.route.length <= 512 && n.route.every(position)
    && Array.isArray(n.leg) && n.leg.length <= 21 && n.leg.every(position);
}

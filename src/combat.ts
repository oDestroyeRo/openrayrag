import weapons from './data/weapon-catalog.json';
import { ITEM_CATALOG } from './game-catalog';
import type { CharacterSnapshot, CharacterState } from './character-state';
import type { Position } from './protocol';

interface WeaponInfo { code: string; range: number; weaponClass: number }
const catalog: Readonly<Record<string, WeaponInfo>> = weapons.items;
export interface NormalAttackProfile {
  range: number;
  sourceRange: number | null;
  weaponItemId: number | null;
  source: string;
  limitation: string;
}

/** Main hand is an equipment bag ID, not an item ID. Granted skills do not
 * contribute to the pinned player's MaxLearnedLevelOfSkill(VultureEye).
 */
export function normalAttackProfile(state: CharacterState | CharacterSnapshot): NormalAttackProfile {
  const fallback = (limitation: string): NormalAttackProfile => ({
    range: 1, sourceRange: null, weaponItemId: null, source: 'Conservative melee', limitation,
  });
  if (!state.inventoryKnown || state.equipment[4] === undefined) return fallback('Equipment is not verified.');
  const bagId = state.equipment[4]!;
  if (bagId === 0) return { range: 1, sourceRange: 1, weaponItemId: null, source: 'Unarmed', limitation: '' };
  const item = state.inventory instanceof Map ? state.inventory.get(bagId) : state.inventory.find(item => item.bagId === bagId);
  if (!item) return fallback('The equipped weapon is missing from the verified inventory.');
  const info = catalog[item.itemId];
  if (!info) return { ...fallback('Weapon range is absent or does not match the pinned source.'), weaponItemId: item.itemId };
  let range = info.range;
  let sourceRange: number | null = range;
  const limitations: string[] = [];
  let source = `${ITEM_CATALOG[item.itemId]?.name ?? `Weapon #${item.itemId}`} · weapon ${range}`;
  if (info.weaponClass === 12) {
    if (state.skillsKnown) {
      const learned = state.learned instanceof Map ? state.learned.get(29) ?? 0 : state.learned.find(skill => skill.skillId === 29)?.level ?? 0;
      range += learned;
      sourceRange = range;
      source += ` + Vulture Eye ${learned}`;
    } else {
      sourceRange = null;
      limitations.push('Learned Vulture Eye is unknown; using the verified bow base range.');
    }
  }
  // TargetForAttack reads raw Range. GetEffectiveStat separately caps it at 14,
  // or 5 while Blind. Use those stricter limits as an explicit planning policy.
  if (range > 14) { range = 14; limitations.push('Planning is capped at 14 cells.'); }
  const blind = state.statuses instanceof Map ? state.statuses.has(5) : state.statuses.some(status => status.id === 5);
  if (blind && range > 5) { range = 5; limitations.push('Blind: planning is capped at 5 cells.'); }
  return { range, sourceRange, weaponItemId: item.itemId, source, limitation: limitations.join(' ') };
}

/** DistanceCache rounds a float32 Euclidean distance, separately from walking.
 * Integer tile deltas cannot produce an exact half, so Math.round matches .NET.
 */
export function attackDistance(from: Position, to: Position): number {
  return Math.round(Math.fround(Math.hypot(to.x - from.x, to.y - from.y)));
}

/** Pinned MapWalkData.HasLineOfSight: integer division truncates toward zero;
 * start and intermediate cells are checked, the destination is excluded.
 * Directional edge cases are intentional; do not substitute walking Bresenham.
 */
export function projectileLineOfSight(from: Position, to: Position, seeThrough: (p: Position) => boolean): boolean {
  if (![from.x, from.y, to.x, to.y].every(Number.isInteger)) return false;
  let x = from.x;
  let y = from.y;
  const dx = Math.abs(to.x - x);
  const dy = Math.abs(to.y - y);
  const sx = x < to.x ? 1 : -1;
  const sy = y < to.y ? 1 : -1;
  let error = Math.trunc((dx > dy ? dx : -dy) / 2);
  while (x !== to.x || y !== to.y) {
    if (!seeThrough({ x, y })) return false;
    const twice = error;
    if (twice > -dx) { error -= dy; x += sx; }
    if (twice < dy) { error += dx; y += sy; }
  }
  return true;
}

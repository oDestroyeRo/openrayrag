import { ITEM_CATALOG, SKILL_CATALOG, skillPrerequisites } from './game-catalog';
import { AMMO_CATALOG } from './loadout';
import type { ExpandedAction, InventoryItem, PlayerStats } from './protocol-feature';
import type { Entity } from './protocol';

export interface ManualActionState {
  connected: boolean; compatible: boolean; player: Readonly<Entity> | null;
  inventoryKnown: boolean; inventory: ReadonlyMap<number, InventoryItem>;
  skillsKnown: boolean; learned: ReadonlyMap<number, number>; stats: Readonly<PlayerStats> | null;
  entities: ReadonlyMap<number, Readonly<Entity>>; actors: ReadonlyMap<number, Readonly<Entity>>;
}
/** Admission does not reserve an action, override a loadout, or dispatch a packet. */
export function manualActionBlocker(action: ExpandedAction, state: ManualActionState): string | null {
  const player = state.player;
  if (!state.connected || !state.compatible || !player) return 'A verified character is required.';
  if (action.type === 'respawn') { if (!player.dead) return 'Respawn requires a dead character.'; }
  else if (player.dead) return 'Revive before using this action.';
  if (action.type === 'sit' && action.sitting && player.classId === 0 && (!state.skillsKnown || (state.learned.get(1) ?? 0) < 2))
    return 'A novice needs verified Basic Mastery level 2 to sit.';
  if (action.type === 'useItem') {
    const count = [...state.inventory.values()].reduce((sum, item) => sum + (item.itemId === action.itemId ? item.count : 0), 0);
    if (!state.inventoryKnown || count < 1) return 'Item is not present in a verified inventory.';
    const item = ITEM_CATALOG[action.itemId];
    if (!item || item.useType < 1) return 'This item is not usable.';
    if (action.target !== undefined && action.target !== -1 && !state.entities.has(action.target) && !state.actors.has(action.target)) return 'Item target is not visible.';
    if (item.useType === 2 && (action.target === undefined || action.target === -1)) return 'This item requires a target.';
  }
  if (action.type === 'equip') {
    const item = state.inventory.get(action.bagId), info = item ? ITEM_CATALOG[item.itemId] : undefined;
    if (!state.inventoryKnown || !item || !info || ![2, 3, 4].includes(info.itemClass) || (!info.position && !AMMO_CATALOG[item.itemId]))
      return 'Equipment is not present in a verified inventory.';
  }
  if (action.type === 'allocateSkill') {
    const skill = SKILL_CATALOG[action.skillId], requirements = skillPrerequisites(player.classId, action.skillId), learned = state.learned.get(action.skillId) ?? 0;
    if (!state.skillsKnown || !state.stats?.skillPoints || !skill || learned >= skill.maxLevel || requirements === null
      || requirements.some(requirement => (state.learned.get(requirement.skillId) ?? 0) < requirement.level))
      return 'Skill points, class prerequisites and a learnable skill are required.';
  }
  if (action.type === 'allocateStats') {
    const stats = state.stats;
    if (!stats?.attributes || stats.statPoints === undefined) return 'Verified attributes and stat points are required.';
    let cost = 0;
    for (let i = 0; i < 6; i++) {
      const current = stats.attributes[i]!;
      if (current + action.attributes[i]! > 99) return 'Attributes cannot exceed 99.';
      for (let n = 0; n < action.attributes[i]!; n++) cost += 2 + Math.floor((current + n - 1) / 10);
    }
    if (cost > stats.statPoints) return 'Insufficient verified stat points.';
  }
  return null;
}

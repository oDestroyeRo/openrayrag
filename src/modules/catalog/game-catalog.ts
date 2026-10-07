import data from '../../data/game-catalog.json';

export interface ItemInfo {
  name: string;
  weight: number;
  price: number;
  sellPrice: number;
  itemClass: number;
  useType: number;
  position: number;
}
export interface SkillInfo {
  name: string;
  target: number;
  maxLevel: number;
  adjustableLevel: boolean;
  spCost: number[] | null;
}
interface SkillTree {
  extends: number;
  skills: Array<{ skillId: number; requires: Array<{ skillId: number; level: number }> }>;
}
export const ITEM_CATALOG: Readonly<Record<string, ItemInfo>> = data.items;
export const SKILL_CATALOG: Readonly<Record<string, SkillInfo>> = data.skills;
const trees: Readonly<Record<string, SkillTree>> = data.trees;
export const itemName = (id: number): string => ITEM_CATALOG[id]?.name ?? `Item #${id}`;
export const skillName = (id: number): string => SKILL_CATALOG[id]?.name ?? `Skill #${id}`;
export function skillCost(id: number, level: number): number | null {
  const skill = SKILL_CATALOG[id];
  if (
    !skill ||
    !Number.isInteger(level) ||
    level < 1 ||
    level > skill.maxLevel ||
    !skill.spCost?.length
  )
    return null;
  return skill.spCost[Math.min(level - 1, skill.spCost.length - 1)] ?? null;
}
export function skillPrerequisites(
  classId: number,
  skillId: number,
): Array<{ skillId: number; level: number }> | null {
  const seen = new Set<number>();
  while (classId >= 0 && !seen.has(classId)) {
    seen.add(classId);
    const tree = trees[classId];
    if (!tree) return null;
    const skill = tree.skills.find((entry) => entry.skillId === skillId);
    if (skill) return skill.requires.map((entry) => ({ ...entry }));
    classId = tree.extends;
  }
  return null;
}

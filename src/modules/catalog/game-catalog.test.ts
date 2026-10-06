import { describe, expect, it } from 'vitest';
import { ITEM_CATALOG, SKILL_CATALOG, itemName, skillCost, skillName, skillPrerequisites } from './game-catalog';

describe('official game catalog', () => {
  it('names inventory and skills and keeps unknown identifiers visible', () => {
    expect(itemName(501)).toBe('Red Potion');
    expect(ITEM_CATALOG[501]?.useType).toBe(1);
    expect(skillName(2)).toBe('First Aid');
    expect(itemName(2147483647)).toBe('Item #2147483647');
  });
  it('does not infer missing SP costs or unsupported levels', () => {
    expect(skillCost(2, 1)).toBe(4);
    expect(skillCost(2, 2)).toBeNull();
    expect(skillCost(1, 1)).toBeNull();
    expect(skillCost(999, 1)).toBeNull();
    expect(SKILL_CATALOG[1]?.target).toBe(0);
  });
  it('resolves inherited prerequisites without treating an unknown skill as free', () => {
    expect(skillPrerequisites(0, 2)).toEqual([{ skillId: 1, level: 2 }]);
    expect(skillPrerequisites(1, 2)).toEqual([{ skillId: 1, level: 2 }]);
    expect(skillPrerequisites(0, 3)).toBeNull();
    expect(skillPrerequisites(999, 1)).toBeNull();
  });
});

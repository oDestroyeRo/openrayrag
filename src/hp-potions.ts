import catalog from './data/hp-potion-catalog.json';

export interface HpPotionSettings {
  mode: 'off' | 'any' | 'selected';
  itemIds: number[];
  belowPercent: number;
  minStock: number;
  cooldownSeconds: number;
}

/** Reviewed HP potions present in the pinned client, cheapest first. */
export const HP_POTION_IDS: readonly number[] = Object.freeze([...catalog.ids]);
const knownIds = new Set(HP_POTION_IDS);
export const DEFAULT_HP_POTIONS: HpPotionSettings = {
  mode: 'off', itemIds: [], belowPercent: 60, minStock: 0, cooldownSeconds: 5,
};

export function isHpPotion(itemId: number): boolean { return knownIds.has(itemId); }

export function validateHpPotions(value: unknown): HpPotionSettings {
  const keys = ['mode', 'itemIds', 'belowPercent', 'minStock', 'cooldownSeconds'];
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid HP potion settings.');
  const row = value as Record<string, unknown>;
  const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))
    || !['off', 'any', 'selected'].includes(String(row.mode)) || typeof row.mode !== 'string'
    || !Array.isArray(row.itemIds) || row.itemIds.length > HP_POTION_IDS.length
    || row.itemIds.some(id => !integer(id, 1, 2_147_483_647) || !knownIds.has(id))
    || new Set(row.itemIds).size !== row.itemIds.length || row.mode === 'selected' && row.itemIds.length === 0
    || !integer(row.belowPercent, 1, 100) || !integer(row.minStock, 0, 9999) || !integer(row.cooldownSeconds, 1, 3600)) {
    throw new Error('Choose known HP potions and valid threshold, reserve and cooldown values.');
  }
  return { mode: row.mode as HpPotionSettings['mode'], itemIds: [...row.itemIds] as number[],
    belowPercent: row.belowPercent as number, minStock: row.minStock as number, cooldownSeconds: row.cooldownSeconds as number };
}

export function hpPotionIds(policy: HpPotionSettings | undefined): readonly number[] {
  return !policy || policy.mode === 'off' ? [] : policy.mode === 'any' ? HP_POTION_IDS : policy.itemIds;
}

/** Late receipts hold the run through both item and shared HP cooldowns. */
export function recoveryItemCooldown(policy: { items: {itemId: number; cooldownSeconds: number}[]; hpPotions?: HpPotionSettings }, itemId: number): number {
  const advanced = policy.items.find(rule => rule.itemId === itemId);
  const shared = policy.hpPotions && policy.hpPotions.mode !== 'off' && isHpPotion(itemId) ? policy.hpPotions.cooldownSeconds : 0;
  return Math.max(advanced?.cooldownSeconds ?? 1, shared);
}

import { DEFAULT_RECOVERY_ITEMS, RECOVERY_ITEM_IDS, isRecoveryItem, recoveryItemIds, validateRecoveryItems, type RecoveryItemSettings } from './recovery-items';

// Keep the existing settings field and exports compatible with saved profiles.
export type HpPotionSettings = RecoveryItemSettings;
export const HP_POTION_IDS = RECOVERY_ITEM_IDS.hp;
export const DEFAULT_HP_POTIONS = DEFAULT_RECOVERY_ITEMS;
export function isHpPotion(itemId: number): boolean { return isRecoveryItem(itemId, 'hp'); }
export function validateHpPotions(value: unknown): HpPotionSettings { return validateRecoveryItems(value, 'hp'); }
export function hpPotionIds(policy: HpPotionSettings | undefined): readonly number[] { return recoveryItemIds(policy, 'hp'); }

/** Late receipts hold the run through item and active HP/SP cooldowns. */
export function recoveryItemCooldown(policy: { items: {itemId: number; cooldownSeconds: number}[]; hpPotions?: HpPotionSettings; spPotions?: RecoveryItemSettings }, itemId: number): number {
  const advanced = policy.items.find(rule => rule.itemId === itemId);
  const shared = policy.hpPotions && policy.hpPotions.mode !== 'off' && isHpPotion(itemId) ? policy.hpPotions.cooldownSeconds : 0;
  const spShared = policy.spPotions && policy.spPotions.mode !== 'off' && isRecoveryItem(itemId, 'sp') ? policy.spPotions.cooldownSeconds : 0;
  return Math.max(advanced?.cooldownSeconds ?? 1, shared, spShared);
}

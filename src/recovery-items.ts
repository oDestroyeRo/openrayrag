import type { ReadonlyData } from './settings';
import catalog from './data/recovery-item-catalog.json';

export type RecoveryResource = 'hp' | 'sp';
export interface RecoveryItemSettings {
  mode: 'off' | 'any' | 'selected';
  itemIds: number[];
  belowPercent: number;
  minStock: number;
  cooldownSeconds: number;
}

/** Direct recovery effects from the pinned server, ordered by client price. */
export const RECOVERY_ITEM_IDS: Readonly<Record<RecoveryResource, readonly number[]>> = {
  hp: Object.freeze([...catalog.hpIds]), sp: Object.freeze([...catalog.spIds]),
};
const knownIds = { hp: new Set(RECOVERY_ITEM_IDS.hp), sp: new Set(RECOVERY_ITEM_IDS.sp) };
export const DEFAULT_RECOVERY_ITEMS: RecoveryItemSettings = {
  mode: 'off', itemIds: [], belowPercent: 60, minStock: 0, cooldownSeconds: 5,
};
export const DEFAULT_SP_ITEMS: RecoveryItemSettings = { ...DEFAULT_RECOVERY_ITEMS, itemIds: [], belowPercent: 30 };

export function isRecoveryItem(itemId: number, resource: RecoveryResource): boolean { return knownIds[resource].has(itemId); }

export function validateRecoveryItems(value: unknown, resource: RecoveryResource): RecoveryItemSettings {
  const keys = ['mode', 'itemIds', 'belowPercent', 'minStock', 'cooldownSeconds'];
  const label = resource.toUpperCase();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid ${label} recovery item settings.`);
  const row = value as Record<string, unknown>;
  const integer = (v: unknown, min: number, max: number) => typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;
  if (Object.keys(row).length !== keys.length || Object.keys(row).some(key => !keys.includes(key))
    || !['off', 'any', 'selected'].includes(String(row.mode)) || typeof row.mode !== 'string'
    || !Array.isArray(row.itemIds) || row.itemIds.length > RECOVERY_ITEM_IDS[resource].length
    || row.itemIds.some(id => !integer(id, 1, 2_147_483_647) || !isRecoveryItem(id, resource))
    || new Set(row.itemIds).size !== row.itemIds.length || row.mode === 'selected' && row.itemIds.length === 0
    || !integer(row.belowPercent, 1, 100) || !integer(row.minStock, 0, 9999) || !integer(row.cooldownSeconds, 1, 3600)) {
    throw new Error(`Choose known ${label} recovery items and valid threshold, reserve and cooldown values.`);
  }
  return { mode: row.mode as RecoveryItemSettings['mode'], itemIds: [...row.itemIds] as number[],
    belowPercent: row.belowPercent as number, minStock: row.minStock as number, cooldownSeconds: row.cooldownSeconds as number };
}

export function recoveryItemIds(policy: ReadonlyData<RecoveryItemSettings> | undefined, resource: RecoveryResource): readonly number[] {
  return !policy || policy.mode === 'off' ? [] : policy.mode === 'any' ? RECOVERY_ITEM_IDS[resource] : policy.itemIds;
}

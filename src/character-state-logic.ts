import type { Entity } from './protocol';
import type { InventoryItem, PlayerStats, SkillLevel } from './protocol-feature';
export interface CharacterSnapshot {
  stats: PlayerStats | null; inventoryKnown: boolean; skillsKnown: boolean;
  inventory: InventoryItem[]; cart: InventoryItem[] | null; equipment: number[]; ammoId: number;
  learned: SkillLevel[]; granted: SkillLevel[]; sitting: boolean | null;
  statuses: Array<{ id: number; seconds: number }>;
  experience: { baseTotal: number; baseGained: number; jobTotal: number; jobGained: number } | null;
}

export type StatefulEntity = Entity & { sp?: number; maxSp?: number; sitting?: boolean; statuses?: Array<{ id: number; seconds: number }> };

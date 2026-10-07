import { map, take } from 'effect/Array';
import { pipe } from 'effect/Function';
import type { FeatureEvent, InventoryItem, PlayerStats } from '../protocol/protocol-feature';

import {
  admitInventoryItem,
  inventoryItemCount,
  type CharacterSnapshot,
  type StatefulEntity,
  type DomainInventoryItem,
} from './character-state-logic';
import {
  bagId,
  skillId,
  quantity,
  revisionFor,
  incrementRevision,
  type BagId,
  type ItemId,
  type SkillId,
  type Quantity,
} from '../../shared/domain-values';

export { type CharacterSnapshot, type StatefulEntity } from './character-state-logic';

export class CharacterState {
  stats: PlayerStats | null = null;
  inventoryKnown = false;
  skillsKnown = false;
  readonly inventory = new Map<BagId, DomainInventoryItem>();
  cart: DomainInventoryItem[] | null = null;
  equipment: number[] = [];
  ammoId = -1;
  readonly learned = new Map<SkillId, number>();
  readonly granted = new Map<SkillId, number>();
  sitting: boolean | null = null;
  readonly statuses = new Map<number, number>();
  experience: CharacterSnapshot['experience'] = null;
  spRevision = revisionFor('sp', 0);
  inventoryRevision = revisionFor('inventory', 0);
  equipmentRevision = revisionFor('equipment', 0);
  statsRevision = revisionFor('stats', 0);
  skillsRevision = revisionFor('skills', 0);
  reset(): void {
    this.stats = null;
    this.inventoryKnown = false;
    this.skillsKnown = false;
    this.inventory.clear();
    this.cart = null;
    this.equipment = [];
    this.ammoId = -1;
    this.learned.clear();
    this.granted.clear();
    this.sitting = null;
    this.statuses.clear();
    this.experience = null;
    this.spRevision = revisionFor('sp', 0);
    this.inventoryRevision = revisionFor('inventory', 0);
    this.equipmentRevision = revisionFor('equipment', 0);
    this.statsRevision = revisionFor('stats', 0);
    this.skillsRevision = revisionFor('skills', 0);
  }
  resetField(): void {
    this.sitting = null;
    this.statuses.clear();
  }
  applyCartWeights(cartWeight: number, currentWeight: number): void {
    if (this.stats) {
      const revision = incrementRevision(this.statsRevision);
      this.stats = { ...this.stats, cartWeight, weight: currentWeight };
      this.statsRevision = revision;
    }
  }
  spawn(entity: StatefulEntity): void {
    this.sitting = entity.sitting ?? null;
    this.stats = {
      ...this.stats,
      level: entity.level,
      hp: entity.hp,
      maxHp: entity.maxHp,
      // Nearby-player broadcasts include the owner but carry placeholder 0/0 SP.
      ...(entity.sp !== undefined && entity.maxSp !== undefined && entity.maxSp > 0
        ? { sp: entity.sp, maxSp: entity.maxSp }
        : {}),
    };
    if (entity.statuses) {
      this.statuses.clear();
      for (const s of entity.statuses) this.statuses.set(s.id, s.seconds);
    }
  }
  apply(event: FeatureEvent, playerId: number | null): void {
    switch (event.type) {
      case 'stats': {
        const sp = event.sp !== undefined ? incrementRevision(this.spRevision) : this.spRevision,
          revision = incrementRevision(this.statsRevision);
        const { type: _type, ...stats } = event;
        this.stats = { ...this.stats, ...stats };
        this.spRevision = sp;
        this.statsRevision = revision;
        break;
      }
      case 'sp':
        this.spRevision = incrementRevision(this.spRevision);
        if (this.stats) {
          this.stats.sp = event.sp;
          this.stats.maxSp = event.maxSp;
        }
        break;
      case 'sit':
        if (event.id === playerId) this.sitting = event.sitting;
        break;
      case 'status':
        if (event.id === playerId) {
          if (event.seconds === null) this.statuses.delete(event.statusId);
          else this.statuses.set(event.statusId, event.seconds);
        }
        break;
      case 'inventory': {
        const items = event.items.map(admitInventoryItem),
          cart = event.cart?.map(admitInventoryItem);
        const inventory = incrementRevision(this.inventoryRevision),
          equipment = incrementRevision(this.equipmentRevision);
        this.inventory.clear();
        for (const item of items) this.inventory.set(item.bagId, item);
        this.inventoryKnown = true;
        if (cart !== undefined) this.cart = cart;
        this.equipment = event.equipment.slice();
        this.ammoId = event.ammoId;
        this.inventoryRevision = inventory;
        this.equipmentRevision = equipment;
        break;
      }
      case 'inventoryDelta': {
        if (!this.inventoryKnown) {
          if (this.stats) this.stats.weight = event.weight;
          break;
        }
        const id = bagId(event.bagId),
          previous = this.inventory.get(id);
        let item: DomainInventoryItem | null;
        if (event.add && event.item) item = admitInventoryItem(event.item);
        else if (previous && event.change <= previous.count) {
          const count = quantity(previous.count - event.change);
          item = count > 0 ? { ...previous, count } : null;
        } else {
          if (this.stats) this.stats.weight = event.weight;
          this.inventoryKnown = false;
          break;
        }
        const revision = incrementRevision(this.inventoryRevision);
        if (this.stats) this.stats.weight = event.weight;
        if (item) this.inventory.set(id, item);
        else this.inventory.delete(id);
        this.inventoryRevision = revision;
        break;
      }
      case 'inventoryItem': {
        const id = bagId(event.item.bagId),
          previous = this.inventory.get(id);
        if (
          !this.inventoryKnown ||
          previous?.type !== 2 ||
          previous.itemId !== event.item.itemId ||
          !previous.guid ||
          previous.guid !== event.item.guid ||
          previous.count !== event.item.count
        ) {
          this.inventoryKnown = false;
          break;
        }
        const item = admitInventoryItem(event.item),
          revision = incrementRevision(this.inventoryRevision);
        this.inventory.set(id, item);
        this.inventoryRevision = revision;
        break;
      }
      case 'equipment': {
        const revision = incrementRevision(this.equipmentRevision);
        if (event.slot === 13) this.ammoId = event.equipped ? event.bagId : -1;
        else {
          while (this.equipment.length <= event.slot) this.equipment.push(0);
          if (event.equipped) this.equipment[event.slot] = event.bagId;
          else if (this.equipment[event.slot] === event.bagId) this.equipment[event.slot] = 0;
        }
        this.equipmentRevision = revision;
        break;
      }
      case 'skills': {
        const learned = event.learned?.map(
            (skill) => [skillId(skill.skillId), skill.level] as const,
          ),
          granted = event.granted?.map((skill) => [skillId(skill.skillId), skill.level] as const);
        const revision = incrementRevision(this.skillsRevision);
        if (learned) {
          this.learned.clear();
          for (const [id, level] of learned) this.learned.set(id, level);
          this.skillsKnown = true;
        }
        if (granted) {
          this.granted.clear();
          for (const [id, level] of granted) this.granted.set(id, level);
        }
        this.skillsRevision = revision;
        break;
      }
      case 'learnedSkill': {
        const id = skillId(event.skillId),
          revision = incrementRevision(this.skillsRevision);
        this.learned.set(id, event.level);
        if (this.stats) this.stats.skillPoints = event.points;
        this.skillsRevision = revision;
        break;
      }
      case 'currency':
        if (this.stats) this.stats.zeny = event.zeny;
        break;
      case 'experience': {
        const { type: _type, ...experience } = event;
        this.experience = experience;
        break;
      }
    }
  }
  count(itemId: ItemId): Quantity {
    return inventoryItemCount(itemId)([...this.inventory.values()]);
  }
  skillLevel(skillId: SkillId): number {
    return Math.max(this.learned.get(skillId) ?? 0, this.granted.get(skillId) ?? 0);
  }
  snapshot(): CharacterSnapshot {
    const clean = (item: DomainInventoryItem): InventoryItem => ({
      bagId: item.bagId,
      itemId: item.itemId,
      count: item.count,
      type: item.type,
      ...(item.flags !== undefined ? { flags: item.flags, refine: item.refine } : {}),
    });
    return {
      stats: this.stats
        ? {
            ...this.stats,
            ...(this.stats.attributes ? { attributes: [...this.stats.attributes] } : {}),
          }
        : null,
      inventoryKnown: this.inventoryKnown,
      skillsKnown: this.skillsKnown,
      inventory: pipe([...this.inventory.values()], take(600), map(clean)),
      cart: this.cart?.slice(0, 600).map(clean) ?? null,
      equipment: this.equipment.slice(0, 14),
      ammoId: this.ammoId,
      learned: pipe(
        [...this.learned],
        take(512),
        map(([skillId, level]) => ({ skillId, level })),
      ),
      granted: pipe(
        [...this.granted],
        take(512),
        map(([skillId, level]) => ({ skillId, level })),
      ),
      sitting: this.sitting,
      statuses: pipe(
        [...this.statuses],
        take(128),
        map(([id, seconds]) => ({ id, seconds })),
      ),
      experience: this.experience ? { ...this.experience } : null,
    };
  }
}

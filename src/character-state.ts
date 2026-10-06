import type { FeatureEvent, InventoryItem, PlayerStats } from './protocol-feature';

import type { CharacterSnapshot, StatefulEntity } from './character-state-logic';

export { type CharacterSnapshot, type StatefulEntity } from './character-state-logic';

export class CharacterState {
  stats: PlayerStats | null = null;
  inventoryKnown = false; skillsKnown = false;
  readonly inventory = new Map<number, InventoryItem>();
  cart: InventoryItem[] | null = null;
  equipment: number[] = []; ammoId = -1;
  readonly learned = new Map<number, number>(); readonly granted = new Map<number, number>();
  sitting: boolean | null = null;
  readonly statuses = new Map<number, number>();
  experience: CharacterSnapshot['experience'] = null;
  spRevision = 0; inventoryRevision = 0; equipmentRevision = 0; statsRevision = 0; skillsRevision = 0;
  reset(): void {
    this.stats = null; this.inventoryKnown = false; this.skillsKnown = false; this.inventory.clear(); this.cart = null;
    this.equipment = []; this.ammoId = -1; this.learned.clear(); this.granted.clear(); this.sitting = null;
    this.statuses.clear(); this.experience = null; this.spRevision = this.inventoryRevision = this.equipmentRevision = this.statsRevision = this.skillsRevision = 0;
  }
  resetField(): void { this.sitting=null;this.statuses.clear(); }
  applyCartWeights(cartWeight: number, currentWeight: number): void {
    if (this.stats) { this.stats = { ...this.stats, cartWeight, weight: currentWeight }; this.statsRevision++; }
  }
  spawn(entity: StatefulEntity): void {
    this.sitting = entity.sitting ?? null;
    this.stats = { ...this.stats, level: entity.level, hp: entity.hp, maxHp: entity.maxHp,
      // Nearby-player broadcasts include the owner but carry placeholder 0/0 SP.
      ...(entity.sp !== undefined && entity.maxSp !== undefined && entity.maxSp > 0 ? { sp: entity.sp, maxSp: entity.maxSp } : {}) };
    if (entity.statuses) { this.statuses.clear(); for (const s of entity.statuses) this.statuses.set(s.id,s.seconds); }
  }
  apply(event: FeatureEvent, playerId: number | null): void {
    switch (event.type) {
      case 'stats': { if(event.sp!==undefined)this.spRevision++; const { type: _type, ...stats } = event; this.stats = { ...this.stats, ...stats }; this.statsRevision++; break; }
      case 'sp': this.spRevision++; if (this.stats) { this.stats.sp = event.sp; this.stats.maxSp = event.maxSp; } break;
      case 'sit': if (event.id === playerId) this.sitting = event.sitting; break;
      case 'status': if (event.id === playerId) { if (event.seconds === null) this.statuses.delete(event.statusId); else this.statuses.set(event.statusId,event.seconds); } break;
      case 'inventory':
        this.inventory.clear(); for (const item of event.items) this.inventory.set(item.bagId,{ ...item });
        this.inventoryKnown = true; if(event.cart!==undefined)this.cart=event.cart.map(i=>({...i}));
        this.equipment = event.equipment.slice(); this.ammoId = event.ammoId; this.inventoryRevision++; this.equipmentRevision++; break;
      case 'inventoryDelta': {
        if (this.stats) this.stats.weight = event.weight;
        if (!this.inventoryKnown) break;
        const previous = this.inventory.get(event.bagId);
        if (event.add && event.item) this.inventory.set(event.bagId,{ ...event.item });
        else if (previous) { if(event.change>previous.count){this.inventoryKnown=false;break;} const count = previous.count - event.change; if (count > 0) this.inventory.set(event.bagId,{ ...previous,count }); else this.inventory.delete(event.bagId); }
        else { this.inventoryKnown = false; break; }
        this.inventoryRevision++; break;
      }
      case 'inventoryItem': {
        const previous=this.inventory.get(event.item.bagId);
        if(!this.inventoryKnown || previous?.type!==2 || previous.itemId!==event.item.itemId || !previous.guid || previous.guid!==event.item.guid || previous.count!==event.item.count) {this.inventoryKnown=false;break;}
        this.inventory.set(event.item.bagId,{...event.item,slots:event.item.slots?.slice()});this.inventoryRevision++;break;
      }
      case 'equipment':
        if (event.slot === 13) this.ammoId = event.equipped ? event.bagId : -1;
        else { while (this.equipment.length <= event.slot) this.equipment.push(0); if (event.equipped) this.equipment[event.slot] = event.bagId; else if (this.equipment[event.slot] === event.bagId) this.equipment[event.slot] = 0; }
        this.equipmentRevision++; break;
      case 'skills':
        if (event.learned) { this.learned.clear(); for (const skill of event.learned) this.learned.set(skill.skillId,skill.level); this.skillsKnown = true; }
        if (event.granted) { this.granted.clear(); for (const skill of event.granted) this.granted.set(skill.skillId,skill.level); }
        this.skillsRevision++; break;
      case 'learnedSkill': this.learned.set(event.skillId,event.level); if (this.stats) this.stats.skillPoints = event.points; this.skillsRevision++; break;
      case 'currency': if (this.stats) this.stats.zeny = event.zeny; break;
      case 'experience': { const { type: _type, ...experience } = event; this.experience = experience; break; }
    }
  }
  count(itemId: number): number { return [...this.inventory.values()].reduce((n,item)=>n+(item.itemId===itemId?item.count:0),0); }
  skillLevel(skillId: number): number { return Math.max(this.learned.get(skillId) ?? 0,this.granted.get(skillId) ?? 0); }
  snapshot(): CharacterSnapshot {
    const clean = (item: InventoryItem): InventoryItem => ({ bagId:item.bagId,itemId:item.itemId,count:item.count,type:item.type,
      ...(item.flags !== undefined ? { flags:item.flags,refine:item.refine } : {}) });
    return { stats:this.stats ? { ...this.stats, ...(this.stats.attributes ? { attributes:[...this.stats.attributes] } : {}) } : null,
      inventoryKnown:this.inventoryKnown, skillsKnown:this.skillsKnown, inventory:[...this.inventory.values()].slice(0,600).map(clean),
      cart:this.cart?.slice(0,600).map(clean) ?? null, equipment:this.equipment.slice(0,14),ammoId:this.ammoId,
      learned:[...this.learned].slice(0,512).map(([skillId,level])=>({skillId,level})),
      granted:[...this.granted].slice(0,512).map(([skillId,level])=>({skillId,level})), sitting:this.sitting,
      statuses:[...this.statuses].slice(0,128).map(([id,seconds])=>({id,seconds})), experience:this.experience ? { ...this.experience } : null };
  }
}

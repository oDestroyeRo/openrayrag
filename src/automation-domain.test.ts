import { describe, expect, it } from 'vitest';
import { bagId, itemId, skillId, seconds, quantity, type ItemId } from './domain-values';
import { DEFAULT_AUTOMATION, validateAutomation, type AutomationPolicy, type AutomationSettings } from './settings';
import { admitDrop, acceptsLoot, effectiveSkillLevel, lootRule, type PendingFeature } from './automation-logic';
import { CharacterState } from './character-state';
import { selectAmmo, identity, permitted, type EquipmentIdentity } from './loadout-logic';
import { admitInventoryItem } from './character-state-logic';
import { recoveryItemCooldown } from './hp-potions';
import { recoveryItemIds } from './recovery-items';
import type { Entity } from './protocol';

describe('typed automation decision views', () => {
  it('admits ground item identity once and detaches the raw observation', () => {
    const raw = {id:9,itemId:909,count:3,isNew:true,x:100.5,y:99.25}, drop = admitDrop(raw);
    expect(JSON.stringify(drop)).toBe(JSON.stringify(raw));
    raw.itemId=910;raw.count=8;
    expect([drop.id,drop.itemId,drop.count,drop.x,drop.y]).toEqual([9,909,3,100.5,99.25]);
  });
  it('preserves filtered policy semantics without manufacturing aggregate proof', () => {
    const raw = structuredClone(DEFAULT_AUTOMATION);
    raw.loot.rules=[{itemId:909,action:'ignore',priority:3}];
    raw.skills=[{skillId:2,level:1,target:'self',hpBelowPercent:80,spAbovePercent:0,cooldownSeconds:3}];
    const admitted=validateAutomation(raw),filtered:AutomationPolicy={...admitted,skills:[],equipment:[]};
    expect(lootRule(filtered,itemId(909))).toEqual(raw.loot.rules[0]);
    expect(acceptsLoot(filtered,itemId(909))).toBe(false);
    expect(acceptsLoot(filtered,itemId(910))).toBe(true);
    expect(admitted.skills).toHaveLength(1);
    const state=new CharacterState();state.apply({type:'skills',learned:[{skillId:2,level:3}]},1);
    expect(effectiveSkillLevel(skillId(2),1,state)).toBe(3);
  });
});
function typeContracts(policy:AutomationPolicy,raw:AutomationSettings,state:CharacterState,player:Entity,pending:PendingFeature,equipment:EquipmentIdentity) {
  lootRule(policy,itemId(909));
  // @ts-expect-error A catalog item ID cannot be replaced with an inventory bag address.
  lootRule(policy,bagId(909));
  // @ts-expect-error Raw policies lack the admitted scalar types required by loot decisions.
  acceptsLoot(raw,itemId(909));
  // @ts-expect-error Raw IDs cannot enter effective-level decision lookup.
  effectiveSkillLevel(2,1,state);
  // @ts-expect-error Item and skill lookup identities are distinct.
  effectiveSkillLevel(itemId(2),1,state);
  // @ts-expect-error Equipment identity retains item IDs instead of bag addresses.
  const badEquipment:EquipmentIdentity={...equipment,itemId:bagId(700)};
  // @ts-expect-error Verified equipment permission lookup cannot take a bag ID.
  permitted(bagId(700),player);
  // @ts-expect-error Pure ammo selection consumes typed policy values, not drafts.
  selectAmmo(state,player,raw);
  // @ts-expect-error After action capture, deadline units cannot become seconds.
  pending.deadline=seconds(10);
  // @ts-expect-error Captured item stock is a quantity, not an arbitrary scalar.
  pending.count=10;
  const owned=admitInventoryItem({bagId:700,itemId:1201,count:1,type:2,guid:'owned'});
  const id:ItemId=identity(owned).itemId;
  const cooldown=seconds(3);
  // @ts-expect-error Shared recovery cooldown lookups use catalog identity.
  recoveryItemCooldown(policy,bagId(501));
  const recoveryIds:readonly ItemId[]=recoveryItemIds(policy.hpPotions,'hp');
  void [badEquipment,id,cooldown,recoveryIds,quantity(0)];
}
void typeContracts;

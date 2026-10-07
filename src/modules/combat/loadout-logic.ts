import { filter } from 'effect/Array';
import { pipe } from 'effect/Function';
import type { DomainInventoryItem as InventoryItem } from '../world/character-state-logic';
import { bagId as domainBagId, itemId as domainItemId, type ItemId, type BagId, type Quantity } from '../../shared/domain-values';
import catalog from '../../data/weapon-catalog.json';
import type { CharacterState } from '../world/character-state';
import type { Entity } from '../protocol/protocol';
import type { ExpandedAction } from '../protocol/protocol-feature';
import type { AutomationPolicy as AutomationSettings } from '../settings/settings';
interface Weapon { code:string; range:number; weaponClass:number; minLevel:number; jobs:number[]|null; twoHanded:boolean }

interface Armor { code:string; position:string; headPosition:string; minLevel:number; jobs:number[]|null }

export interface AmmoInfo { code:string; ammoType:number; minLevel:number; attack:number; property:string }

export const WEAPON_CATALOG: Readonly<Record<number,Weapon>> = catalog.items;

export const AMMO_CATALOG: Readonly<Record<number,AmmoInfo>> = catalog.ammo;

const armor: Readonly<Record<number,Armor>> = catalog.equipment;

export const slots = [0,1,2,3,4,5,6,7,8,9,13];

export type EquipmentIdentity = {readonly itemId:ItemId;readonly type:1|2;readonly guid?:string};
type Identity = EquipmentIdentity;

export type Vector = Array<Identity|null>;

export interface LoadoutSnapshot { state:'off'|'ready'|'switching'|'restoring'|'holding'|'fault'; reason:string; ammoItemId:ItemId|null; stock:Quantity|null; priorCaptured:boolean }

export type EquipmentConditionState = 'matched' | 'unmatched' | 'unavailable';

export interface LoadoutChange { action:Extract<ExpandedAction,{type:'equip'}>; expected:Vector; restoring:boolean }

export function identity(item:InventoryItem): Identity {
  if(item.type===2&&!item.guid)throw new Error('Unique equipment identity is unavailable.');
  return {itemId:item.itemId,type:item.type,...(item.guid?{guid:item.guid}:{})};
}

export function key(id:Identity|null):string { return id ? `${id.type}:${id.itemId}:${id.guid??''}` : ''; }

export function bag(state:CharacterState,slot:number):BagId|0 {const value=slot===13?Math.max(0,state.ammoId):state.equipment[slot]??0;return value===0?0:domainBagId(value);}

export function vector(state:CharacterState):Vector {
  if(!state.inventoryKnown||state.equipment.length<10)throw new Error('A full equipment and inventory update is required.');
  return slots.map(slot=>{const id=bag(state,slot);if(!id)return null;const item=state.inventory.get(domainBagId(id));
    // Exhausted regular ammo can remain equipped on the server.
    if(!item&&slot===13&&AMMO_CATALOG[id])return {itemId:domainItemId(id),type:1};
    if(!item)throw new Error('Equipped item is absent from verified inventory.');if(item.type===2&&[...state.inventory.values()].filter(i=>i.type===2&&i.guid===item.guid).length!==1)throw new Error('Unique equipment identity is ambiguous.');return identity(item);});
}

export function matches(a:Vector,b:Vector):boolean { return a.every((v,i)=>key(v)===key(b[i]??null)); }

export function resolve(state:CharacterState,id:Identity):InventoryItem|null {
  const found=[...state.inventory.values()].filter(i=>i.type===id.type&&(id.type===1?i.itemId===id.itemId:i.guid===id.guid));
  return found.length===1&&found[0]!.itemId===id.itemId?found[0]!:null;
}

export function permitted(itemId:ItemId,p:Entity):string|null {
  const info=WEAPON_CATALOG[itemId]??armor[itemId];
  if(!info)return `Equipment ${itemId} requirements are not verified.`;
  if(info.jobs===null)return `Equipment ${itemId} job requirements are unknown.`;
  if(!info.jobs.includes(p.classId))return `Equipment ${itemId} is not permitted for this job.`;
  if(p.level<info.minLevel)return `Equipment ${itemId} needs level ${info.minLevel}.`;
  return null;
}

function headPositions(name:string):string[] {return ({Top:['Top'],Mid:['Mid'],Bottom:['Bottom'],TopMid:['Top','Mid'],TopBottom:['Top','Bottom'],MidBottom:['Mid','Bottom'],All:['Top','Mid','Bottom']} as Record<string,string[]>)[name]??[];}

export function equipVector(state:CharacterState,p:Entity,item:InventoryItem):Vector {
  const next=vector(state),weapon=WEAPON_CATALOG[item.itemId],info=armor[item.itemId];
  let slot:number;
  if(AMMO_CATALOG[item.itemId])slot=13;
  else if(weapon){slot=p.classId===11&&!WEAPON_CATALOG[next[4]?.itemId??0]?.twoHanded&&!weapon.twoHanded&&next[4]&&!next[5]?5:4;if(weapon.twoHanded)next[5]=null;}
  else if(info){
    if(info.position==='Headgear'){
      const positions=headPositions(info.headPosition);slot=positions.includes('Top')?0:positions.includes('Mid')?1:positions.includes('Bottom')?2:-1;
      for(let i=0;i<3;i++){const old=armor[next[i]?.itemId??0];if(old&&headPositions(old.headPosition).some(pos=>positions.includes(pos)))next[i]=null;}
    } else slot=({Body:3,Armor:3,Shield:5,Garment:6,Boots:7,Footgear:7,Accessory:next[8]&&!next[9]?9:8} as Record<string,number>)[info.position]??-1;
    if(info.position==='Shield'&&WEAPON_CATALOG[next[4]?.itemId??0]?.twoHanded)next[4]=null;
  } else throw new Error(`Equipment ${item.itemId} position is unknown.`);
  const index=slots.indexOf(slot);if(index<0)throw new Error(`Equipment ${item.itemId} position is unsupported.`);
  next[index]=identity(item);return next;
}

export function selectAmmo(state:CharacterState,p:Entity,a:Pick<AutomationSettings,'loadout'>):InventoryItem|null {
  if(!state.inventoryKnown)throw new Error('Ammo stock is unknown.');
  for(const preference of a.loadout.ammoPreferences)if(!AMMO_CATALOG[preference.itemId]||AMMO_CATALOG[preference.itemId]!.ammoType!==0)throw new Error(`Preferred ammo ${preference.itemId} is not a verified arrow.`);
  const preference=(id:ItemId)=>{const i=a.loadout.ammoPreferences.findIndex(v=>v.itemId===id);return i<0?a.loadout.ammoPreferences.length:i;};
  const candidates=pipe([...state.inventory.values()],
    filter(i=>i.type===1&&AMMO_CATALOG[i.itemId]?.ammoType===0&&p.level>=AMMO_CATALOG[i.itemId]!.minLevel&&i.count>a.loadout.minAmmoStock),
    items => [...items].sort((x,y)=>preference(x.itemId)-preference(y.itemId)||(x.bagId===state.ammoId?-1:0)-(y.bagId===state.ammoId?-1:0)||x.itemId-y.itemId||x.bagId-y.bagId));
  return candidates[0]??null;
}

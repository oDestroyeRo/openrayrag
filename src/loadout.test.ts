import { describe,it,expect } from 'vitest';
import { CharacterState } from './character-state';
import { AMMO_CATALOG, WEAPON_CATALOG, LoadoutPolicy, selectAmmo, type LoadoutChange } from './loadout';
import { DEFAULT_AUTOMATION } from './settings';
import type { Entity } from './protocol';
import type { FeatureEvent, InventoryItem } from './protocol-feature';
const player:Entity={id:1,classId:5,name:'Thief',kind:0,level:50,hp:70,maxHp:100,x:10,y:10,dead:false};
const enemy:Entity={...player,id:2,classId:4000,kind:1};
const sword:InventoryItem={bagId:1001,itemId:1101,count:1,type:2,guid:'sword'};
const bow:InventoryItem={bagId:1002,itemId:1701,count:1,type:2,guid:'bow'};
const shield:InventoryItem={bagId:1003,itemId:2101,count:1,type:2,guid:'shield'};
const arrow:InventoryItem={bagId:1750,itemId:1750,count:20,type:1};
const silver:InventoryItem={bagId:1751,itemId:1751,count:20,type:1};
function setup(main=1001,off=1003,ammo=1750){
 let now=1000;const state=new CharacterState(),policy=new LoadoutPolicy(()=>now),a=structuredClone(DEFAULT_AUTOMATION);
 a.loadout.enabled=true;a.loadout.cooldownSeconds=1;a.loadout.minAmmoStock=3;
 state.apply({type:'inventory',items:[sword,bow,shield,arrow,silver],equipment:[0,0,0,0,main,off,0,0,0,0],ammoId:ammo},1);
 const observe=(e:FeatureEvent)=>{state.apply(e,1);return policy.observe(e,state);};
 const confirm=(change:LoadoutChange)=>{
   policy.begin(change,state);
   // Independent server behavior: two-handed bows clear shield and current main.
   if(change.action.equipped){if(change.action.bagId===1002&&state.equipment[5])observe({type:'equipment',bagId:state.equipment[5]!,slot:5,equipped:false});
    const item=state.inventory.get(change.action.bagId)!;
    const slot=AMMO_CATALOG[item.itemId]?13:WEAPON_CATALOG[item.itemId]?player.classId===11&&state.equipment[4]&&!state.equipment[5]&&!WEAPON_CATALOG[state.inventory.get(state.equipment[4]!)!.itemId]!.twoHanded?5:4:5;
    if(slot<10&&state.equipment[slot])observe({type:'equipment',bagId:state.equipment[slot]!,slot,equipped:false});
    observe({type:'equipment',bagId:change.action.bagId,slot,equipped:true});
   }else{const slot=state.ammoId===change.action.bagId?13:state.equipment.indexOf(change.action.bagId);observe({type:'equipment',bagId:change.action.bagId,slot,equipped:false});}
   expect(policy.receipt(state)).toBe(true);policy.confirmed(state);now+=1000;
 };
 return {state,policy,a,observe,confirm,advance:(ms=1000)=>now+=ms};
}
describe('source-backed loadout ownership',()=>{
 it('uses source ammo types, deterministic preferences/current stack and observed reserve',()=>{
  const {state,a}=setup();expect(AMMO_CATALOG[1750]?.ammoType).toBe(0);expect(AMMO_CATALOG[13200]?.ammoType).not.toBe(0);
  expect(selectAmmo(state,player,a)?.itemId).toBe(1750);a.loadout.ammoPreferences=[{itemId:1751}];expect(selectAmmo(state,player,a)?.itemId).toBe(1751);
  state.inventory.set(1751,{...silver,count:3});expect(selectAmmo(state,player,a)?.itemId).toBe(1750);
  state.inventory.set(1750,{...arrow,count:3});expect(selectAmmo(state,player,a)).toBe(null);
  a.loadout.ammoPreferences=[{itemId:13200}];expect(()=>selectAmmo(state,player,a)).toThrow('verified arrow');
  state.inventoryKnown=false;expect(()=>selectAmmo(state,player,a)).toThrow('unknown');
 });
 it('blocks unknown requirements and wrong jobs before sending a conditional equip',()=>{
  const {state,policy,a}=setup();a.equipment=[{itemId:1701,hpBelowPercent:100,monsterClassId:0}];
  expect(policy.next(a,{...player,classId:0},state,enemy).failure).toContain('job');
  expect(policy.next(a,{...player,level:1},state,enemy).failure).toContain('level');
  a.equipment[0]!.itemId=13100;expect(policy.next(a,player,state,enemy).failure).toContain('not verified');
 });
 it('waits for the complete two-handed slot readback, then restores sword and shield',()=>{
  const {state,policy,a,observe,advance}=setup();a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];
  const change=policy.next(a,player,state,enemy).change!;policy.begin(change,state);
  observe({type:'equipment',bagId:1002,slot:5,equipped:true});expect(policy.receipt(state)).toBe(false);
  // Restart fixture for a legitimate source-shaped sequence.
  const t=setup();t.a.equipment=a.equipment;const first=t.policy.next(t.a,player,t.state,enemy).change!;t.confirm(first);
  expect(t.state.equipment.slice(4,6)).toEqual([1002,0]);t.a.equipment=[];
  for(let n=0;n<5;n++){const planned=t.policy.next(t.a,player,t.state,null);expect(planned.failure).toBeUndefined();if(planned.change)t.confirm(planned.change);}
  expect(t.state.equipment.slice(4,6)).toEqual([1001,1003]);expect(t.policy.snapshot(t.a,t.state).priorCaptured).toBe(false);advance();
 });
 it('does not confuse inventory revision, GUID-preserving renumber or identical item IDs',()=>{
  const t=setup();t.a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];t.confirm(t.policy.next(t.a,player,t.state,enemy).change!);
  const items=[...t.state.inventory.values()].map(i=>i.type===2?{...i,bagId:i.bagId+100}:i);
  expect(t.observe({type:'inventory',items,equipment:[0,0,0,0,1102,0,0,0,0,0],ammoId:1750})).toBe(null);
  t.a.equipment=[];for(let n=0;n<5;n++){const c=t.policy.next(t.a,player,t.state,null).change;if(c)t.confirm({...c,action:{...c.action}});}
  expect(t.state.equipment.slice(4,6)).toEqual([1101,1103]);
  expect(t.policy.snapshot(t.a,t.state).state).not.toBe('fault');
 });
 it('cancels restoration on an unrelated manual equipment override or Stop',()=>{
  const t=setup();t.a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];t.confirm(t.policy.next(t.a,player,t.state,enemy).change!);
  expect(t.observe({type:'equipment',bagId:1001,slot:4,equipped:true})).toContain('outside');expect(t.policy.snapshot(t.a,t.state).priorCaptured).toBe(false);
  const second=setup();second.a.equipment=t.a.equipment;second.confirm(second.policy.next(second.a,player,second.state,enemy).change!);second.policy.cancel();second.a.equipment=[];
  expect(second.policy.next(second.a,player,second.state,null)).toEqual({});
 });
 it('reports missing prior identities and never substitutes another copy',()=>{
  const t=setup();t.a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];t.confirm(t.policy.next(t.a,player,t.state,enemy).change!);
  t.state.inventory.delete(1001);t.state.inventory.set(2001,{...sword,bagId:2001,guid:'different'});t.a.equipment=[];
  expect(t.policy.next(t.a,player,t.state,null).failure).toContain('missing');
 });
 it('keeps an uncertain Stop blocked after its deadline, and only0 target clear releases it',()=>{
  const {state,policy,a,observe,advance}=setup(1002,0);policy.attackDispatched();expect(policy.requestStop('Ammo reserve.')).toBe(true);expect(policy.requestStop('Again')).toBe(false);
  advance(7000);policy.tick();expect(policy.snapshot(a,state).reason).toContain('no authoritative');expect(policy.blocked).toBe(true);
  observe({type:'changeTarget',id:2});expect(policy.blocked).toBe(true);observe({type:'changeTarget',id:0});expect(policy.blocked).toBe(false);
 });
 it('does not dispatch a bow attack at reserve or with an unknown/incompatible stack',()=>{
  const {state,policy,a}=setup(1002,0);expect(policy.attackGuard(a,player,state)).toBe(null);
  state.inventory.set(1750,{...arrow,count:3});expect(policy.attackGuard(a,player,state)).toContain('reserve');
  state.ammoId=13200;expect(policy.attackGuard(a,player,state)).toContain('verified arrows');state.inventoryKnown=false;expect(policy.attackGuard(a,player,state)).toContain('unknown');
 });
 it.each([2,3,4])('holds ammo failure subtype%s without converting it into equip confirmation',event=>{
  const {state,policy,a}=setup(1002,0);expect(policy.observe({type:'serverEvent',event,value:0,text:''},state)).toBeTruthy();expect(policy.snapshot(a,state).state).toBe('fault');
 });
 it('ignores non-ammo ServerEvents and never restores when policy says keep loadout',()=>{
  const t=setup();expect(t.policy.observe({type:'serverEvent',event:1,value:0,text:''},t.state)).toBe(null);
  t.a.loadout.restore='never';t.a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];t.confirm(t.policy.next(t.a,player,t.state,enemy).change!);t.a.equipment=[];expect(t.policy.next(t.a,player,t.state,null)).toEqual({});
 });
});
describe('displaced slots and canceled receipts',()=>{
 it('restores an Assassin main and offhand using source default slot ordering',()=>{
  const t=setup(1001,1004);const assassin={...player,classId:11};t.state.inventory.set(1004,{bagId:1004,itemId:1301,type:2,count:1,guid:'offhand'});
  t.a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];const first=t.policy.next(t.a,assassin,t.state,enemy).change!;t.policy.begin(first,t.state);
  for(const e of [{type:'equipment',bagId:1004,slot:5,equipped:false},{type:'equipment',bagId:1001,slot:4,equipped:false},{type:'equipment',bagId:1002,slot:4,equipped:true}] as FeatureEvent[])expect(t.observe(e)).toBe(null);
  expect(t.policy.receipt(t.state)).toBe(true);t.policy.confirmed(t.state);t.a.equipment=[];t.advance();
  for(const [bagId,slot,equipped] of [[1002,4,false],[1001,4,true],[1004,5,true]] as const){const c=t.policy.next(t.a,assassin,t.state,null).change!;expect(c.action).toEqual({type:'equip',bagId,equipped});t.policy.begin(c,t.state);t.observe({type:'equipment',bagId,slot,equipped});expect(t.policy.receipt(t.state)).toBe(true);t.policy.confirmed(t.state);t.advance();}
  expect(t.policy.next(t.a,assassin,t.state,null)).toEqual({});expect(t.state.equipment.slice(4,6)).toEqual([1001,1004]);
 });
 it.each([2224,2264])('displaces source head mask%s and restores the exact top and mid items',itemId=>{
  const t=setup();for(const item of [{bagId:2001,itemId:2206,type:2,count:1,guid:'top'},{bagId:2002,itemId:2201,type:2,count:1,guid:'mid'},{bagId:2003,itemId,type:2,count:1,guid:'combined'}] as InventoryItem[])t.state.inventory.set(item.bagId,item);
  t.state.equipment[0]=2001;t.state.equipment[1]=2002;t.a.equipment=[{itemId,hpBelowPercent:100,monsterClassId:0}];
  const first=t.policy.next(t.a,player,t.state,enemy).change!;expect(first.action).toEqual({type:'equip',bagId:2003,equipped:true});t.policy.begin(first,t.state);
  for(const e of [{type:'equipment',bagId:2001,slot:0,equipped:false},{type:'equipment',bagId:2002,slot:1,equipped:false},{type:'equipment',bagId:2003,slot:0,equipped:true}] as FeatureEvent[])expect(t.observe(e)).toBe(null);
  expect(t.policy.receipt(t.state)).toBe(true);t.policy.confirmed(t.state);t.a.equipment=[];t.advance();
  for(const [bagId,slot,equipped] of [[2003,0,false],[2001,0,true],[2002,1,true]] as const){const c=t.policy.next(t.a,player,t.state,null).change!;expect(c.action).toEqual({type:'equip',bagId,equipped});t.policy.begin(c,t.state);t.observe({type:'equipment',bagId,slot,equipped});expect(t.policy.receipt(t.state)).toBe(true);t.policy.confirmed(t.state);t.advance();}
  expect(t.state.equipment.slice(0,3)).toEqual([2001,2002,0]);expect(t.policy.next(t.a,player,t.state,null)).toEqual({});
 });
 it('refuses missing unique identity metadata',()=>{const t=setup();t.state.inventory.set(1001,{...sword,guid:undefined});expect(t.policy.next(t.a,player,t.state,enemy).failure).toContain('identity');});
 it('does not release canceled equipment on time or an unchanged snapshot, but accepts the exact late slot sequence',()=>{
  const t=setup();t.a.equipment=[{itemId:1701,hpBelowPercent:80,monsterClassId:0}];const c=t.policy.next(t.a,player,t.state,enemy).change!;t.policy.begin(c,t.state);t.policy.cancel();t.advance(30000);t.policy.tick();
  t.observe({type:'inventory',items:[...t.state.inventory.values()],equipment:t.state.equipment.slice(),ammoId:t.state.ammoId});expect(t.policy.blocked).toBe(true);
  for(const e of [{type:'equipment',bagId:1003,slot:5,equipped:false},{type:'equipment',bagId:1001,slot:4,equipped:false},{type:'equipment',bagId:1002,slot:4,equipped:true}] as FeatureEvent[])expect(t.observe(e)).toBe(null);
  expect(t.policy.blocked).toBe(false);expect(t.policy.snapshot(t.a,t.state).priorCaptured).toBe(false);
 });
});

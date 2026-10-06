import { describe, expect, it } from 'vitest';
import cases from './data/recovery-item-cases.json';
import catalog from './data/recovery-item-catalog.json';
import gameCatalog from './data/game-catalog.json';
import { RECOVERY_ITEM_IDS, DEFAULT_RECOVERY_ITEMS, DEFAULT_SP_ITEMS, validateRecoveryItems, type RecoveryResource } from './recovery-items';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, validateSettings } from './settings';
import { CharacterState } from './character-state';
import { AutomationScheduler } from './automation';
import { dispositionStockFloors } from './disposition-ui';
import { recoveryItemCooldown } from './hp-potions';
import { formDocument } from './current-form';
import { ITEM_CATALOG } from './game-catalog';
import { validateWorkflowSpec } from './workflows';
import type { Entity } from './protocol';

const player: Entity = {id:1,classId:6,name:'Test',kind:0,level:10,hp:55,maxHp:100,x:100,y:100,dead:false};
function fixture(stock: [number,number][]) {
  let now=100_000;
  const state=new CharacterState(), scheduler=new AutomationScheduler(()=>{},()=>now);
  state.apply({type:'inventory',items:stock.map(([itemId,count])=>({bagId:itemId,itemId,count,type:1})),equipment:[],ammoId:-1},1);
  state.apply({type:'stats',level:10,hp:55,maxHp:100,sp:10,maxSp:100},1);
  const automation=structuredClone(DEFAULT_AUTOMATION);
  automation.hpPotions={...DEFAULT_RECOVERY_ITEMS,mode:'any'};
  automation.spPotions={...DEFAULT_SP_ITEMS,mode:'any'};
  return {state,scheduler,automation,advance:(ms:number)=>{now+=ms;},consume:(itemId:number)=>{
    const event={type:'inventoryDelta' as const,add:false,bagId:itemId,change:1,weight:0};
    state.apply(event,1);return scheduler.observe(event,state,1);
  }};
}

describe('carried HP and SP recovery items',()=>{
  it.each(cases)('shares the native settings and current-form case: $name',row=>{
    const automation=structuredClone(DEFAULT_AUTOMATION),key=row.resource==='hp'?'hpPotions':'spPotions';
    if(!row.absent)Object.assign(automation,{[key]:row.policy});
    const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation};
    if(row.valid) {
      expect(validateSettings(settings).automation?.[key]).toEqual(row.policy);
      expect(formDocument({version:1,revision:0,selectedProfileId:null,settings}).settings).toEqual(settings);
    } else expect(()=>validateSettings(settings)).toThrow();
  });
  it('classifies only direct untargeted healing effects from matching pinned client items',()=>{
    expect(catalog.clientItemsSha256).toBe(gameCatalog.sources.items.sha256);
    expect(catalog.sourcePin).toBe('4099e2c000c3c550516760b9c1241595aac9aceb');
    expect(RECOVERY_ITEM_IDS.hp).toContain(512);expect(RECOVERY_ITEM_IDS.hp).toContain(515);expect(RECOVERY_ITEM_IDS.hp).toContain(507);
    expect(RECOVERY_ITEM_IDS.sp).toContain(514);expect(RECOVERY_ITEM_IDS.sp).toContain(505);
    expect(RECOVERY_ITEM_IDS.hp).not.toContain(514);expect(RECOVERY_ITEM_IDS.sp).not.toContain(512);
    for(const resource of ['hp','sp'] as const) {
      expect(new Set(RECOVERY_ITEM_IDS[resource]).size).toBe(RECOVERY_ITEM_IDS[resource].length);
      for(const id of RECOVERY_ITEM_IDS[resource])expect(ITEM_CATALOG[id]).toMatchObject({itemClass:1,useType:1});
      for(const id of [506,511,601,602,645,656,657])expect(RECOVERY_ITEM_IDS[resource]).not.toContain(id);
    }
  });
  it('uses carried HP food while excluding unrelated consumables and SP-only food',()=>{
    const f=fixture([[512,2],[514,20],[511,20],[601,20]]);
    expect(f.scheduler.next(f.automation,player,f.state,null).action).toEqual({type:'useItem',itemId:512});
  });
  it('uses carried SP food at its own threshold with HP full',()=>{
    const f=fixture([[512,20],[514,2],[505,10]]),fullHp={...player,hp:100};
    expect(f.scheduler.next(f.automation,fullHp,f.state,null).action).toEqual({type:'useItem',itemId:514});
    f.automation.spPotions!.belowPercent=9;
    expect(f.scheduler.next(f.automation,fullHp,f.state,null)).toEqual({});
  });
  it('honors selected SP order and server-confirmed fallback through the shared cooldown',()=>{
    const f=fixture([[514,2],[505,1]]),fullHp={...player,hp:100};
    f.automation.spPotions={...DEFAULT_SP_ITEMS,mode:'selected',itemIds:[505,514]};
    const action=f.scheduler.next(f.automation,fullHp,f.state,null).action!;
    expect(action).toEqual({type:'useItem',itemId:505});f.scheduler.submit(action,f.state);
    expect(f.scheduler.next(f.automation,fullHp,f.state,null)).toEqual({});
    expect(f.consume(514).state).toBe('ignored');expect(f.consume(505).state).toBe('confirmed');
    f.advance(4999);expect(f.scheduler.next(f.automation,fullHp,f.state,null)).toEqual({});
    f.advance(1);expect(f.scheduler.next(f.automation,fullHp,f.state,null).action).toEqual({type:'useItem',itemId:514});
  });
  it('requires observed SP and full inventory before choosing SP items',()=>{
    const f=fixture([[514,3]]),fullHp={...player,hp:100};f.state.inventoryKnown=false;
    expect(f.scheduler.next(f.automation,fullHp,f.state,null).failure).toContain('full inventory');
    f.state.inventoryKnown=true;f.state.stats=null;
    expect(f.scheduler.next(f.automation,fullHp,f.state,null).failure).toContain('SP is unavailable');
    f.automation.spPotions!.mode='off';expect(f.scheduler.next(f.automation,fullHp,f.state,null)).toEqual({});
  });
  it('protects the larger reserve when an item is selected for both resources',()=>{
    const f=fixture([[518,5]]);
    f.automation.hpPotions={...DEFAULT_RECOVERY_ITEMS,mode:'selected',itemIds:[518],minStock:0};
    f.automation.spPotions={...DEFAULT_SP_ITEMS,mode:'selected',itemIds:[518],minStock:5};
    expect(f.scheduler.next(f.automation,player,f.state,null)).toEqual({});
    expect(dispositionStockFloors(f.automation)).toEqual([{itemId:518,count:5}]);
  });
  it('keeps combined recovery, advanced, ammo and escape reserves within the workflow contract',()=>{
    const f=fixture([]);
    f.automation.hpPotions!.minStock=1;f.automation.spPotions!.minStock=1;
    f.automation.items=Array.from({length:32},(_,index)=>({itemId:10_000+index,resource:'hp' as const,belowPercent:60,minStock:1,cooldownSeconds:5}));
    f.automation.loadout.enabled=true;f.automation.loadout.minAmmoStock=1;
    f.automation.escape={...f.automation.escape!,enabled:true,method:'item',mode:'random',minStock:1};
    const minStock=dispositionStockFloors(f.automation);
    expect(minStock.length).toBeGreaterThan(100);
    const spec={name:'Protected recovery stock',map:'prontera',npcId:1,maxSpend:0,minStock,steps:[{type:'talk'}]};
    expect(()=>validateWorkflowSpec(spec)).not.toThrow();
    expect(()=>validateWorkflowSpec({...spec,minStock:Array.from({length:161},(_,i)=>({itemId:i+1,count:1}))})).toThrow();
  });
  it.each(['hp','sp'] as const)('shared healing honors the longer cooldown when %s remains low, with single-resource fallback',shortResource=>{
    const f=fixture([[518,20],[512,2],[514,2]]),p=shortResource==='hp'?player:{...player,hp:100};
    f.automation.hpPotions={...DEFAULT_RECOVERY_ITEMS,mode:'selected',itemIds:[518],cooldownSeconds:shortResource==='hp'?5:30};
    f.automation.spPotions={...DEFAULT_SP_ITEMS,mode:'selected',itemIds:[518],cooldownSeconds:shortResource==='sp'?5:30};
    const action=f.scheduler.next(f.automation,p,f.state,null).action!;
    f.scheduler.submit(action,f.state);expect(f.consume(518).state).toBe('confirmed');
    f.advance(5000);expect(f.scheduler.next(f.automation,p,f.state,null)).toEqual({});
    const shortPolicy=shortResource==='hp'?f.automation.hpPotions:f.automation.spPotions,fallback=shortResource==='hp'?512:514;
    shortPolicy.itemIds.push(fallback);
    expect(f.scheduler.next(f.automation,p,f.state,null).action).toEqual({type:'useItem',itemId:fallback});
    // The mixed item's effect starts both group timers even when the other group selects different items.
    const otherPolicy=shortResource==='hp'?f.automation.spPotions:f.automation.hpPotions;
    otherPolicy.itemIds=[shortResource==='hp'?514:512];shortPolicy.itemIds=[518];
    expect(f.scheduler.next(f.automation,p,f.state,null)).toEqual({});
    otherPolicy.mode='off';expect(f.scheduler.next(f.automation,p,f.state,null).action).toEqual({type:'useItem',itemId:518});
    otherPolicy.mode='selected';
    f.advance(25000);expect(f.scheduler.next(f.automation,p,f.state,null).action).toEqual({type:'useItem',itemId:518});
    expect(recoveryItemCooldown(f.automation,518)).toBe(30);
  });
  it('keeps advanced conditions authoritative for SP items and protects SP stock in workflows',()=>{
    const f=fixture([[514,20],[505,3]]),fullHp={...player,hp:100};
    f.automation.items=[{itemId:514,resource:'sp',belowPercent:5,minStock:4,cooldownSeconds:20}];
    f.automation.spPotions!.minStock=2;
    expect(f.scheduler.next(f.automation,fullHp,f.state,null).action).toEqual({type:'useItem',itemId:505});
    expect(dispositionStockFloors(f.automation).find(row=>row.itemId===514)).toEqual({itemId:514,count:4});
    expect(recoveryItemCooldown(f.automation,514)).toBe(20);
  });
  it.each(['hp','sp'] as const)('validates every %s policy field, including explicit null',resource=>{
    const valid={...DEFAULT_RECOVERY_ITEMS,mode:'selected',itemIds:[resource==='hp'?512:514]};
    for(const field of Object.keys(valid)) {
      const missing:Record<string,unknown>={...valid};delete missing[field];
      expect(()=>validateRecoveryItems(missing,resource)).toThrow();
      expect(()=>validateRecoveryItems({...valid,[field]:null},resource)).toThrow();
    }
    expect(()=>validateRecoveryItems({...valid,mode:{selected:null}},resource as RecoveryResource)).toThrow();
  });
});

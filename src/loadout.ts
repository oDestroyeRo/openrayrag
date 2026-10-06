import { bagId as domainBagId } from './domain-values';
import type { CharacterState } from './character-state';
import type { Entity } from './protocol';
import type { FeatureEvent } from './protocol-feature';
import type { AutomationSettingsInput as AutomationSettings, ReadonlyData, EquipmentRule } from './settings';

import { WEAPON_CATALOG, AMMO_CATALOG, slots, type Vector, type LoadoutSnapshot, type EquipmentConditionState, type LoadoutChange, identity, key, bag, vector, matches, resolve, permitted, equipVector, selectAmmo } from './loadout-logic';

export { type AmmoInfo, WEAPON_CATALOG, AMMO_CATALOG, type LoadoutSnapshot, type EquipmentConditionState, type LoadoutChange, selectAmmo } from './loadout-logic';

/** In-memory ownership only. Profiles never contain identities or receipts. */
export class LoadoutPolicy {
  private prior:Vector|null=null;
  private expected:Vector|null=null;
  private pending:{before:Vector;change:LoadoutChange;revision:number}|null=null;
  private restoring=false;
  private equipmentConditionOwned=false;
  private lastChange=-Infinity;
  private firing=false;
  private holdSince:number|null=null;
  private holdReason='';
  private fault='';
  private ammoFault=false;
  private reserve=0;
  private ammoConfig:{a:AutomationSettings;p:Entity}|null=null;
  private faultInventoryRevision=0;
  private uncertain:{before:Vector;expected:Vector;revision:number}|null=null;
  constructor(private readonly now:()=>number) {}
  reset(preserveUncertainty=false):void {this.cancel();this.firing=false;this.holdSince=null;this.holdReason='';this.fault='';this.ammoFault=false;this.expected=null;if(!preserveUncertainty)this.uncertain=null;this.lastChange=-Infinity;}
  cancel():void {if(this.pending)this.uncertain={before:this.pending.before,expected:this.pending.change.expected,revision:this.pending.revision};this.prior=null;this.pending=null;this.restoring=false;this.equipmentConditionOwned=false;}
  acknowledgeOverride():void {this.cancel();this.expected=null;if(!this.ammoFault)this.fault='';}
  newRun():void {this.cancel();}
  get blocked():boolean {return this.holdSince!==null||!!this.fault||this.uncertain!==null;}
  get equipmentSettled():boolean {return this.pending===null&&this.uncertain===null;}
  get startBlocked():boolean {return this.holdSince!==null||this.ammoFault||this.uncertain!==null;}
  get needsStop():boolean {return this.firing&&this.holdSince===null;}
  attackDispatched():void {this.firing=true;}
  requestStop(reason:string):boolean {
    if(!this.needsStop)return false;
    this.holdSince=this.now();this.holdReason=reason;return true;
  }
  stockFault(reason:string,state:CharacterState):void {this.ammoFault=true;this.fault=reason;this.faultInventoryRevision=state.inventoryRevision;}
  tick():void {if(this.holdSince!==null&&this.now()-this.holdSince>=6000)this.holdReason='Stop has no authoritative target-clear confirmation. New attacks and equipment changes remain blocked.';}
  observe(e:FeatureEvent,state:CharacterState,enabled=true):string|null {
    if(e.type==='changeTarget'&&e.id===0){this.firing=false;this.holdSince=null;this.holdReason='';}
    if(enabled&&e.type==='serverEvent'&&[2,3,4].includes(e.event)){
      this.ammoFault=true;this.faultInventoryRevision=state.inventoryRevision;
      this.fault=({2:'No ammunition is equipped.',3:'The equipped ammunition is incompatible.',4:'Ammunition is exhausted.'} as Record<number,string>)[e.event]!;
      return this.fault;
    }
    if(this.ammoFault&&!this.firing&&this.holdSince===null&&state.inventoryKnown&&state.inventoryRevision>this.faultInventoryRevision){
      const current=state.ammoId>0?state.inventory.get(domainBagId(state.ammoId)):undefined;
      let supplied=!!current&&AMMO_CATALOG[current.itemId]?.ammoType===0&&current.count>this.reserve;
      if(!supplied&&this.ammoConfig?.a.loadout.autoAmmo){try{supplied=selectAmmo(state,this.ammoConfig.p,this.ammoConfig.a)!==null;}catch{/* Invalid preferences retain the fault. */}}
      if(supplied){this.ammoFault=false;this.fault='';}
    }
    if(this.uncertain&&['equipment','inventory'].includes(e.type)&&state.equipmentRevision>this.uncertain.revision){try{const actual=vector(state);if(matches(actual,this.uncertain.expected)){this.uncertain=null;this.expected=actual;}}catch{/* Unknown identities retain the fence. */}}
    if(!['equipment','inventory','inventoryDelta'].includes(e.type)||!this.expected)return null;
    try {
      const actual=vector(state);
      const owner=this.pending?{before:this.pending.before,expected:this.pending.change.expected}:this.uncertain;
      if(owner){
        const {before,expected}=owner;
        if(!actual.every((id,i)=>key(id)===key(before[i]??null)||key(id)===key(expected[i]??null)||(key(before[i]??null)!==key(expected[i]??null)&&id===null)))throw new Error('Equipment changed outside the owned loadout request.');
      }else if(!matches(actual,this.expected))throw new Error('Equipment changed outside automation; restoration was canceled.');
    }catch(error){this.fault=error instanceof Error?error.message:'Equipment identity is unavailable.';this.cancel();return this.fault;}
    return null;
  }
  receipt(state:CharacterState):boolean {return !!this.pending&&state.equipmentRevision>this.pending.revision&&matches(vector(state),this.pending.change.expected);}
  confirmed(state:CharacterState):void {
    if(!this.pending)return;
    this.expected=vector(state);this.pending=null;this.lastChange=this.now();
  }
  begin(change:LoadoutChange,state:CharacterState):void {
    const before=vector(state);this.prior??=before;this.expected??=before;
    this.pending={before,change,revision:state.equipmentRevision};this.restoring=change.restoring;
  }
  attackGuard(a:AutomationSettings,p:Entity,state:CharacterState):string|null {
    this.reserve=a.loadout.minAmmoStock;this.ammoConfig={a,p};
    if(!a.loadout.enabled)return null;
    if(this.blocked)return this.fault||this.holdReason;
    if(!state.inventoryKnown||state.equipment.length<10)return 'Weapon and ammo stock are unknown.';
    const id=state.equipment[4]??0;if(!id)return null;
    const item=state.inventory.get(domainBagId(id)),weapon=item?WEAPON_CATALOG[item.itemId]:undefined;
    if(!weapon)return 'Normal-attack weapon compatibility is not verified.';
    if(weapon.weaponClass!==12)return null;
    const ammo=state.ammoId>0?state.inventory.get(domainBagId(state.ammoId)):undefined,info=ammo?AMMO_CATALOG[ammo.itemId]:undefined;
    if(!ammo||!info||info.ammoType!==0)return 'Equip verified arrows before attacking.';
    if(p.level<info.minLevel)return `Ammo needs level ${info.minLevel}.`;
    if(ammo.count<=a.loadout.minAmmoStock)return `Observed ammo stock ${ammo.count} reached the reserve ${a.loadout.minAmmoStock}.`;
    return null;
  }
  snapshot(a:AutomationSettings,state:CharacterState):LoadoutSnapshot {
    const ammo=state.ammoId>0?state.inventory.get(domainBagId(state.ammoId)):undefined;
    return {state:this.uncertain?'fault':this.fault?'fault':this.holdSince!==null?'holding':!a.loadout.enabled?'off':this.pending?(this.restoring?'restoring':'switching'):'ready',reason:this.uncertain?'Waiting for authoritative reconciliation of the canceled equipment request.':this.fault||this.holdReason,ammoItemId:ammo?.itemId??null,stock:state.inventoryKnown?ammo?.count??0:null,priorCaptured:this.prior!==null};
  }
  next(a:AutomationSettings,p:Entity,state:CharacterState,enemy:Entity|null,
    conditionState:(rule:ReadonlyData<EquipmentRule>)=>EquipmentConditionState=rule=>rule.conditions?.length?'unavailable':'matched'):{change?:LoadoutChange;failure?:string} {
    this.reserve=a.loadout.minAmmoStock;this.ammoConfig={a,p};
    if(!a.loadout.enabled||this.pending||this.blocked)return {};
    try {
      const hp=p.hp/p.maxHp*100;
      const relevant=a.equipment.filter(rule=>hp<=rule.hpBelowPercent&&(!rule.monsterClassId||enemy?.classId===rule.monsterClassId))
        .map(rule=>({rule,state:conditionState(rule)}));
      const rule=relevant.find(entry=>entry.state==='matched')?.rule;
      // Unknown evidence cannot establish condition end or authorize restoration.
      if(!rule&&relevant.some(entry=>entry.state==='unavailable'))return {};
      const current=vector(state);
      const weaponId=state.equipment[4]??0,weaponItem=weaponId>0?state.inventory.get(domainBagId(weaponId)):undefined,weapon=weaponItem?WEAPON_CATALOG[weaponItem.itemId]:undefined;
      const ammoCondition=!!enemy&&weapon?.weaponClass===12&&a.loadout.autoAmmo;
      if(!this.restoring&&this.prior&&!rule&&(this.equipmentConditionOwned||!ammoCondition)&&a.loadout.restore==='conditionEnd')this.restoring=true;
      if(this.now()-this.lastChange<a.loadout.cooldownSeconds*1000)return {};
      if(this.restoring&&this.prior){
        // Clear changed slot groups before restoring: source default equip has no
        // explicit slot and can choose offhand/accessory2 based on current state.
        const changes=slots.filter((_,i)=>key(current[i]??null)!==key(this.prior![i]??null));
        if(!changes.length){this.cancel();return {};}
        const affected=new Set(changes);
        for(const group of [[4,5],[8,9],[0,1,2]])if(group.some(s=>affected.has(s)))for(const s of group)affected.add(s);
        for(const id of this.prior){if(id&&!resolve(state,id))throw new Error(`Prior item ${id.itemId} is missing or its identity is ambiguous; restoration canceled.`);}
        // Find a current item that prevents placing the next prior item. Clear
        // all affected groups until empty, then restore in deterministic order.
        const order=[4,5,0,1,2,3,6,7,8,9,13];
        for(const slot of order){if(!affected.has(slot))continue;const i=slots.indexOf(slot),desired=this.prior[i];
          if(key(current[i]??null)===key(desired??null))continue;
          if(current[i]){const expected=current.slice();expected[i]=null;return {change:{action:{type:'equip',bagId:bag(state,slot),equipped:false},expected,restoring:true}};}
          if(desired){const item=resolve(state,desired)!;const problem=AMMO_CATALOG[item.itemId]?item.count<=a.loadout.minAmmoStock?'Prior ammo is at the reserve.':null:permitted(item.itemId,p);if(problem)throw new Error(problem);
            const expected=equipVector(state,p,item);if(key(expected[i]??null)!==key(desired)||expected.some((v,j)=>j!==i&&key(v)!==key(current[j]??null))) {
              const blocker=slot===4?5:slot===8?9:-1;
              if(blocker>=0&&bag(state,blocker)){const expected=current.slice();expected[slots.indexOf(blocker)]=null;return {change:{action:{type:'equip',bagId:bag(state,blocker),equipped:false},expected,restoring:true}};}
              throw new Error('Prior loadout cannot be restored into its exact original slots.');
            }
            return {change:{action:{type:'equip',bagId:item.bagId,equipped:true},expected,restoring:true}};
          }
        }
        return {};
      }
      if(rule){
        this.equipmentConditionOwned=true;
        const problem=permitted(rule.itemId,p);if(problem)throw new Error(problem);
        const found=[...state.inventory.values()].filter(i=>i.itemId===rule.itemId&&i.count>0).sort((x,y)=>x.bagId-y.bagId);
        const item=found[0];if(!item)throw new Error(`Conditional equipment ${rule.itemId} is missing.`);
        if(!current.some(id=>key(id)===key(identity(item))))return {change:{action:{type:'equip',bagId:item.bagId,equipped:true},expected:equipVector(state,p,item),restoring:false}};
      }
      if(ammoCondition){const item=selectAmmo(state,p,a);if(!item)throw new Error('No compatible arrow stack is above the configured reserve.');if(state.ammoId!==item.bagId)return {change:{action:{type:'equip',bagId:item.bagId,equipped:true},expected:equipVector(state,p,item),restoring:false}};}
      return {};
    }catch(error){return {failure:error instanceof Error?error.message:'Loadout state is unavailable.'};}
  }
}

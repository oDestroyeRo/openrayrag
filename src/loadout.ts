import catalog from './data/weapon-catalog.json';
import type { CharacterState } from './character-state';
import type { Entity } from './protocol';
import type { ExpandedAction, FeatureEvent, InventoryItem } from './protocol-feature';
import type { AutomationSettings, EquipmentRule } from './settings';

interface Weapon { code:string; range:number; weaponClass:number; minLevel:number; jobs:number[]|null; twoHanded:boolean }
interface Armor { code:string; position:string; headPosition:string; minLevel:number; jobs:number[]|null }
export interface AmmoInfo { code:string; ammoType:number; minLevel:number; attack:number; property:string }
export const WEAPON_CATALOG: Readonly<Record<number,Weapon>> = catalog.items;
export const AMMO_CATALOG: Readonly<Record<number,AmmoInfo>> = catalog.ammo;
const armor: Readonly<Record<number,Armor>> = catalog.equipment;
const slots = [0,1,2,3,4,5,6,7,8,9,13];
type Identity = { itemId:number; type:1|2; guid?:string };
type Vector = Array<Identity|null>;
export interface LoadoutSnapshot { state:'off'|'ready'|'switching'|'restoring'|'holding'|'fault'; reason:string; ammoItemId:number|null; stock:number|null; priorCaptured:boolean }
export type EquipmentConditionState = 'matched' | 'unmatched' | 'unavailable';
export interface LoadoutChange { action:Extract<ExpandedAction,{type:'equip'}>; expected:Vector; restoring:boolean }
function identity(item:InventoryItem): Identity {
  if(item.type===2&&!item.guid)throw new Error('Unique equipment identity is unavailable.');
  return {itemId:item.itemId,type:item.type,...(item.guid?{guid:item.guid}:{})};
}
function key(id:Identity|null):string { return id ? `${id.type}:${id.itemId}:${id.guid??''}` : ''; }
function bag(state:CharacterState,slot:number):number { return slot===13?Math.max(0,state.ammoId):state.equipment[slot]??0; }
function vector(state:CharacterState):Vector {
  if(!state.inventoryKnown||state.equipment.length<10)throw new Error('A full equipment and inventory update is required.');
  return slots.map(slot=>{const id=bag(state,slot);if(!id)return null;const item=state.inventory.get(id);
    // Exhausted regular ammo can remain equipped on the server.
    if(!item&&slot===13&&AMMO_CATALOG[id])return {itemId:id,type:1};
    if(!item)throw new Error('Equipped item is absent from verified inventory.');if(item.type===2&&[...state.inventory.values()].filter(i=>i.type===2&&i.guid===item.guid).length!==1)throw new Error('Unique equipment identity is ambiguous.');return identity(item);});
}
function matches(a:Vector,b:Vector):boolean { return a.every((v,i)=>key(v)===key(b[i]??null)); }
function resolve(state:CharacterState,id:Identity):InventoryItem|null {
  const found=[...state.inventory.values()].filter(i=>i.type===id.type&&(id.type===1?i.itemId===id.itemId:i.guid===id.guid));
  return found.length===1&&found[0]!.itemId===id.itemId?found[0]!:null;
}
function permitted(itemId:number,p:Entity):string|null {
  const info=WEAPON_CATALOG[itemId]??armor[itemId];
  if(!info)return `Equipment ${itemId} requirements are not verified.`;
  if(info.jobs===null)return `Equipment ${itemId} job requirements are unknown.`;
  if(!info.jobs.includes(p.classId))return `Equipment ${itemId} is not permitted for this job.`;
  if(p.level<info.minLevel)return `Equipment ${itemId} needs level ${info.minLevel}.`;
  return null;
}
function headPositions(name:string):string[] {return ({Top:['Top'],Mid:['Mid'],Bottom:['Bottom'],TopMid:['Top','Mid'],TopBottom:['Top','Bottom'],MidBottom:['Mid','Bottom'],All:['Top','Mid','Bottom']} as Record<string,string[]>)[name]??[];}
function equipVector(state:CharacterState,p:Entity,item:InventoryItem):Vector {
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
export function selectAmmo(state:CharacterState,p:Entity,a:AutomationSettings):InventoryItem|null {
  if(!state.inventoryKnown)throw new Error('Ammo stock is unknown.');
  for(const preference of a.loadout.ammoPreferences)if(!AMMO_CATALOG[preference.itemId]||AMMO_CATALOG[preference.itemId]!.ammoType!==0)throw new Error(`Preferred ammo ${preference.itemId} is not a verified arrow.`);
  const preference=(id:number)=>{const i=a.loadout.ammoPreferences.findIndex(v=>v.itemId===id);return i<0?a.loadout.ammoPreferences.length:i;};
  const candidates=[...state.inventory.values()].filter(i=>i.type===1&&AMMO_CATALOG[i.itemId]?.ammoType===0&&p.level>=AMMO_CATALOG[i.itemId]!.minLevel&&i.count>a.loadout.minAmmoStock);
  candidates.sort((x,y)=>preference(x.itemId)-preference(y.itemId)||(x.bagId===state.ammoId?-1:0)-(y.bagId===state.ammoId?-1:0)||x.itemId-y.itemId||x.bagId-y.bagId);
  return candidates[0]??null;
}

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
      const current=state.inventory.get(state.ammoId);
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
    const item=state.inventory.get(id),weapon=item?WEAPON_CATALOG[item.itemId]:undefined;
    if(!weapon)return 'Normal-attack weapon compatibility is not verified.';
    if(weapon.weaponClass!==12)return null;
    const ammo=state.inventory.get(state.ammoId),info=ammo?AMMO_CATALOG[ammo.itemId]:undefined;
    if(!ammo||!info||info.ammoType!==0)return 'Equip verified arrows before attacking.';
    if(p.level<info.minLevel)return `Ammo needs level ${info.minLevel}.`;
    if(ammo.count<=a.loadout.minAmmoStock)return `Observed ammo stock ${ammo.count} reached the reserve ${a.loadout.minAmmoStock}.`;
    return null;
  }
  snapshot(a:AutomationSettings,state:CharacterState):LoadoutSnapshot {
    const ammo=state.inventory.get(state.ammoId);
    return {state:this.uncertain?'fault':this.fault?'fault':this.holdSince!==null?'holding':!a.loadout.enabled?'off':this.pending?(this.restoring?'restoring':'switching'):'ready',reason:this.uncertain?'Waiting for authoritative reconciliation of the canceled equipment request.':this.fault||this.holdReason,ammoItemId:ammo?.itemId??null,stock:state.inventoryKnown?ammo?.count??0:null,priorCaptured:this.prior!==null};
  }
  next(a:AutomationSettings,p:Entity,state:CharacterState,enemy:Entity|null,
    conditionState:(rule:EquipmentRule)=>EquipmentConditionState=rule=>rule.conditions?.length?'unavailable':'matched'):{change?:LoadoutChange;failure?:string} {
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
      const weaponItem=state.inventory.get(state.equipment[4]??0),weapon=weaponItem?WEAPON_CATALOG[weaponItem.itemId]:undefined;
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

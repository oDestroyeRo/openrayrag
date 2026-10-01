import type { AutomationSettings, LootRule, MonsterRule } from './settings';
import type { Entity } from './protocol';

export function monsterRule(a: AutomationSettings, classId: number): MonsterRule | undefined { return a.combat.rules.find(r=>r.classId===classId); }
export function lootRule(a: AutomationSettings, itemId: number): LootRule | undefined { return a.loot.rules.find(r=>r.itemId===itemId); }
export function acceptsMonster(a: AutomationSettings, e: Entity, player: Entity, selected: number[], aggressive: boolean): boolean {
  const rule = monsterRule(a,e.classId);
  if (a.combat.mode === 'off' || rule?.action === 'ignore' || e.level > player.level + a.combat.levelDifference) return false;
  const matching = selected.includes(e.classId) || rule?.action === 'attack';
  return a.combat.mode === 'selected' ? matching : a.combat.mode === 'retaliate' ? aggressive : matching || aggressive;
}
export function acceptsLoot(a: AutomationSettings, itemId: number): boolean { return (lootRule(a,itemId)?.action ?? a.loot.defaultAction) === 'pickup'; }
export function inSchedule(a: AutomationSettings, now: number): boolean {
  if (!a.schedule.enabled || a.schedule.startHour === a.schedule.endHour) return true;
  const hour = new Date(now).getHours();
  return a.schedule.startHour < a.schedule.endHour ? hour >= a.schedule.startHour && hour < a.schedule.endHour
    : hour >= a.schedule.startHour || hour < a.schedule.endHour;
}
export function percent(current: number | undefined, maximum: number | undefined): number | null {
  return current !== undefined && maximum !== undefined && maximum > 0 ? current / maximum * 100 : null;
}

import type { CharacterState } from './character-state';
import { ITEM_CATALOG, SKILL_CATALOG, skillCost, skillPrerequisites } from './game-catalog';
import type { ExpandedAction, FeatureEvent, Attributes } from './protocol-feature';
export interface AutomationTask { kind: string; label: string; pending: boolean; since: number | null }
interface PendingFeature { action: ExpandedAction; since: number; deadline: number; inventory: number; equipment: number; stats: number; skills: number; count: number; skillLevel: number; attributes: Attributes | null }
export interface ActionResult { sequence: number; status: 'idle' | 'pending' | 'confirmed' | 'failed'; reason: string }
// Pinned player spells include Magnus Exorcismus (12s), Storm Gust and Lord
// of Vermilion (up to 15s). Allow a bounded cast and response margin. Equipment
// and debuffs can extend casting: 30s is our policy, not a source maximum.
export function actionConfirmationTimeout(action: { type: string }): number {
  return action.type==='skill' ? 30_000 : 6_000;
}
export function effectiveSkillLevel(skillId: number, requested: number, state: CharacterState): number {
  return SKILL_CATALOG[skillId]?.adjustableLevel || skillId===55 ? requested : state.skillLevel(skillId);
}
export class AutomationScheduler {
  private pending: PendingFeature | null = null;
  private sequence = 0;
  private settlingUntil = 0;
  private canceledUntil = 0;
  result: ActionResult = {sequence:0,status:'idle',reason:''};
  private cooldown = new Map<string, number>();
  private recoverySince: number | null = null;
  private resting = false;
  constructor(private readonly send: (action: ExpandedAction) => void, private readonly now: () => number) {}
  get busy(): boolean { return this.pending !== null || this.now()<this.settlingUntil || this.now()<this.canceledUntil; }
  get recovering(): boolean { return this.recoverySince !== null; }
  get pendingAction(): ExpandedAction | null { return this.pending?.action ?? null; }
  reset(connection=false): void { if(connection){this.settlingUntil=0;this.canceledUntil=0;} else if(this.pending)this.canceledUntil=Math.max(this.canceledUntil,this.pending.deadline); if(this.pending)this.result={sequence:this.sequence,status:'failed',reason:'Action canceled.'}; this.pending = null; this.recoverySince = null; this.resting = false; this.cooldown.clear(); }
  task(): AutomationTask {
    return { kind:this.pending?.action.type ?? (this.now()<this.canceledUntil?'settling':this.now()<this.settlingUntil?'skill':this.recovering?'recover':'idle'),
      label:this.pending ? `Waiting for ${this.pending.action.type} confirmation.` : this.now()<this.canceledUntil?'Waiting for the canceled action deadline.':this.now()<this.settlingUntil?'Waiting for skill motion to finish.':this.recovering?'Resting until HP and SP recover.':'Ready.',
      pending:this.busy,since:this.pending?.since ?? this.recoverySince };
  }
  submit(action: ExpandedAction, state: CharacterState): void {
    if (this.busy) throw new Error('Wait for the current action confirmation.');
    const count = action.type === 'useItem' ? state.count(action.itemId) : 0;
    const skillLevel = action.type === 'allocateSkill' ? state.learned.get(action.skillId) ?? 0 : 0;
    const since=this.now();
    this.pending = { action,since,deadline:since+actionConfirmationTimeout(action),inventory:state.inventoryRevision,equipment:state.equipmentRevision,
      stats:state.statsRevision,skills:state.skillsRevision,count,skillLevel,attributes:state.stats?.attributes?.slice() as Attributes ?? null };
    this.result={sequence:++this.sequence,status:'pending',reason:`Waiting for ${action.type} confirmation.`};
    try { this.send(action); } catch (error) { this.pending = null; this.result={sequence:this.sequence,status:'failed',reason:'Connection failed while sending action.'}; throw error; }
  }
  observe(event: FeatureEvent | {type:'map'|'resurrection'}, state: CharacterState, playerId: number): { confirmed: boolean; failure: string | null } {
    const pending = this.pending;
    if (!pending) return {confirmed:false,failure:null};
    if (event.type === 'featureError') {this.pending=null;this.result={sequence:this.sequence,status:'failed',reason:`Server rejected ${pending.action.type}: ${event.message.slice(0,120)}`};return {confirmed:false,failure:this.result.reason};}
    if (event.type === 'skillFailure' || event.type === 'requestFailure') {
      this.pending = null; this.result={sequence:this.sequence,status:'failed',reason:`Server rejected ${pending.action.type} (code ${event.reason}).`}; return {confirmed:false,failure:`Server rejected ${pending.action.type} (code ${event.reason}).`};
    }
    const action = pending.action;
    let confirmed = false;
    switch(action.type) {
      case 'sit': confirmed = event.type==='sit'&&event.id===playerId&&event.sitting===action.sitting; break;
      case 'useItem': confirmed = event.type==='inventoryDelta'&&!event.add&&state.inventoryKnown&&state.inventoryRevision>pending.inventory&&state.count(action.itemId)<pending.count; break;
      case 'equip': confirmed = event.type==='equipment'&&event.bagId===action.bagId&&event.equipped===action.equipped; break;
      case 'skill':
        confirmed = event.type==='skillResult'&&event.source===playerId&&event.skillId===action.skillId&&event.level===action.level
          && !event.indirect && (action.mode==='self'
            ? event.mode==='self' || (event.mode==='target'&&event.target===playerId)
            : event.mode===action.mode&&(action.mode!=='target'||event.target===action.target));
        break;
      case 'allocateSkill': confirmed = (event.type==='learnedSkill'&&event.skillId===action.skillId&&event.level>pending.skillLevel) || (event.type==='skills'&&!!event.learned&&state.skillsRevision>pending.skills&&(state.learned.get(action.skillId)??0)>pending.skillLevel); break;
      case 'allocateStats': confirmed = event.type==='stats'&&!!event.attributes&&!!pending.attributes&&action.attributes.every((n,i)=>event.attributes![i]!>=pending.attributes![i]!+n); break;
      case 'respawn': confirmed = event.type==='map'||event.type==='resurrection'; break;
    }
    if (confirmed) {
      if(event.type==='skillResult')this.settlingUntil=this.now()+Math.max(0,event.motionSeconds)*1000;
      this.pending = null; this.result={sequence:this.sequence,status:'confirmed',reason:`${action.type} confirmed by the server.`};
      if (action.type==='sit') { this.resting=action.sitting; if(!action.sitting)this.recoverySince=null; }
      const key = action.type==='useItem'?`item:${action.itemId}`:action.type==='skill'?`skill:${action.skillId}`:action.type;
      this.cooldown.set(key,this.now());
    }
    return {confirmed,failure:null};
  }
  timeout(): string | null {
    if (this.pending && this.now()>=this.pending.deadline) { const type=this.pending.action.type;this.pending=null;this.result={sequence:this.sequence,status:'failed',reason:`No server confirmation for ${type}.`};return `No server confirmation for ${type}; stopped to avoid duplicate actions.`; }
    return null;
  }
  wantsRecovery(a: AutomationSettings, p: Entity, state: CharacterState): boolean {
    if (!a.recovery.enabled) return false;
    const hp=percent(p.hp,p.maxHp),sp=percent(state.stats?.sp,state.stats?.maxSp);
    return this.recovering || (hp!==null&&hp<=a.recovery.hpStart) || (a.recovery.spStart>0&&sp!==null&&sp<=a.recovery.spStart);
  }
  recover(a: AutomationSettings, p: Entity, state: CharacterState): { action?: ExpandedAction; failure?: string } {
    const hp=percent(p.hp,p.maxHp),sp=percent(state.stats?.sp,state.stats?.maxSp);
    if(p.classId===0&&(!state.skillsKnown||(state.learned.get(1)??0)<2))return {failure:'A novice needs verified Basic Mastery level 2 to sit for recovery.'};
    if(a.recovery.spStart>0&&sp===null)return {failure:'SP is unavailable; recovery needs a verified SP update.'};
    this.recoverySince ??= this.now();
    if(this.now()-this.recoverySince>=a.recovery.timeoutSeconds*1000)return {failure:'Recovery time limit reached. Check regeneration and carried weight.'};
    if(this.busy)return {};
    if(hp!==null&&hp>=a.recovery.hpEnd&&(a.recovery.spStart===0||(sp!==null&&sp>=a.recovery.spEnd))) {
      if(state.sitting===true||this.resting)return {action:{type:'sit',sitting:false}};
      this.recoverySince=null; return {};
    }
    if(state.sitting!==true)return {action:{type:'sit',sitting:true}};
    this.resting=true; return {};
  }
  nextRecoveryItem(a: AutomationSettings, p: Entity, state: CharacterState): { action?: ExpandedAction; failure?: string } {
    return this.next({...a,skills:[],equipment:[],allocation:{stats:[],skills:[]}},p,state,null);
  }
  next(a: AutomationSettings, p: Entity, state: CharacterState, enemy: Entity | null): { action?: ExpandedAction; failure?: string } {
    if(this.busy)return {};
    const now=this.now(),hp=percent(p.hp,p.maxHp),sp=percent(state.stats?.sp,state.stats?.maxSp);
    if(a.items.length&&!state.inventoryKnown)return {failure:'Inventory is unavailable; item rules need a full inventory update.'};
    for(const r of a.items) {
      const resource=r.resource==='hp'?hp:sp;
      if(resource===null)return {failure:`${r.resource.toUpperCase()} is unavailable for item rules.`};
      if(resource<=r.belowPercent&&ITEM_CATALOG[r.itemId]?.useType!==1)return {failure:`Item ${r.itemId} is not an untargeted usable item.`};
      if(resource<=r.belowPercent&&state.count(r.itemId)>r.minStock&&now-(this.cooldown.get(`item:${r.itemId}`)??-Infinity)>=r.cooldownSeconds*1000)return {action:{type:'useItem',itemId:r.itemId}};
    }
    if(a.skills.length&&!state.skillsKnown)return {failure:'Learned skills are unavailable; skill rules need a full skill update.'};
    for(const r of a.skills) {
      if(sp===null)return {failure:'SP is unavailable for skill rules.'};
      const catalog=SKILL_CATALOG[r.skillId],level=effectiveSkillLevel(r.skillId,r.level,state),cost=skillCost(r.skillId,level);
      if(!catalog||catalog.target===0||cost===null||(r.target==='enemy'&&![1,3].includes(catalog.target))||(r.target==='self'&&![2,3,5].includes(catalog.target)))return {failure:`Skill ${r.skillId} targeting or level is unavailable.`};
      if(state.skillLevel(r.skillId)<r.level)return {failure:`Skill ${r.skillId} level ${r.level} is not learned or granted.`};
      if(hp!==null&&hp<=r.hpBelowPercent&&sp>=r.spAbovePercent&&(state.stats?.sp??0)>=cost&&now-(this.cooldown.get(`skill:${r.skillId}`)??-Infinity)>=r.cooldownSeconds*1000) {
        if(r.target==='self')return {action:{type:'skill',mode:'self',skillId:r.skillId,level}};
        if(enemy&&distanceBetween(p,enemy)<=1)return {action:{type:'skill',mode:'target',skillId:r.skillId,level,target:enemy.id}};
      }
    }
    if(a.equipment.length&&!state.inventoryKnown)return {failure:'Inventory is unavailable for equipment rules.'};
    for(const r of a.equipment) {
      if(hp!==null&&hp<=r.hpBelowPercent&&(!r.monsterClassId||enemy?.classId===r.monsterClassId)) {
        const info=ITEM_CATALOG[r.itemId];
        if(!info||![2,3,4].includes(info.itemClass)||!info.position)return {failure:`Item ${r.itemId} is not verified equipment.`};
        const item=[...state.inventory.values()].find(i=>i.itemId===r.itemId);
        if(item) {if(!state.equipment.includes(item.bagId)&&state.ammoId!==item.bagId)return {action:{type:'equip',bagId:item.bagId,equipped:true}};break;}
      }
    }
    if(a.allocation.stats.length) {
      if(!state.stats?.attributes||state.stats.statPoints===undefined)return {failure:'Character attributes and stat points are unavailable.'};
      for(const r of a.allocation.stats) {
        const value=state.stats.attributes[r.stat]!;
        if(value<r.target) {
          const cost=2+Math.floor((value-1)/10);
          if(state.stats.statPoints>=cost) { const attributes:Attributes=[0,0,0,0,0,0];attributes[r.stat]=1;return {action:{type:'allocateStats',attributes}}; }
          break;
        }
      }
    }
    if(a.allocation.skills.length) {
      if(!state.skillsKnown||state.stats?.skillPoints===undefined)return {failure:'Learned skills and skill points are unavailable for allocation.'};
      if(state.stats.skillPoints>0)for(const r of a.allocation.skills)if((state.learned.get(r.skillId)??0)<r.target) {
        const skill=SKILL_CATALOG[r.skillId],requirements=skillPrerequisites(p.classId,r.skillId);
        if(!skill||r.target>skill.maxLevel||requirements===null)return {failure:`Skill ${r.skillId} is not in the verified class skill tree.`};
        if(requirements.some(requirement=>(state.learned.get(requirement.skillId)??0)<requirement.level))break;
        return {action:{type:'allocateSkill',skillId:r.skillId}};
      }
    }
    return {};
  }
}
function distanceBetween(a:{x:number;y:number},b:{x:number;y:number}):number{return Math.max(Math.abs(a.x-b.x),Math.abs(a.y-b.y));}

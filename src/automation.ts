import { itemId as domainItemId, skillId as domainSkillId, milliseconds, quantity, seconds, secondsToMilliseconds, type Seconds } from './domain-values';
import { map } from 'remeda';
import { foldConditions, unavailableFirstConditions } from './condition-logic';
import { sameActionIdentity, type ActionIdentity } from './actor-identity';
import { isRecoveryItem, recoveryItemIds } from './recovery-items';
import { matchesSkillExecution } from './skill-execution';
import { recoveryItemCooldown } from './hp-potions';
import { skillAfterCastSeconds } from './cast-policy';
import type { AutomationPolicy as AutomationSettings } from './settings';
import type { Entity } from './protocol';
import { actorPredicateEvaluator, type ActorObservationSnapshot, type ActorPredicate, type PredicateTrace } from './actor-observations-logic';
import type { CharacterState } from './character-state';
import { ITEM_CATALOG, SKILL_CATALOG, skillCost, skillPrerequisites } from './game-catalog';
import type { ExpandedAction, FeatureEvent, Attributes } from './protocol-feature';

import { percent, type AutomationTask, type PendingFeature, type ActionResult, type AutomationOutcome, type ObserveSettlement, publishedActionResult, receiptRetirement, actionConfirmationTimeout, effectiveSkillLevel, distanceBetween } from './automation-logic';

export { monsterRule, lootRule, acceptsMonster, acceptsLoot, inSchedule, percent, type AutomationTask, type ActionReceipts, type ActionResult, actionConfirmationTimeout, effectiveSkillLevel } from './automation-logic';

export class AutomationScheduler {
  readonly ruleConditions: Array<{rule:string;conditions:PredicateTrace[]}>=[];
  conditionState(rule:string,conditions:readonly ActorPredicate[]|undefined,observations:ActorObservationSnapshot|undefined):PredicateTrace['state'] {
    if(!conditions?.length)return 'matched';
    const traces=map(conditions, actorPredicateEvaluator(observations));
    if(this.ruleConditions.length<32)this.ruleConditions.push({rule,conditions:traces});
    return foldConditions(traces,unavailableFirstConditions);
  }
  private matches(rule:string,conditions:readonly ActorPredicate[]|undefined,observations:ActorObservationSnapshot|undefined):boolean {
    return this.conditionState(rule,conditions,observations)==='matched';
  }
  private pending: PendingFeature | null = null;
  private captured: PendingFeature | null = null;
  private sequence = 0;
  private settlingUntil = 0;
  private canceledUntil = 0;
  private outcome: AutomationOutcome = {sequence:0,status:'idle',reason:''};
  get result(): ActionResult { return publishedActionResult(this.outcome); }
  private cooldown = new Map<string, number>();
  private recoverySince: number | null = null;
  private resting = false;
  constructor(private readonly send: (action: ExpandedAction) => void, private readonly now: () => number, private readonly identity?:(action:ExpandedAction)=>ActionIdentity|null) {}
  get busy(): boolean { return this.pending !== null || this.now()<this.settlingUntil || this.now()<this.canceledUntil; }
  get recovering(): boolean { return this.recoverySince !== null; }
  get pendingAction(): ExpandedAction | null { return this.pending?.action ?? null; }
  get pendingIdentity(): ActionIdentity | null { return this.pending?.identity ?? null; }
  get receipt(): Readonly<{sequence:number;action:ExpandedAction}> | null {
    return this.captured ? {sequence:this.captured.sequence,action:this.captured.action} : null;
  }
  discardReceipt():void { this.captured=null; }
  /** The caller decides whether intent continues; receipt policy stays here. */
  retireReceipt(continuing:boolean):'rejected'|'uncertain'|'released'|'retained' {
    const decision=receiptRetirement({continuing,actionType:this.captured?.action.type??null,
      failure:this.outcome.status==='failed'?this.outcome.failure:null});
    if(decision.discard)this.discardReceipt();
    return decision.state;
  }
  /** Late readback drains uncertainty without confirming a retired caller's step.
   * Unlike active confirmation, item readback may be a complete inventory.
   * Its caller-wide pause does not stamp the scheduler's active cooldown clocks. */
  reconcileReceipt(events:ReadonlyArray<FeatureEvent|{type:string}>,state:CharacterState,playerId:number|null,policy:AutomationSettings):Seconds|null {
    const receipt=this.captured;
    if(!receipt||this.pending||receipt.identity&&!sameActionIdentity(receipt.identity,this.identity?.(receipt.action)))return null;
    const action=receipt.action;
    const execution=action.type==='skill'?events.find((event):event is Extract<FeatureEvent,{type:'skillResult'}>=>matchesSkillExecution(action,event,playerId)):undefined;
    const confirmed=action.type==='useItem'?state.inventoryKnown&&state.count(domainItemId(action.itemId))<receipt.count
      :action.type==='allocateSkill'?state.skillsRevision>receipt.skills&&(state.learned.get(domainSkillId(action.skillId))??0)>receipt.skillLevel
      :action.type==='allocateStats'?state.statsRevision>receipt.stats&&!!receipt.attributes&&!!state.stats?.attributes
        &&action.attributes.every((count,i)=>state.stats!.attributes![i]!>=receipt.attributes![i]!+count)
      :action.type==='skill'&&execution!==undefined;
    if(!confirmed)return null;
    // Ordinary canceled casts retain their original deadline; Party Heal's
    // specialized owner alone uses reconcileSkill to drain that fence early.
    if(execution)this.settleSkill(execution.motionSeconds,skillAfterCastSeconds(execution.skillId));
    const cooldown=action.type==='useItem'?recoveryItemCooldown(policy,domainItemId(action.itemId))
      :action.type==='skill'?policy.skills.find(rule=>rule.skillId===action.skillId)?.cooldownSeconds??seconds(1):seconds(0);
    this.discardReceipt();return cooldown;
  }
  settleSkill(motionSeconds:number,afterCastSeconds:number):void {
    this.settlingUntil=Math.max(this.settlingUntil,this.now()+Math.max(0,motionSeconds,afterCastSeconds)*1000);
  }
  reconcileSkill(sequence:number,motion:number,afterCast:number):void {
    // Only this scheduler sequence may drain its canceled deadline.
    if(this.sequence!==sequence||this.pending)return;
    this.canceledUntil=0;this.settleSkill(motion,afterCast);
  }
  reset(connection=false): void { this.ruleConditions.length=0; if(connection){this.settlingUntil=0;this.canceledUntil=0;} else if(this.pending)this.canceledUntil=Math.max(this.canceledUntil,this.pending.deadline); if(this.pending)this.outcome={sequence:this.sequence,status:'failed',failure:{type:'cancel',reason:'Action canceled.'}}; this.pending = null; this.recoverySince = null; this.resting = false; this.cooldown.clear(); }
  task(): AutomationTask {
    return { kind:this.pending?.action.type ?? (this.now()<this.canceledUntil?'settling':this.now()<this.settlingUntil?'skill':this.recovering?'recover':'idle'),
      label:this.pending ? `Waiting for ${this.pending.action.type} confirmation.` : this.now()<this.canceledUntil?'Waiting for the canceled action deadline.':this.now()<this.settlingUntil?'Waiting for skill motion to finish.':this.recovering?'Resting until HP and SP recover.':'Ready.',
      pending:this.busy,since:this.pending?.since ?? this.recoverySince };
  }
  submit(action: ExpandedAction, state: CharacterState, equipmentReceipt?: (state: CharacterState)=>boolean, afterCastSeconds=0, reservation?:{receipt:typeof matchesSkillExecution; reserved:(sequence:number,identity:ActionIdentity)=>void; retainReceipt?:false}): void {
    if (this.busy) throw new Error('Wait for the current action confirmation.');
    const identity=this.identity?.(action);if(this.identity&&!identity)throw new Error('A current observed own and target identity is required.');
    const count = action.type === 'useItem' ? state.count(domainItemId(action.itemId)) : quantity(0);
    const skillLevel = action.type === 'allocateSkill' ? state.learned.get(domainSkillId(action.skillId)) ?? 0 : 0;
    const since=milliseconds(this.now()),deadline=milliseconds(since+actionConfirmationTimeout(action));
    this.pending = { sequence:++this.sequence,...(identity?{identity}:{}),action,since,equipmentReceipt,skillReceipt:reservation?.receipt,afterCastSeconds,deadline,inventory:state.inventoryRevision,equipment:state.equipmentRevision,
      stats:state.statsRevision,skills:state.skillsRevision,count,skillLevel,attributes:state.stats?.attributes?.slice() as Attributes ?? null };
    this.captured=reservation?.retainReceipt===false?null:this.pending;
    this.outcome={sequence:this.sequence,status:'pending',reason:`Waiting for ${action.type} confirmation.`};
    try { if(reservation){if(!identity)throw new Error('Observed identity required.');reservation.reserved(this.sequence,identity);} this.send(action); } catch (error) { this.pending = null; this.outcome={sequence:this.sequence,status:'failed',failure:{type:'send-failure',reason:'Connection failed while sending action.'}}; throw error; }
  }
  observe(event: FeatureEvent | {type:'map'|'resurrection'}, state: CharacterState, playerId: number | null, respawnTransition=false): ObserveSettlement {
    const pending = this.pending;
    if (!pending || playerId===null) return {state:'ignored'};
    const current=this.identity?.(pending.action);
    // Only the engine's verified own respawn transition may cross a world/incarnation.
    const respawnRebound=respawnTransition&&pending.action.type==='respawn'&&(event.type==='map'||event.type==='resurrection')&&current?.selfId===pending.identity?.selfId;
    if(pending.identity&&!sameActionIdentity(pending.identity,current)&&!respawnRebound)return {state:'ignored'};
    if (event.type === 'featureError' || event.type === 'skillFailure' || event.type === 'requestFailure') {
      const failure={type:'server-rejection' as const,reason:event.type==='featureError'
        ?`Server rejected ${pending.action.type}: ${event.message.slice(0,120)}`
        :`Server rejected ${pending.action.type} (code ${event.reason}).`};
      this.pending=null;this.outcome={sequence:this.sequence,status:'failed',failure};
      return {state:'rejected',failure:{...failure}};
    }
    const action = pending.action;
    let confirmed = false;
    switch(action.type) {
      case 'sit': confirmed = event.type==='sit'&&event.id===playerId&&event.sitting===action.sitting; break;
      case 'useItem': confirmed = event.type==='inventoryDelta'&&!event.add&&state.inventoryKnown&&state.inventoryRevision>pending.inventory&&state.count(domainItemId(action.itemId))<pending.count; break;
      case 'equip': confirmed = pending.equipmentReceipt ? (event.type==='equipment'||event.type==='inventory')&&pending.equipmentReceipt(state) : event.type==='equipment'&&event.bagId===action.bagId&&event.equipped===action.equipped; break;
      case 'skill':
        confirmed = (pending.skillReceipt??matchesSkillExecution)(action,event,playerId);
        break;
      case 'allocateSkill': confirmed = (event.type==='learnedSkill'&&event.skillId===action.skillId&&event.level>pending.skillLevel) || (event.type==='skills'&&!!event.learned&&state.skillsRevision>pending.skills&&(state.learned.get(domainSkillId(action.skillId))??0)>pending.skillLevel); break;
      case 'allocateStats': confirmed = event.type==='stats'&&!!event.attributes&&!!pending.attributes&&action.attributes.every((n,i)=>event.attributes![i]!>=pending.attributes![i]!+n); break;
      case 'respawn': confirmed = event.type==='map'||event.type==='resurrection'; break;
    }
    if (confirmed) {
      if(event.type==='skillResult')this.settleSkill(event.motionSeconds,pending.afterCastSeconds);
      this.pending = null; this.outcome={sequence:this.sequence,status:'confirmed',reason:`${action.type} confirmed by the server.`};
      this.discardReceipt();
      if (action.type==='sit') { this.resting=action.sitting; if(!action.sitting)this.recoverySince=null; }
      const key = action.type==='useItem'?`item:${action.itemId}`:action.type==='skill'?`skill:${action.skillId}`:action.type;
      this.cooldown.set(key,this.now());
      if(action.type==='useItem')for(const resource of ['hp','sp'] as const) {
        if(isRecoveryItem(action.itemId,resource))this.cooldown.set(`${resource}-potions`,this.now());
      }
    }
    return {state:confirmed?'confirmed':'ignored'};
  }
  timeout(): string | null {
    if (this.pending && this.now()>=this.pending.deadline) { const type=this.pending.action.type;this.pending=null;this.outcome={sequence:this.sequence,status:'failed',failure:{type:'timeout',reason:`No server confirmation for ${type}.`}};return `No server confirmation for ${type}; stopped to avoid duplicate actions.`; }
    return null;
  }
  wantsRecovery(a: AutomationSettings, p: Entity, state: CharacterState): boolean {
    if (!a.recovery.enabled) return false;
    const hp=percent(p.hp,p.maxHp),sp=percent(state.stats?.sp,state.stats?.maxSp);
    return this.recovering || (hp!==null&&hp<=a.recovery.hpStart) || (a.recovery.spStart>0&&sp!==null&&sp<=a.recovery.spStart);
  }
  recover(a: AutomationSettings, p: Entity, state: CharacterState): { action?: ExpandedAction; failure?: string } {
    const hp=percent(p.hp,p.maxHp),sp=percent(state.stats?.sp,state.stats?.maxSp);
    if(p.classId===0&&(!state.skillsKnown||(state.learned.get(domainSkillId(1))??0)<2))return {failure:'A novice needs verified Basic Mastery level 2 to sit for recovery.'};
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
  nextRecoveryItem(a: AutomationSettings, p: Entity, state: CharacterState, observations?:ActorObservationSnapshot): { action?: ExpandedAction; failure?: string } {
    return this.next({...a,skills:[],equipment:[],allocation:{stats:[],skills:[]}},p,state,null,observations);
  }
  next(a: AutomationSettings, p: Entity, state: CharacterState, enemy: Entity | null, observations?:ActorObservationSnapshot): { action?: ExpandedAction; failure?: string } {
    this.ruleConditions.length=0;
    if(this.busy)return {};
    const now=this.now(),hp=percent(p.hp,p.maxHp),sp=percent(state.stats?.sp,state.stats?.maxSp);
    for(const r of a.items) {
      if(!this.matches(`Item ${r.itemId}`,r.conditions,observations))continue;
      if(!state.inventoryKnown)return {failure:'Inventory is unavailable; item rules need a full inventory update.'};
      const resource=r.resource==='hp'?hp:sp;
      if(resource===null)return {failure:`${r.resource.toUpperCase()} is unavailable for item rules.`};
      if(resource<=r.belowPercent&&ITEM_CATALOG[r.itemId]?.useType!==1)return {failure:`Item ${r.itemId} is not an untargeted usable item.`};
      if(resource<=r.belowPercent&&state.count(r.itemId)>r.minStock&&now-(this.cooldown.get(`item:${r.itemId}`)??-Infinity)>=secondsToMilliseconds(r.cooldownSeconds))return {action:{type:'useItem',itemId:r.itemId}};
    }
    for(const resource of ['hp','sp'] as const) {
      const potions=resource==='hp'?a.hpPotions:a.spPotions,percent=resource==='hp'?hp:sp;
      if(!potions||potions.mode==='off')continue;
      if(percent===null)return {failure:`${resource.toUpperCase()} is unavailable for ${resource.toUpperCase()} recovery items.`};
      if(percent<=potions.belowPercent) {
        if(!state.inventoryKnown)return {failure:`Inventory is unavailable; ${resource.toUpperCase()} recovery items need a full inventory update.`};
        if(now-(this.cooldown.get(`${resource}-potions`)??-Infinity)>=secondsToMilliseconds(potions.cooldownSeconds)) {
          const itemId=recoveryItemIds(potions,resource).find(id=> {
            if(a.items.some(rule=>rule.itemId===id))return false;
            const otherResource=resource==='hp'?'sp':'hp',other=resource==='hp'?a.spPotions:a.hpPotions;
            if(other&&other.mode!=='off'&&isRecoveryItem(id,otherResource)&&now-(this.cooldown.get(`${otherResource}-potions`)??-Infinity)<secondsToMilliseconds(other.cooldownSeconds))return false;
            const reserve=Math.max(potions.minStock,recoveryItemIds(other,otherResource).includes(id)?other!.minStock:0);
            return state.count(id)>reserve;
          });
          if(itemId!==undefined)return {action:{type:'useItem',itemId}};
        }
      }
    }
    for(const r of a.skills) {
      if(!this.matches(`Skill ${r.skillId}`,r.conditions,observations))continue;
      if(!state.skillsKnown)return {failure:'Learned skills are unavailable; skill rules need a full skill update.'};
      if(sp===null)return {failure:'SP is unavailable for skill rules.'};
      const catalog=SKILL_CATALOG[r.skillId],level=effectiveSkillLevel(r.skillId,r.level,state),cost=skillCost(r.skillId,level);
      if(!catalog||catalog.target===0||cost===null||(r.target==='enemy'&&![1,3].includes(catalog.target))||(r.target==='self'&&![2,3,5].includes(catalog.target)))return {failure:`Skill ${r.skillId} targeting or level is unavailable.`};
      if(state.skillLevel(r.skillId)<r.level)return {failure:`Skill ${r.skillId} level ${r.level} is not learned or granted.`};
      if(hp!==null&&hp<=r.hpBelowPercent&&sp>=r.spAbovePercent&&(state.stats?.sp??0)>=cost&&now-(this.cooldown.get(`skill:${r.skillId}`)??-Infinity)>=secondsToMilliseconds(r.cooldownSeconds)) {
        if(r.target==='self')return {action:{type:'skill',mode:'self',skillId:r.skillId,level}};
        if(enemy&&distanceBetween(p,enemy)<=1)return {action:{type:'skill',mode:'target',skillId:r.skillId,level,target:enemy.id}};
      }
    }
    for(const r of a.equipment) {
      if(!this.matches(`Equipment ${r.itemId}`,r.conditions,observations))continue;
      if(!state.inventoryKnown)return {failure:'Inventory is unavailable for equipment rules.'};
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
      if(state.stats.skillPoints>0)for(const r of a.allocation.skills)if((state.learned.get(domainSkillId(r.skillId))??0)<r.target) {
        const skill=SKILL_CATALOG[r.skillId],requirements=skillPrerequisites(p.classId,r.skillId);
        if(!skill||r.target>skill.maxLevel||requirements===null)return {failure:`Skill ${r.skillId} is not in the verified class skill tree.`};
        if(requirements.some(requirement=>(state.learned.get(domainSkillId(requirement.skillId))??0)<requirement.level))break;
        return {action:{type:'allocateSkill',skillId:r.skillId}};
      }
    }
    return {};
  }
}

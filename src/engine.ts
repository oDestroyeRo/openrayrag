import { minutesToMilliseconds } from './domain-values';
import { skillId as domainSkillId } from './domain-values';
import { flatMap, map } from 'remeda';
import { manualActionBlocker } from './engine-action-policy';
import { ObservedThreats, type ThreatSnapshot } from './observed-threats';
import { CastAvailability, type ObservedCast } from './cast-availability';
import { matchesSkillExecution, matchesPartyHealExecution } from './skill-execution';
import { PartyEngagements, type PartyEngagementSnapshot } from './party-engagement';
import type { PartyActorBinding } from './party-actors';
import { resourceFresh } from './actor-resources';
import {actionIdentity,sameActionIdentity,type ActionIdentity} from './actor-identity';
import { deathLimitGuidance } from './death-recovery';
import { AttackStrategyPolicy, engagementIdentity, type StrategyChoice, type AttackStrategySnapshot, type EngagementIdentity } from './attack-strategy';
import { castReadiness, skillAfterCastSeconds, CAST_PREREQUISITES, BLIND_CONDITION, AUTOMATIC_ATTACK_SKILLS, MANUAL_GROUND_SKILL } from './cast-policy';
import { fieldGrid, insideLockArea, mapAllowed, mapPolicy, policyIdentity } from './map-policy';
import { ActorObservations, type ActorObservationSnapshot, type ActorPredicate, type PredicateTrace, type PublishedConditionReport, publishConditionReports } from './actor-observations';
import { actorPredicateEvaluator } from './actor-observations-logic';
import { type Drop, type Entity, type GameEvent, type Position, type Walk, type LookAction } from './protocol';

import { walkDuration, walkPosition } from './movement';
import { GridNavigator, routeSegment, searchGrid, distance, minimumRouteCost, type NavigationSummary, type WalkGrid } from './navigation';

import { automationSettings, validateAutomation, DEFAULT_SETTINGS, validateSettings, validateFormSettings, type ValidatedFormSettings, type SettingsInput as Settings, type AutomationSettingsInput as AutomationSettings } from './settings';
import { admitDrop, type DomainDrop } from './automation-logic';
import { acceptsMonster, acceptsLoot, inSchedule, monsterRule, lootRule, effectiveSkillLevel, AutomationScheduler, type AutomationTask, type ActionResult, type ActionReceipts } from './automation';
import { CharacterState, type CharacterSnapshot, type StatefulEntity } from './character-state';
import { validateExpandedAction, type ExpandedAction, type FeatureEvent } from './protocol-feature';
import { SKILL_CATALOG, skillCost } from './game-catalog';
import { attackDistance, normalAttackProfile } from './combat';
import {RetreatLedger,planRetreat,IDLE_RETREAT,type RetreatTask,type RetreatSnapshot} from './retreat';
import {retreatSettings} from './settings';
import { LoadoutPolicy, type LoadoutSnapshot } from './loadout';
import { IDLE_MANUAL_TARGET, manualAmmoGuard, manualEngineSettings, type ManualEngineSettings, manualStateBlocker, previewManualTarget, sameActionIdentity as sameManualIdentity, validateManualTargetRequest, type ManualTargetRequest, type ManualTargetSnapshot } from './manual-target';
export { MAX_TARGETS, DEFAULT_SETTINGS, DEFAULT_AUTOMATION, validateSettings, validateAutomation } from './settings';
export type { Settings, AutomationSettings } from './settings';

export interface LogEntry { at: number; text: string }
export interface NavigationStatus extends NavigationSummary {
  ready: boolean; mode: 'idle' | 'skill' | 'search' | 'attack' | 'pickup' | 'follow' | 'waypoint' | 'recover' | 'travel';
  goal: Position | null; route: Position[]; leg: Position[]; routeLength: number;
}
export interface Snapshot {
  connected: boolean; compatible: boolean; running: boolean; reason: string;
  map: string; player: Entity | null; monsters: Entity[]; drops: Drop[];
  attacks: number; kills: number; looted: number; target: string; log: LogEntry[]; navigation: NavigationStatus | null;
  attackStrategies:AttackStrategySnapshot; actorObservations: ActorObservationSnapshot; ruleConditions: PublishedConditionReport[];
  manualTarget:ManualTargetSnapshot; partyEngagement:PartyEngagementSnapshot;
  retreat:RetreatSnapshot;
  loadout: LoadoutSnapshot; character: CharacterSnapshot; actors: Entity[]; task: AutomationTask; elapsedSeconds: number; deaths: number; runIntent: boolean; lootStats: Array<{itemId:number;count:number}>; actionResult: ActionResult;
}
export type Action = { type: 'attack' | 'pickup'; id: number } | { type: 'stop' } | { type: 'walk'; destination: Position } | LookAction | ExpandedAction;
export const OWN_CAST_WAIT_REASON = 'Waiting for the observed own cast to settle. Some triggered results are ambiguous; bounded stationary recovery checks for authoritative availability.';
// Pinned equipment/card procs can emit these execution shapes with indirect=false.
// A queued proc can survive equipment removal, so current gear cannot rule it out.
function unmarkedProcCanMatch(action:Extract<ExpandedAction,{type:'skill'}>):boolean {
  return action.mode==='self'&&action.skillId===42&&action.level===1
    ||action.mode==='target'&&(action.skillId===43&&(action.level===1||action.level===3)
      ||action.skillId===96&&(action.level===3||action.level===5||action.level===10));
}
const ACTION_DELAY = 100;
const LOOT_DELAY = 150;
// New-drop packets precede monster removal at the pinned server. This is a
// conservative client correlation window, not ground-item ownership evidence.
const PRE_DEATH_DROP_WINDOW = 2000;
const OWN_LOOT_HISTORY = 30000;
const MAX_OWN_KILLS = 64;
const MAX_NEW_DROPS = 256;
const MAX_DROP_ENGAGEMENTS = 8;
type DropIdentity = Pick<DomainDrop,'itemId'|'count'|'x'|'y'>;
const sameDrop = (a:DropIdentity|undefined,b:DropIdentity):boolean => !!a&&a.itemId===b.itemId&&a.count===b.count&&a.x===b.x&&a.y===b.y;
const cell = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
interface RouteTask { followIdentity?:string; engagement?:EngagementIdentity|null; strategy?:Extract<StrategyChoice,{state:'cast'}>; type: 'skill' | 'search' | 'attack' | 'pickup' | 'follow' | 'waypoint' | 'travel'; id?: number; destination: Position; cells: Position[]; since: number | null; attackRange?: number }
interface RouteLeg { destination: Position; cells: Position[]; since: number; acceptedUntil: number | null }

export class BotEngine {
  connected = false;
  compatible = false;
  running = false;
  private updateSuspended=false;
  private updateWasRunning=false;
  private updatePending:{type:'attack'|'pickup';id:number;actorIdentity?:ActionIdentity|null;dropIdentity?:DropIdentity;entity?:Entity}|null=null;
  reason = 'Open the game and sign in to your character.';
  playerId: number | null = null;
  map = '';
  readonly entities = new Map<number, Entity>();
  readonly drops = new Map<number, DomainDrop>();
  readonly log: LogEntry[] = [];
  attacks = 0; kills = 0; looted = 0;
  settings: ValidatedFormSettings | ManualEngineSettings = validateFormSettings(DEFAULT_SETTINGS);
  private motions = new Map<number, { walk: Walk; at: number }>();
  private navigator: GridNavigator | null = null;
  private navigationMap = '';
  private route: RouteTask | null = null;
  private leg: RouteLeg | null = null;
  private implicitWalk: { targetId: number | null; until: number } | null = null;
  private routeFailures = 0;
  private manualTask:{request:ManualTargetRequest;since:number;attackSent:boolean;attackObserved:boolean;acceptedAttack:boolean;acceptedWalk:boolean}|null=null;
  private manualStatus:ManualTargetSnapshot=structuredClone(IDLE_MANUAL_TARGET);
  private manualAttackFence:{world:string;target:EngagementIdentity;accepted:boolean;stopRetried:boolean}|null=null;
  private manualWalkFence=false;
  private manualRetiredMovement=false;
  private manualReceiptOwner:EngagementIdentity|null=null;
  private readonly retreatLedger=new RetreatLedger();
  private retreatTask:RetreatTask|null=null;
  private retreatStatus:RetreatSnapshot={...IDLE_RETREAT};
  private routeStep = 10;
  private pending: { type: 'attack' | 'pickup'; id: number; since: number; progress: number; approachSince: number | null; direct: boolean; attackRange?: number; engagement?:EngagementIdentity|null; actorIdentity?:ActionIdentity|null; dropIdentity?:DropIdentity } | null = null;
  private foreignTargets = new Set<number>();
  private readonly partyEngagements = new PartyEngagements();
  private serverTargetId:number|null=null;
  private officialMovementUntil=0;
  private officialMotion=false;
  private readonly combatConditions=new Map<number,{rule:string;conditions:PredicateTrace[]}>();
  private respawnRefreshPending = false;
  private respawnArrival:{id:number;name:string;entry:1|2}|null=null;
  private skillKills = new Map<number, { until:number; identity:ActionIdentity }>();
  private skillTargets = new Map<number, { skillId: number; until: number; identity:ActionIdentity }>();
  private aggressors = new Map<number, ActionIdentity>();
  readonly actors = new Map<number, Entity>();
  private readonly revivableActors=new Map<number,Entity>();
  partyFollowBinding:(()=>PartyActorBinding|null)|undefined;
  private followLostAt: number | null = null;
  private waypointIndex = 0;
  private runKills = 0; private runPickups = 0;
  private lootStats = new Map<number, number>();
  deaths = 0;
  runIntent = false;
  readonly character = new CharacterState();
  readonly observations: ActorObservations;
  private readonly threats = new ObservedThreats();
  private observedOwnCast: ObservedCast & { action: Extract<ExpandedAction, { type: 'skill' }> } | null = null;
  readonly castAvailability:CastAvailability;
  private castRevision=0;
  private readonly strategies=new AttackStrategyPolicy();
  private strategyWait:{id:number;since:number}|null=null;
  private readonly automation: AutomationScheduler;
  readonly actionReceipts:ActionReceipts;
  private readonly loadout: LoadoutPolicy;
  private stoppedAt = 0;
  private excluded = new Map<number, number>();
  private lastAction = 0;
  private lastFrame = 0;
  private runStarted = 0;
  private lastTick = 0;
  private lootAfter = 0;
  private killedAt: Array<Position & { at: number; identity:ActionIdentity }> = [];
  private dropCreatedAt = new Map<number, {at:number; drop:DropIdentity; engagements:ActionIdentity[]}>();
  private lootOwner:ActionIdentity|null=null;

  private partySupport:{tick:()=>boolean;busy:()=>boolean}|null=null;
  setPartySupport(tick:()=>boolean,busy:()=>boolean):void {this.partySupport={tick,busy};}
  stationaryForPartySupport():boolean {return this.observedOwnCastSettled()&&this.running&&!this.retreatOwned&&!this.manualTargetOwned&&!this.pending&&!this.leg&&!this.route&&!this.automation.busy&&!this.awaitsImplicitWalk()&&!this.ownMotion()&&this.loadout.equipmentSettled&&!this.loadout.blocked&&this.character.sitting!==true;}
  partyHealReadiness(targetId:number,level:number,reserve:number):string|null {
    const p=this.player,target=this.actors.get(targetId);
    if(!p||p.dead||!target||target.kind!==0||target.id===p.id||target.id<=0||target.dead||target.hp<=0||!this.actorActionIdentity(targetId))return 'A current living party player is required.';
    if(!this.stationaryForPartySupport())return 'Waiting for movement, attacks and feature actions to settle.';
    if(!this.fieldContains(target))return 'Party member is outside the field lock area.';
    const observations=this.actorObservation([...CAST_PREREQUISITES,BLIND_CONDITION]);
    const sp=observations.actors.find(actor=>actor.id===p.id)?.sp;
    if(!resourceFresh(sp,observations.at)||sp!.value!==this.character.stats?.sp)return 'Fresh observed own SP is required.';
    const ready=castReadiness(41,level,this.character,observations,this.observedOwnCastSettled());
    if(ready.state!=='ready')return ready.reason;
    if(sp!.value!-ready.profile.spCost<reserve)return 'Party Heal would spend the configured SP reserve.';
    if(!this.navigation()?.canCast(cell(p),cell(target),ready.profile.range))return 'Party member is outside stationary Heal range or line of sight.';
    return null;
  }
  submitPartyHeal(targetId:number,level:number,reserve:number,reserved:(sequence:number,identity:ActionIdentity)=>void):void {
    const reason=this.partyHealReadiness(targetId,level,reserve);if(reason)throw new Error(reason);
    this.automation.submit({type:'skill',mode:'target',skillId:41,level,target:targetId},this.character,undefined,1,{receipt:matchesPartyHealExecution,reserved,retainReceipt:false});this.lastAction=this.now();this.reason=this.automation.task().label;
  }
  reconcilePartyHeal(sequence:number,motion:number):void {this.automation.reconcileSkill(sequence,motion,1);}
  constructor(private readonly send: (action: Action) => void, private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid,
    private readonly partyBinding: (entityId: number) => PartyActorBinding | null = () => null) { this.castAvailability=new CastAvailability(this.now);this.automation = new AutomationScheduler(a=>this.send(a),this.now,a=>this.actionIdentity(a)); this.actionReceipts=this.automation;this.observations=new ActorObservations(this.now);this.loadout=new LoadoutPolicy(this.now); }
  private navigation(settings: Settings = this.settings): GridNavigator | null {
    const policy=mapPolicy(settings), identity=`${this.map}:${policyIdentity(policy)}`;
    if (this.navigationMap !== identity) {
      if(this.running && this.navigationMap) this.stop('Field map policy changed; restart with the new policy.');
      const grid = this.gridFor(this.map);
      this.navigator = grid ? new GridNavigator(fieldGrid(this.map,grid,policy)) : null;
      this.navigationMap = identity;
    }
    this.navigator?.time(this.now());
    return this.navigator;
  }
  get pendingActionIdentity():ActionIdentity|null {return this.automation.pendingIdentity;}
  get player(): Entity | undefined { const p=this.playerId===null?undefined:this.entities.get(this.playerId);return p?.kind===0?p:undefined; }
  private ownMotion() {return this.playerId===null?undefined:this.motions.get(this.playerId);}
  /** Bind actions to existing observed lifetimes; NPC health is not combat evidence. */
  actorActionIdentity(targetId?:number,allowDeadSelf=false):ActionIdentity|null {
    const p=this.player;if(!p||!this.connected||!this.compatible)return null;
    const self=this.observations.context(p.id);if(!self.incarnation&&!allowDeadSelf)return null;
    const own={world:self.world,selfId:p.id,selfIncarnation:self.incarnation??0};
    if(targetId!==undefined){const target=this.observations.context(targetId);if(!target.incarnation)return null;return actionIdentity({...own,targetId,targetIncarnation:target.incarnation});}
    return actionIdentity(own);
  }
  actionIdentity(action:ExpandedAction):ActionIdentity|null {
    const target=action.type==='skill'&&action.mode==='target'?action.target:action.type==='useItem'&&action.target!==undefined&&action.target>=0?action.target:undefined;
    return this.actorActionIdentity(target,action.type==='respawn');
  }
  private awaitsImplicitWalk(): boolean {
    if (this.implicitWalk && this.now() >= this.implicitWalk.until) this.implicitWalk = null;
    return this.implicitWalk !== null;
  }

  note(text: string): void {
    this.log.unshift({ at: this.now(), text });
    this.log.length = Math.min(50, this.log.length);
  }
  connect(compatible: boolean): void {
    this.castAvailability.connectionChanged();
    this.resetWorld(); this.connected = true; this.compatible = compatible;
    this.reason = compatible ? 'Sign in and enter a character to prepare the bot.' : 'This game build is not verified.';
    this.note(this.reason);
  }
  disconnect(): void {
    this.castAvailability.connectionChanged();
    this.running = false; this.connected = false; this.compatible = false;
    this.resetWorld(); this.reason = 'Game disconnected. Sign in again, then press Start.'; this.note(this.reason);
  }
  fail(reason: string): void { this.stop(reason); this.compatible = false; }
  /** Official commands do not retire the requested run or its resource owners. */
  officialGameplay():void {this.officialMovementUntil=this.now()+4_000;}
  /** Availability evidence only; never a resource or target result receipt. */
  officialMovementReceiptOwner(event:GameEvent):EngagementIdentity|null {
    if(this.now()>=this.officialMovementUntil||!['walk','stop','position'].includes(event.type)
      ||!('id' in event)||event.id!==this.playerId)return null;
    const p=this.player;
    return p?.kind===0&&!p.dead&&p.hp>0&&this.actorActionIdentity()?this.manualActorIdentity(p.id):null;
  }
  stop(reason = 'Stopped by you.', sendStop=true): void {
    this.updateWasRunning=false;
    if(this.retreatTask)this.cancelRetreat(reason,false);
    const wasManual=!!this.manualTask||!!this.manualAttackFence||this.manualWalkFence;
    if(wasManual)this.finishManual('cancelled',reason,false);
    const wasRunning = this.running;
    this.fenceUnacknowledgedLeg();
    const reserveStop = automationSettings(this.settings).loadout.enabled && this.loadout.requestStop(reason);
    this.loadout.cancel();this.strategies.cancel();this.strategyWait=null;
    const pendingSkill = this.automation.pendingAction?.type === 'skill';
    this.combatConditions.clear();this.running = false; this.runIntent = false; this.automation.reset(); this.stoppedAt = this.now(); this.pending = null; this.route = null; this.leg = null; this.reason = reason;
    if (sendStop && (wasRunning || pendingSkill || (wasManual || reserveStop) && this.manualReceiptAdmitted()) && this.connected) {
      try { this.send({ type: 'stop' }); }
      catch { this.connected = false; this.compatible = false; this.reason = 'Connection lost while stopping.'; }
    }
    if (wasRunning || this.log[0]?.text !== reason) this.note(reason);
  }
  start(settings: Settings, continuing = false): void {
    if(this.retreatOwned)throw new Error('Wait for retreat movement and target-clear reconciliation.');
    if(this.manualTargetOwned)throw new Error('Wait for the manual command and its Stop confirmation.');
    const validated = validateSettings(settings);
    if(!continuing)this.acknowledgeLoadoutOverride();
    const p = this.player;
    if(this.partySupport?.busy()||this.automation.busy||this.awaitsImplicitWalk()||this.loadout.startBlocked)throw new Error('Wait for the current action and movement to finish.');
    if (!inSchedule(automationSettings(validated),this.now())) throw new Error('Outside the configured daily schedule.');
    if (!this.connected || !this.compatible || !p || p.kind !== 0 || !this.map) throw new Error('Enter a character in the verified game build first.');
    if(!p.dead&&!this.actorActionIdentity())throw new Error('Waiting for the current own actor lifetime to be observed.');
    const respawnOnly=p.dead&&continuing&&automationSettings(validated).respawn.enabled;
    if (!respawnOnly && validated.map !== this.map) throw new Error('Map changed. Choose monsters on the current map before starting.');
    if ((!p.dead && (p.maxHp <= 0 || p.hp / p.maxHp * 100 <= settings.minHpPercent))
      || (p.dead && (!continuing || !automationSettings(validated).respawn.enabled))) throw new Error('Recover above the HP stop limit before starting.');
    this.advanceMovement();
    if(respawnOnly&&this.deaths>automationSettings(validated).respawn.maxDeaths)throw new Error(`Death limit reached. ${deathLimitGuidance(this.deaths,automationSettings(validated).respawn.maxDeaths)}`);
    // A dead character cannot enter the field. Its authorized respawn owner is
    // admitted here; the alive tick still requires the physical field boundary.
    if(!respawnOnly){
      if(!mapAllowed(mapPolicy(validated),this.map) || !insideLockArea(mapPolicy(validated),this.map,p)) throw new Error('Enter the allowed field lock area before starting.');
      const navigation = this.navigation(validated);
      if (!navigation) throw new Error(`Verified walkability is not available for ${this.map}.`);
      if (!navigation.safe(p)) throw new Error('Move onto open ground away from portals before starting.');
    }
    this.route = null; this.leg = null; this.routeFailures = 0; this.routeStep = validated.route_step;
    this.settings = validated; this.combatConditions.clear();this.automation.reset(); this.loadout.newRun();
    this.retreatStatus={...IDLE_RETREAT,...(retreatSettings(validated).enabled?{state:'watching',reason:'Watching an accepted normal ranged engagement for bounded retreat.'} as const:{})};
    this.pending = null; this.excluded.clear();
    if(!continuing||!sameActionIdentity(this.lootOwner,this.actorActionIdentity()))this.clearLootEvidence();
    else this.pruneLootEvidence();
    this.lootOwner=this.actorActionIdentity();this.skillKills.clear();this.skillTargets.clear();
    this.deaths=0; this.runIntent = true; this.followLostAt = null; this.waypointIndex = 0; this.runKills = this.kills; this.runPickups = this.looted;
    this.running = true; this.runStarted = this.now(); this.lastTick = this.now(); this.lastAction = 0;
    this.reason = 'Looking for nearby targets.'; this.note('Started combat and loot.');
  }
  receive(events: Array<GameEvent | FeatureEvent>): void {
    this.advanceMovement();
    this.lastFrame = this.now();
    this.observations.frame();
    const observedAt = this.now();
    for (const event of events) {
      const updateOwner=this.updatePending;
      const updateDrop=updateOwner?.type==='pickup'?this.drops.get(updateOwner.id):undefined;
      const updateConfirmed=!!updateOwner&&this.selfOwnerCurrent(updateOwner.actorIdentity)&&(updateOwner.type==='attack'
        ? this.entities.get(updateOwner.id)===updateOwner.entity&&(event.type==='death'&&event.id===updateOwner.id||event.type==='remove'&&event.id===updateOwner.id&&event.dead)
        : !!updateDrop&&event.type==='pickup'&&event.id===updateOwner.id&&event.picker===this.playerId&&sameDrop(updateOwner.dropIdentity,updateDrop));
      this.apply(event);
      if(updateConfirmed&&this.updatePending===updateOwner)this.updatePending=null;
      this.observeOwnCast(event);
      // Apply in wire order: a later spawn must never lend its lifetime to an earlier attack.
      const own = this.threatOwnIdentity();
      this.threats.snapshot(60, own, this.now(), id => this.threatIdentity(id));
      if (event.type === 'attack' && event.target === this.playerId && own) {
        const source = this.entities.get(event.source), identity = this.threatIdentity(event.source);
        if (source?.kind === 1 && !source.dead && source.hp > 0 && !identity) this.threats.unavailable(observedAt);
        this.threats.observe(event.source, event.target, own, identity, observedAt, this.now(), id => this.threatIdentity(id));
      }
      this.partyChanged();
    }
    this.observations.frame();
  }
  private threatOwnIdentity(): ActionIdentity | null {
    const own = this.player;
    return own && !own.dead && own.hp > 0 && own.maxHp > 0 ? this.actorActionIdentity() : null;
  }
  private threatIdentity(id: number): ActionIdentity | null {
    const actor = this.entities.get(id);
    return actor?.kind === 1 && !actor.dead && actor.hp > 0 ? this.actorActionIdentity(id) : null;
  }
  observedThreats(windowSeconds: number): ThreatSnapshot {
    return this.threats.snapshot(windowSeconds, this.threatOwnIdentity(), this.now(), id => this.threatIdentity(id));
  }
  /** A cast timer or adjustment cannot prove completion. Initial unknown state
   * creates no fence; observed casts require source-backed availability evidence. */
  observedOwnCastSettled(): boolean { return this.observedOwnCast === null&&this.castAvailability.cooldownSettled(); }
  get observedCast():ObservedCast|null {return this.observedOwnCast?{...this.observedOwnCast,identity:{...this.observedOwnCast.identity}}:null;}
  stationaryForCastAvailability():boolean {
    this.advanceMovement();
    const feature=this.automation.pendingAction;
    return !this.retreatOwned&&!this.manualTargetOwned&&!this.pending&&!this.route&&!this.leg&&!this.awaitsImplicitWalk()&&!this.ownMotion()
      &&!this.loadout.blocked&&(!feature||feature.type==='skill'||feature.type==='useItem');
  }
  private observeOwnCast(event: GameEvent | FeatureEvent): void {
    const identity = this.actorActionIdentity();
    this.castAvailability.observe(event,this.player);
    if (this.observedOwnCast && !sameActionIdentity(this.observedOwnCast.identity, identity)) this.observedOwnCast = null;
    if (!identity){this.castAvailability.castChanged(this.observedOwnCast);return;}
    if (event.type === 'castStart' && event.id === identity.selfId) {
      const skill = { type: 'skill' as const, skillId: event.skillId, level: event.level };
      const action: Extract<ExpandedAction, { type: 'skill' }> = event.targetPosition
        ? { ...skill, mode: 'ground', position: { ...event.targetPosition } }
        : event.target !== undefined && event.target >= 0 && event.target !== identity.selfId
          ? { ...skill, mode: 'target', target: event.target } : { ...skill, mode: 'self' };
      this.observedOwnCast = { identity, action,revision:++this.castRevision,capturedAt:this.now(),remainingSeconds:event.remainingSeconds,
        facing:event.facing,ambiguous:unmarkedProcCanMatch(action) };
      this.castAvailability.capture(this.observedOwnCast);
    } else if(event.type==='look'&&event.id===identity.selfId&&event.head!==0&&this.castAvailability.nonVending) {
      // Normal release FIFO places older emitted Look before a newer CastStart.
      // An accepted non-center own Look is availability, not a skill/item ACK.
      this.observedOwnCast=null;this.castAvailability.available();
    } else if (this.observedOwnCast && (event.type === 'castStop' && event.id === identity.selfId
      // StartWalk is emitted only after TryMove admits movement; it does not ACK a resource owner.
      || event.type === 'walk' && event.id === identity.selfId
      // At the pinned source, only CounterAttack.Process emits ResetMotion, after FinishCasting.
      || event.type === 'resetMotion' && event.id === identity.selfId && this.observedOwnCast.action.skillId === 31 && this.observedOwnCast.action.mode === 'self'
      || !unmarkedProcCanMatch(this.observedOwnCast.action) && matchesSkillExecution(this.observedOwnCast.action, event, identity.selfId))) this.observedOwnCast = null;
    this.castAvailability.castChanged(this.observedOwnCast);
  }
  private resetWorld(preserveCharacter=false): void {
    this.officialMovementUntil=0;this.officialMotion=false;
    if(this.retreatTask)this.cancelRetreat('Retreat canceled after a world change.',false);
    this.retreatLedger.clear();if(!preserveCharacter){this.retreatTask=null;this.retreatStatus={...IDLE_RETREAT};}
    if(this.manualTask)this.finishManual('failed','Manual command ended after a world change.',false);
    if(!preserveCharacter){this.manualAttackFence=null;this.manualWalkFence=false;this.manualRetiredMovement=false;this.manualReceiptOwner=null;}
    this.threats.reset();
    this.observedOwnCast = null;
    this.castAvailability.castChanged(null);
    this.observations.reset();this.strategies.reset();this.strategyWait=null;this.serverTargetId=null;this.combatConditions.clear();this.revivableActors.clear();
    this.loadout.reset(preserveCharacter);
    if(!preserveCharacter)this.respawnRefreshPending=false;
    if(preserveCharacter)this.character.resetField();else {this.character.reset();this.automation.reset(true);this.runIntent=false;} this.implicitWalk = null; this.motions.clear(); this.navigator = null; this.navigationMap = ''; this.route = null; this.leg = null; this.routeFailures = 0;
    this.entities.clear(); this.actors.clear(); this.aggressors.clear(); this.drops.clear(); this.foreignTargets.clear(); this.partyEngagements.clear(); this.excluded.clear();
    this.clearLootEvidence();this.skillKills.clear();this.skillTargets.clear();this.pending = null;this.map='';this.playerId=null;
  }
  private removed(id: number, dead: boolean): void {
    const retreatKill=this.retreatTask?.identity.targetId===id&&this.retreatTask.entry.accepted&&this.retreatOwnCurrent()?this.retreatTask.identity:null;
    if(this.retreatTask?.identity.targetId===id)this.cancelRetreat('Retreat target left its observed lifetime.');
    this.retreatLedger.remove(id);
    const skillKill=this.skillKills.get(id);
    // HP reaching zero invalidates predicate observations before the death
    // packet. Target replacement/departure already discards these owners;
    // the surviving credit must still belong to the current own lifetime.
    const killIdentity=this.pending?.type==='attack'&&this.pending.id===id&&this.selfOwnerCurrent(this.pending.actorIdentity)?this.pending.actorIdentity
      :this.updatePending?.type==='attack'&&this.updatePending.id===id&&this.entities.get(id)===this.updatePending.entity&&this.selfOwnerCurrent(this.updatePending.actorIdentity)?this.updatePending.actorIdentity
      :skillKill&&skillKill.until>=this.now()&&this.selfOwnerCurrent(skillKill.identity)?skillKill.identity:retreatKill;
    if(this.manualTask?.request.command.type==='attack'&&this.manualTask.request.command.target.id===id)this.finishManual(dead?'complete':'failed',dead?'Selected monster death confirmed.':'Selected monster left view.');
    if(this.strategyWait?.id===id)this.strategyWait=null;
    this.strategies.remove(id);this.combatConditions.delete(id);this.observations.remove(id);if(this.serverTargetId===id)this.serverTargetId=null;
    this.motions.delete(id);
    const entity = this.entities.get(id) ?? this.actors.get(id);
    if(!dead)this.revivableActors.delete(id);
    else if(entity?.kind===0&&id!==this.playerId&&(this.revivableActors.has(id)||this.revivableActors.size<150))this.revivableActors.set(id,{...entity,statuses:undefined});
    if (dead && entity && !this.foreignTargets.has(id)
      && killIdentity) {
      this.pruneLootEvidence();
      this.kills++;this.killedAt.push({x:entity.x,y:entity.y,at:this.now(),identity:{...killIdentity}});
      if(this.killedAt.length>MAX_OWN_KILLS)this.killedAt.shift();
      this.lootAfter = this.now() + LOOT_DELAY;
      this.note(`Defeated ${entity.name}.`);
    }
    if (this.pending?.id === id && this.pending.type === 'attack') {
      if (!dead && this.pending.direct && this.pending.approachSince !== null) { this.send({ type: 'stop' }); this.lastAction = this.now(); }
      this.pending = null;
    }
    if (this.route?.id === id) {if(this.route.type==='follow')this.followLostAt??=this.now();this.cancelRoute();}
    this.skillKills.delete(id); this.skillTargets.delete(id); this.foreignTargets.delete(id); this.partyEngagements.remove(id); this.aggressors.delete(id); this.actors.delete(id);
    if(id===this.playerId){this.clearLootEvidence();this.skillKills.clear();this.skillTargets.clear();this.aggressors.clear();}
    if (id === this.playerId && dead && entity) { const alreadyDead=entity.dead;entity.dead=true;entity.hp=0;if(!alreadyDead)this.onDeath(); }
    else { this.entities.delete(id);if(id===this.playerId)this.stop('Character left the field.',false); }
  }
  private apply(e: GameEvent | FeatureEvent): void {
    this.observations.apply(e,undefined,this.player?.id??null);
    if(this.retreatTask&&(e.type==='castStart'||e.type==='castExtend')&&e.id===this.playerId&&this.actorActionIdentity())this.cancelRetreat('Own cast interrupted normal retreat; waiting for its observed settlement.',false);
    if (!['enter','map','spawn','remove','clear','stop','position','tracking','walk','attack','hit','death','resurrection','heal','drop','pickup'].includes(e.type)) {
      if(this.playerId!==null)this.character.apply(e as FeatureEvent,this.player?.id??null);
      const loadoutFailure=this.loadout.observe(e as FeatureEvent,this.character,automationSettings(this.settings).loadout.enabled);
      const pendingSkill = this.automation.pendingAction;
      const strategyTarget=this.strategies.pendingTarget;
      const result = this.automation.observe(e as FeatureEvent,this.character,this.player?.id??null);
      if(result.state!=='ignored')this.strategies.settled(this.automation.result.sequence,result.state,strategyTarget===null?null:engagementIdentity(strategyTarget,this.observations.context(strategyTarget)));
      if (result.state==='confirmed' && this.running && e.type === 'skillResult' && e.mode === 'target'
        && e.target !== undefined && pendingSkill?.type === 'skill' && pendingSkill.mode === 'target'
        && this.entities.get(e.target)?.kind === 1 && !e.indirect && (e.attacker === undefined || e.attacker === -1 || e.attacker === e.source) && !this.foreignTargets.has(e.target)) {
        const identity=this.actionIdentity(pendingSkill);
        if(identity) {
          this.skillTargets.set(e.target, { skillId: e.skillId, until: this.now() + 30_000,identity });
          if ((e.damage ?? 0) > 0) this.skillKills.set(e.target, {until:this.now() + 30_000,identity});
        }
      }
      if ((e.type === 'skillResult' || e.type === 'skillImpact') && e.target !== undefined && (e.damage ?? 0) > 0
        && this.entities.get(e.target)?.kind === 1) {
        if (e.source !== this.playerId || e.type === 'skillResult' && (e.indirect || e.attacker !== undefined && e.attacker !== -1 && e.attacker !== e.source)) {
          const direct = e.type === 'skillResult' && e.mode === 'target' && !e.indirect && (e.attacker === undefined || e.attacker === -1 || e.attacker === e.source);
          this.observeForeignEngagement(e.target, direct ? this.currentPartyBinding(e.source) : null,
            direct ? 'unverified source' : 'indirect or conflicting damage owner');
        } else if (e.type === 'skillImpact') {
          const target=this.skillTargets.get(e.target);
          if(target?.skillId===e.skillId&&target.until>=this.now()&&sameActionIdentity(target.identity,this.actorActionIdentity(e.target)))
            this.skillKills.set(e.target,{until:this.now()+30_000,identity:target.identity});
        }
      }
      if(e.type==='skillResult'&&e.mode==='target'&&(e.damage??0)>0&&e.indirect===false
        &&(e.attacker===undefined||e.attacker===-1||e.attacker===e.source))this.observeAggressor(e.source,e.target);
      if(result.state==='confirmed'&&pendingSkill?.type==='equip')this.loadout.confirmed(this.character);
      if(loadoutFailure&&(this.running||this.manualTask)&&automationSettings(this.settings).loadout.enabled)this.stop(loadoutFailure);
      if (result.state==='rejected') this.stop(result.failure.reason);
      if((this.running||this.manualTask)&&automationSettings(this.settings).loadout.enabled&&['inventory','inventoryDelta','equipment'].includes(e.type)&&this.pending?.type==='attack'){
        const failure=this.player?this.loadout.attackGuard(automationSettings(this.settings),this.player,this.character):null;if(failure){this.loadout.stockFault(failure,this.character);this.stop(failure);}
      }
    }
    switch (e.type) {
      case 'changeTarget': {
        if(e.id===0&&this.retreatTask&&(this.retreatOwnCurrent()||this.unsentRetreatRemovalCurrent()))this.retreatTask.cleared=true;
        if(e.id!==0&&this.retreatTask){delete this.retreatTask.unsentRemoval;delete this.retreatTask.unsentArrival;}
        if(e.id===0&&this.manualAttackFence?.accepted&&this.manualReceiptCurrent())this.manualAttackFence=null;
        if(e.id!==0)this.acceptManualAttack(e.id);
        const target=e.id===0?undefined:this.entities.get(e.id)??this.actors.get(e.id);this.serverTargetId=target&&!target.dead&&target.hp>0?e.id:null;break;
      }
      case 'enter':
        this.stop('Preparing character.'); this.resetWorld(); this.playerId = e.id; this.map = e.map;
        this.observations.beginOwnInitialization(e.id); break;
      case 'map': {
        this.prepareUnsentRetreatArrival(e.map,1);
        this.respawnArrival=this.player?{id:this.player.id,name:this.player.name,entry:1}:null;
        const respawning=this.automation.pendingAction?.type==='respawn';
        const resume=respawning||(!this.running&&this.runIntent);
        if(respawning){this.running=false;this.reason='Waiting for the respawned character.';}
        else this.stop('Waiting for the character on the new map.',false);
        this.runIntent = resume; const id = this.playerId;
        this.resetWorld(true); this.playerId = id; this.map = e.map; this.respawnRefreshPending=respawning; break;
      }
      case 'clear': {
        this.prepareUnsentRetreatArrival(this.map,2);
        this.respawnArrival=this.player?{id:this.player.id,name:this.player.name,entry:2}:null;
        const respawning = this.automation.pendingAction?.type === 'respawn';
        const resume = !this.running && this.runIntent;
        if (respawning) {
          // Same-map respawn emits clear then an alive self spawn, without a map packet.
          this.running = false; this.runIntent = true; this.reason = 'Waiting for the respawned character.';
        } else { this.stop('Waiting for the refreshed character.',false); this.runIntent = resume; }
        const id = this.playerId; const map = this.map;
        this.resetWorld(true); this.playerId = id; this.map = map; this.respawnRefreshPending = respawning; break;
      }
      case 'spawn':
        if(this.retreatTask&&e.entity.id===this.retreatTask.identity.selfId){
          const task=this.retreatTask,arrival=task.unsentArrival,removal=task.unsentRemoval;
          // Foreign actors are irrelevant. A replacement own lifetime cannot
          // inherit the removed character's unused intent or transition proof.
          if(removal&&!arrival||arrival&&(e.entity.name!==arrival.name||e.entity.kind!==0||e.entryType!==arrival.entry)){
            delete task.unsentRemoval;delete task.unsentArrival;
          }
        }
        if(this.retreatTask?.unsentArrival){
          const task=this.retreatTask,arrival=task.unsentArrival!,own=e.entity;
          if(this.map===arrival.map&&own.id===arrival.id&&own.name===arrival.name&&own.kind===0&&e.entryType===arrival.entry&&!own.dead&&own.hp>0
            &&!task.walkSent&&!task.walkPending&&!this.leg&&!this.ownMotion()&&!this.implicitWalk)this.retreatTask=null;
        }
        if(this.retreatTask?.identity.targetId===e.entity.id)this.retreatTask.entry.accepted=false;
        if(this.retreatTask&&(e.entity.id===this.playerId||e.entity.id===this.retreatTask.identity.targetId))this.cancelRetreat('Retreat actor lifetime changed.');
        if(this.manualTask&&(e.entity.id===this.playerId||this.manualTask.request.command.type==='attack'&&e.entity.id===this.manualTask.request.command.target.id))this.finishManual('failed','Observed actor lifetime changed.');
        if(this.entities.has(e.entity.id)||this.actors.has(e.entity.id))this.replaceActorOwnership(e.entity.id);
        if(this.strategyWait?.id===e.entity.id)this.strategyWait=null;
        this.strategies.remove(e.entity.id);this.revivableActors.delete(e.entity.id);
        if(this.serverTargetId===e.entity.id)this.serverTargetId=null;
        this.observations.spawn(e.entity,this.playerId,e.entryType);
        this.motions.delete(e.entity.id);
        // A spawn replaces this ID in both stores, including cross-kind reuse.
        this.entities.delete(e.entity.id);this.actors.delete(e.entity.id);
        // Actors remain bounded in memory for opt-in follow and NPC workflows.
        if ((e.entity.id !== this.playerId || e.entity.kind!==0) && (e.entity.kind === 0 || e.entity.kind === 2 || e.entity.kind === 4) && (this.actors.has(e.entity.id)||this.actors.size < 150)) this.actors.set(e.entity.id, e.entity);
        if (e.entity.id === this.playerId&&e.entity.kind===0 || e.entity.kind === 1) this.entities.set(e.entity.id, e.entity);
        if (e.entity.id === this.playerId&&e.entity.kind===0) {
          this.character.spawn(e.entity as StatefulEntity);
          if (this.respawnRefreshPending && this.respawnArrival && e.entryType===this.respawnArrival.entry && e.entity.id===this.respawnArrival.id && e.entity.name===this.respawnArrival.name && !e.entity.dead && e.entity.hp > 0) {
            this.automation.observe({ type: 'resurrection' }, this.character, this.player?.id??null,true);
            this.respawnRefreshPending = false;
          }
        }
        if (e.entity.id === this.playerId&&e.entity.kind===0 && !this.running) { this.reason = 'Ready. Choose your targets and press Start.'; this.note('Character ready.'); }
        break;
      case 'tracking': break; // Minimap markers do not correct world movement.
      case 'stop':
        if(e.id===this.playerId)this.officialMotion=false;
        if(e.id===this.playerId&&this.now()<this.officialMovementUntil){
          this.route=null;this.leg=null;this.implicitWalk=null;
          if(this.pending?.type==='attack')this.pending=null;
        }
        if(e.id===this.playerId&&this.retreatTask&&this.retreatOwnCurrent()){
          this.retreatTask.walkPending=false;
          if(this.retreatTask.phase==='walking')this.cancelRetreat('Retreat walking was interrupted by the server.',false);
        }
        if(e.id===this.playerId&&this.manualTask)this.finishManual('failed','Manual movement or attack was interrupted by the server.',false);
        if(e.id===this.playerId&&this.manualReceiptAdmitted())this.manualWalkFence=false;
        if (e.id === this.playerId&&this.manualReceiptAdmitted()) this.implicitWalk = null;
        this.motions.delete(e.id); this.interrupted(e.id);
        break;
      case 'walk': {
        const retreatReceipt=!!this.retreatMovementReceiptOwner(e);
        const manualReceiptOwner=!!this.manualTask||!!this.manualAttackFence||this.manualWalkFence||this.manualRetiredMovement;
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id);
        if (!entity) break;
        Object.assign(entity, walkPosition(e.walk, 0));
        this.motions.delete(e.id);
        if (!e.walk.locked && e.walk.cells.length > 1) this.motions.set(e.id, { walk: e.walk, at: this.now() });
        if(e.id===this.playerId&&this.running&&this.now()<this.officialMovementUntil){
          // A current-own StartWalk is authoritative physical state. It may be
          // longer than a bot leg or cross a portal; never issue Stop merely
          // because the official client chose a different route. New bot paths
          // still require verified collision data after this motion settles.
          this.officialMotion=!e.walk.locked&&e.walk.cells.length>1;
          if(this.retreatTask)this.cancelRetreat('Official movement superseded the retreat route.',false);
          this.route=null;this.leg=null;this.implicitWalk=null;
          if(this.pending?.type==='attack')this.pending=null;
          break;
        }
        if(retreatReceipt&&this.retreatTask){
          const task=this.retreatTask;task.walkPending=false;
          if(this.leg){
            // Accepted occupancy detours count too; a replan never replenishes
            // the cycle's already dispatched path allowance.
            task.steps+=Math.max(0,e.walk.cells.length-this.leg.cells.length);
            this.leg.destination={...e.walk.cells.at(-1)!};this.leg.cells=e.walk.cells;this.leg.acceptedUntil=this.now()+walkDuration(e.walk)+100;
            if(task.steps>retreatSettings(this.settings).maxPathSteps)this.cancelRetreat('Accepted retreat walk exceeded the remaining path allowance.');
          }
        }
        if(e.id===this.playerId&&this.retreatTask&&(!retreatReceipt||e.walk.locked))this.cancelRetreat('Retreat walk was locked or crossed unverified ground.');
        if (e.id === this.playerId && !this.running && this.automation.pendingAction?.type === 'skill') {
          this.stop('Manual skill triggered movement; waiting for it to settle.'); break;
        }
        if (e.id === this.playerId && !e.walk.locked&&this.manualReceiptAdmitted()) this.implicitWalk = null;
        if(e.id===this.playerId&&!e.walk.locked&&this.manualReceiptAdmitted())this.manualWalkFence=false;
        if (e.id === this.playerId && (this.running||manualReceiptOwner&&this.manualReceiptAdmitted())) {
          const nav = this.navigation();
          if (!nav || e.walk.cells.length > 21 || !nav.validRoute(e.walk.cells)) {
            this.stop('Server walk crossed blocked cells or a portal exclusion.'); break;
          }
          if(!e.walk.locked&&this.manualAttackFence)this.acceptManualAttack(this.manualAttackFence.target.id);
          if (this.leg) {
            const endpoint = e.walk.cells.at(-1);
            if (e.walk.locked) this.leg.acceptedUntil = null;
            else if (!endpoint || walkDuration(e.walk) > 15000) this.failRoute();
            else {
              if(this.manualTask)this.manualTask.acceptedWalk=true;
              // Replies carry no request ID. A shortened Stop route or delayed reply
              // supersedes the movement estimate, not the task's intended goal.
              this.leg.destination = { ...endpoint }; this.leg.cells = e.walk.cells;
              this.leg.acceptedUntil = this.now() + walkDuration(e.walk) + 100;
            }
          }
          if (this.pending && this.pending.approachSince === null) this.pending.approachSince = this.now();
        }
        break;
      }
      case 'position': {
        if(e.id===this.playerId)this.officialMotion=false;
        if(e.id===this.playerId&&this.retreatTask)this.cancelRetreat('Retreat position was corrected.',this.now()>=this.officialMovementUntil);
        if(this.manualTask&&e.id===this.playerId)this.finishManual('failed','Character position was corrected; preview the command again.');
        this.motions.delete(e.id); this.interrupted(e.id);
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id); if (entity) Object.assign(entity, e.position);
        if(this.running && e.id===this.playerId && !this.fieldContains(e.position))this.stop('Server correction left the configured field lock area.');
        break;
      }
      case 'remove': {
        const task=this.retreatTask,p=this.player;
        if(task&&e.id===task.identity.selfId){
          delete task.unsentRemoval;delete task.unsentArrival;
          // Own OutOfSight/Teleport removal precedes map/clear at the pin.
          // Capture physical absence before removed() erases that evidence.
          if((e.reason===0||e.reason===1)&&p?.kind===0&&!p.dead&&p.hp>0&&this.retreatOwnCurrent()
            &&!task.walkSent&&!task.walkPending&&!this.leg&&!this.ownMotion()&&!this.implicitWalk)
            task.unsentRemoval={id:p.id,name:p.name,map:this.map,world:task.identity.world,incarnation:task.identity.selfIncarnation,reason:e.reason};
        }
        this.removed(e.id,e.dead);break;
      }
      case 'death': {
        const task=this.retreatTask;
        // Player.Die clears its target before emitting Death. Retire only an
        // unsent retreat intent, capturing physical ownership before cancellation
        // and own-lifetime removal. A fatal Hit may already remove observations.
        const retireUnsent=task&&e.id===this.playerId&&this.player?.kind===0&&!this.player.dead
          &&task.identity.selfId===e.id&&task.identity.world===this.observations.context().world
          &&!task.walkSent&&!task.walkPending&&!this.leg&&!this.ownMotion()&&!this.implicitWalk;
        if(e.id===this.playerId&&task)this.cancelRetreat('Retreat canceled because the character died.');
        if(retireUnsent)this.retreatTask=null;
        if(e.id===this.playerId&&this.manualTask)this.finishManual('failed','Character died.');
        this.observations.remove(e.id);if(e.id===this.playerId||this.serverTargetId===e.id)this.serverTargetId=null;
        this.motions.delete(e.id);
        if (e.id === this.playerId && this.player) { if(!this.player.dead) {this.player.dead = true; this.player.hp = 0; this.onDeath();} }
        else this.removed(e.id, true);
        break;
      }
      case 'resurrection': {
        if(this.retreatTask?.identity.targetId===e.id)this.retreatTask.entry.accepted=false;
        if(this.retreatTask&&(e.id===this.playerId||e.id===this.retreatTask.identity.targetId))this.cancelRetreat('Retreat actor lifetime changed.');
        if(this.manualTask?.request.command.type==='attack'&&this.manualTask.request.command.target.id===e.id)this.finishManual('failed','Selected monster lifetime changed.');
        if(e.id===this.playerId){this.clearLootEvidence();this.aggressors.clear();}
        else this.replaceActorOwnership(e.id);
        this.observations.remove(e.id);if(e.id===this.playerId||this.serverTargetId===e.id)this.serverTargetId=null;
        this.motions.delete(e.id);
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id) ?? this.revivableActors.get(e.id);
        this.revivableActors.delete(e.id);
        if(entity?.kind===0&&e.id!==this.playerId&&this.actors.size<150)this.actors.set(e.id,entity);
        if (entity) { entity.dead = false; entity.hp = Math.min(e.hp, entity.maxHp); Object.assign(entity, e.position);this.observations.spawn({...entity,statuses:undefined,partyId:undefined,partyName:undefined,sp:undefined,maxSp:undefined,maxHp:0},this.playerId); }
        if (e.id === this.playerId) { const resume = this.automation.pendingAction?.type === 'respawn'; this.automation.observe({type:'resurrection'},this.character,this.player?.id??null,true); this.stop('Character revived. Press Start when ready.'); this.runIntent = resume; }
        break;
      }
      case 'attack': {
        const normalIdentity=e.source===this.playerId?this.actorActionIdentity(e.target):null;
        const normalEntry=normalIdentity?this.retreatLedger.get(normalIdentity):null;
        if(normalEntry&&sameActionIdentity(normalEntry.identity,normalIdentity)&&(this.pending?.type==='attack'&&this.pending.id===e.target||this.retreatTask?.identity.targetId===e.target)){normalEntry.accepted=true;normalEntry.progress=this.now();}
        if(e.source===this.playerId&&this.retreatTask&&sameActionIdentity(this.retreatTask.identity,normalIdentity)){
          // An Attack is never an explicit Walk receipt. A late shot after an
          // earlier target clear needs a new clear; Stop is retried only once.
          this.retreatTask.cleared=false;
          if(!this.retreatTask.stopRetried){this.retreatTask.stopRetried=true;this.send({type:'stop'});this.lastAction=this.now();}
        }
        if(e.source===this.playerId)this.acceptManualAttack(e.target);
        if (e.source === this.playerId && e.target === this.implicitWalk?.targetId&&this.manualReceiptAdmitted()) this.implicitWalk = null;
        const manualWalkOwner=e.source===this.playerId&&(this.manualTask?.request.command.type==='walk'||this.manualWalkFence||this.manualRetiredMovement&&this.motions.has(this.playerId)||!!this.retreatTask&&(this.retreatTask.walkPending||this.retreatTask.walkSent&&this.motions.has(this.playerId)));
        if(!manualWalkOwner)this.motions.delete(e.source);
        const entity = this.entities.get(e.source) ?? this.actors.get(e.source); if (entity&&!manualWalkOwner) Object.assign(entity, e.position);
        this.observeAggressor(e.source,e.target);
        if (e.source !== this.playerId && this.entities.get(e.target)?.kind === 1) {
          this.observeForeignEngagement(e.target, this.currentPartyBinding(e.source));
        }
        if (e.source === this.playerId && this.pending?.type === 'attack' && this.pending.id === e.target
          && sameActionIdentity(this.pending.actorIdentity,this.actorActionIdentity(e.target))) { this.pending.progress = this.now(); this.pending.approachSince = null; this.pending.direct = false; }
        if(this.manualTask?.request.command.type==='attack'&&e.source===this.playerId&&e.target===this.manualTask.request.command.target.id){this.manualTask.attackObserved=true;this.manualStatus.state='attacking';}
        break;
      }
      case 'hit': {
        if(this.manualTask&&e.id===this.playerId&&e.stops)this.finishManual('failed','Manual movement was interrupted by a hit.');
        if (e.stops) { this.motions.delete(e.id); this.interrupted(e.id); }
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id);
        if (entity) { entity.hp = Math.max(0, Math.min(entity.maxHp, entity.hp - e.damage)); Object.assign(entity, e.position);if(entity.hp===0){this.strategies.remove(e.id);this.observations.remove(e.id);if(e.id===this.playerId||this.serverTargetId===e.id)this.serverTargetId=null;} }
        break;
      }
      case 'heal': {
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id); if (entity) { entity.hp = e.hp; entity.maxHp = e.maxHp; } break;
      }
      case 'stats': if (this.player) { this.player.hp = e.hp; this.player.maxHp = e.maxHp; this.player.level = e.level; } break;
      case 'drop': {
        const drop=admitDrop(e.drop);
        const previous=this.drops.get(drop.id);
        if(previous&&!sameDrop(previous,drop)) {
          // A reused/contradictory drop ID cannot inherit the old correlation
          // or receipt credit. Keep a sent pickup owned until its normal reply
          // or timeout; do not immediately retry the changed ground item.
          this.dropCreatedAt.delete(drop.id);
          this.excluded.set(drop.id,this.now()+30000);
          if(this.pending?.type==='pickup'&&this.pending.id===drop.id)this.pending.dropIdentity=undefined;
          if(this.route?.type==='pickup'&&this.route.id===drop.id)this.cancelRoute();
        }
        if(!this.drops.has(drop.id)&&drop.isNew&&(this.running||this.killedAt.length>0&&sameActionIdentity(this.lootOwner,this.actorActionIdentity())))this.observeNewDrop(drop);
        this.drops.set(drop.id, drop); break;
      }
      case 'pickup':
        {const owner=this.pending?.type==='pickup'?this.pending:this.updatePending?.type==='pickup'?this.updatePending:null;
        if (e.picker === this.playerId && owner?.id === e.id&&this.selfOwnerCurrent(owner.actorIdentity)) {
          const drop=this.drops.get(e.id);
          if(drop&&sameDrop(owner.dropIdentity,drop)){this.looted++;this.lootStats.set(drop.itemId,(this.lootStats.get(drop.itemId)??0)+drop.count);this.note('Loot pickup confirmed.');}
        }}
        this.drops.delete(e.id);
        this.dropCreatedAt.delete(e.id);
        if (this.pending?.type === 'pickup' && this.pending.id === e.id) this.pending = null;
        if (this.route?.type === 'pickup' && this.route.id === e.id) this.cancelRoute();
        break;
    }
    if (this.player && this.character.stats) { this.character.stats.hp = this.player.hp; this.character.stats.maxHp = this.player.maxHp; this.character.stats.level = this.player.level; }
    if (this.running && this.player && !this.player.dead && this.player.hp / this.player.maxHp * 100 <= this.settings.minHpPercent) this.stop('HP reached the stop limit. Recover manually.');
  }
  tick(dispatchDecisions = true): void {
    if(this.updateSuspended)dispatchDecisions=false;
    const now = this.now();
    this.advanceMovement(); this.loadout.tick(); this.partyChanged();
    this.retreatSettlement();
    const manualSkill = !this.running && this.automation.pendingAction?.type === 'skill';
    const actionTimeout = this.automation.timeout();
    if (actionTimeout) { if (manualSkill && this.connected) this.send({ type: 'stop' }); this.stop(actionTimeout); return; }
    if(this.updateSuspended){
      this.lastTick=now;
      if(this.retreatTask)this.tickRetreat(now,false);
      if(this.player&&!this.player.dead&&this.route)this.routeTick(this.player,now,true);
      return;
    }
    if(this.manualTask){this.tickManual(now,dispatchDecisions);return;}
    if (!this.running) return;
    if (now - this.lastTick > 5000) { this.stop('Mac slept or the game paused. Press Start to resume.'); return; }
    this.lastTick = now;
    const p = this.player;
    if (!p || !this.connected || !this.compatible) { this.stop('Game state is unavailable.',false); return; }
    if (now - Math.max(this.lastFrame, this.runStarted) > 15000) { this.stop('No recent server updates.'); return; }
    const a = automationSettings(this.settings);
    if (!inSchedule(a,now)) { this.stop('Daily schedule ended. Press Start during the next allowed period.'); return; }
    if ((a.limits.minutes && now - this.runStarted >= minutesToMilliseconds(a.limits.minutes)) || (a.limits.kills && this.kills - this.runKills >= a.limits.kills) || (a.limits.pickups && this.looted - this.runPickups >= a.limits.pickups)) { this.stop('Configured session limit reached.'); return; }
    if(!dispatchDecisions){
      if(this.retreatTask)this.tickRetreat(now,false);
      // Panel input yields decisions, not ownership. Advance accepted legs and
      // their original deadlines without sending another walk, attack or cast.
      if(!p.dead&&this.route)this.routeTick(p,now,true);
      if(!p.dead)this.expirePending(now);
      return;
    }
    if(this.partySupport?.busy()&&!this.automation.busy){this.reason='Waiting for an unresolved party Heal receipt.';return;}
    if (p.dead) { if(a.respawn.enabled && this.deaths <= a.respawn.maxDeaths && !this.automation.busy) { this.automation.submit({type:'respawn'},this.character); this.reason='Waiting for respawn confirmation.'; } return; }
    if(!this.actorActionIdentity()) {
      const intent=this.runIntent;this.stop('Waiting for the current own actor lifetime to be observed.');this.runIntent=intent;return;
    }
    if (p.maxHp <= 0 || p.hp / p.maxHp * 100 <= this.settings.minHpPercent) { this.stop('HP reached the stop limit. Recover manually.'); return; }
    if (a.limits.weightPercent) { const stats=this.character.stats; if(stats?.weight===undefined||!stats.maxWeight) { this.stop('Weight is unavailable for the configured weight limit.');return; } if(stats.weight/stats.maxWeight*100>=a.limits.weightPercent) { this.stop('Configured weight limit reached.');return; } }
    if(this.officialMotion&&this.ownMotion()){this.expirePending(now);this.reason='Waiting for the observed game movement to finish.';return;}
    this.officialMotion=false;
    const nav = this.navigation();
    if(!this.running)return;
    if (!nav || !nav.safe(p)) { this.stop('Character left verified walkable ground or entered a portal exclusion.'); return; }
    if(this.retreatTask?.phase==='cancelled'){this.reason=this.retreatTask.reason;return;}
    if (this.awaitsImplicitWalk() && !this.pending?.direct) {
      // Cancellation holds movement ownership, but cannot extend a named
      // player's visibility deadline while waiting for its late walk reply.
      if(a.follow.name||a.follow.mode==='partyLeader'){
        if(a.follow.mode==='partyLeader'?!!this.partyFollowBinding?.():[...this.actors.values()].some(e=>e.kind===0&&e.name===a.follow.name&&!e.dead))this.followLostAt=null;
        else {this.followLostAt??=now;if(now-this.followLostAt>=a.follow.lostSeconds*1000){this.stop('Follow target is no longer visible.');return;}}
      }
      this.reason = 'Waiting for the previous monster approach to acknowledge before another action.'; return;
    }
    this.pruneLootEvidence();
    if(!this.observedOwnCastSettled()) {
      this.expirePending(now);
      if(this.route)this.routeTick(p,now,true);
      this.reason=this.observedOwnCast?this.castAvailability.reason||OWN_CAST_WAIT_REASON:'Waiting for stationary input cooldown to settle.';return;
    }
    if (this.automation.busy) { this.reason=this.automation.task().label; return; }
    if(this.pending?.type==='attack') {
      const target=this.entities.get(this.pending.id);
      if(target&&(!this.fieldContains(target)||monsterRule(a,target.classId)?.conditions?.length&&!this.eligible(target,now,false))) {
        // Stop the owned auto-attack, keeping an unresolved server approach fenced
        // until its walk/stop reply or the existing bounded wait settles it.
        if(!this.ownMotion())this.implicitWalk ??= {targetId:this.pending.id,until:now+4000};
        this.pending=null;this.route=null;this.send({type:'stop'});this.lastAction=now;
        this.reason='Monster conditions no longer permit this attack.';this.note(this.reason);return;
      }
    }
    if(this.route?.type==='attack'||this.route?.type==='skill') {
      const target=this.entities.get(this.route.id!);
      if(target&&(!this.fieldContains(target)||monsterRule(a,target.classId)?.conditions?.length&&!this.eligible(target,now,false))) {
        this.cancelRoute();this.reason='Monster conditions no longer permit this approach.';this.note(this.reason);return;
      }
    }
    if(this.route?.type==='skill'){const target=this.entities.get(this.route.id!);if(!target||!this.eligible(target,now,false)){this.cancelRoute();this.reason='Attack skill target is no longer eligible.';return;}}
    if (this.automation.wantsRecovery(a,p,this.character)) {
      if(this.retreatTask){this.cancelRetreat('Stopping retreat before recovery.');return;}
      const recoveryItem=this.automation.nextRecoveryItem(a,p,this.character,this.actorObservation(flatMap(a.items, r=>r.conditions??[])));
      if(recoveryItem.failure){this.stop(recoveryItem.failure);return;}
      if (this.pending || this.route || this.leg) { this.pending=null;const stoppingLeg=!!this.leg;this.cancelRoute();if(!stoppingLeg)this.send({type:'stop'});this.lastAction=now;this.reason='Stopping combat before recovery.';return; }
      if(!!this.ownMotion()||now-this.lastAction<ACTION_DELAY)return;
      if(recoveryItem.action){this.automation.submit(recoveryItem.action,this.character);this.reason=this.automation.task().label;return;}
      const recovery=this.automation.recover(a,p,this.character);
      if(recovery.failure) {this.stop(recovery.failure);return;}
      if(recovery.action)this.automation.submit(recovery.action,this.character);
      this.reason=this.automation.task().label;if(this.automation.recovering||this.automation.busy)return;
    }
    if(this.character.sitting===true) {if(this.retreatTask){this.cancelRetreat('Stopping retreat before changing posture.');return;}if(!this.ownMotion())this.automation.submit({type:'sit',sitting:false},this.character);return;}
    const defenseEnabled=a.combat.mode==='retaliate'||a.combat.mode==='both';
    let monsterChoice: { target: Entity; cells: Position[]; strategy?:StrategyChoice } | null | undefined;
    const chooseMonster = () => {
      if (monsterChoice === undefined) {
        const candidates=[...this.entities.values()].filter(e=>this.eligible(e,now));
        const choose=(targets:Entity[])=>a.attackStrategies?.length?this.bestStrategyRoute(p,targets):this.bestRoute(p,targets,e=>monsterRule(a,e.classId)?.priority??0,true);
        // Defense is a separate tier; species priority and path cost still
        // select within each tier, and unreachable attackers do not block farming.
        monsterChoice=defenseEnabled?choose(candidates.filter(e=>this.defending(e.id)))
          ??choose(candidates.filter(e=>!this.defending(e.id))):choose(candidates);
      }
      return monsterChoice;
    };
    if(defenseEnabled&&!this.pending&&!this.retreatTask&&this.route
      &&(!['attack','skill'].includes(this.route.type)||!this.defending(this.route.id!))) {
      const defense=chooseMonster();
      if(defense&&this.defending(defense.target.id)) {
        // Replace only unsent intent. pursue keeps the original leg and its
        // acceptance/deadline; no Stop, cast or attack can cross that owner.
        this.strategyWait=null;this.pursue('attack',defense.target.id,cell(defense.target),defense.cells);
      }
    }
    const needsEnemy = !!a.attackStrategies?.length || a.loadout.enabled || a.skills.some(rule => rule.target === 'enemy') || a.equipment.some(rule => rule.monsterClassId > 0);
    const candidateEnemy=this.retreatTask?this.entities.get(this.retreatTask.identity.targetId!)??null:this.pending?.type==='attack'?this.entities.get(this.pending.id)??null:(this.route?.type==='attack'||this.route?.type==='skill')?this.entities.get(this.route.id!)??null:needsEnemy?chooseMonster()?.target??null:null;
    const enemy=candidateEnemy&&!candidateEnemy.dead&&candidateEnemy.hp>0&&this.observations.context(candidateEnemy.id).incarnation?candidateEnemy:null;
    const conditions=flatMap([...a.items,...a.skills,...a.equipment], rule=>rule.conditions??[]);
    const observations=conditions.length?this.actorObservation(conditions):undefined;
    const featureSettings=enemy&&a.attackStrategies?.some(rule=>rule.speciesIds.some(id=>id===enemy.classId))?{...a,skills:a.skills.filter(rule=>rule.target!=='enemy')}:a;
    const next=this.automation.next(a.loadout.enabled?{...featureSettings,equipment:[]}:featureSettings,p,this.character,enemy,observations);
    if(next.failure) {this.stop(next.failure);return;}
    if(next.action) {
      if(this.retreatTask){this.cancelRetreat('Stopping retreat before the pending resource action.');return;}
      if(this.pending||this.route||this.leg) {this.pending=null;const stoppingLeg=!!this.leg;this.cancelRoute();if(!stoppingLeg)this.send({type:'stop'});this.lastAction=now;return;}
      if(!!this.ownMotion()||now-this.lastAction<ACTION_DELAY)return;
      this.automation.submit(next.action,this.character);this.reason=this.automation.task().label;return;
    }
    if(a.loadout.enabled) {
      if(this.loadout.blocked){this.reason=this.loadout.snapshot(a,this.character).reason;return;}
      const planned=this.loadout.next(a,p,this.character,enemy,rule=>this.automation.conditionState(`Equipment ${rule.itemId}`,rule.conditions,observations));
      if(planned.failure){this.stop(planned.failure);return;}
      if(planned.change){
        if(this.retreatTask){this.cancelRetreat('Stopping retreat before changing equipment.');return;}
        if(this.pending||this.route||this.leg||this.loadout.needsStop){
          this.fenceUnacknowledgedLeg();
          this.pending=null;this.route=null;this.leg=null;
          this.loadout.requestStop('Waiting for target clear before changing equipment.');
          this.send({type:'stop'});this.lastAction=now;return;
        }
        if(!!this.ownMotion()||now-this.lastAction<ACTION_DELAY)return;
        this.loadout.begin(planned.change,this.character);
        this.automation.submit(planned.change.action,this.character,state=>this.loadout.receipt(state));
        this.reason=this.automation.task().label;return;
      }
      if(enemy){const guard=this.loadout.attackGuard(a,p,this.character);if(guard){this.stop(guard);return;}}
    }
    if(this.stationaryForPartySupport()&&this.partySupport?.tick())return;
    if(a.attackStrategies?.length&&enemy&&this.pending?.type!=='pickup'&&this.route?.type!=='pickup'&&this.eligible(enemy,now,false)) {
      const strategy=this.strategyChoice(enemy);
      if(this.retreatTask&&strategy.state!=='normal'){this.cancelRetreat('Stopping retreat for the applicable attack strategy.');return;}
      if(strategy.state==='wait') {
        if(this.pending?.type==='attack'){this.stopAttackForSkill(enemy.id,now);return;}
        this.strategyWait??={id:enemy.id,since:now};
        if(this.strategyWait.id!==enemy.id)this.strategyWait={id:enemy.id,since:now};
        if(now-this.strategyWait.since>=30_000){
          this.cancelRoute();this.excluded.set(enemy.id,now+30_000);this.strategyWait=null;
          this.reason=strategy.reason+' Waited 30 seconds; skipping this actor for 30 seconds.';this.note(this.reason);return;
        }
        this.reason=strategy.reason;
        // Existing walk/pursuit deadlines keep running while prerequisites are
        // unavailable. Settlement cannot plan a new walk or cast in this state.
        if(this.route){this.routeTick(p,now,true);if(!this.route)this.strategyWait=null;}
        return;
      }
      this.strategyWait=null;
      if(strategy.state==='cast') {
        if(this.pending?.type==='attack'){this.stopAttackForSkill(enemy.id,now);return;}
        if(this.route?.type!=='skill'||this.route.id!==enemy.id||!this.sameEngagement(this.route.engagement,strategy.identity)){
          const since=this.route?.id===enemy.id&&['attack','skill'].includes(this.route.type)&&this.sameEngagement(this.route.engagement,strategy.identity)?this.route.since:null;
          this.route={type:'skill',id:enemy.id,engagement:strategy.identity,destination:cell(enemy),cells:[],since,attackRange:strategy.profile.range,strategy};
        } else {this.route.strategy=strategy;}
        this.routeTick(p,now);return;
      }
      if(this.route?.type==='skill'){const since=this.route.since;this.pursue('attack',enemy.id,cell(enemy),[]);this.route!.since=since;}
    }
    if(this.retreatTask){this.tickRetreat(now,true);return;}
    if(this.pending?.type==='attack'&&this.beginRetreat(now))return;
    if (this.pending) {
      const target = this.entities.get(this.pending.id);
      const attackRange = normalAttackProfile(this.character).range;
      if (this.pending.type === 'attack' && target && (this.pending.attackRange !== attackRange
        || (!nav.canAttack(cell(p), cell(target), attackRange) && !nav.clearWalkCorridor(cell(p), cell(target))))) {
        const since = this.pending.approachSince;
        // Attack may already have requested a walk whose reply is still in flight.
        // Retain that owner until its reply or the existing bounded wait expires.
        if (!this.ownMotion()) {
          // Stop on an idle attacker emits no movement acknowledgment. Keep a
          // bounded ownership fence without inventing a failed physical leg.
          this.implicitWalk ??= { targetId: target.id, until: now + 4000 };
        }
        this.send({ type: 'stop' }); this.lastAction = now; this.pending = null;
        const cells = this.planAttack(p, target);
        if (cells && this.eligible(target, now, false)) {
          this.pursue('attack', target.id, cell(target), cells);
          this.route!.since = since;
          this.reason = 'Attack range or sight changed; finishing the server walk before replanning.';
        } else {
          this.excluded.set(target.id, now + 30000);
          this.reason = 'Monster moved to unreachable ground; skipping it for 30 seconds.';
        }
        this.note(this.reason); return;
      }
      this.expirePending(now);return;
    }
    const defenseChoice=defenseEnabled?chooseMonster():null;
    if (now < this.lootAfter && (!defenseChoice || !this.defending(defenseChoice.target.id))) return;
    // Keep a chosen pursuit stable; a moving target is replanned after the current leg.
    if (this.route && (this.route.type === 'attack' || this.route.type === 'pickup')) {
      const target = this.route.type === 'attack' ? this.entities.get(this.route.id!) : this.drops.get(this.route.id!);
      if (!target || !this.fieldContains(target) || (this.route.type === 'attack' && !this.eligible(target as Entity, now, false))) { this.cancelRoute(); return; }
      if (distance(cell(target), this.route.destination) !== 0) { this.route.destination = cell(target); this.route.cells = []; }
      this.routeTick(p, now); return;
    }
    if (now - this.lastAction < ACTION_DELAY) return;
    if(defenseChoice&&this.defending(defenseChoice.target.id)) {
      this.pursue('attack',defenseChoice.target.id,cell(defenseChoice.target),defenseChoice.cells);this.routeTick(p,now);return;
    }
    const available = (id: number) => (this.excluded.get(id) ?? 0) <= now;
    if (this.settings.loot) {
      const candidates = [...this.drops.values()].filter(d => this.fieldContains(d) && available(d.id) && distance(p, d) <= this.settings.radius
        && acceptsLoot(a,d.itemId) && (a.loot.ownership==='all'||this.ownsDrop(d)));
      const choice = this.bestRoute(p, candidates, d=>lootRule(a,d.itemId)?.priority ?? 0);
      if (choice) { this.pursue('pickup', choice.target.id, cell(choice.target), choice.cells); this.routeTick(p, now); return; }
    }
    const choice=chooseMonster();
    if (choice) { this.pursue('attack', choice.target.id, cell(choice.target), choice.cells); this.routeTick(p, now); }
    else if (a.follow.name || a.follow.mode==='partyLeader') { this.followTick(p,now); }
    else if (a.travel.waypoints.length) { this.waypointTick(p,now); }
    else if (this.settings.route_randomWalk === 2) {
      if (!this.route) {
        let destination: Position | null = null;
        let cells: Position[] | null = null;
        for (let attempt = 0; attempt < 5 && !cells; attempt++) {
          destination = nav.randomGoal(p);
          cells = destination && nav.plan(p, destination, { avoidWalls: this.settings.route_avoidWalls });
        }
        if (!destination || !cells) { this.stop('No reachable search destination. Reposition before restarting.'); return; }
        this.route = { type: 'search', destination, cells, since: now };
        this.note(`Searching the map toward ${destination.x}, ${destination.y}.`);
      }
      this.routeTick(p, now);
    } else {
      const denied=a.combat.partyEngagement&&[...this.entities.values()].find(e=>e.kind===1&&this.foreignTargets.has(e.id)&&!this.engagementAllowed(e.id));
      this.reason=denied?this.partyEngagements.reason(denied.id):'Waiting for a reachable matching monster.';
    }
  }
  /** Existing receipts retain their original deadlines while new decisions wait. */
  private expirePending(now:number):void {
    const pending=this.pending,p=this.player;if(!pending||!p)return;
    const target=this.entities.get(pending.id);
    const approachExpired=pending.approachSince!==null&&(now-pending.approachSince>=this.settings.attackMaxRouteTime*1000
      ||pending.type==='attack'&&(!target||!this.planAttack(p,target)));
    if(!approachExpired&&now-pending.progress<12000&&now-pending.since<90000)return;
    this.excluded.set(pending.id,now+30000);this.send({type:'stop'});
    this.reason='Target timed out or became unreachable; skipping it for 30 seconds.';this.note(this.reason);
    this.pending=null;this.lastAction=now;
  }
  private clearLootEvidence():void {this.killedAt=[];this.dropCreatedAt.clear();this.lootOwner=null;this.lootAfter=0;}
  private pruneLootEvidence():void {
    const now=this.now();
    if(!sameActionIdentity(this.lootOwner,this.actorActionIdentity())){this.clearLootEvidence();return;}
    this.killedAt=this.killedAt.filter(k=>now>=k.at&&now-k.at<OWN_LOOT_HISTORY);
    for(const [id,evidence]of this.dropCreatedAt)if(now<evidence.at||now-evidence.at>=OWN_LOOT_HISTORY)this.dropCreatedAt.delete(id);
  }
  private observeNewDrop(drop:DomainDrop):void {
    this.pruneLootEvidence();this.lootOwner=this.actorActionIdentity();if(!this.lootOwner)return;
    const engagements:ActionIdentity[]=[];
    const include=(identity:ActionIdentity|null|undefined)=>{
      if(!identity||identity.targetId===undefined||identity.targetIncarnation===undefined||!this.selfOwnerCurrent(identity)||this.foreignTargets.has(identity.targetId))return;
      const monster=this.entities.get(identity.targetId);
      // Zero-HP targets still retain their dispatched lifetime until removal.
      if(monster?.kind!==1||distance(monster,drop)>3||engagements.some(old=>sameActionIdentity(old,identity))||engagements.length>=MAX_DROP_ENGAGEMENTS)return;
      engagements.push({...identity});
    };
    if(this.pending?.type==='attack')include(this.pending.actorIdentity);
    if(this.retreatTask?.entry.accepted)include(this.retreatTask.identity);
    for(const skill of this.skillKills.values())if(skill.until>=this.now())include(skill.identity);
    this.dropCreatedAt.set(drop.id,{at:this.now(),drop:{itemId:drop.itemId,count:drop.count,x:drop.x,y:drop.y},engagements});
    if(this.dropCreatedAt.size>MAX_NEW_DROPS)this.dropCreatedAt.delete(this.dropCreatedAt.keys().next().value!);
  }
  private ownsDrop(drop:DomainDrop):boolean {
    const evidence=this.dropCreatedAt.get(drop.id);if(!evidence||!sameDrop(evidence.drop,drop))return false;
    return this.killedAt.some(k=>distance(k,drop)<=3&&(evidence.at>=k.at
      ||k.at-evidence.at<=PRE_DEATH_DROP_WINDOW&&evidence.engagements.some(identity=>sameActionIdentity(identity,k.identity))));
  }
  private currentPartyBinding(source: number): PartyActorBinding | null {
    if (source <= 0 || !this.connected || !this.compatible || !this.actorActionIdentity() || !this.observations.livingPlayer(source)) return null;
    const actor = this.actors.get(source) ?? this.entities.get(source), evidence = this.observations.partyActor(source);
    const binding = this.partyBinding(source);
    return actor?.kind === 0 && !actor.dead && actor.hp > 0 && evidence?.kind === 0 && binding
      && binding.entityId === source && binding.map === this.map && binding.world === evidence.world
      && binding.incarnation === evidence.incarnation && binding.affiliationRevision === evidence.affiliationRevision
      && binding.partyId === evidence.partyId ? binding : null;
  }
  private engagementAllowed(id: number): boolean {
    if (!this.foreignTargets.has(id)) return true;
    const identity = engagementIdentity(id, this.observations.context(id));
    return automationSettings(this.settings).combat.partyEngagement === true && !!identity && this.partyEngagements.allows(identity);
  }
  private observeForeignEngagement(id: number, binding: PartyActorBinding | null,
    blocker: 'unverified source' | 'indirect or conflicting damage owner' = 'unverified source'): void {
    const alreadyForeign = this.foreignTargets.has(id);
    this.foreignTargets.add(id); this.skillKills.delete(id); this.skillTargets.delete(id);
    const monster = engagementIdentity(id, this.observations.context(id));
    if (monster) this.partyEngagements.observe(monster, binding, alreadyForeign, blocker);
    if (!this.engagementAllowed(id)) {
      if (automationSettings(this.settings).combat.partyEngagement === true && !this.manualTask) this.cancelPartyEngagement(id);
      else if (this.pending?.type === 'attack' && this.pending.id === id || this.route?.type === 'attack' && this.route.id === id)
        this.stop('Another character engaged this target.');
    }
  }
  /** A full association replacement can have the same fields; retire the old authorization first. */
  partyMembershipChanged(memberId?: number): void {
    const revoked = this.partyEngagements.invalidateMember(memberId);
    if (automationSettings(this.settings).combat.partyEngagement === true)
      for (const id of revoked) this.cancelPartyEngagement(id);
  }
  /** Observe each binding invalidation before a later full roster can replace it. */
  partyChanged(): void {
    const revoked = this.partyEngagements.refresh(id => this.currentPartyBinding(id));
    if (automationSettings(this.settings).combat.partyEngagement === true)
      for (const id of revoked) this.cancelPartyEngagement(id);
  }
  private cancelPartyEngagement(id: number): void {
    if (!this.running) return; // Explicit manual skill owners do not inherit this automatic policy.
    const attack = this.pending?.type === 'attack' && this.pending.id === id;
    const route = !!this.route && ['attack','skill'].includes(this.route.type) && this.route.id === id;
    const action = this.automation.pendingAction;
    const cast = action?.type === 'skill' && action.mode === 'target' && action.target === id;
    if (!attack && !route && !cast) return;
    if (this.manualTask) { this.stop('Party engagement permission was revoked.'); return; }
    // Cancellation preserves finite run/strategy ledgers. An accepted walk keeps
    // its original motion; an unacknowledged/direct approach cannot match a late attack.
    if (attack || route && this.leg) this.implicitWalk ??= {targetId:null,until:this.now()+4000};
    if (this.implicitWalk) this.implicitWalk.targetId = null;
    if (cast) {
      this.automation.reset(); this.strategies.cancel();
      // Preserve requested intent and clocks, but hand the sent cast back to
      // the controller's retained receipt fence before any new field decision.
      this.running = false; this.stoppedAt = this.now();
    }
    if (attack) this.pending = null;
    if (route) { this.route = null; this.leg = null; }
    if (this.strategyWait?.id === id) this.strategyWait = null;
    if (attack || cast || route && this.ownMotion() || this.awaitsImplicitWalk()) {
      this.send({type:'stop'}); this.lastAction = this.now();
    }
    this.reason = this.partyEngagements.reason(id); this.note(this.reason);
  }
  private fieldContains(p:Position):boolean {const policy=mapPolicy(this.settings);return mapAllowed(policy,this.map)&&insideLockArea(policy,this.map,p);}
  private observeAggressor(source:number,target:number|undefined):void {
    if(target!==this.playerId||!this.threatOwnIdentity())return;
    const identity=this.threatIdentity(source);
    if(identity)this.aggressors.set(source,identity);
  }
  private isAggressor(id:number):boolean {
    const identity=this.aggressors.get(id);
    if(identity&&sameActionIdentity(identity,this.threatIdentity(id)))return true;
    this.aggressors.delete(id);return false;
  }
  private defending(id:number):boolean {
    const mode=automationSettings(this.settings).combat.mode;
    return (mode==='retaliate'||mode==='both')&&this.isAggressor(id);
  }
  private eligible(e: Entity, now: number, acquiring = true): boolean {
    const automation=automationSettings(this.settings);const conditions=monsterRule(automation,e.classId)?.conditions;
    const observations=conditions?.length?this.actorObservation(conditions,this.currentTargetId,e.id):undefined;
    if(conditions?.length&&(this.combatConditions.has(e.id)||this.combatConditions.size<32))this.combatConditions.set(e.id,{rule:`Monster ${e.classId} · actor ${e.id}`,conditions:map(conditions, actorPredicateEvaluator(observations))});
    return this.fieldContains(e) && e.kind === 1 && !e.dead && e.hp > 0 && !!this.observations.context(e.id).incarnation && acceptsMonster(automation,e,this.player!,this.settings.targets,this.isAggressor(e.id),observations)
      && (!acquiring || distance(this.player!, e) <= this.settings.radius) && this.engagementAllowed(e.id)
      && (this.excluded.get(e.id) ?? 0) <= now;
  }
  private plan(from: Position, to: Position, range: number, goal: 'walk' | 'attack' | 'cast' = 'walk'): Position[] | null {
    if(!this.fieldContains(to))return null;
    return this.navigation()?.plan(cell(from), cell(to), {
      range, goal, maxDistance: this.settings.attackRouteMaxPathDistance, avoidWalls: this.settings.route_avoidWalls,
    }) ?? null;
  }
  private planAttack(from: Position, to: Position): Position[] | null {
    return this.plan(from, to, normalAttackProfile(this.character).range, 'attack');
  }
  private bestRoute<T extends Position & { id: number }>(from: Position, candidates: T[], priority: (target: T) => number = () => 0, attack = false): { target: T; cells: Position[] } | null {
    let best: { target: T; cells: Position[]; cost: number; priority: number } | null = null;
    const origin = cell(from);
    const range = attack ? normalAttackProfile(this.character).range : 1;
    for (const target of candidates) {
      const rank = priority(target);
      // Iterate in original order: later equal-cost candidates never replace the
      // current winner. The bound omits walls and cannot overstate route cost.
      if (best && (rank < best.priority || (rank === best.priority && minimumRouteCost(origin, cell(target), range) >= best.cost))) continue;
      const cells = this.plan(from, target, range, attack ? 'attack' : 'walk');
      if (!cells) continue;
      const cost = cells.reduce((sum, p, i) => sum + (i ? (p.x !== cells[i - 1]!.x && p.y !== cells[i - 1]!.y ? 14 : 10) : 0), 0);
      if (!best || rank > best.priority || (rank === best.priority && cost < best.cost)) best = { target, cells, cost, priority: rank };
    }
    return best;
  }
  private sameEngagement(a:EngagementIdentity|null|undefined,b:EngagementIdentity):boolean {return !!a&&a.world===b.world&&a.id===b.id&&a.incarnation===b.incarnation;}
  private strategyChoice(target:Entity):StrategyChoice {
    const a=automationSettings(this.settings);
    const conditions=[...flatMap(a.attackStrategies??[], rule=>rule.conditions??[]),...CAST_PREREQUISITES,BLIND_CONDITION];
    return this.strategies.choose(a.attackStrategies??[],engagementIdentity(target.id,this.observations.context(target.id)),target.classId,this.character,this.actorObservation(conditions),this.now());
  }
  private bestStrategyRoute(from:Entity,candidates:Entity[]):{target:Entity;cells:Position[];strategy:StrategyChoice}|null {
    const a=automationSettings(this.settings);
    let best:{target:Entity;cells:Position[];strategy:StrategyChoice;rank:number;cost:number}|null=null;
    for(const target of candidates){
      const strategy=this.strategyChoice(target);const rank=monsterRule(a,target.classId)?.priority??0;
      const range=strategy.state==='cast'?strategy.profile.range:normalAttackProfile(this.character).range;
      if(best&&(rank<best.rank||rank===best.rank&&minimumRouteCost(cell(from),cell(target),range)>=best.cost))continue;
      const cells=strategy.state==='wait'?[cell(from)]:strategy.state==='cast'?this.plan(from,target,range,'cast'):this.planAttack(from,target);
      if(!cells)continue;
      const cost=cells.reduce((n,p,i)=>n+(i?(p.x!==cells[i-1]!.x&&p.y!==cells[i-1]!.y?14:10):0),0);
      if(!best||rank>best.rank||rank===best.rank&&cost<best.cost)best={target,cells,strategy,rank,cost};
    }
    return best;
  }
  private stopAttackForSkill(id:number,now:number):void {
    if(!this.ownMotion())this.implicitWalk??={targetId:id,until:now+4000};
    if(automationSettings(this.settings).loadout.enabled)this.loadout.requestStop('Waiting for target clear before the attack skill.');
    const engagement=engagementIdentity(id,this.observations.context(id));
    const since=engagement&&this.sameEngagement(this.pending?.engagement??this.route?.engagement,engagement)?this.pending?.approachSince??this.route?.since??null:null;
    this.pending=null;this.route={type:'skill',id,engagement,destination:cell(this.entities.get(id)!),cells:[],since};
    this.send({type:'stop'});this.lastAction=now;this.reason='Stopping normal attack before casting.';
  }
  private dispatchStrategy(target:Entity,choice:Extract<StrategyChoice,{state:'cast'}>):void {
    if(this.pending||this.leg||!this.featureActionsSettled||!!this.ownMotion()||this.awaitsImplicitWalk()||this.loadout.blocked)return;
    const fresh=this.strategyChoice(target);
    if(fresh.state!=='cast'||fresh.rule.id!==choice.rule.id||fresh.identity.world!==choice.identity.world||fresh.identity.incarnation!==choice.identity.incarnation||!this.eligible(target,this.now(),false))return;
    if(!this.navigation()?.canCast(cell(this.player!),cell(target),fresh.profile.range))return;
    const action:ExpandedAction={type:'skill',mode:'target',skillId:fresh.rule.skillId,level:fresh.profile.level,target:target.id};
    this.strategies.dispatched(fresh,this.automation.result.sequence+1,this.now());
    this.route=null;this.leg=null;
    this.automation.submit(action,this.character,undefined,fresh.profile.afterCastSeconds);this.lastAction=this.now();this.reason=this.automation.task().label;
  }
  private pursue(type: 'attack' | 'pickup', id: number, destination: Position, cells: Position[]): void {
    // Finish an outstanding leg before changing destination; its reply has no request ID.
    this.route = { type, id, destination, cells, since: null, ...(type === 'attack' ? { engagement:engagementIdentity(id,this.observations.context(id)),attackRange: normalAttackProfile(this.character).range } : {}) };
    const target = type === 'attack' ? this.entities.get(id)?.name ?? 'monster' : 'loot';
    this.reason = `Selected ${target}; finishing the current walk before approaching.`;
  }
  private act(type: 'attack' | 'pickup', id: number, direct = false): void {
    if (type === 'attack' && !this.engagementAllowed(id)) { this.cancelPartyEngagement(id); return; }
    const actorIdentity=this.actorActionIdentity(type==='attack'?id:undefined);
    if(!actorIdentity){this.reason='Waiting for the current action actor lifetime to be observed.';return;}
    const approachStarted = this.route?.since ?? this.now();
    this.route = null; this.leg = null;
    if(type==='attack'&&this.player){const failure=this.loadout.attackGuard(automationSettings(this.settings),this.player,this.character);if(failure){this.stop(failure);return;}if(automationSettings(this.settings).loadout.enabled)this.loadout.attackDispatched();}
    const engagement=type==='attack'?engagementIdentity(id,this.observations.context(id)):null;
    if(type==='attack'&&!this.manualTask)this.strategies.normalDispatched(engagement);
    if(type==='attack'&&this.manualTask){this.manualTask.attackSent=true;this.manualStatus.state=direct?'approaching':'attacking';}
    this.send({ type, id }); this.lastAction = this.now();
    this.pending = { type, id, since: this.now(), progress: this.now(), approachSince: direct ? approachStarted : null, direct,
      actorIdentity,...(type === 'attack' ? { engagement,attackRange: normalAttackProfile(this.character).range } : {dropIdentity:{...this.drops.get(id)!}}) };
    if(type==='attack'&&!this.manualTask&&retreatSettings(this.settings).enabled){const entry=this.retreatLedger.dispatch(actorIdentity,this.now());if(entry){this.pending.since=entry.since;this.pending.progress=entry.progress;}}
    if (direct) this.implicitWalk = {targetId:id,until:this.now()+4000};
    this.reason = type === 'attack' ? `Attacking ${this.entities.get(id)?.name ?? 'selected monster'}.` : `Collecting item #${this.drops.get(id)?.itemId}.`;
    if (type === 'attack') this.attacks++;
    this.note(this.reason);
  }
  private interrupted(id: number): void {
    if (id === this.playerId) { this.leg = null; if (this.route) this.route.cells = []; }
  }
  private selfOwnerCurrent(identity:ActionIdentity|null|undefined):boolean {
    return !!identity&&sameActionIdentity({world:identity.world,selfId:identity.selfId,selfIncarnation:identity.selfIncarnation},this.actorActionIdentity());
  }
  /** A replacement spawn is a new lifetime, even without a preceding removal. */
  private replaceActorOwnership(id:number):void {
    this.retreatLedger.remove(id);
    const own=id===this.playerId;
    if(own){this.clearLootEvidence();this.aggressors.clear();}
    else for(const evidence of this.dropCreatedAt.values())evidence.engagements=evidence.engagements.filter(identity=>identity.targetId!==id);
    const pending=!!this.pending&&(own||this.pending.type==='attack'&&this.pending.id===id);
    const route=!!this.route&&(own||['attack','skill'].includes(this.route.type)&&this.route.id===id);
    if(pending||route) {
      const stopping=this.pending?.type==='attack'&&pending||route&&!!this.leg||own&&!!this.ownMotion();
      if(stopping) {
        // A late Attack for a reused ID cannot acknowledge this cancellation.
        if(this.implicitWalk)this.implicitWalk.targetId=null;
        else this.implicitWalk={targetId:null,until:this.now()+4000};
        if(this.connected){this.send({type:'stop'});this.lastAction=this.now();}
      }
      if(pending)this.pending=null;
      if(route){this.route=null;this.leg=null;}
      this.reason='Actor lifetime changed; waiting to select a current eligible target.';
    }
    if(own){this.skillKills.clear();this.skillTargets.clear();}
    else {this.skillKills.delete(id);this.skillTargets.delete(id);}
    this.combatConditions.delete(id);this.foreignTargets.delete(id); this.partyEngagements.remove(id);this.aggressors.delete(id);this.excluded.delete(id);
  }
  private cancelRoute(): void {
    this.fenceUnacknowledgedLeg();
    if (this.leg && (this.running||this.manualTask)) { this.send({ type: 'stop' }); this.lastAction = this.now(); }
    this.leg = null; this.route = null;
  }
  private fenceUnacknowledgedLeg(): void {
    // Attack replies have no request identity and cannot confirm an explicit
    // Walk. Only a direct monster-click approach owns an attack-matchable fence.
    if(this.leg?.acceptedUntil===null)this.implicitWalk??={targetId:null,until:this.now()+4000};
  }
  private advanceMovement(): void {
    const now = this.now();
    for (const [id, motion] of this.motions) {
      const entity = this.entities.get(id) ?? this.actors.get(id);
      if (entity) Object.assign(entity, walkPosition(motion.walk, now - motion.at));
      if (!entity || now - motion.at >= walkDuration(motion.walk)) this.motions.delete(id);
    }
  }
  private failRoute(): void {
    if(this.manualTask){this.finishManual('failed','Manual walking leg did not receive a verified completion.');return;}
    if (!this.route) return;
    if(this.route.type==='skill'||this.route.type==='attack'&&this.defending(this.route.id!))this.fenceUnacknowledgedLeg();
    if (this.leg) this.navigator?.temporaryBlocked(this.leg.destination, this.now() + 30000);
    this.leg = null; this.route.cells = []; this.routeFailures++;
    this.routeStep = Math.max(1, Math.floor(this.routeStep / 2)); this.lastAction = this.now();
    if (this.routeFailures >= 3) { this.stop('Stopped after three failed walks. Reposition before restarting.'); return; }
    this.send({ type: 'stop' }); this.reason = 'Walk did not complete; replanning with shorter steps.'; this.note(this.reason);
  }
  private routeTick(p: Entity, now: number, settleOnly = false): void {
    const route = this.route;
    const nav = this.navigation();
    if (!route || !nav) return;
    if(!this.fieldContains(route.destination)){this.cancelRoute();this.reason='Destination left the configured field lock area.';return;}
    const navigationTask = !['attack','skill','pickup'].includes(route.type);
    const limit = navigationTask ? this.settings.route_randomWalk_maxRouteTime : this.settings.attackMaxRouteTime;
    if (route.since !== null && now - route.since >= limit * 1000) {
      if(this.manualTask){this.finishManual('failed',`Manual approach exceeded its ${limit}s limit.`);return;}
      if (route.id !== undefined) this.excluded.set(route.id, now + 30000);
      const target = route.type === 'attack'||route.type==='skill' ? this.entities.get(route.id!)?.name ?? 'monster' : 'loot';
      this.cancelRoute();
      this.reason = route.type === 'search' ? 'Search route time limit reached; choosing another goal.'
        : `Approach time limit (${limit}s) reached for ${target}; skipping it for 30 seconds.`;
      this.note(this.reason); return;
    }
    const motion = this.ownMotion();
    if (!this.leg && motion) {
      if (motion.walk.cells.length > 21 || !nav.validRoute(motion.walk.cells)) { this.stop('Existing movement crossed blocked cells or a portal exclusion.'); return; }
      this.leg = { destination: motion.walk.cells.at(-1)!, cells: motion.walk.cells,
        since: motion.at, acceptedUntil: motion.at + walkDuration(motion.walk) + 100 };
    }
    if (this.leg) {
      if (this.leg.acceptedUntil !== null && now >= this.leg.acceptedUntil) {
        if (distance(p, this.leg.destination) !== 0) { this.failRoute(); return; }
        this.leg = null; this.routeFailures = 0; this.routeStep = this.settings.route_step;
      } else {
        if (now - this.leg.since > 19000 || (this.leg.acceptedUntil === null && now - this.leg.since > 4000)) this.failRoute();
        return;
      }
    }
    if(settleOnly||!this.observedOwnCastSettled())return;
    if(route.type==='skill') {
      const target=this.entities.get(route.id!);
      if(!target||!this.eligible(target,now,false)){this.cancelRoute();return;}
      const strategy=this.strategyChoice(target);
      if(strategy.state!=='cast'){route.cells=[];this.reason=strategy.state==='wait'?strategy.reason:'Attack strategy no longer selected.';return;}
      if(distance(cell(target),route.destination)!==0||route.attackRange!==strategy.profile.range){route.destination=cell(target);route.attackRange=strategy.profile.range;route.cells=[];}
      route.strategy=strategy;
      if(now-this.lastAction>=ACTION_DELAY&&nav.canCast(cell(p),cell(target),strategy.profile.range)){this.dispatchStrategy(target,strategy);return;}
    }
    const attackRange = normalAttackProfile(this.character).range;
    if (route.type === 'attack' && route.attackRange !== attackRange) {
      route.attackRange = attackRange; route.cells = [];
    }
    // A normal monster click lets the server own both approach and attack. Never
    // replace an unresolved leg; only skip our walk when its corridor is verified.
    if (route.type === 'attack' && now - this.lastAction >= ACTION_DELAY
      && (nav.canAttack(cell(p), route.destination, attackRange)
        || (Math.max(0, distance(cell(p), route.destination) - 1) <= this.settings.attackRouteMaxPathDistance
          && nav.clearWalkCorridor(cell(p), route.destination)))) {
      this.act('attack', route.id!, !nav.canAttack(cell(p), route.destination, attackRange)); return;
    }
    if(route.type==='follow'&&automationSettings(this.settings).follow.mode==='partyLeader'&&route.followIdentity!==JSON.stringify(this.partyFollowBinding?.()??null)){this.cancelRoute();return;}
    const range = route.type === 'follow' ? automationSettings(this.settings).follow.distance : navigationTask ? 0 : 1;
    const index = route.cells.findIndex(c => distance(c, p) === 0);
    if (index >= 0) route.cells = route.cells.slice(index);
    else route.cells = [];
    if (!route.cells.length) route.cells = (navigationTask
      ? nav.plan(p, route.destination, { range, avoidWalls: this.settings.route_avoidWalls })
      : route.type === 'attack' ? this.planAttack(p, route.destination) : route.type==='skill'?this.plan(p,route.destination,route.strategy!.profile.range,'cast'):this.plan(p, route.destination, range)) ?? [];
    if (!route.cells.length) {
      if(this.manualTask){this.finishManual('failed','Manual destination became unreachable.');return;}
      if (route.id !== undefined) this.excluded.set(route.id, now + 30000);
      this.cancelRoute(); this.reason = 'Destination is unreachable; choosing another goal.'; return;
    }
    if (route.cells.length === 1) {
      if(route.type==='skill'){const target=this.entities.get(route.id!);if(target&&route.strategy)this.dispatchStrategy(target,route.strategy);return;}
      if (route.type === 'attack' || route.type === 'pickup') this.act(route.type, route.id!);
      else { if(route.type==='waypoint')this.waypointIndex++; this.route = null; this.reason = `${route.type} destination reached.`; }
      return;
    }
    if (now - this.lastAction < ACTION_DELAY) return;
    const cells = routeSegment(route.cells, Math.min(this.routeStep, 20));
    const destination = cells.at(-1)!;
    // Only time this task's own movement. An inherited search/stop leg has a
    // separate acceptance deadline and must not consume the pursuit budget.
    route.since ??= now;
    this.leg = { destination, cells, since: now, acceptedUntil: null };
    this.send({ type: 'walk', destination }); this.lastAction = now;
    this.reason = `${route.type === 'search' ? 'Searching' : route.type === 'attack'||route.type==='skill' ? 'Approaching monster' : 'Approaching loot'} · walking to ${destination.x}, ${destination.y}.`;
  }
  /** Capture finite budgets at explicit Start without admitting field actions. */
  prepareRequestedRun(input:Settings):void {
    if(this.running||this.manualTargetOwned||this.automation.pendingAction)throw new Error('Stop the current run and wait for its action before requesting another.');
    this.settings=validateSettings(input);
    this.clearLootEvidence();
    // Entry travel is part of the requested run, including deaths and elapsed time.
    // This does not release movement/resource fences or authorize field actions.
    this.deaths=0;this.runStarted=this.now();this.runKills=this.kills;this.runPickups=this.looted;this.waypointIndex=0;
  }
  /** Freeze decisions without resetting an admitted resource or movement receipt. */
  prepareUpdate():void {if(!this.updateSuspended){this.updateWasRunning=this.running;this.updatePending=this.pending?{...this.pending,...(this.pending.type==='attack'?{entity:this.entities.get(this.pending.id)}:{})}:null;this.updateSuspended=true;}}
  settleUpdate():void {
    this.advanceMovement();
    if(!this.updateSuspended||this.updatePending||this.manualTargetOwned||this.retreatOwned||this.pending||this.leg||this.automation.busy
      ||this.awaitsImplicitWalk()||this.ownMotion()||!this.observedOwnCastSettled()||!this.loadout.equipmentSettled)return;
    this.route=null;this.running=false;
  }
  cancelUpdate():void {
    if(!this.updateSuspended)return;
    this.updateSuspended=false;
    if(this.updateWasRunning&&this.connected&&this.compatible&&!this.running){this.running=true;this.lastTick=this.now();}
    this.updateWasRunning=false;this.updatePending=null;
  }
  restoreRequestedRun(input:Settings,run:{startedAt:number;kills:number;pickups:number;deaths:number}):void {
    this.prepareRequestedRun(input);
    this.runStarted=run.startedAt;this.runKills=this.kills-run.kills;this.runPickups=this.looted-run.pickups;this.deaths=run.deaths;
  }
  /** Resume an already requested run without resetting its finite budgets. */
  resumeRequested(input: Settings = this.settings): void {
    if (this.running || !this.idleForActions()) throw new Error('Wait for movement and actions to finish.');
    const previous = { deaths: this.deaths, started: this.runStarted, kills: this.runKills,
      pickups: this.runPickups, waypoint: this.waypointIndex };
    this.start(input, true);
    this.deaths = previous.deaths;
    if(previous.started){this.runStarted = previous.started;this.runKills = previous.kills;this.runPickups = previous.pickups;this.waypointIndex = previous.waypoint;}
    this.reason = 'Resumed the requested run.'; this.note(this.reason);
  }
  resumeAfterReturn(input: Settings = this.settings): void {
    if(!this.runIntent||this.running||!automationSettings(this.settings).travel.returnToLockMap)throw new Error('No automatic return is authorized. Press Start explicitly.');
    if(input.map!==this.settings.map||this.map!==this.settings.map)throw new Error('Return has not reached the original lock map.');
    this.resumeRequested(input);
    this.reason='Returned to the lock map; resumed the requested run.';this.note(this.reason);
  }
  private onDeath(): void {
    this.clearLootEvidence();
    this.aggressors.clear();
    this.strategies.cancel();
    this.skillKills.clear();this.skillTargets.clear();
    this.implicitWalk = null; this.loadout.reset(true);
    this.deaths++;
    const a=automationSettings(this.settings);
    if(this.running&&a.respawn.enabled&&this.deaths<=a.respawn.maxDeaths) {
      this.pending=null;this.route=null;this.leg=null;this.automation.reset();this.reason='Character died; automatic respawn is enabled.';this.note(this.reason);
    } else this.stop(a.respawn.enabled&&this.deaths>a.respawn.maxDeaths
      ?`Death limit reached. ${deathLimitGuidance(this.deaths,a.respawn.maxDeaths)}`
      :a.respawn.enabled?'Character died. Waiting for revival.':'Character died. Recover manually before restarting.');
  }
  acknowledgeLoadoutOverride():void {this.loadout.acknowledgeOverride();}
  get pendingFeatureAction(): ExpandedAction | null { return this.automation.pendingAction; }
  /** Emergency escape may preempt walking/combat, but never an unresolved resource or cast. */
  get featureActionsSettled(): boolean { return !this.retreatOwned&&this.resourceActionsSettled; }
  /** Escape may request cancellation first, then await the physical owner. */
  get resourceActionsSettled(): boolean {return !this.partySupport?.busy()&&!this.automation.busy&&this.loadout.equipmentSettled;}
  get actionResult(): ActionResult { return {...this.automation.result}; }
  private retreatOwnCurrent():boolean {
    const owner=this.retreatTask?.identity;
    return !!owner&&sameActionIdentity({world:owner.world,selfId:owner.selfId,selfIncarnation:owner.selfIncarnation},this.actorActionIdentity());
  }
  private prepareUnsentRetreatArrival(map:string,entry:1|2):void {
    const task=this.retreatTask,p=this.player;
    if(!task)return;
    if(task.unsentArrival){delete task.unsentRemoval;delete task.unsentArrival;return;}
    // ClearTarget may arrive after own removal. It binds only to captured
    // old-life evidence, never to a fabricated actor or a later own lifetime.
    const removal=this.unsentRetreatRemovalCurrent()?task.unsentRemoval:null;
    if(removal?.reason===1&&entry!==2){delete task.unsentRemoval;return;}
    if(task.cleared&&!task.walkSent&&!task.walkPending&&!this.leg&&!this.ownMotion()&&!this.implicitWalk
      &&(removal||p?.kind===0&&!p.dead&&p.hp>0&&this.retreatOwnCurrent()))
      task.unsentArrival={id:removal?.id??p!.id,name:removal?.name??p!.name,map,entry};
  }
  private unsentRetreatRemovalCurrent():boolean {
    const task=this.retreatTask,removal=task?.unsentRemoval;
    return !!task&&!!removal&&!task.unsentArrival&&!this.player&&this.playerId===removal.id&&this.map===removal.map
      &&this.observations.context().world===removal.world&&task.identity.world===removal.world
      &&task.identity.selfId===removal.id&&task.identity.selfIncarnation===removal.incarnation;
  }
  retreatMovementReceiptOwner(event:GameEvent):EngagementIdentity|null {
    const owner=this.retreatTask?.identity;if(!owner||!this.retreatOwnCurrent())return null;
    if(event.type==='stop'&&event.id===owner.selfId)return {world:owner.world,id:owner.selfId,incarnation:owner.selfIncarnation};
    if(event.type==='walk'&&event.id===owner.selfId&&!event.walk.locked&&event.walk.cells.length<=21&&walkDuration(event.walk)<=15000&&this.navigation()?.validRoute(event.walk.cells))return {world:owner.world,id:owner.selfId,incarnation:owner.selfIncarnation};
    return null;
  }
  get retreatOwned():boolean {this.advanceMovement();this.retreatSettlement();return !!this.retreatTask;}
  private retreatSettlement():void {
    const task=this.retreatTask;if(!task)return;
    const now=this.now();
    if(task.phase!=='cancelled'&&(now-task.entry.since>=90000||now-task.entry.progress>=12000||task.movementSince!==null&&now-task.movementSince>=this.settings.attackMaxRouteTime*1000))this.cancelRetreat('Retreat or original engagement deadline reached; skipping this actor for 30 seconds.');
    if(this.leg?.acceptedUntil!==null&&this.leg?.acceptedUntil!==undefined&&now>=this.leg.acceptedUntil&&!this.ownMotion()){
      if(!this.player||distance(this.player,this.leg.destination)!==0)this.cancelRetreat('Retreat movement did not reach its accepted endpoint.');
      else this.leg=null;
    }
    if(task.phase==='cancelled'&&this.retreatOwnCurrent()&&task.cleared&&!task.walkPending&&!this.leg&&!this.ownMotion()&&!this.awaitsImplicitWalk())this.retreatTask=null;
  }
  private cancelRetreat(reason:string,sendStop=true):void {
    const task=this.retreatTask;if(!task)return;
    if(task.phase==='cancelled')return;
    task.phase='cancelled';task.reason=reason;
    this.fenceUnacknowledgedLeg();this.leg=null;this.route=null;this.pending=null;
    this.excluded.set(task.identity.targetId!,this.now()+30000);
    this.retreatStatus={state:'skipped',reason,targetId:task.identity.targetId!,attempts:task.entry.attempts,destination:{...task.destination},settling:true};
    this.reason=reason;this.note(reason);
    if(sendStop&&this.connected&&this.retreatOwnCurrent()&&this.observedOwnCastSettled()){this.loadout.requestStop(reason);this.send({type:'stop'});this.lastAction=this.now();}
  }
  private beginRetreat(now:number):boolean {
    const policy=retreatSettings(this.settings),pending=this.pending,p=this.player;
    if(!policy.enabled||!pending||pending.type!=='attack'||!pending.actorIdentity||!p||this.manualTargetOwned||!this.featureActionsSettled)return false;
    const entry=this.retreatLedger.get(pending.actorIdentity),target=this.entities.get(pending.id),profile=normalAttackProfile(this.character);
    if(!entry?.accepted||!target||!sameActionIdentity(entry.identity,this.actorActionIdentity(target.id)))return false;
    if(profile.sourceRange===null||profile.range<=1||policy.desiredDistance>profile.range){this.retreatStatus={...IDLE_RETREAT,state:'watching',reason:'Retreat unavailable: desired distance needs a verified ranged normal profile.',targetId:target.id};return false;}
    if(attackDistance(cell(p),cell(target))>policy.triggerDistance)return false;
    const failure=manualAmmoGuard({minAmmoStock:automationSettings(this.settings).loadout.minAmmoStock},p,this.character);
    const nav=this.navigation(),plan=nav&&!failure&&entry.attempts<policy.maxAttempts&&now-entry.since<90000&&now-entry.progress<12000?planRetreat(nav,cell(p),cell(target),profile.range,policy):null;
    const reason=failure??(entry.attempts>=policy.maxAttempts?'Retreat allowance exhausted.':!plan?'No reachable retreat firing tile within the bounded search.':'Waiting for authoritative target clear and movement before retreat.');
    this.retreatTask={identity:{...entry.identity},entry,targetPosition:cell(target),destination:plan?.destination??cell(p),cells:plan?.cells??[],phase:'stopping',cleared:false,walkPending:false,walkSent:false,stopRetried:false,steps:0,since:now,movementSince:null,reason};
    this.pending=null;this.route=null;this.retreatStatus={state:'stopping',reason,targetId:target.id,attempts:entry.attempts,destination:plan?.destination??null,settling:false};
    this.loadout.requestStop(reason);this.send({type:'stop'});this.lastAction=now;this.reason=reason;
    if(!plan)this.cancelRetreat(reason+' Skipping this actor for 30 seconds.',false);
    return true;
  }
  private tickRetreat(now:number,dispatch:boolean):void {
    this.retreatSettlement();const task=this.retreatTask;if(!task)return;
    this.reason=task.reason;if(task.phase==='cancelled')return;
    const p=this.player,target=this.entities.get(task.identity.targetId!),policy=retreatSettings(this.settings),profile=normalAttackProfile(this.character),nav=this.navigation();
    if(!p||!target||!sameActionIdentity(task.identity,this.actorActionIdentity(target.id))||!this.eligible(target,now,false)||!nav?.safe(p)||!policy.enabled||profile.sourceRange===null||profile.range<=1||policy.desiredDistance>profile.range){this.cancelRetreat('Retreat target, field or verified range changed.');return;}
    const blocker=manualStateBlocker('attack',{owner:{world:task.identity.world,id:task.identity.selfId,incarnation:task.identity.selfIncarnation},character:this.character,observedOwnCastSettled:this.observedOwnCastSettled(),observations:this.actorObservation()});
    if(blocker){this.cancelRetreat(blocker);return;}
    const ammo=manualAmmoGuard({minAmmoStock:automationSettings(this.settings).loadout.minAmmoStock},p,this.character);
    if(ammo){this.cancelRetreat(ammo);return;}
    if(task.walkPending&&this.leg&&now-this.leg.since>4000){this.cancelRetreat('Retreat Walk was not acknowledged; no retry will be sent.');return;}
    if(this.leg){if(this.leg.acceptedUntil===null||now<this.leg.acceptedUntil)return;if(distance(p,this.leg.destination)!==0){this.cancelRetreat('Retreat movement did not reach its accepted endpoint.');return;}this.leg=null;}
    if(!task.cleared||this.ownMotion()||this.awaitsImplicitWalk()||!dispatch||this.automation.busy||!this.loadout.equipmentSettled||now-this.lastAction<ACTION_DELAY)return;
    if(task.walkSent&&attackDistance(cell(p),cell(target))>=policy.desiredDistance&&nav.canAttack(cell(p),cell(target),profile.range)){
      this.retreatTask=null;this.retreatStatus={state:'resumed',reason:'Retreat movement settled; resuming the same normal target.',targetId:target.id,attempts:task.entry.attempts,destination:cell(p),settling:false};
      this.act('attack',target.id,false);return;
    }
    const remaining=policy.maxPathSteps-task.steps;
    if(remaining<=0){this.cancelRetreat('Retreat path allowance exhausted; skipping this actor for 30 seconds.');return;}
    if(distance(cell(target),task.targetPosition)!==0||!task.cells.some(c=>distance(c,p)===0)||!nav.canAttack(task.destination,cell(target),profile.range)){
      const plan=planRetreat(nav,cell(p),cell(target),profile.range,policy,remaining);
      if(!plan){this.cancelRetreat('No current retreat firing tile within the remaining path allowance.');return;}
      task.cells=plan.cells;task.destination=plan.destination;task.targetPosition=cell(target);
    }
    const index=task.cells.findIndex(c=>distance(c,p)===0),cells=routeSegment(task.cells.slice(index),Math.min(this.settings.route_step,remaining,20));
    if(cells.length<2||!nav.validRoute(cells)){this.cancelRetreat('Retreat route is no longer valid.');return;}
    if(!task.walkSent){if(task.entry.attempts>=policy.maxAttempts){this.cancelRetreat('Retreat allowance exhausted.');return;}task.entry.attempts++;}
    task.walkSent=true;task.walkPending=true;task.steps+=cells.length-1;task.movementSince??=now;task.phase='walking';
    const destination={...cells.at(-1)!};this.leg={destination,cells,since:now,acceptedUntil:null};
    task.reason=`Retreating from only monster #${target.id} · walking to ${destination.x}, ${destination.y}.`;
    this.retreatStatus={state:'walking',reason:task.reason,targetId:target.id,attempts:task.entry.attempts,destination,settling:false};
    this.send({type:'walk',destination});this.lastAction=now;this.reason=task.reason;
  }
  get manualTargetActive():boolean {return this.manualTask!==null;}
  /** A shortened field walk is authoritative only for its captured own lifetime and verified ground. */
  fieldMovementReceiptOwner(event:GameEvent,captured:ActionIdentity|null):EngagementIdentity|null {
    if(!captured||!sameActionIdentity(captured,this.actorActionIdentity()))return null;
    const owner={world:captured.world,id:captured.selfId,incarnation:captured.selfIncarnation};
    if(event.type==='stop'&&event.id===owner.id)return owner;
    if(event.type==='walk'&&event.id===owner.id&&!event.walk.locked&&event.walk.cells.length>0&&event.walk.cells.length<=21
      &&walkDuration(event.walk)<=15000&&this.navigation()?.validRoute(event.walk.cells))return owner;
    return null;
  }
  /** Movement readback can settle only the captured manual owner's lifetime. */
  manualMovementReceiptOwner(event:GameEvent):EngagementIdentity|null {
    const owner=this.manualTask?.request.owner??this.manualReceiptOwner;
    if(!owner||!sameManualIdentity(owner,this.player?this.manualActorIdentity(this.player.id):null))return null;
    if(event.type==='stop'&&event.id===owner.id)return {...owner};
    if(event.type==='walk'&&event.id===owner.id&&!event.walk.locked&&event.walk.cells.length<=21
      &&walkDuration(event.walk)<=15000&&this.navigation()?.validRoute(event.walk.cells))return {...owner};
    return null;
  }
  private manualReceiptCurrent():boolean {return !!this.manualReceiptOwner&&sameManualIdentity(this.manualReceiptOwner,this.player?this.manualActorIdentity(this.player.id):null);}
  private manualReceiptAdmitted():boolean {return !this.manualReceiptOwner||this.manualReceiptCurrent();}
  get manualTargetOwned():boolean {
    this.advanceMovement();
    const moving=this.manualRetiredMovement&&(!!this.ownMotion()||this.awaitsImplicitWalk());
    if(!moving)this.manualRetiredMovement=false;
    const changedOwn=!!this.manualReceiptOwner&&!this.manualReceiptCurrent();
    const owned=!!this.manualTask||!!this.manualAttackFence||this.manualWalkFence||moving||changedOwn;
    if(!owned)this.manualReceiptOwner=null;
    return owned;
  }
  /** Actual visible lifetime, rather than a name or reusable entity ID. */
  manualActorIdentity(id:number):EngagementIdentity|null {
    const actor=this.entities.get(id)??this.actors.get(id),binding=this.actorActionIdentity(id);
    return actor&&!actor.dead&&actor.hp>0&&binding?{world:binding.world,id,incarnation:binding.targetIncarnation!}:null;
  }
  private manualContext(request:ManualTargetRequest) {
    const targetId=request.command.type==='attack'?request.command.target.id:null;
    return {map:this.map,player:this.player??null,owner:this.player?this.manualActorIdentity(this.player.id):null,
      target:targetId===null?null:this.entities.get(targetId)??null,targetIdentity:targetId===null?null:this.manualActorIdentity(targetId),
      character:this.character,observedOwnCastSettled:this.observedOwnCastSettled(),observations:this.actorObservation(flatMap(request.policy.monsterRules, rule=>rule.conditions??[]),null,targetId),foreignTarget:targetId!==null&&this.foreignTargets.has(targetId)};
  }
  previewManual(input:unknown):Position[] {
    const request=validateManualTargetRequest(input);
    if(!this.connected||!this.compatible||this.now()-this.lastFrame>15000)throw new Error('A fresh verified game connection is required.');
    if(!this.idleForActions())throw new Error('Stop other owners and wait for movement and Stop confirmation.');
    return previewManualTarget(request,this.manualContext(request),this.gridFor);
  }
  startManual(input:unknown):void {
    const request=validateManualTargetRequest(input),cells=this.previewManual(request),since=this.now();
    this.settings=manualEngineSettings(request,request.command.type==='attack'?this.entities.get(request.command.target.id)!.classId:null);
    this.navigation();this.routeStep=request.policy.routeStep;
    this.runIntent=false;this.lastTick=since;this.lastAction=0;this.routeFailures=0;
    this.manualTask={request,since,attackSent:false,attackObserved:false,acceptedAttack:false,acceptedWalk:false};
    this.manualStatus={sequence:this.manualStatus.sequence+1,kind:request.command.type,state:request.command.type==='walk'?'walking':'approaching',active:true,settling:false,reason:'Manual command admitted; waiting for verified execution.',map:request.map,goal:request.command.type==='walk'?{...request.command.destination}:cell(this.entities.get(request.command.target.id)!),target:request.command.type==='attack'?{...request.command.target}:null,elapsedSeconds:0,remainingSeconds:request.timeoutSeconds};
    if(request.command.type==='attack')this.pursue('attack',request.command.target.id,this.manualStatus.goal!,cells);
    else if(cells.length===1){this.finishManual('complete','Character is already at the verified destination.',false);return;}
    else this.route={type:'travel',destination:{...request.command.destination},cells,since:null};
    this.reason=this.manualStatus.reason;this.note(this.reason);
  }
  private finishManual(state:'complete'|'failed'|'cancelled',reason:string,sendStop=true):void {
    const task=this.manualTask;if(!task)return;
    this.manualRetiredMovement=!!this.leg||!!this.ownMotion()||this.awaitsImplicitWalk();
    if(this.leg?.acceptedUntil===null)this.manualWalkFence=true;
    this.fenceUnacknowledgedLeg();
    if(task.attackSent&&task.request.command.type==='attack')this.manualAttackFence={world:task.request.owner.world,target:{...task.request.command.target},accepted:task.acceptedAttack,stopRetried:false};
    if(this.manualRetiredMovement||this.manualWalkFence||this.manualAttackFence)this.manualReceiptOwner={...task.request.owner};
    this.manualTask=null;this.pending=null;this.route=null;this.leg=null;this.runIntent=false;
    this.manualStatus={...this.manualStatus,state,active:false,reason,elapsedSeconds:Math.max(0,(this.now()-task.since)/1000),remainingSeconds:0};
    this.reason=reason;this.note(reason);
    if(sendStop&&this.connected){this.loadout.requestStop(reason);this.send({type:'stop'});this.lastAction=this.now();}
  }
  private acceptManualAttack(id:number):void {
    const task=this.manualTask;
    if(task?.attackSent&&task.request.command.type==='attack'&&task.request.command.target.id===id&&sameManualIdentity(task.request.command.target,this.manualActorIdentity(id)))task.acceptedAttack=true;
    const fence=this.manualAttackFence;
    if(!fence||!this.manualReceiptCurrent()||fence.target.id!==id||!sameManualIdentity(fence.target,this.manualActorIdentity(id)))return;
    if(!fence.accepted&&!fence.stopRetried){fence.accepted=true;fence.stopRetried=true;this.loadout.requestStop('Late canceled attack accepted; reconciling Stop.');if(this.connected)this.send({type:'stop'});}
  }
  private tickManual(now:number,dispatchDecisions=true):void {
    const task=this.manualTask;if(!task)return;
    const request=task.request,p=this.player;
    this.manualStatus.elapsedSeconds=Math.max(0,(now-task.since)/1000);
    this.manualStatus.remainingSeconds=Math.max(0,request.timeoutSeconds-this.manualStatus.elapsedSeconds);
    if(now-this.lastTick>5000){this.finishManual('failed','Manual command ended after the Mac or game paused.');return;}
    this.lastTick=now;
    if(!this.connected||!this.compatible||now-this.lastFrame>15000||request.map!==this.map||!sameManualIdentity(request.owner,this.player?this.manualActorIdentity(this.player.id):null)){this.finishManual('failed','Manual command lost its fresh character or world.');return;}
    if(now-task.since>=request.timeoutSeconds*1000){this.finishManual('failed','Manual command deadline reached; waiting for Stop reconciliation.');return;}
    if(!p||p.dead||p.hp<=0||p.maxHp<=0||p.hp/p.maxHp*100<=request.policy.minHpPercent){this.finishManual('failed','Character reached the manual HP stop limit.');return;}
    // A cast waits at dispatch without canceling this already admitted finite task.
    const blocker=manualStateBlocker(request.command.type,this.manualContext(request),false);if(blocker){this.finishManual('failed',blocker);return;}
    const nav=this.navigation();if(!nav||!nav.safe(p)){this.finishManual('failed','Character left verified manual movement ground.');return;}
    if(request.command.type==='attack'){
      const target=this.entities.get(request.command.target.id);
      if(!sameManualIdentity(request.command.target,this.manualActorIdentity(request.command.target.id))||!target||!this.eligible(target,now,false)){
        this.finishManual('failed','Selected monster lifetime, area, level or engagement changed.');return;
      }
      const ammo=manualAmmoGuard(request.policy,p,this.character);if(ammo){this.finishManual('failed',ammo);return;}
      if(this.loadout.blocked){this.finishManual('failed',this.loadout.snapshot(automationSettings(this.settings),this.character).reason);return;}
      if(this.pending){
        const range=normalAttackProfile(this.character).range;
        if(this.pending.attackRange!==range||(!nav.canAttack(cell(p),cell(target),range)&&!nav.clearWalkCorridor(cell(p),cell(target)))||!this.planAttack(p,target)){
          this.finishManual('failed','Selected monster left the verified normal-attack approach.');return;
        }
        if(this.pending.approachSince!==null&&now-this.pending.approachSince>=request.policy.approachSeconds*1000||now-this.pending.progress>=12000){this.finishManual('failed','Selected monster attack or approach was not confirmed in time.');return;}
        this.reason=this.manualStatus.reason=task.attackObserved?'Attacking only the selected monster; Stop or its death ends this command.':'Waiting for the selected monster approach and attack.';return;
      }
      if(this.route&&distance(cell(target),this.route.destination)!==0){this.route.destination=cell(target);this.route.cells=[];}
    }
    if(this.awaitsImplicitWalk()||!!this.ownMotion()&&!this.leg)return;
    if(!this.observedOwnCastSettled())this.reason=OWN_CAST_WAIT_REASON;
    if(this.route){this.routeTick(p,now,!dispatchDecisions);if(this.manualTask)this.manualStatus.reason=this.reason;}
    if(this.manualTask&&!this.route&&!this.pending&&!this.leg){
      if(request.command.type==='walk'&&task.acceptedWalk&&!this.ownMotion()&&distance(cell(p),request.command.destination)===0)this.finishManual('complete','Verified walking destination reached.',false);
      else this.finishManual('failed','Manual route ended without a verified destination.');
    }
  }
  idleForActions(): boolean { this.advanceMovement(); return this.observedOwnCastSettled()&&!this.partySupport?.busy()&&!this.running&&!this.retreatOwned&&!this.manualTargetOwned&&!this.pending&&!this.leg&&!this.route&&!this.automation.busy&&!this.awaitsImplicitWalk()&&!this.ownMotion()&&!this.loadout.blocked; }
  /** Installation is gated by sent owners, not HP or an equipment policy fault. */
  settledForMaintenance(): boolean { this.advanceMovement(); return !this.updatePending&&this.observedOwnCastSettled()&&!this.partySupport?.busy()&&!this.running&&!this.retreatOwned&&!this.manualTargetOwned&&!this.pending&&!this.leg&&!this.route&&!this.automation.busy&&!this.awaitsImplicitWalk()&&!this.ownMotion()&&this.loadout.equipmentSettled; }
  /** Death recovery owns only the existing posture scheduler, never field decisions. */
  recoveryOnly(settings: Settings): { complete: boolean; reason: string } {
    const p=this.player,a=validateAutomation(automationSettings(settings));
    if(!p||p.dead||!this.actorActionIdentity())return {complete:false,reason:'Waiting for a ready living character before recovery.'};
    if(!this.idleForActions())return {complete:false,reason:'Waiting for the recovery posture and movement to settle.'};
    const next=this.automation.recover(a,p,this.character);
    if(next.failure)return {complete:false,reason:next.failure};
    if(next.action){this.automation.submit(next.action,this.character);return {complete:false,reason:this.automation.task().label};}
    return {complete:!this.automation.recovering,reason:this.automation.task().label};
  }
  manualWarpGroundAllowed(target:Position,range:number,policy:AutomationSettings=automationSettings(this.settings)):boolean {
    const settings={...this.settings,automation:policy};const p=this.player,nav=this.navigation(settings);
    return !!p&&!!nav&&mapAllowed(mapPolicy(settings),this.map)&&nav.safe(target)&&nav.canCast(cell(p),target,range)
      &&!(target.x===Math.floor(p.x)&&target.y===Math.floor(p.y))
      &&![...this.actors.values(),...this.entities.values()].some(actor=>actor.id!==p.id&&!actor.dead&&Math.floor(actor.x)===target.x&&Math.floor(actor.y)===target.y);
  }
  manualAction(action: ExpandedAction, reserved?: (sequence:number,identity:ActionIdentity)=>void): void {
    action=validateExpandedAction(action);
    if(!this.observedOwnCastSettled())throw new Error(OWN_CAST_WAIT_REASON);
    if(!this.idleForActions())throw new Error('Stop automation and wait for movement and action confirmation first.');
    const p=this.player;
    const blocker=manualActionBlocker(action,{connected:this.connected,compatible:this.compatible,player:p??null,
      inventoryKnown:this.character.inventoryKnown,inventory:this.character.inventory,skillsKnown:this.character.skillsKnown,
      learned:this.character.learned,stats:this.character.stats,entities:this.entities,actors:this.actors});
    if(blocker)throw new Error(blocker);
    if(!p)throw new Error('A verified character is required.');
    if(action.type==='skill') {
      const requestedLevel=action.level;
      if(this.character.skillLevel(domainSkillId(action.skillId))<requestedLevel)throw new Error('An active learned or granted skill is required.');
      action={...action,level:effectiveSkillLevel(domainSkillId(action.skillId),requestedLevel,this.character)};
      const skill=SKILL_CATALOG[action.skillId],cost=skillCost(action.skillId,action.level);
      if(!this.character.skillsKnown||this.character.skillLevel(domainSkillId(action.skillId))<action.level||!skill||skill.target===0||cost===null)throw new Error('An active learned or granted skill is required.');
      const supported=(AUTOMATIC_ATTACK_SKILLS as readonly number[]).includes(action.skillId)||action.skillId===MANUAL_GROUND_SKILL;
      const readiness=supported?castReadiness(action.skillId,action.level,this.character,this.actorObservation([...CAST_PREREQUISITES,BLIND_CONDITION])):null;
      if(readiness&&readiness.state!=='ready')throw new Error(readiness.reason);
      if(!supported&&(this.character.stats?.sp===undefined||this.character.stats.sp<cost))throw new Error('Insufficient verified SP.');
      if((action.mode==='self'&&![2,3,5].includes(skill.target))||(action.mode==='ground'&&skill.target!==4)||(action.mode==='target'&&![1,2,3].includes(skill.target)))throw new Error('Skill targeting does not match its catalog.');
      if (action.mode === 'target' || action.mode === 'ground') {
        const target = action.mode === 'target' ? this.entities.get(action.target) ?? this.actors.get(action.target) : action.position;
        if (!target) throw new Error('Target is not visible.');
        if(readiness?.state==='ready'&&action.mode==='target'){const actor=this.entities.get(action.target);if(actor?.kind!==1||actor.dead||actor.hp<=0)throw new Error('A supported bolt needs a living visible monster target.');}
        // Until every skill's deployed range is confirmed, allow only adjacent,
        // directly walkable targets so a manual command cannot start an unowned chase.
        if(readiness?.state==='ready'){if(!this.navigation()?.canCast(cell(p),cell(target),readiness.profile.range))throw new Error('Skill target is outside verified stationary range or line of sight.');}
        const path = readiness?.state==='ready'?null:this.navigation()?.plan(cell(p), cell(target), { maxDistance: 2, avoidWalls: false });
        if (!readiness && (distance(p, target) > 1 || !path || path.length > 2))
          throw new Error('Move next to the skill target on verified open ground first.');
      }
    }
    this.loadout.acknowledgeOverride();
    this.automation.submit(action,this.character,undefined,action.type==='skill'?skillAfterCastSeconds(action.skillId):0,
      reserved?{receipt:matchesSkillExecution,reserved}:undefined);this.reason=this.automation.task().label;
  }
  private followTick(p: Entity, now: number): void {
    const follow=automationSettings(this.settings).follow;
    const binding=follow.mode==='partyLeader'?this.partyFollowBinding?.():null;
    const actor=follow.mode==='partyLeader'?binding?this.actors.get(binding.entityId):undefined:[...this.actors.values()].find(e=>e.kind===0&&e.name===follow.name&&!e.dead);
    const identity=binding?JSON.stringify(binding):undefined;
    if(this.route?.type==='follow'&&this.route.followIdentity!==identity)this.cancelRoute();
    if(!actor) {
      this.followLostAt??=now;if(now-this.followLostAt>=follow.lostSeconds*1000)this.stop('Follow target is no longer visible.');
      else this.reason='Waiting for the named follow target.';return;
    }
    if(!this.fieldContains(actor)){if(this.route?.type==='follow')this.cancelRoute();this.reason='Follow target is outside the field lock area.';return;}
    this.followLostAt=null;
    if(distance(p,actor)<=follow.distance) {if(this.route?.type==='follow')this.cancelRoute();this.reason='Within follow distance.';return;}
    if(!this.route||this.route.type!=='follow')this.route={type:'follow',followIdentity:identity,id:actor.id,destination:cell(actor),cells:[],since:null};
    else if(distance(cell(actor),this.route.destination)!==0){this.route.destination=cell(actor);this.route.cells=[];}
    this.routeTick(p,now);
  }
  private waypointTick(p: Entity, now: number): void {
    const travel=automationSettings(this.settings).travel;
    if(this.waypointIndex>=travel.waypoints.length) {if(travel.loop)this.waypointIndex=0;else {this.reason='Waypoint route completed.';return;}}
    const waypoint=travel.waypoints[this.waypointIndex]!;
    if(!this.fieldContains(waypoint)){this.stop('Waypoint is outside the field lock area.');return;}
    if(waypoint.map!==this.map){this.stop('Next waypoint is on another map; use the travel workflow.');return;}
    if(!this.route||this.route.type!=='waypoint')this.route={type:'waypoint',destination:{x:waypoint.x,y:waypoint.y},cells:[],since:null};
    this.routeTick(p,now);
  }
  actorObservation(conditions:readonly ActorPredicate[]=[], targetId:number|null=this.currentTargetId,candidateId:number|null=null): ActorObservationSnapshot {
    return this.observations.snapshot(this.player?.id??null,targetId,this.connected&&this.compatible,conditions,false,candidateId);
  }
  get currentTargetId():number|null {
    return this.serverTargetId;
  }
  /** Macros may use only the engine's currently eligible observed combat target. */
  macroTargetIdentity():ActionIdentity|null {
    const id=this.currentTargetId,p=this.player,target=id===null?undefined:this.entities.get(id);
    return p&&!p.dead&&target&&this.eligible(target,this.now(),false)?this.actorActionIdentity(target.id):null;
  }
  /** A normal attack or an unsent route can be canceled after physical/resource owners drain. */
  macroHandoffSettled():boolean {
    this.advanceMovement();
    return this.observedOwnCastSettled()&&this.featureActionsSettled&&!this.manualTargetOwned&&!this.leg&&!this.ownMotion()
      &&!this.awaitsImplicitWalk()&&!this.loadout.blocked;
  }
  snapshot(): Snapshot {
    const nav = this.navigation();
    const chase = this.pending?.type === 'attack' ? this.entities.get(this.pending.id) : null;
    const chaseCells = chase ? this.ownMotion()?.walk.cells ?? [] : [];
    const navigation: NavigationStatus | null = nav ? {
      ...nav.summary(this.player ?? { x: -1, y: -1 }), ready: !!this.player && nav.safe(this.player),
      mode: this.automation.recovering ? 'recover' : this.route?.type ?? (chase ? 'attack' : 'idle'), goal: this.route?.destination ?? (chase ? cell(chase) : null),
      route: this.route?.cells.slice(0, 512) ?? chaseCells, leg: this.leg?.cells ?? chaseCells, routeLength: Math.max(0, (this.route?.cells.length ?? chaseCells.length) - 1),
    } : null;
    return {
      connected: this.connected, compatible: this.compatible, running: this.running, reason: this.reason,
      retreat:{...this.retreatStatus,state:!retreatSettings(this.settings).enabled&&!this.retreatTask?'off':this.retreatStatus.state,settling:!!this.retreatTask&&this.retreatTask.phase==='cancelled',reason:(this.retreatTask?.reason??this.retreatStatus.reason)+(this.retreatTask?.phase==='cancelled'?' Waiting for '+(!this.retreatOwnCurrent()?'a fresh connection after the own lifetime changed':this.retreatTask.walkPending?'authoritative Walk or Stop readback':!this.retreatTask.cleared?'authoritative target clear':'accepted movement to settle')+'; no retreat is retried.':''),destination:this.retreatStatus.destination?{...this.retreatStatus.destination}:null},
      manualTarget:{...this.manualStatus,settling:!this.manualTask&&this.manualTargetOwned,reason:this.manualStatus.reason+(!this.manualTask&&this.manualTargetOwned?' Waiting for authoritative '+(this.manualReceiptOwner&&!this.manualReceiptCurrent()?'fresh connection after the character lifetime changed':this.manualAttackFence?'attack acceptance and target clear':this.manualWalkFence?'Walk or Stop acknowledgment':'accepted movement to finish')+'; nothing is retried.':''),goal:this.manualStatus.goal?{...this.manualStatus.goal}:null,target:this.manualStatus.target?{...this.manualStatus.target}:null},
      partyEngagement:this.partyEngagements.snapshot(automationSettings(this.settings).combat.partyEngagement===true),
      map: this.map, player: this.player ? { ...this.player } : null,
      monsters: [...this.entities.values()].filter(e => e.kind === 1).slice(0,150),
      drops: [...this.drops.values()].slice(0,150), attacks: this.attacks, kills: this.kills,
      looted: this.looted, target: this.pending?.type === 'attack' ? this.entities.get(this.pending.id)?.name ?? '' : (this.route?.type === 'attack'||this.route?.type==='skill') ? this.entities.get(this.route.id!)?.name ?? '' : '',
      attackStrategies:automationSettings(this.settings).attackStrategies?.length?this.strategies.snapshot():{pending:false,entries:[],truncated:false},actorObservations:this.observations.snapshot(this.player?.id??null,this.currentTargetId,this.connected&&this.compatible),ruleConditions:publishConditionReports([...this.automation.ruleConditions,...this.combatConditions.values()]),
      log: this.log.slice(), navigation, loadout:this.loadout.snapshot(automationSettings(this.settings),this.character), character:this.character.snapshot(), actors:[...this.actors.values()].slice(0,100),
      task:this.automation.busy||this.automation.recovering?this.automation.task():{kind:this.pending?.type??this.route?.type??'idle',label:this.reason,pending:!!this.pending||!!this.leg,since:this.pending?.since??this.route?.since??null},
      elapsedSeconds:this.runStarted?Math.max(0,Math.floor(((this.running?this.now():this.stoppedAt)-this.runStarted)/1000)):0,deaths:this.deaths,runIntent:this.runIntent,lootStats:[...this.lootStats].slice(0,128).map(([itemId,count])=>({itemId,count})),actionResult:{...this.automation.result},
    };
  }
}

import { ActorObservations, type ActorObservationSnapshot, type ActorPredicate, type PredicateTrace, type PublishedConditionReport, evaluateActorPredicate, publishConditionReports } from './actor-observations';
import { type Drop, type Entity, type GameEvent, type Position, type Walk } from './protocol';

import { walkDuration, walkPosition } from './movement';
import { GridNavigator, routeSegment, searchGrid, distance, minimumRouteCost, type NavigationSummary, type WalkGrid } from './navigation';

import { automationSettings, DEFAULT_SETTINGS, validateSettings, type Settings } from './settings';
import { acceptsMonster, acceptsLoot, inSchedule, monsterRule, lootRule, effectiveSkillLevel, AutomationScheduler, type AutomationTask, type ActionResult } from './automation';
import { CharacterState, type CharacterSnapshot, type StatefulEntity } from './character-state';
import { validateExpandedAction, type ExpandedAction, type FeatureEvent } from './protocol-feature';
import { ITEM_CATALOG, SKILL_CATALOG, skillCost, skillPrerequisites } from './game-catalog';
import { normalAttackProfile } from './combat';
import { AMMO_CATALOG, LoadoutPolicy, type LoadoutSnapshot } from './loadout';
export { MAX_TARGETS, DEFAULT_SETTINGS, DEFAULT_AUTOMATION, validateSettings, validateAutomation } from './settings';
export type { Settings, AutomationSettings } from './settings';

export interface LogEntry { at: number; text: string }
export interface NavigationStatus extends NavigationSummary {
  ready: boolean; mode: 'idle' | 'search' | 'attack' | 'pickup' | 'follow' | 'waypoint' | 'recover' | 'travel';
  goal: Position | null; route: Position[]; leg: Position[]; routeLength: number;
}
export interface Snapshot {
  connected: boolean; compatible: boolean; running: boolean; reason: string;
  map: string; player: Entity | null; monsters: Entity[]; drops: Drop[];
  attacks: number; kills: number; looted: number; target: string; log: LogEntry[]; navigation: NavigationStatus | null;
  actorObservations: ActorObservationSnapshot; ruleConditions: PublishedConditionReport[];
  loadout: LoadoutSnapshot; character: CharacterSnapshot; actors: Entity[]; task: AutomationTask; elapsedSeconds: number; deaths: number; runIntent: boolean; lootStats: Array<{itemId:number;count:number}>; actionResult: ActionResult;
}
export type Action = { type: 'attack' | 'pickup'; id: number } | { type: 'stop' } | { type: 'walk'; destination: Position } | ExpandedAction;
const ACTION_DELAY = 100;
const LOOT_DELAY = 150;
const cell = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
interface RouteTask { type: 'search' | 'attack' | 'pickup' | 'follow' | 'waypoint' | 'travel'; id?: number; destination: Position; cells: Position[]; since: number | null; attackRange?: number }
interface RouteLeg { destination: Position; cells: Position[]; since: number; acceptedUntil: number | null }

export class BotEngine {
  connected = false;
  compatible = false;
  running = false;
  reason = 'Open the game and sign in to your character.';
  playerId = 0;
  map = '';
  readonly entities = new Map<number, Entity>();
  readonly drops = new Map<number, Drop>();
  readonly log: LogEntry[] = [];
  attacks = 0; kills = 0; looted = 0;
  settings: Settings = DEFAULT_SETTINGS;
  private motions = new Map<number, { walk: Walk; at: number }>();
  private navigator: GridNavigator | null = null;
  private navigationMap = '';
  private route: RouteTask | null = null;
  private leg: RouteLeg | null = null;
  private implicitWalk: { targetId: number; until: number } | null = null;
  private routeFailures = 0;
  private routeStep = 10;
  private pending: { type: 'attack' | 'pickup'; id: number; since: number; progress: number; approachSince: number | null; direct: boolean; attackRange?: number } | null = null;
  private foreignTargets = new Set<number>();
  private serverTargetId:number|null=null;
  private readonly combatConditions=new Map<number,{rule:string;conditions:PredicateTrace[]}>();
  private respawnRefreshPending = false;
  private skillKills = new Map<number, number>();
  private skillTargets = new Map<number, { skillId: number; until: number }>();
  private aggressors = new Set<number>();
  readonly actors = new Map<number, Entity>();
  private readonly revivableActors=new Map<number,Entity>();
  private followLostAt: number | null = null;
  private waypointIndex = 0;
  private runKills = 0; private runPickups = 0;
  private lootStats = new Map<number, number>();
  deaths = 0;
  runIntent = false;
  readonly character = new CharacterState();
  readonly observations: ActorObservations;
  private readonly automation: AutomationScheduler;
  private readonly loadout: LoadoutPolicy;
  private stoppedAt = 0;
  private excluded = new Map<number, number>();
  private lastAction = 0;
  private lastFrame = 0;
  private runStarted = 0;
  private lastTick = 0;
  private lootAfter = 0;
  private killedAt: Array<Position & { at: number }> = [];
  private dropCreatedAt = new Map<number, number>();

  constructor(private readonly send: (action: Action) => void, private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid) { this.automation = new AutomationScheduler(a=>this.send(a),this.now); this.observations=new ActorObservations(this.now);this.loadout=new LoadoutPolicy(this.now); }
  private navigation(): GridNavigator | null {
    if (this.navigationMap !== this.map) {
      const grid = this.gridFor(this.map);
      this.navigator = grid ? new GridNavigator(grid) : null;
      this.navigationMap = this.map;
    }
    this.navigator?.time(this.now());
    return this.navigator;
  }
  get player(): Entity | undefined { return this.entities.get(this.playerId); }
  private awaitsImplicitWalk(): boolean {
    if (this.implicitWalk && this.now() >= this.implicitWalk.until) this.implicitWalk = null;
    return this.implicitWalk !== null;
  }

  note(text: string): void {
    this.log.unshift({ at: this.now(), text });
    this.log.length = Math.min(50, this.log.length);
  }
  connect(compatible: boolean): void {
    this.resetWorld(); this.connected = true; this.compatible = compatible;
    this.reason = compatible ? 'Sign in and enter a character to prepare the bot.' : 'This game build is not verified.';
    this.note(this.reason);
  }
  disconnect(): void {
    this.running = false; this.connected = false; this.compatible = false;
    this.resetWorld(); this.reason = 'Game disconnected. Sign in again, then press Start.'; this.note(this.reason);
  }
  fail(reason: string): void { this.stop(reason); this.compatible = false; }
  stop(reason = 'Stopped by you.'): void {
    const wasRunning = this.running;
    const reserveStop = automationSettings(this.settings).loadout.enabled && this.loadout.requestStop(reason);
    this.loadout.cancel();
    const pendingSkill = this.automation.pendingAction?.type === 'skill';
    this.combatConditions.clear();this.running = false; this.runIntent = false; this.automation.reset(); this.stoppedAt = this.now(); this.pending = null; this.route = null; this.leg = null; this.reason = reason;
    if ((wasRunning || pendingSkill || reserveStop) && this.connected) {
      try { this.send({ type: 'stop' }); }
      catch { this.connected = false; this.compatible = false; this.reason = 'Connection lost while stopping.'; }
    }
    if (wasRunning || this.log[0]?.text !== reason) this.note(reason);
  }
  start(settings: Settings, continuing = false): void {
    const validated = validateSettings(settings);
    if(!continuing)this.acknowledgeLoadoutOverride();
    const p = this.player;
    if(this.automation.busy||this.awaitsImplicitWalk()||this.loadout.startBlocked)throw new Error('Wait for the current action and movement to finish.');
    if (!inSchedule(automationSettings(validated),this.now())) throw new Error('Outside the configured daily schedule.');
    if (!this.connected || !this.compatible || !p || p.kind !== 0 || !this.map) throw new Error('Enter a character in the verified game build first.');
    if (validated.map !== this.map) throw new Error('Map changed. Choose monsters on the current map before starting.');
    if ((!p.dead && (p.maxHp <= 0 || p.hp / p.maxHp * 100 <= settings.minHpPercent))
      || (p.dead && (!continuing || !automationSettings(validated).respawn.enabled))) throw new Error('Recover above the HP stop limit before starting.');
    this.advanceMovement();
    const navigation = this.navigation();
    if (!navigation) throw new Error(`Verified walkability is not available for ${this.map}.`);
    if (!navigation.safe(p)) throw new Error('Move onto open ground away from portals before starting.');
    this.route = null; this.leg = null; this.routeFailures = 0; this.routeStep = validated.route_step;
    this.settings = validated; this.combatConditions.clear();this.automation.reset(); this.loadout.newRun();
    this.pending = null; this.excluded.clear();
    this.killedAt = []; this.dropCreatedAt.clear(); this.skillKills.clear(); this.skillTargets.clear(); this.lootAfter = 0;
    this.deaths=0; this.runIntent = true; this.followLostAt = null; this.waypointIndex = 0; this.runKills = this.kills; this.runPickups = this.looted;
    this.running = true; this.runStarted = this.now(); this.lastTick = this.now(); this.lastAction = 0;
    this.reason = 'Looking for nearby targets.'; this.note('Started combat and loot.');
  }
  receive(events: Array<GameEvent | FeatureEvent>): void {
    this.advanceMovement();
    this.lastFrame = this.now();
    this.observations.frame();
    for (const event of events) this.apply(event);
    this.observations.frame();
  }
  private resetWorld(preserveCharacter=false): void {
    this.observations.reset();this.serverTargetId=null;this.combatConditions.clear();this.revivableActors.clear();
    this.loadout.reset(preserveCharacter);
    if(!preserveCharacter)this.respawnRefreshPending=false;
    if(preserveCharacter)this.character.resetField();else {this.character.reset();this.automation.reset(true);this.runIntent=false;} this.implicitWalk = null; this.motions.clear(); this.navigator = null; this.navigationMap = ''; this.route = null; this.leg = null; this.routeFailures = 0;
    this.entities.clear(); this.actors.clear(); this.aggressors.clear(); this.drops.clear(); this.foreignTargets.clear(); this.excluded.clear();
    this.killedAt = []; this.dropCreatedAt.clear(); this.skillKills.clear(); this.skillTargets.clear(); this.pending = null; this.map = ''; this.playerId = 0;
  }
  private removed(id: number, dead: boolean): void {
    this.combatConditions.delete(id);this.observations.remove(id);if(this.serverTargetId===id)this.serverTargetId=null;
    this.motions.delete(id);
    const entity = this.entities.get(id) ?? this.actors.get(id);
    if(!dead)this.revivableActors.delete(id);
    else if(entity?.kind===0&&id!==this.playerId&&(this.revivableActors.has(id)||this.revivableActors.size<150))this.revivableActors.set(id,{...entity,statuses:undefined});
    if (dead && entity && !this.foreignTargets.has(id)
      && (this.pending?.type === 'attack' && this.pending.id === id || (this.skillKills.get(id) ?? 0) >= this.now())) {
      this.kills++; this.killedAt.push({ x: entity.x, y: entity.y, at: this.now() });
      this.lootAfter = this.now() + LOOT_DELAY;
      this.note(`Defeated ${entity.name}.`);
    }
    if (this.pending?.id === id && this.pending.type === 'attack') {
      if (!dead && this.pending.direct && this.pending.approachSince !== null) { this.send({ type: 'stop' }); this.lastAction = this.now(); }
      this.pending = null;
    }
    if (this.route?.id === id) this.cancelRoute();
    this.skillKills.delete(id); this.skillTargets.delete(id); this.foreignTargets.delete(id); this.aggressors.delete(id); this.actors.delete(id);
    if (id === this.playerId && dead && entity) { const alreadyDead=entity.dead;entity.dead=true;entity.hp=0;if(!alreadyDead)this.onDeath(); }
    else { this.entities.delete(id);if(id===this.playerId)this.stop('Character left the field.'); }
  }
  private apply(e: GameEvent | FeatureEvent): void {
    this.observations.apply(e);
    if (!['enter','map','spawn','remove','clear','stop','position','tracking','walk','attack','hit','death','resurrection','heal','drop','pickup'].includes(e.type)) {
      this.character.apply(e as FeatureEvent,this.playerId);
      const loadoutFailure=this.loadout.observe(e as FeatureEvent,this.character,automationSettings(this.settings).loadout.enabled);
      const pendingSkill = this.automation.pendingAction;
      const result = this.automation.observe(e as FeatureEvent,this.character,this.playerId);
      if (result.confirmed && this.running && e.type === 'skillResult' && e.mode === 'target'
        && e.target !== undefined && pendingSkill?.type === 'skill' && pendingSkill.mode === 'target'
        && this.entities.get(e.target)?.kind === 1 && !this.foreignTargets.has(e.target)) {
        this.skillTargets.set(e.target, { skillId: e.skillId, until: this.now() + 30_000 });
        if ((e.damage ?? 0) > 0) this.skillKills.set(e.target, this.now() + 30_000);
      }
      if ((e.type === 'skillResult' || e.type === 'skillImpact') && e.target !== undefined && (e.damage ?? 0) > 0
        && this.entities.get(e.target)?.kind === 1) {
        if (e.source !== this.playerId) {
          this.foreignTargets.add(e.target); this.skillKills.delete(e.target); this.skillTargets.delete(e.target);
          if (this.pending?.type === 'attack' && this.pending.id === e.target || this.route?.type === 'attack' && this.route.id === e.target)
            this.stop('Another character engaged this target.');
        } else if (e.type === 'skillImpact' && this.skillTargets.get(e.target)?.skillId === e.skillId
          && this.skillTargets.get(e.target)!.until >= this.now()) this.skillKills.set(e.target, this.now() + 30_000);
      }
      if(result.confirmed&&pendingSkill?.type==='equip')this.loadout.confirmed(this.character);
      if(loadoutFailure&&this.running&&automationSettings(this.settings).loadout.enabled)this.stop(loadoutFailure);
      if (result.failure) this.stop(result.failure);
      if(this.running&&automationSettings(this.settings).loadout.enabled&&['inventory','inventoryDelta','equipment'].includes(e.type)&&this.pending?.type==='attack'){
        const failure=this.player?this.loadout.attackGuard(automationSettings(this.settings),this.player,this.character):null;if(failure){this.loadout.stockFault(failure,this.character);this.stop(failure);}
      }
    }
    switch (e.type) {
      case 'changeTarget': {const target=this.entities.get(e.id)??this.actors.get(e.id);this.serverTargetId=target&&!target.dead&&target.hp>0?e.id:null;break;}
      case 'enter':
        this.stop('Preparing character.'); this.resetWorld(); this.playerId = e.id; this.map = e.map; break;
      case 'map': {
        const respawning=this.automation.pendingAction?.type==='respawn';
        const resume=respawning||(!this.running&&this.runIntent);
        this.automation.observe({type:'map'},this.character,this.playerId);
        this.stop(respawning ? 'Respawn confirmed. Return to the lock map before resuming.' : 'Map changed. Press Start when ready.'); this.runIntent = resume; const id = this.playerId;
        this.resetWorld(true); this.playerId = id; this.map = e.map; break;
      }
      case 'clear': {
        const respawning = this.automation.pendingAction?.type === 'respawn';
        const resume = !this.running && this.runIntent;
        if (respawning) {
          // Same-map respawn emits clear then an alive self spawn, without a map packet.
          this.running = false; this.runIntent = true; this.reason = 'Waiting for the respawned character.';
        } else { this.stop('World refreshed. Press Start when ready.'); this.runIntent = resume; }
        const id = this.playerId; const map = this.map;
        this.resetWorld(true); this.playerId = id; this.map = map; this.respawnRefreshPending = respawning; break;
      }
      case 'spawn':
        this.revivableActors.delete(e.entity.id);
        if(this.serverTargetId===e.entity.id)this.serverTargetId=null;
        this.observations.spawn(e.entity);
        this.motions.delete(e.entity.id);
        // Actors remain bounded in memory for opt-in follow and NPC workflows.
        if (e.entity.id !== this.playerId && (e.entity.kind === 0 || e.entity.kind === 2 || e.entity.kind === 4) && (this.actors.has(e.entity.id)||this.actors.size < 150)) this.actors.set(e.entity.id, e.entity);
        if (e.entity.id === this.playerId || e.entity.kind === 1) this.entities.set(e.entity.id, e.entity);
        if (e.entity.id === this.playerId) {
          this.character.spawn(e.entity as StatefulEntity);
          if (this.respawnRefreshPending && !e.entity.dead && e.entity.hp > 0) {
            this.automation.observe({ type: 'resurrection' }, this.character, this.playerId);
            this.respawnRefreshPending = false;
          }
        }
        if (e.entity.id === this.playerId && !this.running) { this.reason = 'Ready. Choose your targets and press Start.'; this.note('Character ready.'); }
        break;
      case 'tracking': break; // Minimap markers do not correct world movement.
      case 'stop':
        if (e.id === this.playerId) this.implicitWalk = null;
        this.motions.delete(e.id); this.interrupted(e.id);
        break;
      case 'walk': {
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id);
        if (!entity) break;
        Object.assign(entity, walkPosition(e.walk, 0));
        this.motions.delete(e.id);
        if (!e.walk.locked && e.walk.cells.length > 1) this.motions.set(e.id, { walk: e.walk, at: this.now() });
        if (e.id === this.playerId && !this.running && this.automation.pendingAction?.type === 'skill') {
          this.stop('Manual skill triggered movement; waiting for it to settle.'); break;
        }
        if (e.id === this.playerId && !e.walk.locked) this.implicitWalk = null;
        if (e.id === this.playerId && this.running) {
          const nav = this.navigation();
          if (!nav || e.walk.cells.length > 21 || !nav.validRoute(e.walk.cells)) {
            this.stop('Server walk crossed blocked cells or a portal exclusion.'); break;
          }
          if (this.leg) {
            const endpoint = e.walk.cells.at(-1);
            if (e.walk.locked) this.leg.acceptedUntil = null;
            else if (!endpoint || walkDuration(e.walk) > 15000) this.failRoute();
            else {
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
        this.motions.delete(e.id); this.interrupted(e.id);
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id); if (entity) Object.assign(entity, e.position); break;
      }
      case 'remove': this.removed(e.id, e.dead); break;
      case 'death':
        this.observations.remove(e.id);if(e.id===this.playerId||this.serverTargetId===e.id)this.serverTargetId=null;
        this.motions.delete(e.id);
        if (e.id === this.playerId && this.player) { if(!this.player.dead) {this.player.dead = true; this.player.hp = 0; this.onDeath();} }
        else this.removed(e.id, true);
        break;
      case 'resurrection': {
        this.observations.remove(e.id);if(e.id===this.playerId||this.serverTargetId===e.id)this.serverTargetId=null;
        this.motions.delete(e.id);
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id) ?? this.revivableActors.get(e.id);
        this.revivableActors.delete(e.id);
        if(entity?.kind===0&&e.id!==this.playerId&&this.actors.size<150)this.actors.set(e.id,entity);
        if (entity) { entity.dead = false; entity.hp = Math.min(e.hp, entity.maxHp); Object.assign(entity, e.position);this.observations.spawn({...entity,statuses:undefined}); }
        if (e.id === this.playerId) { const resume = this.automation.pendingAction?.type === 'respawn'; this.automation.observe({type:'resurrection'},this.character,this.playerId); this.stop('Character revived. Press Start when ready.'); this.runIntent = resume; }
        break;
      }
      case 'attack': {
        if (e.source === this.playerId && e.target === this.implicitWalk?.targetId) this.implicitWalk = null;
        this.motions.delete(e.source);
        const entity = this.entities.get(e.source) ?? this.actors.get(e.source); if (entity) Object.assign(entity, e.position);
        if (e.target === this.playerId && this.entities.get(e.source)?.kind === 1) this.aggressors.add(e.source);
        if (e.source !== this.playerId && this.entities.get(e.target)?.kind === 1) {
          this.foreignTargets.add(e.target);
          if ((this.pending?.type === 'attack' && this.pending.id === e.target) || (this.route?.type === 'attack' && this.route.id === e.target)) this.stop('Another character engaged this target.');
        }
        if (e.source === this.playerId && this.pending?.type === 'attack' && this.pending.id === e.target) { this.pending.progress = this.now(); this.pending.approachSince = null; this.pending.direct = false; }
        break;
      }
      case 'hit': {
        if (e.stops) { this.motions.delete(e.id); this.interrupted(e.id); }
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id);
        if (entity) { entity.hp = Math.max(0, Math.min(entity.maxHp, entity.hp - e.damage)); Object.assign(entity, e.position);if(entity.hp===0){this.observations.remove(e.id);if(e.id===this.playerId||this.serverTargetId===e.id)this.serverTargetId=null;} }
        break;
      }
      case 'heal': {
        const entity = this.entities.get(e.id) ?? this.actors.get(e.id); if (entity) { entity.hp = e.hp; entity.maxHp = e.maxHp; } break;
      }
      case 'stats': if (this.player) { this.player.hp = e.hp; this.player.maxHp = e.maxHp; this.player.level = e.level; } break;
      case 'drop':
        if (!this.drops.has(e.drop.id) && this.running && e.drop.isNew) this.dropCreatedAt.set(e.drop.id, this.now());
        this.drops.set(e.drop.id, e.drop); break;
      case 'pickup':
        if (e.picker === this.playerId && this.pending?.type === 'pickup' && this.pending.id === e.id) { this.looted++; const drop = this.drops.get(e.id); if (drop) this.lootStats.set(drop.itemId,(this.lootStats.get(drop.itemId) ?? 0) + drop.count); this.note('Loot pickup confirmed.'); }
        this.drops.delete(e.id);
        this.dropCreatedAt.delete(e.id);
        if (this.pending?.type === 'pickup' && this.pending.id === e.id) this.pending = null;
        if (this.route?.type === 'pickup' && this.route.id === e.id) this.cancelRoute();
        break;
    }
    if (this.player && this.character.stats) { this.character.stats.hp = this.player.hp; this.character.stats.maxHp = this.player.maxHp; this.character.stats.level = this.player.level; }
    if (this.running && this.player && !this.player.dead && this.player.hp / this.player.maxHp * 100 <= this.settings.minHpPercent) this.stop('HP reached the stop limit. Recover manually.');
  }
  tick(): void {
    const now = this.now();
    this.advanceMovement(); this.loadout.tick();
    const manualSkill = !this.running && this.automation.pendingAction?.type === 'skill';
    const actionTimeout = this.automation.timeout();
    if (actionTimeout) { if (manualSkill && this.connected) this.send({ type: 'stop' }); this.stop(actionTimeout); return; }
    if (!this.running) return;
    if (now - this.lastTick > 5000) { this.stop('Mac slept or the game paused. Press Start to resume.'); return; }
    this.lastTick = now;
    const p = this.player;
    if (!p || !this.connected || !this.compatible) { this.stop('Game state is unavailable.'); return; }
    if (now - Math.max(this.lastFrame, this.runStarted) > 15000) { this.stop('No recent server updates.'); return; }
    const a = automationSettings(this.settings);
    if (!inSchedule(a,now)) { this.stop('Daily schedule ended. Press Start during the next allowed period.'); return; }
    if ((a.limits.minutes && now - this.runStarted >= a.limits.minutes * 60000) || (a.limits.kills && this.kills - this.runKills >= a.limits.kills) || (a.limits.pickups && this.looted - this.runPickups >= a.limits.pickups)) { this.stop('Configured session limit reached.'); return; }
    if (p.dead) { if(a.respawn.enabled && this.deaths <= a.respawn.maxDeaths && !this.automation.busy) { this.automation.submit({type:'respawn'},this.character); this.reason='Waiting for respawn confirmation.'; } return; }
    if (p.maxHp <= 0 || p.hp / p.maxHp * 100 <= this.settings.minHpPercent) { this.stop('HP reached the stop limit. Recover manually.'); return; }
    if (a.limits.weightPercent) { const stats=this.character.stats; if(stats?.weight===undefined||!stats.maxWeight) { this.stop('Weight is unavailable for the configured weight limit.');return; } if(stats.weight/stats.maxWeight*100>=a.limits.weightPercent) { this.stop('Configured weight limit reached.');return; } }
    const nav = this.navigation();
    if (!nav || !nav.safe(p)) { this.stop('Character left verified walkable ground or entered a portal exclusion.'); return; }
    if (this.awaitsImplicitWalk() && !this.pending?.direct) {
      this.reason = 'Waiting for the previous monster approach to acknowledge before another action.'; return;
    }
    this.killedAt = this.killedAt.filter(k => now - k.at < 30000);
    if (this.automation.busy) { this.reason=this.automation.task().label; return; }
    if(this.pending?.type==='attack') {
      const target=this.entities.get(this.pending.id);
      if(target&&monsterRule(a,target.classId)?.conditions?.length&&!this.eligible(target,now,false)) {
        // Stop the owned auto-attack, keeping an unresolved server approach fenced
        // until its walk/stop reply or the existing bounded wait settles it.
        if(!this.motions.has(this.playerId))this.implicitWalk ??= {targetId:this.pending.id,until:now+4000};
        this.pending=null;this.route=null;this.send({type:'stop'});this.lastAction=now;
        this.reason='Monster conditions no longer permit this attack.';this.note(this.reason);return;
      }
    }
    if(this.route?.type==='attack') {
      const target=this.entities.get(this.route.id!);
      if(target&&monsterRule(a,target.classId)?.conditions?.length&&!this.eligible(target,now,false)) {
        this.cancelRoute();this.reason='Monster conditions no longer permit this approach.';this.note(this.reason);return;
      }
    }
    if (this.automation.wantsRecovery(a,p,this.character)) {
      const recoveryItem=this.automation.nextRecoveryItem(a,p,this.character,this.actorObservation(a.items.flatMap(r=>r.conditions??[])));
      if(recoveryItem.failure){this.stop(recoveryItem.failure);return;}
      if (this.pending || this.route || this.leg) { this.pending=null;const stoppingLeg=!!this.leg;this.cancelRoute();if(!stoppingLeg)this.send({type:'stop'});this.lastAction=now;this.reason='Stopping combat before recovery.';return; }
      if(this.motions.has(this.playerId)||now-this.lastAction<ACTION_DELAY)return;
      if(recoveryItem.action){this.automation.submit(recoveryItem.action,this.character);this.reason=this.automation.task().label;return;}
      const recovery=this.automation.recover(a,p,this.character);
      if(recovery.failure) {this.stop(recovery.failure);return;}
      if(recovery.action)this.automation.submit(recovery.action,this.character);
      this.reason=this.automation.task().label;if(this.automation.recovering||this.automation.busy)return;
    }
    if(this.character.sitting===true) {if(!this.motions.has(this.playerId))this.automation.submit({type:'sit',sitting:false},this.character);return;}
    let monsterChoice: { target: Entity; cells: Position[] } | null | undefined;
    const chooseMonster = () => {
      if (monsterChoice === undefined) monsterChoice = this.bestRoute(p, [...this.entities.values()].filter(e => this.eligible(e, now)), e => monsterRule(a, e.classId)?.priority ?? 0, true);
      return monsterChoice;
    };
    const needsEnemy = a.loadout.enabled || a.skills.some(rule => rule.target === 'enemy') || a.equipment.some(rule => rule.monsterClassId > 0);
    const enemy=this.pending?.type==='attack'?this.entities.get(this.pending.id)??null:this.route?.type==='attack'?this.entities.get(this.route.id!)??null:needsEnemy?chooseMonster()?.target??null:null;
    const conditions=[...a.items,...a.skills,...a.equipment].flatMap(rule=>rule.conditions??[]);
    const observations=conditions.length?this.actorObservation(conditions):undefined;
    const next=this.automation.next(a.loadout.enabled?{...a,equipment:[]}:a,p,this.character,enemy,observations);
    if(next.failure) {this.stop(next.failure);return;}
    if(next.action) {
      if(this.pending||this.route||this.leg) {this.pending=null;const stoppingLeg=!!this.leg;this.cancelRoute();if(!stoppingLeg)this.send({type:'stop'});this.lastAction=now;return;}
      if(this.motions.has(this.playerId)||now-this.lastAction<ACTION_DELAY)return;
      this.automation.submit(next.action,this.character);this.reason=this.automation.task().label;return;
    }
    if(a.loadout.enabled) {
      if(this.loadout.blocked){this.reason=this.loadout.snapshot(a,this.character).reason;return;}
      const planned=this.loadout.next(a,p,this.character,enemy,rule=>this.automation.conditionState(`Equipment ${rule.itemId}`,rule.conditions,observations));
      if(planned.failure){this.stop(planned.failure);return;}
      if(planned.change){
        if(this.pending||this.route||this.leg||this.loadout.needsStop){
          if(this.leg?.acceptedUntil===null)this.implicitWalk??={targetId:this.pending?.id??0,until:now+4000};
          this.pending=null;this.route=null;this.leg=null;
          this.loadout.requestStop('Waiting for target clear before changing equipment.');
          this.send({type:'stop'});this.lastAction=now;return;
        }
        if(this.motions.has(this.playerId)||now-this.lastAction<ACTION_DELAY)return;
        this.loadout.begin(planned.change,this.character);
        this.automation.submit(planned.change.action,this.character,state=>this.loadout.receipt(state));
        this.reason=this.automation.task().label;return;
      }
      if(enemy){const guard=this.loadout.attackGuard(a,p,this.character);if(guard){this.stop(guard);return;}}
    }
    if (this.pending) {
      const target = this.entities.get(this.pending.id);
      const attackRange = normalAttackProfile(this.character).range;
      if (this.pending.type === 'attack' && target && (this.pending.attackRange !== attackRange
        || (!nav.canAttack(cell(p), cell(target), attackRange) && !nav.clearWalkCorridor(cell(p), cell(target))))) {
        const since = this.pending.approachSince;
        // Attack may already have requested a walk whose reply is still in flight.
        // Retain that owner until its reply or the existing bounded wait expires.
        if (!this.motions.has(this.playerId)) {
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
      const approachExpired = this.pending.approachSince !== null
        && (now - this.pending.approachSince >= this.settings.attackMaxRouteTime * 1000
          || (this.pending.type === 'attack' && (!target || !this.planAttack(p, target))));
      if (!approachExpired && now - this.pending.progress < 12000 && now - this.pending.since < 90000) return;
      this.excluded.set(this.pending.id, now + 30000); this.send({ type: 'stop' });
      this.reason = 'Target timed out or became unreachable; skipping it for 30 seconds.'; this.note(this.reason);
      this.pending = null; this.lastAction = now; return;
    }
    if (now < this.lootAfter) return;
    // Keep a chosen pursuit stable; a moving target is replanned after the current leg.
    if (this.route && (this.route.type === 'attack' || this.route.type === 'pickup')) {
      const target = this.route.type === 'attack' ? this.entities.get(this.route.id!) : this.drops.get(this.route.id!);
      if (!target || (this.route.type === 'attack' && !this.eligible(target as Entity, now, false))) { this.cancelRoute(); return; }
      if (distance(cell(target), this.route.destination) !== 0) { this.route.destination = cell(target); this.route.cells = []; }
      this.routeTick(p, now); return;
    }
    if (now - this.lastAction < ACTION_DELAY) return;
    const available = (id: number) => (this.excluded.get(id) ?? 0) <= now;
    if (this.settings.loot) {
      const candidates = [...this.drops.values()].filter(d => available(d.id) && distance(p, d) <= this.settings.radius
        && acceptsLoot(a,d.itemId) && (a.loot.ownership === 'all' || this.killedAt.some(k => distance(k, d) <= 3 && (this.dropCreatedAt.get(d.id) ?? -Infinity) >= k.at)));
      const choice = this.bestRoute(p, candidates, d=>lootRule(a,d.itemId)?.priority ?? 0);
      if (choice) { this.pursue('pickup', choice.target.id, cell(choice.target), choice.cells); this.routeTick(p, now); return; }
    }
    const choice = chooseMonster();
    if (choice) { this.pursue('attack', choice.target.id, cell(choice.target), choice.cells); this.routeTick(p, now); }
    else if (a.follow.name) { this.followTick(p,now); }
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
    } else this.reason = 'Waiting for a reachable matching monster.';
  }
  private eligible(e: Entity, now: number, acquiring = true): boolean {
    const automation=automationSettings(this.settings);const conditions=monsterRule(automation,e.classId)?.conditions;
    const observations=conditions?.length?this.actorObservation(conditions,this.currentTargetId,e.id):undefined;
    if(conditions?.length&&(this.combatConditions.has(e.id)||this.combatConditions.size<32))this.combatConditions.set(e.id,{rule:`Monster ${e.classId} · actor ${e.id}`,conditions:conditions.map(condition=>evaluateActorPredicate(condition,observations))});
    return e.kind === 1 && !e.dead && e.hp > 0 && acceptsMonster(automation,e,this.player!,this.settings.targets,this.aggressors.has(e.id),observations)
      && (!acquiring || distance(this.player!, e) <= this.settings.radius) && !this.foreignTargets.has(e.id)
      && (this.excluded.get(e.id) ?? 0) <= now;
  }
  private plan(from: Position, to: Position, range: number, goal: 'walk' | 'attack' = 'walk'): Position[] | null {
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
  private pursue(type: 'attack' | 'pickup', id: number, destination: Position, cells: Position[]): void {
    // Finish an outstanding leg before changing destination; its reply has no request ID.
    this.route = { type, id, destination, cells, since: null, ...(type === 'attack' ? { attackRange: normalAttackProfile(this.character).range } : {}) };
    const target = type === 'attack' ? this.entities.get(id)?.name ?? 'monster' : 'loot';
    this.reason = `Selected ${target}; finishing the current walk before approaching.`;
  }
  private act(type: 'attack' | 'pickup', id: number, direct = false): void {
    const approachStarted = this.route?.since ?? this.now();
    this.route = null; this.leg = null;
    if(type==='attack'&&this.player){const failure=this.loadout.attackGuard(automationSettings(this.settings),this.player,this.character);if(failure){this.stop(failure);return;}if(automationSettings(this.settings).loadout.enabled)this.loadout.attackDispatched();}
    this.send({ type, id }); this.lastAction = this.now();
    this.pending = { type, id, since: this.now(), progress: this.now(), approachSince: direct ? approachStarted : null, direct,
      ...(type === 'attack' ? { attackRange: normalAttackProfile(this.character).range } : {}) };
    if (direct) this.implicitWalk = {targetId:id,until:this.now()+4000};
    this.reason = type === 'attack' ? `Attacking ${this.entities.get(id)?.name ?? 'selected monster'}.` : `Collecting item #${this.drops.get(id)?.itemId}.`;
    if (type === 'attack') this.attacks++;
    this.note(this.reason);
  }
  private interrupted(id: number): void {
    if (id === this.playerId) { this.leg = null; if (this.route) this.route.cells = []; }
  }
  private cancelRoute(): void {
    if (this.leg && this.running) { this.send({ type: 'stop' }); this.lastAction = this.now(); }
    this.leg = null; this.route = null;
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
    if (!this.route) return;
    if (this.leg) this.navigator?.temporaryBlocked(this.leg.destination, this.now() + 30000);
    this.leg = null; this.route.cells = []; this.routeFailures++;
    this.routeStep = Math.max(1, Math.floor(this.routeStep / 2)); this.lastAction = this.now();
    if (this.routeFailures >= 3) { this.stop('Stopped after three failed walks. Reposition before restarting.'); return; }
    this.send({ type: 'stop' }); this.reason = 'Walk did not complete; replanning with shorter steps.'; this.note(this.reason);
  }
  private routeTick(p: Entity, now: number): void {
    const route = this.route;
    const nav = this.navigation();
    if (!route || !nav) return;
    const navigationTask = !['attack','pickup'].includes(route.type);
    const limit = navigationTask ? this.settings.route_randomWalk_maxRouteTime : this.settings.attackMaxRouteTime;
    if (route.since !== null && now - route.since >= limit * 1000) {
      if (route.id !== undefined) this.excluded.set(route.id, now + 30000);
      const target = route.type === 'attack' ? this.entities.get(route.id!)?.name ?? 'monster' : 'loot';
      this.cancelRoute();
      this.reason = route.type === 'search' ? 'Search route time limit reached; choosing another goal.'
        : `Approach time limit (${limit}s) reached for ${target}; skipping it for 30 seconds.`;
      this.note(this.reason); return;
    }
    const motion = this.motions.get(this.playerId);
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
    const range = route.type === 'follow' ? automationSettings(this.settings).follow.distance : navigationTask ? 0 : 1;
    const index = route.cells.findIndex(c => distance(c, p) === 0);
    if (index >= 0) route.cells = route.cells.slice(index);
    else route.cells = [];
    if (!route.cells.length) route.cells = (navigationTask
      ? nav.plan(p, route.destination, { range, avoidWalls: this.settings.route_avoidWalls })
      : route.type === 'attack' ? this.planAttack(p, route.destination) : this.plan(p, route.destination, range)) ?? [];
    if (!route.cells.length) {
      if (route.id !== undefined) this.excluded.set(route.id, now + 30000);
      this.cancelRoute(); this.reason = 'Destination is unreachable; choosing another goal.'; return;
    }
    if (route.cells.length === 1) {
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
    this.reason = `${route.type === 'search' ? 'Searching' : route.type === 'attack' ? 'Approaching monster' : 'Approaching loot'} · walking to ${destination.x}, ${destination.y}.`;
  }
  /** Resume an already requested run without resetting its finite budgets. */
  resumeRequested(input: Settings = this.settings): void {
    if (this.running || !this.idleForActions()) throw new Error('Wait for movement and actions to finish.');
    const previous = { deaths: this.deaths, started: this.runStarted, kills: this.runKills,
      pickups: this.runPickups, waypoint: this.waypointIndex };
    this.start(input, true);
    if (previous.started) {
      this.deaths = previous.deaths; this.runStarted = previous.started;
      this.runKills = previous.kills; this.runPickups = previous.pickups; this.waypointIndex = previous.waypoint;
    }
    this.reason = 'Resumed the requested run.'; this.note(this.reason);
  }
  resumeAfterReturn(input: Settings = this.settings): void {
    if(!this.runIntent||this.running||!automationSettings(this.settings).travel.returnToLockMap)throw new Error('No automatic return is authorized. Press Start explicitly.');
    if(input.map!==this.settings.map||this.map!==this.settings.map)throw new Error('Return has not reached the original lock map.');
    this.resumeRequested(input);
    this.reason='Returned to the lock map; resumed the requested run.';this.note(this.reason);
  }
  private onDeath(): void {
    this.implicitWalk = null; this.loadout.reset(true);
    this.deaths++;
    const a=automationSettings(this.settings);
    if(this.running&&a.respawn.enabled&&this.deaths<=a.respawn.maxDeaths) {
      this.pending=null;this.route=null;this.leg=null;this.automation.reset();this.reason='Character died; automatic respawn is enabled.';this.note(this.reason);
    } else this.stop(a.respawn.enabled?'Death limit reached. Recover manually before restarting.':'Character died. Recover manually before restarting.');
  }
  acknowledgeLoadoutOverride():void {this.loadout.acknowledgeOverride();}
  get pendingFeatureAction(): ExpandedAction | null { return this.automation.pendingAction; }
  /** Emergency escape may preempt walking/combat, but never an unresolved resource or cast. */
  get featureActionsSettled(): boolean { return !this.automation.busy && this.loadout.equipmentSettled; }
  get actionResult(): ActionResult { return {...this.automation.result}; }
  idleForActions(): boolean { this.advanceMovement(); return !this.running&&!this.pending&&!this.leg&&!this.route&&!this.automation.busy&&!this.awaitsImplicitWalk()&&!this.motions.has(this.playerId)&&!this.loadout.blocked; }
  manualAction(action: ExpandedAction): void {
    action=validateExpandedAction(action);
    if(!this.idleForActions())throw new Error('Stop automation and wait for movement and action confirmation first.');
    const p=this.player;
    if(!this.connected||!this.compatible||!p)throw new Error('A verified character is required.');
    if(action.type==='respawn') {if(!p.dead)throw new Error('Respawn requires a dead character.');}
    else if(p.dead)throw new Error('Revive before using this action.');
    if(action.type==='sit'&&action.sitting&&p.classId===0&&(!this.character.skillsKnown||(this.character.learned.get(1)??0)<2))throw new Error('A novice needs verified Basic Mastery level 2 to sit.');
    if(action.type==='useItem') {
      if(!this.character.inventoryKnown||this.character.count(action.itemId)<1)throw new Error('Item is not present in a verified inventory.');
      const item=ITEM_CATALOG[action.itemId];if(!item||item.useType<1)throw new Error('This item is not usable.');
      if(action.target&&!this.entities.has(action.target)&&!this.actors.has(action.target))throw new Error('Item target is not visible.');
      if(item.useType===2&&!action.target)throw new Error('This item requires a target.');
    }
    if(action.type==='equip') {const item=this.character.inventory.get(action.bagId),info=item?ITEM_CATALOG[item.itemId]:undefined;if(!this.character.inventoryKnown||!item||!info||![2,3,4].includes(info.itemClass)||(!info.position&&!AMMO_CATALOG[item!.itemId]))throw new Error('Equipment is not present in a verified inventory.');}
    if(action.type==='allocateSkill') {
      const skill=SKILL_CATALOG[action.skillId],requirements=skillPrerequisites(p.classId,action.skillId),learned=this.character.learned.get(action.skillId)??0;
      if(!this.character.skillsKnown||!this.character.stats?.skillPoints||!skill||learned>=skill.maxLevel||requirements===null||requirements.some(r=>(this.character.learned.get(r.skillId)??0)<r.level))throw new Error('Skill points, class prerequisites and a learnable skill are required.');
    }
    if(action.type==='allocateStats') {
      const stats=this.character.stats;if(!stats?.attributes||stats.statPoints===undefined)throw new Error('Verified attributes and stat points are required.');
      let cost=0;for(let i=0;i<6;i++){const current=stats.attributes[i]!;if(current+action.attributes[i]!>99)throw new Error('Attributes cannot exceed 99.');for(let n=0;n<action.attributes[i]!;n++)cost+=2+Math.floor((current+n-1)/10);}
      if(cost>stats.statPoints)throw new Error('Insufficient verified stat points.');
    }
    if(action.type==='skill') {
      const requestedLevel=action.level;
      if(this.character.skillLevel(action.skillId)<requestedLevel)throw new Error('An active learned or granted skill is required.');
      action={...action,level:effectiveSkillLevel(action.skillId,requestedLevel,this.character)};
      const skill=SKILL_CATALOG[action.skillId],cost=skillCost(action.skillId,action.level);
      if(!this.character.skillsKnown||this.character.skillLevel(action.skillId)<action.level||!skill||skill.target===0||cost===null)throw new Error('An active learned or granted skill is required.');
      if(this.character.stats?.sp===undefined||this.character.stats.sp<cost)throw new Error('Insufficient verified SP.');
      if((action.mode==='self'&&![2,3,5].includes(skill.target))||(action.mode==='ground'&&skill.target!==4)||(action.mode==='target'&&![1,2,3].includes(skill.target)))throw new Error('Skill targeting does not match its catalog.');
      if (action.mode === 'target' || action.mode === 'ground') {
        const target = action.mode === 'target' ? this.entities.get(action.target) ?? this.actors.get(action.target) : action.position;
        if (!target) throw new Error('Target is not visible.');
        // Until every skill's deployed range is confirmed, allow only adjacent,
        // directly walkable targets so a manual command cannot start an unowned chase.
        const path = this.navigation()?.plan(cell(p), cell(target), { maxDistance: 2, avoidWalls: false });
        if (distance(p, target) > 1 || !path || path.length > 2)
          throw new Error('Move next to the skill target on verified open ground first.');
      }
    }
    this.loadout.acknowledgeOverride();
    this.automation.submit(action,this.character);this.reason=this.automation.task().label;
  }
  private followTick(p: Entity, now: number): void {
    const follow=automationSettings(this.settings).follow;
    const actor=[...this.actors.values()].find(e=>e.kind===0&&e.name===follow.name&&!e.dead);
    if(!actor) {
      this.followLostAt??=now;if(now-this.followLostAt>=follow.lostSeconds*1000)this.stop('Follow target is no longer visible.');
      else this.reason='Waiting for the named follow target.';return;
    }
    this.followLostAt=null;
    if(distance(p,actor)<=follow.distance) {if(this.route?.type==='follow')this.cancelRoute();this.reason='Within follow distance.';return;}
    if(!this.route||this.route.type!=='follow')this.route={type:'follow',id:actor.id,destination:cell(actor),cells:[],since:null};
    else if(distance(cell(actor),this.route.destination)!==0){this.route.destination=cell(actor);this.route.cells=[];}
    this.routeTick(p,now);
  }
  private waypointTick(p: Entity, now: number): void {
    const travel=automationSettings(this.settings).travel;
    if(this.waypointIndex>=travel.waypoints.length) {if(travel.loop)this.waypointIndex=0;else {this.reason='Waypoint route completed.';return;}}
    const waypoint=travel.waypoints[this.waypointIndex]!;
    if(waypoint.map!==this.map){this.stop('Next waypoint is on another map; use the travel workflow.');return;}
    if(!this.route||this.route.type!=='waypoint')this.route={type:'waypoint',destination:{x:waypoint.x,y:waypoint.y},cells:[],since:null};
    this.routeTick(p,now);
  }
  actorObservation(conditions:ActorPredicate[]=[], targetId:number|null=this.currentTargetId,candidateId:number|null=null): ActorObservationSnapshot {
    return this.observations.snapshot(this.playerId,targetId,this.connected&&this.compatible,conditions,false,candidateId);
  }
  get currentTargetId():number|null {
    return this.serverTargetId;
  }
  snapshot(): Snapshot {
    const nav = this.navigation();
    const chase = this.pending?.type === 'attack' ? this.entities.get(this.pending.id) : null;
    const chaseCells = chase ? this.motions.get(this.playerId)?.walk.cells ?? [] : [];
    const navigation: NavigationStatus | null = nav ? {
      ...nav.summary(this.player ?? { x: -1, y: -1 }), ready: !!this.player && nav.safe(this.player),
      mode: this.automation.recovering ? 'recover' : this.route?.type ?? (chase ? 'attack' : 'idle'), goal: this.route?.destination ?? (chase ? cell(chase) : null),
      route: this.route?.cells.slice(0, 512) ?? chaseCells, leg: this.leg?.cells ?? chaseCells, routeLength: Math.max(0, (this.route?.cells.length ?? chaseCells.length) - 1),
    } : null;
    return {
      connected: this.connected, compatible: this.compatible, running: this.running, reason: this.reason,
      map: this.map, player: this.player ? { ...this.player } : null,
      monsters: [...this.entities.values()].filter(e => e.kind === 1).slice(0,150),
      drops: [...this.drops.values()].slice(0,150), attacks: this.attacks, kills: this.kills,
      looted: this.looted, target: this.pending?.type === 'attack' ? this.entities.get(this.pending.id)?.name ?? '' : this.route?.type === 'attack' ? this.entities.get(this.route.id!)?.name ?? '' : '',
      actorObservations:this.observations.snapshot(this.playerId,this.currentTargetId,this.connected&&this.compatible),ruleConditions:publishConditionReports([...this.automation.ruleConditions,...this.combatConditions.values()]),
      log: this.log.slice(), navigation, loadout:this.loadout.snapshot(automationSettings(this.settings),this.character), character:this.character.snapshot(), actors:[...this.actors.values()].slice(0,100),
      task:this.automation.busy||this.automation.recovering?this.automation.task():{kind:this.pending?.type??this.route?.type??'idle',label:this.reason,pending:!!this.pending||!!this.leg,since:this.pending?.since??this.route?.since??null},
      elapsedSeconds:this.runStarted?Math.max(0,Math.floor(((this.running?this.now():this.stoppedAt)-this.runStarted)/1000)):0,deaths:this.deaths,runIntent:this.runIntent,lootStats:[...this.lootStats].slice(0,128).map(([itemId,count])=>({itemId,count})),actionResult:{...this.automation.result},
    };
  }
}

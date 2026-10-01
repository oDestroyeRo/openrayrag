import { type Drop, type Entity, type GameEvent, type Position, type Walk } from './protocol';

import { walkDuration, walkPosition } from './movement';
import { GridNavigator, routeSegment, searchGrid, distance, type NavigationSummary, type WalkGrid } from './navigation';

export const MAX_TARGETS = 64;
export interface Settings { map: string; targets: number[]; radius: number; minHpPercent: number; loot: boolean;
  route_randomWalk: 0 | 2; route_step: number; route_avoidWalls: boolean;
  route_randomWalk_maxRouteTime: number; attackRouteMaxPathDistance: number; attackMaxRouteTime: number }
export const DEFAULT_SETTINGS: Settings = {
  map: '', targets: [], radius: 12, minHpPercent: 45, loot: true,
  route_randomWalk: 0, route_step: 10, route_avoidWalls: true,
  route_randomWalk_maxRouteTime: 75, attackRouteMaxPathDistance: 20, attackMaxRouteTime: 4,
};
export interface LogEntry { at: number; text: string }
export interface NavigationStatus extends NavigationSummary {
  ready: boolean; mode: 'idle' | 'search' | 'attack' | 'pickup';
  goal: Position | null; route: Position[]; leg: Position[]; routeLength: number;
}
export interface Snapshot {
  connected: boolean; compatible: boolean; running: boolean; reason: string;
  map: string; player: Entity | null; monsters: Entity[]; drops: Drop[];
  attacks: number; kills: number; looted: number; target: string; log: LogEntry[]; navigation: NavigationStatus | null;
}
export type Action = { type: 'attack' | 'pickup'; id: number } | { type: 'stop' } | { type: 'walk'; destination: Position };
const cell = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y) });
const bounded = (v: number, min: number, max: number) => Number.isInteger(v) && v >= min && v <= max;
interface RouteTask { type: 'search' | 'attack' | 'pickup'; id?: number; destination: Position; cells: Position[]; since: number | null }
interface RouteLeg { destination: Position; cells: Position[]; since: number; acceptedUntil: number | null }

export function validateSettings(value: Settings): Settings {
  if (!Number.isInteger(value.radius) || value.radius < 1 || value.radius > 20
    || !Number.isInteger(value.minHpPercent) || value.minHpPercent < 20 || value.minHpPercent > 95
    || ![0, 2].includes(value.route_randomWalk) || !bounded(value.route_step, 1, 20)
    || typeof value.route_avoidWalls !== 'boolean' || !bounded(value.route_randomWalk_maxRouteTime, 1, 600)
    || !bounded(value.attackRouteMaxPathDistance, 1, 200) || !bounded(value.attackMaxRouteTime, 1, 60) || typeof value.loot !== 'boolean' || !Array.isArray(value.targets)
    || typeof value.map !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.map)
    || value.targets.length < 1 || value.targets.length > MAX_TARGETS || new Set(value.targets).size !== value.targets.length
    || value.targets.some(id => !Number.isInteger(id) || id <= 0 || id > 2_147_483_647)) {
    throw new Error('Invalid settings. Choose current-map monsters and valid combat and routing limits.');
  }
  return { ...value, targets: value.targets.slice() };
}

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
  private routeFailures = 0;
  private routeStep = 10;
  private pending: { type: 'attack' | 'pickup'; id: number; since: number; progress: number; approachSince: number | null } | null = null;
  private foreignTargets = new Set<number>();
  private excluded = new Map<number, number>();
  private lastAction = 0;
  private lastFrame = 0;
  private runStarted = 0;
  private lastTick = 0;
  private lootAfter = 0;
  private killedAt: Array<Position & { at: number }> = [];
  private dropCreatedAt = new Map<number, number>();

  constructor(private readonly send: (action: Action) => void, private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid) {}
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
    this.running = false; this.pending = null; this.route = null; this.leg = null; this.reason = reason;
    if (wasRunning && this.connected) {
      try { this.send({ type: 'stop' }); }
      catch { this.connected = false; this.compatible = false; this.reason = 'Connection lost while stopping.'; }
    }
    if (wasRunning || this.log[0]?.text !== reason) this.note(reason);
  }
  start(settings: Settings): void {
    const validated = validateSettings(settings);
    const p = this.player;
    if (!this.connected || !this.compatible || !p || p.kind !== 0 || !this.map) throw new Error('Enter a character in the verified game build first.');
    if (validated.map !== this.map) throw new Error('Map changed. Choose monsters on the current map before starting.');
    if (p.dead || p.maxHp <= 0 || p.hp / p.maxHp * 100 <= settings.minHpPercent) throw new Error('Recover above the HP stop limit before starting.');
    this.advanceMovement();
    const navigation = this.navigation();
    if (!navigation) throw new Error(`Verified walkability is not available for ${this.map}.`);
    if (!navigation.safe(p)) throw new Error('Move onto open ground away from portals before starting.');
    this.route = null; this.leg = null; this.routeFailures = 0; this.routeStep = validated.route_step;
    this.settings = validated;
    this.pending = null; this.excluded.clear();
    this.killedAt = []; this.dropCreatedAt.clear(); this.lootAfter = 0;
    this.running = true; this.runStarted = this.now(); this.lastTick = this.now(); this.lastAction = 0;
    this.reason = 'Looking for nearby targets.'; this.note('Started combat and loot.');
  }
  receive(events: GameEvent[]): void {
    this.advanceMovement();
    this.lastFrame = this.now();
    for (const event of events) this.apply(event);
  }
  private resetWorld(): void {
    this.motions.clear(); this.navigator = null; this.navigationMap = ''; this.route = null; this.leg = null; this.routeFailures = 0;
    this.entities.clear(); this.drops.clear(); this.foreignTargets.clear(); this.excluded.clear();
    this.killedAt = []; this.dropCreatedAt.clear(); this.pending = null; this.map = ''; this.playerId = 0;
  }
  private removed(id: number, dead: boolean): void {
    this.motions.delete(id);
    const entity = this.entities.get(id);
    if (dead && entity && this.pending?.type === 'attack' && this.pending.id === id) {
      this.kills++; this.killedAt.push({ x: entity.x, y: entity.y, at: this.now() });
      this.lootAfter = this.now() + 900;
      this.note(`Defeated ${entity.name}.`);
    }
    if (this.pending?.id === id && this.pending.type === 'attack') this.pending = null;
    if (this.route?.id === id) this.cancelRoute();
    this.foreignTargets.delete(id); this.entities.delete(id);
    if (id === this.playerId) this.stop(dead ? 'Character died. Recover manually before restarting.' : 'Character left the field.');
  }
  private apply(e: GameEvent): void {
    switch (e.type) {
      case 'enter':
        this.stop('Preparing character.'); this.resetWorld(); this.playerId = e.id; this.map = e.map; break;
      case 'map': {
        this.stop('Map changed. Press Start when ready.'); const id = this.playerId;
        this.resetWorld(); this.playerId = id; this.map = e.map; break;
      }
      case 'clear': {
        this.stop('World refreshed. Press Start when ready.'); const id = this.playerId; const map = this.map;
        this.resetWorld(); this.playerId = id; this.map = map; break;
      }
      case 'spawn':
        this.motions.delete(e.entity.id);
        // Keep only the current player and monsters; other player names are not retained.
        if (e.entity.id === this.playerId || e.entity.kind === 1) this.entities.set(e.entity.id, e.entity);
        if (e.entity.id === this.playerId && !this.running) { this.reason = 'Ready. Choose your targets and press Start.'; this.note('Character ready.'); }
        break;
      case 'tracking': break; // Minimap markers do not correct world movement.
      case 'stop':
        this.motions.delete(e.id); this.interrupted(e.id);
        break;
      case 'walk': {
        const entity = this.entities.get(e.id);
        if (!entity) break;
        Object.assign(entity, walkPosition(e.walk, 0));
        this.motions.delete(e.id);
        if (!e.walk.locked && e.walk.cells.length > 1) this.motions.set(e.id, { walk: e.walk, at: this.now() });
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
        const entity = this.entities.get(e.id); if (entity) Object.assign(entity, e.position); break;
      }
      case 'remove': this.removed(e.id, e.dead); break;
      case 'death':
        this.motions.delete(e.id);
        if (e.id === this.playerId && this.player) { this.player.dead = true; this.player.hp = 0; this.stop('Character died. Recover manually before restarting.'); }
        else this.removed(e.id, true);
        break;
      case 'resurrection': {
        this.motions.delete(e.id);
        const entity = this.entities.get(e.id);
        if (entity) { entity.dead = false; entity.hp = Math.min(e.hp, entity.maxHp); Object.assign(entity, e.position); }
        if (e.id === this.playerId) this.stop('Character revived. Press Start when ready.');
        break;
      }
      case 'attack': {
        this.motions.delete(e.source);
        const entity = this.entities.get(e.source); if (entity) Object.assign(entity, e.position);
        if (e.source !== this.playerId && this.entities.get(e.target)?.kind === 1) {
          this.foreignTargets.add(e.target);
          if ((this.pending?.type === 'attack' && this.pending.id === e.target) || (this.route?.type === 'attack' && this.route.id === e.target)) this.stop('Another character engaged this target.');
        }
        if (e.source === this.playerId && this.pending?.type === 'attack' && this.pending.id === e.target) { this.pending.progress = this.now(); this.pending.approachSince = null; }
        break;
      }
      case 'hit': {
        if (e.stops) { this.motions.delete(e.id); this.interrupted(e.id); }
        const entity = this.entities.get(e.id);
        if (entity) { entity.hp = Math.max(0, Math.min(entity.maxHp, entity.hp - e.damage)); Object.assign(entity, e.position); }
        break;
      }
      case 'heal': {
        const entity = this.entities.get(e.id); if (entity) { entity.hp = e.hp; entity.maxHp = e.maxHp; } break;
      }
      case 'stats': if (this.player) { this.player.hp = e.hp; this.player.maxHp = e.maxHp; this.player.level = e.level; } break;
      case 'drop':
        if (!this.drops.has(e.drop.id) && this.running && e.drop.isNew) this.dropCreatedAt.set(e.drop.id, this.now());
        this.drops.set(e.drop.id, e.drop); break;
      case 'pickup':
        if (e.picker === this.playerId && this.pending?.type === 'pickup' && this.pending.id === e.id) { this.looted++; this.note('Loot pickup confirmed.'); }
        this.drops.delete(e.id);
        this.dropCreatedAt.delete(e.id);
        if (this.pending?.type === 'pickup' && this.pending.id === e.id) this.pending = null;
        if (this.route?.type === 'pickup' && this.route.id === e.id) this.cancelRoute();
        break;
    }
    if (this.running && this.player && this.player.hp / this.player.maxHp * 100 <= this.settings.minHpPercent) this.stop('HP reached the stop limit. Recover manually.');
  }
  tick(): void {
    const now = this.now();
    this.advanceMovement();
    if (!this.running) return;
    if (now - this.lastTick > 5000) { this.stop('Mac slept or the game paused. Press Start to resume.'); return; }
    this.lastTick = now;
    const p = this.player;
    if (!p || !this.connected || !this.compatible) { this.stop('Game state is unavailable.'); return; }
    if (now - Math.max(this.lastFrame, this.runStarted) > 15000) { this.stop('No recent server updates.'); return; }
    if (p.dead || p.maxHp <= 0 || p.hp / p.maxHp * 100 <= this.settings.minHpPercent) { this.stop('HP reached the stop limit. Recover manually.'); return; }
    const nav = this.navigation();
    if (!nav || !nav.safe(p)) { this.stop('Character left verified walkable ground or entered a portal exclusion.'); return; }
    this.killedAt = this.killedAt.filter(k => now - k.at < 30000);
    if (this.pending) {
      const target = this.entities.get(this.pending.id);
      const approachExpired = this.pending.approachSince !== null
        && (now - this.pending.approachSince >= this.settings.attackMaxRouteTime * 1000
          || (this.pending.type === 'attack' && (!target || !this.plan(p, target, 1))));
      if (!approachExpired && now - this.pending.progress < 12000 && now - this.pending.since < 90000) return;
      this.excluded.set(this.pending.id, now + 30000); this.send({ type: 'stop' });
      this.reason = 'Target timed out or became unreachable; skipping it for 30 seconds.'; this.note(this.reason);
      this.pending = null; this.lastAction = now; return;
    }
    if (now < this.lootAfter) return;
    // Keep a chosen pursuit stable; a moving target is replanned after the current leg.
    if (this.route && this.route.type !== 'search') {
      const target = this.route.type === 'attack' ? this.entities.get(this.route.id!) : this.drops.get(this.route.id!);
      if (!target || (this.route.type === 'attack' && !this.eligible(target as Entity, now, false))) { this.cancelRoute(); return; }
      if (distance(cell(target), this.route.destination) !== 0) { this.route.destination = cell(target); this.route.cells = []; }
      this.routeTick(p, now); return;
    }
    if (now - this.lastAction < 250) return;
    const available = (id: number) => (this.excluded.get(id) ?? 0) <= now;
    if (this.settings.loot) {
      const candidates = [...this.drops.values()].filter(d => available(d.id) && distance(p, d) <= this.settings.radius
        && this.killedAt.some(k => distance(k, d) <= 3 && (this.dropCreatedAt.get(d.id) ?? -Infinity) >= k.at));
      const choice = this.bestRoute(p, candidates);
      if (choice) { this.pursue('pickup', choice.target.id, cell(choice.target), choice.cells); this.routeTick(p, now); return; }
    }
    const choice = this.bestRoute(p, [...this.entities.values()].filter(e => this.eligible(e, now)));
    if (choice) { this.pursue('attack', choice.target.id, cell(choice.target), choice.cells); this.routeTick(p, now); }
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
    return e.kind === 1 && !e.dead && e.hp > 0 && e.level <= this.player!.level + 1
      && (!acquiring || distance(this.player!, e) <= this.settings.radius) && !this.foreignTargets.has(e.id)
      && (this.excluded.get(e.id) ?? 0) <= now && this.settings.targets.includes(e.classId);
  }
  private plan(from: Position, to: Position, range: number): Position[] | null {
    return this.navigation()?.plan(cell(from), cell(to), {
      range, maxDistance: this.settings.attackRouteMaxPathDistance, avoidWalls: this.settings.route_avoidWalls,
    }) ?? null;
  }
  private bestRoute<T extends Position & { id: number }>(from: Position, candidates: T[]): { target: T; cells: Position[] } | null {
    let best: { target: T; cells: Position[]; cost: number } | null = null;
    for (const target of candidates) {
      const cells = this.plan(from, target, 1);
      if (!cells) continue;
      const cost = cells.reduce((sum, p, i) => sum + (i ? (p.x !== cells[i - 1]!.x && p.y !== cells[i - 1]!.y ? 14 : 10) : 0), 0);
      if (!best || cost < best.cost) best = { target, cells, cost };
    }
    return best;
  }
  private pursue(type: 'attack' | 'pickup', id: number, destination: Position, cells: Position[]): void {
    // Finish an outstanding leg before changing destination; its reply has no request ID.
    this.route = { type, id, destination, cells, since: null };
    const target = type === 'attack' ? this.entities.get(id)?.name ?? 'monster' : 'loot';
    this.reason = `Selected ${target}; finishing the current walk before approaching.`;
  }
  private act(type: 'attack' | 'pickup', id: number): void {
    this.route = null; this.leg = null;
    this.send({ type, id }); this.lastAction = this.now();
    this.pending = { type, id, since: this.now(), progress: this.now(), approachSince: null };
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
      const entity = this.entities.get(id);
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
    const limit = route.type === 'search' ? this.settings.route_randomWalk_maxRouteTime : this.settings.attackMaxRouteTime;
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
    const range = route.type === 'search' ? 0 : 1;
    const index = route.cells.findIndex(c => distance(c, p) === 0);
    if (index >= 0) route.cells = route.cells.slice(index);
    else route.cells = [];
    if (!route.cells.length) route.cells = (route.type === 'search'
      ? nav.plan(p, route.destination, { avoidWalls: this.settings.route_avoidWalls })
      : this.plan(p, route.destination, range)) ?? [];
    if (!route.cells.length) {
      if (route.id !== undefined) this.excluded.set(route.id, now + 30000);
      this.cancelRoute(); this.reason = 'Destination is unreachable; choosing another goal.'; return;
    }
    if (route.cells.length === 1) {
      if (route.type !== 'search') this.act(route.type, route.id!);
      else { this.route = null; this.reason = 'Search destination reached.'; }
      return;
    }
    if (now - this.lastAction < 250) return;
    const cells = routeSegment(route.cells, Math.min(this.routeStep, 20));
    const destination = cells.at(-1)!;
    // Only time this task's own movement. An inherited search/stop leg has a
    // separate acceptance deadline and must not consume the pursuit budget.
    route.since ??= now;
    this.leg = { destination, cells, since: now, acceptedUntil: null };
    this.send({ type: 'walk', destination }); this.lastAction = now;
    this.reason = `${route.type === 'search' ? 'Searching' : route.type === 'attack' ? 'Approaching monster' : 'Approaching loot'} · walking to ${destination.x}, ${destination.y}.`;
  }
  snapshot(): Snapshot {
    const nav = this.navigation();
    const navigation: NavigationStatus | null = nav ? {
      ...nav.summary(this.player ?? { x: -1, y: -1 }), ready: !!this.player && nav.safe(this.player),
      mode: this.route?.type ?? 'idle', goal: this.route?.destination ?? null,
      route: this.route?.cells.slice(0, 512) ?? [], leg: this.leg?.cells ?? [], routeLength: Math.max(0, (this.route?.cells.length ?? 1) - 1),
    } : null;
    return {
      connected: this.connected, compatible: this.compatible, running: this.running, reason: this.reason,
      map: this.map, player: this.player ? { ...this.player } : null,
      monsters: [...this.entities.values()].filter(e => e.kind === 1).slice(0,150),
      drops: [...this.drops.values()].slice(0,150), attacks: this.attacks, kills: this.kills,
      looted: this.looted, target: this.pending?.type === 'attack' ? this.entities.get(this.pending.id)?.name ?? '' : this.route?.type === 'attack' ? this.entities.get(this.route.id!)?.name ?? '' : '',
      log: this.log.slice(), navigation,
    };
  }
}

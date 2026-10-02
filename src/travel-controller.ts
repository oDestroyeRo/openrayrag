import { DEFAULT_MAP_POLICY, insideLockArea, mapAllowed, type MapPolicy } from './map-policy';
import type { Entity, GameEvent, Position, Walk } from './protocol';
import type { Action } from './engine';
import { distance, GridNavigator, routeSegment, searchGrid, type WalkGrid } from './navigation';
import { walkDuration } from './movement';
import { planArrivalEscape, planPortalApproach, routeBetweenMaps, travelNavigator, type TravelStep } from './travel';

export interface TravelSnapshot {
  state: 'idle' | 'walking' | 'transition' | 'complete' | 'failed' | 'cancelled';
  destination: string; reason: string; policy: MapPolicy; purpose: 'travel' | 'service' | 'return' | 'field-entry'; remainingMaps: string[]; route: Position[]; leg: Position[];
}
const cell = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y) });

/** Owns movement only while the field engine is stopped. Never infers a map transition from elapsed time. */
export class TravelController {
  private policy:MapPolicy=DEFAULT_MAP_POLICY;
  private purpose:TravelSnapshot['purpose']='travel';
  private state: TravelSnapshot['state'] = 'idle';
  private destination = '';
  private reason = '';
  private steps: TravelStep[] = [];
  private route: Position[] = [];
  private map = '';
  private playerId: number | null = null;
  private since = 0;
  private deadline = 0;
  private lastAction = 0;
  private awaitingSpawn = false;
  private finalEscape = false;
  private avoidWalls = true;
  private stepSize = 10;
  private consecutiveNudges = 0;
  private nudgeNavigator: GridNavigator | null = null;
  private approachNav: GridNavigator | null = null;
  private approachTarget: Position | null = null;
  private leg: { cells: Position[]; since: number; acceptedUntil: number | null; nudged: boolean } | null = null;
  constructor(private readonly send: (action: Action) => void, private readonly now = Date.now, private readonly gridFor: (map: string) => WalkGrid | null = searchGrid) {}
  get active(): boolean { return this.state === 'walking' || this.state === 'transition'; }

  start(map: string, player: Entity, destination: string, stepSize: number, avoidWalls: boolean, policy:MapPolicy=DEFAULT_MAP_POLICY, purpose:TravelSnapshot['purpose']='travel'): void {
    if (this.active) throw new Error('Stop the current trip first.');
    if (!Number.isInteger(stepSize) || stepSize < 1 || stepSize > 20) throw new Error('Invalid travel step size.');
    if(!mapAllowed(policy,destination))throw new Error('The destination map is forbidden by the map policy.');
    const steps = routeBetweenMaps(map, cell(player), destination, avoidWalls,policy);
    if (!steps) throw new Error(`No verified route connects this position to the destination under the map policy.${!mapAllowed(policy,map)?' Current map is forbidden: departure only; reentry is prohibited.':''}`);
    this.policy=structuredClone(policy);this.purpose=purpose;
    this.approachNav = null; this.approachTarget = null;
    this.steps = steps; this.destination = destination; this.map = map; this.playerId = player.id;
    this.stepSize = stepSize; this.avoidWalls = avoidWalls; this.since = this.now(); this.deadline = this.now() + 20_000;
    this.leg = null; this.awaitingSpawn = false; this.finalEscape = false; this.lastAction = 0;
    this.consecutiveNudges = 0; this.nudgeNavigator = null;
    this.state = 'walking'; this.plan(player);
  }

  /** Bounded final approach shares the trip's accepted-leg ownership and deadlines. */
  startApproach(map: string, player: Entity, target: Position, stepSize = 10, policy:MapPolicy=DEFAULT_MAP_POLICY,purpose:TravelSnapshot['purpose']='service'): void {
    if (this.active) throw new Error('Stop the current trip first.');
    if (!Number.isInteger(stepSize) || stepSize < 1 || stepSize > 20) throw new Error('Invalid travel step size.');
    if(!mapAllowed(policy,map))throw new Error('The approach map is forbidden by the map policy.');
    if(purpose==='field-entry'&&!insideLockArea(policy,map,target))throw new Error('Entry target must be inside the field lock area.');
    const grid = this.gridFor(map);
    if (!grid) throw new Error('No verified collision map for the final approach.');
    const nav = new GridNavigator(grid);
    const destination = { ...target };
    const route = nav.plan(cell(player),destination,{avoidWalls:true});
    if (!route?.length || route.length > 512) throw new Error('The final approach is unreachable or exceeds 512 cells.');
    this.policy=structuredClone(policy);this.purpose=purpose;
    this.approachNav = nav; this.approachTarget = destination; this.consecutiveNudges = 0; this.nudgeNavigator = null; this.steps = []; this.destination = map; this.map = map; this.playerId = player.id;
    this.stepSize = stepSize; this.route = route; this.finalEscape = true; this.leg = null; this.awaitingSpawn = false;
    this.since = this.now(); this.lastAction = 0; this.state = 'walking'; this.reason = purpose==='field-entry'?'Entering the field lock area.':'Approaching the NPC on verified ground.';
  }

  private plan(player: Entity): void {
    const step = this.steps[0];
    const route = this.approachNav
      ? this.approachTarget ? this.approachNav.plan(cell(player), this.approachTarget, { avoidWalls: true }) : null
      : step ? planPortalApproach(this.map, cell(player), step.portal, this.avoidWalls)
        : planArrivalEscape(this.map, cell(player), this.avoidWalls);
    if (!route?.length || this.approachNav && route.length > 512) {
      this.cancel(this.approachNav ? 'The final approach is unreachable or exceeds 512 cells.' : 'Arrival or next portal is unreachable on verified ground.', true); return;
    }
    this.route = route; this.finalEscape = !step; this.leg = null;
    this.state = 'walking';
    this.reason = this.approachNav ? (this.purpose==='field-entry'?'Entering the field lock area.':'Approaching the NPC on verified ground.') : step ? `Travel to ${this.destination}: approaching the portal to ${step.portal.toMap}.`
      : `Arrived in ${this.destination}; leaving the portal area.`;
    if(!mapAllowed(this.policy,this.map))this.reason+=' Current map is forbidden: departure only; no reentry.';
  }

  observe(events: GameEvent[]): void {
    for (const event of events) {
      if (!this.active) return;
      if (event.type === 'death' && event.id === this.playerId) { this.cancel('Travel stopped because the character died.', true); continue; }
      if (event.type === 'enter') { this.cancel('Travel stopped because the game session changed.', true); continue; }
      if (event.type === 'map') {
        const step = this.steps[0];
        if (!step || event.map !== step.portal.toMap || !this.leg && this.state !== 'transition') {
          this.cancel('Travel stopped after an unexpected map transition.', true); continue;
        }
        // A map event is accepted only while approaching the final trigger tile,
        // never during an unrelated leg elsewhere on the same source map.
        const end = this.leg?.cells.at(-1) ?? this.route.at(-1);
        if (!end || !this.inPortal(end, step)) { this.cancel('Map changed before the planned portal was reached.', true); continue; }
        this.map = event.map; this.awaitingSpawn = true; this.leg = null; this.route = []; this.nudgeNavigator = null;
        this.state = 'transition'; this.deadline = this.now() + 20_000; this.reason = `Loading ${event.map}.`;
      } else if (event.type === 'spawn' && event.entity.id === this.playerId && this.awaitingSpawn) {
        const expected = this.steps[0]?.portal.arrival;
        if (!expected || distance(expected, event.entity) > 6) { this.cancel('Portal arrival did not match its verified destination.', true); continue; }
        this.awaitingSpawn = false; this.steps.shift(); this.plan(event.entity);
      } else if (event.type === 'walk' && event.id === this.playerId) {
        if (this.acceptNudge(event.walk)) continue;
        const nav = this.approachNav ?? travelNavigator(this.map, this.route);
        if (!this.leg || this.leg.acceptedUntil !== null || !nav || event.walk.locked || event.walk.cells.length < 1 || event.walk.cells.length > 21
          || distance(cell(event.walk.origin), this.leg.cells[0]!) > 1
          || distance(event.walk.cells[0]!, this.leg.cells[0]!) > 1
          || distance(event.walk.cells.at(-1)!, this.leg.cells.at(-1)!) !== 0
          || !nav.validRoute(event.walk.cells) || walkDuration(event.walk) > 15_000) {
          this.cancel('Travel received an unverified or interrupted movement route.', true); continue;
        }
        this.leg.cells = event.walk.cells;
        this.leg.acceptedUntil = this.now() + walkDuration(event.walk) + 100;
      } else if ((event.type === 'position' || event.type === 'stop') && event.id === this.playerId && this.leg) {
        const step = this.steps[0];
        if (event.type === 'position' && step && this.leg.acceptedUntil !== null && !this.leg.nudged
          && this.now() - this.leg.since <= 19_000
          && this.inPortal(this.leg.cells.at(-1)!, step) && this.inPortal(event.position, step)
          && this.leg.cells.some(p => distance(p, event.position) === 0)) {
          // The portal script stops movement at its trigger before queuing the warp.
          // Wait for the actual expected map and spawn; the correction is not an arrival.
          this.leg = null; this.state = 'transition'; this.deadline = this.now() + 20_000;
          this.reason = 'Waiting for the planned map transition.'; continue;
        }
        this.cancel('Travel stopped after a movement correction. Choose the destination again.', true);
      }
    }
  }

  private acceptNudge(walk: Walk): boolean {
    const leg = this.leg;
    const duration = walkDuration(walk);
    if (!leg || leg.acceptedUntil === null || this.consecutiveNudges >= 4 || this.now() - leg.since > 19_000
      || this.now() > leg.acceptedUntil
      || walk.locked || walk.cells.length !== 2 || distance(walk.cells[0]!, leg.cells.at(-1)!) !== 0
      || distance(cell(walk.origin), walk.cells[0]!) > 1
      || !Number.isFinite(duration) || duration <= 0 || duration > 15_000) return false;
    if (!this.nudgeNavigator) {
      const grid = this.gridFor(this.map);
      if (!grid) return false;
      this.nudgeNavigator = this.approachNav ?? new GridNavigator(grid);
    }
    // Unlike a planned portal leg, a server occupancy adjustment cannot enter a trigger.
    if (!this.nudgeNavigator.validRoute(walk.cells)) return false;
    leg.cells = walk.cells; leg.acceptedUntil = this.now() + duration + 100; leg.nudged = true;
    this.consecutiveNudges++; return true;
  }

  private inPortal(p: Position, step: TravelStep): boolean {
    const a = step.portal.area;
    return Math.abs(p.x - a.x) <= a.halfWidth && Math.abs(p.y - a.y) <= a.halfHeight;
  }
  tick(map: string, player: Entity | undefined): void {
    if (!this.active) return;
    const now = this.now();
    if (this.approachNav && now - this.since > 300_000) { this.cancel('Final NPC approach reached its five-minute limit.', true); return; }
    if (now - this.since > 1_200_000) { this.cancel('Travel reached its twenty-minute limit.', true); return; }
    if (this.state === 'transition') {
      if (now > this.deadline) this.cancel('The planned map transition was not confirmed. No retry was sent.', true);
      return;
    }
    if (!player || player.dead || map !== this.map) { this.cancel('Travel character or map state is unavailable.', true); return; }
    if (this.leg) {
      if (now - this.leg.since > 19_000) { this.cancel('Travel movement confirmation timed out. No retry was sent.', true); return; }
      if (this.leg.acceptedUntil !== null && now >= this.leg.acceptedUntil) {
        if (distance(cell(player), this.leg.cells.at(-1)!) !== 0) { this.cancel('Travel movement did not finish at its accepted destination.', true); return; }
        if (this.leg.nudged) this.plan(player);
        else { this.leg = null; this.consecutiveNudges = 0; }
        if (!this.active) return;
      } else {
        if (this.leg.acceptedUntil === null && now - this.leg.since > 4_000)
          this.cancel('Travel movement confirmation timed out. No retry was sent.', true);
        return;
      }
    }
    const index = this.route.findIndex(p => distance(p, cell(player)) === 0);
    if (index < 0) { this.cancel('Character left the planned travel corridor.', true); return; }
    this.route = this.route.slice(index);
    if (this.route.length === 1) {
      if (this.finalEscape) { this.state = 'complete'; this.reason = this.approachNav ? (this.purpose==='field-entry'?'Field lock entry confirmed.':'Final NPC approach confirmed.') : `Arrived in ${this.destination}. Choose targets before starting combat.`; }
      else { this.state = 'transition'; this.deadline = now + 20_000; this.reason = 'Waiting for the planned map transition.'; }
      return;
    }
    if (now - this.lastAction < 300) return;
    const cells = routeSegment(this.route, this.stepSize);
    this.leg = { cells, since: now, acceptedUntil: null, nudged: false };
    this.send({ type: 'walk', destination: cells.at(-1)! }); this.lastAction = now;
  }
  cancel(reason = 'Travel stopped by you.', failed = false): void {
    const wasActive = this.active;
    this.state = failed ? 'failed' : 'cancelled'; this.reason = reason;
    this.leg = null; this.route = []; this.awaitingSpawn = false;
    if (wasActive) this.send({ type: 'stop' });
  }
  snapshot(): TravelSnapshot {
    return { policy:structuredClone(this.policy),purpose:this.purpose,state: this.state, destination: this.destination, reason: this.reason,
      remainingMaps: this.steps.map(step => step.portal.toMap).slice(0,64), route: this.route.slice(0,512), leg: this.leg?.cells ?? [] };
  }
}

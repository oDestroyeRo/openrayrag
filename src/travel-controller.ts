import type { PlanningOptions } from './route-planning';
import { DEFAULT_MAP_POLICY, insideLockArea, mapAllowed, policyIdentity, type MapPolicy } from './map-policy';
import type { Entity, GameEvent, Position, Walk } from './protocol';
import type { Action } from './engine';
import { distance, GridNavigator, routeSegment, searchGrid, type WalkGrid } from './navigation';
import { walkDuration } from './movement';
import { planArrivalEscape, planPortalApproach, routeBetweenMaps, routeBetweenMapsAsync, travelNavigator, type TravelStep } from './travel';

export interface TravelSnapshot {
  state: 'idle' | 'planning' | 'walking' | 'transition' | 'complete' | 'failed' | 'cancelled';
  destination: string; reason: string; policy: MapPolicy; purpose: 'travel' | 'service' | 'return' | 'field-entry' | 'party-follow'; remainingMaps: string[]; route: Position[]; leg: Position[];
}
export interface TravelTransition {
  trip:number; phase:'remove'|'clear'|'map'|'spawn'; fromMap:string; toMap:string; event:GameEvent;
}
export interface DatabaseTravelTransport {
  supported: (map: string) => boolean;
  /** Wait for server input cooldown before reserving or writing another request. */
  ready?: () => boolean;
  waitReason?: () => string;
  /** Reserve an existing owner's finite command allowance before any write. */
  reserve?: () => boolean;
  send: (map: string) => void;
}
interface DatabaseTrip {
  trip:number; fromMap:string; toMap:string; ownId:number; ownName:string; identity:string; connection:string;
  sent:boolean; phase:'source'|'departed'|'map'; ready:boolean; contradictory:boolean;
}
interface MovementReceipt {
  map:string; ownId:number; ownName:string; identity:string|null; requestedEnd:Position; cells:Position[]; acceptedUntil:number|null;
  expectedMap:string|null; expectedArrival:Position|null; portalArea:{x:number;y:number;halfWidth:number;halfHeight:number}|null; awaitingSpawn:boolean;
}
export interface TravelPlanningContext {
  /** Connection, world and observed own-actor lifetime, independent of actor ID reuse. */
  identity: string | null;
  /** Stable across map/actor replacement, changed on every transport reconnect. */
  connection?: string;
  map: string;
  player: Entity | undefined;
}
export interface TravelPlanningOptions {
  context?: () => TravelPlanningContext;
  dispatchReady?: () => boolean;
  /** Retain a requested trip through current-character official movement. */
  continueRequested?: () => boolean;
  databaseTravel?: DatabaseTravelTransport;
  /** The same verified retired walk may reconcile the transport's original endpoint owner. */
  retiredWalkAccepted?: (requested:Position,accepted:Position) => void;
  scheduler?: PlanningOptions['scheduler'];
  plan?: typeof routeBetweenMapsAsync;
}
interface PlanningRequest {
  generation: number;
  abort: AbortController;
  identity: string | null;
  start: Position;
  policy: string;
}
const cell = (p: Position): Position => ({ x: Math.floor(p.x), y: Math.floor(p.y) });

/** Owns movement only while the field engine is stopped. Never infers a map transition from elapsed time. */
export class TravelController {
  private planning: PlanningRequest | null = null;
  private generation = 0;
  private trip = 0;
  private ownName = '';
  private transitionFrom = '';
  private lastMovement:MovementReceipt|null=null;
  private retiredMovement:MovementReceipt|null=null;
  private executionIdentity: string | null = null;
  private officialWalkUntil=0;
  private officialArrival:1|2|null=null;
  private officialInputUntil=0;
  private preparedDeparture:TravelTransition|null=null;
  private officialDeparture:GameEvent|null=null;
  private databaseTrip:DatabaseTrip|null=null;
  private installedStart: Position | null = null;
  private latest: { map: string; player: Entity | undefined } = { map: '', player: undefined };
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
  constructor(private readonly send: (action: Action) => void, private readonly now = Date.now, private readonly gridFor: (map: string) => WalkGrid | null = searchGrid, private readonly planningOptions: TravelPlanningOptions = {}) {}
  get active(): boolean { return this.state === 'planning' || this.state === 'walking' || this.state === 'transition'; }

  get tripId():number {return this.trip;}
  get teleportPending():boolean {return !!this.databaseTrip?.sent;}
  get databasePreparing():boolean {return this.active&&!!this.databaseTrip&&!this.databaseTrip.sent;}
  officialGameplay():void {if(this.active&&!this.databaseTrip?.sent)this.officialInputUntil=this.now()+4_000;}
  observeReady():void {
    const trip=this.databaseTrip,context=this.planningOptions.context?.();
    if(trip?.sent&&!trip.contradictory&&trip.phase==='map'&&context?.connection===trip.connection&&context.map===trip.toMap)
      trip.ready=true;
  }
  /** Cancellation cannot erase a walk already written to the transport. */
  movementSettled(map:string,player:Entity|undefined):boolean {
    if(this.teleportPending)return false;
    const receipt=this.retiredMovement;
    if(receipt&&receipt.expectedMap===null&&receipt.acceptedUntil!==null&&this.now()>=receipt.acceptedUntil&&map===receipt.map&&player?.id===receipt.ownId
      &&player.name===receipt.ownName&&this.planningOptions.context?.().identity===receipt.identity&&distance(cell(player),receipt.cells.at(-1)!)===0)
      this.retiredMovement=null;
    return this.retiredMovement===null;
  }
  connectionChanged():void {this.retiredMovement=null;this.lastMovement=null;this.databaseTrip=null;}
  private observeRetired(event:GameEvent):void {
    const receipt=this.retiredMovement;if(!receipt)return;
    if(event.type==='map') {receipt.awaitingSpawn=event.map===receipt.expectedMap;return;}
    if(event.type==='spawn'&&receipt.awaitingSpawn&&event.entity.id===receipt.ownId&&event.entity.name===receipt.ownName
      &&event.entity.kind===0&&event.entryType===1&&!event.entity.dead&&event.entity.hp>0
      &&!!receipt.expectedArrival&&distance(receipt.expectedArrival,event.entity)<=6) {this.retiredMovement=null;return;}
    if(this.planningOptions.context&&this.planningOptions.context().identity!==receipt.identity)return;
    if(event.type==='walk'&&event.id===receipt.ownId&&!event.walk.locked&&event.walk.cells.length>0&&event.walk.cells.length<=21
      &&distance(cell(event.walk.origin),receipt.cells[0]!)<=1
      &&distance(event.walk.cells[0]!,receipt.cells[0]!)<=1
      &&event.walk.cells.every((p,index)=>!!receipt.cells[index]&&distance(p,receipt.cells[index]!)===0)
      &&travelNavigator(receipt.map,receipt.cells)?.validRoute(event.walk.cells)&&walkDuration(event.walk)>0&&walkDuration(event.walk)<=15_000) {
      receipt.cells=event.walk.cells.map(p=>({...p}));receipt.acceptedUntil=this.now()+walkDuration(event.walk)+100;
      if(!this.receiptAtPortal(receipt,event.walk.cells.at(-1)!)){receipt.expectedMap=null;receipt.expectedArrival=null;}
      const context=this.planningOptions.context?.();
      if(receipt.expectedMap===null&&context?.identity&&context.identity===receipt.identity&&context.map===receipt.map
        &&context.player?.id===receipt.ownId&&context.player.name===receipt.ownName)
        this.planningOptions.retiredWalkAccepted?.({...receipt.requestedEnd},{...event.walk.cells.at(-1)!});
    } else if(receipt.acceptedUntil!==null&&'id' in event&&event.id===receipt.ownId&&(event.type==='stop'||event.type==='position')
      &&(event.type==='position'?!this.receiptAtPortal(receipt,event.position):receipt.expectedMap===null))this.retiredMovement=null;
  }

  private receiptAtPortal(receipt:MovementReceipt,position:Position):boolean {
    const area=receipt.portalArea;
    return !!area&&Math.abs(position.x-area.x)<=area.halfWidth&&Math.abs(position.y-area.y)<=area.halfHeight;
  }

  /** Capture the source lifetime before applying the own removal erases it.
   * OutOfSight at the sent final portal leg holds uncertainty; it is not arrival. */
  prepareObservation(events:GameEvent[]):void {
    this.preparedDeparture=null;
    this.officialDeparture=null;
    const event=events.length===1?events[0]:undefined,step=this.steps[0],receipt=this.lastMovement,context=this.planningOptions.context?.();
    const trip=this.databaseTrip;
    if(!trip&&this.active&&this.purpose!=='party-follow'&&this.planningOptions.continueRequested?.()
      &&event?.type==='remove'&&event.id===this.playerId&&event.reason===0&&!event.dead
      &&context?.identity===this.executionIdentity&&context.map===this.map&&context.player?.id===this.playerId
      &&context.player.name===this.ownName&&context.player.kind===0&&!context.player.dead&&context.player.hp>0)
      this.officialDeparture=event;
    if(trip?.sent&&!trip.contradictory&&context?.connection===trip.connection&&event
      &&(event.type==='remove'&&event.id===trip.ownId&&event.reason===0&&!event.dead&&trip.phase==='source'
        ||event.type==='clear'&&trip.phase==='departed')
      &&(trip.phase==='source'&&context.identity===trip.identity&&context.map===trip.fromMap
        &&context.player?.id===trip.ownId&&context.player.name===trip.ownName&&context.player.kind===0&&!context.player.dead&&context.player.hp>0
        ||trip.phase==='departed'&&event.type==='clear')) {
      this.preparedDeparture={trip:trip.trip,phase:event.type,fromMap:trip.fromMap,toMap:trip.toMap,event};return;
    }
    if(this.purpose!=='party-follow'||!this.active||this.state==='planning'||this.awaitingSpawn
      ||event?.type!=='remove'||event.reason!==0||event.dead||event.id!==this.playerId
      ||!step||!receipt||!context?.identity||context.identity!==this.executionIdentity||receipt.identity!==context.identity
      ||context.map!==this.map||receipt.map!==this.map||receipt.expectedMap!==step.portal.toMap
      ||context.player?.id!==receipt.ownId||context.player.name!==this.ownName||context.player.kind!==0||context.player.dead||context.player.hp<=0)return;
    const end=this.leg?.cells.at(-1)??(this.state==='transition'?this.route.at(-1):undefined);
    if(!end||!this.inPortal(end,step)||!this.receiptAtPortal(receipt,receipt.cells.at(-1)!))return;
    this.preparedDeparture={trip:this.trip,phase:'remove',fromMap:this.map,toMap:step.portal.toMap,event};
  }

  start(map: string, player: Entity, destination: string, stepSize: number, avoidWalls: boolean, policy:MapPolicy=DEFAULT_MAP_POLICY, purpose:TravelSnapshot['purpose']='travel'): void {
    if (this.active) throw new Error('Stop the current trip first.');
    if(!this.movementSettled(map,player))throw new Error('Waiting for the canceled travel movement to settle.');
    this.trip++;this.ownName=player.name;this.lastMovement=null;
    if (!Number.isInteger(stepSize) || stepSize < 1 || stepSize > 20) throw new Error('Invalid travel step size.');
    if(!mapAllowed(policy,destination))throw new Error('The destination map is forbidden by the map policy.');
    const database=this.planningOptions.databaseTravel;
    if(map!==destination&&purpose!=='party-follow'&&database?.supported(destination)) {
      const context=this.planningOptions.context?.();
      if(!context?.identity||context.connection===undefined||context.map!==map||context.player?.id!==player.id
        ||context.player.name!==player.name||context.player.kind!==0||context.player.dead||context.player.hp<=0
        ||distance(cell(context.player),cell(player))!==0)throw new Error('A current living own actor and connection are required for Database travel.');
      this.policy=structuredClone(policy);this.purpose=purpose;this.destination=destination;this.map=map;this.playerId=player.id;
      this.steps=[];this.route=[];this.leg=null;this.approachNav=null;this.approachTarget=null;this.awaitingSpawn=false;
      this.installedStart=null;this.executionIdentity=context.identity;this.since=this.now();this.deadline=this.now()+60_000;
      this.databaseTrip={trip:this.trip,fromMap:map,toMap:destination,ownId:player.id,ownName:player.name,
        identity:context.identity,connection:context.connection,sent:false,phase:'source',ready:false,contradictory:false};
      this.state='walking';this.reason=`Preparing Database teleport to ${destination}.`;return;
    }
    const steps = policy.mode === 'weighted' ? null : routeBetweenMaps(map, cell(player), destination, avoidWalls,policy);
    if (policy.mode !== 'weighted' && !steps) throw new Error(`No verified route connects this position to the destination under the map policy.${!mapAllowed(policy,map)?' Current map is forbidden: departure only; reentry is prohibited.':''}`);
    this.policy=structuredClone(policy);this.purpose=purpose;
    this.approachNav = null; this.approachTarget = null;
    this.steps = steps ?? []; this.destination = destination; this.map = map; this.playerId = player.id;
    this.stepSize = stepSize; this.avoidWalls = avoidWalls; this.since = this.now(); this.deadline = this.now() + 20_000;
    this.leg = null; this.awaitingSpawn = false; this.finalEscape = false; this.lastAction = 0;
    this.consecutiveNudges = 0; this.nudgeNavigator = null;
    this.latest = { map, player }; this.installedStart = null;
    this.executionIdentity = this.planningOptions.context?.().identity ?? null;
    if (policy.mode === 'weighted') {
      this.planWeighted(player);
      return;
    }
    this.state = 'walking'; this.plan(player);
  }

  /** Bounded final approach shares the trip's accepted-leg ownership and deadlines. */
  startApproach(map: string, player: Entity, target: Position, stepSize = 10, policy:MapPolicy=DEFAULT_MAP_POLICY,purpose:TravelSnapshot['purpose']='service'): void {
    if (this.active) throw new Error('Stop the current trip first.');
    if(!this.movementSettled(map,player))throw new Error('Waiting for the canceled travel movement to settle.');
    this.trip++;this.ownName=player.name;this.lastMovement=null;
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
    this.installedStart = null; this.executionIdentity = this.planningOptions.context?.().identity ?? null;
    this.approachNav = nav; this.approachTarget = destination; this.consecutiveNudges = 0; this.nudgeNavigator = null; this.steps = []; this.destination = map; this.map = map; this.playerId = player.id;
    this.stepSize = stepSize; this.route = route; this.finalEscape = true; this.leg = null; this.awaitingSpawn = false;
    this.since = this.now(); this.lastAction = 0; this.state = 'walking'; this.reason = purpose==='field-entry'?'Entering the field lock area.':'Approaching the NPC on verified ground.';
  }

  private planWeighted(player: Entity, unavailableReason = 'No verified route connects this position to the destination under the map policy.'): void {
    const context = this.planningOptions.context?.();
    if (context && (!context.identity || context.map !== this.map || !context.player || context.player.dead || context.player.id !== player.id || distance(cell(context.player), cell(player)) !== 0)) {
      this.state = 'failed'; this.reason = 'A current own actor lifetime is required for route planning.'; return;
    }
    const request: PlanningRequest = { generation: ++this.generation, abort: new AbortController(), identity: context?.identity ?? null, start: cell(player), policy: policyIdentity(this.policy) };
    this.planning = request; this.steps = []; this.route = []; this.installedStart = null; this.state = 'planning';
    this.reason = `Planning a verified route to ${this.destination}. Stop cancels planning.`;
    // Ownership is visible before the planner can schedule its first slice.
    try {
      void (this.planningOptions.plan ?? routeBetweenMapsAsync)(this.map, request.start, this.destination, this.avoidWalls, this.policy,
        { signal: request.abort.signal, scheduler: this.planningOptions.scheduler }).then(result => {
        if (this.planning !== request || request.generation !== this.generation) return;
        if (!this.planningCurrent(request)) { this.cancel('Route planning state changed. Choose the destination again.', true); return; }
        if (!result) { this.cancel(unavailableReason, true); return; }
        this.steps = result; this.installedStart = { ...request.start };
        const current = this.planningOptions.context?.() ?? this.latest;
        this.plan(current.player!, result[0]?.cells);
        if (this.planning === request) this.planning = null;
      }).catch(error => {
        if (this.planning === request && request.generation === this.generation)
          this.cancel(error instanceof Error ? error.message : 'Route planning failed.', true);
      });
    } catch (error) {
      if (this.planning === request && request.generation === this.generation)
        this.cancel(error instanceof Error ? error.message : 'Route planning failed.', true);
    }
  }

  private planningCurrent(request: PlanningRequest): boolean {
    const context = this.planningOptions.context?.() ?? this.latest;
    return !request.abort.signal.aborted && this.state === 'planning' && this.map === context.map
      && !!context.player && !context.player.dead && context.player.id === this.playerId
      && distance(cell(context.player), request.start) === 0 && request.policy === policyIdentity(this.policy)
      && (!this.planningOptions.context || (context as TravelPlanningContext).identity === request.identity);
  }
  private plan(player: Entity, verified?: Position[]): void {
    // A final approach belongs to its captured destination map. Official travel
    // can move the character elsewhere, but cannot carry that collision grid.
    if(this.approachTarget){
      const grid=this.map===this.destination?this.gridFor(this.map):null;
      this.approachNav=grid?new GridNavigator(grid):null;
      if(this.map===this.destination&&!grid){this.cancel('No verified collision map for the retained final approach.',true);return;}
    }
    const step = this.steps[0];
    const route = verified ?? (this.approachNav
      ? this.approachTarget ? this.approachNav.plan(cell(player), this.approachTarget, { avoidWalls: true }) : null
      : step ? planPortalApproach(this.map, cell(player), step.portal, this.avoidWalls)
        : planArrivalEscape(this.map, cell(player), this.avoidWalls));
    if (!route?.length || this.approachNav && route.length > 512) {
      this.cancel(this.approachNav ? 'The final approach is unreachable or exceeds 512 cells.' : 'Arrival or next portal is unreachable on verified ground.', true); return;
    }
    this.route = route; this.finalEscape = !step; this.leg = null;
    this.state = 'walking';
    this.reason = this.approachNav ? (this.purpose==='field-entry'?'Entering the field lock area.':'Approaching the NPC on verified ground.') : step ? `Travel to ${this.destination}: approaching the portal to ${step.portal.toMap}.`
      : `Arrived in ${this.destination}; leaving the portal area.`;
    if(!mapAllowed(this.policy,this.map))this.reason+=' Current map is forbidden: departure only; no reentry.';
  }

  observe(events: GameEvent[]): TravelTransition[] {
    const proofs:TravelTransition[]=[];
    const departure=this.preparedDeparture;this.preparedDeparture=null;
    for (const event of events) {
      this.observeRetired(event);
      if(this.databaseTrip) {this.observeDatabase(event,departure,proofs);continue;}
      if (!this.active) continue;
      if(this.planningOptions.continueRequested?.()&&this.purpose!=='party-follow'){
        if(event===this.officialDeparture){
          this.officialDeparture=null;
          this.generation++;this.planning?.abort.abort();this.planning=null;
          const step=this.steps[0],end=this.leg?.cells.at(-1)??this.route.at(-1);
          if(step&&end&&this.inPortal(end,step)&&this.now()>=this.officialInputUntil){
            this.state='transition';this.deadline=this.now()+20_000;
            this.reason='Waiting for the planned map transition.';
          }else{
            this.officialArrival=1;this.lastMovement=null;this.leg=null;this.route=[];this.installedStart=null;
            this.state='transition';this.reason='Waiting for the same character after official travel.';
          }
          continue;
        }
        if(event.type==='map'||event.type==='clear'){
          const step=this.steps[0],end=this.leg?.cells.at(-1)??(this.state==='transition'?this.route.at(-1):undefined);
          if(!(event.type==='map'&&step&&event.map===step.portal.toMap&&end&&this.inPortal(end,step))){
            this.generation++;this.planning?.abort.abort();this.planning=null;
            this.officialArrival=event.type==='map'?1:2;this.officialWalkUntil=0;
            this.lastMovement=null;this.leg=null;this.route=[];this.installedStart=null;
            this.state='transition';this.reason='Waiting for the same character after official travel.';continue;
          }
        }
        if(event.type==='spawn'&&this.officialArrival!==null&&event.entity.id===this.playerId){
          const context=this.planningOptions.context?.();
          if(event.entity.name!==this.ownName||event.entity.kind!==0||event.entryType!==this.officialArrival
            ||event.entity.dead||event.entity.hp<=0||!context?.identity){this.cancel('Official travel changed the captured character.',true);continue;}
          this.officialArrival=null;this.map=context.map;this.executionIdentity=context.identity;
          this.replanOfficial(event.entity);continue;
        }
        if(event.type==='walk'&&event.id===this.playerId&&!event.walk.locked
          &&(this.now()<this.officialInputUntil||!!this.officialWalkUntil)){
          const end=event.walk.cells.at(-1),owned=!!this.leg&&distance(end??cell(event.walk.origin),this.leg.cells.at(-1)!)===0
            &&event.walk.cells.length<=21&&(this.approachNav??travelNavigator(this.map,this.route))?.validRoute(event.walk.cells);
          if(!owned&&end){
            this.generation++;this.planning?.abort.abort();this.planning=null;
            this.officialWalkUntil=this.now()+walkDuration(event.walk)+100;
            this.lastMovement=null;this.leg=null;this.route=[];this.installedStart=null;
            this.state='walking';this.reason='Waiting for official movement before replanning the trip.';continue;
          }
        }
        if((event.type==='stop'||event.type==='position')&&event.id===this.playerId
          &&(this.officialWalkUntil||this.now()<this.officialInputUntil)){
          this.generation++;this.planning?.abort.abort();this.planning=null;
          this.officialWalkUntil=this.now()+300;this.lastMovement=null;this.leg=null;this.route=[];
          this.reason='Waiting for official movement before replanning the trip.';continue;
        }
      }
      if (this.state === 'planning') {
        if (event.type === 'map' || event.type === 'enter' || event.type === 'clear'
          || event.type === 'spawn' && event.entity.id === this.playerId
          || 'id' in event && event.id === this.playerId && ['remove','death','walk','position','stop'].includes(event.type))
          this.cancel('Route planning state changed. Choose the destination again.', true);
        continue;
      }
      if (event.type === 'death' && event.id === this.playerId) { this.cancel('Travel stopped because the character died.', true); continue; }
      if(event.type==='remove'&&event.id===this.playerId&&this.purpose==='party-follow') {
        if(!departure||departure.event!==event||departure.trip!==this.trip||departure.fromMap!==this.map||departure.toMap!==this.steps[0]?.portal.toMap) {
          this.cancel('Travel stopped after an unverified own removal.',true);continue;
        }
        proofs.push(departure);this.state='transition';this.deadline=this.now()+20_000;
        this.reason='Waiting for the planned map transition.';continue;
      }
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
        this.transitionFrom=this.map;proofs.push({trip:this.trip,phase:'map',fromMap:this.map,toMap:event.map,event});
        if(this.lastMovement)this.lastMovement.awaitingSpawn=true;
        this.map = event.map; this.awaitingSpawn = true; this.leg = null; this.route = []; this.nudgeNavigator = null;
        this.state = 'transition'; this.deadline = this.now() + 20_000; this.reason = `Loading ${event.map}.`;
      } else if (event.type === 'spawn' && event.entity.id === this.playerId && this.awaitingSpawn) {
        const expected = this.steps[0]?.portal.arrival;
        if (!expected || distance(expected, event.entity) > 6 || this.purpose==='party-follow'&&(event.entity.name!==this.ownName||event.entity.kind!==0||event.entryType!==1||event.entity.dead||event.entity.hp<=0)) { this.cancel('Portal arrival did not match its verified destination.', true); continue; }
        proofs.push({trip:this.trip,phase:'spawn',fromMap:this.transitionFrom,toMap:this.map,event});this.lastMovement=null;
        this.executionIdentity = this.planningOptions.context?.().identity ?? null;
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
        if(this.lastMovement){this.lastMovement.cells=event.walk.cells.map(p=>({...p}));this.lastMovement.acceptedUntil=this.leg.acceptedUntil;}
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
    return proofs;
  }

  private observeDatabase(event:GameEvent,departure:TravelTransition|null,proofs:TravelTransition[]):void {
    const trip=this.databaseTrip!,context=this.planningOptions.context?.();
    if(this.active&&this.now()>this.deadline)
      this.cancel('Database teleport was not confirmed before its deadline. No retry will be sent.',true);
    if(!trip.sent) {
      if(this.planningOptions.continueRequested?.()){
        if(event.type==='walk'||event.type==='position'||event.type==='stop')return;
        if(event.type==='map'||event.type==='clear'){
          this.officialArrival=event.type==='map'?1:2;this.reason='Waiting for the same character before Database travel.';return;
        }
        if(event.type==='spawn'&&this.officialArrival!==null&&event.entity.id===trip.ownId){
          if(event.entity.name!==trip.ownName||event.entity.kind!==0||event.entryType!==this.officialArrival
            ||event.entity.dead||event.entity.hp<=0||context?.connection!==trip.connection||!context.identity){
            this.cancel('Database travel changed the captured character before dispatch.',true);return;
          }
          this.officialArrival=null;trip.fromMap=context.map;trip.identity=context.identity;this.map=context.map;
          if(context.map===trip.toMap){this.databaseTrip=null;this.state='complete';this.reason='Requested destination observed after official travel.';}
          return;
        }
        if(event.type==='remove'&&event.id===trip.ownId&&!event.dead&&event.reason===0)return;
      }
      if(event.type==='map'||event.type==='clear'||event.type==='enter'||event.type==='spawn'&&event.entity.id===trip.ownId
        ||'id' in event&&event.id===trip.ownId&&['remove','death','walk','position'].includes(event.type))
        this.cancel('Database travel source changed before dispatch.',true);
      return;
    }
    if(trip.contradictory||context?.connection!==trip.connection)return;
    const reject=(reason:string)=>{trip.contradictory=true;this.cancel(reason,true);};
    if(event.type==='enter'||event.type==='death'&&event.id===trip.ownId) {reject('Database travel character or connection changed. Waiting for reconnect.');return;}
    if(event.type==='remove'&&event.id===trip.ownId||event.type==='clear') {
      if(!departure||departure.event!==event||departure.trip!==trip.trip) {reject('Database travel departure did not match the captured living character.');return;}
      trip.phase='departed';proofs.push(departure);return;
    }
    if(event.type==='map') {
      if(trip.phase!=='departed'||event.map!==trip.toMap) {reject('Database travel received an unexpected map transition. No retry or walking fallback will be sent.');return;}
      trip.phase='map';proofs.push({trip:trip.trip,phase:'map',fromMap:trip.fromMap,toMap:trip.toMap,event});
      if(this.active)this.reason=`Loading ${trip.toMap}; waiting for the fresh living character.`;
      return;
    }
    if(event.type==='spawn'&&event.entity.id===trip.ownId) {
      if(trip.phase!=='map'||!trip.ready||context.map!==trip.toMap||!context.identity||context.identity===trip.identity
        ||context.player?.id!==trip.ownId||context.player.name!==trip.ownName
        ||event.entity.name!==trip.ownName||event.entity.kind!==0||event.entryType!==1||event.entity.dead||event.entity.hp<=0) {
        reject('Database travel arrival did not match the requested map and fresh living own character.');return;
      }
      proofs.push({trip:trip.trip,phase:'spawn',fromMap:trip.fromMap,toMap:trip.toMap,event});this.databaseTrip=null;
      if(this.active){this.map=trip.toMap;this.state='complete';this.reason=`Database teleport to ${trip.toMap} confirmed.`;}
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
    if(this.lastMovement){this.lastMovement.cells=walk.cells.map(p=>({...p}));this.lastMovement.acceptedUntil=leg.acceptedUntil;}
    this.consecutiveNudges++; return true;
  }

  private inPortal(p: Position, step: TravelStep): boolean {
    const a = step.portal.area;
    return Math.abs(p.x - a.x) <= a.halfWidth && Math.abs(p.y - a.y) <= a.halfHeight;
  }
  private replanOfficial(player:Entity):void {
    if(this.approachTarget&&this.map===this.destination){this.steps=[];this.plan(player);return;}
    this.approachNav=null;
    // Keep the trip identity and its original total deadline when replanning.
    if(this.policy.mode==='weighted'){this.planWeighted(player,'No verified route from the observed official movement destination.');return;}
    const steps=routeBetweenMaps(this.map,cell(player),this.destination,this.avoidWalls,this.policy);
    if(!steps){this.cancel('No verified route from the observed official movement destination.',true);return;}
    this.steps=steps;this.plan(player);
  }
  tick(map: string, player: Entity | undefined): void {
    this.latest = { map, player };
    if (!this.active) return;
    const now = this.now();
    const trip=this.databaseTrip;
    if(trip) {
      if(now>this.deadline){this.cancel(trip.sent?'Database teleport was not confirmed. Waiting for authoritative arrival or reconnect; no retry will be sent.':'Database travel preparation timed out before sending a request.',true);return;}
      if(trip.sent)return;
      if(this.officialArrival!==null||!player){this.reason='Waiting for the original living character before Database travel.';return;}
      const context=this.planningOptions.context?.();
      if(!context||context.identity!==trip.identity||context.connection!==trip.connection||map!==trip.fromMap
        ||player?.id!==trip.ownId||player.name!==trip.ownName||player.dead||player.hp<=0) {
        this.cancel('Database travel source changed before dispatch.',true);return;
      }
      if(this.planningOptions.dispatchReady?.()===false){this.reason='Waiting for movement, resources and casts to settle before Database travel.';return;}
      if(this.planningOptions.databaseTravel!.ready?.()===false){this.reason=this.planningOptions.databaseTravel!.waitReason?.()??'Waiting briefly for the server input cooldown before Database travel.';return;}
      if(this.planningOptions.databaseTravel!.reserve?.()===false){this.cancel('Database travel command allowance exhausted before dispatch.',true);return;}
      // Reserve uncertainty before writing: a throwing socket may already have accepted bytes.
      trip.sent=true;this.state='transition';this.deadline=now+20_000;
      this.reason=`Database teleport to ${trip.toMap} sent; waiting for the server.`;
      try{this.planningOptions.databaseTravel!.send(trip.toMap);}catch{
        this.cancel('Database teleport write is uncertain. No retry or walking fallback will be sent.',true);
      }
      return;
    }
    if (this.approachTarget && now - this.since > 300_000) { this.cancel('Final NPC approach reached its five-minute limit.', true); return; }
    if (now - this.since > 1_200_000) { this.cancel('Travel reached its twenty-minute limit.', true); return; }
    if(this.officialArrival!==null){
      // The original total approach/trip ceiling above still advances. A
      // superseded portal leg's old twenty-second deadline owns no new arrival.
      return;
    }
    if(this.officialWalkUntil){
      if(now<this.officialWalkUntil)return;
      this.officialWalkUntil=0;
      if(player&&this.planningOptions.context?.().identity===this.executionIdentity)this.replanOfficial(player);
      else this.cancel('Official movement changed the captured character.',true);
      return;
    }
    if (this.planning) {
      if (!this.planningCurrent(this.planning)) this.cancel('Route planning state changed. Choose the destination again.', true);
      return;
    }
    if (this.state === 'transition') {
      if (now > this.deadline) this.cancel('The planned map transition was not confirmed. No retry was sent.', true);
      return;
    }
    const context = this.planningOptions.context?.();
    if (context && (!context.identity || context.identity !== this.executionIdentity || context.map !== this.map)) { this.cancel('Travel world or own actor lifetime changed.', true); return; }
    if (this.installedStart && player && distance(cell(player), this.installedStart) !== 0) { this.cancel('Starting cell changed after planning. Choose the destination again.', true); return; }
    if (!player || player.dead || map !== this.map) { this.cancel('Travel character or map state is unavailable.', true); return; }
    if (this.leg) {
      if (now - this.leg.since > 19_000) { this.cancel('Travel movement confirmation timed out. No retry was sent.', true); return; }
      if (this.leg.acceptedUntil !== null && now >= this.leg.acceptedUntil) {
        if (distance(cell(player), this.leg.cells.at(-1)!) !== 0) { this.cancel('Travel movement did not finish at its accepted destination.', true); return; }
        if (this.leg.nudged) this.plan(player);
        else { this.leg = null; this.consecutiveNudges = 0; if(!this.steps[0]||!this.inPortal(cell(player),this.steps[0]))this.lastMovement=null; }
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
    if(this.planningOptions.dispatchReady?.()===false){this.reason='Waiting for the current character action to settle before travel.';return;}
    const cells = routeSegment(this.route, this.stepSize);
    this.leg = { cells, since: now, acceptedUntil: null, nudged: false };
    this.installedStart = null;
    const portal=this.steps[0]&&this.inPortal(cells.at(-1)!,this.steps[0])?this.steps[0].portal:null;
    this.lastMovement={map:this.map,ownId:player.id,ownName:player.name,identity:this.planningOptions.context?.().identity??null,requestedEnd:{...cells.at(-1)!},cells:cells.map(p=>({...p})),acceptedUntil:null,
      expectedMap:portal?.toMap??null,expectedArrival:portal?{...portal.arrival}:null,portalArea:portal?{...portal.area}:null,awaitingSpawn:false};
    this.send({ type: 'walk', destination: cells.at(-1)! }); this.lastAction = now;
  }
  cancel(reason = 'Travel stopped by you.', failed = false): void {
    const wasActive = this.active && this.state !== 'planning'&&!this.databaseTrip;
    if(this.databaseTrip&&!this.databaseTrip.sent)this.databaseTrip=null;
    if(this.purpose==='party-follow'&&this.lastMovement)this.retiredMovement=structuredClone(this.lastMovement);
    this.lastMovement=null;
    this.officialArrival=null;this.officialWalkUntil=0;this.officialInputUntil=0;
    this.generation++; this.planning?.abort.abort(); this.planning = null; this.installedStart = null;
    this.state = failed ? 'failed' : 'cancelled'; this.reason = reason;
    this.leg = null; this.route = []; this.awaitingSpawn = false;
    if (wasActive) this.send({ type: 'stop' });
  }
  snapshot(): TravelSnapshot {
    return { policy:structuredClone(this.policy),purpose:this.purpose,state: this.state, destination: this.destination, reason: this.reason,
      remainingMaps: this.steps.map(step => step.portal.toMap).slice(0,64), route: this.route.slice(0,512), leg: this.leg?.cells ?? [] };
  }
}

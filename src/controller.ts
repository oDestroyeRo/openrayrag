import { BotEngine, type Action, type Snapshot } from './engine';
import { decode } from './protocol';
import { validateExpandedAction, type ExpandedAction } from './protocol-feature';
import { validateSettings, automationSettings, type Settings } from './settings';
import { decodeWorld, validateWorldAction, type WorldAction, type WorldEvent } from './world-protocol';
import { WorldState, type WorldSnapshot } from './world-state';
import { NpcWorkflow, validateWorkflowSpec, worldActionBlockers, type WorkflowContext, type WorkflowSnapshot, type WorkflowStep, createVendingReceipt, confirmVendingReceipt, type VendingReceipt } from './workflows';
import { RoutineRuntime, validateRoutineSpec, type RoutineObservation, type RoutineSnapshot, type RoutineSpec } from './routines';
import { TravelController, type TravelSnapshot } from './travel-controller';
import { inSchedule, actionConfirmationTimeout } from './automation';
import { searchGrid, type WalkGrid } from './navigation';
import type { InventoryItem } from './protocol-feature';
import { ITEM_CATALOG } from './game-catalog';
import { EmergencyEscape, validateEscapeResumeGuard, type EscapeContext, type EscapeSnapshot, type EscapeResumeGuard } from './escape';


export type ControllerAction = ExpandedAction | WorldAction;
export interface CompanionSnapshot extends Snapshot {
  runRequested: boolean; state: 'running' | 'waiting' | 'idle';
  world: WorldSnapshot; workflow: WorkflowSnapshot; routine: RoutineSnapshot; travel: TravelSnapshot;
  escape: EscapeSnapshot;
}
function expanded(value: unknown): value is ExpandedAction {
  try { validateExpandedAction(value); return true; } catch { return false; }
}
export function validControllerAction(value: unknown): value is ControllerAction {
  if (expanded(value)) return true;
  try { validateWorldAction(value); return true; } catch { return false; }
}
interface Pending {
  action: ControllerAction; since: number; routineId: number | null;
  engineSequence?: number; workflow?: boolean; sent?: boolean;
  generation: number; worldGeneration: number; map: string; npcId: number | null;
  receipt?: VendingReceipt;
  cart?: { source: InventoryItem; inventory: number; cart: number; acknowledged: boolean };
}

/** One owner for field automation, trips, NPC workflows and explicit manual actions. */
export class CompanionController {
  readonly engine: BotEngine;
  readonly world = new WorldState();
  readonly workflow: NpcWorkflow;
  readonly routine: RoutineRuntime<ControllerAction>;
  readonly travel: TravelController;
  readonly escape: EmergencyEscape;
  private pending: Pending | null = null;
  private lastFrame = 0;
  private lastTick = 0;
  private started = 0;
  private routineSpec: RoutineSpec<ControllerAction> | null = null;
  private travelSettings: Settings | null = null;
  private returnSettings: Settings | null = null;
  private returning = false;
  private requestedSettings: Settings | null = null;
  private runInitialized = false;
  private retryAt = 0;
  private retries = 0;
  private yieldUntil = 0;
  private heartbeatHealthy = true;
  private waitingReason = '';
  private blockedReason = '';
  private seenActionKey = '0:idle';
  private generation = 0;
  private connectionEpoch = 0;
  private fencedUntil = 0;
  private workflowDeadline = 0;
  private workflowTimeout = 10_000;
  private respawnRefresh = false;
  private runKills = 0;
  private runPickups = 0;
  private characterName: string | null = null;
  private featureReceipt: { action: ExpandedAction; count: number; stats: number; skills: number; attributes: number[] | null; level: number } | null = null;
  private unresolvedWorld: Pending | null = null;
  private workflowOutstanding: Pending | null = null;

  constructor(private readonly send: (action: Action | WorldAction) => void, private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid) {
    this.engine = new BotEngine(send, now, gridFor);
    this.workflow = new NpcWorkflow(now);
    this.routine = new RoutineRuntime(validControllerAction, now, { actionTimeoutSeconds: actionConfirmationTimeout({ type: 'skill' }) / 1000 });
    this.travel = new TravelController(send, now);
    this.escape = new EmergencyEscape(now);
  }
  get runRequested(): boolean { return this.requestedSettings !== null; }
  get connectionGeneration(): number { return this.connectionEpoch; }
  private get executing(): boolean {
    return this.engine.running || this.returning || this.travel.active || this.escape.inFlight || this.workflow.snapshot().running || !!this.pending
      || ['running','waiting'].includes(this.routine.snapshot().state);
  }
  get active(): boolean { return this.runRequested || this.executing; }
  connect(compatible: boolean): void {
    this.escape.connectionChanged();
    this.connectionEpoch++; this.cancelOwners('Connection changed.'); this.fencedUntil = 0; this.unresolvedWorld = null;
    this.world.reset(); this.engine.connect(compatible); this.lastFrame = this.now();
    this.waitingReason = this.engine.reason; this.retryAt = 0;
  }
  disconnect(): void {
    this.escape.connectionChanged();
    this.connectionEpoch++;
    try { this.pause('Waiting for the game to reconnect.'); }
    finally { this.world.reset(); this.engine.disconnect(); this.waitingReason = 'Waiting for the game to reconnect.'; }
  }
  fail(reason: string): void { try { this.pause(reason); } finally { this.engine.fail(reason); } }
  /** Every uncertain sent world request keeps its receipt until it is drained. */
  private retireWorld(pending: Pending | null = this.pending): void {
    const owner = pending && pending.engineSequence === undefined && (!pending.workflow || pending.sent)
      ? pending : this.workflowOutstanding;
    if (!owner) return;
    this.unresolvedWorld = { ...owner };
    this.fencedUntil = Math.max(this.fencedUntil, owner.since + 10_000, owner.workflow ? this.workflowDeadline : 0);
    this.workflowOutstanding = null;
  }
  private syncWorkflowOwner(): void {
    if (!this.workflowOutstanding) return;
    const state = this.workflow.snapshot();
    if (state.state === 'complete' || state.running && !state.pending) {
      this.workflowOutstanding = null; this.workflowDeadline = 0;
    } else if (!state.running) this.retireWorld(null);
  }
  private cancelOwners(reason: string): void {
    this.retireWorld();
    this.generation++; this.pending = null; this.routine.cancel(reason); this.workflow.cancel(reason);
    this.travel.cancel(reason); this.travelSettings = null;
    if (!this.runRequested) { this.returning = false; this.returnSettings = null; }
    this.respawnRefresh = false;
  }
  stop(reason = 'Stopped by you.'): void {
    this.requestedSettings = null; this.blockedReason = ''; this.waitingReason = '';
    this.yieldUntil = 0; this.retryAt = 0; this.retries = 0;
    this.pause(reason);
  }
  /** Retain the requested field run while yielding ownership of commands. */
  pause(reason: string, durationMs = 0): void {
    const externalActive = this.travel.active || this.workflow.snapshot().running || !!this.pending || this.escape.sent;
    const engineStops = this.engine.running || this.engine.pendingFeatureAction?.type === 'skill';
    this.escape.cancel(reason);
    this.captureActionFailure(); this.cancelOwners(reason); this.engine.stop(reason); this.captureActionFailure();
    this.yieldUntil = Math.max(this.yieldUntil, this.now() + durationMs);
    this.waitingReason = reason;
    if (externalActive && !engineStops && this.engine.connected) this.send({ type: 'stop' });
  }
  heartbeat(healthy: boolean): void {
    this.heartbeatHealthy = healthy;
    if (!healthy && this.executing) this.pause('Waiting for the client connection.');
  }
  private captureActionFailure(): void {
    const result = this.engine.actionResult; const action = this.engine.pendingFeatureAction;
    if (action) {
      this.featureReceipt = { action, count: action.type === 'useItem' ? this.engine.character.count(action.itemId) : 0,
        stats: this.engine.character.statsRevision, skills: this.engine.character.skillsRevision,
        attributes: this.engine.character.stats?.attributes?.slice() ?? null,
        level: action.type === 'allocateSkill' ? this.engine.character.learned.get(action.skillId) ?? 0 : 0 };
    }
    const key = `${result.sequence}:${result.status}`;
    if (key === this.seenActionKey) return;
    this.seenActionKey = key;
    if (result.status === 'confirmed') { this.featureReceipt = null; return; }
    if (!this.runRequested || result.status !== 'failed') return;
    const type = this.featureReceipt?.action.type;
    if (result.reason.startsWith('Server rejected')) {
      this.featureReceipt = null; this.retryAt = this.now() + 5_000; this.waitingReason = result.reason;
    } else if (type && ['useItem','allocateStats','allocateSkill','skill'].includes(type)) {
      this.blockedReason = `${result.reason} Waiting for a confirmed result; Stop and Start after checking to override.`;
    } else { this.featureReceipt = null; this.retryAt = this.now() + 250; }
  }
  private reconcileFeature(events: ReturnType<typeof decode>): void {
    const receipt = this.featureReceipt;
    if (!this.blockedReason || !receipt) return;
    const action = receipt.action; const state = this.engine.character;
    const confirmed = action.type === 'useItem' ? state.inventoryKnown && state.count(action.itemId) < receipt.count
      : action.type === 'allocateSkill' ? state.skillsRevision > receipt.skills && (state.learned.get(action.skillId) ?? 0) > receipt.level
      : action.type === 'allocateStats' ? state.statsRevision > receipt.stats && !!receipt.attributes && !!state.stats?.attributes
        && action.attributes.every((count, i) => state.stats!.attributes![i]! >= receipt.attributes![i]! + count)
      : action.type === 'skill' && events.some(event => event.type === 'skillResult' && event.source === this.engine.playerId
        && event.skillId === action.skillId && event.level === action.level && event.mode === action.mode && !event.indirect
        && (action.mode !== 'target' || event.target === action.target));
    if (!confirmed) return;
    const policy = automationSettings(this.requestedSettings!);
    const seconds = action.type === 'useItem' ? policy.items.find(rule => rule.itemId === action.itemId)?.cooldownSeconds ?? 1
      : action.type === 'skill' ? policy.skills.find(rule => rule.skillId === action.skillId)?.cooldownSeconds ?? 1 : 0;
    this.blockedReason = ''; this.featureReceipt = null; this.retryAt = this.now() + seconds * 1000;
    this.waitingReason = 'Canceled action was confirmed; waiting for its configured cooldown.';
  }
  private requireReady(): void {
    if (!this.engine.connected || !this.engine.compatible || !this.engine.player || !this.engine.map)
      throw new Error('Enter a character in the verified game build first.');
    if (this.now() - this.lastFrame > 15_000) throw new Error('Game status is stale.');
  }
  private requireIdle(): void {
    this.requireReady();
    if (this.active || this.escape.busy || this.unresolvedWorld || this.now() < this.fencedUntil || !this.engine.idleForActions()) throw new Error('Stop automation and wait for the current action to finish.');
  }
  start(input: Settings, escapeGuard?: EscapeResumeGuard): void {
    const settings = validateSettings(input);
    if (escapeGuard) validateEscapeResumeGuard(escapeGuard);
    if (this.active || this.engine.pendingFeatureAction)
      throw new Error('Stop the current automation or manual action before requesting a new run.');
    this.engine.acknowledgeLoadoutOverride();
    this.requestedSettings = settings; this.runInitialized = false; this.characterName = this.engine.player?.name ?? null; this.featureReceipt = null;
    this.started = this.now(); this.lastTick = this.now(); this.retryAt = 0; this.retries = 0;
    this.blockedReason = ''; this.waitingReason = 'Preparing the requested run.';
    this.seenActionKey = `${this.engine.actionResult.sequence}:${this.engine.actionResult.status}`;
    this.runKills = this.engine.kills; this.runPickups = this.engine.looted;
    if (escapeGuard) this.escape.restoreOnReconnect(settings, escapeGuard, this.escapeContext());
    this.tick();
  }

  context(): WorkflowContext {
    const engine = this.engine; const character = engine.character;
    return { map: engine.map, playerId: engine.playerId, alive: !!engine.player && !engine.player.dead,
      idle: engine.idleForActions(), inventory: character.inventoryKnown ? [...character.inventory.values()] : [],
      equipped: [...character.equipment, character.ammoId], zeny: character.stats?.zeny ?? -1,
      world: this.world, itemCatalog: ITEM_CATALOG, visibleNpcIds: [...engine.actors.values()].filter(e => e.kind === 2 || e.kind === 4).map(e => e.id),
      basicSkillLevel: character.skillsKnown ? character.skillLevel(1) : 0,
      pushCartLevel: character.skillsKnown ? character.skillLevel(73) : 0,
      vendingLevel: character.skillsKnown ? character.skillLevel(70) : 0 };
  }
  perform(mode: 'command' | 'workflow' | 'routine', input: unknown): void {
    this.requireIdle(); this.started = this.now(); this.lastTick = this.now();
    this.travelSettings = null; this.returnSettings = null; this.returning = false;
    if (mode === 'workflow') {
      if (!this.engine.character.inventoryKnown || this.engine.character.stats?.zeny === undefined)
        throw new Error('Wait for a confirmed inventory and balance before starting a workflow.');
      const spec = validateWorkflowSpec(input); this.workflowTimeout = spec.timeoutMs ?? 10_000; this.workflowOutstanding = null; this.workflowDeadline = 0;
      const result = this.workflow.start(spec, this.context());
      if (!result.ok) throw new Error(result.reasons.join(' '));
    } else if (mode === 'routine') {
      this.routineSpec = validateRoutineSpec(input, validControllerAction);
      this.routine.start(this.routineSpec);
    } else {
      if (!validControllerAction(input)) throw new Error('Unknown or invalid command.');
      this.dispatch(input, null);
    }
  }
  private dispatch(input: ControllerAction, routineId: number | null): void {
    if (this.escape.busy) throw new Error('Waiting for emergency escape to settle.');
    if (this.now() < this.fencedUntil) throw new Error('Waiting for the previous action deadline.');
    const binding = { generation: this.generation, worldGeneration: this.world.generation,
      map: this.engine.map, npcId: this.world.npc.id };
    if (expanded(input)) {
      this.engine.manualAction(input);
      this.pending = { action: input, since: this.now(), routineId, ...binding, engineSequence: this.engine.actionResult.sequence };
      return;
    }
    const action = validateWorldAction(input); const context = this.context();
    const blockers = worldActionBlockers(action, context);
    if (action.type === 'vendingView' && (this.world.npc.id !== null || this.world.npc.mode !== 'idle'))
      blockers.push('Finish the current NPC interaction before opening another vendor.');
    if (blockers.length) throw new Error(blockers.join(' '));
    const resource = this.resourceStep(action);
    if (resource) {
      if (!this.engine.character.inventoryKnown || context.zeny < 0 || this.world.npc.id === null)
        throw new Error('A confirmed NPC, inventory and balance are required.');
      const result = this.workflow.start({ name: 'Requested action', map: context.map, npcId: this.world.npc.id,
        maxSpend: Math.min(context.zeny, 2_000_000_000), minStock: [], steps: [resource] }, context);
      if (!result.ok) throw new Error(result.reasons.join(' '));
      this.workflowTimeout = 10_000; this.workflowOutstanding = null; this.workflowDeadline = 0;
      this.pending = { action, since: this.now(), routineId, ...binding, workflow: true, sent: false };
    } else {
      const receipt = action.type === 'vendingPurchase' ? createVendingReceipt(action, context) : undefined;
      const source = action.type === 'cart' ? (action.direction === 1
        ? this.engine.character.inventory.get(action.bagId) : this.world.cart.get(action.bagId)) : undefined;
      const cart = source ? { source: { ...source }, inventory: this.engine.character.count(source.itemId),
        cart: this.cartCount(source), acknowledged: false } : undefined;
      this.send(action); this.pending = { action, since: this.now(), routineId, ...binding,
        ...(receipt ? { receipt } : {}), ...(cart ? { cart } : {}) };
      this.engine.reason = `Sent ${action.type}; waiting for the game.`;
      this.engine.note(this.engine.reason);
    }
  }
  private resourceStep(action: WorldAction): WorkflowStep | null {
    if (action.type === 'shop') return action.rows.length ? { type: action.mode, rows: action.rows } : { type: 'closeShop' };
    if (action.type === 'storage') return action.operation === 'close' ? { type: 'closeStorage' }
      : { type: action.operation, bagId: action.bagId, count: action.count };
    if (action.type === 'npcBarter') return { type: 'barter', choice: action.choice, count: action.count, bagIds: action.bagIds };
    if (action.type === 'npcBarterCancel') return { type: 'cancelBarter' };
    return null;
  }
  private completePending(success: boolean, reason: string, uncertain = !success): void {
    const pending = this.pending;
    if (uncertain) this.retireWorld(pending);
    else if (!success) this.workflowOutstanding = null;
    this.pending = null;
    if (success) this.workflowDeadline = 0;
    if (!success && pending?.workflow) this.workflow.cancel(reason);
    if (pending?.routineId !== null && pending?.routineId !== undefined) this.routine.acknowledge(success, pending.routineId);
    this.engine.reason = reason; this.engine.note(reason);
  }
  receive(data: Uint8Array, connectionGeneration = this.connectionEpoch): void {
    if (connectionGeneration !== this.connectionEpoch) return;
    // Decode both owners before applying either so malformed packets cannot leak partial state.
    const events = decode(data); const worldEvents = decodeWorld(data) ?? [];
    this.captureActionFailure();
    const respawning = this.engine.snapshot().task.kind === 'respawn' && this.engine.actionResult.status === 'pending';
    this.lastFrame = this.now();
    for (const event of events) {
      if (event.type === 'enter') { this.pause('Preparing the reconnected character.'); this.world.reset(event.map); }
      else if (event.type === 'map' || event.type === 'clear') {
        // Travel owns expected transitions; field runs retain their selected species.
        if (this.pending || this.workflow.snapshot().running || ['running','waiting'].includes(this.routine.snapshot().state)) {
          this.retireWorld();
          this.generation++; this.workflow.cancel('Map changed.'); this.routine.cancel('Map changed.'); this.pending = null;
        }
        if (respawning && event.type === 'clear') this.respawnRefresh = true;
        this.world.reset(event.type === 'map' ? event.map : this.engine.map, true);
      }
    }
    this.engine.receive(events);
    const escaped = this.escape.observe(events, this.escapeContext());
    if (escaped && this.runRequested && automationSettings(this.requestedSettings!).travel.returnToLockMap
      && this.engine.map !== this.requestedSettings!.map) {
      this.returnSettings = structuredClone(this.requestedSettings!); this.returning = true;
    }
    if ((respawning || this.respawnRefresh) && this.returnSettings && events.some(event => event.type === 'map'
      || event.type === 'resurrection' && event.id === this.engine.playerId
      || event.type === 'spawn' && event.entity.id === this.engine.playerId && !event.entity.dead)) {
      this.returning = true;
    }
    this.travel.observe(events);
    for (const event of events) if (event.type === 'inventory' && event.cart !== undefined) this.world.replaceCart(event.cart);
    for (const event of worldEvents) {
      this.world.apply(event, this.engine.playerId);
      if (event.type === 'cartMoved') this.engine.character.applyCartWeights(event.cartWeight, event.currentWeight);
    }
    this.workflow.observe(worldEvents, this.context()); this.syncWorkflowOwner();
    if (this.pending) this.observeCart(this.pending, worldEvents);
    if (this.unresolvedWorld) {
      const owner = this.unresolvedWorld;
      this.observeCart(owner, worldEvents);
      if (owner.map !== this.engine.map || owner.worldGeneration !== this.world.generation
        || worldEvents.some(event => event.type === 'npcEnd')
        || (owner.receipt ? confirmVendingReceipt(owner.receipt, this.context())
          : owner.cart ? this.cartConfirmed(owner) : this.worldConfirmed(owner.action, worldEvents, owner)))
        this.unresolvedWorld = null;
    }
    this.reconcileFeature(events);
    if (events.some(event => event.type === 'requestFailure' || event.type === 'skillFailure') && this.pending) {
      this.workflowOutstanding = null; this.workflow.cancel('The game rejected the request.');
      this.completePending(false, 'The game rejected the request.', false);
    }
    if (this.pending && !this.pending.workflow && this.pending.engineSequence === undefined
      && this.pending.generation === this.generation && this.pending.worldGeneration === this.world.generation
      && this.pending.map === this.engine.map
      && (this.pending.receipt ? confirmVendingReceipt(this.pending.receipt, this.context())
        : this.pending.cart ? this.cartConfirmed(this.pending) : this.worldConfirmed(this.pending.action, worldEvents)))
      this.completePending(true, 'Game response confirmed.');
    if (events.some(event => event.type === 'death' && event.id === this.engine.playerId)) {
      this.retireWorld();
      this.generation++; this.workflow.cancel('Character died.'); this.routine.cancel('Character died.'); this.pending = null;
    }
    this.captureActionFailure();
    this.tick(); // React to authoritative changes without waiting for the polling interval.
  }
  private observeCart(pending: Pending, events: WorldEvent[]): void {
    if (!pending.cart || pending.action.type !== 'cart') return;
    const { cart, action } = pending;
    cart.acknowledged ||= events.some(event => event.type === 'cartMoved' && event.direction === action.direction
      && event.change === action.count && this.sameItem(event.item, cart.source)
      && (action.direction === 1 || event.item.bagId === action.bagId));
  }
  private sameItem(a: InventoryItem, b: InventoryItem): boolean {
    return a.itemId === b.itemId && a.type === b.type && (a.type !== 2 || !!a.guid && a.guid === b.guid);
  }
  private cartCount(source: InventoryItem): number {
    return [...this.world.cart.values()].reduce((sum, item) => sum + (this.sameItem(item, source) ? item.count : 0), 0);
  }
  private cartConfirmed(pending: Pending): boolean {
    if (!pending.cart || pending.action.type !== 'cart' || !pending.cart.acknowledged || !this.engine.character.inventoryKnown || !this.world.cartReady) return false;
    const { source, inventory, cart } = pending.cart; const action = pending.action;
    const direction = action.direction === 1 ? 1 : -1;
    const sourceItems = action.direction === 1 ? this.engine.character.inventory : this.world.cart;
    return (sourceItems.get(action.bagId)?.count ?? 0) === source.count - action.count
      && this.engine.character.count(source.itemId) === inventory - direction * action.count
      && this.cartCount(source) === cart + direction * action.count;
  }
  private worldConfirmed(action: ControllerAction, events: WorldEvent[], owner: Pending | null = this.pending): boolean {
    return events.some(event => {
      switch (action.type) {
        case 'npcTalk': return event.type === 'npcFocus' && event.id === action.id;
        case 'npcAdvance': case 'npcOption': return ['npcDialog','npcOptions','npcEnd','shopOpened','storageOpened','barterOpened'].includes(event.type);
        case 'cart': return false; // Correlated source decrease and destination gain are required.
        case 'partyCreate': return event.type === 'partyJoined' && event.name === action.name;
        case 'partyAccept': return event.type === 'partyJoined' && event.partyId === action.partyId;
        case 'partyLeave': case 'partyDisband': return event.type === 'partyLeft';
        case 'partyLeader': return event.type === 'partyLeader' && event.memberId === action.memberId;
        case 'partyRemove': return event.type === 'partyRemove' && event.memberId === action.memberId;
        case 'vendingStart': return event.type === 'vendingStarted' && event.name === action.name;
        case 'vendingStop': return event.type === 'vendingStopped';
        case 'vendingView': return event.type === 'vendingViewed' && (this.world.npc.id === null || this.world.npc.id === action.id)
          && owner?.worldGeneration === this.world.generation && owner.map === this.engine.map;
        // Invitations and vendor purchases do not have a correlated success packet.
        // A timeout remains uncertain and is never retried by this controller.
        default: return false;
      }
    });
  }
  private observation(): RoutineObservation {
    const p = this.engine.player; const c = this.engine.character;
    const inventory: Record<number, number> = {};
    if (c.inventoryKnown) {
      for (const rule of this.routineSpec?.rules ?? []) for (const condition of rule.conditions)
        if (condition.field === 'inventory') inventory[condition.itemId] = c.count(condition.itemId);
    }
    return { map: this.engine.map, ...(p?.maxHp ? { hpPercent: p.hp / p.maxHp * 100 } : {}),
      ...(c.stats?.maxSp ? { spPercent: (c.stats.sp ?? 0) / c.stats.maxSp * 100 } : {}),
      ...(c.stats?.zeny !== undefined ? { zeny: c.stats.zeny } : {}), ...(c.inventoryKnown ? { inventory } : {}) };
  }
  private wait(reason: string): void {
    this.waitingReason = reason; this.engine.reason = reason;
    if (this.engine.running || this.travel.active) this.pause(reason);
  }
  private escapeContext(): EscapeContext {
    const blocker = this.blockedReason || (this.featureReceipt ? 'Waiting for the previous resource action to settle.' : '')
      || (this.pending || this.workflow.snapshot().running || this.unresolvedWorld || ['running','waiting'].includes(this.routine.snapshot().state)
        ? 'Waiting for the current action owner before emergency escape.' : '')
      || (this.now() < this.fencedUntil || !this.engine.featureActionsSettled ? 'Waiting for the previous action and cast to settle.' : '')
      || (this.world.npc.mode !== 'idle' || this.world.npc.id !== null || this.world.vending ? 'Finish the NPC or vending interaction before escape.' : '')
      || (this.characterName && this.engine.player?.name !== this.characterName ? 'Waiting for the originally selected character.' : '')
      || (!this.gridFor(this.engine.map) ? `Verified walkability is not available for ${this.engine.map}.` : '');
    return { connected: this.engine.connected, compatible: this.engine.compatible, fresh: this.now() - this.lastFrame <= 15_000,
      map: this.engine.map, playerId: this.engine.playerId, player: this.engine.player, character: this.engine.character,
      connection: this.connectionEpoch, ready: !blocker && this.heartbeatHealthy && this.now() >= this.yieldUntil, blocker };
  }
  private escapeTick(): boolean {
    const context = this.escapeContext(); this.escape.update(context);
    if (this.requestedSettings && this.escape.wants(this.requestedSettings, context)) {
      // Stop/cancel movement first, then wait 250ms before the wing/skill. The
      // normal HP guard may already have sent Stop in this incoming packet.
      this.pause('Preparing emergency escape.'); this.escape.begin(this.requestedSettings, this.escapeContext());
    }
    if (this.escape.busy) {
      if (this.runRequested) {
        const action = this.escape.takeAction(this.escapeContext());
        if (action) {
          try { this.send(action); }
          catch { this.escape.cancel('Connection failed while sending escape.'); }
        }
      }
      this.waitingReason = this.escape.snapshot().reason; this.engine.reason = this.waitingReason;
      return true;
    }
    if (this.runRequested && this.escape.blocked) { this.waitingReason = this.escape.snapshot().reason || 'Waiting for HP recovery after escape.'; this.engine.reason = this.waitingReason; return true; }
    return false;
  }
  private resumeRun(): void {
    const settings = this.requestedSettings;
    if (!settings || this.engine.running || this.travel.active || this.pending || this.workflow.snapshot().running
      || ['running','waiting'].includes(this.routine.snapshot().state)) return;
    const now = this.now(); const policy = automationSettings(settings); const player = this.engine.player;
    if (this.escape.blocked) { this.waitingReason = this.escape.snapshot().reason; return; }
    if (this.blockedReason) { this.wait(this.blockedReason); return; }
    if (!this.heartbeatHealthy) { this.wait('Waiting for the client connection.'); return; }
    if (now < this.yieldUntil) { this.wait('Yielding briefly to manual game input.'); return; }
    if (now < this.fencedUntil || !this.engine.idleForActions()) { this.wait('Waiting for the previous action and movement to settle.'); return; }
    if (!this.engine.connected) { this.wait('Waiting for the game to reconnect.'); return; }
    if (!this.engine.compatible) { this.wait('Waiting for a verified game build and protocol.'); return; }
    if (!player || !this.engine.map) { this.wait('Waiting for the character and map to load.'); return; }
    this.characterName ??= player.name;
    if (player.name !== this.characterName) { this.wait('Waiting for the originally selected character.'); return; }
    if (this.unresolvedWorld) { this.wait('Waiting for the canceled world request to settle or its interaction to close.'); return; }
    if (policy.limits.weightPercent) {
      const stats = this.engine.character.stats;
      if (stats?.weight === undefined || !stats.maxWeight) { this.wait('Waiting for a confirmed weight update.'); return; }
      if (stats.weight / stats.maxWeight * 100 >= policy.limits.weightPercent) { this.wait('Waiting for carried weight to fall below the configured limit.'); return; }
    }
    if (now - this.lastFrame > 15_000) { this.wait('Waiting for a fresh server update.'); return; }
    if (player.dead && (!policy.respawn.enabled || this.engine.deaths > policy.respawn.maxDeaths)) {
      this.wait(policy.respawn.enabled ? 'Death limit reached; waiting for revival.' : 'Waiting for revival.'); return;
    }
    if (!player.dead && (!player.maxHp || player.hp / player.maxHp * 100 <= settings.minHpPercent)) {
      this.wait('Waiting for HP to recover above the configured limit.'); return;
    }
    if (this.world.npc.mode !== 'idle' || this.world.npc.id !== null || this.world.vending) {
      this.wait('Waiting for the current NPC or vending interaction to finish.'); return;
    }
    if (now < this.retryAt) return;
    try {
      const destination = this.returning && this.returnSettings ? this.returnSettings.map : policy.travel.destinationMap;
      if (!player.dead && destination && destination !== this.engine.map) {
        this.travel.start(this.engine.map, player, destination, settings.route_step, settings.route_avoidWalls);
        this.travelSettings = settings; this.waitingReason = ''; this.retries = 0;
      } else {
        const ground = this.gridFor(this.engine.map);
        if (!player.dead && ground?.walkable({ x: Math.floor(player.x), y: Math.floor(player.y) })
          && ground.portals?.some(area => Math.abs(player.x - area.x) <= area.halfWidth && Math.abs(player.y - area.y) <= area.halfHeight)) {
          this.travel.start(this.engine.map, player, this.engine.map, settings.route_step, settings.route_avoidWalls);
          this.travelSettings = settings; this.waitingReason = ''; return;
        }
        const bound = { ...settings, map: this.engine.map };
        if (this.runInitialized) this.engine.resumeRequested(bound);
        else { this.engine.start(bound, true); this.runInitialized = true; }
        this.returnSettings = policy.travel.returnToLockMap && (policy.respawn.enabled || policy.escape?.enabled) ? structuredClone(settings) : null;
        this.returning = false; this.travelSettings = null; this.waitingReason = ''; this.retries = 0;
      }
    } catch (error) {
      this.waitingReason = error instanceof Error ? error.message : 'Waiting for a verified reachable route.';
      this.engine.reason = this.waitingReason;
      this.retryAt = now + Math.min(5_000, 250 * 2 ** Math.min(this.retries++, 5));
    }
  }
  tick(): void {
    const now = this.now();
    this.escape.update(this.escapeContext());
    if (this.active && this.lastTick && now - this.lastTick > 5_000) {
      this.lastTick = now; this.pause('Waiting for fresh state after the Mac or game paused.', 1_000); return;
    }
    this.lastTick = now;
    if (this.runRequested && this.returnSettings && this.engine.player?.dead) this.returning = true;
    // Advance finite routine deadlines before any workflow can produce a packet.
    this.routine.advance();
    if (this.pending?.routineId !== null && this.pending?.routineId !== undefined
      && !['running','waiting'].includes(this.routine.snapshot().state)) {
      this.retireWorld();
      this.workflow.cancel('The owning routine ended.'); this.engine.stop('The owning routine ended.'); this.pending = null;
    }
    if (this.runRequested) {
      const policy = automationSettings(this.requestedSettings!);
      if (!inSchedule(policy, now)) { this.wait('Waiting for the configured daily schedule.'); return; }
      if (policy.limits.minutes > 0 && now - this.started >= policy.limits.minutes * 60_000
        || policy.limits.kills > 0 && this.engine.kills - this.runKills >= policy.limits.kills
        || policy.limits.pickups > 0 && this.engine.looted - this.runPickups >= policy.limits.pickups) {
        this.wait('Configured session limit reached. Stop and reconfigure to begin a new run.'); return;
      }
      if (!this.heartbeatHealthy || now < this.yieldUntil) { this.resumeRun(); return; }
      if (!this.engine.connected || !this.engine.compatible || now - this.lastFrame > 15_000) {
        this.wait(!this.engine.connected ? 'Waiting for the game to reconnect.' : !this.engine.compatible
          ? 'Waiting for a verified game build and protocol.' : 'Waiting for a fresh server update.'); return;
      }
    }
    // Escape owns its own receipt rather than the scheduler's cost-only ACK.
    // It must run while a requested field run is already waiting below its HP floor.
    if (this.escapeTick()) return;
    const wasRunning = this.engine.running;
    this.engine.tick(); this.captureActionFailure();
    if (this.runRequested && wasRunning && !this.engine.running && !this.engine.player?.dead
      && !this.engine.reason.includes('HP reached')) {
      this.waitingReason = this.engine.reason; this.retryAt = Math.max(this.retryAt, now + 5_000);
    }
    this.syncWorkflowOwner();
    if (!this.active) return;
    if (!this.engine.connected || !this.engine.compatible || now - Math.max(this.started, this.lastFrame) > 15_000) {
      this.pause('Game state became unavailable.'); return;
    }
    if (this.travel.active) {
      const player = this.engine.player;
      if (player && (player.dead || !player.maxHp || player.hp / player.maxHp * 100 <= (this.travelSettings?.minHpPercent ?? 45))) {
        this.pause('Waiting for HP and a living character before travelling.');
      } else {
        this.travel.tick(this.engine.map, player);
        const state = this.travel.snapshot();
        if (state.state === 'failed') {
          this.waitingReason = state.reason; this.retryAt = now + 2_000;
        } else if (state.state === 'complete') { this.travelSettings = null; this.retryAt = 0; }
      }
      return;
    }
    if (this.pending?.engineSequence !== undefined) {
      const result = this.engine.actionResult;
      if (result.sequence === this.pending.engineSequence && result.status !== 'pending')
        this.completePending(result.status === 'confirmed', result.reason);
    }
    if (this.workflow.snapshot().running && now >= this.fencedUntil) {
      const action = this.workflow.tick(this.context());
      if (action) {
        this.workflowDeadline = now + this.workflowTimeout;
        this.workflowOutstanding = { action, since: now, routineId: this.pending?.routineId ?? null,
          generation: this.generation, worldGeneration: this.world.generation, map: this.engine.map,
          npcId: this.world.npc.id, workflow: true, sent: true };
        if (this.pending?.workflow) { this.pending.sent = true; this.pending.since = now; }
        this.send(action);
      }
      this.syncWorkflowOwner();
    }
    if (this.workflow.snapshot().state === 'complete') this.workflowDeadline = 0;
    if (this.pending?.workflow && !this.workflow.snapshot().running) {
      const state = this.workflow.snapshot(); this.completePending(state.state === 'complete', state.reason);
    }
    if (this.pending && !this.pending.workflow && this.pending.engineSequence === undefined && now - this.pending.since >= 10_000)
      this.completePending(false, 'Result not confirmed. No repeat request was sent.');
    if (!this.pending && !this.workflow.snapshot().running && now >= this.fencedUntil && this.engine.idleForActions()) {
      const action = this.routine.tick(this.observation());
      if (action) {
        const id = this.routine.snapshot().pendingActionId;
        try { this.dispatch(action, id); }
        catch (error) { this.routine.acknowledge(false, id!); this.engine.reason = error instanceof Error ? error.message : 'Routine action rejected.'; }
      }
    }
    this.resumeRun();
  }
  snapshot(): CompanionSnapshot {
    const snapshot = this.engine.snapshot();
    const workflow = this.workflow.snapshot(); const routine = this.routine.snapshot(); const travel = this.travel.snapshot();
    if (this.travel.active || travel.state === 'complete' && this.travelSettings) snapshot.reason = travel.reason;
    else if (workflow.running) snapshot.reason = workflow.reason;
    else if (routine.state === 'running' || routine.state === 'waiting') snapshot.reason = routine.reason;
    const executing = this.executing && (this.engine.running || this.travel.active || workflow.running || !!this.pending
      || this.escape.inFlight || ['running','waiting'].includes(routine.state));
    if (this.runRequested && !executing) snapshot.reason = this.blockedReason || this.waitingReason || snapshot.reason;
    return { ...snapshot, running: executing, runRequested: this.runRequested,
      state: executing ? 'running' : this.runRequested ? 'waiting' : 'idle',
      runIntent: this.runRequested, elapsedSeconds: this.runRequested ? Math.max(0, Math.floor((this.now() - this.started) / 1000)) : snapshot.elapsedSeconds,
      world: this.world.snapshot(), workflow, routine, travel, escape: this.escape.snapshot() };
  }
}

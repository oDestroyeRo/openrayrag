import type { CharacterState } from './character-state';
import type { Entity, GameEvent } from './protocol';
import type { ExpandedAction } from './protocol-feature';
import { automationSettings, escapeSettings, type EscapeSettings, type Settings } from './settings';
import { skillCost } from './game-catalog';

// These are normal player actions at protocol pin 4099e2c. Opcode 21 is an
// unrelated privileged command and is deliberately absent from this owner.
export type EscapeAction = Extract<ExpandedAction, { type: 'useItem' }> | Extract<ExpandedAction, { type: 'skill'; mode: 'self' }>;
export function escapeAction(policy: EscapeSettings): EscapeAction {
  return policy.method === 'item' ? { type: 'useItem', itemId: policy.mode === 'random' ? 601 : 602 }
    : { type: 'skill', mode: 'self', skillId: policy.mode === 'random' ? 53 : 54, level: 1 };
}
export interface EscapeContext {
  connected: boolean; compatible: boolean; fresh: boolean; map: string; playerId: number;
  player: Entity | undefined; character: CharacterState; connection: number;
  ready: boolean; blocker: string;
}
export interface EscapeSnapshot {
  state: 'idle' | 'preparing' | 'sent' | 'refreshing' | 'confirmed' | 'rejected' | 'uncertain' | 'canceled';
  reason: string; pending: boolean; consumed: boolean; cooldownSeconds: number; latched: boolean;
}
/** Ephemeral controller-window state; never part of settings or profile export. */
export interface EscapeResumeGuard { cooldownSeconds: number; latched: boolean }
export function validateEscapeResumeGuard(guard: EscapeResumeGuard): void {
  if (!guard || typeof guard !== 'object' || Array.isArray(guard) || Object.keys(guard).length !== 2
    || Object.keys(guard).some(key => !['cooldownSeconds','latched'].includes(key))
    || !Number.isInteger(guard.cooldownSeconds) || guard.cooldownSeconds < 0 || guard.cooldownSeconds > 3600 || typeof guard.latched !== 'boolean')
    throw new Error('Invalid escape resume guard.');
}
interface Request {
  action: EscapeAction; policy: EscapeSettings; name: string; id: number; map: string; connection: number;
  readyAt: number; sentAt: number | null; deadline: number; count: number; sp: number;
  refresh: 'clear' | 'map' | null; arrivalMap: string; consumed: boolean;
  reconnect: boolean; entered: boolean; spawned: boolean; resources: boolean;
  died: boolean;
}

/** One danger episode, one request, with cost and arrival kept separate.
 * This state is intentionally independent of field/world resets and Start/Stop.
 */
export class EmergencyEscape {
  private request: Request | null = null;
  private state: EscapeSnapshot['state'] = 'idle';
  private reason = '';
  private latched = false;
  private recovered = false;
  private recoveryHp = 0;
  private cooldownUntil = 0;
  private episodeName = '';
  private lastHealth: { name: string; hp: number; at: number } | null = null;
  private restoring: { name: string; action: EscapeAction } | null = null;
  constructor(private readonly now = Date.now) {}
  get busy(): boolean { return this.request !== null || this.restoring !== null; }
  get inFlight(): boolean { return ['preparing','sent','refreshing'].includes(this.state) && this.busy; }
  get sent(): boolean { return this.request !== null && this.request.sentAt !== null; }
  get blocked(): boolean { return this.busy || this.latched && !this.recovered; }
  private hp(context: EscapeContext): number | null {
    const p = context.player;
    return p && p.kind === 0 && !p.dead && p.maxHp > 0 ? p.hp / p.maxHp * 100 : null;
  }
  private resourceBlocker(action: EscapeAction, policy: EscapeSettings, context: EscapeContext): string {
    const character = context.character;
    if (action.type === 'useItem') return !character.inventoryKnown ? 'Waiting for a verified escape-item inventory.'
      : character.count(action.itemId) <= policy.minStock ? `Escape item ${action.itemId} is unavailable above the stock reserve.` : '';
    const cost = skillCost(action.skillId, 1);
    return !character.skillsKnown || character.skillLevel(action.skillId) < 1 ? `Waiting for verified escape skill ${action.skillId}.`
      : cost === null || character.stats?.sp === undefined || character.stats.sp < cost ? 'Waiting for enough verified escape SP.'
      : character.stats.weight !== undefined && character.stats.maxWeight !== undefined && character.stats.weight > character.stats.maxWeight
        ? 'Escape skills cannot be used above the maximum weight.' : '';
  }
  update(context: EscapeContext): void {
    const restored = this.restoring;
    if (restored && context.connected && context.compatible && context.fresh && context.player?.name === restored.name && !context.player.dead
      && this.lastHealth?.name === restored.name && this.now() - this.lastHealth.at <= 15_000
      && (restored.action.type === 'useItem' ? context.character.inventoryKnown : context.character.skillsKnown && context.character.stats?.sp !== undefined)) {
      this.restoring = null; this.reason = 'Escape state reconciled after reload; waiting for recovery.';
    }
    if (this.latched && !this.busy && this.recovered && this.now() >= this.cooldownUntil) {
      this.latched = false; this.state = 'idle'; this.reason = '';
    } else if (this.latched && !this.busy && this.recovered && this.state === 'confirmed') {
      this.reason = 'Escape arrival confirmed; HP recovered and escape cooldown active.';
    }
    const request = this.request;
    if (request && request.sentAt !== null && this.now() >= request.deadline && ['sent','refreshing'].includes(this.state)) {
      this.state = 'uncertain'; this.reason = request.consumed
        ? 'Escape cost was confirmed, but arrival is uncertain. Waiting for arrival or a verified reconnect.'
        : 'Escape result is uncertain. Waiting for arrival or a verified reconnect; no repeat was sent.';
    }
  }
  wants(settings: Settings, context: EscapeContext): boolean {
    this.update(context);
    const policy = escapeSettings(settings); const hp = this.hp(context);
    if (!policy.enabled || this.busy || this.latched || this.now() < this.cooldownUntil || hp === null || hp > policy.hpBelowPercent) return false;
    if (!context.connected || !context.compatible || !context.fresh || !context.player || !context.map) return false;
    this.reason = context.blocker || this.resourceBlocker(escapeAction(policy), policy, context);
    return context.ready && !this.reason;
  }
  begin(settings: Settings, context: EscapeContext): void {
    const policy = { ...escapeSettings(settings) }; const p = context.player!;
    const action = escapeAction(policy); const recovery = automationSettings(settings).recovery;
    this.recoveryHp = Math.min(100, Math.max(policy.hpBelowPercent + 10, settings.minHpPercent + 1, recovery.enabled ? recovery.hpEnd : 0));
    this.state = 'preparing'; this.reason = 'Preparing emergency escape; letting the previous input settle.';
    this.request = { action, policy, name: p.name, id: context.playerId, map: context.map, connection: context.connection,
      readyAt: this.now() + 250, sentAt: null, deadline: 0, count: action.type === 'useItem' ? context.character.count(action.itemId) : 0,
      sp: context.character.stats?.sp ?? 0, refresh: null, arrivalMap: '', consumed: false,
      reconnect: false, entered: false, spawned: false, resources: false, died: false };
  }
  restoreOnReconnect(settings: Settings, guard: EscapeResumeGuard, context: EscapeContext): void {
    validateEscapeResumeGuard(guard);
    const policy = escapeSettings(settings);
    if (!policy.enabled) return;
    const recovery = automationSettings(settings).recovery;
    this.recoveryHp = Math.min(100, Math.max(policy.hpBelowPercent + 10, settings.minHpPercent + 1, recovery.enabled ? recovery.hpEnd : 0));
    this.episodeName = context.player?.name ?? ''; this.latched = true;
    this.recovered = this.lastHealth?.name === this.episodeName && this.now() - this.lastHealth.at <= 15_000 && this.lastHealth.hp >= this.recoveryHp;
    this.cooldownUntil = Math.max(this.cooldownUntil, this.now() + guard.cooldownSeconds * 1000);
    this.restoring = { name: this.episodeName, action: escapeAction(policy) };
    this.state = 'canceled'; this.reason = 'Waiting for verified resources and HP recovery after reconnect.';
  }
  takeAction(context: EscapeContext): EscapeAction | null {
    const r = this.request;
    if (!r || r.sentAt !== null || this.now() < r.readyAt) return null;
    const hp = this.hp(context);
    if (context.connection !== r.connection || context.map !== r.map || context.playerId !== r.id || context.player?.name !== r.name
      || hp === null || hp > r.policy.hpBelowPercent) { this.cancel('Emergency escape canceled before sending.'); return null; }
    this.reason = context.blocker || this.resourceBlocker(r.action, r.policy, context);
    if (!context.connected || !context.compatible || !context.fresh || !context.ready || this.reason) return null;
    // Claim before sending: even a transport exception cannot authorize a retry.
    r.sentAt = this.now(); r.deadline = this.now() + 30_000;
    this.latched = true; this.recovered = false; this.cooldownUntil = this.now() + r.policy.cooldownSeconds * 1000;
    this.episodeName = r.name;
    this.state = 'sent'; this.reason = 'Emergency escape sent; waiting for the refreshed character arrival.';
    return r.action;
  }
  cancel(reason: string): void {
    if (!this.request) return;
    if (this.request.sentAt === null) { this.request = null; this.state = 'idle'; this.reason = reason; }
    else { this.state = 'canceled'; this.reason = `${reason} Waiting for the escape result before another action.`; }
  }
  connectionChanged(): void {
    const r = this.request;
    if (!r) return;
    if (r.sentAt === null) { this.cancel('Escape canceled before connection changed.'); return; }
    r.reconnect = true; r.entered = false; r.spawned = false; r.resources = false;
    this.state = 'uncertain'; this.reason = 'Escape interrupted by connection change; waiting for a verified character and resources.';
  }
  observe(events: GameEvent[], context: EscapeContext): boolean {
    // Read HP only from a new authoritative self sample, never from repeated
    // ticks, SP-only updates, another actor's spawn or assumed save-point healing.
    if (context.connected && context.compatible && context.fresh && context.player
      && events.some(event => event.type === 'spawn' && event.entity.id === context.playerId
        || event.type === 'heal' && event.id === context.playerId || event.type === 'stats'
        || event.type === 'resurrection' && event.id === context.playerId)) {
      const hp = this.hp(context);
      if (hp !== null) {
        this.lastHealth = { name: context.player.name, hp, at: this.now() };
        if (this.latched && context.player.name === this.episodeName && hp >= this.recoveryHp) this.recovered = true;
      }
    }
    const r = this.request;
    if (!r || r.sentAt === null) return false;
    if (context.connection !== r.connection) {
      if (!r.reconnect || !context.compatible) return false;
      for (const event of events) {
        if (event.type === 'enter') { r.entered = true; r.spawned = false; r.resources = false; }
        if (event.type === 'spawn' && r.entered && event.entity.id === context.playerId && event.entity.name === r.name
          && event.entity.kind === 0 && !event.entity.dead && event.entity.hp > 0) r.spawned = true;
        if (r.entered && (r.action.type === 'useItem' ? event.type === 'inventory' : event.type === 'skills' || event.type === 'stats' || event.type === 'sp')) r.resources = true;
      }
      const known = r.action.type === 'useItem' ? context.character.inventoryKnown
        : context.character.skillsKnown && context.character.stats?.sp !== undefined;
      if (r.entered && r.spawned && r.resources && known && context.player?.name === r.name && context.playerId === context.player.id) {
        this.request = null; this.state = 'canceled'; this.reason = 'Escape uncertainty reconciled after reconnect; waiting for recovery.';
      }
      return false;
    }
    for (const event of events) {
      if (r.action.type === 'useItem' && event.type === 'inventoryDelta' && !event.add && context.character.inventoryKnown
        && context.character.count(r.action.itemId) < r.count) r.consumed = true;
      if (r.action.type === 'skill' && event.type === 'sp' && event.sp <= r.sp - (skillCost(r.action.skillId, 1) ?? Infinity)) r.consumed = true;
      if (event.type === 'featureError' || event.type === 'skillFailure' || event.type === 'requestFailure') {
        this.reason = 'message' in event ? `Escape rejected: ${event.message.slice(0,120)}` : `Escape rejected by the server (code ${event.reason}).`;
        if (r.consumed || r.refresh) { this.state = 'uncertain'; this.reason += ' Arrival remains uncertain.'; }
        else { this.request = null; this.state = 'rejected'; }
        return false;
      }
      if (event.type === 'death' && event.id === r.id) { r.died = true; this.state = 'uncertain'; this.reason = 'Character died before escape arrival; waiting for a confirmed result or reconnect.'; }
      if (event.type === 'map' || event.type === 'clear') {
        if (event.type === 'map' || r.refresh !== 'map') {
          r.refresh = event.type; r.arrivalMap = event.type === 'map' ? event.map : context.map;
        }
        if (this.state !== 'canceled' && this.state !== 'uncertain') this.state = 'refreshing';
      }
      if (event.type === 'spawn' && !r.died && r.refresh && event.entity.id === r.id && event.entity.name === r.name
        && event.entity.kind === 0 && !event.entity.dead && event.entity.hp > 0 && context.map === r.arrivalMap
        && (r.refresh === 'map' || event.entryType === 2)) {
        this.request = null; this.state = 'confirmed'; this.reason = r.policy.mode === 'save'
          ? 'Return to save point confirmed; waiting for recovery.' : 'Emergency escape arrival confirmed; waiting for recovery.';
        return true;
      }
    }
    return false;
  }
  snapshot(): EscapeSnapshot {
    return { state: this.state, reason: this.reason, pending: this.busy, consumed: this.request?.consumed ?? false,
      cooldownSeconds: Math.max(0, Math.ceil((this.cooldownUntil - this.now()) / 1000)), latched: this.latched };
  }
}

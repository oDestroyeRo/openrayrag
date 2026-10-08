import { filter, map } from 'effect/Array';
import {
  quantity,
  revisionFor,
  partyMemberId,
  type ItemId,
  type Quantity,
} from '../../shared/domain-values';
import { addExperience, type RunExperience } from '../session/run-experience-logic';
import {
  skillId as domainSkillId,
  itemId as domainItemId,
  bagId as domainBagId,
} from '../../shared/domain-values';
import { fieldIdentityWaitReason, fieldResumeDecision } from './controller-field-policy';
import {
  PartyFollowRuntime,
  type PartyFollowContext,
  type PartyFollowSnapshot,
} from '../party/party-follow';
import {
  PartyHealPolicy,
  partyHealCandidates,
  partyHpCondition,
  type PartyHealSnapshot,
} from '../party/party-heal';
import {
  deathLimitGuidance,
  farmingDestination,
  deathCycle,
  deathGuard,
  validateDeathRecoveryGuard,
  type DeathRecoveryGuard,
  type DeathCycle,
} from '../recovery/death-recovery';
import { ManualRefine, type RefineContext, type RefineSnapshot } from '../refine/refine';
import { validateRefineAdvance, type RefinePacket } from '../refine/refine-protocol';
import { ManualWarp, type WarpContext, type WarpSnapshot, type WarpGuardStore } from '../warp/warp';
import {
  warpInitializationPacket,
  officialWarpSkill,
  validateWarpEnvelope,
  type WarpWire,
} from '../warp/warp-protocol';
import { warpCastReadiness, CAST_PREREQUISITES, BLIND_CONDITION } from '../combat/cast-policy';
import { sameActionIdentity, type ActionIdentity } from '../world/actor-identity';
import { ManualSocket, type SocketContext, type SocketSnapshot } from '../socket/socket';
import {
  socketStockFloors,
  validateSocketEnvelope,
  type SocketAction,
} from '../socket/socket-protocol';
import { validateManualTargetRequest } from '../combat/manual-target';
import {
  validateManualNpcTalkRequest,
  validateManualVendingViewRequest,
} from '../services/manual-npc-talk-logic';
import { isTalkNpc, isPlayerShop } from '../world/actor-interaction-logic';
import { insideLockArea, lockEntry, mapAllowed, mapPolicy } from '../navigation/map-policy';
import type { ActorPredicate } from '../world/actor-observations';
import { routineActorPredicates } from '../automation/routines-logic';
import { ManualSocial, type SocialContext, type SocialSnapshot } from '../social/social';
import type { ManualSocialAction } from '../social/social-protocol';
import { ManualMemo, type MemoContext, type MemoSnapshot } from '../memo/memo';
import type { MemoSlot } from '../memo/memo-protocol';
import { canMemoMap } from '../memo/memo-map-catalog';
import { BotEngine, OWN_CAST_WAIT_REASON, type Action, type Snapshot } from '../automation/engine';
import { decode, type GameEvent } from '../protocol/protocol';
import { validateExpandedAction, type ExpandedAction } from '../protocol/protocol-feature';
import {
  validateSettings,
  automationSettings,
  settingsDraft,
  automationDraft,
  type RunSettings,
  type SettingsInput as Settings,
  type AutomationSettingsInput as AutomationSettings,
} from '../settings/settings';
import {
  decodeWorld,
  validateWorldAction,
  type WorldAction,
  type WorldEvent,
} from '../protocol/world-protocol';
import { WorldState, type WorldSnapshot } from '../world/world-state';
import {
  NpcWorkflow,
  validateWorkflowSpec,
  worldActionBlockers,
  type WorkflowContext,
  type WorkflowSnapshot,
  type WorkflowStep,
  createVendingReceipt,
  confirmVendingReceipt,
  type VendingReceipt,
} from '../services/workflows';
import {
  RoutineRuntime,
  validateRoutineSpec,
  type RoutineObservation,
  type RoutineSnapshot,
  type RoutineSpec,
} from '../automation/routines';
import {
  MacroRuntime,
  validateMacroScript,
  type MacroIntent,
  type MacroSnapshot,
  type MacroStep,
} from '../automation/macros';
import {
  validateControllerUpdateCheckpoint,
  type ControllerUpdateCheckpoint,
} from '../update/controller-update';
import { planDisposition } from '../services/disposition';
import {
  TravelController,
  type TravelSnapshot,
  type DatabaseTravelTransport,
} from '../navigation/travel-controller';
import {
  DATABASE_TELEPORT_COOLDOWN_MS,
  databaseTeleportWait,
} from '../navigation/database-travel-protocol';
import { inSchedule, actionConfirmationTimeout } from '../automation/automation';
import { searchGrid, type WalkGrid } from '../navigation/navigation';
import type { InventoryItemInput as InventoryItem } from '../protocol/protocol-feature';
import {
  NpcServiceRuntime,
  observeServiceReceipt,
  confirmServiceReceipt,
  type ServiceContext,
  type ServiceReceipt,
  type ServiceSnapshot,
} from '../services/npc-services';
import { validateServiceExecution } from '../services/npc-services-logic';
import { ITEM_CATALOG } from '../catalog/game-catalog';
import {
  SupplyTripRuntime,
  validateSupplyResumeGuard,
  type SupplyContext,
  type SupplyIntent,
  type SupplySnapshot,
  type SupplyResumeGuard,
} from '../services/supply-trip';
import { nextSupplyAction, type SupplyPhaseEvidence } from '../services/supply-plan';
import { observeSupplyReceipt } from '../services/supply-receipt';
import {
  createSupplyReceipt,
  confirmSupplyReceipt,
  type SupplyReceipt,
} from '../services/supply-receipt-logic';
import {
  dispositionStockFloors,
  publishedDispositionMetadata,
} from '../services/disposition-ui-logic';
import {
  BUILTIN_SERVICES,
  serviceByContractId,
  resolveServiceNpc,
  type NpcServiceDefinition,
} from '../services/npc-services';
import { confirmWorkflowReceipt, stock, type WorkflowReceipt } from '../services/workflows';
import {
  EmergencyEscape,
  validateEscapeResumeGuard,
  type EscapeContext,
  type EscapeSnapshot,
  type EscapeResumeGuard,
} from '../recovery/escape';
import {
  liveSettingsGuard,
  planLiveSettings,
  validSettingsApplyId,
  validateLiveSettingsGuard,
  type LiveSettingsGuard,
  type LiveSettingsPlan,
  type SettingsApplySnapshot,
} from '../settings/live-settings-logic';
import { reachedRunLimit, runLimitReason } from '../session/run-limit-logic';

export type ControllerAction = ExpandedAction | WorldAction;
export type { ControllerUpdateCheckpoint } from '../update/controller-update';
/** Detached initialization facts; decoded entities remain owned by the controller. */
export interface PacketObservation {
  readonly opcode: number;
  readonly enter: boolean;
  readonly map: boolean;
  readonly clear: boolean;
  readonly fullResources: boolean;
  readonly memoSlots: boolean;
  readonly spawns: readonly {
    readonly id: number;
    readonly kind: number;
    readonly entryType: number | undefined;
  }[];
}
function packetObservation(opcode: number, events: GameEvent[]): PacketObservation {
  let enter = false,
    map = false,
    clear = false,
    inventory = false,
    skills = false,
    stats = false,
    memoSlots = false;
  const spawns: Array<PacketObservation['spawns'][number]> = [];
  for (const event of events) {
    switch (event.type) {
      case 'enter':
        enter = true;
        break;
      case 'map':
        map = true;
        break;
      case 'clear':
        clear = true;
        break;
      case 'inventory':
        inventory = true;
        break;
      case 'skills':
        skills = true;
        break;
      case 'stats':
        stats = true;
        break;
      case 'memoSlots':
        memoSlots = true;
        break;
      case 'spawn':
        spawns.push(
          Object.freeze({
            id: event.entity.id,
            kind: event.entity.kind,
            entryType: event.entryType,
          }),
        );
        break;
    }
  }
  return Object.freeze({
    opcode,
    enter,
    map,
    clear,
    fullResources: inventory && skills && stats,
    memoSlots,
    spawns: Object.freeze(spawns),
  });
}
export interface CompanionSnapshot extends Snapshot {
  runRequested: boolean;
  initialFieldEntryPending?: boolean;
  state: 'running' | 'waiting' | 'idle';
  world: WorldSnapshot;
  workflow: WorkflowSnapshot;
  routine: RoutineSnapshot;
  macro: MacroSnapshot;
  travel: TravelSnapshot;
  service: ServiceSnapshot;
  partyFollow: PartyFollowSnapshot;
  escape: EscapeSnapshot;
  supply: SupplySnapshot;
  supplyGuard?: SupplyResumeGuard;
  deathRecoveryGuard?: DeathRecoveryGuard;
  social: SocialSnapshot;
  memo: MemoSnapshot;
  socket: SocketSnapshot;
  partyHeal?: PartyHealSnapshot;
  refine: RefineSnapshot;
  warp: WarpSnapshot;
  activeSettings: Settings | null;
  settingsApply: SettingsApplySnapshot | null;
  liveSettingsGuard: LiveSettingsGuard | null;
}
function expanded(value: unknown): value is ExpandedAction {
  try {
    validateExpandedAction(value);
    return true;
  } catch {
    return false;
  }
}
export function validControllerAction(value: unknown): value is ControllerAction {
  if (expanded(value)) return true;
  try {
    validateWorldAction(value);
    return true;
  } catch {
    return false;
  }
}
interface Pending {
  actorIdentity?: ActionIdentity;
  action: ControllerAction;
  since: number;
  routineId: number | null;
  engineSequence?: number;
  workflow?: boolean;
  sent?: boolean;
  generation: number;
  worldGeneration: number;
  map: string;
  npcId: number | null;
  receipt?: VendingReceipt;
  serviceReceipt?: ServiceReceipt;
  macro?: { id: number; generation: number };
  workflowReceipt?: WorkflowReceipt;
  workflowAcknowledged?: boolean;
  cart?: { source: InventoryItem; inventory: number; cart: number; acknowledged: boolean };
}
interface MacroOwner {
  intent: MacroIntent;
  phase:
    | 'settling'
    | 'farm'
    | 'travel'
    | 'service'
    | 'workflow'
    | 'closing'
    | 'closeReceipt'
    | 'action';
  stopped: boolean;
  travelTripId?: number;
  service?: NpcServiceDefinition;
  serviceFee?: number;
  target?: ActionIdentity;
}

/** One owner for field automation, trips, NPC workflows and explicit manual actions. */
export class CompanionController {
  readonly engine: BotEngine;
  readonly partyFollow: PartyFollowRuntime;
  readonly partyHeal: PartyHealPolicy;
  readonly world = new WorldState();
  readonly workflow: NpcWorkflow;
  readonly routine: RoutineRuntime<ControllerAction>;
  readonly macro: MacroRuntime;
  private macroBase: Settings | null = null;
  private macroOwner: MacroOwner | null = null;
  private macroPredicates: ActorPredicate[] = [];
  readonly travel: TravelController;
  readonly escape: EmergencyEscape;
  readonly service: NpcServiceRuntime;
  readonly supply: SupplyTripRuntime<SupplyReceipt>;
  private supplyIntent: SupplyIntent | null = null;
  private supplyReceipt: SupplyReceipt | null = null;
  private supplyInventoryRevision = 0;
  private supplyCurrencyRevision = 0;
  private supplyInventoryFresh = false;
  private supplyCurrencyFresh = false;
  private supplyCloseSent = false;
  private supplyReturnApproach = false;
  private supplyServiceStarted = false;
  private supplyServiceContract: string | null = null;
  private supplyStorageFull: SupplyPhaseEvidence['storageFull'] = null;
  private sendingSupply = false;
  private readonly dispositionMetadata = publishedDispositionMetadata();
  readonly socket: ManualSocket;
  private socketFloors: ReadonlyMap<ItemId, Quantity> | null = null;
  private socketInitialization: { key: string; identity: string | null } | null = null;
  readonly social: ManualSocial;
  readonly memo: ManualMemo;
  readonly warp: ManualWarp;
  private warpPolicy: AutomationSettings | null = null;
  private memoIdentity: string | null = null;
  private memoWalkPending: { x: number; y: number } | null = null;
  private memoWalkEnd: { x: number; y: number } | null = null;
  private memoMovementUnknown = false;
  private fieldWalkOwner: ActionIdentity | null = null;
  readonly refine: ManualRefine;
  private refineNpcGeneration = 0;
  private refineNpcIdentity: string | null = null;
  private refinePromptToken: string | null = null;
  private refineActivityRevision = 0;
  private refineInitialization: { key: string; identity: string | null } | null = null;
  private socialIdentity: { actor: ActionIdentity; name: string } | null = null;
  private pending: Pending | null = null;
  private lastFrame = 0;
  private lastTick = 0;
  private started = 0;
  private routineSpec: RoutineSpec<ControllerAction> | null = null;
  private travelSettings: Settings | null = null;
  private returnSettings: Settings | null = null;
  private returning = false;
  private initialFieldEntryPending = false;
  private requestedSettings: RunSettings | null = null;
  private protectedSettings: Settings | null = null;
  private pendingSettings: { id: string; plan: LiveSettingsPlan; character: string } | null = null;
  private settingsApply: SettingsApplySnapshot | null = null;
  private resourceGuard: LiveSettingsGuard | null = null;
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
  private deathCycle: DeathCycle | null = null;
  private deathCycleConnection: number | null = null;
  private cycleDeaths = 0;
  private readyOwn: { identity: string; name: string; initialization: boolean } | null = null;
  private quietUntil = 0;
  private databaseTeleportUntil = 0;
  private ownArrival: { id: number | null; entry: 1 | 2; initialization: boolean } | null = null;
  private enteredConnection = false;
  private runKills = 0;
  private runPickups = 0;
  private experienceRun = 0;
  private runExperience: RunExperience | null = null;
  private experienceConnection = -1;
  private reconnectExperience: BotEngine['character']['experience'] = null;
  private reconnectExperienceCharacter: string | null = null;
  private characterName: string | null = null;
  private featureMacroSequence: number | null = null;
  private get featureReceipt() {
    return this.engine.actionReceipts.receipt;
  }
  private unresolvedWorld: Pending | null = null;
  private workflowOutstanding: Pending | null = null;
  private updateSuspended = false;
  get preparingUpdate(): boolean {
    return this.updateSuspended;
  }

  constructor(
    private readonly transport: (action: Action | WorldAction) => void,
    private readonly now = Date.now,
    private readonly gridFor: (map: string) => WalkGrid | null = searchGrid,
    sendSocial: (action: ManualSocialAction) => void = () => {
      throw new Error('Manual social transport is unavailable.');
    },
    sendMemo: (slot: MemoSlot) => void = () => {
      throw new Error('Manual memo transport is unavailable.');
    },
    sendSocket: (action: SocketAction) => void = () => {
      throw new Error('Manual socket transport is unavailable.');
    },
    sendRefine: (packet: RefinePacket) => void = () => {
      throw new Error('Manual refine transport is unavailable.');
    },
    sendWarp: (wire: WarpWire) => void = () => {
      throw new Error('Warp Portal transport is unavailable.');
    },
    warpStore?: WarpGuardStore,
    private readonly databaseTravel?: DatabaseTravelTransport,
  ) {
    this.partyHeal = new PartyHealPolicy(now);
    this.engine = new BotEngine(
      (action) => this.send(action),
      now,
      gridFor,
      (entityId) => {
        if (!this.world.party) return null;
        const members = [...this.world.party.members.values()].filter(
          (member) => member.entityId === entityId,
        );
        return members.length === 1
          ? this.world.partyActors.get(partyMemberId(members[0]!.memberId))
          : null;
      },
    );
    this.partyFollow = new PartyFollowRuntime(now);
    this.engine.partyFollowBinding = () =>
      this.partyFollow.visibleLeader(this.partyFollowContext());
    this.engine.setPartySupport(
      () => this.partyHealTick(),
      () => this.partyHeal.busy,
    );
    this.workflow = new NpcWorkflow(now);
    this.routine = new RoutineRuntime(validControllerAction, now, {
      actionTimeoutSeconds: actionConfirmationTimeout({ type: 'skill' }) / 1000,
    });
    this.macro = new MacroRuntime(now);
    this.travel = new TravelController((action) => this.send(action), now, gridFor, {
      context: () => {
        const identity = this.engine.actorActionIdentity();
        return {
          identity: identity
            ? JSON.stringify([this.connectionEpoch, this.world.generation, identity])
            : null,
          connection: String(this.connectionEpoch),
          map: this.engine.map,
          player: this.engine.player,
        };
      },
      continueRequested: () => this.runRequested || this.macro.active,
      databaseTravel: databaseTravel
        ? {
            supported: databaseTravel.supported,
            ready: () =>
              this.engine.connected &&
              this.engine.compatible &&
              this.now() - this.lastFrame <= 15_000 &&
              this.now() >= Math.max(this.quietUntil, this.databaseTeleportUntil) &&
              databaseTravel.ready?.() !== false,
            waitReason: () =>
              this.now() - this.lastFrame > 15_000
                ? 'Waiting for a fresh server update before teleporting.'
                : this.now() < this.databaseTeleportUntil
                  ? `Teleport available in ${Math.ceil((this.databaseTeleportUntil - this.now()) / 1_000)}s. Travel will continue automatically.`
                  : (databaseTravel.waitReason?.() ??
                    'Waiting briefly for the server input cooldown before Database travel.'),
            reserve: () =>
              !this.sendingSupply || !this.supply.ownsField || this.supply.commandAllowed(),
            send: (map) => {
              this.quietUntil = Math.max(this.quietUntil, this.now() + 2_000);
              this.databaseTeleportUntil = Math.max(
                this.databaseTeleportUntil,
                this.now() + DATABASE_TELEPORT_COOLDOWN_MS,
              );
              databaseTravel.send(map);
            },
          }
        : undefined,
      dispatchReady: () =>
        this.world.npc.id === null &&
        this.world.npc.mode === 'idle' &&
        !this.world.vending &&
        this.engine.observedOwnCastSettled() &&
        (!databaseTravel ||
          (this.engine.idleForActions() &&
            this.engine.featureActionsSettled &&
            this.movementSettled() &&
            !this.pending &&
            !this.featureReceipt &&
            !this.unresolvedWorld &&
            !this.workflowOutstanding)),
      retiredWalkAccepted: (requested, accepted) => {
        if (this.memoWalkPending?.x === requested.x && this.memoWalkPending.y === requested.y) {
          this.memoWalkPending = null;
          this.memoWalkEnd = { ...accepted };
        }
      },
    });
    this.service = new NpcServiceRuntime(this.travel, now, gridFor);
    this.escape = new EmergencyEscape(now);
    this.supply = new SupplyTripRuntime(
      {
        next: (context, goals, policy) =>
          nextSupplyAction(context, goals, policy, this.requestedSettings?.automation?.supply!, {
            storageFull: this.supplyStorageFull,
          }),
        confirm: confirmSupplyReceipt,
      },
      now,
    );
    this.social = new ManualSocial(sendSocial, now);
    this.memo = new ManualMemo(sendMemo, now);
    this.socket = new ManualSocket(sendSocket, now);
    this.refine = new ManualRefine(sendRefine, now);
    this.warp = new ManualWarp(sendWarp, now, warpStore);
  }
  private send(action: Action | WorldAction): void {
    if (action.type !== 'stop' && this.travel?.teleportPending)
      throw new Error('Waiting for the sent Database teleport to settle or reconnect.');
    if (
      action.type !== 'stop' &&
      this.sendingSupply &&
      this.supply?.ownsField &&
      !this.supply.commandAllowed()
    )
      throw new Error('Supply command allowance exhausted.');
    if (action.type === 'sit' && this.deathCycle?.guard.phase === 'recovery') {
      // Scheduler has captured identity/sequence; retain it before the transport
      // write, including a write that throws after reaching the socket.
      this.deathCycle.posture = {
        sitting: action.sitting,
        sequence: this.engine.actionResult.sequence,
        identity: this.deathIdentity(),
      };
      this.deathCycle.guard.uncertain = true;
      this.deathCycleConnection = this.connectionEpoch;
    }
    if (action.type === 'walk') {
      this.memoWalkPending = { ...action.destination };
      this.memoWalkEnd = null;
      this.memoMovementUnknown = true;
      this.fieldWalkOwner =
        this.engine.running &&
        !this.engine.retreatOwned &&
        !this.engine.manualTargetOwned &&
        !this.travel.active
          ? this.engine.actorActionIdentity()
          : null;
    }
    if (action.type !== 'respawn') this.quietUntil = Math.max(this.quietUntil, this.now() + 2_000);
    this.transport(action);
  }
  private partyHealTick(): boolean {
    if (this.updateSuspended) return false;
    const policy = this.requestedSettings?.automation?.partyHeal;
    if (!this.partyHeal.available(policy, this.engine.observedOwnCastSettled())) return false;
    const e = this.engine,
      p = e.player;
    if (
      !policy ||
      !p ||
      !this.runRequested ||
      !this.heartbeatHealthy ||
      !this.movementSettled() ||
      this.refineBlocksAutomation ||
      this.warp.blocked ||
      this.partyFollow.ownsTravel ||
      this.returning ||
      this.deathCycle ||
      this.pending ||
      this.featureReceipt ||
      this.unresolvedWorld ||
      this.workflowOutstanding ||
      this.travel.active ||
      this.service.active ||
      this.workflow.snapshot().running ||
      ['running', 'waiting'].includes(this.routine.snapshot().state) ||
      this.supply.ownsField ||
      this.supply.uncertain ||
      this.escape.busy ||
      this.memo.blocked ||
      this.socket.busy ||
      this.social.busy ||
      this.now() < this.fencedUntil ||
      this.now() < this.yieldUntil ||
      this.world.npc.id !== null ||
      this.world.npc.mode !== 'idle' ||
      this.world.vending
    ) {
      this.partyHeal.wait('Waiting for higher-priority owners or physical movement.');
      return false;
    }
    this.world.refreshPartyActors(e.observations, p.id);
    const bindings = [...(this.world.party?.members.keys() ?? [])].flatMap((id) => {
      const binding = this.world.partyActors.get(partyMemberId(id));
      return binding ? [binding] : [];
    });
    const observations = e.actorObservation(
      bindings.map((binding) => partyHpCondition(binding, policy.hpBelowPercent)),
    );
    if (!this.partyHeal.resourcesReadBack(observations)) {
      this.partyHeal.wait('Waiting for fresh own SP readback after Heal.');
      return false;
    }
    const candidates = partyHealCandidates(
      bindings,
      e.actors,
      p.id,
      observations,
      policy.hpBelowPercent,
    );
    let reason = 'No fresh, living same-map party member is below the Heal threshold.';
    for (const candidate of candidates) {
      const blocked = e.partyHealReadiness(
        candidate.binding.entityId,
        policy.level,
        policy.spReserve,
      );
      if (blocked) {
        reason = blocked;
        continue;
      }
      // Repeat the authoritative binding check immediately before reservation.
      const current = this.world.partyActors.get(candidate.binding.memberId);
      if (!current || JSON.stringify(current) !== JSON.stringify(candidate.binding)) continue;
      try {
        e.submitPartyHeal(
          candidate.binding.entityId,
          policy.level,
          policy.spReserve,
          (sequence, identity) =>
            this.partyHeal.reserve(
              sequence,
              identity,
              {
                type: 'skill',
                mode: 'target',
                skillId: 41,
                level: policy.level,
                target: candidate.binding.entityId,
              },
              candidate,
              policy.cooldownSeconds,
            ),
        );
      } catch {
        this.partyHeal.cancel('The transport or reservation failed.');
        e.stop('Party Heal send is unresolved.');
      }
      return true;
    }
    this.partyHeal.wait(reason);
    return false;
  }
  private resetMemoMovement(): void {
    this.memoWalkPending = null;
    this.memoWalkEnd = null;
    this.memoMovementUnknown = false;
    this.fieldWalkOwner = null;
  }
  private movementSettled(): boolean {
    const p = this.engine.player;
    return (
      this.travel.movementSettled(this.engine.map, p) &&
      (!this.memoMovementUnknown ||
        (this.memoWalkPending === null &&
          !!this.memoWalkEnd &&
          p?.x === this.memoWalkEnd.x &&
          p?.y === this.memoWalkEnd.y))
    );
  }
  get runRequested(): boolean {
    return this.requestedSettings !== null;
  }
  private get refineBlocksAutomation(): boolean {
    return (
      this.refine.companionReceiptPending ||
      (this.refine.blocked && !this.runRequested && !this.macro.active)
    );
  }
  get connectionGeneration(): number {
    return this.connectionEpoch;
  }
  private get executing(): boolean {
    return (
      this.warp.busy ||
      this.refine.blocked ||
      this.socket.busy ||
      this.memo.busy ||
      this.social.busy ||
      this.engine.running ||
      this.engine.manualTargetActive ||
      this.partyFollow.ownsTravel ||
      this.returning ||
      this.service.active ||
      this.travel.active ||
      this.escape.inFlight ||
      this.workflow.snapshot().running ||
      !!this.pending ||
      this.macro.active ||
      ['running', 'waiting'].includes(this.routine.snapshot().state)
    );
  }
  get active(): boolean {
    return this.runRequested || this.executing;
  }
  connect(compatible: boolean): void {
    if (this.engine.character.experience) {
      this.reconnectExperience = { ...this.engine.character.experience };
      this.reconnectExperienceCharacter = this.engine.player?.name ?? null;
    }
    this.endMacro('Macro interrupted by reconnect.', true);
    this.partyHeal.cancel('The game transport changed.');
    this.ownArrival = null;
    this.readyOwn = null;
    this.enteredConnection = false;
    this.socketInitialization = null;
    this.warp.connectionChanged(true);
    this.resetMemoMovement();
    this.memo.reset('Memo connection changed. Wait for a new complete snapshot.');
    this.memoIdentity = null;
    this.clearRefineContext();
    this.social.reset('Social session changed.', true);
    this.socialIdentity = null;
    this.escape.connectionChanged();
    this.supply.interrupt('Supply trip interrupted by reconnect.');
    this.supplyInventoryFresh = false;
    this.supplyCurrencyFresh = false;
    this.connectionEpoch++;
    this.cancelOwners('Connection changed.');
    this.travel.connectionChanged();
    this.partyFollow.resetEvidence(
      'Connection changed. Stop and Start for a new party follow attempt.',
    );
    this.fencedUntil = 0;
    this.unresolvedWorld = null;
    this.world.reset();
    this.engine.connect(compatible);
    this.lastFrame = this.now();
    this.waitingReason = this.engine.reason;
    this.retryAt = 0;
  }
  disconnect(): void {
    if (this.engine.character.experience) {
      this.reconnectExperience = { ...this.engine.character.experience };
      this.reconnectExperienceCharacter = this.engine.player?.name ?? null;
    }
    this.endMacro('Macro interrupted by disconnect.', true);
    this.ownArrival = null;
    this.readyOwn = null;
    this.socketInitialization = null;
    this.warp.connectionChanged(false);
    this.resetMemoMovement();
    this.memo.reset('Memo connection closed. A transmitted update cannot be undone.');
    this.memoIdentity = null;
    this.clearRefineContext();
    this.social.reset('Social connection closed.', true);
    this.socialIdentity = null;
    this.escape.connectionChanged();
    this.supply.interrupt('Supply trip interrupted by disconnect.');
    this.supplyInventoryFresh = false;
    this.supplyCurrencyFresh = false;
    this.connectionEpoch++;
    try {
      this.pause('Waiting for the game to reconnect.');
    } finally {
      this.travel.connectionChanged();
      this.partyFollow.resetEvidence(
        'Disconnected. Stop and Start for a new party follow attempt.',
      );
      this.world.reset();
      this.engine.disconnect();
      this.waitingReason = 'Waiting for the game to reconnect.';
    }
  }
  fail(reason: string): void {
    this.endMacro(reason, true);
    try {
      this.pause(reason);
    } finally {
      this.engine.fail(reason);
    }
  }
  /** Every uncertain sent world request keeps its receipt until it is drained. */
  private retireWorld(pending: Pending | null = this.pending): void {
    const owner =
      pending?.macro && pending.workflow
        ? this.workflowOutstanding
        : pending && pending.engineSequence === undefined && (!pending.workflow || pending.sent)
          ? pending
          : this.workflowOutstanding;
    if (!owner) return;
    this.unresolvedWorld = { ...owner };
    this.fencedUntil = Math.max(
      this.fencedUntil,
      owner.since + 10_000,
      owner.workflow ? this.workflowDeadline : 0,
    );
    this.workflowOutstanding = null;
  }
  private syncWorkflowOwner(): void {
    if (!this.workflowOutstanding) return;
    if (this.workflowOutstanding.serviceReceipt) {
      if (
        this.service.snapshot().state === 'complete' ||
        (this.service.active && !this.service.receipt())
      ) {
        this.workflowOutstanding = null;
        this.workflowDeadline = 0;
      } else if (!this.service.active) this.retireWorld(null);
      return;
    }
    const state = this.workflow.snapshot();
    if (state.state === 'complete' || (state.running && !state.pending)) {
      this.workflowOutstanding = null;
      this.workflowDeadline = 0;
    } else if (!state.running) this.retireWorld(null);
  }
  private cancelOwners(reason: string): void {
    this.partyFollow.cancel(reason);
    this.warp.cancel(reason);
    this.memo.cancel('Memo intent canceled. A transmitted update cannot be undone or replayed.');
    this.refine.cancel(reason);
    this.supplyStorageFull = null;
    this.socket.cancel(reason);
    this.social.cancel('Unconfirmed after cancellation. A transmitted message cannot be unsent.');
    this.retireWorld();
    this.generation++;
    this.pending = null;
    this.routine.cancel(reason);
    this.workflow.cancel(reason);
    this.service.cancel(reason);
    this.travel.cancel(reason);
    this.travelSettings = null;
    if (!this.runRequested) {
      this.returning = false;
      this.returnSettings = null;
      this.initialFieldEntryPending = false;
    }
  }
  stop(reason = 'Stopped by you.'): void {
    if (this.pendingSettings && this.settingsApply)
      this.settingsApply = {
        ...this.settingsApply,
        state: 'cancelled',
        pending: [],
        reason: 'Stop cancelled the pending Apply.',
      };
    this.pendingSettings = null;
    this.engine.cancelUpdate();
    this.updateSuspended = false;
    this.endMacro(reason);
    this.engine.castAvailability.stop(reason);
    this.supply.stop(reason);
    this.supplyIntent = null;
    this.partyHeal.cancel(reason);
    this.requestedSettings = null;
    this.blockedReason = '';
    this.waitingReason = '';
    this.yieldUntil = 0;
    this.retryAt = 0;
    this.retries = 0;
    this.pause(reason);
  }
  /** Retain the requested field run while yielding ownership of commands. */
  pause(reason: string, durationMs = 0): void {
    this.partyHeal.cancel(reason);
    this.supply.interrupt(reason);
    this.supplyIntent = null;
    const externalActive =
      this.service.active ||
      this.travel.active ||
      this.workflow.snapshot().running ||
      !!this.pending ||
      this.escape.sent;
    const engineStops =
      this.engine.running ||
      this.engine.manualTargetActive ||
      this.engine.pendingFeatureAction?.type === 'skill';
    this.escape.cancel(reason);
    this.captureActionFailure();
    this.cancelOwners(reason);
    this.engine.stop(reason);
    this.captureActionFailure();
    this.yieldUntil = Math.max(this.yieldUntil, this.now() + durationMs);
    this.waitingReason = reason;
    if (externalActive && !engineStops && this.engine.connected) this.send({ type: 'stop' });
  }
  /** Only trusted input in the official game document calls this hook. */
  manualInput(): void {
    const continuing = this.runRequested || this.macro.active;
    if (!continuing) this.partyHeal.cancel('Manual game input interrupted local Heal intent.');
    const active = this.active;
    this.socket.externalInput();
    this.refine.externalInput();
    this.warp.cancel('Official game input retired Warp intent; server actions remain uncertain.');
    this.memo.cancel(
      'Memo preview or intent canceled by manual game input. A transmitted update cannot replay.',
    );
    if (active && !continuing) {
      // Pointer/key input also opens local panels. Keep sent action receipts,
      // cast strategy allowances and clocks; suspend only new decisions.
      this.yieldUntil = Math.max(this.yieldUntil, this.now() + 2_000);
      this.waitingReason = 'Yielding briefly to manual game input.';
    }
  }
  manualCommand(movement = false): void {
    if (this.runRequested || this.macro.active) {
      this.manualInput();
      if (movement) {
        this.engine.officialGameplay();
        this.travel.officialGameplay();
      }
      return;
    }
    this.endMacro('Macro interrupted by an official game action.');
    this.engine.castAvailability.cancel('Official game input stopped automatic cast recovery.');
    this.quietUntil = Math.max(this.quietUntil, this.now() + 2_000);
    this.manualInput();
    if (this.active) this.pause('Yielding to an official game action.', 2_000);
  }
  officialLook(): void {
    if (this.runRequested || this.macro.active) {
      this.manualInput();
      return;
    }
    this.quietUntil = Math.max(this.quietUntil, this.now() + 2_000);
    this.manualInput();
    this.engine.castAvailability.cancel('Official Look input stopped automatic cast recovery.');
  }
  /** The bridge observes only official opcode 80, before forwarding it. */
  officialRefineCommand(character: string | null): void {
    this.refine.officialCommand(character);
  }
  officialRefineResourceRevision(): string | null {
    if (this.warp.blocked) return null;
    return this.initializationResourceRevision(false);
  }
  private initializationResourceRevision(strong: boolean): string | null {
    if (
      !this.engine.observedOwnCastSettled() ||
      this.engine.retreatOwned ||
      this.partyFollow.ownsTravel ||
      this.partyHeal.busy ||
      this.partyHeal.awaitingSpReadback ||
      !this.movementSettled()
    )
      return null;
    const c = this.refineContext();
    const revisions: number[] = [
      c.connection,
      c.inventoryRevision,
      c.equipmentRevision,
      c.currencyRevision,
    ];
    if (strong)
      revisions.push(this.engine.character.spRevision, this.engine.character.skillsRevision);
    return c.inventory && c.equipment && c.zeny !== null ? JSON.stringify(revisions) : null;
  }
  /** First full56 only: capture state for the bridge's certified new-runtime path. */
  officialInitializationResourceRevision(): string | null {
    return this.initializationResourceRevision(true);
  }
  /** The bridge certifies closed old transports, first Enter and stable official input. */
  reconcileOfficialInitialization(revision: string): boolean {
    const context = this.refineContext();
    if (
      !context.ready ||
      !context.identity ||
      this.engine.running ||
      revision !== this.initializationResourceRevision(true) ||
      !this.refineRuntimeSettled() ||
      this.world.npc.id !== null ||
      this.world.npc.mode !== 'idle' ||
      !this.warp.initializedSession(this.warpContext())
    )
      return false;
    // These are availability resets. Refine retains an unknown official outcome;
    // Warp still uses its ordinary strict idle gate after that owner retires.
    this.refine.reconcileOfficialInitialization(context);
    this.warp.tick(this.warpContext());
    return true;
  }
  /** Only the bridge's closed-transport, first-Enter initialization path calls this. */
  reconcileOfficialRefineInitialization(revision: string): void {
    if (this.engine.observedOwnCastSettled() && revision === this.officialRefineResourceRevision())
      this.refine.reconcileOfficialInitialization(this.refineContext());
  }
  heartbeat(healthy: boolean): void {
    this.heartbeatHealthy = healthy;
    this.socket.tick(this.socketContext());
    this.refine.tick(this.refineContext());
    if (!healthy && this.executing && !this.updateSuspended)
      this.pause('Waiting for the client connection.');
  }
  private captureActionFailure(): void {
    const result = this.engine.actionResult;
    if (this.partyHeal.owns(result.sequence)) {
      if (result.status === 'failed') this.partyHeal.cancel(result.reason);
      this.seenActionKey = `${result.sequence}:${result.status}`;
      return;
    }
    if (this.featureReceipt && (this.macro.active || this.macroBase))
      this.featureMacroSequence = this.featureReceipt.sequence;
    const key = `${result.sequence}:${result.status}`;
    if (key === this.seenActionKey) return;
    this.seenActionKey = key;
    if (result.status !== 'failed') return;
    const receipt = this.engine.actionReceipts.retireReceipt(this.runRequested);
    if (!this.runRequested) return;
    if (receipt === 'rejected') {
      this.retryAt = this.now() + 5_000;
      this.waitingReason = result.reason;
    } else if (receipt === 'uncertain') {
      this.blockedReason = `${result.reason} Waiting for a confirmed result; Stop and Start after checking to override.`;
    } else {
      this.retryAt = this.now() + 250;
    }
  }
  private reconcileFeature(events: ReturnType<typeof decode>): void {
    const receipt = this.featureReceipt;
    if (!receipt || (!this.blockedReason && this.featureMacroSequence !== receipt.sequence)) return;
    const policy = automationSettings(this.requestedSettings ?? this.engine.settings);
    const seconds = this.engine.actionReceipts.reconcileReceipt(
      events,
      this.engine.character,
      this.engine.player?.id ?? null,
      policy,
    );
    if (seconds === null) return;
    this.blockedReason = '';
    this.featureMacroSequence = null;
    this.retryAt = this.now() + seconds * 1000;
    this.waitingReason = 'Canceled action was confirmed; waiting for its configured cooldown.';
  }
  private requireReady(): void {
    if (
      !this.engine.connected ||
      !this.engine.compatible ||
      !this.engine.player ||
      !this.engine.map
    )
      throw new Error('Enter a character in the verified game build first.');
    if (this.now() - this.lastFrame > 15_000) throw new Error('Game status is stale.');
  }
  settledForMaintenance(): boolean {
    this.refine.tick(this.refineContext());
    const e = this.engine;
    const stationary = this.movementSettled();
    return (
      !this.refine.maintenanceBlocked &&
      stationary &&
      e.connected &&
      e.compatible &&
      !!e.actorActionIdentity(undefined, true) &&
      (!this.macro.active || (this.updateSuspended && this.macro.checkpoint() !== null)) &&
      (!this.runRequested || this.updateSuspended) &&
      (!this.returning || this.updateSuspended) &&
      !this.pending &&
      !this.featureReceipt &&
      !this.workflowOutstanding &&
      !this.unresolvedWorld &&
      !this.travel.active &&
      !this.service.active &&
      !this.workflow.snapshot().running &&
      !['running', 'waiting'].includes(this.routine.snapshot().state) &&
      !this.supply.ownsField &&
      !this.supply.uncertain &&
      !this.escape.busy &&
      this.warp.settledForMaintenance() &&
      !this.memo.blocked &&
      !this.socket.busy &&
      !this.social.busy &&
      !this.partyHeal.busy &&
      !this.partyHeal.awaitingSpReadback &&
      !this.deathCycle?.guard.uncertain &&
      !this.deathCycle?.posture &&
      this.now() >= this.fencedUntil &&
      this.now() >= this.yieldUntil &&
      this.world.npc.id === null &&
      this.world.npc.mode === 'idle' &&
      !this.world.vending &&
      e.settledForMaintenance()
    );
  }
  prepareUpdate(): void {
    this.updateSuspended = true;
    this.engine.prepareUpdate();
    this.updateTick();
  }
  updateCheckpoint(): ControllerUpdateCheckpoint | null {
    if (!this.updateSuspended || !this.settledForMaintenance()) return null;
    const macro = this.macro.active ? this.macro.checkpoint() : null,
      partyHeal = this.partyHeal.checkpoint();
    if ((this.macro.active && !macro) || !partyHeal) return null;
    return {
      version: 1,
      frozenAt: this.now(),
      status: structuredClone(this.snapshot()),
      settings: structuredClone(this.macroBase ?? this.requestedSettings),
      macro,
      partyHeal,
      liveSettingsGuard: this.liveSettingsProtection(),
      run:
        this.runRequested || this.macro.active
          ? {
              startedAt: this.started,
              kills: Math.max(0, this.engine.kills - this.runKills),
              pickups: Math.max(0, this.engine.looted - this.runPickups),
              deaths: this.engine.deaths,
            }
          : null,
    };
  }
  cancelUpdate(): void {
    this.updateSuspended = false;
    this.engine.cancelUpdate();
    this.lastTick = this.now();
  }
  restoreUpdate(
    value: unknown,
    remainingSettings?: Settings,
    escapeGuard?: EscapeResumeGuard,
    supplyGuard?: SupplyResumeGuard,
    recoveryGuard?: DeathRecoveryGuard,
  ): void {
    const checkpoint = validateControllerUpdateCheckpoint(value, this.now());
    this.requireReady();
    if (
      this.updateSuspended ||
      this.active ||
      !this.settledForMaintenance() ||
      !this.readyOwn?.initialization ||
      this.readyOwn.identity !== this.deathIdentity() ||
      checkpoint.status.player?.name !== this.engine.player?.name
    )
      throw new Error('Update continuation requires a fresh settled entry of the same character.');
    const settings = remainingSettings ? validateSettings(remainingSettings) : checkpoint.settings;
    if (checkpoint.macro && settings)
      for (const rule of checkpoint.macro.script.rules)
        for (const step of rule.steps)
          if (step.type === 'farm') this.macroFieldSettings(step, settings);
    const elapsed = Math.max(0, Math.floor((this.now() - checkpoint.frozenAt) / 1000));
    if (!supplyGuard && checkpoint.status.supplyGuard) {
      const guard = checkpoint.status.supplyGuard;
      supplyGuard = {
        ...guard,
        intervalSeconds: Math.max(0, guard.intervalSeconds - elapsed),
        deadlineSeconds: Math.max(0, guard.deadlineSeconds - elapsed),
      };
    }
    if (
      !escapeGuard &&
      checkpoint.status.escape &&
      (checkpoint.status.escape.latched || checkpoint.status.escape.cooldownSeconds > 0)
    ) {
      const escape = checkpoint.status.escape;
      escapeGuard = {
        latched: escape.latched,
        cooldownSeconds: Math.max(0, escape.cooldownSeconds - elapsed),
        ...(escape.recovery ? { recovery: escape.recovery } : {}),
      };
    }
    recoveryGuard ??= checkpoint.status.deathRecoveryGuard;
    if (escapeGuard) validateEscapeResumeGuard(escapeGuard);
    if (supplyGuard) {
      supplyGuard = validateSupplyResumeGuard(supplyGuard);
      if (supplyGuard.character !== this.engine.player?.name)
        throw new Error('Supply continuation belongs to a different character.');
    }
    if (recoveryGuard) {
      recoveryGuard = validateDeathRecoveryGuard(recoveryGuard);
      if (
        !settings ||
        recoveryGuard.character !== this.engine.player?.name ||
        recoveryGuard.destination !== farmingDestination(settings)
      )
        throw new Error(
          'Death recovery continuation belongs to a different character or destination.',
        );
    }
    // Macro.restore checks its retained clock floor before replacing any state.
    // Run/guard inputs above are already validated before this first mutation.
    if (checkpoint.macro) this.macro.restore(checkpoint.macro);
    if (settings && checkpoint.run) {
      const run = remainingSettings
        ? { ...checkpoint.run, startedAt: this.now(), kills: 0, pickups: 0, deaths: 0 }
        : checkpoint.run;
      this.engine.restoreRequestedRun(settings, run);
      if (checkpoint.liveSettingsGuard) {
        this.resourceGuard = checkpoint.liveSettingsGuard;
        this.engine.restoreLiveSettingsCooldowns(checkpoint.liveSettingsGuard.cooldowns);
      }
      this.supply.configure(settings, this.supplyContext(), supplyGuard);
      this.started = run.startedAt;
      this.runKills = this.engine.kills - run.kills;
      this.runPickups = this.engine.looted - run.pickups;
      this.cycleDeaths = this.engine.deaths;
      this.characterName = this.engine.player!.name;
      if (checkpoint.status.runExperience) {
        this.runExperience = {
          ...checkpoint.status.runExperience,
          ...(remainingSettings ? { revision: 0, baseGained: 0, jobGained: 0 } : {}),
        };
        this.experienceRun = this.runExperience.run;
        this.experienceConnection = this.connectionEpoch;
      }
      this.requestedSettings = checkpoint.status.runRequested ? structuredClone(settings) : null;
      this.initialFieldEntryPending =
        !!this.requestedSettings && checkpoint.status.initialFieldEntryPending === true;
      this.returnSettings = automationSettings(settings).travel.returnToLockMap
        ? { ...structuredClone(settings), map: farmingDestination(settings) }
        : null;
      if (recoveryGuard) {
        this.deathCycle = deathCycle(recoveryGuard, this.now());
        this.returning = true;
      }
      if (escapeGuard) this.escape.restoreOnReconnect(settings, escapeGuard, this.escapeContext());
      this.engine.castAvailability.allowRun();
      const followSettings = settingsDraft(settings),
        policy = automationDraft(automationSettings(followSettings));
      if (policy.follow.mode === 'partyLeader') policy.follow.rendezvous = false;
      followSettings.automation = policy;
      this.partyFollow.start(followSettings, this.partyFollowContext());
    }
    this.partyHeal.restore(checkpoint.partyHeal);
    if (checkpoint.macro) {
      this.macroBase = structuredClone(settings!);
      this.macroPredicates = routineActorPredicates(checkpoint.macro.script.rules);
      const field = this.macro.fieldIntent;
      if (field) this.requestedSettings = this.macroFieldSettings(field);
    }
    this.lastTick = this.now();
    this.retryAt = 0;
    this.waitingReason =
      'Update continuation accepted; waiting for fresh verified field decisions.';
  }
  private updateTick(): void {
    this.lastTick = this.now();
    this.engine.tick(false);
    this.captureActionFailure();
    this.syncWorkflowOwner();
    this.social.tick();
    this.memo.tick(this.memoContext());
    this.warp.tick(this.warpContext());
    this.socket.tick(this.socketContext());
    this.refine.tick(this.refineContext());
    if (this.travel.teleportPending) this.travel.tick(this.engine.map, this.engine.player);
    this.partyHeal.resourcesReadBack(this.engine.actorObservation([]));
    if (this.pending?.engineSequence !== undefined) {
      const result = this.engine.actionResult;
      if (result.sequence === this.pending.engineSequence && result.status !== 'pending')
        this.completePending(result.status === 'confirmed', result.reason);
    }
    if (this.pending?.workflow && !this.workflow.snapshot().running) {
      const state = this.workflow.snapshot();
      this.completePending(state.state === 'complete', state.reason);
    }
    this.engine.settleUpdate();
  }
  private requireIdle(): void {
    this.requireReady();
    if (!this.travel.movementSettled(this.engine.map, this.engine.player))
      throw new Error('Wait for canceled rendezvous movement to settle.');
    if (!this.engine.observedOwnCastSettled()) throw new Error(OWN_CAST_WAIT_REASON);
    if (
      this.deathCycle?.guard.uncertain ||
      this.deathCycle?.posture ||
      this.warp.blocked ||
      this.socket.busy ||
      this.memo.blocked ||
      this.active ||
      this.escape.busy ||
      this.supply.uncertain ||
      this.unresolvedWorld ||
      this.now() < this.fencedUntil ||
      !this.engine.idleForActions()
    )
      throw new Error('Stop automation and wait for the current action to finish.');
  }
  start(
    input: Settings,
    escapeGuard?: EscapeResumeGuard,
    supplyGuard?: SupplyResumeGuard,
    recoveryGuard?: DeathRecoveryGuard,
    liveGuard?: LiveSettingsGuard,
  ): void {
    if (this.updateSuspended)
      throw new Error('Client update is waiting for current actions to settle.');
    const settings = validateSettings(input);
    const protection = liveGuard ? validateLiveSettingsGuard(liveGuard, this.now()) : null;
    if (protection && protection.character !== this.engine.player?.name)
      throw new Error('Live settings protection belongs to a different character.');
    if (recoveryGuard) {
      recoveryGuard = validateDeathRecoveryGuard(recoveryGuard);
      if (
        recoveryGuard.character !== this.engine.player?.name ||
        recoveryGuard.destination !== farmingDestination(settings)
      )
        throw new Error(
          'Death recovery state belongs to a different character or farming destination.',
        );
    }

    if (escapeGuard) validateEscapeResumeGuard(escapeGuard);
    const context = this.supplyContext();
    if (supplyGuard) {
      supplyGuard = validateSupplyResumeGuard(supplyGuard);
      if (supplyGuard.character !== context.character)
        throw new Error('Supply resume state belongs to a different character.');
    }
    if (this.refine.blocked)
      throw new Error('Waiting for the previous refine transaction to reconcile.');
    if (this.supply.uncertain)
      throw new Error('Waiting for the previous supply transaction to reconcile.');
    if (
      this.warp.blocked ||
      this.socket.busy ||
      this.memo.blocked ||
      this.active ||
      this.engine.retreatOwned ||
      this.engine.manualTargetOwned ||
      this.engine.pendingFeatureAction
    )
      throw new Error('Stop the current automation or manual action before requesting a new run.');
    if (!this.travel.movementSettled(this.engine.map, this.engine.player))
      throw new Error('Waiting for canceled rendezvous movement to settle before Start.');
    if (this.partyHeal.busy)
      throw new Error('Waiting for the previous party Heal execution receipt.');
    this.beginRun(settings, escapeGuard, supplyGuard, recoveryGuard);
    this.initialFieldEntryPending = !this.partyFollow.enabled && settings.map !== this.engine.map;
    if (protection) {
      this.resourceGuard = protection;
      this.engine.restoreLiveSettingsCooldowns(protection.cooldowns);
    }
    this.tick();
  }
  /** An Apply request changes no game action or run allowance. Runtime status,
   * rather than native dispatch success, acknowledges the committed projection.
   */
  applySettings(input: Settings, id: string): void {
    if (!validSettingsApplyId(id)) throw new Error('Invalid settings Apply request.');
    if (this.settingsApply?.id === id) return;
    try {
      if (this.updateSuspended)
        throw new Error('Wait for the client update before applying settings.');
      if (!this.requestedSettings)
        throw new Error('No current field run. Saved settings will be used by Start.');
      const plan = planLiveSettings(
        this.requestedSettings,
        input,
        this.protectedSettings ?? this.requestedSettings,
        this.resourceGuard,
      );
      if (this.macro.active)
        throw new Error(
          'Macro field settings are owned by the script. Saved edits are for the next run.',
        );
      this.pendingSettings = {
        id,
        plan,
        character: this.characterName ?? this.engine.player?.name ?? '',
      };
      this.settingsApply = {
        id,
        state: 'pending',
        applied: [],
        pending: plan.live,
        nextRun: plan.nextRun,
        reason: 'Waiting for the current action and its confirmation to settle.',
      };
      this.applySettledSettings();
    } catch (error) {
      this.pendingSettings = null;
      this.settingsApply = {
        id,
        state: 'rejected',
        applied: [],
        pending: [],
        nextRun: [],
        reason: error instanceof Error ? error.message : 'Invalid settings draft.',
      };
    }
  }
  private applySettledSettings(): void {
    const request = this.pendingSettings,
      e = this.engine;
    if (!request || !this.requestedSettings || this.updateSuspended) return;
    if (
      !e.connected ||
      !e.compatible ||
      !e.player ||
      e.player.name !== request.character ||
      this.now() - this.lastFrame > 15_000 ||
      !e.actorActionIdentity(undefined, true) ||
      !this.movementSettled() ||
      !e.settledForSettings() ||
      this.pending ||
      this.featureReceipt ||
      this.workflowOutstanding ||
      this.unresolvedWorld ||
      this.blockedReason ||
      this.travel.active ||
      this.service.active ||
      this.workflow.snapshot().running ||
      ['running', 'waiting'].includes(this.routine.snapshot().state) ||
      this.macro.active ||
      this.partyFollow.ownsTravel ||
      this.supply.ownsField ||
      this.supply.uncertain ||
      this.escape.busy ||
      this.warp.blocked ||
      this.refine.maintenanceBlocked ||
      this.memo.blocked ||
      this.socket.busy ||
      this.social.busy ||
      this.partyHeal.busy ||
      this.partyHeal.awaitingSpReadback ||
      this.deathCycle?.guard.uncertain ||
      this.deathCycle?.posture ||
      this.now() < this.fencedUntil ||
      this.now() < this.yieldUntil ||
      this.world.npc.id !== null ||
      this.world.npc.mode !== 'idle' ||
      this.world.vending
    )
      return;
    try {
      const settings = request.plan.settings;
      const engineSettings = validateSettings({ ...settings, map: e.settings.map });
      const returnSettings = this.returnSettings
        ? validateSettings({ ...settings, map: this.returnSettings.map })
        : null;
      const originalGuard = liveSettingsGuard(
        this.protectedSettings ?? this.requestedSettings,
        this.resourceGuard,
        request.character,
        e.liveSettingsCooldowns(),
        this.now(),
      );
      const protection = liveSettingsGuard(
        settings,
        originalGuard,
        request.character,
        e.liveSettingsCooldowns(),
        this.now(),
      );
      // All admissions precede this synchronous commit. No new-run initializer,
      // scheduler reset, guard configuration or transport effect is involved.
      e.applyRunSettings(engineSettings);
      this.requestedSettings = settings;
      this.returnSettings = returnSettings;
      this.resourceGuard = protection;
      this.pendingSettings = null;
      this.settingsApply = {
        id: request.id,
        state: 'applied',
        applied: request.plan.live,
        pending: [],
        nextRun: request.plan.nextRun,
        reason:
          'Applied to the same run. Original allowances, reserves and cooldowns remain protected.',
      };
    } catch (error) {
      this.pendingSettings = null;
      this.settingsApply = {
        id: request.id,
        state: 'rejected',
        applied: [],
        pending: [],
        nextRun: request.plan.nextRun,
        reason:
          error instanceof Error
            ? error.message
            : 'Could not admit settings at the settled boundary.',
      };
    }
  }
  private liveSettingsProtection(): LiveSettingsGuard | null {
    return this.requestedSettings && this.resourceGuard
      ? liveSettingsGuard(
          this.requestedSettings,
          this.resourceGuard,
          this.characterName ?? this.resourceGuard.character,
          this.engine.liveSettingsCooldowns(),
          this.now(),
        )
      : null;
  }
  /** Explicit run initialization happens once; stage projections only resume it. */
  private beginRun(
    settings: RunSettings,
    escapeGuard?: EscapeResumeGuard,
    supplyGuard?: SupplyResumeGuard,
    recoveryGuard?: DeathRecoveryGuard,
  ): void {
    const context = this.supplyContext();
    this.partyHeal.newRun();
    this.supply.configure(settings, context, supplyGuard);
    this.engine.acknowledgeLoadoutOverride();
    this.engine.prepareRequestedRun(settings);
    this.cycleDeaths = this.engine.deaths;
    if (recoveryGuard && !this.deathCycle?.guard.uncertain && !this.deathCycle?.posture) {
      this.deathCycle = deathCycle(recoveryGuard, this.now());
      this.deathCycleConnection = null;
    } else if (this.deathCycle && !this.deathCycle.guard.uncertain && !this.deathCycle.posture)
      this.deathCycle = null;
    this.returnSettings = automationSettings(settings).travel.returnToLockMap
      ? { ...structuredClone(settings), map: farmingDestination(settings) }
      : null;
    this.returning = !!this.deathCycle;
    this.initialFieldEntryPending = false;
    this.requestedSettings = settings;
    this.characterName = this.engine.player?.name ?? null;
    this.engine.actionReceipts.discardReceipt();
    this.featureMacroSequence = null;
    this.protectedSettings = settings;
    this.pendingSettings = null;
    this.settingsApply = null;
    this.resourceGuard = null;
    this.started = this.now();
    this.lastTick = this.now();
    this.retryAt = 0;
    this.retries = 0;
    this.runExperience = {
      character: this.characterName!,
      run: ++this.experienceRun,
      revision: 0,
      baseGained: 0,
      jobGained: 0,
    };
    this.experienceConnection = this.connectionEpoch;
    this.blockedReason = '';
    this.waitingReason = 'Preparing the requested run.';
    this.seenActionKey = `${this.engine.actionResult.sequence}:${this.engine.actionResult.status}`;
    this.runKills = this.engine.kills;
    this.runPickups = this.engine.looted;
    this.supplyStorageFull = null;
    this.supplyIntent = null;
    this.supplyCloseSent = false;
    this.supplyReturnApproach = false;
    this.partyFollow.start(settings, this.partyFollowContext());
    if (escapeGuard) this.escape.restoreOnReconnect(settings, escapeGuard, this.escapeContext());
    this.engine.castAvailability.allowRun();
  }

  context(): WorkflowContext {
    const engine = this.engine;
    const character = engine.character;
    return {
      map: engine.map,
      playerId: engine.player?.id ?? null,
      alive: !!engine.player && !engine.player.dead,
      idle: engine.idleForActions(),
      inventory: character.inventoryKnown ? [...character.inventory.values()] : [],
      equipped: [...character.equipment, character.ammoId],
      zeny: character.stats?.zeny ?? -1,
      world: this.world,
      itemCatalog: ITEM_CATALOG,
      visibleNpcIds: map(
        filter([...engine.actors.values()], (e) => isTalkNpc(e) && !e.dead),
        (e) => e.id,
      ),
      visibleVendorIds: map(
        filter([...engine.actors.values()], (e) => isPlayerShop(e) && !e.dead),
        (e) => e.id,
      ),
      actorIdentity: (id) =>
        engine.actorActionIdentity(id) ?? (id === 0 ? null : engine.actorActionIdentity()),
      visiblePlayerIds: map(
        filter([...engine.actors.values()], (e) => e.kind === 0 && !e.dead),
        (e) => e.id,
      ),
      basicSkillLevel: character.skillsKnown ? character.skillLevel(domainSkillId(1)) : 0,
      pushCartLevel: character.skillsKnown ? character.skillLevel(domainSkillId(73)) : 0,
      vendingLevel: character.skillsKnown ? character.skillLevel(domainSkillId(70)) : 0,
    };
  }
  private serviceContext(): ServiceContext {
    return {
      ...this.context(),
      player: this.engine.player,
      actors: [...this.engine.actors.values()],
      connection: this.connectionEpoch,
      inventoryKnown: this.engine.character.inventoryKnown,
    };
  }
  private socketContext(
    floors: ReadonlyMap<ItemId, Quantity> = this.socketFloors ??
      socketStockFloors(automationSettings(this.engine.settings)),
  ): SocketContext {
    const e = this.engine,
      c = e.character,
      p = e.player,
      actor = e.actorActionIdentity();
    const stationary = this.movementSettled();
    const identity = actor
      ? JSON.stringify([actor.world, actor.selfId, actor.selfIncarnation])
      : '';
    const init = this.socketInitialization;
    if (init && identity && init.identity === null) init.identity = identity;
    const readbackKey = identity
      ? init?.identity === identity
        ? init.key
        : identity
      : init?.identity === null
        ? init.key
        : null;
    return {
      ready:
        !!identity &&
        !!p &&
        !p.dead &&
        p.hp > 0 &&
        e.connected &&
        e.compatible &&
        !!e.map &&
        this.now() - this.lastFrame <= 15_000,
      settled:
        stationary &&
        !this.warp.blocked &&
        !this.refine.blocked &&
        !this.memo.blocked &&
        !this.returning &&
        !this.runRequested &&
        !e.running &&
        !this.pending &&
        !this.featureReceipt &&
        !this.unresolvedWorld &&
        !this.workflowOutstanding &&
        !this.social.busy &&
        !this.escape.busy &&
        !this.supply.ownsField &&
        !this.supply.uncertain &&
        !this.service.active &&
        !this.travel.active &&
        !this.workflow.snapshot().running &&
        !['running', 'waiting'].includes(this.routine.snapshot().state) &&
        e.featureActionsSettled &&
        e.idleForActions() &&
        this.now() >= this.fencedUntil &&
        this.now() >= this.yieldUntil &&
        this.heartbeatHealthy &&
        this.world.npc.id === null &&
        this.world.npc.mode === 'idle' &&
        !this.world.vending,
      character: p?.name ?? '',
      identity,
      readbackKey,
      connection: revisionFor('connection', this.connectionEpoch),
      map: e.map,
      inventoryKnown: c.inventoryKnown,
      equipmentKnown: c.inventoryKnown && c.equipmentRevision > 0,
      inventoryRevision: c.inventoryRevision,
      equipmentRevision: c.equipmentRevision,
      inventory: c.inventory,
      equipment: c.equipment,
      ammoId: c.ammoId,
      floors,
    };
  }
  private clearRefineContext(): void {
    this.refineNpcGeneration++;
    this.refineNpcIdentity = null;
    this.refinePromptToken = null;
    this.refineInitialization = null;
  }
  private refineIdentity(target?: number): string | null {
    const identity = this.engine.actorActionIdentity(target);
    return identity ? JSON.stringify(identity) : null;
  }
  private observeRefineNpc(event: WorldEvent): void {
    if (event.type === 'npcFocus') {
      this.refineNpcGeneration++;
      this.refinePromptToken = null;
      this.refineNpcIdentity = event.focus ? this.refineIdentity(event.id) : null;
    } else if (event.type === 'npcRefine') {
      this.refineNpcGeneration++;
      const id = this.world.npc.id;
      const identity = id === null ? null : this.refineIdentity(id);
      this.refinePromptToken =
        identity && identity === this.refineNpcIdentity
          ? crypto.randomUUID().replaceAll('-', '')
          : null;
    } else if (
      [
        'npcDialog',
        'npcOptions',
        'npcEnd',
        'shopOpened',
        'storageOpened',
        'barterOpened',
        'vendingViewed',
      ].includes(event.type)
    ) {
      this.refineNpcGeneration++;
      this.refinePromptToken = null;
      if (event.type === 'npcEnd') this.refineNpcIdentity = null;
    }
  }
  private refineRuntimeSettled(): boolean {
    const e = this.engine;
    return (
      e.observedOwnCastSettled() &&
      !e.retreatOwned &&
      !this.partyFollow.ownsTravel &&
      !this.partyHeal.busy &&
      !this.partyHeal.awaitingSpReadback &&
      e.idleForActions() &&
      e.featureActionsSettled &&
      this.movementSettled() &&
      !this.socket.busy &&
      !this.memo.blocked &&
      !this.runRequested &&
      !this.returning &&
      !this.pending &&
      !this.featureReceipt &&
      !this.unresolvedWorld &&
      !this.workflowOutstanding &&
      !this.social.busy &&
      !this.escape.busy &&
      !this.supply.ownsField &&
      !this.supply.uncertain &&
      !this.service.active &&
      !this.travel.active &&
      !this.workflow.snapshot().running &&
      !['running', 'waiting'].includes(this.routine.snapshot().state) &&
      !this.deathCycle?.guard.uncertain &&
      !this.deathCycle?.posture &&
      this.now() >= this.fencedUntil &&
      this.now() >= this.yieldUntil &&
      !this.world.vending
    );
  }
  private refineContext(): RefineContext {
    const e = this.engine,
      c = e.character,
      p = e.player,
      identity = this.refineIdentity(),
      npcId = this.world.npc.id;
    const actor = npcId === null ? null : e.actors.get(npcId),
      candidate = npcId === null ? null : this.refineIdentity(npcId);
    const npcIdentity =
      actor && isTalkNpc(actor) && candidate === this.refineNpcIdentity ? candidate : null;
    const init = this.refineInitialization;
    if (init && identity && init.identity === null) init.identity = identity;
    const readbackKey = identity
      ? init?.identity === identity
        ? init.key
        : identity
      : init?.identity === null
        ? init.key
        : null;
    return {
      ready:
        !!p &&
        !p.dead &&
        !!identity &&
        e.connected &&
        e.compatible &&
        this.heartbeatHealthy &&
        this.now() - this.lastFrame <= 15000,
      settled: !this.warp.blocked && this.refineRuntimeSettled(),
      identity,
      character: p?.name ?? null,
      readbackKey,
      connection: revisionFor('connection', this.connectionEpoch),
      map: e.map,
      npcId,
      npcIdentity,
      npcGeneration: this.refineNpcGeneration,
      npcMode: this.world.npc.mode,
      promptToken: npcIdentity ? this.refinePromptToken : null,
      inventory: c.inventoryKnown ? [...c.inventory.values()] : null,
      equipment: c.inventoryKnown ? [...c.equipment, c.ammoId] : null,
      zeny: c.stats?.zeny ?? null,
      inventoryRevision: c.inventoryRevision,
      equipmentRevision: c.equipmentRevision,
      currencyRevision: revisionFor('currency', this.supplyCurrencyRevision),
      activityRevision: revisionFor('activity', this.refineActivityRevision),
    };
  }
  private socialContext(): SocialContext {
    const p = this.engine.player,
      c = this.engine.character;
    return {
      ready:
        !!p &&
        this.engine.connected &&
        this.engine.compatible &&
        !!this.engine.map &&
        this.now() - this.lastFrame <= 15_000,
      actorId: p?.id ?? null,
      name: p?.name ?? '',
      job: p?.classId ?? null,
      learnedBasic: c.skillsKnown ? (c.learned.get(domainSkillId(1)) ?? 0) : null,
      inParty: this.world.party !== null,
      silenced: c.statuses.has(6),
    };
  }
  private manualWorldBlocker(): string | null {
    return this.world.npc.mode !== 'idle' || this.world.npc.id !== null || !!this.world.vending
      ? 'Finish the NPC or vending interaction before a manual command.'
      : null;
  }
  private memoContext(): MemoContext {
    const p = this.engine.player,
      actor = this.engine.actorActionIdentity();
    const grid = this.gridFor(this.engine.map);
    // idleForActions includes accepted motion, outstanding walk legs, casts and
    // equipment receipts. An interpolated destination alone is not stationary evidence.
    const settled = this.engine.idleForActions();
    const x = Math.floor(p?.x ?? -1),
      y = Math.floor(p?.y ?? -1);
    const stationary = this.movementSettled();
    const idle =
      settled &&
      stationary &&
      !this.refine.blocked &&
      !this.socket.busy &&
      !this.runRequested &&
      !this.engine.running &&
      !this.returning &&
      !this.social.busy &&
      !this.service.active &&
      !this.travel.active &&
      !this.escape.busy &&
      !this.pending &&
      !this.workflow.snapshot().running &&
      !['running', 'waiting'].includes(this.routine.snapshot().state) &&
      !this.supply.ownsField &&
      !this.supply.uncertain &&
      !this.unresolvedWorld &&
      !this.workflowOutstanding &&
      !this.featureReceipt &&
      this.now() >= this.fencedUntil &&
      this.now() >= this.yieldUntil &&
      this.heartbeatHealthy &&
      this.world.npc.id === null &&
      this.world.npc.mode === 'idle' &&
      !this.world.vending;
    return {
      ready: !!p && !p.dead && !!actor && this.now() - this.lastFrame <= 15_000,
      idle,
      world: actor?.world ?? '',
      actorId: actor?.selfId ?? null,
      incarnation: actor?.selfIncarnation ?? null,
      connectionEpoch: this.connectionEpoch,
      map: this.engine.map,
      x,
      y,
      walkable: grid
        ? x >= 0 && y >= 0 && x < grid.width && y < grid.height && grid.walkable({ x, y })
        : null,
      canMemo: canMemoMap(this.engine.map),
      learnedWarp: this.engine.character.skillsKnown
        ? (this.engine.character.learned.get(domainSkillId(55)) ?? 0)
        : null,
    };
  }
  /** Captures ordered initialization/Ready evidence; ordinary input takeover has its own hook. */
  observeOfficialPacket(data: Uint8Array): void {
    const event = warpInitializationPacket(data);
    if (event) {
      this.warp.initialization(event);
      if (event.type === 'playerReady') this.travel.observeReady();
    } else if (officialWarpSkill(data)) this.warp.externalWarp();
  }
  private warpContext(
    policy: AutomationSettings = this.warpPolicy ?? automationSettings(this.engine.settings),
  ): WarpContext {
    const base = this.memoContext(),
      c = this.engine.character,
      memo = this.memo.snapshot(base);
    const readiness = warpCastReadiness(
      c,
      this.engine.actorObservation([...CAST_PREREQUISITES, BLIND_CONDITION]),
    );
    const castSettled = this.engine.observedOwnCastSettled();
    const p = this.engine.player,
      level = c.skillsKnown ? (c.learned.get(domainSkillId(55)) ?? 0) : 0;
    const binding =
      base.actorId !== null && base.incarnation !== null
        ? {
            world: base.world,
            actorId: base.actorId,
            incarnation: base.incarnation,
            connectionEpoch: base.connectionEpoch,
            revision: memo.revision,
            map: base.map,
            x: base.x,
            y: base.y,
            generation: this.warp.revision,
            level,
            inventoryRevision: c.inventoryRevision,
            equipmentRevision: c.equipmentRevision,
            spRevision: c.spRevision,
            skillsRevision: c.skillsRevision,
          }
        : null;
    return {
      ready: base.ready,
      idle:
        base.idle &&
        !this.partyFollow.ownsTravel &&
        !this.partyHeal.busy &&
        !this.partyHeal.awaitingSpReadback &&
        !this.deathCycle?.guard.uncertain &&
        !this.deathCycle?.posture &&
        !this.memo.blocked,
      character: p?.name ?? '',
      connection: this.connectionEpoch,
      binding,
      slots: memo.slots,
      unavailable: !castSettled
        ? OWN_CAST_WAIT_REASON
        : readiness.state === 'ready'
          ? null
          : readiness.reason,
      sp: c.stats?.sp ?? null,
      gems: c.inventoryKnown ? c.count(domainItemId(717)) : null,
      reserve: quantity(
        Math.max(
          0,
          ...dispositionStockFloors(policy)
            .filter((row) => row.itemId === 717)
            .map((row) => row.count),
          ...(policy.disposition?.rules ?? [])
            .filter((row) => row.itemId === 717)
            .map((row) => row.keep),
        ),
      ),
      cost: readiness.state === 'ready' ? readiness.profile.spCost : null,
      resourcesReady: c.inventoryKnown && c.equipment.length === 10 && c.spRevision > 0,
      groundAllowed: (target) =>
        castSettled &&
        readiness.state === 'ready' &&
        this.engine.manualWarpGroundAllowed(target, readiness.profile.range, policy),
    };
  }
  perform(
    mode:
      | 'command'
      | 'workflow'
      | 'routine'
      | 'macro'
      | 'service'
      | 'social'
      | 'memo'
      | 'socketPreview'
      | 'socket'
      | 'refinePreview'
      | 'refine'
      | 'refineAdvance'
      | 'warp'
      | 'warpPreview'
      | 'warpCancel',
    input: unknown,
  ): void {
    if (this.updateSuspended)
      throw new Error('Client update is waiting for current actions to settle.');
    if (mode === 'macro') {
      if (
        !input ||
        typeof input !== 'object' ||
        Array.isArray(input) ||
        Object.keys(input).length !== 2 ||
        !Object.hasOwn(input, 'script') ||
        !Object.hasOwn(input, 'settings')
      )
        throw new Error('Macro request requires exactly script and settings.');
      const request = input as { script: unknown; settings: Settings };
      const script = validateMacroScript(request.script),
        settings = validateSettings(request.settings);
      this.requireIdle();
      if (
        this.engine.player!.dead ||
        this.engine.player!.hp <= 0 ||
        !this.engine.actorActionIdentity()
      )
        throw new Error('A current living own actor is required for a macro.');
      if (
        this.featureReceipt ||
        this.workflowOutstanding ||
        this.blockedReason ||
        this.partyHeal.awaitingSpReadback
      )
        throw new Error('Wait for all previous action receipts before a macro.');
      if (this.world.npc.id !== null || this.world.npc.mode !== 'idle' || this.world.vending)
        throw new Error('Finish the current NPC interaction before a macro.');
      if (automationSettings(settings).follow.mode === 'partyLeader')
        throw new Error('Party leader follow cannot own a macro map.');
      for (const rule of script.rules)
        for (const step of rule.steps)
          if (step.type === 'farm') this.macroFieldSettings(step, settings);
      this.beginRun(settings);
      this.macroBase = structuredClone(settings);
      this.macroPredicates = routineActorPredicates(script.rules);
      this.macro.start(script);
      this.tick();
      return;
    }
    if (mode === 'refinePreview' || mode === 'refine') {
      const context = this.refineContext();
      this.refine.tick(context);
      this.requireIdle();
      if (mode === 'refinePreview') this.refine.preview(input, context);
      else this.refine.dispatch(input, context);
      return;
    }
    if (mode === 'refineAdvance') {
      const token = validateRefineAdvance(input);
      this.requireIdle();
      const context = this.refineContext();
      if (
        !context.ready ||
        !context.settled ||
        !context.npcIdentity ||
        context.npcMode !== 'refine' ||
        token !== context.promptToken
      )
        throw new Error('The displayed refining dialogue changed. Wait for its fresh prompt.');
      this.refinePromptToken = null;
      this.refine.cancel('Requested NPC advance.');
      this.dispatch({ type: 'npcAdvance' }, null, true);
      return;
    }

    if (mode === 'warpCancel') {
      if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length)
        throw new Error('Invalid Warp cancellation.');
      this.warp.cancel(
        'Warp intent dismissed locally; server actions and resources remain uncertain.',
      );
      return;
    }
    if (mode === 'warp' || mode === 'warpPreview') {
      const envelope = validateWarpEnvelope(input, mode === 'warpPreview');
      // An exact Heal result still needs its own ordered SP readback.
      // Reject competitors before changing protection policy or consuming intent.
      if (this.partyHeal.busy || this.partyHeal.awaitingSpReadback)
        throw new Error('Wait for the previous party Heal receipt and ordered SP readback.');
      const context = this.warpContext(envelope.policy);
      if (!context.idle)
        throw new Error(
          context.unavailable ??
            'Wait for stationary movement, casts and all other owners to settle.',
        );
      if (
        this.warp.blocked &&
        this.warpPolicy &&
        JSON.stringify(this.warpPolicy) !== JSON.stringify(envelope.policy)
      ) {
        this.warp.cancel('Manual protection settings changed; activation canceled.');
        throw new Error('Warp protection preview is stale.');
      }
      if (mode === 'warpPreview') {
        this.warp.prepare(envelope.request, context);
        this.warpPolicy = envelope.policy;
      } else {
        if (!this.warpPolicy || JSON.stringify(this.warpPolicy) !== JSON.stringify(envelope.policy))
          throw new Error('Warp protection preview is stale.');
        this.warp.dispatch(envelope.request, context);
      }
      this.started = this.now();
      this.lastTick = this.now();
      return;
    }
    if (mode === 'socketPreview' || mode === 'socket') {
      this.socket.tick(this.socketContext());
      this.requireIdle();
      if (mode === 'socketPreview') {
        const request = validateSocketEnvelope(input, false);
        this.socket.prepare(
          { targetBagId: request.targetBagId, cardBagId: request.cardBagId },
          this.socketContext(socketStockFloors(request.policy)),
        );
        this.socketFloors = socketStockFloors(request.policy);
      } else {
        const request = validateSocketEnvelope(input, true);
        this.socket.dispatch(
          {
            targetBagId: request.targetBagId,
            cardBagId: request.cardBagId,
            previewToken: request.previewToken,
          },
          this.socketContext(socketStockFloors(request.policy)),
        );
      }
      return;
    }
    if (mode === 'memo') {
      this.requireIdle();
      this.memo.dispatch(input, this.memoContext());
      this.started = this.now();
      this.lastTick = this.now();
      return;
    }
    if (
      mode === 'command' &&
      input &&
      typeof input === 'object' &&
      'type' in input &&
      input.type === 'manualTarget'
    ) {
      const request = validateManualTargetRequest(input);
      this.requireIdle();
      if (!this.movementSettled())
        throw new Error('Wait for authoritative movement to settle before a manual command.');
      const blocker = this.manualWorldBlocker();
      if (blocker) throw new Error(blocker);
      this.engine.startManual(request);
      this.started = this.now();
      this.lastTick = this.now();
      return;
    }
    if (
      mode === 'command' &&
      input &&
      typeof input === 'object' &&
      'type' in input &&
      (input.type === 'manualNpcTalk' || input.type === 'manualVendingView')
    ) {
      const request =
        input.type === 'manualNpcTalk'
          ? validateManualNpcTalkRequest(input)
          : validateManualVendingViewRequest(input);
      this.requireIdle();
      const vending = request.type === 'manualVendingView';
      if (!this.movementSettled())
        throw new Error('Wait for authoritative movement to settle before interacting.');
      const blocker = this.manualWorldBlocker();
      if (blocker) throw new Error(blocker);
      const binding = this.engine.actorActionIdentity(request.target.id),
        npc = this.engine.actors.get(request.target.id);
      if (
        request.map !== this.engine.map ||
        !binding ||
        binding.world !== request.owner.world ||
        binding.selfId !== request.owner.id ||
        binding.selfIncarnation !== request.owner.incarnation ||
        binding.targetIncarnation !== request.target.incarnation
      )
        throw new Error(
          'Character, map or actor lifetime changed. Select the NPC or player shop again.',
        );
      if (!npc || !(vending ? isPlayerShop(npc) : isTalkNpc(npc)) || npc.dead)
        throw new Error('Selected NPC or player shop is absent, replaced or changed.');
      if (this.engine.player!.dead || this.engine.player!.hp <= 0)
        throw new Error('A current living character is required to interact.');
      this.dispatch({ type: vending ? 'vendingView' : 'npcTalk', id: request.target.id }, null);
      this.started = this.now();
      this.lastTick = this.now();
      return;
    }
    if (mode === 'social') {
      this.requireIdle();
      const actor = this.engine.actorActionIdentity();
      if (!actor) throw new Error('A current observed own character is required.');
      this.socialIdentity = { actor, name: this.engine.player!.name };
      this.social.dispatch(input, this.socialContext());
      return;
    }
    if (mode === 'service') {
      const { service: definition, executionPolicy } = validateServiceExecution(input);
      this.requireReady();
      if (!this.travel.movementSettled(this.engine.map, this.engine.player))
        throw new Error('Wait for canceled rendezvous movement to settle.');
      if (this.partyHeal.busy)
        throw new Error(
          'Waiting for the previous party Heal execution receipt before running a service.',
        );
      if (!this.engine.observedOwnCastSettled()) throw new Error(OWN_CAST_WAIT_REASON);
      if (
        this.macro.active ||
        this.warp.blocked ||
        this.refine.blocked ||
        this.partyFollow.ownsTravel ||
        this.socket.busy ||
        this.memo.blocked ||
        this.social.busy ||
        this.engine.retreatOwned ||
        this.engine.manualTargetOwned ||
        this.service.active ||
        this.escape.busy ||
        this.travel.active ||
        this.pending ||
        this.workflow.snapshot().running ||
        ['running', 'waiting'].includes(this.routine.snapshot().state) ||
        this.unresolvedWorld ||
        this.now() < this.fencedUntil ||
        this.engine.pendingFeatureAction ||
        this.featureReceipt ||
        this.supply.uncertain
      )
        throw new Error(
          'Wait for the current transaction or unresolved escape/action before running a service.',
        );
      // Explicit service visits replace field intent; they never install a supply-trip policy.
      this.requestedSettings = null;
      this.initialFieldEntryPending = false;
      this.returnSettings = null;
      this.returning = false;
      this.travelSettings = null;
      this.engine.stop('Preparing the requested NPC service.');
      this.service.start(definition, this.serviceContext(), executionPolicy);
      this.started = this.now();
      this.lastTick = this.now();
      this.workflowOutstanding = null;
      this.workflowDeadline = 0;
      return;
    }
    this.requireIdle();
    this.started = this.now();
    this.lastTick = this.now();
    this.travelSettings = null;
    this.returnSettings = null;
    this.returning = false;
    if (mode === 'workflow') {
      if (!this.engine.character.inventoryKnown || this.engine.character.stats?.zeny === undefined)
        throw new Error('Wait for a confirmed inventory and balance before starting a workflow.');
      const spec = validateWorkflowSpec(input);
      this.workflowTimeout = spec.timeoutMs ?? 10_000;
      this.workflowOutstanding = null;
      this.workflowDeadline = 0;
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
  private worldActionIdentity(action: WorldAction): ActionIdentity | null {
    const target =
      ['npcTalk', 'partyInviteId', 'vendingView'].includes(action.type) && 'id' in action
        ? action.id
        : (this.world.npc.id ?? undefined);
    const identity = this.engine.actorActionIdentity(target);
    // Older positive-ID focus-only contexts retain their existing guard contract;
    // newly supported zero requires independently observed actor identity.
    return target === 0 ? identity : (identity ?? this.engine.actorActionIdentity());
  }
  private worldOwnerCurrent(owner: Pending): boolean {
    return (
      !owner.actorIdentity ||
      sameActionIdentity(
        owner.actorIdentity,
        this.engine.actorActionIdentity(owner.actorIdentity.targetId),
      )
    );
  }
  private dispatch(
    input: ControllerAction,
    routineId: number | null,
    refineAdvance = false,
    macro?: Pending['macro'],
  ): void {
    if (this.partyFollow.ownsTravel)
      throw new Error('Party rendezvous owns commands. Stop it before a manual action.');
    if (!this.travel.movementSettled(this.engine.map, this.engine.player))
      throw new Error('Wait for canceled rendezvous movement to settle.');
    if (!this.engine.observedOwnCastSettled()) throw new Error(OWN_CAST_WAIT_REASON);
    if (this.escape.busy) throw new Error('Waiting for emergency escape to settle.');
    if (this.now() < this.fencedUntil) throw new Error('Waiting for the previous action deadline.');
    const binding = {
      generation: this.generation,
      worldGeneration: this.world.generation,
      map: this.engine.map,
      npcId: this.world.npc.id,
    };
    if (expanded(input)) {
      this.engine.manualAction(
        input,
        macro
          ? (sequence, actorIdentity) => {
              this.pending = {
                action: input,
                actorIdentity,
                since: this.now(),
                routineId,
                ...binding,
                engineSequence: sequence,
                macro,
              };
              this.captureActionFailure();
            }
          : undefined,
      );
      if (!macro)
        this.pending = {
          action: input,
          since: this.now(),
          routineId,
          ...binding,
          engineSequence: this.engine.actionResult.sequence,
        };
      return;
    }
    const action = validateWorldAction(input);
    const context = this.context();
    const actorIdentity = this.worldActionIdentity(action);
    if (!actorIdentity) throw new Error('A current own and target actor identity is required.');
    const blockers = worldActionBlockers(action, context, refineAdvance);
    if (
      action.type === 'vendingView' &&
      (this.world.npc.id !== null || this.world.npc.mode !== 'idle')
    )
      blockers.push('Finish the current NPC interaction before opening another vendor.');
    if (blockers.length) throw new Error(blockers.join(' '));
    const resource = this.resourceStep(action);
    if (resource) {
      if (!this.engine.character.inventoryKnown || context.zeny < 0 || this.world.npc.id === null)
        throw new Error('A confirmed NPC, inventory and balance are required.');
      const result = this.workflow.start(
        {
          name: 'Requested action',
          map: context.map,
          npcId: this.world.npc.id,
          maxSpend: Math.min(context.zeny, 2_000_000_000),
          minStock: [],
          steps: [resource],
        },
        context,
      );
      if (!result.ok) throw new Error(result.reasons.join(' '));
      this.workflowTimeout = 10_000;
      this.workflowOutstanding = null;
      this.workflowDeadline = 0;
      this.pending = {
        actorIdentity,
        action,
        since: this.now(),
        routineId,
        ...binding,
        workflow: true,
        sent: false,
      };
    } else {
      const receipt =
        action.type === 'vendingPurchase' ? createVendingReceipt(action, context) : undefined;
      const source =
        action.type === 'cart'
          ? action.direction === 1
            ? this.engine.character.inventory.get(domainBagId(action.bagId))
            : this.world.cart.get(action.bagId)
          : undefined;
      const cart = source
        ? {
            source: { ...source },
            inventory: this.engine.character.count(domainItemId(source.itemId)),
            cart: this.cartCount(source),
            acknowledged: false,
          }
        : undefined;
      this.send(action);
      this.pending = {
        actorIdentity,
        action,
        since: this.now(),
        routineId,
        ...binding,
        ...(receipt ? { receipt } : {}),
        ...(cart ? { cart } : {}),
      };
      this.engine.reason = `Sent ${action.type}; waiting for the game.`;
      this.engine.note(this.engine.reason);
    }
  }
  private resourceStep(action: WorldAction): WorkflowStep | null {
    if (action.type === 'shop')
      return action.rows.length ? { type: action.mode, rows: action.rows } : { type: 'closeShop' };
    if (action.type === 'storage')
      return action.operation === 'close'
        ? { type: 'closeStorage' }
        : { type: action.operation, bagId: action.bagId, count: action.count };
    if (action.type === 'npcBarter')
      return { type: 'barter', choice: action.choice, count: action.count, bagIds: action.bagIds };
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
    if (pending?.routineId !== null && pending?.routineId !== undefined)
      this.routine.acknowledge(success, pending.routineId);
    if (pending?.macro) {
      if (
        success &&
        pending.workflow &&
        this.macroOwner?.phase === 'workflow' &&
        this.macroOwner.intent.id === pending.macro.id
      )
        this.macroOwner.phase = 'closing';
      else this.acknowledgeMacro(pending.macro, success, reason);
    }
    this.engine.reason = reason;
    this.engine.note(reason);
  }
  receive(
    data: Uint8Array,
    connectionGeneration = this.connectionEpoch,
    beforeApply?: (observation: PacketObservation) => void,
  ): PacketObservation | null {
    if (connectionGeneration !== this.connectionEpoch) return null;
    // Decode both owners before applying either so malformed packets cannot leak partial state.
    const events = decode(data);
    const worldEvents = decodeWorld(data) ?? [];
    const observation = packetObservation(data[0]!, events);
    beforeApply?.(observation);
    if (connectionGeneration !== this.connectionEpoch) return null;
    if (this.databaseTravel)
      for (const event of events) {
        const wait = databaseTeleportWait(event);
        if (wait !== null)
          this.databaseTeleportUntil = Math.max(
            this.databaseTeleportUntil,
            this.now() + wait + 1_000,
          );
      }
    // Capture travel source evidence before a clear/map retires world identity.
    this.travel.prepareObservation(events);
    for (const event of events) {
      if (event.type === 'inventory' || event.type === 'inventoryDelta') {
        this.supplyInventoryRevision++;
        this.supplyInventoryFresh = true;
      }
      if (event.type === 'currency' || (event.type === 'stats' && event.zeny !== undefined)) {
        this.supplyCurrencyRevision++;
        this.supplyCurrencyFresh = true;
      }
    }
    this.captureActionFailure();
    const cycle = this.deathCycle;
    for (const event of events) {
      if (event.type === 'enter') {
        this.ownArrival = { id: event.id, entry: 1, initialization: !this.enteredConnection };
        this.enteredConnection = true;
      } else if (event.type === 'map')
        this.ownArrival = { id: this.engine.playerId, entry: 1, initialization: false };
      else if (event.type === 'clear')
        this.ownArrival = { id: this.engine.playerId, entry: 2, initialization: false };
    }
    if (cycle)
      for (const event of events) {
        if (event.type === 'clear') {
          cycle.refresh = 'same';
          cycle.ownId = this.engine.playerId;
        } else if (event.type === 'map' || event.type === 'enter') {
          cycle.refresh = 'cross';
          cycle.ownId = event.type === 'enter' ? event.id : this.engine.playerId;
        }
      }
    this.lastFrame = this.now();
    for (const event of events) {
      if (event.type === 'enter') {
        this.endMacro('Macro character or connection changed.', true);
        this.clearRefineContext();
        this.resetMemoMovement();
        this.memo.invalidate('Memo character changed. Wait for full state.');
        this.memoIdentity = null;
        this.social.reset('Social character changed.');
        this.pause('Preparing the reconnected character.');
        this.world.reset(event.map);
      } else if (event.type === 'map' || event.type === 'clear') {
        this.clearRefineContext();
        this.refine.cancel('World changed during refining.');
        this.resetMemoMovement();
        this.memo.cancel('Memo intent canceled after a world change. Nothing will replay.');
        this.memoIdentity = null;
        this.social.cancel('Unconfirmed after a world change. No social send will be replayed.');
        // Travel owns expected transitions; field runs retain their selected species.
        if (
          this.pending ||
          this.workflow.snapshot().running ||
          ['running', 'waiting'].includes(this.routine.snapshot().state)
        ) {
          this.retireWorld();
          this.generation++;
          this.workflow.cancel('Map changed.');
          this.routine.cancel('Map changed.');
          this.pending = null;
        }
        this.world.reset(event.type === 'map' ? event.map : this.engine.map, true);
      }
    }
    const movementReceipts = new Map(
      events.map((event) => [
        event,
        this.engine.officialMovementReceiptOwner(event) ??
          this.engine.manualMovementReceiptOwner(event) ??
          this.engine.retreatMovementReceiptOwner(event) ??
          this.engine.fieldMovementReceiptOwner(event, this.fieldWalkOwner),
      ]),
    );
    this.warp.observeDeath(events, this.warpContext());
    this.engine.receive(events);
    for (const event of events)
      if (event.type === 'experience') {
        const baseline = this.reconnectExperience;
        // A reconnect can republish the last reward after the fresh own entry.
        // It remains a current/latest observation, but is not a new run reward.
        if (
          baseline &&
          (!this.engine.player || this.engine.player.name === this.reconnectExperienceCharacter) &&
          event.baseTotal === baseline.baseTotal &&
          event.jobTotal === baseline.jobTotal &&
          event.baseGained === baseline.baseGained &&
          event.jobGained === baseline.jobGained
        )
          continue;
        this.reconnectExperience = null;
        if (
          this.runExperience &&
          (this.runRequested || this.macro.active) &&
          this.experienceConnection === this.connectionEpoch &&
          this.engine.player?.name === this.runExperience.character
        ) {
          const revision: number = this.runExperience.revision + 1;
          this.runExperience = {
            ...this.runExperience,
            ...(Number.isSafeInteger(revision)
              ? addExperience(this.runExperience, event)
              : { baseGained: null, jobGained: null }),
            revision: Math.min(Number.MAX_SAFE_INTEGER, revision),
          };
        }
      }
    this.world.refreshPartyActors(this.engine.observations, this.engine.playerId);
    this.engine.partyChanged();
    const readyIdentity = this.engine.actorActionIdentity(),
      readyPlayer = this.engine.player;
    if (
      readyIdentity &&
      readyPlayer &&
      events.some(
        (event) =>
          (event.type === 'spawn' &&
            event.entity.id === readyPlayer.id &&
            event.entity.kind === 0 &&
            event.entity.id === this.ownArrival?.id &&
            event.entryType === this.ownArrival.entry &&
            !event.entity.dead &&
            event.entity.hp > 0) ||
          (event.type === 'resurrection' && event.id === readyPlayer.id && event.hp > 0),
      )
    ) {
      this.readyOwn = {
        identity: JSON.stringify([this.connectionEpoch, readyIdentity]),
        name: readyPlayer.name,
        initialization:
          !!this.ownArrival?.initialization &&
          events.some(
            (event) =>
              event.type === 'spawn' && event.entity.id === readyPlayer.id && event.entryType === 1,
          ),
      };
      this.ownArrival = null;
      // Observation resumes at verified entry even when HP or travel keeps
      // automation waiting. Replayed initialization rewards remain filtered.
      if (this.runRequested && this.runExperience?.character === readyPlayer.name)
        this.experienceConnection = this.connectionEpoch;
      // The server freezes accumulated input debt while the actor is inactive
      // during map loading. Start draining time from fresh own arrival.
      if (this.databaseTravel) {
        this.quietUntil = Math.max(this.quietUntil, this.now() + 2_000);
        // Fresh login also guards against a cooldown left by a previous client.
        // Map arrival anchors the wait after inactive/loading time and covers manual teleports.
        this.databaseTeleportUntil = Math.max(
          this.databaseTeleportUntil,
          this.now() + DATABASE_TELEPORT_COOLDOWN_MS,
        );
      }
    }
    if (
      cycle &&
      readyPlayer?.name === cycle.guard.character &&
      readyPlayer.hp > 0 &&
      !readyPlayer.dead &&
      this.deathOwnReady() &&
      events.some(
        (event) =>
          (event.type === 'spawn' &&
            event.entity.id === cycle.ownId &&
            ((cycle.refresh === 'same' && event.entryType === 2) ||
              (cycle.refresh === 'cross' && event.entryType === 1))) ||
          (event.type === 'resurrection' && event.id === readyPlayer.id && event.hp > 0),
      )
    )
      this.revivalReady();
    if (
      cycle?.posture &&
      events.some(
        (event) =>
          event.type === 'sit' &&
          event.id === readyPlayer?.id &&
          event.sitting === cycle.posture!.sitting,
      ) &&
      cycle.posture.identity === this.deathIdentity()
    ) {
      cycle.posture = null;
      cycle.guard.uncertain = false;
    }
    this.reconcileDeathPosture();

    if (events.some((event) => event.type === 'enter'))
      this.socketInitialization = { key: crypto.randomUUID(), identity: null };
    this.socket.observe(events, this.socketContext());
    const memoPlayer = this.engine.player,
      memoActor = this.engine.actorActionIdentity();
    if (memoPlayer && memoActor) {
      const identity = JSON.stringify([
        memoActor.world,
        memoActor.selfId,
        memoActor.selfIncarnation,
        memoPlayer.name,
      ]);
      if (this.memoIdentity !== null && this.memoIdentity !== identity) {
        this.resetMemoMovement();
        this.memo.invalidate('Memo character incarnation changed. Wait for full state.');
      }
      this.memoIdentity = identity;
    }
    for (const event of events) {
      const movementOwner = movementReceipts.get(event);
      const movementWorld: string | undefined = movementOwner?.world;
      const ownedMovementReceipt =
        !!movementOwner &&
        !!memoActor &&
        movementWorld === memoActor.world &&
        movementOwner.id === memoActor.selfId &&
        movementOwner.incarnation === memoActor.selfIncarnation;
      if (event.type === 'walk' && event.id === memoPlayer?.id) {
        this.memoMovementUnknown = true;
        const end = event.walk.cells.at(-1);
        if (
          !event.walk.locked &&
          end &&
          (ownedMovementReceipt ||
            !this.memoWalkPending ||
            (end.x === this.memoWalkPending.x && end.y === this.memoWalkPending.y))
        ) {
          this.memoWalkPending = null;
          this.memoWalkEnd = { ...end };
        } else this.memoWalkEnd = null;
      } else if (event.type === 'stop' && ownedMovementReceipt) {
        this.resetMemoMovement();
      } else if (
        !this.memoWalkPending &&
        ((event.type === 'spawn' && event.entity.id === memoPlayer?.id) ||
          ((event.type === 'position' || event.type === 'hit' || event.type === 'resurrection') &&
            event.id === memoPlayer?.id) ||
          (event.type === 'attack' && event.source === memoPlayer?.id))
      ) {
        this.memoMovementUnknown = false;
        this.memoWalkEnd = null;
      }
    }
    this.memo.tick(this.memoContext());
    for (const event of events) {
      if (event.type === 'memoSlots') this.memo.observeSlots(event.slots, this.memoContext());
      else if (event.type === 'serverEvent' && event.event === 8) {
        if (
          Number.isInteger(event.value) &&
          event.value >= 0 &&
          event.value <= 3 &&
          event.text === ''
        )
          this.memo.observeNotification(event.value, this.memoContext());
        else if (this.memo.busy)
          this.memo.cancel(
            'Uncertain: memo notification differs from the pinned slot/text contract. Nothing will retry.',
          );
      } else if (
        (event.type === 'requestFailure' ||
          event.type === 'skillFailure' ||
          event.type === 'featureError') &&
        this.memo.busy
      )
        this.memo.cancel(
          'Uncertain memo result after an unrelated or rejected request. Check fresh slot state; nothing will retry.',
        );
    }
    if (events.some((event) => event.type === 'enter'))
      this.refineInitialization = { key: crypto.randomUUID(), identity: null };
    for (const event of events) {
      const own =
        'id' in event
          ? event.id === this.engine.playerId
          : event.type === 'skillResult' && event.source === this.engine.playerId;
      if (
        own &&
        [
          'castStart',
          'castExtend',
          'castStop',
          'skillResult',
          'status',
          'sit',
          'walk',
          'death',
          'remove',
          'spawn',
        ].includes(event.type)
      )
        this.refineActivityRevision++;
    }

    this.warp.observe(events, this.warpContext());
    const recoveredMemo = this.warp.takeRecoveredMemo();
    if (recoveredMemo) this.memo.observeSlots(recoveredMemo, this.memoContext());
    const socialPlayer = this.engine.player,
      socialActor = this.engine.actorActionIdentity();
    if (this.socialIdentity && !sameActionIdentity(this.socialIdentity.actor, socialActor)) {
      if (socialPlayer && socialPlayer.name !== this.socialIdentity.name)
        this.social.reset('Social character identity changed.');
      else
        this.social.cancel(
          'Unconfirmed after the own actor lifetime changed. No social send will be replayed.',
        );
    }
    this.socialIdentity =
      socialActor && socialPlayer ? { actor: socialActor, name: socialPlayer.name } : null;
    for (const event of events)
      if (event.type === 'chat' || event.type === 'emote')
        this.social.observe(event, this.socialContext());
    const escapeRefreshOwned =
      this.escape.sent && ['sent', 'refreshing'].includes(this.escape.snapshot().state);
    const escaped = this.escape.observe(events, this.escapeContext());
    const escapeRefresh = escapeRefreshOwned && this.escape.snapshot().state === 'refreshing';
    if (
      escaped &&
      this.runRequested &&
      automationSettings(this.requestedSettings!).travel.returnToLockMap &&
      this.engine.map !== this.requestedSettings!.map
    ) {
      this.returning = true;
    }
    for (const event of events)
      if (event.type === 'inventory' && event.cart !== undefined)
        this.world.replaceCart(event.cart);
    for (const event of worldEvents) {
      this.engine.castAvailability.observeWorld(event);
      if (event.type === 'partyJoined' || event.type === 'partyLeft')
        this.engine.partyMembershipChanged();
      else if (event.type === 'partyMember')
        this.engine.partyMembershipChanged(event.member.memberId);
      else if (event.type === 'partyRemove' || event.type === 'partyMap')
        this.engine.partyMembershipChanged(event.memberId);
      // Enter supplies this ID; ordered map/clear retain it while the own actor loads.
      this.world.observe(event, this.engine.observations, this.engine.playerId, (before) =>
        this.partyFollow.observeParty(event, before, this.partyFollowContext()),
      );
      this.engine.partyChanged();
      this.observeRefineNpc(event);
      if (event.type === 'cartMoved')
        this.engine.character.applyCartWeights(event.cartWeight, event.currentWeight);
    }
    this.partyFollow.advanceDeadline();
    if (
      this.partyFollow.terminal &&
      this.travel.active &&
      this.travel.snapshot().purpose === 'party-follow'
    )
      this.travel.cancel(this.partyFollow.snapshot().reason);
    const transitions = this.travel.observe(events);
    this.partyFollow.observeGame(events, transitions, this.partyFollowContext());
    if (
      this.partyFollow.terminal &&
      this.travel.active &&
      this.travel.snapshot().purpose === 'party-follow'
    )
      this.travel.cancel(this.partyFollow.snapshot().reason);
    this.refine.observe(events, this.refineContext());
    if (this.supplyReceipt)
      observeSupplyReceipt(this.supplyReceipt, worldEvents, this.supplyContext());
    this.supply.observe(this.supplyContext());
    this.service.observe(
      events,
      worldEvents,
      this.serviceContext(),
      !!this.macroOwner &&
        this.macroOwner.phase === 'service' &&
        this.service.preparingUnsent &&
        !this.travel.teleportPending,
    );
    if (
      this.macro.active &&
      events.some((event) => event.type === 'map' || event.type === 'clear')
    ) {
      const expected =
        (!!this.macroOwner?.travelTripId &&
          transitions.some(
            (transition) =>
              transition.trip === this.macroOwner!.travelTripId &&
              ['map', 'clear'].includes(transition.phase),
          )) ||
        (this.supply.ownsField &&
          transitions.some(
            (transition) =>
              transition.trip === this.travel.tripId && ['map', 'clear'].includes(transition.phase),
          )) ||
        escaped ||
        escapeRefresh ||
        (!!cycle && cycle.guard.phase === 'revival' && cycle.guard.uncertain) ||
        (!!cycle &&
          transitions.some(
            (transition) =>
              transition.trip === this.travel.tripId && ['map', 'clear'].includes(transition.phase),
          ));
      const resumable =
        !this.macroOwner ||
        ((['settling', 'farm', 'travel'].includes(this.macroOwner.phase) ||
          (this.macroOwner.phase === 'service' && this.service.preparingUnsent)) &&
          !this.travel.teleportPending);
      if (!expected && !resumable)
        this.endMacro('World transition interrupted a transmitted macro action.', true);
    }
    if (
      this.supply.ownsField &&
      events.some((event) => event.type === 'map' || event.type === 'clear') &&
      !this.service.active &&
      !this.travel.active
    ) {
      this.supplyStorageFull = null;
      this.supply.interrupt('Unexpected world transition interrupted the supply trip.');
    }
    this.workflow.observe(worldEvents, this.context());
    this.syncWorkflowOwner();
    if (this.pending) this.observeCart(this.pending, worldEvents);
    if (this.unresolvedWorld) {
      const owner = this.unresolvedWorld;
      this.observeCart(owner, worldEvents);
      if (owner.serviceReceipt) {
        observeServiceReceipt(owner.serviceReceipt, events, worldEvents, this.serviceContext());
        if (confirmServiceReceipt(owner.serviceReceipt, this.serviceContext()))
          this.unresolvedWorld = null;
      } else if (owner.macro && owner.workflowReceipt) {
        owner.workflowAcknowledged ||=
          this.worldOwnerCurrent(owner) &&
          worldEvents.some((event) =>
            owner.action.type === 'storage' && owner.action.operation !== 'close'
              ? event.type === 'storageMoved' &&
                event.deposit === (owner.action.operation === 'deposit') &&
                event.change === owner.action.count &&
                owner.workflowReceipt!.itemChanges.has(domainItemId(event.item.itemId))
              : event.type === 'npcEnd' ||
                ([
                  'npcDialog',
                  'npcOptions',
                  'shopOpened',
                  'storageOpened',
                  'barterOpened',
                ].includes(event.type) &&
                  this.world.npc.id === owner.npcId),
          );
        if (
          owner.workflowAcknowledged &&
          owner.map === this.engine.map &&
          owner.worldGeneration === this.world.generation &&
          this.worldOwnerCurrent(owner) &&
          confirmWorkflowReceipt(owner.workflowReceipt, this.context())
        )
          this.unresolvedWorld = null;
      } else if (
        owner.map !== this.engine.map ||
        owner.worldGeneration !== this.world.generation ||
        (this.worldOwnerCurrent(owner) &&
          (worldEvents.some((event) => event.type === 'npcEnd') ||
            (owner.receipt
              ? confirmVendingReceipt(owner.receipt, this.context())
              : owner.cart
                ? this.cartConfirmed(owner)
                : this.worldConfirmed(owner.action, worldEvents, owner))))
      )
        this.unresolvedWorld = null;
    }
    const heal = this.partyHeal.observe(events, (target) =>
      this.engine.actorActionIdentity(target),
    );
    if (heal) this.engine.reconcilePartyHeal(heal.sequence, heal.motion);
    // Consume conclusive readback while its captured own lifetime still exists,
    // including after Stop or the finite allowance prevents another Heal tick.
    if (
      this.partyHeal.awaitingSpReadback &&
      events.some(
        (event) => event.type === 'sp' || (event.type === 'stats' && event.sp !== undefined),
      )
    )
      this.partyHeal.resourcesReadBack(this.engine.actorObservation([]));
    if (this.partyHeal.busy) {
      const state = this.partyHeal.snapshot(),
        binding =
          state.targetMemberId === null
            ? null
            : this.world.partyActors.get(partyMemberId(state.targetMemberId));
      if (
        !binding ||
        events.some(
          (event) =>
            event.type === 'map' ||
            event.type === 'clear' ||
            event.type === 'death' ||
            event.type === 'remove' ||
            event.type === 'partyAffiliation',
        ) ||
        worldEvents.some((event) =>
          ['partyJoined', 'partyLeft', 'partyMember', 'partyRemove', 'partyMap'].includes(
            event.type,
          ),
        )
      )
        this.partyHeal.cancel('Party or actor lifetime evidence changed.');
    }
    this.reconcileFeature(events);
    if (
      events.some((event) => event.type === 'requestFailure' || event.type === 'skillFailure') &&
      this.pending
    ) {
      this.workflowOutstanding = null;
      this.workflow.cancel('The game rejected the request.');
      this.completePending(false, 'The game rejected the request.', false);
    }
    if (
      this.pending &&
      !this.pending.workflow &&
      this.pending.engineSequence === undefined &&
      this.pending.generation === this.generation &&
      this.pending.worldGeneration === this.world.generation &&
      this.pending.map === this.engine.map &&
      this.worldOwnerCurrent(this.pending) &&
      (this.pending.receipt
        ? confirmVendingReceipt(this.pending.receipt, this.context())
        : this.pending.cart
          ? this.cartConfirmed(this.pending)
          : this.worldConfirmed(this.pending.action, worldEvents))
    )
      this.completePending(true, 'Game response confirmed.');
    if (events.some((event) => event.type === 'death' && event.id === this.engine.playerId)) {
      this.supplyStorageFull = null;
      this.retireWorld();
      this.generation++;
      this.workflow.cancel('Character died.');
      this.routine.cancel('Character died.');
      this.pending = null;
    }
    this.captureActionFailure();
    this.tick(); // React to authoritative changes without waiting for the polling interval.
    return observation;
  }
  private observeCart(pending: Pending, events: WorldEvent[]): void {
    if (!pending.cart || pending.action.type !== 'cart') return;
    const { cart, action } = pending;
    cart.acknowledged ||= events.some(
      (event) =>
        event.type === 'cartMoved' &&
        event.direction === action.direction &&
        event.change === action.count &&
        this.sameItem(event.item, cart.source) &&
        (action.direction === 1 || event.item.bagId === action.bagId),
    );
  }
  private sameItem(a: InventoryItem, b: InventoryItem): boolean {
    return (
      a.itemId === b.itemId &&
      a.type === b.type &&
      (a.type !== 2 || (!!a.guid && a.guid === b.guid))
    );
  }
  private cartCount(source: InventoryItem): number {
    return [...this.world.cart.values()].reduce(
      (sum, item) => sum + (this.sameItem(item, source) ? item.count : 0),
      0,
    );
  }
  private cartConfirmed(pending: Pending): boolean {
    if (!this.worldOwnerCurrent(pending)) return false;
    if (
      !pending.cart ||
      pending.action.type !== 'cart' ||
      !pending.cart.acknowledged ||
      !this.engine.character.inventoryKnown ||
      !this.world.cartReady
    )
      return false;
    const { source, inventory, cart } = pending.cart;
    const action = pending.action;
    const direction = action.direction === 1 ? 1 : -1;
    const sourceItems = action.direction === 1 ? this.engine.character.inventory : this.world.cart;
    return (
      (sourceItems.get(domainBagId(action.bagId))?.count ?? 0) === source.count - action.count &&
      this.engine.character.count(domainItemId(source.itemId)) ===
        inventory - direction * action.count &&
      this.cartCount(source) === cart + direction * action.count
    );
  }
  private worldConfirmed(
    action: ControllerAction,
    events: WorldEvent[],
    owner: Pending | null = this.pending,
  ): boolean {
    if (owner && !this.worldOwnerCurrent(owner)) return false;
    return events.some((event) => {
      switch (action.type) {
        case 'npcTalk':
          return event.type === 'npcFocus' && event.id === action.id;
        case 'npcAdvance':
        case 'npcOption':
          return [
            'npcDialog',
            'npcOptions',
            'npcEnd',
            'npcRefine',
            'shopOpened',
            'storageOpened',
            'barterOpened',
          ].includes(event.type);
        case 'cart':
          return false; // Correlated source decrease and destination gain are required.
        case 'partyCreate':
          return event.type === 'partyJoined' && event.name === action.name;
        case 'partyAccept':
          return event.type === 'partyJoined' && event.partyId === action.partyId;
        case 'partyLeave':
        case 'partyDisband':
          return event.type === 'partyLeft';
        case 'partyLeader':
          return event.type === 'partyLeader' && event.memberId === action.memberId;
        case 'partyRemove':
          return event.type === 'partyRemove' && event.memberId === action.memberId;
        case 'vendingStart':
          return event.type === 'vendingStarted' && event.name === action.name;
        case 'vendingStop':
          return event.type === 'vendingStopped';
        case 'vendingView':
          return (
            event.type === 'vendingViewed' &&
            (this.world.npc.id === null || this.world.npc.id === action.id) &&
            owner?.worldGeneration === this.world.generation &&
            owner.map === this.engine.map
          );
        // Invitations and vendor purchases do not have a correlated success packet.
        // A timeout remains uncertain and is never retried by this controller.
        default:
          return false;
      }
    });
  }
  private supplyContext(): SupplyContext {
    const c = this.engine.character,
      p = this.engine.player,
      w = this.context();
    const noOwner =
      !this.warp.blocked &&
      !this.refineBlocksAutomation &&
      !this.partyFollow.ownsTravel &&
      this.travel.movementSettled(this.engine.map, p) &&
      !this.socket.busy &&
      !this.memo.blocked &&
      !this.pending &&
      !this.workflow.snapshot().running &&
      !this.service.active &&
      !this.travel.active &&
      !this.unresolvedWorld &&
      !this.featureReceipt &&
      this.now() >= this.fencedUntil;
    const settled = this.engine.idleForActions() && noOwner;
    return {
      character: p?.name ?? this.characterName ?? '',
      epoch: String(this.connectionEpoch),
      map: this.engine.map,
      position: p ? { x: Math.floor(p.x), y: Math.floor(p.y) } : null,
      connected: this.engine.connected && this.engine.compatible,
      alive: !!p && !p.dead,
      loading: this.travel.active && this.travel.snapshot().state === 'transition',
      fresh:
        this.now() - this.lastFrame <= 15000 &&
        this.supplyInventoryFresh &&
        this.supplyCurrencyFresh,
      settled,
      canPrepare: noOwner && this.engine.featureActionsSettled,
      fieldRequested: this.runRequested,
      inventoryRevision: revisionFor('inventory', this.supplyInventoryRevision),
      currencyRevision: revisionFor('currency', this.supplyCurrencyRevision),
      economicUncertain: !!this.unresolvedWorld || !!this.featureReceipt,
      disposition: {
        revision: `${this.connectionEpoch}:${this.world.generation}:${this.world.revision}:${c.inventoryRevision}:${c.statsRevision}:${c.equipmentRevision}`,
        containers: {
          inventory: {
            items: c.inventoryKnown ? [...c.inventory.values()] : null,
            slots: 200,
            weight: c.stats?.weight ?? null,
            maxWeight: c.stats?.maxWeight ?? null,
          },
          storage: {
            items: this.world.storageReady ? [...this.world.storage.values()] : null,
            slots: 600,
            weight: null,
            maxWeight: 'unlimited',
          },
          cart: {
            items: this.world.cartReady ? [...this.world.cart.values()] : null,
            slots: 100,
            weight: c.stats?.cartWeight ?? null,
            maxWeight: 80000,
          },
        },
        equipment: c.inventoryKnown ? [...c.equipment] : null,
        ammoId: c.inventoryKnown ? c.ammoId : null,
        metadata: this.dispositionMetadata,
        minimumStock: this.requestedSettings
          ? dispositionStockFloors(automationSettings(this.requestedSettings))
          : [],
        workflow: { ...w, idle: this.engine.idleForActions() },
      },
    };
  }
  private supplyFailure(reason: string): void {
    this.supplyStorageFull = null;
    this.supply.interrupt(reason);
    this.supplyIntent = null;
    this.service.cancel(reason);
    this.workflow.cancel(reason);
    this.travel.cancel(reason);
    this.engine.stop(reason);
    this.waitingReason = reason;
  }
  /** Internal ownership handoff preserves the field intent and counters. */
  private supplyTick(): boolean {
    const context = this.supplyContext();
    this.supply.observe(context);
    if (!this.engine.observedOwnCastSettled()) {
      if (!this.supply.ownsField && !this.supply.uncertain) return false;
      // Observe existing receipt and trip deadlines without reserving a new intent.
      if (this.service.active) this.service.tick(this.serviceContext());
      else if (this.travel.active) this.travel.tick(this.engine.map, this.engine.player);
      if (this.workflow.snapshot().running) this.workflow.tick(this.context());
      this.waitingReason = OWN_CAST_WAIT_REASON;
      return this.supply.ownsField || this.supply.uncertain;
    }
    if (
      !this.supply.ownsField &&
      !this.supply.uncertain &&
      this.requestedSettings &&
      context.position &&
      (!mapAllowed(mapPolicy(this.requestedSettings), context.map) ||
        !insideLockArea(mapPolicy(this.requestedSettings), context.map, context.position))
    )
      return false;
    if (!this.supply.uncertain) this.supplyReceipt = null;
    if (
      this.supplyIntent?.type === 'action' &&
      !this.supply.uncertain &&
      this.supply.snapshot().state === 'closing'
    ) {
      this.supplyIntent = null;
      this.workflow.cancel('Supply transaction confirmed.');
    }
    if (this.supplyIntent && !this.supply.accepts(this.supplyIntent.id)) {
      this.supplyFailure(this.supply.snapshot().reason);
      return this.supply.ownsField || this.supply.uncertain;
    }
    this.sendingSupply = true;
    try {
      if (this.world.storageReady)
        this.supplyStorageFull =
          this.world.storage.size >= 600
            ? {
                character: context.character,
                epoch: context.epoch,
                revision: context.disposition.revision,
              }
            : null;
      const player = this.engine.player;
      if (
        this.supply.ownsField &&
        player &&
        !player.dead &&
        (!player.maxHp || (player.hp / player.maxHp) * 100 <= this.requestedSettings!.minHpPercent)
      ) {
        this.supplyFailure(
          'Supply interrupted for HP recovery; check stock and the return destination before restarting.',
        );
        return true;
      }
      let intent = this.supplyIntent;
      if (!intent) {
        intent =
          this.supply.resumeIntent(context) ??
          (this.initialFieldEntryPending && !this.supply.ownsField && !this.supply.uncertain
            ? null
            : this.supply.next(context));
        this.supplyIntent = intent;
        this.supplyCloseSent = false;
        this.supplyReturnApproach = false;
        this.supplyServiceStarted = false;
      }
      if (!intent) {
        if (this.supply.ownsField || this.supply.uncertain) {
          this.waitingReason = this.supply.snapshot().reason;
          return true;
        }
        return false;
      }
      if (intent.type === 'prepare') {
        this.supplyStorageFull = null;
        this.engine.stop('Preparing the bounded supply trip.');
        this.supply.acknowledge(intent.id, 'confirmed', this.supplyContext());
        this.supplyIntent = null;
        return true;
      }
      if (intent.type === 'service') {
        const state = this.service.snapshot();
        if (this.supplyServiceStarted && state.state === 'complete') {
          this.supplyServiceContract = intent.contractId;
          this.supply.acknowledge(intent.id, 'confirmed', this.supplyContext(), state.spent);
          this.supplyIntent = null;
          return true;
        }
        if (!this.supplyServiceStarted) {
          const definition = serviceByContractId(intent.contractId);
          if (!definition) throw new Error('Verified supply service is unavailable.');
          this.service.start(definition, this.serviceContext(), mapPolicy(this.requestedSettings!));
          this.supplyServiceStarted = true;
        }
        const action = this.service.tick(this.serviceContext());
        if (action) this.send(action);
        if (['failed', 'cancelled'].includes(this.service.snapshot().state))
          throw new Error(this.service.snapshot().reason);
        return true;
      }
      if (intent.type === 'action') {
        if (this.supply.uncertain) return true;
        const action = intent.action.command;
        // Recompute immediately before creating a workflow or transport receipt.
        const next = nextSupplyAction(
          context,
          this.supply.snapshot().goals,
          {
            ...this.requestedSettings!.automation!.disposition!,
            maxSpend: quantity(
              Math.min(
                this.requestedSettings!.automation!.disposition!.maxSpend,
                Math.max(
                  0,
                  this.requestedSettings!.automation!.supply!.maxSpend -
                    this.supply.snapshot().reserved +
                    intent.action.reservedSpend,
                ),
              ),
            ),
            rules: this.requestedSettings!.automation!.disposition!.rules.map((rule) => {
              const goal = this.supply.snapshot().goals.find((goal) => goal.itemId === rule.itemId);
              return goal ? { ...rule, minimum: goal.desired, desired: goal.desired } : rule;
            }),
          },
          this.requestedSettings!.automation!.supply!,
          { storageFull: this.supplyStorageFull },
        );
        if (next.type !== 'action' || JSON.stringify(next.action) !== JSON.stringify(intent.action))
          throw new Error('Supply stock, price or prerequisites changed before dispatch.');
        let economic: WorkflowReceipt;
        if (action.type === 'cart') {
          const source = (
            action.direction === 1 ? this.engine.character.inventory : this.world.cart
          ).get(domainBagId(action.bagId));
          if (!source) throw new Error('Supply source bag changed.');
          const w = this.context();
          const items = stock(w.inventory);
          economic = {
            zeny: w.zeny,
            cost: 0,
            credit: 0,
            items,
            bags: new Map(
              w.inventory.map((item) => [domainBagId(item.bagId), quantity(item.count)]),
            ),
            itemChanges: new Map([
              [domainItemId(source.itemId), (action.direction === 1 ? -1 : 1) * action.count],
            ]),
            bagChanges: new Map(
              action.direction === 1 ? [[domainBagId(action.bagId), -action.count]] : [],
            ),
            strictStock: false,
          };
        } else {
          const definition = this.supplyServiceContract
            ? serviceByContractId(this.supplyServiceContract)
            : null;
          const resolved = definition
            ? resolveServiceNpc(definition, context.map, [...this.engine.actors.values()])
            : null;
          if (!resolved || resolved.state !== 'resolved' || resolved.actor.id !== this.world.npc.id)
            throw new Error('The supply NPC is missing, ambiguous or changed before dispatch.');
          const step = this.resourceStep(action);
          if (!step || this.world.npc.id === null)
            throw new Error('Supply transaction requires a confirmed NPC.');
          const result = this.workflow.start(
            {
              name: 'Bounded supply transaction',
              map: context.map,
              npcId: this.world.npc.id,
              maxSpend: intent.action.reservedSpend,
              minStock: context.disposition.minimumStock ?? [],
              steps: [step],
            },
            this.context(),
          );
          if (!result.ok) throw new Error(result.reasons.join(' '));
          const created = this.workflow.tick(this.context());
          if (!created || JSON.stringify(created) !== JSON.stringify(action))
            throw new Error('Supply workflow did not create the revalidated action.');
          economic = this.workflow.receipt()!;
        }
        this.supplyReceipt = createSupplyReceipt(intent.action, economic, context);
        this.supply.attachReceipt(intent.id, this.supplyReceipt, context);
        // Reservation and receipt ownership precede the sole sender, including throw.
        if (!this.supply.commandAllowed())
          throw new Error('Supply command allowance exhausted before dispatch.');
        this.supply.markSent(intent.id);
        this.transport(action);
        return true;
      }
      if (intent.type === 'close') {
        if (this.world.npc.id === null && this.world.npc.mode === 'idle') {
          this.workflow.cancel('Supply batch completed.');
          this.supply.acknowledge(intent.id, 'confirmed', this.supplyContext());
          this.supplyIntent = null;
          return true;
        }
        if (!this.supplyCloseSent) {
          const action: WorldAction =
            this.world.npc.mode === 'storage'
              ? { type: 'storage', operation: 'close' }
              : this.world.npc.mode === 'shop'
                ? { type: 'shop', mode: this.world.shop!.mode, rows: [] }
                : (() => {
                    throw new Error('Supply cannot safely close the changed NPC interaction.');
                  })();
          this.supplyCloseSent = true;
          this.send(action);
        }
        return true;
      }
      if (intent.type === 'return') {
        const p = this.engine.player;
        if (this.travel.active) {
          this.travel.tick(this.engine.map, p);
          if (this.travel.snapshot().state === 'failed')
            throw new Error(this.travel.snapshot().reason);
          return true;
        }
        if (this.travel.snapshot().state === 'failed')
          throw new Error(this.travel.snapshot().reason);
        if (!p) throw new Error('Return character is unavailable.');
        if (this.engine.map !== intent.map) {
          this.travel.start(
            this.engine.map,
            p,
            intent.map,
            this.requestedSettings!.route_step,
            this.requestedSettings!.route_avoidWalls,
            mapPolicy(this.requestedSettings!),
            'return',
          );
          return true;
        }
        if (Math.floor(p.x) !== intent.position.x || Math.floor(p.y) !== intent.position.y) {
          if (this.supplyReturnApproach)
            throw new Error('Supply return did not reach the captured work cell.');
          this.supplyReturnApproach = true;
          this.travel.startApproach(
            intent.map,
            p,
            intent.position,
            this.requestedSettings!.route_step,
            mapPolicy(this.requestedSettings!),
            'return',
          );
          return true;
        }
        this.supply.acknowledge(intent.id, 'confirmed', this.supplyContext());
        if (this.supply.snapshot().state === 'complete') this.supplyIntent = null;
        return true;
      }
      if (
        !context.position ||
        !mapAllowed(mapPolicy(intent.settings), context.map) ||
        !insideLockArea(mapPolicy(intent.settings), context.map, context.position)
      )
        throw new Error('Supply return must reach the captured allowed field area.');
      this.supply.acknowledge(intent.id, 'confirmed', context);
      this.supplyIntent = null;
      if (this.initialFieldEntryPending) {
        this.resumeRun();
        return true;
      }
      this.engine.resumeRequested({
        ...intent.settings,
        map: intent.settings.automation?.mapPolicy?.lockArea ? intent.settings.map : context.map,
      });
      this.waitingReason = '';
      return true;
    } catch (error) {
      this.supplyFailure(
        error instanceof Error ? error.message : 'Supply stage failed without confirmation.',
      );
      return true;
    } finally {
      this.sendingSupply = false;
    }
  }
  private observation(): RoutineObservation {
    const p = this.engine.player;
    const c = this.engine.character;
    const inventory: Record<number, number> = {};
    if (c.inventoryKnown) {
      for (const itemId of this.macro.inventoryItemIds())
        inventory[itemId] = c.count(domainItemId(itemId));
      for (const rule of this.routineSpec?.rules ?? [])
        for (const condition of rule.conditions)
          if (condition.field === 'inventory')
            inventory[condition.itemId] = c.count(domainItemId(condition.itemId));
    }
    const predicates = routineActorPredicates(this.routineSpec?.rules ?? []);
    return {
      actors: this.engine.actorObservation([...predicates, ...this.macroPredicates]),
      map: this.engine.map,
      ...(p?.maxHp ? { hpPercent: (p.hp / p.maxHp) * 100 } : {}),
      ...(p ? { level: p.level } : c.stats?.level !== undefined ? { level: c.stats.level } : {}),
      ...(c.stats?.jobLevel !== undefined ? { jobLevel: c.stats.jobLevel } : {}),
      ...(c.stats?.weight !== undefined && c.stats.maxWeight
        ? { weightPercent: (c.stats.weight / c.stats.maxWeight) * 100 }
        : {}),
      ...(c.stats?.maxSp ? { spPercent: ((c.stats.sp ?? 0) / c.stats.maxSp) * 100 } : {}),
      ...(c.stats?.zeny !== undefined ? { zeny: c.stats.zeny } : {}),
      ...(c.inventoryKnown ? { inventory } : {}),
    };
  }
  private wait(reason: string): void {
    this.waitingReason = reason;
    this.engine.reason = reason;
    if (this.engine.running || this.travel.active) this.pause(reason);
  }
  /** Keep the original unsent owner and deadline while freshness blocks writes. */
  private waitForDatabaseState(): void {
    this.travel.tick(this.engine.map, this.engine.player);
    const state = this.travel.snapshot();
    this.waitingReason = state.reason;
    if (state.state === 'failed' && this.macroOwner?.travelTripId === this.travel.tripId)
      this.endMacro(state.reason, true);
  }
  private escapeContext(allowRetreatCancellation = false): EscapeContext {
    const blocker =
      (this.warp.blocked ? 'Waiting for Warp Portal action and resources to reconcile.' : '') ||
      (this.refineBlocksAutomation ? 'Waiting for the refine transaction to reconcile.' : '') ||
      (this.socket.busy ? 'Waiting for the exact socket receipt before escape.' : '') ||
      (this.memo.blocked ? 'Waiting for memo state to settle.' : '') ||
      (this.supply.uncertain
        ? 'Waiting for the exact supply transaction receipt before escape.'
        : '') ||
      this.blockedReason ||
      (this.featureReceipt ? 'Waiting for the previous resource action to settle.' : '') ||
      ((this.service.active && !['travel', 'approach'].includes(this.service.snapshot().state)) ||
      this.pending ||
      this.workflow.snapshot().running ||
      this.unresolvedWorld ||
      ['running', 'waiting'].includes(this.routine.snapshot().state)
        ? 'Waiting for the current action owner before emergency escape.'
        : '') ||
      (this.now() < this.fencedUntil ||
      !(allowRetreatCancellation
        ? this.engine.resourceActionsSettled
        : this.engine.featureActionsSettled)
        ? 'Waiting for the previous action and cast to settle.'
        : '') ||
      (this.world.npc.mode !== 'idle' || this.world.npc.id !== null || this.world.vending
        ? 'Finish the NPC or vending interaction before escape.'
        : '') ||
      (this.characterName && this.engine.player?.name !== this.characterName
        ? 'Waiting for the originally selected character.'
        : '') ||
      (!this.gridFor(this.engine.map)
        ? `Verified walkability is not available for ${this.engine.map}.`
        : '');
    return {
      connected: this.engine.connected,
      compatible: this.engine.compatible,
      fresh: this.now() >= this.lastFrame && this.now() - this.lastFrame <= 15_000,
      identity: this.engine.actorActionIdentity(),
      threats: (seconds) => this.engine.observedThreats(seconds),
      movementSettled: this.engine.idleForActions() && this.movementSettled(),
      castSettled: this.engine.observedOwnCastSettled(),
      map: this.engine.map,
      playerId: this.engine.playerId,
      player: this.engine.player,
      character: this.engine.character,
      connection: this.connectionEpoch,
      ready: !blocker && this.heartbeatHealthy && this.now() >= this.yieldUntil,
      blocker,
    };
  }
  private escapeTick(): boolean {
    if (
      this.engine.retreatOwned &&
      this.requestedSettings &&
      this.escape.wants(this.requestedSettings, this.escapeContext(true))
    )
      this.pause('Stopping retreat before emergency escape.');
    const context = this.escapeContext();
    this.escape.update(context);
    if (this.requestedSettings && this.escape.wants(this.requestedSettings, context)) {
      // Stop/cancel movement first, then wait 250ms before the wing/skill. The
      // normal HP guard may already have sent Stop in this incoming packet.
      this.pause('Preparing emergency escape.');
      this.escape.begin(this.requestedSettings, this.escapeContext());
    }
    if (this.escape.busy) {
      if (this.runRequested) {
        const action = this.escape.takeAction(this.escapeContext());
        if (action) {
          try {
            this.send(action);
          } catch {
            this.escape.cancel('Connection failed while sending escape.');
          }
        }
      }
      this.waitingReason = this.escape.snapshot().reason;
      this.engine.reason = this.waitingReason;
      return true;
    }
    if (this.runRequested && this.escape.blocked) {
      this.waitingReason = this.escape.snapshot().reason || 'Waiting for HP recovery after escape.';
      this.engine.reason = this.waitingReason;
      return true;
    }
    return false;
  }
  private deathIdentity(): string {
    return JSON.stringify([this.connectionEpoch, this.engine.actorActionIdentity(undefined, true)]);
  }
  private deathOwnReady(): boolean {
    return (
      !!this.readyOwn &&
      this.readyOwn.name === this.engine.player?.name &&
      this.readyOwn.identity === this.deathIdentity()
    );
  }
  private reconcileDeathPosture(): void {
    const cycle = this.deathCycle,
      p = this.engine.player;
    if (
      !cycle?.guard.uncertain ||
      !['recovery', 'failed'].includes(cycle.guard.phase) ||
      !this.readyOwn?.initialization ||
      !this.deathOwnReady() ||
      (this.deathCycleConnection !== null && this.connectionEpoch <= this.deathCycleConnection) ||
      !p ||
      p.name !== cycle.guard.character ||
      p.dead ||
      p.hp <= 0 ||
      this.engine.character.sitting === null
    )
      return;
    // A new connection's own initialization establishes current posture, not
    // which old write executed. Keep failed/stopped continuation retired.
    cycle.posture = null;
    cycle.guard.uncertain = false;
    cycle.reason =
      'Fresh character posture observed. The previous posture outcome remains unknown; a stopped or failed run will not resume.';
  }
  private revivalReady(): void {
    const cycle = this.deathCycle;
    if (!cycle || cycle.guard.phase !== 'revival') return;
    cycle.guard.uncertain = false;
    cycle.guard.phase = 'recovery';
    cycle.refresh = null;
    cycle.recoveryUntil =
      cycle.guard.recoveryDeadline || this.now() + cycle.guard.recoverySeconds * 1000;
    cycle.guard.recoveryDeadline = cycle.recoveryUntil;
    cycle.guard.returnDeadline ||= cycle.recoveryUntil + cycle.guard.returnSeconds * 1000;
    cycle.reason = 'Living character observed. Recovering before return.';
  }
  private deathRecoveryTick(): boolean {
    const settings = this.requestedSettings,
      p = this.engine.player,
      now = this.now();
    if (!settings) return false;
    const a = automationSettings(settings);
    if (
      p?.dead &&
      a.respawn.enabled &&
      (!this.deathCycle ||
        (this.engine.deaths > this.cycleDeaths &&
          !this.deathCycle.guard.uncertain &&
          !this.deathCycle.posture))
    ) {
      this.cycleDeaths = this.engine.deaths;
      this.quietUntil = Math.max(this.quietUntil, now + 2_000);
      this.supply.interrupt('Death interrupted the supply trip.');
      this.supplyIntent = null;
      this.engine.stop('Preparing automatic revival.');
      this.travel.cancel('Death interrupted travel.');
      this.travelSettings = null;
      this.deathCycle = deathCycle(
        {
          version: 1,
          character: this.characterName ?? p.name,
          destination: farmingDestination(settings),
          phase: 'revival',
          uncertain: false,
          recoverySeconds: a.recovery.timeoutSeconds,
          returnSeconds: 1200,
          recoveryDeadline: 0,
          returnDeadline: 0,
        },
        now,
      );
      this.deathCycle.ownId = p.id;
      this.deathCycleConnection = this.connectionEpoch;
      this.returning = true;
    }
    const cycle = this.deathCycle;
    if (!cycle) return false;
    this.engine.tick(false);
    this.captureActionFailure();
    this.reconcileDeathPosture();
    const wait = (reason: string) => {
      cycle.reason = reason;
      this.waitingReason = reason;
      return true;
    };
    const fail = (reason: string) => {
      cycle.guard.phase = 'failed';
      this.travel.cancel(reason);
      this.travelSettings = null;
      return wait(reason);
    };
    if (cycle.guard.phase === 'failed')
      return wait(
        cycle.reason ||
          'Death recovery was interrupted or its deadline expired. Stop and check state before another run.',
      );
    if (!p || p.name !== cycle.guard.character)
      return wait('Waiting for the original character before death recovery.');
    if (cycle.guard.phase === 'revival' && !p.dead && this.deathOwnReady()) this.revivalReady();
    if (
      cycle.guard.phase === 'recovery' &&
      cycle.recoveryUntil !== null &&
      now >= cycle.recoveryUntil
    )
      return fail('Recovery time limit reached. Check regeneration and carried weight.');
    if (cycle.guard.phase === 'return' && cycle.returnUntil !== null && now >= cycle.returnUntil)
      return fail('Return time limit reached. No new return attempt will be started.');
    if (
      this.blockedReason ||
      (this.featureReceipt && !['respawn', 'sit'].includes(this.featureReceipt.action.type)) ||
      this.unresolvedWorld ||
      this.supply.uncertain ||
      this.escape.busy ||
      this.warp.blocked ||
      this.refineBlocksAutomation ||
      this.socket.busy ||
      this.memo.blocked ||
      this.pending ||
      this.service.active ||
      this.workflow.snapshot().running ||
      this.now() < this.fencedUntil ||
      !this.engine.featureActionsSettled
    )
      return wait(
        this.blockedReason || 'Waiting for previous actions to settle before death recovery.',
      );
    if (this.world.npc.mode !== 'idle' || this.world.npc.id !== null || this.world.vending)
      return wait('Waiting for the current interaction to close before death recovery.');
    if (cycle.posture) {
      const result = this.engine.actionResult;
      if (result.sequence === cycle.posture.sequence && result.status === 'failed')
        return fail('Recovery posture was not confirmed. No repeat posture request will be sent.');
      return wait('Waiting for the exact recovery posture confirmation.');
    }
    if (cycle.guard.phase === 'revival') {
      if (!p.dead) return wait('Waiting for an ordered ready living-own arrival.');
      if (!a.respawn.enabled || this.engine.deaths > a.respawn.maxDeaths)
        return wait(
          a.respawn.enabled
            ? `Death limit reached. ${deathLimitGuidance(this.engine.deaths, a.respawn.maxDeaths)}`
            : 'Waiting for revival; automatic respawn is disabled.',
        );
      if (cycle.guard.uncertain)
        return wait(
          'Respawn outcome is unconfirmed. Waiting for a verified living character; no repeat request will be sent.',
        );
      if (now < this.quietUntil)
        return wait(
          'Waiting briefly for input and movement to settle before the one respawn attempt.',
        );
      if (!this.engine.idleForActions())
        return wait('Waiting for movement to settle before respawn.');
      // Reserve the episode before writing; an exception cannot authorize replay.
      cycle.guard.uncertain = true;
      cycle.ownId = p.id;
      try {
        this.engine.manualAction({ type: 'respawn' });
      } catch {
        return wait('Respawn send is uncertain. Waiting for living state; nothing will retry.');
      }
      this.captureActionFailure();
      return wait('Waiting for the respawned living character.');
    }
    if (p.dead)
      return fail(
        'Character died again during recovery or return. The previous cycle will not restart.',
      );
    if (!this.deathOwnReady())
      return wait('Waiting for the ready living-own arrival before recovery or return.');
    if (cycle.guard.phase === 'recovery') {
      if (!this.engine.observedOwnCastSettled()) return wait(OWN_CAST_WAIT_REASON);
      if (a.recovery.enabled) {
        let recovery;
        try {
          recovery = this.engine.recoveryOnly(settings);
        } catch {
          return fail('Recovery posture send is uncertain. No repeat request will be sent.');
        }
        if (this.engine.pendingFeatureAction?.type === 'sit') {
          cycle.posture = {
            sitting: this.engine.pendingFeatureAction.sitting,
            sequence: this.engine.actionResult.sequence,
            identity: this.deathIdentity(),
          };
          cycle.guard.uncertain = true;
        }
        if (!recovery.complete) return wait(recovery.reason);
      }
      if (!a.recovery.enabled && this.engine.character.sitting === true) {
        try {
          this.engine.manualAction({ type: 'sit', sitting: false });
        } catch {
          return fail('Standing posture send is uncertain. No repeat request will be sent.');
        }
        cycle.posture = {
          sitting: false,
          sequence: this.engine.actionResult.sequence,
          identity: this.deathIdentity(),
        };
        cycle.guard.uncertain = true;
        return wait('Waiting for confirmed standing posture before return.');
      }
      if (!p.maxHp || (p.hp / p.maxHp) * 100 <= settings.minHpPercent)
        return wait('Waiting for HP to recover above the configured field and travel limit.');
      if (this.engine.character.sitting !== false)
        return wait('Waiting for confirmed standing posture before return.');
      cycle.guard.phase = 'return';
      cycle.returnUntil = Math.min(
        cycle.guard.returnDeadline || Infinity,
        now + cycle.guard.returnSeconds * 1000,
      );
      cycle.guard.returnDeadline = cycle.returnUntil;
    }
    if (!p.maxHp || (p.hp / p.maxHp) * 100 <= settings.minHpPercent) {
      if (this.travel.active)
        this.pause('Waiting for HP and a living character before travelling.');
      return fail(
        'Return interrupted by unavailable or low HP. The original return deadline will not restart.',
      );
    }
    if (this.travel.active) {
      this.travel.tick(this.engine.map, p);
      const result = this.travel.snapshot();
      if (result.state === 'failed') return fail(result.reason);
      return wait(result.reason);
    }
    if (!this.engine.idleForActions())
      return wait('Waiting for previous movement and posture to settle before return.');
    if (this.travel.snapshot().state === 'failed' && this.travelSettings)
      return fail(this.travel.snapshot().reason);
    this.travelSettings = null;
    const policy = mapPolicy(settings),
      destination = a.travel.returnToLockMap
        ? cycle.guard.destination
        : policy.lockArea?.map || this.engine.map;
    try {
      if (this.engine.map !== destination) {
        this.travel.start(
          this.engine.map,
          p,
          destination,
          settings.route_step,
          settings.route_avoidWalls,
          policy,
          'return',
        );
        this.travelSettings = settings;
        return wait('Returning to the captured farming map.');
      }
      const grid = this.gridFor(this.engine.map);
      if (!grid) return wait('Waiting for verified collision data before field return.');
      if (!mapAllowed(policy, this.engine.map))
        return fail('The captured farming destination is forbidden by the map policy.');
      if (!insideLockArea(policy, this.engine.map, p)) {
        const entry = lockEntry(this.engine.map, p, grid, policy);
        if (!entry) return wait('No reachable safe cell inside the field lock area.');
        this.travel.startApproach(
          this.engine.map,
          p,
          entry,
          settings.route_step,
          policy,
          'field-entry',
        );
        this.travelSettings = settings;
        return wait('Entering the captured farming area.');
      }
      if (
        grid.portals?.some(
          (area) =>
            Math.abs(p.x - area.x) <= area.halfWidth && Math.abs(p.y - area.y) <= area.halfHeight,
        )
      ) {
        this.travel.start(
          this.engine.map,
          p,
          this.engine.map,
          settings.route_step,
          settings.route_avoidWalls,
          policy,
          'return',
        );
        this.travelSettings = settings;
        return wait('Settling off the arrival portal before field activity.');
      }
      this.deathCycle = null;
      this.returning = false;
      this.retryAt = 0;
      this.waitingReason = 'Recovery and return verified. Resuming the requested field run.';
      this.resumeRun();
      return true;
    } catch (error) {
      return fail(
        error instanceof Error
          ? error.message
          : 'Return failed. No new deadline or attempt will be created.',
      );
    }
  }
  private partyFollowContext(): PartyFollowContext {
    return {
      party: this.world.party,
      bindings: this.world.partyActors,
      observations: this.engine.observations,
      actors: this.engine.actors,
      map: this.engine.map,
      player: this.engine.player,
      own: this.engine.actorActionIdentity(),
      connection: this.connectionEpoch,
      admissionReady:
        !this.deathCycle &&
        !this.engine.pendingFeatureAction &&
        this.engine.featureActionsSettled &&
        !this.warp.blocked &&
        !this.socket.busy &&
        !this.memo.blocked &&
        !this.social.busy &&
        !this.supply.ownsField &&
        !this.supply.uncertain &&
        !this.escape.busy &&
        !this.service.active &&
        !this.travel.active &&
        !this.engine.manualTargetOwned &&
        !this.pending &&
        !this.featureReceipt &&
        !this.unresolvedWorld &&
        !this.workflowOutstanding &&
        !this.workflow.snapshot().running &&
        !['running', 'waiting'].includes(this.routine.snapshot().state) &&
        this.world.npc.id === null &&
        this.world.npc.mode === 'idle' &&
        !this.world.vending,
    };
  }
  /** Arbitration precedes every new field, supply, routine and manual decision. */
  private partyFollowTick(): boolean {
    if (!this.runRequested || !this.partyFollow.enabled) return false;
    const context = this.partyFollowContext();
    this.partyFollow.update(context);
    const state = this.partyFollow.snapshot();
    if (state.state === 'following') return false;
    if (this.engine.running) this.engine.stop(state.reason);
    this.engine.tick(false);
    this.captureActionFailure();
    this.waitingReason = this.engine.reason = state.reason;
    if (this.partyFollow.terminal) {
      if (this.travel.active && this.travel.snapshot().purpose === 'party-follow')
        this.travel.cancel(state.reason);
      return (
        !this.deathCycle &&
        context.player?.dead !== true &&
        (state.attemptUsed || context.admissionReady !== false)
      );
    }
    // Existing transactions/escape/maintenance retain their own receipts and deadlines.
    if (!this.partyFollow.ownsTravel && context.admissionReady === false) return false;
    const attempt = this.partyFollow.prepared();
    if (attempt) {
      if (
        !context.player ||
        context.player.dead ||
        !context.player.maxHp ||
        (context.player.hp / context.player.maxHp) * 100 <= attempt.settings.minHpPercent
      ) {
        this.partyFollow.cancel('Health interrupted party rendezvous. Stop and Start to retry.');
        return true;
      }
      if (
        !this.engine.observedOwnCastSettled() ||
        !this.engine.idleForActions() ||
        !this.movementSettled() ||
        this.now() < this.fencedUntil ||
        this.now() < this.yieldUntil
      )
        return true;
      try {
        this.travel.start(
          context.map,
          context.player,
          attempt.destination,
          attempt.settings.route_step,
          attempt.settings.route_avoidWalls,
          attempt.policy,
          'party-follow',
        );
        this.partyFollow.travelling(this.travel.tripId);
      } catch (error) {
        this.partyFollow.fail(
          error instanceof Error ? error.message : 'No verified party rendezvous route.',
        );
      }
    }
    if (this.partyFollow.ownsTravel && this.travel.active) {
      const p = this.engine.player;
      if (
        p &&
        (p.dead || !p.maxHp || (p.hp / p.maxHp) * 100 <= this.requestedSettings!.minHpPercent)
      )
        this.partyFollow.cancel('Health interrupted party rendezvous. Stop and Start to retry.');
      else this.travel.tick(this.engine.map, p);
      const travel = this.travel.snapshot();
      if (travel.state === 'failed' || travel.state === 'cancelled')
        this.partyFollow.fail(travel.reason);
      else if (travel.state === 'complete') {
        this.partyFollow.travelComplete();
        this.partyFollow.update(this.partyFollowContext());
      }
    }
    if (this.partyFollow.terminal && this.travel.active)
      this.travel.cancel(this.partyFollow.snapshot().reason);
    this.waitingReason = this.engine.reason = this.partyFollow.snapshot().reason;
    return true;
  }
  private macroFieldSettings(
    step: Extract<MacroStep, { type: 'farm' }>,
    base = this.macroBase!,
  ): RunSettings {
    const policy = mapPolicy(base);
    if (!mapAllowed(policy, step.map) || (policy.lockArea && policy.lockArea.map !== step.map))
      throw new Error('Macro field conflicts with the configured map policy or lock area.');
    const projected = settingsDraft(base),
      automation = automationDraft(automationSettings(base));
    projected.map = step.map;
    projected.targets = [...step.targets];
    automation.travel = {
      ...automation.travel,
      destinationMap: step.map,
      waypoints: [],
      loop: false,
    };
    projected.automation = automation;
    return validateSettings(projected);
  }
  private endMacro(reason: string, failed = false): void {
    if (!this.macro.active && !this.macroBase) return;
    if (failed) this.macro.fail(reason);
    if (this.macro.active) this.macro.cancel(reason);
    this.macroOwner = null;
    this.macroBase = null;
    this.macroPredicates = [];
    this.supply.stop(reason);
    this.supplyIntent = null;
    this.supplyStorageFull = null;
    this.escape.cancel(reason);
    this.partyHeal.cancel(reason);
    this.requestedSettings = null;
    this.initialFieldEntryPending = false;
    this.returnSettings = null;
    this.returning = false;
    this.captureActionFailure();
    this.retireWorld();
    this.pending = null;
    this.service.cancel(reason);
    this.workflow.cancel(reason);
    this.travel.cancel(reason);
    this.travelSettings = null;
    this.engine.stop(reason);
    this.captureActionFailure();
    this.waitingReason = reason;
  }
  private pollMacro(): void {
    if (!this.macro.active) return;
    if (
      this.characterName &&
      this.engine.player &&
      this.engine.player.name !== this.characterName
    ) {
      this.endMacro('Macro character changed.', true);
      return;
    }
    const intent = this.macro.tick(this.observation());
    if (!this.macro.active) {
      this.endMacro(this.macro.snapshot().reason);
      return;
    }
    if (intent && !this.macroOwner) {
      // The step identity owns every child before it can write to the transport.
      this.macroOwner = {
        intent,
        phase: 'settling',
        stopped: false,
        ...(intent.step.type === 'skill' && intent.step.mode === 'target'
          ? { target: this.engine.macroTargetIdentity() ?? undefined }
          : {}),
      };
      this.waitingReason =
        this.engine.reason = `Macro ${this.macro.snapshot().currentRule}: preparing ${intent.step.type}.`;
      this.engine.note(this.waitingReason);
    }
  }
  private acknowledgeMacro(
    binding: NonNullable<Pending['macro']>,
    success: boolean,
    reason: string,
  ): void {
    const owner = this.macroOwner;
    if (
      !owner ||
      owner.intent.id !== binding.id ||
      owner.intent.generation !== binding.generation ||
      this.macro.currentIntent?.generation !== binding.generation
    )
      return;
    this.macro.acknowledge(binding.id, success, reason);
    this.macroOwner = null;
    this.waitingReason = this.engine.reason = reason;
    this.engine.note(reason);
    if (!this.macro.active) {
      this.endMacro(this.macro.snapshot().reason);
      return;
    }
    const field = this.macro.fieldIntent;
    if (field && !this.macro.snapshot().fieldSuspended) {
      this.requestedSettings = this.macroFieldSettings(field);
      this.retryAt = 0;
    }
  }
  private macroTransaction(owner: MacroOwner): void {
    const step = owner.intent.step;
    if (step.type !== 'buy' && step.type !== 'store')
      throw new Error('Invalid macro service transaction.');
    const context = this.context(),
      service = owner.service!,
      resolved = resolveServiceNpc(service, context.map, [...this.engine.actors.values()]);
    if (resolved.state !== 'resolved' || resolved.actor.id !== this.world.npc.id)
      throw new Error('Macro service NPC identity changed before the transaction.');
    const budget = step.maxSpend - (owner.serviceFee ?? 0),
      floors = dispositionStockFloors(automationSettings(this.macroBase!));
    let steps: WorkflowStep[];
    if (step.type === 'buy')
      steps = [{ type: 'buy', rows: [{ id: step.itemId, count: step.quantity }] }];
    else {
      const count = this.engine.character.count(domainItemId(step.itemId)),
        keep = Math.max(
          step.keep,
          count - step.quantity,
          ...floors.filter((row) => row.itemId === step.itemId).map((row) => row.count),
          ...(automationSettings(this.macroBase!).disposition?.rules ?? [])
            .filter((row) => row.itemId === step.itemId)
            .map((row) => row.keep),
        );
      if (keep > 32767)
        throw new Error('Macro storage keep quantity exceeds the supported stock contract.');
      const disposition = this.supplyContext().disposition;
      const plan = planDisposition(
        {
          maxSpend: budget,
          rules: [
            {
              itemId: step.itemId,
              keep,
              minimum: keep,
              desired: keep,
              maximum: keep,
              store: true,
              sell: false,
              cart: false,
              restock: 'off',
              allowUnique: false,
            },
          ],
        },
        disposition,
      );
      if (plan.blocked.length || plan.unmet.length || !plan.actions.length)
        throw new Error(
          plan.blocked.join(' ') ||
            plan.unmet.flatMap((row) => row.reasons).join(' ') ||
            'No safely storable excess inventory.',
        );
      steps = plan.actions.map((action) => {
        const resource = this.resourceStep(action.command);
        if (!resource) throw new Error('Unsupported macro storage action.');
        return resource;
      });
    }
    const result = this.workflow.start(
      {
        name: 'Macro transaction',
        map: context.map,
        npcId: this.world.npc.id!,
        maxSpend: budget,
        minStock: floors,
        steps,
        timeoutMs: Math.min(60_000, step.timeoutSeconds * 1000),
      },
      context,
    );
    if (!result.ok) throw new Error(result.reasons.join(' '));
    owner.phase = 'workflow';
    this.workflowTimeout = Math.min(60_000, step.timeoutSeconds * 1000);
    this.workflowOutstanding = null;
    this.workflowDeadline = 0;
    this.pending = {
      action:
        step.type === 'buy'
          ? { type: 'shop', mode: 'buy', rows: [{ id: step.itemId, count: step.quantity }] }
          : { type: 'storage', operation: 'close' },
      since: this.now(),
      routineId: null,
      generation: this.generation,
      worldGeneration: this.world.generation,
      map: this.engine.map,
      npcId: this.world.npc.id,
      workflow: true,
      sent: false,
      macro: { id: owner.intent.id, generation: owner.intent.generation },
    };
  }
  private macroStockFloor(itemId: number): number {
    const policy = automationSettings(this.macroBase!);
    return Math.max(
      0,
      ...dispositionStockFloors(policy)
        .filter((row) => row.itemId === itemId)
        .map((row) => row.count),
      ...(policy.disposition?.rules ?? [])
        .filter((row) => row.itemId === itemId)
        .map((row) => row.keep),
    );
  }
  /** Macro selection yields decisions while existing receipts and movement drain. */
  private macroTick(): boolean {
    const owner = this.macroOwner;
    if (!this.macro.active || !owner) return false;
    const step = owner.intent.step,
      binding = { id: owner.intent.id, generation: owner.intent.generation };
    try {
      if (owner.phase === 'settling') {
        this.engine.tick(false);
        this.captureActionFailure();
        this.syncWorkflowOwner();
        if (
          this.pending ||
          this.featureReceipt ||
          this.workflowOutstanding ||
          this.unresolvedWorld ||
          this.supply.ownsField ||
          this.supply.uncertain ||
          !this.engine.macroHandoffSettled() ||
          !this.movementSettled() ||
          this.now() < this.fencedUntil
        )
          return true;
        if (this.world.npc.id !== null || this.world.npc.mode !== 'idle' || this.world.vending) {
          this.waitingReason =
            'Waiting for the official NPC interaction to finish before the macro step.';
          return true;
        }
        if (!owner.stopped) {
          owner.stopped = true;
          this.engine.stop('Preparing the selected macro step.');
          this.captureActionFailure();
        }
        if (!this.engine.idleForActions()) return true;
        if (step.type === 'farm') {
          this.requestedSettings = this.macroFieldSettings(step);
          this.returnSettings = automationSettings(this.requestedSettings).travel.returnToLockMap
            ? structuredClone(this.requestedSettings)
            : null;
          this.retryAt = 0;
          owner.phase = 'farm';
        } else if (step.type === 'travel') {
          const p = this.engine.player!;
          this.travel.start(
            this.engine.map,
            p,
            step.map,
            this.macroBase!.route_step,
            this.macroBase!.route_avoidWalls,
            mapPolicy(this.macroBase!),
          );
          owner.phase = 'travel';
          owner.travelTripId = this.travel.tripId;
          this.travelSettings = this.macroBase;
        } else if (step.type === 'buy' || step.type === 'store') {
          const definition = BUILTIN_SERVICES.find((service) => service.id === step.serviceId);
          if (
            !definition ||
            (step.type === 'buy'
              ? definition.outcome.type !== 'shopOpened' || definition.outcome.mode !== 'buy'
              : definition.outcome.type !== 'storageOpened')
          )
            throw new Error(
              'Macro requires a catalog service with the corresponding opening outcome.',
            );
          const fee = definition.workflow.steps.reduce(
            (total, row) => total + ('expectedCost' in row ? (row.expectedCost ?? 0) : 0),
            0,
          );
          if (fee > step.maxSpend) throw new Error('Service fee exceeds the macro visit cap.');
          owner.service = definition;
          owner.serviceFee = fee;
          owner.phase = 'service';
          this.service.start(
            {
              ...definition,
              workflow: {
                ...definition.workflow,
                maxSpend: Math.min(definition.workflow.maxSpend, step.maxSpend),
              },
            },
            this.serviceContext(),
            mapPolicy(this.macroBase!),
          );
        } else {
          if (
            step.type === 'useItem' &&
            this.engine.character.count(domainItemId(step.itemId)) <=
              this.macroStockFloor(step.itemId)
          )
            throw new Error(
              `Macro item ${step.itemId} is unavailable above the configured stock reserve.`,
            );
          owner.phase = 'action';
          const action: ExpandedAction =
            step.type === 'useItem'
              ? { type: 'useItem', itemId: step.itemId }
              : step.mode === 'self'
                ? { type: 'skill', mode: 'self', skillId: step.skillId, level: step.level }
                : (() => {
                    if (
                      !owner.target ||
                      owner.target.targetId === undefined ||
                      !sameActionIdentity(owner.target, this.engine.macroTargetIdentity())
                    )
                      throw new Error(
                        'The macro combat target is no longer eligible in its observed lifetime.',
                      );
                    return {
                      type: 'skill',
                      mode: 'target',
                      skillId: step.skillId,
                      level: step.level,
                      target: owner.target.targetId,
                    } as const;
                  })();
          this.dispatch(action, null, false, binding);
          return true;
        }
      }
      if (owner.phase === 'farm') {
        if (owner.travelTripId && owner.travelTripId !== this.travel.tripId)
          throw new Error('The macro field trip was replaced by another travel owner.');
        if (owner.travelTripId && ['failed', 'cancelled'].includes(this.travel.snapshot().state))
          throw new Error(this.travel.snapshot().reason);
        this.resumeRun();
        if (this.travel.active) {
          owner.travelTripId = this.travel.tripId;
          return false;
        }
        if (
          step.type === 'farm' &&
          this.engine.running &&
          this.engine.map === step.map &&
          this.engine.player &&
          !this.engine.player.dead &&
          this.engine.actorActionIdentity()
        )
          this.acknowledgeMacro(binding, true, 'Macro field activated.');
        return true;
      }
      if (owner.phase === 'travel') {
        const state = this.travel.snapshot();
        if (
          owner.travelTripId !== this.travel.tripId ||
          step.type !== 'travel' ||
          state.destination !== step.map
        )
          throw new Error('The macro destination trip was replaced by another travel owner.');
        if (
          state.state === 'complete' &&
          this.engine.player &&
          !this.engine.player.dead &&
          this.engine.map === step.map &&
          this.engine.actorActionIdentity()
        ) {
          this.travelSettings = null;
          this.acknowledgeMacro(binding, true, 'Macro destination verified.');
          return true;
        }
        if (['failed', 'cancelled'].includes(state.state)) throw new Error(state.reason);
        return false;
      }
      if (owner.phase === 'service') {
        const state = this.service.snapshot();
        if (state.state === 'complete') {
          owner.serviceFee = state.spent;
          this.macroTransaction(owner);
          return false;
        }
        if (['failed', 'cancelled'].includes(state.state)) throw new Error(state.reason);
        owner.travelTripId = this.travel.active ? this.travel.tripId : owner.travelTripId;
        return false;
      }
      if (owner.phase === 'closing') {
        if (this.world.npc.id === null && this.world.npc.mode === 'idle') {
          this.acknowledgeMacro(binding, true, 'Macro transaction and NPC close confirmed.');
          return true;
        }
        const context = this.context(),
          storage = step.type === 'store';
        if (
          storage
            ? this.world.npc.mode !== 'storage'
            : this.world.npc.mode !== 'shop' || this.world.shop?.mode !== 'buy'
        )
          throw new Error('Macro NPC changed before close.');
        const result = this.workflow.start(
          {
            name: 'Close macro transaction',
            map: context.map,
            npcId: this.world.npc.id!,
            maxSpend: 0,
            minStock: [],
            steps: [{ type: storage ? 'closeStorage' : 'closeShop' }],
            timeoutMs: this.workflowTimeout,
          },
          context,
        );
        if (!result.ok) throw new Error(result.reasons.join(' '));
        owner.phase = 'closeReceipt';
        this.pending = {
          action: storage
            ? { type: 'storage', operation: 'close' }
            : { type: 'shop', mode: 'buy', rows: [] },
          since: this.now(),
          routineId: null,
          generation: this.generation,
          worldGeneration: this.world.generation,
          map: this.engine.map,
          npcId: this.world.npc.id,
          workflow: true,
          sent: false,
          macro: binding,
        };
        return false;
      }
      return false;
    } catch (error) {
      this.endMacro(error instanceof Error ? error.message : 'Macro operation failed.', true);
      return true;
    }
  }
  private resumeRun(): void {
    if (this.pendingSettings) return;
    if (
      this.macro.active &&
      (!this.macro.fieldIntent || this.macro.snapshot().fieldSuspended) &&
      this.macroOwner?.phase !== 'farm'
    )
      return;
    const settings = this.requestedSettings;
    if (this.partyFollow.enabled) {
      this.partyFollow.update(this.partyFollowContext());
      if (this.partyFollow.snapshot().state !== 'following') return;
    }
    if (
      !settings ||
      this.warp.blocked ||
      this.refineBlocksAutomation ||
      this.deathCycle ||
      this.socket.busy ||
      this.memo.blocked ||
      this.supply.ownsField ||
      this.supply.uncertain ||
      this.engine.running ||
      this.travel.active ||
      this.pending ||
      this.workflow.snapshot().running ||
      ['running', 'waiting'].includes(this.routine.snapshot().state)
    )
      return;
    const now = this.now();
    const policy = automationSettings(settings);
    const player = this.engine.player;
    if (this.escape.blocked) {
      this.waitingReason = this.escape.snapshot().reason;
      return;
    }
    if (this.blockedReason) {
      this.wait(this.blockedReason);
      return;
    }
    if (!this.heartbeatHealthy) {
      this.wait('Waiting for the client connection.');
      return;
    }
    if (now < this.yieldUntil) {
      this.wait('Yielding briefly to manual game input.');
      return;
    }
    if (!this.engine.observedOwnCastSettled()) {
      this.waitingReason = this.engine.reason = OWN_CAST_WAIT_REASON;
      return;
    }
    if (
      now < this.fencedUntil ||
      !this.travel.movementSettled(this.engine.map, player) ||
      !this.engine.idleForActions()
    ) {
      this.wait('Waiting for the previous action and movement to settle.');
      return;
    }
    const identityWait = fieldIdentityWaitReason({
      connected: this.engine.connected,
      compatible: this.engine.compatible,
      hasPlayer: !!player,
      map: this.engine.map,
      dead: player?.dead ?? false,
      ownActorObserved: !player || player.dead || !!this.engine.actorActionIdentity(),
    });
    if (identityWait) {
      this.wait(identityWait);
      return;
    }
    if (!player) return;
    this.characterName ??= player.name;
    const stats = this.engine.character.stats;
    const decision = fieldResumeDecision({
      now,
      lastFrame: this.lastFrame,
      retryAt: this.retryAt,
      originalCharacter: this.characterName,
      character: player.name,
      unresolvedWorld: !!this.unresolvedWorld,
      weightLimit: policy.limits.weightPercent,
      weight: stats?.weight,
      maxWeight: stats?.maxWeight,
      databasePreparing: this.travel.databasePreparing,
      databaseReason:
        now - this.lastFrame > 15_000 && this.travel.databasePreparing
          ? this.travel.snapshot().reason
          : '',
      dead: player.dead,
      respawnEnabled: policy.respawn.enabled,
      deaths: this.engine.deaths,
      maxDeaths: policy.respawn.maxDeaths,
      hp: player.hp,
      maxHp: player.maxHp,
      minHpPercent: settings.minHpPercent,
      npcMode: this.world.npc.mode,
      npcId: this.world.npc.id,
      vending: !!this.world.vending,
    });
    if (decision.type === 'wait') {
      this.wait(decision.reason);
      return;
    }
    if (decision.type === 'database-wait') {
      this.waitingReason = decision.reason;
      return;
    }
    if (decision.type === 'hold') return;
    try {
      const executionPolicy = mapPolicy(settings);
      const destination =
        executionPolicy.lockArea?.map ??
        (this.partyFollow.completed
          ? ''
          : this.returning && this.returnSettings
            ? this.returnSettings.map
            : policy.travel.destinationMap ||
              (this.initialFieldEntryPending && !this.partyFollow.enabled ? settings.map : ''));
      if (!player.dead && destination && destination !== this.engine.map) {
        this.travel.start(
          this.engine.map,
          player,
          destination,
          settings.route_step,
          settings.route_avoidWalls,
          executionPolicy,
          this.returning ? 'return' : 'travel',
        );
        this.travelSettings = settings;
        this.waitingReason = '';
        this.retries = 0;
      } else {
        const ground = this.gridFor(this.engine.map);
        if (
          !player.dead &&
          ground?.walkable({ x: Math.floor(player.x), y: Math.floor(player.y) }) &&
          ground.portals?.some(
            (area) =>
              Math.abs(player.x - area.x) <= area.halfWidth &&
              Math.abs(player.y - area.y) <= area.halfHeight,
          )
        ) {
          this.travel.start(
            this.engine.map,
            player,
            this.engine.map,
            settings.route_step,
            settings.route_avoidWalls,
            executionPolicy,
          );
          this.travelSettings = settings;
          this.waitingReason = '';
          return;
        }
        if (!player.dead && !mapAllowed(executionPolicy, this.engine.map))
          throw new Error('Current map is forbidden; choose an allowed destination for departure.');
        if (!player.dead && !insideLockArea(executionPolicy, this.engine.map, player)) {
          const target = ground && lockEntry(this.engine.map, player, ground, executionPolicy);
          if (!target) throw new Error('No reachable safe cell inside the field lock area.');
          this.travel.startApproach(
            this.engine.map,
            player,
            target,
            settings.route_step,
            executionPolicy,
            'field-entry',
          );
          this.travelSettings = settings;
          this.waitingReason = '';
          return;
        }
        const bound = {
          ...settings,
          map: executionPolicy.lockArea ? settings.map : this.engine.map,
        };
        this.engine.resumeRequested(bound);
        this.initialFieldEntryPending = false;
        this.experienceConnection = this.connectionEpoch;
        this.returning = false;
        this.travelSettings = null;
        this.waitingReason = '';
        this.retries = 0;
      }
    } catch (error) {
      this.waitingReason =
        error instanceof Error ? error.message : 'Waiting for a verified reachable route.';
      this.engine.reason = this.waitingReason;
      this.retryAt = now + Math.min(5_000, 250 * 2 ** Math.min(this.retries++, 5));
    }
  }
  tick(): void {
    if (this.updateSuspended) {
      this.updateTick();
      return;
    }
    this.applySettledSettings();
    const now = this.now();
    // Macro duration and step deadlines cannot be renewed by another owner's wait.
    this.pollMacro();
    // A sent transfer's finite deadline advances even while the own actor is absent.
    if (this.travel.teleportPending) this.travel.tick(this.engine.map, this.engine.player);
    this.partyFollow.advanceDeadline();
    this.social.tick();
    this.memo.tick(this.memoContext());
    // Retire Warp's original observation windows before any other owner can return.
    // Availability evidence never acknowledges its pending resources or restores intent.
    this.warp.tick(this.warpContext());
    this.socket.tick(this.socketContext());
    this.refine.tick(this.refineContext());
    if (this.socket.busy) {
      this.engine.castAvailability.cancel(
        'Manual socket ownership stopped automatic cast recovery.',
      );
      return;
    }
    if (this.refineBlocksAutomation) {
      this.engine.castAvailability.cancel('Refining ownership stopped automatic cast recovery.');
      // Retained economic ownership blocks decisions, not the original
      // deadlines of commands already sent on the current transport.
      this.engine.tick(false);
      this.captureActionFailure();
      this.syncWorkflowOwner();
      if (this.pending?.engineSequence !== undefined) {
        const result = this.engine.actionResult;
        if (result.sequence === this.pending.engineSequence && result.status !== 'pending')
          this.completePending(result.status === 'confirmed', result.reason);
      }
      return;
    }
    this.escape.update(this.escapeContext());
    if (this.active && this.lastTick && now - this.lastTick > 5_000) {
      this.lastTick = now;
      this.pause('Waiting for fresh state after the Mac or game paused.', 1_000);
      return;
    }
    this.lastTick = now;
    if (this.warp.blocked) {
      this.engine.castAvailability.cancel(
        'Manual Warp Portal ownership stopped automatic cast recovery.',
      );
      // Advance existing physical/resource clocks without new field decisions.
      // Local expiry does not acknowledge Warp spending or release its hold.
      this.engine.tick(false);
      this.captureActionFailure();
      this.syncWorkflowOwner();
      return;
    }
    // Advance finite routine deadlines before any workflow can produce a packet.
    this.routine.advance();
    if (
      this.pending?.routineId !== null &&
      this.pending?.routineId !== undefined &&
      !['running', 'waiting'].includes(this.routine.snapshot().state)
    ) {
      this.retireWorld();
      this.workflow.cancel('The owning routine ended.');
      this.engine.stop('The owning routine ended.');
      this.pending = null;
    }
    if (this.runRequested) {
      const policy = automationSettings(this.requestedSettings!);
      if (!inSchedule(policy, now)) {
        this.wait('Waiting for the configured daily schedule.');
        return;
      }
      const limit = reachedRunLimit({
        limits: policy.limits,
        elapsedMilliseconds: now - this.started,
        kills: this.engine.kills - this.runKills,
        pickups: this.engine.looted - this.runPickups,
      });
      if (limit) {
        this.wait(runLimitReason(limit));
        return;
      }
      if (!this.heartbeatHealthy) {
        this.resumeRun();
        return;
      }
      if (!this.engine.connected || !this.engine.compatible || now - this.lastFrame > 15_000) {
        if (this.travel.databasePreparing && this.engine.connected && this.engine.compatible) {
          this.waitForDatabaseState();
          return;
        }
        this.wait(
          !this.engine.connected
            ? 'Waiting for the game to reconnect.'
            : !this.engine.compatible
              ? 'Waiting for a verified game build and protocol.'
              : 'Waiting for a fresh server update.',
        );
        return;
      }
    }
    this.castAvailabilityTick();
    if (now < this.yieldUntil) {
      // Poll receipts, movement and absolute deadlines while held keys keep
      // extending the grace period. The engine's clock must not look asleep.
      this.engine.tick(false);
      this.captureActionFailure();
      this.syncWorkflowOwner();
      if (this.travel.snapshot().state === 'planning')
        this.travel.tick(this.engine.map, this.engine.player);
      this.resumeRun();
      return;
    }
    // Safety can terminate follow without replenishing its captured allowance.
    // Existing escape/death owners still drain their receipts after cancellation.
    if (
      this.partyFollow.enabled &&
      this.requestedSettings &&
      !this.deathCycle &&
      !this.engine.player?.dead &&
      (this.escape.busy ||
        this.escape.blocked ||
        this.escape.wants(this.requestedSettings, this.escapeContext())) &&
      this.escapeTick()
    )
      return;
    if (this.partyFollowTick()) return;
    if (this.partyHeal.busy && !this.engine.pendingFeatureAction) {
      this.waitingReason = this.partyHeal.snapshot().reason;
      this.engine.tick(false);
      return;
    }
    if (this.deathRecoveryTick()) return;
    // Escape owns its own receipt rather than the scheduler's cost-only ACK.
    // It must run while a requested field run is already waiting below its HP floor.
    if (this.escapeTick()) return;
    if (
      (!this.macro.active ||
        this.supply.ownsField ||
        this.supply.uncertain ||
        (!this.macroOwner && !!this.macro.fieldIntent)) &&
      this.supplyTick()
    )
      return;
    if (this.macroTick()) return;
    const wasRunning = this.engine.running;
    const manualBlocker = this.engine.manualTargetActive ? this.manualWorldBlocker() : null;
    if (manualBlocker) this.engine.stop(manualBlocker);
    this.engine.tick(
      !this.pendingSettings &&
        !this.macroOwner &&
        this.world.npc.id === null &&
        this.world.npc.mode === 'idle' &&
        !this.world.vending,
    );
    this.captureActionFailure();
    this.applySettledSettings();
    if (
      this.runRequested &&
      wasRunning &&
      !this.engine.running &&
      !this.engine.player?.dead &&
      !this.engine.reason.includes('HP reached')
    ) {
      this.waitingReason = this.engine.reason;
      this.retryAt = Math.max(this.retryAt, now + 5_000);
    }
    this.syncWorkflowOwner();
    if (!this.active) return;
    if (
      !this.engine.connected ||
      !this.engine.compatible ||
      now - Math.max(this.started, this.lastFrame) > 15_000
    ) {
      if (this.travel.databasePreparing && this.engine.connected && this.engine.compatible) {
        this.waitForDatabaseState();
        return;
      }
      this.pause('Game state became unavailable.');
      return;
    }
    if (this.service.active) {
      let action: WorldAction | null;
      try {
        action = this.service.tick(this.serviceContext());
      } catch (error) {
        if (!this.macroOwner) throw error;
        this.endMacro('Macro service movement is uncertain. No request will be repeated.', true);
        return;
      }
      if (action) {
        const receipt = this.service.receipt()!;
        this.workflowDeadline = now + (receipt.outcome?.timeoutMs ?? 60_000);
        this.workflowOutstanding = {
          action,
          since: now,
          routineId: null,
          generation: this.generation,
          worldGeneration: this.world.generation,
          map: this.engine.map,
          npcId: receipt.npcId,
          workflow: true,
          sent: true,
          serviceReceipt: receipt,
          ...(this.macroOwner
            ? {
                macro: {
                  id: this.macroOwner.intent.id,
                  generation: this.macroOwner.intent.generation,
                },
              }
            : {}),
        };
        try {
          this.send(action);
        } catch (error) {
          if (!this.macroOwner) throw error;
          this.endMacro('Macro service write is uncertain. No request will be repeated.', true);
          return;
        }
      }
      this.syncWorkflowOwner();
      return;
    }
    if (this.travel.active) {
      const player = this.engine.player;
      if (
        player &&
        (player.dead ||
          !player.maxHp ||
          (player.hp / player.maxHp) * 100 <= (this.travelSettings?.minHpPercent ?? 45))
      ) {
        this.pause('Waiting for HP and a living character before travelling.');
      } else {
        try {
          this.travel.tick(this.engine.map, player);
        } catch (error) {
          if (!this.macroOwner) throw error;
          this.endMacro('Macro travel write is uncertain. No request will be repeated.', true);
          return;
        }
        const state = this.travel.snapshot();
        if (state.state === 'failed') {
          this.waitingReason = state.reason;
          this.retryAt = now + 2_000;
        } else if (state.state === 'complete') {
          this.travelSettings = null;
          this.retryAt = 0;
        }
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
        const actorIdentity = this.worldActionIdentity(action);
        this.workflowOutstanding = {
          ...(actorIdentity ? { actorIdentity } : {}),
          action,
          since: now,
          routineId: this.pending?.routineId ?? null,
          generation: this.generation,
          worldGeneration: this.world.generation,
          map: this.engine.map,
          npcId: this.world.npc.id,
          workflow: true,
          sent: true,
          ...(this.pending?.macro
            ? {
                macro: this.pending.macro,
                workflowReceipt: this.workflow.receipt() ?? undefined,
                workflowAcknowledged: false,
              }
            : {}),
        };
        if (this.pending?.workflow) {
          this.pending.sent = true;
          this.pending.since = now;
        }
        try {
          this.send(action);
        } catch (error) {
          if (!this.macroOwner) throw error;
          this.endMacro('Macro transaction write is uncertain. No request will be repeated.', true);
          return;
        }
      }
      this.syncWorkflowOwner();
    }
    if (this.workflow.snapshot().state === 'complete') this.workflowDeadline = 0;
    if (this.pending?.workflow && !this.workflow.snapshot().running) {
      const state = this.workflow.snapshot();
      this.completePending(state.state === 'complete', state.reason);
    }
    if (
      this.pending &&
      !this.pending.workflow &&
      this.pending.engineSequence === undefined &&
      now - this.pending.since >= 10_000
    )
      this.completePending(false, 'Result not confirmed. No repeat request was sent.');
    if (
      !this.pending &&
      !this.workflow.snapshot().running &&
      now >= this.fencedUntil &&
      this.engine.idleForActions()
    ) {
      const action = this.routine.tick(this.observation());
      if (action) {
        const id = this.routine.snapshot().pendingActionId;
        try {
          this.dispatch(action, id);
        } catch (error) {
          this.routine.acknowledge(false, id!);
          this.engine.reason = error instanceof Error ? error.message : 'Routine action rejected.';
        }
      }
    }
    this.resumeRun();
  }
  private castAvailabilityTick(): void {
    const e = this.engine,
      cast = e.observedCast;
    if (!cast) return;
    // Retained resource and physical clocks run before escape/death early returns.
    e.tick(false);
    this.captureActionFailure();
    this.syncWorkflowOwner();
    const feature = e.pendingFeatureAction;
    const pendingResource =
      this.pending?.engineSequence !== undefined &&
      ['skill', 'useItem'].includes(this.pending.action.type);
    const exclusive =
      !this.warp.blocked &&
      !this.refineBlocksAutomation &&
      !this.partyFollow.ownsTravel &&
      !this.socket.busy &&
      !this.memo.blocked &&
      !this.social.busy &&
      !this.service.active &&
      !this.travel.active &&
      !this.workflow.snapshot().running &&
      !['running', 'waiting'].includes(this.routine.snapshot().state) &&
      (!this.pending || pendingResource) &&
      !this.workflowOutstanding &&
      !this.unresolvedWorld &&
      !this.supply.ownsField &&
      !this.supply.uncertain &&
      !this.escape.sent &&
      !this.deathCycle?.guard.uncertain &&
      !this.deathCycle?.posture &&
      this.world.npc.id === null &&
      this.world.npc.mode === 'idle' &&
      !this.world.vending &&
      this.movementSettled() &&
      e.stationaryForCastAvailability() &&
      (!feature || feature.type === 'skill' || feature.type === 'useItem');
    const ready =
      this.heartbeatHealthy &&
      e.connected &&
      e.compatible &&
      !!e.player &&
      !e.player.dead &&
      e.player.hp > 0 &&
      e.actorActionIdentity() !== null &&
      this.now() >= this.lastFrame &&
      this.now() - this.lastFrame <= 15_000 &&
      this.now() >= this.yieldUntil &&
      this.now() >= this.fencedUntil;
    const action = e.castAvailability.take({
      cast: e.observedCast,
      requested: this.runRequested,
      ready,
      exclusive,
      reason: 'Another command owner stopped automatic stationary cast recovery.',
    });
    if (action)
      try {
        this.transport(action);
      } catch {
        e.castAvailability.cancel(
          'Stationary availability send was uncertain. Waiting for authoritative availability.',
        );
      }
    if (e.observedCast && e.castAvailability.reason) {
      this.waitingReason = e.castAvailability.reason;
      e.reason = this.waitingReason;
    }
  }
  snapshot(): CompanionSnapshot {
    const snapshot = this.engine.snapshot();
    const workflow = this.workflow.snapshot();
    const routine = this.routine.snapshot();
    const macro = this.macro.snapshot();
    const travel = this.travel.snapshot();
    const service = this.service.snapshot();
    const refine = this.refine.snapshot(this.refineContext());
    if (this.refineBlocksAutomation) snapshot.reason = refine.reason;
    else if (this.partyFollow.ownsTravel) snapshot.reason = this.partyFollow.snapshot().reason;
    else if (this.socket.busy) snapshot.reason = this.socket.snapshot(this.socketContext()).reason;
    else if (this.supply.ownsField || this.supply.uncertain)
      snapshot.reason = this.supply.snapshot().reason;
    else if (service.active) snapshot.reason = service.reason;
    else if (this.travel.active || (travel.state === 'complete' && this.travelSettings))
      snapshot.reason = travel.reason;
    else if (workflow.running) snapshot.reason = workflow.reason;
    else if (routine.state === 'running' || routine.state === 'waiting')
      snapshot.reason = routine.reason;
    else if (this.macro.active) snapshot.reason = macro.reason;
    if (this.macro.active && this.waitingReason && !this.engine.running)
      snapshot.reason = this.blockedReason || this.waitingReason;
    const executing =
      !this.updateSuspended &&
      this.executing &&
      (this.warp.busy ||
        refine.state === 'pending' ||
        this.socket.busy ||
        this.memo.busy ||
        this.social.busy ||
        this.engine.running ||
        this.engine.manualTargetActive ||
        service.active ||
        this.travel.active ||
        workflow.running ||
        !!this.pending ||
        this.partyFollow.ownsTravel ||
        this.escape.inFlight ||
        this.macro.active ||
        ['running', 'waiting'].includes(routine.state));
    if (this.runRequested && !executing)
      snapshot.reason = this.blockedReason || this.waitingReason || snapshot.reason;
    if (this.runRequested && this.now() < this.yieldUntil && !this.blockedReason)
      snapshot.reason = this.waitingReason;
    if (snapshot.player?.dead && this.blockedReason) {
      const respawn = automationSettings(this.requestedSettings ?? this.engine.settings).respawn;
      snapshot.reason = `Character is dead. Automatic respawn is ${respawn.enabled ? 'enabled' : 'disabled'}. ${snapshot.reason}`;
    }
    return {
      ...snapshot,
      runExperience: this.runExperience ? { ...this.runExperience } : null,
      running: executing,
      runRequested: this.runRequested,
      initialFieldEntryPending: this.initialFieldEntryPending,
      activeSettings: this.requestedSettings ? structuredClone(this.requestedSettings) : null,
      settingsApply: this.settingsApply ? structuredClone(this.settingsApply) : null,
      liveSettingsGuard: this.liveSettingsProtection(),
      state: executing ? 'running' : this.runRequested ? 'waiting' : 'idle',
      runIntent: this.runRequested,
      elapsedSeconds: this.runRequested
        ? Math.max(0, Math.floor((this.now() - this.started) / 1000))
        : snapshot.elapsedSeconds,
      refine,
      world: this.world.snapshot(),
      workflow,
      routine,
      macro,
      travel,
      service,
      partyFollow: this.partyFollow.snapshot(),
      escape: this.escape.snapshot(),
      supply: this.supply.snapshot(),
      supplyGuard: this.supply.guard(),
      deathRecoveryGuard: this.deathCycle ? deathGuard(this.deathCycle) : undefined,
      social: this.social.snapshot(),
      memo: this.memo.snapshot(this.memoContext()),
      socket: this.socket.snapshot(this.socketContext()),
      warp: this.warp.snapshot(this.warpContext()),
      partyHeal: this.partyHeal.snapshot(),
    };
  }
}

import type { Position } from "./protocol";
import type { Settings } from "./settings";
import type {
  DispositionAction,
  DispositionContext,
  DispositionPolicy,
} from "./disposition";

export interface SupplySettings {
  enabled: boolean;
  stockEnabled: boolean;
  weightEnabled: boolean;
  weightStartPercent: number;
  weightEndPercent: number;
  minimumIntervalSeconds: number;
  maxTrips: number;
  maxActions: number;
  maxDurationSeconds: number;
  maxSpend: number;
  storageService: string;
  buyService: string;
  sellService: string;
}
export const DEFAULT_SUPPLY: SupplySettings = {
  enabled: false,
  stockEnabled: true,
  weightEnabled: false,
  weightStartPercent: 80,
  weightEndPercent: 60,
  minimumIntervalSeconds: 300,
  maxTrips: 1,
  maxActions: 100,
  maxDurationSeconds: 600,
  maxSpend: 0,
  storageService: "",
  buyService: "",
  sellService: "",
};
export interface SupplyGoal {
  itemId: number;
  desired: number;
}
export interface SupplyContext {
  character: string;
  epoch: string;
  map: string;
  position: Position | null;
  connected: boolean;
  alive: boolean;
  loading?: boolean;
  fresh: boolean;
  settled: boolean;
  canPrepare: boolean;
  fieldRequested: boolean;
  inventoryRevision: number;
  currencyRevision: number;
  economicUncertain: boolean;
  disposition: DispositionContext;
}
export type SupplyNext =
  | { type: "service"; contractId: string; fee: number }
  | { type: "action"; action: DispositionAction }
  | { type: "ready" }
  | { type: "close" }
  | { type: "blocked"; reasons: string[] };
export interface SupplyPorts<Receipt> {
  next(
    context: SupplyContext,
    goals: SupplyGoal[],
    policy: DispositionPolicy,
    remainingBudget: number,
  ): SupplyNext;
  confirm(receipt: Receipt, context: SupplyContext): boolean;
}
export type SupplyIntent =
  | { id: number; type: "prepare" }
  | { id: number; type: "service"; contractId: string; reserved: number }
  | { id: number; type: "action"; action: DispositionAction }
  | { id: number; type: "close" }
  | { id: number; type: "return"; map: string; position: Position }
  | { id: number; type: "resume"; settings: Settings };
export type SupplyPhase =
  | "idle"
  | "armed"
  | "preparing"
  | "service"
  | "planning"
  | "confirming"
  | "closing"
  | "returning"
  | "complete"
  | "waiting"
  | "cancelled";
export interface SupplySnapshot {
  state: SupplyPhase;
  active: boolean;
  reason: string;
  uncertain: boolean;
  latched: boolean;
  remainingTrips: number;
  actions: number;
  spent: number;
  reserved: number;
  deadline: number;
  nextTripAt: number;
  goals: SupplyGoal[];
  returnDestination: { map: string; position: Position } | null;
}
/** Config-free memory only. Actor IDs, commands, menus and economic receipts do
 * not cross page reloads; uncertainty instead disarms continuation. */
export interface SupplyResumeGuard {
  version: 1;
  character: string;
  latched: boolean;
  remainingTrips: number;
  actions: number;
  spent: number;
  reserved: number;
  intervalSeconds: number;
  deadlineSeconds: number;
  interrupted: boolean;
  uncertain: boolean;
  returnDestination: { map: string; position: Position } | null;
}
const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= min &&
  value <= max;
function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid supply fields.");
  return value as Record<string, unknown>;
}
export function validateSupplySettings(input: unknown): SupplySettings {
  const value = record(input, Object.keys(DEFAULT_SUPPLY));
  if (
    ["enabled", "stockEnabled", "weightEnabled"].some(
      (key) => typeof value[key] !== "boolean",
    ) ||
    !integer(value.weightStartPercent, 1, 100) ||
    !integer(value.weightEndPercent, 1, 99) ||
    value.weightEndPercent >= value.weightStartPercent ||
    !integer(value.minimumIntervalSeconds, 1, 86400) ||
    !integer(value.maxTrips, 1, 100) ||
    !integer(value.maxActions, 1, 100) ||
    !integer(value.maxDurationSeconds, 30, 3600) ||
    !integer(value.maxSpend, 0, 2_000_000_000) ||
    ["storageService", "buyService", "sellService"].some(
      (key) =>
        typeof value[key] !== "string" ||
        !/^(?:[a-zA-Z0-9_.-]{1,128})?$/.test(value[key] as string),
    ) ||
    (value.enabled && !value.stockEnabled && !value.weightEnabled)
  )
    throw new Error("Invalid supply triggers, limits or service IDs.");
  return structuredClone(value) as unknown as SupplySettings;
}
export function validateSupplyResumeGuard(input: unknown): SupplyResumeGuard {
  const value = record(input, [
    "version",
    "character",
    "latched",
    "remainingTrips",
    "actions",
    "spent",
    "reserved",
    "intervalSeconds",
    "deadlineSeconds",
    "interrupted",
    "uncertain",
    "returnDestination",
  ]);
  if (
    value.version !== 1 ||
    typeof value.character !== "string" ||
    !value.character.trim() ||
    value.character.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(value.character) ||
    ["latched", "interrupted", "uncertain"].some(
      (key) => typeof value[key] !== "boolean",
    ) ||
    !integer(value.remainingTrips, 0, 100) ||
    !integer(value.actions, 0, 100) ||
    !integer(value.spent, 0, 2_000_000_000) ||
    !integer(value.reserved, 0, 2_000_000_000) ||
    !integer(value.intervalSeconds, 0, 86400) ||
    !integer(value.deadlineSeconds, 0, 3600)
  )
    throw new Error("Invalid supply resume state.");
  if (value.returnDestination !== null) {
    const destination = record(value.returnDestination, ["map", "position"]);
    const position = record(destination.position, ["x", "y"]);
    if (
      typeof destination.map !== "string" ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(destination.map) ||
      !integer(position.x, 0, 511) ||
      !integer(position.y, 0, 511)
    )
      throw new Error("Invalid supply return destination.");
  }
  return structuredClone(value) as unknown as SupplyResumeGuard;
}
const count = (context: SupplyContext, id: number) =>
  context.disposition.containers.inventory.items
    ?.filter((item) => item.itemId === id)
    .reduce((sum, item) => sum + item.count, 0) ?? null;

/** Sender-free trip owner. An intention is single-use; the controller must mark
 * economic send before calling its sole transport, including send exceptions. */
export class SupplyTripRuntime<Receipt> {
  private policy: SupplySettings = DEFAULT_SUPPLY;
  private disposition: DispositionPolicy = { maxSpend: 0, rules: [] };
  private settings: Settings | null = null;
  private character = "";
  private epoch = "";
  private phase: SupplyPhase = "idle";
  private reason = "Supply trips are disabled.";
  private remainingTrips = 0;
  private latched = false;
  private nextTripAt = 0;
  private deadline = 0;
  private actions = 0;
  private spent = 0;
  private committed = 0;
  private held = 0;
  private goals: SupplyGoal[] = [];
  private weightGoal = false;
  private destination: SupplySnapshot["returnDestination"] = null;
  private sequence = 0;
  private pending: SupplyIntent | null = null;
  private prepared = false;
  private receipt: {
    value: Receipt;
    sent: boolean;
    cost: number;
    reservation: number;
    inventoryRevision: number;
    currencyRevision: number;
    epoch: string;
    generation: number;
    since: number;
  } | null = null;
  private reloadUncertainty = false;
  private interrupted = false;
  private resumed = false;
  private retained = false;
  constructor(
    private readonly ports: SupplyPorts<Receipt>,
    private readonly now = Date.now,
  ) {}
  get active(): boolean {
    return !["idle", "armed", "complete", "cancelled"].includes(this.phase);
  }
  get ownsField(): boolean {
    return (
      (this.destination !== null ||
        (this.interrupted && this.phase === "waiting")) &&
      this.phase !== "complete" &&
      this.phase !== "idle" &&
      this.phase !== "armed" &&
      this.phase !== "cancelled"
    );
  }
  get uncertain(): boolean {
    return !!this.receipt?.sent || this.reloadUncertainty;
  }
  configure(
    settings: Settings,
    context: SupplyContext,
    guard?: SupplyResumeGuard,
  ): void {
    if (this.uncertain)
      throw new Error(
        "Waiting for the previous supply transaction to reconcile before starting.",
      );
    // Validate every input before replacing retained ownership or allowances.
    const policy = validateSupplySettings(
      settings.automation?.supply ?? DEFAULT_SUPPLY,
    );
    let retainedGuard = guard ? validateSupplyResumeGuard(guard) : undefined;
    if (retainedGuard && retainedGuard.character !== context.character)
      throw new Error("Supply resume state belongs to a different character.");
    const localGuard = this.guard();
    if (localGuard?.character === context.character) {
      // A delayed controller-window publication cannot replenish this owner's
      // allowance. Explicit Start cancels the old continuation after readback.
      retainedGuard = retainedGuard
        ? {
            ...retainedGuard,
            remainingTrips: Math.min(
              retainedGuard.remainingTrips,
              localGuard.remainingTrips,
            ),
            intervalSeconds: Math.max(
              retainedGuard.intervalSeconds,
              localGuard.intervalSeconds,
            ),
            actions: Math.max(retainedGuard.actions, localGuard.actions),
            spent: Math.max(retainedGuard.spent, localGuard.spent),
            reserved: Math.max(retainedGuard.reserved, localGuard.reserved),
            latched: retainedGuard.latched || localGuard.latched,
          }
        : { ...localGuard, interrupted: false, returnDestination: null };
    }
    const copiedSettings = structuredClone(settings);
    const disposition = structuredClone(
      settings.automation?.disposition ?? { maxSpend: 0, rules: [] },
    );
    const previouslyRetained =
      this.retained && this.character === context.character;
    this.receipt = null;
    this.reloadUncertainty = false;
    this.resumed = false;
    this.settings = copiedSettings;
    this.policy = policy;
    this.retained =
      this.policy.enabled || !!retainedGuard || previouslyRetained;
    this.disposition = disposition;
    this.character = context.character;
    this.epoch = context.epoch;
    this.remainingTrips = this.policy.maxTrips;
    this.latched = false;
    this.actions = 0;
    this.spent = 0;
    this.committed = 0;
    this.held = 0;
    this.deadline = 0;
    this.nextTripAt = 0;
    this.pending = null;
    this.prepared = false;
    this.goals = [];
    this.weightGoal = false;
    this.destination = null;
    this.interrupted = false;
    this.phase = this.policy.enabled ? "armed" : "idle";
    this.reason = this.policy.enabled
      ? "Waiting for a verified supply trigger."
      : "Supply trips are disabled.";
    if (retainedGuard) {
      const retained = retainedGuard;
      this.remainingTrips = Math.min(
        this.remainingTrips,
        retained.remainingTrips,
      );
      this.actions = retained.actions;
      this.spent = retained.spent;
      this.committed = retained.reserved;
      this.latched = retained.latched;
      this.goals = this.disposition.rules
        .filter((rule) => rule.restock !== "off")
        .map((rule) => ({ itemId: rule.itemId, desired: rule.desired }));
      this.weightGoal = this.policy.weightEnabled && retained.latched;
      this.nextTripAt = this.now() + retained.intervalSeconds * 1000;
      this.deadline = retained.deadlineSeconds
        ? this.now() + retained.deadlineSeconds * 1000
        : 0;
      this.destination = structuredClone(retained.returnDestination);
      this.reloadUncertainty = retained.uncertain;
      this.interrupted = retained.interrupted;
      if (retained.interrupted || retained.uncertain) {
        this.phase = "waiting";
        this.reason =
          "Supply trip was interrupted. Check the result and return destination before starting a new run.";
      }
    }
  }
  private known(context: SupplyContext): string[] {
    const inventory = context.disposition.containers.inventory;
    const reasons: string[] = [];
    if (!context.connected || !context.fresh)
      reasons.push(
        "Waiting for fresh character, inventory and currency observations.",
      );
    if (!context.alive) reasons.push("Waiting for a living character.");
    if (context.character !== this.character)
      reasons.push("Supply trip belongs to a different character.");
    if (
      !inventory.items ||
      !integer(inventory.weight, 0, 2147483647) ||
      !integer(inventory.maxWeight, 1, 2147483647) ||
      !integer(inventory.slots, 1, 600)
    )
      reasons.push("Verified inventory, weight and capacity are required.");
    if (
      context.disposition.equipment === null ||
      context.disposition.ammoId === null
    )
      reasons.push("Equipment and ammunition are not observed.");
    if (context.economicUncertain || this.uncertain)
      reasons.push(
        "Waiting for the exact economic receipt; no repeat transaction is allowed.",
      );
    return reasons;
  }
  private goalsMet(context: SupplyContext): boolean {
    const inventory = context.disposition.containers.inventory;
    return (
      this.goals.every(
        (goal) => (count(context, goal.itemId) ?? -1) >= goal.desired,
      ) &&
      (!this.weightGoal ||
        (typeof inventory.weight === "number" &&
          typeof inventory.maxWeight === "number" &&
          inventory.maxWeight > 0 &&
          (inventory.weight / inventory.maxWeight) * 100 <
            this.policy.weightEndPercent))
    );
  }
  observe(context: SupplyContext): void {
    if (this.receipt?.sent) {
      if (this.ports.confirm(this.receipt.value, context)) {
        this.spent += this.receipt.cost;
        this.committed += this.receipt.reservation;
        this.held = 0;
        this.receipt = null;
        if (!this.interrupted && this.phase === "confirming") {
          this.pending = null;
          this.phase = "closing";
          this.reason =
            "Transaction confirmed. Closing the service before replanning.";
        }
      } else if (
        (context.epoch !== this.receipt.epoch ||
          context.disposition.workflow.world.generation !==
            this.receipt.generation) &&
        context.character === this.character &&
        context.fresh &&
        context.inventoryRevision > this.receipt.inventoryRevision &&
        context.currencyRevision > this.receipt.currencyRevision
      ) {
        this.committed += this.receipt.reservation;
        this.held = 0;
        this.receipt = null;
        this.interrupted = true;
        this.phase = "waiting";
        this.reason =
          "Context reset with fresh economics; the old transaction outcome remains unknown. Trip continuation is disabled.";
      }
    }
    if (
      this.reloadUncertainty &&
      context.character === this.character &&
      context.fresh &&
      context.inventoryRevision > 0 &&
      context.currencyRevision > 0
    ) {
      this.reloadUncertainty = false;
      this.interrupted = true;
      this.phase = "waiting";
      this.reason =
        "Fresh economics arrived after reload. Check the interrupted trip before starting again.";
    }
    if (
      !this.interrupted &&
      this.ownsField &&
      (context.character !== this.character ||
        (!context.alive && !context.loading) ||
        !context.connected ||
        context.epoch !== this.epoch)
    )
      this.interrupt(
        "Supply trip interrupted by death, character or connection change.",
      );
    if (this.receipt?.sent && this.now() - this.receipt.since >= 10000) {
      this.interrupted = true;
      this.pending = null;
      this.phase = "waiting";
      this.reason =
        "Transaction timed out without an exact receipt. No repeat request will be sent.";
    }
    if (this.ownsField && this.deadline && this.now() >= this.deadline) {
      this.interrupted = true;
      this.pending = null;
      this.phase = "waiting";
      this.reason =
        "Whole-trip duration limit reached; unresolved economics remain owned.";
    }
    if (this.phase === "armed" || this.phase === "complete") {
      if (
        this.latched &&
        (this.phase === "armed" || this.resumed) &&
        this.goalsMet(context)
      ) {
        this.latched = false;
        this.phase = "armed";
      }
    }
  }
  interrupt(reason: string): void {
    if (!this.ownsField && !this.receipt) return;
    this.interrupted = true;
    this.pending = null;
    this.phase = "waiting";
    this.reason = reason;
    if (this.receipt && !this.receipt.sent) {
      this.receipt = null;
      this.held = 0;
    }
  }
  stop(reason = "Supply trip stopped by you."): void {
    this.interrupted = true;
    this.pending = null;
    this.phase = "cancelled";
    this.reason = reason;
    if (this.receipt && !this.receipt.sent) {
      this.receipt = null;
      this.held = 0;
    }
  }
  private intent<T extends Omit<SupplyIntent, "id">>(intent: T): SupplyIntent {
    const next = { ...intent, id: ++this.sequence } as SupplyIntent;
    this.pending = next;
    return structuredClone(next);
  }
  next(context: SupplyContext): SupplyIntent | null {
    this.observe(context);
    if (
      !this.policy.enabled ||
      !context.fieldRequested ||
      this.pending ||
      this.interrupted ||
      this.uncertain
    )
      return null;
    const reasons = this.known(context);
    if (reasons.length) {
      this.reason = reasons.join(" ");
      return null;
    }
    if (this.phase === "armed" || this.phase === "complete") {
      if (
        (this.phase === "complete" && !this.resumed) ||
        this.latched ||
        this.now() < this.nextTripAt ||
        !this.remainingTrips
      )
        return null;
      const low = this.policy.stockEnabled
        ? this.disposition.rules.filter(
            (rule) =>
              rule.restock !== "off" &&
              (count(context, rule.itemId) ?? Infinity) < rule.minimum,
          )
        : [];
      const inventory = context.disposition.containers.inventory;
      const high =
        this.policy.weightEnabled &&
        (inventory.weight! / Number(inventory.maxWeight)) * 100 >=
          this.policy.weightStartPercent;
      if (!low.length && !high) return null;
      if (
        !context.position ||
        !integer(context.position.x, 0, 511) ||
        !integer(context.position.y, 0, 511) ||
        !context.map
      ) {
        this.reason = "A verified return map and work cell are required.";
        return null;
      }
      this.goals = low.map((rule) => ({
        itemId: rule.itemId,
        desired: rule.desired,
      }));
      this.weightGoal = high;
      this.destination = {
        map: context.map,
        position: { ...context.position },
      };
      this.remainingTrips--;
      this.latched = true;
      this.nextTripAt = this.now() + this.policy.minimumIntervalSeconds * 1000;
      this.deadline = this.now() + this.policy.maxDurationSeconds * 1000;
      this.actions = 0;
      this.spent = 0;
      this.committed = 0;
      this.held = 0;
      this.prepared = false;
      this.phase = "preparing";
      this.reason = "Preparing a bounded supply trip.";
    }
    if (this.phase === "preparing") {
      if (!context.canPrepare) {
        this.reason =
          "Waiting for movement, casts and resource actions before supply travel.";
        return null;
      }
      if (!this.prepared) return this.intent({ type: "prepare" });
      if (!context.settled) {
        this.reason = "Waiting for the field movement stop to settle.";
        return null;
      }
      this.phase = "planning";
    }
    if (this.phase === "planning") {
      if (!context.settled) {
        this.reason = "Waiting for the previous movement or service action.";
        return null;
      }
      const remaining = Math.max(
        0,
        this.policy.maxSpend - this.committed - this.held,
      );
      const policy = structuredClone(this.disposition);
      policy.maxSpend = Math.min(policy.maxSpend, remaining);
      for (const goal of this.goals) {
        const rule = policy.rules.find((rule) => rule.itemId === goal.itemId);
        if (rule) {
          rule.minimum = goal.desired;
          rule.desired = goal.desired;
        }
      }
      const next = this.ports.next(
        context,
        structuredClone(this.goals),
        policy,
        remaining,
      );
      if (next.type === "blocked") {
        this.phase = "waiting";
        this.reason = next.reasons.join(" ");
        return null;
      }
      if (next.type === "close") {
        this.phase = "closing";
        return this.intent({ type: "close" });
      }
      if (next.type === "ready") {
        if (!this.goalsMet(context)) {
          this.phase = "waiting";
          this.reason =
            "The service plan is empty but captured stock or weight goals are not met.";
          return null;
        }
        this.phase = "closing";
        return this.intent({ type: "close" });
      }
      if (next.type === "service") {
        if (context.disposition.workflow.world.npc.id !== null) {
          this.phase = "closing";
          return this.intent({ type: "close" });
        }
        if (
          !integer(next.fee, 0, 2000000000) ||
          next.fee > remaining ||
          next.fee > context.disposition.workflow.zeny
        ) {
          this.phase = "waiting";
          this.reason =
            "Service fee exceeds the remaining trip budget or observed zeny.";
          return null;
        }
        this.held = next.fee;
        this.phase = "service";
        return this.intent({
          type: "service",
          contractId: next.contractId,
          reserved: next.fee,
        });
      }
      if (
        next.action.reservedSpend > remaining ||
        next.action.reservedSpend > context.disposition.workflow.zeny
      ) {
        this.phase = "waiting";
        this.reason =
          "Transaction exceeds the remaining trip budget or observed zeny.";
        return null;
      }
      this.held = next.action.reservedSpend;
      return this.intent({ type: "action", action: next.action });
    }
    if (this.phase === "closing") return this.intent({ type: "close" });
    if (this.phase === "returning" && this.destination)
      return this.intent({ type: "return", ...this.destination });
    return null;
  }
  accepts(id: number): boolean {
    return this.pending?.id === id && !this.interrupted;
  }
  commandAllowed(): boolean {
    if (!this.ownsField) return true;
    if (
      this.interrupted ||
      this.actions >= this.policy.maxActions ||
      this.now() >= this.deadline
    ) {
      this.interrupt("Supply command or duration allowance exhausted.");
      return false;
    }
    this.actions++;
    return true;
  }
  attachReceipt(id: number, value: Receipt, context: SupplyContext): void {
    if (!this.accepts(id) || this.pending?.type !== "action")
      throw new Error("Supply action is no longer owned.");
    this.receipt = {
      value,
      sent: false,
      cost: this.pending.action.estimatedCost,
      reservation: this.pending.action.reservedSpend,
      inventoryRevision: context.inventoryRevision,
      currencyRevision: context.currencyRevision,
      epoch: context.epoch,
      generation: context.disposition.workflow.world.generation,
      since: this.now(),
    };
  }
  markSent(id: number): void {
    if (!this.accepts(id) || !this.receipt)
      throw new Error(
        "An exact supply receipt must be captured before sending.",
      );
    this.receipt.sent = true;
    this.receipt.since = this.now();
    this.phase = "confirming";
    this.reason = "Waiting for the exact transaction receipt.";
  }
  acknowledge(
    id: number,
    result: "confirmed" | "failed",
    context: SupplyContext,
    spent = 0,
  ): void {
    const intent = this.pending;
    if (!intent || intent.id !== id || this.interrupted) return;
    if (result === "failed") {
      this.interrupt(
        "Supply stage failed; no automatic repeat or field resume.",
      );
      return;
    }
    if (intent.type === "prepare") {
      this.prepared = true;
      this.pending = null;
      return;
    }
    if (intent.type === "service") {
      if (!integer(spent, 0, intent.reserved)) {
        this.interrupt(
          "Service economics did not match the reserved opening fee.",
        );
        return;
      }
      this.spent += spent;
      this.committed += intent.reserved;
      this.held = 0;
      this.pending = null;
      this.phase = "planning";
      return;
    }
    if (intent.type === "close") {
      if (
        context.disposition.workflow.world.npc.id !== null ||
        context.disposition.workflow.world.npc.mode !== "idle"
      ) {
        this.reason = "Waiting for confirmed NPC closure.";
        return;
      }
      this.pending = null;
      this.phase = this.goalsMet(context) ? "returning" : "planning";
      this.reason = this.phase === "returning"
        ? "Returning to the captured map and work cell."
        : "Service closed. Replanning the remaining supply goals.";
      return;
    }
    if (intent.type === "return") {
      if (
        context.map !== intent.map ||
        !context.position ||
        context.position.x !== intent.position.x ||
        context.position.y !== intent.position.y ||
        !context.settled
      ) {
        this.reason = "Waiting for the captured return map and work cell.";
        return;
      }
      if (!this.goalsMet(context)) {
        this.interrupt("Captured stock or weight goals changed before return.");
        return;
      }
      this.pending = null;
      this.phase = "complete";
      this.reason = "Supply goals and return destination confirmed.";
      return;
    }
    if (intent.type === "resume") {
      this.pending = null;
      this.phase = "complete";
      this.resumed = true;
      this.latched = false;
    }
  }
  resumeIntent(context: SupplyContext): SupplyIntent | null {
    if (
      this.resumed ||
      this.phase !== "complete" ||
      this.pending ||
      this.interrupted ||
      !this.settings ||
      !this.destination ||
      context.character !== this.character ||
      !this.goalsMet(context) ||
      context.map !== this.destination.map ||
      !context.position ||
      context.position.x !== this.destination.position.x ||
      context.position.y !== this.destination.position.y ||
      !context.settled
    )
      return null;
    return this.intent({
      type: "resume",
      settings: structuredClone(this.settings),
    });
  }
  guard(): SupplyResumeGuard | undefined {
    if (!this.retained) return undefined;
    return {
      version: 1,
      character: this.character,
      latched: this.latched,
      remainingTrips: this.remainingTrips,
      actions: this.actions,
      spent: this.spent,
      reserved: this.committed + this.held,
      intervalSeconds: Math.min(
        86400,
        Math.max(0, Math.ceil((this.nextTripAt - this.now()) / 1000)),
      ),
      deadlineSeconds: Math.min(
        3600,
        Math.max(0, Math.ceil((this.deadline - this.now()) / 1000)),
      ),
      interrupted: this.interrupted || this.ownsField,
      uncertain: this.uncertain,
      returnDestination: structuredClone(this.destination),
    };
  }
  snapshot(): SupplySnapshot {
    return {
      state: this.phase,
      active: this.active,
      reason: this.reason,
      uncertain: this.uncertain,
      latched: this.latched,
      remainingTrips: this.remainingTrips,
      actions: this.actions,
      spent: this.spent,
      reserved: this.committed + this.held,
      deadline: this.deadline,
      nextTripAt: this.nextTripAt,
      goals: structuredClone(this.goals),
      returnDestination: structuredClone(this.destination),
    };
  }
}

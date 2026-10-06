import { quantity, type ItemId } from './domain-values';
import { inventoryItemCount } from './character-state-logic';
import { sort } from 'remeda';
import { insideLockArea, mapAllowed, mapPolicy, policySummary } from './map-policy-logic';
import { planDisposition, VALIDATED_DEFAULT_DISPOSITION, type DispositionPolicyView, type DispositionRuleView } from './disposition';
import { serviceByContractId } from './npc-services-logic';
import { DEFAULT_SUPPLY, validateSupplySettings } from './supply-trip-logic';
import type { SupplyContext, SupplyGoal, SupplyNext, SupplySettings, SupplyPolicySettings } from './supply-trip-logic';

// Planning/display does not capture or confirm resource revision evidence.
export type SupplyPlanningContext = Omit<SupplyContext,'inventoryRevision'|'currencyRevision'> & {readonly inventoryRevision?:number;readonly currencyRevision?:number};

/** One authoritative phase only. Other service prerequisites cannot invalidate
 * this phase, and no unknown preferred destination authorizes a fallback sale. */
export interface SupplyPhaseEvidence {
  storageFull: { character: string; epoch: string; revision: string } | null;
}
export function nextSupplyAction(
  context: SupplyPlanningContext,
  goals: readonly SupplyGoal[],
  policy: DispositionPolicyView,
  supply: SupplySettings,
  evidence: SupplyPhaseEvidence = { storageFull: null },
): SupplyNext {
  const c = context.disposition,
    world = c.workflow.world;
  const carried = (id: ItemId) =>
    inventoryItemCount(id)(c.containers.inventory.items ?? []);
  const floor = (rule: DispositionRuleView) =>
    Math.max(
      rule.maximum,
      rule.keep,
      ...(c.minimumStock
        ?.filter((row) => row.itemId === rule.itemId)
        .map((row) => row.count) ?? []),
    );
  const rules = sort(policy.rules, (a, b) => a.itemId - b.itemId);
  // Dispose before receiving new stock, so capacity is based on confirmed data.
  const target =
    rules.find(
      (rule) =>
        (rule.store || rule.cart || rule.sell) &&
        carried(rule.itemId) > floor(rule),
    ) ??
    rules.find((rule) =>
      goals.some(
        (goal) =>
          goal.itemId === rule.itemId && carried(rule.itemId) < goal.desired,
      ),
    );
  if (!target) return { type: "ready" };
  const rule = { ...target };
  const service = (
    id: string,
    expected: "storage" | "buy" | "sell",
  ): SupplyNext => {
    const definition = serviceByContractId(id);
    if (
      !definition ||
      (expected === "storage"
        ? definition.outcome.type !== "storageOpened"
        : definition.outcome.type !== "shopOpened" ||
          definition.outcome.mode !== expected)
    )
      return {
        type: "blocked",
        reasons: [`A verified ${expected} service must be selected.`],
      };
    return {
      type: "service",
      contractId: definition.contractId,
      fee: definition.workflow.steps.reduce(
        (sum, step) =>
          sum + ("expectedCost" in step ? (step.expectedCost ?? 0) : 0),
        0,
      ),
    };
  };
  if (carried(rule.itemId) > floor(rule)) {
    const full = evidence.storageFull;
    if (
      rule.store &&
      full &&
      full.character === context.character &&
      full.epoch === context.epoch &&
      (c.containers.storage.items === null ||
        (c.containers.storage.slots !== null &&
          c.containers.storage.items.length >= c.containers.storage.slots))
    )
      rule.store = false;
    if (rule.store) {
      if (world.npc.mode !== "storage" || !world.storageReady)
        return service(supply.storageService, "storage");
      // The pinned handler rejects a full destination even when a stack exists.
      if (
        c.containers.storage.items !== null &&
        c.containers.storage.slots !== null &&
        c.containers.storage.items.length >= c.containers.storage.slots
      )
        rule.store = false;
    }
    if (!rule.store && rule.cart) {
      const cart = c.containers.cart;
      if (
        cart.items === null ||
        cart.slots === null ||
        cart.weight === null ||
        typeof cart.maxWeight !== "number"
      )
        return {
          type: "blocked",
          reasons: ["Preferred cart stock, weight or capacity is unknown."],
        };
      const weight = c.metadata[rule.itemId]?.weight;
      if (
        cart.items.length >= cart.slots ||
        (weight !== null &&
          weight !== undefined &&
          cart.weight + weight > cart.maxWeight)
      )
        rule.cart = false;
    }
    if (
      !rule.store &&
      !rule.cart &&
      rule.sell &&
      (world.npc.mode !== "shop" || world.shop?.mode !== "sell")
    )
      return service(supply.sellService, "sell");
  } else {
    if (
      rule.restock === "storage" &&
      (world.npc.mode !== "storage" || !world.storageReady)
    )
      return service(supply.storageService, "storage");
    if (
      rule.restock === "buy" &&
      (world.npc.mode !== "shop" || world.shop?.mode !== "buy")
    )
      return service(supply.buyService, "buy");
  }
  if (
    !rule.store &&
    rule.cart &&
    carried(rule.itemId) > floor(rule) &&
    world.npc.id !== null
  )
    return { type: "close" };
  const plan = planDisposition({ ...policy, rules: [rule] }, c);
  const action = plan.actions[0];
  // A partial, safely quoted first action is valid; the captured desired goal
  // remains immutable and is replanned after this exact receipt, never projected.
  if (action) return { type: "action", action };
  return {
    type: "blocked",
    reasons: plan.blocked.length
      ? plan.blocked
      : ["No permitted action can satisfy the captured supply goal."],
  };
}

/** Sender-free explanation of triggers, captured goals and the next service.
 * Unknown prices/capacity remain prerequisites; this is never an execution token. */
export function previewSupplyTrip(
  settings: SupplyPolicySettings,
  context: SupplyPlanningContext,
): string {
  const supply = validateSupplySettings(
      settings.automation?.supply ?? DEFAULT_SUPPLY,
    ),
    policy = settings.automation?.disposition ?? VALIDATED_DEFAULT_DISPOSITION;
  const executionPolicy=mapPolicy(settings);
  if(context.position&&(!mapAllowed(executionPolicy,context.map)||!insideLockArea(executionPolicy,context.map,context.position)))return 'Supply waits until the allowed field lock area has been entered. '+policySummary(executionPolicy,context.map);
  const inventory = context.disposition.containers.inventory;
  if (!supply.enabled) return "Supply trips are off. No trip will start.";
  if (
    !inventory.items ||
    inventory.weight === null ||
    typeof inventory.maxWeight !== "number" ||
    inventory.maxWeight <= 0 ||
    inventory.slots === null
  )
    return "Waiting for observed stock, weight and capacity.";
  const stock = (id: ItemId) =>
    inventoryItemCount(id)(inventory.items!);
  const goals = supply.stockEnabled
    ? policy.rules
        .filter(
          (rule) => rule.restock !== "off" && stock(rule.itemId) < rule.minimum,
        )
        .map((rule) => ({ itemId: rule.itemId, desired: rule.desired }))
    : [];
  const weight =
    supply.weightEnabled &&
    (inventory.weight / inventory.maxWeight) * 100 >= supply.weightStartPercent;
  if (!goals.length && !weight) return "No stock or weight trigger is active.";
  const next = nextSupplyAction(
    context,
    goals,
    {
      ...policy,
      maxSpend: quantity(Math.min(policy.maxSpend, supply.maxSpend)),
      rules: policy.rules.map((rule) =>
        goals.some((goal) => goal.itemId === rule.itemId)
          ? { ...rule, minimum: rule.desired }
          : rule,
      ),
    },
    supply,
  );
  return [
    `Preview only · ${goals.length} stock goals${weight ? " · weight trigger" : ""}`,
    ...goals.map(
      (goal) => `Item #${goal.itemId}: ${stock(goal.itemId)} → ${goal.desired}`,
    ),
    `Return: ${context.map || "unknown map"} (${context.position?.x ?? "?"}, ${context.position?.y ?? "?"})`,
    `Limits: ${supply.maxTrips} trips · ${supply.maxActions} commands/trip · ${supply.maxDurationSeconds}s · ${supply.maxSpend}z reserved cap`,
    next.type === "service"
      ? `Next verified service: ${next.contractId}`
      : next.type === "action"
        ? `Next guarded action: ${next.action.kind} item #${next.action.itemId} × ${next.action.count}`
        : next.type === "blocked"
          ? `Waiting: ${next.reasons.join(" ")}`
          : "Captured goals require fresh observations before returning.",
    "No commands sent. Each transaction needs fresh revalidation and an exact receipt.",
  ].join("\n");
}

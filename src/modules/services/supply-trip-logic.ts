import type { Revision, ItemId, Quantity } from '../../shared/domain-values';
import { inventoryItemCount } from '../world/character-state-logic';
import type { Position } from '../protocol/protocol';
import type { SettingsInput as Settings, AutomationSettingsInput } from '../settings/settings';
import type {
  DispositionAction,
  DispositionContext,
  DispositionPolicyView,
  ValidatedDispositionPolicy,
} from './disposition';
export interface SupplySettings {
  enabled: boolean;
  stockEnabled: boolean;
  weightEnabled: boolean;
  sellAllPermitted: boolean;
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
  merchantMode?: 'manual' | 'automatic';
  transport?: 'travel' | 'butterfly' | 'returnSkill';
  saveMap?: string;
  returnMinStock?: number;
}

export const DEFAULT_SUPPLY: SupplySettings = {
  enabled: false,
  stockEnabled: true,
  weightEnabled: false,
  sellAllPermitted: false,
  weightStartPercent: 80,
  weightEndPercent: 60,
  minimumIntervalSeconds: 300,
  maxTrips: 1,
  maxActions: 100,
  maxDurationSeconds: 600,
  maxSpend: 0,
  storageService: '',
  buyService: '',
  sellService: '',
  merchantMode: 'manual',
  transport: 'travel',
  saveMap: '',
  returnMinStock: 1,
};

export interface SupplyGoal {
  readonly itemId: ItemId;
  readonly desired: Quantity;
}
/** Supply validates its own limits; disposition has already passed settings admission. */
export type SupplyPolicySettings = Omit<Settings, 'automation'> & {
  readonly automation?: Omit<AutomationSettingsInput, 'disposition'> & {
    readonly disposition?: ValidatedDispositionPolicy;
  };
};

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
  inventoryRevision: Revision<'inventory'>;
  currencyRevision: Revision<'currency'>;
  economicUncertain: boolean;
  disposition: DispositionContext;
  merchant?: { contractId: string | null; reason: string; preview: string };
}

export type SupplyNext =
  | { type: 'service'; contractId: string; fee: number }
  | { type: 'action'; action: DispositionAction }
  | { type: 'ready' }
  | { type: 'close' }
  | { type: 'blocked'; reasons: string[] };

export interface SupplyPorts<Receipt> {
  next(
    context: SupplyContext,
    goals: readonly SupplyGoal[],
    policy: DispositionPolicyView,
    remainingBudget: number,
  ): SupplyNext;
  confirm(receipt: Receipt, context: SupplyContext): boolean;
}

export type SupplyIntent =
  | { id: number; type: 'prepare' }
  | { id: number; type: 'saveReturn'; map: string; method: 'item' | 'skill'; minStock: number }
  | { id: number; type: 'service'; contractId: string; reserved: number }
  | { id: number; type: 'action'; action: DispositionAction }
  | { id: number; type: 'close' }
  | { id: number; type: 'return'; map: string; position: Position }
  | { id: number; type: 'resume'; settings: Settings };

export type SupplyPhase =
  | 'idle'
  | 'armed'
  | 'preparing'
  | 'departing'
  | 'service'
  | 'planning'
  | 'confirming'
  | 'closing'
  | 'returning'
  | 'complete'
  | 'waiting'
  | 'cancelled';

export interface SupplySnapshot {
  state: SupplyPhase;
  active: boolean;
  reason: string;
  uncertain: boolean;
  latched: boolean;
  remainingTrips: number;
  tripSequence?: number;
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
  tripSequence?: number;
  actions: number;
  spent: number;
  reserved: number;
  intervalSeconds: number;
  deadlineSeconds: number;
  interrupted: boolean;
  uncertain: boolean;
  returnDestination: { map: string; position: Position } | null;
}

export const integer = (value: unknown, min: number, max: number): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max;

function record(value: unknown, keys: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid supply fields.');
  return value as Record<string, unknown>;
}

export function validateSupplySettings(input: unknown): SupplySettings {
  if (!input || typeof input !== 'object' || Array.isArray(input))
    throw new Error('Invalid supply fields.');
  const value = record(
    {
      sellAllPermitted: false,
      merchantMode: 'manual',
      transport: 'travel',
      saveMap: '',
      returnMinStock: 1,
      ...input,
    },
    Object.keys(DEFAULT_SUPPLY),
  );
  if (
    ['enabled', 'stockEnabled', 'weightEnabled', 'sellAllPermitted'].some(
      (key) => typeof value[key] !== 'boolean',
    ) ||
    !integer(value.weightStartPercent, 1, 100) ||
    !integer(value.weightEndPercent, 1, 99) ||
    value.weightEndPercent >= value.weightStartPercent ||
    !integer(value.minimumIntervalSeconds, 1, 86400) ||
    !integer(value.maxTrips, 0, 100) ||
    !integer(value.maxActions, 1, 1000) ||
    !integer(value.maxDurationSeconds, 30, 3600) ||
    !integer(value.maxSpend, 0, 2_000_000_000) ||
    ['storageService', 'buyService', 'sellService'].some(
      (key) =>
        typeof value[key] !== 'string' ||
        !/^(?:[a-zA-Z0-9_.-]{1,128})?$/.test(value[key] as string),
    ) ||
    !['manual', 'automatic'].includes(value.merchantMode as string) ||
    !['travel', 'butterfly', 'returnSkill'].includes(value.transport as string) ||
    typeof value.saveMap !== 'string' ||
    !/^(?:[a-zA-Z0-9_-]{1,64})?$/.test(value.saveMap) ||
    !integer(value.returnMinStock, 0, 9999) ||
    (value.enabled && value.transport !== 'travel' && !value.saveMap) ||
    (value.enabled && !value.stockEnabled && !value.weightEnabled)
  )
    throw new Error('Invalid supply triggers, limits or service IDs.');
  return structuredClone(value) as unknown as SupplySettings;
}

export function validateSupplyResumeGuard(input: unknown): SupplyResumeGuard {
  const value = record(
    {
      tripSequence: 0,
      ...(input && typeof input === 'object' && !Array.isArray(input) ? input : {}),
    },
    [
      'version',
      'tripSequence',
      'character',
      'latched',
      'remainingTrips',
      'actions',
      'spent',
      'reserved',
      'intervalSeconds',
      'deadlineSeconds',
      'interrupted',
      'uncertain',
      'returnDestination',
    ],
  );
  if (
    value.version !== 1 ||
    typeof value.character !== 'string' ||
    !value.character.trim() ||
    value.character.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(value.character) ||
    ['latched', 'interrupted', 'uncertain'].some((key) => typeof value[key] !== 'boolean') ||
    !integer(value.remainingTrips, -1, 100) ||
    !integer(value.tripSequence, 0, Number.MAX_SAFE_INTEGER) ||
    !integer(value.actions, 0, 1000) ||
    !integer(value.spent, 0, 2_000_000_000) ||
    !integer(value.reserved, 0, 2_000_000_000) ||
    !integer(value.intervalSeconds, 0, 86400) ||
    !integer(value.deadlineSeconds, 0, 3600)
  )
    throw new Error('Invalid supply resume state.');
  if (value.returnDestination !== null) {
    const destination = record(value.returnDestination, ['map', 'position']);
    const position = record(destination.position, ['x', 'y']);
    if (
      typeof destination.map !== 'string' ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(destination.map) ||
      !integer(position.x, 0, 511) ||
      !integer(position.y, 0, 511)
    )
      throw new Error('Invalid supply return destination.');
  }
  return structuredClone(value) as unknown as SupplyResumeGuard;
}

export const count = (context: SupplyContext, id: ItemId) =>
  context.disposition.containers.inventory.items == null
    ? null
    : inventoryItemCount(id)(context.disposition.containers.inventory.items);

/** Settings use zero for unlimited; retained guards reserve zero for exhausted. */
export const supplyTripAllowance = (maxTrips: number): number => (maxTrips === 0 ? -1 : maxTrips);
/** Meet retained allowances without treating the unlimited sentinel as exhausted. */
export const meetSupplyTripAllowance = (left: number, right: number): number =>
  left === -1 ? right : right === -1 ? left : Math.min(left, right);
export const chargeSupplyTrip = (remaining: number): number =>
  remaining === -1 ? -1 : Math.max(0, remaining - 1);
export function supplyTripCapacityText(
  maxTrips: number,
  retained: number | null | undefined,
): string {
  const configured = maxTrips === 0 ? 'unlimited' : String(maxTrips);
  if (typeof retained !== 'number' || !integer(retained, -1, 100))
    return `retained trip capacity unobserved (configured cap ${configured})`;
  const remaining = meetSupplyTripAllowance(supplyTripAllowance(maxTrips), retained);
  return remaining === -1
    ? 'Unlimited supply trips'
    : `${remaining} trips remaining (configured cap ${configured})`;
}

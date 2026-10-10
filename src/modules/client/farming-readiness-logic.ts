import {
  meetSupplyTripAllowance,
  supplyTripAllowance,
  supplyTripCapacityText,
} from '../services/supply-trip-logic';
import type { SettingsInput } from '../settings/settings';
import { DEFAULT_SUPPLY } from '../services/supply-trip-logic';
import { serviceByContractId } from '../services/npc-services-logic';
import { recoveryInventory } from '../recovery/recovery-item-ui-logic';
import { recoveryItemIds, recoveryItemReserve } from '../recovery/recovery-items';

export type ReadinessAction = 'limits' | 'recovery' | 'supply' | 'account';
export interface ReadinessRow {
  readonly id: string;
  readonly severity: 'info' | 'warning' | 'error';
  readonly title: string;
  readonly detail: string;
  readonly action: ReadinessAction;
}
export interface FarmingReadinessContext {
  readonly active: boolean;
  readonly fresh: boolean;
  readonly used?: {
    readonly elapsedSeconds: number;
    readonly kills: number;
    readonly pickups: number;
    readonly deaths: number;
  };
  readonly remainingSupplyTrips: number | null;
  readonly reconnectEnabled: boolean;
  readonly reconnectAvailable: boolean;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const number = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;

export function respawnAllowanceSummary(
  respawn: NonNullable<SettingsInput['automation']>['respawn'] | undefined,
  deaths?: number,
): string {
  if (!respawn?.enabled) return 'Respawn off';
  const allowance = `${respawn.maxDeaths} deaths${respawn.maxDeaths === 0 ? ' (legacy: no counted death allowance)' : ''}`;
  return `Respawn on · ${allowance}${deaths === undefined ? '' : ` · ${Math.max(0, respawn.maxDeaths - deaths)} remaining`}`;
}

/** Display-only review of existing settings and retained allowances. No action ports. */
export function farmingReadiness(
  settings: SettingsInput | null,
  value: unknown,
  context: FarmingReadinessContext,
): readonly ReadinessRow[] {
  const a = settings?.automation;
  if (!a) return [];
  const rows: ReadinessRow[] = [];
  const add = (
    id: string,
    title: string,
    detail: string,
    action: ReadinessAction,
    severity: ReadinessRow['severity'] = 'info',
  ) => rows.push({ id, title, detail, action, severity });
  const used = context.active ? context.used : undefined;
  const limit = (cap: number, spent: number | undefined, unit: string) =>
    cap === 0
      ? `${unit} unlimited`
      : `${cap} ${unit}${spent === undefined ? '' : ` (${Math.max(0, cap - spent)} remaining)`}`;
  add(
    'limits',
    context.active ? 'Active run limits' : 'Next Start limits',
    `${limit(a.limits.minutes, used ? Math.floor(used.elapsedSeconds / 60) : undefined, 'minutes')} · ${limit(a.limits.kills, used?.kills, 'kills')} · ${limit(a.limits.pickups, used?.pickups, 'pickups')} · hard weight wait ${a.limits.weightPercent ? `${a.limits.weightPercent}%` : 'off (0)'}. Zero time/kills/pickups means unlimited; death and supply allowances stay finite.`,
    'limits',
  );
  const remainingDeaths = Math.max(0, a.respawn.maxDeaths - (used?.deaths ?? 0));
  add(
    'respawn',
    a.respawn.enabled && remainingDeaths === 0
      ? 'Automatic respawn has no counted death allowance'
      : 'Death recovery',
    `${respawnAllowanceSummary(a.respawn, used?.deaths)}. ${a.travel.returnToLockMap ? `Return to farming map ${settings.map || '(choose a field)'} after confirmed revival.` : 'Automatic return to the farming field is off.'}${a.respawn.enabled && remainingDeaths === 0 ? ' Review Recovery and choose an explicit allowance; unlimited session limits do not grant revivals. Starting while already dead can still use the existing one-attempt revival policy.' : ''}`,
    'recovery',
    a.respawn.enabled && remainingDeaths === 0 ? 'warning' : 'info',
  );
  const status = record(value),
    character = record(status.character),
    stock: ReadonlyMap<number, number> | null =
      context.fresh && status.connected === true ? recoveryInventory(character) : null;
  for (const resource of ['hp', 'sp'] as const) {
    const policy = resource === 'hp' ? a.hpPotions : a.spPotions,
      rules = a.items.filter((rule) => rule.resource === resource),
      ids = recoveryItemIds(policy, resource);
    const measurement = record(resource === 'hp' ? status.player : character.stats),
      current = number(measurement[resource]),
      maximum = number(measurement[resource === 'hp' ? 'maxHp' : 'maxSp']),
      observed =
        context.fresh &&
        status.connected === true &&
        current !== null &&
        maximum !== null &&
        maximum > 0;
    const enabled = ids.length > 0 || rules.length > 0;
    const reserves = [
      ...(policy && policy.mode !== 'off'
        ? [
            `${policy.mode === 'any' ? 'any carried' : `${ids.length} selected`} below ${policy.belowPercent}%; reserve at least ${policy.minStock} per item (shared HP/SP reserves apply)`,
          ]
        : []),
      ...rules.map((rule) => `#${rule.itemId} reserve ${rule.minStock}`),
    ];
    const usable =
      stock === null
        ? null
        : rules.some((rule) => (stock.get(rule.itemId) ?? 0) > rule.minStock) ||
          ids.some((id) => {
            const reserve = recoveryItemReserve(a, resource, id);
            return reserve !== null && (stock.get(id) ?? 0) > reserve;
          });
    add(
      resource,
      `${resource.toUpperCase()} recovery`,
      `${enabled ? `${reserves.join(' + ')} · ${usable === null ? 'usable stock unobserved' : usable ? 'usable stock observed above protected reserves' : 'no usable stock above protected reserves'}${observed ? '' : ` · ${resource.toUpperCase()} unobserved`}` : 'Items off'} · sitting ${a.recovery.enabled ? 'on' : 'off'}. Stock and server confirmation determine continued recovery.`,
      'recovery',
      enabled && (usable !== true || !observed) ? 'warning' : 'info',
    );
  }
  if (a.recovery.enabled) {
    const player = record(status.player);
    const basic = Array.isArray(character.learned)
      ? character.learned.find((skill) => record(skill).skillId === 1)
      : undefined;
    const unavailable =
      player.classId === 0 &&
      (character.skillsKnown !== true || Number(record(basic).level ?? 0) < 2);
    add(
      'sitting',
      'Sitting recovery',
      `Rest below HP ${a.recovery.hpStart}%${a.recovery.spStart ? ` or SP ${a.recovery.spStart}%` : ''}; wait at most ${a.recovery.timeoutSeconds}s.${unavailable ? ' Novice Basic Mastery level 2 is required and has not been verified.' : ' HP/SP observation and the learned sitting prerequisites must be available.'}`,
      'recovery',
      unavailable ? 'warning' : 'info',
    );
  }
  const supply = a.supply ?? DEFAULT_SUPPLY;
  if (!supply.enabled) {
    add(
      'supply',
      'Auto sell & refill off',
      'Carried supplies and inventory space are finite. Enabling economic operations is an explicit setup choice.',
      'supply',
    );
  } else {
    const retained = context.remainingSupplyTrips,
      remaining =
        retained === null
          ? null
          : meetSupplyTripAllowance(supplyTripAllowance(supply.maxTrips), retained);
    add(
      'supply',
      remaining === 0 ? 'Supply trip allowance exhausted' : 'Supply trip capacity',
      `${retained === null ? `Retained capacity unobserved; configured cap ${supply.maxTrips === 0 ? 'unlimited' : supply.maxTrips}` : supplyTripCapacityText(supply.maxTrips, retained)}. Stop/Start and unlimited time do not replenish spent trips. ${supply.maxActions} commands/trip · ${supply.maxDurationSeconds}s/trip · ${supply.maxSpend}z spend cap.`,
      'supply',
      remaining === 0 ? 'error' : 'info',
    );
    const rules = a.disposition?.rules ?? [];
    if (supply.weightEnabled) {
      add(
        'selling',
        'Auto sell',
        `At ${supply.weightStartPercent}% → below ${supply.weightEndPercent}%. Only explicitly permitted excess is sold; protected and recovery/return reserves remain retained.${supply.sellAllPermitted ? ' Each visit sells all permitted excess before returning.' : ''}`,
        'supply',
      );
      if (!rules.some((rule) => rule.sell))
        add(
          'sales',
          'Auto sell needs permitted sale items',
          'Choose Allow Sell excess and retained quantities for the items you intend to sell. Unlisted items remain retained.',
          'supply',
          'error',
        );
      const hard = a.limits.weightPercent;
      if (hard > 0)
        add(
          'weight',
          supply.weightStartPercent >= hard
            ? 'Hard weight wait prevents auto-sell departure'
            : 'Weight jump can stop departure',
          supply.weightStartPercent >= hard
            ? `Selling triggers at ${supply.weightStartPercent}%, but the hard wait applies at ${hard}%. Choose a lower sell trigger or explicitly change the hard wait.`
            : `Sell trigger ${supply.weightStartPercent}% precedes hard wait ${hard}%. A pickup jumping directly to ${hard}% still stops departure.`,
          'limits',
          supply.weightStartPercent >= hard ? 'error' : 'info',
        );
      const stats = record(character.stats),
        weight = number(stats.weight),
        maxWeight = number(stats.maxWeight);
      if (
        context.fresh &&
        status.connected === true &&
        hard > 0 &&
        weight !== null &&
        maxWeight !== null &&
        maxWeight > 0 &&
        (weight / maxWeight) * 100 >= hard
      )
        add(
          'current-weight',
          'Current weight prevents supply departure',
          `Observed weight is at or above the ${hard}% hard wait. The supply owner will not depart at this weight.`,
          'limits',
          'error',
        );
    }
    const service = (kind: 'sell' | 'buy' | 'storage', id: string) => {
      const definition = serviceByContractId(id);
      const valid =
        definition &&
        (kind === 'storage'
          ? definition.outcome.type === 'storageOpened'
          : definition.outcome.type === 'shopOpened' && definition.outcome.mode === kind);
      if (!valid)
        add(
          `service-${kind}`,
          `Choose a verified ${kind} service`,
          `The enabled ${kind} operation needs a matching verified service in Loot & supplies.`,
          'supply',
          'error',
        );
      return definition?.map ?? '';
    };
    const merchantMap =
      rules.some((rule) => rule.sell) && supply.merchantMode !== 'automatic'
        ? service('sell', supply.sellService)
        : '';
    // A triggered trip disposes permitted excess before receiving stock. These
    // paths also run on stock-triggered trips; storage/cart can fall back to a
    // permitted sale when the preferred destination is full.
    if (
      rules.some((rule) => rule.store) ||
      (supply.stockEnabled && rules.some((rule) => rule.restock === 'storage'))
    )
      service('storage', supply.storageService);
    if (supply.stockEnabled) {
      const refills = rules.filter((rule) => rule.restock !== 'off');
      add(
        'refill',
        'Refill',
        refills.length
          ? `${refills.length} configured stock goals; retained minimum/target and protected reserves apply.`
          : 'No stock goals configured; choose refill rules if replenishment is intended.',
        'supply',
        refills.length ? 'info' : 'warning',
      );
      if (refills.some((rule) => rule.restock === 'buy')) service('buy', supply.buyService);
    }
    add(
      'route',
      'Merchant & save-point route',
      `${supply.merchantMode === 'automatic' ? 'Automatic merchant selection waits for verified arrival and a permitted route.' : `Manual merchant ${supply.sellService || 'not selected'}${merchantMap ? ` on ${merchantMap}` : ''}.`} ${(supply.transport ?? 'travel') === 'travel' ? 'Travel through permitted maps to the service.' : `${supply.transport === 'butterfly' ? `Butterfly Wing #602; keep ${supply.returnMinStock ?? 1} in reserve` : 'Return skill #54; learned skill and SP required'} → expected save map ${supply.saveMap || '(missing)'}. Living arrival must be confirmed.`} Return to the captured farming map/cell after the trip.`,
      'supply',
    );
  }
  add(
    'reconnect',
    'Reconnect',
    `${context.reconnectAvailable ? (context.reconnectEnabled || context.active ? 'Session reconnect is available for the running bot.' : 'Automatic reconnect is off while idle; a running bot uses the session login.') : 'Session login unavailable; connection loss needs sign-in.'} Reconnect retains original run allowances and unresolved actions.`,
    'account',
    context.reconnectAvailable ? 'info' : 'warning',
  );
  return rows;
}

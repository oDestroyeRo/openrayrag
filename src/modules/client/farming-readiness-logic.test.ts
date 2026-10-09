import { describe, expect, it } from 'vitest';
import {
  farmingReadiness,
  respawnAllowanceSummary,
  type FarmingReadinessContext,
} from './farming-readiness-logic';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION, type Settings } from '../settings/settings';
import { DEFAULT_SUPPLY } from '../services/supply-trip-logic';
import { DEFAULT_RECOVERY_ITEMS, DEFAULT_SP_ITEMS } from '../recovery/recovery-items';

const context: FarmingReadinessContext = {
  active: false,
  fresh: true,
  remainingSupplyTrips: null,
  reconnectEnabled: false,
  reconnectAvailable: true,
};
const settings = (): Settings => ({
  ...DEFAULT_SETTINGS,
  map: 'prt_fild05',
  automation: structuredClone(DEFAULT_AUTOMATION),
});
const sale = {
  itemId: 501,
  keep: 10,
  minimum: 10,
  desired: 10,
  maximum: 10,
  store: false,
  cart: false,
  sell: true,
  restock: 'off' as const,
  allowUnique: false,
};
const supplySettings = () => {
  const s = settings();
  s.automation!.supply = {
    ...DEFAULT_SUPPLY,
    enabled: true,
    stockEnabled: false,
    weightEnabled: true,
    merchantMode: 'automatic',
  };
  s.automation!.disposition = { maxSpend: 0, rules: [sale] };
  return s;
};
const row = (s: Settings, id: string, c = context, snapshot: unknown = null) =>
  farmingReadiness(s, snapshot, c).find((item) => item.id === id);

describe('farming readiness', () => {
  it('explains unlimited/off zero limits without granting any allowance or enabling supplies', () => {
    const s = settings();
    s.automation!.limits = { minutes: 0, kills: 0, pickups: 0, weightPercent: 0 };
    const before = structuredClone(s);
    expect(row(s, 'limits')?.detail).toContain(
      'minutes unlimited · kills unlimited · pickups unlimited · hard weight wait off (0)',
    );
    expect(row(s, 'supply')?.title).toBe('Auto sell & refill off');
    expect(row(s, 'respawn')?.severity).toBe('info');
    expect(farmingReadiness(s, null, context)).toEqual(farmingReadiness(s, null, context));
    expect(s).toEqual(before);
  });
  it('warns on restored enabled legacy-zero deaths and keeps the saved allowance unchanged', () => {
    const s = settings();
    s.automation!.respawn = { enabled: true, maxDeaths: 0 };
    expect(row(s, 'respawn')).toMatchObject({ severity: 'warning', action: 'recovery' });
    expect(row(s, 'respawn')?.detail).toContain('legacy: no counted death allowance');
    expect(row(s, 'respawn')?.detail).toContain('Starting while already dead');
    expect(s.automation!.respawn.maxDeaths).toBe(0);
    s.automation!.respawn.enabled = false;
    expect(row(s, 'respawn')?.severity).toBe('info');
  });
  it('separates original active remaining limits from the saved draft for next Start', () => {
    const active = settings(),
      saved = settings();
    active.automation!.limits = { minutes: 5, kills: 10, pickups: 20, weightPercent: 0 };
    active.automation!.respawn = { enabled: true, maxDeaths: 2 };
    saved.automation!.respawn = { enabled: true, maxDeaths: 5 };
    const c = {
      ...context,
      active: true,
      used: { elapsedSeconds: 120, kills: 4, pickups: 9, deaths: 2 },
    };
    expect(row(active, 'limits', c)?.detail).toContain(
      '5 minutes (3 remaining) · 10 kills (6 remaining) · 20 pickups (11 remaining)',
    );
    expect(row(active, 'respawn', c)).toMatchObject({ severity: 'warning' });
    expect(row(active, 'respawn', c)?.detail).toContain('2 deaths · 0 remaining');
    expect(row(saved, 'respawn', { ...c, active: false })?.detail).toContain('5 deaths');
    expect(row(saved, 'respawn', { ...c, active: false })?.detail).not.toContain('remaining');
    expect(respawnAllowanceSummary({ enabled: true, maxDeaths: 2 }, 1)).toBe(
      'Respawn on · 2 deaths · 1 remaining',
    );
  });
  it.each([
    [0, undefined],
    [90, 'info'],
    [80, 'error'],
    [70, 'error'],
  ] as const)('classifies a sell trigger of 80 with hard wait %i', (hard, severity) => {
    const s = supplySettings();
    s.automation!.limits.weightPercent = hard;
    expect(row(s, 'weight')?.severity).toBe(severity);
    if (severity === 'info') expect(row(s, 'weight')?.detail).toContain('pickup jumping directly');
  });
  it('shows a currently observed weight jump as a departure blocker', () => {
    const s = supplySettings();
    s.automation!.limits.weightPercent = 90;
    const snapshot = { connected: true, character: { stats: { weight: 950, maxWeight: 1000 } } };
    expect(row(s, 'current-weight', context, snapshot)).toMatchObject({
      severity: 'error',
      action: 'limits',
    });
    expect(row(s, 'current-weight', { ...context, fresh: false }, snapshot)).toBeUndefined();
  });
  it('requires manual matching services and permitted sales, while automatic merchants need no manual selection', () => {
    const s = supplySettings();
    expect(row(s, 'service-sell')).toBeUndefined();
    expect(row(s, 'route')?.detail).toContain(
      'Automatic merchant selection waits for verified arrival',
    );
    s.automation!.supply!.merchantMode = 'manual';
    expect(row(s, 'service-sell')).toMatchObject({ severity: 'error' });
    s.automation!.supply!.sellService = 'trader.prt-fild05.tool-dealer.buy.v1';
    expect(row(s, 'service-sell')).toMatchObject({ severity: 'error' });
    s.automation!.supply!.sellService = 'trader.prt-fild05.tool-dealer.sell.v1';
    expect(row(s, 'service-sell')).toBeUndefined();
    expect(row(s, 'route')?.detail).toContain('on prt_fild05');
    s.automation!.disposition!.rules = [];
    expect(row(s, 'sales')).toMatchObject({ severity: 'error' });
  });
  it('requires only services used by enabled refill rules', () => {
    const s = supplySettings();
    s.automation!.supply!.stockEnabled = true;
    s.automation!.disposition!.rules = [{ ...sale, restock: 'buy' }];
    expect(row(s, 'service-buy')).toMatchObject({ severity: 'error' });
    expect(row(s, 'service-storage')).toBeUndefined();
    s.automation!.supply!.buyService = 'trader.prt-fild05.tool-dealer.buy.v1';
    expect(row(s, 'service-buy')).toBeUndefined();
    s.automation!.disposition!.rules = [{ ...sale, restock: 'storage' }];
    expect(row(s, 'service-storage')).toMatchObject({ severity: 'error' });
    s.automation!.supply!.stockEnabled = false;
    expect(row(s, 'service-storage')).toBeUndefined();
  });
  it('uses actual retained trip capacity and never implies a configured cap replenishes it', () => {
    const s = supplySettings();
    s.automation!.supply!.maxTrips = 10;
    expect(row(s, 'supply', { ...context, remainingSupplyTrips: 0 })).toMatchObject({
      severity: 'error',
      title: 'Supply trip allowance exhausted',
    });
    expect(row(s, 'supply', { ...context, remainingSupplyTrips: 0 })?.detail).toContain(
      '0 trips remaining (configured cap 10)',
    );
    expect(row(s, 'supply', { ...context, remainingSupplyTrips: 2 })?.detail).toContain(
      '2 trips remaining',
    );
    expect(row(s, 'supply')?.detail).toContain('Retained capacity unobserved');
  });
  it('shows save-point transport, return reserves and protected recovery stock', () => {
    const s = supplySettings();
    s.automation!.supply = {
      ...s.automation!.supply!,
      transport: 'butterfly',
      saveMap: 'prontera',
      returnMinStock: 2,
    };
    s.automation!.hpPotions = { ...DEFAULT_RECOVERY_ITEMS, mode: 'any', minStock: 10 };
    s.automation!.spPotions = {
      ...DEFAULT_SP_ITEMS,
      mode: 'selected',
      itemIds: [505],
      minStock: 5,
    };
    const snapshot = {
      connected: true,
      player: { hp: 100, maxHp: 200 },
      character: {
        stats: { sp: 20, maxSp: 100 },
        inventoryKnown: true,
        inventory: [
          { itemId: 501, count: 10 },
          { itemId: 505, count: 6 },
        ],
      },
    };
    expect(row(s, 'route')?.detail).toContain(
      'Butterfly Wing #602; keep 2 in reserve → expected save map prontera',
    );
    expect(row(s, 'hp', context, snapshot)).toMatchObject({ severity: 'warning' });
    expect(row(s, 'hp', context, snapshot)?.detail).toContain('reserve at least 10 per item');
    expect(row(s, 'sp', context, snapshot)).toMatchObject({ severity: 'info' });
    expect(row(s, 'hp', { ...context, fresh: false }, snapshot)?.detail).toContain(
      'usable stock unobserved',
    );
  });
  it('explains unavailable reconnect without creating a new run or claiming all automation is ready', () => {
    expect(row(settings(), 'reconnect', { ...context, reconnectAvailable: false })).toMatchObject({
      severity: 'warning',
      action: 'account',
    });
    expect(farmingReadiness(null, null, context)).toEqual([]);
  });
});

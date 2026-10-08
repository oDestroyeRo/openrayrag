import { afterEach, describe, expect, it, vi } from 'vitest';
import { SupplyMerchantResolver } from './supply-merchant';
import { selectSupplyMerchant, supplyMerchantWalkCost } from './supply-merchant-logic';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import { DEFAULT_SUPPLY } from './supply-trip';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy-logic';
import { TravelPlanner } from '../navigation/travel';
import { GridNavigator } from '../navigation/navigation';
import { CompanionController } from '../runtime/controller';

const settings = {
  ...DEFAULT_SETTINGS,
  map: 'prt_fild08',
  targets: [4000],
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    supply: { ...DEFAULT_SUPPLY, merchantMode: 'automatic' as const },
  },
};
afterEach(() => vi.restoreAllMocks());
describe('verified automatic merchant planning', () => {
  it('admits an allowed Database-only destination and waits to rank its actual landing merchants', () => {
    let available = true;
    const resolver = new SupplyMerchantResolver((map) => available && map === 'prontera');
    const value = {
      ...settings,
      automation: {
        ...settings.automation,
        mapPolicy: { ...DEFAULT_MAP_POLICY, allow: ['iz_dun00', 'prontera'] },
      },
    };
    const destination = resolver.resolve(value, 'iz_dun00', { x: 281, y: 47 });
    expect(destination.contractId).toContain('prontera');
    expect(destination.preview).toContain('landing cell and merchant approach');
    expect(destination.preview).toContain('No portal-route cost');
    expect(resolver.resolve(value, 'prontera', { x: 72, y: 133 }, true).contractId).toBe(
      'trader.prontera.milk-ranch-vendor.sell.v1',
    );
    available = false;
    expect(resolver.resolve(value, 'iz_dun00', { x: 281, y: 47 }).contractId).toBeNull();
    expect(
      new SupplyMerchantResolver(() => true).resolve(
        {
          ...value,
          automation: {
            ...value.automation,
            mapPolicy: { ...DEFAULT_MAP_POLICY, allow: ['iz_dun00'] },
          },
        },
        'iz_dun00',
        { x: 281, y: 47 },
      ).contractId,
    ).toBeNull();
  });
  it('prefers a reachable current-map merchant and follows legacy versus weighted remote cost policy', () => {
    const candidate = (contractId: string, map: string, cost: number, hops: number) => ({
      contractId,
      map,
      cost,
      hops,
      name: contractId,
      approach: { x: 1, y: 1 },
    });
    const candidates = [candidate('near', 'remote', 100, 1), candidate('cheap', 'other', 20, 2)];
    expect(selectSupplyMerchant(candidates, 'field').contractId).toBe('near');
    expect(selectSupplyMerchant(candidates, 'field', 'weighted').contractId).toBe('cheap');
    expect(
      selectSupplyMerchant(
        [...candidates, candidate('local', 'field', 1000, 0)],
        'field',
        'weighted',
      ).contractId,
    ).toBe('local');
    expect(candidates.map((c) => c.contractId)).toEqual(['near', 'cheap']);
  });
  it('uses collision-aware actual arrival approaches, caches unchanged plans and honors map restrictions', () => {
    const resolver = new SupplyMerchantResolver();
    const plan = vi.spyOn(GridNavigator.prototype, 'plan');
    const choice = resolver.resolve(settings, 'prontera', { x: 72, y: 133 }, true);
    expect(choice.contractId).toBe('trader.prontera.milk-ranch-vendor.sell.v1');
    const count = plan.mock.calls.length;
    choice.contractId = 'mutated';
    expect(resolver.resolve(settings, 'prontera', { x: 72, y: 133 }, true).contractId).toBe(
      'trader.prontera.milk-ranch-vendor.sell.v1',
    );
    expect(plan.mock.calls).toHaveLength(count);
    const restricted = {
      ...settings,
      automation: {
        ...settings.automation,
        mapPolicy: { ...DEFAULT_MAP_POLICY, allow: ['prt_fild08'] },
      },
    };
    expect(resolver.resolve(restricted, 'prt_fild08', { x: 156, y: 374 }).contractId).toBeNull();
    expect(resolver.resolve(settings, 'unknown', { x: 1, y: 1 }, true).contractId).toBeNull();
  });
  it('counts intermediate exit movement once and the final exit separately', () => {
    const route = [
      {
        cells: [
          { x: 156, y: 374 },
          { x: 157, y: 374 },
        ],
        arrivalEscape: [
          { x: 10, y: 10 },
          { x: 11, y: 10 },
        ],
        portal: { fromMap: 'prt_fild08', toMap: 'prt_fild03', arrival: { x: 10, y: 10 } },
      },
      {
        cells: [
          { x: 10, y: 10 },
          { x: 11, y: 10 },
          { x: 12, y: 10 },
        ],
        arrivalEscape: [
          { x: 288, y: 220 },
          { x: 289, y: 220 },
        ],
        portal: { fromMap: 'prt_fild03', toMap: 'prt_fild05', arrival: { x: 288, y: 220 } },
      },
    ] as unknown as NonNullable<ReturnType<TravelPlanner['routeBetweenMaps']>>;
    vi.spyOn(TravelPlanner.prototype, 'routeBetweenMaps').mockReturnValue(route);
    vi.spyOn(TravelPlanner.prototype, 'planArrivalEscape').mockImplementation((_map, position) => [
      position,
    ]);
    vi.spyOn(GridNavigator.prototype, 'plan').mockImplementation((position) => [position]);
    const value = {
      ...settings,
      route_avoidWalls: false,
      automation: {
        ...settings.automation,
        supply: { ...DEFAULT_SUPPLY, sellService: 'trader.prt-fild05.tool-dealer.sell.v1' },
      },
    };
    expect(
      new SupplyMerchantResolver().resolve(value, 'prt_fild08', { x: 156, y: 374 }).preview,
    ).toContain('route cost 40');
  });
  it('includes the same wall-clearance penalties used by permitted navigation', () => {
    const grid = { width: 20, height: 20, walkable: (p: { x: number; y: number }) => p.x !== 0 };
    const route = [
      { x: 2, y: 10 },
      { x: 1, y: 10 },
    ];
    expect(supplyMerchantWalkCost(grid, route, false)).toBe(10);
    expect(supplyMerchantWalkCost(grid, route, true)).toBe(70);
  });
  it('does not plan merchants for unrelated controller ticks or status reads', () => {
    const resolve = vi.spyOn(SupplyMerchantResolver.prototype, 'resolve');
    const c = new CompanionController(() => {});
    c.connect(true);
    for (let i = 0; i < 20; i++) {
      c.tick();
      c.snapshot();
    }
    expect(resolve).not.toHaveBeenCalled();
  });
});

import { GridNavigator } from '../navigation/navigation';
import { publishedGrid } from '../navigation/navigation-logic';
import { TravelPlanner } from '../navigation/travel';
import { mapAllowed, mapPolicy, PORTAL_COST } from '../navigation/map-policy-logic';
import type { SettingsInput } from '../settings/settings';
import type { Position } from '../protocol/protocol';
import { BUILTIN_SERVICES, serviceAvailability } from './npc-services-logic';
import {
  selectSupplyMerchant,
  supplyMerchantWalkCost,
  type SupplyMerchantCandidate,
  type SupplyMerchantChoice,
} from './supply-merchant-logic';

/** Bounded read-only planning cache. No transport, NPC or economic hooks. */
export class SupplyMerchantResolver {
  private readonly planner = new TravelPlanner();
  private readonly navigators = new Map<string, GridNavigator>();
  private cached: { key: string; choice: SupplyMerchantChoice } | null = null;
  constructor(private readonly databaseSupported: (map: string) => boolean = () => false) {}
  resolve(
    settings: SettingsInput,
    map: string,
    position: Position | null,
    arrivalOnly = false,
  ): SupplyMerchantChoice {
    const supply = settings.automation?.supply,
      policy = mapPolicy(settings);
    if (!position || !map)
      return {
        contractId: null,
        reason: 'A verified arrival map and cell are required to select the merchant.',
        preview: '',
      };
    if (
      arrivalOnly &&
      mapAllowed(policy, map) &&
      !this.planner.planArrivalEscape(map, position, settings.route_avoidWalls)
    )
      return {
        contractId: null,
        reason: `The actual arrival at ${map} (${position.x}, ${position.y}) has no verified walkable escape. Stop, use normal manual Database travel to a walkable cell, check the merchant, then Start for another supply attempt using one remaining trip.`,
        preview: '',
      };
    const databaseMaps = [...new Set(BUILTIN_SERVICES.map((service) => service.map))].filter(
      this.databaseSupported,
    );
    const key = JSON.stringify([
      map,
      position,
      policy,
      settings.route_avoidWalls,
      supply?.merchantMode,
      supply?.sellService,
      arrivalOnly,
      databaseMaps,
    ]);
    if (this.cached?.key === key) return { ...this.cached.choice };
    const candidates: SupplyMerchantCandidate[] = [];
    for (const service of BUILTIN_SERVICES) {
      if (
        service.outcome.type !== 'shopOpened' ||
        service.outcome.mode !== 'sell' ||
        serviceAvailability(service) ||
        !mapAllowed(policy, service.map) ||
        (supply?.merchantMode !== 'automatic' && service.contractId !== supply?.sellService) ||
        (arrivalOnly && service.map !== map)
      )
        continue;
      const route =
        map === service.map
          ? []
          : this.planner.routeBetweenMaps(
              map,
              position,
              service.map,
              settings.route_avoidWalls,
              policy,
            );
      if (!route) {
        if (map !== service.map && databaseMaps.includes(service.map) && !arrivalOnly)
          candidates.push({
            contractId: service.contractId,
            map: service.map,
            name: service.identity.name,
            approach: { x: service.approach.x, y: service.approach.y },
            cost: Infinity,
            hops: Infinity,
            landingUnknown: true,
          });
        continue;
      }
      const last = route.at(-1);
      const initial = last ? (last.arrivalEscape.at(-1) ?? last.portal.arrival) : position;
      const escape = this.planner.planArrivalEscape(
        service.map,
        initial,
        settings.route_avoidWalls,
      );
      const origin = escape?.at(-1);
      const grid = publishedGrid(service.map);
      if (!escape || !origin || !grid) continue;
      let nav = this.navigators.get(service.map);
      if (!nav) {
        nav = new GridNavigator(grid);
        if (this.navigators.size >= 16)
          this.navigators.delete(this.navigators.keys().next().value!);
        this.navigators.set(service.map, nav);
      }
      let approach: Position[] | null = null;
      for (
        let y = service.approach.y - service.approach.halfHeight;
        y <= service.approach.y + service.approach.halfHeight;
        y++
      )
        for (
          let x = service.approach.x - service.approach.halfWidth;
          x <= service.approach.x + service.approach.halfWidth;
          x++
        ) {
          const cells = nav.plan(origin, { x, y }, { avoidWalls: true });
          if (cells?.length && (!approach || cells.length < approach.length)) approach = cells;
        }
      if (!approach?.length || approach.length > 512) continue;
      const walkCost = (
        onMap: string,
        cells: readonly Position[],
        avoidWalls = settings.route_avoidWalls,
      ) => supplyMerchantWalkCost(publishedGrid(onMap)!, cells, avoidWalls);
      // Intermediate exit walks are prefixes of the next step's cells. Only
      // the final exit walk is separate from those route segments.
      const cost =
        walkCost(service.map, approach, true) +
        walkCost(service.map, escape) +
        walkCost(service.map, last?.arrivalEscape ?? []) +
        route.reduce(
          (sum, step) =>
            sum +
            walkCost(step.portal.fromMap, step.cells) +
            (policy.mode === 'weighted'
              ? PORTAL_COST +
                (policy.penalties.find((p) => p.map === step.portal.fromMap)?.cost ?? 0)
              : 0),
          0,
        );
      candidates.push({
        contractId: service.contractId,
        map: service.map,
        name: service.identity.name,
        approach: { ...approach.at(-1)! },
        cost,
        hops: route.length,
      });
    }
    const choice = selectSupplyMerchant(candidates, map, policy.mode);
    this.cached = { key, choice };
    return { ...choice };
  }
}

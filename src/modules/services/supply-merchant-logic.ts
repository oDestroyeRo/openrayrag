import type { Position } from '../protocol/protocol';
import { minimumRouteCost, type WalkGrid } from '../navigation/navigation-logic';
import { penalties } from '../navigation/travel-logic';

export interface SupplyMerchantCandidate {
  contractId: string;
  map: string;
  name: string;
  approach: Position;
  cost: number;
  hops: number;
  landingUnknown?: boolean;
}
export interface SupplyMerchantChoice {
  contractId: string | null;
  reason: string;
  preview: string;
}

/** Candidates already have a permitted collision-aware route and final approach. */
export function selectSupplyMerchant(
  candidates: readonly SupplyMerchantCandidate[],
  map: string,
  mode: 'legacy' | 'weighted' = 'legacy',
): SupplyMerchantChoice {
  const selected = [...candidates].sort(
    (a, b) =>
      Number(b.map === map) - Number(a.map === map) ||
      (mode === 'legacy' ? a.hops - b.hops : 0) ||
      a.cost - b.cost ||
      a.contractId.localeCompare(b.contractId),
  )[0];
  return selected
    ? selected.landingUnknown
      ? {
          contractId: selected.contractId,
          reason: '',
          preview: `${selected.map} · permitted Database destination; landing cell and merchant approach are resolved after verified arrival. No portal-route cost is available.`,
        }
      : {
          contractId: selected.contractId,
          reason: '',
          preview: `${selected.map} · ${selected.name} · approach (${selected.approach.x}, ${selected.approach.y}) · permitted route cost ${selected.cost}`,
        }
    : {
        contractId: null,
        reason:
          'No reachable verified NPC sell service is available under the current map restrictions.',
        preview: '',
      };
}

/** The navigator's cardinal wall-clearance costs, evaluated only along the
 * selected route. Portal margins and map edges are effective obstacles too. */
export function supplyMerchantWalkCost(
  grid: WalkGrid,
  cells: readonly Position[],
  avoidWalls: boolean,
): number {
  const blocked = (p: Position) =>
    p.x < 0 ||
    p.y < 0 ||
    p.x >= grid.width ||
    p.y >= grid.height ||
    !grid.walkable(p) ||
    grid.portals?.some(
      (area) =>
        Math.abs(p.x - area.x) <= area.halfWidth && Math.abs(p.y - area.y) <= area.halfHeight,
    );
  return cells.slice(1).reduce((cost, cell, i) => {
    let clearance = 5;
    if (avoidWalls && blocked(cell)) clearance = 0;
    else if (avoidWalls) {
      search: for (let radius = 1; radius < 5; radius++) {
        for (let dx = -radius; dx <= radius; dx++) {
          const dy = radius - Math.abs(dx);
          if (
            blocked({ x: cell.x + dx, y: cell.y + dy }) ||
            (dy && blocked({ x: cell.x + dx, y: cell.y - dy }))
          ) {
            clearance = radius;
            break search;
          }
        }
      }
    }
    return cost + minimumRouteCost(cells[i]!, cell) + (avoidWalls ? penalties[clearance]! : 0);
  }, 0);
}

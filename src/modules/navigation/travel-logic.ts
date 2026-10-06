import type { PlanningWork } from './route-planning';
import catalog from '../../data/travel-portals.json';
import type { PortalArea, WalkGrid } from './navigation-logic';
import type { Position } from '../protocol/protocol';
export interface PortalEdge {
  id: string;
  fromMap: string;
  toMap: string;
  area: PortalArea;
  arrival: Position;
  source: { kind: string; commit: string; path: string; line: number };
}

export interface TravelStep {
  portal: PortalEdge;
  /** Includes the start, and ends at the first cell of the selected trigger. */
  cells: Position[];
  /** The next map's initial exit from a trigger, if its arrival is excluded. */
  arrivalEscape: Position[];
}

export const TRAVEL_PORTALS: readonly PortalEdge[] = catalog.edges;

export const TRAVEL_SOURCE_COMMIT = catalog.sourceCommit;

export const directions = [[0,1],[1,1],[1,0],[1,-1],[0,-1],[-1,-1],[-1,0],[-1,1]] as const;

export const cardinal = [[0,1],[1,0],[0,-1],[-1,0]] as const;

export const penalties = [0,60,50,20,10,0] as const;

export const inside = (p: Position, area: PortalArea) => Math.abs(p.x - area.x) <= area.halfWidth
  && Math.abs(p.y - area.y) <= area.halfHeight;

export const sameArea = (a: PortalArea, b: PortalArea) => a.x === b.x && a.y === b.y
  && a.halfWidth === b.halfWidth && a.halfHeight === b.halfHeight;

export const sameArrival = (a: PortalEdge, b: PortalEdge) => a.toMap === b.toMap
  && a.arrival.x === b.arrival.x && a.arrival.y === b.arrival.y;

export interface Cell { state: number; cost: number; priority: number }

export interface Path { cells: Position[]; cost: number }

export function* copyCells(cells: readonly Position[], end = cells.length): PlanningWork<Position[]> {
  const copy: Position[] = [];
  for (let i = 0; i < end; i++) { if (i % 128 === 0) yield 'route-copy'; copy.push({ ...cells[i]! }); }
  return copy;
}

export interface WorldNode {
  key: string; map: string; position: Position; hops: number; cost: number; estimate: number;
  parent: WorldNode | null; step: Omit<TravelStep, 'arrivalEscape'> | null;
  pending: PortalEdge | null;
}

export interface TravelPlannerOptions {
  edges?: readonly PortalEdge[];
  grid?: (map: string) => WalkGrid | null;
  /** Same-map teleports require observing the confirmed arrival position. */
  allowSameMap?: boolean;
}

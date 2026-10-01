import { expect, it } from 'vitest';
import { distance, searchGrid, type PortalArea, type WalkGrid } from './navigation';
import { type Position } from './protocol';
import { planArrivalEscape, routeBetweenMaps, TRAVEL_PORTALS, TRAVEL_SOURCE_COMMIT, TravelPlanner, type PortalEdge } from './travel';

const inside = (p: Position, area: PortalArea) => Math.abs(p.x - area.x) <= area.halfWidth
  && Math.abs(p.y - area.y) <= area.halfHeight;
function edge(fromMap: string, toMap: string, x: number, y: number, ax = 1, ay = 1, halfWidth = 0, halfHeight = 0): PortalEdge {
  return { id: `${fromMap}:${x}:${y}:${toMap}:${ax}:${ay}`, fromMap, toMap,
    area: { x,y,halfWidth,halfHeight }, arrival: { x: ax,y: ay },
    source: { kind: 'Warp', commit: 'fixture', path: 'fixture', line: 1 } };
}
function fixture(edges: PortalEdge[], blocked: (map: string, p: Position) => boolean = () => false,
  extra: Record<string, PortalArea[]> = {}, allowSameMap = false): TravelPlanner {
  const names = new Set(edges.flatMap(e => [e.fromMap,e.toMap]));
  const grid = (map: string): WalkGrid | null => names.has(map) ? {
    width: 9, height: 7,
    portals: [...edges.filter(e => e.fromMap === map).map(e => e.area), ...(extra[map] ?? [])],
    walkable: p => Number.isInteger(p.x) && Number.isInteger(p.y) && p.x >= 0 && p.x < 9
      && p.y >= 0 && p.y < 7 && !blocked(map,p),
  } : null;
  return new TravelPlanner({ edges,grid,allowSameMap });
}

it('bundles only fixed portal edges backed by the compatible source pin and available grids', () => {
  expect(TRAVEL_SOURCE_COMMIT).toBe('4099e2c000c3c550516760b9c1241595aac9aceb');
  expect(TRAVEL_PORTALS).toHaveLength(1360);
  expect(new Set(TRAVEL_PORTALS.map(e => e.id)).size).toBe(TRAVEL_PORTALS.length);
  for (const e of TRAVEL_PORTALS) {
    const from = searchGrid(e.fromMap)!;
    const to = searchGrid(e.toMap)!;
    expect(from).not.toBeNull(); expect(to).not.toBeNull();
    expect(from.portals).toContainEqual(e.area);
    expect(to.walkable(e.arrival)).toBe(true);
    expect(['Warp','HiddenWarp']).toContain(e.source.kind);
    expect(e.source.commit).toBe(TRAVEL_SOURCE_COMMIT);
    expect(e.source.line).toBeGreaterThan(0);
  }
});

it('plans a real Field 8 to Prontera crossing and stops at its first chosen trigger cell', () => {
  const from = { x: 169,y: 193 };
  const steps = routeBetweenMaps('prt_fild08',from,'prontera')!;
  expect(steps).toHaveLength(1);
  const step = steps[0]!;
  expect(step.portal.toMap).toBe('prontera');
  expect(step.cells[0]).toEqual(from);
  expect(step.cells.length).toBeGreaterThan(100);
  expect(inside(step.cells.at(-1)!,step.portal.area)).toBe(true);
  expect(step.cells.slice(0,-1).some(p => searchGrid('prt_fild08')!.portals!.some(a => inside(p,a)))).toBe(false);
  const planner = new TravelPlanner();
  expect(planner.travelNavigator('prt_fild08',step.cells)!.validRoute(step.cells)).toBe(true);
  expect(step.arrivalEscape).toEqual([step.portal.arrival]);
});

it('plans a longer real crossing sequence and keeps each start at the confirmed previous arrival', () => {
  const steps = routeBetweenMaps('prt_fild08',{ x: 169,y: 193 },'payon')!;
  expect(steps.length).toBeGreaterThan(1);
  expect(steps.at(-1)!.portal.toMap).toBe('payon');
  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    expect(step.portal.fromMap).not.toBe(step.portal.toMap);
    if (i) {
      expect(step.portal.fromMap).toBe(steps[i - 1]!.portal.toMap);
      expect(step.cells[0]).toEqual(steps[i - 1]!.portal.arrival);
    }
    expect(inside(step.cells.at(-1)!,step.portal.area)).toBe(true);
    expect(new TravelPlanner().travelNavigator(step.portal.fromMap,step.cells)!.validRoute(step.cells)).toBe(true);
  }
});

it('fails closed for unknown maps, physically blocked starts, and maps with no directed edge', () => {
  expect(routeBetweenMaps('prt_fild08',{ x: 169,y: 193 },'payon_p')).toBeNull();
  expect(routeBetweenMaps('unknown',{ x: 0,y: 0 },'prontera')).toBeNull();
  expect(routeBetweenMaps('prt_fild08',{ x: -1,y: 2 },'prontera')).toBeNull();
  const e = edge('a','b',7,3);
  const planner = fixture([e],(m,p) => m === 'a' && p.x === 0);
  expect(planner.routeBetweenMaps('a',{ x: 0,y: 1 },'b')).toBeNull();
  expect(planner.routeBetweenMaps('b',{ x: 1,y: 1 },'a')).toBeNull();
  expect(planner.routeBetweenMaps('a',{ x: 1,y: 1 },'a')).toEqual([]);
});

it('keeps distinct arrival components when multiple portals lead to the same map', () => {
  const left = edge('a','b',2,3,1,3);
  const right = edge('a','b',7,3,6,3);
  const finish = edge('b','c',7,3);
  const planner = fixture([left,right,finish],(map,p) => map === 'b' && p.x === 4);
  expect(planner.planPortalApproach('b',left.arrival,finish)).toBeNull();
  const route = planner.routeBetweenMaps('a',{ x: 1,y: 3 },'c')!;
  expect(route.map(s => s.portal.id)).toEqual([right.id,finish.id]);
});

it('escapes an arrival trigger before approaching the next portal and never reenters it en route', () => {
  const first = edge('a','b',7,3,1,3);
  const finish = edge('b','c',7,3);
  const origin = { x: 1,y: 3,halfWidth: 1,halfHeight: 1 };
  const planner = fixture([first,finish],() => false,{ b: [origin] });
  const route = planner.routeBetweenMaps('a',{ x: 1,y: 3 },'c')!;
  const escape = route[0]!.arrivalEscape;
  expect(escape[0]).toEqual(first.arrival);
  expect(inside(escape.at(-1)!,origin)).toBe(false);
  const cells = route[1]!.cells;
  const exit = cells.findIndex(p => !inside(p,origin));
  expect(cells.slice(exit).some(p => inside(p,origin))).toBe(false);
  expect(planner.travelNavigator('b',cells)!.validRoute(cells)).toBe(true);
  const arrival = planner.routeBetweenMaps('a',{ x: 1,y: 3 },'b')![0]!.arrivalEscape;
  expect(arrival[0]).toEqual(first.arrival);
  expect(inside(arrival.at(-1)!,origin)).toBe(false);
});

it('finds a real safe exit when Morroc Field 2 arrival is inside its catalog trigger', () => {
  const from = { x: 77,y: 338 };
  const grid = searchGrid('moc_fild02')!;
  expect(grid.portals!.some(a => inside(from,a))).toBe(true);
  const cells = planArrivalEscape('moc_fild02',from)!;
  expect(cells[0]).toEqual(from);
  expect(cells.length).toBeGreaterThan(1);
  expect(grid.portals!.some(a => inside(cells.at(-1)!,a))).toBe(false);
  expect(new TravelPlanner().travelNavigator('moc_fild02',cells)!.validRoute(cells)).toBe(true);
});

it('avoids all other triggers, including unknown and conflicting overlapping rectangles', () => {
  const selected = edge('a','b',7,3);
  const foreign = { x: 4,y: 3,halfWidth: 0,halfHeight: 1 };
  const planner = fixture([selected],() => false,{ a: [foreign] });
  const cells = planner.planPortalApproach('a',{ x: 1,y: 3 },selected)!;
  expect(cells.some(p => inside(p,foreign))).toBe(false);
  const conflict = edge('a','c',7,3);
  expect(fixture([selected,conflict]).planPortalApproach('a',{ x: 1,y: 3 },selected)).toBeNull();
  expect(fixture([selected],() => false,{ a: [selected.area] }).planPortalApproach('a',{ x: 1,y: 3 },selected)).not.toBeNull();
});

it('does not cut a diagonal blocked corner when entering a trigger or leaving one', () => {
  const selected = edge('a','b',2,2);
  const planner = fixture([selected],(map,p) => map === 'a' && ((p.x === 2 && p.y === 1) || (p.x === 1 && p.y === 2)));
  const cells = planner.planPortalApproach('a',{ x: 1,y: 1 },selected,false)!;
  expect(cells.length).toBeGreaterThan(2);
  for (let i = 1; i < cells.length; i++) expect(distance(cells[i - 1]!,cells[i]!)).toBe(1);
  expect(planner.travelNavigator('a',cells)!.validRoute(cells)).toBe(true);
});

it('terminates directed cycles and uses same-map teleports only when explicitly enabled', () => {
  const ab = edge('a','b',7,3);
  const ba = edge('b','a',7,3);
  const finish = edge('b','c',6,5);
  const planner = fixture([ab,ba,finish],(map,p) => map === 'b' && p.y === 4);
  expect(planner.routeBetweenMaps('a',{ x: 1,y: 3 },'c')).toBeNull();
  const jump = edge('b','b',2,2,6,5);
  const outgoing = edge('b','c',7,5);
  const self = fixture([ab,jump,outgoing],(map,p) => map === 'b' && p.y === 4);
  expect(self.routeBetweenMaps('a',{ x: 1,y: 3 },'c')).toBeNull();
  const enabled = fixture([ab,jump,outgoing],(map,p) => map === 'b' && p.y === 4,{},true);
  expect(enabled.routeBetweenMaps('a',{ x: 1,y: 3 },'c')!.map(s => s.portal.id)).toEqual([ab.id,jump.id,outgoing.id]);
});

it('does not analyze longer world branches once a reachable direct crossing can win', () => {
  const direct = edge('a','b',2,3);
  const edges = [direct,edge('a','c',7,3),edge('c','d',7,3),edge('d','b',7,3)];
  const loaded: string[] = [];
  const planner = new TravelPlanner({ edges,grid: map => {
    loaded.push(map);
    return { width: 9,height: 7,portals: edges.filter(e => e.fromMap === map).map(e => e.area),
      walkable: p => p.x >= 0 && p.x < 9 && p.y >= 0 && p.y < 7 };
  } });
  expect(planner.routeBetweenMaps('a',{ x: 1,y: 3 },'b')!.map(s => s.portal.id)).toEqual([direct.id]);
  expect(new Set(loaded)).toEqual(new Set(['a','b']));
});

it('compares verified walking costs before committing to a geometrically nearer portal', () => {
  const near = edge('a','b',3,3);
  const clear = edge('a','b',1,6);
  const planner = fixture([near,clear],(map,p) => map === 'a' && p.x === 2 && p.y > 0 && p.y < 6);
  expect(planner.routeBetweenMaps('a',{ x: 1,y: 3 },'b',false)![0]!.portal.id).toBe(clear.id);
});

it('protects cached approaches and world routes from caller mutations and separates exact starts and wall settings', () => {
  const selected = edge('a','b',7,3);
  const planner = fixture([selected]);
  const from = { x: 1,y: 3 };
  const pristine = planner.planPortalApproach('a',from,selected)!;
  const changed = planner.planPortalApproach('a',from,selected)!;
  changed[0]!.x = -1; changed.at(-1)!.y = 999;
  expect(planner.planPortalApproach('a',from,selected)).toEqual(pristine);
  const trip = planner.routeBetweenMaps('a',from,'b')!;
  trip[0]!.cells[0]!.x = -1;
  expect(planner.routeBetweenMaps('a',from,'b')![0]!.cells).toEqual(pristine);
  const other = { x: 2,y: 1 };
  expect(planner.planPortalApproach('a',other,selected)![0]).toEqual(other);
  expect(planner.planPortalApproach('a',from,selected,false)).toEqual(fixture([selected]).planPortalApproach('a',from,selected,false));
});

it('reuses an ACK navigator only when its explicit portal corridor remains the same', () => {
  const selected = edge('a','b',7,3);
  const foreign = { x: 4,y: 3,halfWidth: 0,halfHeight: 1 };
  const planner = fixture([selected],() => false,{ a: [foreign] });
  const route = planner.planPortalApproach('a',{ x: 1,y: 3 },selected)!;
  const navigator = planner.travelNavigator('a',route)!;
  expect(planner.travelNavigator('a',route.slice(1))).toBe(navigator);
  expect(navigator.validRoute(route)).toBe(true);
  expect(navigator.safe(foreign)).toBe(false);
  const safeOnly = planner.travelNavigator('a',route.slice(0,-1))!;
  expect(safeOnly).not.toBe(navigator);
  expect(safeOnly.safe(selected.area)).toBe(false);
});

it('invalidates cached paths and ACK corridors if an evicted custom grid snapshot changes', () => {
  const selected = edge('a','b',7,3);
  let blocked = false;
  const planner = new TravelPlanner({ edges: [selected],grid: map => ({ width: 9,height: 7,
    portals: map === 'a' ? [selected.area] : [],walkable: p => p.x >= 0 && p.x < 9 && p.y >= 0 && p.y < 7
      && !(map === 'a' && blocked && p.x === 4) }) });
  const from = { x: 1,y: 3 };
  const route = planner.planPortalApproach('a',from,selected)!;
  expect(planner.travelNavigator('a',route)!.validRoute(route)).toBe(true);
  for (let i = 0; i < 33; i++) planner.planArrivalEscape(`snapshot-${i}`,from);
  blocked = true;
  expect(planner.planPortalApproach('a',from,selected)).toBeNull();
  expect(planner.travelNavigator('a',route)).toBeNull();
});

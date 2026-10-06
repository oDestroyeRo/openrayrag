import { expect, it, vi } from 'vitest';
import { distance, minimumRouteCost, GridNavigator, MAX_MAP_DIMENSION, NAVIGATION_MAPS, routeSegment, searchGrid, type WalkGrid } from './navigation';
import { type Position } from './protocol';
import catalog from './data/navigation-maps.json';
import sources from '../scripts/navigation-sources.json';

function openGrid(width: number, height: number, blocked: (p: Position) => boolean = () => false): WalkGrid {
  return { width, height, walkable: p => Number.isInteger(p.x) && Number.isInteger(p.y)
    && p.x >= 0 && p.y >= 0 && p.x < width && p.y < height && !blocked(p) };
}
function fixture(rows: string[]): WalkGrid {
  return openGrid(rows[0]!.length, rows.length, ({ x, y }) => rows[y]![x] === '#');
}

it('decodes the complete published grid and counts every physical blocked cell before routing', () => {
  expect(searchGrid('unsupported_map')).toBeNull();
  const grid = searchGrid('prt_fild05')!;
  expect(grid.width).toBe(400);
  expect(grid.height).toBe(400);
  expect(grid.walkable({ x: 360, y: 251 })).toBe(true);
  expect(grid.walkable({ x: -1, y: 251 })).toBe(false);
  const navigator = new GridNavigator(grid);
  const summary = navigator.summary({ x: 367, y: 230 });
  expect(summary.blocked).toBe(77807);
  expect(summary.walkable + summary.blocked).toBe(160000);
  expect(summary.excluded).toBeGreaterThan(0);
  expect(summary.reachable).toBeGreaterThan(10000);
  let blocked = 0;
  let portals = 0;
  for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
    const state = navigator.tileState({ x, y });
    if (state === 'blocked') blocked++;
    if (state === 'portal') portals++;
  }
  expect(blocked).toBe(summary.blocked);
  expect(portals).toBe(summary.excluded);
});

it('keeps portal exclusions distinct from physical walls and snapshots the input grid', () => {
  let blocked = true;
  const grid = openGrid(100, 100, ({ x, y }) => blocked && x === 50 && y === 50);
  const navigator = new GridNavigator(grid, [{ x: 50, y: 50, halfWidth: 24, halfHeight: 24 }]);
  expect(navigator.summary({ x: 0, y: 0 })).toEqual({
    width: 100, height: 100, walkable: 9999, blocked: 1, excluded: 2400, reachable: 7599,
  });
  expect(navigator.tileState({ x: 50, y: 50 })).toBe('blocked');
  expect(navigator.tileState({ x: 26, y: 50 })).toBe('portal');
  expect(navigator.tileState({ x: 25, y: 50 })).toBe('walkable');
  expect(navigator.safe({ x: 26, y: 50 })).toBe(false);
  expect(navigator.summary({ x: 26, y: 50 }).reachable).toBe(0);
  blocked = false;
  expect(grid.walkable({ x: 50, y: 50 })).toBe(true);
  expect(navigator.tileState({ x: 50, y: 50 })).toBe('blocked');
});

it('routes around a U-shaped wall rather than walking directly to its far side', () => {
  const navigator = new GridNavigator(fixture([
    '#########',
    '#.......#',
    '#.#...#.#',
    '#.#...#.#',
    '#.#...#.#',
    '#.#...#.#',
    '#.#####.#',
    '#.......#',
    '#########',
  ]), []);
  const from = { x: 4, y: 4 };
  const to = { x: 4, y: 7 };
  const route = navigator.plan(from, to)!;
  expect(route[0]).toEqual(from);
  expect(route.at(-1)).toEqual(to);
  expect(navigator.validRoute(route)).toBe(true);
  expect(route.some(p => p.y === 1)).toBe(true);
  expect(route.some(p => p.x === 1 || p.x === 7)).toBe(true);
  expect(navigator.plan(from, to, { maxDistance: 3 })).toBeNull();
});

it('rejects targets in another component even when they are nearby', () => {
  const navigator = new GridNavigator(openGrid(7, 5, p => p.x === 3), []);
  const from = { x: 2, y: 2 };
  expect(navigator.summary(from).reachable).toBe(15);
  expect(navigator.plan(from, { x: 4, y: 2 })).toBeNull();
  expect(navigator.plan(from, { x: 4, y: 2 }, { range: 1 })).toBeNull();
  expect(navigator.plan(from, { x: 3, y: 2 })).toBeNull();
});

it('prevents diagonal corner cuts in components, routes, and melee approach range', () => {
  const isolated = new GridNavigator(openGrid(2, 2, p => p.x !== p.y), []);
  expect(isolated.connected({ x: 0, y: 0 }, { x: 1, y: 1 })).toBe(false);
  expect(isolated.summary({ x: 0, y: 0 }).reachable).toBe(1);
  expect(isolated.plan({ x: 0, y: 0 }, { x: 1, y: 1 })).toBeNull();
  expect(isolated.validRoute([{ x: 0, y: 0 }, { x: 1, y: 1 }])).toBe(false);

  const navigator = new GridNavigator(openGrid(5, 5, p => p.x === 2 && p.y === 1), []);
  const from = { x: 1, y: 1 };
  const to = { x: 2, y: 2 };
  const route = navigator.plan(from, to, { range: 1 })!;
  expect(route.length).toBeGreaterThan(1);
  expect(distance(route.at(-1)!, to)).toBe(1);
  expect(navigator.connected(route.at(-1)!, to)).toBe(true);
  expect(navigator.validRoute(route)).toBe(true);
  expect(navigator.plan({ x: 1, y: 2 }, to, { range: 1 })).toEqual([{ x: 1, y: 2 }]);
});

it('prefers clearance but can use a narrow valid route within the configured step cap', () => {
  const navigator = new GridNavigator(openGrid(21, 17, p => p.y === 5 && p.x >= 3 && p.x <= 17), []);
  const from = { x: 2, y: 6 };
  const to = { x: 18, y: 6 };
  const tight = navigator.plan(from, to, { avoidWalls: false })!;
  const clear = navigator.plan(from, to)!;
  expect(tight).toHaveLength(17);
  expect(tight.every(p => p.y === 6)).toBe(true);
  expect(Math.max(...clear.map(p => p.y))).toBeGreaterThanOrEqual(9);
  expect(navigator.validRoute(clear)).toBe(true);
  const capped = navigator.plan(from, to, { maxDistance: 16 })!;
  expect(capped).toHaveLength(17);
  expect(navigator.validRoute(capped)).toBe(true);
  expect(navigator.plan(from, to, { maxDistance: 15 })).toBeNull();
});

it('selects random goals throughout the current component with a bounded fallback', () => {
  const navigator = new GridNavigator(openGrid(40, 20, p => p.x === 20), []);
  const from = { x: 2, y: 2 };
  for (const sample of [0, 0.2, 0.5, 0.9, 0.999]) {
    const goal = navigator.randomGoal(from, () => sample)!;
    expect(goal.x).toBeLessThan(20);
    expect(navigator.plan(from, goal)).not.toBeNull();
  }
  const far = navigator.randomGoal(from, () => 0.999)!;
  expect(distance(from, far)).toBeGreaterThan(10);
  let calls = 0;
  expect(navigator.randomGoal(from, () => { calls++; return NaN; })).not.toBeNull();
  expect(calls).toBe(500);
  const trapped = new GridNavigator(openGrid(1, 1), []);
  expect(trapped.randomGoal({ x: 0, y: 0 }, () => 0)).toBeNull();
});

it('validates coordinates and options while keeping path length caps exact', () => {
  const navigator = new GridNavigator(openGrid(30, 10), []);
  const from = { x: 2, y: 5 };
  const to = { x: 22, y: 5 };
  expect(navigator.plan(from, to, { maxDistance: 20 })!.length - 1).toBe(20);
  expect(navigator.plan(from, to, { maxDistance: 19 })).toBeNull();
  expect(navigator.plan(from, from, { maxDistance: 0 })).toEqual([from]);
  expect(navigator.plan(from, to, { maxDistance: Infinity })).toBeNull();
  expect(navigator.plan(from, to, { maxDistance: -1 })).toBeNull();
  expect(navigator.plan(from, to, { range: 0.5 })).toBeNull();
  for (const invalid of [{ x: -1, y: 1 }, { x: 30, y: 1 }, { x: NaN, y: 1 }, { x: 1.5, y: 1 }]) {
    expect(navigator.safe(invalid)).toBe(false);
    expect(navigator.tileState(invalid)).toBe('blocked');
    expect(navigator.plan(from, invalid)).toBeNull();
  }
  expect(navigator.validRoute([])).toBe(false);
  expect(navigator.validRoute([from, to])).toBe(false);
  expect(() => new GridNavigator(openGrid(MAX_MAP_DIMENSION + 1, 1), [])).toThrow(RangeError);
  expect(() => new GridNavigator(openGrid(0, 1), [])).toThrow(RangeError);
});

it('sends only the longest straight cardinal or diagonal prefix up to the step limit', () => {
  const route = [{ x: 1, y: 1 }, { x: 2, y: 1 }, { x: 3, y: 1 }, { x: 3, y: 2 }, { x: 3, y: 3 }];
  expect(routeSegment(route, 10)).toEqual(route.slice(0, 3));
  expect(routeSegment(route, 1)).toEqual(route.slice(0, 2));
  expect(routeSegment(route, 0)).toEqual(route.slice(0, 1));
  const diagonal = Array.from({ length: 15 }, (_, i) => ({ x: i, y: i }));
  expect(routeSegment(diagonal, 10)).toEqual(diagonal.slice(0, 11));
  expect(routeSegment([{ x: 1, y: 1 }, { x: 3, y: 1 }], 10)).toEqual([{ x: 1, y: 1 }]);
  expect(routeSegment(route, NaN)).toEqual([]);
  expect(routeSegment([], 10)).toEqual([]);
  const segment = routeSegment(route, 10);
  segment[0]!.x = 100;
  expect(route[0]!.x).toBe(1);
});

it('reroutes around temporary failures and restores routes after their expiry', () => {
  const navigator = new GridNavigator(openGrid(7, 5), []);
  const from = { x: 1, y: 2 };
  const to = { x: 5, y: 2 };
  const obstacle = { x: 3, y: 2 };
  const original = navigator.plan(from, to, { avoidWalls: false })!;
  expect(original).toContainEqual(obstacle);
  navigator.time(100);
  navigator.temporaryBlocked(obstacle, 200);
  expect(navigator.tileState(obstacle)).toBe('walkable');
  expect(navigator.summary(from).blocked).toBe(0);
  const rerouted = navigator.plan(from, to, { avoidWalls: false })!;
  expect(rerouted).not.toContainEqual(obstacle);
  expect(navigator.validRoute(rerouted)).toBe(true);
  navigator.time(199);
  expect(navigator.plan(from, to, { avoidWalls: false })).not.toContainEqual(obstacle);
  navigator.time(200);
  expect(navigator.plan(from, to, { avoidWalls: false })).toEqual(original);
});

it('does not cut diagonally past temporary failures and rejects a temporarily sealed corridor', () => {
  const navigator = new GridNavigator(fixture(['#####', '#...#', '#####']), []);
  navigator.time(0);
  navigator.temporaryBlocked({ x: 2, y: 1 }, 10);
  expect(navigator.plan({ x: 1, y: 1 }, { x: 3, y: 1 })).toBeNull();
  navigator.time(10);
  expect(navigator.plan({ x: 1, y: 1 }, { x: 3, y: 1 })).toHaveLength(3);

  const corner = new GridNavigator(openGrid(3, 3), []);
  corner.temporaryBlocked({ x: 1, y: 0 }, 10);
  expect(corner.plan({ x: 0, y: 0 }, { x: 1, y: 1 }, { avoidWalls: false }))
    .toEqual([{ x: 0, y: 0 }, { x: 0, y: 1 }, { x: 1, y: 1 }]);
});

it('can leave a temporarily failed tile after the server places the character on it', () => {
  const nav = new GridNavigator(openGrid(20,20), []);nav.time(100);
  const from={x:10,y:10};nav.temporaryBlocked(from,10000);
  expect(nav.plan(from,{x:12,y:10})).not.toBeNull();
  expect(nav.randomGoal(from,()=>.9)).not.toBeNull();
  expect(nav.plan({x:12,y:10},from)).toBeNull();
  expect(nav.plan(from,from)).toEqual([from]);
});

it('includes every published scene and records metadata entries without scene assets', () => {
  expect([...NAVIGATION_MAPS].sort()).toEqual(sources.maps.map(row => row.map).sort());
  expect(sources.maps).toHaveLength(231);
  expect(sources.unavailableMaps.map(row=>row.map).sort()).toEqual(['2009rwc_03','payon_p','pvp_n_1-5']);
  for (const row of sources.unavailableMaps) expect(searchGrid(row.map)).toBeNull();
  expect(searchGrid('izlude')).toMatchObject({width:272,height:272});
  expect(searchGrid('prontera')).toMatchObject({width:320,height:400});
  expect(searchGrid('__proto__')).toBeNull();
});

it.each(Object.entries(catalog))('verifies the complete collision grid and portal rectangles for %s', (code, data) => {
  expect(data.map).toBe(code);
  const source=sources.maps.find(row=>row.map===code)!;
  expect(data.sourceSha256).toBe(source.sourceSha256);
  expect(data.sourceUrl).toBe(source.sourceUrl);
  expect(data.bitOrder).toBe('lsb-first');
  expect(data.index).toBe('x+y*width');
  const grid = searchGrid(code)!;
  expect(searchGrid(code)).toBe(grid);
  expect(atob(data.walkableBitsBase64)).toHaveLength(Math.ceil(grid.width * grid.height / 8));
  const nav = new GridNavigator(grid);
  const summary = nav.summary({x:0,y:0});
  expect(summary.walkable).toBe(source.walkableCount);
  expect(summary.blocked).toBe(source.blockedCount);
  expect(summary.walkable + summary.blocked).toBe(grid.width * grid.height);
  for (const portal of data.portals) {
    for (let y=portal.y-portal.halfHeight;y<=portal.y+portal.halfHeight;y++)
      for (let x=portal.x-portal.halfWidth;x<=portal.x+portal.halfWidth;x++)
        expect(nav.safe({x,y})).toBe(false);
  }
});

it.each(['pay_fild02','pay_fild03'])('loads the full 416-cell extent and routes on walkable ground in %s', map => {
  const grid=searchGrid(map)!;
  expect(Math.max(grid.width,grid.height)).toBe(416);
  const nav=new GridNavigator(grid);
  let route: Position[] | null=null;
  for (let y=0;y<grid.height&&!route;y++) for (let x=0;x<grid.width&&!route;x++) {
    const from={x,y};
    for (const to of [{x:x+1,y},{x,y:y+1}]) if (nav.connected(from,to)) {
      route=nav.plan(from,to);break;
    }
  }
  expect(route).not.toBeNull();
  expect(nav.validRoute(route!)).toBe(true);
  expect(grid.walkable({x:grid.width-1,y:grid.height-1})).toBe(false);
});

it('can route through valid coordinates above 399 within the supported dimensions', () => {
  const nav=new GridNavigator(openGrid(416,416));
  const route=nav.plan({x:398,y:405},{x:409,y:405})!;
  expect(route.at(-1)).toEqual({x:409,y:405});
  expect(nav.validRoute(route)).toBe(true);
});

it('allows Field 8 arrivals outside the actual portal trigger and rejects the inclusive trigger edge', () => {
  const nav = new GridNavigator(searchGrid('prt_fild08')!);
  expect(nav.summary({x:152,y:354})).toMatchObject({walkable:89999,blocked:70001});
  for (const arrival of [{x:152,y:354},{x:20,y:239}]) {
    expect(nav.safe(arrival)).toBe(true);
    const goal=nav.randomGoal(arrival,()=>.6)!;
    const route=nav.plan(arrival,goal)!;
    expect(nav.validRoute(route)).toBe(true);
  }
  expect(nav.tileState({x:19,y:239})).toBe('portal');
  expect(nav.validRoute([{x:20,y:239},{x:19,y:239}])).toBe(false);
  expect(nav.plan({x:20,y:239},{x:19,y:239})).toBeNull();
});

it('excludes same-map Izlude warps omitted by the public cross-map export', () => {
  const grid=searchGrid('izlude')!;
  const nav=new GridNavigator(grid);
  for (const portal of [{x:149,y:40},{x:176,y:56}]) {
    expect(grid.walkable(portal)).toBe(true);
    expect(nav.tileState(portal)).toBe('portal');
    expect(nav.plan(portal,portal)).toBeNull();
  }
});

it('excludes hidden and conditional NPC touch warps omitted from ordinary Warp definitions', () => {
  for (const [map, point] of [['yuno_fild07',{x:207,y:176}], ['jupe_cave',{x:147,y:52}], ['prt_fild08',{x:131,y:338}]] as const) {
    const grid=searchGrid(map)!;
    expect(grid.walkable(point)).toBe(true);
    expect(new GridNavigator(grid).tileState(point)).toBe('portal');
  }
});

it('verifies unobstructed straight walking corridors without confusing them with detours', () => {
  const clear = new GridNavigator(openGrid(8, 8), []);
  for (const to of [{ x: 6, y: 1 }, { x: 6, y: 6 }, { x: 6, y: 3 }, { x: 1, y: 1 }]) {
    expect(clear.clearWalkCorridor({ x: 1, y: 1 }, to)).toBe(true);
  }
  const blocked = new GridNavigator(openGrid(8, 8, p => p.x === 3 && p.y === 1), []);
  expect(blocked.clearWalkCorridor({ x: 1, y: 1 }, { x: 6, y: 1 })).toBe(false);
  expect(blocked.plan({ x: 1, y: 1 }, { x: 6, y: 1 })).not.toBeNull();
  for (const to of [{ x: -1, y: 1 }, { x: 8, y: 1 }, { x: 1.5, y: 1 }]) {
    expect(clear.clearWalkCorridor({ x: 1, y: 1 }, to)).toBe(false);
  }
});

it('rejects straight-corridor diagonal corner cuts, portals and temporary failed cells', () => {
  const corner = new GridNavigator(openGrid(8, 8, p => p.x === 2 && p.y === 1), []);
  expect(corner.clearWalkCorridor({ x: 1, y: 1 }, { x: 5, y: 5 })).toBe(false);
  expect(corner.plan({ x: 1, y: 1 }, { x: 5, y: 5 })).not.toBeNull();
  const portal = new GridNavigator(openGrid(8, 8), [{ x: 3, y: 1, halfWidth: 0, halfHeight: 0 }]);
  expect(portal.clearWalkCorridor({ x: 1, y: 1 }, { x: 6, y: 1 })).toBe(false);
  expect(portal.clearWalkCorridor({ x: 1, y: 1 }, { x: 3, y: 1 })).toBe(false);
  const temporary = new GridNavigator(openGrid(8, 8), []);
  temporary.time(1000); temporary.temporaryBlocked({ x: 3, y: 1 }, 2000);
  expect(temporary.clearWalkCorridor({ x: 1, y: 1 }, { x: 6, y: 1 })).toBe(false);
  temporary.time(2000);
  expect(temporary.clearWalkCorridor({ x: 1, y: 1 }, { x: 6, y: 1 })).toBe(true);
});

it('uses an admissible cost bound including diagonal steps and the goal range', () => {
  expect(minimumRouteCost({x:1,y:1},{x:6,y:4},1)).toBe(48);
  expect(minimumRouteCost({x:1,y:1},{x:2,y:2},1)).toBe(0);
  const nav=new GridNavigator(openGrid(15,15,p=>p.x===6&&p.y>=2&&p.y<=11));
  for(const range of [0,1,2])for(const target of [{x:12,y:4},{x:4,y:12},{x:12,y:12}]){
    const from={x:3,y:4},path=nav.plan(from,target,{range})!;
    const cost=path.reduce((sum,p,i)=>sum+(i?(p.x!==path[i-1]!.x&&p.y!==path[i-1]!.y?14:10):0),0);
    expect(minimumRouteCost(from,target,range)).toBeLessThanOrEqual(cost);
  }
});

it('reuses exact plans without exposing mutable cached cells and separates every route option', () => {
  const grid=openGrid(21,17,p=>p.y===5&&p.x>=3&&p.x<=17),nav=new GridNavigator(grid);
  const from={x:2,y:6},to={x:18,y:6},calls=vi.spyOn(nav,'connected');
  const original=nav.plan(from,to)!;const expected=original.map(p=>({...p}));const work=calls.mock.calls.length;
  original[0]!.x=-1;original.pop();
  const again=nav.plan(from,to)!;expect(again).toEqual(expected);expect(calls).toHaveBeenCalledTimes(work);
  again[0]!.y=-1;expect(nav.plan(from,to)).toEqual(expected);
  for(const options of [{avoidWalls:false},{maxDistance:16},{maxDistance:15},{range:1},{range:2,maxDistance:14,avoidWalls:false}]){
    expect(nav.plan(from,to,options)).toEqual(new GridNavigator(grid).plan(from,to,options));
  }
  expect(nav.plan(to,from)).toEqual(new GridNavigator(grid).plan(to,from));
});

it('invalidates positive and negative cached routes on temporary block changes and expiry', () => {
  const grid=fixture(['#########','#.......#','#########']),nav=new GridNavigator(grid);
  const from={x:1,y:1},to={x:7,y:1};nav.time(1000);
  const clear=nav.plan(from,to);expect(clear).not.toBeNull();
  nav.temporaryBlocked({x:4,y:1},2000);expect(nav.plan(from,to)).toBeNull();
  const calls=vi.spyOn(nav,'connected');expect(nav.plan(from,to)).toBeNull();expect(calls).not.toHaveBeenCalled();
  nav.temporaryBlocked({x:4,y:1},3000);nav.time(2000);
  expect(nav.plan(from,to)).toBeNull();expect(calls).not.toHaveBeenCalled();
  nav.time(3000);expect(nav.plan(from,to)).toEqual(clear);expect(calls.mock.calls.length).toBeGreaterThan(0);
  nav.temporaryBlocked({x:5,y:1},4000);expect(nav.plan(from,to)).toBeNull();
  nav.time(4000);expect(nav.plan(from,to)).toEqual(clear);
});

it('evicts old exact results while preserving recent plans and their outcomes', () => {
  const grid=openGrid(90,12),nav=new GridNavigator(grid);
  const first={x:1,y:5},to={x:2,y:5};const initial=nav.plan(first,to);
  for(let cap=100;cap<360;cap++)expect(nav.plan(first,to,{maxDistance:cap})).toEqual(initial);
  const calls=vi.spyOn(nav,'connected');
  expect(nav.plan(first,to,{maxDistance:359})).toEqual(initial);expect(calls).not.toHaveBeenCalled();
  expect(nav.plan(first,to)).toEqual(initial);expect(calls.mock.calls.length).toBeGreaterThan(0);
});

it('bounds cached route cells as well as entries when many paths are long', () => {
  const nav=new GridNavigator(openGrid(90,90));
  const from={x:5,y:5},to={x:80,y:5},first=nav.plan(from,to);
  for(let y=6;y<=70;y++)expect(nav.plan({x:5,y},{x:80,y})!.length).toBeGreaterThan(70);
  const calls=vi.spyOn(nav,'connected');
  expect(nav.plan({x:5,y:70},{x:80,y:70})).not.toBeNull();expect(calls).not.toHaveBeenCalled();
  expect(nav.plan(from,to)).toEqual(first);expect(calls.mock.calls.length).toBeGreaterThan(0);
});

it('keeps cached searches equivalent to independent queries across A* and capped BFS fallback', () => {
  const grid=openGrid(30,22,p=>p.y===7&&p.x>=4&&p.x<=23),nav=new GridNavigator(grid);
  for(let i=0;i<90;i++){
    const from={x:2+i%2,y:8+i%3},to={x:25+i%3,y:8+i%4};
    const options={range:i%3,maxDistance:20+i%10,avoidWalls:i%2===0};
    expect(nav.plan(from,to,options)).toEqual(new GridNavigator(grid).plan(from,to,options));
  }
});


it('keeps uncached queries independent of accumulated searches and clock magnitude', () => {
  const grid = openGrid(20, 20), nav = new GridNavigator(grid);
  const from = { x: 2, y: 2 }, to = { x: 10, y: 3 };
  const expected = new GridNavigator(grid).plan(from, to);
  for (let search = 0; search < 300; search++) {
    nav.time(search);
    nav.temporaryBlocked({ x: 19, y: 19 }, search + 1);
    expect(nav.plan(from, to)).toEqual(expected);
  }
  nav.time(Number.MAX_SAFE_INTEGER);
  expect(nav.plan(from, to)).toEqual(expected);
  nav.time(0);
  expect(nav.plan(from, to)).toEqual(expected);
});

it('retains the exact weighted route and original capped fallback after a reachability preflight', () => {
  const grid=openGrid(400,400,p=>(p.y===205&&p.x>=190&&p.x<=225)||(p.x===203&&p.y===206));
  const nav=new GridNavigator(grid),from={x:202,y:206},to={x:210,y:206};
  expect(nav.plan(from,to,{maxDistance:64})).toEqual([
    {x:202,y:206},{x:202,y:207},{x:202,y:208},{x:203,y:209},{x:204,y:210},{x:205,y:210},
    {x:206,y:210},{x:207,y:209},{x:208,y:208},{x:209,y:207},{x:210,y:206},
  ]);
  expect(nav.plan(from,to,{maxDistance:9})).toEqual([
    {x:202,y:206},{x:202,y:207},{x:203,y:208},{x:204,y:209},{x:205,y:210},
    {x:206,y:210},{x:207,y:209},{x:208,y:208},{x:209,y:207},{x:210,y:206},
  ]);
  expect(nav.plan(from,to,{maxDistance:8})).toBeNull();
});

it('proves a capped wall rejection locally instead of exploring the entire large component', () => {
  const nav=new GridNavigator(openGrid(400,400,p=>p.x===200&&p.y>=3));
  const from={x:199,y:200},to={x:201,y:200},calls=vi.spyOn(nav,'connected');
  expect(nav.plan(from,to,{range:1,maxDistance:20})).toBeNull();
  expect(calls.mock.calls.length).toBeLessThan(15000);
  calls.mockClear();expect(nav.plan(from,to,{range:1,maxDistance:20})).toBeNull();expect(calls).not.toHaveBeenCalled();
});

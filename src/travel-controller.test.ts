import { expect, it } from 'vitest';
import { type Action } from './engine';
import { walkDuration } from './movement';
import { decode, OP, type Entity, type Position, type Walk } from './protocol';
import { BitWriter } from './binary';
import { searchGrid, type WalkGrid } from './navigation';
import { TravelController } from './travel-controller';
import { CompanionController } from './controller';

const player = (p: Position): Entity => ({ ...p,id: 321,classId: 0,name: 'Fixture',kind: 0,
  hp: 100,maxHp: 100,level: 9,dead: false });
function adjacentWalkPacket(from: Position, to: Position): Uint8Array {
  const directions = [[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
  const direction = directions.findIndex(([x,y]) => to.x - from.x === x && to.y - from.y === y);
  expect(direction).toBeGreaterThanOrEqual(0);
  const seconds = from.x !== to.x && from.y !== to.y ? 0.15 * 1.4142 : 0.15;
  return new BitWriter().u8(OP.walk).i32(321).position(from).f32(from.x).f32(from.y)
    .f32(0.15).f32(seconds).u8(2).u8(direction << 4).u8(0).finish();
}
function adjacentWalk(from: Position, to: Position): Walk {
  const event = decode(adjacentWalkPacket(from,to))[0]!;
  if (event.type !== 'walk') throw new Error('Expected walk fixture.');
  return event.walk;
}
function fixture() {
  let clock = 100_000;
  const actions: Action[] = [];
  const controller = new TravelController(action => actions.push(action),() => clock);
  const advance = (ms: number) => { clock += ms; };
  const acceptLeg = (map: string, current: Entity): Entity => {
    const cells = controller.snapshot().leg;
    expect(cells.length).toBeGreaterThan(1);
    const walk: Walk = { origin: current,cells,secondsPerCell: 0.1,firstSeconds: 0.1,locked: false };
    controller.observe([{ type: 'walk',id: current.id,walk }]);
    advance(walkDuration(walk) + 101);
    const next = player(cells.at(-1)!);
    controller.tick(map,next);
    return next;
  };
  return { controller,actions,advance,acceptLeg };
}

it('waits for an accepted walk, the expected map and matching character spawn before completing', () => {
  const { controller,actions,advance,acceptLeg } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false);
  controller.tick('prt_fild08',p);
  expect(actions).toHaveLength(1);
  expect(actions[0]!.type).toBe('walk');
  controller.tick('prt_fild08',p);
  expect(actions).toHaveLength(1);
  const atPortal = acceptLeg('prt_fild08',p);
  expect(controller.snapshot().state).toBe('transition');
  advance(500);
  controller.tick('prt_fild08',atPortal);
  expect(controller.snapshot().state).toBe('transition');
  controller.observe([{ type: 'map',map: 'prontera' }]);
  expect(controller.snapshot().state).toBe('transition');
  controller.tick('prontera',undefined);
  expect(actions).toHaveLength(1);
  const arrival = player({ x: 156,y: 26 });
  controller.observe([{ type: 'spawn',entity: arrival }]);
  controller.tick('prontera',arrival);
  expect(controller.snapshot().state).toBe('complete');
  expect(controller.active).toBe(false);
  expect(actions).toHaveLength(1);
  expect(controller.snapshot().reason).toContain('Choose targets');
});

it('accepts a map transition before the final walk acknowledgement without sending another walk', () => {
  const { controller,actions } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false);
  controller.tick('prt_fild08',p);
  controller.observe([{ type: 'map',map: 'prontera' },{ type: 'spawn',entity: player({ x: 156,y: 26 }) }]);
  controller.tick('prontera',player({ x: 156,y: 26 }));
  expect(controller.snapshot().state).toBe('complete');
  expect(actions.map(a => a.type)).toEqual(['walk']);
});

it('stops when no walk acknowledgement arrives and does not infer a transition or retry', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false);
  controller.tick('prt_fild08',p);
  advance(4_001);
  controller.tick('prt_fild08',p);
  expect(controller.snapshot().state).toBe('failed');
  expect(controller.snapshot().reason).toContain('confirmation timed out');
  expect(actions.map(a => a.type)).toEqual(['walk','stop']);
  advance(60_000); controller.tick('prt_fild08',p);
  expect(actions).toHaveLength(2);
});

it('stops after an unexpected map or a premature transition during an unrelated leg', () => {
  const wrong = fixture();
  const near = player({ x: 170,y: 370 });
  wrong.controller.start('prt_fild08',near,'prontera',10,false);
  wrong.controller.tick('prt_fild08',near);
  wrong.controller.observe([{ type: 'map',map: 'izlude' }]);
  expect(wrong.controller.snapshot().state).toBe('failed');
  expect(wrong.actions.map(a => a.type)).toEqual(['walk','stop']);
  const early = fixture();
  const far = player({ x: 169,y: 193 });
  early.controller.start('prt_fild08',far,'prontera',10,false);
  early.controller.tick('prt_fild08',far);
  early.controller.observe([{ type: 'map',map: 'prontera' }]);
  expect(early.controller.snapshot().state).toBe('failed');
  expect(early.controller.snapshot().reason).toContain('before the planned portal');
});

it('routes a retained final approach back to its captured map after official cross-map travel',()=>{
  let now=100_000,context={identity:'old-own',map:'prt_fild08',player:player({x:170,y:370})};const actions:Action[]=[];
  const travel=new TravelController(a=>actions.push(a),()=>now,()=>({width:400,height:400,walkable:()=>true}),
    {context:()=>context,continueRequested:()=>true});
  travel.startApproach(context.map,context.player,{x:169,y:370});const trip=travel.tripId;
  now+=25_000;context={...context,identity:'',map:'prontera'};travel.observe([{type:'map',map:'prontera'}]);travel.tick(context.map,undefined);
  expect(travel.active).toBe(true);context={identity:'new-own',map:'prontera',player:player({x:145,y:28})};
  travel.observe([{type:'spawn',entity:context.player,entryType:1}]);travel.tick(context.map,context.player);
  expect(travel.tripId).toBe(trip);expect(travel.snapshot().remainingMaps).toContain('prt_fild08');
  const walk=actions.find(a=>a.type==='walk');expect(walk?.type==='walk'&&walk.destination.y).toBeLessThan(100);
  expect(actions.filter(a=>a.type==='stop')).toEqual([]);
  now=400_001;travel.tick(context.map,context.player);expect(travel.snapshot()).toMatchObject({state:'failed',reason:'Final NPC approach reached its five-minute limit.'});
});
it('keeps unhinted accepted travel paths subject to collision validation even during a requested run',()=>{
  let context={identity:'own',map:'prt_fild08',player:player({x:170,y:370})};const actions:Action[]=[];
  const travel=new TravelController(a=>actions.push(a),()=>100_000,undefined,{context:()=>context,continueRequested:()=>true});
  travel.start(context.map,context.player,'prontera',10,false);travel.tick(context.map,context.player);
  const cells=Array.from({length:25},(_,i)=>({x:170+i,y:370}));
  travel.observe([{type:'walk',id:context.player.id,walk:{origin:cells[0]!,cells,secondsPerCell:.1,firstSeconds:.1,locked:false}}]);
  expect(travel.snapshot().state).toBe('failed');expect(actions.at(-1)).toEqual({type:'stop'});
});

it('rejects unavailable maps and a blocked start without changing external state', () => {
  const { controller,actions } = fixture();
  expect(() => controller.start('prt_fild08',player({ x: 169,y: 193 }),'payon_p',10,false)).toThrow('No verified route');
  expect(() => controller.start('prt_fild08',player({ x: -1,y: 193 }),'prontera',10,false)).toThrow('No verified route');
  expect(actions).toEqual([]);
  expect(controller.snapshot().state).toBe('idle');
});

it('rejects a blocked or displaced destination spawn instead of continuing through guessed cells', () => {
  for (const destination of [{ x: 0,y: 0,reason: 'arrival did not match' },{ x: 150,y: 20,reason: 'unreachable' }]) {
    const { controller,actions } = fixture();
    const p = player({ x: 170,y: 370 });
    expect(searchGrid('prontera')!.walkable(destination)).toBe(false);
    controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
    controller.observe([{ type: 'map',map: 'prontera' },{ type: 'spawn',entity: player(destination) }]);
    expect(controller.snapshot().state).toBe('failed');
    expect(controller.snapshot().reason).toContain(destination.reason);
    expect(actions.map(a => a.type)).toEqual(['walk','stop']);
  }
});

it('finishes a verified arrival escape before declaring the destination ready', () => {
  const { controller,actions,advance,acceptLeg } = fixture();
  const p = player({ x: 301,y: 21 });
  controller.start('moc_fild01',p,'moc_fild02',10,false); controller.tick('moc_fild01',p);
  controller.observe([{ type: 'map',map: 'moc_fild02' },{ type: 'spawn',entity: player({ x: 77,y: 338 }) }]);
  expect(controller.snapshot().state).toBe('walking');
  expect(controller.snapshot().reason).toContain('leaving the portal');
  advance(300);
  controller.tick('moc_fild02',player({ x: 77,y: 338 }));
  const outside = acceptLeg('moc_fild02',player({ x: 77,y: 338 }));
  expect(controller.snapshot().state).toBe('complete');
  expect(searchGrid('moc_fild02')!.portals!.some(a => Math.abs(outside.x - a.x) <= a.halfWidth
    && Math.abs(outside.y - a.y) <= a.halfHeight)).toBe(false);
  expect(actions.every(a => a.type === 'walk')).toBe(true);
});

it('cancels a manual stop and ignores late confirmations without resuming', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
  const cells = controller.snapshot().leg;
  controller.cancel('Manual input stopped travel.');
  expect(controller.snapshot().state).toBe('cancelled');
  controller.observe([{ type: 'walk',id: p.id,walk: { origin: p,cells,secondsPerCell: 0.1,firstSeconds: 0.1,locked: false } },
    { type: 'map',map: 'prontera' },{ type: 'spawn',entity: player({ x: 156,y: 26 }) }]);
  advance(1_000); controller.tick('prontera',player({ x: 156,y: 26 }));
  expect(controller.snapshot().state).toBe('cancelled');
  expect(actions.map(a => a.type)).toEqual(['walk','stop']);
});

it('cancels invalid accepted walk geometry, movement corrections and character death', () => {
  const badWalk = fixture();
  const p = player({ x: 170,y: 370 });
  badWalk.controller.start('prt_fild08',p,'prontera',10,false); badWalk.controller.tick('prt_fild08',p);
  badWalk.controller.observe([{ type: 'walk',id: p.id,walk: { origin: p,cells: [{ x: 0,y: 0 }],secondsPerCell: 0.1,firstSeconds: 0.1,locked: false } }]);
  expect(badWalk.controller.snapshot().state).toBe('failed');
  const correction = fixture();
  correction.controller.start('prt_fild08',p,'prontera',10,false); correction.controller.tick('prt_fild08',p);
  correction.controller.observe([{ type: 'position',id: p.id,position: p }]);
  expect(correction.controller.snapshot().state).toBe('failed');
  const death = fixture();
  death.controller.start('prt_fild08',p,'prontera',10,false); death.controller.tick('prt_fild08',p);
  death.controller.observe([{ type: 'death',id: p.id }]);
  expect(death.controller.snapshot().state).toBe('failed');
  expect(death.actions.at(-1)).toEqual({ type: 'stop' });
});

it('binds each safe walk acknowledgement to the outstanding leg origin, start and exact requested endpoint', () => {
  for (const changed of ['origin','start','endpoint'] as const) {
    const { controller,actions } = fixture();
    const p = player({ x: 170,y: 370 });
    controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
    const requested = controller.snapshot().leg;
    expect(requested.length).toBeGreaterThan(3);
    const cells = changed === 'start' ? requested.slice(2) : changed === 'endpoint' ? requested.slice(0,-1) : requested;
    const origin = changed === 'origin' ? { x: 170,y: 360 } : p;
    controller.observe([{ type: 'walk',id: p.id,walk: { origin,cells,secondsPerCell: 0.1,firstSeconds: 0.1,locked: false } }]);
    expect(controller.snapshot().state).toBe('failed');
    expect(actions.map(a => a.type)).toEqual(['walk','stop']);
  }
});

it('requires a confirmed character spawn before the transition timeout expires', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
  controller.observe([{ type: 'map',map: 'prontera' }]);
  advance(20_001); controller.tick('prontera',undefined);
  expect(controller.snapshot().state).toBe('failed');
  expect(controller.snapshot().reason).toContain('transition was not confirmed');
  expect(actions.map(a => a.type)).toEqual(['walk','stop']);
});

it('waits for a source-shaped occupancy nudge before replanning the same portal approach', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 166,y: 353 });
  controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
  expect(controller.snapshot().leg).toEqual([{ x: 166,y: 353 },{ x: 167,y: 354 }]);
  const accepted = adjacentWalk(p,{ x: 167,y: 354 });
  controller.observe([{ type: 'walk',id: p.id,walk: accepted }]);
  advance(walkDuration(accepted) + 50);
  const nudge = adjacentWalk({ x: 167,y: 354 },p);
  controller.observe([{ type: 'walk',id: p.id,walk: nudge }]);
  expect(controller.snapshot().state).toBe('walking');
  expect(controller.snapshot().leg).toEqual(nudge.cells);
  controller.tick('prt_fild08',p);
  expect(actions).toHaveLength(1);
  advance(walkDuration(nudge) + 101); controller.tick('prt_fild08',p);
  expect(controller.snapshot().state).toBe('walking');
  expect(controller.snapshot().remainingMaps).toEqual(['prontera']);
  expect(controller.snapshot().leg[0]).toEqual({ x: p.x,y: p.y });
  expect(actions.map(action => action.type)).toEqual(['walk','walk']);
});

it('accepts an occupancy nudge at the settlement boundary before dispatching another leg', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 166,y: 353 });
  controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
  const accepted = adjacentWalk(p,{ x: 167,y: 354 });
  controller.observe([{ type: 'walk',id: p.id,walk: accepted }]);
  advance(walkDuration(accepted) + 100);
  const nudge = adjacentWalk({ x: 167,y: 354 },{ x: 168,y: 354 });
  controller.observe([{ type: 'walk',id: p.id,walk: nudge }]);
  controller.tick('prt_fild08',player(nudge.cells[0]!));
  expect(controller.snapshot().state).toBe('walking');
  expect(actions).toHaveLength(1);
  advance(walkDuration(nudge) + 101); controller.tick('prt_fild08',player(nudge.cells[1]!));
  expect(controller.snapshot().leg[0]).toEqual({ x: 168,y: 354 });
  expect(actions.map(action => action.type)).toEqual(['walk','walk']);
});

it('handles decoded occupancy walks through the owning controller and its movement estimates', () => {
  let clock = 100_000;
  const actions: Action[] = [];
  const controller = new CompanionController(action => actions.push(action as Action),() => clock);
  const p = player({ x: 166,y: 353 });
  const end = { x: 167,y: 354 };
  controller.connect(true);
  controller.engine.receive([{ type: 'enter',id: p.id,map: 'prt_fild08' },{ type: 'spawn',entity: p }]);
  controller.travel.start('prt_fild08',p,'prontera',1,false); controller.tick();
  controller.receive(adjacentWalkPacket(p,end));
  clock += walkDuration(adjacentWalk(p,end)) + 50; controller.tick();
  controller.receive(adjacentWalkPacket(end,{ x: 168,y: 354 })); controller.tick();
  expect(controller.travel.snapshot().state).toBe('walking');
  expect(actions).toHaveLength(1);
  clock += walkDuration(adjacentWalk(end,{ x: 168,y: 354 })) + 101; controller.tick();
  expect(controller.engine.player).toMatchObject({ x: 168,y: 354 });
  expect(controller.travel.snapshot().leg[0]).toEqual({ x: 168,y: 354 });
  expect(actions.map(action => action.type)).toEqual(['walk','walk']);
});

it('waits for the expected map after the portal script corrects an accepted final leg', () => {
  const { controller,actions } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
  const cells = controller.snapshot().leg;
  controller.observe([{ type: 'walk',id: p.id,walk: { origin: p,cells,secondsPerCell: 0.15,firstSeconds: 0.15,locked: false } }]);
  controller.observe(decode(new BitWriter().u8(OP.stopImmediate).i32(p.id).position(cells.at(-1)!).finish()));
  controller.tick('prt_fild08',player(cells.at(-1)!));
  expect(controller.snapshot().state).toBe('transition');
  expect(actions.map(action => action.type)).toEqual(['walk']);
  controller.observe([{ type: 'map',map: 'prontera' },{ type: 'spawn',entity: player({ x: 156,y: 26 }) }]);
  controller.tick('prontera',player({ x: 156,y: 26 }));
  expect(controller.snapshot().state).toBe('complete');
  expect(actions.map(action => action.type)).toEqual(['walk']);
});

it('rejects a reversed nudge as the first acknowledgement and after a new leg was dispatched', () => {
  for (const afterDispatch of [false,true]) {
    const { controller,actions,advance } = fixture();
    const p = player({ x: 166,y: 353 });
    controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
    const accepted = adjacentWalk(p,{ x: 167,y: 354 });
    if (afterDispatch) {
      controller.observe([{ type: 'walk',id: p.id,walk: accepted }]);
      advance(walkDuration(accepted) + 101); controller.tick('prt_fild08',player({ x: 167,y: 354 }));
      expect(actions).toHaveLength(2);
    }
    controller.observe([{ type: 'walk',id: p.id,walk: adjacentWalk({ x: 167,y: 354 },p) }]);
    expect(controller.snapshot().state).toBe('failed');
    expect(actions.at(-1)).toEqual({ type: 'stop' });
  }
});

it('rejects unrelated, locked, long, expired or malformed occupancy routes', () => {
  for (const change of ['start','origin','locked','count','duration','zero','expired'] as const) {
    const { controller,actions,advance } = fixture();
    const p = player({ x: 166,y: 353 });
    controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
    const accepted = adjacentWalk(p,{ x: 167,y: 354 });
    controller.observe([{ type: 'walk',id: p.id,walk: accepted }]);
    const nudge = adjacentWalk({ x: 167,y: 354 },p);
    if (change === 'start') nudge.cells = [p,{ x: 165,y: 353 }];
    if (change === 'origin') nudge.origin = { x: 170,y: 354 };
    if (change === 'locked') nudge.locked = true;
    if (change === 'count') nudge.cells.push({ x: 165,y: 353 });
    if (change === 'duration') nudge.firstSeconds = 16;
    if (change === 'zero') nudge.firstSeconds = 0;
    if (change === 'expired') advance(walkDuration(accepted) + 101);
    controller.observe([{ type: 'walk',id: p.id,walk: nudge }]);
    expect(controller.snapshot().state,change).toBe('failed');
    expect(actions.map(action => action.type),change).toEqual(['walk','stop']);
  }
});

it('rejects occupancy routes through blocked cells or blocked diagonal corners on the real map', () => {
  for (const blocked of [{ x: 152,y: 299 },{ x: 151,y: 299 }]) {
    const { controller,actions } = fixture();
    const p = player({ x: 151,y: 300 });
    controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
    expect(controller.snapshot().leg).toEqual([{ x: 151,y: 300 },{ x: 152,y: 301 }]);
    controller.observe([{ type: 'walk',id: p.id,walk: adjacentWalk(p,{ x: 152,y: 301 }) }]);
    controller.observe([{ type: 'walk',id: p.id,walk: adjacentWalk({ x: 152,y: 301 },{ x: 152,y: 300 }) }]);
    expect(controller.snapshot().state).toBe('walking');
    expect(searchGrid('prt_fild08')!.walkable({ x: 152,y: 299 })).toBe(false);
    if (blocked.x === 151) expect(searchGrid('prt_fild08')!.walkable(blocked)).toBe(true);
    controller.observe([{ type: 'walk',id: p.id,walk: adjacentWalk({ x: 152,y: 300 },blocked) }]);
    expect(controller.snapshot().state).toBe('failed');
    expect(actions.map(action => action.type)).toEqual(['walk','stop']);
  }
});

it('rejects an occupancy nudge into or out of a portal even on an otherwise verified corridor', () => {
  for (const y of [374,375]) {
    const { controller,actions } = fixture();
    const p = player({ x: 170,y });
    controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
    const end = { x: 170,y: y + 1 };
    controller.observe([{ type: 'walk',id: p.id,walk: adjacentWalk(p,end) }]);
    controller.observe([{ type: 'walk',id: p.id,walk: adjacentWalk(end,y === 374 ? { x: 170,y: 376 } : p) }]);
    expect(controller.snapshot().state).toBe('failed');
    expect(actions.map(action => action.type)).toEqual(['walk','stop']);
  }
});

it('bounds consecutive occupancy nudges across replanned requests', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 166,y: 353 });
  controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
  for (let i = 0; i < 5; i++) {
    const accepted = adjacentWalk(p,{ x: 167,y: 354 });
    controller.observe([{ type: 'walk',id: p.id,walk: accepted }]);
    advance(walkDuration(accepted) + 50);
    const nudge = adjacentWalk({ x: 167,y: 354 },p);
    controller.observe([{ type: 'walk',id: p.id,walk: nudge }]);
    if (i < 4) {
      expect(controller.snapshot().state).toBe('walking');
      advance(walkDuration(nudge) + 101); controller.tick('prt_fild08',p);
    }
  }
  expect(controller.snapshot().state).toBe('failed');
  expect(actions.filter(action => action.type === 'walk')).toHaveLength(5);
  expect(actions.at(-1)).toEqual({ type: 'stop' });
});

it('retains the original movement deadline and requires the nudged endpoint to settle', () => {
  for (const failure of ['deadline','endpoint'] as const) {
    const { controller,actions,advance } = fixture();
    const p = player({ x: 166,y: 353 });
    controller.start('prt_fild08',p,'prontera',1,false); controller.tick('prt_fild08',p);
    const accepted = adjacentWalk(p,{ x: 167,y: 354 });
    if (failure === 'deadline') { accepted.secondsPerCell = 10; accepted.firstSeconds = 14; }
    controller.observe([{ type: 'walk',id: p.id,walk: accepted }]);
    advance(walkDuration(accepted));
    const nudge = adjacentWalk({ x: 167,y: 354 },p);
    if (failure === 'deadline') { nudge.secondsPerCell = 5; nudge.firstSeconds = 5; }
    controller.observe([{ type: 'walk',id: p.id,walk: nudge }]);
    expect(controller.snapshot().state).toBe('walking');
    advance(walkDuration(nudge) + 101); controller.tick('prt_fild08',player({ x: 167,y: 354 }));
    expect(controller.snapshot().state).toBe('failed');
    expect(controller.snapshot().reason).toContain(failure === 'deadline' ? 'timed out' : 'did not finish');
    expect(actions.map(action => action.type)).toEqual(['walk','stop']);
  }
});

it('keeps first-ACK, corridor and explicit-position guards on portal corrections', () => {
  for (const invalid of ['unacknowledged','outside','unrelated','stop','expired'] as const) {
    const { controller,actions,advance } = fixture();
    const p = player({ x: 170,y: 370 });
    controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
    const cells = controller.snapshot().leg;
    if (invalid !== 'unacknowledged') controller.observe([{ type: 'walk',id: p.id,
      walk: { origin: p,cells,secondsPerCell: 0.15,firstSeconds: 0.15,locked: false } }]);
    if (invalid === 'expired') advance(19_001);
    controller.observe([invalid === 'stop' ? { type: 'stop',id: p.id } : { type: 'position',id: p.id,
      position: invalid === 'outside' ? p : invalid === 'unrelated' ? { x: 171,y: 376 } : cells.at(-1)! }]);
    expect(controller.snapshot().state,invalid).toBe('failed');
    expect(actions.map(action => action.type),invalid).toEqual(['walk','stop']);
  }
});

it('does not turn a portal correction into an inferred arrival or extend its transition wait', () => {
  const { controller,actions,advance } = fixture();
  const p = player({ x: 170,y: 370 });
  controller.start('prt_fild08',p,'prontera',10,false); controller.tick('prt_fild08',p);
  const cells = controller.snapshot().leg;
  controller.observe([{ type: 'walk',id: p.id,walk: { origin: p,cells,secondsPerCell: 0.15,firstSeconds: 0.15,locked: false } },
    { type: 'position',id: p.id,position: cells.at(-1)! }]);
  advance(19_900); controller.tick('prt_fild08',player(cells.at(-1)!));
  expect(controller.snapshot().state).toBe('transition');
  controller.observe([{ type: 'position',id: p.id,position: cells.at(-1)! }]);
  advance(101); controller.tick('prt_fild08',player(cells.at(-1)!));
  expect(controller.snapshot().state).toBe('failed');
  expect(controller.snapshot().reason).toContain('transition was not confirmed');
  expect(actions.map(action => action.type)).toEqual(['walk','stop']);
});

function approachFixture(grid: WalkGrid = { width: 12, height: 12, walkable: () => true }) {
  let clock = 100_000;
  const actions: Action[] = [];
  const controller = new TravelController(action => actions.push(action), () => clock, map => map === 'fixture' ? grid : null);
  const advance = (ms: number) => { clock += ms; };
  const acknowledge = () => {
    const cells = controller.snapshot().leg;
    controller.observe([{ type: 'walk', id: 321, walk: { origin: cells[0]!, cells, secondsPerCell: 0.1, firstSeconds: 0.1, locked: false } }]);
    return cells.at(-1)!;
  };
  const nudge = (from: Position, to: Position) => controller.observe([{ type: 'walk', id: 321, walk: adjacentWalk(from, to) }]);
  return { controller, actions, advance, acknowledge, nudge };
}

it('replans an NPC approach from a settled nudge to its copied original target', () => {
  const { controller, actions, advance, acknowledge, nudge } = approachFixture();
  const target = { x: 8, y: 5 }, start = player({ x: 3, y: 5 });
  controller.startApproach('fixture', start, target, 1);
  target.x = 1;
  controller.tick('fixture', start);
  const end = acknowledge(), shifted = { x: end.x, y: end.y + 1 };
  nudge(end, shifted);
  expect(controller.snapshot().state).toBe('walking');
  advance(301); controller.tick('fixture', player(shifted));
  expect(controller.snapshot().state).toBe('walking');
  expect(controller.snapshot().route.at(-1)).toEqual({ x: 8, y: 5 });
  expect(actions.map(action => action.type)).toEqual(['walk', 'walk']);
  expect(controller.snapshot().reason).toContain('Approaching the NPC');
  let current = player(shifted);
  for (let i = 0; i < 20 && controller.active; i++) {
    current = player(acknowledge()); advance(301); controller.tick('fixture', current);
  }
  expect(current).toMatchObject({ x: 8, y: 5 });
  expect(controller.snapshot().state).toBe('complete');
  expect(controller.snapshot().reason).toBe('Final NPC approach confirmed.');
});

it('rejects NPC approach nudges into injected blocked corners or portal cells', () => {
  for (const restriction of ['corner', 'portal'] as const) {
    const { controller, actions, acknowledge, nudge } = approachFixture({ width: 12, height: 12,
      walkable: p => restriction !== 'corner' || p.x !== 4 || p.y !== 6,
      portals: restriction === 'portal' ? [{ x: 4, y: 6, halfWidth: 0, halfHeight: 0 }] : [] });
    const start = player({ x: 3, y: 5 });
    controller.startApproach('fixture', start, { x: 4, y: 5 }, 20); controller.tick('fixture', start);
    const end = acknowledge(); expect(end).toEqual({ x: 4, y: 5 });
    nudge(end, restriction === 'corner' ? { x: 5, y: 6 } : { x: 4, y: 6 });
    expect(controller.snapshot().state, restriction).toBe('failed');
    expect(actions.map(action => action.type)).toEqual(['walk', 'stop']);
  }
});

it('resets the nudge allowance when a new NPC approach is explicitly started', () => {
  const { controller, advance, acknowledge, nudge } = approachFixture();
  const start = player({ x: 3, y: 5 });
  controller.startApproach('fixture', start, { x: 8, y: 5 }, 1); controller.tick('fixture', start);
  for (let i = 0; i < 4; i++) {
    const end = acknowledge(); nudge(end, start); advance(301); controller.tick('fixture', start);
    expect(controller.snapshot().state).toBe('walking');
  }
  controller.cancel();
  controller.startApproach('fixture', start, { x: 8, y: 5 }, 1); controller.tick('fixture', start);
  nudge(acknowledge(), start); advance(301); controller.tick('fixture', start);
  expect(controller.snapshot().state).toBe('walking');
});

it('retains the original five-minute deadline after an NPC approach nudge', () => {
  const { controller, advance, acknowledge, nudge } = approachFixture();
  const start = player({ x: 3, y: 5 });
  controller.startApproach('fixture', start, { x: 8, y: 5 }, 1);
  advance(299_000); controller.tick('fixture', start);
  nudge(acknowledge(), start); advance(301); controller.tick('fixture', start);
  expect(controller.snapshot().state).toBe('walking');
  advance(700); controller.tick('fixture', start);
  expect(controller.snapshot().state).toBe('failed');
  expect(controller.snapshot().reason).toContain('five-minute');
});

it('enforces the original 512-cell approach bound after an off-corridor nudge', () => {
  const { controller, advance, acknowledge, nudge } = approachFixture({ width: 512, height: 3,
    walkable: p => p.y === 0 || p.y === 1 && p.x <= 1 || p.x === 0 && p.y === 2 });
  const start = player({ x: 0, y: 0 });
  controller.startApproach('fixture', start, { x: 511, y: 0 }, 1); controller.tick('fixture', start);
  expect(acknowledge()).toEqual({ x: 1, y: 0 });
  nudge({ x: 1, y: 0 }, { x: 1, y: 1 });
  nudge({ x: 1, y: 1 }, { x: 0, y: 1 });
  nudge({ x: 0, y: 1 }, { x: 0, y: 2 });
  advance(301); controller.tick('fixture', player({ x: 0, y: 2 }));
  expect(controller.snapshot().state).toBe('failed');
  expect(controller.snapshot().reason).toContain('512 cells');
});

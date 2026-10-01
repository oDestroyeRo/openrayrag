import { expect, it } from 'vitest';
import { type Action } from './engine';
import { walkDuration } from './movement';
import { type Entity, type Position, type Walk } from './protocol';
import { searchGrid } from './navigation';
import { TravelController } from './travel-controller';

const player = (p: Position): Entity => ({ ...p,id: 321,classId: 0,name: 'Fixture',kind: 0,
  hp: 100,maxHp: 100,level: 9,dead: false });
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

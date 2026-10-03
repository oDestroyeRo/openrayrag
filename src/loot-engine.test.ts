import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { CompanionController, type ControllerAction } from './controller';
import { BotEngine, type Action } from './engine';
import { DEFAULT_MAP_POLICY } from './map-policy';
import type { WalkGrid } from './navigation';
import { decode, OP, type Drop, type Entity, type GameEvent } from './protocol';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, type Settings } from './settings';

const player: Entity = { id: 1, kind: 0, classId: 0, name: 'Test', level: 7, hp: 100, maxHp: 100, x: 100, y: 100, dead: false };
const monster: Entity = { id: 2, kind: 1, classId: 4000, name: 'Poring', level: 1, hp: 100, maxHp: 100, x: 101, y: 100, dead: false };
const drop: Drop = { id: 9000, itemId: 909, count: 2, isNew: true, x: 101.2, y: 100.2 };
const grid: WalkGrid = { width: 200, height: 200, walkable: () => true };
const settings = (): Settings => ({ ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], automation: structuredClone(DEFAULT_AUTOMATION) });
function setup(options: { selfId?: number; targetId?: number; grid?: WalkGrid } = {}) {
  let now = 100_000;
  const sent: Action[] = [];
  const selfId = options.selfId ?? 1, targetId = options.targetId ?? 2;
  const engine = new BotEngine(action => sent.push(action), () => now, () => options.grid ?? grid);
  const receive = (...events: GameEvent[]) => engine.receive(events);
  engine.connect(true);
  receive({ type: 'enter', id: selfId, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player, id: selfId } }, { type: 'spawn', entity: { ...monster, id: targetId } });
  const packet = (writer: BitWriter) => receive(...decode(writer.finish()));
  const advance = (ms: number) => { now += ms; };
  const step = (ms = 100) => { advance(ms); engine.tick(); };
  const pickups = () => sent.filter(action => action.type === 'pickup');
  const start = (input = settings()) => { engine.start(input); step(); };
  const announce = (extra: Partial<Drop> = {}) => receive({ type: 'drop', drop: { ...drop, ...extra } });
  const kill = () => receive({ type: 'remove', id: targetId, dead: true });
  return { engine, sent, receive, packet, advance, step, pickups, start, announce, kill, selfId, targetId };
}
function newDropPacket(item = drop): BitWriter {
  return new BitWriter().u8(OP.drop).i32(item.id).f32(item.x).f32(item.y).i32(item.itemId).i16(item.count).u8(item.isNew ? 1 : 0);
}

describe('source-ordered own loot evidence', () => {
  it.each([0, 1, 1500])('collects a new drop announced %s ms before the confirmed owned death', gap => {
    const f = setup(); f.start();
    f.packet(newDropPacket()); f.advance(gap);
    f.packet(new BitWriter().u8(OP.remove).i32(f.targetId).u8(3));
    expect(f.engine.kills).toBe(1); f.step(150);
    expect(f.pickups()).toEqual([{ type: 'pickup', id: drop.id }]);
    expect(f.engine.looted).toBe(0);
    f.packet(new BitWriter().u8(OP.pickup).i32(f.selfId).i32(drop.id));
    expect(f.engine.looted).toBe(1); expect(f.engine.snapshot().lootStats).toEqual([{ itemId: 909, count: 2 }]);
  });
  it.each([{ selfId: 0, targetId: 2 }, { selfId: 1, targetId: 0 }])('uses actual actor zero in source-shaped death/drop/pickup receipts (%j)', ids => {
    const f = setup(ids); f.start();
    f.packet(new BitWriter().u8(OP.attack).i32(f.selfId).i32(f.targetId).i32(10).position({ x: 100, y: 100 }));
    f.packet(newDropPacket()); f.advance(1);
    f.packet(new BitWriter().u8(OP.remove).i32(f.targetId).u8(3)); f.step(150);
    expect(f.pickups()).toHaveLength(1);
    f.packet(new BitWriter().u8(OP.pickup).i32(f.selfId).i32(drop.id)); expect(f.engine.looted).toBe(1);
  });
  it('preserves the existing post-death announcement path', () => {
    const f = setup(); f.start(); f.kill(); f.advance(1500); f.announce(); f.step();
    expect(f.pickups()).toHaveLength(1);
  });
  it('does not associate an older drop beyond the conservative pre-death window', () => {
    const f = setup(); f.start(); f.announce(); f.advance(2001); f.kill(); f.step(150);
    expect(f.engine.kills).toBe(1); expect(f.pickups()).toEqual([]);
  });
  it.each(['pre-existing', 'old reveal', 'duplicate'] as const)('does not turn a %s drop into owned loot near a later kill', kind => {
    const f = setup();
    if (kind === 'pre-existing' || kind === 'duplicate') f.announce();
    f.start();
    if (kind === 'old reveal') f.announce({ isNew: false });
    if (kind === 'duplicate') f.announce();
    f.kill(); f.step(150); expect(f.pickups()).toEqual([]);
  });
  it('does not infer pre-death ownership from proximity alone', () => {
    const f = setup(); f.announce(); f.start(); f.kill(); f.step(150);
    expect(f.engine.kills).toBe(1); expect(f.pickups()).toEqual([]);
  });
  it('does not associate another monster\'s nearby new drop with a later owned kill', () => {
    const f = setup();
    f.receive({ type: 'spawn', entity: { ...monster, id: 3 } });
    f.engine.start(settings()); f.announce(); f.step(); f.kill(); f.step(150);
    expect(f.pickups()).toEqual([]);
  });
  it('does not credit a foreign-engaged or canceled attack as an own kill', () => {
    for (const boundary of ['foreign', 'cancel'] as const) {
      const f = setup(); f.start(); f.announce();
      if (boundary === 'foreign') f.receive({ type: 'attack', source: 99, target: 2, position: { x: 101, y: 100 } });
      else f.engine.stop();
      f.kill();
      if (boundary === 'cancel') f.engine.resumeRequested();
      f.step(150); expect(f.engine.kills).toBe(0); expect(f.pickups()).toEqual([]);
    }
  });
  it('retains the dispatched target lifetime after an authoritative zero-HP hit until death removal', () => {
    const f = setup(); f.start();
    f.receive({ type: 'hit', id: 2, damage: 100, position: { x: 101, y: 100 } });
    f.announce(); f.advance(1); f.kill(); f.step(150);
    expect(f.engine.kills).toBe(1); expect(f.pickups()).toHaveLength(1);
  });
  it('correlates a pre-death drop after a confirmed owned damaging skill, without inventing a basic attack', () => {
    const f = setup();
    f.receive({ type: 'spawn', entity: { ...player, classId: 2, statuses: [], sp: 100, maxSp: 100 } },
      { type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 }, { type: 'skills', learned: [{ skillId: 11, level: 1 }] });
    const input = settings(); input.automation!.attackStrategies = [{ id: 'opening-bolt', speciesIds: [4000], skillId: 11, level: 1, behavior: 'opener', maxAttempts: 1, maxUses: 1, cooldownSeconds: 1 }];
    f.start(input); expect(f.sent).toEqual([{ type: 'skill', mode: 'target', skillId: 11, level: 1, target: 2 }]);
    f.receive({ type: 'skillResult', mode: 'target', source: 1, target: 2, skillId: 11, level: 1, position: { x: 100, y: 100 }, damage: 100, motionSeconds: 0, indirect: false });
    f.announce(); f.advance(1); f.kill(); f.step(1100);
    expect(f.engine.kills).toBe(1); expect(f.pickups()).toHaveLength(1); expect(f.sent.some(action => action.type === 'attack')).toBe(false);
  });
  it('does not reuse pre-death evidence for a replacement monster with the same ID', () => {
    const f = setup(); f.start(); f.announce();
    f.receive({ type: 'spawn', entity: { ...monster } }, { type: 'stop', id: 1 }); f.step();
    expect(f.sent.filter(action => action.type === 'attack')).toHaveLength(2);
    f.kill(); f.step(150); expect(f.engine.kills).toBe(1); expect(f.pickups()).toEqual([]);
  });
  it.each(['item', 'count', 'position'] as const)('does not transfer new-drop evidence to changed same-ID %s metadata', change => {
    const f = setup(); f.start(); f.announce();
    f.announce({ isNew: false, ...(change === 'item' ? { itemId: 501 } : change === 'count' ? { count: 99 } : { x: 101.8 }) });
    f.kill(); f.step(150); expect(f.engine.kills).toBe(1); expect(f.pickups()).toEqual([]);
  });
  it('retains evidence through an identical old-reveal announcement without changing its creation time', () => {
    const f = setup(); f.start(); f.announce(); f.advance(1500); f.announce({ isNew: false }); f.advance(501);
    f.kill(); f.step(150); expect(f.engine.kills).toBe(1); expect(f.pickups()).toEqual([]);
  });
  it.each([0, 2])('retires the old target lifetime before resurrection of actor %s can grant death credit', targetId => {
    const f = setup({ targetId }); f.start(); f.announce();
    f.receive({ type: 'resurrection', id: targetId, hp: 100, position: { x: 101, y: 100 } });
    f.kill(); f.step(150); expect(f.engine.kills).toBe(0); expect(f.pickups()).toEqual([]);
    expect(f.sent.filter(action => action.type === 'attack')).toHaveLength(1);
  });
  it('keeps already confirmed loot when a new monster lifetime uses the old ID', () => {
    const f = setup(); f.start(); f.announce(); f.kill();
    f.receive({ type: 'spawn', entity: { ...monster, x: 180 } }); f.step(150);
    expect(f.pickups()).toHaveLength(1);
  });
  it.each(['self replacement', 'self removal', 'resurrection', 'clear', 'map', 'reconnect'] as const)('clears confirmed history at %s', boundary => {
    const f = setup(); f.start(); f.announce(); f.kill(); f.engine.stop();
    if (boundary === 'self replacement') f.receive({ type: 'spawn', entity: { ...player } });
    else if (boundary === 'self removal') f.receive({ type: 'remove', id: 1, dead: false }, { type: 'spawn', entity: { ...player } });
    else if (boundary === 'resurrection') f.receive({ type: 'death', id: 1 }, { type: 'resurrection', id: 1, hp: 100, position: { x: 100, y: 100 } });
    else if (boundary === 'clear') f.receive({ type: 'clear' }, { type: 'spawn', entity: { ...player } });
    else if (boundary === 'map') f.receive({ type: 'map', map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } });
    else { f.engine.disconnect(); f.engine.connect(true); f.receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }); }
    f.engine.resumeRequested(); f.announce(); f.step(150); expect(f.pickups()).toEqual([]);
  });
  it('keeps confirmed evidence and delayed new announcements across same-lifetime temporary resumes', () => {
    for (const announced of ['before pause', 'during pause'] as const) {
      const f = setup(); f.start();
      if (announced === 'before pause') f.announce();
      f.kill(); f.engine.stop(); f.advance(2000);
      if (announced === 'during pause') f.announce();
      f.engine.resumeRequested(); f.step(); expect(f.pickups()).toHaveLength(1); expect(f.engine.kills).toBe(1);
    }
  });
  it('expires paused history and clears it on a deliberate new Start', () => {
    for (const fresh of [false, true]) {
      const f = setup(); f.start(); f.announce(); f.kill(); f.engine.stop();
      if (fresh) f.engine.start(settings());
      else { f.advance(30_001); f.engine.resumeRequested(); }
      f.step(); expect(f.pickups()).toEqual([]);
    }
  });
  it('bounds new-drop correlation and never promotes an evicted observation to ownership', () => {
    const f = setup(); f.start();
    for (let id = 9000; id <= 9256; id++) f.announce({ id });
    f.kill(); f.step(150); expect(f.pickups()).toEqual([{ type: 'pickup', id: 9001 }]);
  });
});

describe('loot-all retains field and receipt guards', () => {
  function all(extra: Partial<Settings> = {}) { const input = { ...settings(), ...extra }; input.automation!.loot.ownership = 'all'; return input; }
  it('opts into reachable observed old drops without claiming a kill or success on send', () => {
    const f = setup(); f.receive({ type: 'remove', id: 2, dead: false }); f.announce({ isNew: false }); f.start(all());
    expect(f.pickups()).toEqual([{ type: 'pickup', id: drop.id }]); expect(f.engine.kills).toBe(0); expect(f.engine.looted).toBe(0);
    f.step(); f.step(1000); expect(f.pickups()).toHaveLength(1);
    f.receive({ type: 'pickup', id: drop.id, picker: 99 }); expect(f.engine.looted).toBe(0);
  });
  it.each(['master off', 'item ignore', 'default ignore', 'radius', 'area', 'weight unknown', 'weight reserve'] as const)('still refuses a drop at %s', guard => {
    const f = setup(); f.receive({ type: 'remove', id: 2, dead: false }); f.announce(); const input = all();
    if (guard === 'master off') input.loot = false;
    else if (guard === 'item ignore') input.automation!.loot.rules = [{ itemId: 909, action: 'ignore', priority: 100 }];
    else if (guard === 'default ignore') input.automation!.loot.defaultAction = 'ignore';
    else if (guard === 'radius') f.announce({ id: 9001, x: 140 });
    else if (guard === 'area') input.automation!.mapPolicy = { ...structuredClone(DEFAULT_MAP_POLICY), lockArea: { map: 'prt_fild08', minX: 90, minY: 90, maxX: 100, maxY: 110 } };
    else { input.automation!.limits.weightPercent = 80; if (guard === 'weight reserve') f.receive({ type: 'stats', hp: 100, maxHp: 100, level: 7, weight: 800, maxWeight: 1000 }); }
    if (guard === 'radius') f.receive({ type: 'pickup', id: drop.id, picker: -1 });
    f.start(input); expect(f.pickups()).toEqual([]); expect(f.sent.some(action => action.type === 'walk')).toBe(false);
  });
  it.each(['disconnected', 'portal', 'corner', 'path cap'] as const)('does not bypass %s walking restrictions', guard => {
    const mapGrid: WalkGrid = guard === 'disconnected' ? { ...grid, walkable: p => p.x !== 101 }
      : guard === 'corner' ? { ...grid, walkable: p => p.x === 100 && p.y === 100 || p.x === 102 && p.y === 102 }
      : guard === 'portal' ? { ...grid, portals: [{ x: 104, y: 100, halfWidth: 0, halfHeight: 0 }] }
      : grid;
    const f = setup({ grid: mapGrid }); f.receive({ type: 'remove', id: 2, dead: false });
    f.announce({ x: guard === 'corner' ? 102 : 104, y: guard === 'corner' ? 102 : 100 });
    f.start(all(guard === 'path cap' ? { attackRouteMaxPathDistance: 1 } : {}));
    expect(f.pickups()).toEqual([]); expect(f.sent.some(action => action.type === 'walk')).toBe(false);
  });
  it('waits for the accepted walking leg and exact pickup receipt before counting or acquiring another owner', () => {
    const f = setup(); f.receive({ type: 'remove', id: 2, dead: false }); f.announce({ x: 104, y: 100 }); f.start(all());
    expect(f.sent[0]?.type).toBe('walk'); const cells = f.engine.snapshot().navigation!.leg;
    f.receive({ type: 'walk', id: 1, walk: { origin: cells[0]!, cells, secondsPerCell: .5, firstSeconds: .5, locked: false } });
    f.step(500); expect(f.pickups()).toEqual([]); f.step(1200); expect(f.pickups()).toHaveLength(1);
    f.receive({ type: 'spawn', entity: { ...monster, id: 3 } }); f.step(); expect(f.sent.filter(action => action.type === 'attack')).toEqual([]);
    f.receive({ type: 'pickup', id: 9001, picker: 1 }); expect(f.engine.looted).toBe(0);
    f.receive({ type: 'pickup', id: drop.id, picker: 1 }); f.receive({ type: 'pickup', id: drop.id, picker: 1 });
    expect(f.engine.looted).toBe(1); f.step(); expect(f.sent.at(-1)).toEqual({ type: 'attack', id: 3 });
  });
  it('does not flood retries when the server refuses or fails to acknowledge pickup', () => {
    const f = setup(); f.receive({ type: 'remove', id: 2, dead: false }); f.announce(); f.start(all());
    for (let n = 0; n < 14; n++) { f.receive(); f.step(1000); }
    expect(f.pickups()).toHaveLength(1); expect(f.engine.looted).toBe(0); expect(f.sent.at(-1)).toEqual({ type: 'stop' });
  });
  it('keeps a contradictory in-flight drop receipt owned without crediting changed item metadata', () => {
    const f = setup(); f.receive({ type: 'remove', id: 2, dead: false }); f.announce(); f.start(all());
    f.announce({ itemId: 501, count: 99, isNew: false });
    f.announce(); // Returning to old metadata is not fresh receipt ownership.
    f.receive({ type: 'spawn', entity: { ...monster, id: 3 } }); f.step(1000);
    expect(f.pickups()).toHaveLength(1); expect(f.sent.filter(action => action.type === 'attack')).toEqual([]);
    f.receive({ type: 'pickup', id: drop.id, picker: 1 });
    expect(f.engine.looted).toBe(0); expect(f.engine.snapshot().lootStats).toEqual([]);
  });
  it.each([0, 1])('does not credit an old pickup after replacement of own actor %s', selfId => {
    const f = setup({ selfId }); f.receive({ type: 'remove', id: 2, dead: false }); f.announce(); f.start(all());
    f.receive({ type: 'spawn', entity: { ...player, id: selfId } }, { type: 'pickup', id: drop.id, picker: selfId });
    expect(f.engine.looted).toBe(0); expect(f.engine.snapshot().lootStats).toEqual([]); expect(f.pickups()).toHaveLength(1);
  });
  it('does not admit loot-all on a policy-denied current map', () => {
    const f = setup(); f.announce(); const input = all(); input.automation!.mapPolicy = { ...structuredClone(DEFAULT_MAP_POLICY), deny: ['prt_fild08'] };
    expect(() => f.engine.start(input)).toThrow('allowed field'); expect(f.sent).toEqual([]);
  });
});

describe('real temporary-yield loot continuity', () => {
  it('keeps confirmed own evidence across a real official-command pause without retrying or counting on send', () => {
    let now = 100_000; const sent: Array<Action | ControllerAction> = [];
    const controller = new CompanionController(action => sent.push(action), () => now, () => grid);
    controller.connect(true);
    controller.engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } }]);
    controller.world.reset('prt_fild08'); controller.start(settings()); now += 100; controller.tick();
    controller.receive(newDropPacket().finish()); now++;
    controller.receive(new BitWriter().u8(OP.remove).i32(2).u8(3).finish());
    controller.manualCommand(); expect(controller.runRequested).toBe(true); expect(controller.engine.running).toBe(true);
    for (let n = 0; n < 19; n++) { now += 100; controller.tick(); }
    expect(sent.filter(action => action.type === 'pickup')).toEqual([{ type: 'pickup', id: drop.id }]);
    now += 200; controller.tick(); now += 100; controller.tick();
    expect(sent.filter(action => action.type === 'pickup')).toEqual([{ type: 'pickup', id: drop.id }]);
    expect(controller.engine.kills).toBe(1); expect(controller.engine.looted).toBe(0);
    controller.receive(new BitWriter().u8(OP.pickup).i32(1).i32(drop.id).finish()); expect(controller.engine.looted).toBe(1);
  });
  it('records source-ordered loot while panel input yields decisions without canceling its sent attack', () => {
    let now = 100_000; const sent: Array<Action | ControllerAction> = [];
    const controller = new CompanionController(action => sent.push(action), () => now, () => grid);
    controller.connect(true); controller.engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } }]);
    controller.world.reset('prt_fild08'); controller.start(settings()); now += 100; controller.tick(); controller.manualInput();
    controller.receive(newDropPacket().finish()); now++; controller.receive(new BitWriter().u8(OP.remove).i32(2).u8(3).finish());
    for (let n = 0; n < 19; n++) { now += 100; controller.tick(); }
    expect(controller.engine.running).toBe(true); expect(controller.engine.kills).toBe(1); expect(sent).toEqual([{ type: 'attack', id: 2 }, { type: 'pickup', id: drop.id }]);
    now += 200; controller.tick(); expect(sent).toEqual([{ type: 'attack', id: 2 }, { type: 'pickup', id: drop.id }]);
    controller.receive(new BitWriter().u8(OP.pickup).i32(1).i32(drop.id).finish()); expect(controller.engine.looted).toBe(1);
  });
  it('clears paused evidence at a deliberate controller Start', () => {
    let now = 100_000; const sent: Array<Action | ControllerAction> = [];
    const controller = new CompanionController(action => sent.push(action), () => now, () => grid);
    controller.connect(true); controller.engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } }]);
    controller.world.reset('prt_fild08'); controller.start(settings()); now += 100; controller.tick();
    controller.receive(newDropPacket().finish()); now++; controller.receive(new BitWriter().u8(OP.remove).i32(2).u8(3).finish());
    controller.stop(); controller.start(settings()); now += 200; controller.tick();
    expect(controller.engine.kills).toBe(1); expect(sent.filter(action => action.type === 'pickup')).toEqual([]);
  });
});

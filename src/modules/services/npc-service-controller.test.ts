import { describe, expect, it } from 'vitest';
import { CompanionController } from '../runtime/controller';
import { BUILTIN_SERVICES } from './npc-services';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_SETTINGS } from '../settings/settings';
import { BitWriter } from '../../shared/binary';
import { OP, type Entity, type Position } from '../protocol/protocol';
import { FEATURE_OP } from '../protocol/protocol-feature';
import { WORLD_OP, type WorldAction } from '../protocol/world-protocol';
import type { Action } from '../automation/engine';
const player: Entity = {
  id: 1,
  classId: 1,
  name: 'Tester',
  kind: 0,
  level: 10,
  hp: 100,
  maxHp: 100,
  x: 150,
  y: 28,
  dead: false,
};
const npc: Entity = { ...player, id: 20, classId: 50, name: 'Kafra Staff', kind: 2, x: 151, y: 29 };
const storage = BUILTIN_SERVICES[0]!,
  transport = BUILTIN_SERVICES[1]!;
function spawn(entity: Entity, entryType = 0): Uint8Array {
  const name = new TextEncoder().encode(entity.name);
  const body = new BitWriter()
    .u8(15)
    .i32(entity.id)
    .i32(entity.classId)
    .i32(0)
    .i32(~name.length)
    .i32(entity.name.length)
    .take(name)
    .u8(entity.kind)
    .u8(0)
    .u8(entity.dead ? 3 : 0)
    .i32(entity.x)
    .i32(entity.y)
    .u8(entity.level)
    .i32(entity.hp)
    .i32(entity.maxHp)
    .i32(100)
    .i32(100)
    .i32(-1)
    .u8(entity.id === 1 ? 1 : 0)
    .finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
function stats(hp = 100, zeny = 500): Uint8Array {
  const w = new BitWriter().u8(FEATURE_OP.stats);
  for (const n of [
    10,
    1,
    zeny,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    hp,
    100,
    100,
    100,
    ...Array(16).fill(0),
    1000,
  ])
    w.i32(n);
  w.f32(0.4)
    .i32(20)
    .i32(0)
    .bool(true)
    .i16(1)
    .i16(1)
    .u8(5)
    .i16(0)
    .bool(true)
    .u8(1)
    .i32(1)
    .i32(601)
    .i16(5)
    .i32(0)
    .u8(0);
  for (let i = 0; i < 10; i++) w.i32(0);
  return w.i32(-1).finish();
}
function walk(cells: Position[]): Uint8Array {
  const w = new BitWriter()
    .u8(OP.walk)
    .i32(1)
    .i16(cells[0]!.x)
    .i16(cells[0]!.y)
    .f32(cells[0]!.x)
    .f32(cells[0]!.y)
    .f32(0.05)
    .f32(0)
    .u8(cells.length);
  const dirs = [
    [0, -1],
    [-1, -1],
    [-1, 0],
    [-1, 1],
    [0, 1],
    [1, 1],
    [1, 0],
    [1, -1],
  ];
  const d = cells
    .slice(1)
    .map((p, i) => dirs.findIndex(([x, y]) => p.x - cells[i]!.x === x && p.y - cells[i]!.y === y));
  for (let i = 0; i < d.length; i += 2) w.u8((d[i]! << 4) | (d[i + 1] ?? 0));
  return w.u8(0).finish();
}
function setup(map = 'prontera', position: Position = player) {
  let now = 100_000;
  const sent: Array<Action | WorldAction> = [];
  const controller = new CompanionController(
    (a) => sent.push(a),
    () => now,
  );
  const packet = (data: Uint8Array) => controller.receive(data);
  controller.connect(true);
  packet(new BitWriter().u8(OP.enter).i32(1).string(map).finish());
  packet(spawn({ ...player, ...position }));
  packet(stats());
  if (map === 'prontera') packet(spawn(npc));
  const step = (ms = 100) => {
    now += ms;
    controller.tick();
  };
  const settleWalk = () => {
    const leg = controller.travel.snapshot().leg;
    expect(leg.length).toBeGreaterThan(1);
    packet(walk(leg));
    step(2000);
  };
  const dialogue = (name: string, text: string) =>
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string(name).string(text).bool(false).finish());
  const options = (labels: string[]) => {
    const w = new BitWriter().u8(WORLD_OP.npc).u8(2).i32(labels.length);
    for (const label of labels) w.string(label);
    packet(w.finish());
  };
  const begin = (definition = storage) => {
    controller.perform('service', definition);
    step();
    step();
    step();
  };
  const final = (definition = storage) => {
    begin(definition);
    packet(new BitWriter().u8(WORLD_OP.npc).u8(0).i32(20).bool(true).finish());
    const d = definition.workflow.steps[1]!;
    if (d.type !== 'advance') throw Error();
    dialogue(d.exactDialogue!.name, d.exactDialogue!.text);
    step();
    const o = definition.workflow.steps[2]!;
    if (o.type !== 'option') throw Error();
    options(o.expectedOptions![0]!);
    step();
    if (definition.outcome.type === 'arrival') {
      const d = definition.workflow.steps[3]!;
      if (d.type !== 'advance') throw Error();
      dialogue(d.exactDialogue!.name, d.exactDialogue!.text);
      step();
      const o = definition.workflow.steps[4]!;
      if (o.type !== 'option') throw Error();
      options(o.expectedOptions![0]!);
      step();
    }
    expect(controller.service.snapshot().state).toBe('outcome');
  };
  return { controller, sent, packet, step, settleWalk, begin, final };
}
describe('controller NPC service ownership and cancellation', () => {
  it('replaces combat intent on explicit visit and forbids another action owner', () => {
    const f = setup();
    f.controller.start({ ...DEFAULT_SETTINGS, map: 'prontera', targets: [4000] });
    expect(f.controller.runRequested).toBe(true);
    f.begin();
    expect(f.controller.snapshot()).toMatchObject({
      runRequested: false,
      service: { active: true },
    });
    expect(() => f.controller.perform('command', { type: 'npcTalk', id: 20 })).toThrow();
    expect(() =>
      f.controller.start({ ...DEFAULT_SETTINGS, map: 'prontera', targets: [4000] }),
    ).toThrow();
  });
  it('uses intermap travel then a confirmed final approach before resolving or talking', () => {
    const f = setup('prt_fild08', { x: 156, y: 376 });
    f.controller.perform('service', storage);
    f.step();
    f.step();
    expect(f.controller.service.snapshot().state).toBe('travel');
    expect(f.sent.filter((a) => a.type === 'npcTalk')).toEqual([]);
    const portal = f.controller.travel.snapshot().remainingMaps[0];
    expect(portal).toBe('prontera');
    for (let i = 0; i < 30 && f.controller.travel.snapshot().state === 'walking'; i++) {
      if (f.controller.travel.snapshot().leg.length) f.settleWalk();
      else f.step();
    }
    f.packet(new BitWriter().u8(OP.map).string('prontera').finish());
    expect(f.controller.travel.snapshot().state, f.controller.travel.snapshot().reason).toBe(
      'transition',
    );
    f.packet(spawn({ ...player, x: 156, y: 26 }, 2));
    f.packet(spawn(npc));
    for (let i = 0; i < 12 && f.controller.service.snapshot().state !== 'conversation'; i++) {
      f.step();
      if (f.controller.travel.snapshot().leg.length) f.settleWalk();
    }
    expect(f.controller.service.snapshot().state, f.controller.service.snapshot().reason).toBe(
      'conversation',
    );
    expect(f.sent.at(-1)).toEqual({ type: 'npcTalk', id: 20 });
    expect(f.sent.filter((a) => a.type === 'walk').length).toBeGreaterThan(0);
  });
  it('holds a stopped final service receipt through expected map/reset; late arrival never resumes', () => {
    const f = setup();
    f.final(transport);
    f.controller.stop();
    const count = f.sent.length;
    f.packet(new BitWriter().u8(OP.map).string('izlude').finish());
    expect(() => f.controller.perform('service', storage)).toThrow();
    f.packet(spawn({ ...player, x: 91, y: 105 }, 2));
    f.step();
    expect(f.controller.service.snapshot().state).toBe('cancelled');
    expect(f.sent).toHaveLength(count);
    expect(f.controller.runRequested).toBe(false);
    // Receipt may settle, but the previous send deadline remains a quarantine.
    f.step(1000);
    expect(() => f.controller.perform('service', storage)).toThrow();
  });
  it('preserves an unconfirmed fee contradiction across Stop/map and blocks a new service', () => {
    const f = setup();
    f.final(transport);
    f.packet(new BitWriter().u8(FEATURE_OP.currency).i32(499).finish());
    f.controller.stop();
    f.packet(new BitWriter().u8(OP.map).string('izlude').finish());
    f.packet(spawn({ ...player, x: 91, y: 105 }, 2));
    for (let i = 0; i < 40; i++) f.step(1000);
    f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(100).i32(100).finish());
    expect(() => f.controller.perform('service', storage)).toThrow(/transaction|unresolved/);
    expect(f.controller.service.snapshot().state).toBe('cancelled');
  });
  it('blocks service admission while the real sent escape receipt survives Stop and map reset', () => {
    const f = setup();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.escape = { ...DEFAULT_ESCAPE, enabled: true };
    f.controller.start({ ...DEFAULT_SETTINGS, map: 'prontera', targets: [4000], automation });
    f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(20).i32(100).finish());
    f.step(250);
    expect(f.sent.filter((a) => a.type === 'useItem')).toEqual([{ type: 'useItem', itemId: 601 }]);
    expect(f.controller.escape.busy).toBe(true);
    f.controller.stop();
    f.packet(new BitWriter().u8(OP.map).string('izlude').finish());
    f.packet(spawn({ ...player, name: 'Other', x: 91, y: 105 }, 2));
    expect(f.controller.escape.busy).toBe(true);
    expect(() => f.controller.perform('service', storage)).toThrow(/transaction|unresolved/);
    expect(f.sent.filter((a) => a.type === 'npcTalk')).toEqual([]);
  });
  it('escape cannot preempt a service transaction and Stop prevents its next dialogue action', () => {
    const f = setup();
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.escape = { ...DEFAULT_ESCAPE, enabled: true };
    f.controller.start({ ...DEFAULT_SETTINGS, map: 'prontera', targets: [4000], automation });
    f.begin();
    f.packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(20).i32(100).finish());
    f.step(1000);
    expect(f.sent.filter((a) => a.type === 'useItem' || a.type === 'skill')).toEqual([]);
    expect(f.controller.service.snapshot().active).toBe(true);
    f.controller.stop();
    const count = f.sent.length;
    f.packet(
      new BitWriter().u8(WORLD_OP.npc).u8(1).string('Kafra').string('Late').bool(false).finish(),
    );
    f.step();
    expect(f.sent).toHaveLength(count);
    expect(f.controller.service.snapshot().state).toBe('cancelled');
  });
});

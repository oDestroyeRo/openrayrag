import { afterEach, describe, expect, it, vi } from 'vitest';
import { BitWriter } from '../../shared/binary';
import { CompanionController } from './controller';
import * as protocol from '../protocol/protocol';
import * as worldProtocol from '../protocol/world-protocol';

function fixture() {
  const controller = new CompanionController(() => {}, () => 100_000, () => null);
  controller.connect(true);
  return controller;
}
const enter = (id = 0) => new BitWriter().u8(protocol.OP.enter).i32(id).string('prt_fild08').finish();
function spawn() {
  const name = new TextEncoder().encode('Synthetic');
  const body = new BitWriter().u8(15).i32(0).i32(6).i32(0).i32(~name.length).i32(name.length).take(name)
    .u8(0).u8(0).u8(0).i32(100).i32(100).u8(15).i32(100).i32(100).i32(200).i32(200).i32(0).u8(0).finish();
  return new BitWriter().u8(protocol.OP.spawn).u8(1).i32(body.length).take(body).finish();
}
function resources(full: boolean) {
  const writer = new BitWriter().u8(56);
  for (const value of [15,15,10000,1,1,1,1,1,1,0,0,0]) writer.i32(value);
  for (const value of [100,100,200,200,...Array(16).fill(1),2000]) writer.i32(value);
  writer.f32(.5).i32(100).i32(0).bool(full);
  if (full) writer.i16(0).i16(0);
  writer.bool(full);
  if (full) {
    writer.u8(1).i32(0).i32(0).u8(0);
    for (let index = 0; index < 10; index++) writer.i32(0);
    writer.i32(-1);
  }
  return writer.finish();
}
afterEach(() => vi.restoreAllMocks());

describe('controller packet observation', () => {
  it('validates both decoders before observation, applies afterwards and returns after the immediate tick', () => {
    const controller = fixture(), order: string[] = [];
    const general = vi.spyOn(protocol, 'decode'), world = vi.spyOn(worldProtocol, 'decodeWorld');
    const receive = controller.engine.receive.bind(controller.engine);
    vi.spyOn(controller.engine, 'receive').mockImplementation(events => { order.push('apply'); receive(events); });
    vi.spyOn(controller, 'tick').mockImplementation(() => { order.push('tick'); });
    const observation = controller.receive(enter(), controller.connectionGeneration, facts => {
      expect(general).toHaveBeenCalledOnce();expect(world).toHaveBeenCalledOnce();
      expect(controller.engine.playerId).not.toBe(0);expect(facts.enter).toBe(true);
      order.push('before');
    });
    order.push('returned');
    expect(order).toEqual(['before', 'apply', 'tick', 'returned']);
    expect(controller.engine.playerId).toBe(0);
    expect(observation).toMatchObject({opcode:protocol.OP.enter,enter:true,map:false,clear:false,fullResources:false,memoSlots:false,spawns:[]});
  });

  it('returns detached spawn facts that cannot mutate the retained actor', () => {
    const controller = fixture();controller.receive(enter());
    const observation = controller.receive(spawn());
    expect(observation?.spawns).toEqual([{id:0,kind:0,entryType:1}]);
    const own = observation!.spawns[0]!;
    expect(Object.keys(own).sort()).toEqual(['entryType','id','kind']);
    expect(Reflect.set(own, 'id', 9)).toBe(false);
    controller.engine.player!.classId = 7;controller.engine.player!.hp = 10;
    expect(own).toEqual({id:0,kind:0,entryType:1});expect(controller.engine.player!.id).toBe(0);
  });

  it('identifies complete resources and memo while retaining sparse-first evidence', () => {
    const controller = fixture();controller.receive(enter());
    expect(controller.receive(resources(false))?.fullResources).toBe(false);
    expect(controller.receive(resources(true))?.fullResources).toBe(true);
    expect(controller.receive(new BitWriter().u8(94).u8(0).u8(0).u8(0).u8(0).finish())?.memoSlots).toBe(true);
    expect(controller.receive(new BitWriter().u8(protocol.OP.map).string('prontera').finish())?.map).toBe(true);
    expect(controller.receive(Uint8Array.of(protocol.OP.clear))?.clear).toBe(true);
  });

  it('ignores stale malformed bytes without decoding, observation, mutation or tick', () => {
    const controller = fixture(), previous = controller.snapshot(), before = vi.fn();
    const general = vi.spyOn(protocol, 'decode'), world = vi.spyOn(worldProtocol, 'decodeWorld'), tick = vi.spyOn(controller, 'tick');
    expect(controller.receive(new Uint8Array(), controller.connectionGeneration - 1, before)).toBeNull();
    expect(general).not.toHaveBeenCalled();expect(world).not.toHaveBeenCalled();expect(before).not.toHaveBeenCalled();expect(tick).not.toHaveBeenCalled();
    expect(controller.snapshot()).toEqual(previous);
  });

  it('does not apply to a replacement generation created during observation', () => {
    const controller = fixture(), tick = vi.spyOn(controller, 'tick');
    const apply = vi.spyOn(controller.engine, 'receive');
    expect(controller.receive(enter(), controller.connectionGeneration, () => controller.connect(true))).toBeNull();
    expect(apply).not.toHaveBeenCalled();expect(tick).not.toHaveBeenCalled();expect(controller.engine.playerId).not.toBe(0);
  });

  it('propagates observer failure without applying or ticking', () => {
    const controller = fixture(), previous = controller.snapshot(), tick = vi.spyOn(controller, 'tick');
    expect(() => controller.receive(enter(), controller.connectionGeneration, () => { throw new Error('Synthetic observer failure'); })).toThrow('Synthetic observer failure');
    expect(tick).not.toHaveBeenCalled();expect(controller.snapshot()).toEqual(previous);
  });

  it('withholds facts and all mutation when either decoder fails', () => {
    const controller = fixture(), previous = controller.snapshot(), before = vi.fn(), tick = vi.spyOn(controller, 'tick');
    expect(() => controller.receive(Uint8Array.of(protocol.OP.spawn), controller.connectionGeneration, before)).toThrow('Truncated packet');
    expect(() => controller.receive(Uint8Array.of(worldProtocol.WORLD_OP.partyUpdate, 2), controller.connectionGeneration, before)).toThrow('Truncated packet');
    vi.spyOn(worldProtocol, 'decodeWorld').mockImplementation(() => { throw new Error('Synthetic world failure'); });
    expect(() => controller.receive(enter(), controller.connectionGeneration, before)).toThrow('Synthetic world failure');
    expect(before).not.toHaveBeenCalled();expect(tick).not.toHaveBeenCalled();expect(controller.snapshot()).toEqual(previous);
  });

  it('returns empty facts and ticks for an accepted unknown opcode', () => {
    const controller = fixture(), tick = vi.spyOn(controller, 'tick');
    expect(controller.receive(Uint8Array.of(200))).toEqual({opcode:200,enter:false,map:false,clear:false,fullResources:false,memoSlots:false,spawns:[]});
    expect(tick).toHaveBeenCalledOnce();
  });
});

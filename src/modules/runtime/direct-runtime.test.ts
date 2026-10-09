import { describe, it, expect, vi } from 'vitest';
import { DirectRuntime, type DirectEvent } from './direct-runtime';
import { BitWriter } from '../../shared/binary';
import { OP, type Entity } from '../protocol/protocol';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import { FEATURE_OP, featureCommand } from '../protocol/protocol-feature';

const player: Entity = {
  id: 0,
  classId: 6,
  name: 'Synthetic',
  kind: 0,
  level: 15,
  hp: 100,
  maxHp: 100,
  sp: 200,
  maxSp: 200,
  x: 100,
  y: 100,
  dead: false,
  statuses: [],
};
function spawn(e = player, entryType = 1) {
  const name = new TextEncoder().encode(e.name);
  const body = new BitWriter()
    .u8(15)
    .i32(e.id)
    .i32(e.classId)
    .i32(0)
    .i32(~name.length)
    .i32(e.name.length)
    .take(name)
    .u8(e.kind)
    .u8(0)
    .u8(0)
    .i32(e.x)
    .i32(e.y)
    .u8(e.level)
    .i32(e.hp)
    .i32(e.maxHp)
    .i32(e.sp ?? 0)
    .i32(e.maxSp ?? 0)
    .i32(0)
    .u8(0)
    .finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
function resources(full = true, itemId = 717) {
  const f = new BitWriter().u8(56);
  for (const v of [15, 15, 10000, 1, 1, 1, 1, 1, 1, 0, 0, 0]) f.i32(v);
  for (const v of [100, 100, 200, 200, ...Array(16).fill(1), 2000]) f.i32(v);
  f.f32(0.5).i32(100).i32(0);
  if (!full) return f.bool(false).bool(false).finish();
  f.bool(true).i16(1).i16(55).u8(4).i16(0).bool(true).u8(1).i32(1).i32(itemId).i16(3).i32(0).u8(0);
  for (let i = 0; i < 10; i++) f.i32(0);
  return f.i32(-1).finish();
}
const memo = () =>
  new BitWriter().u8(94).u8(1).string('prontera').i16(100).i16(100).u8(0).u8(0).u8(0).finish();
const enter = (actor = 0) => new BitWriter().u8(OP.enter).i32(actor).string('prt_fild08').finish();
const selected = () => new BitWriter().u8(3).bool(false).string('Synthetic').finish();
function fixture(held = false) {
  let now = 100000;
  let marker = held;
  let events: DirectEvent[] = [];
  const invoke = vi.fn(async (name: string, _args: unknown): Promise<unknown> =>
    name === 'direct_poll'
      ? { events: events.splice(0, 16), delivery: 1 }
      : name === 'update_ack' || name === 'update_lease_alive'
        ? true
        : undefined,
  );
  const runtime = new DirectRuntime(
    {
      invoke,
      now: () => now,
      store: {
        read: () => marker,
        write: (value) => {
          marker = value;
        },
      },
    },
    '11111111-1111-4111-8111-111111111111',
    '22222222-2222-4222-8222-222222222222',
  );
  const frame = (packet: Uint8Array) => runtime.receive([{ kind: 'frame', bytes: [...packet] }]);
  const open = () =>
    runtime.receive([{ kind: 'opened' }, { kind: 'enterSent', bytes: [...selected()] }]);
  const ready = async (actor = 0, own = player) => {
    await open();
    await frame(enter(actor));
    await frame(resources());
    await frame(memo());
    await runtime.receive([{ kind: 'readySent' }]);
    await frame(spawn({ ...own, id: actor }));
  };
  return {
    runtime,
    invoke,
    frame,
    open,
    ready,
    setEvents: (value: DirectEvent[]) => {
      events = value;
    },
    step: (ms: number) => {
      now += ms;
    },
    marker: () => marker,
    writes: () =>
      invoke.mock.calls
        .filter(([name]) => name === 'direct_send')
        .map(([, args]) => (args as { bytes: number[] }).bytes),
  };
}
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
describe('clientless shared-controller runtime', () => {
  it('paces repeated automatic zero-cooldown HP use through completed native writes', async () => {
    const f = fixture();
    await f.ready(0, { ...player, x: 124, y: 90, hp: 200, maxHp: 1000 });
    f.step(1200);
    await f.runtime.cycle();
    f.runtime.controller.engine.receive([
      { type: 'heal', id: 0, hp: 200, maxHp: 1000 },
      {
        type: 'inventory',
        items: [{ bagId: 501, itemId: 501, type: 1, count: 30 }],
        equipment: [],
        ammoId: -1,
      },
    ]);
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.mode = 'off';
    automation.recovery.enabled = false;
    automation.hpPotions = {
      mode: 'any',
      itemIds: [],
      belowPercent: 80,
      minStock: 10,
      cooldownSeconds: 0,
    };
    f.runtime.control('start', {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      route_randomWalk: 0,
      loot: false,
      automation,
    });
    let processed = 0,
      hp = 200,
      debt = 0,
      accepted = 0,
      rejected = 0;
    for (let elapsed = 0; elapsed < 8000; elapsed += 50) {
      debt = Math.max(0, debt - 50);
      f.step(50);
      f.runtime.control('heartbeat', DEFAULT_SETTINGS);
      await f.runtime.cycle();
      await flush();
      const writes = f.writes().filter((p) => p[0] === FEATURE_OP.useItem);
      const batch = writes.slice(processed);
      processed = writes.length;
      for (const _ of batch) {
        if (debt > 1000) {
          rejected++;
          continue;
        }
        debt += 200;
        accepted++;
        hp += 50;
        await f.frame(new BitWriter().u8(OP.heal).i32(0).i32(0).i32(hp).i32(1000).finish());
        await f.frame(
          new BitWriter()
            .u8(FEATURE_OP.inventoryDelta)
            .bool(false)
            .i32(501)
            .i16(1)
            .i32(0)
            .bool(false)
            .finish(),
        );
      }
    }
    expect({ accepted, rejected, reason: f.runtime.snapshot().reason }).toEqual({
      accepted: 13,
      rejected: 0,
      reason: expect.any(String),
    });
    expect(f.runtime.snapshot()).toMatchObject({
      itemAttempt: { send: 'accepted', outcome: 'confirmed' },
    });
    expect(f.runtime.snapshot().character.inventory.find((i) => i.itemId === 501)?.count).toBe(17);
  });
  it('distinguishes an unsettled native item write from accepted send without consumption', async () => {
    const f = fixture();
    await f.ready();
    await f.frame(resources(true, 501));
    const write = deferred<unknown>();
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, args) =>
      name === 'direct_send' ? write.promise : invoke(name, args),
    );
    f.runtime.perform('command', { type: 'useItem', itemId: 501 });
    expect(f.runtime.snapshot().itemAttempt).toMatchObject({ send: 'pending', outcome: 'waiting' });
    write.resolve(undefined);
    await flush();
    expect(f.runtime.snapshot().itemAttempt).toMatchObject({
      send: 'accepted',
      outcome: 'waiting',
    });
    f.step(6000);
    await f.runtime.cycle();
    const attempt = f.runtime.snapshot().itemAttempt;
    expect(attempt).toMatchObject({ send: 'accepted', outcome: 'cancelled' });
    expect(f.runtime.snapshot().actionResult.status).toBe('failed');
    expect(f.writes().filter((packet) => packet[0] === FEATURE_OP.useItem)).toHaveLength(1);
    await f.frame(new BitWriter().u8(OP.death).i32(0).finish());
    expect(f.runtime.snapshot().itemAttempt).toMatchObject({
      context: { life: 'alive' },
      received: { ownState: 1 },
      outcome: 'cancelled',
    });
    expect(attempt?.context?.life).toBe('alive');
  });
  it('reports uncertain native item dispatch without retaining private transport errors', async () => {
    const f = fixture();
    await f.ready();
    await f.frame(resources(true, 501));
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, args) =>
      name === 'direct_send'
        ? Promise.reject(new Error('private-account-token-and-native-path'))
        : invoke(name, args),
    );
    f.runtime.perform('command', { type: 'useItem', itemId: 501 });
    await flush();
    const snapshot = f.runtime.snapshot();
    expect(snapshot.itemAttempt?.send).toBe('uncertain');
    expect(JSON.stringify(snapshot)).not.toContain('private-account-token-and-native-path');
    expect(f.writes().filter((packet) => packet[0] === FEATURE_OP.useItem)).toHaveLength(1);
    expect(f.runtime.controller.engine.actionReceipts.receipt?.action.type).toBe('useItem');
  });
  it('settles a failed non-item native write without trying Stop on the closed connection', async () => {
    const f = fixture();
    await f.ready();
    const invoke = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, args) =>
      name === 'direct_send'
        ? Promise.reject(new Error('private-transport-failure'))
        : invoke(name, args),
    );
    f.runtime.perform('command', { type: 'sit', sitting: true });
    await flush();
    expect(f.runtime.snapshot()).toMatchObject({ connected: false, itemAttempt: null });
    expect(f.writes().filter((packet) => packet[0] === FEATURE_OP.sit)).toHaveLength(1);
    expect(f.writes().filter((packet) => packet[0] === OP.stop)).toHaveLength(0);
  });
  it('attributes an automatic Stop to its limit and rejects invalid action/cause pairs before controller effects', async () => {
    const f = fixture();
    await f.ready();
    const settings = {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      route_randomWalk: 0 as const,
    };
    f.runtime.control('start', settings);
    const before = f.runtime.snapshot(),
      writes = f.writes().length;
    expect(() =>
      f.runtime.control(
        'start',
        settings,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        'minutes',
      ),
    ).toThrow();
    expect(f.runtime.snapshot()).toEqual(before);
    expect(f.writes()).toHaveLength(writes);
    f.runtime.control(
      'stop',
      settings,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      'minutes',
    );
    expect(f.runtime.snapshot().reason).toContain('session time limit');
    expect(f.runtime.snapshot().log[0]?.text).not.toContain('Stopped by you');
    f.runtime.control('stop', settings);
    expect(f.runtime.snapshot().log[0]?.text).toBe('Stopped by you.');
  });
  it('keeps processing frames after a deployed party member update', async () => {
    const f = fixture();
    await f.ready();
    await f.frame(
      new BitWriter()
        .u8(101)
        .u8(1)
        .i32(3)
        .string('Party')
        .u8(0)
        .i32(1)
        .i32(5)
        .i32(100)
        .i16(9)
        .string('Test')
        .u8(0)
        .string('prontera')
        .i32(70)
        .i32(81)
        .i32(20)
        .i32(30)
        .finish(),
    );
    await f.frame(
      new BitWriter()
        .u8(102)
        .u8(2)
        .i32(5)
        .i32(100)
        .i16(10)
        .string('Test')
        .u8(0)
        .string('prontera')
        .i32(75)
        .i32(85)
        .i32(25)
        .i32(35)
        .i32(0x12345678)
        .finish(),
    );
    expect(f.runtime.snapshot()).toMatchObject({ connected: true, compatible: true });
    expect(f.runtime.controller.world.snapshot().party?.members).toMatchObject([
      { memberId: 5, level: 10, hp: 75 },
    ]);
    await f.frame(new BitWriter().u8(OP.heal).i32(0).i32(0).i32(95).i32(100).finish());
    expect(f.runtime.snapshot().player?.hp).toBe(95);
  });
  it('preparation freezes field decisions, cancellation continues intent and final ACK carries a checkpoint', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    const settings = {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      route_randomWalk: 0 as const,
    };
    f.runtime.control('start', settings);
    const requestId = 'a'.repeat(32);
    f.runtime.prepareUpdate(requestId);
    await flush();
    const prepared = f.invoke.mock.calls.find(([name]) => name === 'update_prepared');
    expect(prepared).toBeDefined();
    expect((prepared![1] as { checkpoint: { status: unknown } }).checkpoint.status).toMatchObject({
      runRequested: true,
      sessionId: f.runtime.sessionId,
      connectionId: f.runtime.connectionId,
      connectionMode: 'botOnly',
    });
    const before = f.writes().length;
    f.runtime.perform('command', { type: 'useItem', itemId: 717 });
    await flush();
    expect(f.writes()).toHaveLength(before);
    f.runtime.cancelUpdate(requestId);
    expect(f.runtime.snapshot().runRequested).toBe(true);
    expect(f.runtime.controller.preparingUpdate).toBe(false);
    f.runtime.prepareUpdate('b'.repeat(32));
    await flush();
    const nonce = 'c'.repeat(32);
    f.runtime.maintenance(nonce, true);
    await flush();
    f.runtime.maintenance(nonce, 'commit');
    await flush();
    const final = f.invoke.mock.calls.find(([name]) => name === 'update_final_ack');
    expect(final).toBeDefined();
    expect((final![1] as { checkpoint: { status: unknown } }).checkpoint.status).toMatchObject({
      runRequested: true,
      connectionId: f.runtime.connectionId,
    });
  });
  it('restore acknowledges only a fresh same-character boundary and Stop revokes suspended intent', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    f.runtime.control('start', {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      route_randomWalk: 0,
    });
    const requestId = 'a'.repeat(32);
    f.runtime.prepareUpdate(requestId);
    await flush();
    const checkpoint = f.runtime.controller.updateCheckpoint()!;
    f.runtime.control('stop', DEFAULT_SETTINGS);
    expect(f.runtime.controller.preparingUpdate).toBe(false);
    expect(f.runtime.snapshot().runRequested).toBe(false);
    const next = fixture();
    await next.ready();
    next.step(1200);
    await next.runtime.cycle();
    next.runtime.restoreUpdate({ requestId, checkpoint });
    await flush();
    expect(next.invoke).toHaveBeenCalledWith('update_restored', { requestId, success: true });
    expect(next.runtime.snapshot().runRequested).toBe(true);
    next.runtime.restoreUpdate({ requestId: 'b'.repeat(32), checkpoint });
    await flush();
    expect(next.invoke).toHaveBeenCalledWith('update_restored', {
      requestId: 'b'.repeat(32),
      success: false,
    });
  });
  it.each([0, 1])(
    'processes real first full resources + memo before Ready, own entry actor %s before guard reset',
    async (actor) => {
      const f = fixture(true);
      await f.open();
      await f.frame(enter(actor));
      expect(f.writes()).toEqual([]);
      await f.frame(resources());
      expect(f.writes()).toEqual([]);
      expect(f.marker()).toBe(true);
      await f.frame(memo());
      await f.runtime.receive([{ kind: 'readySent' }]);
      expect(f.writes()).toEqual([[2]]);
      expect(f.marker()).toBe(true);
      await f.frame(spawn({ ...player, id: actor }));
      f.step(1200);
      await f.runtime.cycle();
      expect(f.runtime.snapshot().player?.id).toBe(actor);
      expect(f.marker()).toBe(false);
      expect(f.writes()).toEqual([[2]]);
      await f.frame(new BitWriter().u8(OP.map).string('prontera').finish());
      expect(f.writes()).toEqual([[2], [2]]);
      await f.frame(new BitWriter().u8(OP.clear).finish());
      expect(f.writes()).toHaveLength(2);
    },
  );
  it.each(['partial', 'missingMemo', 'wrongEntry', 'replacedActor', 'changedResources'])(
    'retains uncertainty for %s; no timer grants missing proof',
    async (fault) => {
      const f = fixture(true);
      await f.open();
      await f.frame(enter());
      await f.frame(resources(fault !== 'partial'));
      if (fault !== 'missingMemo') {
        await f.frame(memo());
        if (fault !== 'partial') await f.runtime.receive([{ kind: 'readySent' }]);
      }
      if (fault === 'changedResources') await f.frame(resources());
      await f.frame(
        spawn({ ...player, id: fault === 'replacedActor' ? 1 : 0 }, fault === 'wrongEntry' ? 0 : 1),
      );
      f.step(5000);
      await f.runtime.cycle();
      expect(f.marker()).toBe(true);
      if (fault === 'partial' || fault === 'missingMemo') expect(f.writes()).toEqual([]);
    },
  );
  it.each(['partial', 'missingMemo', 'wrongEntry'])(
    'does not read a reset resource revision before %s admission passes',
    async (fault) => {
      const f = fixture(true);
      await f.open();
      await f.frame(enter());
      await f.frame(resources(fault !== 'partial'));
      if (fault !== 'missingMemo') {
        await f.frame(memo());
        if (fault !== 'partial') await f.runtime.receive([{ kind: 'readySent' }]);
      }
      const revision = vi.spyOn(f.runtime.controller, 'officialInitializationResourceRevision');
      await f.frame(spawn(player, fault === 'wrongEntry' ? 0 : 1));
      expect(revision).not.toHaveBeenCalled();
      expect(f.marker()).toBe(true);
    },
  );
  it('ignores fresh approval as settlement and keeps authentication out of the runtime API', async () => {
    const f = fixture(true);
    await f.runtime.connect();
    expect(f.invoke).toHaveBeenCalledWith('direct_connect', {
      sessionId: f.runtime.sessionId,
      connectionId: f.runtime.connectionId,
    });
    await f.open();
    expect(f.runtime.snapshot().player).toBeNull();
    expect(f.marker()).toBe(true);
    expect(f.writes()).toEqual([]);
    await f.frame(new Uint8Array([3]));
    expect(f.runtime.snapshot().connected).toBe(false);
    expect(f.marker()).toBe(true);
  });
  it('Stop retains in-world connection for receipts; write failures remain unresolved and never confirm an action', async () => {
    const f = fixture();
    await f.ready();
    f.runtime.control('stop', DEFAULT_SETTINGS);
    await flush();
    expect(f.runtime.snapshot().connected).toBe(true);
    expect(f.runtime.snapshot().runRequested).toBe(false);
    f.invoke.mockImplementation(async (name) => {
      if (name === 'direct_send') throw Error('synthetic write failure');
      return undefined;
    });
    f.runtime.perform('command', { type: 'skill', mode: 'self', skillId: 55, level: 1 });
    await flush();
    // Rejection or transport failure cannot manufacture a confirmed action receipt.
    expect(f.runtime.snapshot().actionResult?.status).not.toBe('confirmed');
  });
  it('dispatches a macro child through the clientless public API and the shared manual encoder', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    f.runtime.controller.engine.receive([
      {
        type: 'inventory',
        items: [{ bagId: 501, itemId: 501, type: 1, count: 3 }],
        equipment: Array(10).fill(0),
        ammoId: -1,
      },
    ]);
    const before = f.writes().length;
    f.runtime.perform('macro', {
      settings: { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] },
      script: {
        version: 1,
        name: 'Use potion',
        durationSeconds: 30,
        maxActions: 1,
        maxSpend: 0,
        rules: [
          {
            name: 'Potion',
            priority: 0,
            cooldownSeconds: 0,
            maxRuns: 1,
            conditions: [{ field: 'level', operator: 'gte', value: 1 }],
            steps: [{ type: 'useItem', itemId: 501, timeoutSeconds: 20 }],
          },
        ],
      },
    });
    await flush();
    expect(f.writes().slice(before)).toEqual([
      [...featureCommand({ type: 'useItem', itemId: 501 })],
    ]);
    expect(f.runtime.snapshot().macro).toMatchObject({ state: 'waiting', actionsCompleted: 0 });
    f.runtime.control('stop', DEFAULT_SETTINGS);
    const stopped = f.writes().length;
    await f.frame(
      new BitWriter()
        .u8(FEATURE_OP.inventoryDelta)
        .bool(false)
        .i32(501)
        .i16(1)
        .i32(0)
        .bool(false)
        .finish(),
    );
    await flush();
    expect(f.runtime.snapshot().macro).toMatchObject({ state: 'cancelled', actionsCompleted: 0 });
    expect(f.writes()).toHaveLength(stopped);
  });
  it.each([
    { resource: 'hp', itemId: 504 },
    { resource: 'hp', itemId: 512 },
    { resource: 'sp', itemId: 514 },
  ] as const)(
    'automatically uses selected $resource item $itemId through the direct transport',
    async ({ resource, itemId }) => {
      const f = fixture();
      await f.ready(0, { ...player, x: 124, y: 90, hp: 55 });
      f.step(1200);
      await f.runtime.cycle();
      f.runtime.controller.engine.receive([
        { type: 'heal', id: 0, hp: 55, maxHp: 100 },
        { type: 'sp', sp: 10, maxSp: 100 },
        {
          type: 'inventory',
          items: [{ bagId: itemId, itemId, type: 1, count: 3 }],
          equipment: Array(10).fill(0),
          ammoId: -1,
        },
      ]);
      const automation = structuredClone(DEFAULT_AUTOMATION);
      automation[resource === 'hp' ? 'hpPotions' : 'spPotions'] = {
        mode: 'selected',
        itemIds: [itemId],
        belowPercent: 60,
        minStock: 0,
        cooldownSeconds: 5,
      };
      f.runtime.control('start', {
        ...DEFAULT_SETTINGS,
        map: 'prt_fild08',
        targets: [4000],
        route_randomWalk: 0,
        automation,
      });
      f.step(1000);
      await f.runtime.cycle();
      await flush();
      expect(
        f.writes().filter((bytes) => bytes[0] === FEATURE_OP.useItem),
        f.runtime.snapshot().reason,
      ).toEqual([[...featureCommand({ type: 'useItem', itemId })]]);
      f.step(1000);
      await f.runtime.cycle();
      await flush();
      expect(f.writes().filter((bytes) => bytes[0] === FEATURE_OP.useItem)).toHaveLength(1);
    },
  );
  it.each(['ordered', 'missing', 'early'])(
    'Database macro travel requires ordered native Ready flush evidence: %s',
    async (ready) => {
      const f = fixture();
      await f.ready();
      f.step(30000);
      await f.frame(new BitWriter().u8(FEATURE_OP.sp).i32(200).i32(200).finish());
      await f.runtime.cycle();
      f.runtime.perform('macro', {
        settings: { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] },
        script: {
          version: 1,
          name: 'Database trip',
          durationSeconds: 60,
          maxActions: 1,
          maxSpend: 0,
          rules: [
            {
              name: 'Travel',
              priority: 0,
              cooldownSeconds: 0,
              maxRuns: 1,
              conditions: [{ field: 'level', operator: 'gte', value: 1 }],
              steps: [{ type: 'travel', map: 'prt_fild05', timeoutSeconds: 30 }],
            },
          ],
        },
      });
      await f.runtime.cycle();
      await flush();
      expect(f.writes().filter((bytes) => bytes[0] === 64)).toHaveLength(1);
      if (ready === 'early') await f.runtime.receive([{ kind: 'readySent' }]);
      await f.frame(new BitWriter().u8(OP.remove).i32(0).u8(0).finish());
      await f.frame(new BitWriter().u8(OP.map).string('prt_fild05').finish());
      if (ready === 'ordered') await f.runtime.receive([{ kind: 'readySent' }]);
      await f.frame(spawn());
      await f.runtime.cycle();
      await flush();
      expect(f.runtime.snapshot().macro).toMatchObject(
        ready === 'ordered'
          ? { actionsCompleted: 1, state: 'completed' }
          : { actionsCompleted: 0, state: 'failed' },
      );
      expect(f.runtime.controller.travel.teleportPending).toBe(ready !== 'ordered');
      expect(f.writes().filter((bytes) => bytes[0] === 64)).toHaveLength(1);
    },
  );
  it('freeze gates dispatch, reads frames while held, invalidates final ACK and settles native deliveries after apply', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    f.runtime.maintenance('a'.repeat(32), true);
    await flush();
    expect(f.invoke.mock.calls.some(([n]) => n === 'update_ack')).toBe(true);
    expect(() => f.runtime.control('heartbeat', DEFAULT_SETTINGS)).toThrow(/update/);
    f.setEvents([{ kind: 'frame', bytes: [...new BitWriter().u8(OP.stop).i32(0).finish()] }]);
    await f.runtime.cycle();
    expect(f.invoke.mock.calls.some(([n]) => n === 'update_invalidate')).toBe(true);
    expect(f.invoke.mock.calls.some(([n]) => n === 'direct_observed')).toBe(true);
    f.runtime.maintenance('a'.repeat(32), 'commit');
    await flush();
    expect(f.invoke.mock.calls.filter(([n]) => n === 'update_final_ack')).toEqual([]);
  });
  it('retries a same-owner reservation after the whole empty native poll cycle settles', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    f.step(600);
    const poll = deferred<unknown>(),
      observed = deferred<unknown>(),
      published = deferred<unknown>();
    const original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, args) =>
      name === 'direct_poll'
        ? poll.promise
        : name === 'direct_observed'
          ? observed.promise
          : name === 'bridge_status'
            ? published.promise
            : original(name, args),
    );
    const pending = f.runtime.cycle(),
      nonce = 'b'.repeat(32);
    f.runtime.maintenance(nonce, true);
    await flush();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_ack')).toEqual([]);
    poll.resolve({ events: [], delivery: 17 });
    await flush();
    expect(f.invoke).toHaveBeenCalledWith(
      'direct_observed',
      expect.objectContaining({ delivery: 17 }),
    );
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_ack')).toEqual([]);
    observed.resolve(undefined);
    await flush();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_ack')).toEqual([]);
    published.resolve(undefined);
    await pending;
    await flush();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_ack')).toEqual([
      [
        'update_ack',
        {
          nonce,
          identity: { sessionId: f.runtime.sessionId, connectionId: f.runtime.connectionId },
          revision: expect.any(Number),
        },
      ],
    ]);
    expect(() => f.runtime.control('heartbeat', DEFAULT_SETTINGS)).toThrow(/update/);
  });
  it('retries final confirmation requested during an empty native poll with the acknowledged owner revision', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    const nonce = 'c'.repeat(32);
    f.runtime.maintenance(nonce, true);
    await flush();
    const acknowledgement = f.invoke.mock.calls.find(([name]) => name === 'update_ack')!;
    expect(acknowledgement).toBeDefined();
    const poll = deferred<unknown>(),
      original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, args) =>
      name === 'direct_poll' ? poll.promise : original(name, args),
    );
    const pending = f.runtime.cycle();
    f.runtime.maintenance(nonce, 'commit');
    await flush();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_final_ack')).toEqual([]);
    poll.resolve({ events: [], delivery: null });
    await pending;
    await flush();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_final_ack')).toEqual([
      ['update_final_ack', acknowledgement[1]],
    ]);
  });
  it.each([true, 'commit'] as const)(
    'fences a pending %s confirmation after incoming frames, release, terminal closure or changed controller settlement',
    async (stage) => {
      for (const blocker of ['frame', 'release', 'closed', 'controller']) {
        const f = fixture();
        await f.ready();
        f.step(1200);
        await f.runtime.cycle();
        const nonce = 'd'.repeat(32);
        if (stage === 'commit') {
          f.runtime.maintenance(nonce, true);
          await flush();
        }
        const poll = deferred<unknown>(),
          original = f.invoke.getMockImplementation()!;
        f.invoke.mockImplementation((name, args) =>
          name === 'direct_poll' ? poll.promise : original(name, args),
        );
        const before = f.invoke.mock.calls.length,
          pending = f.runtime.cycle();
        f.runtime.maintenance(nonce, stage);
        await flush();
        if (blocker === 'release') f.runtime.maintenance(nonce, false);
        if (blocker === 'controller')
          vi.spyOn(f.runtime.controller, 'settledForMaintenance').mockReturnValue(false);
        const events: DirectEvent[] =
          blocker === 'frame'
            ? [{ kind: 'frame', bytes: [...new BitWriter().u8(OP.stop).i32(0).finish()] }]
            : blocker === 'closed'
              ? [{ kind: 'closed', reason: 'synthetic closed' }]
              : [];
        poll.resolve({ events, delivery: events.length ? 18 : null });
        await pending;
        await flush();
        const calls = f.invoke.mock.calls.slice(before);
        expect(
          calls.filter(([name]) => name === 'update_ack' || name === 'update_final_ack'),
          `${stage}: ${blocker}`,
        ).toEqual([]);
        expect(calls.filter(([name]) => name === 'direct_send')).toEqual([]);
        if (events.length)
          expect(calls).toContainEqual([
            'direct_observed',
            expect.objectContaining({ delivery: 18 }),
          ]);
      }
    },
  );
  it.each([true, 'commit'] as const)(
    'a released pending %s cannot acknowledge a replacement nonce',
    async (stage) => {
      const f = fixture();
      await f.ready();
      f.step(1200);
      await f.runtime.cycle();
      const nonce = 'e'.repeat(32),
        replacement = 'f'.repeat(32);
      if (stage === 'commit') {
        f.runtime.maintenance(nonce, true);
        await flush();
      }
      const poll = deferred<unknown>(),
        original = f.invoke.getMockImplementation()!;
      f.invoke.mockImplementation((name, args) =>
        name === 'direct_poll' ? poll.promise : original(name, args),
      );
      const before = f.invoke.mock.calls.length,
        pending = f.runtime.cycle();
      f.runtime.maintenance(nonce, stage);
      f.runtime.maintenance(nonce, false);
      f.runtime.maintenance(replacement, true);
      await flush();
      poll.resolve({ events: [], delivery: null });
      await pending;
      await flush();
      const confirmations = f.invoke.mock.calls
        .slice(before)
        .filter(([name]) => name === 'update_ack' || name === 'update_final_ack');
      expect(confirmations).toEqual([
        ['update_ack', expect.objectContaining({ nonce: replacement })],
      ]);
    },
  );
  it('native lease release cancels a deferred final confirmation', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    const nonce = 'a'.repeat(32);
    f.runtime.maintenance(nonce, true);
    await flush();
    const poll = deferred<unknown>(),
      original = f.invoke.getMockImplementation()!;
    f.invoke.mockImplementation((name, args) =>
      name === 'direct_poll'
        ? poll.promise
        : name === 'update_lease_alive'
          ? Promise.resolve(false)
          : original(name, args),
    );
    const pending = f.runtime.cycle();
    f.runtime.maintenance(nonce, 'commit');
    poll.resolve({ events: [], delivery: null });
    await pending;
    await flush();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'update_final_ack')).toEqual([]);
    expect(() => f.runtime.control('heartbeat', DEFAULT_SETTINGS)).not.toThrow();
  });
  it.each(['ack', 'probe'] as const)(
    'a stale %s response cannot release a newer reservation even when its nonce is reused',
    async (stale) => {
      const f = fixture();
      await f.ready();
      f.step(1200);
      await f.runtime.cycle();
      const nonce = 'b'.repeat(32),
        response = deferred<unknown>();
      const original = f.invoke.getMockImplementation()!;
      let first = true;
      f.invoke.mockImplementation((name, args) => {
        if (name === (stale === 'ack' ? 'update_ack' : 'update_lease_alive') && first) {
          first = false;
          return response.promise;
        }
        return original(name, args);
      });
      f.runtime.maintenance(nonce, true);
      await flush();
      if (stale === 'probe') await f.runtime.cycle();
      f.runtime.maintenance(nonce, false);
      f.runtime.maintenance(nonce, true);
      await flush();
      response.resolve(false);
      await flush();
      expect(() => f.runtime.control('heartbeat', DEFAULT_SETTINGS)).toThrow(/update/);
      f.runtime.maintenance(nonce, 'commit');
      await flush();
      expect(f.invoke.mock.calls.filter(([name]) => name === 'update_final_ack')).toHaveLength(1);
    },
  );
  it('actual send completion blocks update ACK', async () => {
    const f = fixture();
    await f.ready();
    f.step(1200);
    await f.runtime.cycle();
    let release!: (value: unknown) => void;
    f.invoke.mockImplementation((name) =>
      name === 'direct_send'
        ? new Promise((resolve) => {
            release = resolve;
          })
        : Promise.resolve(undefined),
    );
    f.runtime.perform('command', { type: 'sit', sitting: true });
    f.runtime.maintenance('b'.repeat(32), true);
    await flush();
    expect(f.invoke.mock.calls.some(([n]) => n === 'update_ack')).toBe(false);
    release(undefined);
    await flush();
  });
  it('an own spawn queued before the native Ready flush never supplies the initialization certificate', async () => {
    const f = fixture(true);
    await f.open();
    await f.frame(enter());
    await f.frame(resources());
    await f.frame(memo());
    await f.frame(spawn());
    await f.runtime.receive([{ kind: 'readySent' }]);
    f.step(5000);
    await f.runtime.cycle();
    expect(f.marker()).toBe(true);
  });
  it('terminal events publish disconnected truth, and later stale frames cannot replace the character', async () => {
    const f = fixture();
    await f.ready();
    await f.runtime.receive([{ kind: 'closed', reason: 'synthetic disconnected' }]);
    await f.frame(spawn({ ...player, id: 1 }));
    expect(f.runtime.snapshot().connected).toBe(false);
    expect(f.runtime.snapshot().player).toBeNull();
    expect(
      f.invoke.mock.calls.some(
        ([n, args]) =>
          n === 'bridge_status' &&
          (args as { status: { connected: boolean } }).status.connected === false,
      ),
    ).toBe(true);
  });
  it('applies each accepted mixed-burst frame and ticks before the next native frame', async () => {
    const f = fixture();
    await f.ready();
    const tick = vi.spyOn(f.runtime.controller, 'tick'),
      observed: number[] = [];
    const frames = [
      spawn({ ...player, id: 2, classId: 4000, kind: 1, name: 'Poring' }, 0),
      new BitWriter().u8(OP.move).i32(2).position({ x: 103, y: 100 }).finish(),
      new BitWriter().u8(OP.tracking).u16(1).i32(2).i16(103).i16(100).u8(1).finish(),
      resources(),
    ];
    for (let burst = 0; burst < 3; burst++)
      for (const frame of frames) {
        await f.frame(frame);
        observed.push(tick.mock.calls.length);
      }
    expect(observed).toEqual(Array.from({ length: 12 }, (_, index) => index + 1));
    expect(f.runtime.controller.engine.entities.get(2)).toMatchObject({ id: 2, x: 103, y: 100 });
    expect(f.runtime.snapshot()).toMatchObject({
      connected: true,
      compatible: true,
      player: { id: 0, hp: 100, sp: 200 },
    });
    f.step(1200);
    f.runtime.perform('command', { type: 'sit', sitting: false });
    await flush();
    expect(f.writes()).toEqual([[2], [...featureCommand({ type: 'sit', sitting: false })]]);
  });
  it.each([
    Uint8Array.of(OP.spawn),
    Uint8Array.of(102, 2),
    new BitWriter().u8(OP.tracking).u16(0).u8(0).finish(),
  ])('closes on malformed owned packets and never applies a later frame', async (packet) => {
    const f = fixture();
    await f.ready();
    const writes = f.writes();
    await f.frame(packet);
    expect(f.runtime.snapshot()).toMatchObject({ connected: false, player: null });
    expect(f.runtime.controller.engine.reason).toBe(
      'Unverified game packet. Update Companion before reconnecting.',
    );
    await f.frame(spawn({ ...player, id: 1, name: 'Stale' }));
    expect(f.runtime.snapshot().player).toBeNull();
    expect(f.writes()).toEqual(writes);
  });
});

it.each(['hp', 'sp'] as const)(
  'Bot only acknowledges live %s recovery edits after its pending item and retains run limits',
  async (resource) => {
    const f = fixture();
    await f.ready(0, { ...player, x: 124, y: 90, hp: 55 });
    f.step(1200);
    await f.runtime.cycle();
    const itemId = resource === 'hp' ? 501 : 514;
    f.runtime.controller.engine.receive([
      { type: 'sp', sp: 10, maxSp: 100 },
      {
        type: 'inventory',
        items: [{ bagId: itemId, itemId, type: 1, count: 4 }],
        equipment: [],
        ammoId: -1,
      },
    ]);
    const automation = structuredClone(DEFAULT_AUTOMATION);
    automation.combat.mode = 'off';
    automation.limits.kills = 5;
    automation[resource === 'hp' ? 'hpPotions' : 'spPotions'] = {
      mode: 'selected',
      itemIds: [itemId],
      belowPercent: 60,
      minStock: 1,
      cooldownSeconds: 10,
    };
    const original = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], automation };
    f.runtime.control('start', original);
    f.step(1000);
    await f.runtime.cycle();
    await flush();
    expect(f.writes().filter((row) => row[0] === FEATURE_OP.useItem)).toHaveLength(1);
    const draft = structuredClone(original);
    draft.radius = 8;
    draft.targets = [4007];
    draft.loot = false;
    draft.automation.limits.kills = 100;
    draft.automation[resource === 'hp' ? 'hpPotions' : 'spPotions']!.belowPercent = 70;
    f.runtime.control('apply', draft, undefined, undefined, undefined, 'a'.repeat(32));
    expect(f.runtime.snapshot().settingsApply?.state).toBe('pending');
    await f.frame(
      new BitWriter()
        .u8(FEATURE_OP.inventoryDelta)
        .bool(false)
        .i32(itemId)
        .i16(1)
        .i32(0)
        .bool(false)
        .finish(),
    );
    await flush();
    expect(f.runtime.snapshot()).toMatchObject({
      runRequested: true,
      settingsApply: { state: 'applied' },
      activeSettings: {
        radius: 8,
        targets: [4007],
        loot: false,
        automation: { limits: { kills: 5 } },
      },
    });
    f.step(1000);
    await f.runtime.cycle();
    await flush();
    expect(f.writes().filter((row) => row[0] === FEATURE_OP.useItem)).toHaveLength(1);
    f.runtime.control(
      'apply',
      { ...draft, radius: 99 },
      undefined,
      undefined,
      undefined,
      'b'.repeat(32),
    );
    expect(f.runtime.snapshot()).toMatchObject({
      settingsApply: { state: 'rejected' },
      activeSettings: { radius: 8 },
    });
  },
);
it('Bot only Stop cancels a waiting settings Apply before late item confirmation', async () => {
  const f = fixture();
  await f.ready(0, { ...player, x: 124, y: 90, hp: 55 });
  f.step(1200);
  await f.runtime.cycle();
  f.runtime.controller.engine.receive([
    {
      type: 'inventory',
      items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }],
      equipment: [],
      ammoId: -1,
    },
  ]);
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.combat.mode = 'off';
  automation.hpPotions = {
    mode: 'selected',
    itemIds: [501],
    belowPercent: 60,
    minStock: 1,
    cooldownSeconds: 10,
  };
  const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], automation };
  f.runtime.control('start', settings);
  f.step(1000);
  await f.runtime.cycle();
  await flush();
  f.runtime.control(
    'apply',
    { ...settings, radius: 8 },
    undefined,
    undefined,
    undefined,
    'a'.repeat(32),
  );
  f.runtime.control('stop', settings);
  await f.frame(
    new BitWriter()
      .u8(FEATURE_OP.inventoryDelta)
      .bool(false)
      .i32(501)
      .i16(1)
      .i32(0)
      .bool(false)
      .finish(),
  );
  await flush();
  expect(f.runtime.snapshot()).toMatchObject({
    runRequested: false,
    activeSettings: null,
    settingsApply: { state: 'cancelled' },
  });
  expect(f.writes().filter((row) => row[0] === FEATURE_OP.useItem)).toHaveLength(1);
});

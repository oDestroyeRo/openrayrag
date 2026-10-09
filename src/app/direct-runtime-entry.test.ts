import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectRuntime } from '../modules/runtime/direct-runtime';
import { mapCode } from '../shared/domain-values';
import { BitWriter } from '../shared/binary';
import { OP } from '../modules/protocol/protocol';
import { DEFAULT_SETTINGS } from '../modules/settings/settings';
import { PersistentFieldRun } from '../modules/session/reconnect';
import { UpdateContinuationOwner } from '../modules/update/update-continuation';
import { formDocument } from '../modules/settings/current-form-logic';
import { validStatus } from '../modules/client/game-status';

const captured = vi.hoisted(() => ({ runtime: null as DirectRuntime | null }));
vi.mock('../modules/runtime/direct-runtime', async (original) => {
  const actual = await original<typeof import('../modules/runtime/direct-runtime')>();
  return {
    ...actual,
    DirectRuntime: class extends actual.DirectRuntime {
      constructor(...args: ConstructorParameters<typeof actual.DirectRuntime>) {
        super(...args);
        captured.runtime = this;
      }
    },
  };
});
const maps = { Items: [{ Code: 'prt_fild08', Name: 'Prontera Field 8' }] };
const monsters = {
  Items: [
    { Id: 4000, Name: 'Poring', Level: 1, HP: 51, Spawns: [{ Map: 'prt_fild08', Count: 100 }] },
    { Id: 4002, Name: 'Lunatic', Level: 3, HP: 79, Spawns: [{ Map: 'prt_fild08', Count: 40 }] },
  ],
};
const assets = { maps: JSON.stringify(maps), monsters: JSON.stringify(monsters) };
async function flush() {
  for (let index = 0; index < 30; index++) await Promise.resolve();
}
async function fixture(read: () => Promise<unknown>) {
  vi.useFakeTimers();
  vi.resetModules();
  const invoke = vi.fn(async (name: string, _args: unknown): Promise<unknown> =>
    name === 'warp_guard_initialize'
      ? null
      : name === 'map_database'
        ? read()
        : name === 'direct_poll'
          ? { events: [], delivery: null }
          : name === 'update_ack' || name === 'update_lease_alive'
            ? true
            : undefined,
  );
  const page = Object.assign(new EventTarget(), {
    __TAURI_INTERNALS__: { invoke },
    __RAYRAG__: undefined,
  });
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('window', page);
  vi.stubGlobal('localStorage', { getItem: () => null, setItem: () => {}, removeItem: () => {} });
  await import('./direct-runtime-entry');
  await flush();
  return { page, invoke, fetcher, runtime: captured.runtime! };
}
async function enterGame(runtime: DirectRuntime) {
  const frame = (bytes: Uint8Array) => runtime.receive([{ kind: 'frame', bytes: [...bytes] }]);
  await runtime.receive([
    { kind: 'opened' },
    {
      kind: 'enterSent',
      bytes: [...new BitWriter().u8(3).bool(false).string('Synthetic').finish()],
    },
  ]);
  await frame(new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish());
  const stats = new BitWriter().u8(56);
  for (const n of [
    15,
    15,
    10000,
    1,
    1,
    1,
    1,
    1,
    1,
    0,
    0,
    0,
    100,
    100,
    200,
    200,
    ...Array(16).fill(1),
    2000,
  ])
    stats.i32(n);
  stats
    .f32(0.5)
    .i32(100)
    .i32(0)
    .bool(true)
    .i16(1)
    .i16(55)
    .u8(4)
    .i16(0)
    .bool(true)
    .u8(1)
    .i32(1)
    .i32(717)
    .i16(3)
    .i32(0)
    .u8(0);
  for (let i = 0; i < 10; i++) stats.i32(0);
  await frame(stats.i32(-1).finish());
  await frame(
    new BitWriter().u8(94).u8(1).string('prontera').i16(100).i16(100).u8(0).u8(0).u8(0).finish(),
  );
  await runtime.receive([{ kind: 'readySent' }]);
  const name = new TextEncoder().encode('Synthetic');
  const own = new BitWriter()
    .u8(15)
    .i32(0)
    .i32(6)
    .i32(0)
    .i32(~name.length)
    .i32(name.length)
    .take(name)
    .u8(0)
    .u8(0)
    .u8(0)
    .i32(170)
    .i32(370)
    .u8(15)
    .i32(100)
    .i32(100)
    .i32(200)
    .i32(200)
    .i32(0)
    .u8(0)
    .finish();
  await frame(new BitWriter().u8(OP.spawn).u8(1).i32(own.length).take(own).finish());
  return frame;
}
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  captured.runtime = null;
});
describe('Bot-only catalogue startup', () => {
  it('defers a genuinely unsettled combat owner without repeatedly suspending the same candidate', async () => {
    const f = await fixture(async () => assets),
      frame = await enterGame(f.runtime);
    await vi.advanceTimersByTimeAsync(1200);
    const settings = {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      route_randomWalk: 0 as const,
    };
    // A normal nearby target creates an admitted attack, with no item action involved.
    f.runtime.controller.engine.receive([
      {
        type: 'spawn',
        entity: {
          id: 2,
          classId: 4000,
          name: 'Poring',
          kind: 1,
          level: 1,
          hp: 50,
          maxHp: 50,
          x: 171,
          y: 370,
          dead: false,
        },
      },
    ]);
    f.runtime.control('start', settings);
    await f.runtime.cycle();
    await vi.advanceTimersByTimeAsync(200);
    await f.runtime.cycle();
    const writes = () =>
      f.invoke.mock.calls.filter(
        ([command, args]) =>
          command === 'direct_send' && (args as { bytes: number[] }).bytes[0] === OP.attack,
      );
    expect(writes(), f.runtime.snapshot().reason).toHaveLength(1);
    const field = new PersistentFieldRun();
    field.begin(settings, 'Synthetic', f.runtime.sessionId);
    const bridge = f.page.__RAYRAG__ as unknown as Pick<
      DirectRuntime,
      'prepareUpdate' | 'cancelUpdate'
    >;
    const id = 'c'.repeat(32);
    const native = vi.fn(async (command: string) => {
      if (command === 'update_prepare') bridge.prepareUpdate(id);
      if (command === 'update_cancel') bridge.cancelUpdate(id);
      return undefined;
    });
    const owner = new UpdateContinuationOwner(native, () => id, 1000);
    const adapter = {
      flush: async () =>
        formDocument({ version: 1, revision: 1, selectedProfileId: null, settings }),
      game: () => {
        const status = (
          f.invoke.mock.calls.filter(([command]) => command === 'bridge_status').at(-1)![1] as {
            status: unknown;
          }
        ).status;
        if (!validStatus(status)) throw new Error('Fixture game status unavailable.');
        return { open: true, status };
      },
      interrupted: () => false,
      status: () => {},
    };
    const options = { installedVersion: '0.17.1', targetVersion: '0.18.0' };
    const installation = owner.install(field, adapter, options);
    await flush();
    await frame(new BitWriter().u8(83).i32(200).i32(200).finish());
    await vi.advanceTimersByTimeAsync(1001);
    await installation;
    expect(owner.presentation().reason).toContain('preparation timed out');
    expect(f.runtime.controller.preparingUpdate).toBe(false);
    expect(writes()).toHaveLength(1);
    for (let poll = 0; poll < 4; poll++) {
      await vi.advanceTimersByTimeAsync(15_000);
      f.runtime.control('heartbeat', settings);
      await owner.install(field, adapter, options);
    }
    expect(native.mock.calls.filter(([command]) => command === 'update_prepare')).toHaveLength(1);
    expect(
      owner.history.filter((entry) => entry.text.includes('preparation timed out')),
    ).toHaveLength(1);
    expect(f.runtime.controller.runRequested).toBe(true);
    expect(owner.canInstall('0.18.0', true)).toBe(true);
    expect(f.runtime.snapshot().elapsedSeconds).toBeGreaterThan(60);
  });
  it('completes the owner/native acknowledgement handoff through the actual entry before heartbeat expiry', async () => {
    const f = await fixture(async () => assets);
    await enterGame(f.runtime);
    await vi.advanceTimersByTimeAsync(1200);
    const settings = {
      ...DEFAULT_SETTINGS,
      map: 'prt_fild08',
      targets: [4000],
      route_randomWalk: 0 as const,
    };
    f.runtime.control('start', settings);
    await f.runtime.cycle();
    const field = new PersistentFieldRun();
    field.begin(settings, 'Synthetic', f.runtime.sessionId);
    const bridge = f.page.__RAYRAG__ as unknown as Pick<
      DirectRuntime,
      'prepareUpdate' | 'cancelUpdate' | 'maintenance'
    >;
    const id = 'a'.repeat(32),
      nonce = 'b'.repeat(32);
    let final = false;
    const original = f.invoke.getMockImplementation()!;
    let owner: UpdateContinuationOwner;
    f.invoke.mockImplementation(async (command, args) => {
      if (command === 'update_prepared') owner.prepared(args);
      if (command === 'update_final_ack') final = true;
      return original(command, args);
    });
    const native = vi.fn(async (command: string, args?: Record<string, unknown>) => {
      if (command === 'update_prepare') bridge.prepareUpdate?.(String(args?.requestId));
      if (command === 'update_cancel') bridge.cancelUpdate(id);
      if (command === 'update_reserve') {
        bridge.maintenance(nonce, true);
        await flush();
        return nonce;
      }
      if (command === 'update_install') {
        bridge.maintenance(nonce, 'commit');
        await flush();
        return final;
      }
      if (command === 'update_release') bridge.maintenance(nonce, false);
      return undefined;
    });
    owner = new UpdateContinuationOwner(native, () => id);
    const installed = owner.install(
      field,
      {
        flush: async () =>
          formDocument({ version: 1, revision: 1, selectedProfileId: null, settings }),
        game: () => {
          const published = f.invoke.mock.calls
            .filter(([command]) => command === 'bridge_status')
            .at(-1)?.[1] as { status?: unknown };
          if (!validStatus(published.status)) throw new Error('Fixture game status unavailable.');
          return { open: true, status: published.status };
        },
        interrupted: () => false,
        status: () => {},
      },
      { installedVersion: '0.17.1', targetVersion: '0.18.0' },
    );
    await flush();
    await vi.advanceTimersByTimeAsync(1000);
    expect(native).toHaveBeenCalledWith('update_reserve', expect.anything());
    expect(final).toBe(true);
    await installed;
    expect(owner.presentation().reason).toContain('complete');
    expect(f.runtime.controller.preparingUpdate).toBe(false);
    expect(field.metrics.deaths).toBe(0);
    expect(f.runtime.snapshot().elapsedSeconds).toBeLessThan(6);
    expect(
      f.runtime
        .snapshot()
        .log.some((entry) => entry.text.includes('Waiting for the client connection')),
    ).toBe(false);
  });
  it('exposes the updater lifecycle through the actual Bot-only page entry', async () => {
    const f = await fixture(async () => assets);
    const bridge = f.page.__RAYRAG__ as unknown as Pick<
      DirectRuntime,
      'prepareUpdate' | 'cancelUpdate' | 'restoreUpdate'
    >;
    const requestId = 'a'.repeat(32);
    expect(typeof bridge.prepareUpdate).toBe('function');
    bridge.prepareUpdate(requestId);
    expect(f.runtime.controller.preparingUpdate).toBe(true);
    bridge.cancelUpdate(requestId);
    expect(f.runtime.controller.preparingUpdate).toBe(false);
    bridge.restoreUpdate({ requestId, checkpoint: null });
    await flush();
    expect(f.invoke).toHaveBeenCalledWith('update_restored', { requestId, success: false });
  });
  it('uses native asset admission and publishes offscreen species in the current map', async () => {
    const f = await fixture(async () => assets);
    expect(f.invoke).toHaveBeenCalledWith('map_database', {});
    expect(f.fetcher).not.toHaveBeenCalled();
    expect(f.runtime.catalog?.get(mapCode('prt_fild08'))?.monsters).toHaveLength(2);
    f.runtime.controller.engine.map = 'prt_fild08';
    await f.runtime.publish();
    expect(f.invoke).toHaveBeenLastCalledWith(
      'bridge_status',
      expect.objectContaining({
        status: expect.objectContaining({
          connectionMode: 'botOnly',
          mapInfo: expect.objectContaining({
            source: 'database',
            name: 'Prontera Field 8',
            monsters: expect.arrayContaining([
              expect.objectContaining({ classId: 4002, spawnCount: 40, visibleCount: 0 }),
            ]),
          }),
        }),
      }),
    );
  });
  it('drops a native response after the runtime page is retired', async () => {
    let resolve!: (value: unknown) => void;
    const f = await fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const publications = f.invoke.mock.calls.filter(([name]) => name === 'bridge_status').length;
    f.page.dispatchEvent(new Event('pagehide'));
    resolve(assets);
    await flush();
    expect(f.runtime.catalog).toBeNull();
    expect(f.invoke.mock.calls.filter(([name]) => name === 'bridge_status')).toHaveLength(
      publications,
    );
    await vi.advanceTimersByTimeAsync(12_000);
    expect(f.invoke.mock.calls.filter(([name]) => name === 'map_database')).toHaveLength(1);
  });
  it('projects a delayed catalogue against the current map after field travel', async () => {
    let resolve!: (value: unknown) => void;
    const f = await fixture(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    f.runtime.controller.engine.map = 'prt_fild05';
    f.runtime.controller.engine.map = 'prt_fild08';
    resolve(assets);
    await flush();
    expect(f.invoke).toHaveBeenLastCalledWith(
      'bridge_status',
      expect.objectContaining({
        status: expect.objectContaining({
          mapInfo: expect.objectContaining({
            code: 'prt_fild08',
            name: 'Prontera Field 8',
            source: 'database',
          }),
        }),
      }),
    );
  });
});

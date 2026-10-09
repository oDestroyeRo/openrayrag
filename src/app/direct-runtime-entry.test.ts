import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DirectRuntime } from '../modules/runtime/direct-runtime';
import { mapCode } from '../shared/domain-values';

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
    name === 'warp_guard_initialize' ? null : name === 'map_database' ? read() : undefined,
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
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  captured.runtime = null;
});
describe('Bot-only catalogue startup', () => {
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

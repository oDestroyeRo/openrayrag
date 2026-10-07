import { mapCode } from '../../shared/domain-values';
import { result, runPromise, runPromiseExit } from 'effect/Effect';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  currentMapInfo,
  loadMapCatalog,
  loadMapCatalogResult,
  loadNativeMapCatalog,
  mapCatalogProgram,
  MapCatalogLoader,
  parseMapCatalog,
  validMapInfo,
  MAP_DATA_URL,
  type MapCatalog,
} from './map-data';
import { type Entity } from '../protocol/protocol';
import { MapDataError } from './map-data-policy';

// Public prt_fild05 rows from the deployed map/monster JSON, 2026-10-01.
const rows = [
  [4000, 'Poring', 1, 51, 70],
  [4002, 'Lunatic', 3, 79, 30],
  [4008, 'Thief Bug Egg', 4, 143, 20],
  [4003, 'Pupa', 6, 214, 30],
  [4007, 'Thief Bug', 8, 152, 10],
  [4010, 'Green Plant', 1, 10, 6],
  [4013, 'Blue Plant', 1, 10, 1],
] as const;
const maps = {
  Items: [
    { Code: 'prt_fild05', Name: 'Prontera Field 5' },
    { Code: 'prontera', Name: 'Prontera' },
  ],
};
const monsters = {
  Items: rows.map(([Id, Name, Level, HP, Count]) => ({
    Id,
    Name,
    Level,
    HP,
    Spawns: [{ Map: 'prt_fild05', Count: Number(Count) }],
  })),
};
const entity: Entity = {
  id: 1,
  classId: 4000,
  name: 'Poring',
  kind: 1,
  level: 1,
  hp: 51,
  maxHp: 51,
  dead: false,
  x: 1,
  y: 1,
};

describe('official map information', () => {
  it('reads the seven deployed field types and combines repeated spawn rules', () => {
    const data = structuredClone(monsters);
    data.Items[0]!.Spawns.push({ Map: 'prt_fild05', Count: 5 });
    const catalog = parseMapCatalog(maps, data);
    expect(catalog.get(mapCode('prt_fild05'))?.name).toBe('Prontera Field 5');
    expect(catalog.get(mapCode('prt_fild05'))?.monsters).toHaveLength(7);
    expect(
      catalog.get(mapCode('prt_fild05'))?.monsters.find((m) => m.classId === 4000)?.spawnCount,
    ).toBe(75);
    expect(catalog.get(mapCode('prontera'))?.monsters).toEqual([]);
  });
  it('keeps configured population distinct from live visible entities, including beyond radar capacity', () => {
    const catalog = parseMapCatalog(maps, monsters);
    const live = Array.from({ length: 160 }, (_, id) => ({ ...entity, id: id + 1 }));
    live.push({ ...entity, id: 999, classId: 4999, name: 'Event monster', level: 8 });
    live.push({ ...entity, id: 1000, kind: 0 }, { ...entity, id: 1001, dead: true });
    const info = currentMapInfo('prt_fild05', live, catalog, false);
    expect(info.monsters.find((m) => m.classId === 4000)).toMatchObject({
      spawnCount: 70,
      visibleCount: 160,
    });
    expect(info.monsters.find((m) => m.classId === 4999)).toMatchObject({
      spawnCount: null,
      visibleCount: 1,
    });
    expect(info.monsters.find((m) => m.classId === 4002)).toMatchObject({
      spawnCount: 30,
      visibleCount: 0,
    });
    expect(catalog.get(mapCode('prt_fild05'))?.monsters[0]?.visibleCount).toBe(0);
    expect(validMapInfo(info, 'prt_fild05')).toBe(true);
    expect(validMapInfo(info, 'prontera')).toBe(false);
  });
  it('falls back to observed types on an unknown map or when metadata is unavailable', () => {
    const info = currentMapInfo('event_map', [entity], null, false);
    expect(info).toMatchObject({ name: 'event_map', source: 'observed' });
    expect(info.monsters[0]).toMatchObject({ classId: 4000, spawnCount: null, visibleCount: 1 });
    expect(currentMapInfo('event_map', [entity], null, true).source).toBe('loading');
  });
  it('rejects malformed exports and invalid IPC map information', () => {
    expect(() => parseMapCatalog({}, monsters)).toThrow();
    expect(() => parseMapCatalog(maps, { Items: [{ ...monsters.Items[0], Id: -1 }] })).toThrow();
    expect(() =>
      parseMapCatalog(maps, {
        Items: [{ ...monsters.Items[0], Spawns: [{ Map: '../map', Count: 1 }] }],
      }),
    ).toThrow();
    const info = currentMapInfo('prt_fild05', [entity], null, false);
    expect(
      validMapInfo({ ...info, monsters: [...info.monsters, ...info.monsters] }, info.code),
    ).toBe(false);
  });
  it('loads only the two public assets without credentials and rejects failed fetches', async () => {
    const fetcher = vi.fn<typeof fetch>(
      async (url) =>
        new Response(JSON.stringify(String(url).endsWith('/maps.json') ? maps : monsters)),
    );
    const catalog = await loadMapCatalog(fetcher);
    expect(catalog.get(mapCode('prt_fild05'))?.monsters).toHaveLength(7);
    expect(fetcher.mock.calls.map((call) => call[0])).toEqual([
      `${MAP_DATA_URL}maps.json`,
      `${MAP_DATA_URL}monsterdatabase.json`,
    ]);
    expect(fetcher.mock.calls.every((call) => call[1]?.credentials === 'omit')).toBe(true);
    await expect(loadMapCatalog(async () => new Response('', { status: 404 }))).rejects.toThrow(
      'unavailable',
    );
  });
  it('admits the same complete roster through Bot-only native IPC without a browser fetch', async () => {
    const invoke = vi.fn(async () => ({
      maps: JSON.stringify(maps),
      monsters: JSON.stringify(monsters),
    }));
    const catalog = await loadNativeMapCatalog(invoke);
    expect(invoke).toHaveBeenCalledExactlyOnceWith('map_database', {});
    const info = currentMapInfo('prt_fild05', [entity], catalog, false);
    expect(info).toMatchObject({ name: 'Prontera Field 5', source: 'database' });
    expect(info.monsters).toHaveLength(7);
    expect(info.monsters.find((monster) => monster.classId === 4002)).toMatchObject({
      spawnCount: 30,
      visibleCount: 0,
    });
  });
  it.each([
    null,
    { maps: maps, monsters: monsters },
    { maps: '{}', monsters: JSON.stringify(monsters) },
    { maps: JSON.stringify(maps), monsters: '{broken' },
    { maps: JSON.stringify(maps), monsters: JSON.stringify(monsters), extra: 'untrusted' },
    {
      maps: JSON.stringify(maps),
      monsters: JSON.stringify({ Items: [{ ...monsters.Items[0], Id: 0 }] }),
    },
    { maps: ' '.repeat(2_000_001), monsters: '{}' },
  ])('rejects unadmitted native data before exposing it to targets', async (value) => {
    await expect(loadNativeMapCatalog(async () => value)).rejects.toThrow();
  });
});

describe('runtime catalogue availability', () => {
  afterEach(() => vi.useRealTimers());
  it.each([
    new MapDataError({ kind: 'http', status: 404 }),
    new MapDataError({ kind: 'size-limit' }),
    new MapDataError({ kind: 'invalid-data', message: 'Invalid map metadata' }),
  ])('does not retry a permanent failure: %s', async (failure) => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {
        throw failure;
      }),
      loader = new MapCatalogLoader(read, () => {});
    await loader.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(read).toHaveBeenCalledOnce();
    expect(loader.loading).toBe(false);
    expect(loader.failure).toEqual(failure.cause);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not retry malformed native assets or publish a partial catalogue', async () => {
    vi.useFakeTimers();
    const invoke = vi.fn(async () => ({ maps: '{broken', monsters: JSON.stringify(monsters) }));
    const loader = new MapCatalogLoader(
      () => loadNativeMapCatalog(invoke),
      () => {},
    );
    await loader.start();
    await vi.advanceTimersByTimeAsync(12_000);
    expect(invoke).toHaveBeenCalledOnce();
    expect(loader.catalog).toBeNull();
    expect(loader.failure?.kind).toBe('invalid-data');
    expect(loader.loading).toBe(false);
  });
  it('retries a transient failure and publishes only a complete validated database', async () => {
    vi.useFakeTimers();
    const catalog = parseMapCatalog(maps, monsters);
    const read = vi
      .fn<(_: AbortSignal) => Promise<typeof catalog>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(catalog);
    const changed = vi.fn(),
      loader = new MapCatalogLoader(read, changed),
      pending = loader.start();
    await Promise.resolve();
    expect(loader.catalog).toBeNull();
    expect(loader.loading).toBe(true);
    expect(currentMapInfo('prt_fild05', [entity], loader.catalog, loader.loading).source).toBe(
      'loading',
    );
    await vi.advanceTimersByTimeAsync(2_000);
    await pending;
    expect(read).toHaveBeenCalledTimes(2);
    expect(changed).toHaveBeenCalledTimes(2);
    expect(currentMapInfo('prt_fild05', [entity], loader.catalog, loader.loading)).toMatchObject({
      source: 'database',
      monsters: expect.any(Array),
    });
    expect(loader.catalog?.get(mapCode('prt_fild05'))?.monsters).toHaveLength(7);
    await loader.start();
    expect(read).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('bounds retries, retains an honest observed fallback, and can retry on a new request', async () => {
    vi.useFakeTimers();
    const read = vi.fn<() => Promise<MapCatalog>>(async () => {
        throw new Error('offline');
      }),
      loader = new MapCatalogLoader(read, () => {});
    const pending = loader.start();
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect(read).toHaveBeenCalledTimes(3);
    expect(loader.loading).toBe(false);
    expect(currentMapInfo('prt_fild05', [entity], loader.catalog, loader.loading)).toMatchObject({
      source: 'observed',
      name: 'prt_fild05',
    });
    expect(vi.getTimerCount()).toBe(0);
    read.mockImplementation(async () => parseMapCatalog(maps, monsters));
    await loader.start();
    expect(read).toHaveBeenCalledTimes(4);
    expect(loader.catalog).not.toBeNull();
  });
  it('cancels a backoff without another request or publication', async () => {
    vi.useFakeTimers();
    const read = vi.fn(async () => {
        throw new Error('offline');
      }),
      changed = vi.fn(),
      loader = new MapCatalogLoader(read, changed);
    const pending = loader.start();
    await Promise.resolve();
    loader.dispose();
    await pending;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(read).toHaveBeenCalledTimes(1);
    expect(changed).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it.each(['success', 'failure'] as const)(
    'does not admit, publish or retry a late native %s after mode/runtime retirement',
    async (outcome) => {
      const catalog = parseMapCatalog(maps, monsters);
      let finish!: (value: MapCatalog) => void;
      let fail!: (error: Error) => void;
      const read = vi.fn(
        () =>
          new Promise<typeof catalog>((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      const changed = vi.fn(),
        loader = new MapCatalogLoader(read, changed);
      const pending = loader.start();
      loader.dispose();
      if (outcome === 'success') finish(catalog);
      else fail(new Error('late failure'));
      await pending;
      await loader.start();
      expect(read).toHaveBeenCalledTimes(1);
      expect(loader.catalog).toBeNull();
      expect(changed).toHaveBeenCalledTimes(1);
    },
  );
  it('aborts browser requests and retires their deadline when the runtime closes', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>((_resolve, reject) =>
        init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))),
      );
    });
    const loader = new MapCatalogLoader(
        (signal) => loadMapCatalog(fetcher, signal),
        () => {},
      ),
      pending = loader.start();
    loader.dispose();
    await pending;
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });
});

describe('catalogue program interpretation', () => {
  afterEach(() => vi.useRealTimers());

  it('is lazy and creates a fresh retired request scope on each interpretation', async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      signals.push(init!.signal!);
      return new Response(JSON.stringify(String(url).endsWith('/maps.json') ? maps : monsters));
    });
    const program = mapCatalogProgram(fetcher);
    expect(fetcher).not.toHaveBeenCalled();
    expect((await runPromise(result(program)))._tag).toBe('Success');
    expect(signals).toHaveLength(2);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect((await runPromise(result(program)))._tag).toBe('Success');
    expect(signals).toHaveLength(4);
    expect(signals[0]).not.toBe(signals[2]);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
  });

  it.each(['maps.json', 'monsterdatabase.json'])(
    'ends on the first %s parse failure and retires a stalled sibling reader',
    async (failed) => {
      vi.useFakeTimers();
      const cancel = vi.fn(() => new Promise<void>(() => {}));
      const body = new ReadableStream<Uint8Array>({ cancel });
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url, init) => {
        signals.push(init!.signal!);
        return String(url).endsWith(`/${failed}`) ? new Response('{broken') : new Response(body);
      });
      const outcome = await loadMapCatalogResult(fetcher);
      expect(outcome).toMatchObject({ kind: 'failure', cause: { kind: 'invalid-data' } });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([
    { status: 404, cause: { kind: 'http', status: 404 } },
    { headers: { 'content-length': '2000001' }, cause: { kind: 'size-limit' } },
  ])(
    'returns typed $cause.kind failures without waiting for a sibling transport',
    async ({ cause, ...init }) => {
      vi.useFakeTimers();
      const signals: AbortSignal[] = [];
      const fetcher = vi.fn<typeof fetch>(async (url, options) => {
        signals.push(options!.signal!);
        return String(url).endsWith('/maps.json')
          ? new Response('', init)
          : new Promise<Response>(() => {});
      });
      expect(await loadMapCatalogResult(fetcher)).toEqual({ kind: 'failure', cause });
      expect(fetcher).toHaveBeenCalledTimes(2);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('keeps arbitrary transport rejection values in the typed failure channel', async () => {
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw undefined;
    });
    expect(await loadMapCatalogResult(fetcher)).toEqual({
      kind: 'failure',
      cause: { kind: 'network' },
    });
    await expect(loadMapCatalog(fetcher)).rejects.toMatchObject({
      name: 'MapDataError',
      cause: { kind: 'network' },
      message: 'Map database unavailable',
    });
  });

  it('preserves the shared deadline and releases both stalled response readers', async () => {
    vi.useFakeTimers();
    const cancel = [vi.fn(), vi.fn()];
    const bodies = cancel.map((cancel) => new ReadableStream<Uint8Array>({ cancel }));
    let responses = 0;
    const fetcher = vi.fn<typeof fetch>(async () => new Response(bodies[responses++]));
    const pending = loadMapCatalogResult(fetcher);
    await vi.advanceTimersByTimeAsync(11_999);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies.every((body) => body.locked)).toBe(true);
    expect(cancel.every((cancel) => cancel.mock.calls.length === 0)).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toEqual({ kind: 'failure', cause: { kind: 'timeout' } });
    expect(cancel.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
    expect(bodies.every((body) => !body.locked)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('closes the shared request scope when its Effect interpreter is interrupted', async () => {
    vi.useFakeTimers();
    const lifetime = new AbortController(),
      signals: AbortSignal[] = [];
    const bodies = [new ReadableStream<Uint8Array>(), new ReadableStream<Uint8Array>()];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signals.push(init!.signal!);
      return new Response(bodies[signals.length - 1]);
    });
    const pending = runPromiseExit(mapCatalogProgram(fetcher), { signal: lifetime.signal });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(bodies.every((body) => body.locked)).toBe(true);
    lifetime.abort();
    expect((await pending)._tag).toBe('Failure');
    await vi.advanceTimersByTimeAsync(0);
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expect(bodies.every((body) => !body.locked)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(['caller', 'deadline', 'interpreter'] as const)(
    'retires stalled transports and listeners on %s cancellation',
    async (end) => {
      vi.useFakeTimers();
      const caller = new AbortController(),
        interpreter = new AbortController(),
        signals: AbortSignal[] = [];
      const added = vi.spyOn(caller.signal, 'addEventListener'),
        removed = vi.spyOn(caller.signal, 'removeEventListener');
      const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
        signals.push(init!.signal!);
        return new Promise<Response>(() => {});
      });
      const pending =
        end === 'interpreter'
          ? runPromiseExit(mapCatalogProgram(fetcher, caller.signal), {
              signal: interpreter.signal,
            })
          : loadMapCatalogResult(fetcher, caller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (end === 'deadline') await vi.advanceTimersByTimeAsync(12_000);
      else if (end === 'caller') caller.abort();
      else interpreter.abort();
      const outcome = await pending;
      expect(outcome).toMatchObject(
        end === 'interpreter'
          ? { _tag: 'Failure' }
          : { kind: 'failure', cause: { kind: end === 'deadline' ? 'timeout' : 'cancelled' } },
      );
      await vi.advanceTimersByTimeAsync(0);
      expect(signals.every((signal) => signal.aborted)).toBe(true);
      for (const [type, listener] of added.mock.calls.filter(([type]) => type === 'abort')) {
        expect(
          removed.mock.calls.some(
            ([removedType, removedListener]) =>
              removedType === type && removedListener === listener,
          ),
        ).toBe(true);
      }
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each(['caller', 'deadline'] as const)(
    'retains the %s cause when fetch rejects with AbortError',
    async (end) => {
      vi.useFakeTimers();
      const caller = new AbortController();
      const fetcher = vi.fn<typeof fetch>(
        async (_url, init) =>
          new Promise<Response>((_resolve, reject) => {
            init!.signal!.addEventListener(
              'abort',
              () => reject(new DOMException('Request aborted', 'AbortError')),
              { once: true },
            );
          }),
      );
      const pending = loadMapCatalogResult(fetcher, caller.signal);
      await vi.advanceTimersByTimeAsync(0);
      expect(fetcher).toHaveBeenCalledTimes(2);
      if (end === 'deadline') await vi.advanceTimersByTimeAsync(12_000);
      else caller.abort();
      expect(await pending).toEqual({
        kind: 'failure',
        cause: { kind: end === 'deadline' ? 'timeout' : 'cancelled' },
      });
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it('gives explicit scope cancellation precedence over an unobserved transport failure', async () => {
    vi.useFakeTimers();
    const caller = new AbortController();
    const fetcher = vi.fn<typeof fetch>(async () => {
      throw new MapDataError({ kind: 'http', status: 404 });
    });
    const pending = loadMapCatalogResult(fetcher, caller.signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
    caller.abort();
    expect(await pending).toEqual({ kind: 'failure', cause: { kind: 'cancelled' } });
    expect(vi.getTimerCount()).toBe(0);
  });
});

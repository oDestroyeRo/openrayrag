import { fail, succeed } from 'effect/Result';
import { describe, expect, it, vi } from 'vitest';
import { MapDataError, mapDataResult, mapDataRetryDelay, type MapDataFailure } from './map-data-policy';
import { parseMapCatalogAssetsResult, parseMapCatalogResult, parseMapDataTextResult } from './map-data-logic';

describe('total catalogue admission and retry decisions', () => {
  it.each<MapDataFailure>([
    { kind: 'network' }, { kind: 'timeout' },
    { kind: 'http', status: 408 }, { kind: 'http', status: 429 },
    { kind: 'http', status: 500 }, { kind: 'http', status: 503 },
  ])('bounds retry for transient $kind failures', cause => {
    const before = structuredClone(cause);
    expect([0, 1, 2, -1, 0.5, Number.NaN].map(attempt => mapDataRetryDelay(cause, attempt)))
      .toEqual([2_000, 10_000, null, null, null, null]);
    expect(mapDataRetryDelay(cause, 0)).toBe(2_000);
    expect(cause).toEqual(before);
  });
  it.each<MapDataFailure>([
    { kind: 'cancelled' }, { kind: 'size-limit' }, { kind: 'invalid-data', message: 'offline' },
    { kind: 'http', status: 400 }, { kind: 'http', status: 401 },
    { kind: 'http', status: 404 }, { kind: 'http', status: 302 },
  ])('stops permanent $kind failures independently of display text', cause => {
    expect(mapDataRetryDelay(cause, 0)).toBeNull();
  });
  it('returns invalid input as values and does not mutate admitted input', () => {
    expect(parseMapDataTextResult('{broken')).toMatchObject({ kind: 'failure', cause: { kind: 'invalid-data' } });
    expect(parseMapDataTextResult(' '.repeat(2_000_001))).toEqual({ kind: 'failure', cause: { kind: 'size-limit' } });
    expect(parseMapCatalogResult({}, {})).toMatchObject({ kind: 'failure', cause: { kind: 'invalid-data' } });
    const maps = { Items: [{ Code: 'prontera', Name: 'Prontera' }] }, monsters = { Items: [] };
    const before = structuredClone({ maps, monsters });
    expect(parseMapCatalogResult(maps, monsters)).toEqual(parseMapCatalogResult(maps, monsters));
    expect({ maps, monsters }).toEqual(before);
  });
  it('retains byte-limit meaning across the native admission pipeline', () => {
    expect(parseMapCatalogAssetsResult({ maps: ' '.repeat(2_000_001), monsters: '{}' }))
      .toEqual({ kind: 'failure', cause: { kind: 'size-limit' } });
  });
  it('short-circuits native text admission before later parsing and bounds checks', () => {
    const parse = vi.spyOn(JSON, 'parse');
    try {
      expect(parseMapCatalogAssetsResult({ maps: '{broken', monsters: ' '.repeat(2_000_001) }))
        .toMatchObject({ kind: 'failure', cause: { kind: 'invalid-data' } });
      expect(parse).toHaveBeenCalledExactlyOnceWith('{broken');
    } finally { parse.mockRestore(); }
  });
  it('projects successful undefined separately from an admitted failure', () => {
    expect(mapDataResult(succeed(undefined))).toEqual({ kind: 'success', value: undefined });
    expect(mapDataResult(fail({ kind: 'network' } as const))).toEqual({ kind: 'failure', cause: { kind: 'network' } });
    expect(parseMapCatalogResult({ get Items() { throw undefined; } }, {}))
      .toEqual({ kind: 'failure', cause: { kind: 'invalid-data', message: 'Invalid map database' } });
  });
  it('owns the typed error cause independently of a mutable external alias', () => {
    const cause = { kind: 'http', status: 503 } as const;
    const error = new MapDataError(cause);
    Reflect.set(cause, 'status', 404);
    expect(mapDataRetryDelay(error.cause, 0)).toBe(2_000);
    expect(Object.isFrozen(error.cause)).toBe(true);
  });
});

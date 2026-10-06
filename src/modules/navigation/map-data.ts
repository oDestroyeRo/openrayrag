import { parseMapCatalogAssetsResult, parseMapCatalogResult, parseMapDataTextResult, type MapCatalog } from './map-data-logic';
import { readNativeMapData, waitForMapDataRetry, withMapDataRequests } from './map-data-effects';
import { mapDataFailure, mapDataRetryDelay, unwrapMapData, type MapDataFailure, type MapDataResult } from './map-data-policy';
export { currentMapInfo, parseMapCatalog, validMapInfo, type MapMonster, type MapInfo, type MapCatalog, type CatalogMonster } from './map-data-logic';
export { MAP_DATA_URL } from './map-data-effects';

export async function loadMapCatalog(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<MapCatalog> {
  return unwrapMapData(await loadMapCatalogResult(fetcher, signal));
}

export async function loadMapCatalogResult(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<MapDataResult<MapCatalog>> {
  try {
    return await withMapDataRequests(async read => {
      const [maps, monsters] = await Promise.all(['maps.json', 'monsterdatabase.json'].map(async file => unwrapMapData(parseMapDataTextResult(await read(file)))));
      return parseMapCatalogResult(maps, monsters);
    }, fetcher, signal);
  } catch (error) { return { kind: 'failure', cause: mapDataFailure(error) }; }
}

export async function loadNativeMapCatalog(invoke: (name: string, args: unknown) => Promise<unknown>): Promise<MapCatalog> {
  return unwrapMapData(parseMapCatalogAssetsResult(await readNativeMapData(invoke)));
}

type MapCatalogLoadState =
  | { readonly kind: 'idle' | 'loading' }
  | { readonly kind: 'ready'; readonly catalog: MapCatalog }
  | { readonly kind: 'failed'; readonly cause: MapDataFailure };

/** One runtime owns this catalogue load; retiring it suppresses every late result. */
export class MapCatalogLoader {
  private state: MapCatalogLoadState = { kind: 'idle' };
  get catalog(): MapCatalog | null { return this.state.kind === 'ready' ? this.state.catalog : null; }
  get loading(): boolean { return this.state.kind === 'loading'; }
  get failure(): MapDataFailure | null { return this.state.kind === 'failed' ? this.state.cause : null; }
  private readonly lifetime = new AbortController();
  constructor(private readonly read: (signal: AbortSignal) => Promise<MapCatalog>, private readonly changed: () => void) {}
  async start(): Promise<void> {
    if (this.lifetime.signal.aborted || this.loading || this.catalog) return;
    this.state = { kind: 'loading' }; this.changed();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const catalog = await this.read(this.lifetime.signal);
          if (!this.lifetime.signal.aborted) this.state = { kind: 'ready', catalog };
          return;
        } catch (error) {
          const cause = mapDataFailure(error);
          const delay = mapDataRetryDelay(cause, attempt);
          if (delay === null || !await waitForMapDataRetry(delay, this.lifetime.signal)) {
            this.state = { kind: 'failed', cause };
            return;
          }
        }
      }
    } finally {
      if (this.state.kind === 'loading') this.state = { kind: 'idle' };
      if (!this.lifetime.signal.aborted) this.changed();
    }
  }
  dispose(): void { this.lifetime.abort(); }
}

import { parseMapCatalog, parseMapCatalogAssets, parseMapDataText, type MapCatalog } from './map-data-logic';
import { readNativeMapData, waitForMapDataRetry, withMapDataRequests } from './map-data-effects';
export { currentMapInfo, parseMapCatalog, validMapInfo, type MapMonster, type MapInfo, type MapCatalog, type CatalogMonster } from './map-data-logic';
export { MAP_DATA_URL } from './map-data-effects';

export async function loadMapCatalog(fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<MapCatalog> {
  return withMapDataRequests(async read => {
    const [maps, monsters] = await Promise.all(['maps.json', 'monsterdatabase.json'].map(async file => parseMapDataText(await read(file))));
    return parseMapCatalog(maps, monsters);
  }, fetcher, signal);
}

export async function loadNativeMapCatalog(invoke: (name: string, args: unknown) => Promise<unknown>): Promise<MapCatalog> {
  return parseMapCatalogAssets(await readNativeMapData(invoke));
}

/** One runtime owns this catalogue load; retiring it suppresses every late result. */
export class MapCatalogLoader {
  catalog: MapCatalog | null = null;
  loading = false;
  private readonly lifetime = new AbortController();
  constructor(private readonly read: (signal: AbortSignal) => Promise<MapCatalog>, private readonly changed: () => void) {}
  async start(): Promise<void> {
    if (this.lifetime.signal.aborted || this.loading || this.catalog) return;
    this.loading = true; this.changed();
    try {
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const catalog = await this.read(this.lifetime.signal);
          if (!this.lifetime.signal.aborted) this.catalog = catalog;
          return;
        } catch {
          if (attempt === 2 || !await waitForMapDataRetry(attempt === 0 ? 2_000 : 10_000, this.lifetime.signal)) return;
        }
      }
    } finally {
      this.loading = false;
      if (!this.lifetime.signal.aborted) this.changed();
    }
  }
  dispose(): void { this.lifetime.abort(); }
}

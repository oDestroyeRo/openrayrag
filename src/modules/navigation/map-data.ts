import { parseMapCatalog, parseMapDataText, type MapCatalog } from './map-data-logic';
import { withMapDataRequests } from './map-data-effects';
export { currentMapInfo, parseMapCatalog, validMapInfo, type MapMonster, type MapInfo, type MapCatalog, type CatalogMonster } from './map-data-logic';
export { MAP_DATA_URL } from './map-data-effects';

export async function loadMapCatalog(fetcher: typeof fetch = fetch): Promise<MapCatalog> {
  return withMapDataRequests(async read => {
    const [maps, monsters] = await Promise.all(['maps.json', 'monsterdatabase.json'].map(async file => parseMapDataText(await read(file))));
    return parseMapCatalog(maps, monsters);
  }, fetcher);
}

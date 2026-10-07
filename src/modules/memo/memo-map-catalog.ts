import catalog from '../../data/memo-map-catalog.json';

const permissions = new Map(catalog.items.map((item) => [item.map, item.canMemo]));
/** Null means absent from the pinned metadata, never permission inferred from collision. */
export function canMemoMap(map: string): boolean | null {
  return permissions.get(map) ?? null;
}

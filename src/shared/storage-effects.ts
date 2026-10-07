/** Browser and injected storage effects shared by local document coordinators. */
export interface TextStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}
export function readStoredText(storage: TextStorage, key: string): string | null {
  return storage.getItem(key);
}
export function writeStoredText(storage: TextStorage, key: string, text: string): void {
  storage.setItem(key, text);
}

/** Access can itself throw when browser storage is disabled. */
export function browserTextStorage(): TextStorage {
  return localStorage;
}

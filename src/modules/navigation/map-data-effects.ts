import { GAME_URL } from '../protocol/protocol';
export const MAP_DATA_URL = `${GAME_URL}StreamingAssets/ClientConfigGenerated/`;

/** Both asset requests share one bounded lifetime; retire it on every exit path. */
export async function withMapDataRequests<T>(action: (read: (file: string) => Promise<string>) => Promise<T>, fetcher: typeof fetch = fetch, signal?: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const read = async (file: string) => {
      const response = await fetcher(`${MAP_DATA_URL}${file}`, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Map database unavailable');
      return response.text();
    };
    return await action(read);
  } finally { clearTimeout(timer); controller.abort(); signal?.removeEventListener('abort', abort); }
}

/** The native command admits only the two fixed public assets, without cookies. */
export async function readNativeMapData(invoke: (name: string, args: unknown) => Promise<unknown>): Promise<unknown> {
  return invoke('map_database', {});
}

export function waitForMapDataRetry(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise(resolve => {
    const finish = (retry: boolean) => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(retry); };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

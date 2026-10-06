import { GAME_URL } from './protocol';
export const MAP_DATA_URL = `${GAME_URL}StreamingAssets/ClientConfigGenerated/`;

/** Both asset requests share one bounded lifetime; retire it on every exit path. */
export async function withMapDataRequests<T>(action: (read: (file: string) => Promise<string>) => Promise<T>, fetcher: typeof fetch = fetch): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 12_000);
  try {
    const read = async (file: string) => {
      const response = await fetcher(`${MAP_DATA_URL}${file}`, { signal: controller.signal, credentials: 'omit' });
      if (!response.ok) throw new Error('Map database unavailable');
      return response.text();
    };
    return await action(read);
  } finally { clearTimeout(timer); controller.abort(); }
}

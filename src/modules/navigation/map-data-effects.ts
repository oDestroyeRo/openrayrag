import { GAME_URL } from '../protocol/protocol';
import { MapDataError, MAX_MAP_DOCUMENT_BYTES } from './map-data-policy';
export const MAP_DATA_URL = `${GAME_URL}StreamingAssets/ClientConfigGenerated/`;

/** Bound bytes while receiving, before text/JSON allocation. Own the reader to its exit. */
export async function readMapDataResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  const body = response.body;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let completed = false;
  const abort = () => {
    void reader?.cancel().catch(() => {});
  };
  try {
    if (!response.ok) throw new MapDataError({ kind: 'http', status: response.status });
    const declared = response.headers.get('content-length');
    if (
      declared !== null &&
      (!/^\d+$/.test(declared) || Number(declared) > MAX_MAP_DOCUMENT_BYTES)
    ) {
      throw new MapDataError({ kind: 'size-limit' });
    }
    if (!body) return '';
    reader = body.getReader();
    signal.addEventListener('abort', abort, { once: true });
    // A fixed buffer also bounds overhead when a server sends tiny chunks.
    const bytes = new Uint8Array(MAX_MAP_DOCUMENT_BYTES);
    let size = 0;
    while (true) {
      if (signal.aborted) throw signal.reason;
      const chunk = await reader.read();
      if (signal.aborted) throw signal.reason;
      if (chunk.done) break;
      if (chunk.value.byteLength > MAX_MAP_DOCUMENT_BYTES - size)
        throw new MapDataError({ kind: 'size-limit' });
      bytes.set(chunk.value, size);
      size += chunk.value.byteLength;
    }
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, size));
    } catch {
      throw new MapDataError({ kind: 'invalid-data', message: 'Invalid map database text' });
    }
    completed = true;
    return text;
  } finally {
    signal.removeEventListener('abort', abort);
    // A cleanup rejection must preserve the HTTP/read/admission failure.
    if (!completed) {
      try {
        void (reader ? reader.cancel() : body?.cancel())?.catch(() => {});
      } catch {
        /* best effort after failure */
      }
    }
    try {
      reader?.releaseLock();
    } catch (error) {
      // Successful reads surface unlock failures; failed reads keep their original error.
      // oxlint-disable-next-line eslint/no-unsafe-finally
      if (completed) throw error;
    }
  }
}

/** Both asset requests share one bounded lifetime; retire it on every exit path. */
export async function withMapDataRequests<T>(
  action: (read: (file: string) => Promise<string>, signal: AbortSignal) => Promise<T>,
  fetcher: typeof fetch = fetch,
  signal?: AbortSignal,
  programSignal?: AbortSignal,
): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(new MapDataError({ kind: 'cancelled' }));
  signal?.addEventListener('abort', abort, { once: true });
  programSignal?.addEventListener('abort', abort, { once: true });
  if (signal?.aborted || programSignal?.aborted) abort();
  const timer = setTimeout(() => controller.abort(new MapDataError({ kind: 'timeout' })), 12_000);
  const failure = (error: unknown): unknown =>
    error instanceof MapDataError
      ? error
      : controller.signal.aborted
        ? controller.signal.reason
        : new MapDataError({ kind: 'network' });
  try {
    const read = async (file: string) => {
      try {
        if (controller.signal.aborted) throw controller.signal.reason;
        const response = await fetcher(`${MAP_DATA_URL}${file}`, {
          signal: controller.signal,
          credentials: 'omit',
        });
        return await readMapDataResponse(response, controller.signal);
      } catch (error) {
        throw failure(error);
      }
    };
    return await action(read, controller.signal);
  } catch (error) {
    throw failure(error);
  } finally {
    clearTimeout(timer);
    controller.abort();
    signal?.removeEventListener('abort', abort);
    programSignal?.removeEventListener('abort', abort);
  }
}

/** The native command admits only the two fixed public assets, without cookies. */
export async function readNativeMapData(
  invoke: (name: string, args: unknown) => Promise<unknown>,
): Promise<unknown> {
  return invoke('map_database', {});
}

export function waitForMapDataRetry(delay: number, signal: AbortSignal): Promise<boolean> {
  if (signal.aborted) return Promise.resolve(false);
  return new Promise((resolve) => {
    const finish = (retry: boolean) => {
      clearTimeout(timer);
      signal.removeEventListener('abort', abort);
      resolve(retry);
    };
    const abort = () => finish(false);
    const timer = setTimeout(() => finish(true), delay);
    signal.addEventListener('abort', abort, { once: true });
  });
}

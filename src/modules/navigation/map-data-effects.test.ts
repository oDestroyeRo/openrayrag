import { afterEach, describe, expect, it, vi } from 'vitest';
import { readMapDataResponse, withMapDataRequests } from './map-data-effects';
import { MapDataError, MAX_MAP_DOCUMENT_BYTES } from './map-data-policy';

function streamed(
  chunks: readonly Uint8Array[],
  init: ResponseInit = {},
  cancellation?: () => void | Promise<void>,
) {
  let index = 0;
  const cancel = vi.fn(cancellation);
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      const chunk = chunks[index++];
      if (chunk) controller.enqueue(chunk);
      else controller.close();
    },
    cancel,
  });
  return { response: new Response(body, init), body, cancel };
}

describe('bounded catalogue response ownership', () => {
  afterEach(() => vi.useRealTimers());
  it('decodes UTF-8 split across chunks and releases its reader', async () => {
    const bytes = new TextEncoder().encode('แผนที่');
    const fixture = streamed(Array.from(bytes, (byte) => new Uint8Array([byte])));
    expect(await readMapDataResponse(fixture.response, new AbortController().signal)).toBe('แผนที่');
    expect(fixture.body.locked).toBe(false);
    expect(fixture.cancel).not.toHaveBeenCalled();
  });
  it.each(['declared', 'streamed'] as const)(
    'rejects %s overflow before accumulating its body',
    async (mode) => {
      const fixture =
        mode === 'declared'
          ? streamed([], { headers: { 'content-length': String(MAX_MAP_DOCUMENT_BYTES + 1) } })
          : streamed([
              new Uint8Array(MAX_MAP_DOCUMENT_BYTES),
              new Uint8Array([1]),
              new Uint8Array([2]),
            ]);
      await expect(
        readMapDataResponse(fixture.response, new AbortController().signal),
      ).rejects.toMatchObject({ cause: { kind: 'size-limit' } });
      expect(fixture.cancel).toHaveBeenCalledOnce();
      expect(fixture.body.locked).toBe(false);
    },
  );
  it.each([{ bytes: [0xff] }, { bytes: [0xe0, 0xa4] }])(
    'rejects invalid or incomplete UTF-8 as a permanent value: $bytes',
    async ({ bytes }) => {
      const fixture = streamed([new Uint8Array(bytes)]);
      await expect(
        readMapDataResponse(fixture.response, new AbortController().signal),
      ).rejects.toMatchObject({ cause: { kind: 'invalid-data' } });
      expect(fixture.body.locked).toBe(false);
    },
  );
  it('preserves an HTTP error when cancelling its body fails', async () => {
    const fixture = streamed([], { status: 404 }, async () => {
      throw new Error('cleanup');
    });
    await expect(
      readMapDataResponse(fixture.response, new AbortController().signal),
    ).rejects.toMatchObject({ cause: { kind: 'http', status: 404 } });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.body.locked).toBe(false);
  });
  it('does not wait on a failed response cleanup that never settles', async () => {
    const fixture = streamed([], { status: 404 }, () => new Promise<void>(() => {}));
    await expect(
      readMapDataResponse(fixture.response, new AbortController().signal),
    ).rejects.toMatchObject({ cause: { kind: 'http', status: 404 } });
    expect(fixture.cancel).toHaveBeenCalledOnce();
    expect(fixture.body.locked).toBe(false);
  });
  it('releases an interrupted reader and keeps transport data out of the error', async () => {
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.error(new Error('private transport detail'));
      },
    });
    await expect(
      withMapDataRequests(
        (read) => read('maps.json'),
        async () => new Response(body),
      ),
    ).rejects.toMatchObject({ cause: { kind: 'network' }, message: 'Map database unavailable' });
    expect(body.locked).toBe(false);
  });
  it('cancels a stalled body at the shared deadline and retires its timer', async () => {
    vi.useFakeTimers();
    const cancel = vi.fn(),
      body = new ReadableStream<Uint8Array>({ cancel });
    const pending = expect(
      withMapDataRequests(
        (read) => read('maps.json'),
        async () => new Response(body),
      ),
    ).rejects.toMatchObject({ cause: { kind: 'timeout' } });
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('retires a response reader on caller cancellation', async () => {
    const lifetime = new AbortController(),
      cancel = vi.fn(),
      body = new ReadableStream<Uint8Array>({ cancel });
    const pending = expect(
      withMapDataRequests(
        (read) => read('maps.json'),
        async () => new Response(body),
        lifetime.signal,
      ),
    ).rejects.toBeInstanceOf(MapDataError);
    await Promise.resolve();
    lifetime.abort();
    await pending;
    expect(body.locked).toBe(false);
    expect(cancel).toHaveBeenCalledOnce();
  });
  it('does not start effects for an already cancelled request scope', async () => {
    const lifetime = new AbortController(),
      fetcher = vi.fn<typeof fetch>();
    lifetime.abort();
    await expect(
      withMapDataRequests((read) => read('maps.json'), fetcher, lifetime.signal),
    ).rejects.toMatchObject({ cause: { kind: 'cancelled' } });
    expect(fetcher).not.toHaveBeenCalled();
  });
});

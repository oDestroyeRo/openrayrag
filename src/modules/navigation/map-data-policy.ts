import { match, type Result } from 'effect/Result';

/** Failure causes drive policy; display text is only a projection. */
export type MapDataFailure =
  | { readonly kind: 'network' | 'timeout' | 'cancelled' | 'size-limit' }
  | { readonly kind: 'http'; readonly status: number }
  | { readonly kind: 'invalid-data'; readonly message: string };

export type MapDataResult<T> =
  | { readonly kind: 'success'; readonly value: T }
  | { readonly kind: 'failure'; readonly cause: MapDataFailure };

/** Project composed admission at the existing public result boundary. */
export function mapDataResult<T>(result: Result<T, MapDataFailure>): MapDataResult<T> {
  return match(result, {
    onFailure: cause => ({ kind: 'failure' as const, cause }),
    onSuccess: value => ({ kind: 'success' as const, value }),
  });
}

export const MAX_MAP_DOCUMENT_BYTES = 2_000_000;

export function mapDataFailureMessage(cause: MapDataFailure): string {
  switch (cause.kind) {
    case 'network': case 'http': return 'Map database unavailable';
    case 'timeout': return 'Map database request deadline exceeded';
    case 'cancelled': return 'Map database request cancelled';
    case 'size-limit': return 'Map database exceeds its limit';
    case 'invalid-data': return cause.message;
  }
}

/** Compatibility Promise APIs reject with a typed cause, never raw transport data. */
export class MapDataError extends Error {
  readonly cause: MapDataFailure;
  constructor(cause: MapDataFailure) {
    super(mapDataFailureMessage(cause));
    this.name = 'MapDataError';
    this.cause = Object.freeze({ ...cause });
  }
}

export function mapDataFailure(error: unknown): MapDataFailure {
  // Unknown native IPC/adaptor failures retain the existing transient policy.
  return error instanceof MapDataError ? error.cause : { kind: 'network' };
}

export function mapDataRetryDelay(cause: MapDataFailure, attempt: number): number | null {
  if (!Number.isInteger(attempt) || attempt < 0 || attempt >= 2) return null;
  const transient = cause.kind === 'network' || cause.kind === 'timeout'
    || cause.kind === 'http' && (cause.status === 408 || cause.status === 429 || cause.status >= 500 && cause.status <= 599);
  return transient ? (attempt === 0 ? 2_000 : 10_000) : null;
}

/** Unwrap only at an existing throwing/Promise compatibility boundary. */
export function unwrapMapData<T>(result: MapDataResult<T>): T {
  if (result.kind === 'failure') throw new MapDataError(result.cause);
  return result.value;
}

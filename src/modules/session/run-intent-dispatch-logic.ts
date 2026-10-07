export type DispatchOutcome =
  | { readonly status: 'accepted'; readonly value: unknown }
  | { readonly status: 'failed'; readonly error: unknown }
  | { readonly status: 'retired' };

/** Read immediately before synchronous effects; read again after any additional await. */
export interface DispatchReceipt {
  readonly outcome: DispatchOutcome;
}

export const retiredOutcome: DispatchOutcome = Object.freeze({ status: 'retired' });

export type PendingKind = 'resume' | 'login' | 'service' | 'manual' | 'limit';

export type NativeDispatch = (
  command: 'control_bot' | 'login_game' | 'reconnect_game',
  args?: Record<string, unknown>,
) => Promise<unknown>;

declare const closeTokenValue: unique symbol;
export type CloseToken = string & { readonly [closeTokenValue]: 'SettingsCloseToken' };
export interface CloseRequest { readonly token: CloseToken }

/** Invalid native events remain no-ops, including malformed and unrelated tokens. */
export function closeRequest(value: unknown): CloseRequest | null {
  if (!value || typeof value !== 'object') return null;
  const token = (value as { token?: unknown }).token;
  if (typeof token !== 'string' || !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(token)) return null;
  return { token: token as CloseToken };
}

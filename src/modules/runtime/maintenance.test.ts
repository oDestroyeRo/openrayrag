import { expect, it } from 'vitest';
import { MaintenanceLease } from './maintenance';
it('requires positive idle, rejects stale revisions and keeps an acknowledged freeze until native release', () => {
  let now = 0;
  const lease = new MaintenanceLease(() => now),
    nonce = 'a'.repeat(32);
  expect(lease.reserve(nonce, false)).toBeNull();
  const revision = lease.reserve(nonce, true)!;
  expect(() => lease.assertDispatch()).toThrow();
  expect(lease.hold(nonce, revision)).toBe(true);
  now = 5000;
  expect(lease.blocked).toBe(true);
  lease.mutate();
  expect(lease.matches(nonce, revision)).toBe(false);
  lease.release('b'.repeat(32));
  expect(lease.blocked).toBe(true);
  lease.release(nonce);
  expect(lease.blocked).toBe(false);
});
it('expires only an unacknowledged reservation', () => {
  let now = 0;
  const lease = new MaintenanceLease(() => now);
  lease.reserve('a'.repeat(32), true);
  now = 4000;
  expect(lease.blocked).toBe(false);
});

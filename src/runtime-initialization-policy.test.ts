import { describe, expect, it } from 'vitest';
import { initializationCertificate, initializationIdentityCurrent, initializationResetCandidate, initializationResetAllowed, shouldSendPlayerReady } from './runtime-initialization-policy';

describe('shared initialization proof', () => {
  it('requires every first-entry fact before certifying a guard reset', () => {
    const full = { initial: true, fullResources: true, memo: true, readyObserved: true };
    expect(initializationCertificate(full)).toBe(true);
    for (const key of Object.keys(full) as Array<keyof typeof full>) expect(initializationCertificate({ ...full, [key]: false })).toBe(false);
  });
  it('requires ordinary own entry and unchanged known resource revisions', () => {
    expect(initializationResetAllowed(true, 1, 'resource-v1', 'resource-v1')).toBe(true);
    expect(initializationResetAllowed(true, 1, 'resource-v1', 'resource-v2')).toBe(false);
    expect(initializationResetAllowed(true, 1, null, null)).toBe(false);
    for (const entry of [undefined, 0, 2, 3]) expect(initializationResetCandidate(true, entry, 'resource-v1')).toBe(false);
    expect(initializationResetCandidate(false, 1, 'resource-v1')).toBe(false);
  });
  it('waits for full resources and memo only during initial readiness', () => {
    expect(shouldSendPlayerReady(false, false, true, true)).toBe(false);
    expect(shouldSendPlayerReady(true, false, false, false)).toBe(true);
    expect(shouldSendPlayerReady(true, true, true, true)).toBe(true);
    expect(shouldSendPlayerReady(true, true, false, true)).toBe(false);
    expect(shouldSendPlayerReady(true, true, true, false)).toBe(false);
  });
  it('rejects guard reconciliation after actor replacement, maintenance or transport retirement', () => {
    expect(initializationIdentityCurrent(true, 'own-v1', 'own-v1', false, false)).toBe(true);
    expect(initializationIdentityCurrent(true, 'own-v1', 'own-v2', false, false)).toBe(false);
    expect(initializationIdentityCurrent(true, null, null, false, false)).toBe(false);
    expect(initializationIdentityCurrent(false, 'own-v1', 'own-v1', false, false)).toBe(false);
    expect(initializationIdentityCurrent(true, 'own-v1', 'own-v1', true, false)).toBe(false);
    expect(initializationIdentityCurrent(true, 'own-v1', 'own-v1', false, true)).toBe(false);
  });
});

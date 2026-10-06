import { describe, expect, it } from 'vitest';
import { initializationCertificate, initializationIdentityCurrent, initializationResetCandidate, initializationResetAllowed, shouldSendPlayerReady } from './runtime-initialization-policy';

describe('shared initialization proof', () => {
  it('requires every first-entry fact before certifying a guard reset', () => {
    const full = { initial: true, fullResources: true, memo: true, readyObserved: true };
    expect(initializationCertificate(full)).toBe(true);
    for (const key of Object.keys(full) as Array<keyof typeof full>) expect(initializationCertificate({ ...full, [key]: false })).toBe(false);
  });
  it('requires ordinary own entry and unchanged known resource revisions', () => {
    const input = { certificate: true, entryType: 1, baseline: 'resource-v1', current: 'resource-v1' };
    expect(initializationResetAllowed(input)).toBe(true);
    expect(initializationResetAllowed({ ...input, current: 'resource-v2' })).toBe(false);
    expect(initializationResetAllowed({ ...input, baseline: null, current: null })).toBe(false);
    for (const entryType of [undefined, 0, 2, 3]) expect(initializationResetCandidate({ ...input, entryType })).toBe(false);
    expect(initializationResetCandidate({ ...input, certificate: false })).toBe(false);
  });
  it('waits for full resources and memo only during initial readiness', () => {
    const input = { pending: true, initial: true, fullResources: true, memo: true };
    expect(shouldSendPlayerReady({ ...input, pending: false, initial: false })).toBe(false);
    expect(shouldSendPlayerReady({ ...input, initial: false, fullResources: false, memo: false })).toBe(true);
    expect(shouldSendPlayerReady(input)).toBe(true);
    expect(shouldSendPlayerReady({ ...input, fullResources: false })).toBe(false);
    expect(shouldSendPlayerReady({ ...input, memo: false })).toBe(false);
  });
  it('rejects guard reconciliation after actor replacement, maintenance or transport retirement', () => {
    const input = { certificate: true, own: 'own-v1', current: 'own-v1', blocked: false, ended: false };
    expect(initializationIdentityCurrent(input)).toBe(true);
    expect(initializationIdentityCurrent({ ...input, current: 'own-v2' })).toBe(false);
    expect(initializationIdentityCurrent({ ...input, own: null, current: null })).toBe(false);
    expect(initializationIdentityCurrent({ ...input, certificate: false })).toBe(false);
    expect(initializationIdentityCurrent({ ...input, blocked: true })).toBe(false);
    expect(initializationIdentityCurrent({ ...input, ended: true })).toBe(false);
  });
});

export interface InitializationEvidence {
  initial: boolean; fullResources: boolean; memo: boolean; readyObserved: boolean;
}
/** Ready alone never grants authority to clear a retained resource guard. */
export function initializationCertificate(evidence: InitializationEvidence): boolean {
  return evidence.initial && evidence.fullResources && evidence.memo && evidence.readyObserved;
}
export function initializationResetAllowed(certificate: boolean, entryType: number | undefined,
  baseline: string | null, current: string | null): boolean {
  return initializationResetCandidate(certificate, entryType, baseline) && baseline === current;
}
/** Resource readback can advance receipts, so callers first check this admission. */
export function initializationResetCandidate(certificate: boolean, entryType: number | undefined, baseline: string | null): boolean {
  return certificate && entryType === 1 && baseline !== null;
}
export function shouldSendPlayerReady(pending: boolean, initial: boolean, fullResources: boolean, memo: boolean): boolean {
  return pending && (!initial || fullResources && memo);
}
export function initializationIdentityCurrent(certificate: boolean, own: string | null,
  current: string | null, blocked: boolean, ended: boolean): boolean {
  return certificate && own !== null && !blocked && !ended && own === current;
}

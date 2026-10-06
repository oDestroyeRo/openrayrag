export interface InitializationEvidence {
  initial: boolean; fullResources: boolean; memo: boolean; readyObserved: boolean;
}
/** Ready alone never grants authority to clear a retained resource guard. */
export function initializationCertificate(evidence: InitializationEvidence): boolean {
  return evidence.initial && evidence.fullResources && evidence.memo && evidence.readyObserved;
}
export interface InitializationResetInput {
  certificate: boolean; entryType: number | undefined; baseline: string | null;
}
export function initializationResetAllowed(input: InitializationResetInput & { current: string | null }): boolean {
  return initializationResetCandidate(input) && input.baseline === input.current;
}
/** Resource readback can advance receipts, so callers first check this admission. */
export function initializationResetCandidate({ certificate, entryType, baseline }: InitializationResetInput): boolean {
  return certificate && entryType === 1 && baseline !== null;
}
export interface PlayerReadyInput {
  pending: boolean; initial: boolean; fullResources: boolean; memo: boolean;
}
export function shouldSendPlayerReady({ pending, initial, fullResources, memo }: PlayerReadyInput): boolean {
  return pending && (!initial || fullResources && memo);
}
export interface InitializationIdentityInput {
  certificate: boolean; own: string | null; current: string | null; blocked: boolean; ended: boolean;
}
export function initializationIdentityCurrent({ certificate, own, current, blocked, ended }: InitializationIdentityInput): boolean {
  return certificate && own !== null && !blocked && !ended && own === current;
}

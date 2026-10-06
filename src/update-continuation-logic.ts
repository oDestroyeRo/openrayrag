import { formDocument, type FormDocument, type FormDocumentInput } from './current-form-logic';
import { validateControllerUpdateCheckpoint, type ControllerUpdateCheckpoint, type ValidatedControllerUpdateCheckpoint } from './controller-update-logic';
import { validStatus, type GameStatus, type ValidatedGameStatus } from './game-status';
import { characterSlot, type CharacterSlot } from './login-logic';
import { validateFieldRunCheckpoint, type FieldRunCheckpoint } from './reconnect-logic';
export interface UpdateAccount { username: string; characterSlot: number; mode: 'botOnly' | 'gameClient' }
/** The legacy continuation codec coerces mode only for admission and retains its raw value. */
export interface UpdateAccountInput { username: string; characterSlot: number; mode: unknown }
declare const updateValue: unique symbol;
export type UpdateUsername = string & { readonly [updateValue]: 'UpdateUsername' };
export type UpdateRequestId = string & { readonly [updateValue]: 'UpdateRequestId' };
export interface ValidatedUpdateAccount { readonly username: UpdateUsername; readonly characterSlot: CharacterSlot; readonly mode: unknown }
/** Correlation IDs intentionally accept every string, including custom/empty test IDs. */
export function updateRequestId(value: unknown): UpdateRequestId {
  if (typeof value !== 'string') throw new Error('Update handoff is unavailable.');
  return value as UpdateRequestId;
}
/** Opaque native reply: the frontend forwards its exact payload without interpreting it. */
declare const reservationValue: unique symbol;
export interface NativeUpdateReservation { readonly rawNonce: unknown; readonly [reservationValue]: true }
export function nativeUpdateReservation(rawNonce: unknown): NativeUpdateReservation { return { rawNonce } as NativeUpdateReservation; }
export interface UpdateContinuationInput {
  version: 1; account: UpdateAccountInput; form: FormDocumentInput; field: FieldRunCheckpoint | null;
  runtime: ControllerUpdateCheckpoint & { status: ControllerUpdateCheckpoint['status'] & GameStatus }; savedAccount: boolean;
}

export interface UpdateContinuation {
  readonly version: 1; readonly account: ValidatedUpdateAccount; readonly form: FormDocument; readonly field: FieldRunCheckpoint | null;
  readonly runtime: ValidatedControllerUpdateCheckpoint & { readonly status: ValidatedControllerUpdateCheckpoint['status'] & ValidatedGameStatus }; readonly savedAccount: boolean;
}

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length
  && expected.every(key => Object.hasOwn(v, key));

export const ERROR = 'Update continuation could not be verified. Start the bot explicitly.';

/** Keep the existing account policy, including the legacy coercive mode guard. */
export function updateAccount(value: unknown): ValidatedUpdateAccount {
  if (!record(value) || !keys(value, ['username', 'characterSlot', 'mode'])
    || typeof value.username !== 'string' || !value.username.trim() || value.username.length > 64
    || /[\u0000-\u001f\u007f]/.test(value.username) || !Number.isInteger(value.characterSlot)
    || Number(value.characterSlot) < 0 || Number(value.characterSlot) > 2
    || !['botOnly', 'gameClient'].includes(String(value.mode))) throw new Error(ERROR);
  return { username: value.username as UpdateUsername, characterSlot: characterSlot(value.characterSlot),
    mode: value.mode };
}

export function validateUpdateContinuation(input: unknown, now: number): UpdateContinuation {
  if (!record(input) || !keys(input, ['version', 'account', 'form', 'field', 'runtime', 'savedAccount'])
    || input.version !== 1 || typeof input.savedAccount !== 'boolean' || !record(input.account)
    || !keys(input.account, ['username', 'characterSlot', 'mode'])) throw new Error(ERROR);
  const account = updateAccount(input.account);
  const runtime = validateControllerUpdateCheckpoint(input.runtime, now);
  if (!validStatus(runtime.status) || !runtime.status.connected || !runtime.status.compatible
    || !runtime.status.player) throw new Error(ERROR);
  const field = input.field === null ? null : validateFieldRunCheckpoint(input.field, now);
  if (field && (field.character !== runtime.status.player.name || field.session !== runtime.status.sessionId)
    || !field && !runtime.macro && !runtime.settings) throw new Error(ERROR);
  return { version: 1, account, form: formDocument(input.form), field, runtime:{...runtime,status:runtime.status},
  savedAccount: input.savedAccount };
}

export function sameUpdateAccount(a: Readonly<UpdateAccountInput>, b: Readonly<UpdateAccountInput>): boolean {
  return a.username === b.username && a.characterSlot === b.characterSlot && a.mode === b.mode;
}

export type UpdateCommand = 'update_prepare' | 'update_restore';
export interface Reply { readonly id: UpdateRequestId; readonly command: UpdateCommand; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

export interface InstallationAdapter {
  flush(): Promise<FormDocument>;
  game(): { open: boolean; status: GameStatus | null };
  interrupted(): boolean;
  status(message: string): void;
}

export interface UpdateInstallationResult {
  continuation: UpdateContinuation | null;
  retired: boolean;
  recoveryFailed: boolean;
}

export type UpdateStep = 'settings' | 'prepare' | 'reserve' | 'confirmation';

export function deferredReason(step: UpdateStep, error: unknown): string {
  // Native errors may contain private paths or account details. Only these
  // known generic messages cross the presentation seam.
  const reasons: Record<string, string> = {
    'No verified update is ready.': 'The verified update is no longer ready.',
    'Waiting for login to settle.': 'Sign-in has not finished.',
    'Save current settings before updating.': 'Current settings need to be saved.',
    'Current settings changed before update settlement.': 'Current settings changed while preparing the update.',
    'Waiting for a fresh stopped client before updating.': 'The connection has not confirmed a fresh stopped state.',
    'Game update settlement is unavailable.': 'The game could not be reached for update confirmation.',
    'Update settlement expired.': 'The game confirmation expired.',
    'Update settlement changed.': 'Game activity changed during update confirmation.',
    'Login settlement changed.': 'Sign-in activity changed during update confirmation.',
    'Game settlement changed before replacement.': 'Game activity changed before installation.',
  };
  const reason = typeof error === 'string' && Object.hasOwn(reasons, error) ? reasons[error] : null;
  const fallback = {
    settings: 'Current settings could not be saved. Check the settings form.',
    prepare: 'The current game action has not reached a confirmed boundary.',
    reserve: 'The connection could not be prepared for update confirmation.',
    confirmation: 'The game could not complete update confirmation.',
  };
  return `Update deferred. ${reason ?? fallback[step]} It will retry automatically.`;
}

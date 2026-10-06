import { formDocument, type FormDocument } from './current-form';
import { validateControllerUpdateCheckpoint, type ControllerUpdateCheckpoint } from './controller-update-logic';
import { validStatus, type GameStatus } from './game-status';
import { validateFieldRunCheckpoint, type FieldRunCheckpoint } from './reconnect-logic';
export interface UpdateAccount { username: string; characterSlot: number; mode: 'botOnly' | 'gameClient' }

export interface UpdateContinuation {
  version: 1; account: UpdateAccount; form: FormDocument; field: FieldRunCheckpoint | null;
  runtime: ControllerUpdateCheckpoint & { status: ControllerUpdateCheckpoint['status'] & GameStatus }; savedAccount: boolean;
}

export type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;

export const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length
  && expected.every(key => Object.hasOwn(v, key));

export const ERROR = 'Update continuation could not be verified. Start the bot explicitly.';

export function validateUpdateContinuation(input: unknown, now: number): UpdateContinuation {
  if (!record(input) || !keys(input, ['version', 'account', 'form', 'field', 'runtime', 'savedAccount'])
    || input.version !== 1 || typeof input.savedAccount !== 'boolean' || !record(input.account)
    || !keys(input.account, ['username', 'characterSlot', 'mode'])) throw new Error(ERROR);
  const account = input.account;
  if (typeof account.username !== 'string' || !account.username.trim() || account.username.length > 64
    || /[\u0000-\u001f\u007f]/.test(account.username) || !Number.isInteger(account.characterSlot)
    || Number(account.characterSlot) < 0 || Number(account.characterSlot) > 2
    || !['botOnly', 'gameClient'].includes(String(account.mode))) throw new Error(ERROR);
  const runtime = validateControllerUpdateCheckpoint(input.runtime, now);
  if (!validStatus(runtime.status) || !runtime.status.connected || !runtime.status.compatible
    || !runtime.status.player) throw new Error(ERROR);
  const field = input.field === null ? null : validateFieldRunCheckpoint(input.field, now);
  if (field && (field.character !== runtime.status.player.name || field.session !== runtime.status.sessionId)
    || !field && !runtime.macro && !runtime.settings) throw new Error(ERROR);
  return { version: 1, account: { username: account.username, characterSlot: Number(account.characterSlot),
    mode: account.mode as UpdateAccount['mode'] }, form: formDocument(input.form), field, runtime:{...runtime,status:runtime.status},
  savedAccount: input.savedAccount };
}

export function sameUpdateAccount(a: UpdateAccount, b: UpdateAccount): boolean {
  return a.username === b.username && a.characterSlot === b.characterSlot && a.mode === b.mode;
}

export interface Reply { id: string; command: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }

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

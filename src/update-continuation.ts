import { formDocument, type FormDocument } from './current-form-logic';
import { validateControllerUpdateCheckpoint, type ControllerUpdateCheckpoint } from './controller-update';
import { validStatus, type GameStatus } from './game-status';
import { validateFieldRunCheckpoint, type FieldRunCheckpoint, type PersistentFieldRun } from './reconnect';

export interface UpdateAccount { username: string; characterSlot: number; mode: 'botOnly' | 'gameClient' }
export interface UpdateContinuation {
  version: 1; account: UpdateAccount; form: FormDocument; field: FieldRunCheckpoint | null;
  runtime: ControllerUpdateCheckpoint & { status: ControllerUpdateCheckpoint['status'] & GameStatus }; savedAccount: boolean;
}
type Invoke = (command: string, args?: Record<string, unknown>) => Promise<unknown>;
const record = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const keys = (v: Record<string, unknown>, expected: string[]) => Object.keys(v).length === expected.length
  && expected.every(key => Object.hasOwn(v, key));
const ERROR = 'Update continuation could not be verified. Start the bot explicitly.';

export function validateUpdateContinuation(input: unknown): UpdateContinuation {
  if (!record(input) || !keys(input, ['version', 'account', 'form', 'field', 'runtime', 'savedAccount'])
    || input.version !== 1 || typeof input.savedAccount !== 'boolean' || !record(input.account)
    || !keys(input.account, ['username', 'characterSlot', 'mode'])) throw new Error(ERROR);
  const account = input.account;
  if (typeof account.username !== 'string' || !account.username.trim() || account.username.length > 64
    || /[\u0000-\u001f\u007f]/.test(account.username) || !Number.isInteger(account.characterSlot)
    || Number(account.characterSlot) < 0 || Number(account.characterSlot) > 2
    || !['botOnly', 'gameClient'].includes(String(account.mode))) throw new Error(ERROR);
  const runtime = validateControllerUpdateCheckpoint(input.runtime);
  if (!validStatus(runtime.status) || !runtime.status.connected || !runtime.status.compatible
    || !runtime.status.player) throw new Error(ERROR);
  const field = input.field === null ? null : validateFieldRunCheckpoint(input.field);
  if (field && (field.character !== runtime.status.player.name || field.session !== runtime.status.sessionId)
    || !field && !runtime.macro && !runtime.settings) throw new Error(ERROR);
  return { version: 1, account: { username: account.username, characterSlot: Number(account.characterSlot),
    mode: account.mode as UpdateAccount['mode'] }, form: formDocument(input.form), field, runtime:{...runtime,status:runtime.status},
  savedAccount: input.savedAccount };
}
export function sameUpdateAccount(a: UpdateAccount, b: UpdateAccount): boolean {
  return a.username === b.username && a.characterSlot === b.characterSlot && a.mode === b.mode;
}

interface Reply { id: string; command: string; resolve(value: unknown): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }
interface InstallationAdapter {
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
type UpdateStep = 'settings' | 'prepare' | 'reserve' | 'confirmation';
function deferredReason(step: UpdateStep, error: unknown): string {
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
/** Own update installation and its one-shot claim. Stop invalidates every outstanding reply. */
export class UpdateContinuationOwner {
  private continuation: UpdateContinuation | null = null;
  private reply: Reply | null = null;
  private epoch = 0;
  private restoring = false;
  private blocked = false;
  private installing = false;
  private stoppedByUser = false;
  constructor(private readonly invoke: Invoke, private readonly id = () => crypto.randomUUID().replaceAll('-', ''),
    private readonly timeoutMs = 30_000) {}
  get pending(): boolean { return this.continuation !== null; }
  get inFlight(): boolean { return this.restoring; }
  get confirmationLost(): boolean { return this.blocked; }
  get stopped(): boolean { return this.stoppedByUser; }
  get account(): UpdateAccount | null { return this.continuation ? { ...this.continuation.account } : null; }
  get needsSignIn(): boolean { return this.continuation !== null && !this.continuation.savedAccount; }
  claim(input: unknown, fieldRun: PersistentFieldRun): UpdateContinuation | null {
    if (input === null) return null;
    const continuation = validateUpdateContinuation(input);
    if (fieldRun.requested) throw new Error(ERROR);
    if (continuation.field) {
      fieldRun.restore(continuation.field);
      // Apply the final frozen old-page readback before seeing a fresh successor.
      fieldRun.observe(continuation.runtime.status, continuation.runtime.frozenAt);
    }
    this.continuation = continuation; this.blocked = false;
    return structuredClone(continuation);
  }
  async claimFrom(load: Promise<unknown>, fieldRun: PersistentFieldRun, retired = false): Promise<UpdateContinuation | null> {
    const epoch=this.epoch,input=await load;
    if(epoch!==this.epoch||this.stoppedByUser||input===null)return null;
    const continuation=validateUpdateContinuation(input);
    if(retired)fieldRun.stop();
    return this.claim(continuation,fieldRun);
  }
  async startup(fieldRun: PersistentFieldRun): Promise<UpdateContinuation | null> {
    const stopped = await this.invoke('update_startup_stopped').catch(error => {
      this.stoppedByUser = true;
      throw error;
    });
    this.stoppedByUser ||= stopped === true;
    if (this.stoppedByUser) return null;
    return this.claimFrom(this.invoke('update_continuation'), fieldRun);
  }
  /** Own the entire update transaction; the window adapter only presents it. */
  async install(fieldRun: PersistentFieldRun, adapter: InstallationAdapter): Promise<UpdateInstallationResult> {
    if (this.installing || this.pending) throw new Error('An update handoff is already pending.');
    this.installing = true; this.stoppedByUser = false;
    const epoch = this.epoch;
    const preparing = () => epoch === this.epoch && !adapter.interrupted();
    const result: UpdateInstallationResult = { continuation: null, retired: false, recoveryFailed: false };
    let nonce: string | null = null;
    let step: UpdateStep = 'settings';
    try {
      adapter.status('Saving current settings before updating.');
      const document = await adapter.flush();
      if (!preparing()) return result;
      const game = adapter.game();
      let active = fieldRun.requested || game.status?.runRequested === true
        || !!game.status?.macro && ['running', 'waiting', 'monitoring'].includes(game.status.macro.state);
      if (game.open && active) {
        step = 'prepare';
        adapter.status('Pausing new decisions and waiting for the current action to finish. Stop cancels continuation.');
        const checkpoint = await this.prepare();
        if (!preparing()) return result;
        if (!validStatus(checkpoint.status)) throw new Error('Update handoff is unavailable.');
        // Reserve only after the final old-page counters spend the original allowances.
        fieldRun.observe(checkpoint.status, checkpoint.frozenAt);
        active = fieldRun.requested || checkpoint.settings !== null || checkpoint.macro !== null;
      }
      step = 'reserve';
      adapter.status('Preparing the connection for update confirmation.');
      nonce = await this.invoke('update_reserve', {
        document, continuation: active ? { version: 1, field: fieldRun.checkpoint() } : null,
      }) as string;
      if (!preparing()) return result;
      step = 'confirmation';
      adapter.status('Update waits for game confirmation that all actions have stopped. It will retry automatically.');
      for (let attempt = 0; attempt < 20; attempt++) {
        if (epoch !== this.epoch) return result;
        if (await this.invoke('update_install', { nonce })) break;
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    } catch (error) {
      adapter.status(deferredReason(step, error));
    } finally {
      if (nonce) await this.invoke('update_release', { nonce }).catch(() => {});
      if (!adapter.game().open && epoch === this.epoch) {
        try { result.continuation = await this.claimFrom(this.invoke('update_continuation'), fieldRun, true); }
        catch { result.recoveryFailed = true; }
        result.retired = !this.pending;
      }
      if (!this.pending) await this.cancel().catch(() => {});
      this.installing = false;
    }
    return result;
  }
  /** A replacement close belongs to install; an ordinary close retires ownership. */
  gameClosed(): boolean {
    if (this.installing || this.pending) return false;
    void this.cancel().catch(() => {});
    return true;
  }
  automaticLogin(profile: UpdateAccount | null): boolean {
    return !!this.continuation?.savedAccount && !!profile && sameUpdateAccount(this.continuation.account, profile);
  }
  private exchange(command: string, args: Record<string, unknown>): Promise<unknown> {
    if (this.reply) return Promise.reject(new Error('An update handoff is already pending.'));
    const requestId = this.id();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.reply?.id !== requestId) return;
        this.reply = null; this.blocked = true;
        reject(new Error('Update handoff confirmation timed out. Press Stop before starting again.'));
      }, this.timeoutMs);
      this.reply = { id: requestId, command, resolve, reject, timer };
      void this.invoke(command, { ...args, requestId }).catch(() => {
        if (this.reply?.id !== requestId) return;
        clearTimeout(timer); this.reply = null; reject(new Error('Update handoff is unavailable.'));
      });
    });
  }
  prepared(input: unknown): void {
    if (!record(input) || this.reply?.command !== 'update_prepare' || input.requestId !== this.reply.id || !Object.hasOwn(input, 'checkpoint')) return;
    const reply = this.reply!; clearTimeout(reply.timer); this.reply = null; reply.resolve(input.checkpoint);
  }
  restored(input: unknown): void {
    if (!record(input) || this.reply?.command !== 'update_restore' || input.requestId !== this.reply.id || typeof input.success !== 'boolean') return;
    const reply = this.reply!; clearTimeout(reply.timer); this.reply = null;
    if (input.success) reply.resolve(true);
    else reply.reject(new Error('Waiting for fresh, settled character data before continuing.'));
  }
  async prepare(): Promise<ControllerUpdateCheckpoint> {
    return validateControllerUpdateCheckpoint(await this.exchange('update_prepare', {}));
  }
  async resume(status: GameStatus, account: UpdateAccount, fieldRun: PersistentFieldRun): Promise<boolean> {
    const c = this.continuation;
    if (!c || this.installing || this.stoppedByUser || this.restoring || this.blocked || !status.connected || !status.compatible || !status.player
      || status.sessionId === c.runtime.status.sessionId
      || status.player.name !== c.runtime.status.player?.name || !sameUpdateAccount(c.account, account)
      || fieldRun.limitReason) return false;
    const request = c.field ? fieldRun.resumeFor(status, { settledUpdate: true }) : null;
    if (c.field && !request) return false;
    const epoch = this.epoch;
    this.restoring = true;
    try {
      await this.exchange('update_restore', { checkpoint: c.runtime,
        ...(request ? { settings: request.settings, escapeGuard: request.escapeGuard,
          supplyGuard: request.supplyGuard, deathRecoveryGuard: request.deathRecoveryGuard } : {}) });
      if (epoch !== this.epoch || this.continuation !== c) return false;
      if (request) fieldRun.completeResume(request, true);
      this.continuation = null; return true;
    } catch (error) {
      if (request && epoch === this.epoch) fieldRun.completeResume(request, false);
      throw error;
    } finally { this.restoring = false; }
  }
  cancel(stop = false): Promise<unknown> {
    if (stop) this.stoppedByUser = true;
    this.epoch++; this.continuation = null; this.blocked = false;
    if (this.reply) {
      clearTimeout(this.reply.timer); this.reply.reject(new Error('Update continuation cancelled by Stop.')); this.reply = null;
    }
    return this.invoke('update_cancel', {stop});
  }
}

import { formDocument, type FormDocument } from './current-form';
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
/** A boot claim stays only in this process. Stop invalidates every outstanding reply. */
export class UpdateContinuationOwner {
  private continuation: UpdateContinuation | null = null;
  private reply: Reply | null = null;
  private epoch = 0;
  private restoring = false;
  private blocked = false;
  constructor(private readonly invoke: Invoke, private readonly id = () => crypto.randomUUID().replaceAll('-', ''),
    private readonly timeoutMs = 30_000) {}
  get pending(): boolean { return this.continuation !== null; }
  get inFlight(): boolean { return this.restoring; }
  get confirmationLost(): boolean { return this.blocked; }
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
    if(epoch!==this.epoch||input===null)return null;
    const continuation=validateUpdateContinuation(input);
    if(retired)fieldRun.stop();
    return this.claim(continuation,fieldRun);
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
    if (!c || this.restoring || this.blocked || !status.connected || !status.compatible || !status.player
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
  cancel(): Promise<unknown> {
    this.epoch++; this.continuation = null; this.blocked = false;
    if (this.reply) {
      clearTimeout(this.reply.timer); this.reply.reject(new Error('Update continuation cancelled by Stop.')); this.reply = null;
    }
    return this.invoke('update_cancel', {});
  }
}

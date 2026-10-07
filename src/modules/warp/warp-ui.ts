import { omit } from 'effect/Struct';
import { validWarpSnapshot } from './warp-ui-logic';
export { validWarpSnapshot } from './warp-ui-logic';
import { WARP_RECOVERY, type WarpSnapshot } from './warp';
import type { AutomationSettingsInput } from '../settings/settings';
import { validateWarpRequest, type WarpRequest, type WarpPreviewRequest } from './warp-protocol';
import type { MemoSlot } from '../memo/memo-protocol';
const object = (v: unknown): Record<string, unknown> =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
/** Each stage has its own explicit preview and one-shot submission. */
export class WarpUi {
  readonly root = document.createElement('details');
  private readonly slot = document.createElement('select');
  private readonly x = document.createElement('input');
  private readonly y = document.createElement('input');
  private readonly groundPreview = document.createElement('button');
  private readonly groundSend = document.createElement('button');
  private readonly activationPreview = document.createElement('button');
  private readonly activationSend = document.createElement('button');
  private readonly previewText = document.createElement('p');
  private readonly status = document.createElement('p');
  private snapshot: WarpSnapshot | null = null;
  private request: WarpRequest | null = null;
  private lifecycle = '';
  private locked = true;
  private sending = false;
  private awaitingPreview = false;
  private expected: WarpPreviewRequest | null = null;
  private policy: AutomationSettingsInput | null = null;
  constructor(
    private readonly send: (
      request: WarpRequest & { policy: AutomationSettingsInput },
    ) => Promise<unknown>,
    private readonly notify: (text: string, error?: boolean) => void,
    private readonly prepare: (
      request: WarpPreviewRequest & { policy: AutomationSettingsInput },
    ) => Promise<unknown>,
    private readonly settings: () => AutomationSettingsInput,
    private readonly cancel: () => Promise<unknown>,
  ) {
    this.root.className = 'manual-group warp-panel';
    const title = document.createElement('summary');
    title.textContent = 'Warp Portal · manual request';
    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent =
      'Two explicit stages: request open ground, then review a fresh activation preview for one observed memo slot. No approach, automatic entry or retry. Creation cannot be confirmed. Activation may consume up to one Blue Gemstone, even on failure; no gemstone waiver is assumed. Ground and activation use the visible field policy and stock reserve captured by Preview. ' +
      WARP_RECOVERY;
    this.slot.setAttribute('aria-label', 'Warp memo slot');
    for (let i = 0; i < 4; i++) {
      const option = document.createElement('option');
      option.value = String(i);
      option.textContent = `Slot ${i}`;
      this.slot.append(option);
    }
    this.slot.value = '0';
    for (const [input, name] of [
      [this.x, 'Warp ground X'],
      [this.y, 'Warp ground Y'],
    ] as const) {
      input.type = 'number';
      input.min = '0';
      input.max = '511';
      input.value = '';
      input.setAttribute('aria-label', name);
      input.addEventListener('input', () => this.cancelIntent());
    }
    this.slot.addEventListener('change', () => this.cancelIntent());
    for (const [button, label] of [
      [this.groundPreview, 'Preview ground request'],
      [this.groundSend, 'Submit ground once'],
      [this.activationPreview, 'Preview activation'],
      [this.activationSend, 'Activate once'],
    ] as const) {
      button.type = 'button';
      button.textContent = label;
      button.className = 'secondary compact';
    }
    this.previewText.setAttribute('aria-label', 'Warp request preview');
    this.previewText.className = this.status.className = 'telemetry-summary';
    this.root.append(
      title,
      help,
      this.slot,
      this.x,
      this.y,
      this.groundPreview,
      this.groundSend,
      this.activationPreview,
      this.previewText,
      this.activationSend,
      this.status,
    );
    this.groundPreview.addEventListener('click', () => void this.preview(false));
    this.activationPreview.addEventListener('click', () => void this.preview(true));
    this.groundSend.addEventListener('click', () => void this.submit('warpGround'));
    this.activationSend.addEventListener('click', () => void this.submit('warpActivate'));
    this.root.addEventListener('toggle', () => {
      if (!this.root.open) this.cancelIntent();
    });
    this.update();
  }
  policyChanged(): void {
    this.cancelIntent();
  }
  private cancelIntent(): void {
    const active = this.awaitingPreview || this.request !== null || this.snapshot?.pending;
    this.retire();
    if (active)
      void this.cancel().catch(() => this.notify('Could not retire Warp intent. Use Stop.', true));
  }
  private retire(): void {
    this.awaitingPreview = false;
    this.expected = null;
    this.request = null;
    this.policy = null;
    this.previewText.textContent = 'Preview canceled. Review current state before submitting.';
    this.update();
  }
  clear(): void {
    this.snapshot = null;
    this.lifecycle = '';
    this.x.value = this.y.value = '';
    this.retire();
    this.lock(true);
  }
  lock(locked: boolean): void {
    this.locked = locked;
    this.update();
  }
  render(input: unknown): void {
    const s = object(input);
    this.snapshot = validWarpSnapshot(s.warp) ? s.warp : null;
    const identity = JSON.stringify([
      s.sessionId,
      s.connectionId,
      object(s.player).id,
      object(s.player).name,
      this.snapshot?.generation,
    ]);
    if (this.lifecycle && identity !== this.lifecycle) this.retire();
    this.lifecycle = identity;
    if (this.request) {
      const current =
        this.request.type === 'warpGround'
          ? this.snapshot?.ready
          : this.snapshot?.activation?.preview;
      if (JSON.stringify(this.request.preview) !== JSON.stringify(current)) this.retire();
    }
    if (
      this.awaitingPreview &&
      this.snapshot?.preview &&
      this.policy &&
      this.expected &&
      JSON.stringify(omit(this.snapshot.preview, ['preview'])) === JSON.stringify(this.expected)
    ) {
      this.request = validateWarpRequest(this.snapshot.preview);
      this.awaitingPreview = false;
      const a = this.request.type === 'warpActivate',
        slot = a ? this.snapshot.captured?.slot : Number(this.slot.value),
        destination = a ? this.snapshot.captured?.destination : this.snapshot.slots?.[slot ?? 0],
        ground = a
          ? this.snapshot.captured?.ground
          : { x: Number(this.x.value), y: Number(this.y.value) };
      this.previewText.textContent = `${a ? 'Activation' : 'Ground'} preview · memo slot ${slot}: ${destination?.map} (${destination?.x}, ${destination?.y}). Ground (${ground?.x}, ${ground?.y}). ${a ? 'Second-stage SP cost: 0 while selection is valid.' : `Effective SP prerequisite: ${this.snapshot.cost}.`}
Observed Blue Gemstones: ${this.snapshot.gems}; reserve: ${this.snapshot.reserve}. Activation may consume up to one gemstone, including failure. Creation remains unconfirmed.
${WARP_RECOVERY}`;
    }
    this.update();
  }
  private async preview(activate: boolean): Promise<void> {
    if (this.locked || this.sending || !this.snapshot) return;
    try {
      this.policy = structuredClone(this.settings());
      this.request = null;
      this.awaitingPreview = true;
      let request: WarpPreviewRequest;
      if (activate) {
        if (!this.snapshot.activation) return;
        request = { type: 'warpActivate' };
      } else {
        if (!this.x.value.trim() || !this.y.value.trim())
          throw new Error('Choose an explicit ground cell.');
        request = {
          type: 'warpGround',
          slot: Number(this.slot.value) as MemoSlot,
          target: { x: Number(this.x.value), y: Number(this.y.value) },
        };
      }
      this.expected = request;
      await this.prepare({ ...request, policy: this.policy });
      // A dismissal/edit can race the preview IPC. Cancel again after its
      // acknowledgment so a hidden staged preview cannot hold an update lease.
      if (this.expected !== request) await this.cancel();
    } catch (e) {
      this.retire();
      this.notify(e instanceof Error ? e.message : 'Warp preview unavailable.', true);
    }
    this.update();
  }
  private async submit(type: WarpRequest['type']): Promise<void> {
    if (this.locked || this.sending || this.request?.type !== type || !this.policy) return;
    if (JSON.stringify(this.policy) !== JSON.stringify(this.settings())) {
      this.retire();
      return;
    }
    const request = this.request,
      policy = this.policy;
    const binding =
      type === 'warpGround' ? this.snapshot?.ready : this.snapshot?.activation?.preview;
    if (JSON.stringify(binding) !== JSON.stringify(request.preview)) {
      this.retire();
      return;
    }
    this.request = null;
    this.sending = true;
    this.update();
    try {
      await this.send({ ...validateWarpRequest(request), policy });
      this.notify(
        type === 'warpGround'
          ? 'One ground request submitted; review observed selection and resources.'
          : 'Activation submitted; portal creation is unconfirmed.',
      );
    } catch (e) {
      this.notify(e instanceof Error ? e.message : 'Warp request was not accepted.', true);
    } finally {
      this.sending = false;
      this.update();
    }
  }
  private update(): void {
    const unavailable = this.locked || this.sending;
    this.slot.disabled =
      this.x.disabled =
      this.y.disabled =
        unavailable || !this.snapshot || this.snapshot.blocked;
    this.groundPreview.disabled = unavailable || !this.snapshot || this.snapshot.blocked;
    this.groundSend.disabled = unavailable || this.request?.type !== 'warpGround';
    this.activationPreview.disabled = unavailable || !this.snapshot?.activation;
    this.activationSend.disabled = unavailable || this.request?.type !== 'warpActivate';
    this.status.textContent = this.snapshot
      ? `${this.snapshot.state} · ${this.snapshot.reason}\nSelection: ${this.snapshot.selection}. ${this.snapshot.resourceEvidence}`
      : 'Waiting for verified Warp Portal state.';
  }
}

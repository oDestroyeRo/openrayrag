import { milliseconds, type Revision } from '../../shared/domain-values';
import catalog from '../../data/socket-catalog.json';
import type { GameEvent } from '../protocol/protocol';
import {
  validateRefineRequest,
  type ValidatedRefineRequest,
  type RefinePacket,
} from './refine-protocol';

import {
  REFINE_WINDOW_MS,
  type RefineContext,
  type RefineSnapshot,
  type Prepared,
  type Receipt,
  cloneItem,
  sameItem,
  contextKey,
  lifetime,
  targetAllowed,
  prepare,
} from './refine-logic';

export {
  REFINE_WINDOW_MS,
  type RefineMetadata,
  type RefineContext,
  type RefinePreview,
  type RefineSnapshot,
  refineMetadata,
  refineFloors,
} from './refine-logic';

/** A single explicit economic transaction; no timer or observation can send. */
export class ManualRefine {
  private state: RefineSnapshot['state'] = 'idle';
  private reason = 'Open the refining dialogue manually, then preview one unequipped item.';
  private prepared: Prepared | null = null;
  private receipt: Receipt | null = null;
  private officialOwner: { character: string | null } | null = null;
  private readback: {
    identity: string;
    inventoryRevision: Revision<'inventory'> | null;
    equipmentRevision: Revision<'equipment'> | null;
    currencyRevision: Revision<'currency'> | null;
  } | null = null;
  constructor(
    private readonly send: (packet: RefinePacket) => void,
    private readonly now = Date.now,
    private readonly token = () => crypto.randomUUID().replaceAll('-', ''),
  ) {}
  get busy(): boolean {
    return this.state === 'pending';
  }
  get blocked(): boolean {
    return this.receipt !== null || this.officialOwner !== null;
  }
  /** Only Companion's own transmitted receipt owns automatic command arbitration. */
  get companionReceiptPending(): boolean {
    return this.receipt !== null;
  }
  get maintenanceBlocked(): boolean {
    return this.prepared !== null || this.blocked;
  }
  preview(input: unknown, c: RefineContext): void {
    if (this.blocked) throw new Error('Wait for the previous refine transaction to reconcile.');
    this.invalidate();
    this.prepared = prepare(validateRefineRequest(input, true), c, this.token());
    this.state = 'preview';
    this.reason = 'Review the exact cost and possible downgrade before sending one attempt.';
  }
  dispatch(input: unknown, c: RefineContext): void {
    if (this.blocked) throw new Error('Wait for the previous refine transaction to reconcile.');
    this.tick(c);
    const request: ValidatedRefineRequest = validateRefineRequest(input),
      previous = this.prepared;
    if (!previous || request.previewToken !== previous.display.token)
      throw new Error('Generate a new refine preview.');
    const current = prepare(request, c, previous.display.token);
    if (current.key !== previous.key) {
      this.invalidate();
      throw new Error('The refine preview changed. Generate a new preview.');
    }
    this.receipt = {
      ...structuredClone(current),
      since: milliseconds(this.now()),
      cancelled: false,
      oreSeen: false,
      currencySeen: false,
      mutation: null,
      tainted: false,
    };
    this.prepared = null;
    this.readback = null;
    this.state = 'pending';
    this.reason = 'Sent one attempt. Waiting for exact ore, zeny and equipment readback.';
    try {
      this.send({
        targetBagId: current.item.bagId,
        oreItemId: current.ore.itemId,
        catalystBagId: 0,
      });
    } catch {
      this.cancel('Socket write was uncertain. No retry will be sent.');
      throw new Error(this.reason);
    }
  }
  private invalidate(): void {
    this.prepared = null;
    if (!this.blocked) {
      this.state = 'idle';
      this.reason = 'State or protection settings changed. Generate a new preview.';
    }
  }
  cancel(reason: string): void {
    this.prepared = null;
    if (this.receipt) {
      this.receipt.cancelled = true;
      this.state = 'uncertain';
      this.reason = reason.slice(0, 420) + ' No retry, refund or NPC close is inferred.';
      this.readback = null;
    } else if (this.state === 'preview') {
      this.state = 'idle';
      this.reason = reason;
    }
  }
  /** Official game input may start another economic request without a request identifier. */
  externalInput(): void {
    if (this.receipt) this.receipt.tainted = true;
    this.cancel(
      'Manual game input made the refine result uncertain. Wait for fresh full inventory and balance.',
    );
  }
  /** Called synchronously before forwarding verified official opcode 80, without reading its body. */
  officialCommand(character: string | null): void {
    this.externalInput();
    this.officialOwner = {
      character:
        this.officialOwner && this.officialOwner.character !== character ? null : character,
    };
  }
  /** Bridge certifies old transport closure and a newer complete first initialization. */
  reconcileOfficialInitialization(c: RefineContext): void {
    if (
      !this.officialOwner?.character ||
      c.character !== this.officialOwner.character ||
      !c.ready ||
      !c.identity ||
      !c.inventory ||
      !c.equipment ||
      c.zeny === null
    )
      return;
    this.officialOwner = null;
    if (!this.receipt) {
      this.state = 'reconciled';
      this.reason =
        'A new same-character initialization reconciled current state. The official refine outcome remains unknown.';
    }
  }
  tick(c: RefineContext): void {
    if (
      this.prepared &&
      (!c.ready ||
        !c.settled ||
        !c.identity ||
        !c.character ||
        !c.npcIdentity ||
        !c.inventory ||
        !c.equipment ||
        c.zeny === null ||
        contextKey(c) !== contextKey(this.prepared.context))
    )
      this.invalidate();
    const r = this.receipt;
    if (!r) return;
    if (
      !r.cancelled &&
      (this.now() - r.since >= REFINE_WINDOW_MS ||
        !c.ready ||
        lifetime(c) !== lifetime(r.context) ||
        c.npcIdentity !== r.context.npcIdentity ||
        c.npcGeneration !== r.context.npcGeneration ||
        c.npcMode !== 'refine')
    )
      this.cancel('The refine result is uncertain after timeout or interaction change.');
  }
  observe(events: GameEvent[], c: RefineContext): void {
    this.tick(c);
    const r = this.receipt;
    if (!r) return;
    const current = c.ready && lifetime(c) === lifetime(r.context);
    if (current)
      for (const event of events) {
        if (event.type === 'inventoryDelta') {
          if (event.add || event.bagId !== r.ore.bagId || event.change !== 1 || r.oreSeen)
            r.tainted = true;
          else r.oreSeen = true;
        } else if (
          event.type === 'currency' ||
          (event.type === 'stats' && event.zeny !== undefined)
        ) {
          if (event.zeny !== r.zeny - r.display.zenyCost) r.tainted = true;
          else r.currencySeen = true; // Source emits this absolute readback twice.
        } else if (event.type === 'inventoryItem') {
          const delta = Number(event.item.refine) - r.display.startingRefine;
          if (
            !sameItem(event.item, r.item, true) ||
            (delta !== 1 && (delta !== -1 || !r.display.failurePossible)) ||
            r.mutation
          )
            r.tainted = true;
          else r.mutation = cloneItem(event.item);
        } else if (event.type === 'equipment') r.tainted = true;
        else if (
          event.type === 'requestFailure' ||
          event.type === 'featureError' ||
          event.type === 'skillFailure'
        )
          this.cancel('The game reported an error after the refine request.');
      }
    if (
      current &&
      !r.tainted &&
      r.oreSeen &&
      r.currencySeen &&
      r.mutation &&
      c.inventory &&
      c.zeny === r.zeny - r.display.zenyCost &&
      (c.inventory.find((item) => item.bagId === r.ore.bagId)?.count ?? 0) === r.ore.count - 1 &&
      c.inventory
        .filter((item) => item.itemId === r.ore.itemId)
        .reduce((n, item) => n + item.count, 0) ===
        r.ore.count - 1 &&
      c.inventory.some((item) => sameItem(item, r.mutation!)) &&
      c.equipment !== null &&
      !c.equipment.includes(r.item.bagId)
    ) {
      const improved = r.mutation.refine! > r.item.refine!;
      this.state = r.cancelled ? 'reconciled' : improved ? 'improved' : 'downgraded';
      this.reason = r.cancelled
        ? 'Late exact receipt reconciled the cancelled attempt. Nothing resumed.'
        : `${improved ? 'Improved' : 'Downgraded'} to +${r.mutation.refine}. Exact ore, zeny and item changes confirmed.`;
      this.receipt = null;
      this.readback = null;
      return;
    }
    if (r.tainted && !r.cancelled)
      this.cancel('The refine evidence differed from the exact preview.');
    if (r.cancelled && c.readbackKey) {
      const key = c.readbackKey;
      if (this.readback?.identity !== key)
        this.readback = {
          identity: key,
          inventoryRevision: null,
          equipmentRevision: null,
          currencyRevision: null,
        };
      const fresh = this.readback;
      if (
        events.some((event) => event.type === 'inventory') &&
        c.inventory !== null &&
        c.equipment !== null
      ) {
        fresh.inventoryRevision = c.inventoryRevision;
        fresh.equipmentRevision = c.equipmentRevision;
      }
      if (
        events.some(
          (event) =>
            event.type === 'currency' || (event.type === 'stats' && event.zeny !== undefined),
        ) &&
        c.zeny !== null
      )
        fresh.currencyRevision = c.currencyRevision;
      // A later sparse mutation cannot stand in for a fresh full inventory readback.
      if (
        fresh.inventoryRevision !== c.inventoryRevision ||
        fresh.equipmentRevision !== c.equipmentRevision ||
        c.inventory === null ||
        c.equipment === null
      ) {
        fresh.inventoryRevision = null;
        fresh.equipmentRevision = null;
      }
      if (fresh.currencyRevision !== c.currencyRevision || c.zeny === null)
        fresh.currencyRevision = null;
      if (
        c.ready &&
        c.identity &&
        c.character === r.context.character &&
        fresh.inventoryRevision !== null &&
        fresh.currencyRevision !== null
      ) {
        this.receipt = null;
        this.readback = null;
        this.state = 'reconciled';
        this.reason =
          'Fresh full inventory and balance reconciled current state. The previous attempt outcome remains unknown.';
      }
    }
  }
  snapshot(c: RefineContext): RefineSnapshot {
    this.tick(c);
    return {
      state: this.officialOwner ? 'uncertain' : this.state,
      blocked: this.blocked,
      reason: this.officialOwner
        ? 'An official game refine may still be spending resources. Reopen the game and finish initialization with the same character before another attempt. Its outcome remains unknown.'
        : this.reason,
      dialogueToken: c.ready && c.npcIdentity && c.npcMode === 'refine' ? c.promptToken : null,
      preview: this.prepared ? { ...this.prepared.display } : null,
      candidates:
        c.inventory && c.equipment
          ? c.inventory
              .filter((item) => targetAllowed(item, c))
              .slice(0, 200)
              .map((item) => ({
                bagId: item.bagId,
                itemId: item.itemId,
                name: (catalog.items as Record<string, { name: string }>)[item.itemId]!.name,
                refine: item.refine!,
              }))
          : [],
    };
  }
}

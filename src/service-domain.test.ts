import { describe, expect, it } from 'vitest';
import { actorId, bagId, itemId, milliseconds, quantity, revisionFor, type ItemId } from './domain-values';
import { DEFAULT_AUTOMATION } from './settings';
import { admitInventoryItem } from './character-state-logic';
import { validateSocketEnvelope, validateSocketSelection } from './socket-protocol';
import type { SocketContext, SocketPlan, Receipt as SocketReceipt } from './socket-logic';
import { validateRefineRequest, type RefinePreviewRequest } from './refine-protocol';
import { prepare, refineMetadata, type RefineContext, type RefinePlan } from './refine-logic';

const policy = () => structuredClone(DEFAULT_AUTOMATION);
describe('admitted manual service values', () => {
  it('detaches admitted policies and preserves socket/refine request JSON', () => {
    const socket = { targetBagId: 700, cardBagId: 4002, policy: policy() };
    const admittedSocket = validateSocketEnvelope(socket, false);
    expect(JSON.stringify(admittedSocket)).toBe(JSON.stringify(socket));
    socket.policy.items.push({ itemId: 501, resource: 'hp', belowPercent: 50, minStock: 2, cooldownSeconds: 1 });
    expect(admittedSocket.policy.items).toEqual([]);
    const refine = { targetBagId: 700, catalystBagId: 0 as const, policy: policy(), maxSpend: 1000, minZeny: 0 };
    const admittedRefine = validateRefineRequest(refine, true);
    expect(JSON.stringify(admittedRefine)).toBe(JSON.stringify(refine));
    refine.policy.items.push({ itemId: 501, resource: 'hp', belowPercent: 50, minStock: 2, cooldownSeconds: 1 });
    expect(admittedRefine.policy.items).toEqual([]);
  });
  it('keeps request error priority before domain value construction', () => {
    expect(() => validateSocketSelection({ targetBagId: -1, cardBagId: -1, extra: true })).toThrow('Unknown socket request fields.');
    expect(() => validateSocketSelection({ targetBagId: 0, cardBagId: 4002 })).toThrow('Socket bag IDs must be positive int32 values.');
    expect(() => validateRefineRequest({ targetBagId: -1, catalystBagId: 1, policy: null, maxSpend: -1, minZeny: -1 }, true)).toThrow('Catalysts are not supported.');
    expect(() => validateRefineRequest({ targetBagId: 0, catalystBagId: 0 as const, policy: policy(), maxSpend: 1000, minZeny: 0 }, true)).toThrow('Invalid refine number.');
  });
});

function typeContracts(socket: SocketContext, socketPlan: SocketPlan, socketReceipt: SocketReceipt,
  refine: RefineContext, refinePlan: RefinePlan, raw: RefinePreviewRequest) {
  socket.inventory.get(bagId(700));
  // @ts-expect-error Catalog item identity is not an inventory bag address.
  socket.inventory.get(itemId(700));
  // @ts-expect-error Protection floors are keyed by item identity, not bag identity.
  socket.floors.get(bagId(4002));
  // @ts-expect-error A selected inventory bag cannot be substituted with an item ID.
  const invalidSocketPlan: SocketPlan = { ...socketPlan, targetBagId: itemId(700) };
  // @ts-expect-error A full inventory revision cannot prove equipment freshness.
  socketReceipt.fresh = { key: 'readback', connection: revisionFor('connection', 1), inventoryRevision: revisionFor('inventory', 1), equipmentRevision: revisionFor('inventory', 1) };
  socketReceipt.deadline = milliseconds(1000);
  // @ts-expect-error Raw policy/selection DTOs have not passed request admission.
  prepare(raw, refine, 'aa'.repeat(16));
  // @ts-expect-error Refine ore identity is a catalog item ID, not a bag address.
  const invalidRefinePlan: RefinePlan = { ...refinePlan, oreItemId: bagId(1010) };
  // @ts-expect-error NPC actor and inventory item identities cannot be substituted.
  const invalidNpc: RefinePlan = { ...refinePlan, npcId: itemId(501) };
  refineMetadata(itemId(1201));
  // @ts-expect-error Catalog lookups require admitted item IDs.
  refineMetadata(1201);
  const inventory = admitInventoryItem({ bagId: 700, itemId: 1201, type: 2, count: 1 });
  const id: ItemId = inventory.itemId;
  void [id, invalidSocketPlan, invalidRefinePlan, invalidNpc, actorId(0), quantity(0)];
}
void typeContracts;

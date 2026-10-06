import { describe, expect, it } from 'vitest';
import { actorId, partyMemberId, revisionFor } from './domain-values';
import { partyActorBinding, onlinePartyMembers, type PartyActorBinding } from './party-actors-logic';
import type { PartyActorBindings } from './party-actors';
import type { PartyMember } from './world-protocol';
import type { SupplyContext } from './supply-trip-logic';
import type { SupplyReceipt } from './supply-receipt-logic';

const raw = { partyId: 5, memberId: 7, entityId: 3, map: 'prontera', world: 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA', incarnation: 1, affiliationRevision: 2 };
describe('party association domain admission', () => {
  it('retains the detached association shape and accepted world spelling', () => {
    const input = {...raw}, binding = partyActorBinding(input);
    expect(JSON.stringify(binding)).toBe(JSON.stringify(input));
    input.entityId = 9;
    expect(binding.entityId).toBe(3);
    expect(binding.world).toBe(raw.world);
  });
  it('keeps offline roster sentinels out of admitted actor associations', () => {
    const member: PartyMember = { memberId: 7, entityId: 0, level: 10, name: 'Member', leader: false, map: 'prontera', hp: 100, maxHp: 100, sp: 20, maxSp: 20 };
    expect(onlinePartyMembers([member, {...member, entityId: -1}])).toEqual([]);
    expect(() => partyActorBinding({...raw, entityId: 0})).toThrow('online member');
    expect(() => partyActorBinding({...raw, incarnation: 0})).toThrow('Invalid incarnation');
  });
});
function typeContracts(binding: PartyActorBinding, bindings: PartyActorBindings, supply: SupplyContext, receipt: SupplyReceipt) {
  bindings.get(partyMemberId(7));
  // @ts-expect-error Visible actor identity cannot address a roster member association.
  bindings.get(actorId(7));
  // @ts-expect-error Roster membership and visible actor identity remain separate.
  const actor: typeof binding.entityId = binding.memberId;
  // @ts-expect-error Admitted association inputs are read-only.
  binding.incarnation = binding.incarnation;
  supply.inventoryRevision = revisionFor('inventory', 2);
  // @ts-expect-error Currency freshness cannot establish inventory readback.
  supply.inventoryRevision = revisionFor('currency', 2);
  // @ts-expect-error Supply receipts retain their specific resource channel.
  receipt.currencyRevision = revisionFor('inventory', 2);
  void actor;
}
void typeContracts;

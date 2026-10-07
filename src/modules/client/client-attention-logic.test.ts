import { describe, expect, it } from 'vitest';
import { clientAttention, type AttentionContext } from './client-attention-logic';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from '../settings/settings';
import { DEFAULT_RECOVERY_ITEMS, DEFAULT_SP_ITEMS } from '../recovery/recovery-items';
const context: AttentionContext = {
  fresh: true,
  fieldRequested: false,
  held: false,
  loginBusy: false,
  limitReason: '',
  setupReason: '',
};
const settings = () => ({
  ...DEFAULT_SETTINGS,
  automation: {
    ...structuredClone(DEFAULT_AUTOMATION),
    hpPotions: structuredClone(DEFAULT_RECOVERY_ITEMS),
    spPotions: structuredClone(DEFAULT_SP_ITEMS),
  },
});
const status = () => ({
  connected: true,
  compatible: true,
  running: false,
  player: { id: 0, name: 'Character', dead: false },
  character: { inventoryKnown: true, inventory: [] },
  reason: 'Ready.',
  log: [],
});
describe('current attention observations', () => {
  it('shows initial account guidance without inventing a failed run', () => {
    expect(clientAttention(null, context, settings())).toEqual([
      expect.objectContaining({ id: 'connection', severity: 'info', action: 'account' }),
    ]);
    expect(clientAttention(null, { ...context, fieldRequested: true }, settings())).toContainEqual(
      expect.objectContaining({ title: 'Connection unavailable', severity: 'warning' }),
    );
  });
  it('never calls missing, stale, offline or malformed stock empty', () => {
    const configured = settings();
    configured.automation.hpPotions!.mode = 'any';
    const snapshot = status();
    expect(clientAttention(snapshot, context, configured)).toContainEqual(
      expect.objectContaining({ id: 'hp-stock', title: 'No usable HP items' }),
    );
    const malformed = {
      ...snapshot,
      character: { inventoryKnown: true, inventory: [{ itemId: 501, count: -1 }] },
    };
    for (const value of [malformed, { ...snapshot, character: {} }]) {
      const cards = clientAttention(value, context, configured);
      expect(cards).toContainEqual(
        expect.objectContaining({ id: 'hp-stock', title: 'HP item stock unobserved' }),
      );
      expect(cards.some((card) => card.title.startsWith('No usable'))).toBe(false);
    }
    for (const [value, flags] of [
      [snapshot, { ...context, fresh: false }],
      [{ ...snapshot, connected: false }, context],
    ] as const) {
      expect(clientAttention(value, flags, configured).some((card) => card.id === 'hp-stock')).toBe(
        false,
      );
    }
  });
  it('uses protected reserves, advanced-rule precedence and the supplied active policy', () => {
    const configured = settings(),
      snapshot = {
        ...status(),
        character: { inventoryKnown: true, inventory: [{ itemId: 501, count: 3 }] },
      };
    configured.automation.hpPotions!.mode = 'selected';
    configured.automation.hpPotions!.itemIds = [501];
    configured.automation.hpPotions!.minStock = 3;
    expect(
      clientAttention(snapshot, context, configured).some((card) => card.id === 'hp-stock'),
    ).toBe(true);
    configured.automation.items = [
      { itemId: 501, resource: 'hp', belowPercent: 60, minStock: 0, cooldownSeconds: 5 },
    ];
    expect(
      clientAttention(snapshot, context, configured).some((card) => card.id === 'hp-stock'),
    ).toBe(false);
    const draft = settings();
    draft.automation.hpPotions!.mode = 'off';
    expect(
      clientAttention({ ...status(), activeSettings: draft }, context, configured).some(
        (card) => card.id === 'hp-stock',
      ),
    ).toBe(true);
    expect(clientAttention(status(), context, draft).some((card) => card.id === 'hp-stock')).toBe(
      false,
    );
  });
  it('retains local limits and last-observed uncertainty while suppressing stale task claims', () => {
    const snapshot = {
      ...status(),
      running: true,
      warp: { blocked: true, reason: 'Unresolved resources.' },
      actionResult: { status: 'failed', reason: 'Old failure' },
    };
    const cards = clientAttention(
      snapshot,
      {
        ...context,
        fresh: false,
        fieldRequested: true,
        held: true,
        limitReason: 'Death cap reached.',
      },
      settings(),
    );
    expect(cards[0]).toMatchObject({ id: 'limit', detail: 'Death cap reached.', action: 'limits' });
    expect(cards).toContainEqual(
      expect.objectContaining({
        id: 'warp',
        title: 'Last observed: Warp Portal needs review',
        detail: 'Unresolved resources.',
      }),
    );
    expect(cards).toContainEqual(expect.objectContaining({ id: 'freshness' }));
    expect(cards.some((card) => card.id === 'action')).toBe(false);
  });
  it('does not interpret logs as receipts or normal pending supply as a failure', () => {
    const snapshot = {
      ...status(),
      log: [{ text: 'Transaction failed. Retry now.' }],
      actionResult: { status: 'pending', reason: 'Waiting for receipt.' },
      supply: {
        uncertain: true,
        state: 'confirming',
        active: true,
        reason: 'Awaiting supply confirmation.',
      },
    };
    expect(clientAttention(snapshot, context, settings())).toEqual([
      expect.objectContaining({
        id: 'waiting',
        severity: 'info',
        title: 'Waiting for action confirmation',
      }),
    ]);
    const uncertain = clientAttention(
      { ...snapshot, supply: { ...snapshot.supply, state: 'waiting' } },
      context,
      settings(),
    );
    expect(uncertain).toContainEqual(
      expect.objectContaining({ id: 'supply', title: 'Supply transaction needs review' }),
    );
    expect(uncertain.every((card) => !card.nextStep.includes('Retry'))).toBe(true);
  });
  it('preserves generic failed-action and owner-specific guidance during a running field run', () => {
    const cards = clientAttention(
      {
        ...status(),
        running: true,
        refine: { blocked: true, reason: 'External refine hold.' },
        actionResult: { status: 'failed', reason: '<script>unconfirmed</script>' },
      },
      context,
      settings(),
    );
    expect(cards).toContainEqual(
      expect.objectContaining({
        id: 'refine',
        title: 'Refining needs review',
        detail: 'External refine hold.',
      }),
    );
    expect(cards).toContainEqual(
      expect.objectContaining({
        id: 'action',
        title: 'Action needs review',
        detail: '<script>unconfirmed</script>',
      }),
    );
    expect(cards.every((card) => !card.title.includes('Bot stopped'))).toBe(true);
  });
  it('bounds deterministic current cards and clears resolved or changed-session owners', () => {
    const snapshot = {
      ...status(),
      sessionId: 'old',
      warp: { blocked: true, reason: 'Awaiting resource proof.' },
      refine: { blocked: true },
      memo: { blocked: true },
      escape: { state: 'uncertain' },
      partyHeal: { state: 'uncertain' },
      deathRecoveryGuard: { uncertain: true },
    };
    const before = structuredClone(snapshot),
      configured = settings();
    const cards = clientAttention(snapshot, { ...context, limitReason: 'Limit.' }, configured);
    expect(cards).toHaveLength(6);
    expect(clientAttention(snapshot, { ...context, limitReason: 'Limit.' }, configured)).toEqual(
      cards,
    );
    expect(snapshot).toEqual(before);
    expect(clientAttention({ ...status(), sessionId: 'new' }, context, configured)).toEqual([]);
    expect(
      clientAttention(null, context, configured).every((card) => card.id === 'connection'),
    ).toBe(true);
  });
  it('keeps an invalid offline draft actionable and ignores malformed discriminants', () => {
    expect(
      clientAttention(null, { ...context, setupReason: 'Correct the recovery threshold.' }, null),
    ).toContainEqual(expect.objectContaining({ id: 'setup', action: 'setup' }));
    expect(
      clientAttention(
        {
          ...status(),
          warp: { blocked: 'true' },
          actionResult: { status: 'unknown' },
          partyHeal: { state: 'pendingly' },
        },
        context,
        settings(),
      ),
    ).toEqual([]);
  });
});

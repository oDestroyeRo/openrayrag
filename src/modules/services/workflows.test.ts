import { describe, expect, it } from 'vitest';
import type { InventoryItem } from '../protocol/protocol-feature';
import { WorldState } from '../world/world-state';
import {
  confirmVendingReceipt,
  createVendingReceipt,
  dryRunWorkflow,
  NpcWorkflow,
  validateWorkflowSpec,
  worldActionBlockers,
  type WorkflowContext,
  type WorkflowSpec,
} from './workflows';
import type { WorldEvent } from '../protocol/world-protocol';

const item = (count: number, itemId = 512, bagId = itemId): InventoryItem => ({
  bagId,
  itemId,
  type: 1,
  count,
});
function fixture() {
  let time = 0;
  const world = new WorldState();
  world.reset('prontera');
  const context: WorkflowContext = {
    map: 'prontera',
    playerId: 100,
    alive: true,
    idle: true,
    inventory: [item(10)],
    equipped: [],
    zeny: 1000,
    world,
    visibleNpcIds: [123],
    itemCatalog: { '512': { sellPrice: 7, itemClass: 1 } },
  };
  const workflow = new NpcWorkflow(() => time);
  const receive = (...events: WorldEvent[]) => {
    events.forEach((event) => world.apply(event, context.playerId));
    workflow.observe(events, context);
  };
  const spec = (
    steps: WorkflowSpec['steps'],
    overrides: Partial<WorkflowSpec> = {},
  ): WorkflowSpec => ({
    name: 'Town supplies',
    map: 'prontera',
    npcId: 123,
    maxSpend: 1000,
    minStock: [],
    steps,
    ...overrides,
  });
  const focus = () => receive({ type: 'npcFocus', id: 123, focus: true });
  const shop = (mode: 'buy' | 'sell', discountLevel = 0) => {
    focus();
    receive({
      type: 'shopOpened',
      mode,
      discountLevel,
      entries: mode === 'buy' ? [{ itemId: 512, price: 100 }] : [],
    });
  };
  return {
    world,
    context,
    workflow,
    receive,
    spec,
    focus,
    shop,
    advance: (ms: number) => {
      time += ms;
    },
  };
}

describe('bounded NPC workflows', () => {
  it('waits for observed NPC responses before sending the next typed step', () => {
    const f = fixture();
    expect(
      f.workflow.start(
        f.spec([{ type: 'talk' }, { type: 'option', index: 2, expectedLabel: 'Storage' }]),
        f.context,
      ).ok,
    ).toBe(true);
    expect(f.workflow.tick(f.context)).toEqual({ type: 'npcTalk', id: 123 });
    expect(f.workflow.tick(f.context)).toBeNull();
    f.receive({ type: 'partyInvite', partyId: 3, name: 'Other', sender: 'Other' });
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().step).toBe(0);
    f.focus();
    f.receive({ type: 'npcOptions', options: ['Hello', '', 'Storage'] });
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().step).toBe(1);
    expect(f.workflow.tick(f.context)).toEqual({ type: 'npcOption', index: 2 });
    f.receive({ type: 'storageOpened', items: [] });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot()).toMatchObject({ state: 'complete', running: false, step: 2 });
  });
  it('stops on changed option text and never chooses a different index automatically', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'npcOptions', options: ['Cancel', 'Storage'] });
    f.workflow.start(f.spec([{ type: 'option', index: 0, expectedLabel: 'Storage' }]), f.context);
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot()).toMatchObject({
      state: 'failed',
      reason: 'NPC option label changed; workflow stopped.',
    });
  });
  it('checks an expected dialog before advancing', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'npcDialog', name: 'Kafra', text: 'Unexpected', big: false });
    f.workflow.start(f.spec([{ type: 'advance', expectedText: 'Welcome' }]), f.context);
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().state).toBe('failed');
  });
  it('guards a configured NPC fee and confirms its exact authoritative debit', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'npcOptions', options: ['Yes', 'No'] });
    const spec = f.spec([{ type: 'option', index: 0, expectedLabel: 'Yes', expectedCost: 850 }], {
      maxSpend: 850,
    });
    expect(f.workflow.start(spec, f.context)).toMatchObject({ ok: true, estimatedSpend: 850 });
    expect(f.workflow.tick(f.context)).toEqual({ type: 'npcOption', index: 0 });
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    f.context.zeny = 150;
    f.workflow.observe([], f.context);
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot()).toMatchObject({ state: 'complete', spent: 850 });
  });
  it('rejects known fees above the global budget before any request', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'npcOptions', options: ['Yes'] });
    expect(
      f.workflow.start(
        f.spec([{ type: 'option', index: 0, expectedLabel: 'Yes', expectedCost: 850 }], {
          maxSpend: 849,
        }),
        f.context,
      ).ok,
    ).toBe(false);
    expect(f.workflow.tick(f.context)).toBeNull();
  });
  it('does not treat an unexpected charge as a confirmed NPC operation', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'npcOptions', options: ['Yes'] });
    f.workflow.start(
      f.spec([{ type: 'option', index: 0, expectedLabel: 'Yes' }], { timeoutMs: 1000 }),
      f.context,
    );
    f.workflow.tick(f.context);
    f.context.zeny = 150;
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    f.advance(1000);
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('failed');
  });
  it('requires inventory and currency confirmation after a purchase', () => {
    const f = fixture();
    f.shop('buy');
    f.workflow.start(f.spec([{ type: 'buy', rows: [{ id: 512, count: 2 }] }]), f.context);
    expect(f.workflow.tick(f.context)).toEqual({
      type: 'shop',
      mode: 'buy',
      rows: [{ id: 512, count: 2 }],
    });
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    f.context.inventory = [item(12)];
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    f.context.zeny = 800;
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot()).toMatchObject({ state: 'complete', spent: 200, step: 1 });
  });
  it('waits for the shop handshake when inventory and money arrive first', () => {
    const f = fixture();
    f.shop('buy');
    f.workflow.start(f.spec([{ type: 'buy', rows: [{ id: 512, count: 2 }] }]), f.context);
    f.workflow.tick(f.context);
    f.context.inventory = [item(12)];
    f.context.zeny = 800;
    f.workflow.observe([], f.context);
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    f.receive({ type: 'npcDialog', name: 'Merchant', text: 'Thank you.', big: false });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('complete');
  });
  it('guards both displayed/server prices and confirms the exact server discount bug', () => {
    const f = fixture();
    f.shop('buy', 10);
    f.world.shop!.entries[0]!.price = 500;
    // Server unit=500-floor(512*24/100)=378; displayed unit=380.
    const spec = f.spec([{ type: 'buy', rows: [{ id: 512, count: 2 }] }], { maxSpend: 760 });
    expect(dryRunWorkflow(spec, f.context)).toEqual({
      ok: true,
      reasons: [],
      estimatedSpend: 760,
      unpriced: false,
    });
    f.workflow.start(spec, f.context);
    expect(f.workflow.tick(f.context)?.type).toBe('shop');
    f.context.inventory = [item(12)];
    f.context.zeny = 240;
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running'); // displayed debit alone is not server receipt.
    f.context.zeny = 244;
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot()).toMatchObject({ state: 'complete', spent: 756 });
  });
  it('does not underbudget when the server discount is smaller than the display', () => {
    const f = fixture();
    f.shop('buy', 10);
    f.world.shop!.entries[0]!.price = 1000;
    f.context.zeny = 2000;
    // Display says1520; pinned server charges1756 for two of item512.
    expect(
      f.workflow.start(
        f.spec([{ type: 'buy', rows: [{ id: 512, count: 2 }] }], { maxSpend: 1520 }),
        f.context,
      ).ok,
    ).toBe(false);
    expect(f.workflow.tick(f.context)).toBeNull();
  });
  it('blocks negative-price and overflowing discounted server arithmetic', () => {
    const f = fixture();
    f.shop('buy', 10);
    f.world.shop!.entries[0]!.price = 15;
    expect(
      worldActionBlockers({ type: 'shop', mode: 'buy', rows: [{ id: 512, count: 1 }] }, f.context),
    ).toContain('Requested item or safe price is unavailable.');
    f.world.shop!.entries = [{ itemId: 2_147_483_647, price: 1000 }];
    expect(
      worldActionBlockers(
        { type: 'shop', mode: 'buy', rows: [{ id: 2_147_483_647, count: 1 }] },
        f.context,
      ),
    ).toContain('Requested item or safe price is unavailable.');
  });
  it('does not confirm extra purchased items or excess sold quantities', () => {
    const f = fixture();
    f.shop('buy');
    f.workflow.start(f.spec([{ type: 'buy', rows: [{ id: 512, count: 2 }] }]), f.context);
    f.workflow.tick(f.context);
    f.context.inventory = [item(13)];
    f.context.zeny = 800;
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    const g = fixture();
    g.shop('sell');
    g.workflow.start(g.spec([{ type: 'sell', rows: [{ id: 512, count: 2 }] }]), g.context);
    g.workflow.tick(g.context);
    g.context.inventory = [item(7)];
    g.context.zeny = 1014;
    g.receive({ type: 'npcEnd' });
    g.workflow.tick(g.context);
    expect(g.workflow.snapshot().state).toBe('running');
  });
  it('confirms sales only after the exact server proceeds and bag/item reductions', () => {
    const f = fixture();
    f.shop('sell', 10);
    f.workflow.start(f.spec([{ type: 'sell', rows: [{ id: 512, count: 2 }] }]), f.context);
    expect(f.workflow.tick(f.context)).toEqual({
      type: 'shop',
      mode: 'sell',
      rows: [{ id: 512, count: 2 }],
    });
    f.context.inventory = [item(8)];
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    f.context.zeny = 1017;
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('running');
    // floor(7*124/100) per-unit, then count2, yields16 not floor(14*124/100)=17.
    f.context.zeny = 1016;
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot()).toMatchObject({ state: 'complete', spent: 0 });
  });
  it('uses zero ammo proceeds even if its catalog sell price is positive', () => {
    const f = fixture();
    f.context.inventory = [item(10, 1750)];
    f.context.itemCatalog = { '1750': { sellPrice: 7, itemClass: 4 } };
    f.shop('sell', 10);
    f.workflow.start(f.spec([{ type: 'sell', rows: [{ id: 1750, count: 2 }] }]), f.context);
    f.workflow.tick(f.context);
    f.context.inventory = [item(8, 1750)];
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('complete');
  });
  it('blocks a sale when its catalog price or resulting safe balance is unknown', () => {
    const f = fixture();
    f.context.itemCatalog = undefined;
    f.shop('sell');
    f.workflow.start(f.spec([{ type: 'sell', rows: [{ id: 512, count: 2 }] }]), f.context);
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().state).toBe('failed');
    f.context.itemCatalog = { '512': { sellPrice: 7, itemClass: 1 } };
    f.context.zeny = 2_147_483_647;
    expect(
      worldActionBlockers({ type: 'shop', mode: 'sell', rows: [{ id: 512, count: 1 }] }, f.context),
    ).toContain('Verified sale prices or safe proceeds are unavailable.');
  });
  it('rechecks budget after a future shop becomes known', () => {
    const f = fixture();
    const spec = f.spec([{ type: 'talk' }, { type: 'buy', rows: [{ id: 512, count: 2 }] }], {
      maxSpend: 100,
    });
    expect(f.workflow.start(spec, f.context)).toMatchObject({ ok: true, unpriced: true });
    f.workflow.tick(f.context);
    f.shop('buy');
    f.workflow.tick(f.context);
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot()).toMatchObject({
      state: 'failed',
      reason: 'Purchase would exceed the workflow budget.',
    });
  });
  it('protects configured minimum stock before selling', () => {
    const f = fixture();
    f.shop('sell');
    f.workflow.start(
      f.spec([{ type: 'sell', rows: [{ id: 512, count: 6 }] }], {
        minStock: [{ itemId: 512, count: 5 }],
      }),
      f.context,
    );
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot()).toMatchObject({
      state: 'failed',
      reason: 'Operation would use the minimum stock for item 512.',
    });
  });
  it('allows buying when starting below the kept-stock threshold', () => {
    const f = fixture();
    f.context.inventory = [item(1)];
    f.shop('buy');
    f.workflow.start(
      f.spec([{ type: 'buy', rows: [{ id: 512, count: 5 }] }], {
        minStock: [{ itemId: 512, count: 3 }],
      }),
      f.context,
    );
    expect(f.workflow.tick(f.context)?.type).toBe('shop');
  });
  it('matches exact storage response and authoritative inventory delta', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'storageOpened', items: [item(4)] });
    f.workflow.start(
      f.spec([{ type: 'deposit', bagId: 512, count: 2 }, { type: 'closeStorage' }]),
      f.context,
    );
    expect(f.workflow.tick(f.context)).toEqual({
      type: 'storage',
      operation: 'deposit',
      bagId: 512,
      count: 2,
    });
    f.context.inventory = [item(8)];
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().step).toBe(0);
    f.receive({
      type: 'storageMoved',
      item: item(5),
      change: 1,
      currentWeight: 500,
      storageCount: 5,
      deposit: true,
    });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().step).toBe(0);
    f.receive({
      type: 'storageMoved',
      item: item(7),
      change: 2,
      currentWeight: 500,
      storageCount: 7,
      deposit: true,
    });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().step).toBe(1);
    expect(f.workflow.tick(f.context)).toEqual({ type: 'storage', operation: 'close' });
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('complete');
  });
  it('guards minimum inventory stock before deposit, but allows confirmed withdrawal', () => {
    const f = fixture();
    f.focus();
    f.receive({ type: 'storageOpened', items: [item(4)] });
    f.workflow.start(
      f.spec([{ type: 'deposit', bagId: 512, count: 6 }], {
        minStock: [{ itemId: 512, count: 5 }],
      }),
      f.context,
    );
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().state).toBe('failed');
    f.workflow.start(f.spec([{ type: 'withdraw', bagId: 512, count: 2 }]), f.context);
    expect(f.workflow.tick(f.context)).toEqual({
      type: 'storage',
      operation: 'withdraw',
      bagId: 512,
      count: 2,
    });
    f.receive({
      type: 'storageMoved',
      item: item(2),
      change: 2,
      currentWeight: 500,
      storageCount: 2,
      deposit: false,
    });
    f.context.inventory = [item(12)];
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('complete');
  });
  it('does not resend a money or resource operation after timeout', () => {
    const f = fixture();
    f.shop('buy');
    f.workflow.start(
      f.spec([{ type: 'buy', rows: [{ id: 512, count: 2 }] }], { timeoutMs: 1000 }),
      f.context,
    );
    expect(f.workflow.tick(f.context)?.type).toBe('shop');
    f.advance(1000);
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().state).toBe('failed');
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().reason).toContain('outcome is unconfirmed');
  });
  it.each(['map', 'generation', 'focus', 'manual', 'death'])(
    'cancels a pending workflow on %s',
    (reason) => {
      const f = fixture();
      f.workflow.start(f.spec([{ type: 'talk' }]), f.context);
      f.workflow.tick(f.context);
      if (reason === 'map') f.context.map = 'prt_fild08';
      if (reason === 'generation') f.world.reset('prontera');
      if (reason === 'focus') f.receive({ type: 'npcFocus', id: 124, focus: true });
      if (reason === 'manual') f.workflow.cancel('Manual input.');
      if (reason === 'death') f.context.alive = false;
      expect(f.workflow.tick(f.context)).toBeNull();
      expect(f.workflow.snapshot().state).toBe('cancelled');
    },
  );
  it('does not send while an inherited movement leg remains outstanding', () => {
    const f = fixture();
    f.workflow.start(f.spec([{ type: 'talk' }]), f.context);
    f.context.idle = false;
    expect(f.workflow.tick(f.context)).toBeNull();
    f.context.idle = true;
    expect(f.workflow.tick(f.context)?.type).toBe('npcTalk');
  });
  it('keeps a copied workflow definition when caller mutates its input', () => {
    const f = fixture();
    const spec = f.spec([{ type: 'talk' }]);
    f.workflow.start(spec, f.context);
    spec.npcId = 124;
    spec.steps.push({ type: 'closeStorage' });
    expect(f.workflow.tick(f.context)).toEqual({ type: 'npcTalk', id: 123 });
    expect(f.workflow.snapshot().total).toBe(1);
  });
});

describe('manual and routine context gates', () => {
  it('requires confirmed windows, counts, and unprotected equipment', () => {
    const f = fixture();
    expect(
      worldActionBlockers({ type: 'shop', mode: 'sell', rows: [{ id: 512, count: 1 }] }, f.context),
    ).toContain('The corresponding shop is not open.');
    f.shop('sell');
    f.context.equipped = [512];
    expect(
      worldActionBlockers({ type: 'shop', mode: 'sell', rows: [{ id: 512, count: 1 }] }, f.context),
    ).toContain('Equipped or protected items cannot be consumed.');
    f.context.equipped = [];
    f.context.protectedItemIds = [512];
    expect(
      worldActionBlockers({ type: 'shop', mode: 'sell', rows: [{ id: 512, count: 1 }] }, f.context),
    ).toContain('Equipped or protected items cannot be consumed.');
  });
  it('requires observed invitation and leader identity for party actions', () => {
    const f = fixture();
    expect(
      worldActionBlockers({ type: 'partyAccept', partyId: 3 }, f.context).length,
    ).toBeGreaterThan(0);
    f.receive({ type: 'partyInvite', partyId: 3, name: 'P', sender: 'S' });
    expect(worldActionBlockers({ type: 'partyAccept', partyId: 3 }, f.context)).toEqual([]);
    f.receive({
      type: 'partyJoined',
      partyId: 3,
      name: 'P',
      login: false,
      members: [{ memberId: 5, entityId: 100, level: 9, name: 'Raon', leader: false }],
    });
    expect(worldActionBlockers({ type: 'partyDisband' }, f.context).length).toBeGreaterThan(0);
    f.receive({ type: 'partyLeader', memberId: 5 });
    expect(worldActionBlockers({ type: 'partyDisband' }, f.context)).toEqual([]);
  });
  it('requires source capabilities and observed cart items before vending', () => {
    const f = fixture();
    const action = {
      type: 'vendingStart' as const,
      name: 'Shop',
      rows: [{ id: 512, count: 2, price: 30 }],
    };
    expect(worldActionBlockers(action, f.context).length).toBeGreaterThan(0);
    f.world.replaceCart([item(10)]);
    f.context.vendingLevel = 1;
    expect(worldActionBlockers(action, f.context)).toEqual([]);
    f.context.pushCartLevel = 1;
    expect(
      worldActionBlockers({ type: 'cart', direction: 2, bagId: 512, count: 2 }, f.context),
    ).toEqual([]);
    f.receive({ type: 'vendingStarted', name: 'Shop', rows: action.rows });
    expect(
      worldActionBlockers({ type: 'cart', direction: 2, bagId: 512, count: 2 }, f.context),
    ).toContain('Finish the current interaction first.');
  });
  it('does not substitute the cart-to-storage opcode no-op for supported movement', () => {
    const f = fixture();
    expect(
      worldActionBlockers({ type: 'cart', direction: 3, bagId: 512, count: 1 } as never, f.context),
    ).toEqual(['Unsupported cart direction']);
  });
  it('guards barter minimum stock and consumes only selected unique ingredients', () => {
    const f = fixture();
    f.focus();
    f.receive({
      type: 'barterOpened',
      offers: [
        { item: item(1, 513), count: 1, zenyCost: 50, required: [{ itemId: 512, count: 3 }] },
      ],
    });
    f.workflow.start(
      f.spec([{ type: 'barter', choice: 0, count: 2, bagIds: [] }], {
        minStock: [{ itemId: 512, count: 5 }],
      }),
      f.context,
    );
    expect(f.workflow.tick(f.context)).toBeNull();
    expect(f.workflow.snapshot().state).toBe('failed');
    f.workflow.start(f.spec([{ type: 'barter', choice: 0, count: 1, bagIds: [] }]), f.context);
    expect(f.workflow.tick(f.context)?.type).toBe('npcBarter');
    f.context.inventory = [item(7), item(1, 513)];
    f.context.zeny = 950;
    f.receive({ type: 'npcEnd' });
    f.workflow.tick(f.context);
    expect(f.workflow.snapshot().state).toBe('complete');
  });
});

describe('workflow input boundary', () => {
  it.each([
    { steps: [] },
    { steps: Array.from({ length: 33 }, () => ({ type: 'talk' })) },
    { map: '../../file' },
    { npcId: -1 },
    { maxSpend: -1 },
    { timeoutMs: 999 },
    { steps: [{ type: 'option', index: 0, expectedLabel: '' }] },
    { steps: [{ type: 'talk', script: 'alert(1)' }] },
    { script: 'eval' },
    { steps: [{ type: 'buy', rows: [] }] },
    { steps: [{ type: 'talk', expectedCost: -1 }] },
    { steps: [{ type: 'deposit', bagId: 512, count: 1, expectedCost: 1 }] },
    {
      minStock: [
        { itemId: 512, count: 1 },
        { itemId: 512, count: 2 },
      ],
    },
  ])('rejects invalid steps, values, and arbitrary scripts %j', (patch) => {
    const f = fixture();
    expect(() => validateWorkflowSpec({ ...f.spec([{ type: 'talk' }]), ...patch })).toThrow();
  });
});

describe('vending purchase confirmations', () => {
  function store() {
    const f = fixture();
    f.focus();
    f.receive({
      type: 'vendingViewed',
      id: 200,
      name: 'Supplies',
      entries: [
        { item: item(3, 512, 512), price: 30 },
        { item: { ...item(1, 512, 900), type: 2 }, price: 50 },
      ],
    });
    const action = {
      type: 'vendingPurchase' as const,
      rows: [
        { id: 512, count: 2 },
        { id: 900, count: 1 },
      ],
    };
    const receipt = createVendingReceipt(action, f.context);
    return { ...f, receipt };
  }
  it('confirms exact item gains and cost even when NPC end arrives first', () => {
    const f = store();
    expect(f.receipt).toMatchObject({ cost: 110, gains: [{ itemId: 512, before: 10, count: 3 }] });
    f.receive({ type: 'npcEnd' });
    expect(confirmVendingReceipt(f.receipt, f.context)).toBe(false);
    f.context.inventory = [item(12), { ...item(1, 512, 901), type: 2 }];
    f.context.zeny = 890;
    expect(confirmVendingReceipt(f.receipt, f.context)).toBe(true);
  });
  it('rejects a debit without the purchased item increase and unrelated larger gains', () => {
    const f = store();
    f.context.zeny = 890;
    expect(confirmVendingReceipt(f.receipt, f.context)).toBe(false);
    f.context.inventory = [item(14)];
    expect(confirmVendingReceipt(f.receipt, f.context)).toBe(false);
    f.context.inventory = [item(13)];
    f.context.zeny = 889;
    expect(confirmVendingReceipt(f.receipt, f.context)).toBe(false);
  });
  it('rejects late confirmations from a prior map/session or a different vendor', () => {
    const f = store();
    f.context.inventory = [item(13)];
    f.context.zeny = 890;
    f.world.reset('prontera', true);
    expect(confirmVendingReceipt(f.receipt, f.context)).toBe(false);
    const g = store();
    g.context.inventory = [item(13)];
    g.context.zeny = 890;
    g.receive({ type: 'vendingViewed', id: 201, name: 'Different', entries: [] });
    expect(confirmVendingReceipt(g.receipt, g.context)).toBe(false);
  });
  it('confirms an explicit zero-row close only after the observed store closes', () => {
    const f = store();
    const receipt = createVendingReceipt({ type: 'vendingPurchase', rows: [] }, f.context);
    expect(confirmVendingReceipt(receipt, f.context)).toBe(false);
    f.receive({ type: 'npcEnd' });
    expect(confirmVendingReceipt(receipt, f.context)).toBe(true);
  });
});

import { itemId as domainItemId } from '../../shared/domain-values';
import { validateAutomation } from '../settings/settings';
import { describe, expect, it } from 'vitest';
import cases from '../../data/hp-potion-cases.json';
import catalog from '../../data/recovery-item-catalog.json';
import gameCatalog from '../../data/game-catalog.json';
import {
  DEFAULT_HP_POTIONS,
  HP_POTION_IDS,
  hpPotionIds,
  recoveryItemCooldown,
  validateHpPotions,
  type HpPotionSettings,
} from './hp-potions';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  validateSettings,
  type AutomationSettings,
} from '../settings/settings';
import { ITEM_CATALOG } from '../catalog/game-catalog';
import { ProfileStore } from '../settings/profiles';
import { formDocument } from '../settings/current-form';
import { CharacterState } from '../world/character-state';
import { AutomationScheduler } from '../automation/automation';
import { BotEngine, type Action } from '../automation/engine';
import { dispositionStockFloors } from '../services/disposition-ui';
import { validateWorkflowSpec } from '../services/workflows';
import type { Entity } from '../protocol/protocol';
import type { FeatureEvent } from '../protocol/protocol-feature';

const player: Entity = {
  id: 1,
  classId: 6,
  name: 'Test',
  kind: 0,
  level: 10,
  hp: 55,
  maxHp: 100,
  x: 100,
  y: 100,
  dead: false,
};
const policy = (): AutomationSettings & { hpPotions: HpPotionSettings } => ({
  ...structuredClone(DEFAULT_AUTOMATION),
  hpPotions: { ...DEFAULT_HP_POTIONS, mode: 'selected' as const, itemIds: [501, 504] },
});
const settings = () => ({
  ...DEFAULT_SETTINGS,
  map: 'prt_fild08',
  targets: [4000],
  automation: policy(),
});
function fixture(
  stock: [number, number][] = [
    [501, 1],
    [504, 3],
  ],
) {
  let now = 100_000;
  const state = new CharacterState();
  state.apply(
    {
      type: 'inventory',
      items: stock.map(([itemId, count]) => ({ bagId: itemId, itemId, count, type: 1 })),
      equipment: [],
      ammoId: -1,
    },
    1,
  );
  const scheduler = new AutomationScheduler(
    () => {},
    () => now,
  );
  const consume = (itemId: number) => {
    const event: FeatureEvent = {
      type: 'inventoryDelta',
      add: false,
      bagId: itemId,
      change: 1,
      weight: 0,
    };
    state.apply(event, 1);
    return scheduler.observe(event, state, 1);
  };
  return {
    state,
    scheduler,
    consume,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('HP potion settings contract', () => {
  it.each(cases)('shares the native schema case: $name', (row) => {
    const configured = settings();
    if (row.absent) delete (configured.automation as typeof DEFAULT_AUTOMATION).hpPotions;
    else Object.assign(configured.automation, { hpPotions: row.policy });
    const check = () => validateSettings(configured);
    if (row.valid) {
      expect(check().automation?.hpPotions).toEqual(row.policy);
      if (!row.absent) expect(validateHpPotions(row.policy)).toEqual(row.policy);
    } else expect(check).toThrow();
  });
  it('uses classified untargeted HP recovery items from the pinned client', () => {
    expect(new Set(HP_POTION_IDS).size).toBe(69);
    expect(catalog.clientItemsSha256).toBe(gameCatalog.sources.items.sha256);
    for (const id of HP_POTION_IDS)
      expect(ITEM_CATALOG[id]).toMatchObject({ itemClass: 1, useType: 1 });
    for (const id of [505, 506, 601, 645, 656, 657, 12016]) expect(HP_POTION_IDS).not.toContain(id);
  });
  it('round-trips selection order, disabled preferences and legacy rules in profiles and current forms', () => {
    const data = new Map<string, string>();
    const storage = {
      getItem: (key: string) => data.get(key) ?? null,
      setItem: (key: string, text: string) => {
        data.set(key, text);
      },
    };
    let id = 0;
    const store = new ProfileStore(storage, () => `potion-profile-${++id}`);
    for (const mode of ['off', 'any', 'selected'] as const) {
      const configured = settings();
      configured.automation.hpPotions.mode = mode;
      configured.automation.hpPotions.itemIds = [504, 501];
      configured.automation.items = [
        { itemId: 505, resource: 'sp', belowPercent: 20, minStock: 2, cooldownSeconds: 10 },
      ];
      const saved = store.save('Potions', 'Test', configured, store.list()[0]?.id);
      expect(
        new ProfileStore(storage).list().find((profile) => profile.id === saved.id)?.settings,
      ).toEqual(configured);
      expect(store.import(store.export(saved.id))[0]?.settings).toEqual(configured);
      expect(
        formDocument({ version: 1, revision: 0, selectedProfileId: saved.id, settings: configured })
          .settings,
      ).toEqual(configured);
    }
  });
});

describe('automatic HP potion use', () => {
  it.each(['any', 'selected'] as const)(
    'uses %s HP items without delay only after confirmed consumption, retaining reserves and threshold',
    (mode) => {
      const f = fixture([
          [501, 2],
          [504, 2],
        ]),
        a = policy();
      a.hpPotions = { ...a.hpPotions, mode, minStock: 1, cooldownSeconds: 0 };
      const admitted = validateAutomation(a);
      const first = f.scheduler.next(admitted, player, f.state, null).action!;
      expect(first).toEqual({ type: 'useItem', itemId: 501 });
      f.scheduler.submit(first, f.state);
      expect(f.scheduler.next(admitted, player, f.state, null)).toEqual({});
      expect(
        f.scheduler.observe({ type: 'stats', level: 10, hp: 55, maxHp: 100 }, f.state, 1).state,
      ).toBe('ignored');
      expect(f.scheduler.next(admitted, player, f.state, null)).toEqual({});
      expect(f.consume(501).state).toBe('confirmed');
      const second = f.scheduler.next(admitted, player, f.state, null).action!;
      expect(second).toEqual({ type: 'useItem', itemId: 504 });
      expect(f.scheduler.next(admitted, { ...player, hp: 61 }, f.state, null)).toEqual({});
      f.scheduler.submit(second, f.state);
      expect(f.consume(504).state).toBe('confirmed');
      expect(f.scheduler.next(admitted, player, f.state, null)).toEqual({});
      expect(f.state.count(domainItemId(501))).toBe(1);
      expect(f.state.count(domainItemId(504))).toBe(1);
      expect(recoveryItemCooldown(admitted, domainItemId(504))).toBe(0);
    },
  );
  it('follows selected order, then falls back only after the confirmed spend and shared cooldown', () => {
    const f = fixture(),
      a = policy();
    const first = f.scheduler.next(validateAutomation(a), player, f.state, null).action!;
    expect(first).toEqual({ type: 'useItem', itemId: 501 });
    f.scheduler.submit(first, f.state);
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null)).toEqual({});
    expect(f.consume(504).state).toBe('ignored');
    expect(f.consume(501).state).toBe('confirmed');
    f.advance(4999);
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null)).toEqual({});
    f.advance(1);
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null).action).toEqual({
      type: 'useItem',
      itemId: 504,
    });
  });
  it('uses any carried HP potion while skipping reserved, SP and status items', () => {
    const f = fixture([
        [569, 1],
        [501, 1],
        [504, 2],
        [505, 30],
        [506, 30],
      ]),
      a = policy();
    a.hpPotions.mode = 'any';
    a.hpPotions.minStock = 1;
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null).action).toEqual({
      type: 'useItem',
      itemId: 504,
    });
    f.state.inventory.clear();
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null)).toEqual({});
  });
  it('honors preference changes, HP threshold, Off and complete inventory readiness', () => {
    const f = fixture(),
      a = policy();
    a.hpPotions.itemIds = [504, 501];
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null).action).toEqual({
      type: 'useItem',
      itemId: 504,
    });
    expect(f.scheduler.next(validateAutomation(a), { ...player, hp: 61 }, f.state, null)).toEqual(
      {},
    );
    f.state.inventoryKnown = false;
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null).failure).toContain(
      'full inventory',
    );
    a.hpPotions.mode = 'off';
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null)).toEqual({});
  });
  it('keeps advanced conditions, reserve and cooldown authoritative for their item IDs', () => {
    const f = fixture(),
      a = policy();
    a.items = [
      {
        itemId: 501,
        resource: 'hp',
        belowPercent: 60,
        minStock: 0,
        cooldownSeconds: 20,
        conditions: [
          { field: 'actorHpPercent', actor: { scope: 'self' }, operator: 'lte', value: 10 },
        ],
      },
    ];
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null).action).toEqual({
      type: 'useItem',
      itemId: 504,
    });
    delete a.items[0]!.conditions;
    const first = f.scheduler.next(validateAutomation(a), player, f.state, null).action!;
    expect(first).toEqual({ type: 'useItem', itemId: 501 });
    f.scheduler.submit(first, f.state);
    f.consume(501);
    f.advance(1000);
    expect(f.scheduler.next(validateAutomation(a), player, f.state, null)).toEqual({});
    expect(recoveryItemCooldown(validateAutomation(a), domainItemId(501))).toBe(20);
    expect(recoveryItemCooldown(validateAutomation(a), domainItemId(504))).toBe(5);
    a.items[0]!.cooldownSeconds = 1;
    a.hpPotions.cooldownSeconds = 10;
    a.hpPotions.itemIds = [504];
    expect(recoveryItemCooldown(validateAutomation(a), domainItemId(501))).toBe(10);
  });
  it('protects active potion reserves for transfers and macro consumption', () => {
    const a = policy();
    a.hpPotions.minStock = 3;
    expect(dispositionStockFloors(a)).toEqual([
      { itemId: 501, count: 3 },
      { itemId: 504, count: 3 },
    ]);
    a.hpPotions.mode = 'any';
    expect(dispositionStockFloors(a).map((row) => row.itemId)).toEqual(HP_POTION_IDS);
    a.hpPotions.mode = 'off';
    expect(dispositionStockFloors(a)).toEqual([]);
    expect(hpPotionIds(undefined)).toEqual([]);
  });
  it.each(['any', 'selected'] as const)(
    'merges overlapping %s and advanced potion reserves before NPC workflows',
    (mode) => {
      const a = policy();
      a.hpPotions.mode = mode;
      a.hpPotions.minStock = 3;
      a.items = [
        { itemId: 501, resource: 'hp', belowPercent: 60, minStock: 2, cooldownSeconds: 5 },
      ];
      const floors = dispositionStockFloors(a);
      expect(floors.filter((row) => row.itemId === 501)).toEqual([{ itemId: 501, count: 3 }]);
      expect(() =>
        validateWorkflowSpec({
          name: 'Protected stock',
          map: 'prontera',
          npcId: 1,
          maxSpend: 0,
          minStock: floors,
          steps: [{ type: 'talk' }],
        }),
      ).not.toThrow();
      a.items[0]!.minStock = 4;
      expect(dispositionStockFloors(a).filter((row) => row.itemId === 501)).toEqual([
        { itemId: 501, count: 4 },
      ]);
    },
  );
  it('uses the engine recovery path before sitting while retaining the HP safety stop', () => {
    let now = 100_000;
    const sent: Action[] = [];
    const engine = new BotEngine(
      (action) => sent.push(action),
      () => now,
      () => ({ width: 200, height: 200, walkable: () => true }),
    );
    engine.connect(true);
    engine.receive([
      { type: 'enter', id: 1, map: 'prt_fild08' },
      { type: 'spawn', entity: { ...player } },
      {
        type: 'inventory',
        items: [{ bagId: 504, itemId: 504, count: 3, type: 1 }],
        equipment: [],
        ammoId: -1,
      },
    ]);
    const configured = settings();
    configured.automation.recovery.enabled = true;
    configured.automation.recovery.spStart = 0;
    engine.start(configured);
    now += 1000;
    engine.tick();
    expect(sent).toEqual([{ type: 'useItem', itemId: 504 }]);
    now += 1000;
    engine.tick();
    expect(sent).toHaveLength(1);
    engine.receive([{ type: 'inventoryDelta', add: false, bagId: 504, change: 1, weight: 0 }]);
    now += 1000;
    engine.tick();
    expect(sent.at(-1)).toEqual({ type: 'sit', sitting: true });
    engine.receive([{ type: 'sit', id: 1, sitting: true }]);
    engine.stop();
    sent.length = 0;
    engine.start(configured);
    engine.player!.hp = 40;
    now += 1000;
    engine.tick();
    expect(engine.running).toBe(false);
    expect(sent.some((action) => action.type === 'useItem')).toBe(false);
  });
});

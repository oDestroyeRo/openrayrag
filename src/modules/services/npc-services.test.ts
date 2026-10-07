import cases from '../../data/npc-service-request-cases.json';
import { describe, expect, it } from 'vitest';
import {
  BUILTIN_SERVICES,
  NpcServiceRuntime,
  confirmServiceReceipt,
  observeServiceReceipt,
  resolveServiceNpc,
  serviceAvailability,
  serviceByContractId,
  validateServiceDefinition,
  validateServiceRequest,
  type ServiceContext,
} from './npc-services';
import { TravelController } from '../navigation/travel-controller';
import { WorldState } from '../world/world-state';
import type { Entity, GameEvent } from '../protocol/protocol';
import type { WorldEvent, WorldAction } from '../protocol/world-protocol';
import { NpcServiceStore } from './npc-service-store';
import { NpcWorkflow } from './workflows';
import type { Action } from '../automation/engine';
const player: Entity = {
  id: 1,
  kind: 0,
  classId: 0,
  name: 'Tester',
  x: 150,
  y: 28,
  hp: 100,
  maxHp: 100,
  dead: false,
  level: 10,
};
const npc: Entity = { ...player, id: 20, kind: 2, classId: 50, name: 'Kafra Staff', x: 151, y: 29 };
const storage = BUILTIN_SERVICES[0]!,
  transport = BUILTIN_SERVICES[1]!;
function setup(definition = storage) {
  let now = 100_000;
  const sent: Array<Action | WorldAction> = [];
  const world = new WorldState();
  world.reset(definition.map);
  const c: ServiceContext & { world: WorldState } = {
    map: definition.map,
    playerId: 1,
    alive: true,
    idle: true,
    inventory: [],
    inventoryKnown: true,
    equipped: [],
    zeny: 500,
    world,
    visibleNpcIds: [20],
    basicSkillLevel: 5,
    player: { ...player, x: definition.approach.x, y: definition.approach.y },
    actors: [{ ...npc, name: definition.identity.name, ...definition.identity.anchor }],
    connection: 1,
  };
  const travel = new TravelController(
    (a) => sent.push(a),
    () => now,
  );
  const service = new NpcServiceRuntime(travel, () => now);
  service.start(definition, c);
  const tick = () => {
    const a = service.tick(c);
    if (a) sent.push(a);
    return a;
  };
  const receive = (events: GameEvent[] = [], worldEvents: WorldEvent[] = []) => {
    for (const e of worldEvents) world.apply(e, 1);
    service.observe(events, worldEvents, c);
    tick();
  };
  const start = () => {
    tick();
    tick();
    tick();
  };
  const dialog = (name: string, text: string) =>
    receive(
      [],
      [
        { type: 'npcFocus', id: npc.id, focus: true },
        { type: 'npcDialog', name, text, big: false },
      ],
    );
  const prepareFinal = () => {
    start();
    const greeting = definition.workflow.steps[1]!;
    if (greeting.type !== 'advance') throw Error();
    dialog(greeting.exactDialogue!.name, greeting.exactDialogue!.text);
    tick();
    const choice = definition.workflow.steps[2]!;
    if (choice.type !== 'option') throw Error();
    receive([], [{ type: 'npcOptions', options: choice.expectedOptions![0]! }]);
    tick();
    if (definition.outcome.type === 'arrival') {
      const d = definition.workflow.steps[3]!;
      if (d.type !== 'advance') throw Error();
      receive(
        [],
        [
          {
            type: 'npcDialog',
            name: d.exactDialogue!.name,
            text: d.exactDialogue!.text,
            big: false,
          },
        ],
      );
      tick();
      const m = definition.workflow.steps[4]!;
      if (m.type !== 'option') throw Error();
      receive([], [{ type: 'npcOptions', options: m.expectedOptions![0]! }]);
      tick();
    }
  };
  return {
    c,
    service,
    sent,
    tick,
    receive,
    start,
    dialog,
    prepareFinal,
    advance: (ms: number) => {
      now += ms;
      tick();
    },
  };
}
describe('portable pinned NPC contracts', () => {
  it('looks up portable contracts without exposing a shared mutable definition', () => {
    const copy = serviceByContractId(storage.contractId)!;
    expect(copy).toEqual(storage);
    copy.identity.name = 'Changed locally';
    copy.workflow.steps.pop();
    expect(serviceByContractId(storage.contractId)).toEqual(storage);
    expect(serviceByContractId('unverified.v1')).toBeNull();
  });
  it('has nine verified fee-zero contracts and no transient IDs', () => {
    expect(BUILTIN_SERVICES).toHaveLength(9);
    for (const s of BUILTIN_SERVICES) {
      expect(validateServiceRequest(s)).toEqual(s);
      expect(
        s.workflow.steps.every((step) => 'expectedCost' in step && step.expectedCost === 0),
      ).toBe(true);
      expect(JSON.stringify(s)).not.toContain('npcId');
    }
  });
  it('saves edited/unknown definitions as unavailable drafts but rejects unsafe fields/cells', () => {
    const changed = structuredClone(storage);
    changed.identity.name = 'Custom NPC';
    expect(serviceAvailability(validateServiceDefinition(changed))).toMatch(/differs/);
    expect(() => validateServiceRequest(changed)).toThrow(/differs/);
    expect(
      serviceAvailability(validateServiceDefinition({ ...storage, contractId: 'custom.v1' })),
    ).toMatch(/No verified/);
    for (const bad of [
      { ...storage, npcId: 20 },
      { ...storage, receipt: {} },
      { ...storage, map: 'missing' },
      { ...storage, identity: { ...storage.identity, kind: 4 } },
      { ...storage, approach: { ...storage.approach, y: 26 } },
      {
        ...storage,
        workflow: { ...storage.workflow, steps: [{ type: 'deposit', bagId: 10, count: 1 }] },
      },
    ])
      expect(() => validateServiceDefinition(bad)).toThrow();
  });
  it('roundtrips configuration, edits by stable ID, imports fresh IDs and bounds documents', () => {
    const values = new Map<string, string>();
    let id = 0;
    const store = new NpcServiceStore(
      { getItem: (k) => values.get(k) ?? null, setItem: (k, v) => values.set(k, v) },
      () => `service-${++id}`,
    );
    const saved = store.save(storage),
      edited = store.save({ ...saved, name: 'My storage' }, saved.id);
    expect(edited.id).toBe(saved.id);
    expect(store.list()).toHaveLength(1);
    const exported = store.export(saved.id),
      copies = store.import(exported);
    expect(copies[0]!.id).not.toBe(saved.id);
    expect(exported).not.toMatch(/npcId|bagId|generation|pending|receipt/);
    expect(() => store.import(exported.slice(0, -1))).toThrow();
    expect(() => store.import(' '.repeat(256001))).toThrow();
    expect(
      new NpcServiceStore({ getItem: () => exported, setItem: () => {} }).list()[0]!.name,
    ).toBe('My storage');
  });
});
describe('fresh service identity', () => {
  it('resolves a new ID each visit and filters exact map, kind, name and anchor', () => {
    expect(resolveServiceNpc(storage, 'prontera', [{ ...npc, id: 70 }])).toMatchObject({
      state: 'resolved',
      actor: { id: 70 },
    });
    expect(resolveServiceNpc(storage, 'prontera', [{ ...npc, id: 80 }])).toMatchObject({
      state: 'resolved',
      actor: { id: 80 },
    });
    for (const actors of [
      [{ ...npc, kind: 4 }],
      [{ ...npc, npcSpawn: { displayType: 3, effectType: 0, interactable: true, ownerId: 999 } }],
      [{ ...npc, name: 'Kafra Staff ' }],
      [{ ...npc, x: 152 }],
      [{ ...npc, dead: true }],
      [],
    ])
      expect(resolveServiceNpc(storage, 'prontera', actors).state).toBe('missing');
    expect(resolveServiceNpc(storage, 'izlude', [npc]).state).toBe('missing');
    expect(resolveServiceNpc(storage, 'prontera', [npc, { ...npc, id: 21 }]).state).toBe(
      'ambiguous',
    );
  });
  it('waits for missing actors and rejects ambiguous actors without talking', () => {
    const missing = setup();
    missing.c.actors = [];
    missing.start();
    expect(missing.service.snapshot().state).toBe('locate');
    expect(missing.sent).toEqual([]);
    missing.advance(30001);
    expect(missing.service.snapshot().state).toBe('failed');
    const duplicate = setup();
    duplicate.c.actors = [npc, { ...npc, id: 21 }];
    duplicate.start();
    expect(duplicate.service.snapshot().reason).toMatch(/More than one/);
    expect(duplicate.sent).toEqual([]);
  });
  it('invalidates despawn, movement and replacement before any next action', () => {
    for (const actors of [
      [],
      [{ ...npc, x: 152 }],
      [{ ...npc, name: 'Different' }],
      [{ ...npc, classId: 99 }],
      [{ ...npc, id: 21 }],
      [{ ...npc, npcSpawn: { displayType: 3, effectType: 0, interactable: true, ownerId: 999 } }],
    ]) {
      const f = setup();
      f.start();
      expect(f.sent.at(-1)?.type).toBe('npcTalk');
      f.c.actors = actors;
      f.tick();
      expect(f.service.snapshot().state).toBe('failed');
      expect(f.sent.filter((a) => a.type === 'npcAdvance')).toEqual([]);
    }
  });
});
describe('strict service dialogue and authoritative outcomes', () => {
  it('opens storage only after the authoritative storage snapshot and unchanged receipt', () => {
    const f = setup();
    f.prepareFinal();
    expect(f.service.snapshot().state).toBe('outcome');
    expect(f.sent.at(-1)).toEqual({ type: 'npcOption', index: 1 });
    f.receive([], [{ type: 'npcFocus', id: 20, focus: false }]);
    expect(f.service.snapshot().active).toBe(true);
    f.receive([], [{ type: 'storageOpened', items: [] }]);
    expect(f.service.snapshot()).toMatchObject({ state: 'complete', spent: 0 });
  });
  it('rejects wrong full text, speaker or option array even when selected label matches', () => {
    for (const variant of ['suffix', 'speaker']) {
      const f = setup();
      f.start();
      const d = storage.workflow.steps[1]!;
      if (d.type !== 'advance') throw Error();
      f.dialog(
        variant === 'speaker' ? 'Other' : d.exactDialogue!.name,
        d.exactDialogue!.text + (variant === 'suffix' ? ' extra' : ''),
      );
      f.tick();
      expect(f.service.snapshot().state).toBe('failed');
      expect(f.sent.filter((a) => a.type === 'npcAdvance')).toEqual([]);
    }
    const f = setup();
    f.start();
    const d = storage.workflow.steps[1]!;
    if (d.type !== 'advance') throw Error();
    f.dialog(d.exactDialogue!.name, d.exactDialogue!.text);
    f.tick();
    f.receive(
      [],
      [{ type: 'npcOptions', options: ['Save', 'Use Storage', 'Teleport Service', 'Cancel'] }],
    );
    f.tick();
    expect(f.service.snapshot().state).toBe('failed');
    expect(f.sent.filter((a) => a.type === 'npcOption')).toEqual([]);
  });
  it('allows only the source-verified conditional cart placeholder menu', () => {
    const f = setup();
    f.start();
    const d = storage.workflow.steps[1]!;
    if (d.type !== 'advance') throw Error();
    f.dialog(d.exactDialogue!.name, d.exactDialogue!.text);
    f.tick();
    const o = storage.workflow.steps[2]!;
    if (o.type !== 'option') throw Error();
    f.receive([], [{ type: 'npcOptions', options: o.expectedOptions![1]! }]);
    f.tick();
    expect(f.sent.at(-1)).toEqual({ type: 'npcOption', index: 1 });
  });
  it('does not complete a fee-zero service after an unexpected debit or stock change', () => {
    for (const change of ['zeny', 'stock']) {
      const f = setup();
      f.prepareFinal();
      if (change === 'zeny') f.c.zeny = 499;
      else f.c.inventory = [{ itemId: 501, bagId: 50, type: 1, count: 1 }];
      f.receive([], [{ type: 'storageOpened', items: [] }]);
      expect(f.service.snapshot().state).toBe('outcome');
      f.advance(10001);
      expect(f.service.snapshot().state).toBe('failed');
      expect(confirmServiceReceipt(f.service.receipt()!, f.c)).toBe(false);
    }
  });
  it('requires expected map plus exact fresh living self spawn for transport', () => {
    const f = setup(transport);
    f.prepareFinal();
    f.receive([], [{ type: 'npcEnd' }]);
    expect(f.service.snapshot().state).toBe('outcome');
    f.c.map = 'izlude';
    f.c.world.reset('izlude');
    f.c.player = undefined;
    f.c.alive = false;
    f.receive([{ type: 'map', map: 'izlude' }]);
    expect(f.service.snapshot().state).toBe('outcome');
    f.c.player = { ...player, x: 91, y: 105 };
    f.c.alive = true;
    f.receive([{ type: 'spawn', entity: f.c.player }]);
    expect(f.service.snapshot().state).toBe('complete');
  });
  it('fails unexpected transitions and never sends a next action after Stop; late arrival can settle only the receipt', () => {
    const wrong = setup(transport);
    wrong.prepareFinal();
    wrong.c.map = 'geffen';
    wrong.c.world.reset('geffen');
    wrong.receive([{ type: 'map', map: 'geffen' }]);
    expect(wrong.service.snapshot().state).toBe('failed');
    expect(wrong.service.receipt()).not.toBeNull();
    const f = setup(transport);
    f.prepareFinal();
    const receipt = f.service.receipt()!,
      count = f.sent.length;
    f.service.cancel();
    f.c.map = 'izlude';
    f.c.world.reset('izlude');
    f.c.player = { ...player, x: 91, y: 105 };
    f.receive([
      { type: 'map', map: 'izlude' },
      { type: 'spawn', entity: f.c.player },
    ]);
    expect(f.service.snapshot().state).toBe('cancelled');
    expect(f.sent).toHaveLength(count);
    expect(confirmServiceReceipt(receipt, f.c)).toBe(true);
  });
  it('requires a transition before a matching spawn and keeps canceled economic receipts across world resets', () => {
    const f = setup(transport);
    f.prepareFinal();
    const r = f.service.receipt()!;
    f.c.map = 'izlude';
    f.c.world.reset('izlude');
    observeServiceReceipt(r, [{ type: 'spawn', entity: { ...player, x: 91, y: 105 } }], [], f.c);
    expect(r.arrived).toBe(false);
    expect(confirmServiceReceipt(r, f.c)).toBe(false);
  });
});

describe('shared native service request corpus', () => {
  for (const c of cases)
    it(c.name, () => {
      if (c.valid) expect(() => validateServiceRequest(c.request)).not.toThrow();
      else expect(() => validateServiceRequest(c.request)).toThrow();
    });
});

describe('shop-open and resource-effect contracts', () => {
  it('recognizes only the observed six-row deployed menu for storage, never the recovery entry', () => {
    const menu = [
      'Save',
      'Use Storage',
      'Teleport Service',
      '',
      'Recover Old Cart Items',
      'Cancel',
    ];
    const f = setup();
    f.start();
    const greeting = storage.workflow.steps[1]!;
    if (greeting.type !== 'advance') throw Error();
    f.dialog(greeting.exactDialogue!.name, greeting.exactDialogue!.text);
    f.tick();
    f.receive([], [{ type: 'npcOptions', options: menu }]);
    f.tick();
    expect(f.sent.at(-1)).toEqual({ type: 'npcOption', index: 1 });
    expect(f.service.snapshot().state).toBe('outcome');
    f.receive([], [{ type: 'storageOpened', items: [] }]);
    expect(f.service.snapshot().state).toBe('complete');
    expect(f.sent.some((action) => action.type === 'npcOption' && action.index === 4)).toBe(false);
    for (const definition of [transport, storage]) {
      const rejected = setup(definition);
      rejected.start();
      rejected.dialog(greeting.exactDialogue!.name, greeting.exactDialogue!.text);
      rejected.tick();
      rejected.receive(
        [],
        [
          {
            type: 'npcOptions',
            options:
              definition === transport
                ? menu
                : menu.map((label) => (label === '' ? 'Rent Push Cart' : label)),
          },
        ],
      );
      rejected.tick();
      expect(rejected.service.snapshot().state).toBe('failed');
      expect(rejected.sent.some((action) => action.type === 'npcOption')).toBe(false);
    }
  });
  it('opens only the requested verified shop mode after its exact menu', () => {
    for (const definition of BUILTIN_SERVICES.slice(7)) {
      const f = setup(definition);
      f.start();
      expect(f.sent.at(-1)).toEqual({ type: 'npcTalk', id: 20 });
      f.receive(
        [],
        [
          { type: 'npcFocus', id: 20, focus: true },
          { type: 'npcOptions', options: ['Buy', 'Sell', 'Cancel'] },
        ],
      );
      f.tick();
      expect(f.service.snapshot().state).toBe('outcome');
      if (definition.outcome.type !== 'shopOpened') throw Error();
      f.receive(
        [],
        [
          {
            type: 'shopOpened',
            mode: definition.outcome.mode === 'buy' ? 'sell' : 'buy',
            discountLevel: 0,
            entries: [],
          },
        ],
      );
      expect(f.service.snapshot().state).toBe('outcome');
      f.receive(
        [],
        [{ type: 'shopOpened', mode: definition.outcome.mode, discountLevel: 0, entries: [] }],
      );
      expect(f.service.snapshot().state).toBe('complete');
    }
  });
  it('requires the actual exact balance readback for a declared nonzero workflow fee', () => {
    const f = setup(),
      workflow = new NpcWorkflow();
    f.c.world.apply({ type: 'npcFocus', id: 20, focus: true });
    f.c.world.apply({ type: 'npcOptions', options: ['Pay'] });
    workflow.start(
      {
        name: 'Known paid contract',
        map: 'prontera',
        npcId: 20,
        maxSpend: 50,
        minStock: [],
        steps: [{ type: 'option', index: 0, expectedLabel: 'Pay', expectedCost: 50 }],
      },
      f.c,
      { terminal: true, strictStock: true },
    );
    expect(workflow.tick(f.c)).toEqual({ type: 'npcOption', index: 0 });
    expect(workflow.settleTerminal(f.c)).toBe(false);
    f.c.zeny = 451;
    expect(workflow.settleTerminal(f.c)).toBe(false);
    f.c.zeny = 450;
    expect(workflow.settleTerminal(f.c)).toBe(true);
    expect(workflow.snapshot().spent).toBe(50);
  });
  it('does not accept a guessed paid-service contract at either boundary', () => {
    const changed = structuredClone(storage);
    const step = changed.workflow.steps[2]!;
    if (step.type !== 'option') throw Error();
    step.expectedCost = 50;
    changed.workflow.maxSpend = 50;
    expect(() => validateServiceRequest(changed)).toThrow(/differs/);
  });
  it('requires same-map clear and a Warp entry for a same-map receipt', () => {
    const f = setup(transport);
    f.prepareFinal();
    const r = f.service.receipt()!;
    r.outcome = { type: 'arrival', map: 'prontera', position: { x: 150, y: 28 }, timeoutMs: 20000 };
    observeServiceReceipt(
      r,
      [{ type: 'clear' }, { type: 'spawn', entity: { ...player }, entryType: 0 }],
      [],
      f.c,
    );
    expect(r.arrived).toBe(false);
    observeServiceReceipt(r, [{ type: 'spawn', entity: { ...player }, entryType: 2 }], [], f.c);
    expect(confirmServiceReceipt(r, f.c)).toBe(true);
  });
  it('fails wrong actor identity or exact arrival coordinates after the expected transition', () => {
    for (const entity of [
      { ...player, x: 92, y: 105 },
      { ...player, x: 91, y: 105, name: 'Other' },
      { ...player, x: 91, y: 105, kind: 2 },
      { ...player, x: 91, y: 105, dead: true },
    ]) {
      const f = setup(transport);
      f.prepareFinal();
      f.c.map = 'izlude';
      f.c.world.reset('izlude');
      f.receive([{ type: 'map', map: 'izlude' }]);
      f.c.player = entity;
      f.c.alive = !entity.dead;
      f.receive([{ type: 'spawn', entity }]);
      expect(f.service.snapshot().state).toBe('failed');
    }
  });
  it('Stop cancels every phase without issuing another service command', () => {
    for (const phase of ['preparing', 'approach', 'locate', 'conversation', 'outcome']) {
      const f = setup();
      if (phase === 'approach') f.tick();
      if (phase === 'locate') {
        f.tick();
        f.tick();
      }
      if (phase === 'conversation') f.start();
      if (phase === 'outcome') f.prepareFinal();
      expect(f.service.snapshot().state).toBe(phase);
      f.service.cancel();
      const count = f.sent.length;
      f.tick();
      f.receive([], [{ type: 'npcDialog', name: 'Late', text: 'Late', big: false }]);
      expect(f.service.snapshot().state).toBe('cancelled');
      expect(f.sent).toHaveLength(count);
    }
  });
});

describe('composed NPC identity checks', () => {
  it('short-circuits later evidence for ineligible kinds and dead actors', () => {
    const ineligible = { ...player };
    Object.defineProperty(ineligible, 'dead', {
      get: () => {
        throw new Error('Ineligible actor evidence was read.');
      },
    });
    const dead = { ...npc, dead: true };
    Object.defineProperty(dead, 'name', {
      get: () => {
        throw new Error('Dead actor identity was read.');
      },
    });
    expect(resolveServiceNpc(storage, storage.map, [ineligible, dead]).state).toBe('missing');
  });
});

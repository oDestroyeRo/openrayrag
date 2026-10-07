import { describe, expect, it } from 'vitest';
import { checkedEngagementIdentity, engagementIdentity, key } from './attack-strategy-logic';
import { AttackStrategyPolicy } from './attack-strategy';
import { ActorObservations } from '../world/actor-observations';
import { CharacterState } from '../world/character-state';
import { actorId, incarnation, itemId, quantity, type WorldId } from '../../shared/domain-values';
import {
  manualTargetPolicy,
  manualTargetSettings,
  validateActionIdentity,
  validateManualTargetRequest,
  type ManualTargetRequestInput,
} from './manual-target-logic';
import { actorKey, manualTargetView } from './manual-target-view-logic';
import { PartyEngagements } from '../party/party-engagement';
import { partyActorBinding } from '../party/party-actors-logic';
import { DEFAULT_SETTINGS, type AttackStrategyRule } from '../settings/settings';

const world = 'ABCDEFAB-0000-4000-8000-000000000001';
const rawIdentity = () => ({ world, id: 0, incarnation: 1 });
const rawRequest = (): ManualTargetRequestInput => ({
  type: 'manualTarget',
  map: 'prt_fild08',
  owner: rawIdentity(),
  command: { type: 'attack', target: { world, id: 2, incarnation: 2 } },
  timeoutSeconds: 30,
  policy: manualTargetPolicy(DEFAULT_SETTINGS),
});

function strategyFixture() {
  const state = new CharacterState();
  state.apply({ type: 'inventory', items: [], equipment: Array(10).fill(0), ammoId: -1 }, 1);
  state.apply(
    {
      type: 'skills',
      learned: [
        { skillId: 11, level: 1 },
        { skillId: 12, level: 10 },
      ],
    },
    1,
  );
  state.apply({ type: 'stats', hp: 100, maxHp: 100, level: 10, sp: 200, maxSp: 200 }, 1);
  const rule: AttackStrategyRule = {
    id: 'opener',
    speciesIds: [4000],
    skillId: 11,
    level: 1,
    behavior: 'opener',
    maxAttempts: 2,
    maxUses: 1,
    cooldownSeconds: 1,
  };
  const observations = new ActorObservations(() => 1000);
  observations.spawn({
    id: 0,
    kind: 0,
    classId: 2,
    name: 'Mage',
    level: 10,
    hp: 100,
    maxHp: 100,
    x: 2,
    y: 2,
    dead: false,
    statuses: [],
  });
  observations.frame();
  return {
    state,
    rule,
    snapshot: observations.snapshot(0, null, true),
    ledger: new AttackStrategyPolicy(),
  };
}

describe('observed engagement admission', () => {
  it.each(['injected world', '', 'world:with:separators', world])(
    'preserves the loose observation world %j and actor zero',
    (observedWorld) => {
      const context = { world: observedWorld, incarnation: 1, at: 1000, sequence: 7 };
      const identity = engagementIdentity(0, context)!;
      expect(identity).toEqual({ world: observedWorld, id: 0, incarnation: 1 });
      expect(Object.getOwnPropertySymbols(identity)).toEqual([]);
      expect(Object.keys(identity)).toEqual(['world', 'id', 'incarnation']);
      context.world = 'replaced';
      context.incarnation = 2;
      expect(key(identity)).toBe(`${observedWorld}:0:1`);
    },
  );

  it('preserves the unavailable lifetime gate before attempting admission', () => {
    expect(engagementIdentity(-1, { world: '', at: 1000 })).toBeNull();
    expect(engagementIdentity(-1, { world: '', at: 1000, incarnation: 0 })).toBeNull();
    expect(
      checkedEngagementIdentity({ world: '', id: 2147483647, incarnation: 2147483647 }),
    ).toEqual({ world: '', id: 2147483647, incarnation: 2147483647 });
    for (const id of [-1, 0.5, 2147483648, NaN])
      expect(() => checkedEngagementIdentity({ world, id, incarnation: 1 })).toThrow(
        'Invalid actor ID',
      );
    for (const lifetime of [0, -1, 0.5, 2147483648])
      expect(() => checkedEngagementIdentity({ world, id: 0, incarnation: lifetime })).toThrow(
        'Invalid incarnation',
      );
    expect(() => checkedEngagementIdentity({ world: null, id: 0, incarnation: 1 })).toThrow(
      'Invalid engagement world',
    );
  });

  it('keeps manual UUID syntax, case, numeric bounds and original first errors', () => {
    expect(JSON.stringify(validateActionIdentity(rawIdentity()))).toBe(
      JSON.stringify(rawIdentity()),
    );
    expect(() => validateActionIdentity({ ...rawIdentity(), world: 'injected world' })).toThrow(
      'Invalid observed actor identity.',
    );
    expect(() =>
      validateActionIdentity({ ...rawIdentity(), world: 'invalid', extra: true }),
    ).toThrow('Invalid manual target command.');
    expect(() => validateActionIdentity({ ...rawIdentity(), incarnation: 0 })).toThrow(
      'Invalid observed actor identity.',
    );
    const input = rawRequest();
    expect(() =>
      validateManualTargetRequest({ ...input, map: 'unknown', owner: {}, policy: {} }),
    ).toThrow('Invalid manual command map or deadline.');
    expect(() => validateManualTargetRequest({ ...input, owner: {}, policy: {} })).toThrow(
      'Invalid observed actor identity.',
    );
    expect(() => validateManualTargetRequest({ ...input, policy: {}, command: {} })).toThrow(
      'Invalid bounded manual policy.',
    );
  });

  it('returns detached admitted owner and target tuples with unchanged JSON fields', () => {
    const input = rawRequest(),
      admitted = validateManualTargetRequest(input);
    expect(JSON.stringify(admitted)).toBe(JSON.stringify(input));
    input.owner.incarnation = 5;
    if (input.command.type !== 'attack' || admitted.command.type !== 'attack')
      throw new Error('Expected attack request');
    input.command.target.id = 7;
    input.command.target.world = 'injected world';
    input.policy.monsterRules.push({ classId: 4000, action: 'ignore', priority: 0 });
    expect(admitted.owner.incarnation).toBe(1);
    expect(admitted.command.target).toEqual({ world, id: 2, incarnation: 2 });
    expect(admitted.policy.monsterRules).toEqual([]);
  });

  it('keeps the UI request and preview target as separate detached identities', () => {
    const observedWorld = 'abcdefab-0000-4000-8000-000000000001';
    const observations = new ActorObservations(
      () => 1000,
      () => observedWorld,
    );
    const player = {
      id: 0,
      kind: 0,
      classId: 2,
      name: 'Mage',
      level: 10,
      hp: 100,
      maxHp: 100,
      x: 2,
      y: 2,
      dead: false,
      statuses: [],
    };
    const monster = { ...player, id: 2, kind: 1, classId: 4000 };
    observations.spawn(player);
    observations.spawn(monster);
    observations.frame();
    const actors = observations.snapshot(0, null, true),
      observed = actors.actors.find((actor) => actor.id === 2)!;
    const view = manualTargetView(
      {
        actorObservations: actors,
        player,
        monsters: [monster],
        connected: true,
        compatible: true,
        map: 'prt_fild08',
        character: new CharacterState().snapshot(),
      },
      DEFAULT_SETTINGS,
      { type: 'attack', key: actorKey(observedWorld, observed.id, observed.incarnation) },
      30,
      1000,
    );
    if (view.request.command.type !== 'attack') throw new Error('Expected attack request');
    Reflect.set(view.request.command.target, 'id', 8);
    expect(view.context.targetIdentity!.id).toBe(2);
    Reflect.set(view.context.targetIdentity!, 'incarnation', 9);
    expect(view.request.command.target.incarnation).toBe(observed.incarnation);
  });

  it('retains independent ledger and pending receipt tuples after caller mutation', () => {
    const { state, rule, snapshot: observations, ledger } = strategyFixture(),
      identity = checkedEngagementIdentity(rawIdentity());
    const choice = ledger.choose([rule], identity, 4000, state, observations, 1000);
    if (choice.state !== 'cast') throw new Error(`Expected cast, got ${choice.state}`);
    ledger.dispatched(choice, 7, 1000);
    Reflect.set(identity, 'id', 8);
    Reflect.set(choice.identity, 'incarnation', 9);
    expect(ledger.pendingTarget).toBe(0);
    ledger.settled(7, 'confirmed', checkedEngagementIdentity(rawIdentity()));
    const snapshot = ledger.snapshot();
    expect(snapshot.pending).toBe(false);
    expect(snapshot.entries[0]).toMatchObject({
      id: 0,
      incarnation: 1,
      rules: [{ uses: 1, uncertain: false }],
    });
    Reflect.set(snapshot.entries[0]!, 'id', 10);
    expect(ledger.snapshot().entries[0]!.id).toBe(0);
  });

  it.each(['world', 'incarnation'] as const)(
    'never credits a receipt from a changed %s',
    (field) => {
      const { state, rule, snapshot: observations, ledger } = strategyFixture(),
        identity = checkedEngagementIdentity(rawIdentity());
      const choice = ledger.choose([rule], identity, 4000, state, observations, 1000);
      if (choice.state !== 'cast') throw new Error('Expected cast');
      ledger.dispatched(choice, 7, 1000);
      const changed = checkedEngagementIdentity({
        ...rawIdentity(),
        [field]: field === 'world' ? 'injected world' : 2,
      });
      ledger.settled(8, 'confirmed', identity);
      expect(ledger.snapshot().pending).toBe(true);
      ledger.settled(7, 'confirmed', changed);
      expect(ledger.snapshot().entries[0]!.rules[0]).toMatchObject({ uses: 0, uncertain: true });
      expect(ledger.choose([rule], identity, 4000, state, observations, 2000).state).toBe('wait');
    },
  );

  it('detaches party claim identities while keeping loose observed worlds', () => {
    const policy = new PartyEngagements(),
      identity = checkedEngagementIdentity({ world: 'injected world', id: 0, incarnation: 1 });
    const binding = partyActorBinding({
      partyId: 1,
      memberId: 1,
      entityId: 1,
      map: 'prt_fild08',
      world,
      incarnation: 1,
      affiliationRevision: 1,
    });
    policy.observe(identity, binding, false);
    Reflect.set(identity, 'incarnation', 2);
    expect(
      policy.allows(checkedEngagementIdentity({ world: 'injected world', id: 0, incarnation: 1 })),
    ).toBe(true);
    expect(policy.allows(identity)).toBe(false);
  });

  it('rejects mixed or edited identities at actual domain consumers', () => {
    if (false) {
      const { ledger } = strategyFixture(),
        identity = checkedEngagementIdentity(rawIdentity()),
        policy = new PartyEngagements();
      // @ts-expect-error a raw JSON tuple has no engagement admission
      ledger.normalDispatched(rawIdentity());
      // @ts-expect-error edited copies lose the private aggregate admission
      ledger.normalDispatched({ ...identity, id: actorId(2) });
      // @ts-expect-error item IDs cannot identify an engaged actor
      key({ ...identity, id: itemId(2) });
      // @ts-expect-error quantities cannot identify an actor lifetime
      policy.allows({ ...identity, incarnation: quantity(1) });
      // @ts-expect-error readonly domain identities cannot be changed in place
      identity.incarnation = incarnation(2);
      const request = validateManualTargetRequest(rawRequest());
      const uuid: WorldId = request.owner.world;
      void uuid;
      // @ts-expect-error loose observation worlds do not prove UUID syntax
      const looseUuid: WorldId = identity.world;
      void looseUuid;
      // @ts-expect-error ordinary observations do not prove manual request UUID syntax
      manualTargetSettings({ ...request, owner: identity });
      // @ts-expect-error display rows do not have engagement aggregate admission
      ledger.normalDispatched(ledger.snapshot().entries[0]!);
    }
  });
});

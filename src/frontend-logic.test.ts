import { milliseconds } from './domain-values';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { checkedProfile, profileName, importedProfiles, parseProfileDocument, savedProfiles } from './profiles-logic';
import { BUILTIN_SERVICES } from './npc-services';
import { importedServices, parseServiceDocument, savedServices } from './npc-service-store-logic';
import { NpcServiceStore } from './npc-service-store';
import { formDocument, formRevision, nextFormSave } from './current-form-logic';
import { CurrentForm } from './current-form';
import { addMacroExample, encodeMacroSource, macroExample, restoreMacroSource } from './macro-ui-logic';
import { formatBotScript, parseBotScript } from './bot-script';
import { characterSlot, loginPacketStatus, selectionReadiness } from './login-logic';
import { actorSnapshotAt, bindObservedActor, observedActorChoices } from './actor-predicate-ui-logic';
import type { ActorObservationSnapshot } from './actor-observations';
import { featureObservation, featureServiceBlocked, featureActive, featureServiceChoices, featureServiceEvidence, featureAttackStrategiesText, featureRuleConditionsText, featureNpcChoices, featureInventoryText, featureSkillsText } from './feature-ui-logic';
import { consoleInventory, consoleMonsters } from './bot-console-logic';
import type { Snapshot } from './engine';
import { loadMapCatalog } from './map-data';
import { carriedRecoveryItem, recoveryChoices, recoveryInventory, recoveryStockSummary } from './recovery-item-ui-logic';
import { dispositionStockFloors } from './disposition-ui-logic';
import { manualMonsterChoices } from './manual-target-view-logic';
import { memoSlotsText } from './memo-ui-logic';
import { socketSlotsText } from './socket-ui-logic';
import { socialHistoryText } from './social-ui-logic';

const settings = () => ({ ...structuredClone(DEFAULT_SETTINGS), map: 'prt_fild08', targets: [4000] });
const profile = () => checkedProfile({ id: 'original', name: 'Original', character: 'Synthetic', savedAt: 10, settings: settings() });
const actors = (): ActorObservationSnapshot => ({
  world: '00000000-0000-0000-0000-000000000001', at: 100, lastFrameAt: 100, connected: true, selfId: 0, targetId: null,
  actors: [{ id: 0, incarnation: 1, kind: 0, name: 'Synthetic', observedAt: 100, statusesKnown: true, statuses: [],
    cast: { state: 'unknown', observedAt: null, deadline: null, skillId: null } }],
});
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('detached local document proposals', () => {
  it('uses explicit profile identities and timestamps without replacing the imported original', () => {
    const original = profile(), before = structuredClone(original);
    const imported = importedProfiles([], [original], [{ id: 'fresh', savedAt: 500 }]);
    expect(imported[0]).toMatchObject({ id: 'fresh', savedAt: 500 });
    Reflect.set(imported[0]!.settings.targets, '0', 4012);
    expect(original).toEqual(before);
    const next = savedProfiles([original], { ...profile(), name: profileName('Updated') });
    Reflect.set(next[0]!.settings.targets, 'length', 0);
    expect(original).toEqual(before);
    expect(() => importedProfiles([original], [original], [{ id: 'original', savedAt: 500 }])).toThrow('unique');
    expect(() => importedProfiles([], [original], [])).toThrow('unique');
    expect(() => parseProfileDocument(JSON.stringify({ version: 1, profiles: [original, original] }))).toThrow('unique');
  });
  it('rejects colliding service identities and detaches workflow definitions', () => {
    const original = structuredClone(BUILTIN_SERVICES[0]!), before = structuredClone(original);
    const imported = importedServices([], [original], ['fresh']);
    imported[0]!.approach.x++;
    const proposal = savedServices([original], original, original.id, original.id);
    proposal.services[0]!.identity.name = 'Changed';
    expect(original).toEqual(before);
    expect(() => importedServices([original], [original], [original.id])).toThrow('unique');
    expect(() => importedServices([], [original], [])).toThrow('unique');
    expect(() => parseServiceDocument(JSON.stringify({ version: 1, services: [original], password: 'synthetic' }))).toThrow('fields');
  });
  it('validates every source entry before checking document identity collisions', () => {
    const original = profile();
    expect(() => parseProfileDocument(JSON.stringify({ version: 1, profiles: [original, original, { ...original, savedAt: -1 }] })))
      .toThrow('Invalid profile name or metadata.');
    const service = structuredClone(BUILTIN_SERVICES[0]!);
    expect(() => parseServiceDocument(JSON.stringify({ version: 1, services: [service, service, { ...service, name: '' }] })))
      .toThrow('Invalid service text.');
  });
  it('keeps service state unchanged when persistence rejects a validated proposal', () => {
    let fail = false;
    const store = new NpcServiceStore({ getItem: () => null, setItem: () => { if (fail) throw new Error('quota'); } }, () => 'saved');
    const saved = store.save(BUILTIN_SERVICES[0]);
    fail = true;
    expect(() => store.save({ ...saved, name: 'Changed' }, saved.id)).toThrow('quota');
    expect(store.list()).toEqual([saved]);
    expect(() => store.remove(saved.id)).toThrow('quota');
    expect(store.list()).toEqual([saved]);
  });
  it('plans content revisions independently and retries an unconfirmed save through the coordinator', async () => {
    const document = formDocument({ version: 1, revision: 12, selectedProfileId: null, settings: settings() });
    const next = nextFormSave(document, document.revision, null);
    expect(next.revision).toBe(13);
    expect(nextFormSave(document, formRevision(13), next.content).revision).toBe(13);
    Reflect.set(next.document.settings.targets, 'length', 0);
    expect(document.settings.targets).toEqual([4000]);
    let confirm = false;
    const save = vi.fn(async (value) => confirm ? value.revision : value.revision - 1);
    const form = new CurrentForm(() => ({ settings: settings(), selectedProfileId: null }), save);
    await expect(form.flush()).rejects.toThrow('not confirmed');
    confirm = true;
    await expect(form.flush()).resolves.toMatchObject({ revision: 1 });
    expect(save).toHaveBeenCalledTimes(2);
  });
});

describe('pure editor and telemetry projections', () => {
  it.each([
    ['macro', 'state', 'running'], ['macro', 'state', 'waiting'], ['macro', 'state', 'monitoring'],
    ['warp', 'blocked', true], ['refine', 'blocked', true], ['retreat', 'settling', true],
    ['partyHeal', 'state', 'pending'], ['partyHeal', 'state', 'uncertain'], ['partyFollow', 'ownsTravel', true],
    ['manualTarget', 'active', true], ['manualTarget', 'settling', true],
    ['travel', 'state', 'planning'], ['travel', 'state', 'walking'], ['travel', 'state', 'transition'],
    ['socket', 'pending', true], ['memo', 'blocked', true], ['social', 'pending', true],
    ['service', 'active', true], ['workflow', 'running', true],
    ['routine', 'state', 'running'], ['routine', 'state', 'waiting'], ['actionResult', 'status', 'pending'],
  ] as const)('recognizes shared activity for %s.%s = %s', (feature, field, value) => {
    const status = { [feature]: { [field]: value } }, before = structuredClone(status);
    expect([status, {}, status].map(featureActive)).toEqual([true, false, true]);
    expect([status, {}, status].map(featureServiceBlocked)).toEqual([true, false, true]);
    expect(status).toEqual(before);
  });
  it('keeps service blockers distinct from task activity and rejects truthy non-booleans', () => {
    for (const feature of ['supply', 'escape']) {
      const status = { [feature]: { [feature === 'supply' ? 'uncertain' : 'pending']: true } };
      expect(featureServiceBlocked(status)).toBe(true);
      expect(featureActive(status)).toBe(false);
    }
    expect(featureServiceBlocked({ task: { pending: true } })).toBe(false);
    expect(featureActive({ task: { pending: true } })).toBe(true);
    const inactive = { socket: { pending: 1 }, service: { active: 'true' }, warp: { blocked: {} },
      macro: { state: 'completed' }, travel: { state: 'idle' }, routine: { state: null }, actionResult: { status: true } };
    expect(featureActive(inactive)).toBe(false);
    expect(featureServiceBlocked(inactive)).toBe(false);
  });
  it('stops feature evaluation at the first match and preserves blocker ordering', () => {
    const unexpected = () => { throw new Error('later feature was evaluated'); };
    for (const evaluate of [featureActive, featureServiceBlocked]) {
      expect(evaluate({ macro: { state: 'running' }, get warp() { return unexpected(); } })).toBe(true);
      expect(evaluate({ manualTarget: { active: true, get settling() { return unexpected(); } } })).toBe(true);
    }
    expect(featureServiceBlocked({ supply: { uncertain: true }, get social() { return unexpected(); } })).toBe(true);
    expect(featureServiceBlocked({ social: { pending: true }, get escape() { return unexpected(); } })).toBe(true);
    expect(featureActive({ get supply() { return unexpected(); }, get escape() { return unexpected(); }, task: { pending: true } })).toBe(true);
  });
  it('decodes saved macro source and adds collision-free examples without changing the source document', () => {
    const document = { settings: settings(), script: macroExample('item') }, before = structuredClone(document);
    const source = formatBotScript(document);
    expect(restoreMacroSource(encodeMacroSource(source), null, settings())).toBe(source);
    const added = addMacroExample(source, document, 'item');
    expect(parseBotScript(added.text).script?.rules.map(rule => rule.name)).toEqual(['Use a potion', 'Use a potion 2']);
    expect(document).toEqual(before);
    expect(() => restoreMacroSource('{bad', null, settings())).toThrow();
    expect(() => restoreMacroSource(JSON.stringify({ version: 1, source, password: 'synthetic' }), null, settings())).toThrow('format');
  });
  it('refreshes a detached actor snapshot with an explicit clock and binds actor zero', () => {
    const original = actors(), snapshot = actorSnapshotAt(original, 250)!;
    expect(snapshot.at).toBe(250);
    snapshot.actors[0]!.cast.state = 'idle';
    expect(original.actors[0]!.cast.state).toBe('unknown');
    expect(observedActorChoices(original)).toEqual([{ value: '0', label: 'Synthetic · #0' }]);
    expect(bindObservedActor(original, '0')).toEqual({ scope: 'actor', id: 0, incarnation: 1, world: original.world });
    expect(bindObservedActor(original, '999')).toBeUndefined();
    expect(actorSnapshotAt({ ...original, password: 'synthetic' }, 250)).toBeUndefined();
  });
  it('retains unknown resources and projects independent inventories with an explicit observation time', () => {
    const status = { actorObservations: actors(), map: 'prt_fild08', player: { hp: 50, maxHp: 100, level: 3 },
      character: { stats: { sp: 0, maxSp: 200 }, inventoryKnown: true, inventory: [{ itemId: 501, count: 2 }, { itemId: 501, count: 3 }] } };
    const observation = featureObservation(status, 300);
    expect(observation).toMatchObject({ hpPercent: 50, spPercent: 0, level: 3, actors: { at: 300 }, inventory: { 501: 5 } });
    Object.assign(observation.inventory!, { 501: 99 });
    expect(featureObservation(status, 300).inventory![501]).toBe(5);
    expect(featureObservation({ character: { inventoryKnown: false } }, 300).inventory).toBeUndefined();
    expect(featureServiceBlocked({ supply: { uncertain: true } })).toBe(true);
    expect(featureActive({ supply: { uncertain: true } })).toBe(false);
    expect(featureActive({ task: { pending: true } })).toBe(true);
  });
  it('combines console stock and sorts living monsters without mutating telemetry', () => {
    const status = { character: { inventoryKnown: true, inventory: [{ itemId: 501, count: 2 }, { itemId: 501, count: 3 }] }, player: { x: 10, y: 10 },
      monsters: [{ id: 3, name: 'Far', x: 20, y: 20, hp: 1, maxHp: 1, level: 1, dead: false },
        { id: 2, name: 'Near', x: 11, y: 10, hp: 1, maxHp: 1, level: 1, dead: false },
        { id: 4, name: 'Dead', x: 10, y: 10, hp: 0, maxHp: 1, level: 1, dead: true }] } as unknown as Snapshot;
    const before = structuredClone(status);
    expect(consoleInventory(status)).toMatchObject([{ itemId: 501, count: 5 }]);
    const rows = consoleMonsters(status);
    expect(rows.map(row => row.key)).toEqual(['unavailable:2', 'unavailable:3']);
    expect(rows.every(row => !row.attackable)).toBe(true);
    rows[0]!.text = 'Changed';
    expect(status).toEqual(before);
  });
  it('preserves first-observed order when display names and monster distances tie', () => {
    const status = { character: { inventoryKnown: true, inventory: [
      { itemId: 664, count: 2 }, { itemId: 644, count: 1 }, { itemId: 664, count: 3 }, { itemId: 501, count: 0 }] },
      player: { x: 10, y: 10 }, monsters: [
        { id: 9, name: 'First', x: 11, y: 10, hp: 1, maxHp: 1, level: 1, dead: false },
        { id: 2, name: 'Second', x: 10, y: 11, hp: 1, maxHp: 1, level: 1, dead: false }] } as unknown as Snapshot;
    const before = structuredClone(status);
    expect(consoleInventory(status)).toEqual([
      { itemId: 664, count: 5, label: 'Gift Box × 5' }, { itemId: 644, count: 1, label: 'Gift Box × 1' }]);
    expect(consoleMonsters(status).map(row => row.key)).toEqual(['unavailable:9', 'unavailable:2']);
    expect(status).toEqual(before);
  });
  it('merges stock reservations by maximum while preserving first-configured item order', () => {
    const policy = structuredClone(DEFAULT_AUTOMATION);
    const item = { resource: 'hp' as const, belowPercent: 50, cooldownSeconds: 5 };
    policy.items = [{ ...item, itemId: 502, minStock: 2 }, { ...item, itemId: 501, minStock: 3 }, { ...item, itemId: 502, minStock: 4 }];
    policy.hpPotions = { mode: 'selected', itemIds: [501, 503], belowPercent: 50, minStock: 5, cooldownSeconds: 5 };
    const before = structuredClone(policy);
    const floors = dispositionStockFloors(policy);
    expect(floors).toEqual([{ itemId: 502, count: 4 }, { itemId: 501, count: 5 }, { itemId: 503, count: 5 }]);
    floors[0]!.count = 99;
    expect(policy).toEqual(before);
  });
  it('binds service selectors without retaining or modifying preview evidence', () => {
    const services = structuredClone(BUILTIN_SERVICES), before = structuredClone(services);
    const choices = featureServiceChoices(services);
    const buy = choices('buy');
    expect(buy).toContainEqual(['trader.prt-fild05.tool-dealer.buy.v1', 'Prontera Field05 · Open buy shop']);
    expect(choices('storage').every(([id]) => id.includes('storage'))).toBe(true);
    buy[0]![1] = 'Changed';
    expect(services).toEqual(before);
    const status = { character: { inventoryKnown: true, skillsKnown: true, stats: { zeny: 100 },
      inventory: [{ itemId: 501, count: 3 }], learned: [{ skillId: 1, level: 5 }] },
      actors: [{ id: 0, kind: 2, classId: 3, name: 'NPC', x: 1, y: 2, dead: false }, { id: 1, kind: 1 }] };
    const evidence = featureServiceEvidence(status);
    expect(JSON.parse(evidence)).toEqual([true, 100, true, 5, [[501, 3]], [[0, 2, 3, 'NPC', 1, 2, false]]]);
    status.character.inventory[0]!.count = 4;
    expect(featureServiceEvidence(status)).not.toBe(evidence);
  });
  it('projects actor identity choices and exact ordered slot/history text independently', () => {
    const observed = actors();
    observed.actors.push({ ...structuredClone(observed.actors[0]!), id: 7, kind: 1, name: 'Monster' });
    const status = { actorObservations: observed, monsters: [
      { id: 7, name: 'Monster', level: 2, x: 3, y: 4, hp: 1, dead: false },
      { id: 7, name: 'Dead', level: 2, x: 3, y: 4, hp: 0, dead: true },
      { id: 8, name: 'Unobserved', hp: 1 }] };
    const before = structuredClone(status), choices = manualMonsterChoices(status);
    expect(choices).toEqual([{ value: `${observed.world}:7:1`, label: 'Monster #7 · level 2 · 3, 4 · lifetime 1' }]);
    choices[0]!.label = 'Changed';
    expect(status).toEqual(before);
    expect(memoSlotsText([null, { map: 'prontera', x: 10, y: 20 }, null, null]))
      .toBe('Slot 0: Empty\nSlot 1: prontera (10, 20)\nSlot 2: Empty\nSlot 3: Empty');
    expect(socketSlotsText([0, 2147483647, 0, 0])).toBe('empty, Item #2147483647, empty, empty');
    expect(socialHistoryText([{ state: 'echo', name: 'Fixture', kind: 'chat', channel: 2, text: 'Hello' },
      { state: 'observed', name: 'Other', kind: 'emote', text: ':)' }]))
      .toBe('Echo observed · Fixture · Party: Hello\nObserved · Other · Emote: :)');
  });
  it('keeps display caps, diagnostic order and NPC-zero choices without evaluating omitted rows', () => {
    const unexpected = { get id() { throw new Error('Omitted row evaluated'); } };
    const actor = { id: 0, normalStarted: true, rules: [{ id: 'first', attempts: 2, uses: 1, uncertain: true, rejected: true }] };
    const strategies = featureAttackStrategiesText({ entries: [...Array.from({ length: 8 }, () => actor), unexpected], truncated: true });
    expect(strategies.split('Actor #0')).toHaveLength(9);
    expect(strategies).toContain('first · 2 attempts · 1 confirmed · unresolved');
    expect(strategies).not.toContain('rejected');
    expect(strategies).toMatch(/Additional actor ledgers omitted from display\.$/);
    expect(featureRuleConditionsText([{ rule: 'Rule', truncated: true, conditions: [
      { state: 'unavailable', reason: 'Unknown' }, { state: 'matched', reason: 'Fresh' }] }]))
      .toBe('Rule · additional evidence omitted\n  unavailable · Unknown\n  matched · Fresh');
    expect(featureNpcChoices([{ id: 0, kind: 2, name: '' }, { id: 1, kind: 1, name: 'Monster' }, { id: 2, kind: 4, name: 'Trader' }]))
      .toEqual([{ value: '0', label: 'NPC · #0', key: '0:' }, { value: '2', label: 'Trader · #2', key: '2:Trader' }]);
    expect(featureInventoryText([...Array.from({ length: 30 }, () => ({ bagId: 1, itemId: 501, count: 2 })),
      { get itemId() { throw new Error('Omitted inventory row evaluated'); } }]).split('\n')).toHaveLength(30);
    expect(featureSkillsText([{ skillId: 2, level: 1 }])).toBe('First Aid · Lv 1');
  });
  it('makes terminal login states inert and resets selection settlement after readiness loss', () => {
    expect(loginPacketStatus({ phase: 'cancelled', message: '' }, Uint8Array.of(0), characterSlot(0))).toBeNull();
    expect(loginPacketStatus({ phase: 'signingIn', message: '' }, Uint8Array.of(0), characterSlot(0))?.phase).toBe('failed');
    expect(selectionReadiness(true, null, milliseconds(100))).toEqual({ since: 100, settled: false });
    expect(selectionReadiness(true, milliseconds(100), milliseconds(299)).settled).toBe(false);
    expect(selectionReadiness(true, milliseconds(100), milliseconds(300)).settled).toBe(true);
    expect(selectionReadiness(false, milliseconds(100), milliseconds(400))).toEqual({ since: null, settled: false });
  });
});

describe('recovery item observation and preference projections', () => {
  it('keeps saved preference order across zero stock and returns detached display arrays', () => {
    const stock = new Map([[501, 2], [502, 3], [503, 0]]), ids = [502, 501, 503], itemIds = [503, 501];
    const projected = recoveryChoices({ selected: true, ids, itemIds, stock });
    expect(projected).toEqual({ order: [503, 501, 502], visibleOrder: [501, 502] });
    expect(recoveryStockSummary({ ids, itemIds, stock })).toEqual({ carried: true, missing: 1 });
    expect(carriedRecoveryItem(stock)(503)).toBe(false);
    projected.order.reverse(); projected.visibleOrder.length = 0;
    expect(itemIds).toEqual([503, 501]); expect(ids).toEqual([502, 501, 503]);
    stock.set(503, 1);
    expect(recoveryChoices({ selected: true, ids, itemIds, stock }).visibleOrder).toEqual([503, 501, 502]);
    expect(recoveryChoices({ selected: false, ids, itemIds, stock }).order).toEqual(ids);
  });
  it('discards malformed inventory atomically and stops decoding at its first invalid row', () => {
    const inventory = [{ itemId: 502, count: 3 }, { itemId: 501, count: 0 }, { itemId: 501, count: 5 }];
    const before = structuredClone(inventory), stock = recoveryInventory({ inventoryKnown: true, inventory })!;
    expect([...stock]).toEqual([[502, 3], [501, 5]]);
    Reflect.apply(Map.prototype.set, stock, [501, 99]); expect(inventory).toEqual(before);
    const untouched = { get itemId() { throw new Error('Later row evaluated'); } };
    expect(recoveryInventory({ inventoryKnown: true, inventory: [inventory[0], { itemId: 0, count: 1 }, untouched] })).toBeNull();
    expect(recoveryInventory({ inventoryKnown: false, inventory })).toBeNull();
    expect(recoveryInventory({ inventoryKnown: true, inventory: Array.from({ length: 601 }, () => inventory[0]) })).toBeNull();
    expect(recoveryInventory({ inventoryKnown: true, inventory: [] })).toEqual(new Map());
  });
});

describe('map request lifetime effects', () => {
  it('aborts the sibling request and retires the timer when decoding rejects', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      signals.push(init!.signal!);
      if (String(url).endsWith('maps.json')) return new Response('{broken');
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('aborted'))));
    });
    await expect(loadMapCatalog(fetcher)).rejects.toThrow();
    expect(signals).toHaveLength(2);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('shares the deadline across both requests and cleans up after expiration', async () => {
    vi.useFakeTimers();
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>(async (_url, init) => {
      signals.push(init!.signal!);
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new Error('deadline'))));
    });
    const pending = expect(loadMapCatalog(fetcher)).rejects.toThrow('deadline');
    await vi.advanceTimersByTimeAsync(12_000);
    await pending;
    expect(signals[0]).toBe(signals[1]);
    expect(signals.every(signal => signal.aborted)).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });
});

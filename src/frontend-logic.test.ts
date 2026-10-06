import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from './settings';
import { checkedProfile, importedProfiles, parseProfileDocument, savedProfiles } from './profiles-logic';
import { BUILTIN_SERVICES } from './npc-services';
import { importedServices, parseServiceDocument, savedServices } from './npc-service-store-logic';
import { NpcServiceStore } from './npc-service-store';
import { formDocument, nextFormSave } from './current-form-logic';
import { CurrentForm } from './current-form';
import { addMacroExample, encodeMacroSource, macroExample, restoreMacroSource } from './macro-ui-logic';
import { formatBotScript, parseBotScript } from './bot-script';
import { loginPacketStatus, selectionReadiness } from './login-logic';
import { actorSnapshotAt, bindObservedActor, observedActorChoices } from './actor-predicate-ui-logic';
import type { ActorObservationSnapshot } from './actor-observations';
import { featureObservation, featureServiceBlocked, featureActive } from './feature-ui-logic';
import { consoleInventory, consoleMonsters } from './bot-console-logic';
import type { Snapshot } from './engine';
import { loadMapCatalog } from './map-data';

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
    imported[0]!.settings.targets.push(4012);
    expect(original).toEqual(before);
    const next = savedProfiles([original], { ...profile(), name: 'Updated' });
    next[0]!.settings.targets.length = 0;
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
    const next = nextFormSave(document, 12, null);
    expect(next.revision).toBe(13);
    expect(nextFormSave(document, 13, next.content).revision).toBe(13);
    next.document.settings.targets.length = 0;
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
  it('makes terminal login states inert and resets selection settlement after readiness loss', () => {
    expect(loginPacketStatus({ phase: 'cancelled', message: '' }, Uint8Array.of(0), 0)).toBeNull();
    expect(loginPacketStatus({ phase: 'signingIn', message: '' }, Uint8Array.of(0), 0)?.phase).toBe('failed');
    expect(selectionReadiness(true, null, 100)).toEqual({ since: 100, settled: false });
    expect(selectionReadiness(true, 100, 299).settled).toBe(false);
    expect(selectionReadiness(true, 100, 300).settled).toBe(true);
    expect(selectionReadiness(false, 100, 400)).toEqual({ since: null, settled: false });
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

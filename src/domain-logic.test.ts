import { expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS, validateSettings } from './settings';
import { validActorSnapshot } from './actor-observations-logic';
import { validateMacroScript } from './macros-logic';
import { BUILTIN_SERVICES, validateServiceDefinition } from './npc-services-logic';
import { createMapGrid, mapDimensions, publishedGrid } from './navigation-logic';
import { findNavigationRoute, type NavigationSearchView } from './navigation-search-logic';
import { workflowWorldFromSnapshot, workflowWorldSnapshot } from './workflows-logic';
import type { WorldSnapshot } from './world-state-logic';
import { dispositionContextFromStatus } from './disposition-ui-logic';

it('validates detached domain inputs without consulting clocks or randomness', () => {
  const clock = vi.spyOn(Date, 'now').mockImplementation(() => { throw new Error('Unexpected clock effect'); });
  const random = vi.spyOn(Math, 'random').mockImplementation(() => { throw new Error('Unexpected random effect'); });
  const identity = vi.spyOn(crypto, 'randomUUID').mockImplementation(() => { throw new Error('Unexpected identity effect'); });
  try {
    const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild05', targets: [4000] };
    expect(validateSettings(settings)).toEqual(settings);
    expect(validActorSnapshot({ world: '00000000-0000-0000-0000-000000000001', at: 10,
      lastFrameAt: null, connected: false, selfId: null, targetId: null, actors: [] })).toBe(true);
    expect(validateMacroScript({ version: 1, name: 'Pure preview', durationSeconds: 60, maxActions: 1, maxSpend: 0,
      rules: [{ name: 'Farm', priority: 0, cooldownSeconds: 0, maxRuns: 1,
        conditions: [{ field: 'hpPercent', operator: 'gte', value: 50 }],
        steps: [{ type: 'farm', map: 'prt_fild05', targets: [4000], timeoutSeconds: 30 }] }] }).name).toBe('Pure preview');
    expect(validateServiceDefinition(BUILTIN_SERVICES[0])).toEqual(BUILTIN_SERVICES[0]);
  } finally { clock.mockRestore(); random.mockRestore(); identity.mockRestore(); }
});

it('reads published base64 geometry without sharing decoded cache state', () => {
  expect(publishedGrid('unknown')).toBeNull();
  expect(mapDimensions('unknown')).toBeNull();
  for (const map of ['prt_fild05', 'prontera', 'pay_fild04']) {
    const sparse = publishedGrid(map)!, decoded = createMapGrid(map)!;
    expect(mapDimensions(map)).toEqual({ width: decoded.width, height: decoded.height });
    for (let cell = 0; cell < decoded.width * decoded.height; cell += 127) {
      const point = { x: cell % decoded.width, y: Math.floor(cell / decoded.width) };
      expect(sparse.walkable(point)).toBe(decoded.walkable(point));
      expect(sparse.seeThrough!(point)).toBe(decoded.seeThrough!(point));
    }
    for (const point of [{ x: -1, y: 0 }, { x: decoded.width, y: 1 }, { x: 0.5, y: 1 }]) {
      expect(sparse.walkable(point)).toBe(false);
    }
  }
});

it('owns search scratch inside each query and leaves geometry unchanged', () => {
  const width = 12, count = width * width, clearance = new Uint8Array(count).fill(5);
  const view: NavigationSearchView = { count, clearance,
    index: p => p.x + p.y * width, position: cell => ({ x: cell % width, y: Math.floor(cell / width) }),
    step: (a, b) => b.x >= 0 && b.y >= 0 && b.x < width && b.y < width
      && Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y)) === 1,
    clearWalkCorridor: () => true, clearApproach: () => true, canAttack: () => false, canCast: () => false };
  const before = clearance.slice(), from = { x: 1, y: 1 }, to = { x: 9, y: 6 };
  const expected = findNavigationRoute(view, from, to, 0, 20, true, 'walk')!;
  const changed = findNavigationRoute(view, from, to, 0, 20, true, 'walk')!;
  changed[1]!.x = -100;
  expect(findNavigationRoute(view, from, to, 0, 20, true, 'walk')).toEqual(expected);
  expect(clearance).toEqual(before);
  expect(from).toEqual({ x: 1, y: 1 }); expect(to).toEqual({ x: 9, y: 6 });
});

it('detaches workflow world data and preserves its complete snapshot', () => {
  const snapshot: WorldSnapshot = { map: 'prontera', generation: 2, revision: 7,
    npc: { id: null, mode: 'idle', dialog: null, options: [] }, shop: null,
    storage: [{ itemId: 501, bagId: 501, count: 5, type: 1 }], storageReady: true,
    barter: [], cart: [], hasCart: false, cartReady: false,
    party: { id: 1, name: 'Party', members: [{ memberId: 3, entityId: 4, level: 10, name: 'Member', leader: true }] },
    invite: null, vending: null, viewedVending: null };
  const world = workflowWorldFromSnapshot(snapshot), readback = workflowWorldSnapshot(world);
  expect(readback).toEqual(snapshot); expect(world.party!.members.has(3)).toBe(true);
  world.storage.get(501)!.count = 1; world.party!.members.get(3)!.name = 'Changed';
  expect(snapshot.storage[0]!.count).toBe(5); expect(snapshot.party!.members[0]!.name).toBe('Member');
  expect(readback).toEqual(snapshot);
});

it('projects disposition telemetry without leaking input or catalog state', () => {
  const status = { character: { inventoryKnown: true, inventory: [{ bagId: 501, itemId: 501, count: 5, type: 1 }] },
    world: { storageReady: true, storage: [{ bagId: 501, itemId: 501, count: 7, type: 1 }],
      map: 'prontera', generation: 2, revision: 3, npc: { id: 4, mode: 'storage' } } };
  const before = structuredClone(status), expected = dispositionContextFromStatus(status);
  const altered = dispositionContextFromStatus(status);
  altered.workflow.world.storage.get(501)!.count = 0;
  altered.containers.inventory.items![0]!.count = 0;
  const item = Object.values(altered.metadata)[0]!;
  item.weight = 999;
  expect(status).toEqual(before);
  expect(dispositionContextFromStatus(status)).toEqual(expected);
});

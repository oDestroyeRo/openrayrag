import { filter, map, sort } from "remeda";
import { BotEngine } from '../src/engine';
import { BotConsole } from '../src/bot-console';
import { FeatureUi } from '../src/feature-ui';
import { SettingsForm } from '../src/settings-form';
import { validStatus, type GameStatus } from '../src/game-status';
import { currentMapInfo } from '../src/map-data';
import { GridNavigator, searchGrid } from '../src/navigation';
import { calls, emit } from './client-rendering-native';

// Wrappers live entirely in this bundle. Counts include the real main listener,
// validation, UI classes and canvas; fixture construction is outside each sample.
let counters: Record<string, number> = {};
let measuring = false;
let featureInstance: FeatureUi;
let formInstance: SettingsForm;
const overrides: Array<{ prototype: any; name: string; original: any; wrapped: any }> = [];
function wrap(prototype: any, name: string, wrapped: any): void {
  overrides.push({ prototype, name, original: prototype[name], wrapped }); prototype[name] = wrapped;
}
const count = (name: string, amount = 1) => { if (measuring) counters[name] = (counters[name] ?? 0) + amount; };
for (const [prototype, names, label] of [
  [FeatureUi.prototype, ['read', 'render'], 'FeatureUi'],
  [SettingsForm.prototype, ['snapshot', 'runSettings', 'refresh'], 'SettingsForm'],
  [BotConsole.prototype, ['render'], 'BotConsole'],
] as const) for (const name of names) {
  const original = (prototype as any)[name];
  wrap(prototype, name, function (...args: unknown[]) {
    if (label === 'FeatureUi') featureInstance = this;
    if (label === 'SettingsForm') formInstance = this;
    count(`${label}.${name}`); return original.apply(this, args);
  });
}
const createElement = Document.prototype.createElement;
wrap(Document.prototype, 'createElement', function (tag: string, ...args: any[]) {
  count('elementsCreated'); count(`created.${tag.toLowerCase()}`);
  return (createElement as any).call(this, tag, ...args);
});
const formatTime = Date.prototype.toLocaleTimeString;
wrap(Date.prototype, 'toLocaleTimeString', function (...args: any[]) { count('timeFormats'); return (formatTime as any).apply(this, args); });
const canvasDescriptors = new Map<string, PropertyDescriptor>();
for (const dimension of ['width', 'height']) {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLCanvasElement.prototype, dimension)!;
  canvasDescriptors.set(dimension, descriptor);
  Object.defineProperty(HTMLCanvasElement.prototype, dimension, { ...descriptor, set(value) { count(`canvas.${dimension}Writes`); descriptor.set!.call(this, value); } });
}
for (const method of ['clearRect', 'drawImage', 'putImageData', 'stroke', 'fill', 'arc']) {
  const prototype = CanvasRenderingContext2D.prototype as any, original = prototype[method];
  wrap(prototype, method, function (...args: unknown[]) { count(`canvas.${method}`); return original.apply(this, args); });
}
const observer = new MutationObserver(() => {});
observer.observe(document.getElementById('app')!, { subtree: true, childList: true, attributes: true, characterData: true });
function instrumentation(enabled: boolean): void {
  observer.disconnect();
  for (const { prototype, name, original, wrapped } of overrides) prototype[name] = enabled ? wrapped : original;
  for (const [dimension, descriptor] of canvasDescriptors) Object.defineProperty(HTMLCanvasElement.prototype, dimension, enabled
    ? { ...descriptor, set(value) { count(`canvas.${dimension}Writes`); descriptor.set!.call(this, value); } } : descriptor);
  if (enabled) observer.observe(document.getElementById('app')!, { subtree: true, childList: true, attributes: true, characterData: true });
}
function mutations(): void {
  for (const record of observer.takeRecords()) {
    count(`mutations.${record.type}`);
    count('nodesAdded', record.addedNodes.length); count('nodesRemoved', record.removedNodes.length);
    const target = record.target instanceof Element ? record.target : record.target.parentElement;
    if (target?.closest('#log')) count('logMutations');
    if (target?.closest('#console-drops')) count('dropMutations');
  }
}
// Real periodic refreshes remain installed, but deterministic explicit ticks keep
// timer phase/noise out of samples. Their callbacks are measured separately.
const intervals: Array<{ callback: () => void; delay: number }> = [];
window.setInterval = ((callback: () => void, delay: number) => {
  intervals.push({ callback, delay }); return intervals.length;
}) as typeof window.setInterval;

const grid = searchGrid('prt_fild08')!, navigator = new GridNavigator(grid);
let origin = { x: 100, y: 100 };
search: for (let y = 100; y < 200; y++) for (let x = 100; x < 200; x++) {
  if (navigator.safe({ x, y }) && navigator.safe({ x: x + 1, y })) { origin = { x, y }; break search; }
}
const fixedTime = 1_800_000_000_000;
const engine = new BotEngine(() => { throw new Error('Benchmark attempted a game action.'); }, () => fixedTime);
engine.connect(true);
const player = { id: 0, kind: 0, classId: 4, name: 'Offline benchmark', level: 20, hp: 100, maxHp: 100, ...origin, dead: false };
const monsters = Array.from({ length: 24 }, (_, i) => ({ ...player, id: i + 1, kind: 1, classId: 4000, name: 'Poring', level: 1, x: origin.x + i % 6, y: origin.y + Math.floor(i / 6) }));
engine.receive([
  { type: 'enter', id: 0, map: 'prt_fild08' }, { type: 'spawn', entity: player },
  ...map(monsters, entity => ({ type: 'spawn' as const, entity })),
  { type: 'inventory', items: [{ itemId: 501, bagId: 501, count: 3, type: 1 }, { itemId: 610, bagId: 610, count: 2, type: 1 }], equipment: Array(10).fill(0), ammoId: -1 },
]);
const base = {
  ...engine.snapshot(), sessionId: 'offline-benchmark', reconnectAvailable: false,
  login: { phase: 'complete', message: 'Offline synthetic character' },
  mapInfo: currentMapInfo('prt_fild08', monsters, null, false),
  drops: Array.from({ length: 12 }, (_, i) => ({ id: i + 100, itemId: 501, count: 1, x: origin.x + i % 4, y: origin.y + Math.floor(i / 4) })),
  log: Array.from({ length: 50 }, (_, i) => ({ at: fixedTime - i * 1000, text: `Synthetic activity ${i}` })),
} as GameStatus;
base.actorObservations.world = '00000000-0000-0000-0000-000000000001';
if (!validStatus(base)) throw new Error('Invalid benchmark GameStatus.');

function statusAt(kind: string, i: number): GameStatus {
  const status = structuredClone(base);
  if (kind === 'vitals') {
    status.player!.hp = 80 + i % 20; status.attacks = i; status.kills = Math.floor(i / 4); status.looted = Math.floor(i / 3);
  }
  if (kind === 'movement') {
    status.player!.x += i % 2;
    for (const monster of status.monsters) monster.x += i % 3;
    for (const drop of status.drops) drop.y += i % 2;
    status.navigation!.mode = 'search'; status.navigation!.route = Array.from({ length: 8 }, (_, n) => ({ x: origin.x + n, y: origin.y + i % 2 }));
    status.navigation!.leg = status.navigation!.route.slice(0, 4); status.navigation!.goal = status.navigation!.route.at(-1)!; status.navigation!.routeLength = 7;
  }
  if (kind === 'logs') {
    status.log[20]!.text = `Middle entry edit ${i}`;
    status.log[21]!.at += i * 1000;
    status.log.unshift({ at: fixedTime + i * 1000, text: `New activity ${i}` }); status.log.length = 50;
  }
  if (kind === 'reconnect') {
    status.sessionId += `-${i}`; status.actorObservations.world = `00000000-0000-0000-0000-${(i + 2).toString(16).padStart(12, '0')}`;
  }
  return status;
}
const prepared = new Map<string, GameStatus[]>();
function statuses(kind: string, iterations: number): GameStatus[] {
  const key = `${kind}:${iterations}`;
  if (!prepared.has(key)) prepared.set(key, Array.from({ length: iterations }, (_, i) => statusAt(kind, i)));
  return prepared.get(key)!;
}
function deliver(status: GameStatus): void { emit('game-status', status); }
function signature(): object {
  const ids = ['status', 'character', 'location', 'hp-text', 'sp-text', 'attacks', 'kills', 'looted', 'nearby', 'map-label', 'navigation-info', 'console-drops', 'monster-list', 'console-setup-summary'];
  const controls = Array.from(document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement>('input,select,button,textarea'), input => ({ id: input.id, setting: input.dataset.setting ?? '', disabled: input.disabled, hidden: input.hidden, checked: input instanceof HTMLInputElement ? input.checked : null, value: input.value }));
  return { texts: Object.fromEntries(ids.map(id => [id, document.getElementById(id)!.textContent])), log: Array.from(document.querySelectorAll('#log li'), row => row.textContent), controls, bars: ['hp-bar', 'sp-bar'].map(id => document.getElementById(id)!.style.width), canvas: pixelHash() };
}
function pixelHash(): number {
  const canvas = document.getElementById('radar') as HTMLCanvasElement;
  const pixels = canvas.getContext('2d')!.getImageData(0, 0, canvas.width, canvas.height).data;
  let hash = 2166136261;
  for (const byte of pixels) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
  return hash;
}
function assert(condition: unknown, reason: string): void { if (!condition) throw new Error(reason); }

async function initialize(): Promise<void> {
  await import('../src/main');
  for (let i = 0; i < 100 && !calls.includes('update_status'); i++) await Promise.resolve();
  assert(calls.includes('update_status'), 'Main initialization did not settle.');
  deliver(base);
  assert(document.getElementById('character')!.textContent === player.name, 'Actual main status listener was not reached.');
}
await initialize();

const benchmark = {
  ready: true,
  workload: { map: base.map, monsters: 24, drops: 12, logs: 50, dimensions: [grid.width, grid.height], intervalMode: 'explicit real 1000ms callback', synthetic: true },
  prepare(kind: string, iterations: number) { statuses(kind, iterations); },
  begin(instrumented = false) {
    instrumentation(instrumented);
    deliver(base); observer.takeRecords(); counters = {}; measuring = instrumented;
  },
  run(kind: string, iterations: number) {
    const rows = statuses(kind, iterations);
    const started = performance.now();
    for (let i = 0; i < iterations; i++) {
      if (kind === 'reconnect') emit('game-closed');
      if (kind === 'timer') for (const timer of filter(intervals, timer => timer.delay === 1000)) timer.callback();
      else deliver(rows[i]!);
      if (measuring) mutations();
    }
    const elapsedMs = performance.now() - started;
    measuring = false;
    return { elapsedMs, counters };
  },
  outcome: signature,
  probes() {
    const passed: string[] = [];
    deliver(base); const mapBefore = pixelHash();
    const originalTime = document.querySelectorAll('#log li')[21]!.querySelector('time')!.textContent;
    const edit = structuredClone(base); edit.log[20]!.text = '<literal middle-entry edit>'; edit.log[21]!.at += 1000;
    deliver(edit);
    assert(document.querySelectorAll('#log li')[20]!.querySelector('span')!.textContent === '<literal middle-entry edit>', 'Middle log edit was not rendered literally.');
    assert(document.querySelectorAll('#log li')[21]!.querySelector('time')!.textContent !== originalTime, 'Log timestamp edit was not rendered.');
    passed.push('same-length middle log text and timestamp edits; literal text safety');
    const vitals = statusAt('vitals', 3); deliver(vitals);
    assert(document.getElementById('hp-text')!.textContent === '83 / 100' && pixelHash() === mapBefore, 'HP edit changed map or failed to render.');
    passed.push('HP/count edits update telemetry and preserve map pixels');
    const input = document.getElementById('console-walk-x') as HTMLInputElement; input.value = '123';
    const item = document.getElementById('console-item') as HTMLSelectElement; item.value = '501'; item.dispatchEvent(new Event('change', { bubbles: true }));
    const button = document.querySelector<HTMLButtonElement>('#monster-list button')!; button.focus();
    deliver(statusAt('movement', 1));
    assert(pixelHash() !== mapBefore, 'Moving actors, drops and routes did not update the map.');
    assert(button.isConnected && document.activeElement === button && input.value === '123' && item.value === '501', 'Telemetry replaced focus or input drafts.');
    passed.push('actor/drop/route movement redraws; focus, item selection and coordinates survive');
    const radius = document.getElementById('radius') as HTMLInputElement; radius.value = '19'; radius.dispatchEvent(new Event('input', { bubbles: true }));
    assert(document.getElementById('radius-value')!.textContent === '19 cells', 'Settings input edit was not reflected.');
    radius.value = '12'; radius.dispatchEvent(new Event('input', { bubbles: true }));
    const settings = formInstance.snapshot();
    featureInstance.write({ ...settings.settings.automation!, recovery: { ...settings.settings.automation!.recovery, enabled: true } });
    deliver(base); assert(document.getElementById('console-setup-summary')!.textContent!.includes('Recovery on'), 'Programmatic settings write was stale.');
    formInstance.restore({ version: 1, revision: 0, selectedProfileId: null, settings: { ...settings.settings, loot: false } });
    deliver(base); assert(document.getElementById('console-setup-summary')!.textContent!.includes('Pickup off'), 'Settings restore was stale.');
    formInstance.restore({ version: 1, revision: 0, ...settings });
    const distance = document.querySelector<HTMLInputElement>('[data-setting="follow.distance"]')!, originalDistance = distance.value;
    distance.value = '0'; deliver(base);
    assert(document.getElementById('console-setup-summary')!.textContent!.includes('Setup needs attention') && document.getElementById('death-cap')!.textContent === '—', 'Invalid draft was masked by stale settings.');
    distance.value = originalDistance; deliver(base);
    passed.push('settings DOM edits, programmatic writes/restores and invalid drafts use fresh values');
    const unsupported = structuredClone(base); unsupported.map = 'unsupported_fixture'; unsupported.mapInfo = { code: unsupported.map, name: unsupported.map, source: 'observed', monsters: [] }; unsupported.navigation = null;
    deliver(unsupported); assert(document.getElementById('navigation-info')!.textContent!.includes('Collision unavailable'), 'Unsupported map retained old collision.');
    emit('game-closed'); assert(document.getElementById('status')!.textContent === 'OFFLINE' && item.value === '', 'Disconnect retained active state or selection.');
    deliver(statusAt('reconnect', 1)); assert(document.getElementById('status')!.textContent === 'READY' && pixelHash() === mapBefore, 'Reconnect failed to restore map.');
    passed.push('unsupported map clears collision; disconnect/reconnect restores map and clears old selection');
    return { passed, outcome: signature(), nativeCalls: sort([...new Set(calls)], (a, b) => a < b ? -1 : a > b ? 1 : 0) };
  },
};
(window as any).clientRenderingBenchmark = benchmark;

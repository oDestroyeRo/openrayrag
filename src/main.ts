import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { type Snapshot } from './engine';
import { DEFAULT_SETTINGS, DEFAULT_AUTOMATION, MAX_TARGETS, validateSettings, type Settings } from './settings';
import { FeatureUi, validFeatureStatus } from './feature-ui';
import { ReconnectPolicy, PersistentFieldRun } from './reconnect';
import type { EscapeSnapshot } from './escape';
import { type LoginStatus } from './login';
import { validMapInfo, type MapInfo } from './map-data';
import { GridNavigator, NAVIGATION_MAPS, searchGrid } from './navigation';
import { validNavigationStatus } from './navigation-status';
import { MapTargets } from './targets';
import { normalAttackProfile } from './combat';
import { canStartField, settingsWithFieldMap } from './field-controls';
import './style.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
root.innerHTML = `
  <aside class="sidebar">
    <div class="brand"><span class="brand-mark">r<span>∕</span></span><div>rayrag<small>COMPANION</small></div></div>
    <div class="nav-label">YOUR WORKSPACE</div>
    <div class="nav-item"><span>◈</span> Combat & loot <span class="nav-dot"></span></div>
    <div class="sidebar-bottom"><span class="small-dot"></span> SEA 01 <small>macOS · v0.1</small></div>
  </aside>
  <main>
    <header><div><div class="eyebrow">RAY SIDE PROJECT</div><h1>A little help in the field.</h1><p>Combat, recovery and daily routines, with you in control.</p></div><button id="open" class="secondary">Open game <span>↗</span></button></header>
    <div id="notice" class="notice" role="status" aria-live="polite">Open the game, sign in, and select a character to begin.</div>
    <details id="signin-panel" class="signin panel" open>
      <summary>Account & character <span id="saved-account">Session only</span></summary>
      <form id="signin-form" autocomplete="off">
        <div class="signin-fields">
          <label>Username<input id="username" type="text" maxlength="64" autocomplete="off" spellcheck="false" required /></label>
          <label>Password<input id="password" type="password" maxlength="256" autocomplete="off" /></label>
          <label>Character<select id="character-slot"><option value="0">Slot 1</option><option value="1">Slot 2</option><option value="2">Slot 3</option></select></label>
        </div>
        <div class="signin-options">
          <label><input id="remember-login" type="checkbox" /> Save in macOS Keychain</label>
          <label><input id="auto-login" type="checkbox" disabled /> Sign in when app opens</label>
          <label><input id="auto-reconnect" type="checkbox" disabled /> Reconnect after connection loss</label>
          <button id="forget-login" type="button" class="text-button" hidden>Forget saved login</button>
        </div>
        <p id="reconnect-help" class="hint">A running bot reconnects with this session login and resumes when your character is ready.</p>
        <div class="signin-actions"><p id="login-help" class="hint">Select an existing slot. Sign-in enters the field with combat stopped.</p><button id="signin" type="submit" class="primary">Sign in & enter</button></div>
      </form>
    </details>
    <section class="session-card">
      <div class="session-heading"><span class="eyebrow">CURRENT SESSION</span><span id="status" class="pill">OFFLINE</span></div>
      <div class="character"><div class="avatar">✦</div><div><h2 id="character">No character connected</h2><p id="location">Your adventure starts in the game window.</p></div><div class="health"><div><span>HEALTH</span><b id="hp-text">— / —</b></div><div class="health-track"><i id="hp-bar"></i></div></div></div>
      <div class="stats"><div><strong id="attacks">0</strong><span>Targets engaged</span></div><div><strong id="kills">0</strong><span>Monsters defeated</span></div><div><strong id="looted">0</strong><span>Pickups confirmed</span></div><div><strong id="nearby">0</strong><span>Monsters nearby</span></div></div>
    </section>
    <div class="columns">
      <section class="panel settings"><div class="panel-title"><h2>Combat & loot</h2><span>01</span></div>
        <fieldset class="map-targets"><legend>Target monsters</legend>
          <div id="target-map" class="target-map">Enter a map to choose monsters</div>
          <div class="target-tools"><span id="target-count">0 selected</span><div><button id="select-targets" type="button" class="text-button" disabled>Select eligible</button><button id="clear-targets" type="button" class="text-button" disabled>Clear</button></div></div>
          <div id="targets" class="target-options"><p class="target-empty">Map monsters will appear after you enter the field.</p></div>
          <p id="target-source" class="hint">Choose what to attack. Up to one level above you.</p>
        </fieldset>
        <div class="field-row"><label for="radius">Monster scan radius</label><output id="radius-value">12 cells</output></div><input id="radius" type="range" min="1" max="20" value="12" />
        <div class="field-row"><label for="min-hp">Wait below HP</label><output id="hp-value">45%</output></div><input id="min-hp" type="range" min="20" max="95" value="45" />
        <div class="routing-field"><label for="random-walk">Find monsters <code>route_randomWalk</code></label><select id="random-walk"><option value="0">Off · approach visible targets only</option><option value="2">2 · Search the current map</option></select><p class="hint">Search connected walkable ground and avoid portal areas.</p></div>
        <details class="routing-settings"><summary>OpenKore routing settings</summary>
          <div class="routing-grid">
            <label>Steps per walk <code>route_step</code><input id="route-step" type="number" min="1" max="20" value="10" /></label>
            <label>Search route seconds <code>route_randomWalk_maxRouteTime</code><input id="route-time" type="number" min="1" max="600" value="75" /></label>
            <label>Attack path cells <code>attackRouteMaxPathDistance</code><input id="attack-distance" type="number" min="1" max="200" value="20" /></label>
            <label>Approach seconds <code>attackMaxRouteTime</code><input id="attack-time" type="number" min="1" max="60" value="4" /></label>
          </div>
          <label class="toggle-row">Avoid walls <code>route_avoidWalls</code><input id="avoid-walls" type="checkbox" checked /></label>
          <p id="attack-range" class="hint">Normal attack: conservative 1 cell until equipment is verified.</p>
        </details>
        <label class="toggle-row" for="loot"><div>Collect loot<small>Nearby drops from your defeated monsters</small></div><input id="loot" type="checkbox" checked role="switch" /></label>
        <div class="actions"><button id="start" class="primary" disabled>▶ &nbsp; Start bot</button><button id="stop" class="secondary" disabled>■ &nbsp; Stop</button></div>
        <p class="footnote">Click or type in the game to pause briefly. The bot waits through low HP, map changes and connection loss. Stop cancels the run.</p>
      </section>
      <section class="panel activity"><div class="panel-title"><h2>In the field</h2><span id="map-label">WAITING</span></div>
        <div class="radar-wrap"><canvas id="radar" width="400" height="400" aria-label="Map collision: blocked terrain, walkable ground, portal exclusions and planned route"></canvas><div class="radar-label"><span class="legend-dot you"></span>You <span class="legend-dot mob"></span>Monster <span class="legend-dot drop"></span>Loot</div></div>
        <p id="navigation-info" class="navigation-info">Enter a supported map to inspect walkability.</p>
        <div class="map-legend"><span class="terrain-key"></span>Blocked <span class="walkable-key"></span>Walkable <span class="portal-key"></span>Portal exclusion <span class="route-key"></span>Planned route</div>
        <div id="monster-list" class="monster-list">No monsters in sight.</div>
        <div class="activity-title">ACTIVITY <span id="target-label">No active target</span></div><ol id="log" class="log"><li class="empty">Session activity will appear here.</li></ol>
      </section>
    </div>
    <footer><span><i class="small-dot"></i> Session stays on this Mac</span><span>Passwords stay in memory unless you choose macOS Keychain</span></footer>
  </main>`;

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
const openButton = element<HTMLButtonElement>('open');
const startButton = element<HTMLButtonElement>('start');
const stopButton = element<HTMLButtonElement>('stop');
const native = isTauri();
interface SavedLogin { username: string; characterSlot: number; autoLogin: boolean }
type GameStatus = Snapshot & { sessionId: string; login: LoginStatus; mapInfo: MapInfo; runRequested?: boolean; state?: 'running' | 'waiting' | 'idle'; reconnectAvailable: boolean; escape?: EscapeSnapshot; supplyGuard?:import('./supply-trip').SupplyResumeGuard };
let savedLogin: SavedLogin | null = null;
let loginBusy = false;
let loginStartedAt = 0;
let accountReady = !native;
let gameOpen = false;
let latest: GameStatus | null = null;
let receivedAt = 0;
let busy = false;
let heartbeatPending = false;
let previousSession: string | undefined;
const targets = new MapTargets();
const reconnect = new ReconnectPolicy();
const fieldRun = new PersistentFieldRun();
let sessionLoginAvailable = false;
let runGeneration = 0;
let loginGeneration = 0;
let pendingService: Promise<unknown> | null = null;
let pendingResume: Promise<unknown> | null = null;
let pendingLogin: Promise<unknown> | null = null;
let stopping = false;
let limitHeld = false;
let limitStopPending = false;
let pendingLimitStop: Promise<unknown> | null = null;
function runActive(): boolean { return fieldRun.requested || !!latest?.runRequested || !!latest?.running || features.active(); }
function configureReconnect(): void {
  reconnect.configure(fieldRun.requested || element<HTMLInputElement>('auto-reconnect').checked,
    sessionLoginAvailable, fieldRun.requested);
}
function holdAtRunLimit(): void {
  if (!fieldRun.limitReason || limitHeld || limitStopPending || !gameOpen) return;
  const generation = runGeneration;
  limitStopPending = true;
  const pending = [pendingResume, pendingLogin].filter((task): task is Promise<unknown> => task !== null);
  const task = (async () => {
    try {
      await invoke('control_bot', { action: 'stop' });
      if (pending.length) {
        await Promise.allSettled(pending);
        if (generation === runGeneration && fieldRun.limitReason) await invoke('control_bot', { action: 'stop' });
      }
      if (generation === runGeneration) limitHeld = true;
    } catch { /* Retry when the controller returns. */ }
    finally { limitStopPending = false; }
  })();
  pendingLimitStop = task;
  void task.finally(() => { if (pendingLimitStop === task) pendingLimitStop = null; });
}
function resumeFieldRun(s: GameStatus): void {
  if (!native || busy || stopping || loginBusy || pendingResume) return;
  holdAtRunLimit();
  const request = fieldRun.resumeFor(s);
  if (!request) return;
  const generation = runGeneration;
  const task = invoke('control_bot', { action: 'start', settings: request.settings, escapeGuard: request.escapeGuard, supplyGuard:request.supplyGuard });
  pendingResume = task;
  void task.then(() => { fieldRun.completeResume(request, true); })
    .catch(() => {
      if (fieldRun.completeResume(request, false) && generation === runGeneration) message('Waiting to reach the game controller before resuming.');
    }).finally(() => { if (pendingResume === task) pendingResume = null; updateButtons(); });
}
const targetRows = new Map<number, { label: HTMLLabelElement; input: HTMLInputElement; name: HTMLElement; detail: HTMLElement; count: HTMLElement }>();
let targetOrder = '';
const features = new FeatureUi(document.querySelector<HTMLElement>('main')!, {
  settings, apply: applySettings, map: () => targets.map, character: () => latest?.player?.name ?? '',
  command: request => featureRequest('command',request), workflow: request => featureRequest('workflow',request), routine: request => featureRequest('routine',request), service: request => featureRequest('service',request), social: request => featureRequest('social',request), memo: request => featureRequest('memo',request), socketPreview:request=>featureRequest('socketPreview',request),socket:request=>featureRequest('socket',request),
  notify: message, changed: () => { targets.setLevelDifference(features.levelDifference()); renderTargets(); updateButtons(); },
});
const configHelp = document.createElement('p'); configHelp.id = 'config-help'; configHelp.className = 'hint'; document.querySelector('.run-controls')!.append(configHelp);
const monsterCatalog = document.createElement('datalist'); monsterCatalog.id = 'classId-catalog'; document.querySelector('main')!.append(monsterCatalog);

async function featureRequest(action: string, request: unknown): Promise<unknown> {
  if (!native || busy || stopping || loginBusy || !latest?.connected || !latest.compatible || !latest.player || (action==='service'?features.serviceBlocked():runActive()) || Date.now()-receivedAt >= 7000) {
    throw new Error('Stop automation and connect a verified character before sending a manual command.');
  }
  busy=true;updateButtons();
  try {
    if(action==='service') {
      const generation=++runGeneration;fieldRun.stop();reconnect.cancel();limitHeld=false;
      const pending=pendingResume;if(pending)await pending.catch(()=>{});
      if(generation!==runGeneration||stopping)throw new Error('Service request canceled by Stop.');
      const task=invoke('control_bot',{action,request});pendingService=task;
      try{return await task;}finally{if(pendingService===task)pendingService=null;}
    }
    return await invoke('control_bot',{action,request});
  } finally { busy=false;updateButtons(); }
}

function applySettings(value: Settings): void {
  const checked = validateSettings(value);
  if (runActive() || checked.map !== targets.map) throw new Error('Stop automation and enter the profile map before applying it.');
  features.write(checked.automation ?? structuredClone(DEFAULT_AUTOMATION));
  targets.setLevelDifference(features.levelDifference()); targets.clear(); for (const id of checked.targets) targets.select(id,true);
  const inputs: Record<string,number> = {radius:checked.radius,'min-hp':checked.minHpPercent,'route-step':checked.route_step,'route-time':checked.route_randomWalk_maxRouteTime,'attack-distance':checked.attackRouteMaxPathDistance,'attack-time':checked.attackMaxRouteTime};
  for(const [id,value]of Object.entries(inputs))element<HTMLInputElement>(id).value=String(value);
  element<HTMLSelectElement>('random-walk').value=String(checked.route_randomWalk);element<HTMLInputElement>('avoid-walls').checked=checked.route_avoidWalls;element<HTMLInputElement>('loot').checked=checked.loot;
  element('radius-value').textContent=`${checked.radius} cells`;element('hp-value').textContent=`${checked.minHpPercent}%`;renderTargets();updateButtons();
}

function message(text: string, error = false): void {
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
}
function settings(): Settings {
  const automation=features.read();
  return settingsWithFieldMap({
    map: targets.map, targets: targets.ids,
    radius: Number(element<HTMLInputElement>('radius').value),
    minHpPercent: Number(element<HTMLInputElement>('min-hp').value),
    loot: element<HTMLInputElement>('loot').checked,
    route_randomWalk: Number(element<HTMLSelectElement>('random-walk').value) as 0 | 2,
    route_step: Number(element<HTMLInputElement>('route-step').value),
    route_avoidWalls: element<HTMLInputElement>('avoid-walls').checked,
    route_randomWalk_maxRouteTime: Number(element<HTMLInputElement>('route-time').value),
    attackRouteMaxPathDistance: Number(element<HTMLInputElement>('attack-distance').value),
    attackMaxRouteTime: Number(element<HTMLInputElement>('attack-time').value),
    automation,
  });
}
function updateButtons(): void {
  const fresh = Date.now() - receivedAt < 7000;
  const ready = native && fresh && latest?.connected && latest.compatible && latest.player;
  let checked:Settings|null = null;
  try { checked=validateSettings(settings()); configHelp.textContent=''; }
  catch(error) { configHelp.textContent=ready && error instanceof Error ? error.message : ''; }
  startButton.disabled = !canStartField({native,fresh,busy,stopping,loginBusy,runActive:runActive(),connected:latest?.connected===true,compatible:latest?.compatible===true,
    map:latest?.map??'',player:latest?.player??null,settings:checked});
  stopButton.disabled = stopping || !gameOpen && !fieldRun.requested && !loginBusy;
  openButton.disabled = !accountReady || busy || stopping || loginBusy;
  element<HTMLButtonElement>('signin').disabled = !native || !accountReady || busy || stopping || loginBusy || !!(latest?.connected && latest.player);
  element<HTMLButtonElement>('forget-login').disabled = busy || stopping || loginBusy;
  for (const id of ['username', 'password', 'character-slot', 'remember-login']) {
    element<HTMLInputElement>(id).disabled = !accountReady || busy || stopping || loginBusy;
  }
  element<HTMLInputElement>('auto-login').disabled = busy || stopping || loginBusy || !element<HTMLInputElement>('remember-login').checked;
  element<HTMLInputElement>('auto-reconnect').disabled = busy || stopping || loginBusy || !sessionLoginAvailable;
  for (const id of ['radius', 'min-hp', 'loot', 'random-walk', 'route-step', 'route-time', 'attack-distance', 'attack-time', 'avoid-walls']) {
    element<HTMLInputElement>(id).disabled = busy || stopping || loginBusy || runActive();
  }
  const locked = busy || stopping || loginBusy || !ready || runActive();
  element<HTMLButtonElement>('select-targets').disabled = locked || !targets.options.some(m => targets.eligible(m.classId));
  element<HTMLButtonElement>('clear-targets').disabled = locked || !targets.options.some(m => targets.checked(m.classId));
  for (const [id, row] of targetRows) row.input.disabled = locked || !targets.eligible(id) || (!targets.checked(id) && targets.ids.length >= MAX_TARGETS);
  features.lock(busy || stopping || loginBusy || runActive(),busy || stopping || loginBusy || !ready || runActive(),busy || stopping || loginBusy || !ready || features.serviceBlocked());
}

function renderTargets(): void {
  const options = targets.options;
  const container = element('targets');
  const order = options.map(monster => monster.classId).join(',');
  const currentIds = new Set(options.map(monster => monster.classId));
  for (const id of targetRows.keys()) if (!currentIds.has(id)) targetRows.delete(id);
  for (const monster of options) {
    let row = targetRows.get(monster.classId);
    if (!row) {
      const label = document.createElement('label'); label.className = 'target-option';
      const input = document.createElement('input'); input.type = 'checkbox';
      const description = document.createElement('span'); description.className = 'target-description';
      const name = document.createElement('strong'); const detail = document.createElement('small');
      const count = document.createElement('span'); count.className = 'target-visible';
      description.append(name, detail); label.append(input, description, count);
      input.addEventListener('change', () => {
        targets.select(monster.classId, input.checked); renderTargets(); updateButtons();
      });
      row = { label, input, name, detail, count }; targetRows.set(monster.classId, row);
    }
    row.input.checked = targets.checked(monster.classId);
    row.input.setAttribute('aria-label', `Attack ${monster.name}`);
    row.name.textContent = monster.name;
    row.name.title = `Monster class ID ${monster.classId}`;
    const population = monster.spawnCount === null ? 'Seen on this map' : `${monster.spawnCount} map spawns`;
    const levelLimit = latest?.player && !targets.eligible(monster.classId) ? ' · Above level limit' : '';
    row.detail.textContent = `Lv ${monster.level} · #${monster.classId} · HP ${monster.maxHp} · ${population}${levelLimit}`;
    row.count.textContent = `${monster.visibleCount} in view`;
    row.count.classList.toggle('present', monster.visibleCount > 0);
    row.label.classList.toggle('selected', row.input.checked);
  }
  // Keep focused checkboxes intact through the half-second telemetry refresh.
  if (order !== targetOrder || !options.length) {
    targetOrder = order;
    if (options.length) container.replaceChildren(...options.map(monster => targetRows.get(monster.classId)!.label));
    else {
      const empty = document.createElement('p'); empty.className = 'target-empty';
      empty.textContent = targets.map ? 'No monsters listed yet. Monsters seen in the game will appear here.' : 'Map monsters will appear after you enter the field.';
      container.replaceChildren(empty);
    }
  }
  element('target-count').textContent = `${targets.ids.length} selected`;
  if (monsterCatalog.dataset.order !== order) { monsterCatalog.dataset.order=order;monsterCatalog.replaceChildren(...options.map(monster=>{const option=document.createElement('option');option.value=String(monster.classId);option.label=monster.name;return option;})); }
  const info = latest?.mapInfo;
  element('target-map').textContent = info?.code ? `${info.name} · ${info.code}` : 'Enter a map to choose monsters';
  element('target-source').textContent = info?.source === 'database'
    ? `Game map database · Map spawns are configured counts; in view is live. Level limit: yours ${features.levelDifference()>=0?'+':''}${features.levelDifference()}.`
    : info?.source === 'loading' ? 'Loading map database… Monsters already in view can be selected.'
    : `Using monsters seen on this map; the map database is unavailable here. Level limit: yours ${features.levelDifference()>=0?'+':''}${features.levelDifference()}.`;
}
element('select-targets').addEventListener('click', () => { targets.selectEligible(); renderTargets(); updateButtons(); });
element('clear-targets').addEventListener('click', () => { targets.clear(); renderTargets(); updateButtons(); });

function showSavedLogin(profile: SavedLogin | null): void {
  savedLogin = profile;
  element('saved-account').textContent = profile ? `Saved: ${profile.username}` : 'Session only';
  element<HTMLButtonElement>('forget-login').hidden = !profile;
  element<HTMLInputElement>('password').placeholder = profile ? 'Leave blank to use saved password' : '';
  if (!profile && !sessionLoginAvailable) element<HTMLInputElement>('auto-reconnect').checked = false;
  configureReconnect();
}

async function signIn(): Promise<void> {
  if (!native || !accountReady || busy || stopping || loginBusy || latest?.connected && latest.player) return;
  reconnect.signIn();
  const generation = ++loginGeneration;
  const username = element<HTMLInputElement>('username').value.trim();
  const password = element<HTMLInputElement>('password');
  const characterSlot = Number(element<HTMLSelectElement>('character-slot').value);
  const remember = element<HTMLInputElement>('remember-login').checked;
  const autoLogin = element<HTMLInputElement>('auto-login').checked;
  const reuse = savedLogin?.username === username && !password.value;
  previousSession = latest?.sessionId;
  loginBusy = true; loginStartedAt = Date.now(); updateButtons();
  try {
    const task = invoke('login_game', { request: {
      credentials: reuse ? null : { username, password: password.value, characterSlot },
      characterSlot, remember, autoLogin,
    } });
    pendingLogin = task;
    await task;
    if (generation !== loginGeneration) return;
    gameOpen = true;
    if (remember) showSavedLogin({ username, characterSlot, autoLogin });
    message('Loading the game for automatic sign-in…');
  } catch (error) {
    if (generation !== loginGeneration) return;
    previousSession = undefined;
    loginBusy = false;
    message(typeof error === 'string' ? error : 'Could not start automatic sign-in.', true);
  } finally {
    if (generation === loginGeneration) pendingLogin = null;
    password.value = '';
    updateButtons();
  }
}

element<HTMLFormElement>('signin-form').addEventListener('submit', event => {
  event.preventDefault();
  if (native && !busy && !loginBusy && !(latest?.connected && latest.player)) void signIn();
});
element<HTMLInputElement>('remember-login').addEventListener('change', () => {
  if (!element<HTMLInputElement>('remember-login').checked) element<HTMLInputElement>('auto-login').checked = false;
  updateButtons();
});
element<HTMLInputElement>('auto-reconnect').addEventListener('change',()=>{configureReconnect();updateButtons();});
element('forget-login').addEventListener('click', () => void perform(async () => {
  await invoke('forget_login');
  showSavedLogin(null);
  element<HTMLInputElement>('remember-login').checked = false;
  element<HTMLInputElement>('auto-login').checked = false;
  message('Saved login removed from macOS Keychain.');
}));

async function perform(action: () => Promise<unknown>): Promise<void> {
  if (busy) return;
  busy = true; updateButtons();
  try { await action(); } catch (error) { message(typeof error === 'string' ? error : 'Unable to contact the game.', true); }
  finally { busy = false; updateButtons(); }
}
openButton.addEventListener('click', () => void perform(async () => {
  if (!native) { message('Run npm run app:dev to open the native game window. Browser preview cannot control a game.'); return; }
  await invoke('open_game'); gameOpen = true;
  message('Loading the game. Sign in there, then return here to start.');
}));
startButton.addEventListener('click', () => void perform(async () => {
  if (!latest?.player || stopping) return;
  const checked = validateSettings(settings()), generation = ++runGeneration;
  fieldRun.begin(checked, latest.player.name, latest.sessionId, { kills: latest.kills, looted: latest.looted, deaths: latest.deaths, attacks: latest.attacks });
  limitHeld = false; configureReconnect();
  reconnect.observe(latest.connected, true, latest.login.phase, Date.now(), latest.login.message);
  const supplyGuard=fieldRun.supplyGuardForStart(checked,latest.player.name,latest.sessionId);
  const supplyCharacter=latest.player.name,supplySession=latest.sessionId;
  const task = invoke('control_bot', { action: 'start', settings: checked,
    escapeGuard: fieldRun.guardForStart(checked, latest?.player?.name ?? '', latest?.sessionId ?? ''),
    supplyGuard });
  pendingResume = task;
  try { await task;if(generation===runGeneration)fieldRun.completeSupplyStart(supplyCharacter,supplySession,supplyGuard); }
  catch (error) { if (generation === runGeneration) { fieldRun.stop(); configureReconnect(); } throw error; }
  finally { if (pendingResume === task) pendingResume = null; }
}));
stopButton.addEventListener('click', () => {
  if (stopping) return;
  const generation = ++runGeneration; ++loginGeneration;
  fieldRun.stop(); reconnect.cancel(); limitHeld = false; loginBusy = false; previousSession = undefined;
  const pending = [pendingResume, pendingLogin, pendingLimitStop, pendingService].filter((task): task is Promise<unknown> => task !== null);
  stopping = true; updateButtons();
  void (async () => {
    try {
      await invoke('control_bot', { action: 'stop' });
      // A request already crossing the native boundary may finish after Stop.
      // Cancel its one-shot login / Start again before unlocking the controls.
      if (pending.length) {
        await Promise.allSettled(pending);
        if (generation === runGeneration) await invoke('control_bot', { action: 'stop' });
      }
      message('Bot stopped.');
    } catch { message('Run cancelled. The game controller is unavailable.'); }
    finally { stopping = false; pendingLogin = null; pendingResume = null; updateButtons(); }
  })();
});
for (const [id, output, suffix] of [['radius','radius-value',' cells'],['min-hp','hp-value','%']] as const) {
  element<HTMLInputElement>(id).addEventListener('input', () => { element(output).textContent = element<HTMLInputElement>(id).value + suffix; updateButtons(); });
}

function validStatus(value: unknown): value is GameStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.reconnectAvailable !== 'boolean') return false;
  if (typeof s.sessionId !== 'string' || !s.sessionId || s.sessionId.length > 64) return false;
  const login = s.login as Partial<LoginStatus> | undefined;
  if (!login || typeof login.message !== 'string' || login.message.length > 1024
    || !['idle','signingIn','selecting','entering','complete','failed','cancelled'].includes(login.phase ?? '')) return false;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const entity = (v: unknown) => {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return Number.isInteger(e.id)&&Number(e.id)>=0&&Number(e.id)<=0x7fffffff&&['id','classId','kind','level','hp','maxHp','x','y'].every(k => finite(e[k])) && typeof e.name === 'string' && e.name.length <= 512;
  };
  if (!validNavigationStatus(s.navigation)) return false;
  if ((s.runRequested !== undefined && typeof s.runRequested !== 'boolean') || (s.state !== undefined && !['running','waiting','idle'].includes(s.state as string))) return false;
  return ['connected','compatible','running'].every(k => typeof s[k] === 'boolean')
    && ['reason','map','target'].every(k => typeof s[k] === 'string' && (s[k] as string).length <= 1024)
    && validMapInfo(s.mapInfo, s.map as string)
    && ['attacks','kills','looted'].every(k => finite(s[k]))
    && (s.player === null || entity(s.player) && (s.player as Record<string,unknown>).kind===0)
    && Array.isArray(s.monsters) && s.monsters.length <= 150 && s.monsters.every(entity)
    && Array.isArray(s.drops) && s.drops.length <= 150 && s.drops.every(v => v && ['id','x','y'].every(k => finite(v[k])))
    && Array.isArray(s.log) && s.log.length <= 50 && s.log.every(v => v && finite(v.at) && typeof v.text === 'string' && v.text.length < 1024)
    && validFeatureStatus(s);
}

function render(s: GameStatus): void {
  // Navigation is asynchronous: the previous page may still publish its terminal
  // login status while the next official client is loading.
  if (s.sessionId === previousSession) return;
  const justSignedIn = s.login.phase === 'complete' && latest?.login.phase !== 'complete';
  latest = s; receivedAt = Date.now(); gameOpen = true;
  if (sessionLoginAvailable !== s.reconnectAvailable) { sessionLoginAvailable = s.reconnectAvailable; configureReconnect(); }
  reconnect.observe(s.connected, !!s.player, s.login.phase, Date.now(), s.login.message);
  fieldRun.observe(s); holdAtRunLimit();
  targets.setLevelDifference(features.levelDifference());
  targets.update(s.sessionId, s.mapInfo, s.player?.level ?? null);
  if (fieldRun.requested) for (const id of fieldRun.targetIds) targets.select(id, true);
  renderTargets();
  if (['complete','failed','cancelled'].includes(s.login.phase)) loginBusy = false;
  if (justSignedIn) element<HTMLDetailsElement>('signin-panel').open = false;
  element('login-help').textContent = s.login.message || 'Select an existing slot. Sign-in enters the field with combat stopped.';
  const state = s.running && !fieldRun.limitReason ? 'RUNNING' : fieldRun.requested || s.runRequested ? 'WAITING' : s.player && s.compatible ? 'READY' : s.connected ? 'CONNECTED' : 'OFFLINE';
  element('status').textContent = state;
  element('status').classList.toggle('active', s.running);
  element('character').textContent = s.player?.name ?? 'No character connected';
  element('location').textContent = s.player ? `Level ${s.player.level} · ${s.map} · ${s.player.x}, ${s.player.y}` : 'Your adventure starts in the game window.';
  const attack = normalAttackProfile(s.character);
  const rawRange = attack.sourceRange !== null && attack.sourceRange !== attack.range ? ` · source range ${attack.sourceRange}` : '';
  element('attack-range').textContent = `Normal attack: ${attack.range} cells · ${attack.source}${rawRange}. ${attack.limitation} Projectile sight is checked; skill range and kiting are separate.`;
  element('hp-text').textContent = s.player ? `${s.player.hp} / ${s.player.maxHp}` : '— / —';
  element('hp-bar').style.width = `${s.player?.maxHp ? Math.max(0, Math.min(100, s.player.hp / s.player.maxHp * 100)) : 0}%`;
  for (const key of ['attacks','kills','looted'] as const) element(key).textContent = String(fieldRun.requested ? fieldRun.metrics[key] : s[key]);
  element('nearby').textContent = String(s.monsters.length);
  element('map-label').textContent = s.map || 'WAITING';
  element('target-label').textContent = s.target || 'No active target';
  const nearby = s.monsters.map(e => ({ name: e.name, level: e.level,
    distance: s.player ? Math.max(Math.abs(e.x-s.player.x), Math.abs(e.y-s.player.y)) : 0 }))
    .sort((a,b) => a.distance-b.distance).slice(0,3);
  element('monster-list').textContent = nearby.length ? nearby.map(e => `${e.name} · Lv ${e.level} · ${Math.ceil(e.distance)} cells`).join('  /  ') : 'No monsters in sight.';
  const loginMessage = s.login.phase === 'failed' || s.login.phase === 'cancelled' || loginBusy;
  message(fieldRun.limitReason || (loginMessage ? s.login.message || 'Loading the game for automatic sign-in…' : s.reason),
    s.login.phase === 'failed' || s.connected && !s.compatible);
  const list = element('log'); list.replaceChildren();
  for (const entry of s.log.slice(0,6)) {
    const li = document.createElement('li'); const time = document.createElement('time'); const text = document.createElement('span');
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    text.textContent = entry.text; li.append(time, text); list.append(li);
  }
  features.render(s);drawRadar(s); updateButtons(); resumeFieldRun(s);
}
let rasterMap = '';
let raster: HTMLCanvasElement | null = null;
function drawRadar(s: Snapshot | null): void {
  const canvas = element<HTMLCanvasElement>('radar'); const ctx = canvas.getContext('2d')!;
  const map = s?.map ?? '';
  if (rasterMap !== map) {
    rasterMap = map; raster = null;
    const grid = searchGrid(map);
    if (grid) {
      const nav = new GridNavigator(grid);
      raster = document.createElement('canvas'); raster.width = grid.width; raster.height = grid.height;
      const image = raster.getContext('2d')!.createImageData(grid.width, grid.height);
      for (let y = 0; y < grid.height; y++) for (let x = 0; x < grid.width; x++) {
        const state = nav.tileState({ x, y });
        const color = state === 'blocked' ? [16,22,26] : state === 'portal' ? [121,79,48] : [62,86,72];
        const i = (x + (grid.height - 1 - y) * grid.width) * 4;
        image.data.set([...color, 255], i);
      }
      raster.getContext('2d')!.putImageData(image, 0, 0);
    }
  }
  canvas.width = raster?.width ?? 400; canvas.height = raster?.height ?? 400;
  canvas.style.aspectRatio = `${canvas.width} / ${canvas.height}`;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  const n = s?.navigation;
  element('navigation-info').textContent = n
    ? `${n.width} × ${n.height} · ${n.blocked.toLocaleString()} blocked · ${n.walkable.toLocaleString()} walkable · ${n.excluded.toLocaleString()} portal exclusions · ${n.reachable.toLocaleString()} reachable${n.routeLength ? ` · ${n.routeLength} route cells` : ''}${n.ready ? '' : ' · Move away from blocked ground and portals'}`
    : map ? `Walkability is not verified for ${map}. Start is disabled. ${NAVIGATION_MAPS.length} maps are supported.`
      : 'Enter a supported map to inspect walkability.';
  if (!raster) {
    ctx.font = '13px system-ui'; ctx.textAlign = 'center'; ctx.fillStyle = '#889b92';
    ctx.fillText('Waiting for verified map collision', canvas.width / 2, canvas.height / 2); return;
  }
  ctx.imageSmoothingEnabled = false; ctx.drawImage(raster, 0, 0);
  const routeLine = (cells: Array<{x:number;y:number}>, color: string, width: number) => {
    ctx.strokeStyle = color; ctx.lineWidth = width; ctx.beginPath();
    cells.forEach((p, i) => { if (i) ctx.lineTo(p.x + .5, canvas.height - .5 - p.y); else ctx.moveTo(p.x + .5, canvas.height - .5 - p.y); }); ctx.stroke();
  };
  routeLine(n?.route ?? [], '#80bde3', 1.6); routeLine(n?.leg ?? [], '#d7e9b0', 2.2);
  const dot = (p: {x:number;y:number}, color: string, radius: number) => {
    ctx.fillStyle = color; ctx.strokeStyle = '#10161a'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.arc(p.x + .5, canvas.height - .5 - p.y, radius, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  };
  for (const monster of s?.monsters ?? []) dot(monster, '#e2ae79', 2.5);
  for (const drop of s?.drops ?? []) dot(drop, '#b9a7ee', 2);
  if (n?.goal) dot(n.goal, '#80bde3', 3.5);
  if (s?.player) dot(s.player, '#c3f5cf', 4);
}
drawRadar(null);
if (!native) message('Browser preview · Launch the macOS app with npm run app:dev to connect.');
if (native) {
  void (async () => {
  await listen<unknown>('game-status', event => { if (validStatus(event.payload)) render(event.payload); });
  await listen('game-closed', () => {
    features.clearSocial();
    features.clearMemo();
    ++runGeneration; ++loginGeneration; fieldRun.stop(); reconnect.cancel();
    sessionLoginAvailable = false; pendingResume = null; pendingLogin = null; limitHeld = false; previousSession = undefined;
    gameOpen = false; latest = null; receivedAt = 0; loginBusy = false;
    targets.update('', { code: '', name: '', source: 'observed', monsters: [] }, null); renderTargets();
    element('status').textContent = 'OFFLINE'; element('status').classList.remove('active');
    message('Game window closed. Open it again to reconnect.'); updateButtons(); drawRadar(null);
  });
  try {
    const profile = await invoke<SavedLogin | null>('saved_login');
    accountReady = true;
    showSavedLogin(profile);
    if (profile) {
      element<HTMLInputElement>('username').value = profile.username;
      element<HTMLSelectElement>('character-slot').value = String(profile.characterSlot);
      element<HTMLInputElement>('remember-login').checked = true;
      element<HTMLInputElement>('auto-login').checked = profile.autoLogin;
      if (profile.autoLogin) await signIn();
    }
  } catch { message('Saved login could not be read from Keychain. You can enter your account manually.', true); }
  finally { accountReady = true; }
  updateButtons();
  })();
  setInterval(() => {
    holdAtRunLimit();
    if (loginBusy && Date.now() - loginStartedAt > 120_000) {
      loginBusy = false; previousSession = undefined; reconnect.networkFailure(Date.now());
      message('Sign-in is taking too long. Waiting before reconnecting again.', true);
    }
    updateButtons();
    const retry = gameOpen && !busy && !stopping && !loginBusy && !(latest?.connected && latest.player)
      && !fieldRun.limitReason ? reconnect.takeDue(Date.now()) : null;
    if (retry !== null) {
      const generation = ++loginGeneration;
      loginBusy = true; loginStartedAt = Date.now(); previousSession = latest?.sessionId; updateButtons();
      message(`Reconnecting · attempt ${retry}. ${fieldRun.requested ? 'The bot will resume when your character is ready.' : 'Combat remains stopped.'}`);
      const task = invoke('reconnect_game'); pendingLogin = task;
      void task.then(() => { if (generation === loginGeneration) gameOpen = true; })
        .catch(error => {
          if (generation !== loginGeneration) return;
          previousSession = undefined; loginBusy = false;
          if (typeof error === 'string' && /(?:sign in|account|keychain)/i.test(error)) reconnect.observe(false, false, 'failed', Date.now(), 'Explicit sign-in required.');
          else reconnect.networkFailure(Date.now());
          message(reconnect.requiresSignIn ? 'Waiting for you to sign in again before resuming.' : 'Reconnect could not open the game. Waiting before trying again.', true); updateButtons();
        }).finally(() => { if (pendingLogin === task) pendingLogin = null; });
    }
    element('reconnect-help').textContent = fieldRun.limitReason || (reconnect.requiresSignIn
      ? 'Sign in again to resume the requested run.'
      : reconnect.waitingUntil !== null ? `Connection lost. Reconnect in ${Math.max(0,Math.ceil((reconnect.waitingUntil-Date.now())/1000))} seconds.`
      : fieldRun.requested && !sessionLoginAvailable ? 'Waiting for connection recovery. Sign in through Companion to enable session reconnect.'
      : 'A running bot reconnects with this session login and resumes when your character is ready.');
    if (!fieldRun.limitReason && latest?.connected && Date.now() - receivedAt > 7000) message('Waiting for fresh game status. The run will resume when the controller responds.', true);
    if (!gameOpen || heartbeatPending) return;
    if (receivedAt > 0 && Date.now() - receivedAt > 7000) return;
    heartbeatPending = true;
    void invoke('control_bot', { action: 'heartbeat' }).catch(() => { updateButtons(); })
      .finally(() => { heartbeatPending = false; });
  }, 1000);
}
// Credentials are never persisted by the frontend.
element<HTMLInputElement>('radius').value = String(DEFAULT_SETTINGS.radius);
updateButtons();

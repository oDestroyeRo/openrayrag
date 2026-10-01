import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { DEFAULT_SETTINGS, MAX_TARGETS, type Settings, type Snapshot } from './engine';
import { type LoginStatus } from './login';
import { validMapInfo, type MapInfo } from './map-data';
import { GridNavigator, MAX_MAP_DIMENSION, NAVIGATION_MAPS, searchGrid } from './navigation';
import { MapTargets } from './targets';
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
    <header><div><div class="eyebrow">RAY SIDE PROJECT</div><h1>A little help in the field.</h1><p>Basic combat and looting, with you in control.</p></div><button id="open" class="secondary">Open game <span>↗</span></button></header>
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
          <button id="forget-login" type="button" class="text-button" hidden>Forget saved login</button>
        </div>
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
        <div class="field-row"><label for="min-hp">Stop below HP</label><output id="hp-value">45%</output></div><input id="min-hp" type="range" min="20" max="95" value="45" />
        <div class="routing-field"><label for="random-walk">Find monsters <code>route_randomWalk</code></label><select id="random-walk"><option value="0">Off · approach visible targets only</option><option value="2">2 · Search the current map</option></select><p class="hint">Search connected walkable ground and avoid portal areas.</p></div>
        <details class="routing-settings"><summary>OpenKore routing settings</summary>
          <div class="routing-grid">
            <label>Steps per walk <code>route_step</code><input id="route-step" type="number" min="1" max="20" value="10" /></label>
            <label>Search route seconds <code>route_randomWalk_maxRouteTime</code><input id="route-time" type="number" min="1" max="600" value="75" /></label>
            <label>Attack path cells <code>attackRouteMaxPathDistance</code><input id="attack-distance" type="number" min="1" max="200" value="20" /></label>
            <label>Approach seconds <code>attackMaxRouteTime</code><input id="attack-time" type="number" min="1" max="60" value="4" /></label>
          </div>
          <label class="toggle-row">Avoid walls <code>route_avoidWalls</code><input id="avoid-walls" type="checkbox" checked /></label>
          <p class="hint">Melee approach: 1 cell. Current map only; map changes stop the bot.</p>
        </details>
        <label class="toggle-row" for="loot"><div>Collect loot<small>Nearby drops from your defeated monsters</small></div><input id="loot" type="checkbox" checked role="switch" /></label>
        <div class="actions"><button id="start" class="primary" disabled>▶ &nbsp; Start bot</button><button id="stop" class="secondary" disabled>■ &nbsp; Stop</button></div>
        <p class="footnote">Click or type in the game to pause. Map changes and low HP require a manual restart.</p>
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
type GameStatus = Snapshot & { sessionId: string; login: LoginStatus; mapInfo: MapInfo };
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
const targetRows = new Map<number, { label: HTMLLabelElement; input: HTMLInputElement; name: HTMLElement; detail: HTMLElement; count: HTMLElement }>();
let targetOrder = '';

function message(text: string, error = false): void {
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
}
function settings(): Settings {
  return {
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
  };
}
function updateButtons(): void {
  const fresh = Date.now() - receivedAt < 7000;
  const ready = native && fresh && latest?.connected && latest.compatible && latest.player;
  startButton.disabled = busy || loginBusy || !ready || !!latest?.running || !targets.ids.length || !latest?.navigation?.ready;
  stopButton.disabled = busy || !gameOpen;
  openButton.disabled = !accountReady || busy || loginBusy;
  element<HTMLButtonElement>('signin').disabled = !native || !accountReady || busy || loginBusy || !!latest?.player;
  element<HTMLButtonElement>('forget-login').disabled = busy || loginBusy;
  for (const id of ['username', 'password', 'character-slot', 'remember-login']) {
    element<HTMLInputElement>(id).disabled = !accountReady || busy || loginBusy;
  }
  element<HTMLInputElement>('auto-login').disabled = busy || loginBusy || !element<HTMLInputElement>('remember-login').checked;
  for (const id of ['radius', 'min-hp', 'loot', 'random-walk', 'route-step', 'route-time', 'attack-distance', 'attack-time', 'avoid-walls']) {
    element<HTMLInputElement>(id).disabled = busy || loginBusy || !!latest?.running;
  }
  const locked = busy || loginBusy || !ready || !!latest?.running;
  element<HTMLButtonElement>('select-targets').disabled = locked || !targets.options.some(m => targets.eligible(m.classId));
  element<HTMLButtonElement>('clear-targets').disabled = locked || !targets.options.some(m => targets.checked(m.classId));
  for (const [id, row] of targetRows) row.input.disabled = locked || !targets.eligible(id) || (!targets.checked(id) && targets.ids.length >= MAX_TARGETS);
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
    const population = monster.spawnCount === null ? 'Seen on this map' : `${monster.spawnCount} map spawns`;
    const levelLimit = latest?.player && !targets.eligible(monster.classId) ? ' · Above level limit' : '';
    row.detail.textContent = `Lv ${monster.level} · HP ${monster.maxHp} · ${population}${levelLimit}`;
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
  const info = latest?.mapInfo;
  element('target-map').textContent = info?.code ? `${info.name} · ${info.code}` : 'Enter a map to choose monsters';
  element('target-source').textContent = info?.source === 'database'
    ? 'Game map database · Map spawns are configured counts; in view is live. Level limit: yours + 1.'
    : info?.source === 'loading' ? 'Loading map database… Monsters already in view can be selected.'
    : 'Using monsters seen on this map; the map database is unavailable here. Level limit: yours + 1.';
}
element('select-targets').addEventListener('click', () => { targets.selectEligible(); renderTargets(); updateButtons(); });
element('clear-targets').addEventListener('click', () => { targets.clear(); renderTargets(); updateButtons(); });

function showSavedLogin(profile: SavedLogin | null): void {
  savedLogin = profile;
  element('saved-account').textContent = profile ? `Saved: ${profile.username}` : 'Session only';
  element<HTMLButtonElement>('forget-login').hidden = !profile;
  element<HTMLInputElement>('password').placeholder = profile ? 'Leave blank to use saved password' : '';
}

async function signIn(): Promise<void> {
  if (!native || !accountReady || busy || loginBusy || latest?.player) return;
  const username = element<HTMLInputElement>('username').value.trim();
  const password = element<HTMLInputElement>('password');
  const characterSlot = Number(element<HTMLSelectElement>('character-slot').value);
  const remember = element<HTMLInputElement>('remember-login').checked;
  const autoLogin = element<HTMLInputElement>('auto-login').checked;
  const reuse = savedLogin?.username === username && !password.value;
  previousSession = latest?.sessionId;
  loginBusy = true; loginStartedAt = Date.now(); updateButtons();
  try {
    await invoke('login_game', { request: {
      credentials: reuse ? null : { username, password: password.value, characterSlot },
      characterSlot, remember, autoLogin,
    } });
    gameOpen = true;
    if (remember) showSavedLogin({ username, characterSlot, autoLogin });
    message('Loading the game for automatic sign-in…');
  } catch (error) {
    previousSession = undefined;
    loginBusy = false;
    message(typeof error === 'string' ? error : 'Could not start automatic sign-in.', true);
  } finally {
    password.value = '';
    updateButtons();
  }
}

element<HTMLFormElement>('signin-form').addEventListener('submit', event => {
  event.preventDefault();
  if (native && !busy && !loginBusy && !latest?.player) void signIn();
});
element<HTMLInputElement>('remember-login').addEventListener('change', () => {
  if (!element<HTMLInputElement>('remember-login').checked) element<HTMLInputElement>('auto-login').checked = false;
  updateButtons();
});
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
  await invoke('control_bot', { action: 'start', settings: settings() });
}));
stopButton.addEventListener('click', () => void perform(async () => {
  await invoke('control_bot', { action: 'stop' });
}));
for (const [id, output, suffix] of [['radius','radius-value',' cells'],['min-hp','hp-value','%']] as const) {
  element<HTMLInputElement>(id).addEventListener('input', () => { element(output).textContent = element<HTMLInputElement>(id).value + suffix; updateButtons(); });
}

function validStatus(value: unknown): value is GameStatus {
  if (!value || typeof value !== 'object') return false;
  const s = value as Record<string, unknown>;
  if (typeof s.sessionId !== 'string' || !s.sessionId || s.sessionId.length > 64) return false;
  const login = s.login as Partial<LoginStatus> | undefined;
  if (!login || typeof login.message !== 'string' || login.message.length > 1024
    || !['idle','signingIn','selecting','entering','complete','failed','cancelled'].includes(login.phase ?? '')) return false;
  const finite = (v: unknown) => typeof v === 'number' && Number.isFinite(v);
  const entity = (v: unknown) => {
    if (!v || typeof v !== 'object') return false;
    const e = v as Record<string, unknown>;
    return ['id','classId','kind','level','hp','maxHp','x','y'].every(k => finite(e[k])) && typeof e.name === 'string' && e.name.length <= 512;
  };
  const n = s.navigation as Snapshot['navigation'];
  const position = (p: unknown): boolean => !!p && typeof p === 'object' && ['x','y'].every(k => {
    const value = (p as Record<string, unknown>)[k]; return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < MAX_MAP_DIMENSION;
  });
  if (n !== null && (!n || typeof n.ready !== 'boolean' || !['idle','search','attack','pickup'].includes(n.mode)
    || !['width','height','walkable','blocked','excluded','reachable','routeLength'].every(k => {
      const value = (n as unknown as Record<string, unknown>)[k]; return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_MAP_DIMENSION ** 2;
    }) || (n.goal !== null && !position(n.goal)) || !Array.isArray(n.route) || n.route.length > 512 || !n.route.every(position)
    || !Array.isArray(n.leg) || n.leg.length > 21 || !n.leg.every(position))) return false;
  return ['connected','compatible','running'].every(k => typeof s[k] === 'boolean')
    && ['reason','map','target'].every(k => typeof s[k] === 'string' && (s[k] as string).length <= 1024)
    && validMapInfo(s.mapInfo, s.map as string)
    && ['attacks','kills','looted'].every(k => finite(s[k]))
    && (s.player === null || entity(s.player))
    && Array.isArray(s.monsters) && s.monsters.length <= 150 && s.monsters.every(entity)
    && Array.isArray(s.drops) && s.drops.length <= 150 && s.drops.every(v => v && ['id','x','y'].every(k => finite(v[k])))
    && Array.isArray(s.log) && s.log.length <= 50 && s.log.every(v => v && finite(v.at) && typeof v.text === 'string' && v.text.length < 1024);
}

function render(s: GameStatus): void {
  // Navigation is asynchronous: the previous page may still publish its terminal
  // login status while the next official client is loading.
  if (s.sessionId === previousSession) return;
  const justSignedIn = s.login.phase === 'complete' && latest?.login.phase !== 'complete';
  latest = s; receivedAt = Date.now(); gameOpen = true;
  targets.update(s.sessionId, s.mapInfo, s.player?.level ?? null);
  renderTargets();
  if (['complete','failed','cancelled'].includes(s.login.phase)) loginBusy = false;
  if (justSignedIn) element<HTMLDetailsElement>('signin-panel').open = false;
  element('login-help').textContent = s.login.message || 'Select an existing slot. Sign-in enters the field with combat stopped.';
  const state = s.running ? 'RUNNING' : s.player && s.compatible ? 'READY' : s.connected ? 'CONNECTED' : 'OFFLINE';
  element('status').textContent = state;
  element('status').classList.toggle('active', s.running);
  element('character').textContent = s.player?.name ?? 'No character connected';
  element('location').textContent = s.player ? `Level ${s.player.level} · ${s.map} · ${s.player.x}, ${s.player.y}` : 'Your adventure starts in the game window.';
  element('hp-text').textContent = s.player ? `${s.player.hp} / ${s.player.maxHp}` : '— / —';
  element('hp-bar').style.width = `${s.player?.maxHp ? Math.max(0, Math.min(100, s.player.hp / s.player.maxHp * 100)) : 0}%`;
  for (const key of ['attacks','kills','looted'] as const) element(key).textContent = String(s[key]);
  element('nearby').textContent = String(s.monsters.length);
  element('map-label').textContent = s.map || 'WAITING';
  element('target-label').textContent = s.target || 'No active target';
  const nearby = s.monsters.map(e => ({ name: e.name, level: e.level,
    distance: s.player ? Math.max(Math.abs(e.x-s.player.x), Math.abs(e.y-s.player.y)) : 0 }))
    .sort((a,b) => a.distance-b.distance).slice(0,3);
  element('monster-list').textContent = nearby.length ? nearby.map(e => `${e.name} · Lv ${e.level} · ${Math.ceil(e.distance)} cells`).join('  /  ') : 'No monsters in sight.';
  const loginMessage = s.login.phase === 'failed' || s.login.phase === 'cancelled' || loginBusy;
  message(loginMessage ? s.login.message || 'Loading the game for automatic sign-in…' : s.reason,
    s.login.phase === 'failed' || s.connected && !s.compatible);
  const list = element('log'); list.replaceChildren();
  for (const entry of s.log.slice(0,6)) {
    const li = document.createElement('li'); const time = document.createElement('time'); const text = document.createElement('span');
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    text.textContent = entry.text; li.append(time, text); list.append(li);
  }
  drawRadar(s); updateButtons();
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
    if (loginBusy && Date.now() - loginStartedAt > 120_000) {
      loginBusy = false;
      void invoke('control_bot', { action: 'stop' }).catch(() => {});
      message('The game did not finish sign-in. Reopen it to try again.', true);
    }
    updateButtons();
    if (latest?.connected && Date.now() - receivedAt > 7000) message('Game status is stale. Automation stops when the controller heartbeat is lost.', true);
    if (!gameOpen || heartbeatPending) return;
    // Do not keep an unseen session running when its status channel stops responding.
    if (receivedAt > 0 && Date.now() - receivedAt > 7000) return;
    heartbeatPending = true;
    void invoke('control_bot', { action: 'heartbeat' }).catch(() => { gameOpen = false; updateButtons(); })
      .finally(() => { heartbeatPending = false; });
  }, 2000);
}
// Credentials are never persisted by the frontend.
element<HTMLInputElement>('radius').value = String(DEFAULT_SETTINGS.radius);
updateButtons();

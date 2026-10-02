import { CurrentForm } from './current-form';
import type { Snapshot } from './engine';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { validateSettings, type Settings } from './settings';
import { FeatureUi } from './feature-ui';
import { ReconnectPolicy, PersistentFieldRun } from './reconnect';
import { GridNavigator, NAVIGATION_MAPS, searchGrid } from './navigation';
import { validStatus, statusHeartbeatFresh, type GameStatus } from './game-status';
import { SettingsForm } from './settings-form';
import { normalAttackProfile } from './combat';
import { canStartField } from './field-controls';
import { mountClientShell } from './client-shell';
import { clientStatus, clientSp, clientDeaths, clientDeathCap } from './client-status';
import './client-shell.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const shell = mountClientShell(root);

function element<T extends HTMLElement>(id: string): T { return document.getElementById(id) as T; }
element('update-download').addEventListener('click',event=>{
  if(!isTauri())return;event.preventDefault();
  void invoke('update_open_release').catch(()=>message('Could not open the release download. Visit the repository Releases page.',true));
});
const openButton = element<HTMLButtonElement>('open');
const startButton = element<HTMLButtonElement>('start');
const stopButton = element<HTMLButtonElement>('stop');
const native = isTauri();
interface SavedLogin { username: string; characterSlot: number; autoLogin: boolean }
let savedLogin: SavedLogin | null = null;
let loginBusy = false;
let loginStartedAt = 0;
let accountReady = !native;
let accountBaseline:string|null=null;
function accountFields():string{return JSON.stringify(['username','character-slot'].map(id=>element<HTMLInputElement>(id).value).concat(['remember-login','auto-login'].map(id=>String(element<HTMLInputElement>(id).checked))));}
function accountDraft():boolean{return !!element<HTMLInputElement>('password').value||accountBaseline!==null&&accountFields()!==accountBaseline;}
let updateBusy=false;
let updatePolling=false;
let saveTimer:ReturnType<typeof setTimeout>|undefined;
let gameOpen = false;
let latest: GameStatus | null = null;
let receivedAt = 0;
let busy = false;
let heartbeatPending = false;
let previousSession: string | undefined;
const reconnect = new ReconnectPolicy();
const fieldRun = new PersistentFieldRun();
let sessionLoginAvailable = false;
let runGeneration = 0;
let loginGeneration = 0;
let pendingService: Promise<unknown> | null = null;
let pendingManual:Promise<unknown>|null=null;
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
  const task = invoke('control_bot', { action: 'start', settings: request.settings, escapeGuard: request.escapeGuard, supplyGuard:request.supplyGuard, deathRecoveryGuard:request.deathRecoveryGuard });
  pendingResume = task;
  void task.then(() => { fieldRun.completeResume(request, true); })
    .catch(() => {
      if (fieldRun.completeResume(request, false) && generation === runGeneration) message('Waiting to reach the game controller before resuming.');
    }).finally(() => { if (pendingResume === task) pendingResume = null; updateButtons(); });
}
const features = new FeatureUi(shell.main, {
  settings: () => form.runSettings(), apply: value => form.applyProfile(value), map: () => latest?.map ?? '', character: () => latest?.player?.name ?? '',
  command: request => featureRequest('command',request), workflow: request => featureRequest('workflow',request), routine: request => featureRequest('routine',request), service: request => featureRequest('service',request), social: request => featureRequest('social',request), memo: request => featureRequest('memo',request), socketPreview:request=>featureRequest('socketPreview',request),socket:request=>featureRequest('socket',request), warp:request=>featureRequest('warp',request),warpPreview:request=>featureRequest('warpPreview',request),warpCancel:()=>invoke('control_bot',{action:'warpCancel',request:{}}),
  refinePreview: request => featureRequest('refinePreview',request), refine: request => featureRequest('refine',request), refineAdvance: promptToken => featureRequest('refineAdvance',{promptToken}),
  notify: message,stop:()=>stopButton.click(), changed: () => { formChanged(); updateButtons(); },
}, shell);
shell.refreshManualIndex();
const form = new SettingsForm(shell.main, features, {
  context: () => ({
    sessionId: latest?.sessionId ?? '',
    mapInfo: latest?.mapInfo ?? { code: '', name: '', source: 'observed', monsters: [] },
    level: latest?.player?.level ?? null,
    runActive: runActive(),
    controlsLocked: updateBusy || busy || stopping || loginBusy || runActive(),
    targetsLocked: updateBusy || busy || stopping || loginBusy || !native || Date.now() - receivedAt >= 7000
      || !latest?.connected || !latest.compatible || !latest.player || runActive(),
    retainedTargets: fieldRun.requested ? fieldRun.targetIds : undefined,
  }),
  changed: () => { formChanged(); updateButtons(); },
});
const currentForm = new CurrentForm(() => form.snapshot(),
  document=>invoke<number>('save_current_form',{document}));
function formChanged():void {
  currentForm.touch();
  if(!native||!currentForm.initialized||updateBusy)return;
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{void currentForm.flush().catch(()=>{element('update-status').textContent='Updates are waiting for valid, saved current settings.';});},300);
}
function mainSettledForUpdate():boolean {
  return accountReady&&currentForm.initialized&&!accountDraft()&&!updateBusy&&!busy&&!stopping&&!loginBusy&&!heartbeatPending&&!pendingLogin&&!pendingResume&&!pendingService&&!pendingManual&&!pendingLimitStop
    &&!limitStopPending&&features.settledForMaintenance()&&!runActive()&&!fieldRun.requested&&!reconnect.waitingUntil;
}
async function pollUpdate():Promise<void>{
  if(!native||updatePolling||updateBusy)return;updatePolling=true;
  try{
    const state=await invoke<{version:string;phase:string;message:string;availableVersion:string|null}>('update_status');
    element('client-version').textContent=`macOS · v${state.version}`;element('update-status').textContent=state.message;
    if(state.phase==='waiting'&&accountDraft()){element('update-status').textContent='Update waits for your account draft. Sign in or clear the draft first.';return;}
    if(state.phase!=='waiting'||!mainSettledForUpdate())return;
    updateBusy=true;updateButtons();if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined;}
    let nonce:string|null=null;
    try{
      const document=await currentForm.flush();nonce=await invoke<string>('update_reserve',{document});
      for(let attempt=0;attempt<20;attempt++){
        if(await invoke<boolean>('update_install',{nonce}))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch{element('update-status').textContent='Update deferred. Waiting for valid saved settings and settled game actions. Use the release download if needed.';}
    finally{if(nonce)await invoke('update_release',{nonce}).catch(()=>{});updateBusy=false;updateButtons();}
  }catch{element('update-status').textContent='Update check unavailable. It will retry automatically.';}
  finally{updatePolling=false;}
}
const configHelp = element('config-help');

async function featureRequest(action: string, request: unknown): Promise<unknown> {
  if (!native || busy || stopping || loginBusy || !latest?.connected || !latest.compatible || !latest.player || (action==='service'?features.serviceBlocked():(action==='warp'||action==='warpPreview')&&features.warpActivationReady()?fieldRun.requested:runActive()) || Date.now()-receivedAt >= 7000) {
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
    if(action==='command'&&request&&typeof request==='object'&&'type' in request&&request.type==='manualTarget') {
      const generation=++runGeneration;reconnect.cancel();
      const task=invoke('control_bot',{action,request});pendingManual=task;
      try {const result=await task;if(generation!==runGeneration&&stopping)await invoke('control_bot',{action:'stop'});return result;}
      finally{if(pendingManual===task)pendingManual=null;}
    }
    return await invoke('control_bot',{action,request});
  } finally { busy=false;updateButtons(); }
}

function message(text: string, error = false): void {
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
}
function updateButtons(): void {
  const navigation = new Set(shell.main.querySelectorAll<HTMLButtonElement>('button[data-client-page-nav], button[data-client-bot-nav], #client-manual-index > button'));
  for (const button of navigation) button.disabled = false;
  try { element('death-cap').textContent = clientDeathCap(form.snapshot().settings.automation?.respawn); }
  catch { element('death-cap').textContent = '—'; }
  if(updateBusy){for(const input of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement>('input,select,button,textarea'))if(!navigation.has(input as HTMLButtonElement))input.disabled=true;features.lock(true,true,true);return;}
  form.refresh();
  const fresh = Date.now() - receivedAt < 7000;
  const ready = native && fresh && latest?.connected && latest.compatible && latest.player;
  let checked:Settings|null = null;
  try { checked=validateSettings(form.runSettings()); configHelp.textContent=''; }
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
  features.lock(busy || stopping || loginBusy || runActive(),busy || stopping || loginBusy || !ready || runActive(),busy || stopping || loginBusy || !ready || features.serviceBlocked(),busy || stopping || loginBusy || !ready || fieldRun.requested);
}

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
    gameOpen = true;accountBaseline=accountFields();
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
  accountBaseline=accountFields();message('Local saved login and app-open sign-in preference removed.');
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
  const checked = validateSettings(form.runSettings()), generation = ++runGeneration;
  fieldRun.begin(checked, latest.player.name, latest.sessionId, { kills: latest.kills, looted: latest.looted, deaths: latest.deaths, attacks: latest.attacks });
  limitHeld = false; configureReconnect();
  reconnect.observe(latest.connected, true, latest.login.phase, Date.now(), latest.login.message);
  const supplyGuard=fieldRun.supplyGuardForStart(checked,latest.player.name,latest.sessionId);
  const deathRecoveryGuard=fieldRun.deathGuardForStart(checked,latest.player.name,latest.sessionId);
  const supplyCharacter=latest.player.name,supplySession=latest.sessionId;
  const task = invoke('control_bot', { action: 'start', settings: checked,
    escapeGuard: fieldRun.guardForStart(checked, latest?.player?.name ?? '', latest?.sessionId ?? ''),
    supplyGuard, deathRecoveryGuard });
  pendingResume = task;
  try { await task;if(generation===runGeneration){fieldRun.completeSupplyStart(supplyCharacter,supplySession,supplyGuard);fieldRun.completeDeathStart(supplyCharacter,supplySession,deathRecoveryGuard);} }
  catch (error) { if (generation === runGeneration) { fieldRun.stop(); configureReconnect(); } throw error; }
  finally { if (pendingResume === task) pendingResume = null; }
}));
stopButton.addEventListener('click', () => {
  if (stopping) return;
  const generation = ++runGeneration; ++loginGeneration;
  fieldRun.stop(); reconnect.cancel(); limitHeld = false; loginBusy = false; previousSession = undefined;
  const pending = [pendingResume, pendingLogin, pendingLimitStop, pendingService,pendingManual].filter((task): task is Promise<unknown> => task !== null);
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
function render(s: GameStatus): void {
  // Navigation is asynchronous: the previous page may still publish its terminal
  // login status while the next official client is loading.
  if (s.sessionId === previousSession) return;
  const justSignedIn = s.login.phase === 'complete' && latest?.login.phase !== 'complete';
  latest = s; receivedAt = Date.now(); gameOpen = true;
  if (sessionLoginAvailable !== s.reconnectAvailable) { sessionLoginAvailable = s.reconnectAvailable; configureReconnect(); }
  reconnect.observe(s.connected, !!s.player, s.login.phase, Date.now(), s.login.message);
  fieldRun.observe(s); holdAtRunLimit();
  form.refresh();
  features.render(s);
  if (['complete','failed','cancelled'].includes(s.login.phase)) loginBusy = false;
  if (justSignedIn) element<HTMLDetailsElement>('signin-panel').open = false;
  element('login-help').textContent = s.login.message || 'Select an existing slot. Sign-in enters the field with combat stopped.';
  const { state, reason } = clientStatus(s, { fieldRequested: fieldRun.requested, held: features.active(), limitReason: fieldRun.limitReason, loginBusy });
  element('status').textContent = state;
  element('status').classList.toggle('active', state === 'RUNNING');
  element('status').dataset.state = state;
  element('character').textContent = s.player?.name ?? 'No character connected';
  element('location').textContent = s.player ? `Level ${s.player.level} · ${s.map} · ${s.player.x}, ${s.player.y}` : 'Your adventure starts in the game window.';
  const attack = normalAttackProfile(s.character);
  const rawRange = attack.sourceRange !== null && attack.sourceRange !== attack.range ? ` · source range ${attack.sourceRange}` : '';
  element('attack-range').textContent = `Normal attack: ${attack.range} cells · ${attack.source}${rawRange}. ${attack.limitation} Projectile sight is checked; skill range and kiting are separate.`;
  element('hp-text').textContent = s.player ? `${s.player.hp} / ${s.player.maxHp}` : '— / —';
  element('hp-bar').style.width = `${s.player?.maxHp ? Math.max(0, Math.min(100, s.player.hp / s.player.maxHp * 100)) : 0}%`;
  const sp = clientSp(s.character.stats);
  element('sp-text').textContent = sp.text; element('sp-bar').style.width = sp.width;
  element('death-count').textContent = clientDeaths(fieldRun.requested ? fieldRun.metrics.deaths : s.deaths);
  for (const key of ['attacks','kills','looted'] as const) element(key).textContent = String(fieldRun.requested ? fieldRun.metrics[key] : s[key]);
  element('nearby').textContent = String(s.monsters.length);
  element('map-label').textContent = s.map || 'WAITING';
  element('target-label').textContent = s.target || 'No active target';
  const nearby = s.monsters.map(e => ({ name: e.name, level: e.level,
    distance: s.player ? Math.max(Math.abs(e.x-s.player.x), Math.abs(e.y-s.player.y)) : 0 }))
    .sort((a,b) => a.distance-b.distance).slice(0,3);
  element('monster-list').textContent = nearby.length ? nearby.map(e => `${e.name} · Lv ${e.level} · ${Math.ceil(e.distance)} cells`).join('  /  ') : 'No monsters in sight.';
  message(reason,
    s.login.phase === 'failed' || s.connected && !s.compatible);
  const list = element('log'); list.replaceChildren();
  for (const entry of s.log.slice(0,6)) {
    const li = document.createElement('li'); const time = document.createElement('time'); const text = document.createElement('span');
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    text.textContent = entry.text; li.append(time, text); list.append(li);
  }
  drawRadar(s); updateButtons(); resumeFieldRun(s);
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
    form.refresh();
    element('status').textContent = 'OFFLINE'; element('status').classList.remove('active'); element('status').dataset.state = 'OFFLINE';
    message('Game window closed. Open it again to reconnect.'); updateButtons(); drawRadar(null);
  });
  try {
    try{currentForm.restore(await invoke('current_form'), document => form.restore(document));}
    catch{currentForm.initialized=false;element('update-status').textContent='Current settings could not be restored. Automatic updates are waiting.';}
    if(currentForm.initialized)await currentForm.flush().catch(()=>{element('update-status').textContent='Updates are waiting for valid, saved current settings.';});
    const profile = await invoke<SavedLogin | null>('saved_login');
    accountReady = true;
    showSavedLogin(profile);
    if (profile) {
      element<HTMLInputElement>('username').value = profile.username;
      element<HTMLSelectElement>('character-slot').value = String(profile.characterSlot);
      element<HTMLInputElement>('remember-login').checked = true;
      element<HTMLInputElement>('auto-login').checked = profile.autoLogin;
      accountBaseline=accountFields();if (profile.autoLogin) await signIn();
    }
  } catch {
    element<HTMLButtonElement>('forget-login').hidden = false;
    message('Local saved login could not be read. Forget it or enter your account manually.', true);
  }
  finally { accountReady = true;accountBaseline??=accountFields(); }
  await invoke('update_initialized').catch(()=>{});void pollUpdate();setInterval(()=>{void pollUpdate();},15_000);
  updateButtons();
  })();
  setInterval(() => {
    holdAtRunLimit();
    if (loginBusy && Date.now() - loginStartedAt > 120_000) {
      loginBusy = false; previousSession = undefined; reconnect.networkFailure(Date.now());
      message('Sign-in is taking too long. Waiting before reconnecting again.', true);
    }
    updateButtons();
    const retry = !updateBusy && gameOpen && !busy && !stopping && !loginBusy && !(latest?.connected && latest.player)
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
          if (typeof error === 'string' && /(?:sign in|account)/i.test(error)) reconnect.observe(false, false, 'failed', Date.now(), 'Explicit sign-in required.');
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
    if(updateBusy||!gameOpen || heartbeatPending) return;
    if (!statusHeartbeatFresh(receivedAt, Date.now())) return;
    heartbeatPending = true;
    void invoke('control_bot', { action: 'heartbeat' }).catch(() => { updateButtons(); })
      .finally(() => { heartbeatPending = false; });
  }, 1000);
}
// Only the explicit settings projection enters persistence; account inputs are excluded.
document.querySelector('main')!.addEventListener('input',event=>{const target=event.target as HTMLElement;if(!target.closest('#signin-panel')&&target.closest('.settings,.feature-panel,.rule-editor')){formChanged();updateButtons();}});
document.querySelector('main')!.addEventListener('change',event=>{const target=event.target as HTMLElement;if(target.id==='profile-select')formChanged();});
updateButtons();

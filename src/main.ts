import { CurrentForm } from './current-form';
import { SettingsClose, type CloseRequest } from './settings-close';
import { BotConsole } from './bot-console';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { validateSettings, type Settings } from './settings';
import { FeatureUi } from './feature-ui';
import { ReconnectPolicy, PersistentFieldRun } from './reconnect';
import { validStatus, statusHeartbeatFresh, type GameStatus } from './game-status';
import { SettingsForm } from './settings-form';
import { normalAttackProfile } from './combat';
import { canStartField } from './field-controls';
import { mountClientShell } from './client-shell';
import { clientStatus, clientSp, clientDeaths, clientDeathCap } from './client-status';
import { clientDashboard } from './client-dashboard';
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
let closeRegistered=!native;
let closeBusy=false;
let closeStatus:string|null=null;
root.inert=native;
interface SavedLogin { username: string; characterSlot: number; autoLogin: boolean; mode?:'botOnly'|'gameClient' }
let savedLogin: SavedLogin | null = null;
let loginBusy = false;
let loginStartedAt = 0;
let accountReady = !native;
let accountBaseline:string|null=null;
function accountFields():string{return JSON.stringify(['username','character-slot','connection-mode'].map(id=>element<HTMLInputElement>(id).value).concat(['remember-login','auto-login'].map(id=>String(element<HTMLInputElement>(id).checked))));}
function accountDraft():boolean{return !!element<HTMLInputElement>('password').value||accountBaseline!==null&&accountFields()!==accountBaseline;}
let updateBusy=false;
let updateSettled:Promise<void>=Promise.resolve();
let updateFinished:()=>void=()=>{};
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
  if (!native || closeBusy || busy || stopping || loginBusy || pendingResume) return;
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
  macroSettings: () => form.snapshot().settings,
  command: request => featureRequest('command',request), workflow: request => featureRequest('workflow',request), routine: request => featureRequest('routine',request), macro: request => featureRequest('macro',request), service: request => featureRequest('service',request), social: request => featureRequest('social',request), memo: request => featureRequest('memo',request), socketPreview:request=>featureRequest('socketPreview',request),socket:request=>featureRequest('socket',request), warp:request=>featureRequest('warp',request),warpPreview:request=>featureRequest('warpPreview',request),warpCancel:()=>invoke('control_bot',{action:'warpCancel',request:{}}),
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
    controlsLocked: !closeRegistered || closeBusy || updateBusy || busy || stopping || loginBusy || runActive(),
    targetsLocked: !closeRegistered || closeBusy || updateBusy || busy || stopping || loginBusy || !native || Date.now() - receivedAt >= 7000
      || !latest?.connected || !latest.compatible || !latest.player || runActive(),
    retainedTargets: fieldRun.requested ? fieldRun.targetIds : undefined,
  }),
  changed: () => { formChanged(); updateButtons(); },
});
const currentForm = new CurrentForm(() => form.snapshot(),
  document=>invoke<number>('save_current_form',{document}));
let formRestored:()=>void=()=>{};
const restoreSettled=new Promise<void>(resolve=>{formRestored=resolve;});
const settingsClose=new SettingsClose({
  settled:async()=>{await restoreSettled;await updateSettled;if(!currentForm.initialized)currentForm.restore(await invoke('current_form'),document=>form.restore(document));},
  flush:()=>currentForm.flush(),
  unchanged:document=>JSON.stringify(form.snapshot())===JSON.stringify({settings:document.settings,selectedProfileId:document.selectedProfileId}),
  complete:(token,revision)=>invoke('settings_close_complete',{token,revision}),
  cancel:token=>invoke('settings_close_cancel',{token}),
  lock:locked=>{closeBusy=locked;root.inert=locked||!closeRegistered;if(locked&&saveTimer){clearTimeout(saveTimer);saveTimer=undefined;}updateButtons();},
  status:status=>{closeStatus=status;element('update-status').textContent=status;message(status,status.startsWith('Close cancelled'));},
});
function formChanged():void {
  currentForm.touch();
  if(!closeBusy)closeStatus=null;
  if(!native||!currentForm.initialized||closeBusy||updateBusy)return;
  if(saveTimer)clearTimeout(saveTimer);
  saveTimer=setTimeout(()=>{void currentForm.flush().catch(()=>{element('update-status').textContent='Updates are waiting for valid, saved current settings.';});},300);
}
function mainSettledForUpdate():boolean {
  return closeRegistered&&!closeBusy&&accountReady&&currentForm.initialized&&!accountDraft()&&!updateBusy&&!busy&&!stopping&&!loginBusy&&!heartbeatPending&&!pendingLogin&&!pendingResume&&!pendingService&&!pendingManual&&!pendingLimitStop
    &&!limitStopPending&&!features.hasUnsavedMacro()&&features.settledForMaintenance()&&!runActive()&&!fieldRun.requested&&!reconnect.waitingUntil;
}
async function pollUpdate():Promise<void>{
  if(!native||!closeRegistered||closeBusy||closeStatus||updatePolling||updateBusy)return;updatePolling=true;
  try{
    const state=await invoke<{version:string;platform?:string;phase:string;message:string;availableVersion:string|null}>('update_status');
    element('client-version').textContent=`${({macos:'macOS',windows:'Windows',linux:'Linux'} as Record<string,string>)[state.platform??'']??'Desktop'} · v${state.version}`;if(closeBusy||closeStatus)return;element('update-status').textContent=state.message;
    if(state.phase==='waiting'&&accountDraft()){element('update-status').textContent='Update waits for your account draft. Sign in or clear the draft first.';return;}
    if(state.phase!=='waiting'||!mainSettledForUpdate())return;
    updateBusy=true;updateSettled=new Promise(resolve=>{updateFinished=resolve;});updateButtons();if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined;}
    let nonce:string|null=null;
    try{
      const document=await currentForm.flush();if(closeBusy)return;
      nonce=await invoke<string>('update_reserve',{document});if(closeBusy)return;
      for(let attempt=0;attempt<20;attempt++){
        if(await invoke<boolean>('update_install',{nonce}))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch{if(!closeStatus)element('update-status').textContent='Update deferred. Waiting for valid saved settings and settled game actions. Use the release download if needed.';}
    finally{if(nonce)await invoke('update_release',{nonce}).catch(()=>{});updateBusy=false;updateFinished();updateButtons();}
  }catch{element('update-status').textContent='Update check unavailable. It will retry automatically.';}
  finally{updatePolling=false;}
}
const configHelp = element('config-help');
const botConsole = new BotConsole(shell.main, {
  settings: () => form.runSettings(), command: request => featureRequest('command', request), notify: message,
  account: () => { shell.showPage('settings'); element<HTMLDetailsElement>('signin-panel').open = true; element<HTMLInputElement>('username').focus(); },
  lootSettings: () => { shell.showPage('bot'); shell.showBotSection('inventory'); },
  manualTools: () => shell.showPage('manual'),
});
function disconnectReady():boolean {
  return native && gameOpen && accountReady && !updateBusy && !busy && !stopping && !loginBusy && !pendingLogin && !pendingResume
    && !pendingService && !pendingManual && !pendingLimitStop && !heartbeatPending && !runActive()
    && features.settledForMaintenance() && !(latest?.connected && latest.player && Date.now()-receivedAt>=7000);
}


async function featureRequest(action: string, request: unknown): Promise<unknown> {
  if (!native || updateBusy || busy || stopping || loginBusy || !latest?.connected || !latest.compatible || !latest.player || (action==='service'?features.serviceBlocked():(action==='warp'||action==='warpPreview')&&features.warpActivationReady()?fieldRun.requested:runActive()) || Date.now()-receivedAt >= 7000) {
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
    if(action==='macro') {
      const generation=++runGeneration;fieldRun.stop();reconnect.cancel();limitHeld=false;
      const pending=pendingResume;if(pending)await pending.catch(()=>{});
      if(generation!==runGeneration||stopping)throw new Error('Macro request canceled by Stop.');
      const task=invoke('control_bot',{action,request});pendingManual=task;
      try { const result=await task;if(generation!==runGeneration)await invoke('control_bot',{action:'stop'});return result; }
      finally { if(pendingManual===task)pendingManual=null; }
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
  if(closeStatus){text=closeStatus;error=closeStatus.startsWith('Close cancelled');}
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
}
function updateButtons(): void {
  const navigation = new Set(shell.main.querySelectorAll<HTMLButtonElement>('button[data-client-page-nav], button[data-client-bot-nav], button[data-client-inspector-nav], button[data-client-navigation], #client-manual-index > button'));
  for (const button of navigation) button.disabled = false;
  let dashboardSettings: Settings | null = null;
  try { dashboardSettings = form.snapshot().settings; } catch { /* Keep invalid drafts editable on Setup. */ }
  const fresh = Date.now() - receivedAt < 7000;
  const dashboard = clientDashboard(latest, { fieldRequested: fieldRun.requested, held: features.active(), limitReason: fieldRun.limitReason, loginBusy, fresh }, dashboardSettings, latest?.mapInfo);
  element('client-run-title').textContent = dashboard.headline;
  element('console-setup-summary').textContent = dashboard.setup;
  element('client-account-label').textContent = latest?.connected && latest.compatible && latest.player ? 'Account' : 'Connect account';
  startButton.hidden = dashboard.state === 'RUNNING';
  try { element('death-cap').textContent = clientDeathCap(form.snapshot().settings.automation?.respawn); }
  catch { element('death-cap').textContent = '—'; }
  if(!closeRegistered||closeBusy||updateBusy){botConsole.lock(true,closeBusy?'Saving current settings before closing.':!closeRegistered?'Preparing saved settings.':'Client update in progress. Manual actions are locked.');for(const input of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement>('input,select,button,textarea'))if(!navigation.has(input as HTMLButtonElement))input.disabled=true;features.lock(true,true,true);return;}
  form.refresh();
  const ready = native && fresh && latest?.connected && latest.compatible && latest.player;
  let checked:Settings|null = null;
  try { checked=validateSettings(form.runSettings()); configHelp.textContent=''; }
  catch(error) { configHelp.textContent=ready && error instanceof Error ? error.message : ''; }
  startButton.disabled = !canStartField({native,fresh,busy,stopping,loginBusy,runActive:runActive(),connected:latest?.connected===true,compatible:latest?.compatible===true,
    map:latest?.map??'',player:latest?.player??null,settings:checked});
  stopButton.disabled = stopping || !gameOpen && !fieldRun.requested && !loginBusy;
  openButton.disabled = false;
  element<HTMLButtonElement>('disconnect').disabled = !disconnectReady();
  botConsole.lock(busy || stopping || loginBusy || !ready || runActive() || !features.settledForMaintenance(), !native ? 'Browser preview · native connection required.' : busy || stopping || loginBusy ? 'Wait for the current request to finish.' : !ready ? 'Connect a fresh verified character to use manual controls.' : runActive() || !features.settledForMaintenance() ? 'Stop the bot; wait for pending actions before manual control.' : '');
  element<HTMLButtonElement>('signin').disabled = !native || !accountReady || busy || stopping || loginBusy || !!(latest?.connected && latest.player);
  element<HTMLButtonElement>('forget-login').disabled = busy || stopping || loginBusy;
  for (const id of ['username', 'password', 'character-slot', 'remember-login']) {
    element<HTMLInputElement>(id).disabled = !accountReady || busy || stopping || loginBusy;
  }
  element<HTMLSelectElement>('connection-mode').disabled = !accountReady || gameOpen || busy || stopping || loginBusy;
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
  const mode = element<HTMLSelectElement>('connection-mode').value as 'botOnly'|'gameClient';
  const reuse = savedLogin?.username === username && !password.value;
  previousSession = latest?.sessionId;
  loginBusy = true; loginStartedAt = Date.now(); updateButtons();
  try {
    const task = invoke('login_game', { request: {
      credentials: reuse ? null : { username, password: password.value, characterSlot },
      characterSlot, remember, autoLogin, mode,
    } });
    pendingLogin = task;
    await task;
    if (generation !== loginGeneration) return;
    gameOpen = true;accountBaseline=accountFields();
    if (remember) showSavedLogin({ username, characterSlot, autoLogin, mode });
    message(mode==='botOnly'?'Opening bot connection for sign-in…':'Loading the game client for sign-in…');
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
element('disconnect').addEventListener('click', () => {
  if (!disconnectReady()) return;
  void perform(async () => { await invoke('close_game'); });
});
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
  element('character').title = s.player?.name ?? 'No character connected';
  element('location').textContent = s.player ? `Level ${s.player.level} · ${s.map} · ${s.player.x}, ${s.player.y}` : 'Connect an account to load your character.';
  element('location').title = element('location').textContent ?? '';
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
  message(reason,
    s.login.phase === 'failed' || s.connected && !s.compatible);
  const list = element('log'); list.replaceChildren();
  for (const entry of s.log.slice(0,50)) {
    const li = document.createElement('li'); const time = document.createElement('time'); const text = document.createElement('span');
    time.textContent = new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    text.textContent = entry.text; li.append(time, text); list.append(li);
  }
  if (!list.childElementCount) { const empty=document.createElement('li'); empty.className='empty'; empty.textContent='No activity observed yet.'; list.append(empty); }
  botConsole.render(s); updateButtons(); resumeFieldRun(s);
}
if (!native) message('Browser preview · Launch the desktop app with npm run app:dev to connect.');
if (native) {
  void (async () => {
  try {
    await listen<CloseRequest>('settings-close-request',event=>{void settingsClose.request(event.payload);});
    const pending=await invoke<CloseRequest|null>('settings_close_ready');
    closeRegistered=true;root.inert=closeBusy;updateButtons();
    if(pending)void settingsClose.request(pending);
  }catch{element('update-status').textContent='Settings could not be initialized. Reopen the app to edit them safely.';return;}
  await listen<unknown>('game-status', event => { if (validStatus(event.payload)) render(event.payload); });
  await listen('game-closed', () => {
    features.clearSocial();
    features.clearMemo();
    features.clearMacro();
    ++runGeneration; ++loginGeneration; fieldRun.stop(); reconnect.cancel();
    sessionLoginAvailable = false; pendingResume = null; pendingLogin = null; limitHeld = false; previousSession = undefined;
    gameOpen = false; latest = null; receivedAt = 0; loginBusy = false;
    form.refresh();
    element('status').textContent = 'OFFLINE'; element('status').classList.remove('active'); element('status').dataset.state = 'OFFLINE';
    element('character').textContent='No character connected'; element('location').textContent='Connect an account to load your character.';
    element('character').title='No character connected'; element('location').title='Connect an account to load your character.';
    element('hp-text').textContent='— / —'; element('hp-bar').style.width='0%'; element('sp-text').textContent='— / —'; element('sp-bar').style.width='0%'; element('death-count').textContent='—';
    for (const id of ['attacks','kills','looted','nearby']) element(id).textContent='0'; element('map-label').textContent='WAITING'; element('target-label').textContent='No active target';
    const empty=document.createElement('li'); empty.className='empty'; empty.textContent='Session activity will appear after connection.'; element('log').replaceChildren(empty);
    message('Disconnected. Select an account and character to connect again.'); botConsole.render(null); updateButtons();
  });
  try {
    try{currentForm.restore(await invoke('current_form'), document => form.restore(document));}
    catch{currentForm.initialized=false;element('update-status').textContent='Current settings could not be restored. Automatic updates are waiting.';}
    if(currentForm.initialized)await currentForm.flush().catch(()=>{element('update-status').textContent='Updates are waiting for valid, saved current settings.';});
    formRestored();
    const profile = await invoke<SavedLogin | null>('saved_login');
    accountReady = true;
    showSavedLogin(profile);
    if (profile) {
      element<HTMLInputElement>('username').value = profile.username;
      element<HTMLSelectElement>('character-slot').value = String(profile.characterSlot);
      element<HTMLInputElement>('remember-login').checked = true;
      element<HTMLInputElement>('auto-login').checked = profile.autoLogin;
      element<HTMLSelectElement>('connection-mode').value = profile.mode ?? 'gameClient';
      accountBaseline=accountFields();if (profile.autoLogin&&!closeBusy) await signIn();
    }
  } catch {
    element<HTMLButtonElement>('forget-login').hidden = false;
    message('Local saved login could not be read. Forget it or enter your account manually.', true);
  }
  finally { accountReady = true;accountBaseline??=accountFields(); }
  await invoke('update_initialized').catch(()=>{});void pollUpdate();setInterval(()=>{void pollUpdate();},15_000);
  updateButtons();
  })().catch(()=>{formRestored();element('update-status').textContent='Settings initialization failed. Check the settings or local storage before closing.';});
  setInterval(() => {
    holdAtRunLimit();
    if (loginBusy && Date.now() - loginStartedAt > 120_000) {
      loginBusy = false; previousSession = undefined; reconnect.networkFailure(Date.now());
      message('Sign-in is taking too long. Waiting before reconnecting again.', true);
    }
    updateButtons();
    const retry = !closeBusy && !updateBusy && gameOpen && !busy && !stopping && !loginBusy && !(latest?.connected && latest.player)
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
          message(reconnect.requiresSignIn ? 'Waiting for you to sign in again before resuming.' : 'Reconnect could not restore the connection. Waiting before trying again.', true); updateButtons();
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

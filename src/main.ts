import { CurrentForm } from './current-form';
import { SettingsClose, type CloseRequest } from './settings-close';
import { BotConsole } from './bot-console';
import { ActivityLog } from './activity-log';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { validateSettings, type Settings } from './settings';
import { FeatureUi } from './feature-ui';
import { ReconnectPolicy, PersistentFieldRun } from './reconnect';
import { RunIntentDispatch } from './run-intent-dispatch';
import { UpdateContinuationOwner, type UpdateAccount } from './update-continuation';
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
const activityLog = new ActivityLog(element('log'));
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
const dispatches = new RunIntentDispatch(fieldRun, reconnect, (command, args) => invoke(command, args));
const updateContinuation = new UpdateContinuationOwner((command, args) => invoke(command, args));
let updateStopped = false;
function accountSelection(): UpdateAccount {
  return { username: element<HTMLInputElement>('username').value.trim(),
    characterSlot: Number(element<HTMLSelectElement>('character-slot').value),
    mode: element<HTMLSelectElement>('connection-mode').value as UpdateAccount['mode'] };
}
function selectUpdateAccount(): void {
  const account=updateContinuation.account;if(!account)return;
  element<HTMLInputElement>('username').value=account.username;
  element<HTMLSelectElement>('character-slot').value=String(account.characterSlot);
  element<HTMLSelectElement>('connection-mode').value=account.mode;
  const savedMatches=!!savedLogin&&savedLogin.username===account.username&&savedLogin.characterSlot===account.characterSlot
    &&(savedLogin.mode??'gameClient')===account.mode;
  element<HTMLInputElement>('remember-login').checked=savedMatches;
  element<HTMLInputElement>('auto-login').checked=savedMatches&&savedLogin!.autoLogin;
}
async function claimUpdateContinuation(load:Promise<unknown>,retired=false):Promise<void> {
  if(updateStopped)return;
  const continuation=await updateContinuation.claimFrom(load,fieldRun,retired);if(!continuation||updateStopped||!updateContinuation.pending)return;
  form.restore(continuation.form);selectUpdateAccount();accountBaseline=accountFields();
  message('Update complete. Settings restored. Waiting for the same account and character to continue.');
  updateButtons();
}
function runActive(): boolean { return updateContinuation.pending || fieldRun.requested || !!latest?.runRequested || !!latest?.running || features.active(); }
function configureReconnect(): void {
  reconnect.configure(fieldRun.requested || element<HTMLInputElement>('auto-reconnect').checked,
    sessionLoginAvailable, fieldRun.requested);
}
function holdAtRunLimit(): void {
  if(updateBusy)return;
  const task = dispatches.holdAtRunLimit(gameOpen);
  if (task) void task.finally(updateButtons);
}
function resumeFieldRun(s: GameStatus): void {
  if (!native || closeBusy || updateBusy || updateContinuation.pending || busy || dispatches.stopping || loginBusy || dispatches.pending.resume) return;
  holdAtRunLimit();
  const task = dispatches.resume(s);
  if (!task) return;
  void task.then(receipt => {
    const result = receipt.outcome;
    if (result.status === 'failed') message('Waiting to reach the game controller before resuming.');
  }).finally(updateButtons);
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
    controlsLocked: !closeRegistered || closeBusy || updateBusy || busy || dispatches.stopping || loginBusy || runActive(),
    targetsLocked: !closeRegistered || closeBusy || updateBusy || busy || dispatches.stopping || loginBusy || !native || Date.now() - receivedAt >= 7000
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
function mainUpdateWaitReason():string|null {
  if(!closeRegistered)return 'Update waits for settings initialization.';
  if(closeBusy)return 'Update waits for the settings window to finish closing.';
  if(!accountReady)return 'Update waits for the saved account to finish loading.';
  if(!currentForm.initialized)return 'Update waits for current settings to be restored.';
  if(accountDraft())return 'Update waits for your account draft. Sign in or clear the draft first.';
  if(updateBusy)return 'Update settlement is already in progress.';
  if(busy)return 'Update waits for the current request to finish.';
  if(dispatches.stopping)return 'Update waits for Stop to finish.';
  if(loginBusy)return 'Update waits for sign-in to finish.';
  if(heartbeatPending)return 'Update waits for the current connection check to finish.';
  if(dispatches.pending.login)return 'Update waits for the pending sign-in request to finish.';
  if(dispatches.pending.resume)return 'Update waits for the pending automation resume to finish.';
  if(dispatches.pending.service)return 'Update waits for the pending service action to finish.';
  if(dispatches.pending.manual)return 'Update waits for the pending manual action to finish.';
  if(dispatches.pending.limit)return 'Update waits for automation to stop at its configured limit.';
  if(features.hasUnsavedMacro())return 'Update waits for your macro draft. Save or clear it first.';
  if(updateContinuation.pending)return 'The previous update is waiting to continue your run.';
  if(!features.settledForMaintenance(true))return 'Update waits for pending game actions or previews to finish.';
  if(reconnect.waitingUntil)return 'Update waits for the scheduled reconnect to finish.';
  return null;
}
type UpdateStep='settings'|'prepare'|'reserve'|'confirmation';
function updateDeferredReason(step:UpdateStep,error:unknown):string {
  // Only known generic messages may cross this boundary. Unknown errors can
  // contain paths, account details or payloads, so report only their stage.
  const reasons:Record<string,string>={
    'No verified update is ready.':'The verified update is no longer ready.',
    'Waiting for login to settle.':'Sign-in has not finished.',
    'Save current settings before updating.':'Current settings need to be saved.',
    'Current settings changed before update settlement.':'Current settings changed while preparing the update.',
    'Waiting for a fresh stopped client before updating.':'The connection has not confirmed a fresh stopped state.',
    'Game update settlement is unavailable.':'The game could not be reached for update confirmation.',
    'Update settlement expired.':'The game confirmation expired.',
    'Update settlement changed.':'Game activity changed during update confirmation.',
    'Login settlement changed.':'Sign-in activity changed during update confirmation.',
    'Game settlement changed before replacement.':'Game activity changed before installation.',
  };
  const reason=typeof error==='string'&&Object.hasOwn(reasons,error)?reasons[error]:null;
  const fallback={settings:'Current settings could not be saved. Check the settings form.',prepare:'The current game action has not reached a confirmed boundary.',reserve:'The connection could not be prepared for update confirmation.',confirmation:'The game could not complete update confirmation.'};
  return `Update deferred. ${reason??fallback[step]} It will retry automatically.`;
}
async function pollUpdate():Promise<void>{
  if(!native||!closeRegistered||closeBusy||closeStatus||updatePolling||updateBusy)return;updatePolling=true;
  try{
    const state=await invoke<{version:string;platform?:string;phase:string;message:string;availableVersion:string|null}>('update_status');
    element('client-version').textContent=`${({macos:'macOS',windows:'Windows',linux:'Linux'} as Record<string,string>)[state.platform??'']??'Desktop'} · v${state.version}`;if(closeBusy||closeStatus)return;element('update-status').textContent=state.message;
    if(state.phase!=='waiting')return;
    const waiting=mainUpdateWaitReason();if(waiting){element('update-status').textContent=waiting;return;}
    updateBusy=true;updateStopped=false;updateSettled=new Promise(resolve=>{updateFinished=resolve;});updateButtons();if(saveTimer){clearTimeout(saveTimer);saveTimer=undefined;}
    let nonce:string|null=null;
    let step:UpdateStep='settings';
    try{
      element('update-status').textContent='Saving current settings before updating.';
      const document=await currentForm.flush();if(closeBusy||updateStopped)return;
      let active = fieldRun.requested||latest?.runRequested===true
        ||!!latest?.macro&&['running','waiting','monitoring'].includes(latest.macro.state);
      if(gameOpen&&active){
        step='prepare';element('update-status').textContent='Pausing new decisions and waiting for the current action to finish. Stop cancels continuation.';
        const checkpoint=await updateContinuation.prepare();if(closeBusy||updateStopped)return;
        if(!validStatus(checkpoint.status))throw new Error('Update handoff is unavailable.');
        fieldRun.observe(checkpoint.status,checkpoint.frozenAt);
        active=fieldRun.requested||checkpoint.settings!==null||checkpoint.macro!==null;
      }
      step='reserve';element('update-status').textContent='Preparing the connection for update confirmation.';
      nonce=await invoke<string>('update_reserve',{document,continuation:active?{version:1,field:fieldRun.checkpoint()}:null});if(closeBusy||updateStopped)return;
      step='confirmation';element('update-status').textContent='Update waits for game confirmation that all actions have stopped. It will retry automatically.';
      for(let attempt=0;attempt<20;attempt++){
        if(updateStopped)return;
        if(await invoke<boolean>('update_install',{nonce}))break;
        await new Promise(resolve=>setTimeout(resolve,100));
      }
    }catch(error){if(!closeStatus)element('update-status').textContent=updateDeferredReason(step,error);}
    finally{
      if(nonce)await invoke('update_release',{nonce}).catch(()=>{});
      if(!gameOpen&&!updateStopped){
        try{await claimUpdateContinuation(invoke('update_continuation'),true);}
        catch{message('The update could not continue the run. Start the bot explicitly.',true);}
        if(!updateContinuation.pending)dispatches.gameClosed();
      }
      if(!updateContinuation.pending)await updateContinuation.cancel().catch(()=>{});
      updateBusy=false;updateFinished();updateButtons();
      if(updateContinuation.pending&&updateContinuation.automaticLogin(savedLogin?{...savedLogin,mode:savedLogin.mode??'gameClient'}:null))void signIn();
    }
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
  return native && gameOpen && accountReady && !updateBusy && !busy && !dispatches.stopping && !loginBusy && !dispatches.pending.login && !dispatches.pending.resume
    && !dispatches.pending.service && !dispatches.pending.manual && !dispatches.pending.limit && !heartbeatPending && !runActive()
    && features.settledForMaintenance() && !(latest?.connected && latest.player && Date.now()-receivedAt>=7000);
}


async function featureRequest(action: string, request: unknown): Promise<unknown> {
  if (!native || updateBusy || busy || dispatches.stopping || loginBusy || !latest?.connected || !latest.compatible || !latest.player || (action==='service'?features.serviceBlocked():(action==='warp'||action==='warpPreview')&&features.warpActivationReady()?fieldRun.requested:runActive()) || Date.now()-receivedAt >= 7000) {
    throw new Error('Stop automation and connect a verified character before sending a manual command.');
  }
  busy=true;updateButtons();
  try {
    const result = (await dispatches.feature(action, request)).outcome;
    if (result.status === 'failed') throw result.error;
    if (result.status === 'retired') throw new Error(action === 'service' ? 'Service request canceled by Stop.'
      : action === 'macro' ? 'Macro request canceled by Stop.' : 'Stop automation and connect a verified character before sending a manual command.');
    return result.value;
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
  element('death-cap').textContent = dashboardSettings ? clientDeathCap(dashboardSettings.automation?.respawn) : '—';
  if(!closeRegistered||closeBusy||updateBusy){botConsole.lock(true,closeBusy?'Saving current settings before closing.':!closeRegistered?'Preparing saved settings.':'Client update in progress. Manual actions are locked.');for(const input of document.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement|HTMLTextAreaElement>('input,select,button,textarea'))if(!navigation.has(input as HTMLButtonElement))input.disabled=true;features.lock(true,true,true);if(updateBusy&&!closeBusy)stopButton.disabled=dispatches.stopping||updateStopped;return;}
  form.refresh();
  const ready = native && fresh && latest?.connected && latest.compatible && latest.player;
  let checked:Settings|null = null;
  try { checked=validateSettings(form.runSettings()); configHelp.textContent=''; }
  catch(error) { configHelp.textContent=ready && error instanceof Error ? error.message : ''; }
  startButton.disabled = !canStartField({native,fresh,busy,stopping:dispatches.stopping,loginBusy,runActive:runActive(),connected:latest?.connected===true,compatible:latest?.compatible===true,
    map:latest?.map??'',player:latest?.player??null,settings:checked});
  stopButton.disabled = dispatches.stopping || !gameOpen && !fieldRun.requested && !loginBusy && !updateContinuation.pending;
  openButton.disabled = false;
  element<HTMLButtonElement>('disconnect').disabled = !disconnectReady();
  botConsole.lock(busy || dispatches.stopping || loginBusy || !ready || runActive() || !features.settledForMaintenance(), !native ? 'Browser preview · native connection required.' : busy || dispatches.stopping || loginBusy ? 'Wait for the current request to finish.' : !ready ? 'Connect a fresh verified character to use manual controls.' : runActive() || !features.settledForMaintenance() ? 'Stop the bot; wait for pending actions before manual control.' : '');
  element<HTMLButtonElement>('signin').disabled = !native || !accountReady || busy || dispatches.stopping || loginBusy || !!(latest?.connected && latest.player);
  element<HTMLButtonElement>('forget-login').disabled = busy || dispatches.stopping || loginBusy;
  for (const id of ['username', 'password', 'character-slot', 'remember-login']) {
    element<HTMLInputElement>(id).disabled = !accountReady || busy || dispatches.stopping || loginBusy;
  }
  element<HTMLSelectElement>('connection-mode').disabled = !accountReady || gameOpen || busy || dispatches.stopping || loginBusy;
  element<HTMLInputElement>('auto-login').disabled = busy || dispatches.stopping || loginBusy || !element<HTMLInputElement>('remember-login').checked;
  element<HTMLInputElement>('auto-reconnect').disabled = busy || dispatches.stopping || loginBusy || !sessionLoginAvailable;
  features.lock(busy || dispatches.stopping || loginBusy || runActive(),busy || dispatches.stopping || loginBusy || !ready || runActive(),busy || dispatches.stopping || loginBusy || !ready || features.serviceBlocked(),busy || dispatches.stopping || loginBusy || !ready || fieldRun.requested);
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
  if (!native || !accountReady || updateBusy || busy || dispatches.stopping || loginBusy || latest?.connected && latest.player) return;
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
    const task = dispatches.login({
      credentials: reuse ? null : { username, password: password.value, characterSlot },
      characterSlot, remember, autoLogin, mode,
    });
    password.value = '';
    const result = (await task).outcome;
    if (result.status === 'retired') return;
    if (result.status === 'failed') {
      previousSession = undefined;
      loginBusy = false;
      message(typeof result.error === 'string' ? result.error : 'Could not start automatic sign-in.', true);
      return;
    }
    gameOpen = true;accountBaseline=accountFields();
    if (remember) showSavedLogin({ username, characterSlot, autoLogin, mode });
    message(mode==='botOnly'?'Opening bot connection for sign-in…':'Loading the game client for sign-in…');
  } finally { updateButtons(); }
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
  if (!latest?.player || dispatches.stopping) return;
  const checked = validateSettings(form.runSettings());
  const task = dispatches.start(checked, latest);
  configureReconnect();
  reconnect.observe(latest.connected, true, latest.login.phase, Date.now(), latest.login.message);
  const result = (await task).outcome;
  if (result.status === 'failed') {
    configureReconnect();
    message(typeof result.error === 'string' ? result.error : 'Unable to contact the game.', true);
  }
}));
stopButton.addEventListener('click', () => {
  if (dispatches.stopping) return;
  updateStopped=true;
  // Cancel native restart authority before dispatching Stop through admission.
  // Local ownership retires immediately, even if replacement already started.
  const cancel=updateContinuation.cancel(true).catch(()=>{});
  const task = dispatches.stop(cancel);
  loginBusy = false; previousSession = undefined;
  updateButtons();
  void task.then(receipt => {
    const result = receipt.outcome;
    if (result.status === 'accepted') message('Bot stopped.');
    else if (result.status === 'failed') message('Run cancelled. The game controller is unavailable.');
  }).finally(updateButtons);
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
  if(updateContinuation.pending&&!updateBusy&&!closeBusy&&!loginBusy&&!dispatches.stopping){
    void updateContinuation.resume(s,accountSelection(),fieldRun).then(resumed=>{
      if(resumed){configureReconnect();message('Update complete. Continuing with the same settings and remaining limits.');updateButtons();}
    }).catch(()=>message(updateContinuation.confirmationLost?'The game did not confirm continuation. Press Stop before starting again.':'Update restored your settings. Waiting for verified character data; Stop cancels continuation.',true));
  }
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
  activityLog.render(s.log);
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
  await listen<unknown>('update-prepared', event=>updateContinuation.prepared(event.payload));
  await listen<unknown>('update-restored', event=>updateContinuation.restored(event.payload));
  await listen('game-closed', () => {
    features.clearSocial();
    features.clearMemo();
    features.clearMacro();
    if(!updateBusy&&!updateContinuation.pending){void updateContinuation.cancel().catch(()=>{});dispatches.gameClosed();}
    else reconnect.cancel();
    sessionLoginAvailable = false; previousSession = undefined;
    gameOpen = false; latest = null; receivedAt = 0; loginBusy = false;
    form.refresh();
    element('status').textContent = 'OFFLINE'; element('status').classList.remove('active'); element('status').dataset.state = 'OFFLINE';
    element('character').textContent='No character connected'; element('location').textContent='Connect an account to load your character.';
    element('character').title='No character connected'; element('location').title='Connect an account to load your character.';
    element('hp-text').textContent='— / —'; element('hp-bar').style.width='0%'; element('sp-text').textContent='— / —'; element('sp-bar').style.width='0%'; element('death-count').textContent='—';
    for (const id of ['attacks','kills','looted','nearby']) element(id).textContent='0'; element('map-label').textContent='WAITING'; element('target-label').textContent='No active target';
    activityLog.render([], 'Session activity will appear after connection.');
    message('Disconnected. Select an account and character to connect again.'); botConsole.render(null); updateButtons();
  });
  try {
    try{currentForm.restore(await invoke('current_form'), document => form.restore(document));}
    catch{currentForm.initialized=false;element('update-status').textContent='Current settings could not be restored. Automatic updates are waiting.';}
    if(currentForm.initialized){
      if(await invoke<boolean>('update_startup_stopped'))updateStopped=true;
      try{await claimUpdateContinuation(invoke('update_continuation'));}
      catch{message('Update settings restored. The run could not be verified; start the bot explicitly.',true);}
      await currentForm.flush().catch(()=>{element('update-status').textContent='Updates are waiting for valid, saved current settings.';});
    }
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
      if(!updateContinuation.pending){accountBaseline=accountFields();if (profile.autoLogin&&!closeBusy&&!updateStopped) await signIn();}
    }
    if(updateContinuation.pending){
      selectUpdateAccount();accountBaseline=accountFields();
      if(updateContinuation.automaticLogin(profile?{...profile,mode:profile.mode??'gameClient'}:null)&&!closeBusy&&!updateStopped)await signIn();
      else message('Update complete. Settings restored. Sign in to the same account and character to continue.');
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
    const retry = !closeBusy && !updateBusy && gameOpen && !busy && !dispatches.stopping && !loginBusy && !(latest?.connected && latest.player)
      && !fieldRun.limitReason ? reconnect.takeDue(Date.now()) : null;
    if (retry !== null) {
      loginBusy = true; loginStartedAt = Date.now(); previousSession = latest?.sessionId; updateButtons();
      message(`Reconnecting · attempt ${retry}. ${fieldRun.requested ? 'The bot will resume when your character is ready.' : 'Combat remains stopped.'}`);
      void dispatches.reconnect().then(receipt => {
        const result = receipt.outcome;
        if (result.status === 'accepted') gameOpen = true;
        else if (result.status === 'failed') {
          previousSession = undefined; loginBusy = false;
          message(reconnect.requiresSignIn ? 'Waiting for you to sign in again before resuming.' : 'Reconnect could not restore the connection. Waiting before trying again.', true);
        }
      }).finally(updateButtons);
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

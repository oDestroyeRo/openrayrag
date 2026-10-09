import {
  accountHasDraft,
  panelUpdateWaitReason,
  panelDisconnectReady,
  panelControls,
} from '../modules/client/runtime-panel-policy';
import { CurrentForm } from '../modules/settings/current-form';
import { SettingsClose } from '../modules/settings/settings-close';
import { BotConsole } from '../modules/client/bot-console';
import { consoleNpcs, consolePlayerShops } from '../modules/client/bot-console-logic';
import { ActivityLog } from '../modules/client/activity-log';
import { ClientAttention } from '../modules/client/client-attention';
import { clientAttention } from '../modules/client/client-attention-logic';
import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import {
  validateSettings,
  type SettingsInput,
  type RunSettings,
} from '../modules/settings/settings';
import { FeatureUi } from '../modules/client/feature-ui';
import { macroBaseSettings } from '../modules/automation/macro-ui';
import { ReconnectPolicy, PersistentFieldRun } from '../modules/session/reconnect';
import { RunIntentDispatch } from '../modules/session/run-intent-dispatch';
import {
  UpdateContinuationOwner,
  type UpdateAccount,
  type UpdateContinuation,
} from '../modules/update/update-continuation';
import {
  validStatus,
  statusHeartbeatFresh,
  type GameStatus,
  type ValidatedGameStatus,
} from '../modules/client/game-status';
import { SettingsForm, type SettingsFormProjection } from '../modules/settings/settings-form';
import { normalAttackProfile } from '../modules/combat/combat';
import { canStartField } from '../modules/settings/field-controls';
import { farmingDestination } from '../modules/recovery/death-recovery';
import { mountClientShell } from '../modules/client/client-shell';
import { EmbeddedGameView, gameViewBounds } from '../modules/client/game-view';
import {
  clientStatus,
  clientSp,
  clientDeaths,
  clientDeathCap,
} from '../modules/client/client-status';
import { clientDashboard } from '../modules/client/client-dashboard';
import { FarmingReadiness, navigateFarmingReadiness } from '../modules/client/farming-readiness';
import { farmingReadiness } from '../modules/client/farming-readiness-logic';
import { liveSettingLabel, planLiveSettings } from '../modules/settings/live-settings-logic';
import { mountMcp } from '../modules/mcp/mcp-client';
import {
  mcpReadResult,
  mcpWriteTool,
  retainedMcpObservation,
  type McpQuery,
  type McpObservation,
} from '../modules/mcp/mcp-logic';
import { McpControl } from '../modules/mcp/mcp-control';
import { mcpPreview } from '../modules/mcp/mcp-preview';
import { validateLoginProfile } from '../modules/session/login-logic';
import type { FormSnapshot } from '../modules/settings/settings-form-logic';
import '../modules/client/client-shell.css';

const root = document.querySelector<HTMLDivElement>('#app')!;
const shell = mountClientShell(root);

function element<T extends HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}
element('update-download').addEventListener('click', (event) => {
  if (!isTauri()) return;
  event.preventDefault();
  void invoke('update_open_release').catch(() =>
    message('Could not open the release download. Visit the repository Releases page.', true),
  );
});
const openButton = element<HTMLButtonElement>('open');
const startButton = element<HTMLButtonElement>('start');
const stopButton = element<HTMLButtonElement>('stop');
const liveSettingsPanel = document.createElement('section');
liveSettingsPanel.className = 'panel live-settings-panel';
const liveSettingsTitle = document.createElement('h3');
liveSettingsTitle.textContent = 'Saved draft & active run';
const applySettingsButton = document.createElement('button');
applySettingsButton.id = 'apply-run-settings';
applySettingsButton.type = 'button';
applySettingsButton.className = 'secondary compact';
applySettingsButton.textContent = 'Apply to current run';
const liveSettingsStatus = document.createElement('p');
liveSettingsStatus.id = 'live-settings-status';
liveSettingsStatus.className = 'hint';
liveSettingsStatus.setAttribute('role', 'status');
liveSettingsStatus.setAttribute('aria-live', 'polite');
const liveSettingsHelp = document.createElement('p');
liveSettingsHelp.className = 'hint';
liveSettingsHelp.textContent =
  'Form edits save as a separate draft. Live Apply supports combat targets, scan radius, loot and HP/SP recovery. Lower reserves or cooldowns, limits/schedules, map/travel, supply spending, equipment/allocation, macro/service rules and whole profiles are Next run.';
const liveSettingsDetails = document.createElement('details');
const liveSettingsSummary = document.createElement('summary');
liveSettingsSummary.textContent = 'What can apply during a run?';
liveSettingsDetails.append(liveSettingsSummary, liveSettingsHelp);
liveSettingsPanel.append(
  liveSettingsTitle,
  liveSettingsStatus,
  applySettingsButton,
  liveSettingsDetails,
);
element('client-page-bot').prepend(liveSettingsPanel);
const savedDraftSummary = element('console-saved-draft-summary');
const editSetupButton = element<HTMLButtonElement>('console-edit-setup');
let currentTargetsNeedAttention = false;
editSetupButton.addEventListener('click', () => {
  if (!currentTargetsNeedAttention) return;
  element<HTMLButtonElement>('setup-tab-form').click();
  shell.showBotSection('combat');
});
const activityLog = new ActivityLog(element('log'));
const readiness = new FarmingReadiness(
  element<HTMLDetailsElement>('console-readiness'),
  element('console-readiness-summary'),
  element('console-readiness-list'),
  (action) => navigateFarmingReadiness(action, shell.main, shell),
);
const attention = new ClientAttention(
  element('console-attention'),
  element('console-attention-list'),
  (action) => {
    if (action === 'account') {
      shell.showPage('settings');
      element<HTMLDetailsElement>('signin-panel').open = true;
      element<HTMLInputElement>('username').focus();
    } else if (action === 'tools') shell.showPage('manual');
    else {
      shell.showPage('bot');
      if (action === 'recovery' || action === 'limits' || action === 'supply') {
        element<HTMLButtonElement>('setup-tab-form').click();
        shell.showBotSection(
          action === 'recovery' ? 'recovery' : action === 'supply' ? 'travel' : 'workflows',
        );
        if (action === 'supply') {
          element<HTMLDetailsElement>('setup-travel-advanced').open = true;
          const output = element('supply-preview');
          output.tabIndex = -1;
          output.focus();
          output.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  },
);
const native = isTauri();
let closeRegistered = !native;
let closeBusy = false;
let closeStatus: string | null = null;
root.inert = native;
interface SavedLogin {
  username: string;
  characterSlot: number;
  autoLogin: boolean;
  mode?: 'botOnly' | 'gameClient';
}
let savedLogin: SavedLogin | null = null;
let loginBusy = false;
let loginStartedAt = 0;
let accountReady = !native;
let accountBaseline: string | null = null;
function accountFields(): string {
  return JSON.stringify(
    ['username', 'character-slot', 'connection-mode']
      .map((id) => element<HTMLInputElement>(id).value)
      .concat(
        ['remember-login', 'auto-login'].map((id) => String(element<HTMLInputElement>(id).checked)),
      ),
  );
}
function accountDraft(): boolean {
  return accountHasDraft(
    element<HTMLInputElement>('password').value,
    accountFields(),
    accountBaseline,
  );
}
let updateBusy = false;
let updateSettled: Promise<void> = Promise.resolve();
let updateFinished: () => void = () => {};
let updatePolling = false;
let saveTimer: ReturnType<typeof setTimeout> | undefined;
let gameOpen = false;
let latest: ValidatedGameStatus | null = null;
let receivedAt = 0;
let mcpObservation: McpObservation | null = null;
let mcpDraftRevision = 0;
function touchMcpDraft(): void {
  mcpDraftRevision++;
}
let busy = false;
let heartbeatPending = false;
let previousSession: string | undefined;
const gameViewport = element('client-game-viewport');
const gameView = new EmbeddedGameView({
  bounds: () =>
    gameViewBounds(
      gameViewport.getBoundingClientRect(),
      { width: globalThis.innerWidth, height: globalThis.innerHeight },
      shell.main.querySelector<HTMLElement>('.client-toolbar')!.getBoundingClientRect().bottom,
    ),
  present: (bounds) => invoke('set_game_view', { bounds }),
  changed: (shown) => {
    element('client-game-placeholder').hidden = shown;
  },
  error: () => message('Could not display Game. Switch to Bot and try Game again.', true),
});
function syncGameView(): void {
  const mode = latest?.connectionMode ?? element<HTMLSelectElement>('connection-mode').value;
  const available = native && gameOpen && mode === 'gameClient';
  element('client-game-help').textContent = !native
    ? 'Open the desktop app to use the Game view.'
    : gameOpen && mode === 'botOnly'
      ? 'This connection uses Bot only. Disconnect and choose With game client to use Game and Bot with the same login.'
      : 'Choose With game client in Account & character to use Game and Bot with the same login.';
  gameView.setVisible(
    available && shell.page === 'game' && closeRegistered && !closeBusy && !updateBusy,
  );
}
shell.onPageChange(syncGameView);
globalThis.addEventListener?.('resize', () => gameView.refresh());
globalThis.addEventListener?.('scroll', () => gameView.refresh(), { passive: true, capture: true });
if (typeof ResizeObserver !== 'undefined') {
  const observer = new ResizeObserver(() => gameView.refresh());
  observer.observe(gameViewport);
  observer.observe(shell.main.querySelector<HTMLElement>('.client-toolbar')!);
}
const reconnect = new ReconnectPolicy();
const fieldRun = new PersistentFieldRun();
let sessionLoginAvailable = false;
const dispatches = new RunIntentDispatch(fieldRun, reconnect, (command, args) =>
  invoke(command, args),
);
const updateContinuation = new UpdateContinuationOwner((command, args) => invoke(command, args));
function accountSelection(): UpdateAccount {
  return {
    username: element<HTMLInputElement>('username').value.trim(),
    characterSlot: Number(element<HTMLSelectElement>('character-slot').value),
    mode: element<HTMLSelectElement>('connection-mode').value as UpdateAccount['mode'],
  };
}
function selectUpdateAccount(): void {
  const account = updateContinuation.account;
  if (!account) return;
  element<HTMLInputElement>('username').value = account.username;
  element<HTMLSelectElement>('character-slot').value = String(account.characterSlot);
  element<HTMLSelectElement>('connection-mode').value = String(account.mode);
  const savedMatches =
    !!savedLogin &&
    savedLogin.username === account.username &&
    savedLogin.characterSlot === account.characterSlot &&
    (savedLogin.mode ?? 'gameClient') === account.mode;
  element<HTMLInputElement>('remember-login').checked = savedMatches;
  element<HTMLInputElement>('auto-login').checked = savedMatches && savedLogin!.autoLogin;
}
function presentUpdateContinuation(continuation: UpdateContinuation | null): void {
  if (!continuation || updateContinuation.stopped || !updateContinuation.pending) return;
  form.restore(continuation.form);
  selectUpdateAccount();
  accountBaseline = accountFields();
  message(
    'Update complete. Settings restored. Waiting for the same account and character to continue.',
  );
  updateButtons();
}
function runActive(): boolean {
  return (
    updateContinuation.pending ||
    fieldRun.requested ||
    !!latest?.runRequested ||
    !!latest?.running ||
    features.active()
  );
}
function configureReconnect(): void {
  reconnect.configure(
    fieldRun.requested || element<HTMLInputElement>('auto-reconnect').checked,
    sessionLoginAvailable,
    fieldRun.requested,
  );
}
function holdAtRunLimit(): void {
  if (updateBusy) return;
  const task = dispatches.holdAtRunLimit(gameOpen);
  if (task) void task.finally(updateButtons);
}
function resumeFieldRun(s: GameStatus): void {
  if (
    !native ||
    closeBusy ||
    updateBusy ||
    updateContinuation.pending ||
    busy ||
    dispatches.stopping ||
    loginBusy ||
    dispatches.pending.resume
  )
    return;
  holdAtRunLimit();
  const task = dispatches.resume(s);
  if (!task) return;
  void task
    .then((receipt) => {
      const result = receipt.outcome;
      if (result.status === 'failed')
        message('Waiting to reach the game controller before resuming.');
    })
    .finally(updateButtons);
}
const features = new FeatureUi(
  shell.main,
  {
    settings: () => form.runSettings(),
    apply: (value) => form.applyProfile(value),
    map: () => latest?.map ?? '',
    character: () => latest?.player?.name ?? '',
    remainingSupplyTrips: () =>
      fieldRun.readinessFor(latest?.player?.name ?? '').remainingSupplyTrips,
    macroSettings: () => form.snapshot().settings,
    applySetup: (value) => form.applySettings(value),
    setupChanged: () => {
      touchMcpDraft();
      updateButtons();
    },
    definitionsChanged: () => {
      touchMcpDraft();
      updateButtons();
    },
    command: (request) => featureRequest('command', request),
    workflow: (request) => featureRequest('workflow', request),
    routine: (request) => featureRequest('routine', request),
    macro: (request) => featureRequest('macro', request),
    service: (request) => featureRequest('service', request),
    social: (request) => featureRequest('social', request),
    memo: (request) => featureRequest('memo', request),
    socketPreview: (request) => featureRequest('socketPreview', request),
    socket: (request) => featureRequest('socket', request),
    warp: (request) => featureRequest('warp', request),
    warpPreview: (request) => featureRequest('warpPreview', request),
    warpCancel: () => invoke('control_bot', { action: 'warpCancel', request: {} }),
    refinePreview: (request) => featureRequest('refinePreview', request),
    refine: (request) => featureRequest('refine', request),
    refineAdvance: (promptToken) => featureRequest('refineAdvance', { promptToken }),
    notify: message,
    stop: () => {
      void stopBot();
    },
    changed: () => {
      formChanged();
      updateButtons();
    },
  },
  shell,
);
shell.refreshManualIndex();
const form = new SettingsForm(shell.main, features, {
  context: () => ({
    sessionId: latest?.sessionId ?? '',
    mapInfo: latest?.mapInfo ?? { code: '', name: '', source: 'observed', monsters: [] },
    level: latest?.player?.level ?? null,
    runActive: runActive(),
    controlsLocked: !closeRegistered || closeBusy || updateBusy || dispatches.stopping,
    targetsLocked:
      !closeRegistered ||
      closeBusy ||
      updateBusy ||
      dispatches.stopping ||
      (!runActive() &&
        (!native ||
          Date.now() - receivedAt >= 7000 ||
          !latest?.connected ||
          !latest.compatible ||
          !latest.player)) ||
      features.setupDraftDirty(),
  }),
  changed: () => {
    formChanged();
    updateButtons();
  },
});
const currentForm = new CurrentForm(
  () => form.snapshot(),
  (document) => invoke<number>('save_current_form', { document }),
);
let formRestored: () => void = () => {};
const restoreSettled = new Promise<void>((resolve) => {
  formRestored = resolve;
});
const settingsClose = new SettingsClose({
  settled: async () => {
    await restoreSettled;
    await updateSettled;
    if (!currentForm.initialized)
      currentForm.restore(await invoke('current_form'), (document) => form.restore(document));
  },
  flush: () => currentForm.flush(),
  unchanged: (document) =>
    JSON.stringify(form.snapshot()) ===
    JSON.stringify({ settings: document.settings, selectedProfileId: document.selectedProfileId }),
  complete: async (token, revision) => {
    if (features.hasUnsavedMacro()) throw new Error('Script changes have not been saved.');
    await invoke('settings_close_complete', { token, revision });
  },
  cancel: (token) => invoke('settings_close_cancel', { token }),
  lock: (locked) => {
    closeBusy = locked;
    root.inert = locked || !closeRegistered;
    if (locked && saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    updateButtons();
  },
  status: (status) => {
    if (status.startsWith('Close cancelled') && features.hasUnsavedMacro())
      status =
        'Close cancelled: your Script changes are not saved. Correct the script and retry Save script, or copy it and Discard draft, then close again.';
    closeStatus = status;
    element('update-status').textContent = status;
    message(status, status.startsWith('Close cancelled'));
  },
});
function formChanged(): void {
  touchMcpDraft();
  currentForm.touch();
  if (!closeBusy) closeStatus = null;
  if (!native || !currentForm.initialized || closeBusy || updateBusy) return;
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    void currentForm.flush().catch(() => {
      element('update-status').textContent =
        'Updates are waiting for valid, saved current settings.';
    });
  }, 300);
}
function pendingRequests() {
  const pending = dispatches.pending;
  return {
    login: !!pending.login,
    resume: !!pending.resume,
    service: !!pending.service,
    manual: !!pending.manual,
    limit: !!pending.limit,
  };
}
function mainUpdateWaitReason(): string | null {
  if (fieldRun.settingsApplyPending || latest?.settingsApply?.state === 'pending')
    return 'Waiting for Apply to current run to settle. Stop cancels the pending Apply.';
  return panelUpdateWaitReason({
    closeRegistered,
    closeBusy,
    accountReady,
    formInitialized: currentForm.initialized,
    accountDraft: accountDraft(),
    updateBusy,
    busy,
    stopping: dispatches.stopping,
    loginBusy,
    heartbeatPending,
    pending: pendingRequests(),
    unsavedMacro: features.hasUnsavedMacro(),
    continuationPending: updateContinuation.pending,
    featuresSettled: features.settledForMaintenance(true),
    reconnectScheduled: !!reconnect.waitingUntil,
  });
}
element('update-check').addEventListener('click', () => {
  void pollUpdate(true);
});
async function pollUpdate(requested = false): Promise<void> {
  if (
    !native ||
    !closeRegistered ||
    closeBusy ||
    (closeStatus && !requested) ||
    updatePolling ||
    updateBusy
  )
    return;
  if (requested) closeStatus = null;
  updatePolling = true;
  updateButtons();
  try {
    const state = await invoke<{
      version: string;
      platform?: string;
      phase: string;
      message: string;
      availableVersion: string | null;
    }>(requested ? 'update_check' : 'update_status');
    element('client-version').textContent =
      `${({ macos: 'macOS', windows: 'Windows', linux: 'Linux' } as Record<string, string>)[state.platform ?? ''] ?? 'Desktop'} · v${state.version}`;
    if (closeBusy || closeStatus) return;
    element('update-status').textContent = state.message;
    if (state.phase !== 'waiting') return;
    const waiting = mainUpdateWaitReason();
    if (waiting) {
      element('update-status').textContent = waiting;
      return;
    }
    updateBusy = true;
    updateSettled = new Promise((resolve) => {
      updateFinished = resolve;
    });
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = undefined;
    }
    try {
      const installation = updateContinuation.install(fieldRun, {
        flush: () => currentForm.flush(),
        game: () => ({ open: gameOpen, status: latest }),
        interrupted: () => closeBusy,
        status: (text) => {
          if (!closeStatus) element('update-status').textContent = text;
        },
      });
      updateButtons();
      const result = await installation;
      presentUpdateContinuation(result.continuation);
      if (result.recoveryFailed)
        message('The update could not continue the run. Start the bot explicitly.', true);
      if (result.retired) dispatches.gameClosed();
    } finally {
      updateBusy = false;
      updateFinished();
      updateButtons();
      if (
        updateContinuation.pending &&
        updateContinuation.automaticLogin(
          savedLogin ? { ...savedLogin, mode: savedLogin.mode ?? 'gameClient' } : null,
        )
      )
        void signIn();
    }
  } catch {
    element('update-status').textContent = 'Update check unavailable. It will retry automatically.';
  } finally {
    updatePolling = false;
    updateButtons();
  }
}
const configHelp = element('config-help');
async function applyCurrentSettings(mcpOperation?: string): Promise<Record<string, unknown>> {
  if (
    !latest ||
    !fieldRun.requested ||
    !latest.runRequested ||
    dispatches.stopping ||
    features.setupDraftDirty() ||
    fieldRun.settingsApplyPending ||
    latest.settingsApply?.state === 'pending' ||
    Date.now() - receivedAt >= 7000
  )
    throw new Error('Current run settings are not ready for Apply.');
  const proposal = form.snapshot().settings;
  const active = latest.activeSettings ?? fieldRun.activeSettings;
  if (!active) throw new Error('Active run settings are unavailable.');
  planLiveSettings(
    active,
    proposal,
    active,
    latest.liveSettingsGuard ?? fieldRun.liveSettingsGuard,
  );
  const id = crypto.randomUUID().replaceAll('-', '');
  const result = (await dispatches.applySettings(proposal, latest, id, mcpOperation)).outcome;
  if (result.status === 'failed') throw result.error;
  return {
    dispatch: result.status,
    applyId: id,
    confirmation: 'Read get_status.receipts.settingsApply for game confirmation.',
  };
}
applySettingsButton.addEventListener(
  'click',
  () =>
    void perform(async () => {
      const result = await applyCurrentSettings();
      if (result.dispatch === 'accepted')
        message('Settings Apply requested. Waiting for the current action confirmation.');
    }),
);
const botConsole = new BotConsole(shell.main, {
  settings: () => form.runSettings(),
  command: (request) => featureRequest('command', request),
  notify: message,
  account: () => {
    shell.showPage('settings');
    element<HTMLDetailsElement>('signin-panel').open = true;
    element<HTMLInputElement>('username').focus();
  },
  lootSettings: () => {
    shell.showPage('bot');
    shell.showBotSection('inventory');
  },
  manualTools: () => shell.showPage('manual'),
  playerShop: (id) => {
    shell.showPage('manual');
    element<HTMLInputElement>('vending-seller').value = String(id);
    element<HTMLDetailsElement>('player-vending-panel').open = true;
    element('vending-state').scrollIntoView({ block: 'nearest' });
  },
  npcDialogue: (id) => {
    shell.showPage('manual');
    element<HTMLInputElement>('npc-id').value = String(id);
    element<HTMLDetailsElement>('npc-dialogue-panel').open = true;
    element('npc-dialogue').scrollIntoView({ block: 'nearest' });
  },
});
function disconnectReady(): boolean {
  return panelDisconnectReady({
    native,
    gameOpen,
    accountReady,
    updateBusy,
    busy,
    stopping: dispatches.stopping,
    loginBusy,
    pending: pendingRequests(),
    heartbeatPending,
    runActive: runActive(),
    featuresSettled: features.settledForMaintenance(),
    connectedCharacter: !!(latest?.connected && latest.player),
    statusAgeMs: Date.now() - receivedAt,
  });
}

async function featureRequest(
  action: string,
  request: unknown,
  mcpOperation?: string,
): Promise<unknown> {
  if (
    !native ||
    !closeRegistered ||
    closeBusy ||
    updateBusy ||
    busy ||
    (mcpControls.busy && !mcpOperation) ||
    dispatches.stopping ||
    loginBusy ||
    !latest?.connected ||
    !latest.compatible ||
    !latest.player ||
    (action === 'service'
      ? features.serviceBlocked()
      : (action === 'warp' || action === 'warpPreview') && features.warpActivationReady()
        ? fieldRun.requested
        : runActive()) ||
    Date.now() - receivedAt >= 7000
  ) {
    throw new Error(
      'Stop automation and connect a verified character before sending a manual command.',
    );
  }
  busy = true;
  updateButtons();
  try {
    const result = (await dispatches.feature(action, request, mcpOperation)).outcome;
    if (result.status === 'failed') throw result.error;
    if (result.status === 'retired')
      throw new Error(
        action === 'service'
          ? 'Service request canceled by Stop.'
          : action === 'macro'
            ? 'Macro request canceled by Stop.'
            : 'Stop automation and connect a verified character before sending a manual command.',
      );
    return result.value;
  } finally {
    busy = false;
    updateButtons();
  }
}

function message(text: string, error = false): void {
  if (closeStatus) {
    text = closeStatus;
    error = closeStatus.startsWith('Close cancelled');
  }
  element('notice').textContent = text;
  element('notice').classList.toggle('error', error);
}
function updateButtons(projection: SettingsFormProjection = form.project()): void {
  syncGameView();
  let dashboardSettings: SettingsInput | null = null;
  let formError: unknown = null;
  try {
    dashboardSettings = projection.snapshot().settings;
  } catch (error) {
    formError = error; /* Keep invalid drafts editable on Setup. */
  }
  if (dashboardSettings) features.syncSetup(dashboardSettings);
  const fresh = Date.now() - receivedAt < 7000;
  const ready = native && fresh && latest?.connected && latest.compatible && latest.player;
  let startSettings: SettingsInput | null = null,
    checked: RunSettings | null = null;
  let scripted = false,
    setupReason = '';
  try {
    if (!dashboardSettings)
      throw formError ?? new Error('Finish valid Form settings before Start.');
    const document = features.setupDocument();
    scripted = document.script !== null;
    startSettings = projection.startSettings();
    checked = document.script
      ? macroBaseSettings(document.settings, document.script)
      : validateSettings(startSettings);
  } catch (error) {
    setupReason =
      error instanceof Error ? error.message : 'Finish valid Form settings before Start.';
  }
  configHelp.textContent = ready || !dashboardSettings ? setupReason : '';
  const activeSettings = runActive() ? (latest?.activeSettings ?? fieldRun.activeSettings) : null;
  const dashboard = clientDashboard(
    latest,
    {
      fieldRequested: fieldRun.requested,
      held: features.active(),
      limitReason: fieldRun.limitReason,
      loginBusy,
      fresh,
      setupReason: ready && !runActive() ? setupReason : '',
      activeRun: !!activeSettings,
    },
    activeSettings ?? (scripted ? dashboardSettings : (startSettings ?? dashboardSettings)),
    latest?.mapInfo,
  );
  element('status').textContent = dashboard.state;
  element('status').classList.toggle('active', dashboard.state === 'RUNNING');
  element('status').dataset.state = dashboard.state;
  element('client-run-title').textContent = dashboard.headline;
  attention.render(
    clientAttention(
      latest,
      {
        fresh,
        fieldRequested: fieldRun.requested,
        held: features.active(),
        limitReason: fieldRun.limitReason,
        loginBusy,
        setupReason: !runActive() && (ready || !dashboardSettings) ? setupReason : '',
      },
      activeSettings ?? dashboardSettings,
    ),
  );
  const navigation = new Set(
    shell.main.querySelectorAll<HTMLButtonElement>(
      'button[data-client-page-nav], button[data-client-bot-nav], button[data-client-inspector-nav], button[data-client-navigation], #client-manual-index > button',
    ),
  );
  // Step boundaries are owned by the retained Setup navigation.
  for (const button of navigation)
    if (button.dataset.clientNavigation !== 'setup-step') button.disabled = false;
  if (dashboard.state === 'LIMIT') message(dashboard.reason);
  const entryDestination = startSettings ? farmingDestination(startSettings) : '';
  const entrySummary =
    !activeSettings &&
    !scripted &&
    startSettings?.automation?.follow.mode !== 'partyLeader' &&
    entryDestination &&
    entryDestination !== latest?.map
      ? `Travel to ${entryDestination} · `
      : '';
  element('console-setup-summary').textContent =
    `${activeSettings ? 'Active run: ' : entrySummary}${dashboard.setup}`;
  const retainedDiffers =
    !!dashboardSettings &&
    !!startSettings &&
    (dashboardSettings.map !== startSettings.map ||
      dashboardSettings.targets.join(',') !== startSettings.targets.join(','));
  savedDraftSummary.hidden = !activeSettings && !retainedDiffers;
  savedDraftSummary.textContent = `${activeSettings ? 'Saved draft' : `Retained choices for ${dashboardSettings?.map || 'the configured field'}`}: ${clientDashboard(latest, { fieldRequested: false, held: false, limitReason: '', loginBusy: false }, dashboardSettings, latest?.mapInfo).setup}`;
  const retainedReadiness = fieldRun.readinessFor(latest?.player?.name ?? '');
  const readinessContext = {
    fresh,
    remainingSupplyTrips: retainedReadiness.remainingSupplyTrips,
    reconnectEnabled: element<HTMLInputElement>('auto-reconnect').checked,
    reconnectAvailable: sessionLoginAvailable,
  };
  readiness.render([
    ...(activeSettings
      ? [
          {
            label: 'Active run · retained remaining allowances',
            rows: farmingReadiness(fieldRun.activeSettings ?? activeSettings, latest, {
              ...readinessContext,
              active: true,
              used: retainedReadiness.used ?? {
                elapsedSeconds: latest?.elapsedSeconds ?? 0,
                kills: latest?.kills ?? 0,
                pickups: latest?.looted ?? 0,
                deaths: latest?.deaths ?? 0,
              },
            }),
          },
        ]
      : []),
    {
      label: activeSettings ? 'Saved draft · next explicit Start' : 'Before Start · saved setup',
      rows: farmingReadiness(dashboardSettings, latest, { ...readinessContext, active: false }),
    },
  ]);
  currentTargetsNeedAttention =
    !!ready &&
    !runActive() &&
    !scripted &&
    !checked &&
    !!startSettings &&
    !startSettings.targets.length &&
    ['selected', 'both'].includes(startSettings.automation?.combat.mode ?? '');
  editSetupButton.textContent = currentTargetsNeedAttention
    ? 'Choose current-field targets'
    : 'Edit setup';
  const receipt = latest?.settingsApply;
  const lines: string[] = [];
  const lostApply = fieldRun.settingsApplyWaitReason(latest?.sessionId ?? '');
  if (lostApply) lines.push(lostApply);
  if (receipt) {
    lines.push(`${receipt.state[0]!.toUpperCase()}${receipt.state.slice(1)}: ${receipt.reason}`);
    if (receipt.applied.length)
      lines.push(`Applied: ${receipt.applied.map(liveSettingLabel).join(', ')}`);
    if (receipt.pending.length)
      lines.push(`Pending: ${receipt.pending.map(liveSettingLabel).join(', ')}`);
    if (receipt.nextRun.length)
      lines.push(`Last Apply · Next run: ${receipt.nextRun.map(liveSettingLabel).join(', ')}`);
  }
  let liveValid = false;
  if (activeSettings && dashboardSettings) {
    try {
      const plan = planLiveSettings(
        activeSettings,
        dashboardSettings,
        activeSettings,
        latest?.liveSettingsGuard ?? fieldRun.liveSettingsGuard,
      );
      liveValid = true;
      if (plan.live.length)
        lines.push(`Draft can Apply now: ${plan.live.map(liveSettingLabel).join(', ')}`);
      if (plan.nextRun.length)
        lines.push(`Next run: ${plan.nextRun.map(liveSettingLabel).join(', ')}`);
    } catch (error) {
      lines.push(
        `Rejected draft: ${error instanceof Error ? error.message : 'Invalid settings.'} Active settings are intact.`,
      );
    }
  } else if (formError)
    lines.push(
      `Rejected draft: ${formError instanceof Error ? formError.message : 'Invalid settings.'} Active settings are intact.`,
    );
  else lines.push('Saved draft. Start uses these settings.');
  if (runActive() && !fieldRun.requested) lines.push('Macro/service settings are Next run.');
  liveSettingsStatus.textContent = lines.join('\n');
  liveSettingsStatus.style.whiteSpace = 'pre-line';
  applySettingsButton.hidden = !fieldRun.requested;
  applySettingsButton.disabled =
    !native ||
    !fieldRun.requested ||
    !latest?.runRequested ||
    !liveValid ||
    !fresh ||
    busy ||
    dispatches.stopping ||
    loginBusy ||
    fieldRun.settingsApplyPending ||
    receipt?.state === 'pending' ||
    features.setupDraftDirty();
  element('client-account-label').textContent =
    latest?.connected && latest.compatible && latest.player ? 'Account' : 'Connect account';
  startButton.hidden = dashboard.state === 'RUNNING';
  element('death-cap').textContent = dashboardSettings
    ? clientDeathCap(dashboardSettings.automation?.respawn)
    : '—';
  if (!closeRegistered || closeBusy || updateBusy) {
    botConsole.lock(
      true,
      closeBusy
        ? 'Saving current settings before closing.'
        : !closeRegistered
          ? 'Preparing saved settings.'
          : 'Client update in progress. Manual actions are locked.',
    );
    for (const input of document.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement | HTMLTextAreaElement
    >('input,select,button,textarea'))
      if (!navigation.has(input as HTMLButtonElement)) input.disabled = true;
    features.withSettings(projection.runSettings, () => features.lock(true, true, true));
    if (updateBusy && !closeBusy)
      stopButton.disabled = dispatches.stopping || updateContinuation.stopped;
    return;
  }
  if (features.setupDraftDirty())
    for (const id of [
      'radius',
      'loot',
      'random-walk',
      'route-step',
      'route-time',
      'attack-distance',
      'attack-time',
      'avoid-walls',
    ])
      element<HTMLInputElement>(id).disabled = true;
  // Rules keep the existing macro admission gate; ordinary field runs still
  // require verified physical ground and targets for the field being entered.
  startButton.disabled = scripted
    ? !ready || !checked || busy || dispatches.stopping || loginBusy || runActive()
    : !canStartField({
        native,
        fresh,
        busy,
        stopping: dispatches.stopping,
        loginBusy,
        runActive: runActive(),
        connected: latest?.connected === true,
        compatible: latest?.compatible === true,
        map: latest?.map ?? '',
        player: latest?.player ?? null,
        settings: checked,
      });
  stopButton.disabled =
    dispatches.stopping ||
    (!gameOpen && !fieldRun.requested && !loginBusy && !updateContinuation.pending);
  element<HTMLButtonElement>('update-check').disabled = !native || updatePolling;
  openButton.disabled = false;
  for (const id of ['disconnect', 'account-disconnect'])
    element<HTMLButtonElement>(id).disabled = !disconnectReady();
  const controls = panelControls({
    native,
    ready: !!ready,
    accountReady,
    connectedCharacter: !!(latest?.connected && latest.player),
    busy,
    stopping: dispatches.stopping,
    loginBusy,
    gameOpen,
    rememberLogin: element<HTMLInputElement>('remember-login').checked,
    sessionLoginAvailable,
    runActive: runActive(),
    featuresSettled: features.settledForMaintenance(),
  });
  botConsole.lock(controls.manualLocked, controls.manualReason);
  element<HTMLButtonElement>('signin').disabled = controls.signinDisabled;
  element<HTMLButtonElement>('forget-login').disabled = controls.forgetLoginDisabled;
  for (const id of ['username', 'password', 'character-slot', 'remember-login']) {
    element<HTMLInputElement>(id).disabled = controls.accountDisabled;
  }
  element<HTMLSelectElement>('connection-mode').disabled = controls.modeDisabled;
  element<HTMLInputElement>('auto-login').disabled = controls.autoLoginDisabled;
  element<HTMLInputElement>('auto-reconnect').disabled = controls.autoReconnectDisabled;
  features.withSettings(projection.runSettings, () =>
    features.lock(
      dispatches.stopping,
      busy || dispatches.stopping || loginBusy || !ready || runActive(),
      busy || dispatches.stopping || loginBusy || !ready || features.serviceBlocked(),
      busy || dispatches.stopping || loginBusy || !ready || fieldRun.requested,
    ),
  );
}

function showSavedLogin(profile: SavedLogin | null): void {
  savedLogin = profile;
  element('saved-account').textContent = profile ? `Saved: ${profile.username}` : 'Session only';
  element<HTMLButtonElement>('forget-login').hidden = !profile;
  element<HTMLInputElement>('password').placeholder = profile
    ? 'Leave blank to use saved password'
    : '';
  if (!profile && !sessionLoginAvailable)
    element<HTMLInputElement>('auto-reconnect').checked = false;
  configureReconnect();
}

interface SignInInput {
  username?: string;
  password?: string;
  characterSlot?: number;
  remember?: boolean;
  autoLogin?: boolean;
  mode?: 'botOnly' | 'gameClient';
}
async function signIn(
  mcpOperation?: string,
  input?: SignInInput,
): Promise<Record<string, unknown>> {
  if (
    !native ||
    !closeRegistered ||
    closeBusy ||
    !accountReady ||
    updateBusy ||
    busy ||
    (mcpControls.busy && !mcpOperation) ||
    dispatches.stopping ||
    loginBusy ||
    (latest?.connected && latest.player)
  )
    throw new Error('The client is not ready to sign in.');
  const username = (input?.username ?? element<HTMLInputElement>('username').value).trim();
  const password = element<HTMLInputElement>('password');
  const suppliedPassword = input ? (input.password ?? '') : password.value;
  const characterSlot =
    input?.characterSlot ?? Number(element<HTMLSelectElement>('character-slot').value);
  const remember = input?.remember ?? element<HTMLInputElement>('remember-login').checked;
  const autoLogin = input?.autoLogin ?? element<HTMLInputElement>('auto-login').checked;
  const mode =
    input?.mode ??
    (element<HTMLSelectElement>('connection-mode').value as 'botOnly' | 'gameClient');
  const reuse = savedLogin?.username === username && !suppliedPassword;
  validateLoginProfile({
    username,
    password: reuse ? 'saved-password' : suppliedPassword,
    characterSlot,
  });
  const accountRevision = mcpDraftRevision;
  previousSession = latest?.sessionId;
  loginBusy = true;
  loginStartedAt = Date.now();
  updateButtons();
  try {
    const task = dispatches.login(
      {
        credentials: reuse ? null : { username, password: suppliedPassword, characterSlot },
        characterSlot,
        remember,
        autoLogin,
        mode,
      },
      mcpOperation,
    );
    if (!input) {
      password.value = '';
      touchMcpDraft();
    }
    const result = (await task).outcome;
    if (result.status === 'retired') return { dispatch: 'retired' };
    if (result.status === 'failed') {
      previousSession = undefined;
      loginBusy = false;
      message(
        typeof result.error === 'string' ? result.error : 'Could not start automatic sign-in.',
        true,
      );
      return {
        dispatch: 'failed',
        error: 'Sign-in could not start. Credentials are not included in operation outcomes.',
      };
    }
    gameOpen = true;
    if (input && mcpDraftRevision === accountRevision) {
      element<HTMLInputElement>('username').value = username;
      element<HTMLSelectElement>('character-slot').value = String(characterSlot);
      element<HTMLSelectElement>('connection-mode').value = mode;
      element<HTMLInputElement>('remember-login').checked = remember;
      element<HTMLInputElement>('auto-login').checked = autoLogin;
      touchMcpDraft();
    }
    accountBaseline = accountFields();
    if (mode === 'gameClient') shell.showPage('game');
    if (remember) showSavedLogin({ username, characterSlot, autoLogin, mode });
    message(
      mode === 'botOnly'
        ? 'Opening bot connection for sign-in…'
        : 'Loading the game client for sign-in…',
    );
    return {
      dispatch: 'accepted',
      confirmation: 'Wait for a fresh connected character observation.',
    };
  } finally {
    updateButtons();
  }
}

element<HTMLFormElement>('signin-form').addEventListener('submit', (event) => {
  event.preventDefault();
  if (native && !busy && !loginBusy && !(latest?.connected && latest.player)) void signIn();
});
element<HTMLInputElement>('remember-login').addEventListener('change', () => {
  if (!element<HTMLInputElement>('remember-login').checked)
    element<HTMLInputElement>('auto-login').checked = false;
  updateButtons();
});
element<HTMLInputElement>('auto-reconnect').addEventListener('change', () => {
  configureReconnect();
  updateButtons();
});
element('forget-login').addEventListener(
  'click',
  () =>
    void perform(async () => {
      await forgetLogin();
      message('Local saved login and app-open sign-in preference removed.');
    }),
);
async function forgetLogin(mcpOperation?: string): Promise<Record<string, unknown>> {
  const revision = mcpDraftRevision;
  await (mcpOperation ? invoke('forget_login', { mcpOperation }) : invoke('forget_login'));
  showSavedLogin(null);
  if (revision === mcpDraftRevision) {
    element<HTMLInputElement>('remember-login').checked = false;
    element<HTMLInputElement>('auto-login').checked = false;
    accountBaseline = accountFields();
    touchMcpDraft();
  }
  return { persisted: true, forgotten: true, draftRevision: mcpDraftRevision };
}

async function mainOperation(
  action: () => Promise<unknown>,
  mcpOperation?: string,
): Promise<unknown> {
  if (busy || (mcpControls.busy && !mcpOperation))
    throw new Error('Another client operation is in progress.');
  busy = true;
  updateButtons();
  try {
    return await action();
  } finally {
    busy = false;
    updateButtons();
  }
}
async function perform(action: () => Promise<unknown>): Promise<void> {
  try {
    await mainOperation(action);
  } catch (error) {
    message(typeof error === 'string' ? error : 'Unable to contact the game.', true);
  }
}
async function disconnect(mcpOperation?: string): Promise<Record<string, unknown>> {
  if (!disconnectReady()) throw new Error('The current connection is not ready to disconnect.');
  return (await mainOperation(async () => {
    await (mcpOperation ? invoke('close_game', { mcpOperation }) : invoke('close_game'));
    return { dispatch: 'accepted', confirmation: 'Wait for the game-closed observation.' };
  }, mcpOperation)) as Record<string, unknown>;
}
for (const id of ['disconnect', 'account-disconnect'])
  element(id).addEventListener('click', () => {
    if (!disconnectReady()) return;
    void disconnect().catch(() => message('Unable to disconnect the current game.', true));
  });
function botStartReady(): boolean {
  if (
    !native ||
    !closeRegistered ||
    closeBusy ||
    updateBusy ||
    dispatches.stopping ||
    loginBusy ||
    runActive() ||
    !latest?.connected ||
    !latest.compatible ||
    !latest.player ||
    Date.now() - receivedAt >= 7000 ||
    features.setupDraftDirty()
  )
    return false;
  try {
    const document = features.setupDocument();
    if (document.script) {
      macroBaseSettings(document.settings, document.script);
      return true;
    }
    return canStartField({
      native,
      fresh: true,
      busy: false,
      stopping: false,
      loginBusy: false,
      runActive: false,
      connected: true,
      compatible: true,
      map: latest.map,
      player: latest.player,
      settings: validateSettings(form.startSettings()),
    });
  } catch {
    return false;
  }
}
async function startBot(mcpOperation?: string): Promise<Record<string, unknown>> {
  if (!botStartReady() || !latest)
    throw new Error('Connect a verified character and finish a valid Setup before Start.');
  features.syncSetup(form.snapshot().settings);
  const document = features.setupDocument();
  const task = document.script
    ? dispatches.feature(
        'macro',
        {
          script: document.script,
          settings: macroBaseSettings(document.settings, document.script),
        },
        mcpOperation,
      )
    : dispatches.start(validateSettings(form.startSettings()), latest, mcpOperation);
  configureReconnect();
  reconnect.observe(latest.connected, true, latest.login.phase, Date.now(), latest.login.message);
  const result = (await task).outcome;
  if (result.status === 'failed') {
    configureReconnect();
    message(typeof result.error === 'string' ? result.error : 'Unable to contact the game.', true);
  }
  return {
    dispatch: result.status,
    confirmation: 'Read get_status for observed run intent and game action receipts.',
  };
}
startButton.addEventListener('click', () => void perform(() => startBot()));
async function stopBot(mcpOperation?: string): Promise<Record<string, unknown>> {
  mcpControls.retireActivations();
  // Cancel native restart authority before dispatching Stop through admission.
  // Local ownership retires immediately, even if replacement already started.
  const cancel = updateContinuation.cancel(true, mcpOperation).catch(() => {});
  const task = dispatches.stop(cancel, mcpOperation);
  loginBusy = false;
  previousSession = undefined;
  updateButtons();
  return task
    .then((receipt) => {
      const result = receipt.outcome;
      if (result.status === 'accepted') message('Bot stopped.');
      else if (result.status === 'failed')
        message('Run cancelled. The game controller is unavailable.');
      return {
        dispatch: result.status,
        retainedRunCancelled: true,
        confirmation:
          'Stop retires local intent; previously sent game actions still require receipt reconciliation.',
      };
    })
    .finally(updateButtons);
}
stopButton.addEventListener('click', () => {
  void stopBot();
});
function render(s: ValidatedGameStatus): void {
  // Navigation is asynchronous: the previous page may still publish its terminal
  // login status while the next official client is loading.
  if (s.sessionId === previousSession) return;
  const justSignedIn = s.login.phase === 'complete' && latest?.login.phase !== 'complete';
  latest = s;
  receivedAt = Date.now();
  gameOpen = true;
  mcpObservation = retainedMcpObservation({ status: s, previousSession, retained: mcpObservation });
  if (sessionLoginAvailable !== s.reconnectAvailable) {
    sessionLoginAvailable = s.reconnectAvailable;
    configureReconnect();
  }
  reconnect.observe(s.connected, !!s.player, s.login.phase, Date.now(), s.login.message);
  fieldRun.observe(s);
  holdAtRunLimit();
  if (['complete', 'failed', 'cancelled'].includes(s.login.phase)) loginBusy = false;
  const projection = form.project();
  features.withSettings(projection.runSettings, () =>
    features.render({ ...s, runExperience: fieldRun.experienceFor(s) }),
  );
  if (!updateBusy && !closeBusy && !loginBusy && !dispatches.stopping) {
    void updateContinuation
      .resume(s, accountSelection(), fieldRun)
      .then((resumed) => {
        if (resumed) {
          configureReconnect();
          message('Update complete. Continuing with the same settings and remaining limits.');
          updateButtons();
        }
      })
      .catch(() =>
        message(
          updateContinuation.confirmationLost
            ? 'The game did not confirm continuation. Press Stop before starting again.'
            : 'Update restored your settings. Waiting for verified character data; Stop cancels continuation.',
          true,
        ),
      );
  }
  if (justSignedIn) element<HTMLDetailsElement>('signin-panel').open = false;
  element('login-help').textContent =
    s.login.message || 'Select an existing slot. Sign-in enters the field with combat stopped.';
  const { state, reason } = clientStatus(s, {
    fieldRequested: fieldRun.requested,
    held: features.active(),
    limitReason: fieldRun.limitReason,
    loginBusy,
  });
  element('status').textContent = state;
  element('status').classList.toggle('active', state === 'RUNNING');
  element('status').dataset.state = state;
  element('character').textContent = s.player?.name ?? 'No character connected';
  element('character').title = s.player?.name ?? 'No character connected';
  element('location').textContent = s.player
    ? `Level ${s.player.level} · ${s.map} · ${s.player.x}, ${s.player.y}`
    : 'Connect an account to load your character.';
  element('location').title = element('location').textContent ?? '';
  const attack = normalAttackProfile(s.character);
  const rawRange =
    attack.sourceRange !== null && attack.sourceRange !== attack.range
      ? ` · source range ${attack.sourceRange}`
      : '';
  element('attack-range').textContent =
    `Normal attack: ${attack.range} cells · ${attack.source}${rawRange}. ${attack.limitation} Projectile sight is checked; skill range and kiting are separate.`;
  element('hp-text').textContent = s.player ? `${s.player.hp} / ${s.player.maxHp}` : '— / —';
  element('hp-bar').style.width =
    `${s.player?.maxHp ? Math.max(0, Math.min(100, (s.player.hp / s.player.maxHp) * 100)) : 0}%`;
  const sp = clientSp(s.character.stats);
  element('sp-text').textContent = sp.text;
  element('sp-bar').style.width = sp.width;
  element('death-count').textContent = clientDeaths(
    fieldRun.requested ? fieldRun.metrics.deaths : s.deaths,
  );
  for (const key of ['attacks', 'kills', 'looted'] as const)
    element(key).textContent = String(fieldRun.requested ? fieldRun.metrics[key] : s[key]);
  element('nearby').textContent = String(
    s.monsters.length + consoleNpcs(s).length + consolePlayerShops(s).length,
  );
  element('map-label').textContent = s.map || 'WAITING';
  element('target-label').textContent = s.target || 'No active target';
  message(
    fieldRun.settingsApplyWaitReason(s.sessionId) || reason,
    s.login.phase === 'failed' || (s.connected && !s.compatible),
  );
  activityLog.render(s.log);
  botConsole.render(s);
  updateButtons(projection);
  resumeFieldRun(s);
}
function readMcp(query: McpQuery, executing = false) {
  let snapshot: FormSnapshot | null = null;
  if (currentForm.initialized) {
    try {
      snapshot = form.snapshot();
    } catch {
      /* Invalid editable drafts remain intact. */
    }
  }
  return {
    now: Date.now(),
    runtimeGeneration: query.runtimeGeneration,
    status: latest,
    observation: mcpObservation,
    gameOpen,
    runRequested: fieldRun.requested,
    limitReason: fieldRun.limitReason,
    updateBusy,
    updateContinuationPending: updateContinuation.pending,
    form: snapshot,
    formInitialized: currentForm.initialized,
    profiles: query.tool === 'list_profiles' ? features.readProfiles() : [],
    draftRevision: mcpDraftRevision,
    script: query.tool === 'get_script' ? features.readScript() : null,
    services: query.tool === 'list_services' ? features.readServices() : null,
    account: {
      username: element<HTMLInputElement>('username').value,
      characterSlot: Number(element<HTMLSelectElement>('character-slot').value),
      mode: element<HTMLSelectElement>('connection-mode').value,
      remember: element<HTMLInputElement>('remember-login').checked,
      autoLogin: element<HTMLInputElement>('auto-login').checked,
      reconnect: element<HTMLInputElement>('auto-reconnect').checked,
      savedPasswordAvailable: savedLogin !== null,
    },
    controls: {
      busy:
        busy ||
        (!executing && mcpControls.busy) ||
        loginBusy ||
        dispatches.stopping ||
        closeBusy ||
        !closeRegistered ||
        !currentForm.initialized ||
        !accountReady,
      ready: !!(
        latest?.connected &&
        latest.compatible &&
        latest.player &&
        Date.now() - receivedAt < 7000
      ),
      startReady: !busy && (executing || !mcpControls.busy) && botStartReady(),
      applyReady: !applySettingsButton.disabled,
      disconnectReady: disconnectReady(),
    },
  };
}
async function flushMcpDraft(operation: string): Promise<Record<string, unknown>> {
  // Replace only the autosave scheduled by the synchronous assistant edit.
  // Later human edits schedule their own ordinary save and retain their ownership.
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = undefined;
  }
  const draftRevision = mcpDraftRevision;
  try {
    const document = await currentForm.flush((document) =>
      invoke<number>('save_current_form', { document, mcpOperation: operation }),
    );
    return {
      draftChanged: true,
      draftRevision,
      persisted: true,
      persistedRevision: document.revision,
    };
  } catch {
    return {
      draftChanged: true,
      draftRevision,
      persisted: false,
      error:
        'The draft changed but Form persistence was not confirmed. Newer human edits remain intact.',
    };
  }
}
const mcpControls = new McpControl({
  claim: (query) =>
    invoke('mcp_claim', { id: query.id, runtimeGeneration: query.runtimeGeneration }),
  read: (query) => readMcp(query, true),
  perform: async (tool, args, operation) => {
    if (tool === 'stop_bot') return stopBot(operation);
    if (tool === 'set_settings') {
      if (features.setupDraftDirty())
        throw new Error('Finish or discard the Script draft before editing Form.');
      form.applySettings(args.settings as SettingsInput);
      return flushMcpDraft(operation);
    }
    if (tool === 'set_script') {
      const script = features.setScript(args.script as string);
      const formResult = await flushMcpDraft(operation);
      return {
        ...formResult,
        scriptPersisted: script.persisted,
        draftChanged: script.draftChanged,
        ...(script.persisted
          ? {}
          : {
              error:
                'The Script draft changed but script persistence was not confirmed. Copy the draft or retry Save script.',
            }),
      };
    }
    if (tool === 'profile') {
      if (args.operation === 'apply' && features.setupDraftDirty())
        throw new Error('Finish or discard the Script draft before applying a profile.');
      features.profileOperation(args as Parameters<FeatureUi['profileOperation']>[0]);
      return {
        ...(await flushMcpDraft(operation)),
        profilesPersisted: ['save', 'remove', 'import'].includes(args.operation as string),
      };
    }
    if (tool === 'service_definition') {
      features.serviceOperation(args as Parameters<FeatureUi['serviceOperation']>[0]);
      // Service collections own their private local-storage transaction; no Form save is needed.
      return { draftChanged: true, draftRevision: mcpDraftRevision, persisted: true };
    }
    if (tool === 'connect') return signIn(operation, args as SignInInput);
    if (tool === 'disconnect') return disconnect(operation);
    if (tool === 'start_bot')
      return (await mainOperation(() => startBot(operation), operation)) as Record<string, unknown>;
    if (tool === 'apply_settings')
      return (await mainOperation(() => applyCurrentSettings(operation), operation)) as Record<
        string,
        unknown
      >;
    if (tool === 'forget_login')
      return (await mainOperation(() => forgetLogin(operation), operation)) as Record<
        string,
        unknown
      >;
    if (tool === 'set_reconnect') {
      element<HTMLInputElement>('auto-reconnect').checked = args.enabled as boolean;
      touchMcpDraft();
      configureReconnect();
      updateButtons();
      return { draftRevision: mcpDraftRevision, enabled: args.enabled, sessionOnly: true };
    }
    if (tool === 'client_action') {
      if (args.action === 'warpCancel') {
        await invoke('control_bot', {
          action: 'warpCancel',
          request: args.request,
          mcpOperation: operation,
        });
      } else await featureRequest(args.action as string, args.request, operation);
      return {
        dispatch: 'accepted',
        confirmation:
          'Read get_client_state and get_status for the owner preview or eventual game receipt. A dispatch is not game confirmation.',
      };
    }
    throw new Error('Unsupported assistant operation.');
  },
});
async function executeMcp(query: McpQuery): Promise<Record<string, unknown>> {
  if (mcpWriteTool(query.tool)) return mcpControls.execute(query);
  if (query.tool === 'preview_bot') return mcpPreview(query, readMcp(query));
  if (query.tool === 'export_profile')
    return { document: features.exportProfile(query.arguments.id as string) };
  if (query.tool === 'export_service')
    return { document: features.exportService(query.arguments.id as string) };
  return mcpReadResult(query, readMcp(query));
}
if (!native) message('Browser preview · Launch the desktop app with bun run app:dev to connect.');
if (native) {
  void (async () => {
    try {
      await listen<unknown>('settings-close-request', (event) => {
        void settingsClose.request(event.payload);
      });
      const pending = await invoke<unknown>('settings_close_ready');
      closeRegistered = true;
      root.inert = closeBusy;
      updateButtons();
      if (pending) void settingsClose.request(pending);
    } catch {
      element('update-status').textContent =
        'Settings could not be initialized. Reopen the app to edit them safely.';
      return;
    }
    await mountMcp(element('client-mcp'), readMcp, executeMcp, {
      revoke: () => mcpControls.revoke(),
      renew: () => mcpControls.renew(),
    });
    await listen<unknown>('game-status', (event) => {
      if (validStatus(event.payload)) render(event.payload);
    });
    await listen<unknown>('update-prepared', (event) => updateContinuation.prepared(event.payload));
    await listen<unknown>('update-restored', (event) => updateContinuation.restored(event.payload));
    await listen('game-closed', () => {
      features.clearSocial();
      features.clearMemo();
      features.clearMacro();
      if (updateContinuation.gameClosed()) dispatches.gameClosed();
      else reconnect.cancel();
      sessionLoginAvailable = false;
      previousSession = undefined;
      gameOpen = false;
      latest = null;
      receivedAt = 0;
      mcpObservation = null;
      loginBusy = false;
      element('status').textContent = 'OFFLINE';
      element('status').classList.remove('active');
      element('status').dataset.state = 'OFFLINE';
      element('character').textContent = 'No character connected';
      element('location').textContent = 'Connect an account to load your character.';
      element('character').title = 'No character connected';
      element('location').title = 'Connect an account to load your character.';
      element('hp-text').textContent = '— / —';
      element('hp-bar').style.width = '0%';
      element('sp-text').textContent = '— / —';
      element('sp-bar').style.width = '0%';
      element('death-count').textContent = '—';
      for (const id of ['attacks', 'kills', 'looted', 'nearby']) element(id).textContent = '0';
      element('map-label').textContent = 'WAITING';
      element('target-label').textContent = 'No active target';
      activityLog.render([], 'Session activity will appear after connection.');
      message('Disconnected. Select an account and character to connect again.');
      botConsole.render(null);
      updateButtons();
    });
    try {
      try {
        currentForm.restore(await invoke('current_form'), (document) => form.restore(document));
      } catch {
        currentForm.initialized = false;
        element('update-status').textContent =
          'Current settings could not be restored. Automatic updates are waiting.';
      }
      if (currentForm.initialized) {
        try {
          presentUpdateContinuation(await updateContinuation.startup(fieldRun));
        } catch {
          message(
            'Update settings restored. The run could not be verified; start the bot explicitly.',
            true,
          );
        }
        await currentForm.flush().catch(() => {
          element('update-status').textContent =
            'Updates are waiting for valid, saved current settings.';
        });
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
        if (!updateContinuation.pending) {
          accountBaseline = accountFields();
          if (profile.autoLogin && !closeBusy && !updateContinuation.stopped) await signIn();
        }
      }
      if (updateContinuation.pending) {
        selectUpdateAccount();
        accountBaseline = accountFields();
        if (
          updateContinuation.automaticLogin(
            profile ? { ...profile, mode: profile.mode ?? 'gameClient' } : null,
          ) &&
          !closeBusy &&
          !updateContinuation.stopped
        )
          await signIn();
        else
          message(
            'Update complete. Settings restored. Sign in to the same account and character to continue.',
          );
      }
    } catch {
      element<HTMLButtonElement>('forget-login').hidden = false;
      message(
        'Local saved login could not be read. Forget it or enter your account manually.',
        true,
      );
    } finally {
      accountReady = true;
      accountBaseline ??= accountFields();
    }
    await invoke('update_initialized').catch(() => {});
    void pollUpdate();
    setInterval(() => {
      void pollUpdate();
    }, 15_000);
    updateButtons();
  })().catch(() => {
    formRestored();
    element('update-status').textContent =
      'Settings initialization failed. Check the settings or local storage before closing.';
  });
  setInterval(() => {
    holdAtRunLimit();
    if (loginBusy && Date.now() - loginStartedAt > 120_000) {
      loginBusy = false;
      previousSession = undefined;
      reconnect.networkFailure(Date.now());
      message('Sign-in is taking too long. Waiting before reconnecting again.', true);
    }
    updateButtons();
    const retry =
      !closeBusy &&
      !updateBusy &&
      gameOpen &&
      !busy &&
      !dispatches.stopping &&
      !loginBusy &&
      !(latest?.connected && latest.player) &&
      !fieldRun.limitReason
        ? reconnect.takeDue(Date.now())
        : null;
    if (retry !== null) {
      loginBusy = true;
      loginStartedAt = Date.now();
      previousSession = latest?.sessionId;
      updateButtons();
      message(
        `Reconnecting · attempt ${retry}. ${fieldRun.requested ? 'The bot will resume when your character is ready.' : 'Combat remains stopped.'}`,
      );
      void dispatches
        .reconnect()
        .then((receipt) => {
          const result = receipt.outcome;
          if (result.status === 'accepted') gameOpen = true;
          else if (result.status === 'failed') {
            previousSession = undefined;
            loginBusy = false;
            message(
              reconnect.requiresSignIn
                ? 'Waiting for you to sign in again before resuming.'
                : 'Reconnect could not restore the connection. Waiting before trying again.',
              true,
            );
          }
        })
        .finally(updateButtons);
    }
    element('reconnect-help').textContent =
      fieldRun.limitReason ||
      (reconnect.requiresSignIn
        ? 'Sign in again to resume the requested run.'
        : reconnect.waitingUntil !== null
          ? `Connection lost. Reconnect in ${Math.max(0, Math.ceil((reconnect.waitingUntil - Date.now()) / 1000))} seconds.`
          : fieldRun.requested && !sessionLoginAvailable
            ? 'Waiting for connection recovery. Sign in through Companion to enable session reconnect.'
            : 'A running bot reconnects with this session login and resumes when your character is ready.');
    if (!fieldRun.limitReason && latest?.connected && Date.now() - receivedAt > 7000)
      message(
        'Waiting for fresh game status. The run will resume when the controller responds.',
        true,
      );
    if (updateBusy || !gameOpen || heartbeatPending) return;
    if (!statusHeartbeatFresh(receivedAt, Date.now())) return;
    heartbeatPending = true;
    void invoke('control_bot', { action: 'heartbeat' })
      .catch(() => {
        updateButtons();
      })
      .finally(() => {
        heartbeatPending = false;
      });
  }, 1000);
}
// Only the explicit settings projection enters persistence; account inputs are excluded.
document.querySelector('main')!.addEventListener('input', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('#client-mcp')) return;
  if (target.closest('#signin-panel')) touchMcpDraft();
  if (!target.closest('#signin-panel') && target.closest('.settings,.feature-panel,.rule-editor')) {
    formChanged();
    updateButtons();
  }
});
document.querySelector('main')!.addEventListener('change', (event) => {
  const target = event.target as HTMLElement;
  if (target.closest('#client-mcp')) return;
  if (target.closest('#signin-panel')) touchMcpDraft();
  if (target.id === 'profile-select') formChanged();
});
updateButtons();

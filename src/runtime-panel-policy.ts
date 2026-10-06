/** Panel decisions consume observations; DOM reads, clocks and commands belong to main. */
export function accountHasDraft(password: string, fields: string, baseline: string | null): boolean {
  return !!password || baseline !== null && fields !== baseline;
}

export interface PanelRequests {
  login: boolean; resume: boolean; service: boolean; manual: boolean; limit: boolean;
}
export interface UpdatePanelState {
  closeRegistered: boolean; closeBusy: boolean; accountReady: boolean; formInitialized: boolean;
  accountDraft: boolean; updateBusy: boolean; busy: boolean; stopping: boolean; loginBusy: boolean;
  heartbeatPending: boolean; pending: PanelRequests; unsavedMacro: boolean; continuationPending: boolean;
  featuresSettled: boolean; reconnectScheduled: boolean;
}
export function panelUpdateWaitReason(state: UpdatePanelState): string | null {
  if (!state.closeRegistered) return 'Update waits for settings initialization.';
  if (state.closeBusy) return 'Update waits for the settings window to finish closing.';
  if (!state.accountReady) return 'Update waits for the saved account to finish loading.';
  if (!state.formInitialized) return 'Update waits for current settings to be restored.';
  if (state.accountDraft) return 'Update waits for your account draft. Sign in or clear the draft first.';
  if (state.updateBusy) return 'Update settlement is already in progress.';
  if (state.busy) return 'Update waits for the current request to finish.';
  if (state.stopping) return 'Update waits for Stop to finish.';
  if (state.loginBusy) return 'Update waits for sign-in to finish.';
  if (state.heartbeatPending) return 'Update waits for the current connection check to finish.';
  if (state.pending.login) return 'Update waits for the pending sign-in request to finish.';
  if (state.pending.resume) return 'Update waits for the pending automation resume to finish.';
  if (state.pending.service) return 'Update waits for the pending service action to finish.';
  if (state.pending.manual) return 'Update waits for the pending manual action to finish.';
  if (state.pending.limit) return 'Update waits for automation to stop at its configured limit.';
  if (state.unsavedMacro) return 'Update waits for your Script draft. Apply & save or Discard draft first.';
  if (state.continuationPending) return 'The previous update is waiting to continue your run.';
  if (!state.featuresSettled) return 'Update waits for pending game actions or previews to finish.';
  if (state.reconnectScheduled) return 'Update waits for the scheduled reconnect to finish.';
  return null;
}

export interface PanelControlState {
  native: boolean; ready: boolean; accountReady: boolean; connectedCharacter: boolean;
  busy: boolean; stopping: boolean; loginBusy: boolean; gameOpen: boolean;
  rememberLogin: boolean; sessionLoginAvailable: boolean; runActive: boolean; featuresSettled: boolean;
}
export function panelControls(state: PanelControlState) {
  const requesting = state.busy || state.stopping || state.loginBusy;
  return {
    signinDisabled: !state.native || !state.accountReady || requesting || state.connectedCharacter,
    forgetLoginDisabled: requesting,
    accountDisabled: !state.accountReady || requesting,
    modeDisabled: !state.accountReady || state.gameOpen || requesting,
    autoLoginDisabled: requesting || !state.rememberLogin,
    autoReconnectDisabled: requesting || !state.sessionLoginAvailable,
    manualLocked: requesting || !state.ready || state.runActive || !state.featuresSettled,
    manualReason: !state.native ? 'Browser preview · native connection required.'
      : requesting ? 'Wait for the current request to finish.'
      : !state.ready ? 'Connect a fresh verified character to use manual controls.'
      : state.runActive || !state.featuresSettled ? 'Stop the bot; wait for pending actions before manual control.' : '',
  };
}

export interface PanelDisconnectState {
  native: boolean; gameOpen: boolean; accountReady: boolean; updateBusy: boolean; busy: boolean;
  stopping: boolean; loginBusy: boolean; pending: PanelRequests; heartbeatPending: boolean;
  runActive: boolean; featuresSettled: boolean; connectedCharacter: boolean; statusAgeMs: number;
}
export function panelDisconnectReady(state: PanelDisconnectState): boolean {
  return state.native && state.gameOpen && state.accountReady && !state.updateBusy && !state.busy && !state.stopping
    && !state.loginBusy && !Object.values(state.pending).some(Boolean) && !state.heartbeatPending && !state.runActive
    && state.featuresSettled && !(state.connectedCharacter && state.statusAgeMs >= 7000);
}

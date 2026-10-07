import { describe, expect, it } from 'vitest';
import {
  accountHasDraft,
  panelControls,
  panelDisconnectReady,
  panelUpdateWaitReason,
  type PanelControlState,
  type PanelDisconnectState,
  type UpdatePanelState,
} from './runtime-panel-policy';

const pending = { login: false, resume: false, service: false, manual: false, limit: false };
const settled: UpdatePanelState = {
  closeRegistered: true,
  closeBusy: false,
  accountReady: true,
  formInitialized: true,
  accountDraft: false,
  updateBusy: false,
  busy: false,
  stopping: false,
  loginBusy: false,
  heartbeatPending: false,
  pending,
  unsavedMacro: false,
  continuationPending: false,
  featuresSettled: true,
  reconnectScheduled: false,
};
const controls: PanelControlState = {
  native: true,
  ready: true,
  accountReady: true,
  connectedCharacter: false,
  busy: false,
  stopping: false,
  loginBusy: false,
  gameOpen: false,
  rememberLogin: true,
  sessionLoginAvailable: true,
  runActive: false,
  featuresSettled: true,
};
const disconnect: PanelDisconnectState = {
  native: true,
  gameOpen: true,
  accountReady: true,
  updateBusy: false,
  busy: false,
  stopping: false,
  loginBusy: false,
  pending,
  heartbeatPending: false,
  runActive: false,
  featuresSettled: true,
  connectedCharacter: true,
  statusAgeMs: 6999,
};

describe('panel policy', () => {
  it('admits updates only after every owner settles, with stable reason priority', () => {
    expect(panelUpdateWaitReason(settled)).toBeNull();
    expect(
      panelUpdateWaitReason({ ...settled, closeBusy: true, busy: true, unsavedMacro: true }),
    ).toBe('Update waits for the settings window to finish closing.');
    expect(panelUpdateWaitReason({ ...settled, accountDraft: true, updateBusy: true })).toBe(
      'Update waits for your account draft. Sign in or clear the draft first.',
    );
    expect(
      panelUpdateWaitReason({ ...settled, unsavedMacro: true, continuationPending: true }),
    ).toBe(
      'Update waits for your Script draft. Correct it and retry Save script, or Discard draft first.',
    );
    expect(
      panelUpdateWaitReason({ ...settled, featuresSettled: false, reconnectScheduled: true }),
    ).toBe('Update waits for pending game actions or previews to finish.');
  });
  it.each(['login', 'resume', 'service', 'manual', 'limit'] as const)(
    'holds update and disconnect during a pending %s',
    (kind) => {
      const requests = { ...pending, [kind]: true };
      expect(panelUpdateWaitReason({ ...settled, pending: requests })).not.toBeNull();
      expect(panelDisconnectReady({ ...disconnect, pending: requests })).toBe(false);
    },
  );
  it.each(['closeRegistered', 'accountReady', 'formInitialized', 'featuresSettled'] as const)(
    'requires %s for an update',
    (key) => {
      expect(panelUpdateWaitReason({ ...settled, [key]: false })).not.toBeNull();
    },
  );
  it.each([
    'closeBusy',
    'accountDraft',
    'updateBusy',
    'busy',
    'stopping',
    'loginBusy',
    'heartbeatPending',
    'unsavedMacro',
    'continuationPending',
    'reconnectScheduled',
  ] as const)('holds an update for %s', (key) => {
    expect(panelUpdateWaitReason({ ...settled, [key]: true })).not.toBeNull();
  });
  it('distinguishes account drafts from a baseline still loading', () => {
    expect(accountHasDraft('', 'selected', null)).toBe(false);
    expect(accountHasDraft('', 'selected', 'selected')).toBe(false);
    expect(accountHasDraft('', 'changed', 'selected')).toBe(true);
    expect(accountHasDraft('synthetic password', 'selected', null)).toBe(true);
  });
  it('keeps stale status from authorizing disconnect for a connected character', () => {
    expect(panelDisconnectReady(disconnect)).toBe(true);
    expect(panelDisconnectReady({ ...disconnect, statusAgeMs: 7000 })).toBe(false);
    expect(
      panelDisconnectReady({ ...disconnect, connectedCharacter: false, statusAgeMs: 7000 }),
    ).toBe(true);
  });
  it('projects account and manual locks independently', () => {
    const idle = panelControls(controls);
    expect(idle).toMatchObject({
      signinDisabled: false,
      accountDisabled: false,
      modeDisabled: false,
      manualLocked: false,
      manualReason: '',
    });
    expect(panelControls({ ...controls, gameOpen: true, connectedCharacter: true })).toMatchObject({
      signinDisabled: true,
      accountDisabled: false,
      modeDisabled: true,
    });
    expect(
      panelControls({ ...controls, rememberLogin: false, sessionLoginAvailable: false }),
    ).toMatchObject({
      autoLoginDisabled: true,
      autoReconnectDisabled: true,
      accountDisabled: false,
    });
    expect(panelControls({ ...controls, featuresSettled: false })).toMatchObject({
      manualLocked: true,
      manualReason: 'Stop the bot; wait for pending actions before manual control.',
    });
    expect(panelControls({ ...controls, native: false, ready: false, busy: true })).toMatchObject({
      manualLocked: true,
      manualReason: 'Browser preview · native connection required.',
    });
  });
  it.each(['busy', 'stopping', 'loginBusy'] as const)(
    'locks both account and manual controls during %s',
    (key) => {
      expect(panelControls({ ...controls, [key]: true })).toMatchObject({
        signinDisabled: true,
        forgetLoginDisabled: true,
        accountDisabled: true,
        modeDisabled: true,
        autoLoginDisabled: true,
        autoReconnectDisabled: true,
        manualLocked: true,
      });
    },
  );
});

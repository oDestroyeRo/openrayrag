import { find } from 'remeda';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
const text = (value: unknown): string => typeof value === 'string' ? value : '';

interface StatusContext {
  fieldRequested: boolean;
  held: boolean;
  limitReason: string;
  loginBusy: boolean;
  setupReason?: string;
}

function heldReason(status: Record<string, unknown>): string {
  const refine = record(status.refine), warp = record(status.warp);
  if (refine.blocked === true && text(refine.reason)) {
    // The controller separates requested field arbitration from an external
    // official refine hold. Its actual run reason still represents owned holds.
    return status.runRequested===true&&text(status.reason)?text(status.reason):text(refine.reason);
  }
  if (warp.blocked === true) {
    const reason = text(warp.reason);
    return reason && !/^Stopped(?: by you)?\.?$/i.test(reason.trim()) ? reason
      : `${reason || 'Warp Portal remains unresolved.'} Automation is held until verified recovery reconciles the character and resources. Stop ends local intent; normal map arrival and reconnect alone do not release the hold.`;
  }
  const owners: Array<[unknown, boolean]> = [
    [status.retreat, record(status.retreat).settling === true],
    [status.partyHeal, ['pending', 'uncertain'].includes(text(record(status.partyHeal).state))],
    [status.partyFollow, record(status.partyFollow).ownsTravel === true],
    [status.manualTarget, record(status.manualTarget).active === true || record(status.manualTarget).settling === true],
    [status.travel, ['planning', 'walking', 'transition'].includes(text(record(status.travel).state))],
    [status.socket, record(status.socket).pending === true],
    [status.memo, record(status.memo).blocked === true],
    [status.social, record(status.social).pending === true],
    [status.service, record(status.service).active === true],
    [status.workflow, record(status.workflow).running === true],
    [status.routine, ['running', 'waiting'].includes(text(record(status.routine).state))],
    [status.actionResult, record(status.actionResult).status === 'pending'],
  ];
  const owner = find(owners, ([value, held]) => held && !!text(record(value).reason));
  if (owner) return text(record(owner[0]).reason);
  const task = record(status.task);
  return task.pending === true ? text(task.label) : '';
}

/** Read-only projection; it does not change run intent, owner holds or admission. */
export function clientStatus(value: unknown, context: StatusContext): { state: string; reason: string } {
  const status = record(value), login = record(status.login);
  const state = status.running === true && !context.limitReason ? 'RUNNING'
    : context.fieldRequested || status.runRequested === true || context.held || record(status.warp).blocked === true ? 'WAITING'
      : status.player && status.compatible === true ? context.setupReason ? 'SETUP' : 'READY' : status.connected === true ? 'CONNECTED' : 'OFFLINE';
  const loginMessage = login.phase === 'failed' || login.phase === 'cancelled' || context.loginBusy;
  const reason = context.limitReason || (loginMessage ? text(login.message) || 'Loading the game for automatic sign-in…' : heldReason(status) || (state === 'SETUP' ? context.setupReason! : text(status.reason)));
  return { state, reason };
}

export function clientSp(value: unknown): { text: string; width: string } {
  const stats = record(value), sp = stats.sp, maximum = stats.maxSp;
  if (typeof sp !== 'number' || !Number.isFinite(sp) || sp < 0 || typeof maximum !== 'number' || !Number.isFinite(maximum) || maximum <= 0) return { text: '— / —', width: '0%' };
  return { text: `${sp} / ${maximum}`, width: `${Math.max(0, Math.min(100, sp / maximum * 100))}%` };
}

export function clientDeaths(value: unknown): string {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? String(value) : '—';
}

export function clientDeathCap(value: unknown): string {
  const policy = record(value);
  if (policy.enabled === false) return 'Off';
  const cap = policy.maxDeaths;
  if (policy.enabled !== true || typeof cap !== 'number' || !Number.isInteger(cap) || cap < 0 || cap > 100) return '—';
  return cap === 0 ? '0 (legacy cap)' : String(cap);
}

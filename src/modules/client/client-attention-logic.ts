import type { SettingsInput } from '../settings/settings';
import { recoveryInventory } from '../recovery/recovery-item-ui-logic';
import {
  recoveryItemIds,
  recoveryItemReserve,
  type RecoveryResource,
} from '../recovery/recovery-items';
import { itemId } from '../../shared/domain-values';
import { clientStatus } from './client-status';

export type AttentionAction = 'account' | 'setup' | 'recovery' | 'limits' | 'supply' | 'tools';
export interface AttentionItem {
  readonly id: string;
  readonly severity: 'error' | 'warning' | 'info';
  readonly title: string;
  readonly detail: string;
  readonly nextStep: string;
  readonly action: AttentionAction | null;
}
export interface AttentionContext {
  readonly fresh: boolean;
  readonly fieldRequested: boolean;
  readonly held: boolean;
  readonly loginBusy: boolean;
  readonly limitReason: string;
  readonly setupReason: string;
}
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Current observations only; navigation and game actions belong to their existing owners. */
export function clientAttention(
  value: unknown,
  context: AttentionContext,
  settings: SettingsInput | null,
): readonly AttentionItem[] {
  const status = record(value),
    login = record(status.login);
  const items: AttentionItem[] = [];
  if (context.limitReason)
    items.push({
      id: 'limit',
      severity: 'warning',
      title: 'Run limit reached',
      detail: context.limitReason,
      nextStep:
        'Review the allowance. A new run requires an explicit Stop and Start after pending actions settle.',
      action: 'limits',
    });
  if (context.loginBusy)
    items.push({
      id: 'login',
      severity: 'info',
      title: 'Sign-in in progress',
      detail: text(login.message),
      nextStep: 'Wait for the character to enter. Stop cancels pending automatic sign-in.',
      action: 'account',
    });
  else if (context.fresh && (login.phase === 'failed' || login.phase === 'cancelled'))
    items.push({
      id: 'login',
      severity: 'warning',
      title: login.phase === 'failed' ? 'Sign-in needs attention' : 'Sign-in cancelled',
      detail: text(login.message),
      nextStep: 'Review the account and character selection before signing in again.',
      action: 'account',
    });

  if (
    context.setupReason &&
    !context.loginBusy &&
    !context.fieldRequested &&
    status.runRequested !== true &&
    status.running !== true
  )
    items.push({
      id: 'setup',
      severity: 'warning',
      title: 'Setup needs attention',
      detail: context.setupReason,
      nextStep: 'Review the saved draft. Editing setup does not start a run.',
      action: 'setup',
    });
  const observed = context.fresh && status.connected === true;
  for (const [id, title, held, action, fallback] of [
    [
      'warp',
      'Warp Portal needs review',
      record(status.warp).blocked === true,
      'tools',
      'The Warp Portal owner remains unresolved.',
    ],
    [
      'refine',
      'Refining needs review',
      record(status.refine).blocked === true,
      'tools',
      'The refine owner remains unresolved.',
    ],
    [
      'memo',
      'Memo needs review',
      record(status.memo).blocked === true,
      'tools',
      'The memo owner remains unresolved.',
    ],
    [
      'supply',
      'Supply transaction needs review',
      record(status.supply).uncertain === true &&
        ['waiting', 'cancelled'].includes(text(record(status.supply).state)),
      'supply',
      'Supply transaction reconciliation is unresolved.',
    ],
    [
      'partyHeal',
      'Party Heal needs review',
      record(status.partyHeal).state === 'uncertain',
      'recovery',
      'The Heal outcome is uncertain.',
    ],
    [
      'escape',
      'Escape needs review',
      record(status.escape).state === 'uncertain',
      'recovery',
      'The escape outcome is uncertain.',
    ],
    [
      'deathRecoveryGuard',
      'Revival needs review',
      record(status.deathRecoveryGuard).uncertain === true,
      'recovery',
      'The revival or return outcome is uncertain.',
    ],
  ] as const) {
    if (!held) continue;
    items.push({
      id,
      severity: 'warning',
      title: observed ? title : 'Last observed: ' + title,
      detail: text(record(status[id]).reason) || fallback,
      nextStep:
        'Review the existing recovery guidance. Stop or reconnect does not confirm the outstanding action.',
      action,
    });
  }

  if (!context.loginBusy && status.connected !== true) {
    items.push({
      id: 'connection',
      severity: context.fieldRequested ? 'warning' : 'info',
      title: context.fieldRequested ? 'Connection unavailable' : 'Connect a character',
      detail: context.fieldRequested
        ? 'The requested run is waiting for a verified connection.'
        : 'No verified character is connected.',
      nextStep: 'Open Account to review sign-in and the selected character.',
      action: 'account',
    });
  } else if (status.connected === true && !context.fresh) {
    items.push({
      id: 'freshness',
      severity: 'warning',
      title: 'Waiting for fresh game status',
      detail: 'Character, inventory and action observations are stale.',
      nextStep:
        'Review the connection. Wait for fresh observations before relying on resource or action status.',
      action: 'account',
    });
  } else if (observed && status.compatible !== true) {
    items.push({
      id: 'compatibility',
      severity: 'warning',
      title: 'Character state unavailable',
      detail: text(status.reason),
      nextStep: 'Review the connection and character selection.',
      action: 'account',
    });
  }

  if (observed && status.compatible === true && status.player) {
    const result = record(status.actionResult);
    if (result.status === 'failed')
      items.push({
        id: 'action',
        severity: 'warning',
        title: 'Action needs review',
        detail: text(result.reason),
        nextStep:
          'Inspect the action result before another request. This outcome does not establish that a retry is safe.',
        action: 'tools',
      });
    if (record(status.player).dead === true)
      items.push({
        id: 'death',
        severity: 'warning',
        title: 'Character is dead',
        detail: text(status.reason),
        nextStep: 'Review revival settings and the remaining death allowance.',
        action: 'recovery',
      });
    if (settings?.automation) {
      const policy = settings.automation,
        stock = recoveryInventory(status.character);
      for (const resource of ['hp', 'sp'] as const satisfies readonly RecoveryResource[]) {
        const selected = resource === 'hp' ? policy.hpPotions : policy.spPotions;
        const rules = policy.items.filter((rule) => rule.resource === resource),
          ids = recoveryItemIds(selected, resource);
        if (!rules.length && !ids.length) continue;
        if (stock === null) {
          items.push({
            id: resource + '-stock',
            severity: 'info',
            title: resource.toUpperCase() + ' item stock unobserved',
            detail: 'Recovery is configured, but no complete inventory observation is available.',
            nextStep: 'Wait for verified inventory; review the selected items and reserves.',
            action: 'recovery',
          });
          continue;
        }
        const usable =
          rules.some((rule) => (stock.get(itemId(rule.itemId)) ?? 0) > rule.minStock) ||
          ids.some((id) => {
            const reserve = recoveryItemReserve(policy, resource, id);
            return reserve !== null && (stock.get(itemId(id)) ?? 0) > reserve;
          });
        if (!usable)
          items.push({
            id: resource + '-stock',
            severity: 'warning',
            title: 'No usable ' + resource.toUpperCase() + ' items',
            detail: 'Observed inventory has no configured item above its protected reserve.',
            nextStep: 'Review recovery choices and supplies. Protected stock will not be consumed.',
            action: 'recovery',
          });
      }
    }
    if (!items.length) {
      const view = clientStatus(value, context);
      if (view.state === 'WAITING' || result.status === 'pending')
        items.push({
          id: 'waiting',
          severity: 'info',
          title:
            result.status === 'pending' ? 'Waiting for action confirmation' : 'Waiting to continue',
          detail: view.reason || text(result.reason),
          nextStep:
            'Wait for the current owner to settle. Review its status without repeating the action.',
          action: 'tools',
        });
    }
  }
  const severity = { error: 0, warning: 1, info: 2 };
  return items.sort((a, b) => severity[a.severity] - severity[b.severity]).slice(0, 6);
}

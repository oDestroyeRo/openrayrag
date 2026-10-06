import { find, map } from 'remeda';
import { clientStatus } from './client-status';
import type { MapInfo } from '../navigation/map-data-logic';
import type { SettingsInput } from '../settings/settings';

const targetName = (monsters: MapInfo['monsters']) => (id: number) =>
  find(monsters, monster => monster.classId === id)?.name;

/** An idle task label can survive a run/state transition; it is not an action. */
export function dashboardTaskLabel(value: unknown): string {
  if (!value || typeof value !== 'object' || !('running' in value) || value.running !== true) return '';
  const task = value && typeof value === 'object' && 'task' in value ? value.task : null;
  const label = task && typeof task === 'object' && 'label' in task && typeof task.label === 'string' ? task.label.trim() : '';
  const activeTask = task && typeof task === 'object' && ('pending' in task && task.pending === true
    || 'kind' in task && typeof task.kind === 'string' && task.kind.trim() !== '' && task.kind !== 'idle');
  return activeTask ? label : '';
}

/** Display-only projection. Neither target presence nor log text proves an action. */
export function clientDashboard(value: unknown, context: Parameters<typeof clientStatus>[1] & { fresh?: boolean }, settings: SettingsInput | null, mapInfo?: MapInfo) {
  const status = clientStatus(value, context);
  const stale = context.fresh === false && value && typeof value === 'object' && 'connected' in value && value.connected === true
    && status.state !== 'WAITING' && !context.limitReason;
  const headline = stale ? 'Waiting for fresh game status' : status.state === 'RUNNING' ? dashboardTaskLabel(value) || 'Bot running'
    : status.state === 'WAITING' ? 'Waiting to continue'
    : status.state === 'READY' ? 'Ready to start'
    : status.state === 'CONNECTED' ? 'Choose your character' : 'Connect your character';
  if (!settings) return { ...status, headline, setup: 'Setup needs attention · review your settings' };
  const names = settings.map === mapInfo?.code ? map(settings.targets, targetName(mapInfo.monsters)) : [];
  const targets = !settings.targets.length ? 'No targets selected' : names.length && names.every(Boolean) && names.length <= 2
    ? names.join(', ') : `${settings.targets.length} selected targets`;
  const mode = settings.automation?.combat.mode;
  const targeting = mode === 'retaliate' ? 'Defend against attackers' : mode === 'both' ? `${targets} + defense` : targets;
  const loot = !settings.loot ? 'Pickup off' : settings.automation?.loot.ownership === 'all' ? 'All drops' : 'Own drops';
  const recovery = settings.automation?.recovery.enabled ? 'Recovery on' : 'Recovery off';
  return { ...status, headline, setup: `${targeting} · ${loot} · ${recovery}` };
}

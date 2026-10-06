import { filter, find, map, sumBy } from 'remeda';
import { clientStatus } from './client-status';
import type { MapInfo } from '../navigation/map-data-logic';
import type { AutomationSettingsInput, SettingsInput } from '../settings/settings';
import { recoveryItemIds, recoveryItemReserve, type RecoveryResource } from '../recovery/recovery-items';
import { recoveryInventory } from '../recovery/recovery-item-ui-logic';

const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' ? value as Record<string, unknown> : {};
const resourceObserved = (value: Record<string, unknown>, current: string, maximum: string): boolean =>
  typeof value[current] === 'number' && Number.isFinite(value[current]) && Number(value[current]) >= 0
  && typeof value[maximum] === 'number' && Number.isFinite(value[maximum]) && Number(value[maximum]) > 0;

/** Configuration stays visible even when its current stock or prerequisites are unavailable. */
function recoverySummary(value: unknown, automation: AutomationSettingsInput | undefined): string {
  const snapshot = record(value), character = record(snapshot.character), player = record(snapshot.player), stats = record(character.stats);
  const stock: ReadonlyMap<number, number> | null = recoveryInventory(character);
  const items = (resource: RecoveryResource): string => {
    const policy = resource === 'hp' ? automation?.hpPotions : automation?.spPotions;
    const rules = filter(automation?.items ?? [], rule => rule.resource === resource);
    const choices: string[] = [];
    if (policy?.mode === 'any') choices.push('any carried');
    if (policy?.mode === 'selected') choices.push(`${policy.itemIds.length} selected`);
    if (rules.length) choices.push(`${rules.length} rule${rules.length === 1 ? '' : 's'}`);
    const label = `${resource.toUpperCase()} items`;
    if (!choices.length) return `${label} off`;
    const ids = new Set([...recoveryItemIds(policy, resource), ...map(rules, rule => rule.itemId)]);
    const observed = resource === 'hp' ? resourceObserved(player, 'hp', 'maxHp') : resourceObserved(stats, 'sp', 'maxSp');
    const evidence = [stock === null ? 'stock unobserved' : `${sumBy([...ids], id => stock.get(id) ?? 0)} carried`];
    if (stock !== null && automation) {
      const usable = rules.some(rule => (stock.get(rule.itemId) ?? 0) > rule.minStock)
        || recoveryItemIds(policy, resource).some(id => {
          const reserve = recoveryItemReserve(automation, resource, id);
          return reserve !== null && (stock.get(id) ?? 0) > reserve;
        });
      if (!usable) evidence.push('no usable stock');
    }
    if (!observed) evidence.push(`${resource.toUpperCase()} unobserved`);
    return `${label}: ${choices.join(' + ')} (${evidence.join('; ')})`;
  };
  const prerequisites: string[] = [];
  if (automation?.recovery.enabled) {
    if (!resourceObserved(player, 'hp', 'maxHp')) prerequisites.push('HP unobserved');
    if (player.classId === 0) {
      const basic = Array.isArray(character.learned) ? find(character.learned, skill => record(skill).skillId === 1) : undefined;
      if (character.skillsKnown !== true) prerequisites.push('Basic Mastery unverified');
      else if (Number(record(basic).level ?? 0) < 2) prerequisites.push('Basic Mastery below 2');
    }
    if (automation.recovery.spStart > 0 && !resourceObserved(stats, 'sp', 'maxSp')) prerequisites.push('SP unobserved');
  }
  const sitting = automation?.recovery.enabled ? `Sitting on${prerequisites.length ? ` (${prerequisites.join('; ')})` : ''}` : 'Sitting off';
  return `${sitting} · ${items('hp')} · ${items('sp')} · Respawn ${automation?.respawn.enabled ? 'on' : 'off'}`;
}

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
  const recovery = recoverySummary(value, settings.automation);
  return { ...status, headline, setup: `${targeting} · ${loot} · ${recovery}` };
}

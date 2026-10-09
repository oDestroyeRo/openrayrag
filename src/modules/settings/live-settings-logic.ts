import {
  automationDraft,
  automationSettings,
  settingsDraft,
  validateFormSettings,
  validateSettings,
  type RunSettings,
  type SettingsInput,
} from './settings';
import { recoveryItemIds } from '../recovery/recovery-items';

export interface SettingsApplySnapshot {
  id: string;
  state: 'pending' | 'applied' | 'rejected' | 'cancelled';
  applied: string[];
  pending: string[];
  nextRun: string[];
  reason: string;
}
export interface LiveSettingsPlan {
  settings: RunSettings;
  live: string[];
  nextRun: string[];
}
export interface RecoveryProtection {
  minStock: number;
  cooldownSeconds: number;
}
export interface LiveSettingsGuard {
  version: 1;
  character: string;
  items: Array<RecoveryProtection & { itemId: number }>;
  hp: RecoveryProtection;
  sp: RecoveryProtection;
  cooldowns: Array<{ key: string; at: number }>;
}
export const validSettingsApplyId = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-f0-9]{32}$/.test(value);

function sameSettingsValue(before: unknown, after: unknown): boolean {
  if (before === after) return true;
  if (Array.isArray(before) || Array.isArray(after))
    return (
      Array.isArray(before) &&
      Array.isArray(after) &&
      before.length === after.length &&
      before.every((value, index) => sameSettingsValue(value, after[index]))
    );
  const left = record(before),
    right = record(after);
  return (
    !!left &&
    !!right &&
    [...new Set([...Object.keys(left), ...Object.keys(right)])].every((key) =>
      sameSettingsValue(left[key], right[key]),
    )
  );
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
/** Arrays are one ordered rule/selection edit; object fields remain individually visible. */
export function settingsChanges(before: unknown, after: unknown, path = ''): string[] {
  if (sameSettingsValue(before, after)) return [];
  const left = record(before),
    right = record(after);
  if (left && right)
    return [...new Set([...Object.keys(left), ...Object.keys(right)])]
      .sort()
      .flatMap((key) => settingsChanges(left[key], right[key], path ? `${path}.${key}` : key));
  return [path];
}
function normalized(input: SettingsInput): SettingsInput {
  return { ...input, automation: automationSettings(input) };
}
export function validateLiveSettingsGuard(value: unknown, now: number): LiveSettingsGuard {
  const v = record(value),
    integer = (n: unknown, min: number, max: number) =>
      typeof n === 'number' && Number.isSafeInteger(n) && n >= min && n <= max;
  const protection = (row: unknown, keys: string[]) => {
    const r = record(row);
    return (
      !!r &&
      Object.keys(r).length === keys.length &&
      Object.keys(r).every((key) => keys.includes(key)) &&
      integer(r.minStock, 0, 9999) &&
      integer(r.cooldownSeconds, 0, 3600)
    );
  };
  if (
    !v ||
    Object.keys(v).length !== 6 ||
    v.version !== 1 ||
    typeof v.character !== 'string' ||
    !v.character ||
    v.character.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(v.character) ||
    !Array.isArray(v.items) ||
    v.items.length > 256 ||
    !v.items.every(
      (row) =>
        protection(row, ['itemId', 'minStock', 'cooldownSeconds']) &&
        integer(row.itemId, 1, 0x7fffffff),
    ) ||
    new Set(v.items.map((row) => row.itemId)).size !== v.items.length ||
    !protection(v.hp, ['minStock', 'cooldownSeconds']) ||
    !protection(v.sp, ['minStock', 'cooldownSeconds']) ||
    !Array.isArray(v.cooldowns) ||
    v.cooldowns.length > 256 ||
    !v.cooldowns.every((row) => {
      const r = record(row);
      return (
        !!r &&
        Object.keys(r).length === 2 &&
        typeof r.key === 'string' &&
        /^(?:item:[1-9][0-9]{0,9}|hp-potions|sp-potions)$/.test(r.key) &&
        (!r.key.startsWith('item:') || integer(Number(r.key.slice(5)), 1, 0x7fffffff)) &&
        integer(r.at, 0, now)
      );
    }) ||
    new Set(v.cooldowns.map((row) => row.key)).size !== v.cooldowns.length
  )
    throw new Error('Invalid live settings resource protection.');
  return structuredClone(v) as unknown as LiveSettingsGuard;
}
/** Old publications may not reduce a floor or move a confirmed clock backward. */
export function mergeLiveSettingsGuards(
  left: LiveSettingsGuard | null,
  right: LiveSettingsGuard,
  now: number,
): LiveSettingsGuard {
  const current = validateLiveSettingsGuard(right, now);
  if (!left) return current;
  const previous = validateLiveSettingsGuard(left, now);
  if (previous.character !== current.character)
    throw new Error('Live settings protection belongs to another character.');
  const items = new Map(previous.items.map((row) => [row.itemId, { ...row }]));
  for (const row of current.items) {
    const old = items.get(row.itemId);
    items.set(row.itemId, {
      ...row,
      minStock: Math.max(row.minStock, old?.minStock ?? 0),
      cooldownSeconds: Math.max(row.cooldownSeconds, old?.cooldownSeconds ?? 0),
    });
  }
  const clocks = new Map(previous.cooldowns.map((row) => [row.key, row.at]));
  for (const row of current.cooldowns)
    clocks.set(row.key, Math.max(row.at, clocks.get(row.key) ?? 0));
  const floor = (resource: 'hp' | 'sp') => ({
    minStock: Math.max(previous[resource].minStock, current[resource].minStock),
    cooldownSeconds: Math.max(
      previous[resource].cooldownSeconds,
      current[resource].cooldownSeconds,
    ),
  });
  return validateLiveSettingsGuard(
    {
      ...current,
      items: [...items.values()],
      hp: floor('hp'),
      sp: floor('sp'),
      cooldowns: [...clocks].map(([key, at]) => ({ key, at })),
    },
    now,
  );
}
/** Transfer only resource floors and confirmed clocks; no action can be replayed. */
export function liveSettingsGuard(
  settings: SettingsInput,
  previous: LiveSettingsGuard | null,
  character: string,
  cooldowns: LiveSettingsGuard['cooldowns'],
  now: number,
): LiveSettingsGuard {
  const policy = automationSettings(validateSettings(settings)),
    items = new Map((previous?.items ?? []).map((row) => [row.itemId, { ...row }]));
  const protect = (rule: RecoveryProtection & { itemId: number }) => {
    const old = items.get(rule.itemId);
    items.set(rule.itemId, {
      itemId: rule.itemId,
      minStock: Math.max(rule.minStock, old?.minStock ?? 0),
      cooldownSeconds: Math.max(rule.cooldownSeconds, old?.cooldownSeconds ?? 0),
    });
  };
  for (const rule of policy.items) protect(rule);
  for (const resource of ['hp', 'sp'] as const) {
    const group = resource === 'hp' ? policy.hpPotions : policy.spPotions;
    if (group) for (const itemId of recoveryItemIds(group, resource)) protect({ ...group, itemId });
  }
  const floor = (resource: 'hp' | 'sp'): RecoveryProtection => {
    const group = resource === 'hp' ? policy.hpPotions : policy.spPotions,
      old = previous?.[resource];
    return {
      minStock: Math.max(group?.minStock ?? 0, old?.minStock ?? 0),
      cooldownSeconds: Math.max(group?.cooldownSeconds ?? 0, old?.cooldownSeconds ?? 0),
    };
  };
  return validateLiveSettingsGuard(
    {
      version: 1,
      character,
      items: [...items.values()],
      hp: floor('hp'),
      sp: floor('sp'),
      cooldowns,
    },
    now,
  );
}

/** Admit the whole draft before projecting supported edits, then admit the merged
 * configuration too. Original finite policies and protected reserves stay owned
 * by the run; neither a draft nor a projection can renew them.
 */
export function planLiveSettings(
  active: SettingsInput,
  proposed: SettingsInput,
  protectedSettings: SettingsInput = active,
  guard?: LiveSettingsGuard | null,
): LiveSettingsPlan {
  const original = validateSettings(active),
    draft = validateFormSettings(proposed);
  const next = settingsDraft(original),
    policy = automationDraft(automationSettings(original));
  const desired = automationDraft(automationSettings(draft)),
    previous = automationSettings(original);
  const protectedPolicy = automationSettings(validateSettings(protectedSettings));
  const protection = (id: number) =>
    [previous, protectedPolicy].flatMap((value) => [
      ...value.items.filter((rule) => rule.itemId === id),
      ...(['hp', 'sp'] as const).flatMap((resource) => {
        const group = resource === 'hp' ? value.hpPotions : value.spPotions;
        return group && recoveryItemIds(group, resource).some((value) => value === id)
          ? [group]
          : [];
      }),
      ...(guard?.items.filter((rule) => rule.itemId === id) ?? []),
    ]);
  next.targets = [...draft.targets];
  next.radius = draft.radius;
  next.loot = draft.loot;
  policy.combat = desired.combat;
  policy.loot = desired.loot;
  policy.recovery = { ...desired.recovery, timeoutSeconds: previous.recovery.timeoutSeconds };
  for (const resource of ['hpPotions', 'spPotions'] as const) {
    const value = desired[resource],
      old = previous[resource];
    const floor = protectedPolicy[resource];
    const itemFloors = value
      ? recoveryItemIds(value, resource === 'hpPotions' ? 'hp' : 'sp').flatMap(protection)
      : [];
    if (value)
      policy[resource] = {
        ...value,
        minStock: Math.max(
          value.minStock,
          old?.minStock ?? 0,
          floor?.minStock ?? 0,
          guard?.[resource === 'hpPotions' ? 'hp' : 'sp'].minStock ?? 0,
          ...itemFloors.map((rule) => rule.minStock),
        ),
        cooldownSeconds: Math.max(
          value.cooldownSeconds,
          old?.cooldownSeconds ?? 0,
          floor?.cooldownSeconds ?? 0,
          guard?.[resource === 'hpPotions' ? 'hp' : 'sp'].cooldownSeconds ?? 0,
          ...itemFloors.map((rule) => rule.cooldownSeconds),
        ),
      };
    else delete policy[resource];
  }
  policy.items = desired.items.map((rule) => {
    const floors = protection(rule.itemId);
    return {
      ...rule,
      minStock: Math.max(rule.minStock, ...floors.map((value) => value.minStock)),
      cooldownSeconds: Math.max(
        rule.cooldownSeconds,
        ...floors.map((value) => value.cooldownSeconds),
      ),
    };
  });
  next.automation = policy;
  const settings = validateSettings(next);
  return {
    settings,
    live: settingsChanges(normalized(original), normalized(settings)),
    nextRun: settingsChanges(normalized(settings), normalized(draft)),
  };
}

/** Runtime acknowledgement owns the exact supported values. Retention keeps
 * original run-only allowances, without planning or changing those values again.
 */
export function acknowledgedLiveSettings(
  active: SettingsInput,
  acknowledgement: SettingsInput,
): RunSettings {
  const original = validateSettings(active),
    applied = validateSettings(acknowledgement),
    next = settingsDraft(original);
  const policy = automationDraft(automationSettings(original)),
    value = automationDraft(automationSettings(applied));
  next.targets = [...applied.targets];
  next.radius = applied.radius;
  next.loot = applied.loot;
  policy.combat = value.combat;
  policy.loot = value.loot;
  policy.recovery = { ...value.recovery, timeoutSeconds: policy.recovery.timeoutSeconds };
  policy.items = value.items;
  for (const resource of ['hpPotions', 'spPotions'] as const) {
    if (value[resource]) policy[resource] = value[resource];
    else delete policy[resource];
  }
  next.automation = policy;
  return validateSettings(next);
}

export function validSettingsApplySnapshot(value: unknown): value is SettingsApplySnapshot {
  const v = record(value);
  if (
    !v ||
    !validSettingsApplyId(v.id) ||
    !['pending', 'applied', 'rejected', 'cancelled'].includes(String(v.state)) ||
    typeof v.reason !== 'string' ||
    v.reason.length > 1024 ||
    Object.keys(v).some(
      (key) => !['id', 'state', 'applied', 'pending', 'nextRun', 'reason'].includes(key),
    )
  )
    return false;
  return ['applied', 'pending', 'nextRun'].every(
    (key) =>
      Array.isArray(v[key]) &&
      v[key].length <= 128 &&
      v[key].every(
        (path: unknown) =>
          typeof path === 'string' && path.length <= 256 && /^[a-zA-Z0-9_.]+$/.test(path),
      ),
  );
}

const labels: Record<string, string> = {
  targets: 'Combat targets',
  radius: 'Scan radius',
  loot: 'Pickup enabled',
  'automation.combat': 'Combat policy',
  'automation.loot': 'Loot policy',
  'automation.recovery': 'Rest recovery',
  'automation.hpPotions': 'HP items',
  'automation.spPotions': 'SP items',
  'automation.items': 'Item rules',
};
const fieldLabels: Record<string, string> = {
  belowPercent: 'Threshold',
  minStock: 'Stock reserve',
  cooldownSeconds: 'Cooldown',
  hpStart: 'HP start',
  hpEnd: 'HP end',
  spStart: 'SP start',
  spEnd: 'SP end',
  route_randomWalk: 'Random walk',
  route_step: 'Route step',
  route_avoidWalls: 'Avoid walls',
  route_randomWalk_maxRouteTime: 'Route time limit',
  attackRouteMaxPathDistance: 'Attack path limit',
  attackMaxRouteTime: 'Attack route time',
  hpPotions: 'HP items',
  spPotions: 'SP items',
};
const readable = (value: string) =>
  fieldLabels[value] ??
  value
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replaceAll('_', ' ')
    .replace(/^./, (letter) => letter.toUpperCase());
export function liveSettingLabel(path: string): string {
  const owner = Object.keys(labels).find((key) => path === key || path.startsWith(`${key}.`));
  return owner
    ? `${labels[owner]}${
        path === owner
          ? ''
          : ` · ${path
              .slice(owner.length + 1)
              .split('.')
              .map(readable)
              .join(' · ')}`
      }`
    : path
        .replace(/^automation\./, '')
        .split('.')
        .map(readable)
        .join(' · ');
}

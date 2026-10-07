import {
  farmingDestination,
  validateDeathRecoveryGuard,
  type DeathRecoveryGuard,
} from '../recovery/death-recovery';
import {
  validExperienceGains,
  validRunExperience,
  type ExperienceGains,
  type RunExperience,
} from './run-experience-logic';
import {
  validateSettings,
  type SettingsInput as Settings,
  type RunSettings,
} from '../settings/settings';
import { validateSupplyResumeGuard, type SupplyResumeGuard } from '../services/supply-trip-logic';
import {
  validateEscapeResumeGuard,
  type EscapeRecovery,
  type EscapeResumeGuard,
  type EscapeSnapshot,
} from '../recovery/escape-logic';
import {
  validateLiveSettingsGuard,
  type LiveSettingsGuard,
  type SettingsApplySnapshot,
} from '../settings/live-settings-logic';
export const INITIAL_DELAY = 5_000;

export const MAX_DELAY = 60_000;

export const transientFailure = (message: string): boolean =>
  /(?:disconnected during sign-in|sign-in timed out)/i.test(message);

export interface RunSession {
  sessionId: string;
  connected: boolean;
  compatible: boolean;
  map: string;
  player: { name: string; dead?: boolean } | null;
  runRequested?: boolean;
  kills?: number;
  looted?: number;
  deaths?: number;
  attacks?: number;
  runExperience?: RunExperience | null;
  escape?: EscapeSnapshot;
  supplyGuard?: SupplyResumeGuard;
  deathRecoveryGuard?: DeathRecoveryGuard;
  settingsApply?: SettingsApplySnapshot | null;
  activeSettings?: Settings | null;
  liveSettingsGuard?: LiveSettingsGuard | null;
}

export interface ResumeRequest {
  generation: number;
  sessionId: string;
  settings: Settings;
  escapeGuard?: EscapeResumeGuard;
  supplyGuard?: SupplyResumeGuard;
  deathRecoveryGuard?: DeathRecoveryGuard;
  liveSettingsGuard?: LiveSettingsGuard;
}

export const MAX_ESCAPE_GUARDS = 64;

export interface RetainedEscape {
  session: string;
  cooldownUntil: number;
  latched: boolean;
  recovery?: EscapeRecovery;
}

interface FieldMetrics {
  kills: number;
  looted: number;
  deaths: number;
  attacks: number;
}

export interface RetainedSupply {
  session: string;
  at: number;
  guard: SupplyResumeGuard;
}

export interface RetainedDeath {
  session: string;
  at: number;
  guard: DeathRecoveryGuard;
}

/** A data-only updater checkpoint for the original requested field run. */
export interface FieldRunCheckpoint {
  version: 1;
  desired: Settings;
  character: string;
  session: string;
  generation: number;
  startedAt: number;
  metricsSession: string;
  previous: FieldMetrics;
  totals: FieldMetrics;
  escapeGuard: RetainedEscape | null;
  supplyGuard: RetainedSupply | null;
  deathGuard: RetainedDeath | null;
  escapeOverflowUncertain: boolean;
  supplyOverflow: boolean;
  deathOverflow: boolean;
  experience?: { gains: ExperienceGains; previous: RunExperience | null; session: string };
  liveSettingsGuard?: LiveSettingsGuard | null;
}

const MAX_TIMESTAMP = 8_640_000_000_000_000;

export const sessionIdentity = (value: unknown): value is string =>
  typeof value === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value);

export const timestamp = (value: unknown): value is number =>
  Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= MAX_TIMESTAMP;

function checkpointRecord(
  value: unknown,
  required: string[],
  optional: string[] = [],
): Record<string, unknown> {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    ![Object.prototype, null].includes(Object.getPrototypeOf(value)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error('Invalid field run checkpoint.');
  return value as Record<string, unknown>;
}

/** Validate completely before any run intent or retained allowance can change. */
export type ValidatedFieldRunCheckpoint = Omit<FieldRunCheckpoint, 'desired'> & {
  desired: RunSettings;
};
export function validateFieldRunCheckpoint(
  value: unknown,
  now: number,
): ValidatedFieldRunCheckpoint {
  const v = checkpointRecord(
    value,
    [
      'version',
      'desired',
      'character',
      'session',
      'generation',
      'startedAt',
      'metricsSession',
      'previous',
      'totals',
      'escapeGuard',
      'supplyGuard',
      'deathGuard',
      'escapeOverflowUncertain',
      'supplyOverflow',
      'deathOverflow',
    ],
    ['experience', 'liveSettingsGuard'],
  );
  if (
    v.version !== 1 ||
    typeof v.character !== 'string' ||
    !v.character.trim() ||
    v.character.length > 64 ||
    /[\u0000-\u001f\u007f]/.test(v.character) ||
    /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(v.character) ||
    !sessionIdentity(v.session) ||
    !sessionIdentity(v.metricsSession) ||
    v.metricsSession !== v.session ||
    !Number.isSafeInteger(v.generation) ||
    Number(v.generation) < 1 ||
    Number(v.generation) >= Number.MAX_SAFE_INTEGER ||
    !timestamp(now) ||
    !timestamp(v.startedAt) ||
    v.startedAt > now ||
    ['escapeOverflowUncertain', 'supplyOverflow', 'deathOverflow'].some(
      (key) => typeof v[key] !== 'boolean',
    )
  )
    throw new Error('Invalid field run checkpoint identity or bounds.');
  const desired = validateSettings(v.desired as Settings);
  if (v.experience !== undefined) {
    const experience = checkpointRecord(v.experience, ['gains', 'previous', 'session']);
    if (
      !validExperienceGains(experience.gains) ||
      !sessionIdentity(experience.session) ||
      (experience.previous !== null &&
        (!validRunExperience(experience.previous) || experience.previous.character !== v.character))
    )
      throw new Error('Invalid field run experience checkpoint.');
  }
  const liveSettingsGuard =
    v.liveSettingsGuard === undefined || v.liveSettingsGuard === null
      ? null
      : validateLiveSettingsGuard(v.liveSettingsGuard, now);
  if (liveSettingsGuard && liveSettingsGuard.character !== v.character)
    throw new Error('Live settings protection belongs to another character.');
  if (
    (v.escapeGuard === null && !v.escapeOverflowUncertain) ||
    (desired.automation?.supply?.enabled && v.supplyGuard === null && !v.supplyOverflow)
  )
    throw new Error('Missing field run allowance state.');
  for (const metrics of [v.previous, v.totals]) {
    const counters = checkpointRecord(metrics, ['kills', 'looted', 'deaths', 'attacks']);
    if (
      Object.values(counters).some(
        (counter) => !Number.isSafeInteger(counter) || Number(counter) < 0,
      )
    )
      throw new Error('Invalid field run checkpoint counters.');
  }
  if (v.escapeGuard !== null) {
    const guard = checkpointRecord(
      v.escapeGuard,
      ['session', 'cooldownUntil', 'latched'],
      ['recovery'],
    );
    // An empty owner is the existing conservative overflow latch.
    if (
      !(
        sessionIdentity(guard.session) ||
        (guard.session === '' && guard.latched === true && v.escapeOverflowUncertain === true)
      ) ||
      !timestamp(guard.cooldownUntil) ||
      guard.cooldownUntil > now + 3_600_000
    )
      throw new Error('Invalid field run escape owner.');
    validateEscapeResumeGuard({
      cooldownSeconds: 0,
      latched: guard.latched as boolean,
      ...(Object.hasOwn(guard, 'recovery') ? { recovery: guard.recovery as EscapeRecovery } : {}),
    });
  }
  if (v.supplyGuard !== null) {
    const retained = checkpointRecord(v.supplyGuard, ['session', 'at', 'guard']);
    const guard = validateSupplyResumeGuard(retained.guard);
    if (
      !sessionIdentity(retained.session) ||
      !timestamp(retained.at) ||
      retained.at > now ||
      guard.character !== v.character
    )
      throw new Error('Invalid field run supply owner.');
  }
  if (v.deathGuard !== null) {
    const retained = checkpointRecord(v.deathGuard, ['session', 'at', 'guard']);
    const guard = validateDeathRecoveryGuard(retained.guard);
    if (
      !sessionIdentity(retained.session) ||
      !timestamp(retained.at) ||
      retained.at > now ||
      guard.character !== v.character ||
      guard.destination !== farmingDestination(desired) ||
      guard.recoveryDeadline > retained.at + guard.recoverySeconds * 1000 ||
      guard.returnDeadline >
        retained.at +
          (guard.phase === 'return'
            ? guard.returnSeconds
            : guard.recoverySeconds + guard.returnSeconds) *
            1000
    )
      throw new Error('Invalid field run death owner or deadline.');
  }
  return { ...(structuredClone(value) as FieldRunCheckpoint), desired, liveSettingsGuard };
}

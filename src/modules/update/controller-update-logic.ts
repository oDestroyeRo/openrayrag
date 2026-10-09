import {
  milliseconds,
  quantity,
  type Milliseconds,
  type Quantity,
} from '../../shared/domain-values';
import { validRunExperience } from '../session/run-experience-logic';
import type { CompanionSnapshot } from '../runtime/controller';
import { validateMacroCheckpoint, type MacroCheckpoint } from '../automation/macros-logic';
import { validatePartyHealCheckpoint, type PartyHealCheckpoint } from '../party/party-heal-logic';
import { validateSettings, type SettingsInput, type RunSettings } from '../settings/settings';
import type { EscapeResumeGuard } from '../recovery/escape-logic';
import type { SupplyResumeGuard } from '../services/supply-trip-logic';
import type { DeathRecoveryGuard } from '../recovery/death-recovery';
import { validateLiveSettingsGuard, type LiveSettingsGuard } from '../settings/live-settings-logic';
import {
  validateDatabaseTravelCheckpoint,
  type DatabaseTravelCheckpoint,
} from '../navigation/travel-controller-logic';
import { farmingDestination } from '../recovery/death-recovery';
export interface ControllerUpdateCheckpoint {
  version: 1;
  frozenAt: number;
  status: CompanionSnapshot;
  settings: SettingsInput | null;
  macro: MacroCheckpoint | null;
  partyHeal: PartyHealCheckpoint;
  liveSettingsGuard?: LiveSettingsGuard | null;
  databaseTravel?: DatabaseTravelCheckpoint | null;
  run: { startedAt: number; kills: number; pickups: number; deaths: number } | null;
}

export interface ValidatedControllerRunAllowance {
  readonly startedAt: Milliseconds;
  readonly kills: Quantity;
  readonly pickups: Quantity;
  readonly deaths: Quantity;
}
export interface ValidatedControllerUpdateCheckpoint {
  readonly version: 1;
  readonly frozenAt: Milliseconds;
  readonly status: CompanionSnapshot;
  readonly settings: RunSettings | null;
  readonly macro: MacroCheckpoint | null;
  readonly partyHeal: PartyHealCheckpoint;
  readonly run: ValidatedControllerRunAllowance | null;
  readonly liveSettingsGuard: LiveSettingsGuard | null;
  readonly databaseTravel?: DatabaseTravelCheckpoint;
}

export interface ControllerUpdateRestore {
  requestId: string;
  checkpoint: unknown;
  settings?: SettingsInput;
  escapeGuard?: EscapeResumeGuard;
  supplyGuard?: SupplyResumeGuard;
  deathRecoveryGuard?: DeathRecoveryGuard;
}

/** Resource owners and actor observations are deliberately absent from restore authority. */
export function validateControllerUpdateCheckpoint(
  value: unknown,
  now: number,
): ValidatedControllerUpdateCheckpoint {
  const c = value as ControllerUpdateCheckpoint;
  if (
    !c ||
    typeof c !== 'object' ||
    Array.isArray(c) ||
    Object.keys(c).some(
      (key) =>
        ![
          'version',
          'frozenAt',
          'status',
          'settings',
          'macro',
          'partyHeal',
          'run',
          'liveSettingsGuard',
          'databaseTravel',
        ].includes(key),
    ) ||
    c.version !== 1 ||
    !Number.isSafeInteger(c.frozenAt) ||
    c.frozenAt < 0 ||
    c.frozenAt > now ||
    !c.status ||
    typeof c.status !== 'object' ||
    Array.isArray(c.status) ||
    !c.status.player ||
    typeof c.status.player.name !== 'string' ||
    c.status.connected !== true ||
    c.status.compatible !== true ||
    c.status.running !== false ||
    typeof c.status.runRequested !== 'boolean' ||
    (c.status.initialFieldEntryPending !== undefined &&
      typeof c.status.initialFieldEntryPending !== 'boolean') ||
    !c.status.macro ||
    typeof c.status.macro.state !== 'string'
  )
    throw new Error('Invalid controller update checkpoint.');
  const settings = c.settings === null ? null : validateSettings(c.settings);
  const databaseTravel =
    c.databaseTravel == null
      ? null
      : validateDatabaseTravelCheckpoint(c.databaseTravel, c.frozenAt);
  if (
    databaseTravel &&
    (!settings ||
      !c.status.runRequested ||
      c.macro !== null ||
      databaseTravel.destination !== farmingDestination(settings) ||
      c.status.travel?.destination !== databaseTravel.destination ||
      !['walking', 'failed'].includes(c.status.travel.state) ||
      databaseTravel.failed !== (c.status.travel.state === 'failed'))
  )
    throw new Error('Unsent Database travel does not match the captured field intent.');
  if (
    c.status.runExperience !== undefined &&
    c.status.runExperience !== null &&
    (!validRunExperience(c.status.runExperience) ||
      c.status.runExperience.character !== c.status.player.name)
  )
    throw new Error('Invalid controller run experience checkpoint.');
  const macro = c.macro === null ? null : validateMacroCheckpoint(c.macro);
  const partyHeal = validatePartyHealCheckpoint(c.partyHeal);
  const liveSettingsGuard =
    c.liveSettingsGuard === undefined || c.liveSettingsGuard === null
      ? null
      : validateLiveSettingsGuard(c.liveSettingsGuard, c.frozenAt);
  if (liveSettingsGuard && liveSettingsGuard.character !== c.status.player.name)
    throw new Error('Live settings protection belongs to another character.');
  const run = c.run;
  if (
    run !== null &&
    (!run ||
      typeof run !== 'object' ||
      Object.keys(run).length !== 4 ||
      !Number.isSafeInteger(run.startedAt) ||
      run.startedAt < 0 ||
      run.startedAt > c.frozenAt ||
      ![run.kills, run.pickups, run.deaths].every((n) => Number.isSafeInteger(n) && n >= 0))
  )
    throw new Error('Invalid controller run allowance checkpoint.');
  if ((c.status.runRequested || macro !== null) && (!settings || !run))
    throw new Error('Update continuation settings and run allowances are missing.');
  if (
    (macro &&
      (macro.startedAt > c.frozenAt ||
        macro.lastTime > c.frozenAt ||
        macro.selector.lastTime > c.frozenAt)) ||
    (c.status.macro &&
      ['running', 'waiting', 'monitoring'].includes(c.status.macro.state) !== (macro !== null)) ||
    c.status.running ||
    (c.status.partyHeal && ['pending', 'uncertain'].includes(c.status.partyHeal.state))
  )
    throw new Error('Update checkpoint has unresolved or inconsistent active ownership.');
  const cooldownSeconds = settings?.automation?.partyHeal?.enabled
    ? settings.automation.partyHeal.cooldownSeconds
    : 3600;
  if (partyHeal.cooldownUntil > c.frozenAt + Math.max(1, cooldownSeconds) * 1000)
    throw new Error('Update party Heal cooldown exceeds its configured allowance.');
  return {
    version: 1,
    frozenAt: milliseconds(c.frozenAt),
    status: structuredClone(c.status),
    settings,
    macro,
    partyHeal,
    liveSettingsGuard,
    ...(databaseTravel ? { databaseTravel } : {}),
    run:
      run === null
        ? null
        : {
            startedAt: milliseconds(run.startedAt),
            kills: quantity(run.kills),
            pickups: quantity(run.pickups),
            deaths: quantity(run.deaths),
          },
  };
}

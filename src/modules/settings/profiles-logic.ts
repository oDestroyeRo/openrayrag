import { appendAll, filter, findFirst, map, dedupe } from 'effect/Array';
import { pipe, flow, identity } from 'effect/Function';
import {
  flatMap,
  fromOption,
  gen,
  getOrThrowWith,
  map as mapResult,
  try as tryResult,
  type Result,
} from 'effect/Result';
import { DomainValueError } from '../../shared/domain-values';
import {
  DEFAULT_AUTOMATION,
  DEFAULT_SETTINGS,
  validateSettings,
  type SettingsInput,
  type RunSettings,
} from './settings';

export const MAX_PROFILES = 20;
const MAX_DOCUMENT_BYTES = 256_000;
declare const profileValue: unique symbol;
export type ProfileId = string & { readonly [profileValue]: 'ProfileId' };
export type ProfileName = string & { readonly [profileValue]: 'ProfileName' };
export type ProfileSavedAt = number & { readonly [profileValue]: 'ProfileSavedAt' };
const INVALID_METADATA = 'Invalid profile name or metadata.';
export function profileId(value: unknown): ProfileId {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value))
    throw new DomainValueError(
      'ProfileId',
      typeof value === 'string' ? 'range' : 'type',
      'profile name or metadata.',
    );
  return value as ProfileId;
}
export function profileName(value: unknown): ProfileName {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > 48 ||
    /[\u0000-\u001f\u007f]/.test(value)
  )
    throw new DomainValueError(
      'ProfileName',
      typeof value === 'string' ? 'range' : 'type',
      'profile name or metadata.',
    );
  return value.trim() as ProfileName;
}
export function profileSavedAt(value: unknown): ProfileSavedAt {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new DomainValueError(
      'ProfileSavedAt',
      typeof value === 'number' ? 'range' : 'type',
      'profile name or metadata.',
    );
  return value as ProfileSavedAt;
}
/** Editable and serialized input; admission belongs to checkedProfile. */
export interface BotProfileInput {
  id: string;
  name: string;
  character: string;
  savedAt: number;
  settings: SettingsInput;
}
export interface BotProfile {
  readonly id: ProfileId;
  readonly name: ProfileName;
  readonly character: string;
  readonly savedAt: ProfileSavedAt;
  readonly settings: RunSettings;
}
export interface ProfileDocument {
  readonly version: 1;
  readonly profiles: readonly BotProfile[];
}
const profileIds = flow(
  map<readonly BotProfile[], string>((profile) => profile.id),
  dedupe,
);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key) => expected.includes(key));
}
function ruleKeys(value: Record<string, unknown>, expected: string[], path: string): boolean {
  return keys(value, [
    ...expected,
    ...(['items', 'skills', 'equipment', 'combat.rules'].includes(path) &&
    Object.hasOwn(value, 'conditions')
      ? ['conditions']
      : []),
  ]);
}
function checkedSettings(value: unknown): RunSettings {
  const expected = [
    ...Object.keys(DEFAULT_SETTINGS),
    ...(record(value) && Object.hasOwn(value, 'minHpPercent') ? ['minHpPercent'] : []),
    ...(record(value) && Object.hasOwn(value, 'automation') ? ['automation'] : []),
  ];
  if (!record(value) || !keys(value, expected))
    throw new Error('Profile contains unknown or missing settings.');
  if (Object.hasOwn(value, 'automation')) {
    // Older profiles predate escape and loadout controls. Only these sections
    // get defaults; unknown fields and missing older sections still fail closed.
    const a = record(value.automation)
      ? {
          escape: DEFAULT_AUTOMATION.escape,
          loadout: structuredClone(DEFAULT_AUTOMATION.loadout),
          ...value.automation,
        }
      : value.automation;
    if (
      !record(a) ||
      !keys(a, [
        ...Object.keys(DEFAULT_AUTOMATION),
        ...(Object.hasOwn(a, 'disposition') ? ['disposition'] : []),
        ...(Object.hasOwn(a, 'supply') ? ['supply'] : []),
        ...(Object.hasOwn(a, 'attackStrategies') ? ['attackStrategies'] : []),
        ...(Object.hasOwn(a, 'mapPolicy') ? ['mapPolicy'] : []),
        ...(Object.hasOwn(a, 'partyHeal') ? ['partyHeal'] : []),
        ...(Object.hasOwn(a, 'retreat') ? ['retreat'] : []),
        ...(Object.hasOwn(a, 'hpPotions') ? ['hpPotions'] : []),
      ])
    )
      throw new Error('Profile contains unknown automation settings.');
    const arrayKeys: Record<string, string[]> = {
      items: ['itemId', 'resource', 'belowPercent', 'minStock', 'cooldownSeconds'],
      skills: ['skillId', 'level', 'target', 'hpBelowPercent', 'spAbovePercent', 'cooldownSeconds'],
      equipment: ['itemId', 'hpBelowPercent', 'monsterClassId'],
      'combat.rules': ['classId', 'action', 'priority'],
      'loot.rules': ['itemId', 'action', 'priority'],
      'allocation.stats': ['stat', 'target'],
      'allocation.skills': ['skillId', 'target'],
      'travel.waypoints': ['map', 'x', 'y'],
      'loadout.ammoPreferences': ['itemId'],
    };
    for (const [key, template] of Object.entries(DEFAULT_AUTOMATION)) {
      const child = a[key];
      if (Array.isArray(template)) {
        if (
          !Array.isArray(child) ||
          !child.every((entry) => record(entry) && ruleKeys(entry, arrayKeys[key]!, key))
        )
          throw new Error('Profile contains unknown rule settings.');
      } else {
        if (!record(child)) throw new Error('Profile contains unknown automation settings.');
        const optional =
          key === 'escape'
            ? ['hpEnabled', 'threatEnabled', 'threatCount', 'threatWindowSeconds']
            : key === 'combat'
              ? ['partyEngagement']
              : [];
        const fields = Object.keys(template).filter(
          (field) => !optional.includes(field) || Object.hasOwn(child, field),
        );
        if (key === 'follow')
          fields.push(...['mode', 'rendezvous'].filter((field) => Object.hasOwn(child, field)));
        if (!keys(child, fields)) throw new Error('Profile contains unknown automation settings.');
        for (const [field, fields] of Object.entries(arrayKeys))
          if (field.startsWith(`${key}.`)) {
            const entries = child[field.slice(key.length + 1)];
            if (
              !Array.isArray(entries) ||
              !entries.every((entry) => record(entry) && ruleKeys(entry, fields, field))
            )
              throw new Error('Profile contains unknown rule settings.');
          }
      }
    }
  }
  // The engine owns the settings schema. Only its validated, detached values may
  // enter a profile; account fields and controller state are never accepted.
  return validateSettings(
    JSON.parse(JSON.stringify(validateSettings(value as SettingsInput))) as SettingsInput,
  );
}
/** Metadata admits the settings stage; a failed stage never evaluates its successor. */
export function checkedProfileResult(value: unknown): Result<BotProfile, unknown> {
  return flatMap(
    tryResult(() => {
      if (
        !record(value) ||
        !keys(value, ['id', 'name', 'character', 'savedAt', 'settings']) ||
        typeof value.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id) ||
        typeof value.name !== 'string' ||
        !value.name.trim() ||
        value.name.length > 48 ||
        /[\u0000-\u001f\u007f]/.test(value.name) ||
        typeof value.character !== 'string' ||
        value.character.length > 64 ||
        /[\u0000-\u001f\u007f]/.test(value.character) ||
        typeof value.savedAt !== 'number' ||
        !Number.isSafeInteger(value.savedAt) ||
        value.savedAt < 0
      ) {
        throw new Error(INVALID_METADATA);
      }
      return {
        id: profileId(value.id),
        name: profileName(value.name),
        character: value.character,
        savedAt: profileSavedAt(value.savedAt),
        settings: value.settings,
      };
    }),
    (metadata) =>
      mapResult(
        tryResult(() => checkedSettings(metadata.settings)),
        (settings) => ({ ...metadata, settings }),
      ),
  );
}
export function checkedProfile(value: unknown): BotProfile {
  return getOrThrowWith(checkedProfileResult(value), identity);
}
export function parseProfileDocumentResult(text: string): Result<ProfileDocument, unknown> {
  return flatMap(
    tryResult(() => {
      if (text.length > MAX_DOCUMENT_BYTES) throw new Error('Profile document is too large.');
      const value: unknown = JSON.parse(text);
      if (
        !record(value) ||
        !keys(value, ['version', 'profiles']) ||
        value.version !== 1 ||
        !Array.isArray(value.profiles) ||
        value.profiles.length > MAX_PROFILES
      )
        throw new Error('Unsupported profile document.');
      return value.profiles;
    }),
    (values) =>
      gen(function* () {
        const profiles: BotProfile[] = [];
        // Bind each producer before reading the next entry. Collision diagnostics
        // follow entry admission, preserving the original document error order.
        for (const value of values) profiles.push(yield* checkedProfileResult(value));
        yield* tryResult(() => {
          if (profileIds(profiles).length !== profiles.length)
            throw new Error('Profile IDs must be unique.');
        });
        return { version: 1 as const, profiles };
      }),
  );
}
export function parseProfileDocument(text: string): ProfileDocument {
  return getOrThrowWith(parseProfileDocumentResult(text), identity);
}

export function profileSaveAllowed(profiles: readonly BotProfile[], existingId?: string): void {
  if (existingId && !profiles.some((profile) => profile.id === existingId))
    throw new Error('Choose an existing profile to update.');
  if (!existingId && profiles.length >= MAX_PROFILES)
    throw new Error(`Keep at most ${MAX_PROFILES} profiles.`);
}
export function savedProfiles(profiles: readonly BotProfile[], profile: BotProfile): BotProfile[] {
  return pipe(
    profiles,
    filter((saved) => saved.id !== profile.id),
    appendAll([profile]),
    map(checkedProfile),
  );
}
export function encodeProfileDocument(profiles: readonly BotProfile[]): string {
  const document = JSON.stringify({ version: 1, profiles });
  if (document.length > MAX_DOCUMENT_BYTES)
    throw new Error('Saved profiles exceed the storage limit.');
  return document;
}
export function profileImportAllowed(
  profiles: readonly BotProfile[],
  imported: readonly BotProfile[],
): void {
  if (!imported.length) throw new Error('Profile document is empty.');
  if (profiles.length + imported.length > MAX_PROFILES)
    throw new Error(`Keep at most ${MAX_PROFILES} profiles.`);
}
export function importedProfiles(
  profiles: readonly BotProfile[],
  imported: readonly BotProfile[],
  identities: readonly { id: string; savedAt: number }[],
): BotProfile[] {
  if (identities.length !== imported.length)
    throw new Error('Could not create unique profile IDs.');
  const copies = map(imported, (profile, index) =>
    checkedProfile({ ...profile, ...identities[index] }),
  );
  if (profileIds([...profiles, ...copies]).length !== profiles.length + copies.length)
    throw new Error('Could not create unique profile IDs.');
  return copies;
}
export function profileForMap(
  profiles: readonly BotProfile[],
  id: string,
  map: string,
  character?: string,
): BotProfile {
  return getOrThrowWith(
    pipe(
      findFirst(profiles, (saved) => saved.id === id),
      fromOption(() => new Error('Choose a saved profile.')),
      flatMap((profile) =>
        flatMap(
          tryResult(() => {
            if (!map || profile.settings.map !== map)
              throw new Error(`Enter ${profile.settings.map} before applying this profile.`);
            if (character !== undefined && profile.character && profile.character !== character)
              throw new Error(`Select ${profile.character} before applying this profile.`);
            return profile;
          }),
          checkedProfileResult,
        ),
      ),
    ),
    identity,
  );
}
export function exportProfile(profiles: readonly BotProfile[], id: string): string {
  return getOrThrowWith(
    pipe(
      findFirst(profiles, (saved) => saved.id === id),
      fromOption(() => new Error('Choose a profile to export.')),
      mapResult((profile) => JSON.stringify({ version: 1, profiles: [profile] }, null, 2)),
    ),
    identity,
  );
}

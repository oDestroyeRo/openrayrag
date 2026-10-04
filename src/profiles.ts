import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, validateSettings, type Settings } from './settings';

export const PROFILE_STORAGE_KEY = 'rayrag.companion.profiles.v1';
export const MAX_PROFILES = 20;
const MAX_DOCUMENT_BYTES = 256_000;
export interface BotProfile { id: string; name: string; character: string; savedAt: number; settings: Settings }
interface ProfileDocument { version: 1; profiles: BotProfile[] }
interface ProfileStorage { getItem(key: string): string | null; setItem(key: string, value: string): void }
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function keys(value: Record<string, unknown>, expected: string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every(key => expected.includes(key));
}
function ruleKeys(value: Record<string,unknown>, expected:string[], path:string): boolean {
  return keys(value,[...expected,...(['items','skills','equipment','combat.rules'].includes(path)&&Object.hasOwn(value,'conditions')?['conditions']:[])]);
}
function checkedSettings(value: unknown): Settings {
  const expected = [...Object.keys(DEFAULT_SETTINGS), ...(record(value) && Object.hasOwn(value, 'automation') ? ['automation'] : [])];
  if (!record(value) || !keys(value, expected)) throw new Error('Profile contains unknown or missing settings.');
  if (Object.hasOwn(value, 'automation')) {
    // Older profiles predate escape and loadout controls. Only these sections
    // get defaults; unknown fields and missing older sections still fail closed.
    const a = record(value.automation) ? { escape: DEFAULT_AUTOMATION.escape, loadout: structuredClone(DEFAULT_AUTOMATION.loadout), ...value.automation } : value.automation;
    if (!record(a) || !keys(a, [...Object.keys(DEFAULT_AUTOMATION), ...(Object.hasOwn(a, 'disposition') ? ['disposition'] : []), ...(Object.hasOwn(a, 'supply') ? ['supply'] : []), ...(Object.hasOwn(a,'attackStrategies')?['attackStrategies']:[]), ...(Object.hasOwn(a,'mapPolicy')?['mapPolicy']:[]), ...(Object.hasOwn(a,'partyHeal')?['partyHeal']:[]), ...(Object.hasOwn(a,'retreat')?['retreat']:[]), ...(Object.hasOwn(a,'hpPotions')?['hpPotions']:[])])) throw new Error('Profile contains unknown automation settings.');
    const arrayKeys: Record<string, string[]> = {
      items: ['itemId','resource','belowPercent','minStock','cooldownSeconds'],
      skills: ['skillId','level','target','hpBelowPercent','spAbovePercent','cooldownSeconds'],
      equipment: ['itemId','hpBelowPercent','monsterClassId'],
      'combat.rules': ['classId','action','priority'], 'loot.rules': ['itemId','action','priority'],
      'allocation.stats': ['stat','target'], 'allocation.skills': ['skillId','target'],
      'travel.waypoints': ['map','x','y'], 'loadout.ammoPreferences': ['itemId'],
    };
    for (const [key, template] of Object.entries(DEFAULT_AUTOMATION)) {
      const child = a[key];
      if (Array.isArray(template)) {
        if (!Array.isArray(child) || !child.every(entry => record(entry) && ruleKeys(entry, arrayKeys[key]!,key))) throw new Error('Profile contains unknown rule settings.');
      } else {
        if (!record(child)) throw new Error('Profile contains unknown automation settings.');
        const optional = key === 'escape' ? ['hpEnabled','threatEnabled','threatCount','threatWindowSeconds'] : key === 'combat' ? ['partyEngagement'] : [];
        const fields = Object.keys(template).filter(field => !optional.includes(field) || Object.hasOwn(child, field));
        if (key === 'follow') fields.push(...['mode','rendezvous'].filter(field => Object.hasOwn(child, field)));
        if (!keys(child, fields)) throw new Error('Profile contains unknown automation settings.');
        for (const [field, fields] of Object.entries(arrayKeys)) if (field.startsWith(`${key}.`)) {
          const entries = child[field.slice(key.length + 1)];
          if (!Array.isArray(entries) || !entries.every(entry => record(entry) && ruleKeys(entry, fields,field))) throw new Error('Profile contains unknown rule settings.');
        }
      }
    }
  }
  // The engine owns the settings schema. Only its validated, detached values may
  // enter a profile; account fields and controller state are never accepted.
  return JSON.parse(JSON.stringify(validateSettings(value as unknown as Settings))) as Settings;
}
function checkedProfile(value: unknown): BotProfile {
  if (!record(value) || !keys(value, ['id', 'name', 'character', 'savedAt', 'settings'])
    || typeof value.id !== 'string' || !/^[a-zA-Z0-9_-]{1,64}$/.test(value.id)
    || typeof value.name !== 'string' || !value.name.trim() || value.name.length > 48 || /[\u0000-\u001f\u007f]/.test(value.name)
    || typeof value.character !== 'string' || value.character.length > 64 || /[\u0000-\u001f\u007f]/.test(value.character)
    || typeof value.savedAt !== 'number' || !Number.isSafeInteger(value.savedAt) || value.savedAt < 0) {
    throw new Error('Invalid profile name or metadata.');
  }
  return { id: value.id, name: value.name.trim(), character: value.character, savedAt: value.savedAt, settings: checkedSettings(value.settings) };
}
function parseDocument(text: string): ProfileDocument {
  if (text.length > MAX_DOCUMENT_BYTES) throw new Error('Profile document is too large.');
  const value: unknown = JSON.parse(text);
  if (!record(value) || !keys(value, ['version', 'profiles']) || value.version !== 1
    || !Array.isArray(value.profiles) || value.profiles.length > MAX_PROFILES) throw new Error('Unsupported profile document.');
  const profiles = value.profiles.map(checkedProfile);
  if (new Set(profiles.map(profile => profile.id)).size !== profiles.length) throw new Error('Profile IDs must be unique.');
  return { version: 1, profiles };
}

export class ProfileStore {
  private profiles: BotProfile[] = [];
  constructor(private readonly storage: ProfileStorage, private readonly id: () => string = () => crypto.randomUUID(), private readonly now = Date.now) {
    try { const saved = storage.getItem(PROFILE_STORAGE_KEY); if (saved) this.profiles = parseDocument(saved).profiles; }
    catch { /* A corrupt or incompatible document cannot change current settings. */ }
  }
  list(): BotProfile[] { return this.profiles.map(profile => checkedProfile(profile)); }
  private persist(profiles: BotProfile[]): void {
    const document = JSON.stringify({ version: 1, profiles });
    if (document.length > MAX_DOCUMENT_BYTES) throw new Error('Saved profiles exceed the storage limit.');
    this.storage.setItem(PROFILE_STORAGE_KEY, document);
    this.profiles = profiles;
  }
  save(name: string, character: string, settings: Settings, existingId?: string): BotProfile {
    if (existingId && !this.profiles.some(profile => profile.id === existingId)) throw new Error('Choose an existing profile to update.');
    if (!existingId && this.profiles.length >= MAX_PROFILES) throw new Error(`Keep at most ${MAX_PROFILES} profiles.`);
    const profile = checkedProfile({ id: existingId ?? this.id(), name, character, savedAt: this.now(), settings });
    this.persist([...this.profiles.filter(saved => saved.id !== profile.id), profile]);
    return checkedProfile(profile);
  }
  remove(id: string): void { this.persist(this.profiles.filter(profile => profile.id !== id)); }
  export(id: string): string {
    const profile = this.profiles.find(saved => saved.id === id);
    if (!profile) throw new Error('Choose a profile to export.');
    return JSON.stringify({ version: 1, profiles: [profile] }, null, 2);
  }
  import(text: string): BotProfile[] {
    const imported = parseDocument(text).profiles;
    if (!imported.length) throw new Error('Profile document is empty.');
    if (this.profiles.length + imported.length > MAX_PROFILES) throw new Error(`Keep at most ${MAX_PROFILES} profiles.`);
    // Import creates fresh IDs, so a document cannot silently replace a profile.
    const copies = imported.map(profile => checkedProfile({ ...profile, id: this.id(), savedAt: this.now() }));
    if (new Set([...this.profiles, ...copies].map(profile => profile.id)).size !== this.profiles.length + copies.length) throw new Error('Could not create unique profile IDs.');
    this.persist([...this.profiles, ...copies]);
    return copies.map(checkedProfile);
  }
  forMap(id: string, map: string, character?: string): BotProfile {
    const profile = this.profiles.find(saved => saved.id === id);
    if (!profile) throw new Error('Choose a saved profile.');
    if (!map || profile.settings.map !== map) throw new Error(`Enter ${profile.settings.map} before applying this profile.`);
    if (character !== undefined && profile.character && profile.character !== character) throw new Error(`Select ${profile.character} before applying this profile.`);
    return checkedProfile(profile);
  }
}

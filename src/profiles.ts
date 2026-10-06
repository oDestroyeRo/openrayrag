import { filter, map } from 'remeda';
import type { SettingsInput } from './settings';
import { checkedProfile, parseProfileDocument, profileSaveAllowed, savedProfiles, encodeProfileDocument, profileImportAllowed, importedProfiles, profileForMap, exportProfile, type BotProfile } from './profiles-logic';
import { readStoredText, writeStoredText, type TextStorage } from './storage-effects';
export { MAX_PROFILES, type BotProfile, type BotProfileInput, type ProfileId, type ProfileName, type ProfileSavedAt } from './profiles-logic';
export const PROFILE_STORAGE_KEY = 'rayrag.companion.profiles.v1';

/** Validate and persist proposals before committing the store's owned state. */
export class ProfileStore {
  private profiles: readonly BotProfile[] = [];
  constructor(private readonly storage: TextStorage, private readonly id: () => string = () => crypto.randomUUID(), private readonly now = Date.now) {
    try { const saved = readStoredText(storage, PROFILE_STORAGE_KEY); if (saved) this.profiles = parseProfileDocument(saved).profiles; }
    catch { /* A corrupt or incompatible document cannot change current settings. */ }
  }
  list(): readonly BotProfile[] { return map(this.profiles, checkedProfile); }
  private persist(profiles: BotProfile[]): void {
    writeStoredText(this.storage, PROFILE_STORAGE_KEY, encodeProfileDocument(profiles));
    this.profiles = profiles;
  }
  save(name: string, character: string, settings: SettingsInput, existingId?: string): BotProfile {
    profileSaveAllowed(this.profiles, existingId);
    const profile = checkedProfile({ id: existingId ?? this.id(), name, character, savedAt: this.now(), settings });
    this.persist(savedProfiles(this.profiles, profile));
    return checkedProfile(profile);
  }
  remove(id: string): void { this.persist(filter(this.profiles, profile => profile.id !== id)); }
  export(id: string): string { return exportProfile(this.profiles, id); }
  import(text: string): readonly BotProfile[] {
    const imported = parseProfileDocument(text).profiles;
    profileImportAllowed(this.profiles, imported);
    const copies = importedProfiles(this.profiles, imported, imported.map(() => ({ id: this.id(), savedAt: this.now() })));
    this.persist([...this.profiles, ...copies]);
    return map(copies, checkedProfile);
  }
  forMap(id: string, map: string, character?: string): BotProfile { return profileForMap(this.profiles, id, map, character); }
}

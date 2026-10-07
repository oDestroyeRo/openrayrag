import { validateFormSettings, type SettingsInput, type ValidatedFormSettings } from './settings';
import { incrementRevision, revisionFor, type Revision } from '../../shared/domain-values';
import { profileId, type ProfileId } from './profiles-logic';
export type FormRevision = Revision<'form'>;
export const formRevision = (value: unknown): FormRevision =>
  revisionFor('form', value, 'current settings document.');
/** Mutable editor/JSON shape; only formDocument admits a persisted form. */
export interface FormDocumentInput {
  version: 1;
  revision: number;
  selectedProfileId: string | null;
  settings: SettingsInput;
}
export interface FormDocument {
  readonly version: 1;
  readonly revision: FormRevision;
  readonly selectedProfileId: ProfileId | null;
  readonly settings: ValidatedFormSettings;
}
export function formDocument(value: unknown): FormDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid current settings document.');
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).length !== 4 ||
    !['version', 'revision', 'selectedProfileId', 'settings'].every((k) => Object.hasOwn(v, k)) ||
    v.version !== 1 ||
    !Number.isSafeInteger(v.revision) ||
    Number(v.revision) < 0 ||
    (v.selectedProfileId !== null &&
      (typeof v.selectedProfileId !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,64}$/.test(v.selectedProfileId)))
  )
    throw new Error('Invalid current settings document.');
  return {
    version: 1,
    revision: formRevision(v.revision),
    selectedProfileId: v.selectedProfileId === null ? null : profileId(v.selectedProfileId),
    settings: validateFormSettings(v.settings as SettingsInput),
  };
}
/** Decide revisions from document content without reading or persisting a form. */
export function nextFormSave(
  document: FormDocument,
  revision: FormRevision,
  last: string | null,
): { document: FormDocument; revision: FormRevision; content: string } {
  const content = JSON.stringify({ ...document, revision: 0 });
  const nextRevision = content !== last ? incrementRevision(revision) : revision;
  return {
    document: structuredClone({ ...document, revision: nextRevision }),
    revision: nextRevision,
    content,
  };
}

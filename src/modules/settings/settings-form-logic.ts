import { map } from 'effect/Array';
import type { FormDocument, FormDocumentInput } from './current-form';
import type { FeatureUi } from '../client/feature-ui';
import type { MapInfo, MapMonster } from '../navigation/map-data-logic';
import type { SettingsInput } from './settings';
export type AutomationEditor = Pick<
  FeatureUi,
  'read' | 'write' | 'levelDifference' | 'selectedProfileId' | 'restoreProfileSelection'
>;

export type FormSnapshot = Omit<FormDocument, 'version' | 'revision'>;
export type FormSnapshotInput = Omit<FormDocumentInput, 'version' | 'revision'>;

export interface SettingsFormProjection {
  runSettings(): SettingsInput;
  startSettings(): SettingsInput;
  snapshot(): FormSnapshot;
}

export interface SettingsFormContext {
  sessionId: string;
  mapInfo: MapInfo;
  level: number | null;
  runActive: boolean;
  controlsLocked: boolean;
  targetsLocked: boolean;
  retainedTargets?: readonly number[];
}

export interface Hooks {
  context(): SettingsFormContext;
  changed(): void;
}

export interface TargetRow {
  label: HTMLLabelElement;
  input: HTMLInputElement;
  name: HTMLElement;
  detail: HTMLElement;
  count: HTMLElement;
}

export function targetRosterIdentity(options: readonly Pick<MapMonster, 'classId'>[]): {
  ids: number[];
  order: string;
} {
  const ids = map(options, (monster) => monster.classId);
  return { ids, order: ids.join(',') };
}

import type { FormDocument } from './current-form';
import type { FeatureUi } from './feature-ui';
import type { MapInfo } from './map-data';
import type { Settings } from './settings';
export type AutomationEditor = Pick<FeatureUi, 'read' | 'write' | 'levelDifference' | 'selectedProfileId' | 'restoreProfileSelection'>;

export type FormSnapshot = Omit<FormDocument, 'version' | 'revision'>;

export interface SettingsFormProjection {
  runSettings(): Settings;
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

export interface Hooks { context(): SettingsFormContext; changed(): void }

export interface TargetRow { label: HTMLLabelElement; input: HTMLInputElement; name: HTMLElement; detail: HTMLElement; count: HTMLElement }

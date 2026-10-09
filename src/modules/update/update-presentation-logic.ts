import type { LogEntry } from '../automation/engine';
import type { UpdateStep } from './update-continuation-logic';

export type UpdateTransition = UpdateStep | 'retry' | 'deferred' | 'cancelled' | 'complete';
export interface UpdateDiagnostic {
  readonly stage: UpdateTransition;
  readonly installedVersion: string | null;
  readonly targetVersion: string | null;
  readonly startedAt: number;
  readonly at: number;
  readonly message: string;
  readonly retryAt: number;
}

/** Only bounded version identifiers may enter retained updater history. */
export function updateVersion(value: unknown): string | null {
  return typeof value === 'string' &&
    value.length <= 80 &&
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)
    ? value
    : null;
}

export function updatePresentation(
  diagnostic: UpdateDiagnostic | null,
  active: boolean,
  now: number,
  retryAllowed = true,
): { active: boolean; reason: string } {
  if (!diagnostic) return { active: false, reason: '' };
  const version = diagnostic.targetVersion ? ` to v${diagnostic.targetVersion}` : '',
    installed = diagnostic.installedVersion ? ` (installed v${diagnostic.installedVersion})` : '',
    elapsed = Math.max(
      0,
      Math.floor(((active ? now : diagnostic.at) - diagnostic.startedAt) / 1000),
    ),
    retry =
      retryAllowed && diagnostic.retryAt > now
        ? ` Next automatic attempt in ${Math.ceil((diagnostic.retryAt - now) / 1000)}s. Check for updates retries now.`
        : '';
  return {
    active,
    reason: `Update${version}${installed} · ${diagnostic.stage} · ${elapsed}s. ${diagnostic.message}${retry}`,
  };
}

/** Activity sources retain their own ownership and merge only for presentation. */
export function updateActivity(
  game: readonly LogEntry[],
  updater: readonly LogEntry[],
): LogEntry[] {
  return [...game, ...updater]
    .sort((a, b) => b.at - a.at)
    .slice(0, 50)
    .map((entry) => ({ ...entry }));
}

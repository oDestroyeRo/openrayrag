import { manualTargetView as manualTargetViewAt } from './manual-target-view-logic';
import type { Position } from '../protocol/protocol';
import type { SettingsInput } from '../settings/settings';
export { actorKey } from './manual-target-view-logic';

export function manualTargetView(
  status: Record<string, unknown>,
  settings: SettingsInput,
  command: { type: 'walk'; destination: Position } | { type: 'attack'; key: string },
  timeoutSeconds = 30,
  now = Date.now(),
): ReturnType<typeof manualTargetViewAt> {
  return manualTargetViewAt(status, settings, command, timeoutSeconds, now);
}

import { manualTargetView as manualTargetViewAt } from './manual-target-view-logic';
import type { Position } from './protocol';
import type { Settings } from './settings';
export { actorKey } from './manual-target-view-logic';

export function manualTargetView(status: Record<string, unknown>, settings: Settings,
  command: { type: 'walk'; destination: Position } | { type: 'attack'; key: string }, timeoutSeconds = 30,
  now = Date.now()): ReturnType<typeof manualTargetViewAt> {
  return manualTargetViewAt(status, settings, command, timeoutSeconds, now);
}

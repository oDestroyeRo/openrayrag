import type { Action } from './engine';
import { command, walkCommand, lookCommand } from './protocol';
import { featureCommand, validateExpandedAction } from './protocol-feature';
import { worldCommand, validateWorldAction, type WorldAction } from './world-protocol';

/** Pure wire projection shared by both transport composition roots. */
export function encodeControllerAction(action: Action | WorldAction): Uint8Array {
  const packet = action.type === 'look' ? lookCommand(action) : action.type === 'walk' ? walkCommand(action.destination)
    : action.type === 'attack' || action.type === 'pickup' || action.type === 'stop'
      ? command(action.type, 'id' in action ? action.id : undefined)
      : (() => { try { return featureCommand(validateExpandedAction(action)); } catch { return worldCommand(validateWorldAction(action)); } })();
  return Uint8Array.from(packet);
}

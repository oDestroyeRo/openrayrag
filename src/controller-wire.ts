import { CompanionController } from './controller';
import { command, walkCommand, lookCommand } from './protocol';
import { featureCommand, validateExpandedAction } from './protocol-feature';
import { worldCommand, validateWorldAction } from './world-protocol';
import { socialCommand } from './social-protocol';
import { memoCommand } from './memo-protocol';
import { socketCommand } from './socket-protocol';
import { refineCommand } from './refine-protocol';
import { warpCommand } from './warp-protocol';

/** Both transport modes use this controller and exactly these action encoders. */
export function wireController(send: (packet: Uint8Array) => void,
  store: ConstructorParameters<typeof CompanionController>[8], now = Date.now): CompanionController {
  return new CompanionController(action => {
    const packet = action.type === 'look' ? lookCommand(action) : action.type === 'walk' ? walkCommand(action.destination)
      : action.type === 'attack' || action.type === 'pickup' || action.type === 'stop'
        ? command(action.type, 'id' in action ? action.id : undefined)
        : (() => { try { return featureCommand(validateExpandedAction(action)); } catch { return worldCommand(validateWorldAction(action)); } })();
    send(Uint8Array.from(packet));
  }, now, undefined, action => send(socialCommand(action)), slot => send(memoCommand(slot)),
  action => send(socketCommand(action)), packet => send(Uint8Array.from(refineCommand(packet))),
  wire => send(warpCommand(wire)), store);
}

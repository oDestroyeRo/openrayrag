import { CompanionController } from './controller';
import { encodeControllerAction } from './controller-action-encoding';
import { socialCommand } from './social-protocol';
import { memoCommand } from './memo-protocol';
import { socketCommand } from './socket-protocol';
import { refineCommand } from './refine-protocol';
import { warpCommand } from './warp-protocol';
import { databaseTravelCommand, supportsDatabaseTravel } from './database-travel-protocol';

/** Both transport modes use this controller and exactly these action encoders. */
export function wireController(send: (packet: Uint8Array) => void,
  store: ConstructorParameters<typeof CompanionController>[8], now = Date.now): CompanionController {
  return new CompanionController(action => send(encodeControllerAction(action)), now, undefined, action => send(socialCommand(action)), slot => send(memoCommand(slot)),
  action => send(socketCommand(action)), packet => send(Uint8Array.from(refineCommand(packet))),
  wire => send(warpCommand(wire)), store,
  {supported:supportsDatabaseTravel,send:map=>send(databaseTravelCommand(map))});
}

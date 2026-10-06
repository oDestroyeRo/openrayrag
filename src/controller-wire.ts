import { piped } from 'remeda';
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
  return new CompanionController(piped(encodeControllerAction, send), now, undefined, piped(socialCommand, send), piped(memoCommand, send),
  piped(socketCommand, send), piped((packet: Parameters<typeof refineCommand>[0]) => Uint8Array.from(refineCommand(packet)), send),
  piped(warpCommand, send), store,
  {supported:supportsDatabaseTravel,send:piped(databaseTravelCommand, send)});
}

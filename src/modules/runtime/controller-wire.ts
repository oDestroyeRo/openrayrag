import { flow } from 'effect/Function';
import { CompanionController } from './controller';
import { encodeControllerAction } from './controller-action-encoding';
import { socialCommand } from '../social/social-protocol';
import { memoCommand } from '../memo/memo-protocol';
import { socketCommand } from '../socket/socket-protocol';
import { refineCommand } from '../refine/refine-protocol';
import { warpCommand } from '../warp/warp-protocol';
import {
  databaseTravelCommand,
  supportsDatabaseTravel,
} from '../navigation/database-travel-protocol';

/** Both transport modes use this controller and exactly these action encoders. */
export function wireController(
  send: (packet: Uint8Array) => void,
  store: ConstructorParameters<typeof CompanionController>[8],
  now = Date.now,
): CompanionController {
  return new CompanionController(
    flow(encodeControllerAction, send),
    now,
    undefined,
    flow(socialCommand, send),
    flow(memoCommand, send),
    flow(socketCommand, send),
    flow(
      (packet: Parameters<typeof refineCommand>[0]) => Uint8Array.from(refineCommand(packet)),
      send,
    ),
    flow(warpCommand, send),
    store,
    { supported: supportsDatabaseTravel, send: flow(databaseTravelCommand, send) },
  );
}

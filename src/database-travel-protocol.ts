import { BitWriter } from './binary';
import { NAVIGATION_MAPS } from './navigation';

const supportedMaps = new Set(NAVIGATION_MAPS);

/** Database travel is limited to maps with our pinned collision data. */
export function supportsDatabaseTravel(map: unknown): map is string {
  return typeof map === 'string' && supportedMaps.has(map);
}

/** The deployed 4099e2c contract uses 64, not newer upstream opcode enums.
 * -999 requests the server's default destination; forced coordinates are never exposed. */
export function databaseTravelCommand(map: unknown): Uint8Array<ArrayBuffer> {
  if (!supportsDatabaseTravel(map)) throw new Error('Unsupported Database travel map.');
  return new BitWriter().u8(64).string(map,64).i16(-999).i16(-999).bool(false).finish();
}

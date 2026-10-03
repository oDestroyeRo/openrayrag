import { BitWriter } from './binary';
import { NAVIGATION_MAPS } from './navigation';
import type { GameEvent } from './protocol';

// Deployed-server Database cooldown, observed through Teleport Now on 2026-10-04.
export const DATABASE_TELEPORT_COOLDOWN_MS = 30_000;

/** Only the exact server warning can extend the guard; player chat is inert. */
export function databaseTeleportWait(event: GameEvent): number | null {
  const text = event.type === 'featureError' ? event.message
    : event.type === 'chat' && event.actorId === -1 && (event.channel === 0 || event.channel === 3) ? event.text : null;
  const match = text?.match(/^You need to wait ([1-9][0-9]?) more seconds before you can teleport again\.$/);
  const seconds = match ? Number(match[1]) : 0;
  return seconds > 0 && seconds <= 60 ? seconds * 1_000 : null;
}

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

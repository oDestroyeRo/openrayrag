// Rebuild pin 4099e2c000c3c550516760b9c1241595aac9aceb:
// PacketType.cs and NetworkManager.cs. Panel shortcuts only toggle local UI.
// Observe only the opcode of official binary sends; never retain, decode or log
// authentication, chat text, item IDs or any other packet contents.
const gameplayOpcodes = new Set([
  7, 8, 9, 11, 14, 19, 21, 29, 33, 41, 45, 47, 48, 57, 58, 59, 62, 63,
  76, 78, 79, 80, 81, 82, 86, 87, 88, 89, 90, 94, 97,
  99, 100, 101, 102, 104, 105, 106, 107, 109, 110, 111, 112,
]);

export function isOfficialGameplayCommand(data: unknown): boolean {
  // Unity's WebGL transport sends ArrayBuffers. Views preserve their offset;
  // strings/Blobs are deliberately not inspected or read asynchronously.
  const bytes = data instanceof ArrayBuffer ? new Uint8Array(data, 0, Math.min(1, data.byteLength))
    : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, Math.min(1, data.byteLength)) : null;
  return bytes !== null && bytes.length === 1 && gameplayOpcodes.has(bytes[0]!);
}
export function isOfficialLookCommand(data:unknown):boolean {
  const bytes=data instanceof ArrayBuffer?new Uint8Array(data,0,Math.min(1,data.byteLength))
    :ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,Math.min(1,data.byteLength)):null;
  return bytes!==null&&bytes.length===1&&bytes[0]===13;
}

// Maintenance conservatively owns opaque/unsupported sends from an already
// verified-ready game transport, without reading any body or awaiting a Blob.
// Known readiness/keepalive, cosmetic/social and text-query families stay inert.
const benignMaintenanceOpcodes=new Set([2,3,4,17,44,54,55]);
export function couldOwnOfficialGameplay(data:unknown):boolean {
  const bytes=data instanceof ArrayBuffer?new Uint8Array(data,0,Math.min(1,data.byteLength))
    :ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,Math.min(1,data.byteLength)):null;
  return bytes===null||bytes.length===0||!benignMaintenanceOpcodes.has(bytes[0]!);
}

/** Refine has no terminal acknowledgement; only the opcode is inspected. */
export function isOfficialRefineCommand(data:unknown):boolean {
  const bytes=data instanceof ArrayBuffer?new Uint8Array(data,0,Math.min(1,data.byteLength))
    :ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,Math.min(1,data.byteLength)):null;
  return bytes?.[0]===80;
}

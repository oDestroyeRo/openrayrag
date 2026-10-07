// Linuxdeploy changes RPATH after the raw Tauri application has been built.
import { execFileSync } from 'node:child_process';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';

import {
  MAX_BYTES,
  requireValue,
  sha256,
  compareElfIdentity,
  compareDynamicIdentity,
} from './appimage-policy.mjs';
export { APPIMAGE_RPATH, compareElfIdentity, compareDynamicIdentity } from './appimage-policy.mjs';

/** @param {string} path @returns {import("../shared/tooling-domain-values.mjs").DynamicIdentity} */
function dynamicIdentity(path) {
  const output = (option) =>
    execFileSync('patchelf', [option, path], {
      encoding: 'utf8',
      timeout: 30_000,
      maxBuffer: 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).replace(/\r?\n$/, '');
  const needed = output('--print-needed');
  return {
    needed: needed === '' ? [] : needed.split('\n'),
    interpreter: output('--print-interpreter'),
    rpath: output('--print-rpath'),
  };
}
/** @param {string} path @returns {Promise<Buffer>} */
export async function executableBytes(path) {
  // O_NOFOLLOW is unavailable on some platforms. AppImage proof must fail
  // closed there rather than silently accepting a redirected executable.
  requireValue(
    typeof constants.O_NOFOLLOW === 'number' && constants.O_NOFOLLOW !== 0,
    'AppImage proof requires no-follow file support.',
  );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | (constants.O_NONBLOCK ?? 0),
  );
  try {
    const stat = await file.stat();
    requireValue(
      stat.isFile() && stat.size <= MAX_BYTES,
      'AppImage proof requires a bounded regular executable file.',
    );
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await file.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    // A concurrent append cannot make an unbounded read or conceal a change.
    const extra = await file.read(Buffer.alloc(1), 0, 1, offset);
    requireValue(
      offset === stat.size && extra.bytesRead === 0,
      'AppImage executable size changed while reading.',
    );
    return bytes;
  } finally {
    await file.close();
  }
}

/** @param {string} original @param {string} staged @param {string} extracted */
export async function verifyAppImageExecutable(original, staged, extracted) {
  const [rawBytes, stagedBytes, extractedBytes] = await Promise.all(
    [original, staged, extracted].map(executableBytes),
  );
  const originalSha256 = sha256(rawBytes),
    stagedSha256 = sha256(stagedBytes),
    extractedSha256 = sha256(extractedBytes);
  requireValue(
    stagedSha256 === extractedSha256,
    'AppImage extracted executable differs from the post-Linuxdeploy AppDir executable.',
  );
  const allocatedSections = compareElfIdentity(rawBytes, extractedBytes);
  const dynamic = dynamicIdentity(extracted);
  compareDynamicIdentity(dynamicIdentity(original), dynamic);
  return { originalSha256, stagedSha256, extractedSha256, allocatedSections, ...dynamic };
}

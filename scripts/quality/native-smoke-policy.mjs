// Deterministic launch inputs and smoke result contracts.
import { join } from 'node:path';
import { smokeDocumentValues } from '../shared/tooling-domain-values.mjs';
import { isDeepStrictEqual } from 'node:util';

const EXPECTED_CHECKS = [
  'webview-boot',
  'offline-controller',
  'native-settings-ipc',
  'window-close-save',
  'mcp-loopback-read-only',
  'mcp-loopback-control',
];

/** @param {string} binary @param {string} root @param {string} platform @param {NodeJS.ProcessEnv} env */
export function createSmokeLaunch(binary, root, platform, env) {
  if (platform !== 'linux') return { binary: binary, prefixArgs: [], env };
  return {
    binary: 'dbus-run-session',
    prefixArgs: ['--', binary],
    env: { ...env, XDG_DATA_HOME: join(root, 'xdg-data'), XDG_CACHE_HOME: join(root, 'xdg-cache') },
  };
}

/** @param {import('../shared/tooling-domain-values.mjs').SmokeResultDto} result @param {import('../shared/tooling-domain-values.mjs').SmokeStage} stage @param {string} token @returns {import('../shared/tooling-domain-values.mjs').SmokeDocument} */
export function validateResult(result, stage, token) {
  if (
    result?.protocol !== 1 ||
    result.stage !== stage ||
    result.token !== token ||
    result.passed !== true ||
    !EXPECTED_CHECKS.every((check) => result.checks?.includes(check))
  ) {
    throw new Error(`Native ${stage} smoke did not return a complete passing result.`);
  }
  if (stage === 'reopen' && !result.checks?.includes('settings-restore'))
    throw new Error('Native reopening did not prove settings restoration.');
  const document = result.document;
  if (
    document?.version !== 1 ||
    typeof document.revision !== 'number' ||
    !Number.isSafeInteger(document.revision) ||
    document.revision < 1 ||
    document.selectedProfileId !== null ||
    document.settings?.radius !== 17 ||
    document.settings.loot !== false ||
    document.settings.route_step !== 7 ||
    Object.keys(document).sort().join(',') !== 'revision,selectedProfileId,settings,version'
  ) {
    throw new Error(`Native ${stage} smoke did not retain the edited settings.`);
  }
  return smokeDocumentValues(document);
}

/** @param {import('../shared/tooling-domain-values.mjs').SmokeDocument} saved @param {import('../shared/tooling-domain-values.mjs').SmokeDocument} reopened */
export function verifyReopened(saved, reopened) {
  // Startup may advance the save revision while confirming identical contents.
  const { revision: savedRevision, ...savedContents } = saved;
  const { revision: reopenedRevision, ...reopenedContents } = reopened;
  if (reopenedRevision < savedRevision || !isDeepStrictEqual(savedContents, reopenedContents)) {
    throw new Error('Native reopening changed the saved settings.');
  }
}

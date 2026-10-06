import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeBuildOptions } from './build-bridge-policy.mjs';

export async function buildBridge(runBuild = build) {
  return runBuild(bridgeBuildOptions());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await buildBridge();
}

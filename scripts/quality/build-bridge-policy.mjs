// Deterministic build inputs; source generation is owned by build-bridge.mjs.
/** @returns {import('esbuild').BuildOptions} */
export function bridgeBuildOptions() {
  return {
    entryPoints: ['src/modules/runtime/bridge.ts'],
    bundle: true,
    format: 'iife',
    target: 'safari16',
    outfile: 'src-tauri/generated/game-bridge.js',
    legalComments: 'none',
  };
}

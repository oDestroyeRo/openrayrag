// Deterministic build inputs; source generation is owned by build-bridge.mjs.
export function bridgeBuildOptions() {
  return {
    entryPoints: ['src/bridge.ts'],
    bundle: true,
    format: 'iife',
    target: 'safari16',
    outfile: 'src-tauri/generated/game-bridge.js',
    legalComments: 'none',
  };
}

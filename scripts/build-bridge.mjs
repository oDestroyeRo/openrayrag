import { build } from 'esbuild';

await build({
  entryPoints: ['src/bridge.ts'],
  bundle: true,
  format: 'iife',
  target: 'safari16',
  outfile: 'src-tauri/generated/game-bridge.js',
  legalComments: 'none',
});

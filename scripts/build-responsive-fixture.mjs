// Offline-only native WebKit/Chrome fixture. No app, socket or gameplay transport
// is opened. Serve the output directory and load index.html in the chosen runtime.
// An explicit output directory must be new; default outputs are unique.
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { responsiveFixtureBuildOptions, FIXTURE_HTML } from './responsive-fixture-policy.mjs';

const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');

export async function buildResponsiveFixture(requestedOutput) {
  const output = requestedOutput ? resolve(requestedOutput) : await mkdtemp(join(tmpdir(), 'rayrag-responsive-fixture-'));
  if (requestedOutput) { await mkdir(dirname(output), { recursive: true }); await mkdir(output, { mode: 0o700 }); }
  const result = await build(responsiveFixtureBuildOptions(root, output));
  for (const file of result.outputFiles) await writeFile(file.path, file.contents, { flag:'wx', mode:0o600 });
  await writeFile(join(output,'index.html'), FIXTURE_HTML, { flag:'wx', mode:0o600 });
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(await buildResponsiveFixture(process.argv[2]));
}

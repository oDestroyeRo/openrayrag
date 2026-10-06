import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { benchmarkSourcePlugin } from './source-snapshot.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));

test('real flat historical renderer sources bundle through current module entries without mixing current source', async () => {
  const loaded = new Set();
  const result = await build({
    entryPoints: [join(root, 'scripts/benchmarks/client-rendering-fixture.ts')],
    bundle: true, format: 'esm', platform: 'browser', target: 'chrome120', loader: { '.svg': 'text' },
    write: false, outdir: 'unused', metafile: true, logLevel: 'silent',
    plugins: [{ name: 'offline-native', setup(builder) {
      builder.onResolve({ filter: /^@tauri-apps\/api\/(core|event)$/ }, () => ({ path: join(root, 'scripts/benchmarks/client-rendering-native.ts') }));
    } }, benchmarkSourcePlugin(root, '7d68d08', { observed: file => loaded.add(file) })],
  });
  assert.ok(loaded.has('src/main.ts'));
  assert.ok(loaded.has('src/engine.ts'));
  assert.ok(loaded.has('src/settings.ts'));
  assert.ok(loaded.size > 50);
  assert.equal([...loaded].some(file => file.startsWith('src/modules/')), false);
  assert.equal(Object.keys(result.metafile.inputs).some(file => file.startsWith('src/modules/')), false);
  assert.ok(Object.keys(result.metafile.inputs).some(file => file.includes('node_modules/remeda/')));
});

test('immutable modular snapshots retain their own nested imports, and mixed layouts reject', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-benchmark-layout-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--quiet']);
  await mkdir(join(directory, 'src/modules/automation'), { recursive: true });
  await mkdir(join(directory, 'src/shared'), { recursive: true });
  await writeFile(join(directory, 'src/modules/automation/engine.ts'), "import { value } from '../../shared/value'; export { value };\n");
  await writeFile(join(directory, 'src/shared/value.ts'), 'export const value = 17;\n');
  git(['add', 'src']);
  git(['-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test: snapshot modules']);
  const sha = git(['rev-parse', 'HEAD']);
  await writeFile(join(directory, 'src/shared/value.ts'), 'export const value = 99;\n');
  const loaded = new Set();
  const result = await build({ stdin: { contents: "export { value } from './src/engine.ts';", resolveDir: directory },
    bundle: true, platform: 'node', format: 'esm', write: false, logLevel: 'silent',
    plugins: [benchmarkSourcePlugin(directory, sha, { observed: file => loaded.add(file) })],
  });
  const module = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString('base64')}`);
  assert.equal(module.value, 17);
  assert.deepEqual([...loaded].sort(), ['src/modules/automation/engine.ts', 'src/shared/value.ts']);
  await writeFile(join(directory, 'src/engine.ts'), 'export const value = 42;\n');
  git(['add', 'src']);
  git(['-c', 'user.name=Offline Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'test: ambiguous snapshot']);
  assert.throws(() => benchmarkSourcePlugin(directory, git(['rev-parse', 'HEAD'])), /ambiguous benchmark source layout/);
});

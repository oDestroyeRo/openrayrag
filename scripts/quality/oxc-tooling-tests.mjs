import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const cli = (name) => join(root, 'node_modules', name, 'bin', name);

function run(name, args, cwd) {
  const outcome = spawnSync(process.execPath, ['run', cli(name), ...args], {
    cwd,
    env: { ...process.env, BUN_INSTALL_AUTO: '0' },
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(outcome.error, undefined);
  assert.equal(outcome.signal, null);
  return { status: outcome.status, output: outcome.stdout + outcome.stderr };
}

async function fixture(action) {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-oxc-'));
  try {
    await symlink(
      join(root, 'node_modules'),
      join(folder, 'node_modules'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    await writeFile(
      join(folder, 'tsconfig.json'),
      JSON.stringify({
        extends: join(root, 'tsconfig.json'),
        compilerOptions: { types: ['node'], noUnusedLocals: false, noUnusedParameters: false },
        include: ['fixture.ts'],
      }),
    );
    await action(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test('installed Effect Oxlint integration rejects discarded Effects and promises', async () => {
  await fixture(async (folder) => {
    for (const [source, code] of [
      ["import { succeed } from 'effect/Effect';\nsucceed(1);\n", 'effecttsgo(floating-effect)'],
      ['Promise.resolve(1);\n', 'typescript(no-floating-promises)'],
      [
        "import test from 'node:test';\ntest('registered', () => { Promise.resolve(1); });\n",
        'typescript(no-floating-promises)',
      ],
    ]) {
      await writeFile(join(folder, 'fixture.ts'), source);
      const outcome = run(
        'oxlint',
        ['-c', join(root, '.oxlintrc.json'), '--deny-warnings', '--format', 'json', 'fixture.ts'],
        folder,
      );
      assert.notEqual(outcome.status, 0, outcome.output);
      const diagnostics = JSON.parse(outcome.output).diagnostics;
      assert.ok(
        diagnostics.some((entry) => entry.code === code),
        outcome.output,
      );
    }
  });
});

test('native async and filesystem APIs remain valid alongside Option and Result', async () => {
  await fixture(async (folder) => {
    await writeFile(
      join(folder, 'fixture.ts'),
      `
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { some } from 'effect/Option';
import { succeed } from 'effect/Result';
export async function read(path: string) { return succeed(some(await readFile(path, 'utf8'))); }
export async function download(url: string) { return (await fetch(url)).text(); }
test('registered', async () => { await Promise.resolve(1); });
`,
    );
    const outcome = run(
      'oxlint',
      ['-c', join(root, '.oxlintrc.json'), '--deny-warnings', '--format', 'json', 'fixture.ts'],
      folder,
    );
    assert.equal(outcome.status, 0, outcome.output);
    assert.deepEqual(JSON.parse(outcome.output).diagnostics, []);
  });
});

test('Oxfmt checks formatting, is idempotent, and preserves generated or vendor bytes', async () => {
  await fixture(async (folder) => {
    await writeFile(join(folder, '.oxfmtrc.json'), await readFile(join(root, '.oxfmtrc.json')));
    await mkdir(join(folder, 'src/data'), { recursive: true });
    await mkdir(join(folder, 'vendor'), { recursive: true });
    const ignored = ['src/data/catalog.json', 'vendor/upstream.ts'];
    for (const name of ignored) await writeFile(join(folder, name), '{"preserve":  1}');
    await writeFile(join(folder, 'fixture.ts'), 'export const value={a:1}\n');
    const check = run('oxfmt', ['--check', '.'], folder);
    assert.notEqual(check.status, 0, check.output);
    const formatted = run('oxfmt', ['.'], folder);
    assert.equal(formatted.status, 0, formatted.output);
    const once = await readFile(join(folder, 'fixture.ts'), 'utf8');
    assert.equal(run('oxfmt', ['--check', '.'], folder).status, 0);
    assert.equal(run('oxfmt', ['.'], folder).status, 0);
    assert.equal(await readFile(join(folder, 'fixture.ts'), 'utf8'), once);
    for (const name of ignored)
      assert.equal(await readFile(join(folder, name), 'utf8'), '{"preserve":  1}');
  });
});

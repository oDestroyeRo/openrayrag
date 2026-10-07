import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { writeBenchmarkReport } from '../benchmarks/benchmark-client-rendering.mjs';

const run = promisify(execFile);
const fixtureScript = fileURLToPath(
  new URL('../benchmarks/build-responsive-fixture.mjs', import.meta.url),
);
const buildFixture = async (output) =>
  (await run(process.execPath, [fixtureScript, ...(output ? [output] : [])])).stdout.trim();

test('default benchmark reports use unique retained private directories', async () => {
  const paths = [];
  try {
    paths.push(
      ...(await Promise.all([
        writeBenchmarkReport({ sample: 1 }),
        writeBenchmarkReport({ sample: 2 }),
      ])),
    );
    assert.notEqual(dirname(paths[0]), dirname(paths[1]));
    for (const [index, path] of paths.entries()) {
      assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), { sample: index + 1 });
      if (process.platform !== 'win32') {
        assert.equal((await stat(dirname(path))).mode & 0o777, 0o700);
        assert.equal((await stat(path)).mode & 0o777, 0o600);
      }
    }
  } finally {
    await Promise.all(paths.map((path) => rm(dirname(path), { recursive: true, force: true })));
  }
});

test('explicit benchmark report is exclusive and preserves an existing file', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-report-output-'));
  try {
    const output = join(folder, 'report.json');
    assert.equal(await writeBenchmarkReport({ sample: 1 }, output), output);
    await assert.rejects(writeBenchmarkReport({ sample: 2 }, output), { code: 'EEXIST' });
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { sample: 1 });
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test(
  'explicit benchmark report refuses a symlink without changing its target',
  { skip: process.platform === 'win32' },
  async () => {
    const folder = await mkdtemp(join(tmpdir(), 'rayrag-report-link-'));
    try {
      const target = join(folder, 'target'),
        output = join(folder, 'report.json');
      await writeFile(target, 'preserved target');
      await symlink(target, output);
      await assert.rejects(writeBenchmarkReport({ sample: 1 }, output), { code: 'EEXIST' });
      assert.equal(await readFile(target, 'utf8'), 'preserved target');
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  },
);

test('default responsive fixtures are unique and remain available for serving', async () => {
  const outputs = [];
  try {
    outputs.push(await buildFixture());
    outputs.push(await buildFixture());
    assert.notEqual(outputs[0], outputs[1]);
    for (const output of outputs) {
      assert.match(
        await readFile(join(output, 'index.html'), 'utf8'),
        /<script src="fixture.js"><\/script>/,
      );
      assert.match(await readFile(join(output, 'fixture.js'), 'utf8'), /Offline route planning/);
      if (process.platform !== 'win32') assert.equal((await stat(output)).mode & 0o777, 0o700);
    }
  } finally {
    await Promise.all(outputs.map((output) => rm(output, { recursive: true, force: true })));
  }
});

test('explicit responsive fixture supports a fresh nested path and refuses existing directories', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-fixture-output-'));
  try {
    const output = join(folder, 'nested', 'fixture');
    assert.equal(await buildFixture(output), output);
    const existing = await readFile(join(output, 'fixture.js'));
    await assert.rejects(buildFixture(output), /EEXIST/);
    assert.deepEqual(await readFile(join(output, 'fixture.js')), existing);
    const occupied = join(folder, 'occupied');
    await mkdir(occupied);
    await writeFile(join(occupied, 'index.html'), 'preserved fixture');
    await assert.rejects(buildFixture(occupied), /EEXIST/);
    assert.deepEqual(await readdir(occupied), ['index.html']);
    assert.equal(await readFile(join(occupied, 'index.html'), 'utf8'), 'preserved fixture');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

test('responsive fixture rejects an existing linked directory without writing outside it', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'rayrag-fixture-link-'));
  try {
    const target = join(folder, 'target'),
      output = join(folder, 'fixture');
    await mkdir(target);
    await symlink(target, output, process.platform === 'win32' ? 'junction' : 'dir');
    await assert.rejects(buildFixture(output), /EEXIST/);
    assert.deepEqual(await readdir(target), []);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

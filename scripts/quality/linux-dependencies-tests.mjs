import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, readdir, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';

const actionPath = './.github/actions/linux-dependencies';
const readYaml = async path => Bun.YAML.parse(await readFile(new URL(path, import.meta.url), 'utf8'));
const desktop = await readYaml('../../.github/workflows/release.yml');
const release = await readYaml('../../.github/workflows/release-publish.yml');
const security = await readYaml('../../.github/workflows/security.yml');

test('Linux quality warms the same package archives consumed by release and Rust scans', async () => {
  const quality = desktop.jobs.quality;
  const builders = release.jobs['release-platforms'];
  const scans = security.jobs.codeql;
  for (const job of [quality, builders, scans]) {
    const install = job.steps.find(step => step.uses === actionPath);
    assert.ok(install, job.name ?? 'release platforms');
    assert.ok(job.steps.indexOf(install) < job.steps.findIndex(step => /bun run check|ci-platform.mjs build|bun run bridge/.test(step.run ?? '')));
    assert.ok(!job.steps.some(step => step.run?.includes('apt-get')));
  }
  assert.equal(quality.steps.find(step => step.uses === actionPath).with.smoke, true);
  assert.equal(builders.steps.find(step => step.uses === actionPath).if, "needs.reconcile.outputs.state == 'build' && matrix.platform == 'linux'");
  assert.equal(scans.steps.find(step => step.uses === actionPath).if, "matrix.language == 'rust'");
  const save = quality.steps.find(step => step.with?.key === '${{ steps.linux-dependencies.outputs.cache-primary-key }}');
  assert.ok(save.if.includes("github.repository == 'oDestroyeRo/openrayrag' && github.ref == 'refs/heads/main'"));
  assert.ok(save.if.includes("matrix.platform == 'linux'"));
  assert.ok(save.if.includes("steps.linux-dependencies.outputs.cache-hit != 'true'"));
  assert.equal(save.with.path, '${{ steps.linux-dependencies.outputs.archive-path }}/*.deb');
  for (const step of quality.steps.filter(step => step.run?.includes('--smoke'))) assert.ok(quality.steps.indexOf(save) > quality.steps.indexOf(step));
  for (const job of [builders, scans]) assert.ok(!job.steps.some(step => step.with?.key?.includes('linux-dependencies.outputs')));
});

test('restored archives preserve fresh authenticated package resolution and cold-cache installation', async () => {
  const action = await readYaml('../../.github/actions/linux-dependencies/action.yml');
  assert.equal(action.runs.using, 'composite');
  assert.equal(action.inputs.smoke.default, 'false');
  assert.ok(!action.runs.steps.some(step => step.uses?.startsWith('actions/cache/save@')));
  const metadata = action.runs.steps.find(step => step.id === 'metadata');
  assert.ok(metadata.run.includes('${GITHUB_WORKSPACE}-apt-cache'));
  assert.ok(metadata.run.includes('$ID-$VERSION_ID-$(dpkg --print-architecture)'));
  assert.ok(metadata.run.includes('update --error-on=any'));
  assert.ok(metadata.run.includes('Acquire::ForceHash=SHA256'));
  assert.ok(metadata.run.includes('--print-uris --download-only'));
  assert.ok(metadata.run.includes('Dir::Cache::archives=$plan_path/archives'));
  const restore = action.runs.steps.find(step => step.id === 'archives');
  assert.equal(restore.uses, 'actions/cache/restore@v6.1.0');
  assert.equal(restore.with.path, '${{ steps.metadata.outputs.archive-path }}/*.deb');
  assert.ok(restore.with.key.includes("hashFiles('.github/actions/linux-dependencies/action.yml', 'scripts/quality/apt-cache.py')"));
  assert.equal(restore.with.key, restore.with['restore-keys'] + '${{ steps.metadata.outputs.manifest-hash }}');
  const install = action.runs.steps.find(step => step.name === 'Install current signed desktop packages');
  assert.equal(install.if, undefined);
  assert.ok(action.runs.steps.indexOf(metadata) < action.runs.steps.indexOf(restore));
  assert.ok(install.run.indexOf('apt-cache.py verify') < install.run.indexOf('install -y'));
  assert.ok(install.run.includes('Dir::Cache::archives=$APT_ARCHIVE_CACHE_DIR'));
  assert.ok(install.run.includes('Keep-Downloaded-Packages=true'));
  for (const name of ['libwebkit2gtk-4.1-dev', 'build-essential', 'pkg-config', 'libxdo-dev', 'libssl-dev', 'librsvg2-dev', 'libayatana-appindicator3-dev', 'patchelf', 'libfuse2', 'xvfb', 'dbus-daemon']) assert.ok(metadata.run.includes(name), name);
  assert.ok(!JSON.stringify(action).match(/allow-unauthenticated|allow-insecure|dpkg -i|\/var\/lib\/apt\/lists/));
});

const helper = fileURLToPath(new URL('./apt-cache.py', import.meta.url));
const python = (...args) => execFileSync(process.platform === 'win32' ? 'python' : 'python3', [helper, ...args], { encoding: 'utf8', stdio: 'pipe' });

test('the authenticated plan retains encoded names and rejects invalid download records', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-apt-plan-'));
  try {
    const source = join(directory, 'downloads.txt');
    const hash = 'a'.repeat(64);
    await writeFile(source, `Reading package lists...\n'https://archive.example/package.deb' package_1%3a2_amd64.deb 4 SHA256:${hash}\n`);
    assert.deepEqual(JSON.parse(python('plan', source)), { 'package_1%3a2_amd64.deb': { size: 4, sha256: hash } });
    for (const record of [`../package.deb 4 SHA256:${hash}`, `package.deb 4 MD5Sum:${hash}`, `package.deb 0 SHA256:${hash}`]) {
      await writeFile(source, `'https://archive.example/package.deb' ${record}\n`);
      assert.throws(() => python('plan', source));
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('archive validation removes same-size corruption, stale packages and links before APT reuse', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'rayrag-apt-cache-'));
  try {
    const content = Buffer.from('authenticated package bytes');
    const record = { size: content.length, sha256: createHash('sha256').update(content).digest('hex') };
    const manifest = join(directory, 'manifest.json');
    await writeFile(manifest, JSON.stringify({ 'good.deb': record, 'bad.deb': record, 'linked.deb': record }));
    await writeFile(join(directory, 'good.deb'), content);
    await writeFile(join(directory, 'bad.deb'), Buffer.alloc(content.length));
    await writeFile(join(directory, 'stale.deb'), content);
    if (process.platform !== 'win32') await symlink(join(directory, 'good.deb'), join(directory, 'linked.deb'));
    assert.match(python('verify', manifest, directory), /1 verified, [23] discarded/);
    assert.deepEqual((await readdir(directory)).sort(), ['good.deb', 'manifest.json']);
    assert.match(python('verify', manifest, directory), /1 verified, 0 discarded/);
    await rm(join(directory, 'good.deb'));
    assert.match(python('verify', manifest, directory), /0 verified, 0 discarded/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

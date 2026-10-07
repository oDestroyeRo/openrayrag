// Bounded source acquisition for offline benchmarks across the flat-to-module
// migration. Historical imports resolve within their selected immutable tree;
// external packages retain their immutable version when the root install differs.
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve } from 'node:path';
import {
  bunInstallCommand,
  privateEnvironment,
  runReadOnly,
} from '../release/release-public-io.mjs';

/** @param {string} root @param {string | null | undefined} ref
 * @param {{transform?: (source: string, file: string) => string, observed?: (file: string, source: string) => void}} [options]
 * @returns {import('esbuild').Plugin}
 */
export function benchmarkSourcePlugin(root, ref, { transform, observed } = {}) {
  const namespace = 'rayrag-benchmark-source';
  const commit = ref
    ? execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
        cwd: root,
        encoding: 'utf8',
      }).trim()
    : null;
  const files = commit
    ? new Set(
        execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src'], {
          cwd: root,
          encoding: 'utf8',
          maxBuffer: 32_000_000,
        })
          .trim()
          .split('\n')
          .filter((name) => /^src\/.+\.(?:ts|json|css)$/.test(name)),
      )
    : null;
  if (
    files &&
    Number(files.has('src/engine.ts')) + Number(files.has('src/modules/automation/engine.ts')) !== 1
  )
    throw new Error('Unsupported or ambiguous benchmark source layout.');
  /** @type {Promise<string> | undefined} */
  let dependencyInstall;
  /** @type {string | undefined} */
  let dependencyFolder;
  /** @type {Record<string, any> | undefined} */
  let manifest;
  const sourceBytes = (name) =>
    execFileSync('git', ['show', `${commit}:${name}`], { cwd: root, maxBuffer: 32_000_000 });
  async function dependencyRoot(requested) {
    if (!commit) throw new Error('Historical benchmark source is unavailable.');
    if (!manifest)
      manifest = /** @type {Record<string, any>} */ (
        JSON.parse(sourceBytes('package.json').toString('utf8'))
      );
    const name = requested.startsWith('@')
      ? requested.split('/').slice(0, 2).join('/')
      : requested.split('/')[0];
    const pin = manifest.dependencies?.[name] ?? manifest.devDependencies?.[name];
    if (typeof pin !== 'string' || !/^\d+\.\d+\.\d+$/.test(pin))
      throw new Error(`Selected benchmark source must pin an exact ${name} version.`);
    let installed;
    try {
      installed = JSON.parse(
        await readFile(join(root, 'node_modules', name, 'package.json'), 'utf8'),
      ).version;
    } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
    }
    if (installed === pin && !dependencyInstall) return root;
    dependencyInstall ??= (async () => {
      dependencyFolder = await mkdtemp(join(tmpdir(), 'rayrag-benchmark-dependencies-'));
      const names = execFileSync(
        'git',
        ['ls-tree', '--name-only', commit, '--', 'bun.lock', 'package-lock.json'],
        { cwd: root, encoding: 'utf8' },
      )
        .trim()
        .split('\n');
      const lock = names.includes('bun.lock')
        ? 'bun.lock'
        : names.includes('package-lock.json')
          ? 'package-lock.json'
          : null;
      if (!lock) throw new Error('Selected benchmark source has no supported dependency lock.');
      await writeFile(join(dependencyFolder, 'package.json'), sourceBytes('package.json'));
      await writeFile(join(dependencyFolder, lock), sourceBytes(lock));
      await writeFile(join(dependencyFolder, 'bunfig.toml'), '[install]\npeer = false\n');
      const options = {
        cwd: dependencyFolder,
        env: {
          ...privateEnvironment(dependencyFolder),
          BUN_INSTALL_CACHE_DIR: process.env.BUN_INSTALL_CACHE_DIR,
        },
      };
      if (lock !== 'bun.lock') {
        const migration = bunInstallCommand(true);
        runReadOnly(migration.file, migration.args, options);
      }
      const install = bunInstallCommand();
      runReadOnly(install.file, install.args, options);
      return dependencyFolder;
    })();
    const directory = await dependencyInstall;
    const selected = JSON.parse(
      await readFile(join(directory, 'node_modules', name, 'package.json'), 'utf8'),
    );
    if (selected.version !== pin)
      throw new Error(`Installed benchmark ${name} differs from its source pin.`);
    return directory;
  }
  async function cleanupDependencies() {
    try {
      await dependencyInstall;
    } catch {
      /* Build preserves the installation failure. */
    }
    if (dependencyFolder) await rm(dependencyFolder, { recursive: true, force: true });
    dependencyInstall = undefined;
    dependencyFolder = undefined;
  }
  function historicalFile(requested) {
    if (!files) throw new Error('Historical benchmark source is unavailable.');
    const candidates = [
      requested,
      ...['.ts', '.json', '.css'].map((extension) => `${requested}${extension}`),
    ];
    const exact = candidates.find((name) => files.has(name));
    if (exact) return exact;
    // Only root source owners moved into app/shared/modules. Data retains its
    // original directory. A unique legacy owner may satisfy a current entry.
    for (const candidate of candidates) {
      if (/^src\/(?:app|shared|modules\/[^/]+)\//.test(candidate)) {
        const legacy = `src/${basename(candidate)}`;
        if (files.has(legacy)) return legacy;
      } else if (/^src\/[^/]+$/.test(candidate)) {
        const matches = [...files].filter(
          (name) =>
            /^src\/(?:app|shared|modules\/[^/]+)\//.test(name) &&
            basename(name) === basename(candidate),
        );
        if (matches.length === 1) return matches[0];
      }
    }
    throw new Error(`Selected benchmark source has no ${requested}.`);
  }
  return {
    name: 'benchmark-source-snapshot',
    setup(builder) {
      builder.onEnd(cleanupDependencies);
      builder.onDispose(() => {
        void cleanupDependencies().catch(() => {});
      });
      if (commit)
        builder.onResolve({ filter: /.*/ }, async (args) => {
          if (
            !args.path.startsWith('.') &&
            !args.path.startsWith('/') &&
            !/^[A-Za-z]:[\\/]/.test(args.path)
          ) {
            if (args.namespace !== namespace) return;
            return builder.resolve(args.path, {
              resolveDir: await dependencyRoot(args.path),
              kind: args.kind,
            });
          }
          const base =
            args.namespace === namespace ? dirname(join(root, args.importer)) : args.resolveDir;
          const file = relative(root, resolve(base, args.path)).replaceAll('\\', '/');
          if (!file.startsWith('src/')) return;
          return { path: historicalFile(file), namespace };
        });
      builder.onLoad({ filter: /\.(?:ts|json|css)$/ }, async (args) => {
        const file =
          args.namespace === namespace
            ? args.path
            : relative(root, args.path).replaceAll('\\', '/');
        if (!file.startsWith('src/')) return;
        const original =
          args.namespace === namespace
            ? execFileSync('git', ['show', `${commit}:${file}`], {
                cwd: root,
                encoding: 'utf8',
                maxBuffer: 32_000_000,
              })
            : await readFile(args.path, 'utf8');
        observed?.(file, original);
        const contents = transform ? transform(original, file) : original;
        return {
          contents,
          loader: file.endsWith('.json') ? 'json' : file.endsWith('.css') ? 'css' : 'ts',
          resolveDir: dirname(join(root, file)),
        };
      });
    },
  };
}

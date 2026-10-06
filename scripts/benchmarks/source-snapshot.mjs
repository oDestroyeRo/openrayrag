// Bounded source acquisition for offline benchmarks across the flat-to-module
// migration. Historical imports resolve within their selected immutable tree;
// external packages retain this benchmark's locked root installation.
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join, relative, resolve } from 'node:path';

/** @param {string} root @param {string | null | undefined} ref
 * @param {{transform?: (source: string, file: string) => string, observed?: (file: string, source: string) => void}} [options]
 * @returns {import('esbuild').Plugin}
 */
export function benchmarkSourcePlugin(root, ref, { transform, observed } = {}) {
  const namespace = 'rayrag-benchmark-source';
  const commit = ref ? execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], { cwd: root, encoding: 'utf8' }).trim() : null;
  const files = commit ? new Set(execFileSync('git', ['ls-tree', '-r', '--name-only', commit, '--', 'src'], { cwd: root, encoding: 'utf8', maxBuffer: 32_000_000 })
    .trim().split('\n').filter(name => /^src\/.+\.(?:ts|json|css)$/.test(name))) : null;
  if (files && (Number(files.has('src/engine.ts')) + Number(files.has('src/modules/automation/engine.ts')) !== 1))
    throw new Error('Unsupported or ambiguous benchmark source layout.');
  function historicalFile(requested) {
    if (!files) throw new Error('Historical benchmark source is unavailable.');
    const candidates = [requested, ...['.ts', '.json', '.css'].map(extension => `${requested}${extension}`)];
    const exact = candidates.find(name => files.has(name));
    if (exact) return exact;
    // Only root source owners moved into app/shared/modules. Data retains its
    // original directory. A unique legacy owner may satisfy a current entry.
    for (const candidate of candidates) {
      if (/^src\/(?:app|shared|modules\/[^/]+)\//.test(candidate)) {
        const legacy = `src/${basename(candidate)}`;
        if (files.has(legacy)) return legacy;
      } else if (/^src\/[^/]+$/.test(candidate)) {
        const matches = [...files].filter(name => /^src\/(?:app|shared|modules\/[^/]+)\//.test(name) && basename(name) === basename(candidate));
        if (matches.length === 1) return matches[0];
      }
    }
    throw new Error(`Selected benchmark source has no ${requested}.`);
  }
  return { name: 'benchmark-source-snapshot', setup(builder) {
    if (commit) builder.onResolve({ filter: /.*/ }, async args => {
      if (!args.path.startsWith('.') && !args.path.startsWith('/') && !/^[A-Za-z]:[\\/]/.test(args.path)) {
        if (args.namespace !== namespace) return;
        return builder.resolve(args.path, { resolveDir: root, kind: args.kind });
      }
      const base = args.namespace === namespace ? dirname(join(root, args.importer)) : args.resolveDir;
      const file = relative(root, resolve(base, args.path)).replaceAll('\\', '/');
      if (!file.startsWith('src/')) return;
      return { path: historicalFile(file), namespace };
    });
    builder.onLoad({ filter: /\.(?:ts|json|css)$/ }, async args => {
      const file = args.namespace === namespace ? args.path : relative(root, args.path).replaceAll('\\', '/');
      if (!file.startsWith('src/')) return;
      const original = args.namespace === namespace
        ? execFileSync('git', ['show', `${commit}:${file}`], { cwd: root, encoding: 'utf8', maxBuffer: 32_000_000 })
        : await readFile(args.path, 'utf8');
      observed?.(file, original);
      const contents = transform ? transform(original, file) : original;
      return { contents, loader: file.endsWith('.json') ? 'json' : file.endsWith('.css') ? 'css' : 'ts', resolveDir: dirname(join(root, file)) };
    });
  } };
}

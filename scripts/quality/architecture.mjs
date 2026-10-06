// Architecture check orchestration: discover source, resolve runtime imports, check policy.
import { readdir, readFile } from 'node:fs/promises';
import { dirname, extname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { build, transform } from 'esbuild';
import { dependencyViolations, inventoryViolations, logicGlobalDefines, rustEffectViolations, scriptEffectViolations } from './architecture-policy.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const scriptExtensions = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs']);
const sourceExtensions = new Set([...scriptExtensions, '.py', '.rs']);
const isTest = file => /(?:\.(?:test|spec)\.[cm]?[jt]sx?|-tests\.[cm]?js|-tests\.py|_test\.py)$/.test(file) || /(?:^|\/)test[-_]/.test(file);
export async function sourceFiles(directory = root) {
  const found = [];
  async function walk(folder) {
    for (const entry of await readdir(join(directory, folder), { withFileTypes: true })) {
      const name = `${folder}/${entry.name}`;
      if (entry.isDirectory() && !['__pycache__', 'node_modules'].includes(entry.name)) await walk(name);
      else if (entry.isFile() && sourceExtensions.has(extname(name)) && !isTest(name)) found.push(name);
    }
  }
  for (const folder of ['src', 'scripts', 'src-tauri/src', 'tools']) await walk(folder);
  found.push('src-tauri/build.rs');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && sourceExtensions.has(extname(entry.name))) found.push(entry.name);
  }
  return found.sort();
}

export async function scriptViolations(file, source, roles, directory = root) {
  const role = roles[file];
  const extension = extname(file);
  const loader = extension === '.tsx' ? 'tsx' : extension === '.jsx' ? 'jsx' : ['.ts', '.mts', '.cts'].includes(extension) ? 'ts' : 'js';
  // esbuild erases types and resolves re-exports. Externalizing relative
  // imports keeps this bounded; every logic dependency is checked separately.
  const result = await build({ stdin: { contents: source, sourcefile: file,
    resolveDir: resolve(directory, dirname(file)), loader }, bundle: true,
    write: false, metafile: true, platform: 'neutral', format: 'esm', packages: 'external',
    plugins: [{ name: 'architecture-imports', setup(builder) {
      builder.onResolve({ filter: /.*/ }, args => ({ path: args.path, external: true }));
    }}], logLevel: 'silent' });
  const imports = Object.values(result.metafile.inputs).flatMap(input => input.imports).map(item => {
    if (!item.path.startsWith('.')) return { ...item, external: true };
    const base = relative(directory, resolve(directory, dirname(file), item.path)).replaceAll('\\', '/');
    const path = [base, `${base}.ts`, `${base}.mjs`, `${base}/index.ts`].find(candidate => Object.hasOwn(roles, candidate)) ?? base;
    return { ...item, path, external: false };
  });
  const violations = dependencyViolations(file, role, imports, roles);
  if (role === 'logic') {
    const compiled = await transform(source, { loader, format: 'esm', target: 'esnext', treeShaking: false, define: logicGlobalDefines });
    violations.push(...scriptEffectViolations(file, compiled.code, true));
  }
  return violations;
}

export async function checkArchitecture(directory = root) {
  /** @type {import("../shared/tooling-domain-values.mjs").ArchitectureInventoryDto} */
  const roles = JSON.parse(await readFile(join(directory, 'architecture.json'), 'utf8'));
  const files = await sourceFiles(directory);
  const violations = inventoryViolations(files, roles);
  for (const file of files) {
    const role = roles[file];
    if (!role || role === 'orchestration') continue;
    const source = await readFile(join(directory, file), 'utf8');
    if (scriptExtensions.has(extname(file))) {
      violations.push(...await scriptViolations(file, source, roles, directory));
    } else if (role === 'logic' && file.endsWith('.rs')) violations.push(...rustEffectViolations(file, source));
  }
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const pythonViolations = JSON.parse(execFileSync(python, [join(directory, 'scripts/quality/architecture-python.py'), directory], { encoding: 'utf8' }));
  violations.push(...pythonViolations);
  return { files: files.length, roles: Object.fromEntries(['logic', 'effects', 'orchestration'].map(role => [role, Object.values(roles).filter(value => value === role).length])), violations };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await checkArchitecture();
  if (result.violations.length) throw new Error(result.violations.join('\n'));
  console.log(`Architecture checked: ${result.files} sources (${JSON.stringify(result.roles)}).`);
}

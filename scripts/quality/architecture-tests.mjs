import test from 'node:test';
import assert from 'node:assert/strict';
import { transform } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inventoryViolations, dependencyViolations, scriptEffectViolations, rustEffectViolations } from './architecture-policy.mjs';
import { checkArchitecture, scriptViolations, sourceFiles } from './architecture.mjs';

test('every first-party production source has a role and pure modules stay independent of effects', async () => {
  const result = await checkArchitecture();
  assert.deepEqual(result.violations, []);
});

test('inventory rejects unclassified, stale, and invalid roles', () => {
  assert.equal(inventoryViolations(['a', 'b'], { a: 'wrong', old: 'logic' }).length, 3);
});

test('inventory includes alternate script extensions and code beside static data', async () => {
  const root = await mkdtemp(join(tmpdir(), 'rayrag-architecture-'));
  try {
    for (const name of ['src/data', 'scripts/catalogs/nested', 'src-tauri/src', 'tools/release']) await mkdir(join(root, name), { recursive: true });
    const files = ['src/data/policy.js', 'src/panel.tsx', 'scripts/catalogs/nested/task.cjs', 'tools/release/task.mts'];
    for (const name of files) await writeFile(join(root, name), '');
    assert.deepEqual(await sourceFiles(root), [...files, 'src-tauri/build.rs'].sort());
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('runtime dependency rules reject effects, orchestration, dynamic loading and unknown sources', () => {
  const roles = { 'core.ts': 'logic', 'disk.ts': 'effects', 'main.ts': 'orchestration' };
  for (const dependency of ['disk.ts', 'main.ts', 'unknown.ts']) {
    assert.equal(dependencyViolations('core.ts', 'logic', [{ path: dependency }], roles).length, 1);
  }
  assert.equal(dependencyViolations('disk.ts', 'effects', [{ path: 'main.ts' }], roles).length, 1);
  assert.equal(dependencyViolations('core.ts', 'logic', [{ path: 'core.ts', kind: 'dynamic-import' }], roles).length, 1);
  assert.deepEqual(dependencyViolations('disk.ts', 'effects', [{ path: 'core.ts' }], roles), []);
  assert.deepEqual(dependencyViolations('main.ts', 'orchestration', [{ path: 'disk.ts' }], roles), []);
});

test('resolved imports distinguish erased types from re-exports and side effects', async () => {
  const roles = { 'core.ts': 'logic', 'nested.ts': 'logic', 'disk.ts': 'effects' };
  assert.deepEqual(await scriptViolations('core.ts', 'import type { Disk } from "./disk"; export type Port = Disk;', roles), []);
  for (const source of ['export { read } from "./disk";', 'import "./disk";', 'export const read = () => import("./disk");']) {
    assert.ok((await scriptViolations('core.ts', source, roles)).length, source);
  }
  assert.deepEqual(await scriptViolations('core.ts', 'export { read } from "./nested";', roles), []);
  assert.ok((await scriptViolations('nested.ts', 'export { read } from "./disk";', roles)).length);
  assert.deepEqual(await scriptViolations('core.ts', 'export const read = (document) => document.version;', roles), []);
  assert.ok((await scriptViolations('core.ts', 'export const read = () => document.title;', roles)).length);
  for (const source of ['const Clock=Date; export const now=()=>new Clock().getTime();',
    'const {now}=Date; export const value=()=>now();', 'const Rng=Math; export const value=()=>Rng.random();',
    'export const read = (flag, fallback) => flag ? fetch : fallback;',
    'export const read = (flag, fallback) => (flag ? document : fallback).title;',
    'import {resolve} from "node:path"; export const cwd=()=>resolve();', 'import "./style.css";']) {
    assert.ok((await scriptViolations('core.ts', source, roles)).length, source);
  }
  assert.deepEqual(await scriptViolations('core.ts', 'export const read = (Date:{now:number}) => Date.now;', roles), []);
});

test('ambient references, aliases, computed clocks and dynamic imports reject before use', async () => {
  for (const code of ['export const now = Date.now;', 'export const now = Date["now"];',
    'export const random = Math.random;', 'export const random = Math["random"];',
    'export const send = fetch;', 'export const value = new Date();', 'export const value = Date(0);',
    'export const read = () => process.env.HOME;', 'export const read = (path) => import(path);',
    'import * as crypto from "node:crypto"; export const key = crypto.randomBytes(8);']) {
    const compiled = await transform(code, { format: 'esm', treeShaking: false });
    assert.ok(scriptEffectViolations('logic.ts', compiled.code).length, code);
  }
  assert.deepEqual(scriptEffectViolations('logic.ts', 'export const date = value => new Date(value).toISOString();'), []);
  assert.deepEqual(scriptEffectViolations('logic.ts', 'const text = "fetch() and Date.now()"; // window\n'), []);
  assert.deepEqual(scriptEffectViolations('logic.ts', 'const text = value => `fetch ${value} crypto`; const pattern = /window/;'), []);
  assert.ok(scriptEffectViolations('logic.ts', 'const text = () => `result ${Date.now()}`;').length);
  assert.deepEqual(scriptEffectViolations('logic.ts', 'import { createHash } from "node:crypto"; export const hash = value => createHash("sha256").update(value).digest("hex");'), []);
});

test('logic permits named pure Effect composition and rejects effectful or unrestricted imports', async () => {
  const roles = { 'logic.ts': 'logic', 'effects.ts': 'effects' };
  for (const source of [
    'import { pipe } from "effect/Function"; import { map, filter } from "effect/Array"; export const doublePositive = xs => pipe(xs, filter(x => x > 0), map(x => x * 2));',
    'import { map as transform } from "effect/Array"; export const copy = xs => transform(xs, x => x);',
    'export { map as transform, filter } from "effect/Array";',
    'import { every } from "effect/Predicate"; export const positive = every([x => x > 0]);',
    'import { make } from "effect/Order"; import { sort } from "effect/Array"; export const sorted = xs => sort(xs, make((a, b) => a < b ? -1 : a > b ? 1 : 0));',
    'import { flatMap, map, succeed, try as tryResult } from "effect/Result"; export const admitted = text => flatMap(tryResult(() => JSON.parse(text)), value => map(succeed(value), value => value));',
    'import { gen, succeed } from "effect/Result"; export const admitted = value => gen(function* () { return yield* succeed(value); });',
    'import { flatMap, fromNullishOr, getOrNull } from "effect/Option"; export const present = value => getOrNull(flatMap(fromNullishOr(value), value => fromNullishOr(value)));',
  ]) assert.deepEqual(await scriptViolations('logic.ts', source, roles), [], source);
  for (const source of [
    'import * as A from "effect/Array"; export const copy = A.map;',
    'import A from "effect/Array"; export const copy = A.map;',
    'import "effect/Array";',
    'import { memoize } from "effect/Function"; export const cached = memoize(value => value);',
    'import { assignProperty } from "effect/Record"; export const change = value => assignProperty(value, "key", 1);',
    'import { runSync, sync } from "effect/Effect"; export const now = () => runSync(sync(() => Date.now()));',
    'import { Clock, Random } from "effect"; export { Clock, Random };',
    'export * from "effect/Array";',
    'export * as utilities from "effect/Array";',
    'import { map } from "effect/internal/array"; export { map };',
    'import { map } from "effect/Array"; export const stamps = xs => map(xs, () => Date.now());',
    'import { try as unchecked } from "effect/Array"; export const bypass = unchecked;',
    'import { "assignProperty" as unchecked } from "effect/Record"; export const bypass = unchecked;',
    'import { gen, succeed } from "effect/Result"; export const stamps = () => gen(function* () { return yield* succeed(Date.now()); });',
    'import { try as tryResult } from "effect/Result"; export const request = () => tryResult(() => fetch("https://example.invalid"));',
    'import { map } from "remeda"; export const copy = xs => map(xs, x => x);',
  ]) assert.ok((await scriptViolations('logic.ts', source, roles)).length, source);
  assert.deepEqual(await scriptViolations('effects.ts', 'import { runSync, sync } from "effect/Effect"; export const now = () => runSync(sync(() => Date.now()));', roles), []);
});

test('Rust checks production effects while allowing I/O in separate test modules', () => {
  assert.deepEqual(rustEffectViolations('logic.rs', '#[cfg(test)] mod tests { fn t() { println!("test"); } } fn valid() -> bool { true }'), []);
  for (const code of ['use std::fs;', 'std::fs::read(path);', 'use std::{io::Read, fs::File};', 'Instant::now();', 'Uuid::new_v4();', 'println!("output");']) {
    assert.ok(rustEffectViolations('logic.rs', code).length, code);
  }
  assert.ok(rustEffectViolations('logic.rs', `#[cfg(test)] mod tests { fn t() { let c = '{'; } } pub fn production() { std::fs::read("path"); }`).length);
  assert.deepEqual(rustEffectViolations('logic.rs', '/* outer /* nested */ std::fs::read */ fn pure() {}'), []);
});

test('Python logic permits memory streams and rejects aliased file or output effects', () => {
  const code = `import importlib.util,sys
spec=importlib.util.spec_from_file_location('architecture',sys.argv[1])
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
roles={'scripts/catalogs/catalog_logic.py':'logic','scripts/catalogs/catalog_effects.py':'effects'}
assert not module.check_module('scripts/catalogs/consumer.py','from catalog_logic import transform',roles)
assert module.check_module('scripts/catalogs/consumer.py','from catalog_effects import write_catalog',roles)
for source in ['import io; io.FileIO(path).read()', 'from io import open as read_file; read_file(path)', 'import json; json.dump(value, stream)', 'from pathlib import Path; Path(path).read_text()']:
    assert module.check_module('logic.py',source,{}),source
for source in ['import io; io.StringIO(text).getvalue()', 'from io import BytesIO; BytesIO(data).getvalue()', 'from pathlib import PurePosixPath; PurePosixPath(name).parts']:
    assert not module.check_module('logic.py',source,{}),source
`;
  execFileSync(process.platform === 'win32' ? 'python' : 'python3', ['-c', code, fileURLToPath(new URL('./architecture-python.py', import.meta.url))]);
});

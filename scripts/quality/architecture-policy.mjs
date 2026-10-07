// Deterministic architecture rules. Discovery, compilation and reporting live in architecture.mjs.
import { createScanner, SyntaxKind } from 'typescript/unstable/ast';
import { filter, flatMap, map } from 'effect/Array';
import { pipe } from 'effect/Function';

/** @type {readonly import("../shared/tooling-domain-values.mjs").ArchitectureRole[]} */
export const ROLES = ['logic', 'effects', 'orchestration'];

/** @param {readonly string[]} files @param {import("../shared/tooling-domain-values.mjs").ArchitectureInventoryDto} roles */
export function inventoryViolations(files, roles) {
  const actual = new Set(files);
  return [
    ...pipe(files, filter(file => !Object.hasOwn(roles, file)), map(file => `${file}: missing architecture role`)),
    ...flatMap(Object.entries(roles), ([file, role]) => !actual.has(file)
      ? [`${file}: stale architecture entry`]
      : !ROLES.some(known => known === role) ? [`${file}: unknown architecture role ${role}`] : []),
  ];
}

// These imports expose deterministic operations only; ambient APIs are checked separately.
const PURE_PACKAGES = new Set(['typescript/unstable/ast']);
const CRYPTO_OPERATIONS = new Set(['createHash', 'createPublicKey', 'verify', 'timingSafeEqual']);
const UTIL_OPERATIONS = new Set(['isDeepStrictEqual']);
const PACKAGE_OPERATIONS = new Map([
  ['node:crypto', CRYPTO_OPERATIONS], ['node:util', UTIL_OPERATIONS],
  ['node:path', new Set(['join', 'normalize', 'dirname', 'basename', 'extname', 'isAbsolute', 'parse', 'format'])],
  ['node:url', new Set(['fileURLToPath', 'domainToASCII', 'domainToUnicode'])],
  // Import the deterministic Effect owners directly. The runtime, clock,
  // randomness and retained-state helpers belong to effects or orchestration.
  // Caller-supplied callbacks and observations still require purity review.
  ['effect/Function', new Set(['identity', 'pipe', 'flow'])],
  ['effect/Array', new Set([
    'appendAll', 'dedupe', 'dedupeWith', 'every', 'filter', 'filterMap', 'findFirst',
    'findFirstIndex', 'flatMap', 'fromIterable', 'groupBy', 'head', 'map', 'partition',
    'reduce', 'some', 'sort', 'sortBy', 'sortWith', 'take',
  ])],
  ['effect/Record', new Set(['filter', 'fromEntries', 'get', 'keys', 'map', 'mapEntries', 'mapKeys', 'reduce', 'toEntries', 'values'])],
  ['effect/Struct', new Set(['omit', 'pick'])],
  ['effect/Predicate', new Set(['and', 'every', 'isNotNullish', 'isNotUndefined', 'not', 'or', 'some'])],
  ['effect/Filter', new Set(['fromPredicate'])],
  ['effect/Order', new Set(['make', 'mapInput', 'combine', 'combineAll', 'Number', 'String'])],
  ['effect/Number', new Set(['sum', 'sumAll'])],
  ['effect/Option', new Set(['getOrUndefined', 'isNone', 'isSome', 'match', 'none', 'some'])],
  ['effect/Result', new Set(['fail', 'succeed'])],
]);
const AMBIENT = ['window', 'document', 'globalThis', 'self', 'localStorage', 'sessionStorage',
  'fetch', 'XMLHttpRequest', 'WebSocket', 'console', 'process', 'Bun', 'Deno',
  'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'queueMicrotask',
  'requestAnimationFrame', 'cancelAnimationFrame', 'requestIdleCallback', 'cancelIdleCallback',
  'performance', 'crypto', 'navigator', 'location', 'Intl', 'eval', 'Function'];
// esbuild substitutes only unbound globals, so a parameter named document is safe.
export const logicGlobalDefines = Object.fromEntries([...AMBIENT, 'Date', 'Math'].map(name => [name, `__architecture_effect_${name}`]));

/** @param {string} file @param {string | undefined} role @param {readonly import("../shared/tooling-domain-values.mjs").ArchitectureDependency[]} imports @param {import("../shared/tooling-domain-values.mjs").ArchitectureInventoryDto} roles */
export function dependencyViolations(file, role, imports, roles) {
  if (role === 'orchestration') return [];
  return imports.flatMap(({ path, external, kind }) => {
    if (kind === 'dynamic-import' || kind === 'require-call') return [`${file}: runtime module loading belongs in orchestration (${path})`];
    if (/\.json$|\.svg\?raw$/.test(path)) return [];
    if (external) return role === 'logic' && !PURE_PACKAGES.has(path) && !PACKAGE_OPERATIONS.has(path)
      ? [`${file}: logic imports effect-capable package ${path}`] : [];
    const dependencyRole = roles[path];
    if (!dependencyRole) return [`${file}: unclassified dependency ${path}`];
    return dependencyRole === 'orchestration' || role === 'logic' && dependencyRole !== 'logic'
      ? [`${file}: ${role} imports ${dependencyRole} ${path}`] : [];
  });
}

export function scriptEffectViolations(file, code, markedGlobals = false) {
  const scanner = createScanner(true, undefined, code);
  const tokens = [];
  const templates = [];
  let braces = 0;
  for (let kind = scanner.scan(); kind !== SyntaxKind.EndOfFile; kind = scanner.scan()) {
    if (kind === SyntaxKind.CloseBraceToken && templates.at(-1) === braces) {
      kind = scanner.reScanTemplateToken(false);
      if (kind === SyntaxKind.TemplateTail) templates.pop();
    } else if (kind === SyntaxKind.OpenBraceToken) braces++;
    else if (kind === SyntaxKind.CloseBraceToken) braces--;
    if (kind === SyntaxKind.TemplateHead) templates.push(braces);
    if (kind === SyntaxKind.SlashToken && (!tokens.length || ['=', '(', '[', ',', ':', 'return', '=>', '!', '&&', '||', '?'].includes(tokens.at(-1).text))) kind = scanner.reScanSlashToken();
    tokens.push({ kind, text: scanner.getTokenText(), value: scanner.getTokenValue() });
  }
  const failures = new Set();
  const ambient = new Set(markedGlobals ? AMBIENT.map(name => logicGlobalDefines[name]) : AMBIENT);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i], previous = tokens[i - 1]?.text, next = tokens[i + 1]?.text;
    if (token.kind !== SyntaxKind.Identifier && token.kind !== SyntaxKind.ImportKeyword) continue;
    // Property names are not ambient references.
    if (previous !== '.' && previous !== '?.' && (markedGlobals || next !== ':') && ambient.has(token.text)) failures.add(`ambient ${token.text}`);
    if (token.text === 'import' && next === '(') failures.add('dynamic import');
    if (token.text === (markedGlobals ? logicGlobalDefines.Date : 'Date')) {
      const member = next === '.' ? tokens[i + 2]?.text : next === '[' && tokens[i + 2]?.kind === SyntaxKind.StringLiteral ? tokens[i + 2]?.value : null;
      const explicitConstructor = previous === 'new' && next === '(' && ![')', '...'].includes(tokens[i + 2]?.text);
      if (!explicitConstructor && !['parse', 'UTC'].includes(member)) failures.add('ambient Date clock or capability');
    }
    if (token.text === (markedGlobals ? logicGlobalDefines.Math : 'Math')) {
      const member = next === '.' ? tokens[i + 2]?.text : next === '[' && tokens[i + 2]?.kind === SyntaxKind.StringLiteral ? tokens[i + 2]?.value : null;
      if (!member || member === 'random') failures.add('ambient Math.random or capability');
    }
  }
  // Namespace/default imports and re-exports could hide effects or retained state.
  for (let i = 0; i < tokens.length; i++) {
    const declaration = tokens[i].kind;
    if (declaration !== SyntaxKind.ImportKeyword && declaration !== SyntaxKind.ExportKeyword) continue;
    if (tokens[i + 1]?.text === '(' || declaration === SyntaxKind.ExportKeyword && !['{', '*'].includes(tokens[i + 1]?.text)) continue;
    let end = -1;
    if (tokens[i + 1]?.kind === SyntaxKind.StringLiteral) end = i + 1;
    else for (let j = i + 1; j < tokens.length && tokens[j].text !== ';'; j++) {
      if (tokens[j].kind === SyntaxKind.FromKeyword && tokens[j + 1]?.kind === SyntaxKind.StringLiteral) { end = j + 1; break; }
    }
    if (end < 0 || !PACKAGE_OPERATIONS.has(tokens[end].value)) continue;
    const library = tokens[end].value, operations = PACKAGE_OPERATIONS.get(library);
    if (!operations) continue;
    if (tokens[i + 1]?.text !== '{') { failures.add(`unrestricted ${library} import`); continue; }
    for (let j = i + 2; j < end && tokens[j].text !== '}'; j++) {
      if (tokens[j].kind === SyntaxKind.Identifier && tokens[j - 1]?.text !== 'as' && !operations.has(tokens[j].text)) failures.add(`effect-capable ${library} operation ${tokens[j].text}`);
    }
  }
  return [...failures].map(failure => `${file}: logic references ${failure}`);
}

/** Remove strings, comments and test modules before checking Rust production effects. */
export function rustProductionCode(source) {
  let clean = '';
  for (let i = 0; i < source.length;) {
    if (source.startsWith('//', i)) {
      const end = source.indexOf('\n', i + 2);
      i = end < 0 ? source.length : end; clean += ' '; continue;
    }
    if (source.startsWith('/*', i)) {
      i += 2; let depth = 1;
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2; }
        else if (source.startsWith('*/', i)) { depth--; i += 2; }
        else i++;
      }
      clean += ' '; continue;
    }
    const raw = /^(?:b)?r(#{0,255})"/.exec(source.slice(i));
    if (raw) {
      const delimiter = `"${raw[1]}`, end = source.indexOf(delimiter, i + raw[0].length);
      i = end < 0 ? source.length : end + delimiter.length; clean += ' '; continue;
    }
    const character = /^(?:b)?'(?:\\(?:u\{[0-9a-fA-F_]+\}|x[0-9a-fA-F]{2}|.)|[^'\\\r\n])'/u.exec(source.slice(i));
    if (character) { i += character[0].length; clean += ' '; continue; }
    if (source[i] === '"') {
      i++;
      while (i < source.length && source[i] !== '"') i += source[i] === '\\' ? 2 : 1;
      i++; clean += ' '; continue;
    }
    clean += source[i++];
  }
  let result = clean;
  const test = /#\s*\[\s*cfg\s*\(\s*test\s*\)\s*\]\s*mod\s+\w+\s*\{/g;
  let match;
  while ((match = test.exec(result))) {
    let end = test.lastIndex, depth = 1;
    while (end < result.length && depth) {
      if (result[end] === '{') depth++;
      if (result[end] === '}') depth--;
      end++;
    }
    result = result.slice(0, match.index) + result.slice(end);
    test.lastIndex = match.index;
  }
  return result;
}

export function rustEffectViolations(file, source) {
  // Cursor wraps supplied bytes; it does not perform external I/O.
  const code = rustProductionCode(source).replace(/\bio\s*::\s*Cursor\b/g, 'MemoryCursor');
  const forbidden = /\bstd\s*::\s*(?:fs|io|net|process|env|thread)\b|\b(?:fs|io|net|process|env|thread)\s*::|\b(?:tauri|tokio|reqwest)\s*::|\b(?:Instant|SystemTime)\s*::\s*now\b|\b(?:new_v4|random|println|eprintln|print|eprint|dbg)\s*[!(]|\bstatic\s+mut\b|\b(?:use\s+std\s*::\s*\{[^;]*\b(?:fs|io|net|process|env|thread)\b)/g;
  return [...code.matchAll(forbidden)].map(match => `${file}: logic references effect ${match[0].trim()}`);
}

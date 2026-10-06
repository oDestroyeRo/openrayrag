import { filter, map, pipe, sort } from 'remeda';

// Pure source-check planning. Discovery and process execution belong to check.mjs.
/** @param {string} platform @param {readonly string[]} scriptNames @returns {readonly import('../shared/tooling-domain-values.mjs').VerificationStep[]} */
export function createVerificationPlan(platform, scriptNames) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Unsupported desktop platform.');
  const scripts = pipe(scriptNames,
    filter(name => name.endsWith('-tests.mjs')),
    sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
    map(name => `scripts/${name}`));
  if (!scripts.length) throw new Error('No script tests found.');
  const cargo = ['--locked', '--manifest-path', 'src-tauri/Cargo.toml'];
  /** @type {import("../shared/tooling-domain-values.mjs").VerificationStep[]} */
  const steps = [
    { tool: 'bun', args: ['install', '--cwd', 'tools/release', '--frozen-lockfile', '--ignore-scripts'], report: 'release-tools.log' },
    { tool: 'bun', args: ['run', 'typecheck:release'], report: 'release-types.log' },
    { tool: 'python', args: ['vendor/glib/verify.py', ...(platform === 'linux' ? ['--test'] : [])], report: 'glib.log' },
    // Process/packaging regressions can exceed Bun's five-second default on CI.
    { tool: 'bun', args: ['test', '--timeout', '120000', ...map(scripts, name => `./${name}`)], report: 'scripts.log' },
    { tool: 'python', args: ['-m', 'unittest', 'discover', '-s', 'scripts/catalogs', '-p', 'catalog_logic_test.py'], report: 'catalogs.log' },
    { tool: 'python', args: ['scripts/release/release-public-zip-tests.py'], report: 'public-zip.log' },
    { tool: 'bun', args: ['run', 'build'], report: 'frontend-build.log' },
    { tool: 'bun', args: ['run', 'test', '--reporter=default', '--reporter=junit', '--outputFile=reports/frontend.xml'], report: 'frontend.log' },
    { tool: 'cargo', args: ['test', ...cargo], report: 'native.log' },
    { tool: 'cargo', args: ['test', ...cargo, '--features', 'ci-smoke'], report: 'native-ci.log' },
    { tool: 'cargo', args: ['clippy', ...cargo, '--all-targets', '--', '-D', 'warnings'], report: 'clippy.log' },
    { tool: 'cargo', args: ['clippy', ...cargo, '--features', 'ci-smoke', '--all-targets', '--', '-D', 'warnings'], report: 'clippy-ci.log' },
    { tool: 'cargo', args: ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check'], report: 'format.log' },
  ];
  if (platform === 'darwin') steps.push({
    tool: 'python', args: ['-m', 'unittest', 'discover', '-s', 'scripts/release', '-p', 'release_test.py'], report: 'release-native.log',
  });
  return steps;
}

/** @param {import('../shared/tooling-domain-values.mjs').VerificationStep} step @param {string} platform @param {string} bunExecutable @returns {import('../shared/tooling-domain-values.mjs').ProcessInvocation} */
export function createInvocation(step, platform, bunExecutable) {
  return { file: step.tool === 'bun' ? bunExecutable : step.tool === 'python' ? (platform === 'win32' ? 'python' : 'python3') : step.tool, args: step.args };
}

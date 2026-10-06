// Pure source-check planning. Discovery and process execution belong to check.mjs.
export function createVerificationPlan(platform, scriptNames) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Unsupported desktop platform.');
  const scripts = scriptNames.filter(name => name.endsWith('-tests.mjs')).sort().map(name => `scripts/${name}`);
  if (!scripts.length) throw new Error('No script tests found.');
  const cargo = ['--locked', '--manifest-path', 'src-tauri/Cargo.toml'];
  const steps = [
    { tool: 'bun', args: ['install', '--cwd', 'tools/release', '--frozen-lockfile', '--ignore-scripts'], report: 'release-tools.log' },
    { tool: 'bun', args: ['run', 'typecheck:release'], report: 'release-types.log' },
    { tool: 'python', args: ['vendor/glib/verify.py', ...(platform === 'linux' ? ['--test'] : [])], report: 'glib.log' },
    // Process/packaging regressions can exceed Bun's five-second default on CI.
    { tool: 'bun', args: ['test', '--timeout', '120000', ...scripts.map(name => `./${name}`)], report: 'scripts.log' },
    { tool: 'bun', args: ['run', 'build'], report: 'frontend-build.log' },
    { tool: 'bun', args: ['run', 'test', '--reporter=default', '--reporter=junit', '--outputFile=reports/frontend.xml'], report: 'frontend.log' },
    { tool: 'cargo', args: ['test', ...cargo], report: 'native.log' },
    { tool: 'cargo', args: ['test', ...cargo, '--features', 'ci-smoke'], report: 'native-ci.log' },
    { tool: 'cargo', args: ['clippy', ...cargo, '--all-targets', '--', '-D', 'warnings'], report: 'clippy.log' },
    { tool: 'cargo', args: ['clippy', ...cargo, '--features', 'ci-smoke', '--all-targets', '--', '-D', 'warnings'], report: 'clippy-ci.log' },
    { tool: 'cargo', args: ['fmt', '--manifest-path', 'src-tauri/Cargo.toml', '--', '--check'], report: 'format.log' },
  ];
  if (platform === 'darwin') steps.push({
    tool: 'python', args: ['-m', 'unittest', 'discover', '-s', 'scripts', '-p', 'release_test.py'], report: 'release-native.log',
  });
  return steps;
}

export function createInvocation(step, platform, bunExecutable) {
  return { file: step.tool === 'bun' ? bunExecutable : step.tool === 'python' ? (platform === 'win32' ? 'python' : 'python3') : step.tool, args: step.args };
}

// Shared local/CI source verification. Native installer smoke remains a CI lane.
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoggedProcess } from './process-diagnostics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export async function verificationPlan(platform = process.platform, directory = root) {
  if (!['darwin', 'linux', 'win32'].includes(platform)) throw new Error('Unsupported desktop platform.');
  const scripts = (await readdir(join(directory, 'scripts')))
    .filter(name => name.endsWith('-tests.mjs')).sort().map(name => `scripts/${name}`);
  if (!scripts.length) throw new Error('No script tests found.');
  const cargo = ['--locked', '--manifest-path', 'src-tauri/Cargo.toml'];
  const steps = [
    { tool: 'npm', args: ['ci', '--prefix', 'tools/release', '--ignore-scripts', '--no-audit', '--no-fund'], report: 'release-tools.log' },
    { tool: 'npm', args: ['run', 'typecheck:release'], report: 'release-types.log' },
    { tool: 'python', args: ['vendor/glib/verify.py', ...(platform === 'linux' ? ['--test'] : [])], report: 'glib.log' },
    { tool: 'node', args: ['--test', ...scripts], report: 'scripts.log' },
    { tool: 'npm', args: ['run', 'build'], report: 'frontend-build.log' },
    { tool: 'npm', args: ['test', '--', '--reporter=default', '--reporter=junit', '--outputFile=reports/frontend.xml'], report: 'frontend.log' },
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

export function invocation(step, env = process.env, platform = process.platform) {
  if (step.tool === 'npm') {
    if (!env.npm_execpath) throw new Error('Run verification through npm run check.');
    // Run the npm JavaScript entry point; npm.cmd cannot spawn without a shell.
    return { file: process.execPath, args: [env.npm_execpath, ...step.args] };
  }
  return { file: step.tool === 'node' ? process.execPath : step.tool === 'python' ? (platform === 'win32' ? 'python' : 'python3') : step.tool, args: step.args };
}

export async function executePlan(steps, run = runLoggedProcess, directory = root, env = process.env) {
  for (const step of steps) {
    console.log(`Checking ${step.report.replace(/\.log$/, '')}…`);
    const command = invocation(step, env);
    await run(command.file, command.args, {
      cwd: directory, env: { ...env, PYTHONDONTWRITEBYTECODE: '1' }, report: join(directory, 'reports', step.report),
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--plan', '--help'].includes(args[0]))) throw new Error('Usage: npm run check [-- --plan]');
  if (args[0] === '--help') console.log('npm run check: complete source checks with retained reports. --plan lists checks without running them. Native installer smoke and hosted security remain CI proof.');
  else {
    const plan = await verificationPlan();
    if (args[0] === '--plan') console.log(JSON.stringify(plan, null, 2));
    else await executePlan(plan);
  }
}

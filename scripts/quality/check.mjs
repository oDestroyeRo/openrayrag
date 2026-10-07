// Shared local/CI source verification. Native installer smoke remains a CI lane.
import { readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createVerificationPlan, createInvocation } from './check-policy.mjs';
import { runLoggedProcess } from '../shared/process-diagnostics.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

export { createVerificationPlan } from './check-policy.mjs';

export async function verificationPlan(platform = process.platform, directory = root) {
  // Reject unsupported runners before reading their scripts directory.
  if (!['darwin', 'linux', 'win32'].includes(platform))
    throw new Error('Unsupported desktop platform.');
  const names = [];
  async function discover(folder) {
    for (const entry of await readdir(join(directory, 'scripts', folder), {
      withFileTypes: true,
    })) {
      const name = folder ? `${folder}/${entry.name}` : entry.name;
      if (entry.isDirectory() && !['node_modules', '__pycache__'].includes(entry.name))
        await discover(name);
      else if (entry.isFile()) names.push(name);
    }
  }
  await discover('');
  return createVerificationPlan(platform, names);
}

export function invocation(step, env = process.env, platform = process.platform) {
  return createInvocation(step, platform, process.execPath);
}

/** @param {readonly import('../shared/tooling-domain-values.mjs').VerificationStep[]} steps @param {typeof runLoggedProcess} [run] @param {string} [directory] @param {NodeJS.ProcessEnv} [env] */
export async function executePlan(
  steps,
  run = runLoggedProcess,
  directory = root,
  env = process.env,
) {
  for (const step of steps) {
    console.log(`Checking ${step.report.replace(/\.log$/, '')}…`);
    const command = invocation(step, env);
    /** @type {NodeJS.ProcessEnv} */
    const stepEnv = { ...env, PYTHONDONTWRITEBYTECODE: '1' };
    if (step.cargoTargetDirectory && stepEnv.CARGO_TARGET_DIR === undefined)
      stepEnv.CARGO_TARGET_DIR = resolve(directory, step.cargoTargetDirectory);
    await run(command.file, command.args, {
      cwd: directory,
      env: stepEnv,
      report: join(directory, 'reports', step.report),
    });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length && !['--plan', '--help'].includes(args[0])))
    throw new Error('Usage: bun run check [--plan]');
  if (args[0] === '--help')
    console.log(
      'bun run check: complete source checks with retained reports. --plan lists checks without running them. Native installer smoke and hosted security remain CI proof.',
    );
  else {
    const plan = await verificationPlan();
    if (args[0] === '--plan') console.log(JSON.stringify(plan, null, 2));
    else await executePlan(plan);
  }
}

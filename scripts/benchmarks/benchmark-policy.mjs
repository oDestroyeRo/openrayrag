import { map } from 'effect/Array';

// Pure benchmark inputs and report comparison. Measurements are effect-owned.
import { isDeepStrictEqual } from 'node:util';

/** @param {readonly number[]} values @returns {number} */
export const median = values => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

/** @param {readonly string[]} args @returns {import("../shared/tooling-domain-values.mjs").RendererOptions} */
export function rendererOptions(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    if (!['--ref', '--output', '--compare', '--samples', '--iterations', '--chrome'].includes(args[i]) || !args[i + 1]) throw new Error(`Invalid option: ${args[i]}`);
    options.set(args[i], args[i + 1]);
  }
  const samples = Number(options.get('--samples') ?? 5), iterations = Number(options.get('--iterations') ?? 100);
  if (![samples, iterations].every(n => Number.isInteger(n) && n > 0)) throw new Error('Samples and iterations must be positive integers.');
  return { options, samples, iterations };
}

/** @param {import("../shared/tooling-domain-values.mjs").RenderingReport} report @param {import("../shared/tooling-domain-values.mjs").RenderingReport} baseline */
export function compareRenderingReports(report, baseline) {
  const { samples: _samples, ...methodology } = report.methodology;
  const { samples: _oldSamples, ...oldMethodology } = baseline.methodology;
  if (report.schemaVersion !== baseline.schemaVersion || !isDeepStrictEqual(report.harness, baseline.harness) || !isDeepStrictEqual(report.machine, baseline.machine) || !isDeepStrictEqual(methodology, oldMethodology) || !isDeepStrictEqual(report.workload, baseline.workload)) throw new Error('Comparison requires the same harness, dependencies, machine/browser, methodology and workload.');
  return map(report.scenarios, row => {
    const old = baseline.scenarios.find(old => old.name === row.name);
    if (!old || !isDeepStrictEqual(row.samples[0].outcome, old.samples[0].outcome)) throw new Error(`Visible outcome differs from baseline: ${row.name}`);
    return { name: row.name, elapsedRatio: row.medianElapsedMs / old.medianElapsedMs, rendererTaskRatio: row.medianRendererTaskMs / old.medianRendererTaskMs, sameVisibleOutcome: true };
  });
}

/** @param {string} baseline @param {import("../shared/tooling-domain-values.mjs").PacketReplay} beforeCounts @param {import("../shared/tooling-domain-values.mjs").PacketReplay} afterCounts @param {import("../shared/tooling-domain-values.mjs").PacketReplay} beforeTime @param {import("../shared/tooling-domain-values.mjs").PacketReplay} afterTime @returns {import("../shared/tooling-domain-values.mjs").PacketReport} */
export function packetReport(baseline, beforeCounts, afterCounts, beforeTime, afterTime) {
  const frames = afterCounts.frames;
  /** @param {"gameClient" | "botOnly"} mode @returns {import("../shared/tooling-domain-values.mjs").PacketModeReport} */
  const modeReport = mode => ({
    generalDecodes: { before: beforeCounts[mode].counts.general, after: afterCounts[mode].counts.general },
    worldDecodes: { before: beforeCounts[mode].counts.world, after: afterCounts[mode].counts.world },
    snapshotEqual: JSON.stringify(beforeCounts[mode].snapshot) === JSON.stringify(afterCounts[mode].snapshot),
    outgoingEqual: JSON.stringify(beforeCounts[mode].writes) === JSON.stringify(afterCounts[mode].writes),
    outgoing: afterCounts[mode].writes,
    medianMs: { before: beforeTime[mode].medianMs, after: afterTime[mode].medianMs },
    samplesMs: { before: beforeTime[mode].samplesMs, after: afterTime[mode].samplesMs },
  });
  const modes = {gameClient: modeReport("gameClient"), botOnly: modeReport("botOnly")};
  return { baseline, frames, modes };
}

/** @param {import("../shared/tooling-domain-values.mjs").PacketReport} result */
export function validatePacketReport(result) {
  if (Object.values(result.modes).some(mode => !mode.snapshotEqual || !mode.outgoingEqual
    || mode.generalDecodes.after !== result.frames || mode.worldDecodes.after !== result.frames)) {
    throw new Error('Packet replay differed or an accepted frame was decoded more than once.');
  }
}

/** Error names cross the VM/browser boundary; realm-specific prototypes do not.
 * @param {unknown} error
 */
export function isBenchmarkCancellation(error) {
  return error !== null && (typeof error === 'object' || typeof error === 'function')
    && 'name' in error && error.name === 'AbortError';
}

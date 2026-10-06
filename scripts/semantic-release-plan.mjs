// Semantic release orchestration. Plugin resolution is an effect performed only
// when planning needs the pinned engines; pure contracts remain importable alone.
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  RELEASE_POLICY, validatePlanningInput, analyzerVersion, finalizePlan,
} from "./semantic-release-policy.mjs";
export * from "./semantic-release-policy.mjs";

const logger = Object.freeze({ log() {} });

async function loadReleaseEngines() {
  // Use the isolated locked tools install and the plugins' public exports.
  const toolRequire = createRequire(new URL("../tools/release/package.json", import.meta.url));
  const [analyzerModule, notesModule] = await Promise.all([
    import(pathToFileURL(toolRequire.resolve("@semantic-release/commit-analyzer")).href),
    import(pathToFileURL(toolRequire.resolve("@semantic-release/release-notes-generator")).href),
  ]);
  return { analyzer: analyzerModule.analyzeCommits, notesGenerator: notesModule.generateNotes };
}

/** @param {any} input
 * @param {{cwd?: string, analyzer?: any, notesGenerator?: any}} [options]
 */
export async function planRelease(
  input,
  { cwd = fileURLToPath(new URL("../tools/release/", import.meta.url)), analyzer, notesGenerator } = {},
) {
  const { analysisBase, notesBase } = validatePlanningInput(input, cwd);
  if (analyzer === undefined || notesGenerator === undefined) {
    const engines = await loadReleaseEngines();
    if (analyzer === undefined) analyzer = engines.analyzer;
    if (notesGenerator === undefined) notesGenerator = engines.notesGenerator;
  }
  const context = {
    cwd,
    logger,
    commits: structuredClone(input.analysisCommits),
  };
  const releaseType = await analyzer(
    structuredClone(RELEASE_POLICY.analyzer),
    context,
  );
  if (releaseType === null)
    return { state: "skip", reason: "No releasable changes." };
  const version = analyzerVersion(analysisBase, releaseType);
  const tag = `v${version}`;
  const date = input.source.pubDate.slice(0, 10);
  const notes = await notesGenerator(
    {
      ...structuredClone(RELEASE_POLICY.notesGenerator),
      writerOpts: {
        // The writer otherwise takes today's date. Retries must reserve the same bytes.
        formatDate: () => date,
        finalizeContext: (value) => ({ ...value, date }),
      },
    },
    {
      cwd,
      logger,
      commits: structuredClone(input.notesCommits),
      options: {
        repositoryUrl: `https://github.com/${RELEASE_POLICY.repository}.git`,
      },
      lastRelease: { gitHead: notesBase.sourceSha, gitTag: notesBase.tag },
      nextRelease: { gitHead: input.source.sourceSha, gitTag: tag, version },
    },
  );
  return { state: "release", plan: finalizePlan(input, { analysisBase, notesBase, releaseType, version }, notes) };
}

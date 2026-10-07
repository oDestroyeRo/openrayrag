// Semantic release orchestration. Plugin resolution is an effect performed only
// when planning needs the pinned engines; pure contracts remain importable alone.
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  planningInputValues,
  releaseTypeValue,
  releaseTagFor,
} from '../shared/tooling-domain-values.mjs';
import {
  RELEASE_POLICY,
  validatePlanningInput,
  analyzerVersion,
  finalizePlan,
} from './semantic-release-policy.mjs';
export * from './semantic-release-policy.mjs';

const logger = Object.freeze({ log() {} });

/** @returns {Promise<{analyzer: Analyzer, notesGenerator: NotesGenerator}>} */
async function loadReleaseEngines() {
  // Use the isolated locked tools install and the plugins' public exports.
  const toolRequire = createRequire(new URL('../../tools/release/package.json', import.meta.url));
  const [analyzerModule, notesModule] = await Promise.all([
    import(pathToFileURL(toolRequire.resolve('@semantic-release/commit-analyzer')).href),
    import(pathToFileURL(toolRequire.resolve('@semantic-release/release-notes-generator')).href),
  ]);
  return { analyzer: analyzerModule.analyzeCommits, notesGenerator: notesModule.generateNotes };
}

/** @typedef {(config: object, context: {cwd: string, logger: {log: () => void}, commits: readonly import('../shared/tooling-domain-values.mjs').Commit[]}) => Promise<unknown>} Analyzer */
/** @typedef {(config: object, context: {cwd: string, logger: {log: () => void}, commits: readonly import('../shared/tooling-domain-values.mjs').Commit[], options: {repositoryUrl: string}, lastRelease: {gitHead: import('../shared/tooling-domain-values.mjs').SourceCommitSha, gitTag: import('../shared/tooling-domain-values.mjs').ReleaseTag}, nextRelease: {gitHead: import('../shared/tooling-domain-values.mjs').SourceCommitSha, gitTag: import('../shared/tooling-domain-values.mjs').ReleaseTag, version: import('../shared/tooling-domain-values.mjs').StableReleaseVersion}}) => Promise<string>} NotesGenerator */
/** @param {import('../shared/tooling-domain-values.mjs').PlanningInputDto} rawInput
 * @param {{cwd?: string, analyzer?: Analyzer, notesGenerator?: NotesGenerator}} [options]
 * @returns {Promise<Readonly<{state: 'skip', reason: string, plan?: never}> | Readonly<{state: 'release', plan: import('../shared/tooling-domain-values.mjs').ReleasePlan, reason?: never}>>}
 */
export async function planRelease(
  rawInput,
  {
    cwd = fileURLToPath(new URL('../../tools/release', import.meta.url)),
    analyzer,
    notesGenerator,
  } = {},
) {
  validatePlanningInput(rawInput, cwd);
  const input = planningInputValues(rawInput);
  const sourceBase = input.reservation ?? input.published;
  const analysisBase = {
    sourceSha: sourceBase.sourceSha,
    version: sourceBase.version,
    tag: sourceBase.tag,
  };
  const notesBase = {
    sourceSha: input.published.sourceSha,
    version: input.published.version,
    tag: input.published.tag,
  };
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
  const analyzed = await analyzer(structuredClone(RELEASE_POLICY.analyzer), context);
  if (analyzed === null) return { state: 'skip', reason: 'No releasable changes.' };
  const releaseType = releaseTypeValue(analyzed, 'Invalid analyzer release type.');
  const version = analyzerVersion(analysisBase, releaseType);
  const tag = releaseTagFor(version);
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
  return {
    state: 'release',
    plan: finalizePlan(input, { analysisBase, notesBase, releaseType, version }, notes),
  };
}

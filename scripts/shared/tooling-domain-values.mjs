// Domain values retain their wire primitives. Assertions stay at this boundary;
// policies construct records only after their existing ordered checks succeed.

/** @typedef {string & {readonly __sourceCommitSha: unique symbol}} SourceCommitSha */
/** @typedef {string & {readonly __gitTagObjectSha: unique symbol}} GitTagObjectSha */
/** @typedef {string & {readonly __planDigest: unique symbol}} PlanDigest */
/** @typedef {string & {readonly __policyDigest: unique symbol}} PolicyDigest */
/** @typedef {string & {readonly __fileDigest: unique symbol}} FileDigest */
/** @typedef {string & {readonly __artifactDigest: unique symbol}} ArtifactDigest */
/** @typedef {string & {readonly __workflowRunId: unique symbol}} WorkflowRunId */
/** @typedef {string & {readonly __workflowJobId: unique symbol}} WorkflowJobId */
/** @typedef {string & {readonly __actionsArtifactId: unique symbol}} ActionsArtifactId */
/** @typedef {string & {readonly __pullRequestNumber: unique symbol}} PullRequestNumber */
/** @typedef {string & {readonly __workflowAttemptText: unique symbol}} WorkflowAttemptText */
/** @typedef {number & {readonly __workflowAttempt: unique symbol}} WorkflowAttempt */
/** @typedef {number & {readonly __releaseId: unique symbol}} ReleaseId */
/** @typedef {number & {readonly __firstParentCount: unique symbol}} FirstParentCount */
/** @typedef {string & {readonly __stableReleaseVersion: unique symbol}} StableReleaseVersion */
/** @typedef {string & {readonly __releaseTag: unique symbol}} ReleaseTag */
/** @typedef {'major' | 'minor' | 'patch'} ReleaseType */
/** @typedef {'macos' | 'windows' | 'linux'} PackagePlatform */
/** @typedef {'aarch64-apple-darwin' | 'x86_64-pc-windows-msvc' | 'x86_64-unknown-linux-gnu'} PackageTarget */
/** @typedef {'darwin' | 'win32' | 'linux'} DesktopPlatform */
/** @typedef {Readonly<{sourceSha: string, version: string, tag: string}>} ReleaseBaseDto */
/** @typedef {Readonly<{sourceSha: SourceCommitSha, version: StableReleaseVersion, tag: ReleaseTag}>} ReleaseBase */
/** @typedef {Readonly<{sourceSha: string, firstParentCount: number, pubDate: string}>} ReleaseSourceDto */
/** @typedef {Readonly<{sourceSha: SourceCommitSha, firstParentCount: FirstParentCount, pubDate: string}>} ReleaseSource */
/** @typedef {ReleaseBaseDto & Readonly<{firstParentCount: number}>} ReleaseBridgeDto */
/** @typedef {ReleaseBase & Readonly<{firstParentCount: FirstParentCount}>} ReleaseBridge */
/** @typedef {Readonly<{hash: string, message: string}>} CommitDto */
/** @typedef {Readonly<{hash: SourceCommitSha, message: string}>} Commit */
/** @typedef {Readonly<{schemaVersion: 1, repository: string, sourceSha: string, firstParentCount: number, pubDate: string, version: string, tag: string, releaseType: ReleaseType, analysisBase: ReleaseBaseDto, notesBase: ReleaseBaseDto, policyVersion: number, policySha256: string, predecessorPlanSha256: string | null, notes: string}>} ReleasePlanDto */
/** @typedef {Readonly<{schemaVersion: 1, repository: string, sourceSha: SourceCommitSha, firstParentCount: FirstParentCount, pubDate: string, version: StableReleaseVersion, tag: ReleaseTag, releaseType: ReleaseType, analysisBase: ReleaseBase, notesBase: ReleaseBase, policyVersion: number, policySha256: PolicyDigest, predecessorPlanSha256: PlanDigest | null, notes: string}>} ReleasePlan */
/** @typedef {Readonly<{source: ReleaseSourceDto, published: ReleaseBaseDto, reservation: ReleasePlanDto | null, analysisCommits: readonly CommitDto[], notesCommits: readonly CommitDto[]}>} PlanningInputDto */
/** @typedef {Readonly<{source: ReleaseSource, published: ReleaseBase, reservation: ReleasePlan | null, analysisCommits: readonly Commit[], notesCommits: readonly Commit[]}>} PlanningInput */
/** @typedef {Readonly<{sourceSha: SourceCommitSha, firstParentCount?: FirstParentCount, version: StableReleaseVersion, tag: ReleaseTag, pubDate: string, releasePlan?: ReleasePlan}>} ReleaseIdentity */
/** @typedef {Pick<ReleaseIdentity, 'sourceSha' | 'version'>} PackageIdentity */
/** @typedef {Readonly<{id: string | undefined, runId: string | undefined, digest: string}>} ArtifactIdentityDto */
/** @typedef {Readonly<{id: ActionsArtifactId, runId: WorkflowRunId, digest: ArtifactDigest}>} ArtifactIdentity */
/** @typedef {Readonly<{name: string, bytes: number, sha256: FileDigest}>} FileRecord */
/** @typedef {Readonly<{runId: string | undefined, runAttempt: string | undefined, artifactName?: string, schemaVersion?: number, platforms?: readonly PlatformReceipt[]}>} BuildDto */
/** @typedef {Readonly<{schemaVersion: 1, sourceSha: SourceCommitSha, version: StableReleaseVersion, target: PackageTarget, runId: WorkflowRunId, runAttempt: WorkflowAttemptText, files: readonly FileRecord[], checks: readonly string[]}>} PlatformReceipt */
/** @typedef {Readonly<{schemaVersion: 1 | 2, repository: string, sourceSha: SourceCommitSha, firstParentCount: FirstParentCount, version: StableReleaseVersion, target: PackageTarget, identifier: string, runId: WorkflowRunId, runAttempt: WorkflowAttemptText, artifactName: string, toolchain: Readonly<Record<string, string>>, files: readonly FileRecord[], platforms?: readonly PlatformReceipt[]}> | Readonly<{schemaVersion: 3, repository: string, sourceSha: SourceCommitSha, firstParentCount: FirstParentCount, version: StableReleaseVersion, target: PackageTarget, identifier: string, runId: WorkflowRunId, runAttempt: WorkflowAttemptText, artifactName: string, toolchain: Readonly<Record<string, string>>, files: readonly FileRecord[], platforms: readonly PlatformReceipt[], releasePlan: ReleasePlan}>} Provenance */
/** @typedef {Readonly<{schemaVersion: 1 | 2, version: StableReleaseVersion, sourceSha: SourceCommitSha, artifact: ArtifactIdentity}> | Readonly<{schemaVersion: 3, version: StableReleaseVersion, sourceSha: SourceCommitSha, firstParentCount: FirstParentCount, planSha256: PlanDigest, artifact: ArtifactIdentity}>} ReleaseMetadata */
/** @typedef {Readonly<{id: number, tag_name: string, body: string, draft: boolean, prerelease: boolean, published_at?: string, assets?: readonly ReleaseAssetDto[]}>} ReleaseDto */
/** @typedef {Readonly<{id: ReleaseId, tag_name: ReleaseTag, body: string, draft: boolean, prerelease: boolean, published_at?: string, assets: readonly ReleaseAssetDto[]}>} PublicRelease */
/** @typedef {Readonly<{id: number, name: string, state: string, size: number, digest?: string, browser_download_url?: string, updated_at?: string}>} ReleaseAssetDto */
/** @typedef {Readonly<{ref: string, object: Readonly<{type: string, sha: string}>}>} ReservationRefDto */
/** @typedef {Readonly<{ref: string, object: Readonly<{type: 'tag', sha: GitTagObjectSha}>}>} ReservationRef */
/** @typedef {Readonly<{sha: string, tag: string, message: string, object: Readonly<{type: string, sha: string}>}>} TagObjectDto */
/** @typedef {Readonly<{sha: GitTagObjectSha, tag: string, message: string, object: Readonly<{type: 'commit', sha: SourceCommitSha}>}>} ReservationTagObject */
/** @typedef {Pick<import('../release/release.mjs').GitHubReleaseApi, 'release' | 'latest' | 'tagSha' | 'planRefs' | 'planRef' | 'tagObject' | 'createPlanTag' | 'createPlanRef' | 'createTag' | 'createDraft' | 'assets' | 'downloadAsset' | 'downloadRelease' | 'upload' | 'publish' | 'restoreArtifact'>} ReleaseApi */
/** @typedef {{readonly history: readonly string[], readonly sha: SourceCommitSha, readonly api: ReleaseApi, readonly dateFor: (sha: SourceCommitSha) => Promise<string>, readonly publicKey: string, readonly verifyNative: (files: Map<string, Buffer>, id: ReleaseIdentity) => Promise<void>, readonly verifyPlan?: (plan: ReleasePlan) => Promise<unknown>}} ReleaseContext */
/** @typedef {{readonly history: readonly string[], readonly bridge: ReleaseBridgeDto, readonly api: Pick<ReleaseApi, 'planRefs' | 'planRef' | 'tagObject' | 'createPlanTag' | 'createPlanRef'>}} ReservationContext */
/** @typedef {Omit<ReservationContext, 'api'> & {readonly api: Pick<ReleaseApi, 'planRefs' | 'tagObject'>}} ReservationReadContext */
/** @typedef {ReleaseContext & {readonly commitsBetween: (base: SourceCommitSha, source: SourceCommitSha) => Promise<readonly CommitDto[]>}} PlanningContext */
/** @typedef {ReleaseContext & {readonly id: ReleaseIdentity}} CandidateContext */
/** @typedef {CandidateContext & {readonly files?: Map<string, Buffer>, readonly artifact?: ArtifactIdentity}} PublicationContext */
/** @typedef {Readonly<{state: 'build', artifact?: never}> | Readonly<{state: 'reuse' | 'published', artifact: ArtifactIdentity}>} PreflightResult */
/** @typedef {Readonly<{state: 'skip', reason: string, id?: never, plan?: never, artifact?: never}> | (PreflightResult & Readonly<{id: ReleaseIdentity, plan: ReleasePlan, reason?: never}>)} ProductionPlanResult */
/** @typedef {Readonly<{tool: 'bun' | 'python' | 'cargo', args: readonly string[], report: string}>} VerificationStep */
/** @typedef {Readonly<{file: string, args: readonly string[]}>} ProcessInvocation */
/** @typedef {Readonly<{binary: string, report: string}>} PackageSmoke */
/** @typedef {'save' | 'reopen'} SmokeStage */
/** @typedef {Readonly<{version: 1, revision: number, selectedProfileId: null, settings: Readonly<{radius: 17, loot: false, route_step: 7}>}>} SmokeDocument */
/** @typedef {Readonly<{needed: readonly string[], interpreter: string, rpath: string}>} DynamicIdentity */
/** @typedef {Readonly<{samples: number, iterations: number, options: ReadonlyMap<string, string>}>} RendererOptions */
/** @typedef {Readonly<{schemaVersion: number, sourceSha: string, version: string, target: string, runId: string | undefined, runAttempt: string | undefined, files: readonly {name: string, bytes: number, sha256: string}[], checks: readonly string[]}>} PlatformReceiptDto */
/** @typedef {Readonly<{schemaVersion: number, repository: string, sourceSha: string, firstParentCount: number, version: string, target: string, identifier: string, runId: string, runAttempt: string, artifactName: string, toolchain: Readonly<Record<string, string>>, files: readonly {name: string, bytes: number, sha256: string}[], platforms?: readonly PlatformReceiptDto[], releasePlan?: ReleasePlanDto}>} ProvenanceDto */
/** @typedef {Readonly<{schemaVersion: number, version: string, sourceSha: string, artifact: ArtifactIdentityDto, firstParentCount?: number, planSha256?: string}>} ReleaseMetadataDto */
/** @typedef {'queued' | 'in_progress' | 'completed' | 'waiting' | 'pending' | 'requested'} HostedStatus */
/** @typedef {Readonly<{id: number | string, head_sha: string, status: string, run_attempt: number, conclusion?: string | null}>} HostedRunDto */
/** @typedef {Readonly<{id: number | string, head_sha: SourceCommitSha, status: HostedStatus, run_attempt: WorkflowAttempt, conclusion?: string | null}>} HostedRun */
/** @typedef {Readonly<{id: WorkflowJobId, name: string, status: HostedStatus, conclusion: string | null}>} HostedJob */
/** @typedef {Readonly<{name: string | undefined, status: string, conclusion: string | null}>} HostedCheck */
/** @typedef {Readonly<{number: PullRequestNumber, state: string, mergeState: string, reviewDecision: string | null, checks: readonly HostedCheck[]}>} PullRequestStatus */
/** @typedef {Readonly<{repository: string, runId: WorkflowRunId, sourceSha: SourceCommitSha, attempt: WorkflowAttempt, status: HostedStatus, conclusion: string | null, url: string, jobs: readonly HostedJob[], pullRequest?: PullRequestStatus}>} RunSnapshot */
/** @typedef {{runId: WorkflowRunId, watch: boolean, expectedSha?: SourceCommitSha, jobId?: WorkflowJobId, pullRequest?: PullRequestNumber, help?: never}} HostedOptions */
/** @typedef {Readonly<{help: true}> | Readonly<HostedOptions>} HostedCommand */
/** @typedef {Readonly<{headRefOid: string, state: string, mergeStateStatus: string, reviewDecision?: string | null, statusCheckRollup: readonly {name?: string, context?: string, status?: string, state?: string, conclusion?: string}[]}>} PullRequestStatusDto */
/** @typedef {Readonly<{repository: string, sourceSha: SourceCommitSha, tag: ReleaseTag, latest: boolean, skipNative: boolean, runId?: WorkflowRunId, runAttempt?: WorkflowAttemptText, help?: never}>} PublicOptions */
/** @typedef {Readonly<{help: true}> | PublicOptions} PublicCommand */
/** @typedef {{repository: string, latest: boolean, skipNative: boolean, sourceSha?: string, tag?: string, runId?: string, runAttempt?: string}} PublicOptionsDto */
/** @typedef {HostedRunDto & Readonly<{id: number, head_branch: string, event: string, path: string}>} SourceWorkflowDto */
/** @typedef {Readonly<{id: number, name: string, status: string, conclusion: string | null, steps?: readonly {name: string, conclusion: string | null}[]}>} PublicationJobDto */
/** @typedef {Readonly<{total_count: number, jobs: readonly PublicationJobDto[]}>} PublicationJobsDto */
/** @typedef {Readonly<{id: number, name: string, digest: string, expired: boolean, workflow_run?: {id: number, head_sha: string}}>} ActionsArtifactDto */
/** @typedef {Readonly<{runId: WorkflowRunId, runAttempt: WorkflowAttemptText, recoveredOriginalArtifact: boolean}>} PublicationEvidence */
/** @typedef {(args: readonly string[]) => Buffer} AnonymousGit */
/** @typedef {(name: string, bytes: string | Buffer) => Promise<void>} ProofWriter */
/** @typedef {{core: typeof import('../release/release-core.mjs'), planner: typeof import('../release/semantic-release-plan.mjs'), reservations: typeof import('../release/release-reservations.mjs'), tags: typeof import('../release/release.mjs'), readonly scriptDirectory?: "scripts" | "scripts/release"}} SourceValidators */
/** @typedef {{
 * (path: `/git/matching-refs/tags/${string}`, options?: {fresh?: boolean}): Promise<readonly ReservationRefDto[]>;
 * (path: `/git/ref/${string}`, options?: {fresh?: boolean}): Promise<{object: {type: string, sha: string}}>;
 * (path: `/git/tags/${string}`, options?: {fresh?: boolean}): Promise<TagObjectDto>;
 * (path: `/releases/${string}`, options?: {fresh?: boolean}): Promise<ReleaseDto>;
 * (path: `/actions/workflows/${string}`, options?: {fresh?: boolean}): Promise<{workflow_runs: readonly SourceWorkflowDto[]}>;
 * (path: `/actions/runs/${string}/attempts/${string}/jobs?${string}`, options?: {fresh?: boolean}): Promise<PublicationJobsDto>;
 * (path: `/actions/runs/${string}/attempts/${string}`, options?: {fresh?: boolean}): Promise<SourceWorkflowDto>;
 * (path: `/actions/artifacts/${string}`, options?: {fresh?: boolean}): Promise<ActionsArtifactDto>;
 * }} PublicMetadataApi */
/** @typedef {{readonly folder: string, readonly api: PublicMetadataApi, readonly write: ProofWriter, readonly git?: AnonymousGit, readonly loadValidators?: typeof import('../release/release-public-source.mjs').loadSourceValidators}} SourceVerificationIo */
/** @typedef {Readonly<{zipDigest: ArtifactDigest, publicAssetCount: number}>} ZipProof */
/** @typedef {SourceVerificationIo & {readonly verifySource?: typeof import('../release/release-public-source.mjs').verifySource, readonly download: (url: string, limit: number) => Promise<Buffer>, readonly progress?: (message: string) => void, readonly verifyZip: (input: {assets: readonly {name: string, size: number, sha256: FileDigest}[], artifactId: ActionsArtifactId, artifactDigest: ArtifactDigest, limit: number}) => Promise<ZipProof>, readonly verifyNative: (source: Awaited<ReturnType<typeof import('../release/release-public-source.mjs').verifySource>>, version: StableReleaseVersion) => Promise<void>}} PublicVerificationIo */
/** @typedef {Readonly<{protocol: 1, stage: SmokeStage, token: string, passed: true, checks: readonly string[], document: SmokeDocument}>} SmokeResult */
/** @typedef {Readonly<{protocol?: number, stage?: string, token?: string, passed?: boolean, checks?: readonly string[], document?: {version?: number, revision?: number, selectedProfileId?: string | null, settings?: {radius?: number, loot?: boolean, route_step?: number}}}>} SmokeResultDto */
/** @typedef {Readonly<{root: string, data: string, result: string, token: string, timeoutMs?: number, prefixArgs?: readonly string[], env?: NodeJS.ProcessEnv}>} SmokeStageOptions */
/** @typedef {Readonly<{os: DesktopPlatform, arch: 'arm64' | 'x64', target: PackageTarget, bundles: string}>} PackagePlatformSpec */
/** @typedef {Readonly<{type: number, flags: number, offset: number, address: bigint, physical: bigint, fileSize: number, memorySize: number, alignment: bigint}>} ElfProgram */
/** @typedef {{index: number, nameOffset: number, type: number, flags: bigint, address: bigint, offset: number, size: number, link: number, info: number, alignment: bigint, entrySize: bigint, contents?: Buffer | null, name?: string}} ElfSectionDraft */
/** @typedef {'steady' | 'vitals' | 'movement' | 'logs' | 'timer' | 'reconnect'} RenderingScenarioName */
/** @typedef {Readonly<{elapsedMs: number, counters: Readonly<Record<string, number>>}>} RenderingWork */
/** @typedef {RenderingWork & Readonly<{outcome: unknown, rendererTaskMs: number, heapBeforeBytes: number, heapAfterBytes: number, heapAfterGcBytes: number, heapGrowthBytes: number, retainedHeapDeltaBytes: number}>} RenderingSample */
/** @typedef {Readonly<{name: RenderingScenarioName, iterations: number, workCounters: Readonly<Record<string, number>>, medianElapsedMs: number, medianRendererTaskMs: number, medianHeapGrowthBytes: number, medianRetainedHeapDeltaBytes: number, samples: readonly RenderingSample[]}>} RenderingScenario */
/** @typedef {Readonly<{name: RenderingScenarioName, elapsedRatio: number, rendererTaskRatio: number, sameVisibleOutcome: boolean}>} RenderingComparison */
/** @typedef {{schemaVersion: number, harness: Readonly<{files: readonly string[], hash: string}>, createdAt: string, source: Readonly<{commit: string, mode: string, loadedSourceHash: string, dirty: string}>, machine: Readonly<Record<string, unknown>>, methodology: Readonly<Record<string, unknown>> & {samples: number}, workload: unknown, scenarios: RenderingScenario[], probes: {passed: readonly string[]} | null, comparison?: readonly RenderingComparison[]}} RenderingReport */

/** @param {unknown} value @param {string} message @returns {asserts value} */
function requireValue(value, message) { if (!value) throw new Error(message); }
/** @param {unknown} value @param {string} message @returns {asserts value is string} */
function sha(value, message) { requireValue(typeof value === 'string' && /^[a-f0-9]{40}$/.test(value), message); }
/** @param {unknown} value @param {string} message @returns {asserts value is string} */
function digest(value, message) { requireValue(typeof value === 'string' && /^[a-f0-9]{64}$/.test(value), message); }
/** @param {unknown} value @param {string} message @returns {string} */
function decimal(value, message) { requireValue(/^[1-9]\d*$/.test(String(value)), message); return String(value); }

/** @param {unknown} value @param {string} [message] @returns {SourceCommitSha} */
export function sourceCommitSha(value, message = 'Invalid source SHA.') { sha(value, message); return /** @type {SourceCommitSha} */ (value); }
/** @param {unknown} value @param {string} [message] @returns {GitTagObjectSha} */
export function gitTagObjectSha(value, message = 'Invalid annotated tag SHA.') { sha(value, message); return /** @type {GitTagObjectSha} */ (value); }
/** @param {unknown} value @returns {FileDigest} */
export function fileDigest(value) { digest(value, 'Invalid file digest.'); return /** @type {FileDigest} */ (value); }
/** @param {unknown} value @returns {PlanDigest} */
export function planDigest(value) { digest(value, 'Invalid plan digest.'); return /** @type {PlanDigest} */ (value); }
/** @param {unknown} value @returns {PolicyDigest} */
export function policyDigest(value) { digest(value, 'Invalid policy digest.'); return /** @type {PolicyDigest} */ (value); }
/** @param {unknown} value @returns {ArtifactDigest} */
export function artifactDigest(value) { requireValue(typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value), 'Invalid artifact digest.'); return /** @type {ArtifactDigest} */ (value); }
/** @param {unknown} value @param {string} [message] @returns {WorkflowRunId} */
export function workflowRunId(value, message = 'Expected a positive numeric GitHub ID.') { return /** @type {WorkflowRunId} */ (decimal(value, message)); }
/** @param {unknown} value @param {string} [message] @returns {WorkflowJobId} */
export function workflowJobId(value, message = 'Expected a positive numeric GitHub ID.') { return /** @type {WorkflowJobId} */ (decimal(value, message)); }
/** @param {unknown} value @param {string} [message] @returns {ActionsArtifactId} */
export function actionsArtifactId(value, message = 'Expected a positive numeric GitHub ID.') { return /** @type {ActionsArtifactId} */ (decimal(value, message)); }
/** @param {unknown} value @param {string} [message] @returns {PullRequestNumber} */
export function pullRequestNumber(value, message = 'Expected a positive numeric GitHub ID.') { return /** @type {PullRequestNumber} */ (decimal(value, message)); }
/** @param {unknown} value @param {string} [message] @returns {WorkflowAttemptText} */
export function workflowAttemptText(value, message = 'Invalid workflow attempt.') { return /** @type {WorkflowAttemptText} */ (decimal(value, message)); }
/** @param {unknown} value @returns {WorkflowAttempt} */
export function workflowAttempt(value) { requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'Missing workflow attempt.'); return /** @type {WorkflowAttempt} */ (value); }
/** @param {unknown} value @returns {ReleaseId} */
export function releaseId(value) { requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, 'Invalid release record.'); return /** @type {ReleaseId} */ (value); }
/** @param {unknown} value @param {string} [message] @returns {FirstParentCount} */
export function firstParentCount(value, message = 'Invalid first-parent count.') { requireValue(typeof value === 'number' && Number.isSafeInteger(value) && value > 0, message); return /** @type {FirstParentCount} */ (value); }

const MAX_STABLE_VERSION_LENGTH = 3 * String(Number.MAX_SAFE_INTEGER).length + 2;
/** @param {unknown} value @returns {StableReleaseVersion} */
export function stableReleaseVersion(value) {
  requireValue(typeof value === 'string' && value.length <= MAX_STABLE_VERSION_LENGTH &&
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value) &&
    value.split('.').every(part => Number.isSafeInteger(Number(part)) && String(Number(part)) === part), 'Invalid stable release version.');
  return /** @type {StableReleaseVersion} */ (value);
}
/** @param {unknown} value @returns {ReleaseTag} */
export function releaseTag(value) { requireValue(typeof value === 'string' && /^v(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(value), 'Expected a canonical stable release tag.'); return /** @type {ReleaseTag} */ (value); }
/** @param {StableReleaseVersion} version @returns {ReleaseTag} */
export function releaseTagFor(version) { return releaseTag(`v${version}`); }
/** @param {unknown} value @param {string} [message] @returns {ReleaseType} */
export function releaseTypeValue(value, message = 'Invalid release type.') { requireValue(value === 'major' || value === 'minor' || value === 'patch', message); return value; }

/** @param {ReleaseBaseDto} value @returns {ReleaseBase} */
export function releaseBaseValues(value) { sourceCommitSha(value.sourceSha); stableReleaseVersion(value.version); releaseTag(value.tag); return /** @type {ReleaseBase} */ (value); }
/** @param {ReleaseBridgeDto} value @returns {ReleaseBridge} */
export function releaseBridgeValues(value) { releaseBaseValues(value); firstParentCount(value.firstParentCount); return /** @type {ReleaseBridge} */ (value); }
/** @param {ReleaseSourceDto} value @returns {ReleaseSource} */
export function releaseSourceValues(value) { sourceCommitSha(value.sourceSha); firstParentCount(value.firstParentCount); return /** @type {ReleaseSource} */ (value); }
/** @param {ReleasePlanDto} value @returns {ReleasePlan} */
export function releasePlanValues(value) {
  releaseSourceValues(value); releaseBaseValues(value); releaseBaseValues(value.analysisBase); releaseBaseValues(value.notesBase);
  policyDigest(value.policySha256); if (value.predecessorPlanSha256 !== null) planDigest(value.predecessorPlanSha256);
  return /** @type {ReleasePlan} */ (value);
}
/** @param {PlanningInputDto} value @returns {PlanningInput} */
export function planningInputValues(value) {
  const owned = structuredClone(value);
  releaseSourceValues(owned.source); releaseBaseValues(owned.published); if (owned.reservation !== null) releasePlanValues(owned.reservation);
  for (const commit of [...owned.analysisCommits, ...owned.notesCommits]) sourceCommitSha(commit.hash);
  return /** @type {PlanningInput} */ (owned);
}
/** @param {ArtifactIdentityDto} value @returns {ArtifactIdentity} */
export function artifactIdentityValues(value) { actionsArtifactId(value.id); workflowRunId(value.runId); artifactDigest(value.digest); return /** @type {ArtifactIdentity} */ (value); }
/** @param {ReservationRefDto} value @returns {ReservationRef} */
export function reservationRefValues(value) { gitTagObjectSha(value.object.sha); return /** @type {ReservationRef} */ (value); }
/** @param {TagObjectDto} value @returns {ReservationTagObject} */
export function reservationTagValues(value) { gitTagObjectSha(value.sha); sourceCommitSha(value.object.sha); return /** @type {ReservationTagObject} */ (value); }
/** @param {PlatformReceiptDto} value @returns {PlatformReceipt} */
export function platformReceiptValues(value) {
  sourceCommitSha(value.sourceSha); stableReleaseVersion(value.version); workflowRunId(value.runId); workflowAttemptText(value.runAttempt);
  for (const file of value.files) fileDigest(file.sha256);
  return /** @type {PlatformReceipt} */ (value);
}
/** @param {ProvenanceDto} value @returns {Provenance} */
export function provenanceValues(value) {
  sourceCommitSha(value.sourceSha); firstParentCount(value.firstParentCount); stableReleaseVersion(value.version);
  workflowRunId(value.runId); workflowAttemptText(value.runAttempt); for (const file of value.files) fileDigest(file.sha256);
  if (value.platforms) for (const receipt of value.platforms) platformReceiptValues(receipt);
  if (value.schemaVersion === 3 && value.releasePlan) releasePlanValues(value.releasePlan);
  return /** @type {Provenance} */ (value);
}
/** @param {ReleaseMetadataDto} value @returns {ReleaseMetadata} */
export function releaseMetadataValues(value) {
  sourceCommitSha(value.sourceSha); stableReleaseVersion(value.version); artifactIdentityValues(value.artifact);
  if (value.schemaVersion === 3) { firstParentCount(value.firstParentCount); planDigest(value.planSha256); }
  return /** @type {ReleaseMetadata} */ (value);
}
/** @param {HostedRunDto} value @returns {HostedRun} */
export function hostedRunValues(value) { sourceCommitSha(value.head_sha); workflowAttempt(value.run_attempt); return /** @type {HostedRun} */ (value); }
/** @param {{id: string, name: string, status: string, conclusion: string | null}} value @returns {HostedJob} */
export function hostedJobValues(value) { workflowJobId(value.id); return /** @type {HostedJob} */ (value); }
/** @param {NonNullable<SmokeResultDto['document']>} value @returns {SmokeDocument} */
export function smokeDocumentValues(value) {
  requireValue(value.version === 1 && typeof value.revision === 'number' && Number.isSafeInteger(value.revision) && value.revision > 0
    && value.selectedProfileId === null && value.settings?.radius === 17 && value.settings.loot === false && value.settings.route_step === 7,
  'Invalid smoke settings document.');
  return /** @type {SmokeDocument} */ (value);
}
/** @param {SmokeResultDto} value @returns {SmokeResult} */
export function smokeResultValues(value) {
  requireValue(value.protocol === 1 && (value.stage === 'save' || value.stage === 'reopen') && typeof value.token === 'string'
    && value.passed === true && Array.isArray(value.checks) && value.document, 'Invalid smoke result.');
  smokeDocumentValues(value.document);
  return /** @type {SmokeResult} */ (structuredClone(value));
}
/** @param {PublicOptionsDto} value @returns {PublicOptions} */
export function publicOptionsValues(value) {
  sourceCommitSha(value.sourceSha); releaseTag(value.tag);
  if (value.runId !== undefined) workflowRunId(value.runId);
  if (value.runAttempt !== undefined) workflowAttemptText(value.runAttempt);
  return /** @type {PublicOptions} */ ({...value});
}
/** Own the release and nested asset DTOs before starting download effects.
 * @param {ReleaseDto} value @returns {PublicRelease}
 */
export function publicReleaseValues(value) {
  releaseId(value.id); releaseTag(value.tag_name);
  requireValue(typeof value.body === 'string' && typeof value.draft === 'boolean' && typeof value.prerelease === 'boolean'
    && Array.isArray(value.assets), 'Invalid public release.');
  return /** @type {PublicRelease} */ (structuredClone(value));
}

/** @typedef {Readonly<{general: number, world: number}>} PacketDecodeCounts */
/** @typedef {Readonly<{snapshot: unknown, writes: readonly (readonly number[])[], counts: PacketDecodeCounts, medianMs: number, samplesMs: readonly number[]}>} PacketReplaySample */
/** @typedef {Readonly<{frames: number, gameClient: PacketReplaySample, botOnly: PacketReplaySample}>} PacketReplay */
/** @typedef {Readonly<{generalDecodes: {before: number, after: number}, worldDecodes: {before: number, after: number}, snapshotEqual: boolean, outgoingEqual: boolean, outgoing: readonly (readonly number[])[], medianMs: {before: number, after: number}, samplesMs: {before: readonly number[], after: readonly number[]}}>} PacketModeReport */
/** @typedef {Readonly<{baseline: string, frames: number, modes: Readonly<Record<'gameClient' | 'botOnly', PacketModeReport>>}>} PacketReport */
/** @typedef {'logic' | 'effects' | 'orchestration'} ArchitectureRole */
/** @typedef {Readonly<Record<string, string>>} ArchitectureInventoryDto */
/** @typedef {Readonly<{path: string, external: boolean, kind: string}>} ArchitectureDependency */
/** @typedef {Readonly<{fixture: string, beforeMs: number, afterMs: number, crossings: number | null, outcomeHash: string}>} RouteBenchmarkSummary */
/** @typedef {Readonly<{score: number, hops: number}>} RouteOptimum */
/** @typedef {Readonly<{mode: 'legacy' | 'weighted', destination: string, cache: 'cold' | 'repeated', totalMs: number, maxSliceMs: number, maxSchedulingDelayMs: number, maxTimerDelayMs: number, slices: number}>} ResponsiveRouteSample */
/** @typedef {{planRequests: number, searchedPlans: number, stepChecks: number}} RoutingWorkCounters */
/** @typedef {Readonly<RoutingWorkCounters & {scenario: string, medianMs: number, outcome: unknown}>} RoutingSample */

/** @typedef {Readonly<{x: number, y: number}>} BenchmarkPosition */
/** @typedef {{routeBetweenMaps(fromMap: string, from: BenchmarkPosition, destination: string, walls: boolean, policy: Readonly<Record<string, unknown>>): unknown, routeBetweenMapsAsync(fromMap: string, from: BenchmarkPosition, destination: string, walls: boolean, policy: Readonly<Record<string, unknown>>, options?: {signal?: AbortSignal, onSlice?: (slice: {durationMs: number, schedulingDelayMs: number}) => void}): Promise<unknown>}} ResponsiveRoutePlanner */
/** @typedef {{TravelPlanner: new () => ResponsiveRoutePlanner, DEFAULT_MAP_POLICY: Readonly<Record<string, unknown>>}} ResponsiveRouteApi */
/** @typedef {Readonly<{number: number, base?: {ref?: string, repo?: {id?: number, full_name?: string}}, head?: {ref?: string, sha?: string, repo?: {id?: number, full_name?: string}}, user?: {login?: string, type?: string}, title?: string, draft?: boolean, state?: string, merged?: boolean, mergeable?: boolean | null, mergeable_state?: string, merge_commit_sha?: string | null}>} DependabotPrDto */
/** @typedef {Readonly<{repository?: {id: number, full_name: string}, head_repository?: {full_name: string}, path?: string, event?: string, status?: string, conclusion?: string, head_sha: string, pull_requests?: readonly DependabotPrDto[]}>} DependabotRunDto */
/** @typedef {{
 * (method: 'GET', path: `/repos/${string}/actions/runs/${string}/jobs?${string}`): Promise<{jobs: readonly {name: string, status: string, conclusion: string | null}[]}>;
 * (method: 'GET', path: `/repos/${string}/actions/runs/${string}`): Promise<DependabotRunDto>;
 * (method: 'GET', path: `/repos/${string}/commits/${string}/pulls?${string}`): Promise<readonly DependabotPrDto[]>;
 * (method: 'GET', path: `/repos/${string}/pulls/${number}`): Promise<DependabotPrDto>;
 * (method: 'GET', path: `/repos/${string}/commits/${string}`): Promise<{parents?: readonly {sha: string}[]}>;
 * (method: 'PUT', path: `/repos/${string}/pulls/${number}/merge`, body: {sha: string, merge_method: 'merge', commit_title?: string}): Promise<{merged: boolean, sha: string}>;
 * (method: 'POST', path: `/repos/${string}/actions/workflows/${string}/dispatches`, body: {ref: 'main'}): Promise<void>;
 * }} DependabotRequest */
/** @typedef {Readonly<{outcome: 'ignored', reason: string, runId: string | number | undefined}> | Readonly<{outcome: 'eligible', number: number, runId: string | number | undefined, headSha: string, alreadyMerged: boolean | undefined}> | Readonly<{outcome: 'release-dispatched', number: number, runId: string | number | undefined, headSha: string, mergeSha: SourceCommitSha}>} DependabotOutcome */

/** Snapshot JSON metadata without moving its ordered admission checks.
 * @param {ReleaseDto} value @returns {ReleaseDto}
 */
export function ownedReleaseDto(value) { return structuredClone(value); }

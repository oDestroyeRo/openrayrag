import { filter } from "effect/Array";
import { sourceCommitSha, gitTagObjectSha, firstParentCount as sourceCount } from "../shared/tooling-domain-values.mjs";
// Reconstruct a published plan from anonymous Git and the selected source's
// own locked validators. A later main or reservation does not invalidate it.
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { REPOSITORY, privateEnvironment, requireValue, runReadOnly, bunInstallCommand } from "./release-public-io.mjs";

const SOURCE_ENTRY_NAMES = [
  "release-core.mjs", "release-native.py", "semantic-release-plan.mjs",
  "release-reservations.mjs", "release-planning.mjs", "release.mjs",
];
const SOURCE_ROOT_FILES = [
  "release.config.mjs", "release-policy-history.json", "release-migration.json",
  "tools/release/package.json",
];

// Detect only the two supported immutable layouts. A mixed layout is ambiguous
// and must never silently load validators from a different source generation.
/** @param {import("../shared/tooling-domain-values.mjs").SourceCommitSha} sourceSha @param {import("../shared/tooling-domain-values.mjs").AnonymousGit} git */
export function sourceScriptDirectory(sourceSha, git) {
  const cores = ["scripts/release-core.mjs", "scripts/release/release-core.mjs"];
  const files = git(["ls-tree", "--name-only", sourceSha, "--", ...cores])
    .toString("utf8").trim().split("\n").filter(Boolean);
  requireValue(files.length === 1 && cores.includes(files[0]), "Unsupported or ambiguous source validator layout.");
  return files[0] === cores[0] ? "scripts" : "scripts/release";
}

/** @param {import("../shared/tooling-domain-values.mjs").SourceCommitSha} sourceSha @param {import("../shared/tooling-domain-values.mjs").AnonymousGit} git */
export function sourceDependencyFiles(sourceSha, git) {
  const files = git(["ls-tree", "--name-only", sourceSha, "--",
    "tools/release/bun.lock", "tools/release/bunfig.toml",
    "tools/release/package-lock.json", "tools/release/.npmrc",
  ]).toString("utf8").trim().split("\n").filter(Boolean);
  const allowed = new Set(["tools/release/bun.lock", "tools/release/bunfig.toml",
    "tools/release/package-lock.json", "tools/release/.npmrc"]);
  requireValue(files.every(name => allowed.has(name)) && new Set(files).size === files.length,
    "Unexpected source dependency files.");
  requireValue(files.includes("tools/release/bun.lock") || files.includes("tools/release/package-lock.json"),
    "Selected source has no supported dependency lock.");
  return files;
}

// Older releases contain the original inline validators. New sources carry
// extracted modules; discover only this allowlist at the selected immutable SHA.
const SPLIT_SOURCE_NAMES = [
  "release-policy.mjs", "release-publication.mjs", "release-source-policy.mjs",
  "release-reservation-policy.mjs", "release_policy.py", "semantic-release-policy.mjs",
];
/** @param {import("../shared/tooling-domain-values.mjs").SourceCommitSha} sourceSha @param {import("../shared/tooling-domain-values.mjs").AnonymousGit} git */
export function sourceModuleFiles(sourceSha, git, scriptDirectory = "scripts/release") {
  const allowed = [...SPLIT_SOURCE_NAMES.map(name => `${scriptDirectory}/${name}`),
    scriptDirectory === "scripts" ? "scripts/tooling-domain-values.mjs" : "scripts/shared/tooling-domain-values.mjs"];
  const files = git(["ls-tree", "--name-only", sourceSha, "--", ...allowed])
    .toString("utf8").trim().split("\n").filter(Boolean);
  requireValue(files.every(name => allowed.includes(name)) && new Set(files).size === files.length,
    "Unexpected source validator modules.");
  return files;
}

/** @param {import("../shared/tooling-domain-values.mjs").PublicMetadataApi} api @param {import("../shared/tooling-domain-values.mjs").ReleaseTag} tag @param {boolean} [fresh] @returns {Promise<import("../shared/tooling-domain-values.mjs").SourceCommitSha>} */
export async function peelTag(api, tag, fresh = false) {
  let object = (await api(`/git/ref/tags/${tag}`, { fresh })).object;
  const seen = new Set();
  while (object?.type === "tag") {
    requireValue(/^[a-f0-9]{40}$/.test(object.sha) && !seen.has(object.sha) && seen.size < 10, "Cyclic, invalid or excessive annotated tag depth.");
    seen.add(object.sha);
    object = (await api(`/git/tags/${object.sha}`, { fresh })).object;
  }
  requireValue(object?.type === "commit" && /^[a-f0-9]{40}$/.test(object.sha), "Release tag does not peel to a commit.");
  return sourceCommitSha(object.sha);
}

/** @param {import("../shared/tooling-domain-values.mjs").AnonymousGit} git @param {import("../shared/tooling-domain-values.mjs").SourceCommitSha} base @param {import("../shared/tooling-domain-values.mjs").SourceCommitSha} source @returns {readonly import("../shared/tooling-domain-values.mjs").CommitDto[]} */
export function commitsBetween(git, base, source) {
  const output = git(["log", "--format=%H%x00%B%x00", `${base}..${source}`]).toString("utf8");
  const fields = output.split("\0");
  requireValue(fields.at(-1)?.trim() === "" && fields.length % 2 === 1, "Unexpected anonymous Git commit range.");
  return Array.from({ length: (fields.length - 1) / 2 }, (_, i) => ({
    hash: fields[2 * i].trim(), message: fields[2 * i + 1].trimEnd(),
  }));
}

/** @param {string} folder @param {import("../shared/tooling-domain-values.mjs").SourceCommitSha} sourceSha @param {import("../shared/tooling-domain-values.mjs").AnonymousGit} git @returns {Promise<import("../shared/tooling-domain-values.mjs").SourceValidators>} */
export async function loadSourceValidators(folder, sourceSha, git) {
  const scriptDirectory = sourceScriptDirectory(sourceSha, git);
  const dependencyFiles = sourceDependencyFiles(sourceSha, git);
  const sourceFiles = [...SOURCE_ENTRY_NAMES.map(name => `${scriptDirectory}/${name}`), ...SOURCE_ROOT_FILES];
  for (const name of [...sourceFiles, ...sourceModuleFiles(sourceSha, git, scriptDirectory), ...dependencyFiles]) {
    const destination = join(folder, name);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, git(["show", `${sourceSha}:${name}`]), { flag: "wx", mode: 0o600 });
  }
  const directory = join(folder, "tools/release");
  if (!dependencyFiles.includes("tools/release/bunfig.toml"))
    await writeFile(join(directory, "bunfig.toml"), "[install]\npeer = false\n", { flag: "wx", mode: 0o600 });
  const manifest = JSON.parse(await readFile(join(directory, "package.json"), "utf8"));
  const compositionLibraries = [["effect", "Effect"], ["remeda", "Remeda"]]
    .filter(([name]) => manifest.devDependencies?.[name] !== undefined);
  for (const [name, label] of compositionLibraries)
    requireValue(typeof manifest.devDependencies[name] === "string" && /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(manifest.devDependencies[name]),
      `Selected source must pin an exact ${label} version.`);
  const options = { cwd: directory, env: privateEnvironment(dirname(folder)) };
  if (!dependencyFiles.includes("tools/release/bun.lock")) {
    const migration = bunInstallCommand(true);
    runReadOnly(migration.file, migration.args, options);
  }
  const install = bunInstallCommand();
  runReadOnly(install.file, install.args, options);
  // Provision the selected source's pure library from its own frozen tools
  // install. Older sources retain Remeda; current policies use Effect. App
  // packages and lifecycle hooks remain outside this reconstruction.
  for (const [name, label] of compositionLibraries) {
    const installed = JSON.parse(await readFile(join(directory, `node_modules/${name}/package.json`), "utf8"));
    requireValue(installed.version === manifest.devDependencies[name], `Installed source ${label} differs from its pin.`);
  }
  if (compositionLibraries.length) {
    await symlink(resolve(directory, "node_modules"), join(folder, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
  }
  const [core, planner, reservations, tags] = await Promise.all([
    "release-core", "semantic-release-plan", "release-reservations", "release",
  ].map(name => import(pathToFileURL(join(folder, `${scriptDirectory}/${name}.mjs`)).href)));
  return { core, planner, reservations, tags, scriptDirectory };
}

/** @param {import("../shared/tooling-domain-values.mjs").PublicOptions} options @param {import("../shared/tooling-domain-values.mjs").SourceVerificationIo} io */
export async function verifySource(options, io) {
  const { api, folder, write } = io;
  const sourceFolder = join(folder, "source");
  await mkdir(sourceFolder, { mode: 0o700 });
  const environment = privateEnvironment(folder);
  const git = io.git ?? ((args) => runReadOnly("git", ["-c", "credential.helper=", "-C", sourceFolder, ...args], { env: environment }));
  /** @param {readonly string[]} args */
  const text = args => git(args).toString("utf8").trim();
  const main = await api("/git/ref/heads/main");
  requireValue(main.object?.type === "commit" && /^[a-f0-9]{40}$/.test(main.object.sha), "Invalid main source identity.");
  git(["init", "--quiet"]);
  git(["fetch", "--quiet", "--no-tags", `https://github.com/${REPOSITORY}.git`, "refs/heads/main"]);
  const mainSha = text(["rev-parse", "FETCH_HEAD"]);
  requireValue(mainSha === main.object.sha, "Main moved between API readback and anonymous Git fetch; rerun verification.");
  const allHistory = text(["rev-list", "--first-parent", "--reverse", mainSha]).split("\n");
  const firstParentCount = allHistory.indexOf(options.sourceSha) + 1;
  requireValue(firstParentCount > 0, "Expected source is outside main first-parent history.");
  const history = allHistory.slice(0, firstParentCount);
  const modules = await (io.loadValidators ?? loadSourceValidators)(sourceFolder, options.sourceSha, git);
  const { core, planner, reservations, tags } = modules;
  requireValue(core.REPOSITORY === REPOSITORY, "Exact source uses a different repository.");
  const config = JSON.parse(git(["show", `${options.sourceSha}:src-tauri/tauri.conf.json`]).toString("utf8"));
  requireValue(config.plugins?.updater?.requireSignedVersion === true &&
    JSON.stringify(config.plugins.updater.endpoints) === JSON.stringify([core.ENDPOINT]) &&
    config.bundle?.createUpdaterArtifacts === true, "Committed updater contract differs.");
  const pubDate = new Date(text(["show", "-s", "--format=%cI", options.sourceSha])).toISOString();

  const refs = await api("/git/matching-refs/tags/rayrag-release-plan/");
  requireValue(Array.isArray(refs) && refs.length <= reservations.MAX_RESERVATIONS, "Invalid or oversized reservation ref list.");
  git(["fetch", "--quiet", "--no-tags", `https://github.com/${REPOSITORY}.git`, "refs/tags/rayrag-release-plan/*:refs/tags/rayrag-release-plan/*"]);
  /** @type {import("../shared/tooling-domain-values.mjs").ReservationRefDto[]} */
  const prefix = [];
  /** @type {Map<import("../shared/tooling-domain-values.mjs").GitTagObjectSha, import("../shared/tooling-domain-values.mjs").TagObjectDto>} */
  const objects = new Map();
  const names = new Set();
  for (const ref of refs) {
    requireValue(typeof ref.ref === "string" && ref.ref.startsWith(reservations.PLAN_REF_PREFIX) &&
      !names.has(ref.ref) && ref.object?.type === "tag" && /^[a-f0-9]{40}$/.test(ref.object.sha), "Malformed or duplicate reservation ref.");
    names.add(ref.ref);
    const tag = tags.readLocalTagObject(sourceFolder, gitTagObjectSha(ref.object.sha));
    requireValue(tag !== null && tag.sha === ref.object.sha && tag.tag === ref.ref.slice("refs/tags/".length) && tag.object?.type === "commit", "Anonymous reservation object differs from metadata.");
    const index = allHistory.indexOf(tag.object.sha);
    requireValue(index >= 0, "Reservation source is outside main first-parent history.");
    // Newer plans can use a newer policy. Only the selected historical prefix
    // is claimed to be validated by this source's policy and tools.
    if (index < firstParentCount) {
      prefix.push(structuredClone(ref));
      objects.set(gitTagObjectSha(ref.object.sha), tag);
    }
  }
  const ledger = await reservations.readReservations({ history, bridge: core.migrationBridge, api: {
    planRefs: async () => prefix, tagObject: async sha => objects.get(sha) ?? null,
  } });
  const selected = ledger.findIndex(plan => plan.tag === options.tag);
  requireValue(selected === ledger.length - 1 && selected >= 0, "Selected release reservation is missing or outside its historical prefix.");
  const plan = ledger[selected], predecessor = ledger[selected - 1] ?? null;
  planner.validatePlan(plan);
  requireValue(plan.sourceSha === options.sourceSha && plan.firstParentCount === firstParentCount &&
    plan.version === options.tag.slice(1) && plan.pubDate === pubDate, "Selected reservation source/version differs.");
  const notesBase = plan.notesBase;
  const published = await api(`/releases/tags/${notesBase.tag}`);
  const baseMarker = core.releaseMetadata(published);
  const baseCount = history.indexOf(notesBase.sourceSha) + 1;
  requireValue(!published.draft && baseMarker.sourceSha === notesBase.sourceSha &&
    baseMarker.version === notesBase.version && baseCount > 0 && baseCount < firstParentCount &&
    (baseMarker.schemaVersion === 3 ? baseMarker.firstParentCount === baseCount : core.countOf(baseMarker.version) === baseCount), "Notes base differs from a published predecessor.");
  if (baseMarker.schemaVersion === 3) {
    const basePlan = ledger.find(item => item.sourceSha === notesBase.sourceSha);
    requireValue(basePlan && planner.planSha256(basePlan) === baseMarker.planSha256, "Published notes base differs from its reservation.");
  }
  requireValue(await peelTag(api, notesBase.tag) === notesBase.sourceSha, "Published notes-base tag targets a different source.");
  const recomputed = await planner.planRelease({
    source: { sourceSha: options.sourceSha, firstParentCount, pubDate },
    published: notesBase, reservation: predecessor,
    analysisCommits: commitsBetween(git, plan.analysisBase.sourceSha, options.sourceSha),
    notesCommits: commitsBetween(git, notesBase.sourceSha, options.sourceSha),
  });
  requireValue(recomputed.state === "release" && planner.serializePlan(recomputed.plan) === planner.serializePlan(plan), "Reserved plan differs from regenerated exact Git ranges.");
  const selectedRef = prefix.find(ref => ref.ref === reservations.planRefName(plan));
  requireValue(selectedRef, "Selected release reservation is missing or outside its historical prefix.");
  const selectedObject = objects.get(gitTagObjectSha(selectedRef.object.sha));
  requireValue(selectedObject, "Anonymous reservation object differs from metadata.");
  await write("release-plan.json", planner.serializePlan(plan));
  await write("reservation-ledger.json", JSON.stringify(ledger, null, 2) + "\n");
  await write("reservation-refs.json", JSON.stringify(prefix, null, 2) + "\n");
  await write("release-reservation.json", selectedObject.message);
  await write("reservation-tag-object.txt", git(["cat-file", "tag", selectedRef.object.sha]));
  return {
    ...modules, config, sourceFolder, plan,
    identity: { version: plan.version, tag: plan.tag, sourceSha: options.sourceSha, pubDate, firstParentCount: sourceCount(firstParentCount), releasePlan: plan },
    proof: {
      mainShaAtFetch: mainSha, sourceIsMainAncestor: true, firstParentCount,
      historicalReservationCount: ledger.length, newerReservationsNotPolicyValidated: refs.length - prefix.length,
      planRefName: selectedRef.ref, planTagObjectSha: selectedRef.object.sha,
      planSha256: planner.planSha256(plan), predecessorPlanSha256: plan.predecessorPlanSha256,
      analysisBase: plan.analysisBase, notesBase: plan.notesBase,
      policySha256: plan.policySha256, independentlyRegenerated: true,
    },
    async confirmReservations() {
      const current = await api("/git/matching-refs/tags/rayrag-release-plan/", { fresh: true });
      requireValue(Array.isArray(current), "Final reservation ref list is invalid.");
      for (const ref of prefix) {
        const matches = filter(current, item => item.ref === ref.ref);
        requireValue(matches.length === 1 && matches[0].object?.type === "tag" && matches[0].object.sha === ref.object.sha, "Historical reservation changed during verification.");
      }
    },
  };
}

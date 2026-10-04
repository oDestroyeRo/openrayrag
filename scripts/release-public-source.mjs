// Reconstruct a published plan from anonymous Git and the selected source's
// own locked validators. A later main or reservation does not invalidate it.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { REPOSITORY, privateEnvironment, requireValue, runReadOnly } from "./release-public-io.mjs";

const SOURCE_FILES = [
  "scripts/release-core.mjs", "scripts/release-native.py",
  "scripts/semantic-release-plan.mjs", "scripts/release-reservations.mjs",
  "scripts/release-planning.mjs", "scripts/release.mjs",
  "release.config.mjs", "release-policy-history.json", "release-migration.json",
  "tools/release/package.json", "tools/release/package-lock.json", "tools/release/.npmrc",
];

export async function peelTag(api, tag, fresh = false) {
  let object = (await api(`/git/ref/tags/${tag}`, { fresh })).object;
  const seen = new Set();
  while (object?.type === "tag") {
    requireValue(/^[a-f0-9]{40}$/.test(object.sha) && !seen.has(object.sha) && seen.size < 10, "Cyclic, invalid or excessive annotated tag depth.");
    seen.add(object.sha);
    object = (await api(`/git/tags/${object.sha}`, { fresh })).object;
  }
  requireValue(object?.type === "commit" && /^[a-f0-9]{40}$/.test(object.sha), "Release tag does not peel to a commit.");
  return object.sha;
}

export function commitsBetween(git, base, source) {
  const output = git(["log", "--format=%H%x00%B%x00", `${base}..${source}`]).toString("utf8");
  const fields = output.split("\0");
  requireValue(fields.at(-1).trim() === "" && fields.length % 2 === 1, "Unexpected anonymous Git commit range.");
  return Array.from({ length: (fields.length - 1) / 2 }, (_, i) => ({
    hash: fields[2 * i].trim(), message: fields[2 * i + 1].trimEnd(),
  }));
}

export async function loadSourceValidators(folder, sourceSha, git) {
  for (const name of SOURCE_FILES) {
    const destination = join(folder, name);
    await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
    await writeFile(destination, git(["show", `${sourceSha}:${name}`]), { flag: "wx", mode: 0o600 });
  }
  // Windows npm is a command shim. Keep its shell text constant rather than
  // interpolating paths or release inputs into a shell command.
  runReadOnly(process.platform === "win32" ? "cmd.exe" : "npm",
    process.platform === "win32" ? ["/d", "/s", "/c", "npm ci --ignore-scripts --no-audit --no-fund"] : ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], {
    cwd: join(folder, "tools/release"), env: privateEnvironment(dirname(folder)),
  });
  const [core, planner, reservations, tags] = await Promise.all([
    "release-core", "semantic-release-plan", "release-reservations", "release",
  ].map(name => import(pathToFileURL(join(folder, `scripts/${name}.mjs`)).href)));
  return { core, planner, reservations, tags };
}

export async function verifySource(options, io) {
  const { api, folder, write } = io;
  const sourceFolder = join(folder, "source");
  await mkdir(sourceFolder, { mode: 0o700 });
  const environment = privateEnvironment(folder);
  const git = io.git ?? ((args) => runReadOnly("git", ["-c", "credential.helper=", "-C", sourceFolder, ...args], { env: environment }));
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
  const prefix = [], objects = new Map(), names = new Set();
  for (const ref of refs) {
    requireValue(typeof ref.ref === "string" && ref.ref.startsWith(reservations.PLAN_REF_PREFIX) &&
      !names.has(ref.ref) && ref.object?.type === "tag" && /^[a-f0-9]{40}$/.test(ref.object.sha), "Malformed or duplicate reservation ref.");
    names.add(ref.ref);
    const tag = tags.readLocalTagObject(sourceFolder, ref.object.sha);
    requireValue(tag?.sha === ref.object.sha && tag.tag === ref.ref.slice("refs/tags/".length) && tag.object?.type === "commit", "Anonymous reservation object differs from metadata.");
    const index = allHistory.indexOf(tag.object.sha);
    requireValue(index >= 0, "Reservation source is outside main first-parent history.");
    // Newer plans can use a newer policy. Only the selected historical prefix
    // is claimed to be validated by this source's policy and tools.
    if (index < firstParentCount) {
      prefix.push(structuredClone(ref));
      objects.set(ref.object.sha, tag);
    }
  }
  const ledger = await reservations.readReservations({ history, bridge: core.migrationBridge, api: {
    planRefs: async () => prefix, tagObject: async sha => objects.get(sha),
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
  await write("release-plan.json", planner.serializePlan(plan));
  await write("reservation-ledger.json", JSON.stringify(ledger, null, 2) + "\n");
  await write("reservation-refs.json", JSON.stringify(prefix, null, 2) + "\n");
  await write("release-reservation.json", objects.get(selectedRef.object.sha).message);
  await write("reservation-tag-object.txt", git(["cat-file", "tag", selectedRef.object.sha]));
  return {
    ...modules, config, sourceFolder, plan,
    identity: { version: plan.version, tag: plan.tag, sourceSha: options.sourceSha, pubDate, firstParentCount, releasePlan: plan },
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
        const matches = current.filter(item => item.ref === ref.ref);
        requireValue(matches.length === 1 && matches[0].object?.type === "tag" && matches[0].object.sha === ref.object.sha, "Historical reservation changed during verification.");
      }
    },
  };
}

import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const compiler = join(
  dirname(createRequire(import.meta.url).resolve("typescript/package.json")),
  "bin/tsc",
);
const configuration = join(root, "tsconfig.release.json");

function compile(project) {
  const result = spawnSync(
    process.execPath,
    [compiler, "--project", project, "--pretty", "false"],
    { cwd: root, encoding: "utf8", timeout: 30_000, maxBuffer: 1024 * 1024 },
  );
  assert.equal(result.error, undefined);
  assert.equal(result.signal, null);
  return { status: result.status, output: result.stdout + result.stderr };
}

async function compileMutation(mutate) {
  const folder = await mkdtemp(join(tmpdir(), "rayrag-release-typecheck-"));
  try {
    await mkdir(join(folder, "scripts"));
    const source = await readFile(join(root, "scripts/release.mjs"), "utf8");
    const changed = mutate(source);
    assert.notEqual(changed, source, "The fixture must mutate production code.");
    const entrypoint = join(folder, "scripts/release.mjs");
    await writeFile(entrypoint, changed);
    const project = join(folder, "tsconfig.json");
    await writeFile(
      project,
      JSON.stringify({
        extends: configuration,
        compilerOptions: {
          // Resolve the unchanged production dependencies beside this overlay.
          rootDirs: [folder, root],
          typeRoots: [join(root, "node_modules/@types")],
        },
        files: [entrypoint],
      }),
    );
    return compile(project);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

test("release entrypoint and its production dependency graph type-check", () => {
  const result = compile(configuration);
  assert.equal(result.status, 0, result.output);
});

test("compiler rejects the original string argument to reservation slice", async () => {
  const result = await compileMutation((source) =>
    source.replace(
      'PLAN_REF_PREFIX.slice("refs/".length)',
      'PLAN_REF_PREFIX.slice("refs/")',
    ),
  );
  assert.notEqual(result.status, 0);
  assert.match(
    result.output,
    /scripts[/\\]release\.mjs\(\d+,\d+\): error TS2345: Argument of type 'string' is not assignable to parameter of type 'number'/,
  );
  assert.equal((result.output.match(/error TS/g) ?? []).length, 1, result.output);
});

test("request method, path and uploaded bytes have checked input contracts", async () => {
  const result = await compileMutation(
    (source) => `${source}
const apiTypeFixture = new GitHubReleaseApi("synthetic-token");
apiTypeFixture.request("DELETE", "releases/latest");
apiTypeFixture.request("GET", 42);
apiTypeFixture.upload(1, "bundle.zip", "invalid-byte-body");
`,
  );
  assert.notEqual(result.status, 0);
  assert.match(result.output, /Argument of type '"DELETE"'/);
  assert.match(result.output, /Argument of type 'number'.*parameter of type 'string'/);
  assert.match(result.output, /Argument of type 'string'.*parameter of type 'Buffer/);
  assert.equal((result.output.match(/error TS/g) ?? []).length, 3, result.output);
});

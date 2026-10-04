import { createHash } from "node:crypto";

// Only these pure plugins run. Artifact signing and publication stay in release.mjs.
export const RELEASE_POLICY_VERSION = 1;
export const RELEASE_ENGINE_VERSIONS = Object.freeze({
  "@semantic-release/commit-analyzer": "13.0.1",
  "@semantic-release/release-notes-generator": "14.1.1",
  "conventional-changelog-conventionalcommits": "10.4.0",
  "conventional-changelog-writer": "9.2.1",
  semver: "7.8.5",
});

const dependencyRules = ["chore", "build"].flatMap((type) =>
  ["deps", "deps-dev"].map((scope) => ({ type, scope, release: "patch" })),
);
const dependencySections = dependencyRules.map(({ type, scope }) => ({
  type,
  scope,
  section: "Dependencies",
  effect: "bump",
}));

function freeze(value) {
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === "object") freeze(child);
  }
  return Object.freeze(value);
}

export const RELEASE_POLICY = freeze({
  version: RELEASE_POLICY_VERSION,
  repository: "oDestroyeRo/openrayrag",
  engines: RELEASE_ENGINE_VERSIONS,
  notesDate: "source-utc-date",
  analyzer: {
    preset: "conventionalcommits",
    releaseRules: [
      // Breaking dependency changes must win over the ordinary patch rule.
      { breaking: true, release: "major" },
      { type: "feat", release: "minor" },
      { type: "fix", release: "patch" },
      { type: "perf", release: "patch" },
      ...dependencyRules,
      { type: "docs", release: false },
      { type: "ci", release: false },
    ],
  },
  notesGenerator: {
    preset: "conventionalcommits",
    presetConfig: {
      types: [
        { type: "feat", section: "Features", effect: "bump" },
        { type: "fix", section: "Bug Fixes", effect: "bump" },
        { type: "perf", section: "Performance Improvements", effect: "bump" },
        { type: "revert", section: "Reverts", effect: "bump" },
        ...dependencySections,
        ...["docs", "ci", "chore", "build", "style", "refactor", "test"].map(
          (type) => ({ type, effect: "hidden" }),
        ),
      ],
    },
  },
});

// Sorting every object key makes policy and reservation hashes independent of
// property insertion order. Inputs to the planner are validated before encoding.
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export const RELEASE_POLICY_SHA256 = createHash("sha256")
  .update(canonicalJson(RELEASE_POLICY) + "\n")
  .digest("hex");

export default freeze({
  branches: ["main"],
  tagFormat: "v${version}",
  plugins: [
    ["@semantic-release/commit-analyzer", RELEASE_POLICY.analyzer],
    [
      "@semantic-release/release-notes-generator",
      RELEASE_POLICY.notesGenerator,
    ],
  ],
});

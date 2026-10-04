# Release and CI review

Read this when reviewing release scripts, workflow extraction, updater feeds or CI gates. Use the diff and the complete caller/callee files; a passing unit suite alone does not establish a hosted contract.

## Boundary review

| Contract | Required evidence |
| --- | --- |
| Runtime inputs | Trace each moved toolchain/env value from its owner into the job. Caller `env` does not propagate into reusable workflows. |
| Signing | Trace allowed secret names from caller to callee, protected environment binding and the early runtime guard. Inspect presence and scope without reading secret values. |
| Authority | Check trusted repository/ref/event gates and the least permissions needed by every effect. Preserve the full release lifecycle queue. |
| Source and artifacts | Match checkout SHA, reserved plan, run/attempt names, original artifact identity and digest across builders, restoration and publication. Reruns may legitimately reuse an earlier artifact attempt. |
| Wire contracts | Compare actual HTTP method/path/body with the provider contract. Exercise nonempty and failure responses; a broad mock route can hide an invalid request. |
| Recovery and compatibility | Review skip/build/reuse/published paths, monotonic versions, retained reservations, signature checks and the frozen legacy feed. |

Record observations separately from hypotheses. Before assigning a cause, inspect the actual request or runtime input that distinguishes competing explanations. State local, hosted, public artifact and installed-app evidence separately, including unrun surfaces.

Mechanical checks belong in tooling. Run the shared verification command from `package.json`; add a failing regression when a missing boundary can be checked deterministically. Keep platform package smoke and security gates mandatory.

## Hosted monitoring

Assign one monitoring owner per workflow run. Use `npm run ci:status -- <run-id>` for a compact snapshot; use its watch mode for changed states instead of asking multiple agents to poll the same run. A completed failing job's log is available even while other jobs run; the status tool saves it privately on explicit request. Share the run ID, source SHA and changed gate or blocker.

Use authenticated read-only metadata to conserve the public API quota. Verify public assets and feeds without credentials using `npm run release:verify -- --help`. Preserve its report path and limitations; a signed download or private installer test does not prove a GUI restart or live game behavior.

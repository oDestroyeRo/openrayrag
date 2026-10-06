# Desktop releases

Every push to `main` verifies the exact triggering commit. Releasable commits then build Apple Silicon macOS, Windows x64 and Linux x64 releases. A manual run is accepted only from `main`. Pull requests run verification without signing secrets or release writes. The source versions stay at `0.1.0`; only a disposable CI checkout is stamped.

## Version and client contract

Versions and notes use the official `@semantic-release/commit-analyzer` and `@semantic-release/release-notes-generator` plugins with the Conventional Commits preset, under the committed policy in `release.config.mjs`. The plugins are pure planning tools; the existing publisher owns signing, artifacts, tags and GitHub release mutations. They run from the separate locked `tools/release` development dependency graph. The desktop and release-tool Bun locks remain separate; the semantic-release host and its npm/GitHub publisher plugins are intentionally absent.

| Commit | Release |
| --- | --- |
| Breaking change (`!` or `BREAKING CHANGE`) | major |
| `feat` | minor |
| `fix`, `perf` | patch |
| `chore(deps)`, `chore(deps-dev)`, `build(deps)`, `build(deps-dev)` | patch |
| Routine `docs`, `ci`, other nonreleasable changes | skip |

New versions are canonical stable SemVer, tagged `vX.Y.Z`. The triggering SHA's one-based position in `git rev-list --first-parent --reverse origin/main` remains a separate ordering/provenance value; it no longer determines the version. Full-history exact-event checkout and fresh main ancestry checks remain mandatory. Public tags must peel to the exact source SHA, including annotated tags. Rewritten ancestry or conflicting tags fails closed. Release POST/PATCH requests retain `target_commitish: main` after exact tag creation/readback; the peeled tag and signed provenance determine the source, rather than that API metadata.

Analysis advances from the highest valid reserved ancestor, while release notes span from the last verified published release. A failed earlier build therefore retains its version reservation and its unpublished changes remain in later notes. `release-policy-history.json` retains reviewed, hash-verified policy snapshots, so later engine or policy updates can still validate older reservations. Add the new current snapshot when updating `release.config.mjs`; keep the old snapshots. Notes and their date are fixed by the source and reserved plan, so a retry does not regenerate different release text. A same-source retry reuses its existing plan; an older unplanned source superseded by a newer reservation is skipped.

Before building, reconciliation stores a validated canonical plan and SHA256 in an annotated tag under `refs/tags/rayrag-release-plan/vX.Y.Z`, directly targeting the source commit. Plans include the predecessor plan hash, analysis/notes bases, policy hash, version and notes. Automation creates these objects/refs only and verifies them by readback; it never moves or deletes reservations. Administrative edits remain possible and are detected as conflicts. Full-ledger validation occurs in queued reconciliation; immutable annotated objects are fetched through Git, validated against their object SHA and cached there. Only a newly created object not yet fetched needs a REST object read. Downstream stages read and compare only their exact reservation, avoiding one ledger scan per build command. The first plan anchors to the independently verified compatibility bridge recorded in `release-migration.json`; reconciliation verifies its published archive and frozen feed again before reserving a version.

The configured bridge is [v0.2.66](https://github.com/oDestroyeRo/openrayrag/releases/tag/v0.2.66), source `edcd744d35b8f213d7c7eec5c54a8596ae4307fd`. Its nine anonymous public assets, signatures, platform receipts, native containers and original Actions artifact were independently verified before freezing the feed. The committed migration record retains the exact feed and SHA256; keep its immutable signed archive available for older installations.

CI stamps `package.json`, `src-tauri/Cargo.toml`, the root package in `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Bun locks contain no root version and remain byte-identical; dependency versions do not change. Installation uses `bun install --frozen-lockfile` and Cargo uses `--locked` after stamping. No version commit, push, or release-trigger loop is created.

The committed updater configuration must enable `bundle.createUpdaterArtifacts` and `plugins.updater.requireSignedVersion`, contain the public key, and use only:

```
https://github.com/oDestroyeRo/openrayrag/releases/latest/download/latest.json
```

The native updater checks the fixed `latest-semver.json` URL in the same latest-release directory first. It accepts canonical stable SemVer, including minor and major upgrades, and falls back to `latest.json` only when the primary request returns HTTP 404. Successful metadata, including an up-to-date result, never triggers fallback. Authentication errors, rate limits, server errors, interrupted or oversized responses and malformed metadata fail the check. Both feeds retain immutable versioned archive URLs and signed-version verification.

New schema-3 releases contain exactly ten assets. Existing schema-1 and schema-2 releases retain their six- and nine-asset contracts:

- `Rayrag_Companion_X.Y.Z_aarch64.app.tar.gz`: signed updater payload.
- `Rayrag_Companion_X.Y.Z_aarch64.app.tar.gz.sig`: Tauri signature text.
- `Rayrag_Companion_X.Y.Z_aarch64.dmg`: first-install bootstrap.
- `Rayrag_Companion_X.Y.Z_x64-setup.exe`: Windows NSIS installer.
- `Rayrag_Companion_X.Y.Z_amd64.deb`: Linux Debian package.
- `Rayrag_Companion_X.Y.Z_x86_64.AppImage`: Linux AppImage.
- `latest-semver.json`: current `darwin-aarch64` release, signature contents and immutable archive URL under `releases/download/vX.Y.Z/`.
- `latest.json`: the unchanged, verified final bridge manifest pointing to its immutable signed bridge archive. Dormant legacy clients install that bridge, restart, then discover the SemVer feed.
- `provenance.json`: exact source SHA, separate first-parent ordinal, version, target, application identifier, build run/attempt, artifact name, toolchain, reserved plan and payload hashes/sizes.
- `SHA256SUMS`: hashes of all other assets, including both manifests and provenance.

Schema-3 provenance binds all three platform receipts and the reserved plan to the same source and release version. Each receipt declares native build and package inspection, and records canonical installer hashes/sizes. Packaging checks the Windows application itself is AMD64 (the NSIS stub may be 32-bit), Linux ELF executables are x64 and Debian metadata matches. Windows/Linux installers remain manual downloads. The legacy feed is independently validated against the retained bridge release; it must not be rewritten to advertise a version old clients cannot accept.

Both updater feeds are capped at the installed client’s 64,000-byte metadata bound. Raw and JSON-escaped release notes each have a 48,000-byte budget. Commit subjects are limited to 1,024 bytes, other lines to 4,096 bytes and each message to 16 KiB before either official engine runs; invalid messages fail rather than truncating breaking-change information. The updater archive is capped at 128 MiB and the signature at 4,096 characters, matching the installed client. The expanded app is capped at 512 MiB and 10,000 entries. Other release assets are capped at 256 MiB each. The updater signature authenticates both archive bytes and version. Verification checks the committed public key, Tauri/minisign Ed25519 signatures, BLAKE2b prehash, and signed trusted comment. The archive and DMG each must contain the expected identifier, exact version, ARM64-only executable, and valid ad-hoc Apple code signature. Their complete app manifests must also match: paths, file bytes/sizes, permissions, and link targets. This prevents a same-version but different bootstrap app. TAR extraction rejects links, devices, duplicate/escaping paths, special permissions, and excessive sizes. The current app does not require archive symlinks; adding frameworks with links requires an explicit verifier change.

Apple code signing remains ad-hoc. Releases are not Developer ID signed or notarized, and first installation may require the user's normal macOS security approval. Tauri updater signing is a separate mandatory cryptographic check. Existing installations without updater support need one bootstrap installation.

## Trust and publication order

The `release` GitHub environment must allow deployment only from the `main` branch. Store `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as environment secrets, never repository files or repository-level secrets. Keep the encrypted private key and recovery password outside the repository; do not print them or enable shell tracing. Only the build command receives these secrets. The committed key is public.

The desktop workflow keeps the `quality`, reusable `security` and always-running `CI / required` gate. Only successful trusted main pushes/dispatches call `release-publish.yml`. That single reusable call grants a `contents: write` / `actions: read` ceiling and holds the repository-wide `rayrag-release-publication` concurrency group with `queue: max` and `cancel-in-progress: false` across the entire lifecycle:

1. `reconcile` installs the isolated tools, checks published releases/drafts and reserves or restores the exact-source plan. Draft inspection and create-only reservation need `contents: write`. No releasable change yields `skip` before any builder or publisher runs.
2. `build` and the Windows/Linux `release-platforms` matrix start in parallel only for `build`. Each downloads the same `release-plan.json` Actions artifact, stamps its disposable checkout and builds production assets. Only the macOS build command receives signing secrets.
3. `assemble` joins successful builders, downloads their payloads and the same plan, then verifies signatures, native containers, platform receipts and provenance before uploading the complete immutable bundle. A `reuse` plan restores its original artifact; a `published` plan runs no build, signing or native preparation.
4. `publish` downloads the same plan and restores/verifies the complete bundle before creating public tags/releases or uploading assets. A published exact-source release is checked as a no-op. Every CLI stage cross-checks the transport plan against its durable reservation.

The plan artifact is named `release-plan-${github.sha}-${github.run_id}-${github.run_attempt}`. It transports the reserved plan rather than allocating a new version; if it expires, a later run reconstructs it from the validated annotated tag. The callee defines its own toolchain environment and uses the caller's source SHA, run, attempt and event. Jobs retain the `release` environment and reduce permissions per job. There is no inner publication lock that could conflict with the caller's lifecycle queue. GitHub permits up to 100 pending calls and queue order is not commit order, so ancestry and version checks remain necessary. External manual publication is outside this lock.

Before publication, the publisher verifies any existing latest release, stages missing assets in a draft, downloads every asset for exact comparison, verifies the complete bundle and both native containers, and reads latest again. It explicitly sets `make_latest: true` only when the candidate is newer. An older build that finishes later may publish its own version, with `make_latest: false`. The same release ID, asset set, publication state and nondecreasing latest version/source order are read back after the final PATCH, including after an ambiguous HTTP result. No API method deletes or replaces an asset or tag. Keep all automated publishers in this concurrency group; external manual publication is outside its lock.

## Reruns and recovery

A published tag with the exact source, valid signature, complete assets and matching provenance is a no-op before rebuilding. A conflicting published tag, malformed metadata, invalid latest release or incomplete published release fails closed. Never repair a published version by overwriting its files.

Each draft records the original Actions artifact ID, build run ID and ZIP SHA256 digest in its release-body provenance marker. A rerun retrieves that artifact by ID, verifies API metadata plus the downloaded ZIP digest, and accepts only the exact six (schema 1), nine (schema 2) or ten (schema 3) flat expected files. Existing draft assets must match byte-for-byte. Missing assets can then be uploaded; a lost create/upload/publish response is reconciled by readback instead of an automatic overwrite.

A fresh nondeterministic rebuild cannot fill an old draft. If the original artifact expired, has conflicting metadata, or cannot be downloaded, leave the draft unpublished. Artifacts are retained for 90 days. The operator should recover the original complete artifact from retained trusted storage, investigate the named conflict, or explicitly retire the unpublished draft/tag after confirming no client used it; the workflow never performs destructive recovery. An upload left in a non-uploaded state also stops for operator recovery rather than silently replacing it. Only the artifact bound to the existing draft can resume that draft. A reservation without a draft can build again, but must retain its reserved version and notes.

## Local checks and CI proof

Run without release credentials:

```sh
bun install --frozen-lockfile
bun run check
```

The same source-check entry point runs locally and in every native CI lane. It installs the isolated policy tools, type-checks the release entry point and its dependency graph, verifies the GLib backport, discovers script tests, builds/tests the frontend, tests and lints default/CI Rust features (including test targets), and checks formatting. Optimized GLib iterator tests run on Linux; macOS container tests run on macOS. `bun run check --plan` shows the exact platform plan without running it. Bounded diagnostic reports remain in `reports/`, including failures. Installer builds and save/reopen smoke remain separate CI lanes.

For cross-file release review and a single hosted monitoring owner, see [release review](agents/release-review.md). `bun run ci:status <run-id> --sha <source-sha> --pr <number> --watch` prints only changed status snapshots and includes merge-policy checks outside the workflow. Omit `--pr` for main runs. `--failed-log <job-id>` saves a completed failed job's log privately even when the run is still active.

Secret-free smoke builds retain verbose Tauri packaging output in `reports/package-<platform>.log`; production signing builds keep their existing output behavior. No signing inputs are admitted to diagnostic capture.

`bun run release:verify --help` describes the read-only public proof command. It launches the running Bun executable directly on every platform. For historical sources, it imports their original npm dependency lock into a temporary Bun lock inside the private proof directory, then performs a frozen install without lifecycle scripts or host peers. The original source files and published Node provenance remain unchanged. Supply explicit source SHA, tag and optional workflow identity. Its report distinguishes authenticated metadata from anonymous public downloads, source/ledger reconstruction, signature/container/Actions ZIP proof and unrun native or GUI checks. Verifying an immutable ancestor release does not require it to be current main; request the latest-feed check explicitly.

```sh
bun run release:verify --source <40-character-sha> --tag <vX.Y.Z> --run-id <id> --run-attempt <attempt> --latest
```

On Windows/Linux, explicitly pass `--skip-native` to record that macOS container inspection was not run. The verifier never launches or installs the app. Original Actions artifacts must still be available to complete byte-for-byte proof.


The release tests use synthetic in-memory signing keys and an injected fake GitHub API. They cover official commit analysis/notes, plan transport and reservation guards, out-of-order publication, reruns, missing/partial uploads, lost responses, rewritten ancestry, draft collisions, artifact expiry/digest conflicts, malformed metadata, credential-free CDN redirects, and native container mismatches. No test publishes a release or launches the app. Local unit checks do not prove a hosted build, actual artifact upload, environment secret access or GitHub publication; those require the first trusted workflow run and its source/artifact readback.

The pipeline pins Bun `1.4.2`, Rust `1.98.1` and locked Tauri CLI `2.12.1`. Rust is installed with the runner's `rustup`, avoiding an unversioned setup action. Actions use current stable release tags, rather than commit SHAs, as requested; Dependabot checks for new tags every calendar day and proposes reviewed updates. Tags can be moved by their upstream maintainers, so this policy does not provide immutable action-source pinning. Checkout still uses the exact triggering commit, credentials are not persisted, and ZIP artifact format is explicit for release restoration. Security and all native platform checks must succeed before any release job. See [desktop CI](DESKTOP_CI.md) for dependency and code security coverage.

After reconciliation, the signed macOS builder and Windows/Linux production builders run independently. macOS uploads only its archive, signature and DMG, preserving application modes inside the archive. Assembly waits for every builder, stamps its own exact-source checkout, verifies all three platforms and produces the complete release artifact. Draft recovery reuses the original signed artifact; publication never reconstructs or re-signs it. Linux package smoke flows run concurrently with separate settings/WebKit/DBus contexts and unchanged save/reopen checks.

`macos-15` remains the ARM64 hosted runner, and Ubuntu 22.04 remains the Linux package baseline. The current actionlint `1.7.12` does not recognize GitHub's documented `concurrency.queue`; lint only ignores that diagnostic, with the hosted workflow providing the definitive syntax check.

Primary references: [Tauri updater](https://v2.tauri.app/plugin/updater/), [Tauri GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/), [Apple signing](https://v2.tauri.app/distribute/sign/macos/), [GitHub release API](https://docs.github.com/en/rest/releases/releases), [workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Bun installation](https://bun.com/docs/installation), [Rust release manifest checksum](https://static.rust-lang.org/dist/channel-rust-1.98.1.toml.sha256), and [Tauri CLI signature source](https://github.com/tauri-apps/tauri/blob/30da1fd6e17de6107ecc850c95dfb16b5729f2dd/crates/tauri-cli/src/helpers/updater_signature.rs).

The opt-in `public_signed_update_chain` Rust test verifies downloaded public archive signatures and runs the full native installer on an owned temporary bundle for the old version, final bridge and semantic release. It checks code signatures, executable hashes, recovery and downgrade rejection without launching the application or reading user settings. GUI restart and running-process state remain separate proof. Its manifest contract is documented in `src-tauri/src/update_install.rs`.

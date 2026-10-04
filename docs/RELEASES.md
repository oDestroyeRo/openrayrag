# Desktop releases

Every push to `main` verifies the exact triggering commit and builds Apple Silicon macOS, Windows x64 and Linux x64 releases. A manual run is accepted only from `main`. Pull requests run verification without signing secrets or release writes. The source versions stay at `0.1.0`; only a disposable CI checkout is stamped.

## Version and client contract

`N` is the triggering SHA's one-based position in `git rev-list --first-parent --reverse origin/main`. The release is `0.2.N`, tagged `v0.2.N`. Checkout uses full history and the exact event SHA; each release stage fetches current main again and rejects a SHA outside its first-parent ancestry. A tag must peel to the exact source SHA, including annotated tags. Existing releases are checked against current ancestry, so a rewritten main or conflicting tag fails closed. After exact tag creation and readback, release POST/PATCH requests set the ignored `target_commitish` metadata to `main`; GitHub documents that it is unused when the tag exists. This avoids its separate Workflows permission requirement when an older commit differs from current main in workflow files, and normalizes reused drafts. The peeled tag and signed provenance, never this metadata field, determine the source. Older-source tag creation still requires hosted API proof; an API denial fails closed without creating a release at another commit.

CI stamps `package.json`, both root versions in `package-lock.json`, `src-tauri/Cargo.toml`, the root package in `src-tauri/Cargo.lock`, and `src-tauri/tauri.conf.json`. Dependency versions do not change. Installation uses `npm ci` and Cargo uses `--locked` after stamping. No version commit, push, or release-trigger loop is created.

The committed updater configuration must enable `bundle.createUpdaterArtifacts` and `plugins.updater.requireSignedVersion`, contain the public key, and use only:

```
https://github.com/oDestroyeRo/openrayrag/releases/latest/download/latest.json
```

New schema-2 releases contain exactly nine assets; existing schema-1 releases retain their six-asset contract:

- `Rayrag_Companion_0.2.N_aarch64.app.tar.gz`: signed updater payload.
- `Rayrag_Companion_0.2.N_aarch64.app.tar.gz.sig`: Tauri signature text.
- `Rayrag_Companion_0.2.N_aarch64.dmg`: first-install bootstrap.
- `Rayrag_Companion_0.2.N_x64-setup.exe`: Windows NSIS installer.
- `Rayrag_Companion_0.2.N_amd64.deb`: Linux Debian package.
- `Rayrag_Companion_0.2.N_x86_64.AppImage`: Linux AppImage.
- `latest.json`: `darwin-aarch64` only, with the signature contents and the immutable URL `https://github.com/oDestroyeRo/openrayrag/releases/download/v0.2.N/Rayrag_Companion_0.2.N_aarch64.app.tar.gz`.
- `provenance.json`: exact source SHA, first-parent count, version, target, application identifier, build run/attempt, artifact name, toolchain, and payload hashes/sizes.
- `SHA256SUMS`: hashes of all other assets, including the manifest and provenance.

Schema 2 provenance binds all three platform receipts to the same source SHA, release version, build run and attempt. Each receipt declares native build and package inspection, and records canonical installer hashes/sizes. Packaging checks the Windows application itself is AMD64 (the NSIS stub may be 32-bit), Linux ELF executables are x64 and Debian metadata matches. New Windows/Linux installers are manually downloaded; they are not advertised as macOS updater payloads.

The updater archive is capped at 128 MiB and the signature at 4,096 characters, matching the installed client. The expanded app is capped at 512 MiB and 10,000 entries. Other release assets are capped at 256 MiB each. The updater signature authenticates both archive bytes and version. Verification checks the committed public key, Tauri/minisign Ed25519 signatures, BLAKE2b prehash, and signed trusted comment. The archive and DMG each must contain the expected identifier, exact version, ARM64-only executable, and valid ad-hoc Apple code signature. Their complete app manifests must also match: paths, file bytes/sizes, permissions, and link targets. This prevents a same-version but different bootstrap app. TAR extraction rejects links, devices, duplicate/escaping paths, special permissions, and excessive sizes. The current app does not require archive symlinks; adding frameworks with links requires an explicit verifier change.

Apple code signing remains ad-hoc. Releases are not Developer ID signed or notarized, and first installation may require the user's normal macOS security approval. Tauri updater signing is a separate mandatory cryptographic check. Existing installations without updater support need one bootstrap installation.

## Trust and publication order

The `release` GitHub environment must allow deployment only from the `main` branch. Store `TAURI_SIGNING_PRIVATE_KEY` and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` as environment secrets, never repository files or repository-level secrets. Keep the encrypted private key and recovery password outside the repository; do not print them or enable shell tracing. Only the build command receives these secrets. The committed key is public.

The workflow has six stages:

1. `quality`: separate native macOS, Windows and Linux jobs run the complete frontend/native regressions, strict Clippy, formatting, native packaging and isolated settings-close/reopen smoke. Token access is read-only; no signing secrets are referenced.
2. `verify` (`CI / required`): runs even if a matrix lane fails or is skipped, and passes only if every lane succeeds. Main requires this check.
3. `reconcile`: a trusted main-only environment job inspects published releases and drafts. GitHub draft listing requires push access, so this read-only script receives `contents: write`. It uses paginated release listing because the tag endpoint only promises published releases.
4. `release-platforms`: trusted Windows/Linux jobs stamp the exact source/version, build production installers without smoke instrumentation, validate architecture/package contents and upload receipts with hashes.
5. `build`: a fresh CI checkout stamps and builds once, validates its assets, and uploads a complete Actions artifact. A draft rerun restores its original artifact; a verified published release skips rebuilding and signing.
6. `publish`: a main-only environment job with repository write access restores and verifies that same artifact. This is the only stage that creates tags/releases or uploads release assets. Its repository-wide concurrency group uses `queue: max` and does not cancel active jobs. The GitHub queue is bounded and its order is not commit order, so the publisher compares first-parent version counts under the lock.

Before publication, the publisher verifies any existing latest release, stages missing assets in a draft, downloads every asset for exact comparison, verifies the complete bundle and both native containers, and reads latest again. It explicitly sets `make_latest: true` only when the candidate is newer. An older build that finishes later may publish its own version, with `make_latest: false`. The same release ID, asset set, publication state and nondecreasing latest count are read back after the final PATCH, including after an ambiguous HTTP result. No API method deletes or replaces an asset or tag. Keep all automated publishers in this concurrency group; external manual publication is outside its lock.

## Reruns and recovery

A published tag with the exact source, valid signature, complete assets and matching provenance is a no-op before rebuilding. A conflicting published tag, malformed metadata, invalid latest release or incomplete published release fails closed. Never repair a published version by overwriting its files.

Each draft records the original Actions artifact ID, build run ID and ZIP SHA256 digest in its release-body provenance marker. A rerun retrieves that artifact by ID, verifies API metadata plus the downloaded ZIP digest, and accepts only the exact six (schema 1) or nine (schema 2) flat expected files. Existing draft assets must match byte-for-byte. Missing assets can then be uploaded; a lost create/upload/publish response is reconciled by readback instead of an automatic overwrite.

A fresh nondeterministic rebuild cannot fill an old draft. If the original artifact expired, has conflicting metadata, or cannot be downloaded, leave the draft unpublished. Artifacts are retained for 90 days. The operator should recover the original complete artifact from retained trusted storage, investigate the named conflict, or explicitly retire the unpublished draft/tag after confirming no client used it; the workflow never performs destructive recovery. An upload left in a non-uploaded state also stops for operator recovery rather than silently replacing it. Competing builds for the same source may complete, but only the artifact bound to the existing draft can resume that draft.

## Local checks and CI proof

Run without release credentials:

```sh
node --test scripts/*-tests.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p release_test.py
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

The release tests use synthetic in-memory signing keys and an injected fake GitHub API. They cover out-of-order publication, reruns, missing/partial uploads, lost responses, rewritten ancestry, draft collisions, artifact expiry/digest conflicts, malformed metadata, credential-free CDN redirects, and native container mismatches. No test publishes a release or launches the app. Local unit checks do not prove a hosted build, actual artifact upload, environment secret access or GitHub publication; those require the first trusted workflow run and its source/artifact readback.

The pipeline retains the tested Node `26.10.0`, Rust `1.98.1` and locked Tauri CLI `2.12.1`. Rust is installed with the runner's `rustup`, avoiding an unversioned setup action. Actions use current stable release tags, rather than commit SHAs, as requested; Dependabot checks for new tags every calendar day and proposes reviewed updates. Tags can be moved by their upstream maintainers, so this policy does not provide immutable action-source pinning. Checkout still uses the exact triggering commit, credentials are not persisted, and ZIP artifact format is explicit for release restoration. Security and all native platform checks must succeed before any release job. See [desktop CI](DESKTOP_CI.md) for dependency and code security coverage.

After reconciliation, the signed macOS builder and Windows/Linux production builders run independently. macOS uploads only its archive, signature and DMG, preserving application modes inside the archive. Assembly waits for every builder, stamps its own exact-source checkout, verifies all three platforms and produces the complete release artifact. Draft recovery reuses the original signed artifact; publication never reconstructs or re-signs it. Linux package smoke flows run concurrently with separate settings/WebKit/DBus contexts and unchanged save/reopen checks.

`macos-15` remains the ARM64 hosted runner, and Ubuntu 22.04 remains the Linux package baseline. The current actionlint `1.7.12` does not recognize GitHub's documented `concurrency.queue`; lint only ignores that diagnostic, with the hosted workflow providing the definitive syntax check.

Primary references: [Tauri updater](https://v2.tauri.app/plugin/updater/), [Tauri GitHub pipelines](https://v2.tauri.app/distribute/pipelines/github/), [Apple signing](https://v2.tauri.app/distribute/sign/macos/), [GitHub release API](https://docs.github.com/en/rest/releases/releases), [workflow concurrency](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/control-workflow-concurrency), [hosted runners](https://docs.github.com/en/actions/reference/runners/github-hosted-runners), [Node release checksums](https://nodejs.org/dist/v26.10.0/SHASUMS256.txt), [Rust release manifest checksum](https://static.rust-lang.org/dist/channel-rust-1.98.1.toml.sha256), and [Tauri CLI signature source](https://github.com/tauri-apps/tauri/blob/30da1fd6e17de6107ecc850c95dfb16b5729f2dd/crates/tauri-cli/src/helpers/updater_signature.rs).

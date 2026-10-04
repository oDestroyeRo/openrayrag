# Desktop CI

Pull requests into `main`, merge-queue candidates and main pushes run the same three native lanes. `CI / required` always executes and passes only when the whole platform matrix and reusable security workflow succeed. Main branch protection requires that check and an up-to-date pull request; force pushes and deletion are blocked. No path filter permits a change to bypass verification.

| Platform | Runner / target | Packages |
| --- | --- | --- |
| macOS | macos-15 / aarch64-apple-darwin | app and DMG |
| Windows | windows-2022 / x86_64-pc-windows-msvc | NSIS |
| Linux | ubuntu-22.04 / x86_64-unknown-linux-gnu | Debian and AppImage |

Every lane runs frontend build/type checking, the full Vitest suite, native Cargo tests, strict Clippy, Rust formatting and CI/release script regressions. macOS also exercises native container verifier fixtures. Packaging checks executable architecture, application identity/version where available, and embedded executable bytes against the built application. Reports and packages are retained as Actions artifacts.

The startup smoke uses the real packaged executable, native IPC and WebView. It edits three controls, closes before the debounce, proves the newest settings reached disk, reopens and compares all saved settings. It requires a compile-time `ci-smoke` feature, a separate application identifier, restricted capabilities, per-launch proof token and watchdog. The runner supplies a fresh temporary data directory; normal login/settings are not read. Game connection, automation and updater installation capabilities are absent, and network update checks are suppressed. Production release packages omit the feature.

Only trusted `main` jobs can reach the release environment/signing key or write releases. Windows/Linux production packages carry source/run-bound build receipts, and the macOS publisher validates and publishes one immutable nine-file bundle. Legacy six-file macOS releases remain verifiable. See [release contracts](RELEASES.md). Windows/Linux currently use manual installers; automated updates remain Apple Silicon macOS only.

A green gate proves the automated contracts and packaged startup checks. It cannot guarantee every live game action, every server/map change or every installed desktop configuration. CI deliberately has no game account credentials. Feature changes must add behavior-focused regression proof; live with-game-client and bot-only verification remains separate and is recorded in [feature verification](LOCAL_FEATURE_VERIFICATION.md).

## Native GitHub security

The reusable `security.yml` runs on every desktop PR, merge-group candidate and main push, with no path filters or inherited release secrets. It also runs every calendar day at 09:37 Bangkok time (02:37 UTC) and can be dispatched manually. CodeQL analyzes TypeScript/JavaScript, Rust, Python release scripts and GitHub Actions using the extended security query suite. Rust extraction uses the tested toolchain, Linux desktop prerequisites and freshly generated bridge; CodeQL's `none` build mode can still execute Cargo build scripts and procedural macros.

Dependency review compares PR base/head commits or merge-group base/head commits. It blocks new high/critical vulnerabilities across runtime, development and unknown scopes, including both npm and Cargo lockfiles. It needs no PR comment write access. `Security / required` rejects failed, cancelled or unexpectedly skipped applicable jobs, and `CI / required` includes that result before signing/publication. Scanner success establishes completion/upload, not an absence of findings. GitHub's separate CodeQL merge-protection ruleset blocks newly introduced high/critical security alerts and errors on `main`; the rule is activated after the first main analysis is available. Native ruleset protection does not apply to merge queue groups, although the scan execution and dependency-review checks still run there.

Dependabot checks npm `/`, Cargo `/src-tauri` and GitHub Actions `/` at 09:17 Bangkok time every calendar day. Explicit cron schedules include weekends (`daily` only means weekdays). Minor/patch version updates are grouped by ecosystem; major and security fixes remain separate PRs. All Dependabot update types automatically merge after the desktop workflow and its `CI / required` aggregate pass, including the three platform build/test/smoke lanes, CodeQL and dependency review. GitHub still enforces strict up-to-date branch protection and the native CodeQL rule; failed, stale, draft, fork and human-authored PRs do not merge.

`.github/workflows/dependabot-auto-merge.yml` runs after desktop CI completes and executes only trusted default-branch code, with no dependency PR checkout, package installation, artifacts or signing secrets. It confirms the live PR head matches the successful run, then requests a merge commit with that exact head. [Dependabot-authored squash commits can receive read-only tokens](https://docs.github.com/en/code-security/reference/code-scanning/troubleshoot-analysis-errors/resource-not-accessible) on main and fail CodeQL uploads. Because [built-in token merges suppress push workflows](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow), it explicitly dispatches the existing release workflow on current main after verifying the merge commit. Release reconciliation handles duplicate dispatches and a main branch that advances before dispatch; the dispatch does not promise to build an older merged revision. No extra token or branch-protection bypass is used.

If a merge is blocked by newer main, Dependabot must rebase and pass CI again. For an existing successful run or a failed post-merge dispatch, rerun `Dependabot auto merge` using its `workflow_dispatch` input `run_id`; it revalidates the current PR and safely retries release dispatch for an already merged commit. Use `dry_run: true` to check eligibility without writing. Existing application/toolchain pins stay reproducible until an update passes the same checks.

Repository settings enable Dependabot alerts and automatic security-fix PRs, secret scanning and secret push protection. These native features are settings outside YAML and should be checked after repository transfers or policy changes. Alerts and scan details are available in the repository's [Security tab](https://github.com/oDestroyeRo/openrayrag/security). GitHub's native scanners cover this source/dependency task, so there is no duplicate Semgrep/Trivy service or extra scan credential.

Linux verifies both package payloads before running Debian and AppImage smoke tests concurrently. Each package retains its sequential save/reopen assertions with private temporary settings, WebKit data/cache and DBus sessions. Both cleanups finish before any smoke failure is reported. Production macOS signing runs alongside Windows/Linux packaging after reconciliation; a separate assembly job joins all three builders before signature, native container and provenance verification. Publication still restores and validates the complete immutable artifact under its serialized queue. No tests, security checks or package formats are removed for speed.

Actions use full stable version tags verified against upstream releases, maintained by Dependabot. This intentionally follows the requested tag policy; tags remain mutable. Credential-free exact-commit checkout, minimal job permissions, trusted-main-only Rust cache writes, explicit ZIP artifacts, bounded timeouts and serialized publication retain the existing release boundaries. Superseded PR platform jobs are cancelled; main release runs remain independent.

Primary guidance: [Dependabot options](https://docs.github.com/en/code-security/reference/supply-chain-security/dependabot-options-reference), [dependency review action](https://github.com/actions/dependency-review-action), [CodeQL language support](https://codeql.github.com/docs/codeql-overview/supported-languages-and-frameworks/), [Rust extraction](https://docs.github.com/en/code-security/reference/code-scanning/codeql/build-options-for-compiled-languages), [merge protection](https://docs.github.com/en/code-security/concepts/code-scanning/merge-protection), [secret scanning](https://docs.github.com/en/code-security/concepts/secret-security/secret-scanning).

Local checks:

```sh
node --test scripts/*-tests.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p release_test.py
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Use the platform-specific Tauri prerequisites for local builds. Linux uses Ubuntu 22.04 as the release build baseline to limit glibc requirements; see [Tauri AppImage distribution](https://v2.tauri.app/distribute/appimage/). Windows protected local settings/login storage requires NTFS. CI packages are test artifacts, not signed automatic updates.

# Desktop CI

Pull requests into `main`, merge-queue candidates and main pushes run the same three native lanes. `CI / required` always executes and passes only when the whole matrix succeeds. Main branch protection requires that check and an up-to-date pull request; force pushes and deletion are blocked. No path filter permits a change to bypass verification.

| Platform | Runner / target | Packages |
| --- | --- | --- |
| macOS | macos-15 / aarch64-apple-darwin | app and DMG |
| Windows | windows-2022 / x86_64-pc-windows-msvc | NSIS |
| Linux | ubuntu-22.04 / x86_64-unknown-linux-gnu | Debian and AppImage |

Every lane runs frontend build/type checking, the full Vitest suite, native Cargo tests, strict Clippy, Rust formatting and CI/release script regressions. macOS also exercises native container verifier fixtures. Packaging checks executable architecture, application identity/version where available, and embedded executable bytes against the built application. Reports and packages are retained as Actions artifacts.

The startup smoke uses the real packaged executable, native IPC and WebView. It edits three controls, closes before the debounce, proves the newest settings reached disk, reopens and compares all saved settings. It requires a compile-time `ci-smoke` feature, a separate application identifier, restricted capabilities, per-launch proof token and watchdog. The runner supplies a fresh temporary data directory; normal login/settings are not read. Game connection, automation and updater installation capabilities are absent, and network update checks are suppressed. Production release packages omit the feature.

Only trusted `main` jobs can reach the release environment/signing key or write releases. Windows/Linux production packages carry source/run-bound build receipts, and the macOS publisher validates and publishes one immutable nine-file bundle. Legacy six-file macOS releases remain verifiable. See [release contracts](RELEASES.md). Windows/Linux currently use manual installers; automated updates remain Apple Silicon macOS only.

A green gate proves the automated contracts and packaged startup checks. It cannot guarantee every live game action, every server/map change or every installed desktop configuration. CI deliberately has no game account credentials. Feature changes must add behavior-focused regression proof; live with-game-client and bot-only verification remains separate and is recorded in [feature verification](LOCAL_FEATURE_VERIFICATION.md).

Local checks:

```sh
node --test scripts/*-tests.mjs
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s scripts -p release_test.py
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
```

Use the platform-specific Tauri prerequisites for local builds. Linux uses Ubuntu 22.04 as the release build baseline to limit glibc requirements; see [Tauri AppImage distribution](https://v2.tauri.app/distribute/appimage/). Windows protected local settings/login storage requires NTFS. CI packages are test artifacts, not signed automatic updates.

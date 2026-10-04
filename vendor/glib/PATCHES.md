# GLib 0.18.5 security backport

This is the complete MIT-licensed `glib` 0.18.5 crate published on crates.io,
including its original license, normalized Cargo manifest, and tests. Its version
remains **0.18.5**. `src-tauri/Cargo.toml` replaces the registry source with this
directory through `[patch.crates-io]`.
The local `.gitattributes` preserves the published file bytes on every platform.

## Source and patch

- Archive: <https://static.crates.io/crates/glib/glib-0.18.5.crate>
- Archive SHA-256: `233daaf6e83ae6a12a52055f568f9d7cf4671dabb78ff9560ab6da230ce00ee5`
- Advisory: [RUSTSEC-2024-0429](https://rustsec.org/advisories/RUSTSEC-2024-0429.html)
  / [GHSA-wrw7-89jp-8q8g](https://github.com/advisories/GHSA-wrw7-89jp-8q8g)
- Upstream fix: [gtk-rs-core PR #1343](https://github.com/gtk-rs/gtk-rs-core/pull/1343),
  commit [`b5a4071e439bef2b5eea76c3aa25e5ae84839e34`](https://github.com/gtk-rs/gtk-rs-core/commit/b5a4071e439bef2b5eea76c3aa25e5ae84839e34)
- Original `src/variant_iter.rs` SHA-256:
  `1fd02859333761c45321b32f28b24233446b97d0022a90d3a937ed162585b90e`
- Patched `src/variant_iter.rs` SHA-256:
  `a0f5ee8acb8faa089bcdfbc9a57372609fce7654026ccef7d9a224d05a654ccc`

The only changes to published files are two lines in `VariantStrIter::impl_get`:
`let p` becomes `let mut p`, and the C output argument `&p` becomes `&mut p`.
This adds eight bytes and preserves the API, crate version, and dependencies.
It fixes an immutable reference being written through by `g_variant_get_child`,
which can cause optimized builds to use a null pointer. All iterator output
methods share this implementation.

## Compatibility and maintenance

The advisory's released fix starts at GLib 0.20.0. The current Tauri Linux stack
uses GTK 0.18 / GLib 0.18, so a normal dependency update cannot select 0.20.
The backport keeps those type and dependency contracts intact.

Daily Cargo Dependabot checks remain enabled. A local path replacement may be
reported differently by dependency scanners; a changed alert state alone does
not prove the fix. Version-only advisory scanners can still flag 0.18.5. Review
new GLib advisories against this source and the documented patch, and retain
these provenance checks until the replacement is removed.

Remove the vendor directory, its `[patch.crates-io]` entry, and its CI guard once
the Tauri / GTK dependency stack can use a released GLib version that includes
this fix (currently >=0.20.0). Regenerate the app lockfile and verify Linux native
tests with the registry dependency before removing the backport.

## Verification

From the repository root, run:

```sh
python3 vendor/glib/verify.py
python3 vendor/glib/verify.py --test
```

The guard checks the archive checksum, every published file against the exact
two-line backport, and the locked Linux dependency graph's local source selection.
`--archive PATH` reuses an already downloaded archive. `--platform TARGET` changes
the dependency-graph target (default `x86_64-unknown-linux-gnu`).

`--test` additionally runs the crate's existing string iterator tests with release
optimizations and a probe covering nonempty `next`, `nth`, `next_back`,
`nth_back`, and `last`, plus mixed front/back iteration and exhaustion. It uses a
temporary copy because GLib's dev-tests cannot run as a dependency package in the
app workspace. The app lockfile seeds the temporary test resolution so its locked
runtime dependency versions are reused; missing test-only dependencies are added
there, and that test lockfile is reused for the probe.
This does not change the app's locked dependency graph or published test sources.
Native tests require Rust, pkg-config, and GLib/GObject/GIO development libraries.

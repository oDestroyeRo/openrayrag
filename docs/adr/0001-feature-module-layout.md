# Feature module layout

Status: accepted.

The flat frontend and tooling directories obscured ownership: changes to one feature required finding its logic, orchestration, UI, codec and tests among unrelated files. The project already had those owners and their responsibility contracts; the folder structure should make them easier to find together.

Frontend code lives in `src/modules/<feature>`, with tests beside the owning implementation. `src/app` contains executable entrypoints, and `src/shared` contains existing primitives used across features. Native Rust groups its existing leaves under game, session, settings, update, shell and shared modules. Tooling groups release, quality, benchmarks, catalogs and shared process/domain owners. `docs/architecture.md` describes the complete structure.

Use the domain owner to choose placement. Feature-specific UI, wire adapters and policies belong to that feature. Application composition may connect multiple features. Keep pure logic, effects and orchestration as distinct named files inside a module; do not create project-wide folders for those three roles. Preserve direct imports and private construction invariants. This decision introduces no blanket barrel exports or additional interfaces.

Shared JSON catalogs and fixtures remain in `src/data` because TypeScript, Rust and Python consume the same representations. The generated bridge output, HTML page names, Tauri commands, wire formats and persistence schemas retain their external contracts. The isolated release dependency installation remains under `tools/release`.

Source tooling must resolve files from its actual module location. Tests and architecture discovery recurse into the new folders. Historical release reconstruction and benchmark comparisons must select the paths belonging to the requested immutable source revision; a current folder name cannot be assumed to exist in older releases.

This is a reversible source organization change. Existing domain interfaces and execution order remain authoritative. A later interface refactor needs its own behavior contract and verification.

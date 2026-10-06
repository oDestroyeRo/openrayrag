# Responsive route planning

Weighted travel, weighted replanning after verified official movement or arrival, and both map-policy/NPC-service previews use `routeBetweenMapsAsync`. Initial travel and official replanning share the trip-owned planning lifecycle and claim the existing movement owner as `planning` before the first scheduled slice. Replanning retains the trip identity and original overall deadline; the retained final approach still uses its bounded collision plan. Default execution retains the synchronous crossing-first path. `TravelPlanner.routeBetweenMaps` remains the exact synchronous reference API; the async API drains the same search kernels with macrotask breaks. No Worker, extra transport, route catalog, collision relaxation or scoring change is involved.

The kernels yield inside physical map scans, portal exclusion/clearance analysis, local A*, reverse heuristic construction, world search and result copying. The runner checks an eight-millisecond budget between bounded checkpoints and caps a slice at 4,096 checkpoints even with an injected frozen clock. Map and local-search loops checkpoint every 128 cells or heap removals. JavaScript allocation, garbage collection and host scheduling can exceed the requested budget; observed maxima must be measured rather than inferred from the configured budget.

Each runtime admits at most four concurrent jobs and has no waiting queue. Each UI owns one pending preview; replacement, input changes, Stop and changed world/player snapshots abort it. Complete map/path caches keep the existing limits: 32 maps/4,000,000 analyzed cells, 128 paths/60,000 stored route cells and four accepted-walk navigators. Partial analyses and search scratch stay inside the job generator and are released on cancellation. A yielded search cannot overwrite cache accounting for an already-installed map or store an old path after that map snapshot was evicted.

Travel captures a generation, connection/world/own-incarnation identity, exact start cell, destination, movement options and detached policy. Completion validates that request again; its first movement also requires the same start cell and current own identity. A changed start needs a new plan. Expected verified portal transitions may establish the next own lifetime. Stop, removal/replacement/death, world changes and newer requests invalidate the old job. A late success or failure cannot install a route, dispatch movement or cancel another request. The existing overall trip deadline also applies while planning. Existing accepted-movement and uncertain resource-action fences remain with their original owners.

Official game-panel input preserves planning while yielding new controller decisions for two seconds. A valid computed route may install during that grace period, but Walk dispatch waits until it expires. Passive engine clocks continue through `tick(false)`. An actual official gameplay command or explicit Stop cancels planning; late completion cannot restore the canceled route. Memo/socket previews still retire on panel input under their existing ownership rules.

A successful preview grants no execution authority. Service previews additionally invalidate on inventory availability/counts, balance, Basic Mastery or visible NPC changes without treating unrelated HP changes as stale. Preview has no gameplay sender, and service/field execution independently captures and validates current state. Native status accepts `travel.state: "planning"` through the full status predicate, keeps the controller active, and retains the normal heartbeat freshness boundary.

## Reproducible proof

Run from the repository root:

```sh
bun run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
bun scripts/benchmark-map-policy.mjs ec34f05323221789cb4f438d157d0c4c2abb520d --incremental
bun scripts/test-weighted-routing-oracle.mjs
bun scripts/benchmark-responsive-routing.mjs
bun run app:build
codesign --verify --deep --strict --verbose=2 'src-tauri/target/release/bundle/macos/Rayrag Companion.app'
```

The default oracle compares all 3,004 complete results with the pre-change revision. The weighted oracle independently enumerates the world graph by hop through the unchanged 64-crossing bound, including permissions, departure-only origins, same-map fixtures, blocked cells and small/large fractional penalties. Its 4,000 cases compare optimum cost/hops and exact async cells/escapes/ties against the synchronous API. Physical collision searches are shared with that oracle; default reference comparisons and local collision fixtures provide separate evidence for those searches. The optional `--incremental` flag on `benchmark-weighted-routing.mjs <frozen-before-bundle>` also checks exact async results against an externally frozen planner.

`route-planning.test.ts` uses injected scheduler/clock boundaries to cancel during each planning phase and tests admission bounds, rejection and delayed callbacks. `travel-planning.test.ts` tests ownership before first yield, duplicate/manual/resource/service arbitration, invalidation before installation and dispatch, actor ID zero, and Stop with delayed results. `route-preview.test.ts` checks preview replacement and stale snapshots without command effects. `game-status.test.ts` uses actual controller snapshots and the production native predicate/heartbeat freshness function.

Official replanning caller tests additionally cover accepted movement settlement, map/clear and verified spawn, late success/failure after replacement, death/session invalidation, the original trip deadline, and revalidation before the first Walk. A controlled scheduler around the production planning kernel proves the official-arrival handler returns with planning ownership and a queued slice before any collision-grid reads. Completing that job produces the exact synchronous reference route and grants movement only on a later controller tick. This is scheduling/correctness proof, not a measured handler-latency or native-runtime result.

`benchmark-responsive-routing.mjs` measures cold/repeated Payon, Geffen and Prontera controls for both legacy and weighted policies. It reports total time, longest uninterrupted slice, scheduling delay, timer delay and cancellation latency, and checks complete route identity. Its ESM and Safari-targeted IIFE artifacts now run under Bun; the IIFE runs in a VM context. These are artifact measurements, not native WebKit or live gameplay results. VM totals are not a speed comparison with the browser, and yielding does not promise lower total computation time.

## Recorded artifact measurements

On 2026-10-02, the Node 26.10.0 artifact run on the reviewed `80ff691` base plus this change recorded the following maxima across all cold/repeated default and weighted controls. [Full rows](evidence/issue-46-node-artifacts.json) retain every measured case, including the VM outlier.

| Artifact runtime | Longest slice | Scheduling delay | 10 ms timer delay | Cancellation after handler |
| --- | ---: | ---: | ---: | ---: |
| ESM under Node | 9.060 ms | 2.393 ms | 9.560 ms | 0.342 ms |
| Safari-targeted IIFE under Node VM | 86.434 ms | 16.417 ms | 88.894 ms | 0.342 ms |

ESM weighted Payon took 2,717 ms cold / 2,601 ms repeated; Geffen took 1,181 / 1,041 ms. Repeated default controls completed in 1.5–1.9 ms. The VM IIFE took about 30 seconds for Payon and 12–14 seconds for Geffen; its isolated host overhead is not representative of JavaScriptCore. One repeated Payon slice reached 86.434 ms, so an eight-millisecond scheduling budget is explicitly **not** a hard runtime guarantee. This change improves opportunities for input, socket and controller processing while calculation is pending; it does not establish lower total route latency or an algorithmic speedup.

The implementation passed full local checks, app packaging and strict ARM64 ad-hoc signature verification. Independent review also interleaved four jobs across a 40-map graph, forced cache eviction, matched 150 complete routes and canceled ten jobs over 69,788 deterministic checkpoints. Native WebKit/UI proof and live gameplay are separate from these artifact results.

## Recorded native WebKit measurements

The offline Safari fixture completed all twelve cold/repeated measurements on 2026-10-02 through visible controls. [Full native evidence](evidence/issue-46-webkit.json) identifies the exact generated fixtures and retains all rows. The timing run reported a longest slice of 8 ms, scheduling delay of 9 ms and 100 ms timer delay of 11 ms. Weighted Payon took 5,181 ms cold / 4,569 ms repeated; weighted Geffen took 2,123 / 1,958 ms. Repeated legacy controls took 2–7 ms. Complex weighted routes therefore remain multi-second calculations despite the available input-processing breaks.

A separate input/Stop run recorded text input while `planning` at 217 ms and Stop at 314 ms, with cancellation and no commands. Stop-handler latency was below the page timer's reporting resolution (shown as 0 ms); that is not a zero-cost guarantee. Its longest reported slice was 8 ms, scheduling delay 13 ms and timer delay 9 ms. The later fixture revision split results into short visible rows after a single long accessibility text block was truncated; that truncation did not establish a planner stall. Both runs used the same reviewed production planner/controller. No game socket or live travel was used.

## Offline native UI proof

```sh
bun scripts/build-responsive-fixture.mjs /tmp/rayrag-responsive-fixture
```

Serve the generated directory and open `index.html` in the runtime being verified. The fixture imports the actual planner/controller and uses an in-memory sender. It opens no socket. Start a cold weighted Payon plan, edit **Input check** while the state is `planning`, and press **Stop fixture plan**. Separate short visible rows record input state, Stop latency, slice/scheduling maxima and command types. **Measure cold and repeated** displays twelve individual timing rows and a completed-count/current-case summary without starting movement. Stop also cancels the measurement run, and failed runs display the error. The `window.routePlanningFixture.state()` and `window.routePlanningMeasurements` values contain the same data; inspection through visible controls is sufficient. Record the runtime and exact source/artifact with the output.

Packaging/signature checks, synthetic controller proofs, Node artifact timings, offline native input/Stop proof and live gameplay are distinct. No live weighted travel is required by this change's responsiveness proof.

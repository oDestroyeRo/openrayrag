# Map permissions and field lock areas

The optional `automation.mapPolicy` group is portable configuration. Missing policy preserves the previous unrestricted route order: fewest reachable portal crossings, then verified walking cost. Old saved profiles remain valid and never start automation when applied.

```json
{
  "mode": "weighted",
  "allow": [],
  "deny": ["moc_fild02"],
  "penalties": [{ "map": "prt_fild05", "cost": 500 }],
  "lockArea": {
    "map": "prt_fild08",
    "minX": 120,
    "minY": 150,
    "maxX": 200,
    "maxY": 230
  }
}
```

Use **Travel & follow** to configure and preview the policy. Map lists accept comma or space separated codes; penalties are ordered rows with map names and costs. The rectangle checkbox enables its five explicit fields. Its map must equal the saved field map; a field destination, if set, must also match. Coordinates are inclusive integer cells; zero is valid. Actual bundled map dimensions bound every coordinate. A blocked rectangle is a valid configuration, but entry will wait with an explicit no-route reason.

`allow` and `deny` contain at most 256 unique known map codes each. Empty allow permits all maps except denied maps. Deny always wins, including overlap between the lists. Penalties contain at most 256 unique known map codes and finite costs from 0 through 1,000,000. Unknown fields, maps, duplicate rows and invalid coordinates are rejected in both TypeScript and native validation. Penalties never permit a forbidden map. A forbidden current map can be the initial origin of a deliberate trip to an allowed destination; it cannot be the destination or be reentered later.

`mode: "legacy"` ignores penalties and preserves the existing crossing-first objective. `mode: "weighted"` uses a separate Dijkstra search: each verified cardinal walking step costs 10, each diagonal 14, existing wall-avoidance costs are added when enabled, and each portal crossing costs 200 plus the penalty of the map being departed. The final verified escape from the destination portal also contributes to the weighted score. Legacy deliberately preserves its former omission of that terminal escape from the comparison. These are local route units, not travel-time predictions or server fees.

Weighted search retains nondominated `(score, crossings)` labels for each exact map and arrival coordinate. A cheaper arrival with many crossings cannot erase a more expensive arrival with enough crossing budget left. Lower-bound portal candidates are verified lazily. Equal-score ties prefer fewer crossings and then deterministic catalog/search insertion order. Search permits at most 64 crossings and 4,096 expanded states. An exhausted bound or lack of an allowed collision-safe route returns unavailable; it does not claim the graph is globally impossible. Same-map portals remain disabled as before. NPC transports remain separate verified service contracts rather than additions to the fixed portal graph.

An abstract reverse search at exact portal arrivals supplies the remaining-score bound. It ignores walls, corner checks and trigger exclusions, and rounds only heuristic penalties and frontier estimates down. Verified route scores and the `(score, crossings)` frontier retain the configured fractional penalties. This reduces unrelated physical searches without relaxing collision or map permissions. Weighted queries across distant maps can still take seconds in total. Execution now claims a cancelable planning owner and yields inside map analysis, heuristics and local searches; previews use the same incremental planner. The default crossing-first execution objective and its synchronous path are unchanged. See [responsive routing](RESPONSIVE_ROUTING.md) for cancellation, bounds and separate runtime proof.

The combat engine retains one field navigator, keyed by map and policy identity. The navigator masks physical walkability to the rectangle and retains visibility metadata and portal exclusions. Monsters, enemy skills, loot, follow targets and waypoints require an in-area target coordinate even when a range shortcut could otherwise avoid walking. Random searching, direct monster-click approaches, local routes and accepted server walks use the same field mask. Changing policy invalidates that owner's navigation. Unexpected server movement or corrections are stopped when they leave the verified field area.

If the character is outside, the controller uses the physical grid to find any reachable safe in-area entry cell; it does not assume the centre or nearest edge is reachable. Entry retains the existing single movement owner, exact walk acknowledgment checks, finite deadlines and occupancy-nudge limits. Field combat waits until the complete entry route and server motion settle. Low-stock/weight supply triggers also wait, so their captured return cell is inside the field area. Explicit lock-map identity survives reconnects on another map instead of silently rebinding field work there.

The finite run begins at explicit Start, before area-entry travel. Deaths during entry count against the same limit. Enabled respawn may act for the dead character outside the rectangle or on a forbidden departure map, since it cannot walk into the field. After an alive server refresh, normal permitted return and area entry are required before any field action. Boundary cancellation and Stop retain an unacknowledged explicit walk's bounded ownership fence and wait through a late accepted motion.

Service visits and supply/respawn/escape return travel capture a detached policy snapshot. Map permissions and route scores apply to every planned fixed-portal leg; only the controller's service/return/entry owner can use physical movement outside the field rectangle. A service's declared NPC map and transport arrival map must be allowed. The rectangle is restored before field work resumes. Escape can still land wherever the server chooses; an unexpected transition invalidates the current route and field work remains gated by the policy afterward. Sending Stop is not a guarantee that the server instantly cancels an in-flight movement.

**Run service** carries `{ "service": <verified definition>, "executionPolicy": <validated policy> }`. The execution policy is outside the immutable source-matched service JSON; preview reads the same configured policy. Older raw service requests retain unrestricted legacy execution. No policy or profile stores character state, actor IDs, request receipts or credentials. UI changes apply on the next Start or explicit service execution, not midway through a captured trip.

## Verification

`src/data/map-policy-cases.json` is shared by TypeScript and native tests, including coordinate zero, actual map widths, precedence, fractions and rejected unknown fields. Route tests cover restrictions, longer weighted paths, terminal escape, cycles, disconnected arrivals and the crossing-budget frontier. Engine/controller tests cover every field movement source, physical entry, supply trigger gating, services outside the rectangle, immutable trip policy, reconnect identity, Stop and late walk replies, and entry occupancy nudges.

Run `bun scripts/benchmark-map-policy.mjs <baseline-ref>` for exact complete default `TravelStep` comparisons on real routes and 3,000 seeded synthetic cases. `bun scripts/benchmark-routing.mjs <baseline-ref>` checks the existing target-routing outcomes and work counts. Timings are local planning measurements. Tests, native packaging and deployed gameplay are separate evidence; no server-side movement restriction or live policy guarantee follows from local checks.

`bun scripts/benchmark-weighted-routing.mjs <before-bundle>` compares 2,003 weighted optimum scores/crossing counts and reports cold and repeated real-map timings. The frozen before bundle must export `TravelPlanner` and `DEFAULT_MAP_POLICY`; it is a verification artifact, not a runtime dependency.

The integrated 2026-10-02 build passed 1,272 TypeScript tests, 41 Rust tests, frontend/bridge build, typechecking, Clippy, formatting and two independent integration reviews. One Keychain test remained intentionally ignored. Against `a3c5ff5`, all 3,004 default routes and all nine combat-routing benchmark outcomes, search counts and route hashes matched. Independent weighted routing review compared 4,000 cases with an eager bounded oracle. At that revision, distant weighted planning measured about two seconds for Payon and was synchronous; the later responsiveness change is documented in [responsive routing](RESPONSIVE_ROUTING.md).

Native ARM64 packaging and strict ad-hoc signature verification passed. A fresh session-only sign-in entered Field 8 at `(115,316)`. With combat and searching disabled, Start entered the inclusive `[120,310]–[128,320]` rectangle at the server-confirmed cell `(120,320)`, reported complete field entry and remained running for 58 seconds until client Stop returned Ready. HP remained 161/161, with zero attacks or pickups. The existing profile was reapplied with automation stopped. Live weighted inter-map travel, blocked-entry recovery, respawn and late-packet cases remain untested; their evidence is source and synthetic tests.

# Local feature verification

Verification separates automated local behavior, the native socket loop against a local test server, browser presentation, packaged application integrity, and actual deployed-game behavior. A passing fixture test does not establish live server acceptance.

## Current local results

### Real gameplay in both connection modes

Checked on 2026-10-03 for issue #99. Both final combat/loot runs used the local native v0.2.48 QA package; the initial respawn observation used the released v0.2.47 package.

| Proof | Result |
| --- | --- |
| Full Vitest suite | 3,244 passed across 108 files |
| Full native suite | 112 passed; one optional anonymous public probe ignored |
| TypeScript build/typecheck, Clippy, Rust formatting and scoped diff | Passed |
| Local ARM64 package and strict ad-hoc signature | Passed; native package launched for the live checks below |
| With game client, `prt_fild08` | Login and occupied slot entered; movement, 4 server-attributed defeats and 6 confirmed pickups in 91 seconds; 0 deaths |
| Bot only, `prt_fild08` | Login and occupied slot entered without the official renderer; movement, 8 server-attributed defeats and 14 confirmed pickups in 83 seconds; 0 deaths |
| Stop and explicit mode switching | Stop acknowledged and counters held in both modes. With game client position stayed stable for 20 seconds. Bot only settled three tiles of existing movement, then stayed stable over observations about 30 seconds apart. Disconnect preceded each mode switch. |
| Target selection | Native checkbox selection/deselection persisted after synchronous form refresh |
| Automatic respawn, released v0.2.47 | With game client, an initially dead character revived at the same field's savepoint and resumed sitting recovery; no new death was induced |
| Independent source review | Clear after correcting the mixed small/large-frame reserve regression |

Live testing exposed two failures: target checkbox input was overwritten by the parent form refresh before `change`, and the Bot-only initial entity burst exceeded the native event queue. Target selection now commits on `input` before that refresh. Native reads pause when capacity is low, with space reserved for Ready and terminal events; outgoing writes, Ping and cancellation continue. Regression tests failed before each correction and passed afterward, including successive batches that replace small frames with Ready acknowledgements.

Both final runs used three low-level target types, own-drop pickup, current-map search, sitting recovery and a two-death cap. No purchases, stat allocation, refining or other economic actions were tested. After testing, the app was disconnected and closed, the original connection preference was restored, and original current settings were restored with a newer persistence revision. Local packaging disabled updater artifact creation only for the QA build because the private signing key is CI-only; committed release signing remains enabled. These results concern the local package, separately from CI and published release verification.

### Run dashboard

Checked on 2026-10-03 for the selected Product Design option 2:

| Proof | Result |
| --- | --- |
| Final frontend/bridge build and TypeScript typecheck | Passed |
| Final full Vitest suite | 3,242 passed across 108 files |
| Native suite and Clippy | 108 passed; one optional public probe ignored; Clippy passed |
| Focused UI suites | 69 passed before the final pending-combat freshness regression; final full suite includes the correction |
| Browser presentation and interactions | Default 1100 by 880 and minimum 820 by 750; keyboard tabs, retained drafts, Stop/manual locks, stale observations, death cap, unresolved Warp/refine, and updater busy/finally navigation passed with blocked native/network backends |
| Local ARM64 package and strict ad-hoc signature | Passed; app not launched or installed |
| Independent source and visual review | No blocking findings after the documented corrections |

[Design QA](../design-qa.md) records the selected visual, captures, intentional data differences and live-proof limits. The UI changes retain existing bot policies and native transport. No live account or game action was attempted for this redesign.

### Clientless connection

Checked on 2026-10-03 for the clientless connection change:

| Proof | Result |
| --- | --- |
| Frontend/bridge build and TypeScript typecheck | Passed |
| Full Vitest suite | 3,233 passed across 107 files |
| Final native suite, including map-transition Stop regression | 108 passed; one public-network probe excluded from the default suite |
| Opt-in native anonymous compatibility probe | Passed both fixed public GETs; no authentication or gameplay socket |
| Clippy, Rust formatting and scoped diff checks | Passed after fixing the initial argument-count lint failure |
| Release helpers | 38 Node and 6 Python tests passed |
| Account UI browser checks | Both mode payloads, draft-only choice, Disconnect switching, connected lock and minimum 820 by 750 layout passed with a blocked mock backend |
| Local ARM64 app bundle and strict ad-hoc signature check | Passed; app not launched or installed |

The initial full `npm run check` passed its build and TypeScript/native tests but failed Clippy. The native hooks were grouped, then the affected native suite and Clippy passed. The later map-transition Stop change was checked with the final full native suite. The TypeScript source stayed unchanged.

The first local packaging command reached updater signing and failed because the private release key is CI-only. Local app packaging then passed with a temporary `bundle.createUpdaterArtifacts=false` configuration override, followed by `codesign --verify --deep --strict`. Committed release configuration and updater signing remain enabled. This proves local app integrity, not an installed update or live runtime.

## Implemented feature coverage

The full `npm run check` command runs build/typechecking, all Vitest suites, native Rust tests, and Clippy. These suites exercise the supported subsets; they do not imply complete OpenKore parity.

| Feature group | Local suites and behavior checked |
| --- | --- |
| Combat and monster selection | `engine`, `combat`, `targets`, actor identity/conditions, party engagement: acquisition, range, observed lifetimes, failed targets and conservative ownership. |
| Loot and loot-all option | `loot-engine`, `loot-ui`, `automation`, `controller`: own-kill/all-drop policy, priorities, bounded attempts and confirmed pickup counters. |
| Collision, search, routes and map changes | Navigation/movement/ranged routing, route planning, travel/controller, map policy/data: blocked cells, corners, portals, path settlement and allowed fields. Catalog checks do not mean every map was visited live. |
| Login, character selection and local profiles | TypeScript login/storage UI and Rust login/local-store tests: chosen occupied slot, credential ownership, permissions, legacy profiles and cancellation. |
| Reconnect and continuous run intent | `reconnect`, `controller`, Rust login identity/retry tests: backoff, replacement generations, retained intent, Stop and uncertainty fences. |
| Resting, escape, death and respawn return | Recovery, death/respawn controller, escape and observed threats: authoritative living arrival, return map, recovery hysteresis and exhausted death allowances. |
| Hours, run limits and Stop | Settings, automation, controller, respawn and manual target tests: finite budgets, waiting policies and late replies after cancellation. |
| Official game panels and input | Bridge input/official input tests: inventory/skill-panel interactions, takeover grace, existing official sends and action ownership. |
| Manual map walking and attacks | Manual target/controller/UI and bot-console tests: map coordinates, reachable paths, stale targets, cancellation and no implicit field-run intent. |
| Items, equipment, skills and allocation | Protocol feature, character state, automation, loadout, attack strategy/engine, skill execution and Rust control validation. Resource observations remain distinct from command receipts. |
| Cast waits and ranged retreat | Cast availability/controller, own-cast admission, retreat/engine and bridge input: supported availability observations, finite probes and retained item/SP debts. |
| Party engagement, follow and Heal | Party engagement protocol, follow/controller, Heal/integration: visible affiliation, lifetimes, rendezvous ownership, exact Heal receipts and cancellation. |
| NPC, shops, storage, cart, supply and vending | World protocol/state, workflows, NPC services/controller, disposition and supply suites: preview revisions, stock/capacity/spending bounds and canceled or uncertain transactions. |
| Chat, emotes, memo, socketing, refining and Warp | The corresponding protocol/controller/UI suites: supported wire layouts, previews, prerequisites, response ordering and no duplicate resource request after uncertainty. |
| Settings, profiles and routines | SettingsForm/current-form/profile, profiles, routines, UI and native persistence: strict schemas, round trips, restoration without starting a bot and finite automation budgets. |
| Bot console and character monitor | Bot console, shell/status and game-status tests: HP/SP/EXP/weight observations, drafts/focus, inventory actions, route/target overlays and immediate action locks. |
| Updates and releases | Maintenance, bridge input and Rust maintenance/updater/install tests; separate Node/Python release helpers: leases, cancellation, artifact bounds, signatures, source identity and publication order. |

## Clientless connection checks

The actual asynchronous native socket loop passed against a local synthetic server, covering authentication bytes, existing-character selection, initial/map Ready, Ping, cancellation, rejected or malformed input, generation replacement and send failure. Passing runtime tests retain resource uncertainty and cover frames delivered by native IPC but not yet applied when an update is requested. Account UI tests cover saved mode, legacy migration, disconnect-before-switch behavior and official-client parity.

## Live proof limits

The bounded live runs above establish current native login, occupied-slot selection, movement, basic combat and confirmed pickup in both connection modes. Automatic respawn and sitting recovery were observed with the game client; its savepoint was on the same field, so return across maps was not exercised. Bot-only death recovery, long-duration/minimized main-window liveness, other maps, real network-loss reconnect, advanced skills/ranged and party behavior, economic/social resource actions, and installed updater/restart still need separate live validation. No synthetic result should be described as a successful live transaction.

Not-implemented or unverified OpenKore families are listed in `OPENKORE_FEATURES.md`; they are not included as working features.

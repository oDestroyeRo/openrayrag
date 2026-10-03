# Local feature verification

Verification separates automated local behavior, the native socket loop against a local test server, browser presentation, packaged application integrity, and actual deployed-game behavior. A passing fixture test does not establish live server acceptance.

## Current local results

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

Historical basic native evidence covers login, selection, combat, pickup, manual respawn and resting. It is not fresh proof for every current feature. Automatic death return, real network-loss reconnect, advanced skills/ranged and party behavior, economic/social resource actions, installed updater/restart, and new clientless server acceptance need separate live validation. No synthetic result should be described as a successful live transaction.

Not-implemented or unverified OpenKore families are listed in `OPENKORE_FEATURES.md`; they are not included as working features.

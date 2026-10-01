# Rayrag Companion

A Tauri v2 macOS client for automatic sign-in, character selection, combat, looting and configurable game automation on [Ray Side Project SEA 01](https://websea01.rayrag.com/). It opens the official Unity game in a separate, ephemeral WebKit window. [OpenKore](https://github.com/openkore/openkore) supplies behavioral references; Companion uses its own TypeScript engine, interface and Rebuild protocol adapter.

## Run

Requires Node.js 22.12+ (tested on 24), Rust and Xcode command line tools. The application targets macOS 13+ and has been tested on Apple Silicon. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run app:dev
```

Build a local macOS application:

```sh
npm run app:build
```

The output is `src-tauri/target/release/bundle/macos/Rayrag Companion.app`. It uses an [ad-hoc signature](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing) for local use and is not notarized. `npm run dev` previews the controller in a browser; native game control requires the Tauri app.

The release profile leaves build dependencies unstripped to work around a macOS proc-macro loading failure in Homebrew Rust 1.98.1. Application optimization remains enabled.

## Start a run

1. Under **Account & character**, enter your account, choose an existing character slot (1–3), and select **Sign in & enter**. **Open game** also permits manual sign-in. Empty slots do not open character creation.
2. Under **Combat**, select monster types from the current map. The list combines the public spawn database with monsters observed by the game. Spawn counts are configured populations, while **in view** counts are live observations. No monster is selected automatically before the first run.
3. Check **Travel & follow** for the collision map and routing settings. Enable **Find monsters → Search the current map** if the bot should walk to find targets. Set recovery and item rules as needed, then select **Start bot**.
4. Select **Stop** to cancel the run and pending automatic sign-in. Closing the client ends its game session.

After Start, the run request remains active until **Stop** or game-window close. The status distinguishes **RUNNING**, **WAITING** and idle. Low HP, map loading, missing navigation, interrupted routes, connection loss or controller pauses put the bot into waiting/recovery; valid state lets it resume. Game input yields briefly before automatic field behavior continues. The run retains its selected monster classes when it binds to a new map; it does not automatically add new targets.

Configured hours and limits still govern actions. Outside the allowed hours, the run waits until the window opens. An exhausted session/kill/pickup allowance waits until Stop and a new run. If respawn is disabled or the death allowance is exhausted, it waits for revival. Unknown builds/maps and rejected or uncertain resource actions can require intervention; keeping run intent does not make those actions valid.

## Configure automation

The six sections keep the common Start and Stop controls available:

| Section | Controls |
| --- | --- |
| **Combat** | Selected targets, retaliation, combat off, level difference, species ignore/attack rules and priority. Ignore rules take precedence. |
| **Recovery** | HP/SP rest thresholds with separate resume thresholds, emergency HP threshold, optional respawn and death allowance. Sitting requires the game's skill prerequisites. |
| **Travel & follow** | Verified portal destination, optional return to the start map after respawn, current-map waypoints, repeat route, named-player follow and routing limits. |
| **Inventory & skills** | Own-kill or all-drop pickup policy, item filters and priority, recovery consumables with retained quantities, self/enemy skills, conditional equipment and ordered stat/skill allocation. |
| **Workflows & social** | NPC dialogue, shop buy/sell, storage/cart, item exchange, party and vending controls, bounded NPC workflows and condition routines. Daily hours and session/kill/pickup/weight limits are also configured here. |
| **Profiles & features** | Save, apply, remove, import and export named settings profiles; view the 39-family OpenKore coverage inventory. |

Recovery, consumables, skills, equipment, allocation, follow, travel, respawn, schedules and limits are opt-in. Missing inventory, SP, learned skills or other required observations prevents the corresponding action. Resource-consuming actions wait for game confirmation. A timeout is uncertain; the client does not automatically repeat that transaction.

Skill rules currently support your character and the current enemy. Enemy skill rules retain the conservative adjacent gate. Normal attacks use verified weapon range and projectile sight. The action catalog also supports explicit ground and actor targets; richer skill range, kiting, combos and automatic party support remain follow-ups. Equipment rules do not automatically restore previous gear. Allocation spends real character points according to the configured plan.

Stop field automation before using manual controls, starting an NPC workflow or running an advanced condition routine. A workflow binds its visible NPC and map, checks dialogue/options, and applies maximum spend and minimum retained stock. Conversation steps can specify an expected zeny fee. Buy/sell, storage and barter steps inspect authoritative stock and results; equipped items are protected. Workflow JSON is data, not executable code.

Condition routines use HP %, SP %, zeny, elapsed time, map and inventory quantities. Rules have priority, cooldown, maximum runs and overall duration/action budgets. **Validate / dry run** explains matching rules without sending commands. An unknown observation never matches. Routines execute only the same validated actions available to the controller; they cannot load scripts or send arbitrary packets.

Profiles contain validated settings, a map binding and optional character name. Up to 20 profiles are saved locally; applying one requires the matching map/character and never starts automation. Imports receive fresh IDs and cannot silently overwrite saved profiles. Credentials, login preferences and running state are excluded.

## Navigation, targets and loot

Companion bundles collision grids for **all 231 map scenes published by the official client**. Each uses its own dimensions and static teleport rectangles. Eight-direction A* prevents diagonal corner cutting, computes connected areas, avoids unreachable monsters and optionally penalizes paths near walls. Turning off wall avoidance never permits blocked cells.

The official map-name export also lists **`payon_p`, `2009rwc_03` and `pvp_n_1-5`**, which have no published scene assets. No shared-scene aliases were verified. The client waits for supported, safe ground on these codes and unknown maps. It does not substitute another map's grid.

The travel graph contains **1,360 directed fixed portal edges** from the pinned server source: 879 cross-map and 481 same-map edges. Conditional NPC/event portals, random arrivals and edges without usable collision data are excluded. Inter-map travel uses verified fixed portals and validates the expected arrival. It cannot promise a route through every game teleport. Farming excludes portal trigger areas; intentional travel permits only its planned portal corridor.

Target acquisition matches monster class IDs to live entity IDs. It plans a reachable firing tile within verified normal weapon range and skips targets observed being attacked by another actor. Projectile sight uses published visibility flags and the pinned server's geometry; melee retains its diagonal corner checks. A bow can attack across a visible nonwalking barrier without routing next to the monster. Along a verified clear walking corridor outside range, it sends the normal monster Attack request so the server approaches and attacks. Routes still avoid collision and portal exclusions. The combat hint shows range provenance and uncertainty; unknown weapons use a conservative one-cell fallback. Current-map exploration samples goals within the character's connected area; it is not exhaustive coverage or a guarantee that a monster will spawn. Server cooldowns, actual movement and pickup eligibility remain authoritative.

Acquisition skips route searches that cannot improve the current target's priority and distance, while preserving equal-cost ties. Unchanged route results are reused. Nearby obstructed approaches first receive a bounded reachability check, so a monster across a long wall can be rejected without searching the entire map. Collision, temporary failed cells and your approach limits still apply.

Own-kill loot is the default. It considers new drops near a confirmed defeated monster for 30 seconds. This proximity/time policy is not proof of server ownership; the server enforces loot priority. **All available drops** is an explicit broader policy. Item rules can ignore or prioritize individual IDs. The bundled catalog provides **2,579 items, 221 skills and 13 skill trees**, with source hashes and build identity.

A route is followed in straight segments, with at most one movement leg outstanding. The protocol has no movement request IDs, so changing targets waits for the accepted leg to finish. Every returned route is checked against collision and the applicable portal policy. Timed positions follow the server's accepted movement; sent walk destinations do not become confirmed positions. Temporary failed endpoints affect avoidance, never the physical grid.

The original routing controls retain these OpenKore names:

| Setting | Default | Accepted values / behavior |
| --- | --- | --- |
| `route_randomWalk` | 0 | 0: off; 2: explore the current connected map area. Inter-map travel has a separate destination control. |
| `route_step` | 10 | 1–20 steps; bends can shorten a segment. |
| `route_avoidWalls` | true | Wall-clearance penalties; physical collision remains enforced. |
| `route_randomWalk_maxRouteTime` | 75 | 1–600 seconds per search goal. |
| `attackRouteMaxPathDistance` | 20 | 1–200 path cells for an approach, separate from the scan radius. |
| `attackMaxRouteTime` | 4 | 1–60 seconds from the first pursuit walk or direct Attack request, excluding an inherited search leg; replanning preserves the same deadline. |

These follow [OpenKore's pinned config](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/control/config.txt), except opt-in random walking. The app does not import OpenKore configuration files or offer complete setting compatibility.

## Accounts and compatibility

Credentials are session-only by default. **Save in macOS Keychain** explicitly enables persistent account storage. **Sign in when app opens** restores that saved account and character slot at launch. **Forget saved login** removes the Keychain entry and its launch preference. The local controller never retrieves the saved password or writes credentials into configuration, profile exports, browser storage or logs. Leave the game's own Remember Password option off.

A successful sign-in through Companion retains the login profile only in native memory for that game session, allowing reconnection without enabling Keychain storage. A running field bot retries network loss with increasing delays and resumes the same character only after a new verified session is ready. A manually opened game without a Companion login has no session credentials to retry. The optional reconnect checkbox also permits reconnection while field combat is stopped; it does not create a run request.

Authentication rejection or an absent character requires a new explicit sign-in rather than repeated attempts. Stop cancels queued retries and automatic run resume. Closing the game clears the session profile and run request; Keychain entries remain until explicitly forgotten. An explicit sign-in starts with combat stopped unless an already requested field run is waiting for recovery. Close the current game before switching characters. Shop/storage/vending/workflow and point-spending requests with uncertain outcomes are never replayed on reconnect.

The adapter is restricted to `https://websea01.rayrag.com/`, `wss://gamesea01.rayrag.com/ws` and **`Build_2569-09-01-01-55`**. Changed or malformed supported protocols prevent commands until a valid state is available. The remote game window can report bounded status and claim or cancel an explicitly queued login; it cannot read Keychain credentials. Controller commands belong to the bundled local window. No shell or filesystem plugin is exposed to the game.

See [protocol evidence](docs/PROTOCOL.md) and the [OpenKore feature inventory](docs/OPENKORE_FEATURES.md). The inventory describes implemented portions and remaining gaps across 39 families; it does not claim full OpenKore parity. RO-specific transports, XKore/Poseidon and privileged GM/debug actions are outside this client's player-automation scope. Chat, refining/socketing, random teleport, full crafting, direct player trade, richer skill range and kiting, and third-party plugins still need implementation or a matching verified game contract.

## Verification

```sh
npm run check
cargo fmt --manifest-path src-tauri/Cargo.toml -- --check
npm run app:build
```

`check` builds the frontend and injected bridge, typechecks TypeScript, runs behavioral/protocol/login tests and Rust boundary tests, and runs Clippy. Tests use synthetic events and a public monster fixture; no unattended account test is bundled. An optional Keychain integration check creates and removes a synthetic entry:

```sh
cargo test --manifest-path src-tauri/Cargo.toml keychain_round_trip -- --ignored
```

Compare route work and local decision time against the version before the targeting optimization:

```sh
node scripts/benchmark-routing.mjs 9f7ee0e
```

The benchmark compares the engine/navigation revisions with identical deterministic fixtures and shared dependencies, excluding map setup. It checks matching outcomes and reports searches, cell checks and median local timings. Published Field 8 acquisition and synthetic wall/detour cases are separate from live game or network latency.

**2026-10-02 weapon range and visibility:** integrated checks passed 748 TypeScript tests and 25 Rust tests, build/typechecking, Clippy, formatting and two weapon-catalog regeneration tests. Native ARM64 packaging and signature verification passed. Independent combined review passed 2,400 route comparisons, 2,400 cache-copy checks and 240 target rankings; the nine routing benchmark fixtures retained their exact outcomes and search counts against `88e7878`. A fresh native sign-in displayed Cutter range 1, and a 30-second Field 8 run confirmed 3 defeats and 2 pickups before Stop returned ready. This establishes melee regression proof; live bow behavior, ammunition selection and kiting remain unverified or separate work. One Keychain test remains intentionally ignored.

**2026-10-02 routing optimization:** `npm run check` passed 721 TypeScript tests and 25 Rust tests, plus build, typechecking and Clippy. Independent review passed 8,509 exact baseline comparisons. Native ARM64 packaging and strict ad-hoc signature verification passed. A fresh session-only sign-in, character selection and saved-profile application led to a 40-second Field 8 run with 3 defeats and 4 confirmed pickups; Stop returned the app to ready. One Keychain integration test remains intentionally ignored. Search scratch retains up to 6 MiB per navigator, and reachable obstructed queries can perform extra bounded preflight work.

**2026-10-02 expanded release:** `npm run check` passed 708 TypeScript tests and 25 Rust tests, plus frontend/bridge build, typechecking and Clippy. Formatting, native ARM64 packaging and strict ad-hoc signature verification passed; one Keychain integration test remained intentionally ignored. Independent reviews covered protocol, world workflows, native credentials, controller ownership and route equivalence. Native checks confirmed session-only login/character selection, six settings sections, inventory/skill/SP telemetry, Field 7 combat and pickup, Stop, death waiting, manual respawn to Field 8 and automatic sitting recovery followed by resumed combat (2 defeats and 7 pickups in Field 8). A placeholder-SP overwrite found during this check was fixed and the corrected login displayed authoritative SP. Further source-backed fixes preserve negative support-skill delays and wait for the actual character-selection controls; three consecutive fresh native sign-ins and character selections succeeded after those corrections. The final direct-target build confirmed one Lunatic defeat and two pickups, then Stop returned idle. Network reconnect, live economy/party/vending/point spending and traversal of every map remain synthetic/source proof rather than live validation. No remote CI is configured.

Earlier native releases established the following historical evidence, not live proof of every new feature:

| Earlier validation | Established evidence |
| --- | --- |
| 2026-10-01 login | Session-only sign-in entered an existing slot; an empty slot stayed on character selection; Stop during loading cancelled the attempt. The real account was not saved. |
| 2026-10-01 combat and pickup | A bounded native run confirmed 4 defeats and 8 pickups; Stop returned idle. |
| 2026-10-01 targets and A* | Public map spawns loaded on Field 5; bounded routing/search runs confirmed combat and pickups. Movement failures and map transitions were also tested with synthetic fixtures. |
| Earlier transition/pursuit fix | 99 TypeScript tests and 3 Rust tests passed, plus Clippy/formatting. A Field 8 run confirmed 4 defeats and 9 pickups using the four-second pursuit limit. |
| 2026-10-02 all-map release | 334 TypeScript tests and 3 Rust tests passed, plus Clippy, formatting, packaging and signature verification. Independent extraction/hash review covered all 231 grids; native Field 8 combat and pickups worked. Other maps were asset/test evidence, not visits to every map. |

Implementation owners are `src/controller.ts` (single action ownership), `src/engine.ts` (field combat/search), `src/automation.ts` (rules/recovery/actions), `src/character-state.ts`, `src/world-state.ts`, `src/protocol.ts`, `src/protocol-feature.ts`, `src/world-protocol.ts`, `src/navigation.ts`, `src/movement.ts`, `src/travel.ts`, `src/travel-controller.ts`, `src/workflows.ts`, `src/routines.ts`, `src/profiles.ts`, `src/login.ts`, `src/bridge.ts` and `src-tauri` (native windows, credentials and IPC). `src-tauri/generated/game-bridge.js` is generated by the normal build; edit its TypeScript source.

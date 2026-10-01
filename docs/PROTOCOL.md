# Protocol evidence

Baseline runtime inspected 2026-10-01; expanded adapters reviewed against pinned source on 2026-10-02. The live page identifies **RO Rebuild / Unity WebGL**, protocol **V.8**, with build directory `Build_2569-09-01-01-55`. Login through the official client succeeded, and the browser opened `wss://gamesea01.rayrag.com/ws`.

The observed entity packet matches the older [Rebuild enum at 4099e2c000c3c550516760b9c1241595aac9aceb](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RebuildSharedData/Networking/PacketType.cs). Current upstream reordered its enum; do not substitute current numeric IDs.

The [OpenKore packet table](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/Network/Send/ServerType0.pm) describes a different transport. The implementation here uses the game's existing session and implements only the relevant Rebuild message fields.

| Operation | Deployed opcode | Fields used, after opcode |
| --- | ---: | --- |
| Enter | 3 | i32 character ID; u16 byte length + UTF8 map |
| MemoryPack entity | 6 | u8 event; optional toss position; i32 length; 15-member entity record |
| Walk | 7 | outgoing i16 x/y; incoming i32 ID, i16 start x/y, f32 actual x/y, f32 seconds/cell, f32 first-step seconds, u8 cell count, packed directions, move-lock bit |
| Position / stop position | 10 / 20 | i32 entity ID; i16 x/y |
| Attack | 11 | outgoing i32 target; incoming i32 source/target, 4 bytes flags, i16 x/y |
| Remove | 15 | i32 ID, u8 reason (3 = dead) |
| Clear / change map | 16 / 18 | clear world / string map |
| Stop | 19 | outgoing no payload; incoming i32 actor ID |
| Hit | 23 | i32 ID, i32 damage, i16 x/y, should-stop bit; decrements HP |
| Death / heal / revive | 36 / 37 / 46 | actor ID followed by position or health |
| Player stats | 56 | Validated full or legacy UpdatePlayerData layout; HP/SP, level/job level, zeny, attributes/points, weight, learned/granted skills, inventory/equipment |
| Minimap tracking | 60 | u16 count; i32 ID, i16 x/y, u8 kind; effect kind 8 adds a string |
| Ground drop | 81 | i32 ground ID, f32 x/y, i32 item ID, i16 count, new-drop bit |
| Pickup | 82 | outgoing i32 ground ID; incoming i32 picker and ground ID |

Integer and float fields are little-endian. Ordinary booleans occupy **one bit**, including booleans followed by other fields; subsequent values are not implicitly byte-aligned. Unused final bits can contain pooled-buffer data and are ignored, while an extra complete trailing byte is rejected. For example, the drop decoder reads the first bit at byte 19 to distinguish a new drop from an existing item entering view. MemoryPack entity strings use their own encoding: negative complemented UTF8 byte count plus UTF16 character count, or a nonnegative UTF16 character count. The entity's Position uses i32 fields, unlike packet positions.

The public Poring spawn fixture decoded as ID 1638, class 4000, position 320/153, level 1, HP 51/51. No account handshake or token is saved in fixtures. The live Enter packet had a shorter suffix than upstream's 16-byte GUID. That suffix is deliberately not interpreted or stored. This illustrates why sharing a version number does not establish complete compatibility.

## Sign-in and character selection

Companion uses the official Unity login methods; it does not construct an authentication packet. The deployed `Build Web.data`, `Build Web.symbols.json`, and WASM were inspected against the source pin. Their active scene paths and callable methods match the adapter in `src/login.ts`:

- Login window: `Canvas/Login Screen/LoginBoxWindow`, with `ChangeTabs(int)` and `AttemptLogin()`.
- TMP inputs below that window: `LoginBox/Login/Username/Title/InputField (TMP)`, `LoginBox/Login/Password/Title/InputField (TMP)`, and `LoginBox/Server Settings/Username/Title/InputField (TMP)`, each with `SetTextWithoutNotify(string)`.
- Character screen: `Canvas/Login Screen/CharacterCreator`, with `SetCharacterInfo(int)` and `ClickOk()`.

Unity factory completion precedes asynchronous asset loading and login-screen activation. WebGL `SendMessage` finds only active objects and reports failed dispatch through the console instead of throwing. A harmless nonexistent-method probe requires the exact active-object diagnostic before credentials are claimed. The server-settings tab must be activated before setting its input, then the login tab must be restored. Character selection similarly waits for its active screen.

While a requested sign-in is active, ConnectionApproved opcode `0` is read only to establish populated slots. After the opcode it contains a one-bit token flag, an optional i32 byte count and opaque token bytes, an i32 character count, then each character's u16-length UTF8 name, i32 slot, map string, and i32-length summary bytes. Fields following the bit are unaligned. Tokens are skipped; only occupied slots 0–2 are retained. Opcodes `1` and `32` end the attempt as rejected. Selecting an absent slot would otherwise open character creation, so the adapter stops before invoking `ClickOk()`.

The official client remains responsible for validation and network authentication. Each queued credential handoff is one-shot, expires after 120 seconds, and requires the fixed game window, URL and build. After confirmed successful entry, native state retains a session profile for reconnect; it is cleared on game close and is never returned to the controller. Only explicit remember opt-in writes Keychain. Stop cancels queued handoffs/retries. Credentials and authentication frames are excluded from telemetry and fixtures.

HP is reduced on HitTarget, not on visual Attack/TakeDamage packets. Tracking removal records contain negative coordinates and must not be interpreted as invalid world coordinates. Effect records are variable length. Resurrection updates authoritative health/alive state. The controller, rather than packet decoding, owns the optional respawn/return and persistent-run policy. Controller tests cover same-map revival and death budgets; native validation confirmed manual respawn from Field 7 into Field 8.

## Map-based monster choices

The official [maps.json](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/maps.json) exposes map `Code` and `Name`. [monsterdatabase.json](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/monsterdatabase.json) exposes monster `Id`, `Name`, `Level`, `HP`, and `Spawns` entries with `Map` and `Count`. The deployed exports inspected on 2026-10-01 contained 234 maps and 333 monster types. The bridge reads these fixed public URLs once per game page without credentials; failures fall back to observed monster types.

For `prt_fild05` (Prontera Field 5), the export lists Poring (70), Lunatic (30), Thief Bug Egg (20), Pupa (30), Thief Bug (10), Green Plant (6), and Blue Plant (1). Counts represent configured spawn rules, not the number currently alive or visible. Events, summons and other dynamic spawns may not be listed. The picker merges live observations and counts visible, living monster entities before the radar's 150-entity cap.

The MemoryPack entity's class ID is retained separately from the appearance override and entity ID. Selections use the class ID matching database `Id`; outgoing attack still addresses the live entity ID. The Start command carries the selected map code and up to 64 unique class IDs. Both IPC and engine validate the selection; the engine rejects a map mismatch and preserves its existing level, distance, health and engagement checks. Map metadata never supplies an attackable entity or causes an automatic start.

Sources: [entity schema](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RebuildSharedData/Packets/CreateEntityMessages.cs), [client network handling](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RebuildClient/Assets/Scripts/Network/NetworkManager.cs), [stat order](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RebuildSharedData/Enum/EntityStats/StatEnums.cs), [server attack handling](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Character/PacketAttack.cs), [server pickup handling](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Character/PacketPickUpItem.cs).

## Collision analysis, planned approach and walking

Incoming walking directions are packed high nibble first: south, southwest, west, northwest, north, northeast, east, southeast. The first remaining duration already accounts for partial or diagonal movement; later diagonal steps multiply seconds/cell by 1.4142. Actual floating positions use tile centers. A moving monster spawn appends the same walk payload; moving players first append a length-prefixed appearance block, which Companion skips without retaining it. Locked routes do not advance until replaced by an unlocked route.

Normal walking does not send a final position packet. Companion follows the accepted route using elapsed time, exposes estimated tile positions, and never moves its estimate to a requested destination before the server returns a path. StopImmediate, position corrections, stopping hits, attacks, death and removals supersede movement. Minimap tracking is a separate display-only stream and no longer overwrites world positions. Outgoing StopAction shortens a route rather than guaranteeing an instantaneous halt.

The navigation catalog `src/data/navigation-maps.json` covers all **231 scenes** in the official addressables catalog, refreshed on 2026-10-01 (catalog SHA-256 `aa3608bf7d16eb827c10e07992cbf9230f0b087bc3f1b40ba6482911ccd81aaf`). Every scene was downloaded and its walk flags extracted successfully. Each record includes exact dimensions, cell counts, source URL and SHA-256, with LSB-first flags indexed by `x + y * width`. The combined JSON is 4,112,679 bytes. `scripts/navigation-sources.json` is the reviewed inventory used by extraction and coverage tests. Native command validation and TypeScript navigation read the same generated catalog.

Dimensions range up to 416: `pay_fild02` is 304×416 and `pay_fild03` is 416×304. Navigation and status validation support dimensions up to 512. Physical walls remain blocked regardless of size. The official map-name export contains 234 codes; `2009rwc_03`, `payon_p`, and `pvp_n_1-5` have no published scene assets. Server/client map-change tracing passes raw map codes into literal scene paths; no shared-scene aliases were proved. These three entries are recorded as unavailable, not assigned another map's collision data.

The Unity serialized-file version is 23. `scripts/extract-navigation.py` reads walk flags with UnityPy 1.25.3 and never executes bundle code. Only cell types with the Walkable bit (`Type & 1`) are included, including walkable water. Reproduce the catalog in a Python environment with that dependency:

```sh
python scripts/fetch-navigation.py /path/to/bundle-cache
python scripts/build-navigation-catalog.py /path/to/bundle-cache src/data/navigation-maps.json
```

The first command downloads the pinned public assets (about 1.76 GB total), reusing existing bundles only when size and SHA-256 match. The second independently verifies hashes, dimensions, bit lengths, trailing bits, counts, and portal bounds, then replaces the catalog only after every map succeeds. Both use at most four workers. Asset changes fail checksum verification; update the reviewed inventory and portal evidence before accepting a new deployment. Gameplay does not download bundles or parse Unity assets.

The controller analyzes all cells before Start and requires a verified grid even with random walking disabled. A* plans whole routes with cardinal/diagonal costs 10/14, an octile heuristic and no corner cutting. Orthogonal distance-to-obstacle propagation, with map boundaries at distance 1, applies penalties 60/50/20/10/0 at clearance 1/2/3/4/≥5. Portal exclusions participate in clearance and connectivity but remain a separate overlay from physical walls. Connected-component prefiltering is a Rayrag adaptation, not upstream OpenKore behavior.

Selected visible targets require a reachable, clear adjacent tile within `attackRouteMaxPathDistance`. If a cheaper wall-aware path exceeds the step cap, bounded shortest-step search finds a usable capped alternative or rejects the target. Random walking mode 2 samples goals across the current component. A complete route is retained, then split into straight cardinal or 45-degree prefixes capped by `route_step` (default 10, maximum 20). The server's own pathfinder has a twenty-step limit. Every accepted route is checked against walkability and portal policy. A pending leg must finish before changing pursuit; this avoids attributing an old reply to a newer destination when the protocol has no request ID. A new pursuit clock stays unset during that inherited leg and starts immediately before its first approach walk is sent. Replans and corrections do not reset an active clock. Missing replies and locked inherited legs retain their separate failure bounds.

Missing or locked walks time out and retry with shorter steps. Corrections and interrupted walks invalidate the old leg and replan from the updated position. Safe replacement endpoints supersede the accepted leg and cause replanning toward the original goal. Failed endpoints are avoided temporarily without changing the static grid. Three consecutive failed legs end the current movement attempt; the controller decides whether to wait and resume an authorized persistent field run. Useful accepted movement completion clears the failure count. Attack approach timeouts and search goal timeouts are distinct; a server-generated pursuit after Attack is also bounded. Adjacent approach is conservative: the walk-only grid does not contain the separate flags needed to prove arbitrary ranged line of sight.

Algorithm/settings references: [OpenKore A*](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/auto/XSTools/PathFinding/algorithm.cpp), [wall clearance weights](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/auto/XSTools/misc/fastutils.xs), [route execution](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/Task/Route.pm), [settings](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/control/config.txt). This is an original TypeScript implementation; no OpenKore engine or transport is bundled.

Static teleport exclusions use **1,443 distinct inclusive rectangles across 231 maps**. The full audit resolves all 970 published [mapwarps.json](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/mapwarps.json) records against [upstream source at `72d4004`](https://github.com/Doddler/RagnarokRebuildTcp/tree/72d4004af948daa61b4d496be1080e0633b66602/RoRebuildServer/GameConfig/ServerData/Script), also comparing the protocol pin `4099e2c`. Source definitions add same-map, hidden, and fixed NPC-touch teleports omitted by the public export. The included source records comprise 1,405 Warp calls, three HiddenWarp calls, and 38 NPC touch portals before rectangle deduplication. `scripts/navigation-portals.json` owns the reviewed areas; `scripts/navigation-portal-sources.json` records source paths, lines, commits, public-export hash, and limitations. Packet decoding remains on its existing protocol pin.

Exact trigger rectangles replace the old blanket 24-cell margin. Both boundaries are inclusive. Conditional fixed triggers are excluded even while hidden or inactive, including Field 8's Okolnir entrance `(131,338)`. Field 5 excludes 479 physically walkable trigger cells; Field 8 excludes 333. Thirteen scenes have no static portal definitions in audited source and have explicit empty lists. Static source coverage is not live server introspection and cannot account for dynamically placed player Warp Portal skills or dynamic event areas.

Three source warp definitions land at `moc_fild02 (77,338)`, inside an actual destination trigger. Start remains blocked there until the character moves onto safe ground. Destination-only movement still lets the server choose a different path; a returned unsafe route is stopped. Every map transition invalidates the old movement/target state and loads navigation for the exact new map. Planned travel additionally requires its expected destination and player arrival. Persistent run intent and map rebinding belong to the controller; they do not preserve an in-flight action across maps. Reverify collision assets and portal rules when the deployed game changes.

## Entity status dictionary layout

The pinned entity schema uses `Dictionary<CharacterStatusEffect,float>`, with a byte enum key. MemoryPack 1.21.4 serializes unmanaged key/value pairs as eight bytes: one key, three padding bytes, and the float. The decoder consumes this padding and retains exact entity-size checks. A synthetic status-bearing version of the existing public monster fixture reproduced the old `Invalid entity` failure when only five bytes were consumed. Finite positive status durations include the server's permanent-effect sentinel (`float.MaxValue`); a two-hour application cap would reject valid effects such as Cloaking. The original failing runtime frame was not retained, so this is a matching source-backed reproduction rather than identification of that particular packet. See the [MemoryPack formatter](https://github.com/Cysharp/MemoryPack/blob/1.21.4/src/MemoryPack.Core/Formatters/KeyValuePairFormatter.cs) and [enum generator](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig.Generator/StatusEffectGenerator.cs).


## Expanded player state and actions

`src/protocol-feature.ts` and `src/world-protocol.ts` decode their owned messages before the controller applies either result. Unknown opcodes are ignored; malformed owned messages cannot partially update state. Full inventory/skills and later deltas are separate observations. An omitted cart field does not clear a known cart. HP/SP, zeny and other nonnegative i32 resource fields accept the complete range through `2,147,483,647`.

| Adapter | Pinned opcodes | Implemented observations/actions |
| --- | --- | --- |
| Character state | 14, 34, 39, 40, 43, 56–58, 61–62, 98 | Sit/stand, EXP, SP, zeny, targeting, full stats/skills/inventory/equipment, allocation and status changes. |
| Skills and recovery | 29–32, 41–42, 47–48, 50, 104 | Self/actor/ground skill result and impact, skill/request failure, respawn, item use, equip/unequip and inventory deltas. |
| NPC dialogue | 76–79 | Visible NPC focus, dialogue/options/end, talk/continue/zero-based option requests. Blank option labels still occupy their server index. |
| Shops and storage | 83–88 | Live shop offers, buy/sell requests, storage snapshots/transfers and NPC item exchange. |
| Cart | 89 | Bag-to-cart direction 1 and cart-to-bag direction 2. Source directions 3/4 are not productive transfer commands. |
| Party | 99–102 | Explicit create/invite/accept and roster/leader/remove/leave/disband state. |
| Vending | 105–109 | Start/stop/view stores, sales and purchase requests. Purchases need inventory and balance readback because no correlated success packet is provided. |

These opcode numbers belong to the pinned enum, not current upstream. Strict action schemas apply in TypeScript and Rust; the main native window is the command owner. Skills require verified learned/granted levels and metadata. For skills whose level is not adjustable, requested use normalizes to the server's learned maximum; Warp Portal retains its separate requested-level behavior. Skill results hold dispatch until the acknowledged motion time ends.

`src/character-state.ts` retains authoritative inventory, equipment, skills, resource values and bounded status state. `src/world-state.ts` retains NPC/shop/storage/cart/party/vending state. Map changes preserve persistent inventory/skills/cart/party where applicable, but clear map-bound NPC/store state. New character sessions and disconnects invalidate authoritative session state. Actor observations include visible players/NPCs; they do not grant authority to issue a command to a missing or unrelated actor.

Source fixtures and command encoders establish adapter behavior. They do not establish every deployed action: earlier native checks covered ordinary attack/pickup/walk and official-client login. Expanded resource and social operations still require bounded native verification before they can be reported as live-tested.

## Resource workflow ownership

`src/controller.ts` owns field automation, travel, NPC workflows, routines and manual actions. They cannot dispatch concurrently. `src/workflows.ts` binds a workflow to an observed visible NPC, current map and conversation generation. It checks option labels, optional dialogue text, live prices, equipped/protected items, retained stock and an overall spending cap before each applicable step.

Talk/continue/option steps support `expectedCost` for known NPC fees; omitted cost means zero. A fee is accounted for before progression and confirmed through zeny readback. The pinned Kafra storage dialogue is free and requires Basic Mastery level 5; cart rental charges 850 zeny at its final confirmation. A commented-out teleport charge is not an active source fee and must not be inferred.

Resource steps wait for authoritative inventory, storage/cart and currency outcomes. Vendor purchases capture the observed item/price receipt before the server closes the store and require matching item gains and balance debit. Unknown outcomes are reported without resending the transaction. Cancellation must retain the old response deadline/generation so a late reply cannot confirm a newly submitted action. These controls cannot infer which simultaneous external game operation caused an ambiguous delta.

## Bundled item, skill and travel catalogs

`src/data/game-catalog.json` contains **2,579 items, 221 skills and 13 skill trees**, generated from the official build's [items](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/items.json), [skills](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/skillinfo.json) and [class trees](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/skilltree.json). Source URLs/SHA-256 and build identity are embedded. The generator reads JSON without executing client code:

```sh
python3 scripts/build-game-catalog.py /path/to/export-directory src/data/game-catalog.json
```

The directory must contain `items.json`, `skillinfo.json` and `skilltree.json`. Metadata supplies item class/use/weight/price/equipment position and skill target/max level/SP costs/prerequisites; it is not a live inventory or proof the character learned a skill.

`src/data/travel-portals.json` contains **1,360 directed fixed edges**, including **879 cross-map** and **481 same-map** edges. Each edge is re-read at protocol pin `4099e2c` against the reviewed excluded trigger rectangles and collision grid. Only direct top-level literal Warp/HiddenWarp calls with fixed usable arrivals are included. Scripted NPC-touch/event/conditional registrations, random arrivals, missing grids and unusable cells are excluded. The broader 1,443 farming-exclusion rectangles deliberately cover more potentially unsafe trigger areas than the travel graph permits.

```sh
python3 scripts/build-travel-catalog.py scripts/navigation-portal-sources.json /path/to/pinned-source-git src/data/travel-portals.json
```

Travel waits for its expected map and nearby player spawn, validates returned movement endpoints/corridors, and leaves the arrival trigger before completing. Failed movement, ambiguous transitions or unsupported destinations do not become assumed success. Source graph coverage is not a claim that every edge exists or has been traversed on the live server.

## Persistent running and response latency

The field-run controller exposes `runRequested` separately from active `running`, with `state` equal to `running`, `waiting` or `idle`. Temporary map/loading/health/navigation/connection problems invalidate pending work and wait for valid state; Stop and window close cancel the request. Manual game input yields briefly; the run then waits for any movement/action deadline before resuming. Disabled respawn, exhausted budgets and resource uncertainty prevent dispatch while preserving the visible waiting reason. Outside allowed hours it waits for the next schedule window. Reconnect restores only the requested field run, never NPC/storage/shop/vending/workflow/allocation requests. The local controller retains validated settings and run totals across page replacement; it requires the same character, valid new session and remaining budgets before issuing Start.

Incoming game events trigger controller decisions immediately; a 100 ms fallback tick handles timers, while UI status publishes at most every 500 ms. Normal action spacing is 100 ms and own-kill loot settling is 150 ms. Reconnect starts after 5 seconds and backs off through 10, 20, 40 and 60 seconds; requested field runs retain retries, while the stopped-session option is bounded to three attempts. Authentication rejection requires a new explicit sign-in. Route validation is lazy and cached with bounded, exact keys. Three-run median cold Node route benchmarks improved Prontera 77→17 ms, Payon 347→151 ms, Yuno 1,758→680 ms and Glast Heim 1,743→723 ms with identical routes. An independent Field 8→Payon approach-cache check measured repeated planning at 7.19→0.008 ms; 3,000 generated graphs preserved route availability, crossing counts and costs. These are local planner measurements, not native frame-rate claims. Integrated checks passed 708 TypeScript and 25 Rust tests; native packaging and signature checks passed. Live network-loss recovery remains untested. The server's movement time, skill motion, attack cooldown and pickup ownership remain authoritative regardless of client scheduling frequency.

Player spawn broadcasts can include the owning character with placeholder `SP=0, MaxSP=0`. The official client accepts spawn SP only when `MaxSP>0`; the adapter omits that placeholder and preserves prior stats/SP updates. A real `0/positive maximum` remains authoritative exhausted SP.

Targeted support results and indirect Sanctuary damage may serialize `DamageInfo.Time=0` as `Time - server uptime`, producing a large finite negative damage delay. Opcodes 29 and 30 preserve that value; non-finite delays, excessive future delays and invalid motion durations remain rejected.

## Direct monster approach

After ranking and validating a visible selected target, the engine checks a straight walking corridor including both diagonal side cells and portal exclusions. Once inherited movement has settled, it can send the normal Attack command and let the server approach. Obstructed corridors retain A* routing. The pursuit clock starts at the first actual approach request and survives direct/routed conversions. An implicit walk retains ownership through target removal, recovery, Stop and timeouts; a matching Attack, explicit Stop, accepted movement or bounded acknowledgment deadline reconciles that owner before another action. Returned movement remains collision-validated. This is a conservative walking corridor, not a ranged/projectile LOS claim.

The checked-in augmented portal evidence report includes the per-source protocol-pin matches required by regeneration. `python3 scripts/test-travel-catalog.py /path/to/pinned-source-git` passes three cases: exact 1,360-edge byte reproduction, rejection of missing pin evidence and rejection of empty results while preserving the existing catalog.

Final direct-target release proof: 708 TypeScript tests and 25 Rust tests passed, plus typechecking, Clippy, formatting, native packaging and strict signature verification. Three consecutive fresh native logins entered the selected character. A Field 8 run confirmed one defeat and two pickups, then Stop. Synthetic scenarios cover obstacle/corner/portal fallback, moving targets, late acknowledgments and pursuit deadlines; live checks do not cover every such geometry.

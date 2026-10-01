# Protocol evidence

Inspected 2026-10-01. The live page identifies **RO Rebuild / Unity WebGL**, protocol **V.8**, with build directory `Build_2569-09-01-01-55`. Login through the official client succeeded, and the browser opened `wss://gamesea01.rayrag.com/ws`.

The observed entity packet matches the older [Rebuild enum at 4099e2c000c3c550516760b9c1241595aac9aceb](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RebuildSharedData/Networking/PacketType.cs). Current upstream reordered its enum; do not substitute current numeric IDs.

The [OpenKore packet table](https://github.com/OpenKore/openkore/blob/master/src/Network/Send/ServerType0.pm) describes a different transport. The implementation here uses the game's existing session and implements only the relevant Rebuild message fields.

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
| Player stats | 56 | HP at byte 49 and max HP at byte 53, including opcode |
| Minimap tracking | 60 | u16 count; i32 ID, i16 x/y, u8 kind; effect kind 8 adds a string |
| Ground drop | 81 | i32 ground ID, f32 x/y, i32 item ID, i16 count, new-drop bit |
| Pickup | 82 | outgoing i32 ground ID; incoming i32 picker and ground ID |

Integer and float fields are little-endian. Trailing ordinary booleans are bit-packed; the drop decoder reads the first bit at byte 19 to distinguish a new drop from an existing item entering view. MemoryPack entity strings use their own encoding: negative complemented UTF8 byte count plus UTF16 character count, or a nonnegative UTF16 character count. The entity's Position uses i32 fields, unlike packet positions.

The public Poring spawn fixture decoded as ID 1638, class 4000, position 320/153, level 1, HP 51/51. No account handshake or token is saved in fixtures. The live Enter packet had a shorter suffix than upstream's 16-byte GUID. That suffix is deliberately not interpreted or stored. This illustrates why sharing a version number does not establish complete compatibility.

## Sign-in and character selection

Companion uses the official Unity login methods; it does not construct an authentication packet. The deployed `Build Web.data`, `Build Web.symbols.json`, and WASM were inspected against the source pin. Their active scene paths and callable methods match the adapter in `src/login.ts`:

- Login window: `Canvas/Login Screen/LoginBoxWindow`, with `ChangeTabs(int)` and `AttemptLogin()`.
- TMP inputs below that window: `LoginBox/Login/Username/Title/InputField (TMP)`, `LoginBox/Login/Password/Title/InputField (TMP)`, and `LoginBox/Server Settings/Username/Title/InputField (TMP)`, each with `SetTextWithoutNotify(string)`.
- Character screen: `Canvas/Login Screen/CharacterCreator`, with `SetCharacterInfo(int)` and `ClickOk()`.

Unity factory completion precedes asynchronous asset loading and login-screen activation. WebGL `SendMessage` finds only active objects and reports failed dispatch through the console instead of throwing. A harmless nonexistent-method probe requires the exact active-object diagnostic before credentials are claimed. The server-settings tab must be activated before setting its input, then the login tab must be restored. Character selection similarly waits for its active screen.

While a requested sign-in is active, ConnectionApproved opcode `0` is read only to establish populated slots. After the opcode it contains a one-bit token flag, an optional i32 byte count and opaque token bytes, an i32 character count, then each character's u16-length UTF8 name, i32 slot, map string, and i32-length summary bytes. Fields following the bit are unaligned. Tokens are skipped; only occupied slots 0–2 are retained. Opcodes `1` and `32` end the attempt as rejected. Selecting an absent slot would otherwise open character creation, so the adapter stops before invoking `ClickOk()`.

The official client remains responsible for validation and network authentication. Credential handoff is one-shot, expires after 120 seconds, and requires the fixed game window, URL and build. Credentials and authentication frames are excluded from telemetry and fixtures.

HP is reduced on HitTarget, not on visual Attack/TakeDamage packets. Tracking removal records contain negative coordinates and must not be interpreted as invalid world coordinates. Effect records are variable length. Resurrection updates health/alive state but does not restart automation.

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

Missing or locked walks time out and retry with shorter steps. Corrections and interrupted walks invalidate the old leg and replan from the updated position. Safe replacement endpoints supersede the accepted leg and cause replanning toward the original goal. Failed endpoints are avoided temporarily without changing the static grid. Three consecutive failed legs stop the run. Useful accepted movement completion clears the failure count. Attack approach timeouts and search goal timeouts are distinct; a server-generated pursuit after Attack is also bounded. Adjacent approach is conservative: the walk-only grid does not contain the separate flags needed to prove arbitrary ranged line of sight.

Algorithm/settings references: [OpenKore A*](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/auto/XSTools/PathFinding/algorithm.cpp), [wall clearance weights](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/auto/XSTools/misc/fastutils.xs), [route execution](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/src/Task/Route.pm), [settings](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/control/config.txt). This is an original TypeScript implementation; no OpenKore engine or transport is bundled.

Static teleport exclusions use **1,443 distinct inclusive rectangles across 231 maps**. The full audit resolves all 970 published [mapwarps.json](https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/mapwarps.json) records against [upstream source at `72d4004`](https://github.com/Doddler/RagnarokRebuildTcp/tree/72d4004af948daa61b4d496be1080e0633b66602/RoRebuildServer/GameConfig/ServerData/Script), also comparing the protocol pin `4099e2c`. Source definitions add same-map, hidden, and fixed NPC-touch teleports omitted by the public export. The included source records comprise 1,405 Warp calls, three HiddenWarp calls, and 38 NPC touch portals before rectangle deduplication. `scripts/navigation-portals.json` owns the reviewed areas; `scripts/navigation-portal-sources.json` records source paths, lines, commits, public-export hash, and limitations. Packet decoding remains on its existing protocol pin.

Exact trigger rectangles replace the old blanket 24-cell margin. Both boundaries are inclusive. Conditional fixed triggers are excluded even while hidden or inactive, including Field 8's Okolnir entrance `(131,338)`. Field 5 excludes 479 physically walkable trigger cells; Field 8 excludes 333. Thirteen scenes have no static portal definitions in audited source and have explicit empty lists. Static source coverage is not live server introspection and cannot account for dynamically placed player Warp Portal skills or dynamic event areas.

Three source warp definitions land at `moc_fild02 (77,338)`, inside an actual destination trigger. Start remains blocked there until the character moves onto safe ground. Destination-only movement still lets the server choose a different path; a returned unsafe route is stopped. Every map transition stops automation and resets map-specific navigation and targets. Reverify collision assets and portal rules when the deployed game changes.

## Entity status dictionary layout

The pinned entity schema uses `Dictionary<CharacterStatusEffect,float>`, with a byte enum key. MemoryPack 1.21.4 serializes unmanaged key/value pairs as eight bytes: one key, three padding bytes, and the float. The decoder consumes this padding and retains exact entity-size checks. A synthetic status-bearing version of the existing public monster fixture reproduced the old `Invalid entity` failure when only five bytes were consumed. The original failing runtime frame was not retained, so this is a matching source-backed reproduction rather than identification of that particular packet. See the [MemoryPack formatter](https://github.com/Cysharp/MemoryPack/blob/1.21.4/src/MemoryPack.Core/Formatters/KeyValuePairFormatter.cs) and [enum generator](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig.Generator/StatusEffectGenerator.cs).

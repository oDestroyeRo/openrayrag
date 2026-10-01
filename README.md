# Rayrag Companion

A Tauri v2 macOS app for automatic sign-in, character selection, and basic combat and looting on [Ray Side Project SEA 01](https://websea01.rayrag.com/). The bundled controller opens the official Unity game in a separate, ephemeral WebKit window.

## Run

Requires Node.js 22.12+ (tested on 24), Rust, and Xcode command line tools. The application targets macOS 13+ and was tested on Apple Silicon. See [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/).

```sh
npm ci
npm run app:dev
```

Build a local macOS application:

```sh
npm run app:build
```

The app is created at `src-tauri/target/release/bundle/macos/Rayrag Companion.app`. This uses an [ad-hoc signature](https://v2.tauri.app/distribute/sign/macos/#ad-hoc-signing) for local use and is not notarized. `npm run dev` is a browser preview of the controller; it cannot control the game.

The release profile leaves build dependencies unstripped to work around a macOS proc-macro loading failure in Homebrew Rust 1.98.1. Application optimization remains enabled.

## Use

1. Enter your account under **Account & character**, choose an existing character slot (1–3), and select **Sign in & enter**. The app waits for the login screen, signs in through the official client, and enters that character. **Open game** still supports manual sign-in.
2. Dismiss any game popups and position your character near the monsters you want to fight.
3. Return to Companion. Check the monsters you want to attack in the current map's list, choose monster scan radius and HP stop limit, inspect the collision map, and optionally choose **Find monsters → Search the current map**, then select **Start bot**. **Select eligible** checks the listed monsters within the level limit; **Clear** removes your choices.
4. Select **Stop** to cancel automation, including sign-in. Clicking or typing inside the game also cancels automatic sign-in and pauses combat.

Credentials are session-only by default. To remember the account, explicitly enable **Save in macOS Keychain** before signing in. **Sign in when app opens** additionally restores that saved account and character slot on launch. These choices are saved when you submit **Sign in & enter**. **Forget saved login** removes the Keychain entry and its launch preference. The controller never retrieves the saved password or writes credentials to configuration files or browser storage.

Automatic sign-in attempts once per request. Rejection, disconnect, timeout, or an empty slot stops it without retrying or opening character creation. Close the current game before switching characters. Entering the field never starts combat automatically; press **Start bot** when ready. Leave the game's own Remember Password option off.

The target picker uses the game's published map and monster database. It shows monster level, HP, configured **map spawns**, and the number currently **in view**. Configured spawns are not a live population count. Types observed by the game also appear, including event monsters absent from the database; if the database is unavailable, the picker uses observed types alone.

No monster is selected automatically. Choices survive normal updates and monsters leaving view, but reset when the map or game session changes. Start requires at least one eligible choice and rejects selections from a previous map. The bot matches monster class IDs and attacks only live, nearby entities, up to one level above your character. Companion plans an approach to an adjacent melee tile before sending Attack. The server still controls actual movement, combat cooldowns and pickup eligibility. The bot waits for server responses; counters distinguish commands sent from confirmed monster deaths and pickups.

It considers server-marked new drops that appear after and near its defeated monsters for 30 seconds. This is conservative proximity/time attribution, not proof of server ownership; the server still enforces loot priority. It skips targets observed being attacked by another actor. It does not use skills or potions, sell items, or respawn.

**Walkability is checked before Start.** The client bundles collision data for **all 231 map scenes published by the official game client**: towns, interiors, fields and dungeons. Each map uses its own dimensions and static teleport trigger rectangles, including the two 416-cell Payon fields. The compact grids total about 4.1 MB; Unity scene bundles are not shipped or downloaded during gameplay. Field 8 has 70,001 physically blocked cells, 89,999 walkable cells and 333 walkable cells excluded by static teleport triggers. The collision view shows your character, visible monsters, drops, planned route and current waypoint.

The official map-name database has three additional entries without published scene assets: **`payon_p`, `2009rwc_03`, and `pvp_n_1-5`**. No shared-scene aliases were verified, so Start stays disabled for those exact codes and for unknown maps. Changing maps clears the old route and target choices; choose current-map targets and press Start after arrival. If arrival is inside an actual teleport trigger, move onto open ground first.

The planner uses eight-direction A* with diagonal corner prevention and optional wall-clearance penalties. It precomputes connected areas, skips unreachable monsters, ranks eligible targets by approach travel cost, and approaches an adjacent tile before attacking. The full route is followed in straight segments within the server's 20-step limit. Monster scan radius bounds target acquisition; it does not bound exploration around Start.

**Find monsters** is off by default. Mode **2** selects random destinations throughout the character's connected area on the current map. It switches to a selected visible monster or eligible loot after any outstanding movement leg; the old leg must finish because server replies do not identify their request. It does not travel through portals or automatically return from another map. Random walking is not exhaustive coverage or a guarantee that a particular monster will spawn.

The supported OpenKore setting subset is:

| Setting | Default | Accepted values / behavior |
| --- | --- | --- |
| `route_randomWalk` | 0 | 0: off; 2: current-map exploration. Upstream defaults to 1, which permits map routing and is not implemented here. |
| `route_step` | 10 | 1–20 steps; bends can shorten a segment. |
| `route_avoidWalls` | true | Apply upstream-style wall-distance penalties; never permits blocked cells when off. |
| `route_randomWalk_maxRouteTime` | 75 | 1–600 seconds per search goal. |
| `attackRouteMaxPathDistance` | 20 | 1–200 path cells for an approach, separate from visible scan radius. |
| `attackMaxRouteTime` | 4 | 1–60 seconds from the first approach walk, excluding an inherited search leg; also bounds a server-initiated chase after Attack. |

These names/defaults follow [OpenKore's pinned config](https://github.com/openkore/openkore/blob/51de1ddfc4449ae5217f6886de702f87ca934030/control/config.txt), except the deliberately opt-in random walk. This is a routing subset, not full config compatibility. Melee approach range is fixed at 1; weapon range, skills, party policies, town rules, teleport and cross-map `lockMap` are not implemented.

Companion validates every server-returned player route against collision and portal exclusions, including combat-generated movement. Position displays follow the accepted route's timing; normal walking has no separate arrival acknowledgment. Corrections, stopping hits and replacement routes supersede the estimate. Failed legs are temporarily avoided, the next step is shortened, and three consecutive failures stop the run. Temporary failures never change the physical collision map. Approach timeouts cool down targets for 30 seconds; search timeouts select another goal.

Low HP, death, map changes, manual input, stale traffic, computer sleep, controller heartbeat loss, and malformed supported packets stop automation. Resume explicitly. A stop cancels the character's action; it does not prevent nearby monsters from attacking. Closing Companion closes its game session.

## OpenKore and protocol compatibility

[OpenKore](https://github.com/OpenKore/openkore) is a behavioral reference, but its Ragnarok packet transport is incompatible with this custom Rebuild server. No OpenKore code or engine is bundled. This implementation observes the official client's existing WebSocket and sends the ordinary attack, pickup, walk, and stop commands on that session.

The adapter is restricted to `https://websea01.rayrag.com/`, `wss://gamesea01.rayrag.com/ws`, and the observed build `Build_2569-09-01-01-55`. New builds require protocol validation. The remote game window can report bounded status and claim or cancel one explicitly queued login. It cannot read the Keychain. Controller commands belong to the bundled local window. No shell or filesystem plugin is exposed.

See [protocol evidence](docs/PROTOCOL.md) for the source pin and observed differences. Authentication responses, outgoing credentials, chat and raw packet contents are not recorded by Companion. In-memory status retains only your character, monsters, drops and bounded activity messages.

## Checks

```sh
npm run check
```

This builds the frontend and injected bridge, typechecks TypeScript, runs behavioral/protocol/login tests and Rust boundary tests, and runs Clippy. Tests use synthetic game events and one public monster packet. The app does not contain an unattended account test. An optional local Keychain integration check creates and removes one synthetic entry:

```sh
cargo test --manifest-path src-tauri/Cargo.toml keychain_round_trip -- --ignored
```

Live validation on 2026-10-01 in the native game window confirmed 4 monster defeats and 8 loot pickups during one bounded run. Stop returned the controller to idle; manual game input also paused automation in a separate run. These checks establish basic combat and looting on the pinned build, not unattended reliability across all maps and monsters.

Automatic sign-in and entry of the existing character in slot 1 were also verified in the release app using session-only credentials. Combat remained stopped. An empty slot 2 produced the expected error and left the game on character selection without opening creation. Stop during initial loading cancelled sign-in and unlocked the account controls. Keychain storage was tested separately using a synthetic entry; the real account was not saved during validation.

The map picker was verified live on Prontera Field 5: all seven database types loaded, configured spawn counts matched the public export, and in-view counts changed with live monsters. Class-ID attack matching, map mismatch rejection, selection retention and metadata failure handling are covered by automated tests.

Nearby search was verified live on Prontera Field 5 in the release app: multiple short walks stayed within the selected starting area, manual game input paused the first run, and the final build confirmed one monster defeat plus two pickups with search enabled before continuing to search. Stop returned it to Ready. The isolated search-to-new-target preemption and failed-walk paths are covered by automated tests; this was not an unattended endurance test. That earlier nearby-search build passed 71 TypeScript tests, three Rust tests, Clippy, formatting and app signature verification.

The A* routing build was verified on 2026-10-01 with **91 TypeScript tests**, **three Rust tests**, Clippy, formatting, release packaging and signature verification. Independent review covered delayed replies, soft-block recovery and detours outside the acquisition radius. Native UI inspection confirmed collision counts and all six routing controls before Start. A bounded live run traversed the map; a later run with `attackMaxRouteTime=12` confirmed **two monster defeats and three pickups**, then resumed searching. Stop returned Ready, and the temporary Poring selection and timeout change were restored. Later diagnosis found that this build incorrectly charged the remainder of a search leg against the default four-second approach budget. The current fix starts that clock only on the first pursuit walk; subsequent replans retain the same deadline. Long actual approaches can still reach the configured limit. Obstacle fixtures and recovery races are automated proof, not an exhaustive live map or endurance test.

The earlier 14-map transition and pursuit fix passed **99 TypeScript tests**, **three Rust tests**, Clippy and formatting. Regressions cover search-to-attack handoff at the default four seconds, bounded failed-walk recovery, Field 5 → Field 8 route reset and restart, attack on Field 8, all 14 collision grids, inclusive portal boundaries, valid arrival positions, and unsupported maps. The rebuilt native app was then checked on Field 8 at `(152,354)`: the verified collision view loaded and Start was available. With map search enabled and `attackMaxRouteTime=4`, a bounded run confirmed **four monster defeats and nine pickups**. Stop returned Ready; the temporary Poring selection was removed, preserving Drops, Lunatic and Pupa. Longer moving-target approaches still reached the configured four-second limit. The map-transition event sequence is automated proof; this run did not physically traverse or live-test all 14 maps. Release packaging and ad-hoc signature verification also passed.

The all-map expansion passed **334 TypeScript tests**, **three Rust tests**, Clippy, formatting, release packaging and signature verification. Independent review matched all 231 generated grids to separate extraction outputs and verified every bundle hash. The catalog generator rejects altered bundles while preserving the existing catalog; the fetch command reuses all matching cached assets. Native inspection on 2026-10-02 confirmed the expanded catalog loads in the game session, Field 8 shows 333 static teleport exclusions, and resumed combat and pickups work. Coverage of the remaining maps is asset and automated-test proof, not a claim that every map was visited live.

`src/protocol.ts` owns gameplay wire decoding, `src/engine.ts` owns combat and search decisions, `src/navigation.ts` owns collision analysis, connected areas, A* and straight route segments, `src/movement.ts` follows server-accepted walk timing, `src/map-data.ts` reads the public map catalog and aggregates visible monsters, `src/targets.ts` owns map-specific choices, `src/login.ts` owns sign-in and character selection, `src/bridge.ts` connects the official game session, and `src-tauri` owns native windows, Keychain storage and IPC capabilities. `src-tauri/generated/game-bridge.js` is rebuilt by the normal npm build; edit its TypeScript source instead.

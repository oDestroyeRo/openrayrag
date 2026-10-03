# Manual chat and emotes

The Social panel sends only on an explicit button click. It has no Enter shortcut, aliases, slash/percent parsing, automatic replies, macro actions or replay. The native controller accepts a separate `social` request; the ordinary action, routine, workflow and service validators reject it. Existing fixed origin/build/socket, fresh character state and action ownership gates still apply. Unavailable actions are rejected immediately rather than queued for later.

Say reaches the entire current map. Shout reaches all players and requires **learned Basic Mastery (skill 1) level 7**. Party requires observed current membership. Granted skills do not satisfy these checks. Accepted chat is opaque and unchanged: 1–140 UTF-16 code units, not UTF8 bytes or Unicode code points. Empty, Unicode White_Space-only and lone-surrogate text is rejected. The shared TypeScript/Rust corpus includes U+0085 (whitespace, rejected), U+FEFF (accepted), emoji, Thai and HTML-looking content.

The picker uses the exact 59 player IDs and command labels in pinned `Emotes.csv`, including its gaps. It offers dice 58; result IDs 200..205 are receive-only. Novices (job 0) require learned Basic Mastery level 1; other jobs do not. Unknown job/mastery state and known Silence block the applicable send. Incoming NPC, monster and unknown signed emote IDs remain literal observations and cannot dispatch anything.

The app imposes a **20-second Shout gap**, **1.8-second emote gap** and **10-second echo window**. These are conservative app policies: the pinned Shout handler accumulates allowance rather than implementing this exact gap. Server input/cooldown/status checks can silently refuse a send. No verified item, SP or zeny cost is invented.

A successful socket write is **Sent**. **Echo observed** requires an explicitly ready own actor, exact channel and complete text, or the requested emote result (200..205 for dice 58). Actor 0 is valid only when independently observed as the current ready character. Other-player/server chat, dialogue and unrelated emotes/errors cannot confirm it. Matching happens before display truncation. This protocol has no request IDs or delivery receipts: identical repeated requests cannot be uniquely correlated and remain unconfirmed. Fingerprints are retained through Stop, map and character changes; the bounded 256-fingerprint session budget disables further echo correlation when exhausted. No timeout or ambiguous result triggers a retry.

Stop and world, character, socket or window-session changes cancel local pending intent. Cancellation cannot unsend a transmitted packet. Old socket generations are ignored; reconnect starts a fresh social session and never replays an outgoing packet. Character/session boundaries clear history. Draft cleanup binds page/session ID, socket ID, observed character identity and local generation, so a reloaded page cannot retain a previous draft when its counter restarts.

History exists only in memory: at most **200 entries and 32 KiB of serialized UTF8**, with at most **4 KiB text and 256 bytes sender display** per entry. Truncation keeps Unicode code point boundaries and a visible marker. Names/text are rendered with `textContent`. Drafts, history and full outgoing fingerprints are excluded from profiles, browser storage, saved login, reconnect state and logs. Incoming u16 strings can each contain 65,535 UTF8 bytes; these wire bounds are distinct from display caps. Combined status remains subject to the existing 500,000-byte native limit.

Guild, friends, clan, private whispers, automatic replies and other social systems have no adapter here. Companion provides the explicit manual chat/emote subset described above.

## Pinned evidence

Rebuild source: `4099e2c000c3c550516760b9c1241595aac9aceb`. The generated catalog stores its source path, SHA-256 and pin. Regenerate and check it without gameplay:

```sh
python3 scripts/build-emote-catalog.py /path/to/RagnarokRebuildTcp src/data/emote-catalog.json
python3 scripts/test-emote-catalog.py /path/to/RagnarokRebuildTcp
```

- [PacketSay](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Character/PacketSay.cs): channels, 140-unit check, learned Shout prerequisite and allowance.
- [PacketEmote](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Character/PacketEmote.cs): novice mastery, 1.8-second gate, Silence, whitelist and dice randomization.
- [CommandBuilder, lines 1037–1102](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/CommandBuilder.cs#L1037): Say/Emote echo layouts, map-wide Say and server-message sentinel.
- [NetworkManager, lines 1364–1384 and 1515–1522](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RebuildClient/Assets/Scripts/Network/NetworkManager.cs#L1364): official outgoing layouts.
- [Emotes.csv](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig/ServerData/Db/Emotes.csv) and [DataLoader, lines 1119–1132](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Data/DataLoader.cs#L1119): whitelist ownership. The deployed emote export has not been matched separately.
- [World allocator, lines 919–931](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Simulation/World.cs#L919): actor IDs can wrap to 0; Emote has no -1 sentinel.
- [Map, lines 437–466](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Simulation/Map.cs#L437): source self-visibility supports an own echo. Source support is not deployed echo proof.

Synthetic tests cover full wire, Unicode/native parity (including literal leading BOM text/name), prerequisites, cooldowns, ownership, echo ambiguity, cancellation, literal rendering and bounds. The social decoder and model accept actor 0 with independently ready identity, but the existing core entity decoder rejects ID 0 spawns: end-to-end own-actor-0 readiness remains an existing core identity limitation. Integrated offline native UI inspection confirmed the social panel layout, disabled channel/draft/emote/send controls while disconnected, and empty session history without signing in or sending any message. Unicode input, literal rendering and Enter-key behavior remain synthetic UI proof. Deployed social sends and echoes remain unverified until separately authorized. The core actor-0 limitation is tracked in [issue #38](https://github.com/oDestroyeRo/openrayrag/issues/38).

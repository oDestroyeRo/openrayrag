# Companion wire formats

[Overview and implementation workflow](README.md) · [All packet IDs](packets.md) · [Source-only packets](upstream-packets.md)

These tables describe the bytes the current Companion consumes or emits. A consumed prefix is not a claim about the complete official payload. Every gameplay table omits its leading `u8 opcode`. C→S means client to server; S→C means server to client. Authentication and character approval are documented in the [connection sequence](README.md#connection-and-initialization).

## Primitives and framing

| Notation | Encoding / local bound |
| --- | --- |
| `u8`, `u16`, `i16`, `i32` | Unsigned/signed fixed-width integers; little-endian. Signed values use two's complement. |
| `f32` | IEEE 754 little-endian float; readers require finite values. |
| `b` | One least-significant-first bit. The next field begins at the next bit, without byte alignment. |
| `str` | `u16 UTF-8 byteLength, byte[byteLength]`; strict UTF-8, BOM preserved. Default BitReader limit 4,096 bytes; `str(N)` specifies another limit. |
| `pos` | `i16 x, i16 y`, normally each 0–4,096. Exceptions are called out below. |
| `actor` / `optionalActor` | `i32` 0–2,147,483,647 / −1–2,147,483,647. Actor zero is valid. |
| `resource` | `i32` 0–2,147,483,647; health pairs also require current ≤ maximum. |
| `bytes[N]`, `T[N]` | Exactly N bytes / repeated records; no implicit count. |
| `finish` | Reject any unread complete byte; ignore 0–7 final unused bits, including nonzero bits. |
| `prefix` | Only the listed prefix is consumed; remaining outer bytes are not validated. |

[binary.ts](../../src/binary.ts) implements the bit reader/writer. Reads are bounded to 1–1,000,000-byte packets, and writes to 8,000,000 bits. Writers validate ranges and finite float32 conversion. Final bits from the upstream pooled buffer can contain old data; they are not extra booleans or a checksum.

The private `Reader` in [protocol.ts](../../src/protocol.ts) is byte-oriented, caps string bytes at 1,024, and has no automatic whole-packet finish. Core tables identify its exact/prefix cases. Boolean-at-end core layouts read the last byte and inspect bit zero. Do not use that pattern when another field follows the boolean.

Map codes normally match `[a-zA-Z0-9_-]{1,64}`. Actor, class, item, bag, party-member and ground-drop IDs are separate domains. Bag/drop/member IDs are positive where required. Offline roster entity zero and selected-target zero retain their packet-specific sentinel ambiguity; [actor identity](../ACTOR_IDS.md) explains how these differ from valid visible actor zero.

## Core world and movement

Owner: [protocol.ts](../../src/protocol.ts), `decode`, `spawn`, `readWalk`, `command`, `walkCommand`, `lookCommand`.

| S→C ID | Consumed fields | Framing / meaning |
| --- | --- | --- |
| 3 | `actor selfId, str map` | Prefix; establishes identity. Any suffix is ignored, not stored. |
| 6 | `u8 entryType, [pos tossPosition if entryType=3], i32 entitySize, bytes[entitySize], [player appearance], [Walk]` | Entry 0–5; exact nested records, outer prefix. See below. |
| 7 | `actor id, Walk` | Exact bytes. |
| 10 / 20 | `actor id, pos position` | Prefix; position correction / immediate stop. |
| 11 | `optionalActor source, actor target, bytes[4] ignored, pos position` | Prefix; observed attack, not authoritative HP deduction. |
| 13 | `actor id, i16 lookX, i16 lookY, u8 direction, u8 head` | Exactly 11 bytes including opcode; look coordinates allow full signed i16, direction 0–7, head 0–2. |
| 15 | `actor id, u8 reason, [f32 ignoredTiming]` | Exactly 6 or 10 total bytes; reason 0–7, dead iff 3. |
| 16 | Empty | Prefix; clear current world. |
| 18 | `str map` | Prefix; map change. |
| 19 | `actor id` | Prefix; stop observation. |
| 23 | `actor id, i32 damage, pos position, u8 flags` | Prefix; `flags & 1` means stop. Damage is not independently range-limited here; HP deduction belongs to HitTarget. |
| 36 | `actor id` | Prefix; death. |
| 37 | `actor id, i32 ignoredValue, resource hp, resource maxHp` | Prefix; health pair validated. |
| 46 | `actor id, pos position, i32 hp` | Prefix; HP must be positive. |
| 60 | `u16 count, {i32 id, i16 x, i16 y, u8 kind, [str effectAsset if kind=8]}[count]` | Exact bytes; count ≤4,096. Effects and negative-coordinate marker removals emit no world-position event. Other coordinates are bounded; raw tracking IDs/kinds are not actor/kind-validated. |
| 81 | `i32 dropId, f32 x, f32 y, i32 itemId, i16 count, u8 flags` | Prefix; positive IDs/count, positions 0–4,096. `flags & 1` is new drop. |
| 82 | `optionalActor picker, i32 dropId` | Prefix; positive drop ID. |
| 103 | See [party](#party) | Bit-stream finish. |

| C→S ID | Action | Fields |
| --- | --- | --- |
| 7 | Walk | `pos destination` (integer coordinates); 5 total bytes. |
| 11 | Attack | `actor target`; 5 bytes. |
| 13 | Look | `u8 direction, u8 head`; 3 bytes, direction 0–7, head 0–2. |
| 19 | StopAction | Empty; 1 byte. Stop can shorten a route; transmission does not prove physical rest. |
| 82 | Pick up | `i32 positiveDropId`; 5 bytes. |

### MemoryPack entity

The length-delimited entity is 40–4,096 bytes. Its header declares **15 members**, but nested structs/dictionaries expand into the scalar sequence below:

```text
u8 schema = 15
i32 actorId, i32 actualClassId, i32 ignoredAppearanceOverride
MemoryString name
u8 kind, u8 ignoredFacing, u8 state
i32 x, i32 y
u8 level
i32 hp, i32 maxHp, i32 sp, i32 maxSp
i32 statusCount
repeat max(statusCount, 0):
    u8 statusId, bytes[3] unmanagedPadding, f32 seconds
u8 ignoredIsMainCharacter
```

Actor/class IDs are nonnegative; kind/state ≤4; coordinates are 0–4,096; health pairs are validated. Status count is −1 (null) through 128, status IDs are unique, and duration only needs to be finite (including `float.MaxValue`). Each status pair is **eight bytes**, not five. The nested reader must end exactly at entitySize. Sitting is state 2; dead is state 3. Kind-0 player SP with maxSp=0 is omitted as unavailable. `IsMainCharacter` is consumed but identity comes from EnterServer.

`MemoryString` is distinct from `str`: read `i32 length`; −1 produces empty text, nonnegative means `length * 2` UTF-16LE bytes, and other negative values mean `i32 UTF16CodeUnitCount` followed by `~length` UTF-8 bytes. The UTF-8 decoded JS length must match that count. Encoded text is capped at 1,024 bytes; both decoders are strict and preserve BOM.

For kind-0 players, any remaining outer bytes first trigger a length-delimited appearance record:

```text
i32 appearanceSize                    // 41..4096
u8 schema = 13
bytes[28] ignoredAppearancePrefix     // byte bool, i32 weapon class,
                                      // three bytes, five i32 equipment IDs
i32 partyId
MemoryString partyName
i32 ignoredFollowerStateFlags
```

Appearance ends exactly at its declared size. Party ID ≥−1; party name ≤128 UTF-16 units; positive ID requires a nonempty name, while ID≤0 requires empty name. Companion retains affiliation, not the rest of the appearance. Older entity-only player fixtures may omit the entire block and therefore leave affiliation unknown.

### Walk

```text
pos start
f32 originX, f32 originY
f32 secondsPerCell, f32 firstSeconds
u8 cellCount
bytes[ceil(max(cellCount - 1, 0) / 2)] packedDirections
u8 flags                              // locked = flags & 1
```

Count includes the starting cell when nonzero. Directions are decoded **high nibble first**, then low: 0 south `(0,-1)`, 1 southwest, 2 west, 3 northwest, 4 north, 5 northeast, 6 east, 7 southeast. Consumed nibbles 8–15 fail; the unused final low nibble is ignored. Every resulting cell is bounded. Float origins use tile centers, differ from start by at most two on each axis, and remain bounded. Seconds/cell is (0,10]; `abs(firstSeconds) ≤20`, so a negative first duration is allowed.

For moving state 1, kinds 0/1 append Walk after appearance/entity respectively. Standalone opcode 7 checks the whole packet; spawn-carried walking retains the outer prefix behavior. Timing estimates follow server-accepted routes; a requested destination never becomes an authoritative position before a response. See [movement evidence](../PROTOCOL.md#collision-analysis-planned-approach-and-walking).

## Character, inventory and skills

Owner: [protocol-feature.ts](../../src/protocol-feature.ts), `readItem`, `readInventory`, `readSkills`, `readStats`, `readSkillResult`, `decodeFeatures`, `featureCommand`. These owned layouts use `finish`.

### Shared records

| Record | Fields and bounds |
| --- | --- |
| RegularItem (type 1) | `i32 positiveItemId, i16 count`; count 0–32,767; bag ID equals item ID. |
| UniqueItem (type 2) | `i32 positiveItemId, i16 count, u8 flags, u8 refine, bytes[16] guid, i32 slots[4]`; 40 bytes. Enclosing record supplies bag ID. GUID is opaque wire-order hex; slots are consumed without ID validation. |
| Inventory | `u8 present`; 0 ends with empty inventory; 1 adds `i32 regularCount, RegularItem[regularCount], i32 uniqueCount, {i32 bagId, UniqueItem}[uniqueCount]`. Total ≤600; positive item counts, positive unique bag IDs, no duplicate bag IDs; counts checked against remaining bytes. |
| SkillList | `i16 count, {i16 skillId, u8 level}[count]`; count 0–512, positive unique IDs and positive levels. |

### Incoming feature packets

| S→C ID | Fields after opcode |
| --- | --- |
| 14 | `actor id, b sitting` |
| 24 | `actor id, optionalActor target, u8 skillId, u8 level, u8 facing, pos origin, f32 remainingSeconds, u8 flags` |
| 25 | `actor id, pos target, u8 skillId, u8 level, u8 size, u8 facing, pos origin, f32 remainingSeconds, u8 flags` |
| 26 | `actor id, f32 deltaSeconds` |
| 27 / 111 | `actor id` (cast stop / reset motion) |
| 29 | SkillResult variants below. |
| 30 | `actor source, actor target, pos position, i32 damage, f32 damageSeconds, u8 skillId, u8 hits, u8 result` |
| 31 / 42 | `u8 reason` (skill failure / request failure) |
| 32 | `str message` |
| 33 | `i32 currentTarget` ≥0 |
| 34 | `resource baseTotal, i32 baseGained, resource jobTotal, i32 jobGained` |
| 39 | `resource sp, resource maxSp` |
| 40 | `resource zeny` |
| 43 | `actor id` (targeted notification) |
| 48 | `i32 bagId, u8 slot, b equipped`; bag positive, slot 0–13. |
| 50 add | `b true, u8 type, i32 bagId, i16 change, resource weight, Item(type)` |
| 50 remove | `b false, i32 bagId, i16 change, resource weight, b ignored` |
| 56 | UpdatePlayerData below. |
| 57 | `u8 positiveSkillId, u8 positiveLevel, resource points` |
| 61 | `actor id, u8 statusId, f32 seconds` |
| 62 | `actor id, u8 statusId, b refresh` |
| 63 | `i32 positiveBagId, UniqueItem` (**no type byte**) |
| 91 | `u8 event, i32 value, str text`; memo event 8 is intercepted first. |
| 98 | SkillList (granted) |
| 104 | `actor source, pos target, u8 skillId, u8 level, u8 facing, pos origin, u8 range, f32 motionSeconds, b indirect, b mask[(1+2*range)^2]` |

Facing is 0–7; cast flags 0–15. Inventory changes are positive 1–32,767, with positive bag IDs and matching addition item identity. Skill result codes are 0–8. Opcode 30 requires damageSeconds ≤60, including arbitrary negative finite values; opcode 104 requires `abs(motionSeconds) ≤60`. Mask range 0–31; mask bits are consumed but not exposed as spatial state. See [actor observations](../ACTOR_OBSERVATIONS.md) and [cast availability](../CAST_AVAILABILITY.md) for freshness/admission; decoding an observation does not make it indefinitely available.

### SkillResult (29 S→C)

| Mode byte | Remaining fields |
| --- | --- |
| 1 / 2 / 3 (target) | `actor source, optionalActor attacker, optionalActor target, u8 skillId, u8 level, u8 facing, pos origin, i32 damage, u8 result, u8 hits, f32 motionSeconds, f32 damageSeconds, b indirect` |
| 4 (ground) | `actor source, pos target, u8 skillId, u8 level, u8 facing, pos origin, f32 motionSeconds` |
| 5 (self) | `actor source, u8 skillId, u8 level, u8 facing, pos origin, f32 motionSeconds, b indirect` |

`abs(motionSeconds) ≤60`; damageSeconds has upper bound 60 and may be arbitrarily negative but finite for support results. Facing is consumed/validated but omitted from the emitted result. Modes 1/2/3 collapse to the local target variant; preserve direction-specific layout rather than reusing the request schema.

### UpdatePlayerData (56 S→C)

```text
i32 data[12]   = level, jobLevel, zeny, attributes[6], skillPoints, statPoints, jobExperience
i32 stats[21]  = hp, maxHp, sp, maxSp, combatStats[16], maxWeight
f32 attackDelay
i32 weight, i32 cartWeight
b hasSkills
if hasSkills: SkillList learned, SkillList granted
b hasInventory
if hasInventory:
    Inventory items
    u8 hasCart                         // exactly 0 or 1
    if hasCart: Inventory cart
    i32 equipment[10]
    i32 ammoId
```

Exactly **145 total bytes including opcode** selects the legacy prefix: only fields through cartWeight are consumed and only level/hp/maxHp are emitted. That path cannot establish known skills, inventory or SP. Full packets validate HP/SP, level/job level 0–1,000, nonnegative resource values, attackDelay 0–60, equipment≥0 and ammo≥−1. The decoder retains the six attribute and sixteen combat-stat positions as arrays; their deeper semantics require the pinned stat enum, not a guessed index. Optional sections absent from a full packet mean unobserved, not empty; omitted cart does not clear known cart state.

### Outgoing feature packets

| C→S ID | Action | Fields |
| --- | --- | --- |
| 14 | Sit/stand | `b sitting` |
| 29 | Self skill | `u8 mode=5, i16 skillId, u8 level` |
| 29 | Target skill | `u8 mode=1, actor target, u8 skillId, u8 level` |
| 29 | Ground skill | `u8 mode=4, pos target, u8 skillId, u8 level` |
| 41 | Save-point respawn | `u8 mode=0` |
| 47 | Use item | `i32 positiveItemId, optionalActor target` (default −1) |
| 48 | Equip/unequip | `i32 positiveBagId, b equipped` |
| 57 | Allocate skill | `u8 skillId` |
| 58 | Allocate stats | `i32 increments[6]` |

Schemas reject unknown object fields. Skill IDs are positive: self ≤32,767, target/ground ≤255; levels 1–255. Six stat increments are each 0–99 and at least one is positive. Skill 55 is excluded from the general action path and uses the dedicated Warp owner. Skill/item/equipment availability and receipt handling belong to the controller, beyond numeric encoding.

## NPC, economy and party

Owner: [world-protocol.ts](../../src/world-protocol.ts), `decodeWorld`, `member`, `worldCommand`. Known variants use `finish`, with only the explicit party suffix exceptions below. Unknown opcodes and unsupported NPC/party subtypes return `null`.

`Rows` = `i32 count, {i32 id, i32 count}[count]`. `PricedRows` adds `i32 price` to each row. Request IDs/counts are positive, counts ≤32,767, IDs unique; prices 0–9,999,999 where priced rows are validated.

| S→C ID | Fields |
| --- | --- |
| 77 subtype 0 | `u8 subtype=0, actor npcId, b focus` |
| 77 subtype 1 | `u8 subtype=1, str(256) name, str text, b big` |
| 77 subtype 2 | `u8 subtype=2, i32 count, str(1024) options[count]`; count 0–32. Blank labels retain their option index. |
| 77 subtype 3 | `u8 subtype=3` (end) |
| 77 subtype 4 | `u8 subtype=4, str(256) sprite, u8 position` |
| 77 subtype 5 | `u8 subtype=5` (refine prompt) |
| 83 sell | `u8 kind=0, i32 overchargeLevel` |
| 83 buy | `u8 kind!=0, u8 discountLevel, i32 count, {i32 itemId, i32 price}[count]`; count 0–600, positive unique IDs, nonnegative prices. |
| 84 | Inventory |
| 85 | `u8 count, {u8 type, Item(type), i32 outputCount, resource zenyCost, i32 requiredCount, {i32 itemId, i16 count}[requiredCount]}[count]` |
| 86 | `u8 type, i32 bagId, i16 change, Item(type), resource currentWeight, i32 storageCount, b deposit` |
| 89 | `u8 direction, i32 bagId, u8 type, Item(type), i16 change, resource cartWeight, resource currentWeight` |
| 100–103 | [Party records and variants](#party). |
| 105 | `str(128) name, PricedRows`; 1–32 rows. |
| 106 | Empty |
| 107 | `actor vendorId, str(128) name, i32 count, {i32 bagId, u8 type, Item(type), i32 price}[count]`; count 0–32, unique bag IDs, prices 0–9,999,999. |
| 108 | `i32 positiveBagId, i32 count`; count 1–32,767. |

Shop levels are asymmetric widths (sell i32, buy u8); the sell value is still constrained to 0–255. NPC subtypes 6/7 are not implemented by this decoder. Barter count ≤64, output count 1–32,767, required count ≤100, and required item quantities are positive; unique output items use contextual bag ID −1. Storage/cart changes are positive i16; storageCount 0–32,767. Cart direction is 1 (bag→cart) or 2 (cart→bag); 3/4 are not implemented transfer commands.

### Party

```text
PartyMember:
    i32 positiveMemberId
    i32 entityId                       // -1..INT32_MAX
    i16 level
    str(128) name
    u8 leader                          // true only if byte == 1
    if entityId > 0:
        str(64) map                    // empty means unknown
        i32 hp, i32 maxHp, i32 sp, i32 maxSp
```

Live levels are 1–999; offline entity≤0 permits level −1 or retained positive level. Nonempty maps use the map-code grammar; health pairs are validated. Roster identity is memberId, not the current actor incarnation.

| S→C ID / subtype | Fields |
| --- | --- |
| 100 | `i32 positivePartyId, str(128) name, str(128) sender` |
| 101 | `u8 login, i32 positivePartyId, str(128) name, u8 opaque, i32 memberCount, PartyMember[memberCount], [bytes[8] opaqueSuffix]` |
| 102 / 0 | `u8 subtype=0, PartyMember` (add) |
| 102 / 1 | `u8 subtype=1, i32 positiveMemberId` (remove) |
| 102 / 2 | `u8 subtype=2, PartyMember, [bytes[4] opaqueSuffix]` (update) |
| 102 / 3 or 4 | `u8 subtype, PartyMember` (login / logout) |
| 102 / 5 | `u8 subtype=5, i32 positiveMemberId` (leader) |
| 102 / 6 or 7 | `u8 subtype` (left / disbanded) |
| 102 / 8 | `u8 subtype=8, i32 positiveMemberId, i32 hp, i32 maxHp, i32 sp, i32 maxSp` |
| 102 / 9 | `u8 subtype=9, i32 positiveMemberId, str(64) map` |
| 103 leave | `actor id, u8 joined=0` |
| 103 join | `actor id, u8 joined=1, i32 positivePartyId, str(128) nonemptyName, b ignored` |

Opcode 103 belongs to `protocol.ts`, establishing visible actor affiliation separately from roster snapshots. Joined byte must be 0/1. Login and leader bytes use equality with 1, not bit booleans.

**Deployed exceptions:** 101's opaque header byte is mandatory in Companion; it is absent from the pinned upstream handler. Optional suffixes are exactly 8 bytes for 101 and exactly 4 bytes for 102 subtype 2, or absent. Other subtype suffixes still fail. Their semantics remain unknown. Member count must be positive and fit the available payload's minimum 13-byte member footprint before allocation; duplicate member IDs fail atomically. There is no arbitrary 32-member cap. See the [dated deployed WASM evidence](../PROTOCOL.md#expanded-player-state-and-actions), including functions 29584–29586/29589 and the recorded artifact hash. These exceptions do not permit arbitrary trailers.

### Outgoing world packets

| C→S ID | Action | Fields |
| --- | --- | --- |
| 76 | NPC talk | `actor npcId` |
| 78 | Advance dialogue | Empty |
| 79 | Select option | `i32 index` 0–31 |
| 86 | Close storage | `u8 operation=0` |
| 86 | Deposit / withdraw | `u8 operation=1/2, i32 bagId, i32 count` |
| 87 | Shop buy/sell | Rows; **no mode byte**. Current store state selects interpretation. Buy ≤20 rows, sell ≤200. |
| 88 | Barter | `i32 choice, i32 count, i32 bagCount, i32 bagIds[bagCount]` |
| 88 | Cancel barter | `i32 choice=-1` |
| 89 | Cart transfer | `i32 bagId, i16 count, u8 direction` 1/2 |
| 99 | Create party | `str name, i32 inviteId` (positive when supplied; default −1) |
| 100 | Invite actor / name | `u8 mode=0, actor id` / `u8 mode=1, str name` |
| 101 | Accept party | `i32 positivePartyId` |
| 102 | Leave | `u8 operation=0` |
| 102 | Leader / remove | `u8 operation=1/2, i32 positiveMemberId` |
| 102 | Disband | `u8 operation=3, i32 sentinel=-1` |
| 105 | Start vending | `str name, PricedRows` (1–32 rows) |
| 106 | Stop vending | Empty |
| 107 | View vending | `actor id` |
| 109 | Purchase vending | Rows (0–32); no corresponding receive success schema. |

Barter choice 0–63, quantity 1–99, at most ten distinct positive bag IDs. Names must be nonblank, control-free and ≤32 JS characters, then use UTF-8 byte lengths on wire. Strict request schemas reject extra fields. [Workflows](../../src/workflows.ts) correlate inventory/balance/storage/cart observations; no request ID or generic success packet proves all these operations. Cancellation retains unresolved transactions without automatic resend.

## Manual adapters and Database travel

| Direction / ID | Fields | Owner |
| --- | --- | --- |
| C→S 44 | `str(420) text, u8 channel` | [social-protocol.ts](../../src/social-protocol.ts): channel 0 Say/map, 1 Shout/world, 2 Party; 1–140 UTF-16 units, nonblank paired Unicode, opaque untrimmed text. |
| S→C 44 | `optionalActor id, str(65535) text, str(65535) name, u8 channel` | Same; receive channel 0–3 (3 Notice); actor −1 is server. |
| C→S 54 | `i32 emoteId` | Same; generated 59-ID player whitelist, canonical dice 58. |
| S→C 54 | `actor id, i32 emoteId` | Same; signed/unknown results retained inertly, dice results 200–205. |
| C→S 94 | `u8 slot` 0–3 | [memo-protocol.ts](../../src/memo-protocol.ts); no map/coordinates transmitted. |
| S→C 94 | Four records: `u8 present`; if 1, `str(64) map, i16 x, i16 y` | Same; presence exactly 0/1, map grammar validated, coordinates nonnegative. Receive permits all positive i16 coordinates; preview caps at 511. |
| S→C 91 / event 8 | `u8 event=8, i32 value, str text` | Same; intercepted before generic ServerEvent; memo proof requires slot 0–3 and exactly empty text. |
| C→S 63 | `i32 targetBagId, i32 cardBagId` | [socket-protocol.ts](../../src/socket-protocol.ts); distinct positive IDs, no type byte. |
| C→S 80 | `i32 targetBagId, i32 oreItemId, i32 catalystBagId=0` | [refine-protocol.ts](../../src/refine-protocol.ts); ore is an item ID, target/catalyst are bag IDs. Catalysts unsupported. |
| C→S 29 / Warp ground | `u8 mode=4, i16 x, i16 y, u8 skillId=55, u8 learnedLevel` | [warp-protocol.ts](../../src/warp-protocol.ts); coordinates 0–511, learned level 1–4. |
| C→S 29 / Warp activate | `u8 mode=5, i16 skillId=55, u8 level=slot+1` | Same; slot 0–3. |
| S→C 97 | `u8 state` 0 cleared / 1 waiting | Same; selection state does not prove portal creation. |
| C→S 64 | `str(64) map, i16 x=-999, i16 y=-999, b force=false` | [database-travel-protocol.ts](../../src/database-travel-protocol.ts); only bundled collision-catalog maps, server-selected arrival. |

The Warp initialization observer also recognizes complete outgoing **3** (`b create=false, str(96) character`, 1–48 UTF-16 units) and exactly one-byte **2**. Its `officialWarpSkill` helper recognizes skill-55 prefixes in outgoing 29 modes 1/4/5 for interference detection; it is not a full validating decoder and does not establish send success.

| Feature | Completion evidence / extension constraint |
| --- | --- |
| [Social](../SOCIAL.md) | Own-actor matching echo within 10 seconds; repeated requests can remain ambiguous. Shout/party/emote admission uses skill, membership and cooldown gates. No automatic replies/retries. |
| [Memo](../MEMO.md) | Ordered 91/event8/exact slot/empty text, then complete 94 matching preview and unchanged other slots. Slot must be below learned Warp level; current-location preview binds identity, map/cell and revisions. |
| [Socket](../SOCKETING.md) | Exact card removal (50), expected unique-item mutation (63), and complete inventory/equipment/ammo preservation. Unequipped compatible target, first free slot and reserve gates. |
| [Refine](../REFINING.md) | Fresh 77/subtype5 prompt; exact ore loss (50), zeny debit (40), and same-item refine result (63). One attempt, no catalyst. Costs alone do not prove result. |
| Warp | Dedicated stationary ground/activation previews, own selection and exact cast/resource ordering. Creation remains unconfirmed; retain the persisted uncertainty guard until verified reset and reconciliation. See [Warp evidence](../PROTOCOL.md). |
| Database travel | Captured own departure, requested map, ordered Ready and fresh living own spawn. 30-second cooldown; only exact server warning can extend it. Stop preserves a sent unresolved receipt. See [travel](../../src/travel-controller.ts) and [local proof](../LOCAL_FEATURE_VERIFICATION.md). |

Manual social/memo/socket/refine/Warp schemas remain separate from routine/workflow/imported action documents. Their policy details and proof limits stay in the linked feature owners. Source-backed requests and synthetic fixtures do not establish every deployed transaction.

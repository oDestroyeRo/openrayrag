# Source-only packets and unimplemented directions

[Overview](README.md) · [Complete catalogue with pinned handler links](packets.md) · [Implemented formats](wire-formats.md)

This appendix records the remaining pinned-source surface so a future feature starts from a known owner. **These are not Companion APIs or verified deployed Rayrag contracts.** Source is Rebuild revision `4099e2c000c3c550516760b9c1241595aac9aceb`; follow each ID's client/server links in the catalogue. The same opcode can have a working receive adapter but no send action.

Notation follows [wire formats](wire-formats.md#primitives-and-framing), but bounds in that document are Companion bounds and must not be silently assigned to upstream code. Fields below follow the opcode. Server writers and client readers must be checked together; their discrepancies are called out explicitly.

## Ordinary observations and requests

| ID | Direction | Source payload / current gap |
| ---: | --- | --- |
| 5 CreateEntity | S→C | Retained legacy entity reader/writer disagree; see the historical layout below. Current creation uses 6. No Companion decoder. |
| 8 PauseMove | Unresolved | Enum entry only; no active sender/receiver found at the pin. No payload contract established. |
| 9 ResumeMove | Unresolved | Enum entry only; no active sender/receiver found at the pin. No payload contract established. |
| 12 TakeDamage | S→C | `i32 target, i32 damage, u8 hitCount, f32 timing`; presentation feedback, not Companion's authoritative HP deduction path (23). |
| 17 Disconnect | C→S | Empty; queues disconnect. Companion retires its transport without an opcode-17 encoder. |
| 21 RandomTeleport | C→S | Empty; requires admin or source `EnableRandomMoveForEveryone`. No ordinary Companion action; existing escape uses items/skills. |
| 22 UnhandledPacket | C→S fallback | Registered server fallback logs and disconnects. Not a usable feature request. |
| 28 CreateCastCircle | S→C | `pos position, u8 size, f32 castTime, b isAlly, b hasSound`; no Companion decoder. |
| 35 LevelUp | S→C | `i32 entity, u8 level, i32 currentExp`; no dedicated Companion decoder. Stats/EXP observations use 56/34. |
| 38 ImprovedRecoveryTick | S→C | `i32 entity, i16 hpGain, i16 spGain`; no Companion decoder. |
| 49 UpdateCharacterDisplayState | S→C | Seven i32 values: `entity, headUpper, headMid, headLower, weapon, shield, weaponClass`; no display-state adapter. |
| 51 EffectOnCharacter | S→C | `i32 entity, i32 effect`; no Companion decoder. |
| 52 EffectAtLocation | S→C | `i32 effect, i16 x, i16 y, i32 facing`; no Companion decoder. |
| 53 PlayOneShotSound | S→C | `str filename, i16 x, i16 y`; no Companion decoder. |
| 55 ClientTextCommand | C→S | `u8 command`: 0 Where, 1 Info, 2 Adminify. Adminify additionally reads `str` and changes privilege state. No generic text-command interface in Companion. |
| 59 ChangeTargetableState | S→C | `i32 entity, b canTarget`; no Companion decoder. |
| 62 RemoveStatusEffect | C→S only gap | `i32 statusId`; requires alive/action-ready player, enum range and `CanCancelStatusEffect` (status configuration `CanDisable`). Companion implements S→C status removal but cannot request cancellation. |
| 81 DropItem | C→S only gap | `i32 bagId, i16 count`; requires alive/action-ready player, positive quantity and unequipped inventory item. Companion implements ground-drop observation, not inventory discard. |
| 90 ChangeFollower | Both | C→S `i32 follower/style` (negative removes); S→C `i32 entity, u8 followerFlags`. Neither direction has a Companion action/decoder. Does not establish a feeding/pet-care protocol. |
| 92 ServerResult | S→C | Server writer: `u8 result, i32 value, str text`; Unity consumes only result/value and leaves its text read commented out. No Companion decoder; do not invent a universal transaction receipt. |
| 93 DebugEntry | Unresolved | Enum entry only; no active sender/receiver found at the pin. |
| 95 DeleteCharacter | C→S registered | Handler body is effectively a no-op, with no payload consumption or deletion implementation. Registration is not a usable delete contract. |
| 110 StartWalkInDirection | C→S | `i16 x, i16 y`; validates alive/action/hidden state and clears target. Companion only encodes StartWalk 7. |
| 112 ToggleActivatedState | S→C | `i32 entity, b activated`; no Companion decoder. |

ServerResult 92 values in the pinned [ServerEvent.cs](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RebuildSharedData/Enum/ServerEvent.cs) are 0 `PartyInviteSent`, 1 `InviteFailedSenderNoBasicSkill`, 2 `InviteFailedRecipientNoBasicSkill`, 3 `InviteFailedAlreadyInParty`. The full server writer is `CommandBuilder.SendActionResult`; the receive prefix is `PacketServerResult.ReceivePacket`.

Some implemented families also have gaps: NPC 77 subtypes 6/7 lack a verified Companion layout; Skill 29 has a deliberately separate staged Warp owner; refine 80 excludes catalysts; incoming 104 consumes but does not publish the area mask. Authentication covers existing characters, not new-character creation. Complete incoming 0/3 source registration does not imply support for character creation/deletion flows.

## Privileged and appearance surface

These entries complete the inventory; they are outside the ordinary-player Companion command surface. Most use inherited `AdminClientPacketHandler` authorization. **64** and **68** instead use ordinary registration with internal gates, so neither packet names nor enum attributes establish authority.

| ID | Direction | Fields / source gate |
| ---: | --- | --- |
| 45 ChangeName | Both | Privileged C→S `str name`; S→C `i32 entity, str name`. No Companion adapter. |
| 64 AdminRequestMove | C→S | `str map, i16 x, i16 y, b force`; requires admin or `EnableWarpCommandForEveryone` in pinned source. Companion already uses only its constrained Database variant described in [wire formats](wire-formats.md#manual-adapters-and-database-travel). |
| 65 AdminServerAction | C→S | `u8 action`, conditional fields below; privileged. |
| 66 AdminLevelUp | C→S | `i8 level, b isJobLevel`; privileged. |
| 67 AdminEnterServerSpecificMap | C→S | `str map, b hasPosition, [pos if hasPosition]`; privileged. |
| 68 AdminChangeAppearance | C→S | `i32 selector, i32 value, i32 subId`; selectors 0–2 lack an admin attribute; selector 3 changing job checks `IsAdmin`. Other server validation still applies. |
| 69 AdminSummonMonster | C→S | `str mobName, i16 count, b isBoss`; privileged. |
| 70 AdminHideCharacter | Both | `b hidden` in each direction; request privileged, observation unsupported in Companion. |
| 71 AdminChangeSpeed | C→S | `i16 speed`; privileged. |
| 72 AdminFindTarget | C→S | `str targetName`; privileged. |
| 73 AdminResetSkills | C→S | Empty; privileged. |
| 74 AdminResetStats | C→S | Empty; privileged. |
| 75 AdminCreateItem | C→S | `i32 itemId, i32 count`; privileged. |
| 96 AdminCharacterAction | C→S | `i32 action`, conditional fields below; privileged. |

The [65 handler](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Admin/PacketAdminServerAction.cs) branches on the enum in PacketType.cs:

| Action byte | Remaining payload |
| --- | --- |
| 0 ForceGC / 1 ReloadScripts | Empty |
| 2 KillMobs | `b isMapWide` |
| 3 EnableMonsterDebugLogging | Empty; handler compiled only in DEBUG |
| 4 SignalNpc | `str signalName, str signalValue` |
| 5 ShutdownServer | `i32 seconds, str reason` |

The [96 handler](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Admin/PacketAdminCharacterAction.cs) uses [AdminCharacterAction](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RebuildSharedData/Enum/AdminCharacterAction.cs):

| Action i32 | Remaining payload |
| --- | --- |
| 0 RefineItem | `i32 bagId, i32 change` |
| 1 CreateEvent | `str eventName, i32 p1, i32 p2, i32 p3, i32 p4, str parameter` |
| 2 ApplyStatus | `u8 status, f32 duration, i32 v1, i32 v2, i16 v3, u8 v4` |
| 3 UnlockSkill | `i32 skill, i32 level` |
| 4 Die | Empty |
| 5 GodModeSelf | `b enabled`; DEBUG only |
| 6 GodModeOther | `str name, b enabled`; DEBUG only |
| 7 Disguise | `i32 classId` |

## Legacy CreateEntity 5

The [retained client reader](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RebuildClient/Assets/Scripts/Network/IncomingPacketHandlers/Network/PacketCreateEntity.cs) and [CommandBuilder.AddFullEntityData](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/CommandBuilder.cs) are historical source, not a compatible replacement for 6. All current calls to `BuildCreateEntity` at this pin are commented out.

The historical writer's ordered branches are:

1. Common: `i32 id, u8 type, i16 classId, pos position, u8 facing, u8 state`.
2. Player/Monster/BattleNpc/PlayerLikeNpc: `u8 level, i32 maxHp, i32 hp`, then repeated `b true, u8 status, f32 duration` terminated by `b false`. PlayerLikeNpc uses fixed level/health and optional PushCart status.
3. Player/PlayerLikeNpc: `u8 headFacing, u8 headId, u8 hairColor, u8 weaponClass, b isMale, str name, i32 headTop, i32 headMid, i32 headBottom, i32 weaponId, i32 shieldId, i32 sp, i32 maxSp`. Only Player then adds `u8 hasParty` and, when 1, `i32 partyId, str partyName`; both add `u8 follower`. Other-player/PlayerLikeNpc SP can be placeholders.
4. NPC/BattleNpc: `str name, u8 displayType, b interactable, u8 effectType`. MaskedEffect adds `pos minimum, u8 width, u8 height` and one bit per area cell. VendingProxy adds `i32 ownerId`.
5. Moving state adds the movement record: start position, float real position, speed, first-step duration, total step byte, packed directions and move-lock bit.

The client exits immediately for Player/Monster after the common header, lacks the MaskedEffect area/mask branch, and has early-return NPC rendering paths. After a successful spawn it expects trailing `u8 eventType` and, for Toss, `pos tossStart`; the dead writer does not append this trailer. These discrepancies prevent presenting one complete agreed schema. Use the implemented [MemoryPack entity 6](wire-formats.md#memorypack-entity) for new Companion work.

## Evidence to obtain before implementing a gap

Select the exact source handler and writer from the catalogue, check its active caller and all authorization/configuration branches, then establish whether the deployed build uses it. Add synthetic fixtures for the full branch structure and verify the feature's observable response; do not infer success from a packet name or a writable socket. For enum-only/no-op/conflicting entries, first obtain a usable contract. The ordinary feature workflow is in the [overview](README.md#implementing-another-feature).

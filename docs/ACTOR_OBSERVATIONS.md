# Actor status and cast conditions

Conditions are data shared by combat policies, recovery item, skill and equipment rules, and routines. Existing profiles omit `conditions` and retain their previous behavior. A present array has at most 16 conditions; every condition must match. Unknown observations fail both positive and negative checks, including `ne`. Routine priority and rule order stay unchanged. Conditional attack policies guard that class even when its species is selected elsewhere. A matched ignore policy denies attack; an explicitly unmatched ignore policy is inactive and falls back to ordinary selected/combat policy. Any unavailable ignore observation blocks the class conservatively.

```json
{"field":"actorStatus","actor":{"scope":"self"},"statusId":8,"operator":"eq","value":false}
{"field":"actorCasting","actor":{"scope":"target"},"skillId":20,"operator":"eq","value":true}
```

`self` resolves the entered character. `target` resolves the owner's authoritative server-selected target from packet 33, including zero clearing it; a proposed route, queued skill or previous attack does not establish it. StopAction can clear that target, so a routine started after pausing may correctly report it unavailable. `candidate` is permitted only in monster policy conditions and resolves the alive observed monster currently being ranked. It never replaces `target`.

`actor` references contain `id`, a local world UUID and a local `incarnation`. Choose the visible actor in the editor to bind them. Saved/imported references remain verbatim and require explicit rebinding after departure, respawn, reconnect or map change. The UUID and incarnation are local observation ownership, not persistent game identities. No name, class ID or matching reused actor ID silently rebinds a condition.

When loadout automation owns equipment rules, it uses the same tri-state actor conditions as the ordinary scheduler. Matched rules remain eligible; known false rules are inactive. If no equipment rule matches and a relevant rule is unavailable, the loadout retains its prior gear and restoration state. Unknown evidence cannot imply `conditionEnd` or start restoration. Pending or uncertain equipment receipts keep their existing ownership fences, including the escape guard. Conditions are re-evaluated after authoritative target clearing; a previous target does not substitute for the cleared server selection.

## Supported evidence at the protocol pin

The authority is [4099e2c000c3c550516760b9c1241595aac9aceb](https://github.com/Doddler/RagnarokRebuildTcp/tree/4099e2c000c3c550516760b9c1241595aac9aceb). Integers are little-endian; booleans consume one bit without alignment. The decoder emits nothing until the complete owned packet passes bounds and trailing-byte validation.

| Evidence | Opcode / payload after opcode | Observation behavior |
| --- | --- | --- |
| Create entity | 6, bounded MemoryPack record including optional status dictionary | New local incarnation. Null and empty dictionaries both establish no active supported statuses. Cast remains unknown: no cast snapshot or replay exists. |
| Apply status | 61, actor i32, status u8, remaining f32 | Supported status becomes known present. |
| Remove status | 62, actor i32, status u8, refresh bool | Ordinary removal establishes absence. Refresh removal makes only that status unknown until the following apply. |
| Start target cast | 24, actor i32, target i32 (-1 allowed), skill/level/direction u8, caster i16 x/y, remaining f32, flags u8 | Known active cast until its estimated deadline. Flags validated against mask 15. |
| Start area cast | 25, actor i32, target i16 x/y, skill/level/size/direction u8, caster i16 x/y, remaining f32, flags u8 | Same actor cast state; ground position does not identify another actor. |
| Adjust cast | 26, actor i32, signed delta f32 | Adds or subtracts from an existing active cast deadline. Cannot create or revive an expired cast. |
| Stop cast | 27, actor i32 | Establishes idle casting state for a current live actor. |
| Cast circle | 28, position without actor identity | Does not supply actor casting evidence. |
| Direct skill result | 29 / 104, existing validated result layouts | A matching source and skill closes the observed active cast. Indirect results and damage/impact packets do not close it. This state update does not acknowledge a pending action by itself. |
| Owner target | 33, target i32 (0 clears) | Retained independently of bot routing; missing/dead targets remain unavailable. |

Statuses are supported only for normal player and monster actors (kinds 0 and 1). Other actor kinds lack a proved equivalent snapshot/delta contract. There is no inferred enemy HP/SP, hidden cast replay or hidden status state.

`src/actor-status-catalog.ts` contains the 60 statuses whose pinned handlers have non-None visibility. IDs follow ordered TOML tables, with None=0, statuses=1..75 and StatusEffectMax=76. Visibility names Owner/Ally/Everyone all use visible-player recipients at this pin; only None suppresses add/remove broadcasts. None statuses are unavailable even if a spawn contains them, because future transitions are not observable. Unsupported IDs: 7 Confusion, 12 ProvokeNoAtk, 20 SignumCrusis, 24 Pneuma, 38 AnkleSnare, 41 BlitzBeatRateUp, 43 VenomSplasher, 45 StormGustHitCounter, 56 ElementalConverter, 62 GuidedAttack, 66 SpeedUp, 67 Vampyrism, 68 Doom, 72 StopOwner, 75 StolenFrom.

The catalog was audited from [StatusEffects.toml](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig/ServerData/Skills/StatusEffects.toml), [StatusEffectGenerator](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig.Generator/StatusEffectGenerator.cs#L27), and handler attributes under `RoRebuildServer/RoRebuildServer/Simulation/StatusEffects`. Unhandled names default to None; handler names absent from the pinned TOML do not produce supported IDs.

## Duration, freshness and lifetime

The exact float32 maximum `3.4028234663852886e38` represents a permanent status. It has no local expiry. Finite seconds become local estimated deadlines, with safe finite arithmetic. Predicted expiry becomes unknown, not absent: Invisible and Quagmire can be extended silently and the server removes expired entries on subsequent updates. An ordinary removal or new complete spawn snapshot resolves the uncertainty. Refresh gaps remain unknown. No arbitrary per-status TTL is imposed on a long or permanent buff.

Casting starts unknown on every spawn. A start establishes an active cast; replacement starts supersede it. Predicted deadline expiry becomes unknown and never implies success. A direct matching result arriving after the estimated deadline can resolve it. Signed extensions arriving without an existing nonexpired cast remain unknown.

All predicates require the current compatible connected world and a valid game frame received within 15 seconds, matching the existing engine's stale-frame guard. Observation timestamps remain visible; UI dry runs advance evaluation time without refreshing the last game-frame time. Disconnect, character entry, clear, map change, actor removal, death and resurrection invalidate actor observations. Authoritative resurrection of a retained live actor starts a new incarnation with statuses and casting unknown; fresh deltas can establish individual evidence without implying a complete snapshot. A separate cache retains identity metadata for at most 150 visible player corpses until departure/world reset, allowing their authoritative revival to start an unknown incarnation as well. Only a spawn or that retained-actor revival creates a record; deltas for absent actors do not revive it. Internal records cap at 300 actors; snapshots cap at 64 actors. Policy evaluation retains up to 512 status entries; display publication caps them at 128, with an explicit truncation flag and unknown completeness. Display traces retain eight reports and four conditions per report, explicitly marking additional evidence omitted. Truncated status state cannot establish absence.

Local evaluation contexts carry world and incarnation fences. Controller socket generation already rejects data from a superseded connection. The raw protocol carries only actor IDs, with no sequence or incarnation, so a late frame for an old actor after identical-ID reuse on the same ordered socket is indistinguishable from a current frame. The implementation does not claim to solve that unavailable wire distinction.

Primary source details: [CharacterStatusContainer](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Simulation/StatusEffects/Setup/CharacterStatusContainer.cs) (`ExtendStatusEffectOfType`, add/remove and snapshot serialization), [StatusEffectState](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Simulation/StatusEffects/Setup/StatusEffectState.cs), [CombatEntity](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/CombatEntity.cs) (cast starts and `ModifyExistingCastTime`), [CommandBuilder](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/CommandBuilder.cs) and [Player](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/Player.cs) (owner target).

Source-shaped fixtures and local rule/boundary tests establish these contracts. The integrated macOS dry run on 2026-10-02 matched a self Blind-absent condition from the current spawn and reported self idle-casting unavailable, without executing a routine action. Live cast/status transitions, actor rebinding through the editor and reconnect behavior remain unverified against the deployed build. No new combat or automatic interruption command is introduced.

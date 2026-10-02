# Loot policy

Use **Combat & loot → Collect loot** to enable pickup. The single **Pickup scope** setting chooses **Only drops from your kills** (default) or **Loot all nearby drops**. The broader scope is opt-in and uses the existing `automation.loot.ownership: "all"` setting; profiles and native validation keep the same schema. Applying a profile does not start the bot.

Both scopes consider only observed ground items within the pickup radius and allowed field area. Item ignore/priority rules, verified collision paths, portal exclusions, route distance/time limits, the configured weight limit and one outstanding action owner still apply. Loot all does not grant server pickup rights. A sent Pickup is not counted until the matching own-character receipt arrives. Missing replies use the existing timeout and thirty-second target exclusion rather than retrying every tick.

## Drop order and own attribution

The pinned Rebuild source [Monster.Die](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/Monster.cs#L701) calls `DoMonsterDrops` before removing the monster. [Map.DropGroundItem](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Simulation/Map.cs#L1563) publishes a new-drop packet immediately. The prior client required a drop's receive timestamp to follow the confirmed death, so a one-millisecond gap in this normal source order could leave the item uncollected.

Ground-item packets contain no owner or contributor identity. Companion therefore uses bounded local correlation:

- A newly observed drop records its item/count/position and up to eight nearby owned engagements, including the own-character and monster world/incarnation identities. The radius is three cells.
- A confirmed owned death can associate a matching pre-death drop received at most two seconds earlier. Two seconds is a conservative client policy, not a server ownership guarantee. Existing new-drop announcements after a confirmed nearby death remain eligible.
- Kill/drop history lasts thirty seconds, with at most 64 confirmed kills and 256 new-drop observations. Old reveals, pre-existing drops, unrelated pre-death drops and contradictory same-ID metadata do not inherit ownership. Duplicate announcements do not refresh creation time. Changed metadata also invalidates in-flight pickup credit while the existing receipt/timeout owner stays pending.
- Temporary same-character resumes retain confirmed evidence, including a delayed new-drop announcement received while paused. A deliberate new Start, world refresh, map/connection change, own-character removal/replacement, death or resurrection clears it. Target replacement/resurrection retires its unconfirmed engagement evidence; already confirmed loot can remain when a different monster uses that ID.

An attack canceled before death does not establish an owned kill. Shared combat and unrelated new drops near an owned kill can still be ambiguous because the protocol lacks ground ownership data. The default is conservative rather than exhaustive; choose Loot all explicitly when broader observed-item pickup is desired.

## Server acceptance

The pinned [pickup handler](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Character/PacketPickUpItem.cs#L24) checks character action state, sitting, item existence, adjacency and loot priority, and can queue a pickup during attack cooldown. [Player.CanPickUpItem](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/Player.cs#L474) enforces inventory slots, resulting weight and regular-stack capacity. The client does not simulate acceptance or bypass these conditions. A refused pickup can remain visible until the bounded timeout; switching scope alone does not make the server accept it.

The regression suite exercises source-shaped Drop→Death→Pickup packets, actor zero, zero-HP targets, confirmed skills, stale/reused identities, temporary input yields, all-mode filters and pickup receipt/timeout ownership. These synthetic checks are separate from live gameplay proof.

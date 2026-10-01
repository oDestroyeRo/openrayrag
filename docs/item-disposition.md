# Protected item disposition preview

Issue #18 adds a pure preview in **Inventory & skills**. It does not send game
commands, start a supply trip or execute a workflow. Rules are saved, exported
and imported with the existing character profile. Older profiles have no rules
and preserve every item. Adding a rule also starts with every disposition off.

Each item ID has one rule. Quantities must satisfy
`0 ≤ keep ≤ minimum ≤ desired ≤ maximum ≤ 32767`. `keep` is a hard floor;
`minimum` triggers restocking; `desired` is the restock target; `maximum` retains
that quantity before any excess can move. Recovery-item `minStock` and the selected
wing reserve for enabled item-based emergency escape take
precedence when higher than the disposition maximum. An overlap is reported as
an unmet excess target rather than consuming protected stock.

Restocking starts only below minimum and uses the explicitly chosen source:
observed storage, observed cart, or the currently open buy shop. Excess uses
permitted storage, then cart, then sale. Known capacity limits may produce a
partial suggestion. An unknown preferred prerequisite blocks a fallback sale.
Unlisted items, equipped items, selected ammunition, refined items and carded
items stay protected. Unique items are protected by default. Explicit unique
permission still requires the exact bag ID and observed identity, zero
refinement and fully observed empty card slots. Unique equipment is never
represented as an interchangeable aggregate sale row. Buying new unique
identities is not planned in this slice.

Suggested actions are ordered by item ID, then source bag ID. The preview shows
quantities, source/destination, protected entries, exact source-model spending
and proceeds, conservative spending reservation, unmet targets and blocked
reasons. Unknown stock, capacity, current weight, price or permission is never
treated as zero or unlimited. The plan is limited to 32 actions.

## Verified source contracts

Capacity/handler reference: public Rayrag Rebuild commit
`4099e2c000c3c550516760b9c1241595aac9aceb`.

| Contract | Pinned source |
| --- | --- |
| Inventory 200 slots | `EntityComponents/Items/CharacterBag.cs`, `MaxBagSlots` |
| Storage 600 slots, no storage weight check | `Networking/PacketHandlers/NPCPackets/PacketStorageInteraction.cs` |
| Cart 100 slots, 80000 weight units | `Networking/PacketHandlers/Character/PacketCartInventoryInteraction.cs` |
| Withdrawal rejects full inventory even for an existing stack; merged count must be below 30000 | `EntityComponents/Player.cs`, `CanPickUpItem` |
| Shop buying may merge into an existing stack at the slot ceiling | `EntityComponents/Npc.cs`, `SubmitPlayerPurchaseFromNpc` |
| Classes 1/4/5/6 are regular; 2/3 are unique | `Data/DataLoader.cs`, item loaders |
| Normal shop/storage/cart handlers have no additional category or binding flag restriction | The three normal handlers above; `Npc.cs`, `SubmitPlayerSellItemsToNpc` |

All paths above are under `RoRebuildServer/RoRebuildServer/`. Item weights,
classes and sale prices come from the existing published-build catalog, with
its recorded hashes in `src/data/game-catalog.json`; no catalog values were
invented or regenerated. Player and cart current weights and player maximum
weight still require observed server statistics. Storage has explicit unlimited
weight semantics from this source contract; null means unknown everywhere else.

The planner uses existing workflow validators and exported quotes. The pinned
buy handler discounts the item ID while the game display discounts the price.
The preview estimates the exact source debit and reserves the higher of the two
nonnegative prices. Negative/overflow arithmetic blocks. Sale proceeds use the
source overcharge rounding, and ammunition has zero proceeds.

## Future executor boundary and verification limits

`planDisposition` accepts observed context and returns data only. A plan binds
the session/map/world revision and a canonical fingerprint of inventory,
container capacities, equipment, ammunition, stock floors, item metadata,
policy and transaction context. `revalidateDisposition` recomputes the plan and
rejects any changed prerequisite, altered action or blocked target. A future
executor must obtain fresh authoritative context before each action and replan
after each exact receipt. A matching revision alone cannot authorize execution.
`dispositionPreviewIsCurrent` only detects stale display data; it does not
authorize a transaction. No execution or retry path is implemented here.

The UI copies already observed GUID/card data from world container snapshots;
it does not fabricate data omitted from character telemetry. Unique inventory
disposition remains protected when its identity/cards are unknown. Actual server
version, source-model price discrepancy, storage/cart transactions and macOS
game interaction need a controlled live session before execution is enabled.
Synthetic tests and a native artifact build do not establish those live results.

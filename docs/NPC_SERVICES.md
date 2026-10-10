# Reusable NPC services

A service definition stores a versioned contract, stable name/map/anchor identity, walkable approach area, dialogue steps, budget/stock prerequisites and expected outcome. It contains no actor ID, bag ID, conversation position, currency snapshot or runtime receipt. Existing settings profiles are unchanged; services have their own local document, capped at20 entries/256,000 bytes. Imports receive fresh stable IDs; save/update does not start a visit. A definition/request is capped at65,536 UTF-8 bytes. Invalid fields, unsupported maps, blocked/portal approach areas, nonportable transfer steps and unbounded values are rejected.

The service editor is under **Workflows & social**. Choose a verified preset or saved definition, edit its JSON, and use **Preview**, **Save / update**, **Import document**, or **Export saved**. Name, budget, minimum stock and per-step timeout are editable policies. Identity, source, steps and outcome must exactly match a known contract to run. Other structurally valid definitions remain unavailable drafts; a saved name is not evidence that an arbitrary script has an adapter.

**Run service** clears field-run intent. One owner prepares → travels → approaches → locates → converses → waits for the outcome. Travel uses the existing Database adapter where supported and retains map permissions, portal exclusions and accepted-leg checks for walking. Final approach retains its copied target through verified server occupancy nudges and allows at most512 cells and five minutes; NPC visibility waits at most30 seconds; workflows retain their per-step deadlines, and the terminal outcome has a declared10–20 second deadline in the supplied presets. Missing actors wait with a reason; multiple exact matches reject ambiguity. Only kind2, exact name and verified anchor qualify. Actor ID, name, class, position, world generation and connection are bound freshly for the conversation. Disappearance, replacement, movement, foreign focus, death, unexpected world change or manual input cancels further steps. Stop has authority in every phase.

The source manifest supplies **21 contracts**: the original seven Kafra and two Field05 shop contracts, plus twelve town sell contracts.

| Contract | Identity | Exact outcome | Fee |
| --- | --- | --- | --- |
| Prontera South Kafra storage | prontera, Kafra Staff at151,29 | Storage-open snapshot; Basic Mastery5 prerequisite | 0 |
| Prontera South Kafra transport | Same identity | Izlude91,105; Geffen120,39; Payon161,58; Morroc156,46; Orc Dungeon/gef_fild10 52,326; Alberta117,56 | 0 |
| Field05 Tool Dealer buy/sell shop | prt_fild05, Tool Dealer at290,221 | Matching buy/sell shop-open snapshot | 0 |

The added ordinary traders all require the exact **Buy / Sell / Cancel** menu, select Sell at option1, open a matching sell shop and declare zero opening fees. Their names are case-sensitive; the two Prontera Flower Girls are distinguished by anchors.

| Map | Exact NPC and anchor | Verified approach cell | Registration |
| --- | --- | --- | --- |
| prontera | Vendor from Milk Ranch (73,134) | (72,133) | PronteraShop.txt:2 |
| prontera | Fruit Gardener (104,49) | (103,48) | PronteraShop.txt:6 |
| prontera | Vegetable Gardener (48,58) | (48,57) | PronteraShop.txt:11 |
| prontera | Butcher (64,125) | (63,124) | PronteraShop.txt:17 |
| prontera | Flower Girl (58,182) | (57,181) | PronteraShop.txt:21 |
| prontera | Flower Girl (113,42) | (112,41) | PronteraShop.txt:26 |
| prontera | Gift Merchant (105,87) | (104,86) | PronteraShop.txt:31 |
| prontera | Doll Supplier (248,153) | (247,152) | PronteraShop.txt:38 |
| prontera | Pet Groomer (218,211) | (217,210) | PronteraShop.txt:44 |
| prt_in | Tool Dealer (126,76) | (125,75) | PronteraShop.txt:71 |
| izlude | Fruit gardener (94,98) | (95,98) | IzludeShop.txt:2 |
| izlude | Butcher (105,99) | (104,99) | IzludeShop.txt:9 |

The contracts are verified against Rebuild commit `4099e2c000c3c550516760b9c1241595aac9aceb`. Approach areas/cells are checked against the bundled published collision grids and portal exclusions. These checks establish source and walking contracts; the added merchants' deployed identities, menus and sales remain unverified. Exact own arrival, not a broad distance tolerance, confirms transport. Same-map receipt support requires refresh followed by a living matching Warp spawn; no unverified same-map preset is supplied.

[Auto-sell supply trips](SUPPLY_TRIPS.md) can choose these merchants automatically or retain an explicit map/NPC. Automatic selection ranks permitted routes and walks, prefers the actual arrival map, and reranks on that map after Database arrival before approach. It never substitutes a player shop, unknown actor or arbitrary saved definition. Opening and every reopened sale batch still resolve fresh actor identity and menu; the catalogue does not persist actor IDs or prices.

An actual arrival with no verified walkable escape reports its map and cell separately from a merchant map-policy rejection. It holds the trip before NPC approach; it does not invent an escape path or repeat Database travel. The recovery guidance is Stop, normal manual Database relocation to a walkable cell, merchant correction, and explicit Start. The supply owner then admits at most one newly charged replacement attempt while preserving the original work cell, cumulative command/spending limits and economic fences. This recovery currently requires normal merchant travel; Butterfly/Return-skill departures are not replayed.

On 2026-10-02, SEA 01 returned the exact six-entry main menu `Save`, `Use Storage`, `Teleport Service`, an empty entry, `Recover Old Cart Items`, `Cancel`. The speaker, complete greeting, actor identity and storage option 1 were observed; opening empty storage produced no contradictory balance or inventory change, and closing was confirmed. This menu differs from the upstream pin and current upstream HEAD. Only the storage adapter accepts this additional exact menu. The catalog records its deployed observation separately from source provenance; no recovery entry is selected, no cart-rental variant is inferred, and transport retains its original source-only menus. A subsequent native service run automatically travelled from prt_fild08 to Prontera, completed its final approach, matched this menu and confirmed storage opening; explicit storage closure was then confirmed. No transfer was requested. Transfers and other deployed service outcomes remain unverified.

## Source evidence

- [Kafra.txt at the pin](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig/ServerData/Script/Npcs/Kafra.txt): lines8–34 define the exact greeting, speaker, menu and storage prerequisite; lines81–92 define the South transport menu; lines210–219 leave fee deductions commented out; line225 registers the South actor. Other Kafra actors share the same name and are excluded by the anchor. The main menu preserves its empty conditional cart slot; the only alternative is the source-declared Rent Push Cart label.
- [PronteraShop.txt at the pin](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig/ServerData/Script/Npcs/Shops/PronteraShop.txt): lines2–46 register the nine Prontera traders, lines48–57 the Field05 Tool Dealer and lines71–86 the prt_in Tool Dealer. [IzludeShop.txt](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig/ServerData/Script/Npcs/Shops/IzludeShop.txt): lines2–11 register the selected Fruit gardener and Butcher. [NpcTraderBase.cs](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/Npcs/NpcTraderBase.cs): lines8–27 use exactly Buy, Sell, Cancel with no initial dialogue and close each batch. Current stock/prices come from the authoritative shop packet; the service does not bake preset prices into transactions.
- [NpcInteractionState.cs](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/Npcs/NpcInteractionState.cs): lines119–142 open storage after database readiness; lines175–180 release focus; lines541–564 call WarpPlayer with1×1 dimensions. Focus release does not end normal storage. NpcEnd is a closing/cancellation response.
- [Player.cs](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/EntityComponents/Player.cs): lines2046–2084 preserve exact1×1 arrival. [World.cs](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Simulation/World.cs): lines838–861 change map; [PacketPlayerReady.cs](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/RoRebuildServer/Networking/PacketHandlers/Connection/PacketPlayerReady.cs): readiness activates self and sends experience, not a fresh full resource snapshot. Initial login sends full player/inventory data via CommandBuilder.InformEnterServer.

## Economic proof and limitations

The shared workflow receipt captures pre-step authoritative currency, every item/bag count and declared effects. The verified opening/transport presets have **zero economic effect**. Their exact typed outcome plus known unchanged authoritative resource observations can confirm them; no new resource snapshot is inferred from map loading or spawn. A contradictory charge or stock change leaves the outcome unconfirmed. A declared nonzero cost or inventory effect requires the actual exact updated balance/stock receipt; sending a request or receiving text does not satisfy it. Guessed paid variants of these presets are unavailable.

Storage transfers, shop rows and barter remain visit-only guarded operations. The service definition does not persist old bag selections or silently choose unique equipment. The pinned ordinary trader ends the interaction after one purchase/sale batch, so another batch needs a fresh visit. Opening a service does not implement desired-stock optimization, autonomous town trips or automatic combat resume; that supply-trip policy is a separate feature.

An uncertain sent request retains its economic fence across Stop and map/clear. Late responses can settle that receipt but never restart the canceled service. A fresh visit cannot replace an unresolved receipt. Unresolved escape similarly blocks service admission, and escape cannot preempt a service transaction. World loading alone never clears a service's uncertain receipt.

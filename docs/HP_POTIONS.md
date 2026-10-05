# HP and SP recovery items

In **Setup → Recovery**, select **HP** or **SP** under **Recovery item resource**. The list shows only currently carried items that directly restore that resource, including potions, food and herbs. HP and SP each keep their own mode, threshold, selections, reserves and cooldown. Choosing the resource changes the visible editor; it does not enable or disable either policy.

For each resource, choose:

- **Off**: leave item use to existing advanced recovery item rules.
- **Any carried HP/SP item**: use a recognized recovery item from inventory, starting with the cheapest published price.
- **Choose items**: select one or more carried items and move them earlier or later in the preference order. The next available selection is used when earlier stock is empty or at its reserve.

Set the resource threshold, reserve per item and shared cooldown. Keep the HP threshold above **Wait below HP**: the safety stop remains authoritative. A resource's shared cooldown begins after confirmed consumption and applies across its recovery items. Items that restore both resources start and honor both active cooldowns, even if the other resource selects different items; an eligible item that restores only one resource can still be used. An item selected for both resources keeps the greater reserve. A pending or uncertain use never triggers a speculative replacement. Inventory must be fully observed before use; a heal alone does not confirm consumption.

Selections and order are retained when switching resources or modes and closing/reopening the app. Depleted selections disappear from the inventory list but retain their preferences for restocking. Unknown inventory shows a waiting message; known empty inventory shows no carried items. Inventory updates never select replacements or send item commands. A first explicit Choose opt-in selects the first available carried item. Old settings remain compatible; SP use remains off unless configured. Both connection modes use the same scheduler and item command.

Advanced HP/SP item rules remain available in Inventory and take priority. An item configured there is exclusively governed by that rule's conditions, reserve and cooldown, even if it is also selected here. Recovery reserves are included in the existing transfer, supply and macro stock protections.

## Catalog and settings contract

The shared catalog contains 69 HP and 25 SP items, with 18 items in both lists. Effects come from [Rebuild's pinned item scripts](https://github.com/Doddler/RagnarokRebuildTcp/blob/4099e2c000c3c550516760b9c1241595aac9aceb/RoRebuildServer/GameConfig/ServerData/Script/Items/ItemEffects.txt), resolved through `ItemsUsable.csv` and matched to the pinned client by ID, name, item class and untargeted use mode. Unimplemented food, status-only items, speed items and teleport items are excluded. Classification does not assert live server healing amounts. The generator and source hashes are in `scripts/build-recovery-item-catalog.py` and `src/data/recovery-item-catalog.json`.

Reproduce the catalog from a Rebuild source checkout containing the pin:

```sh
python3 scripts/build-recovery-item-catalog.py /path/to/RagnarokRebuildTcp src/data/game-catalog.json src/data/recovery-item-catalog.json
```

The optional `automation.hpPotions` and `automation.spPotions` objects each have exactly five required fields. Existing `hpPotions` selections keep their schema and order; the accepted HP catalog now includes food and herbs. For example:

```json
{
  "mode": "selected",
  "itemIds": [501, 504],
  "belowPercent": 60,
  "minStock": 0,
  "cooldownSeconds": 5
}
```

`mode` is `off`, `any` or `selected`. Selected mode requires at least one unique recognized ID for that resource; the other modes retain optional preferences. Thresholds are integer 1–100, reserves 0–9999 and cooldowns 1–3600 seconds. Explicit null, missing fields and unknown fields reject. The existing settings version is retained; an absent policy remains compatible. TypeScript and Rust share the schema fixtures in `src/data/hp-potion-cases.json` and `src/data/recovery-item-cases.json`. Workflow stock rules permit up to 160 unique guards so combined recovery, advanced-item, ammo and escape reserves fit without dropping protections.

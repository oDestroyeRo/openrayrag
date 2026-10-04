# HP potions

In **Recovery → HP potions**, choose:

- **Off**: leave potion use to existing advanced recovery item rules.
- **Any carried HP potion**: use a recognized HP potion from inventory, starting with the cheapest published price.
- **Choose potions**: select one or more named potions and move them earlier or later in the preference order. The next available selection is used when earlier stock is empty or at its reserve.

Set the HP threshold, reserve per potion and shared cooldown. Keep the threshold above **Wait below HP**: the safety stop remains authoritative. The shared cooldown begins after confirmed consumption and applies across potion variants. A pending or uncertain use never triggers a speculative replacement. Inventory must be fully observed before use; a heal alone does not confirm consumption.

Selections and order are retained when switching modes and closing/reopening the app. Old settings remain disabled by default. Both connection modes use the same scheduler and item command.

Advanced HP/SP item rules remain available in Inventory and take priority. An item configured there is exclusively governed by that rule's conditions, reserve and cooldown, even if it is also selected here. Potion reserves are included in the existing transfer, supply and macro stock protections.

## Catalog and settings contract

The reviewed list contains Novice, Red, Orange, Yellow, White and the three condensed HP potions. SP, status, speed and teleport items are excluded. IDs and price ordering come from the pinned client item catalog; HP classification is cross-checked against the [primary classic item definitions](https://raw.githubusercontent.com/rathena/rathena/master/db/pre-re/item_db_usable.yml). The client export does not publish healing effects, so this list does not assert live server healing amounts. Source hashes and the shared ID list are in `src/data/hp-potion-catalog.json`.

The optional `automation.hpPotions` object has exactly five required fields:

```json
{
  "mode": "selected",
  "itemIds": [501, 504],
  "belowPercent": 60,
  "minStock": 0,
  "cooldownSeconds": 5
}
```

`mode` is `off`, `any` or `selected`. Selected mode requires at least one unique recognized ID; the other modes retain optional preferences. Thresholds are integer 1–100, reserves 0–9999 and cooldowns 1–3600 seconds. Explicit null, missing fields and unknown fields reject. The existing settings version is retained; an absent policy remains compatible. TypeScript and Rust share the schema fixtures in `src/data/hp-potion-cases.json`.

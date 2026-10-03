# Conditional macro scripts

Open **Setup → Macros & limits → Macro scripts**. Choose an example and **Load example**, edit **Script · JSON version 1**, then select **Validate & preview**. Preview validates the document and explains rule matches without sending commands; it does not confirm routes, NPC prices, storage capacity or learned skills. Review the current field settings and script, then explicitly select **Start macro** with a connected, verified, living character and all previous automation/actions stopped. **Stop macro** and the common **Stop bot** control stop the macro and its field automation.

A macro is versioned JSON data interpreted by Companion. It cannot execute JavaScript, shell commands or other code, add action types, load plugins, send arbitrary packets or call another script. Conditions select bounded sequences of the existing guarded field, travel, NPC, item and skill actions. This document describes implementation contracts; examples and local checks do not establish deployed-game proof.

## Version 1 document

Every field below is required. Unknown keys, unsupported step types and implicit defaults are rejected. `version` must be the number `1`. All numeric limits are integers unless a condition's table explicitly permits a fractional threshold.

| Document field | Contract |
| --- | --- |
| `name` | Nonblank string, at most 64 UTF-16 code units; ASCII control characters and DEL are rejected. |
| `durationSeconds` | 1–86,400 seconds for the entire macro, including waits and field monitoring. |
| `maxActions` | 1–1,000 issued macro steps, including `farm` and `travel`. Internal combat attacks, movement legs and transaction messages are governed by their own controller limits. |
| `maxSpend` | 0–2,000,000,000 zeny reserved across all `buy`/`store` steps. |
| `rules` | 1–32 rule objects. |

The compact serialized document is limited to 65,536 UTF-8 bytes. JSON data must have finite numbers, at most eight nesting levels, at most 16 keys per object and at most 64 entries per array; the specific rule/condition/step limits below are narrower. Comments, trailing commas, functions and expressions are not JSON.

Each rule requires exactly these fields:

| Rule field | Contract |
| --- | --- |
| `name` | Same string bounds as the document name; unique within the script. |
| `priority` | −1,000–1,000; the highest matching eligible priority wins. Equal priorities preserve document order. |
| `cooldownSeconds` | 0–86,400, measured from sequence selection. |
| `maxRuns` | 1–1,000 sequence selections for this rule. A selected attempt consumes an allowance. |
| `conditions` | 1–16 conditions, combined with AND. Every condition must match known observations. |
| `steps` | 1–16 ordered steps. The sequence must fit the remaining `maxActions` allowance before dispatch. |

A selected sequence owns execution until it finishes or fails; a later higher-priority rule does not interrupt it. Conditions select the sequence and are not re-evaluated as a prerequisite for each subsequent step. Each step still rechecks its action-specific state, permissions, resources and ownership.

## Conditions

Numeric comparisons use `lt` (`<`), `lte` (`≤`), `eq` (`=`), `gte` (`≥`) or `gt` (`>`). Ordinary numeric and map conditions contain exactly `field`, `operator` and `value`; inventory adds `itemId`.

| `field` | Operators and `value` |
| --- | --- |
| `hpPercent`, `spPercent`, `weightPercent` | Numeric comparisons; finite number 0–100, including fractions. |
| `level`, `jobLevel` | Numeric comparisons; integer 1–1,000. `level` is base level. |
| `zeny` | Numeric comparisons; integer 0–2,147,483,647. |
| `elapsedSeconds` | Numeric comparisons; finite number 0–86,400. During execution this is the macro's own elapsed clock. |
| `map` | `eq` or `ne`; map code of 1–64 ASCII letters, digits, underscores or hyphens. |
| `inventory` | Numeric comparisons; integer count 0–2,147,483,647 and integer `itemId` 1–2,147,483,647. |

For example, `{"field":"level","operator":"gte","value":20}` tests base level; `{"field":"inventory","itemId":501,"operator":"lt","value":5}` tests the observed Red Potion count. Missing inventory is unavailable, rather than zero. Once a complete inventory is known, an absent requested item has a known count of zero.

Observed actor predicates use the same bounded conditions described in [actor observations](ACTOR_OBSERVATIONS.md):

| `field` | Exact condition fields |
| --- | --- |
| `actorStatus` | `field`, `actor`, integer `statusId` 1–255, `operator` (`eq`/`ne`), boolean `value`. |
| `actorCasting` | `field`, `actor`, `operator` (`eq`/`ne`), boolean `value`; optional integer `skillId` 1–255. |
| `actorHpPercent`, `actorSpPercent` | `field`, `actor`, numeric comparison `operator`, finite `value` 0–100. |

`actor` is exactly `{"scope":"self"}`, `{"scope":"target"}`, or `{"scope":"actor","id":0,"world":"00000000-0000-0000-0000-000000000001","incarnation":1}`. The last form must use an actually observed current binding: nonnegative actor ID up to 2,147,483,647, lowercase hexadecimal world UUID and incarnation 1–2,147,483,647. The example UUID is a shape illustration only. `candidate` scope is not accepted in macro rules.

Unknown, stale, disconnected or replaced actor evidence never matches, including negative conditions. Actor resource evidence expires after 15 seconds; enemy SP is unavailable, while own/current-party SP requires verified evidence. Unsupported status/casting evidence remains unavailable rather than implying absence. A missing target does not stand in for self.

## Steps and admission limits

Every step requires `type` and integer `timeoutSeconds`. The timeout includes preparation and waiting for confirmation, not just transport dispatch. Map codes use the same format as map conditions. Item IDs and farm target class IDs are integers 1–2,147,483,647. Syntax validity does not prove that a map, item, target or skill is supported by the current game state.

| `type` | Additional required fields | Timeout |
| --- | --- | --- |
| `farm` | `map`; `targets` containing 1–64 unique monster species/class IDs. | 1–86,400 seconds to activate the field. |
| `travel` | `map`. | 1–86,400 seconds to verify destination arrival. |
| `buy` | `serviceId`, `itemId`, `quantity` (1–100,000), `maxSpend` (0–2,000,000,000). | 1–86,400 seconds for the service visit, transaction and confirmed close. |
| `store` | Same fields as `buy`, plus `keep` (0–100,000). | 1–86,400 seconds for the service visit, transaction and confirmed close. |
| `useItem` | `itemId`; uses one observed untargeted consumable. | 1–120 seconds. |
| `skill` | `skillId`, `level` (1–10), `mode` (`self`/`target`). | 1–120 seconds. |

Self skill IDs accept 1–32,767; target skill IDs accept 1–255. Skill 55 (Warp Portal) is excluded from macro steps. These syntax bounds do not bypass learned/granted skill, level, actual SP, motion, range, target lifetime or receipt checks. A target skill uses the verified combat target captured for that step; it does not acquire a replacement or permit arbitrary actor/ground targeting.

`farm` projects the script's map/targets over the settings captured at **Start macro**, retaining their combat, recovery, map policy and limits. It follows verified fixed portals when necessary, then confirms that field automation is active on the requested map. That confirmation starts ongoing farming; it does not mean farming has finished, and the step timeout is not a farming duration. Conditions continue to select later sequences from fresh observations while the field runs. Party-leader follow cannot own a macro map, and a farm stage conflicting with the captured map permissions or field lock area is rejected.

An empty selected-target draft uses the first farm step's targets for startup validation. A script with no farm step needs no monster selection and captures combat off when that empty draft would otherwise require targets. These projections leave the saved settings untouched; an explicitly configured combat-off or retaliation policy stays intact.

Another sequence suspends retained field intent until all its steps confirm. Item/skill and NPC transaction sequences can then return to that field through the usual guarded field-resume path. A confirmed `travel` clears retained field intent; use a following `farm` step to activate a field at the destination. A new `farm` replaces the previous field intent. Changing stages does not start a new run or renew session, kill, pickup or death allowances.

### NPC service and spending contracts

`serviceId` must be a built-in catalog ID with the matching opening outcome, not a saved service name or arbitrary NPC ID:

| Step | Current accepted service ID | Location/outcome |
| --- | --- | --- |
| `buy` | `tool-dealer-buy` | Prontera Field 5 (`prt_fild05`), verified buy shop opening. |
| `store` | `kafra-south-storage` | Prontera (`prontera`), verified storage opening. |

The controller resolves the NPC again, checks the exact [service contract](NPC_SERVICES.md), performs the guarded transaction and confirms shop/storage close before completing the macro step. `tool-dealer-sell` and transport service IDs are not accepted for these steps. Current pinned opening fees are zero; actual stock, prices, capacity and economics still require observations.

A buy requests `quantity` additional units. A store requests **at most** `quantity` units and retains at least `keep`, plus higher protected stock/disposition floors from the captured settings. Equipped, selected ammunition, refined/carded, unique and unknown items remain protected. No safely storable excess, insufficient capacity, changed NPC identity or contradictory resource evidence fails the step. Broader JSON quantity bounds do not override narrower shop, stock and transfer validators; in particular, a computed storage keep floor above 32,767 is rejected.

Each step's `maxSpend` must be no greater than document `maxSpend`. Its **full cap is reserved before dispatch**, including any service fee; the combined fee/item expense must fit that step cap. Reservations accumulate and are never refunded after a cheaper purchase, cancellation or sale. A later step whose reservation exceeds the remaining document allowance fails without dispatch. Account for every possible run of each spending rule when choosing the document cap.

## Examples

These are editable proposals, not verified routes or successful game transactions. Check map policy, selected species, learned skills, stock and prices before starting.

### Keep farming until a level rule selects another field

```json
{
  "version": 1,
  "name": "Leveling route",
  "durationSeconds": 3600,
  "maxActions": 3,
  "maxSpend": 0,
  "rules": [
    {
      "name": "First field",
      "priority": 10,
      "cooldownSeconds": 10,
      "maxRuns": 1,
      "conditions": [{ "field": "level", "operator": "lt", "value": 20 }],
      "steps": [{ "type": "farm", "map": "prt_fild08", "targets": [4000], "timeoutSeconds": 300 }]
    },
    {
      "name": "Next field",
      "priority": 20,
      "cooldownSeconds": 10,
      "maxRuns": 1,
      "conditions": [{ "field": "level", "operator": "gte", "value": 20 }],
      "steps": [
        { "type": "travel", "map": "prt_fild07", "timeoutSeconds": 600 },
        { "type": "farm", "map": "prt_fild07", "targets": [4000], "timeoutSeconds": 300 }
      ]
    }
  ]
}
```

After the first farm activation confirms, the macro monitors base level while farming continues. At level 20 it settles existing actions/movement, travels and activates the next field. If every rule/action allowance is then exhausted, the confirmed field remains monitored until macro duration ends or Stop; these macro allowances do not replace the configured field-run limits.

### Buy potions, store excess loot and use a potion

```json
{
  "version": 1,
  "name": "Field supplies",
  "durationSeconds": 3600,
  "maxActions": 12,
  "maxSpend": 1200,
  "rules": [
    {
      "name": "Activate field",
      "priority": 0,
      "cooldownSeconds": 0,
      "maxRuns": 1,
      "conditions": [{ "field": "level", "operator": "gte", "value": 1 }],
      "steps": [{ "type": "farm", "map": "prt_fild08", "targets": [4000], "timeoutSeconds": 300 }]
    },
    {
      "name": "Buy Red Potions",
      "priority": 50,
      "cooldownSeconds": 60,
      "maxRuns": 2,
      "conditions": [
        { "field": "inventory", "itemId": 501, "operator": "lt", "value": 5 },
        { "field": "zeny", "operator": "gte", "value": 500 }
      ],
      "steps": [{ "type": "buy", "serviceId": "tool-dealer-buy", "itemId": 501, "quantity": 5, "maxSpend": 500, "timeoutSeconds": 600 }]
    },
    {
      "name": "Store Jellopy",
      "priority": 40,
      "cooldownSeconds": 60,
      "maxRuns": 2,
      "conditions": [{ "field": "inventory", "itemId": 909, "operator": "gte", "value": 20 }],
      "steps": [{ "type": "store", "serviceId": "kafra-south-storage", "itemId": 909, "quantity": 10, "keep": 10, "maxSpend": 100, "timeoutSeconds": 600 }]
    },
    {
      "name": "Use Red Potion",
      "priority": 100,
      "cooldownSeconds": 10,
      "maxRuns": 5,
      "conditions": [
        { "field": "hpPercent", "operator": "lt", "value": 60 },
        { "field": "inventory", "itemId": 501, "operator": "gte", "value": 1 }
      ],
      "steps": [{ "type": "useItem", "itemId": 501, "timeoutSeconds": 30 }]
    }
  ]
}
```

Two buy reservations of 500 and two store reservations of 100 fit the 1,200 document cap. Higher-priority recovery or supply rules can run before the first farm rule if they already match. Once a field is retained, confirmed transaction/item sequences permit the guarded return to it. Store quantities may be smaller because of protected stock floors.

### Use First Aid on self

```json
{
  "version": 1,
  "name": "First Aid",
  "durationSeconds": 600,
  "maxActions": 5,
  "maxSpend": 0,
  "rules": [
    {
      "name": "Recover with First Aid",
      "priority": 100,
      "cooldownSeconds": 10,
      "maxRuns": 5,
      "conditions": [
        { "field": "hpPercent", "operator": "lt", "value": 60 },
        { "field": "spPercent", "operator": "gte", "value": 30 }
      ],
      "steps": [{ "type": "skill", "skillId": 2, "level": 1, "mode": "self", "timeoutSeconds": 30 }]
    }
  ]
}
```

First Aid is skill ID **2**, level 1, with a pinned catalog cost of 4 SP. The percentage condition does not prove enough absolute SP or that the skill is learned; action admission still checks both. This script has no `farm` step and does not start combat. When appended to a farming script, a confirmed self-skill sequence can return to the retained field.

## Stop, failures and run limits

Unknown observations leave a rule unmatched/unavailable; they never fabricate HP, SP, inventory, level or actor state. When no eligible rule matches, the macro waits or monitors its retained field within the duration and runtime evaluation budgets. Exhausting all rule/action allowances completes a macro without a retained field; a confirmed retained field can continue in monitoring state until duration or Stop. The internal rule-evaluation guard can also fail execution if exhausted. A backward/unavailable clock fails the macro. Duration expiry completes an idle/monitoring macro, but fails an unconfirmed step. Step timeout, rejection or uncertain result fails execution and never automatically retries that request.

Stop cancels local sequence/field intent and future dispatch. It cannot undo an already transmitted attack, purchase, transfer, item use or skill. Existing movement/resource receipts and uncertainty fences remain owned until appropriate authoritative settlement; delayed replies cannot restart a stopped sequence. Reconnect, disconnect, character/session replacement, unexpected map/world transitions and actual official-game action takeover terminate the macro rather than replaying or resuming it. Verified macro/service travel, supply, escape and death-recovery transitions retain their existing transition owners.

The settings captured at **Start macro** continue to govern field hours, HP/SP recovery, emergency escape, map restrictions and run/death allowances. Farm transitions share the same run counters. A dead character waits for configured guarded respawn/recovery, or for manual revival when respawn is disabled or the death allowance blocks another attempt. Changing script stages does not renew that allowance. Stop and a new explicit Start begin a new run only after pending actions settle and the character is eligible. Time spent waiting still counts toward macro duration and an outstanding step's deadline.

## Saving and restart behavior

**Save on this Mac** validates and saves one script draft locally. Loading an example, editing, saving and previewing never starts automation. Unsaved edits are marked; save or copy them before closing. If saved data is invalid, the UI reports the error and keeps that stored document until you explicitly save a valid replacement.

The draft contains script data only, with no credentials, active sequence, run intent, counters or resource receipts. It is separate from named settings profiles. Reopening/restoring the draft does not resume a macro or its farming, and reconnect does not automatically start it. Review current observations and explicitly select **Start macro** again. Installed updates also wait while a macro is active or its editor has unsaved changes.

## Evidence owners

The contract and rule runtime live in `src/macros.ts` and `src/routines.ts`; `src/controller.ts` owns guarded execution and receipts. `src/macro-ui.ts` owns previews and draft persistence; native validation checks the same request boundary. Local schema/runtime/controller/UI tests and the [feature verification record](LOCAL_FEATURE_VERIFICATION.md) describe available proof. No example above establishes live leveling, travel, NPC economics, item consumption, skill recovery or network-loss recovery.

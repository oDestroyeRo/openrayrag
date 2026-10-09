# Bot scripts

**Setup → Form** and **Setup → Script** are two views of one configuration. Form is the usual set of controls. Script shows those same settings as readable commands, with optional rules beneath them. You can configure everything in Form, convert it to Script, and add a rule without maintaining a second setup.

## Get started

1. Stop the bot and open **Setup → Script**. The editor contains your retained map, targets and settings, including options configured before a character is connected.
2. Add an example or write a rule. Comments begin with `#`; indentation makes a script easier to read but does not change its meaning.
3. Select **Validate & preview** to check the script and see which rules match the latest observations. Preview sends no commands.
4. Valid edits update Form and save the source automatically. Return to **Form** to see the same settings; Form edits update Script while preserving its comments and rules. Incomplete or invalid text leaves the last valid configuration intact. Correct it or select **Discard draft** before returning to Form or starting.
5. Select the common **Start bot** control. A settings-only script starts ordinary field automation; a script containing rules starts those rules with the settings shown in the editor. **Stop bot** stops either.

Loading, editing, converting, saving and restoring a script never start automation. The editor reports syntax errors with a line number. A preview can check a rule's observed conditions; game actions still require a ready character, known resources and confirmation.

## Settings without JSON

The editor exports every current setting. These are some of the common lines:

```text
script "My field setup"

set map = prt_fild08
set targets = [4000, 4012]
set radius = 12
set loot = true
set route_randomWalk = 2
set route_step = 10
set route_avoidWalls = true
```

`set` changes one setting. Strings can be bare words or quoted text; quote text containing spaces or `#`. Lists use square brackets. Booleans are `true` and `false`. Every document begins with `script "Name"`. Add advanced options below that header using their full setting path, so conversion retains recovery, equipment, party, movement, schedules and safety policies:

```text
set automation.combat.mode = selected
set automation.recovery.enabled = true
set automation.recovery.hpStart = 60%
set automation.recovery.hpEnd = 85%
set automation.recovery.spStart = 10%
set automation.recovery.spEnd = 80%
set automation.recovery.timeoutSeconds = 5m
set automation.limits.minutes = 1h
set automation.follow.name = "Friend #1"
```

Lists of rules use an index starting at zero:

```text
set automation.items[0].itemId = 501
set automation.items[0].resource = hp
set automation.items[0].belowPercent = 60%
set automation.items[0].minStock = 0
set automation.items[0].cooldownSeconds = 10s
```

Use Form for creating complex settings, then open Script to obtain the complete configuration. A short script written from scratch uses Companion's defaults for omitted settings. An empty list is `[]`; an optional empty value such as a field rectangle is `null`. Unknown settings, duplicate assignments and incomplete rules are reported rather than silently ignored.

## Add a rule

A rule has a name, conditions introduced by `when`, and one or more actions in execution order. All its conditions must match. Higher priority wins; a selected sequence finishes before another rule begins.

This example starts a field once, then monitors First Aid:

```text
script "Farm and recover"
set map = prt_fild08
set targets = [4000]

# Whole-script limits. Each action still has a timeout.
duration 1h
actions 20
spend 0

rule "Start farming"
  priority 10
  cooldown 10s
  runs 1
  when level >= 1
  farm prt_fild08 targets [4000] timeout 5m
end

rule "First Aid"
  priority 100
  cooldown 10s
  runs 5
  when hp < 60%
  when sp >= 30%
  skill 2 level 1 self timeout 30s
end
```

The farm action confirms that field automation is active; it does not wait until farming finishes. Later rules can select while that field is monitored. First Aid still requires the learned skill and sufficient actual SP. A settings-only script does not need a `rule` block.

## Conditions and actions

| Condition | Example |
| --- | --- |
| Resources | `when hp < 60%`, `when sp >= 30%`, `when weight > 80%` |
| Character | `when level >= 20`, `when jobLevel < 10` |
| Money and time | `when zeny >= 500`, `when elapsed >= 5m` |
| Map | `when map == prt_fild08` |
| Inventory | `when inventory 501 < 5` |
| Observed actor | `when actor self status 29 == true` |

Comparisons are `<`, `<=`, `==`, `>=` and `>`; map and actor boolean conditions also support `!=`. Missing observations do not match, including negative conditions. Exact actor identities and additional observed actor conditions are preserved when converting an existing macro.

| Action | Example |
| --- | --- |
| Farm | `farm prt_fild08 targets [4000] timeout 5m` |
| Travel | `travel prt_fild07 timeout 10m` |
| Consume one item | `use item 501 timeout 30s` |
| Use a skill | `skill 2 level 1 self timeout 30s` |
| Buy | `buy 501 quantity 5 from tool-dealer-buy spend 500 timeout 10m` |
| Store | `store 909 quantity 10 keep 10 at kafra-south-storage spend 100 timeout 10m` |

Map codes and item, monster and skill IDs are the same values shown by the existing controls and game catalogs. NPC service names select Companion's existing verified service contracts. A buy/store action reserves its declared spending cap, including fees, before it starts. Set the whole-script `spend` allowance high enough for every allowed reservation.

## Limits, saving and existing macros

Use `s`, `m` or `h` for durations and `%` for percentages. Counts and IDs remain numbers. Settings use their own units: for example, `automation.limits.minutes = 1h` means 60 minutes, while `timeout 1m` means 60 seconds.

For scripts containing rules, `duration`, `actions` and a rule's `runs` accept `unlimited` (or `0`). Each action still has a finite positive timeout, and the configured health, recovery, death, schedule and field-run limits remain active. `spend 0` allows no spending. A settings-only script uses `set automation.limits.minutes = 1h` for its run duration; macro-only limit commands require a rule. Stop and unconfirmed-action handling retain the existing execution behavior.

Existing saved version-1 JSON macros are converted into readable source using the current retained settings. Legacy JSON can also be imported. Comments are preserved when saving source and when graphical setting edits update the settings portion of a script. Incomplete or invalid text is retained until corrected or discarded; telemetry and delayed settings restoration cannot silently overwrite it. A valid Script settings edit also takes precedence over delayed native restoration. Closing waits for invalid or unsaved source. If saving fails, the shared configuration stays updated: retry **Save script**, or copy your text and use **Discard draft** to return to the last saved rules while retaining the current Form settings.

The current settings form remains the persisted settings owner. Restoring the editor refreshes its settings from that form and retains the saved rules; cached editor settings cannot replace newer saved form values. Saving/restoring never resumes a running macro.

See [compiled macro contracts](MACRO_PROTOCOL.md) for legacy JSON, exact limits, actor identities, travel and spending behavior. Installed-app persistence and live game execution require separate verification from parser, UI and controller tests.

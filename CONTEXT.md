# Rayrag Companion

A companion for configuring and observing a character’s field automation in Rayrag.

## Language

**Settings form**:
The editable bot configuration and selected profile retained on this Mac. It represents the user’s choices independently of an active run or a currently observed character.
_Avoid_: Session state, run state

**Configured targets**:
The monster species selected for the configured field, including choices retained before the character and map are ready. Eligibility in an observed field does not erase those choices.
_Avoid_: Current monsters, visible targets

**Field settings**:
The settings projected for the currently verified field and eligible selected monster species. These may differ from the retained settings form while a character or map is unavailable.
_Avoid_: Saved settings

**Profile**:
A named, validated collection of bot settings that can be applied to the settings form. Selecting or applying a profile does not start automation.
_Avoid_: Character session

**Run intent**:
The user’s request to continue field automation subject to its configured limits and unresolved actions. A temporary wait does not itself create a new run or renew its allowances.
_Avoid_: Running status

**Macro script**:
A validated, versioned JSON document whose conditions select bounded ordered sequences of existing game actions. The saved document is separate from active execution and credentials; saving or restoring it never starts automation.
_Avoid_: Executable code, profile

**Macro field intent**:
The field activated by a confirmed farm step and retained while later conditions are monitored. Temporary item, skill or NPC sequences suspend that intent; confirmed travel clears it. Every stage shares the original run allowances and existing action receipts.
_Avoid_: New run, completed farming

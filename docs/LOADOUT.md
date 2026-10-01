# Ammunition and equipment policy

Enable this policy in **Inventory & skills**. It is disabled for new and older
profiles. Automatic ammo selection supports verified bows and arrows. Preferences
are ordered choices, not an allowlist: remaining compatible stacks follow, with
the currently equipped stack preferred among equal choices. Unknown compatibility
or equipment identity prevents automatic action.

The client gates new attacks and equips on observed ammo stock above the reserve.
At the reserve, unknown stock, or a server ammo fault, it sends Stop once and waits
for authoritative target clear plus fresh eligible stock. A compatible alternate
stack can then be selected. The server performs continuous attacks: shots already
in flight can consume stock before Stop arrives, so this is not a strict per-shot
reserve guarantee. A timeout never confirms Stop or equipment success.

Conditional equipment changes capture the prior item identities and slot layout.
Unique equipment uses GUID plus item ID; a new bag ID alone is not a new identity.
Restoration handles displaced offhand, accessory and headgear slots through
ordered confirmed changes. Missing prior items, ambiguous identity or a manual
equipment change cancels restoration. Manual overrides leave automation waiting
until an explicit new run. Stop cancels future changes. Sent equipment requests
retain their receipt after cancellation, timeout, map refresh and same-character
death/revival; an exact later confirmation reconciles the receipt without replay.
Emergency escape waits behind unresolved equipment changes.

Stock and equipment ownership stay in runtime memory, outside profiles. The
disposition preview protects selected ammo and the configured reserve for all
verified compatible arrow alternatives.

## Source and proof boundaries

The catalog extends the weapon metadata at Rebuild pin
`4099e2c000c3c550516760b9c1241595aac9aceb`: 493 weapons, 40 ammunition entries
and 555 equipment requirement entries, identity-matched to the published item
snapshot. `scripts/build-weapon-catalog.py` records input hashes and reproduces
the data. Only Bow class 12 to Arrow type 0 normal attacks are verified here;
other ammo categories do not establish gun or skill consumption rules.

The pinned exporter omits ammunition subtype and position. Classification comes
from the matching server CSV. CSV minimum levels are conservative client policy:
the pinned weapon loader does not populate its runtime minimum level, and the
ammo equip handler does not enforce the CSV minimum. Job-group evaluation follows
the source loader order; unknown groups block automatic equipment changes.

ServerEvent 91 is subtype byte, signed value, and a length-prefixed UTF-8 string.
Subtypes 2/3/4 report missing, wrong or exhausted ammo. ChangeTarget 33 reports the
own character's target ID or zero for clear; opcode 43 instead reports incoming
monster aggression. An idle Stop has no universal acknowledgement.

Automated fixtures cover source-shaped packets, malformed boundaries, equipment
identities and slots, reserve handling, late manual acknowledgements, and receipt
ownership across interruptions. Live bow firing, restoration, and reserve timing
require a controlled bow session; melee gameplay does not establish those results.

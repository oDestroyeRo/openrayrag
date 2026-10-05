# Defending against monsters

In **Setup → Combat → Attack monsters**, choose:

- **Only monsters attacking me** to defend without choosing monster species.
- **Selected monsters + monsters attacking me** to keep farming selected species and defend against other eligible attackers.

Only selected monsters and Combat off retain their existing behavior. The mode is saved with current settings and profiles; restoring settings never starts the bot.

Defense requires an observed normal monster attack or a direct targeted damaging monster skill against the current character. Healing, indirect/conflicting damage ownership, ground effects and hits without an identified attacker cannot establish a source. Being nearby, appearing on the minimap or attacking another player is not sufficient. Evidence belongs to both observed actor lifetimes, so death, replacement, revival or a world change cannot transfer an old attack to a new character or monster.

At the next safe target selection, reachable eligible attackers take priority over ordinary selected monsters and new loot. Monster priority and route cost still choose between attackers. Once attack-skill prerequisites are ready, an unreachable attacker does not block other reachable work. Unavailable prerequisites retain the existing wait of up to 30 seconds and failed-target cooldown. Normal attacks and configured species attack skills use the same defense tier.

An unsent route can change its goal while its already dispatched movement leg retains its acknowledgment and deadline. A sent pickup, item, cast, retreat or current attack engagement keeps its existing owner. Defense does not cancel an uncertain action, reset skill budgets or restart the run.

Ignore rules, conditions, maximum level difference, scan radius, allowed map/field area, engagement ownership, collision/line of sight and target timeout still apply. HP recovery and death/run limits remain authoritative. This option attacks monsters, not other players.

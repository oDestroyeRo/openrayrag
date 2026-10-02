# Stationary cast availability recovery

The shared own-cast fence remains conservative after execution shapes that can
also be emitted by unmarked equipment or card procs: Increase Agility 42/self/1,
Decrease Agility 43/target/1 or 3, and Jupitel Thunder 96/target/3, 5 or 10. A
matching resource result can confirm its existing scheduler receipt without
establishing general cast availability. Fresh SP, inventory, status, elapsed
duration, cast extensions, ordinary Stop and generic failure never clear the
cast fence.

For an existing explicitly requested run, Companion automatically sends bounded
ordinary Look commands while stationary. A valid own non-center Look broadcast
independently establishes cast availability. It does not acknowledge a particular
probe, skill, item, transaction, movement or resource reservation. The same
evidence can come from an official manual Look or an earlier request that the
server processes after casting finishes. No private nonce is invented and no
castStop or resource event is synthesized.

## Source and ordering contract

The authoritative source is Rebuild commit
`4099e2c000c3c550516760b9c1241595aac9aceb`, matched to the supported deployed
client. Paths below are under `RoRebuildServer/RoRebuildServer/` unless stated.

- `Networking/PacketHandlers/Character/PacketLookTowards.cs:14–34` checks a
  living player and normal character-action eligibility, adds input delay,
  reads direction/head, then changes facing. Its vending exception can bypass
  the cast gate, so vending authority is a necessary part of the proof.
- `EntityComponents/WorldObject.cs:574–590` rejects moving/dead state and emits
  facing/head. Look changes cosmetic facing/head and input cooldown; it does
  not move, clear a target, remove spawn immunity or consume a resource.
- `Networking/CommandBuilder.cs:909–930` emits opcode 13, actor i32, two signed
  i16 look-at coordinates, direction 0–7 and head 0–2. The reply is exactly 11
  bytes. Coordinates may lie outside map bounds. The ordinary request is three
  bytes: opcode, direction, head. Automatic probes preserve the captured
  CastStart facing and use non-center head 1.
- The pinned normal release inbound/outbound queues are FIFO and Look executes
  synchronously. See `Networking/NetworkManager.cs:360–382,445–482,890–926`
  and `3rdParty/NetQueue.cs:98–108`. An older emitted Look precedes a newer
  CastStart; a later CastStart immediately renews the fence. Debug simulated
  lag queues do not provide this release ordering contract.
- `EntityComponents/Player.cs:2127–2140` rejects current casting, NPC interaction,
  disabled/dead state and input cooldown. Accepting Look proves that particular
  availability gate, not full skill/SP/after-cast readiness. Normal dispatch
  guards still apply afterward. Silent rejection proves nothing.

Incoming events apply in wire order to the current connection and observed own
actor lifetime. Foreign actors, center-head Look, malformed bodies and obsolete
connections cannot release the fence. No look-at position is used for navigation
or resource attribution.

## Durable vending authority

Authority starts unknown on every new transport. Its first Enter followed by a
matching own player kind0 entry1 initialization establishes a non-vending
baseline. The pinned login creates a new player runtime; database restoration
does not restore NPC/vending state, and disconnect removes the previous runtime.
Intervening NPC/vending events are preserved even if they precede that spawn.
Initial HP0/dead state still identifies this new runtime; automatic probes
separately require a currently living own actor with positive HP. A later
entry2 respawn preserves the existing baseline but cannot create one by itself.

Own vending105 marks active vending. NPC activity remains held until the
authoritative recipient NPC-end event. Sending VendingStop, its106 reply,
WorldState defaults, map changes, clear, respawn and own-spawn replacement do not
manufacture an exit or reset this transport-level authority. Unknown or vending
authority cannot make Look eligible availability.

## Bounded ownership and dispatch

One sender-free policy captures own identity, cast revision, original duration
hint and facing. It reserves an attempt before transport, including a send that
throws after writing. It sends at most six probes, at least one second apart,
within one immutable ten-second window starting after the original duration
hint plus a 250ms scheduling margin. Extensions, panel-input grace and readiness
delays cannot renew that window or settle the cast. Exhaustion retains the fence
and an explicit waiting reason. A send exception stops new probes without replay.

The policy runs before escape/death wait cycles. An unsent escape preparation may
wait on the same fence while recovery probes proceed. Pending/canceled skill or
item receipts can coexist with this resource-free query, keeping their exact
identity and outcome. Sent escape, movement, NPC/economic, service, travel,
workflow, supply, socket/memo/social and competing command owners retain
exclusivity. Receipt, physical movement, session, engagement and death clocks
continue; the requested run and configured death limit are never reset.

Positive eligible Look stops automatic probes and holds ordinary dispatch for
`(N + 1) * 100ms + 100ms`, where N includes all possibly transmitted probes,
including retired cast episodes and send exceptions. This conservative timer
drains aggregate input delay under the normal progressing server clock. It
never clears an unresolved cast or resource receipt. The numeric outstanding
input accounting stops further queries at 64 until authoritative availability
and its cooldown drain settle it.

Other authoritative cast outcomes and same-connection actor/world retirement
also preserve possibly sent Look debt. StopCast, accepted own walking,
CounterAttack ResetMotion, reliable completion, a newer cast, map/clear and
own-lifetime replacement can retire the cast through their existing contracts,
but they cannot discard this independent input-delay hold. With outstanding
probes, the same conservative duration starts once; unrelated frames do not
renew it. Without probes, the existing retirement behavior adds no new delay.
Only a new transport can discard debt from the previous player runtime.

A generic retirement does not prove the full common action gate is open. This
hold drains only additional possibly sent Look delay, preserving ordinary
after-cast/motion/freshness/body/resource guards. At the source pin, Antonio
Card can trigger Teleport's 0.50 input delay before a delayed Look batch, and
ordinary Stop can add another 0.20 while bypassing the cooldown check. Dropping
the six-probe debt during clear/entry2 could then cause an item request to be
silently rejected. The regression blocks that fresh request until the independent
drain, and still requires its actual inventory result to confirm the receipt.

Trusted panel input delays decisions within the original window. Official
Look13 and official gameplay sends stop the current automatic episode and keep
manual grace; only their first opcode is inspected, without retaining private
payloads. The injected Look uses the normal serialized bridge/socket transport
and updater dispatch lease. Look is separate from ExpandedAction and is not a
new public manual, profile, routine or resource-scheduler action. Native manual
validation remains unchanged and does not expose Look.

Stop and transport replacement disarm automatic recovery. Late valid Look may
settle existing availability and input delay, but cannot resume a stopped run.
Automatic reconnect cannot arm new probes without a newly authorized explicit
Start. No runtime identities, probe attempts or requested run are persisted in
settings or profiles.

## Verification and limits

Raw-controller regressions cover actual automatic Increase Agility through
resource confirmation, Look, continued combat and pickup; all six ambiguous
shapes with own actor0/1; ordered older/manual Look and newer CastStart;
pending/canceled resources; aggregate cooldown; ignored/exhausted probes;
send-then-throw; manual input; Stop/reconnect; vending across clear and106;
unsent threat escape; the existing one-death cap; and the original minute limit.
Non-Look retirement tests cover StopCast, own walking, CounterAttack111, reliable
completion, clear/entry2, map entry, lifetime replacement, send exceptions and
Stop, including resource dispatch only after debt drain and exact inventory ACK.
Protocol and actual bridge boundary tests validate strict bodies, signed
coordinates, prototype sending and updater gates. Sender-free tests cover
initialization provenance, intervening NPC/vending events and finite accounting.

These budgets and cooldown margins are client policy, not server acknowledgments.
An independent public-client audit on 2026-10-02 verified the served
`Build_2569-09-01-01-55` WASM SHA256
`6f00155f49675b0737f04fa0465fa8df3403c084ff07a842efe3424008453195`:
the Look sender/reader, non-center heads and vending/NPC handlers match the wire
contract. This establishes public-client compatibility, not the deployed
server's gating/FIFO behavior or a live successful recovery.

Unknown baseline, active vending/NPC, silent rejection, retained resource
uncertainty and unsupported server changes can still require an explicit wait.
This does not promise universal recovery. Native packaging, independent review
and deployed live recovery are separate proof surfaces and are not established
by the synthetic tests.

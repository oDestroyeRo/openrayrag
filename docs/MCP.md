# Local MCP access

Companion can host an optional Model Context Protocol server for an AI assistant. Open **Settings → AI assistant connection (MCP)**. Leave **Allow bot controls** unchecked for read-only access, or check it before enabling to allow configuration, sign-in and the existing bot/client actions. The grant is locked while enabled; disable and enable again to change it. The server and control grant are disabled on ordinary launches and after the main view reloads or closes. Browser preview cannot enable them.

Copy the displayed endpoint and use **Copy access token**. Configure a Streamable HTTP client with a custom authorization header:

```json
{
  "url": "http://127.0.0.1:<displayed-port>/mcp",
  "headers": { "Authorization": "Bearer <copied-access-token>" }
}
```

Every enable binds an ephemeral loopback port and generates a new random bearer token. Disable revokes the token and pending authority. Neither setting nor token is stored on disk. With bot controls granted, possession of the token permits configuration changes, sign-in, spending through existing guarded actions and Start/Stop. Keep it private. The server does not expose saved passwords or auth tokens in tool results, operation receipts or logs. Sign-in can reuse a matching locally saved password without revealing it.

Clicking Disable or closing the main view immediately blocks local assistant writes, including writes awaiting native claim. If disabling fails, writes remain blocked until a new control enable succeeds. A later grant cannot revive a request from the previous grant.

Every HTTP method authenticates before reading its body. `Host` must equal the displayed `127.0.0.1:<port>` authority. A non-browser client may omit `Origin`; a supplied Origin must exactly equal `http://127.0.0.1:<port>`. Other hosts/origins are rejected. No cross-origin browser or network hosting is enabled; loopback uses HTTP.

## Tools

The pinned official Rust SDK `rmcp = 3.5.1` owns MCP framing, discovery and stateless JSON Streamable HTTP. Supported protocol versions are `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` and `2026-07-28`. The 2026 version uses `server/discover`; older versions use `initialize`. There is no SSE subscription or persistent MCP session. Rust 1.88 is the declared SDK minimum; the tested repository toolchain is 1.98.1.

Results contain structured content plus matching text. Unknown argument properties, malformed arguments, unknown tools and oversized data are rejected. Read tools remain available with either grant. Mutating tools are advertised with their actual control annotations and require the bot-control grant on every call; their annotations do not confer authority.

| Read tool | Arguments | Result |
| --- | --- | --- |
| `get_status` | `{}` | Freshness, connection, character/map, run intent/limits and published action/Apply receipts. |
| `get_settings` | `{}` | `draftRevision`, validated retained Form and separate observed active-run settings. Invalid editable Form is unavailable. |
| `get_client_state` | `{}` | `draftRevision`, account preferences without password, control readiness, and explicitly projected current public gameplay state. Includes target map catalog, actor world/incarnation, inventory and learned skills with catalog names, NPC/shop/storage/cart/party/vending state and owner preview bindings. |
| `get_script` | `{}` | `draftRevision`, source text including an invalid draft, `dirty` and `unsaved`. |
| `list_profiles` | `{}` | Detached validated profile settings, IDs, names and save timestamps. |
| `list_services` | `{}` | Detached saved definitions and verified built-in presets. |
| `export_profile` | `{ "id": "..." }` | Existing versioned profile export document. |
| `export_service` | `{ "id": "..." }` | Existing versioned saved-service export document. |
| `validate_script` | `{ "script": "..." }` | Parser diagnostics, normalized document and configuration Start readiness. |
| `preview_bot` | `{ "kind": "...", "request": {} }` | Existing workflow, routine, macro, route, service, disposition or supply preview; sends no commands and saves nothing. |
| `get_operation` | `{ "requestId": "..." }` | Native operation state and bounded retained outcome, independent of an HTTP timeout. |

Every control request requires a caller-generated `requestId` matching `[A-Za-z0-9_-]{1,64}`. The draft revision is a monotonic main-view token covering Form inputs (including invalid values), Script drafts, profile/service collections and selection, account/mode and reconnect preferences. It is separate from the native persisted Form revision. Read it immediately before editing; rejection never overwrites a newer human draft. Native claim is awaited, then revision, freshness, busy state and existing owner admission are checked again before effects. Competing ordinary writes fail without a mutation queue.

| Control tool | Additional arguments | Existing behavior |
| --- | --- | --- |
| `set_settings` | `expectedDraftRevision`, `settings` | Validate and replace the retained Form; preserve an invalid Script until it is corrected/discarded. Save the Form with explicit operation ownership. |
| `set_script` | `expectedDraftRevision`, `script` | Admit through the Form/Script editor transaction and save its configuration. Invalid new source is rejected before application. |
| `profile` | `expectedDraftRevision`, `operation`, optional `id`, `name`, `document` | `save`/update, `remove`, `import`, `apply` or `select`. Apply obeys the existing map/character gate and changes only the draft. |
| `service_definition` | `expectedDraftRevision`, `operation`, optional `id`, `definition`, `document` | Save/update, remove or import through the existing definition store. Invalid/unverified definitions retain existing execution restrictions. |
| `connect` | `expectedDraftRevision`, optional paired `username`/`password`, `characterSlot` (0–2), `mode` (`botOnly` or `gameClient`), `remember`, `autoLogin` | Reuse current account selections/defaults and existing native sign-in validation. Omit both credential fields to reuse the currently selected matching saved account/password. Does not return credentials. |
| `disconnect` | `expectedGeneration` | Existing fresh, stopped, settled disconnect admission. |
| `start_bot` | `expectedDraftRevision`, `expectedGeneration` | Existing explicit field or macro Start, readiness, settings and run-budget admission. |
| `stop_bot` | No additional arguments | Cancel retained intent and updater continuation, dispatch Stop and drain outstanding activation with its second fence. Available during busy/invalid/stale/disconnected state. |
| `apply_settings` | `expectedDraftRevision`, `expectedGeneration` | Existing Apply-to-current-run owner; preserve live/Next-run categories, protected reserves, allowances and pending receipts. |
| `set_reconnect` | `expectedDraftRevision`, `enabled` | Existing session reconnect preference. Does not log in or Start. |
| `forget_login` | `expectedDraftRevision` | Existing local saved-login and app-open sign-in preference removal. |
| `client_action` | `expectedGeneration`, `action`, `request` | Dispatch one existing validated action family through its owning adapter. |

`expectedGeneration` comes from `get_status.observation.runtimeGeneration` or `get_client_state.observation.runtimeGeneration`. Runtime actions require current observations. Stop bypasses draft/freshness/busy admission while retaining native control authorization. Local UI Stop also retires an assistant activation still awaiting claim.

Saving, importing, editing, selecting, validating and previewing never Start or Apply. Save outcomes distinguish changed draft from confirmed Form persistence (`persisted`/`persistedRevision`), and Script writes separately report `scriptPersisted`. A failed save retains the recoverable draft and reports the failure. Profile/service stores persist before committing their in-memory collections. Later human edits retain their own save callback and cannot inherit an assistant operation scope.

## Existing action and preview contracts

`client_action.action` is one of the following. `request` uses the existing owner contract, without raw packet or arbitrary native-command access:

| Action | Owning request/validation source |
| --- | --- |
| `command` | [Typed action admission](../src/modules/client/feature-ui-logic.ts), [manual target identities](../src/modules/combat/manual-target-logic.ts), [world commands](../src/modules/protocol/world-protocol.ts). Includes implemented movement, inventory/equipment/skills/allocation, NPC/shop/storage/barter/cart, party and vending actions. |
| `workflow` | [Workflow spec and economic receipts](../src/modules/services/workflows-logic.ts). |
| `routine` | [Condition routine spec](../src/modules/automation/routines-logic.ts). |
| `macro` | [Macro requests](../src/modules/automation/macros-logic.ts) with admitted base settings. |
| `service` | [Verified service request](../src/modules/services/npc-services-logic.ts). |
| `social` | [Existing chat/emote request](../src/modules/social/social-protocol.ts). |
| `memo` | [Memo request](../src/modules/memo/memo-protocol.ts). Use the current published `memo.ready` binding. |
| `socketPreview`, `socket` | [Socket requests](../src/modules/socket/socket-protocol.ts). Commit uses the current one-attempt preview token. |
| `warpPreview`, `warp`, `warpCancel` | [Warp requests](../src/modules/warp/warp-protocol.ts). Ground/activation use current published bindings; cancel retains the owner's unresolved cast/resource hold. |
| `refinePreview`, `refine`, `refineAdvance` | [Refine requests](../src/modules/refine/refine-protocol.ts). Commit and advance retain preview/dialogue tokens, spending checks and acknowledgement fences. |

Manual targeting/talking/viewing vending requires the owner's exact observed actor world/incarnation. Read `get_client_state` rather than guessing identities. Socket, Warp, Memo and refine preview results are read through their published state; preview dispatch acceptance is not a usable fabricated token. Return values distinguish dispatch admission from eventual game confirmation. Read current owner state and action/Apply receipts to learn the actual result. Failed or uncertain spending/actions must settle through existing receipts before another attempt.

`preview_bot` request shapes:

| Kind | Request |
| --- | --- |
| `workflow` | `{ "spec": <existing workflow spec> }` |
| `routine` | `{ "spec": <existing routine spec> }` |
| `macro` | `{ "script": <Bot script source> }` |
| `route` | `{ "destinationMap": "prontera" }`; omission uses the retained policy/travel destination. Only map codes are accepted. |
| `service` | `{ "definition": <existing service definition> }` |
| `disposition` | `{ "policy": <existing disposition policy> }`; omission uses the retained policy. |
| `supply` | `{}`; uses retained settings. |

Route/service planning needs a fresh verified character and aborts within four seconds. Dry runs use missing evidence instead of stale gameplay; unknown observations never become a match. These previews use the existing owners and do not replace retained UI previews or grant commit authority. Text Bot scripts are self-contained; legacy macro JSON needs the retained Form as its baseline.

Catalog rows without verified adapters remain unavailable: companions, quests, mail, bank, auction, repair and arbitrary client plugins/packets. MCP does not install updates, destroy windows or add an independent game connection. Both existing connection modes use the same controller and native gates.

## Examples and outcome recovery

Call `get_settings` and `get_status`, then explicitly Start with their tokens:

```json
{ "name": "start_bot", "arguments": { "requestId": "start-001", "expectedDraftRevision": 8, "expectedGeneration": 2 } }
```

Edit/save source without starting:

```json
{ "name": "set_script", "arguments": { "requestId": "script-001", "expectedDraftRevision": 8, "script": "script \"Field\"\nset radius = 12" } }
```

Send an existing manual action after checking current state and stopping automation:

```json
{ "name": "client_action", "arguments": { "requestId": "sit-001", "expectedGeneration": 2, "action": "command", "request": { "type": "sit", "sitting": true } } }
```

If HTTP times out, query the same operation instead of minting a retry ID:

```json
{ "name": "get_operation", "arguments": { "requestId": "sit-001" } }
```

The native launch ledger deduplicates the same ID and canonical-equivalent payload; it never re-emits that operation. Reusing an ID with a changed tool/payload is rejected. States are `unknown`, `queued`, `claimed`, `unresolved`, `cancelled` and `completed`. `cancelled` means retirement before claim with no effects; `unresolved` means the waiter ended after claim and effects may still finish. `completed` means the owner replied: inspect its result/error, then published gameplay receipts where applicable. `resultUnavailable: true` means the outcome could not fit the bounded retained-result envelope, and does not authorize replay. A late reply can complete an unresolved operation. Disable/reload/exit clears this launch ledger.

## Observation, limits and proof

Native accepted status retains its non-secret generation, sequence and Unix-millisecond timestamp with the same accepted game session. Tool reads do not refresh it. State is `current` for age 0–6,999 ms with a connected matching runtime, `stale` for age ≥7,000 ms or future timestamps, `disconnected` for a closed/disconnected game, or `unavailable` for missing/replaced evidence. Stale/disconnected/unavailable reads null gameplay and active-run/receipt fields while retaining independent draft/script/profile reads. Main and native completion both check replacement. Missing remaining run budgets, active-run persisted revisions and unpublished character resource revision channels are explicitly unavailable; owner-published preview revision bindings remain exposed.

Ordinary admission permits four concurrent requests/pending queries, with reserved Stop admission so a stalled ordinary operation cannot consume every Stop slot. The HTTP/query deadline is five seconds. Script source is limited to 262,144 UTF-8 bytes and 8,192 lines; streamed HTTP bodies to 1,600,000 bytes; structured tool results to 262,144 bytes. Oversized reads fail instead of returning truncated usable settings/gameplay. The ledger retains up to 1,024 ordinary IDs and 128 reserved Stop IDs within a 4 MiB conservative metadata/result budget, reserving 256 KiB for Stop. Keys are not evicted for replay within a launch; after capacity is exhausted, new operations are rejected. SDK mirrored text/envelope can make the full bounded response larger than its structured result.

Native tests exercise real SDK discovery/tools, grants, exact payload replay/conflicts, claim expiry/replacement/revocation, maintenance admission, concurrency and late outcomes. Frontend tests exercise real main-view command composition, both modes, draft CAS after delayed claims, local/remote Stop fences, explicit save ownership/failures and recursive secret redaction. The isolated packaged `ci-smoke` app verifies read-only Form/maintenance invariants, then real main-bridge offline Stop, operation lookup/replay/conflict and token rotation. These checks establish offline source/packaging behavior; they do not prove an installed user's assistant setup or live-game actions.

# Local MCP access

Companion can host an optional, read-only Model Context Protocol server for external AI assistants. Open **Settings → AI assistant connection (MCP)** and choose **Enable MCP server**. It stays disabled on ordinary launches and after the main view closes or reloads. Browser preview cannot enable it.

Copy the displayed endpoint and use **Copy access token**. Configure a client that supports Streamable HTTP and custom authorization headers:

```json
{
  "url": "http://127.0.0.1:<displayed-port>/mcp",
  "headers": {
    "Authorization": "Bearer <copied-access-token>"
  }
}
```

Use the port and token shown by your running app. Each enable binds an ephemeral port on `127.0.0.1` and issues a new random token. Disable immediately revokes the old token and cancels pending queries. The app stores neither setting nor token on disk. Tokens appear only in the local main-view connection panel and its explicit copy action. Keep the token private; any local process with it can read the exposed configuration. TLS is not used for this loopback endpoint.

Requests authenticate on every HTTP method before reading the body. `Host` must equal the displayed `127.0.0.1:<port>` authority. Non-browser clients may omit `Origin`; a supplied Origin must exactly match `http://127.0.0.1:<port>`. Other origins, including `null`, are rejected. This server does not allow cross-origin browser access or network hosting.

## Protocol and tools

The pinned official Rust SDK, `rmcp = 3.5.1`, implements protocol framing, discovery, version negotiation and Streamable HTTP. Axum hosts its Tower transport service; Tokio owns cancellation. The SDK provides dedicated protocol correctness and compatibility that the native platform APIs do not supply. The app declares Rust 1.88 minimum to match the SDK and retains the repository's tested Rust 1.98.1 toolchain.

Supported versions are `2024-11-05`, `2025-03-26`, `2025-06-18`, `2025-11-25` and `2026-07-28`, as defined by this pinned SDK. The 2026 version uses `server/discover` and per-request protocol metadata; the older versions use `initialize`. Requests are stateless, with JSON responses; no SSE subscription, session persistence or client-side MCP consumption is exposed.

All tools have `readOnlyHint: true`, `destructiveHint: false`, `idempotentHint: true` and `openWorldHint: false`. These annotations describe the implemented read-only contract. Results include `structuredContent` and the SDK's matching text content.

| Tool              | Arguments             | Structured result                                                                                      |
| ----------------- | --------------------- | ------------------------------------------------------------------------------------------------------ |
| `get_status`      | `{}`                  | `observation`, `connection`, `character`, `map`, `run`, `receipts`, `updateMaintenance`, `unavailable` |
| `get_settings`    | `{}`                  | `observation`, `settingsForm`, `activeRun`, `unavailable`                                              |
| `list_profiles`   | `{}`                  | `profiles: [{ id, name, savedAt, settings }]`                                                          |
| `validate_script` | `{ "script": "..." }` | `valid`, `normalized`, `diagnostics`; valid data also includes `startReady` and `legacyBaseline`       |

Additional argument properties are rejected. Unknown tools and malformed/oversized arguments are protocol errors. Tool-owner failures, missing configuration, output limits and query deadlines return bounded errors. Parser diagnostics include a line where the existing parser supplies one. A valid configuration can still have `startReady: false`; its diagnostics explain the existing settings/macro Start admission requirements. Start readiness describes configuration admission, independently of connection, character and run availability.

Text Bot scripts are self-contained and can be validated when the editable Form is unavailable. Legacy macro JSON takes the current retained Form as an explicit baseline and requires it to be available. Validation runs the existing Bot script parser, retained-form validation and the same macro/field settings admission used by Start. It never edits the Form, invalid Script draft, profiles or active run.

`settingsForm.settings` is a validated, detached read of the editable retained Form. Invalid form inputs make this field unavailable. `selectedProfileId` is separate from configuration and does not apply a profile. The DOM draft has no authoritative persisted revision, so `revision` is `null`. `activeRun.settings` comes from a current admitted game observation and has its runtime generation and latest published `settingsApplyId`; an active settings revision is currently unavailable. `list_profiles` reads validated detached settings and omits profile character labels.

`run.requested` describes current observed controller intent, including macro waiting. `retainedFieldRequested` and `updateContinuationPending` separately describe main-app ownership that can survive missing gameplay observations. When no current observation or retained intent establishes overall intent, `requested` is `null`. Configured run limits, observed elapsed seconds/kills/pickups and retained limit reasons are available where known; remaining run budgets are explicitly unavailable. `receipts.action` exposes the published action sequence/status/reason and pending task kind. Apply state includes published pending/applied/next-run categories. No read settles or creates a receipt.

## Observation and limits

Native admission adds a non-secret runtime generation, monotonic sequence and observation timestamp to accepted game status. The main app retains this metadata only with an accepted status from the same session. A tool query does not refresh gameplay observation time. Native completion checks the captured runtime generation again, covering disconnect/navigation races before the UI receives its closure event.

`observation.state` is one of:

| State          | Meaning                                                                                                                                                                |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `current`      | An accepted observation for the captured runtime generation, connected, with age from 0 through 6,999 ms. Readiness separately requires compatibility and a character. |
| `stale`        | Observation age is at least 7,000 ms, or its timestamp is in the future.                                                                                               |
| `disconnected` | The main app has no open game, or the matching observed runtime reports disconnected.                                                                                  |
| `unavailable`  | No accepted observation exists, the runtime was replaced, or native ownership cannot establish it.                                                                     |

Stale/disconnected/unavailable results null gameplay, active-run settings and receipt fields. The retained Form, profiles and main-app intent remain independently readable. Timestamps are Unix milliseconds; `ageMs` measures underlying observation age, and `staleAfterMs` is 7,000. Native replacement clears current gameplay fields even if a reply was already being prepared. `unavailable` lists missing evidence; null values do not mean zero, stopped or confirmed.

Limits are four concurrent HTTP requests and four pending main queries, a five-second request/query deadline, 262,144 UTF-8 bytes per script, the existing 8,192 authoring-line limit, a 1,600,000-byte streamed HTTP body cap (including JSON escaping), and 262,144 bytes per structured tool result. Oversized configurations/profile collections return an error instead of a truncated usable configuration. The wire response includes the SDK's mirrored text and protocol envelope, so it can exceed the structured-result cap while remaining bounded by the admitted result size. Busy requests receive HTTP 429, unauthenticated requests 401, invalid origins/hosts 403, oversized HTTP bodies 413, and a whole-request deadline 408 when a tool error has not already completed.

Read/validate requests do not save, Start/resume, Apply, log in, Stop, send gameplay packets, renew limits/cooldowns or control the updater. Native MCP commands require the main WebView and are allowed only by main-view capabilities. They deliberately bypass mutating maintenance admission; updater settlement and Stop keep their existing owners.

## Verification boundary

Focused Rust tests exercise a real official MCP client on loopback, modern discovery and all tools, legacy initialization, auth/Origin/Host rejection, streamed oversized bodies, output rejection, generation replacement, concurrent limits, disable/re-enable, explicit client cancellation, stalled bodies and deadline cleanup. TypeScript tests cover both connection modes, stale/disconnected/replaced observations, redaction/detachment, field/macro intent, receipt publication, existing Form/Script rules, optional initialization failure and absence of save/gameplay calls.

The isolated `ci-smoke` packaged app additionally discovers and calls all four tools through the real native/main event bridge, reads back unchanged persisted Form data, and verifies that a synthetic acknowledged maintenance lease and revision remain unchanged. That test driver is excluded from production builds. Packaging and smoke execution results are recorded with delivery evidence. These offline checks do not establish live gameplay behavior or an installed user's MCP client configuration.

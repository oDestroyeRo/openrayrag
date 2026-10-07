mod mcp_logic;
#[cfg(test)]
mod test_mcp;

use axum::{
    extract::{Request, State},
    http::StatusCode,
    middleware::{self, Next},
    response::{IntoResponse, Response},
    Router,
};
use mcp_logic::{MAX_BODY_BYTES, MAX_CONCURRENT, MAX_OUTPUT_BYTES};
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, CallToolResult, ContentBlock, Implementation,
        ListToolsResult, PaginatedRequestParams, ServerCapabilities, ServerConfig,
    },
    service::RequestContext,
    transport::streamable_http_server::{
        session::local::LocalSessionManager, StreamableHttpServerConfig, StreamableHttpService,
    },
    ErrorData, RoleServer, ServerHandler,
};
use serde::Serialize;
use serde_json::{Map, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, Webview};
use tokio::{
    net::TcpListener,
    sync::{oneshot, Semaphore},
};
use tokio_util::sync::CancellationToken;

const DEADLINE: Duration = Duration::from_secs(5);
type EmitQuery = dyn Fn(Query) -> Result<(), ()> + Send + Sync;
type RuntimeGeneration = dyn Fn() -> Option<u64> + Send + Sync;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Query {
    id: String,
    tool: String,
    arguments: Map<String, Value>,
    runtime_generation: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct Observation {
    generation: u64,
    sequence: u64,
    observed_at: u64,
}
#[derive(Clone, Serialize)]
pub struct Connection {
    endpoint: String,
    token: String,
}
struct PendingReply {
    generation: u64,
    sender: oneshot::Sender<Value>,
}
struct Running {
    connection: Connection,
    cancel: CancellationToken,
}
#[derive(Default)]
struct Core {
    running: Mutex<Option<Running>>,
    pending: Mutex<HashMap<String, PendingReply>>,
    epoch: AtomicU64,
    sequence: AtomicU64,
}
#[derive(Default)]
pub struct SharedMcp(Arc<Core>);

struct PendingQuery {
    core: Arc<Core>,
    id: String,
}
impl Drop for PendingQuery {
    fn drop(&mut self) {
        if let Ok(mut pending) = self.core.pending.lock() {
            pending.remove(&self.id);
        }
    }
}

impl Core {
    fn shutdown(&self) {
        self.epoch.fetch_add(1, Ordering::SeqCst);
        if let Ok(mut running) = self.running.lock() {
            if let Some(server) = running.take() {
                server.cancel.cancel();
            }
        }
        if let Ok(mut pending) = self.pending.lock() {
            pending.clear();
        }
    }
    fn reply(&self, id: &str, generation: u64, mut result: Value) -> Result<(), String> {
        if id.len() > 64 || !result.is_object() {
            return Err("Invalid MCP reply.".into());
        }
        let reply = self
            .pending
            .lock()
            .map_err(|_| "MCP is unavailable.")?
            .remove(id)
            .ok_or("MCP query has expired.")?;
        if reply.generation != generation {
            return Err("MCP runtime generation does not match.".into());
        }
        if serde_json::to_vec(&result)
            .map_err(|_| "Invalid MCP reply.")?
            .len()
            > MAX_OUTPUT_BYTES
        {
            result = serde_json::json!({"error":"MCP result exceeds the 256 KiB output limit. Reduce the configuration or profile collection."});
        }
        reply
            .sender
            .send(result)
            .map_err(|_| "MCP query has expired.".into())
    }
}

#[derive(Clone)]
struct ReadServer {
    core: Arc<Core>,
    cancel: CancellationToken,
    emit: Arc<EmitQuery>,
    generation: Arc<RuntimeGeneration>,
}
fn failure(message: &'static str) -> CallToolResponse {
    CallToolResult::error(vec![ContentBlock::text(message)]).into()
}
impl ServerHandler for ReadServer {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().build())
            .with_server_info(Implementation::new("openrayrag-companion", env!("CARGO_PKG_VERSION")))
            .with_instructions("Read-only local Companion tools. Gameplay observations older than 7 seconds are stale. No tool starts, saves, applies, logs in or sends game actions.")
    }
    fn get_tool(&self, name: &str) -> Option<rmcp::model::Tool> {
        mcp_logic::tool(name)
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult::with_all_items(
            [
                "get_status",
                "get_settings",
                "list_profiles",
                "validate_script",
            ]
            .into_iter()
            .filter_map(mcp_logic::tool)
            .collect(),
        ))
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if mcp_logic::tool(&request.name).is_none() {
            return Err(ErrorData::invalid_params("Unknown read-only tool.", None));
        }
        let arguments = request.arguments.unwrap_or_default();
        if !mcp_logic::arguments_valid(&request.name, &arguments) {
            return Err(ErrorData::invalid_params(
                "Invalid or oversized tool arguments.",
                None,
            ));
        }
        if self.cancel.is_cancelled() {
            return Ok(failure("MCP server is disabled."));
        }
        let Some(generation) = (self.generation)() else {
            return Ok(failure("Companion runtime is unavailable."));
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        {
            let mut pending = self
                .core
                .pending
                .lock()
                .map_err(|_| ErrorData::internal_error("MCP is unavailable.", None))?;
            if pending.len() >= MAX_CONCURRENT {
                return Ok(failure(
                    "Too many pending MCP queries. Retry after a query completes.",
                ));
            }
            pending.insert(id.clone(), PendingReply { generation, sender });
        }
        let _pending = PendingQuery {
            core: self.core.clone(),
            id: id.clone(),
        };
        if (self.emit)(Query {
            id,
            tool: request.name.to_string(),
            arguments,
            runtime_generation: generation,
        })
        .is_err()
        {
            return Ok(failure("Companion query owner is unavailable."));
        }
        let response = tokio::select! {
            _ = self.cancel.cancelled() => return Ok(failure("MCP server is disabled.")),
            _ = context.ct.cancelled() => return Ok(failure("MCP query was cancelled.")),
            result = tokio::time::timeout(DEADLINE, receiver) => match result {
                Ok(Ok(result)) => result,
                _ => return Ok(failure("Companion query timed out or became unavailable.")),
            }
        };
        let response = if matches!(request.name.as_ref(), "get_status" | "get_settings")
            && (self.generation)() != Some(generation)
        {
            mcp_logic::retired_result(
                &request.name,
                response,
                (self.generation)().unwrap_or(generation),
            )
        } else {
            response
        };
        if response.get("error").is_some() {
            return Ok(CallToolResult::structured_error(response).into());
        }
        Ok(CallToolResult::structured(response).into())
    }
}

#[derive(Clone)]
struct Access {
    token: String,
    cancel: CancellationToken,
    permits: Arc<Semaphore>,
}
async fn guard(State(access): State<Access>, request: Request, next: Next) -> Response {
    if access.cancel.is_cancelled() {
        return StatusCode::SERVICE_UNAVAILABLE.into_response();
    }
    if request.headers().get_all("authorization").iter().count() != 1
        || !request
            .headers()
            .get("authorization")
            .is_some_and(|header| mcp_logic::authenticated(header.as_bytes(), &access.token))
    {
        return StatusCode::UNAUTHORIZED.into_response();
    }
    let Ok(_permit) = access.permits.try_acquire() else {
        return StatusCode::TOO_MANY_REQUESTS.into_response();
    };
    tokio::select! {
        _ = access.cancel.cancelled() => StatusCode::SERVICE_UNAVAILABLE.into_response(),
        result = tokio::time::timeout(DEADLINE, next.run(request)) => result.unwrap_or_else(|_| StatusCode::REQUEST_TIMEOUT.into_response()),
    }
}

async fn start(
    core: Arc<Core>,
    emit: Arc<EmitQuery>,
    generation: Arc<RuntimeGeneration>,
) -> Result<Connection, String> {
    let epoch = core.epoch.load(Ordering::SeqCst);
    if let Some(server) = core
        .running
        .lock()
        .map_err(|_| "MCP is unavailable.")?
        .as_ref()
    {
        return Ok(server.connection.clone());
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Could not bind the local MCP server.")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Could not read the MCP endpoint.")?;
    let connection = Connection {
        endpoint: format!("http://{address}/mcp"),
        token: format!(
            "{}{}",
            uuid::Uuid::new_v4().simple(),
            uuid::Uuid::new_v4().simple()
        ),
    };
    let cancel = CancellationToken::new();
    let mut config = StreamableHttpServerConfig::default();
    config.legacy_session_mode = false;
    config.json_response = true;
    config.cancellation_token = cancel.clone();
    config.allowed_hosts = vec![address.to_string()];
    config.allowed_origins = vec![format!("http://{address}")];
    config.max_request_body_bytes = MAX_BODY_BYTES;
    let server = ReadServer {
        core: core.clone(),
        cancel: cancel.clone(),
        emit,
        generation,
    };
    let service = StreamableHttpService::new(
        move || Ok(server.clone()),
        Arc::new(LocalSessionManager::default()),
        config,
    );
    let app = Router::new()
        .nest_service("/mcp", service)
        .layer(middleware::from_fn_with_state(
            Access {
                token: connection.token.clone(),
                cancel: cancel.clone(),
                permits: Arc::new(Semaphore::new(MAX_CONCURRENT)),
            },
            guard,
        ));
    {
        let mut running = core.running.lock().map_err(|_| "MCP is unavailable.")?;
        if core.epoch.load(Ordering::SeqCst) != epoch {
            return Err("MCP startup was cancelled.".into());
        }
        if let Some(server) = running.as_ref() {
            return Ok(server.connection.clone());
        }
        *running = Some(Running {
            connection: connection.clone(),
            cancel: cancel.clone(),
        });
    }
    tauri::async_runtime::spawn(async move {
        let _ = axum::serve(listener, app)
            .with_graceful_shutdown(cancel.clone().cancelled_owned())
            .await;
        // A late shutdown from a retired listener cannot disable a newer launch.
        if core.epoch.load(Ordering::SeqCst) == epoch {
            core.shutdown();
        }
    });
    Ok(connection)
}

pub fn shutdown(app: &tauri::AppHandle) {
    app.state::<SharedMcp>().0.shutdown();
}
pub fn observe(app: &tauri::AppHandle, generation: u64) -> Value {
    let sequence = app
        .state::<SharedMcp>()
        .0
        .sequence
        .fetch_add(1, Ordering::Relaxed)
        + 1;
    serde_json::to_value(Observation {
        generation,
        sequence,
        observed_at: SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
    })
    .unwrap_or(Value::Null)
}

#[tauri::command]
pub async fn mcp_set_enabled(
    app: tauri::AppHandle,
    window: Webview,
    enabled: bool,
) -> Result<Option<Connection>, String> {
    super::require_view(&window, "main")?;
    let core = app.state::<SharedMcp>().0.clone();
    if !enabled {
        core.shutdown();
        return Ok(None);
    }
    let emitter = app.clone();
    let runtime = app.clone();
    start(
        core,
        Arc::new(move |query| emitter.emit_to("main", "mcp-query", query).map_err(|_| ())),
        Arc::new(move || {
            runtime
                .state::<super::session::maintenance::SharedGate>()
                .lock()
                .ok()
                .map(|gate| gate.game_generation)
        }),
    )
    .await
    .map(Some)
}
#[tauri::command]
pub fn mcp_reply(
    app: tauri::AppHandle,
    window: Webview,
    id: String,
    runtime_generation: u64,
    result: Value,
) -> Result<(), String> {
    super::require_view(&window, "main")?;
    app.state::<SharedMcp>()
        .0
        .reply(&id, runtime_generation, result)
}

/// Runs only in the isolated packaged CI application after the main view is initialized.
#[cfg(feature = "ci-smoke")]
pub(crate) async fn smoke_check(app: tauri::AppHandle, window: Webview) -> Result<(), String> {
    super::require_view(&window, "main")?;
    if !super::shell::ci_smoke::active() || app.config().identifier != "com.rayrag.companion.ci" {
        return Err("MCP smoke requires the isolated CI application.".into());
    }
    let before = super::update::updater::current_form(app.clone(), window.clone())?
        .ok_or("MCP smoke settings unavailable.")?;
    let before = serde_json::to_value(before).map_err(|_| "MCP smoke settings unavailable.")?;
    let nonce = uuid::Uuid::new_v4().to_string();
    let (revision, generation, form_revision, old_lease) = {
        let shared = app.state::<super::session::maintenance::SharedGate>();
        let mut gate = shared
            .lock()
            .map_err(|_| "MCP smoke maintenance unavailable.")?;
        let values = (
            gate.revision,
            gate.game_generation,
            gate.form_revision,
            gate.lease.clone(),
        );
        gate.lease = Some(super::session::maintenance::Lease {
            nonce: nonce.clone(),
            until: std::time::Instant::now() + Duration::from_secs(30),
            revision: gate.revision,
            game_generation: gate.game_generation,
            identity: gate.identity.clone(),
            acknowledged: true,
            committed: false,
            form_revision: gate
                .form_revision
                .ok_or("MCP smoke form revision unavailable.")?,
            bridge_revision: None,
            final_requested: false,
            final_ack: false,
            invalidated: false,
        });
        values
    };
    let outcome = async {
        let connection = mcp_set_enabled(app.clone(), window.clone(), true).await?.ok_or("MCP smoke did not enable.")?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(7)).build().map_err(|_| "MCP smoke client unavailable.")?;
        let request = |body: Value| client.post(&connection.endpoint).bearer_auth(&connection.token)
            .header("accept", "application/json, text/event-stream").header("mcp-protocol-version", "2025-11-25").json(&body);
        let initialized: Value = request(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"packaged-offline-probe","version":"1"}}})).send().await.map_err(|_| "MCP smoke connection failed.")?.json().await.map_err(|_| "MCP smoke initialize failed.")?;
        if initialized.pointer("/result/protocolVersion").and_then(Value::as_str) != Some("2025-11-25") { return Err("MCP smoke protocol negotiation failed.".into()); }
        let listed: Value = request(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})).send().await.map_err(|_| "MCP smoke discovery failed.")?.json().await.map_err(|_| "MCP smoke discovery failed.")?;
        if listed.pointer("/result/tools").and_then(Value::as_array).map(Vec::len) != Some(4) { return Err("MCP smoke tool inventory failed.".into()); }
        for (index, tool) in ["get_status", "get_settings", "list_profiles", "validate_script"].iter().enumerate() {
            let arguments = if *tool == "validate_script" { serde_json::json!({"script":"script \"MCP offline probe\""}) } else { serde_json::json!({}) };
            let response: Value = request(serde_json::json!({"jsonrpc":"2.0","id":index+3,"method":"tools/call","params":{"name":tool,"arguments":arguments}})).send().await.map_err(|_| "MCP smoke tool call failed.")?.json().await.map_err(|_| "MCP smoke tool reply failed.")?;
            if response.get("error").is_some() || response.pointer("/result/isError").and_then(Value::as_bool) == Some(true) { return Err("MCP smoke projection failed.".into()); }
            let content = response.pointer("/result/structuredContent").ok_or("MCP smoke structured reply missing.")?;
            let valid = match *tool {
                "get_status" => content.pointer("/observation/state").and_then(Value::as_str) == Some("disconnected") && content.get("character") == Some(&Value::Null),
                "get_settings" => {
                    // Compare admitted settings, independent of JSON's integer/float spelling.
                    let settings: super::settings::automation::Settings = serde_json::from_value(
                        content.pointer("/settingsForm/settings").cloned().ok_or("MCP smoke settings form missing.")?
                    ).map_err(|_| "MCP smoke settings projection was not admitted.")?;
                    settings.validate_form().map_err(|_| "MCP smoke settings projection was invalid.")?;
                    serde_json::to_value(settings).map_err(|_| "MCP smoke settings serialization failed.")?.as_object()
                        == before.get("settings").and_then(Value::as_object)
                        && content.get("activeRun") == Some(&Value::Null)
                },
                "list_profiles" => content.get("profiles").is_some_and(Value::is_array),
                "validate_script" => content.get("valid").and_then(Value::as_bool) == Some(true) && content.pointer("/normalized/settings").is_some(),
                _ => false,
            };
            if !valid { return Err(format!("MCP smoke returned an unexpected {tool} projection.")); }
        }
        let after = super::update::updater::current_form(app.clone(), window.clone())?;
        if after.map(serde_json::to_value).transpose().map_err(|_| "MCP smoke readback failed.")?.as_ref() != Some(&before) { return Err("MCP reads changed persisted settings.".into()); }
        let shared = app.state::<super::session::maintenance::SharedGate>();
        let gate = shared.lock().map_err(|_| "MCP smoke maintenance unavailable.")?;
        if (gate.revision, gate.game_generation, gate.form_revision) != (revision, generation, form_revision)
            || !gate.lease.as_ref().is_some_and(|lease| lease.nonce == nonce && lease.acknowledged && !lease.invalidated) {
            return Err("MCP reads changed update settlement.".into());
        }
        Ok(())
    }.await;
    shutdown(&app);
    if let Ok(mut gate) = app
        .state::<super::session::maintenance::SharedGate>()
        .lock()
    {
        if gate
            .lease
            .as_ref()
            .is_some_and(|lease| lease.nonce == nonce)
        {
            gate.lease = old_lease;
        }
    }
    outcome
}

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
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
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
    control: bool,
}
struct PendingReply {
    generation: u64,
    epoch: u64,
    expires: Instant,
    cancellation: CancellationToken,
    sender: Option<oneshot::Sender<Value>>,
    request_id: Option<String>,
    claimed: bool,
}
struct Operation {
    query_id: String,
    tool: String,
    action: Option<String>,
    fingerprint: [u8; 32],
    epoch: u64,
    generation: u64,
    expected_generation: Option<u64>,
    state: &'static str,
    result: Option<Value>,
    effects: Vec<String>,
}
#[derive(Default)]
struct Requests {
    pending: HashMap<String, PendingReply>,
    operations: HashMap<String, Operation>,
    retained_bytes: usize,
}
const MAX_OPERATIONS: usize = 1024;
const STOP_OPERATIONS: usize = 128;
const MAX_LEDGER_BYTES: usize = 4 * 1024 * 1024;
pub(crate) struct Running {
    connection: Connection,
    cancel: CancellationToken,
}
#[derive(Default)]
struct Core {
    running: Mutex<Option<Running>>,
    requests: Mutex<Requests>,
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
        self.core.retire(&self.id);
    }
}
impl Operation {
    fn receipt(&self, request_id: &str) -> Value {
        let available = self.result.as_ref().is_some_and(|result| {
            serde_json::to_vec(result).is_ok_and(|bytes| bytes.len() <= MAX_OUTPUT_BYTES - 1024)
        });
        serde_json::json!({"requestId":request_id,"tool":self.tool,"state":self.state,"result":if available { self.result.as_ref() } else { None },"resultUnavailable":self.state=="completed" && !available})
    }
}
impl Core {
    fn shutdown(&self) {
        // Gate -> running -> requests is the sole native effect lock order.
        if let Ok(mut running) = self.running.lock() {
            self.epoch.fetch_add(1, Ordering::SeqCst);
            if let Some(server) = running.take() {
                server.cancel.cancel();
            }
            if let Ok(mut requests) = self.requests.lock() {
                *requests = Requests::default();
            }
        }
    }
    fn retire(&self, id: &str) {
        if let Ok(mut requests) = self.requests.lock() {
            let Some(reply) = requests.pending.get_mut(id) else {
                return;
            };
            if reply.claimed {
                reply.sender = None;
                if let Some(request_id) = reply.request_id.clone() {
                    if let Some(operation) = requests.operations.get_mut(&request_id) {
                        operation.state = "unresolved";
                    }
                }
            } else if let Some(reply) = requests.pending.remove(id) {
                if let Some(request_id) = reply.request_id {
                    if let Some(operation) = requests.operations.get_mut(&request_id) {
                        operation.state = "cancelled";
                        operation.result = Some(
                            serde_json::json!({"error":"MCP operation expired or was cancelled before execution."}),
                        );
                    }
                }
            }
        }
    }
    fn operation(&self, request_id: &str) -> Result<Value, String> {
        let requests = self.requests.lock().map_err(|_| "MCP is unavailable.")?;
        Ok(requests
            .operations
            .get(request_id)
            .map(|op| op.receipt(request_id))
            .unwrap_or_else(|| serde_json::json!({"requestId":request_id,"state":"unknown"})))
    }
    fn claim(&self, id: &str, generation: u64, current_generation: u64) -> Result<(), String> {
        let running = self.running.lock().map_err(|_| "MCP is unavailable.")?;
        if !running
            .as_ref()
            .is_some_and(|server| server.connection.control && !server.cancel.is_cancelled())
        {
            return Err("MCP control is not enabled locally.".into());
        }
        let mut requests = self.requests.lock().map_err(|_| "MCP is unavailable.")?;
        let pending = requests
            .pending
            .get_mut(id)
            .ok_or("MCP operation has expired.")?;
        if pending.claimed
            || pending.expires <= Instant::now()
            || pending.cancellation.is_cancelled()
            || pending.epoch != self.epoch.load(Ordering::SeqCst)
            || pending.generation != generation
        {
            return Err("MCP operation expired, was claimed or changed generation.".into());
        }
        let request_id = pending
            .request_id
            .clone()
            .ok_or("Read-only queries cannot claim control.")?;
        let operation = requests
            .operations
            .get_mut(&request_id)
            .ok_or("MCP receipt is unavailable.")?;
        if operation.tool != "stop_bot"
            && (generation != current_generation
                || operation
                    .expected_generation
                    .is_some_and(|expected| expected != current_generation))
        {
            return Err("MCP runtime generation does not match.".into());
        }
        operation.state = "claimed";
        requests
            .pending
            .get_mut(id)
            .ok_or("MCP operation has expired.")?
            .claimed = true;
        Ok(())
    }
    fn authorize(
        &self,
        id: &str,
        current_generation: u64,
        effect: &str,
    ) -> Result<std::sync::MutexGuard<'_, Option<Running>>, String> {
        let authority = self.running.lock().map_err(|_| "MCP is unavailable.")?;
        if !authority
            .as_ref()
            .is_some_and(|server| server.connection.control && !server.cancel.is_cancelled())
        {
            return Err("MCP control was revoked.".into());
        }
        let mut requests = self.requests.lock().map_err(|_| "MCP is unavailable.")?;
        let request_id = requests
            .pending
            .get(id)
            .filter(|pending| pending.claimed)
            .and_then(|pending| pending.request_id.clone())
            .ok_or("MCP operation is not claimed.")?;
        let operation = requests
            .operations
            .get_mut(&request_id)
            .ok_or("MCP receipt is unavailable.")?;
        if operation.query_id != id
            || operation.epoch != self.epoch.load(Ordering::SeqCst)
            || !matches!(operation.state, "claimed" | "unresolved")
            || operation.tool != "stop_bot"
                && (operation.generation != current_generation
                    || operation
                        .expected_generation
                        .is_some_and(|expected| expected != current_generation))
            || !mcp_logic::effect_allowed(&operation.tool, operation.action.as_deref(), effect)
            || operation.tool != "stop_bot"
                && operation.effects.iter().any(|used| {
                    used == effect
                        || operation.tool == "start_bot" && used.starts_with("control_bot:")
                })
        {
            return Err("MCP operation no longer authorizes this effect.".into());
        }
        if !operation.effects.iter().any(|used| used == effect) {
            operation.effects.push(effect.to_owned());
        }
        Ok(authority)
    }
    fn reply(&self, id: &str, generation: u64, mut result: Value) -> Result<(), String> {
        if id.len() > 64 || !result.is_object() {
            return Err("Invalid MCP reply.".into());
        }
        if serde_json::to_vec(&result)
            .map_err(|_| "Invalid MCP reply.")?
            .len()
            > MAX_OUTPUT_BYTES
        {
            result = serde_json::json!({"error":"MCP result exceeds the 256 KiB output limit. Reduce the configuration or profile collection."});
        }
        let mut requests = self.requests.lock().map_err(|_| "MCP is unavailable.")?;
        let pending = requests.pending.get(id).ok_or("MCP query has expired.")?;
        if pending.generation != generation {
            return Err("MCP runtime generation does not match.".into());
        }
        if pending.request_id.is_some() && !pending.claimed && result.get("error").is_none() {
            return Err("MCP operation was not claimed.".into());
        }
        let reply = requests.pending.remove(id).unwrap();
        if let Some(request_id) = reply.request_id {
            if requests
                .operations
                .get(&request_id)
                .is_some_and(|operation| operation.tool == "connect")
            {
                result = mcp_logic::credential_free_result(result);
            }
            let stop = requests
                .operations
                .get(&request_id)
                .is_some_and(|operation| operation.tool == "stop_bot");
            let budget = if stop {
                MAX_LEDGER_BYTES
            } else {
                MAX_LEDGER_BYTES - 262_144
            };
            let size = serde_json::to_vec(&result)
                .map_err(|_| "Invalid MCP reply.")?
                .len();
            if requests.retained_bytes.saturating_add(size) > budget {
                result = serde_json::json!({"error":"Operation completed but its result exceeded the retained receipt budget.","outcome":"unresolved"});
            }
            let size = serde_json::to_vec(&result)
                .map_err(|_| "Invalid MCP reply.")?
                .len();
            let stored = if requests.retained_bytes.saturating_add(size) <= budget {
                requests.retained_bytes += size;
                Some(result.clone())
            } else {
                None
            };
            if let Some(operation) = requests.operations.get_mut(&request_id) {
                operation.state = "completed";
                operation.result = stored;
            }
        }
        if let Some(sender) = reply.sender {
            let _ = sender.send(result);
        }
        Ok(())
    }
}

/// Hold launch authority through the synchronous effect while the existing Gate is locked.
pub(crate) fn authorize_effect<'a>(
    app: &'a tauri::AppHandle,
    gate: &super::session::maintenance::Gate,
    id: Option<&str>,
    effect: &str,
) -> Result<Option<std::sync::MutexGuard<'a, Option<Running>>>, String> {
    let Some(id) = id else {
        return Ok(None);
    };
    let core = &app.state::<SharedMcp>().inner().0;
    core.authorize(id, gate.game_generation, effect).map(Some)
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
            .with_instructions("Local Companion tools. Control requires a separate per-launch grant in Settings. Write requests require unique requestId and observed draft/runtime revisions. Retained unresolved operations must not be repeated with a new identity. Gameplay observations older than 7 seconds are stale.")
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
            mcp_logic::TOOL_NAMES
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
            return Err(ErrorData::invalid_params("Unknown tool.", None));
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
        if request.name == "get_operation" {
            let result = self
                .core
                .operation(arguments["requestId"].as_str().unwrap())
                .map_err(|_| ErrorData::internal_error("MCP is unavailable.", None))?;
            return Ok(CallToolResult::structured(result).into());
        }
        let Some(generation) = (self.generation)() else {
            return Ok(failure("Companion runtime is unavailable."));
        };
        let id = uuid::Uuid::new_v4().to_string();
        let (sender, receiver) = oneshot::channel();
        let write = mcp_logic::mutating(&request.name);
        let stop = request.name == "stop_bot";
        let epoch = self.core.epoch.load(Ordering::SeqCst);
        {
            let running = self
                .core
                .running
                .lock()
                .map_err(|_| ErrorData::internal_error("MCP is unavailable.", None))?;
            if write
                && !running.as_ref().is_some_and(|server| {
                    server.connection.control && !server.cancel.is_cancelled()
                })
            {
                return Ok(failure("MCP control is not enabled locally. Enable control in Settings for this launch."));
            }
            let mut requests = self
                .core
                .requests
                .lock()
                .map_err(|_| ErrorData::internal_error("MCP is unavailable.", None))?;
            let request_id = if write {
                Some(arguments["requestId"].as_str().unwrap().to_owned())
            } else {
                None
            };
            if let Some(request_id) = &request_id {
                let fingerprint = mcp_logic::fingerprint(&request.name, &arguments)
                    .map_err(|_| ErrorData::invalid_params("Invalid arguments.", None))?;
                if let Some(operation) = requests.operations.get(request_id) {
                    if operation.fingerprint != fingerprint {
                        return Err(ErrorData::invalid_params(
                            "requestId was already used with different arguments.",
                            None,
                        ));
                    }
                    return Ok(
                        if operation
                            .result
                            .as_ref()
                            .is_some_and(|result| result.get("error").is_some())
                        {
                            CallToolResult::structured_error(operation.result.clone().unwrap())
                                .into()
                        } else {
                            CallToolResult::structured(
                                operation
                                    .result
                                    .clone()
                                    .unwrap_or_else(|| operation.receipt(request_id)),
                            )
                            .into()
                        },
                    );
                }
                let count = requests
                    .operations
                    .values()
                    .filter(|operation| (operation.tool == "stop_bot") == stop)
                    .count();
                if count
                    >= if stop {
                        STOP_OPERATIONS
                    } else {
                        MAX_OPERATIONS
                    }
                    || !stop && requests.retained_bytes >= MAX_LEDGER_BYTES - 262_144
                {
                    return Ok(failure("The per-launch MCP operation receipt capacity is full. Disable and re-enable locally after resolving outstanding operations."));
                }
            }
            let pending_count = requests
                .pending
                .values()
                .filter(|pending| {
                    pending
                        .request_id
                        .as_ref()
                        .and_then(|id| requests.operations.get(id))
                        .is_some_and(|op| op.tool == "stop_bot")
                        == stop
                        && (!stop || pending.sender.is_some())
                })
                .count();
            if pending_count >= if stop { 1 } else { MAX_CONCURRENT } {
                return Ok(failure(
                    "Too many pending MCP queries. Retry after a query completes.",
                ));
            }
            if let Some(request_id) = &request_id {
                let fingerprint = mcp_logic::fingerprint(&request.name, &arguments)
                    .map_err(|_| ErrorData::invalid_params("Invalid arguments.", None))?;
                requests.retained_bytes += 512 + request_id.len() + id.len();
                requests.operations.insert(
                    request_id.clone(),
                    Operation {
                        query_id: id.clone(),
                        tool: request.name.to_string(),
                        action: arguments
                            .get("action")
                            .and_then(Value::as_str)
                            .map(str::to_owned),
                        fingerprint,
                        epoch,
                        generation,
                        expected_generation: arguments
                            .get("expectedGeneration")
                            .and_then(Value::as_u64),
                        state: "queued",
                        result: None,
                        effects: Vec::new(),
                    },
                );
            }
            requests.pending.insert(
                id.clone(),
                PendingReply {
                    generation,
                    epoch,
                    expires: Instant::now() + DEADLINE,
                    cancellation: context.ct.clone(),
                    sender: Some(sender),
                    request_id,
                    claimed: false,
                },
            );
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
            _ = context.ct.cancelled() => return Ok(failure(if write { "MCP operation was cancelled; outcome may be unresolved. Read get_operation using the same requestId." } else { "MCP query was cancelled." })),
            result = tokio::time::timeout(DEADLINE, receiver) => match result {
                Ok(Ok(result)) => result,
                _ => return Ok(failure(if write { "MCP operation timed out; outcome may be unresolved. Read get_operation using the same requestId." } else { "Companion query timed out or became unavailable." })),
            }
        };
        let response = if matches!(
            request.name.as_ref(),
            "get_status" | "get_settings" | "get_client_state" | "preview_bot"
        ) && (self.generation)() != Some(generation)
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
    stop_permits: Arc<Semaphore>,
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
    let work = async {
        let (request, _permit) = match access.permits.clone().try_acquire_owned() {
            Ok(permit) => (request, permit),
            Err(_) => {
                let Ok(permit) = access.stop_permits.clone().try_acquire_owned() else {
                    return StatusCode::TOO_MANY_REQUESTS.into_response();
                };
                let (parts, body) = request.into_parts();
                let Ok(bytes) = axum::body::to_bytes(body, MAX_BODY_BYTES).await else {
                    return StatusCode::PAYLOAD_TOO_LARGE.into_response();
                };
                let is_stop = serde_json::from_slice::<Value>(&bytes)
                    .ok()
                    .is_some_and(|body| {
                        body.get("method").and_then(Value::as_str) == Some("tools/call")
                            && body.pointer("/params/name").and_then(Value::as_str)
                                == Some("stop_bot")
                    });
                if !is_stop {
                    return StatusCode::TOO_MANY_REQUESTS.into_response();
                }
                (
                    Request::from_parts(parts, axum::body::Body::from(bytes)),
                    permit,
                )
            }
        };
        next.run(request).await
    };
    tokio::select! {
        _=access.cancel.cancelled()=>StatusCode::SERVICE_UNAVAILABLE.into_response(),
        result=tokio::time::timeout(DEADLINE,work)=>result.unwrap_or_else(|_|StatusCode::REQUEST_TIMEOUT.into_response()),
    }
}

async fn start(
    core: Arc<Core>,
    emit: Arc<EmitQuery>,
    generation: Arc<RuntimeGeneration>,
    control: bool,
) -> Result<Connection, String> {
    let epoch = core.epoch.load(Ordering::SeqCst);
    if let Some(server) = core
        .running
        .lock()
        .map_err(|_| "MCP is unavailable.")?
        .as_ref()
    {
        if server.connection.control != control {
            return Err("Disable MCP before changing its control grant.".into());
        }
        return Ok(server.connection.clone());
    }
    let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|_| "Could not bind the local MCP server.")?;
    let address = listener
        .local_addr()
        .map_err(|_| "Could not read the MCP endpoint.")?;
    let connection = Connection {
        control,
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
                stop_permits: Arc::new(Semaphore::new(1)),
            },
            guard,
        ));
    {
        let mut running = core.running.lock().map_err(|_| "MCP is unavailable.")?;
        if core.epoch.load(Ordering::SeqCst) != epoch {
            return Err("MCP startup was cancelled.".into());
        }
        if let Some(server) = running.as_ref() {
            if server.connection.control != control {
                return Err("Disable MCP before changing its control grant.".into());
            }
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
    control: Option<bool>,
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
        control.unwrap_or(false),
    )
    .await
    .map(Some)
}
#[tauri::command]
pub fn mcp_claim(
    app: tauri::AppHandle,
    window: Webview,
    id: String,
    runtime_generation: u64,
) -> Result<(), String> {
    super::require_view(&window, "main")?;
    let shared = app.state::<super::session::maintenance::SharedGate>();
    let gate = shared
        .lock()
        .map_err(|_| "Companion runtime is unavailable.")?;
    // Capture generation under the owner's lock before taking MCP authority.
    app.state::<SharedMcp>()
        .0
        .claim(&id, runtime_generation, gate.game_generation)
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
        let connection = mcp_set_enabled(app.clone(), window.clone(), true, None).await?.ok_or("MCP smoke did not enable.")?;
        let client = reqwest::Client::builder().timeout(Duration::from_secs(7)).build().map_err(|_| "MCP smoke client unavailable.")?;
        let request = |body: Value| client.post(&connection.endpoint).bearer_auth(&connection.token)
            .header("accept", "application/json, text/event-stream").header("mcp-protocol-version", "2025-11-25").json(&body);
        let initialized: Value = request(serde_json::json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"packaged-offline-probe","version":"1"}}})).send().await.map_err(|_| "MCP smoke connection failed.")?.json().await.map_err(|_| "MCP smoke initialize failed.")?;
        if initialized.pointer("/result/protocolVersion").and_then(Value::as_str) != Some("2025-11-25") { return Err("MCP smoke protocol negotiation failed.".into()); }
        let listed: Value = request(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}})).send().await.map_err(|_| "MCP smoke discovery failed.")?.json().await.map_err(|_| "MCP smoke discovery failed.")?;
        if listed.pointer("/result/tools").and_then(Value::as_array).map(Vec::len) != Some(mcp_logic::TOOL_NAMES.len()) { return Err("MCP smoke tool inventory failed.".into()); }
        let denied: Value = request(serde_json::json!({"jsonrpc":"2.0","id":99,"method":"tools/call","params":{"name":"stop_bot","arguments":{"requestId":"packaged-read-only-denied"}}})).send().await.map_err(|_|"MCP smoke write denial failed.")?.json().await.map_err(|_|"MCP smoke write denial failed.")?;
        if denied.pointer("/result/isError").and_then(Value::as_bool)!=Some(true) { return Err("MCP default read-only launch accepted control.".into()); }
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
    outcome?;
    // The synthetic updater lease is restored before any safe offline control.
    let control = async {
        let connection=mcp_set_enabled(app.clone(),window.clone(),true,Some(true)).await?.ok_or("MCP smoke control enable failed.")?;
        let client=reqwest::Client::builder().timeout(Duration::from_secs(7)).build().map_err(|_|"MCP smoke control client unavailable.")?;
        let request=|body:Value|client.post(&connection.endpoint).bearer_auth(&connection.token)
            .header("accept","application/json, text/event-stream").header("mcp-protocol-version","2025-11-25").json(&body);
        let stop=serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"stop_bot","arguments":{"requestId":"packaged-offline-stop"}}});
        let response:Value=request(stop.clone()).send().await.map_err(|_|"MCP smoke Stop dispatch failed.")?.json().await.map_err(|_|"MCP smoke Stop reply failed.")?;
        if response.get("error").is_some() || response.pointer("/result/isError").and_then(Value::as_bool)==Some(true)
            || response.pointer("/result/structuredContent/retainedRunCancelled").and_then(Value::as_bool)!=Some(true) {
            return Err("MCP smoke Stop did not cancel retained run intent through the main owner.".into());
        }
        let receipt:Value=request(serde_json::json!({"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"get_operation","arguments":{"requestId":"packaged-offline-stop"}}})).send().await.map_err(|_|"MCP smoke receipt failed.")?.json().await.map_err(|_|"MCP smoke receipt failed.")?;
        if receipt.pointer("/result/structuredContent/state").and_then(Value::as_str)!=Some("completed") { return Err("MCP smoke main control was not claimed and completed.".into()); }
        let duplicate:Value=request(stop).send().await.map_err(|_|"MCP smoke replay failed.")?.json().await.map_err(|_|"MCP smoke replay failed.")?;
        if response.get("result")!=duplicate.get("result") { return Err("MCP smoke replay changed its retained outcome.".into()); }
        let changed:Value=request(serde_json::json!({"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"disconnect","arguments":{"requestId":"packaged-offline-stop","expectedGeneration":generation}}})).send().await.map_err(|_|"MCP smoke replay conflict failed.")?.json().await.map_err(|_|"MCP smoke replay conflict failed.")?;
        if changed.get("error").is_none() { return Err("MCP smoke reused an operation identity for different effects.".into()); }
        let after=super::update::updater::current_form(app.clone(),window.clone())?;
        if after.map(serde_json::to_value).transpose().map_err(|_|"MCP smoke control readback failed.")?.as_ref()!=Some(&before) { return Err("MCP offline Stop changed persisted settings.".into()); }
        shutdown(&app);
        // A fresh read-only launch must revoke both the control token and ledger.
        let reopened=mcp_set_enabled(app.clone(),window.clone(),true,None).await?.ok_or("MCP smoke re-enable failed.")?;
        let revoked=client.get(&reopened.endpoint).bearer_auth(&connection.token).send().await.map_err(|_|"MCP smoke revocation failed.")?;
        if revoked.status()!=StatusCode::UNAUTHORIZED || reopened.control { return Err("MCP smoke control authority was not revoked.".into()); }
        Ok(())
    }.await;
    shutdown(&app);
    control
}

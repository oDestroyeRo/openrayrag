//! One-shot update continuation authority. Ordinary startup never grants run intent.
use crate::{
    automation::{DeathRecoveryGuard, EscapeResumeGuard, Settings, SupplyResumeGuard},
    current_form::{self, FormDocument},
    login::{self, local_store as file, UpdateAccount},
    maintenance::{GameIdentity, Gate, SharedGate},
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, WebviewWindow};

const ERROR: &str = "Update continuation is unavailable. Sign in and start manually.";
const CHECKPOINT: &str = "update-continuation.json";
const TEMPORARY: &str = ".update-continuation.tmp";
const LAUNCH_PREFIX: &str = "--rayrag-update-resume=";
const MAX_BYTES: u64 = 1_000_000;
const TTL_MS: u64 = 10 * 60 * 1000;
const SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ContinuationBase {
    version: u8,
    field: Value,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Continuation {
    version: u8,
    pub account: UpdateAccount,
    form: FormDocument,
    field: Value,
    pub runtime: Value,
    saved_account: bool,
}
#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DiskCheckpoint {
    version: u8,
    target_version: String,
    created_at: u64,
    launch_token: Option<String>,
    continuation: Continuation,
}
struct Prepared {
    request_id: String,
    account: UpdateAccount,
    identity: GameIdentity,
    generation: u64,
    until: Instant,
    checkpoint: Option<Value>,
}
struct Reserved {
    prepared: Prepared,
    nonce: String,
    form: FormDocument,
    field: Value,
    runtime: Option<Value>,
}
struct Restore {
    request_id: String,
    identity: GameIdentity,
    generation: u64,
    until: Instant,
}
struct Claimed {
    account: UpdateAccount,
    runtime: Value,
}
#[derive(Default)]
pub(crate) struct ContinuationState {
    prepared: Option<Prepared>,
    reserved: Option<Reserved>,
    available: Option<Continuation>,
    claimed: Option<Claimed>,
    restore: Option<Restore>,
    observed_character: Option<(GameIdentity, String)>,
    observed_idle: bool,
}
pub(crate) type SharedContinuation = Mutex<ContinuationState>;
impl ContinuationState {
    fn acknowledge_restore(
        &mut self,
        request_id: &str,
        success: bool,
        account: &UpdateAccount,
        identity: &GameIdentity,
        generation: u64,
    ) -> bool {
        if !self.restore.as_ref().is_some_and(|r| {
            r.request_id == request_id
                && r.identity == *identity
                && r.generation == generation
                && Instant::now() < r.until
        }) || !self.claimed.as_ref().is_some_and(|p| p.account == *account)
        {
            return false;
        }
        self.restore = None;
        // A known rejection leaves activation untouched and permits a fresh
        // request for the same claim. A successful activation consumes it.
        if success {
            self.claimed = None;
        }
        true
    }
    fn restore_matches(
        &self,
        account: &UpdateAccount,
        checkpoint: &Value,
        identity: &GameIdentity,
    ) -> bool {
        self.claimed
            .as_ref()
            .is_some_and(|c| c.account == *account && c.runtime == *checkpoint)
            && self.restore.is_none()
            && self.observed_idle
            && self
                .observed_character
                .as_ref()
                .map(|(i, name)| (i, name.as_str()))
                == character(checkpoint).map(|name| (identity, name))
    }
    fn revoke(&mut self) -> Option<String> {
        let active = self
            .prepared
            .as_ref()
            .map(|p| p.request_id.clone())
            .or_else(|| {
                self.reserved
                    .as_ref()
                    .map(|r| r.prepared.request_id.clone())
            });
        self.prepared = None;
        self.reserved = None;
        self.available = None;
        self.claimed = None;
        self.restore = None;
        active
    }
}

fn invalid<T>() -> Result<T, String> {
    Err(ERROR.into())
}
pub(crate) fn request_id(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ERROR)?
        .as_millis()
        .try_into()
        .map_err(|_| ERROR.into())
}
fn exact(value: &Value, keys: &[&str]) -> bool {
    value
        .as_object()
        .is_some_and(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
}
fn number(value: &Value) -> bool {
    value.as_u64().is_some_and(|n| n <= SAFE_INTEGER)
}
fn bounded(value: &Value, depth: usize) -> bool {
    if depth > 32 {
        return false;
    }
    match value {
        Value::Null | Value::Bool(_) => true,
        Value::Number(n) => n
            .as_f64()
            .is_some_and(|n| n.is_finite() && n.abs() <= SAFE_INTEGER as f64),
        Value::String(s) => s.len() <= 65_536 && !s.contains('\0'),
        Value::Array(a) => a.len() <= 1024 && a.iter().all(|v| bounded(v, depth + 1)),
        Value::Object(o) => {
            o.len() <= 256
                && o.iter().all(|(k, v)| {
                    let key = k.to_ascii_lowercase().replace(['_', '-'], "");
                    k.len() <= 64
                        && !["password", "credential", "packet"]
                            .iter()
                            .any(|name| key.contains(name))
                        && !matches!(
                            key.as_str(),
                            "password"
                                | "credentials"
                                | "cookie"
                                | "cookies"
                                | "authorization"
                                | "accesstoken"
                                | "refreshtoken"
                                | "authtoken"
                                | "sessiontoken"
                                | "packet"
                                | "packets"
                                | "rawpacket"
                                | "rawpackets"
                                | "packetbytes"
                        )
                        && bounded(v, depth + 1)
                })
        }
    }
}
fn validate_settings(value: &Value) -> Result<(), String> {
    let settings: Settings = serde_json::from_value(value.clone()).map_err(|_| ERROR)?;
    settings.validate().map_err(|_| ERROR.into())
}
pub(crate) fn validate_runtime(value: &Value) -> Result<(), String> {
    if !exact(
        value,
        &[
            "version",
            "frozenAt",
            "status",
            "settings",
            "macro",
            "partyHeal",
            "run",
        ],
    ) || value["version"] != 1
        || !number(&value["frozenAt"])
        || value["frozenAt"]
            .as_u64()
            .map_or(true, |n| n == 0 || n > now().unwrap_or(0))
        || !value["status"].is_object()
        || value["status"]["connected"] != true
        || value["status"]["compatible"] != true
        || !value["status"]["runRequested"].is_boolean()
        || character(value).is_none()
        || runtime_identity(value).is_none()
        || !bounded(value, 0)
        || serde_json::to_vec(value).map_err(|_| ERROR)?.len() > 750_000
    {
        return invalid();
    }
    if !value["settings"].is_null() {
        validate_settings(&value["settings"])?;
    }
    let heal = &value["partyHeal"];
    if !exact(heal, &["version", "attempts", "confirmed", "cooldownUntil"])
        || heal["version"] != 1
        || !["attempts", "confirmed", "cooldownUntil"]
            .iter()
            .all(|k| number(&heal[*k]))
        || heal["confirmed"].as_u64() > heal["attempts"].as_u64()
    {
        return invalid();
    }
    let run = &value["run"];
    if !run.is_null()
        && (!exact(run, &["startedAt", "kills", "pickups", "deaths"])
            || run["startedAt"].as_u64() > value["frozenAt"].as_u64()
            || !["startedAt", "kills", "pickups", "deaths"]
                .iter()
                .all(|k| number(&run[*k])))
    {
        return invalid();
    }
    if !value["macro"].is_null() {
        let m = &value["macro"];
        if !exact(
            m,
            &[
                "version",
                "script",
                "selector",
                "sequence",
                "retainedField",
                "state",
                "reason",
                "generation",
                "nextId",
                "startedAt",
                "lastTime",
                "actionsIssued",
                "actionsCompleted",
                "spendReserved",
            ],
        ) || m["version"] != 1
            || !matches!(m["state"].as_str(), Some("running" | "monitoring"))
            || !m["selector"].is_object()
            || !m["reason"].as_str().is_some_and(|s| s.len() <= 800)
            || ![
                "generation",
                "nextId",
                "startedAt",
                "lastTime",
                "actionsIssued",
                "actionsCompleted",
                "spendReserved",
            ]
            .iter()
            .all(|k| number(&m[*k]))
            || m["actionsCompleted"] != m["actionsIssued"]
            || m["lastTime"].as_u64() < m["startedAt"].as_u64()
            || m["lastTime"].as_u64() > value["frozenAt"].as_u64()
        {
            return invalid();
        }
        let script = value["macro"].get("script").ok_or(ERROR)?;
        crate::control::request_script(
            "macro",
            &json!({"script":script,"settings":value["settings"]}),
        )
        .map_err(|_| ERROR)?;
    }
    if (value["status"]["runRequested"] == true || !value["macro"].is_null())
        && (value["settings"].is_null() || run.is_null())
    {
        return invalid();
    }
    Ok(())
}
fn validate_field(value: &Value) -> Result<(), String> {
    if value.is_null() {
        return Ok(());
    }
    if !exact(
        value,
        &[
            "version",
            "desired",
            "character",
            "session",
            "generation",
            "startedAt",
            "metricsSession",
            "previous",
            "totals",
            "escapeGuard",
            "supplyGuard",
            "deathGuard",
            "escapeOverflowUncertain",
            "supplyOverflow",
            "deathOverflow",
        ],
    ) || value["version"] != 1
        || !bounded(value, 0)
        || !["generation", "startedAt"]
            .iter()
            .all(|k| number(&value[*k]))
        || !["character", "session", "metricsSession"].iter().all(|k| {
            value[*k].as_str().is_some_and(|s| {
                !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control)
            })
        })
        || !["escapeOverflowUncertain", "supplyOverflow", "deathOverflow"]
            .iter()
            .all(|k| value[*k].is_boolean())
    {
        return invalid();
    }
    validate_settings(&value["desired"])?;
    for k in ["previous", "totals"] {
        if !exact(&value[k], &["kills", "looted", "deaths", "attacks"])
            || !["kills", "looted", "deaths", "attacks"]
                .iter()
                .all(|n| number(&value[k][*n]))
        {
            return invalid();
        }
    }
    for key in ["supplyGuard", "deathGuard"] {
        let guard = &value[key];
        if guard.is_null() {
            continue;
        }
        if !exact(guard, &["session", "at", "guard"])
            || !guard["session"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
            || !number(&guard["at"])
            || guard["guard"]["character"] != value["character"]
        {
            return invalid();
        }
        if key == "supplyGuard" {
            serde_json::from_value::<SupplyResumeGuard>(guard["guard"].clone())
                .map_err(|_| ERROR)?
                .validate()?;
        } else {
            serde_json::from_value::<DeathRecoveryGuard>(guard["guard"].clone())
                .map_err(|_| ERROR)?
                .validate()?;
        }
    }
    let escape = &value["escapeGuard"];
    if !escape.is_null() {
        let keys = if escape.get("recovery").is_some() {
            vec!["session", "cooldownUntil", "latched", "recovery"]
        } else {
            vec!["session", "cooldownUntil", "latched"]
        };
        if !exact(escape, &keys)
            || !escape["session"]
                .as_str()
                .is_some_and(|s| !s.is_empty() && s.len() <= 256)
            || !number(&escape["cooldownUntil"])
            || !escape["latched"].is_boolean()
        {
            return invalid();
        }
        let mut projected = json!({"cooldownSeconds":0,"latched":escape["latched"]});
        if let Some(recovery) = escape.get("recovery") {
            projected["recovery"] = recovery.clone();
        }
        serde_json::from_value::<EscapeResumeGuard>(projected)
            .map_err(|_| ERROR)?
            .validate()?;
    }
    Ok(())
}
fn runtime_identity(runtime: &Value) -> Option<GameIdentity> {
    let status = &runtime["status"];
    for key in ["sessionId", "connectionId"] {
        let id = status[key].as_str()?;
        if id.is_empty()
            || id.len() > 64
            || !id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
        {
            return None;
        }
    }
    Some(GameIdentity {
        session_id: status["sessionId"].as_str()?.to_owned(),
        connection_id: status["connectionId"].as_str()?.to_owned(),
    })
}
fn character(runtime: &Value) -> Option<&str> {
    runtime
        .pointer("/status/player/name")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control))
}
fn validate_payload(payload: &Continuation) -> Result<(), String> {
    if payload.version != 1 {
        return invalid();
    }
    payload.account.validate()?;
    payload.form.validate()?;
    validate_field(&payload.field)?;
    validate_runtime(&payload.runtime)?;
    let name = character(&payload.runtime).ok_or(ERROR)?;
    if !payload.field.is_null() && payload.field["character"].as_str() != Some(name) {
        return invalid();
    }
    Ok(())
}
fn same_form(a: &FormDocument, b: &FormDocument) -> bool {
    serde_json::to_vec(a).ok() == serde_json::to_vec(b).ok()
}
fn clear_disk(path: PathBuf) -> Result<(), String> {
    let Some(dir) = file::LocalLoginStore::new(path)
        .open_directory(false)
        .map_err(|_| ERROR)?
    else {
        return Ok(());
    };
    file::remove_private_file(&dir, CHECKPOINT).map_err(|_| ERROR)?;
    file::remove_private_file(&dir, TEMPORARY).map_err(|_| ERROR)?;
    file::sync_directory(&dir).map_err(|_| ERROR.into())
}
fn write_disk(path: PathBuf, disk: &DiskCheckpoint) -> Result<(), String> {
    validate_payload(&disk.continuation)?;
    let bytes = serde_json::to_vec(disk).map_err(|_| ERROR)?;
    if bytes.len() as u64 > MAX_BYTES {
        return invalid();
    }
    let dir = file::LocalLoginStore::new(path)
        .open_directory(true)
        .map_err(|_| ERROR)?
        .ok_or(ERROR)?;
    file::private_file(&dir, CHECKPOINT).map_err(|_| ERROR)?;
    file::remove_private_file(&dir, TEMPORARY).map_err(|_| ERROR)?;
    let result = (|| {
        let mut temp = file::create_private_file(&dir, TEMPORARY).map_err(|_| ERROR)?;
        file::verify_private(&temp, false).map_err(|_| ERROR)?;
        temp.write_all(&bytes).map_err(|_| ERROR)?;
        temp.sync_all().map_err(|_| ERROR)?;
        file::rename_at(&dir, TEMPORARY, CHECKPOINT).map_err(|_| ERROR)?;
        file::sync_directory(&dir).map_err(|_| ERROR)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = file::remove_private_file(&dir, TEMPORARY);
    }
    result
}
fn launch_token(args: &[OsString]) -> Option<String> {
    let matching: Vec<_> = args
        .iter()
        .skip(1)
        .filter_map(|arg| arg.to_str()?.strip_prefix(LAUNCH_PREFIX))
        .collect();
    if matching.len() != 1 || !request_id(matching[0]) {
        return None;
    }
    Some(matching[0].into())
}
/// Remove the private checkpoint under its directory lock before validating or
/// exposing it. Even wrong arguments, corrupt contents and crashes consume it.
fn consume(
    path: PathBuf,
    args: &[OsString],
    compiled: &str,
    at: u64,
) -> Result<Option<Continuation>, String> {
    let bytes = {
        let Some(dir) = file::LocalLoginStore::new(path.clone())
            .open_directory(false)
            .map_err(|_| ERROR)?
        else {
            return Ok(None);
        };
        let bytes = if let Some(f) = file::private_file(&dir, CHECKPOINT).map_err(|_| ERROR)? {
            let mut bytes = Vec::new();
            f.take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .map_err(|_| ERROR)?;
            Some(bytes)
        } else {
            None
        };
        file::remove_private_file(&dir, CHECKPOINT).map_err(|_| ERROR)?;
        file::remove_private_file(&dir, TEMPORARY).map_err(|_| ERROR)?;
        file::sync_directory(&dir).map_err(|_| ERROR)?;
        bytes
    };
    let Some(bytes) = bytes.filter(|b| b.len() as u64 <= MAX_BYTES) else {
        return Ok(None);
    };
    let Ok(mut disk) = serde_json::from_slice::<DiskCheckpoint>(&bytes) else {
        return Ok(None);
    };
    let Some(token) = launch_token(args) else {
        return Ok(None);
    };
    if disk.version != 1
        || disk.target_version != compiled
        || disk.launch_token.as_deref() != Some(&token)
        || at < disk.created_at
        || at - disk.created_at > TTL_MS
        || validate_payload(&disk.continuation).is_err()
    {
        return Ok(None);
    }
    let Ok(Some(form)) = current_form::load(path.clone()) else {
        return Ok(None);
    };
    if !same_form(&form, &disk.continuation.form) {
        return Ok(None);
    }
    disk.continuation.saved_account =
        login::saved_account_matches(path, &disk.continuation.account);
    Ok(Some(disk.continuation))
}
pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let path = crate::app_data(app).map_err(|_| ERROR)?;
    // Invalid private storage suppresses automatic intent; it does not prevent
    // ordinary startup and must never follow an unsafe entry to clean it up.
    let available = consume(path, &app.env().args_os, env!("CARGO_PKG_VERSION"), now()?)
        .ok()
        .flatten();
    app.state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?
        .available = available;
    Ok(())
}
pub(crate) fn observe(app: &tauri::AppHandle, status: &Value) {
    let observed = status["sessionId"]
        .as_str()
        .zip(status["connectionId"].as_str())
        .zip(status.pointer("/player/name").and_then(Value::as_str))
        .filter(|_| status["connected"] == true && status["compatible"] == true)
        .map(|((session, connection), name)| {
            (
                GameIdentity {
                    session_id: session.into(),
                    connection_id: connection.into(),
                },
                name.to_owned(),
            )
        });
    if let Ok(mut state) = app.state::<SharedContinuation>().inner().lock() {
        state.observed_character = observed;
        state.observed_idle = status["runRequested"] == false && status["running"] == false;
    }
}
fn owner(
    app: &tauri::AppHandle,
    gate: &Gate,
) -> Result<(UpdateAccount, GameIdentity, u64), String> {
    let identity = gate.identity.clone().ok_or(ERROR)?;
    if gate
        .observed
        .map_or(true, |t| t.elapsed() > Duration::from_secs(2))
    {
        return invalid();
    }
    let state = app.state::<login::SharedLogin>();
    let login = state.lock().map_err(|_| ERROR)?;
    let account = login.update_account(&identity).ok_or(ERROR)?;
    Ok((account, identity, login.generation()))
}
#[tauri::command]
pub(crate) fn update_prepare(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
) -> Result<(), String> {
    crate::require_window(&window, "main")?;
    if !self::request_id(&request_id) {
        return invalid();
    }
    let gate = crate::maintenance::admit(&app)?;
    let (account, identity, generation) = owner(&app, &gate)?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    if state.prepared.is_some() || state.reserved.is_some() {
        return invalid();
    }
    clear_disk(crate::app_data(&app).map_err(|_| ERROR)?)?;
    state.prepared = Some(Prepared {
        request_id: request_id.clone(),
        account,
        identity,
        generation,
        until: Instant::now() + Duration::from_secs(60),
        checkpoint: None,
    });
    let result = app
        .get_webview_window("game")
        .ok_or(ERROR)?
        .eval(format!(
            "window.__RAYRAG__?.prepareUpdate({})",
            serde_json::to_string(&request_id).map_err(|_| ERROR)?
        ))
        .map_err(|_| ERROR.into());
    if result.is_err() {
        state.prepared = None;
    }
    result
}
#[tauri::command]
pub(crate) fn update_prepared(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    checkpoint: Value,
) -> Result<bool, String> {
    crate::require_game_runtime(&window)?;
    validate_runtime(&checkpoint)?;
    let gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let (account, identity, generation) = owner(&app, &gate)?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let Some(p) = state.prepared.as_mut() else {
        return Ok(false);
    };
    if p.request_id != request_id
        || p.account != account
        || p.identity != identity
        || p.generation != generation
        || Instant::now() >= p.until
        || p.checkpoint.is_some()
        || runtime_identity(&checkpoint).as_ref() != Some(&identity)
    {
        return Ok(false);
    }
    if state
        .observed_character
        .as_ref()
        .map(|(i, name)| (i, name.as_str()))
        != Some((&identity, character(&checkpoint).ok_or(ERROR)?))
    {
        return Ok(false);
    }
    let p = state.prepared.as_mut().ok_or(ERROR)?;
    p.checkpoint = Some(checkpoint.clone());
    app.get_webview_window("main")
        .ok_or(ERROR)?
        .emit(
            "update-prepared",
            json!({"requestId":request_id,"checkpoint":checkpoint}),
        )
        .map_err(|_| ERROR)?;
    Ok(true)
}
pub(crate) fn reserve(
    app: &tauri::AppHandle,
    gate: &Gate,
    nonce: &str,
    form: FormDocument,
    base: ContinuationBase,
) -> Result<(), String> {
    if base.version != 1 {
        return invalid();
    }
    validate_field(&base.field)?;
    let (account, identity, generation) = owner(app, gate)?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let p = state.prepared.as_ref().ok_or(ERROR)?;
    if p.account != account
        || p.identity != identity
        || p.generation != generation
        || Instant::now() >= p.until
        || p.checkpoint.is_none()
        || !base.field.is_null()
            && base.field["character"].as_str() != character(p.checkpoint.as_ref().unwrap())
    {
        return invalid();
    }
    let prepared = state.prepared.take().unwrap();
    state.reserved = Some(Reserved {
        prepared,
        nonce: nonce.into(),
        form,
        field: base.field,
        runtime: None,
    });
    Ok(())
}
fn envelope(r: &Reserved) -> Result<Continuation, String> {
    // Form types deliberately remain settings-only. Clone by validated JSON so
    // no persistence-only metadata is introduced into their public contract.
    let form = serde_json::from_value(serde_json::to_value(&r.form).map_err(|_| ERROR)?)
        .map_err(|_| ERROR)?;
    Ok(Continuation {
        version: 1,
        account: r.prepared.account.clone(),
        form,
        field: r.field.clone(),
        runtime: r.runtime.clone().ok_or(ERROR)?,
        saved_account: false,
    })
}
pub(crate) fn capture(
    app: &tauri::AppHandle,
    gate: &Gate,
    nonce: &str,
    checkpoint: Option<Value>,
    target: &str,
) -> Result<(), String> {
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let Some(r) = state.reserved.as_mut().filter(|r| r.nonce == nonce) else {
        return Ok(());
    };
    let checkpoint = checkpoint.ok_or(ERROR)?;
    validate_runtime(&checkpoint)?;
    let (account, identity, generation) = owner(app, gate)?;
    if r.prepared.account != account
        || r.prepared.identity != identity
        || r.prepared.generation != generation
        || runtime_identity(&checkpoint).as_ref() != Some(&identity)
        || character(&checkpoint) != character(r.prepared.checkpoint.as_ref().ok_or(ERROR)?)
    {
        return invalid();
    }
    r.runtime = Some(checkpoint);
    write_disk(
        crate::app_data(app).map_err(|_| ERROR)?,
        &DiskCheckpoint {
            version: 1,
            target_version: target.into(),
            created_at: now()?,
            launch_token: None,
            continuation: envelope(r)?,
        },
    )
}
pub(crate) fn failed(app: &tauri::AppHandle, retired: bool) {
    if let Ok(mut state) = app.state::<SharedContinuation>().inner().lock() {
        if retired {
            state.available =
                state
                    .reserved
                    .as_ref()
                    .and_then(|r| envelope(r).ok())
                    .map(|mut p| {
                        p.saved_account = crate::app_data(app)
                            .ok()
                            .is_some_and(|path| login::saved_account_matches(path, &p.account));
                        p
                    });
        }
        state.reserved = None;
        if let Ok(path) = crate::app_data(app) {
            let _ = clear_disk(path);
        }
    }
}
/// Called only after signed replacement and game retirement. The native UI
/// closure selects authority immediately before cleanup and process restart.
pub(crate) async fn restart(app: &tauri::AppHandle, target: &str) -> Result<(), String> {
    let target = target.to_owned();
    let restart_app = app.clone();
    let (failure, failed) = tokio::sync::oneshot::channel();
    app.run_on_main_thread(move || {
        let mut env = restart_app.env().clone();
        env.args_os
            .retain(|arg| !arg.to_str().is_some_and(|s| s.starts_with(LAUNCH_PREFIX)));
        let result = (|| -> Result<(), String> {
            let mut state = restart_app
                .state::<SharedContinuation>()
                .inner()
                .lock()
                .map_err(|_| ERROR)?;
            if let Some(r) = state.reserved.as_ref() {
                let token = uuid::Uuid::new_v4().simple().to_string();
                write_disk(
                    crate::app_data(&restart_app).map_err(|_| ERROR)?,
                    &DiskCheckpoint {
                        version: 1,
                        target_version: target,
                        created_at: now()?,
                        launch_token: Some(token.clone()),
                        continuation: envelope(r)?,
                    },
                )?;
                env.args_os.push(format!("{LAUNCH_PREFIX}{token}").into());
            }
            state.reserved = None;
            // Hold the authority lock through restart. Stop admitted before
            // this closure revokes it; no command can arm a ticket afterward.
            restart_app.cleanup_before_exit();
            tauri::process::restart(&env);
        })();
        // Only a failed handoff returns to the controller. A successful restart
        // exits this process without an IPC success/finally cancellation race.
        let _ = failure.send(result);
    })
    .map_err(|_| ERROR)?;
    failed.await.map_err(|_| ERROR)?
}

#[tauri::command]
pub(crate) fn update_continuation(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<Continuation>, String> {
    crate::require_window(&window, "main")?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let available = state.available.take();
    if let Some(p) = available.as_ref() {
        state.claimed = Some(Claimed {
            account: p.account.clone(),
            runtime: p.runtime.clone(),
        });
    }
    Ok(available)
}
#[tauri::command]
pub(crate) fn update_cancel(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: Option<String>,
) -> Result<bool, String> {
    crate::require_window(&window, "main")?;
    if request_id.as_ref().is_some_and(|id| !self::request_id(id)) {
        return invalid();
    }
    let mut gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let active = state
        .prepared
        .as_ref()
        .map(|p| &p.request_id)
        .or_else(|| state.reserved.as_ref().map(|r| &r.prepared.request_id))
        .cloned();
    if request_id.is_some() && request_id != active {
        return Ok(false);
    }
    state.revoke();
    clear_disk(crate::app_data(&app).map_err(|_| ERROR)?)?;
    let committed = gate.lease.as_ref().is_some_and(|l| l.committed);
    gate.cancel_update();
    if let Some(game) = app.get_webview_window("game").filter(|_| !committed) {
        let id = active.or(request_id);
        game.eval(format!(
            "window.__RAYRAG__?.cancelUpdate({})",
            serde_json::to_string(&id).map_err(|_| ERROR)?
        ))
        .map_err(|_| ERROR)?;
    }
    // Never discard a committed retirement or an unconfirmed transport owner.
    Ok(gate.lease.is_none())
}

/// Stop is cancellation, so it may revoke intent while the normal admission
/// gate is held. It never disconnects or erases the lease's transport owner.
pub(crate) fn stop_while_settling(app: &tauri::AppHandle) -> Result<bool, String> {
    let mut gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    if gate.lease.is_none() {
        return Ok(false);
    }
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let active = state.revoke();
    clear_disk(crate::app_data(app).map_err(|_| ERROR)?)?;
    if let Some(nonce) = gate.cancel_update() {
        if let Some(game) = app.get_webview_window("game") {
            let nonce = serde_json::to_string(&nonce).map_err(|_| ERROR)?;
            let id = serde_json::to_string(&active).map_err(|_| ERROR)?;
            game.eval(format!("window.__RAYRAG__?.maintenance({nonce},false);window.__RAYRAG__?.cancelUpdate({id});window.__RAYRAG__?.control('stop',null,null,null,null)"))
                .map_err(|_| ERROR)?;
        }
    }
    app.state::<login::SharedLogin>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?
        .cancel();
    Ok(true)
}
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub(crate) fn update_restore(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    checkpoint: Value,
    settings: Option<Settings>,
    escape_guard: Option<EscapeResumeGuard>,
    supply_guard: Option<SupplyResumeGuard>,
    death_recovery_guard: Option<DeathRecoveryGuard>,
) -> Result<(), String> {
    crate::require_window(&window, "main")?;
    if !self::request_id(&request_id) {
        return invalid();
    }
    validate_runtime(&checkpoint)?;
    if let Some(s) = &settings {
        s.validate()?;
    }
    if let Some(g) = &escape_guard {
        g.validate()?;
    }
    if let Some(g) = &supply_guard {
        g.validate()?;
    }
    if let Some(g) = &death_recovery_guard {
        g.validate()?;
    }
    let gate = crate::maintenance::admit(&app)?;
    let (account, identity, generation) = owner(&app, &gate)?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    if !state.restore_matches(&account, &checkpoint, &identity) {
        return invalid();
    }
    let payload = json!({"requestId":request_id,"checkpoint":checkpoint,"settings":settings,"escapeGuard":escape_guard,"supplyGuard":supply_guard,"deathRecoveryGuard":death_recovery_guard});
    let game = app.get_webview_window("game").ok_or(ERROR)?;
    state.restore = Some(Restore {
        request_id,
        identity,
        generation,
        until: Instant::now() + Duration::from_secs(10),
    });
    if game
        .eval(format!("window.__RAYRAG__?.restoreUpdate({payload})"))
        .is_err()
    {
        state.restore = None;
        return invalid();
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn update_restored(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request_id: String,
    success: bool,
) -> Result<bool, String> {
    crate::require_game_runtime(&window)?;
    let gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let (account, identity, generation) = owner(&app, &gate)?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    if !state.acknowledge_restore(&request_id, success, &account, &identity, generation) {
        return Ok(false);
    }
    app.get_webview_window("main")
        .ok_or(ERROR)?
        .emit(
            "update-restored",
            json!({"requestId":request_id,"success":success}),
        )
        .map_err(|_| ERROR)?;
    Ok(true)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn form(revision: u64) -> FormDocument {
        serde_json::from_value(json!({"version":1,"revision":revision,"selectedProfileId":null,"settings":{
            "map":"","targets":[],"radius":12,"minHpPercent":45,"loot":true,"route_randomWalk":0,
            "route_step":10,"route_avoidWalls":true,"route_randomWalk_maxRouteTime":75,
            "attackRouteMaxPathDistance":20,"attackMaxRouteTime":4
        }})).unwrap()
    }
    fn runtime() -> Value {
        json!({"version":1,"frozenAt":1,"status":{"sessionId":"old-page","connectionId":"old-socket","connected":true,"compatible":true,"runRequested":false,"player":{"name":"Synthetic"}},
            "settings":null,"macro":null,"partyHeal":{"version":1,"attempts":2,"confirmed":1,"cooldownUntil":1000},"run":null})
    }
    // Shape emitted by PersistentFieldRun.begin/checkpoint, including the
    // default-off, unlatched escape owner allocated for every field run.
    fn field_checkpoint() -> Value {
        let mut desired = serde_json::to_value(form(3).settings).unwrap();
        desired["map"] = "prontera".into();
        desired["targets"] = json!([1002]);
        json!({"version":1,"desired":desired,"character":"Synthetic","session":"old-page",
            "generation":2,"startedAt":100,"metricsSession":"old-page",
            "previous":{"kills":5,"looted":2,"deaths":0,"attacks":15},
            "totals":{"kills":3,"looted":4,"deaths":1,"attacks":9},
            "escapeGuard":{"session":"old-page","cooldownUntil":0,"latched":false},
            "supplyGuard":null,"deathGuard":null,"escapeOverflowUncertain":false,
            "supplyOverflow":false,"deathOverflow":false})
    }
    fn disk() -> DiskCheckpoint {
        DiskCheckpoint {
            version: 1,
            target_version: "1.2.3".into(),
            created_at: 1000,
            launch_token: Some("0123456789abcdef0123456789abcdef".into()),
            continuation: Continuation {
                version: 1,
                account: UpdateAccount {
                    username: "synthetic-account".into(),
                    character_slot: 1,
                    mode: login::ConnectionMode::BotOnly,
                },
                form: form(3),
                field: Value::Null,
                runtime: runtime(),
                saved_account: true,
            },
        }
    }
    fn arguments() -> Vec<OsString> {
        vec![
            "Companion".into(),
            format!("{LAUNCH_PREFIX}0123456789abcdef0123456789abcdef").into(),
        ]
    }
    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap();
        current_form::save(path.clone(), &form(3)).unwrap();
        (dir, path)
    }
    #[test]
    fn field_escape_guard_accepts_default_off_latched_and_optional_recovery() {
        let mut checkpoint = field_checkpoint();
        assert!(validate_field(&checkpoint).is_ok());
        checkpoint["escapeGuard"]["latched"] = true.into();
        checkpoint["escapeGuard"]["cooldownUntil"] = 1000.into();
        assert!(validate_field(&checkpoint).is_ok());
        checkpoint["escapeGuard"]["recovery"] =
            json!({"hpPercent":80,"threatCount":2,"quietSeconds":5});
        assert!(validate_field(&checkpoint).is_ok());
    }
    #[test]
    fn field_escape_guard_rejects_malformed_latched_and_present_null_recovery() {
        for latched in [Value::Null, 0.into(), "false".into()] {
            let mut checkpoint = field_checkpoint();
            checkpoint["escapeGuard"]["latched"] = latched;
            assert!(validate_field(&checkpoint).is_err());
        }
        let mut checkpoint = field_checkpoint();
        checkpoint["escapeGuard"]
            .as_object_mut()
            .unwrap()
            .remove("latched");
        assert!(validate_field(&checkpoint).is_err());
        for recovery in [
            Value::Null,
            json!({"hpPercent":0,"threatCount":0,"quietSeconds":0}),
            json!({"hpPercent":80,"threatCount":2,"quietSeconds":5,"extra":true}),
        ] {
            let mut checkpoint = field_checkpoint();
            checkpoint["escapeGuard"]["recovery"] = recovery;
            assert!(validate_field(&checkpoint).is_err());
        }
    }
    #[test]
    fn nonnull_field_reservation_and_private_claim_preserve_all_checkpoint_metadata() {
        for recovery in [
            None,
            Some(json!({"hpPercent":80,"threatCount":2,"quietSeconds":5})),
        ] {
            let (_dir, path) = root();
            let mut field = field_checkpoint();
            if let Some(recovery) = recovery {
                field["escapeGuard"]["latched"] = true.into();
                field["escapeGuard"]["cooldownUntil"] = 1000.into();
                field["escapeGuard"]["recovery"] = recovery;
            }
            let base: ContinuationBase =
                serde_json::from_value(json!({"version":1,"field":field})).unwrap();
            assert_eq!(base.version, 1);
            validate_field(&base.field).unwrap(); // The update_reserve field boundary.
            let mut final_runtime = runtime();
            final_runtime["frozenAt"] = 1000.into();
            final_runtime["settings"] = base.field["desired"].clone();
            final_runtime["status"]["runRequested"] = true.into();
            final_runtime["run"] = json!({"startedAt":100,"kills":3,"pickups":4,"deaths":1});
            let reservation = Reserved {
                prepared: Prepared {
                    request_id: "0123456789abcdef0123456789abcdef".into(),
                    account: disk().continuation.account,
                    identity: runtime_identity(&final_runtime).unwrap(),
                    generation: 2,
                    until: Instant::now() + Duration::from_secs(60),
                    checkpoint: Some(final_runtime.clone()),
                },
                nonce: "fedcba9876543210fedcba9876543210".into(),
                form: form(3),
                field: base.field,
                runtime: Some(final_runtime.clone()),
            };
            let mut record = disk();
            record.continuation = envelope(&reservation).unwrap();
            write_disk(path.clone(), &record).unwrap();
            let claimed = consume(path.clone(), &arguments(), "1.2.3", 1001)
                .unwrap()
                .unwrap();
            assert_eq!(claimed.field, field);
            assert_eq!(claimed.runtime, final_runtime);
            assert_eq!(claimed.account, reservation.prepared.account);
            assert!(same_form(&claimed.form, &reservation.form));
            assert!(consume(path, &arguments(), "1.2.3", 1001)
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn private_checkpoint_is_consumed_once_without_persisting_credentials() {
        let (_dir, path) = root();
        write_disk(path.clone(), &disk()).unwrap();
        let store = file::LocalLoginStore::new(path.clone());
        let directory = store.open_directory(false).unwrap().unwrap();
        file::verify_private(&directory, true).unwrap();
        let checkpoint = file::private_file(&directory, CHECKPOINT).unwrap().unwrap();
        file::verify_private(&checkpoint, false).unwrap();
        drop(directory);
        let claimed = consume(path.clone(), &arguments(), "1.2.3", 1001)
            .unwrap()
            .unwrap();
        assert!(!claimed.saved_account); // Caller cannot forge saved credential authority.
        assert_eq!(claimed.account.character_slot, 1);
        assert_eq!(claimed.runtime["partyHeal"]["attempts"], 2);
        assert!(consume(path.clone(), &arguments(), "1.2.3", 1001)
            .unwrap()
            .is_none());
        assert!(!path.join("login").join(CHECKPOINT).exists());
        let text = serde_json::to_string(&claimed).unwrap();
        assert!(!text.contains("password"));
    }
    #[test]
    fn ordinary_crash_unarmed_wrong_version_wrong_token_replay_and_expired_startup_never_resume() {
        for case in 0..8 {
            let (_dir, path) = root();
            let mut record = disk();
            let mut args = arguments();
            let mut compiled = "1.2.3";
            let mut at = 1001;
            match case {
                0 => args = vec!["Companion".into()],
                1 => record.launch_token = None,
                2 => compiled = "1.2.4",
                3 => args[1] = format!("{LAUNCH_PREFIX}ffffffffffffffffffffffffffffffff").into(),
                4 => args.push(args[1].clone()),
                5 => at = 1000 + TTL_MS + 1,
                6 => at = 999,
                _ => args[1] = format!("{LAUNCH_PREFIX}not-a-token").into(),
            }
            write_disk(path.clone(), &record).unwrap();
            assert!(
                consume(path.clone(), &args, compiled, at)
                    .unwrap()
                    .is_none(),
                "case {case}"
            );
            assert!(!path.join("login").join(CHECKPOINT).exists());
            assert!(consume(path, &arguments(), "1.2.3", 1001)
                .unwrap()
                .is_none());
        }
    }
    #[test]
    fn corrupt_oversized_and_unknown_disk_schema_are_consumed_without_authority() {
        for data in [b"corrupt".to_vec(), vec![b' '; MAX_BYTES as usize + 1], {
            let mut value = serde_json::to_value(disk()).unwrap();
            value["extra"] = true.into();
            serde_json::to_vec(&value).unwrap()
        }] {
            let (_dir, path) = root();
            write_disk(path.clone(), &disk()).unwrap();
            std::fs::write(path.join("login").join(CHECKPOINT), data).unwrap();
            assert!(consume(path.clone(), &arguments(), "1.2.3", 1001)
                .unwrap()
                .is_none());
            assert!(!path.join("login").join(CHECKPOINT).exists());
        }
    }
    #[test]
    fn changed_form_or_character_cannot_reuse_the_checkpoint() {
        let (_dir, path) = root();
        write_disk(path.clone(), &disk()).unwrap();
        current_form::save(path.clone(), &form(4)).unwrap();
        assert!(consume(path.clone(), &arguments(), "1.2.3", 1001)
            .unwrap()
            .is_none());
        let mut record = disk();
        record.continuation.runtime["status"]["player"] = Value::Null;
        assert!(write_disk(path, &record).is_err());
    }
    #[test]
    fn credential_packet_unknown_roots_and_unbounded_metadata_reject() {
        for key in [
            "password",
            "credentials",
            "rawPacket",
            "accessToken",
            "refresh_token",
            "cookie",
        ] {
            let mut record = runtime();
            record["status"][key] = "synthetic-only".into();
            assert!(validate_runtime(&record).is_err(), "{key}");
        }
        let mut record = runtime();
        record["futureRoot"] = 1.into();
        assert!(validate_runtime(&record).is_err());
        let mut record = runtime();
        record["partyHeal"]["confirmed"] = 3.into();
        assert!(validate_runtime(&record).is_err());
        let mut record = runtime();
        record["frozenAt"] = (now().unwrap() + 60_000).into();
        assert!(validate_runtime(&record).is_err());
        let mut record = runtime();
        record["status"]["log"] = json!(["x".repeat(65_537)]);
        assert!(validate_runtime(&record).is_err());
        let mut record = runtime();
        record["settings"] = json!({"map":"wrong"});
        assert!(validate_runtime(&record).is_err());
    }
    #[test]
    fn cancellation_revokes_available_and_claimed_authority() {
        let mut state = ContinuationState {
            available: Some(disk().continuation),
            claimed: Some(Claimed {
                account: disk().continuation.account,
                runtime: runtime(),
            }),
            ..Default::default()
        };
        state.revoke();
        assert!(state.available.is_none());
        assert!(state.claimed.is_none());
        assert!(state.restore.is_none());
        let (_dir, path) = root();
        write_disk(path.clone(), &disk()).unwrap();
        clear_disk(path.clone()).unwrap();
        assert!(consume(path, &arguments(), "1.2.3", 1001)
            .unwrap()
            .is_none());
    }
    #[test]
    fn restore_requires_the_claimed_account_character_runtime_and_fresh_idle_owner() {
        let account = disk().continuation.account;
        let checkpoint = runtime();
        let identity = GameIdentity {
            session_id: "fresh-page".into(),
            connection_id: "fresh-socket".into(),
        };
        let mut state = ContinuationState {
            claimed: Some(Claimed {
                account: account.clone(),
                runtime: checkpoint.clone(),
            }),
            observed_character: Some((identity.clone(), "Synthetic".into())),
            observed_idle: true,
            ..Default::default()
        };
        assert!(state.restore_matches(&account, &checkpoint, &identity));
        let mut wrong = account.clone();
        wrong.character_slot = 2;
        assert!(!state.restore_matches(&wrong, &checkpoint, &identity));
        let mut changed = checkpoint.clone();
        changed["partyHeal"]["attempts"] = 3.into();
        assert!(!state.restore_matches(&account, &changed, &identity));
        state.observed_character.as_mut().unwrap().1 = "Other".into();
        assert!(!state.restore_matches(&account, &checkpoint, &identity));
        state.observed_character.as_mut().unwrap().1 = "Synthetic".into();
        state.observed_idle = false;
        assert!(!state.restore_matches(&account, &checkpoint, &identity));
        state.observed_idle = true;
        state.revoke();
        assert!(!state.restore_matches(&account, &checkpoint, &identity));
    }
    #[test]
    fn rejected_restore_keeps_claim_for_a_fresh_request_and_success_consumes_it() {
        let account = disk().continuation.account;
        let checkpoint = runtime();
        let identity = GameIdentity {
            session_id: "fresh-page".into(),
            connection_id: "fresh-socket".into(),
        };
        let first = "0123456789abcdef0123456789abcdef";
        let second = "fedcba9876543210fedcba9876543210";
        let mut state = ContinuationState {
            claimed: Some(Claimed {
                account: account.clone(),
                runtime: checkpoint.clone(),
            }),
            observed_character: Some((identity.clone(), "Synthetic".into())),
            observed_idle: true,
            restore: Some(Restore {
                request_id: first.into(),
                identity: identity.clone(),
                generation: 2,
                until: Instant::now() + Duration::from_secs(10),
            }),
            ..Default::default()
        };
        assert!(state.acknowledge_restore(first, false, &account, &identity, 2));
        assert!(state.restore.is_none());
        assert!(state.restore_matches(&account, &checkpoint, &identity));
        assert!(!state.acknowledge_restore(first, true, &account, &identity, 2));
        state.restore = Some(Restore {
            request_id: second.into(),
            identity: identity.clone(),
            generation: 2,
            until: Instant::now() + Duration::from_secs(10),
        });
        assert!(!state.acknowledge_restore(first, true, &account, &identity, 2));
        assert!(state.acknowledge_restore(second, true, &account, &identity, 2));
        assert!(state.restore.is_none());
        assert!(state.claimed.is_none());
        assert!(!state.restore_matches(&account, &checkpoint, &identity));
        assert!(!state.acknowledge_restore(second, true, &account, &identity, 2));
    }
    #[test]
    fn unknown_restore_timeout_keeps_activation_blocked() {
        let account = disk().continuation.account;
        let checkpoint = runtime();
        let identity = GameIdentity {
            session_id: "fresh-page".into(),
            connection_id: "fresh-socket".into(),
        };
        let request = "0123456789abcdef0123456789abcdef";
        let mut state = ContinuationState {
            claimed: Some(Claimed {
                account: account.clone(),
                runtime: checkpoint.clone(),
            }),
            observed_character: Some((identity.clone(), "Synthetic".into())),
            observed_idle: true,
            restore: Some(Restore {
                request_id: request.into(),
                identity: identity.clone(),
                generation: 2,
                until: Instant::now(),
            }),
            ..Default::default()
        };
        assert!(!state.acknowledge_restore(request, false, &account, &identity, 2));
        assert!(state.restore.is_some());
        assert!(!state.restore_matches(&account, &checkpoint, &identity));
    }
    #[cfg(unix)]
    #[test]
    fn symlink_hardlink_or_nonprivate_checkpoint_never_follows_or_mutates_an_outside_file() {
        use std::os::unix::fs::{symlink, PermissionsExt};
        for kind in 0..3 {
            let (_dir, path) = root();
            write_disk(path.clone(), &disk()).unwrap();
            let checkpoint = path.join("login").join(CHECKPOINT);
            let outside = path.join("outside");
            if kind == 0 {
                std::fs::write(&outside, b"outside synthetic").unwrap();
                std::fs::remove_file(&checkpoint).unwrap();
                symlink(&outside, &checkpoint).unwrap();
            } else if kind == 1 {
                std::fs::hard_link(&checkpoint, &outside).unwrap();
            } else {
                std::fs::set_permissions(&checkpoint, std::fs::Permissions::from_mode(0o644))
                    .unwrap();
            }
            let before = std::fs::read(if kind == 2 { &checkpoint } else { &outside }).unwrap();
            assert!(consume(path.clone(), &arguments(), "1.2.3", 1001).is_err());
            assert!(clear_disk(path).is_err());
            assert_eq!(
                std::fs::read(if kind == 2 { checkpoint } else { outside }).unwrap(),
                before
            );
        }
    }
}

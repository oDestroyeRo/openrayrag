//! One-shot update continuation authority. Ordinary startup never grants run intent.
use crate::update::update_continuation_logic::{
    self as policy, character, restart_arguments, runtime_identity, startup_stopped,
    validate_field, AdmittedContinuation, DiskCheckpoint, ERROR, LAUNCH_PREFIX, MAX_BYTES,
};
#[cfg(test)]
use crate::update::update_continuation_logic::{launch_token, STOPPED_FLAG, TTL_MS};
pub(crate) use crate::update::update_continuation_logic::{
    request_id, Continuation, ContinuationBase,
};
use crate::{
    session::login::{self, local_store as file, UpdateAccount},
    session::maintenance::{GameIdentity, Gate, SharedGate},
    settings::automation::{DeathRecoveryGuard, EscapeResumeGuard, Settings, SupplyResumeGuard},
    settings::current_form::{self, FormDocument},
    settings::current_form_logic::same_form,
};
use serde_json::{json, Value};
use std::{
    ffi::OsString,
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{Emitter, Manager, Webview};

const CHECKPOINT: &str = "update-continuation.json";
const TEMPORARY: &str = ".update-continuation.tmp";

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
// Startup requires consumed-checkpoint proof; a retired retry retains the
// already-owned reservation. Keep their different admission histories explicit.
enum AvailableContinuation {
    Consumed(AdmittedContinuation),
    RetiredRetry(Continuation),
}
impl AvailableContinuation {
    fn raw(&self) -> &Continuation {
        match self {
            Self::Consumed(value) => value.raw(),
            Self::RetiredRetry(value) => value,
        }
    }
    fn into_wire(self) -> Continuation {
        match self {
            Self::Consumed(value) => value.into_wire(),
            Self::RetiredRetry(value) => value,
        }
    }
}
#[derive(Default)]
pub(crate) struct ContinuationState {
    prepared: Option<Prepared>,
    reserved: Option<Reserved>,
    available: Option<AvailableContinuation>,
    claimed: Option<Claimed>,
    restore: Option<Restore>,
    observed_character: Option<(GameIdentity, String)>,
    observed_idle: bool,
    stop_restart: bool,
}
pub(crate) type SharedContinuation = Mutex<ContinuationState>;
impl ContinuationState {
    fn begin_prepare(&mut self, prepared: Prepared) -> Result<(), String> {
        if self.prepared.is_some() || self.reserved.is_some() {
            return invalid();
        }
        // Normal admission excludes a still-settling transaction. This request
        // belongs to the user's fresh run intent, not an earlier stopped update.
        self.stop_restart = false;
        self.prepared = Some(prepared);
        Ok(())
    }
    fn cancel(&mut self, committed: bool, stop: bool) -> Option<String> {
        self.stop_restart |= committed && stop;
        self.revoke()
    }
    fn finish_failure(&mut self, gate: &Gate) {
        // The caller still owns admission: a later transaction cannot begin
        // between releasing this failed lease and clearing its Stop marker.
        if gate.lease.is_none() {
            self.stop_restart = false;
        }
    }
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
fn now() -> Result<u64, String> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| ERROR)?
        .as_millis()
        .try_into()
        .map_err(|_| ERROR.into())
}
pub(crate) fn validate_runtime(value: &Value) -> Result<(), String> {
    policy::validate_runtime(value, now().unwrap_or(0))
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
    let bytes = policy::encode_checkpoint(disk, now().unwrap_or(0))?;
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
fn read_and_remove_checkpoint(path: PathBuf) -> Result<Option<Vec<u8>>, String> {
    let Some(dir) = file::LocalLoginStore::new(path)
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
    Ok(bytes)
}
/// Remove the private checkpoint under its directory lock before validating or
/// exposing it. Even wrong arguments, corrupt contents and crashes consume it.
fn consume(
    path: PathBuf,
    args: &[OsString],
    compiled: &str,
    at: u64,
) -> Result<Option<AdmittedContinuation>, String> {
    let bytes = read_and_remove_checkpoint(path.clone())?;
    let Some(continuation) = bytes.and_then(|bytes| {
        policy::eligible_checkpoint(&bytes, args, compiled, at, now().unwrap_or(0))
    }) else {
        return Ok(None);
    };
    let Ok(Some(form)) = current_form::load(path.clone()) else {
        return Ok(None);
    };
    if !same_form(&form, &continuation.raw().form) {
        return Ok(None);
    }
    let saved_account = login::saved_account_matches(path, &continuation.raw().account);
    Ok(Some(continuation.with_saved_account(saved_account)))
}
pub(crate) fn initialize(app: &tauri::AppHandle) -> Result<(), String> {
    let path = crate::app_data(app).map_err(|_| ERROR)?;
    // Invalid private storage suppresses automatic intent; it does not prevent
    // ordinary startup and must never follow an unsafe entry to clean it up.
    let available = consume(path, &app.env().args_os, env!("CARGO_PKG_VERSION"), now()?)
        .ok()
        .flatten()
        .map(AvailableContinuation::Consumed);
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
        .is_none_or(|t| t.elapsed() > Duration::from_secs(2))
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
    window: Webview,
    request_id: String,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    if !self::request_id(&request_id) {
        return invalid();
    }
    let gate = crate::session::maintenance::admit(&app)?;
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
    state.begin_prepare(Prepared {
        request_id: request_id.clone(),
        account,
        identity,
        generation,
        until: Instant::now() + Duration::from_secs(60),
        checkpoint: None,
    })?;
    let result = app
        .get_webview("game")
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
    window: Webview,
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
        || !runtime_identity(&checkpoint).is_some_and(|proof| proof.matches(&identity))
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
    app.get_webview("main")
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
    policy::envelope(&r.prepared.account, &r.form, &r.field, r.runtime.as_ref())
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
        || !runtime_identity(&checkpoint).is_some_and(|proof| proof.matches(&identity))
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
                        AvailableContinuation::RetiredRetry(p)
                    });
        }
        state.reserved = None;
        if let Ok(path) = crate::app_data(app) {
            let _ = clear_disk(path);
        }
    }
}
pub(crate) fn finish_failure(app: &tauri::AppHandle, gate: &Gate) {
    if let Ok(mut state) = app.state::<SharedContinuation>().inner().lock() {
        state.finish_failure(gate);
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
        let result = (|| -> Result<(), String> {
            let state = restart_app
                .state::<SharedContinuation>()
                .inner()
                .lock()
                .map_err(|_| ERROR)?;
            env.args_os = restart_arguments(&env.args_os, state.stop_restart);
            if let Some(r) = state.reserved.as_ref().filter(|_| !state.stop_restart) {
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
            // Hold the authority lock through restart. Stop admitted before
            // this closure revokes it; no command can arm a ticket afterward.
            // A failed launch retains the reservation for existing failure
            // recovery. Cleanup occurs only after LaunchServices accepts it.
            crate::update::update_restart::restart(&restart_app, &env)
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
    window: Webview,
) -> Result<Option<Continuation>, String> {
    crate::require_view(&window, "main")?;
    if crate::shell::ci_smoke::active() {
        return Ok(None);
    }
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let available = state.available.take();
    if let Some(p) = available.as_ref() {
        let p = p.raw();
        state.claimed = Some(Claimed {
            account: p.account.clone(),
            runtime: p.runtime.clone(),
        });
    }
    Ok(available.map(AvailableContinuation::into_wire))
}
#[tauri::command]
pub(crate) fn update_startup_stopped(
    app: tauri::AppHandle,
    window: Webview,
) -> Result<bool, String> {
    crate::require_view(&window, "main")?;
    if crate::shell::ci_smoke::active() {
        return Ok(false);
    }
    // This launch-only opt-out grants no run authority and changes no saved preference.
    Ok(startup_stopped(&app.env().args_os))
}
#[tauri::command]
pub(crate) fn update_cancel(
    app: tauri::AppHandle,
    window: Webview,
    request_id: Option<String>,
    stop: Option<bool>,
    mcp_operation: Option<String>,
) -> Result<bool, String> {
    crate::require_view(&window, "main")?;
    if request_id.as_ref().is_some_and(|id| !self::request_id(id)) {
        return invalid();
    }
    let mut gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let _mcp =
        crate::mcp::authorize_effect(&app, &gate, mcp_operation.as_deref(), "update_cancel")?;
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
    let committed = gate.lease.as_ref().is_some_and(|l| l.committed);
    state.cancel(committed, stop.unwrap_or(false));
    clear_disk(crate::app_data(&app).map_err(|_| ERROR)?)?;
    gate.cancel_update();
    if let Some(game) = app.get_webview("game").filter(|_| !committed) {
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
pub(crate) fn stop_while_settling(
    app: &tauri::AppHandle,
    mcp_operation: Option<&str>,
) -> Result<bool, String> {
    let mut gate = app
        .state::<SharedGate>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    if gate.lease.is_none() {
        return Ok(false);
    }
    let _mcp = crate::mcp::authorize_effect(app, &gate, mcp_operation, "control_bot:stop")?;
    let mut state = app
        .state::<SharedContinuation>()
        .inner()
        .lock()
        .map_err(|_| ERROR)?;
    let active = state.cancel(gate.lease.as_ref().is_some_and(|l| l.committed), true);
    clear_disk(crate::app_data(app).map_err(|_| ERROR)?)?;
    if let Some(nonce) = gate.cancel_update() {
        if let Some(game) = app.get_webview("game") {
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
    window: Webview,
    request_id: String,
    checkpoint: Value,
    settings: Option<Settings>,
    escape_guard: Option<EscapeResumeGuard>,
    supply_guard: Option<SupplyResumeGuard>,
    death_recovery_guard: Option<DeathRecoveryGuard>,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
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
    let gate = crate::session::maintenance::admit(&app)?;
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
    let game = app.get_webview("game").ok_or(ERROR)?;
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
    window: Webview,
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
    app.get_webview("main")
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
    fn prepared(request_id: &str, checkpoint: Value) -> Prepared {
        Prepared {
            request_id: request_id.into(),
            account: disk().continuation.account,
            identity: runtime_identity(&checkpoint).unwrap().into_observation(),
            generation: 2,
            until: Instant::now() + Duration::from_secs(60),
            checkpoint: Some(checkpoint),
        }
    }
    #[test]
    fn failed_committed_update_keeps_stop_until_release_then_a_fresh_run_can_resume() {
        let mut gate = Gate::default();
        gate.initialized = true;
        gate.form_revision = Some(3);
        let old_nonce = uuid::Uuid::new_v4().simple().to_string();
        gate.reserve(old_nonce.clone(), 3, false).unwrap();
        gate.commit(&old_nonce).unwrap();
        let owner = gate.begin_retirement(&old_nonce, false).unwrap();
        let mut state = ContinuationState {
            available: Some(AvailableContinuation::RetiredRetry(disk().continuation)),
            ..Default::default()
        };
        state.cancel(true, true);
        assert!(state.stop_restart);
        assert!(gate.admit().is_err());
        state.finish_failure(&gate); // Failure has not released its owned lease yet.
        assert!(state.stop_restart);
        state.cancel(true, true); // A late Stop while failure cleanup is waiting.
        assert!(gate.cancel_update().is_none());
        gate.release_retirement(&owner);
        state.finish_failure(&gate); // Called with admission still held in production.
        assert!(!state.stop_restart);
        assert!(state.available.is_none());
        assert!(state.claimed.is_none());

        gate.admit().unwrap(); // The user explicitly starts a fresh run.
        let field = field_checkpoint();
        let mut checkpoint = runtime();
        checkpoint["frozenAt"] = 1000.into();
        checkpoint["status"]["runRequested"] = true.into();
        checkpoint["settings"] = field["desired"].clone();
        checkpoint["run"] = json!({"startedAt":100,"kills":5,"pickups":2,"deaths":0});
        state
            .begin_prepare(prepared(
                "fedcba9876543210fedcba9876543210",
                checkpoint.clone(),
            ))
            .unwrap();
        state.reserved = Some(Reserved {
            prepared: state.prepared.take().unwrap(),
            nonce: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa".into(),
            form: form(3),
            field: field.clone(),
            runtime: Some(checkpoint.clone()),
        });
        let (_dir, path) = root();
        let mut record = disk();
        record.continuation = envelope(state.reserved.as_ref().unwrap()).unwrap();
        let mut args = arguments();
        args.push(STOPPED_FLAG.into()); // Inherited arguments do not poison the new update.
        args = restart_arguments(&args, state.stop_restart);
        assert!(!startup_stopped(&args));
        write_disk(path.clone(), &record).unwrap();
        args.push(format!("{LAUNCH_PREFIX}{}", record.launch_token.unwrap()).into());
        let claimed = consume(path, &args, "1.2.3", 1001)
            .unwrap()
            .unwrap()
            .into_wire();
        assert_eq!(claimed.runtime, checkpoint);
        assert_eq!(claimed.field, field);
    }
    #[test]
    fn only_a_fresh_accepted_preparation_clears_an_earlier_stop_marker() {
        let mut state = ContinuationState {
            prepared: Some(prepared("0123456789abcdef0123456789abcdef", runtime())),
            stop_restart: true,
            ..Default::default()
        };
        assert!(state
            .begin_prepare(prepared("fedcba9876543210fedcba9876543210", runtime()))
            .is_err());
        assert!(state.stop_restart);
        state.revoke();
        state
            .begin_prepare(prepared("fedcba9876543210fedcba9876543210", runtime()))
            .unwrap();
        assert!(!state.stop_restart);
        assert_eq!(
            state.prepared.as_ref().unwrap().request_id,
            "fedcba9876543210fedcba9876543210"
        );
    }
    #[test]
    fn smoke_capability_has_startup_queries_and_isolated_offline_stop_authority() {
        let capability: Value =
            serde_json::from_str(include_str!("../../capabilities/ci-smoke.json")).unwrap();
        assert!(capability.get("windows").is_none());
        assert_eq!(capability["webviews"], json!(["main"]));
        let permissions = capability["permissions"].as_array().unwrap();
        for query in ["allow-update-continuation", "allow-update-startup-stopped"] {
            assert!(permissions.iter().any(|p| p == query));
        }
        for permission in permissions {
            assert!(matches!(
                permission.as_str().unwrap(),
                "core:event:allow-listen"
                    | "core:event:allow-unlisten"
                    | "core:window:allow-close"
                    | "allow-ci-smoke-report"
                    | "allow-current-form"
                    | "allow-save-current-form"
                    | "allow-settings-close-ready"
                    | "allow-settings-close-cancel"
                    | "allow-settings-close-complete"
                    | "allow-saved-login"
                    | "allow-update-continuation"
                    | "allow-update-startup-stopped"
                    | "allow-update-initialized"
                    | "allow-update-status"
                    | "allow-mcp-set-enabled"
                    | "allow-mcp-reply"
                    | "allow-mcp-claim"
                    | "allow-control-bot"
                    | "allow-update-cancel"
            ));
        }
    }
    #[test]
    fn only_explicit_stop_during_a_committed_update_marks_the_restart() {
        for (committed, stop) in [(false, false), (false, true), (true, false), (true, true)] {
            let mut state = ContinuationState {
                available: Some(AvailableContinuation::RetiredRetry(disk().continuation)),
                ..Default::default()
            };
            state.cancel(committed, stop);
            assert_eq!(state.stop_restart, committed && stop);
            assert!(state.available.is_none());
            assert!(state.claimed.is_none());
            let mut args = arguments();
            args = restart_arguments(&args, state.stop_restart);
            assert_eq!(startup_stopped(&args), committed && stop);
            assert!(launch_token(&args).is_none());
            state.cancel(committed, false); // Later failure cleanup cannot undo explicit Stop.
            assert_eq!(state.stop_restart, committed && stop);
        }
    }
    #[test]
    fn subsequent_updates_strip_inherited_stop_and_resume_arguments() {
        let mut args = arguments();
        args.push(STOPPED_FLAG.into());
        args.push("--unrelated-option".into());
        args = restart_arguments(&args, false);
        assert_eq!(
            args,
            vec![
                OsString::from("Companion"),
                OsString::from("--unrelated-option")
            ]
        );
        assert!(!startup_stopped(&args));
        assert!(launch_token(&args).is_none());
        args = restart_arguments(&args, true);
        assert!(startup_stopped(&args));
        assert!(launch_token(&args).is_none());
        args = restart_arguments(&args, true);
        assert_eq!(
            args.iter()
                .filter(|arg| arg.to_str() == Some(STOPPED_FLAG))
                .count(),
            1
        );
        args = restart_arguments(&args, false);
        assert!(!startup_stopped(&args));
    }
    #[test]
    fn ordinary_launches_have_no_stop_marker_and_lookalike_flags_are_not_opt_outs() {
        for args in [
            vec!["Companion".into()],
            vec![STOPPED_FLAG.into()],
            vec!["Companion".into(), "--rayrag-update-stopped=true".into()],
            vec!["Companion".into(), "--rayrag-update-stopped-other".into()],
        ] {
            assert!(!startup_stopped(&args));
        }
    }
    fn root() -> (tempfile::TempDir, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap();
        current_form::save(path.clone(), &form(3)).unwrap();
        (dir, path)
    }
    #[test]
    fn stopped_launch_grants_no_resume_authority_and_keeps_saved_login_preferences() {
        let (_dir, path) = root();
        write_disk(path.clone(), &disk()).unwrap();
        let profile = serde_json::to_vec(
            &json!({"username":"synthetic-account","password":"synthetic-only",
            "characterSlot":1,"mode":"botOnly","autoLogin":true}),
        )
        .unwrap();
        {
            let store = file::LocalLoginStore::new(path.clone());
            let directory = store.open_directory(false).unwrap().unwrap();
            let mut saved = file::create_private_file(&directory, "profile.json").unwrap();
            saved.write_all(&profile).unwrap();
            saved.sync_all().unwrap();
            file::sync_directory(&directory).unwrap();
        }
        let mut args = arguments();
        args.push(STOPPED_FLAG.into()); // Stop overrides even a matching native launch proof.
        assert!(startup_stopped(&args));
        assert!(consume(path.clone(), &args, "1.2.3", 1001)
            .unwrap()
            .is_none());
        assert_eq!(
            std::fs::read(path.join("login/profile.json")).unwrap(),
            profile
        );
        assert!(login::saved_account_matches(
            path.clone(),
            &disk().continuation.account
        ));
        assert!(consume(path, &arguments(), "1.2.3", 1001)
            .unwrap()
            .is_none());
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
                    identity: runtime_identity(&final_runtime).unwrap().into_observation(),
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
                .unwrap()
                .into_wire();
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
        // NTFS completes deletion after the last file handle closes. Release
        // this inspection handle before exercising one-shot consumption.
        drop(checkpoint);
        drop(directory);
        let claimed = consume(path.clone(), &arguments(), "1.2.3", 1001)
            .unwrap()
            .unwrap()
            .into_wire();
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
            available: Some(AvailableContinuation::RetiredRetry(disk().continuation)),
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

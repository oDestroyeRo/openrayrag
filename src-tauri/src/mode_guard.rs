//! Shared, durable Warp uncertainty across the two webview origins.
use crate::{
    login::{local_store as file, ConnectionMode},
    maintenance::GameIdentity,
};
use serde::{Deserialize, Serialize};
use std::{
    io::{Read, Write},
    path::PathBuf,
    sync::Mutex,
};
use tauri::{Manager, WebviewWindow};
const ERROR: &str =
    "Warp recovery guard unavailable. Reconnect in the previous mode before switching.";
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Hold {
    mode: ConnectionMode,
    nonce: String,
}
#[derive(Default)]
pub(crate) struct SharedGuard(Mutex<GuardState>);
#[derive(Default)]
struct GuardState {
    pending: Option<ConnectionMode>,
    permit: Option<Permit>,
}
impl GuardState {
    fn take_initialization(&mut self, mode: ConnectionMode) -> Result<(), String> {
        if self.pending != Some(mode) {
            return Err("Initialization permit is unavailable in this world.".into());
        }
        self.pending = None;
        Ok(())
    }
}
struct Permit {
    id: String,
    mode: ConnectionMode,
    nonce: String,
    generation: u64,
    owner: Option<GameIdentity>,
}
impl Permit {
    fn allows(
        &self,
        id: &str,
        mode: ConnectionMode,
        generation: u64,
        owner: &GameIdentity,
    ) -> bool {
        self.id == id
            && self.mode == mode
            && self.generation == generation
            && self.owner.as_ref() == Some(owner)
    }
}
fn read(directory: &std::fs::File) -> Result<Option<Hold>, String> {
    let Some(f) = file::private_file(directory, "connection-hold.json").map_err(|_| ERROR)? else {
        return Ok(None);
    };
    if f.metadata().map_err(|_| ERROR)?.len() > 128 {
        return Err(ERROR.into());
    }
    let mut bytes = Vec::new();
    f.take(129).read_to_end(&mut bytes).map_err(|_| ERROR)?;
    serde_json::from_slice(&bytes)
        .map(Some)
        .map_err(|_| ERROR.into())
}
pub(crate) fn check(path: PathBuf, mode: ConnectionMode) -> Result<(), String> {
    let store = file::LocalLoginStore::settings(path);
    let Some(dir) = store.open_directory(false).map_err(|_| ERROR)? else {
        return Ok(());
    };
    if read(&dir)?.is_some_and(|held| held.mode != mode) {
        return Err("An unresolved Warp request belongs to the previous connection mode. Reconnect that mode and wait for authoritative character initialization before switching.".into());
    }
    Ok(())
}
fn mark(path: PathBuf, mode: ConnectionMode) -> Result<String, String> {
    let dir = file::LocalLoginStore::settings(path)
        .open_directory(true)
        .map_err(|_| ERROR)?
        .ok_or(ERROR)?;
    if read(&dir)?.is_some_and(|held| held.mode != mode) {
        return Err(ERROR.into());
    }
    file::remove_private_file(&dir, ".connection-hold.tmp").map_err(|_| ERROR)?;
    let hold = Hold {
        mode,
        nonce: uuid::Uuid::new_v4().to_string(),
    };
    let mut f = file::open_at(
        &dir,
        ".connection-hold.tmp",
        libc::O_WRONLY | libc::O_CREAT | libc::O_EXCL,
        0o600,
    )
    .map_err(|_| ERROR)?;
    file::access_list::clear(&f).map_err(|_| ERROR)?;
    file::verify_private(&f, false).map_err(|_| ERROR)?;
    f.write_all(&serde_json::to_vec(&hold).map_err(|_| ERROR)?)
        .map_err(|_| ERROR)?;
    f.sync_all().map_err(|_| ERROR)?;
    file::rename_at(&dir, ".connection-hold.tmp", "connection-hold.json").map_err(|_| ERROR)?;
    dir.sync_all().map_err(|_| ERROR)?;
    Ok(hold.nonce)
}
fn clear(path: PathBuf, mode: ConnectionMode, nonce: &str) -> Result<(), String> {
    let store = file::LocalLoginStore::settings(path);
    let Some(dir) = store.open_directory(false).map_err(|_| ERROR)? else {
        return Ok(());
    };
    if !read(&dir)?.is_some_and(|held| held.mode == mode && held.nonce == nonce) {
        return Err(ERROR.into());
    }
    file::remove_private_file(&dir, "connection-hold.json").map_err(|_| ERROR)?;
    dir.sync_all().map_err(|_| ERROR)?;
    Ok(())
}
fn path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    app.path().app_data_dir().map_err(|_| ERROR.into())
}
pub(crate) fn mark_admitted(
    app: &tauri::AppHandle,
    mode: ConnectionMode,
) -> Result<String, String> {
    mark(path(app)?, mode)
}
pub(crate) fn check_app(app: &tauri::AppHandle, mode: ConnectionMode) -> Result<(), String> {
    check(path(app)?, mode)
}
// Issued by native creation/reconnect only. A current-world mark never refreshes it.
pub(crate) fn prepare(app: &tauri::AppHandle, mode: ConnectionMode) -> Result<(), String> {
    check_app(app, mode)?;
    let shared = app.state::<SharedGuard>();
    let mut state = shared.0.lock().map_err(|_| ERROR)?;
    state.pending = Some(mode);
    state.permit = None;
    Ok(())
}
#[tauri::command]
pub(crate) fn warp_guard_initialize(
    app: tauri::AppHandle,
    window: WebviewWindow,
    legacy_held: bool,
) -> Result<Option<String>, String> {
    crate::require_game_runtime(&window)?;
    let gate = crate::maintenance::admit(&app)?;
    let mode = crate::direct::window_mode(&window)?;
    let shared = app.state::<SharedGuard>();
    let mut state = shared.0.lock().map_err(|_| ERROR)?;
    state.take_initialization(mode)?;
    let store = file::LocalLoginStore::settings(path(&app)?);
    let mut held = match store.open_directory(false).map_err(|_| ERROR)? {
        Some(dir) => read(&dir)?,
        None => None,
    };
    // The existing origin-local durable marker is migration evidence, not clean status.
    if held.is_none() && legacy_held {
        let nonce = mark(path(&app)?, mode)?;
        held = Some(Hold { mode, nonce });
    }
    let Some(held) = held else { return Ok(None) };
    if held.mode != mode {
        return Err(ERROR.into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    state.permit = Some(Permit {
        id: id.clone(),
        mode,
        nonce: held.nonce,
        generation: gate.game_generation,
        owner: None,
    });
    Ok(Some(id))
}
#[tauri::command]
pub(crate) fn warp_guard_mark(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<String, String> {
    crate::require_game_runtime(&window)?;
    let _gate = crate::maintenance::admit(&app)?;
    let mode = crate::direct::window_mode(&window)?;
    mark_admitted(&app, mode)
}
pub(crate) fn bind_owner(app: &tauri::AppHandle, generation: u64, identity: &Option<GameIdentity>) {
    if let Ok(mut state) = app.state::<SharedGuard>().0.lock() {
        if let Some(p) = state.permit.as_mut() {
            if p.owner.is_none() && p.generation.wrapping_add(1) == generation && identity.is_some()
            {
                p.generation = generation;
                p.owner = identity.clone();
            }
        }
    }
}
#[tauri::command]
pub(crate) fn warp_guard_clear(
    app: tauri::AppHandle,
    window: WebviewWindow,
    identity: GameIdentity,
    permit: String,
) -> Result<(), String> {
    crate::require_game_runtime(&window)?;
    let gate = crate::maintenance::admit(&app)?;
    if gate.identity.as_ref() != Some(&identity) {
        return Err("Warp initialization identity is stale.".into());
    }
    let mode = crate::direct::window_mode(&window)?;
    let shared = app.state::<SharedGuard>();
    let mut state = shared.0.lock().map_err(|_| ERROR)?;
    let proof = state
        .permit
        .as_ref()
        .filter(|p| p.allows(&permit, mode, gate.game_generation, &identity))
        .ok_or("Initialization permit is stale.")?;
    clear(path(&app)?, mode, &proof.nonce)?;
    state.permit = None;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clean_initialization_issues_no_hold_and_cannot_initialize_again_in_the_same_world() {
        let mut state = GuardState {
            pending: Some(ConnectionMode::BotOnly),
            permit: None,
        };
        state.take_initialization(ConnectionMode::BotOnly).unwrap();
        assert!(state.permit.is_none());
        assert!(state.take_initialization(ConnectionMode::BotOnly).is_err());
        assert!(state
            .take_initialization(ConnectionMode::GameClient)
            .is_err());
    }
    #[test]
    fn initialization_permit_is_bound_to_native_generation_owner_and_mode() {
        let identity = GameIdentity {
            session_id: "s".into(),
            connection_id: "c".into(),
        };
        let p = Permit {
            id: "issued-on-new-runtime".into(),
            mode: ConnectionMode::BotOnly,
            nonce: "old-held-nonce".into(),
            generation: 7,
            owner: Some(identity.clone()),
        };
        assert!(p.allows(
            "issued-on-new-runtime",
            ConnectionMode::BotOnly,
            7,
            &identity
        ));
        assert!(!p.allows("current-world-mark", ConnectionMode::BotOnly, 7, &identity));
        assert!(!p.allows(&p.id, ConnectionMode::GameClient, 7, &identity));
        assert!(!p.allows(&p.id, ConnectionMode::BotOnly, 8, &identity));
        assert!(!p.allows(
            &p.id,
            ConnectionMode::BotOnly,
            7,
            &GameIdentity {
                session_id: "replacement".into(),
                connection_id: "c".into()
            }
        ));
    }
    #[test]
    fn originating_mode_hold_survives_disconnect_restart_and_rejects_opposite_clear() {
        let path = std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .join(format!("rayrag-mode-guard-{}", uuid::Uuid::new_v4()));
        let nonce = mark(path.clone(), ConnectionMode::GameClient).unwrap();
        assert!(check(path.clone(), ConnectionMode::BotOnly).is_err());
        assert!(clear(path.clone(), ConnectionMode::BotOnly, &nonce).is_err());
        assert!(check(path.clone(), ConnectionMode::BotOnly).is_err());
        assert!(check(path.clone(), ConnectionMode::GameClient).is_ok());
        let newer = mark(path.clone(), ConnectionMode::GameClient).unwrap();
        assert!(clear(path.clone(), ConnectionMode::GameClient, &nonce).is_err());
        clear(path.clone(), ConnectionMode::GameClient, &newer).unwrap();
        assert!(check(path.clone(), ConnectionMode::BotOnly).is_ok());
        mark(path.clone(), ConnectionMode::BotOnly).unwrap();
        assert!(check(path.clone(), ConnectionMode::GameClient).is_err());
        std::fs::remove_dir_all(path).unwrap();
    }
}

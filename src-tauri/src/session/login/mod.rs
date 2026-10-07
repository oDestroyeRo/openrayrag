pub(crate) use crate::session::direct_compatibility_logic::VERIFIED_BUILD;
pub(crate) use crate::session::login_logic::{
    ConnectionMode, LoginProfile, LoginRequest, SavedLogin, UpdateAccount,
};
use serde::Serialize;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, Webview};

pub(crate) mod local_store;

pub(crate) struct PendingLogin {
    profile: LoginProfile,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct LoginState {
    pub pending: Option<PendingLogin>,
    pub in_world: bool,
    pub cancelled: bool,
    // Session-only credentials never leave native memory except for a one-shot
    // claim by the verified game page. They are discarded when it closes.
    candidate: Option<LoginProfile>,
    session_profile: Option<LoginProfile>,
    reconnect_blocked: bool,
    generation: u64,
    active_session: Option<String>,
    candidate_session: Option<String>,
    profile_session: Option<String>,
    active_connection: Option<String>,
    candidate_connection: Option<String>,
    profile_connection: Option<String>,
}

#[derive(Serialize)]
pub(crate) struct PendingLoginResult {
    pub(crate) profile: Option<LoginProfile>,
    cancelled: bool,
}

impl LoginState {
    pub(crate) fn update_account(
        &self,
        identity: &crate::session::maintenance::GameIdentity,
    ) -> Option<UpdateAccount> {
        // Cancellation owns pending login requests. An exact, already-proven
        // live account remains bound through Stop and a later explicit Start.
        if !self.in_world
            || self.maintenance_busy()
            || self.profile_session.as_deref() != Some(identity.session_id.as_str())
            || self.profile_connection.as_deref() != Some(identity.connection_id.as_str())
            || self.active_session != self.profile_session
            || self.active_connection != self.profile_connection
        {
            return None;
        }
        self.session_profile
            .as_ref()
            .map(UpdateAccount::from_profile)
    }
    pub(crate) fn generation(&self) -> u64 {
        self.generation
    }
    pub(crate) fn claim_generation(
        &mut self,
        generation: u64,
        session: String,
    ) -> Result<LoginProfile, String> {
        if generation != self.generation || self.cancelled {
            return Err("Login request replaced or cancelled.".into());
        }
        self.claim(session)
            .profile
            .ok_or_else(|| "No explicit login is queued.".into())
    }
    pub(crate) fn maintenance_busy(&self) -> bool {
        self.pending.is_some() || self.candidate.is_some()
    }
    fn queue(&mut self, profile: LoginProfile) -> u64 {
        self.generation = self.generation.wrapping_add(1);
        self.candidate_session = None;
        self.candidate_connection = None;
        self.candidate = Some(profile.clone());
        self.pending = Some(PendingLogin {
            profile,
            expires_at: Instant::now() + Duration::from_secs(120),
        });
        self.cancelled = false;
        self.generation
    }

    pub(crate) fn cancel(&mut self) {
        self.generation = self.generation.wrapping_add(1);
        self.pending = None;
        self.candidate = None;
        self.candidate_session = None;
        self.candidate_connection = None;
        self.cancelled = true;
    }

    pub(crate) fn close(&mut self) {
        let generation = self.generation.wrapping_add(1);
        *self = Self {
            generation,
            ..Self::default()
        };
    }

    pub(crate) fn observe(
        &mut self,
        session_id: &str,
        connection_id: Option<&str>,
        connected: bool,
        has_player: bool,
        phase: &str,
        message: &str,
    ) {
        // Only the page that claimed a request can settle it. Status already
        // queued by the outgoing page must not consume the next login handoff.
        if self.active_session.as_deref() != Some(session_id)
            || self.candidate.is_some() && self.candidate_session.is_none()
        {
            return;
        }
        if let Some(connection_id) = connection_id {
            if self.active_connection.as_deref() != Some(connection_id) {
                self.active_connection = Some(connection_id.to_owned());
                if self.candidate_session.as_deref() == Some(session_id) && self.candidate.is_some()
                {
                    self.candidate_connection = Some(connection_id.to_owned());
                } else {
                    // Unity can return to its login scene without reloading this
                    // page. A new unclaimed socket has no proven account owner.
                    self.session_profile = None;
                    self.profile_session = None;
                    self.profile_connection = None;
                }
            }
        }
        self.in_world = connected && has_player;
        if self.in_world {
            if phase == "complete"
                && self.candidate_session.as_deref() == Some(session_id)
                && connection_id.is_some()
                && self.candidate_connection.as_deref() == connection_id
            {
                if let Some(profile) = self.candidate.take() {
                    self.session_profile = Some(profile);
                    self.profile_session = Some(session_id.to_owned());
                    self.profile_connection = connection_id.map(str::to_owned);
                }
                self.candidate_session = None;
                self.candidate_connection = None;
            } else if (self.profile_session.as_deref() != Some(session_id)
                || self.profile_connection.as_deref() != connection_id)
                && self.candidate.is_none()
            {
                // Manual login into a new page has no proven credential owner.
                self.session_profile = None;
                self.profile_session = None;
                self.profile_connection = None;
            }
            self.reconnect_blocked = false;
        } else if phase == "failed" || phase == "cancelled" {
            self.pending = None;
            self.candidate = None;
            self.candidate_session = None;
            self.candidate_connection = None;
            self.reconnect_blocked = phase == "cancelled"
                || !(message.contains("disconnected during sign-in")
                    || message.to_lowercase().contains("sign-in timed out"));
        }
    }

    pub(crate) fn reconnect_available(&self) -> bool {
        self.session_profile.is_some() && !self.reconnect_blocked
    }

    fn reconnect_profile(&self) -> Result<Option<LoginProfile>, String> {
        if self.in_world {
            return Err("The character is already connected.".into());
        }
        if self.reconnect_blocked {
            return Err("Sign in explicitly before reconnecting this account again.".into());
        }
        Ok(self.session_profile.clone())
    }

    pub(crate) fn claim(&mut self, session_id: String) -> PendingLoginResult {
        let queued = self.candidate.is_some();
        let profile = self
            .pending
            .take()
            .filter(|p| Instant::now() < p.expires_at)
            .map(|p| p.profile);
        if self.active_session.as_deref() != Some(session_id.as_str()) {
            self.active_connection = None;
        }
        self.active_session = Some(session_id.clone());
        self.candidate_connection = None;
        if profile.is_some() {
            self.candidate_session = Some(session_id);
        } else {
            self.candidate = None;
            self.candidate_session = None;
            if !queued && self.profile_session.as_deref() != Some(session_id.as_str()) {
                self.session_profile = None;
                self.profile_session = None;
                self.profile_connection = None;
            }
        }
        PendingLoginResult {
            profile,
            cancelled: self.cancelled,
        }
    }
}

pub(crate) type SharedLogin = Mutex<LoginState>;

fn login_store(app: &tauri::AppHandle) -> Result<local_store::LocalLoginStore, String> {
    let directory = crate::app_data(app).map_err(|_| "Local saved login is unavailable.")?;
    Ok(local_store::LocalLoginStore::new(directory))
}

pub(crate) fn saved_account_matches(app_data: std::path::PathBuf, account: &UpdateAccount) -> bool {
    local_store::LocalLoginStore::new(app_data)
        .load()
        .ok()
        .flatten()
        .is_some_and(|profile| crate::session::login_logic::account_matches(&profile, account))
}

#[tauri::command]
pub(crate) async fn saved_login(window: Webview) -> Result<Option<SavedLogin>, String> {
    crate::require_view(&window, "main")?;
    let store = login_store(window.app_handle())?;
    tauri::async_runtime::spawn_blocking(move || store.load().map(|p| p.map(SavedLogin::from)))
        .await
        .map_err(|_| {
            "Could not read the local saved login. Forget it or enter your account manually."
        })?
}

#[tauri::command]
pub(crate) async fn forget_login(
    window: Webview,
    mcp_operation: Option<String>,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    let store = login_store(window.app_handle())?;
    let app = window.app_handle().clone();
    tauri::async_runtime::spawn_blocking(move || {
        if mcp_operation.is_some() {
            let gate = crate::session::maintenance::admit(&app)?;
            let _mcp = crate::mcp::authorize_effect(
                &app,
                &gate,
                mcp_operation.as_deref(),
                "forget_login",
            )?;
            store.forget()
        } else {
            store.forget()
        }
    })
    .await
    .map_err(|_| "Could not remove the local saved login.")?
}

fn resolve_profile(
    request: LoginRequest,
    load: impl FnOnce() -> Result<Option<LoginProfile>, String>,
) -> Result<LoginProfile, String> {
    crate::session::login_logic::validate_request(&request)?;
    let saved = if request.credentials.is_none() {
        load()?
    } else {
        None
    };
    crate::session::login_logic::resolve_profile(request, saved)
}

#[tauri::command]
// URL/navigation calls and admission share the UI thread; a worker holding the
// gate while waiting for that thread can deadlock its heartbeat command.
pub(crate) fn login_game(
    app: tauri::AppHandle,
    window: Webview,
    request: LoginRequest,
    mcp_operation: Option<String>,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    let mut _permit = crate::session::maintenance::admit(&app)?;
    let _mcp =
        crate::mcp::authorize_effect(&app, &_permit, mcp_operation.as_deref(), "login_game")?;
    let remember = request.remember;
    let profile = resolve_profile(request, || login_store(&app)?.load())?;
    if let Some(game) = app.get_webview("game") {
        if crate::session::direct::runtime_mode(&game)? != profile.mode {
            return Err("Disconnect before changing the connection mode.".into());
        }
    }
    let mode = profile.mode;
    crate::session::mode_guard::check_app(&app, mode)?;
    let state = app.state::<SharedLogin>();
    {
        let mut state = state.lock().map_err(|_| "Login state is unavailable.")?;
        if state.in_world {
            return Err("Close the current game before signing in to another character.".into());
        }
        if remember {
            login_store(&app)?.save(&profile)?;
        }
        if state.session_profile.as_ref().is_some_and(|previous| {
            previous.username != profile.username
                || previous.password != profile.password
                || previous.character_slot != profile.character_slot
                || previous.mode != profile.mode
        }) {
            state.session_profile = None;
            state.profile_session = None;
            state.profile_connection = None;
        }
        state.reconnect_blocked = false;
        state.queue(profile);
    }
    _permit.ever_game = true;
    _permit.authorize_navigation();
    let result = reopen_game(&app, mode, &mut _permit);
    if result.is_err() {
        _permit.cancel_navigation();
    }
    result
}

fn reopen_game(
    app: &tauri::AppHandle,
    mode: ConnectionMode,
    gate: &mut crate::session::maintenance::Gate,
) -> Result<(), String> {
    crate::session::mode_guard::check_app(app, mode)?;
    if app.get_webview("game").is_some() {
        crate::session::mode_guard::prepare(app, mode)?;
    }
    crate::session::direct::cancel_admitted(app, gate);
    let result = if let Some(game) = app.get_webview("game") {
        game.navigate(crate::session::direct::url_for(mode))
            .map_err(|_| "Could not reopen the game.".to_string())
    } else {
        crate::open_game_window(app, mode)
    };
    if result.is_err() {
        if let Ok(mut state) = app.state::<SharedLogin>().lock() {
            state.pending = None;
            state.candidate = None;
        }
    }
    result
}

#[tauri::command]
pub(crate) fn reconnect_game(app: tauri::AppHandle, window: Webview) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    let mut _permit = crate::session::maintenance::admit(&app)?;
    // Reuse this exact window. A concurrent close must never create a new one.
    let game = app
        .get_webview("game")
        .ok_or("Open the game and sign in before reconnecting.")?;
    let state = app.state::<SharedLogin>();
    let (generation, mode) = {
        let mut state = state.lock().map_err(|_| "Login state is unavailable.")?;
        let profile = state
            .reconnect_profile()?
            .ok_or("Sign in through Companion to enable session reconnect.")?;
        profile.validate()?;
        let mode = profile.mode;
        (state.queue(profile), mode)
    };
    {
        let state = state.lock().map_err(|_| "Login state is unavailable.")?;
        if state.generation != generation || app.get_webview("game").is_none() {
            return Err("Reconnect was cancelled.".into());
        }
    }
    _permit.ever_game = true;
    _permit.authorize_navigation();
    if crate::session::direct::runtime_mode(&game)? != mode {
        return Err("Disconnect before changing the connection mode.".into());
    }
    crate::session::mode_guard::prepare(&app, mode)?;
    crate::session::direct::cancel_admitted(&app, &mut _permit);
    let result = game
        .navigate(crate::session::direct::url_for(mode))
        .map_err(|_| "Could not reopen the game.".to_string());
    if result.is_err() {
        _permit.cancel_navigation();
        if let Ok(mut state) = state.lock() {
            if state.generation == generation {
                state.pending = None;
                state.candidate = None;
                state.candidate_session = None;
            }
        }
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_pending_login(app: tauri::AppHandle, window: Webview) -> Result<(), String> {
    crate::require_view(&window, "game")?;
    let state = app.state::<SharedLogin>();
    let mut state = state.lock().map_err(|_| "Login state is unavailable.")?;
    state.cancel();
    Ok(())
}

#[tauri::command]
pub(crate) fn take_pending_login(
    app: tauri::AppHandle,
    window: Webview,
    build: String,
    session_id: String,
) -> Result<PendingLoginResult, String> {
    crate::require_view(&window, "game")?;
    let mut _permit = crate::session::maintenance::admit(&app)?;
    if window
        .url()
        .map_err(|_| "Game URL is unavailable.")?
        .as_str()
        != crate::GAME_URL
        || build != VERIFIED_BUILD
        || session_id.is_empty()
        || session_id.len() > 64
        || !session_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-')
    {
        return Err("This game build is not verified for automatic login.".into());
    }
    let state = app.state::<SharedLogin>();
    let result = state
        .lock()
        .map_err(|_| "Login state is unavailable.")?
        .claim(session_id);
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> LoginProfile {
        LoginProfile {
            mode: ConnectionMode::GameClient,
            username: "test-account".into(),
            password: "synthetic-test-password".into(),
            character_slot: 0,
            auto_login: false,
        }
    }

    #[test]
    fn legacy_saved_profiles_default_to_official_and_explicit_mode_overrides_reuse() {
        let profile: LoginProfile = serde_json::from_str(
            r#"{"username":"synthetic","password":"synthetic-only","characterSlot":0}"#,
        )
        .unwrap();
        assert_eq!(profile.mode, ConnectionMode::GameClient);
        let request:LoginRequest=serde_json::from_str(r#"{"credentials":null,"characterSlot":1,"remember":true,"autoLogin":true,"mode":"botOnly"}"#).unwrap();
        let selected = resolve_profile(request, || Ok(Some(profile))).unwrap();
        assert_eq!(selected.mode, ConnectionMode::BotOnly);
        assert_eq!(selected.character_slot, 1);
    }
    #[test]
    fn validates_login_input_and_does_not_serialize_password_in_saved_info() {
        let mut value = profile();
        assert!(value.validate().is_ok());
        value.character_slot = 3;
        assert!(value.validate().is_err());
        value.character_slot = 0;
        value.password.clear();
        assert!(value.validate().is_err());
        let info = SavedLogin {
            mode: ConnectionMode::GameClient,
            username: "test-account".into(),
            character_slot: 1,
            auto_login: true,
        };
        let json = serde_json::to_value(info).unwrap();
        assert!(json.get("password").is_none());
    }

    #[test]
    fn update_account_requires_the_exact_proven_live_login_owner() {
        let mut state = LoginState::default();
        let identity = crate::session::maintenance::GameIdentity {
            session_id: "page-a".into(),
            connection_id: "socket-a".into(),
        };
        state.queue(profile());
        assert!(state.update_account(&identity).is_none());
        state.claim(identity.session_id.clone());
        assert!(state.update_account(&identity).is_none());
        state.observe("page-a", Some("socket-a"), true, true, "complete", "");
        let account = state.update_account(&identity).unwrap();
        assert_eq!(account.username, "test-account");
        assert_eq!(account.character_slot, 0);
        assert_eq!(account.mode, ConnectionMode::GameClient);
        let other = crate::session::maintenance::GameIdentity {
            session_id: "page-b".into(),
            ..identity.clone()
        };
        assert!(state.update_account(&other).is_none());
        state.observe("page-a", Some("socket-b"), true, true, "complete", "");
        assert!(state.update_account(&identity).is_none());
        assert!(state.session_profile.is_none());
        state.queue(profile());
        state.claim("page-a".into());
        state.observe("page-a", Some("socket-a"), true, true, "complete", "");
        state.cancel();
        state.observe("page-a", Some("socket-b"), true, true, "complete", "");
        assert!(state.update_account(&identity).is_none());
    }

    #[test]
    fn update_account_survives_stop_and_explicit_start_for_the_proven_connected_character() {
        for mode in [ConnectionMode::BotOnly, ConnectionMode::GameClient] {
            let mut profile = profile();
            profile.mode = mode;
            let mut state = LoginState::default();
            let identity = crate::session::maintenance::GameIdentity {
                session_id: "page-a".into(),
                connection_id: "socket-a".into(),
            };
            state.queue(profile);
            state.claim(identity.session_id.clone());
            state.observe("page-a", Some("socket-a"), true, true, "complete", "");
            let account = state.update_account(&identity).unwrap();
            let original_generation = state.generation();
            state.cancel(); // control_bot('stop') cancels login requests, not the proven account.
            assert!(state.cancelled);
            // Previous update requests stay stale even though the live owner remains proven.
            assert_ne!(state.generation(), original_generation);
            // Explicit field or macro Start does not mutate LoginState; its
            // subsequent same-owner telemetry must retain update eligibility.
            state.observe("page-a", Some("socket-a"), true, true, "complete", "");
            assert_eq!(state.update_account(&identity), Some(account));
        }
    }

    #[test]
    fn update_account_does_not_promote_a_cancelled_pending_login_into_proven_ownership() {
        let mut state = LoginState::default();
        let identity = crate::session::maintenance::GameIdentity {
            session_id: "page-a".into(),
            connection_id: "socket-a".into(),
        };
        state.queue(profile());
        state.claim(identity.session_id.clone());
        state.cancel();
        state.observe("page-a", Some("socket-a"), true, true, "complete", "");
        assert!(state.update_account(&identity).is_none());
        assert!(state.session_profile.is_none());
    }

    #[test]
    fn update_saved_account_flag_requires_matching_existing_credential_metadata() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().canonicalize().unwrap();
        let account = UpdateAccount::from_profile(&profile());
        assert!(!saved_account_matches(path.clone(), &account));
        local_store::LocalLoginStore::new(path.clone())
            .save(&profile())
            .unwrap();
        assert!(saved_account_matches(path.clone(), &account));
        for field in ["username", "slot", "mode"] {
            let mut other = account.clone();
            match field {
                "username" => other.username = "other-account".into(),
                "slot" => other.character_slot = 2,
                _ => other.mode = ConnectionMode::BotOnly,
            };
            assert!(!saved_account_matches(path.clone(), &other));
        }
    }

    #[test]
    fn session_only_new_credentials_do_not_access_persistence() {
        let request = LoginRequest {
            mode: None,
            credentials: Some(profile()),
            character_slot: 2,
            remember: false,
            auto_login: false,
        };
        let resolved = resolve_profile(request, || {
            panic!("session-only input must not access local persistence")
        })
        .unwrap();
        assert_eq!(resolved.character_slot, 2);
        assert!(!resolved.auto_login);
        let request = LoginRequest {
            mode: None,
            credentials: Some(profile()),
            character_slot: 0,
            remember: false,
            auto_login: true,
        };
        assert!(resolve_profile(request, || panic!(
            "invalid remember opt-in must not access persistence"
        ))
        .is_err());
    }

    #[test]
    fn saved_reuse_keeps_password_native_and_overrides_requested_slot_and_preference() {
        let saved = profile();
        let request = LoginRequest {
            mode: None,
            credentials: None,
            character_slot: 1,
            remember: false,
            auto_login: false,
        };
        let resolved = resolve_profile(request, || Ok(Some(saved.clone()))).unwrap();
        assert_eq!(resolved.username, saved.username);
        assert_eq!(resolved.password, saved.password);
        assert_eq!(resolved.character_slot, 1);
        assert!(!resolved.auto_login);
        let request = LoginRequest {
            mode: None,
            credentials: None,
            character_slot: 0,
            remember: true,
            auto_login: true,
        };
        let resolved = resolve_profile(request, || Ok(Some(saved))).unwrap();
        assert_eq!(resolved.character_slot, 0);
        assert!(resolved.auto_login);
        let request = LoginRequest {
            mode: None,
            credentials: None,
            character_slot: 0,
            remember: false,
            auto_login: false,
        };
        assert!(resolve_profile(request, || Ok(None)).is_err());
    }

    #[test]
    fn handoff_is_one_shot_expires_and_preserves_cancellation_across_navigation() {
        let mut state = LoginState {
            pending: Some(PendingLogin {
                profile: profile(),
                expires_at: Instant::now() + Duration::from_secs(10),
            }),
            ..LoginState::default()
        };
        assert!(state.claim("test-page".into()).profile.is_some());
        assert!(state.claim("test-page".into()).profile.is_none());
        state.pending = Some(PendingLogin {
            profile: profile(),
            expires_at: Instant::now() - Duration::from_secs(1),
        });
        assert!(state.claim("test-page".into()).profile.is_none());
        state.cancelled = true;
        assert!(state.claim("test-page".into()).cancelled);
        assert!(state.claim("test-page".into()).cancelled);
    }

    #[test]
    fn retains_only_successful_session_login_and_clears_it_on_close() {
        let mut state = LoginState::default();
        state.queue(profile());
        assert!(state.reconnect_profile().unwrap().is_none());
        assert!(state.claim("test-page".into()).profile.is_some());
        state.observe(
            "test-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        assert!(state.reconnect_profile().is_err());
        state.observe(
            "test-page",
            Some("test-connection"),
            false,
            true,
            "complete",
            "Disconnected.",
        );
        assert!(state.reconnect_profile().unwrap().is_some());
        state.cancel();
        assert!(state.claim("test-page".into()).profile.is_none());
        assert!(state.claim("test-page".into()).cancelled);
        assert!(state.reconnect_profile().unwrap().is_some());
        state.close();
        assert!(state.reconnect_profile().unwrap().is_none());
        assert!(!state.cancelled);
    }

    #[test]
    fn rejected_login_blocks_reconnect_but_network_loss_does_not() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.claim("test-page".into());
        state.observe(
            "test-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        state.observe(
            "test-page",
            Some("test-connection"),
            false,
            false,
            "failed",
            "Game disconnected during sign-in. No automatic retry will run.",
        );
        assert!(state.reconnect_profile().unwrap().is_some());
        state.observe(
            "test-page",
            Some("test-connection"),
            false,
            false,
            "failed",
            "Sign-in was rejected.",
        );
        assert!(state.reconnect_profile().is_err());
        state.observe(
            "test-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in manually.",
        );
        state.observe(
            "test-page",
            Some("test-connection"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        assert!(state.reconnect_profile().unwrap().is_some());
    }

    #[test]
    fn cancellation_prevents_late_handoff_or_false_successful_profile() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.cancel();
        state.claim("test-page".into());
        state.observe(
            "test-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in manually.",
        );
        state.observe(
            "test-page",
            Some("test-connection"),
            false,
            false,
            "idle",
            "",
        );
        assert!(state.claim("test-page".into()).profile.is_none());
        assert!(state.reconnect_profile().unwrap().is_none());
    }

    #[test]
    fn old_page_status_cannot_consume_or_promote_a_retry_handoff() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.claim("old-page".into());
        state.observe(
            "old-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        state.observe(
            "old-page",
            Some("test-connection"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        let retry = state.reconnect_profile().unwrap().unwrap();
        state.queue(retry);
        state.observe(
            "old-page",
            Some("test-connection"),
            false,
            false,
            "failed",
            "Sign-in was rejected.",
        );
        state.observe(
            "old-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Late old world.",
        );
        assert!(!state.in_world);
        assert!(state.claim("new-page".into()).profile.is_some());
        state.observe(
            "old-page",
            Some("test-connection"),
            false,
            false,
            "failed",
            "Sign-in was rejected.",
        );
        state.observe(
            "old-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Late old world.",
        );
        assert!(!state.in_world);
        assert!(state.candidate.is_some());
        state.observe(
            "new-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        assert_eq!(state.profile_session.as_deref(), Some("new-page"));
        assert!(state.candidate.is_none());
    }

    #[test]
    fn same_page_manual_socket_takeover_cannot_reuse_previous_account() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.claim("same-page".into());
        state.observe(
            "same-page",
            Some("socket-a"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        assert!(state.reconnect_available());
        state.observe(
            "same-page",
            Some("socket-a"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        // Client Stop and harmless input do not create an unknown account owner.
        state.cancel();
        assert!(state.reconnect_available());
        state.observe(
            "same-page",
            Some("socket-a"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        assert!(state.reconnect_profile().unwrap().is_some());
        // Unity's reconnect/login scene can use another account without page reload.
        state.observe(
            "same-page",
            Some("socket-b"),
            true,
            false,
            "complete",
            "Old login phase.",
        );
        assert!(!state.reconnect_available());
        state.observe(
            "same-page",
            Some("socket-b"),
            true,
            true,
            "complete",
            "Old login phase.",
        );
        state.observe(
            "same-page",
            Some("socket-b"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        assert!(state.reconnect_profile().unwrap().is_none());
    }

    #[test]
    fn explicitly_claimed_retry_can_bind_successful_credentials_to_a_new_socket() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.claim("old-page".into());
        state.observe(
            "old-page",
            Some("old-socket"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        state.observe(
            "old-page",
            Some("old-socket"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        state.queue(state.reconnect_profile().unwrap().unwrap());
        state.claim("new-page".into());
        state.observe(
            "new-page",
            Some("new-socket"),
            true,
            false,
            "entering",
            "Entering.",
        );
        state.observe(
            "new-page",
            Some("new-socket"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        assert!(state.reconnect_available());
        assert_eq!(state.profile_session.as_deref(), Some("new-page"));
        assert_eq!(state.profile_connection.as_deref(), Some("new-socket"));
    }

    #[test]
    fn a_world_status_without_socket_identity_cannot_confirm_login_ownership() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.claim("test-page".into());
        state.observe("test-page", None, true, true, "complete", "Signed in.");
        assert!(!state.reconnect_available());
    }

    #[test]
    fn expired_retry_handoff_keeps_previous_successful_profile_until_manual_login() {
        let mut state = LoginState::default();
        state.queue(profile());
        state.claim("old-page".into());
        state.observe(
            "old-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        state.observe(
            "old-page",
            Some("test-connection"),
            false,
            false,
            "complete",
            "Disconnected.",
        );
        state.queue(state.reconnect_profile().unwrap().unwrap());
        state.pending.as_mut().unwrap().expires_at = Instant::now() - Duration::from_secs(1);
        assert!(state.claim("slow-page".into()).profile.is_none());
        assert!(state.reconnect_profile().unwrap().is_some());
        state.observe(
            "slow-page",
            Some("test-connection"),
            true,
            true,
            "idle",
            "Manual login.",
        );
        assert!(state.session_profile.is_none());
    }

    #[test]
    fn manual_new_page_has_no_automatic_credential_owner_and_close_invalidates_generation() {
        let mut state = LoginState::default();
        let generation = state.queue(profile());
        state.claim("old-page".into());
        state.observe(
            "old-page",
            Some("test-connection"),
            true,
            true,
            "complete",
            "Signed in.",
        );
        assert!(state.session_profile.is_some());
        state.claim("manual-page".into());
        state.observe(
            "manual-page",
            Some("test-connection"),
            true,
            true,
            "idle",
            "",
        );
        state.observe(
            "manual-page",
            Some("test-connection"),
            false,
            false,
            "idle",
            "",
        );
        assert!(state.reconnect_profile().unwrap().is_none());
        state.close();
        assert_ne!(state.generation, generation);
        assert!(state.pending.is_none());
    }
}

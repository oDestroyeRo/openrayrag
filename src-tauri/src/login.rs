use serde::{Deserialize, Serialize};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{Manager, WebviewWindow};

const KEYCHAIN_SERVICE: &str = "com.rayrag.companion.login";
const KEYCHAIN_ACCOUNT: &str = "sea01";
const VERIFIED_BUILD: &str = "Build_2569-09-01-01-55";

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoginProfile {
    username: String,
    password: String,
    character_slot: u8,
    #[serde(default)]
    auto_login: bool,
}

impl LoginProfile {
    fn validate(&self) -> Result<(), String> {
        if self.username.trim().is_empty()
            || self.username.chars().count() > 64
            || self.username.chars().any(char::is_control)
            || self.password.is_empty()
            || self.password.len() > 256
            || self.password.contains('\0')
            || self.character_slot > 2
        {
            return Err("Enter a username, password and character slot 1–3.".into());
        }
        Ok(())
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SavedLogin {
    username: String,
    character_slot: u8,
    auto_login: bool,
}

pub(crate) struct PendingLogin {
    profile: LoginProfile,
    expires_at: Instant,
}

#[derive(Default)]
pub(crate) struct LoginState {
    pub pending: Option<PendingLogin>,
    pub in_world: bool,
    pub cancelled: bool,
}

#[derive(Serialize)]
pub(crate) struct PendingLoginResult {
    profile: Option<LoginProfile>,
    cancelled: bool,
}

impl LoginState {
    fn claim(&mut self) -> PendingLoginResult {
        PendingLoginResult {
            profile: self
                .pending
                .take()
                .filter(|p| Instant::now() < p.expires_at)
                .map(|p| p.profile),
            cancelled: self.cancelled,
        }
    }
}

pub(crate) type SharedLogin = Mutex<LoginState>;

fn load_profile() -> Result<Option<LoginProfile>, String> {
    match security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT) {
        Ok(bytes) => {
            let profile: LoginProfile = serde_json::from_slice(&bytes)
                .map_err(|_| "Saved login is invalid. Forget it and enter your account again.")?;
            profile.validate()?;
            Ok(Some(profile))
        }
        Err(error) if error.code() == -25300 => Ok(None), // errSecItemNotFound
        Err(_) => Err("Could not read the saved login from macOS Keychain.".into()),
    }
}

#[tauri::command]
pub(crate) async fn saved_login(window: WebviewWindow) -> Result<Option<SavedLogin>, String> {
    super::require_window(&window, "main")?;
    Ok(load_profile()?.map(|profile| SavedLogin {
        username: profile.username,
        character_slot: profile.character_slot,
        auto_login: profile.auto_login,
    }))
}

#[tauri::command]
pub(crate) async fn forget_login(window: WebviewWindow) -> Result<(), String> {
    super::require_window(&window, "main")?;
    match security_framework::passwords::delete_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
    {
        Ok(()) => Ok(()),
        Err(error) if error.code() == -25300 => Ok(()),
        Err(_) => Err("Could not remove the saved login from macOS Keychain.".into()),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct LoginRequest {
    // Null credentials mean reuse the Keychain entry. Its password never returns
    // to the controller webview.
    credentials: Option<LoginProfile>,
    character_slot: u8,
    remember: bool,
    auto_login: bool,
}

#[tauri::command]
pub(crate) async fn login_game(
    app: tauri::AppHandle,
    window: WebviewWindow,
    request: LoginRequest,
) -> Result<(), String> {
    super::require_window(&window, "main")?;
    if request.auto_login && !request.remember {
        return Err("Save the login in Keychain to sign in when the app opens.".into());
    }
    let mut profile = match request.credentials {
        Some(profile) => profile,
        None => load_profile()?.ok_or("Enter your account or save a login first.")?,
    };
    profile.character_slot = request.character_slot;
    profile.auto_login = request.auto_login;
    profile.validate()?;
    let state = app.state::<SharedLogin>();
    {
        let mut state = state.lock().map_err(|_| "Login state is unavailable.")?;
        if state.in_world {
            return Err("Close the current game before signing in to another character.".into());
        }
        if request.remember {
            let bytes = serde_json::to_vec(&profile).map_err(|_| "Invalid login settings.")?;
            security_framework::passwords::set_generic_password(
                KEYCHAIN_SERVICE,
                KEYCHAIN_ACCOUNT,
                &bytes,
            )
            .map_err(|_| "Could not save the login in macOS Keychain.")?;
        }
        state.pending = Some(PendingLogin {
            profile,
            expires_at: Instant::now() + Duration::from_secs(120),
        });
        state.cancelled = false;
    }
    // Reuse the same window but start a fresh official-client session. Credentials
    // are claimed once; reloads and disconnects cannot silently repeat a login.
    let result = if let Some(game) = app.get_webview_window("game") {
        game.navigate(super::GAME_URL.parse().unwrap())
            .and_then(|()| game.set_focus())
            .map_err(|_| "Could not reopen the game.".to_string())
    } else {
        super::open_game_window(&app)
    };
    if result.is_err() {
        if let Ok(mut state) = state.lock() {
            state.pending = None;
        }
    }
    result
}

#[tauri::command]
pub(crate) fn cancel_pending_login(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    super::require_window(&window, "game")?;
    let state = app.state::<SharedLogin>();
    let mut state = state.lock().map_err(|_| "Login state is unavailable.")?;
    state.pending = None;
    state.cancelled = true;
    Ok(())
}

#[tauri::command]
pub(crate) fn take_pending_login(
    app: tauri::AppHandle,
    window: WebviewWindow,
    build: String,
) -> Result<PendingLoginResult, String> {
    super::require_window(&window, "game")?;
    if window
        .url()
        .map_err(|_| "Game URL is unavailable.")?
        .as_str()
        != super::GAME_URL
        || build != VERIFIED_BUILD
    {
        return Err("This game build is not verified for automatic login.".into());
    }
    let state = app.state::<SharedLogin>();
    let result = state
        .lock()
        .map_err(|_| "Login state is unavailable.")?
        .claim();
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn profile() -> LoginProfile {
        LoginProfile {
            username: "test-account".into(),
            password: "synthetic-test-password".into(),
            character_slot: 0,
            auto_login: false,
        }
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
            username: "test-account".into(),
            character_slot: 1,
            auto_login: true,
        };
        let json = serde_json::to_value(info).unwrap();
        assert!(json.get("password").is_none());
    }

    #[test]
    fn handoff_is_one_shot_expires_and_preserves_cancellation_across_navigation() {
        let mut state = LoginState::default();
        state.pending = Some(PendingLogin {
            profile: profile(),
            expires_at: Instant::now() + Duration::from_secs(10),
        });
        assert!(state.claim().profile.is_some());
        assert!(state.claim().profile.is_none());
        state.pending = Some(PendingLogin {
            profile: profile(),
            expires_at: Instant::now() - Duration::from_secs(1),
        });
        assert!(state.claim().profile.is_none());
        state.cancelled = true;
        assert!(state.claim().cancelled);
        assert!(state.claim().cancelled);
    }

    #[test]
    #[ignore = "Writes and deletes one synthetic entry in the local macOS Keychain"]
    fn keychain_round_trip() {
        let service = format!("com.rayrag.companion.test.{}", std::process::id());
        let data = b"synthetic-test-only";
        security_framework::passwords::set_generic_password(&service, "test", data).unwrap();
        let read = security_framework::passwords::get_generic_password(&service, "test");
        let cleanup = security_framework::passwords::delete_generic_password(&service, "test");
        assert_eq!(read.unwrap(), data);
        cleanup.unwrap();
        assert_eq!(
            security_framework::passwords::get_generic_password(&service, "test")
                .unwrap_err()
                .code(),
            -25300
        );
    }
}

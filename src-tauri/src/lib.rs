use automation::Settings;
use std::sync::OnceLock;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
mod automation;
mod control;
mod login;

const GAME_URL: &str = "https://websea01.rayrag.com/";
const BRIDGE: &str = include_str!("../generated/game-bridge.js");
// Bounded inventory, cart and storage snapshots can each contain 600 items.
const MAX_STATUS_BYTES: usize = 500_000;

fn supported_map(map: &str) -> bool {
    static MAPS: OnceLock<serde_json::Map<String, serde_json::Value>> = OnceLock::new();
    MAPS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/data/navigation-maps.json"))
            .expect("Bundled navigation catalog must be valid")
    })
    .contains_key(map)
}

fn require_window(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() != label {
        return Err("Command is not available in this window.".into());
    }
    Ok(())
}

#[tauri::command]
async fn open_game(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_window(&window, "main")?;
    open_game_window(&app)
}

fn open_game_window(app: &tauri::AppHandle) -> Result<(), String> {
    if let Some(game) = app.get_webview_window("game") {
        game.show().map_err(|_| "Could not show the game.")?;
        return game
            .set_focus()
            .map_err(|_| "Could not focus the game.".into());
    }
    WebviewWindowBuilder::new(app, "game", WebviewUrl::External(GAME_URL.parse().unwrap()))
        .title("Rayrag · Game")
        .inner_size(1360.0, 880.0)
        .min_inner_size(1000.0, 720.0)
        .incognito(true)
        .initialization_script(BRIDGE)
        .on_navigation(|url| url.as_str() == GAME_URL)
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| "Could not open the game window.".to_string())?;
    Ok(())
}

#[tauri::command]
fn control_bot(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    settings: Option<Settings>,
    request: Option<serde_json::Value>,
    escape_guard: Option<automation::EscapeResumeGuard>,
) -> Result<(), String> {
    require_window(&window, "main")?;
    if let Some(guard) = &escape_guard {
        if action != "start" {
            return Err("Escape resume state is only accepted by start.".into());
        }
        guard.validate()?;
    }
    if !matches!(
        action.as_str(),
        "start" | "stop" | "heartbeat" | "command" | "workflow" | "routine" | "service"
    ) {
        return Err("Unknown bot action.".into());
    }
    if matches!(action.as_str(), "start" | "stop" | "heartbeat") && request.is_some() {
        return Err("This control does not accept an automation request.".into());
    }
    if matches!(
        action.as_str(),
        "command" | "workflow" | "routine" | "service"
    ) && settings.is_some()
    {
        return Err("Use start to apply automation settings.".into());
    }
    if action == "stop" {
        if let Ok(mut state) = app.state::<login::SharedLogin>().lock() {
            state.cancel();
        }
    }
    if action == "start" {
        settings
            .as_ref()
            .ok_or("Combat settings are required.")?
            .validate()?;
    }
    let game = app
        .get_webview_window("game")
        .ok_or("Open the game first.")?;
    let script = if matches!(
        action.as_str(),
        "command" | "workflow" | "routine" | "service"
    ) {
        control::request_script(
            &action,
            request.as_ref().ok_or("Automation request is required.")?,
        )?
    } else {
        let action_json = serde_json::to_string(&action).map_err(|_| "Invalid action.")?;
        let settings_json = serde_json::to_string(&settings).map_err(|_| "Invalid settings.")?;
        let escape_json =
            serde_json::to_string(&escape_guard).map_err(|_| "Invalid escape resume state.")?;
        format!("window.__RAYRAG__?.control({action_json},{settings_json},{escape_json})")
    };
    game.eval(script)
        .map_err(|_| "Could not reach the game controller.".into())
}

#[tauri::command]
fn bridge_status(
    app: tauri::AppHandle,
    window: WebviewWindow,
    mut status: serde_json::Value,
) -> Result<(), String> {
    require_window(&window, "game")?;
    // Status is display data only. Never evaluate it or interpret it as a command.
    let encoded = serde_json::to_string(&status).map_err(|_| "Invalid status.")?;
    if encoded.len() > MAX_STATUS_BYTES || !status.is_object() {
        return Err("Status exceeds its limit.".into());
    }
    if let Ok(mut state) = app.state::<login::SharedLogin>().lock() {
        state.observe(
            status
                .get("sessionId")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
            status
                .get("connectionId")
                .and_then(serde_json::Value::as_str)
                .filter(|id| {
                    !id.is_empty()
                        && id.len() <= 64
                        && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
                }),
            status
                .get("connected")
                .and_then(serde_json::Value::as_bool)
                .unwrap_or(false),
            status
                .get("player")
                .is_some_and(|player| player.is_object()),
            status
                .pointer("/login/phase")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
            status
                .pointer("/login/message")
                .and_then(serde_json::Value::as_str)
                .unwrap_or(""),
        );
        status["reconnectAvailable"] = state.reconnect_available().into();
    } else {
        status["reconnectAvailable"] = false.into();
    }
    app.emit_to("main", "game-status", status)
        .map_err(|_| "Controller is unavailable.".into())
}

pub fn run() {
    tauri::Builder::default()
        .manage(login::SharedLogin::default())
        .invoke_handler(tauri::generate_handler![
            open_game,
            control_bot,
            bridge_status,
            login::login_game,
            login::reconnect_game,
            login::saved_login,
            login::forget_login,
            login::cancel_pending_login,
            login::take_pending_login
        ])
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                if window.label() == "main" {
                    if let Some(game) = window.app_handle().get_webview_window("game") {
                        let _ = game.destroy();
                    }
                } else if window.label() == "game" {
                    if let Ok(mut state) = window.app_handle().state::<login::SharedLogin>().lock()
                    {
                        state.close();
                    }
                    let _ = window.app_handle().emit_to("main", "game-closed", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not launch Rayrag Companion");
}

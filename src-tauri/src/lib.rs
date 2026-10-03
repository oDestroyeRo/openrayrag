use automation::Settings;
use std::sync::OnceLock;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
mod automation;
mod ci_smoke;
mod control;
mod current_form;
mod direct;
mod direct_wire;
mod login;
mod maintenance;
mod mode_guard;
mod settings_close;
mod update_install;
mod updater;

const GAME_URL: &str = "https://websea01.rayrag.com/";
const BRIDGE: &str = include_str!("../generated/game-bridge.js");
// Bounded inventory, cart and storage snapshots can each contain 600 items.
const MAX_STATUS_BYTES: usize = 500_000;

fn navigation_maps() -> &'static serde_json::Map<String, serde_json::Value> {
    static MAPS: OnceLock<serde_json::Map<String, serde_json::Value>> = OnceLock::new();
    MAPS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/data/navigation-maps.json"))
            .expect("Bundled navigation catalog must be valid")
    })
}
fn supported_map(map: &str) -> bool {
    navigation_maps().contains_key(map)
}
fn map_dimensions(map: &str) -> Option<(u64, u64)> {
    let grid = navigation_maps().get(map)?;
    Some((grid.get("width")?.as_u64()?, grid.get("height")?.as_u64()?))
}

fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, tauri::Error> {
    if let Some(directory) = ci_smoke::data_dir() {
        return Ok(directory);
    }
    app.path().app_data_dir()
}

fn require_window(window: &WebviewWindow, label: &str) -> Result<(), String> {
    if window.label() != label {
        return Err("Command is not available in this window.".into());
    }
    Ok(())
}

#[tauri::command]
// Keep admitted window operations on the UI thread: URL/build operations may
// synchronously dispatch there, while other UI commands need the same gate.
fn open_game(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_window(&window, "main")?;
    let mut permit = maintenance::admit(&app)?;
    permit.ever_game = true;
    permit.game_generation += 1;
    permit.identity = None;
    if app.get_webview_window("game").is_none() {
        permit.authorize_navigation();
    }
    let result = open_game_window(&app, login::ConnectionMode::GameClient);
    if result.is_err() {
        permit.cancel_navigation();
    }
    result
}

#[tauri::command]
fn close_game(app: tauri::AppHandle, window: WebviewWindow) -> Result<(), String> {
    require_window(&window, "main")?;
    let mut _permit = maintenance::admit(&app)?;
    direct::cancel_admitted(&app, &mut _permit);
    if let Some(game) = app.get_webview_window("game") {
        game.destroy()
            .map_err(|_| "Could not disconnect the game.".to_string())?;
    }
    Ok(())
}

fn open_game_window(app: &tauri::AppHandle, mode: login::ConnectionMode) -> Result<(), String> {
    mode_guard::check_app(app, mode)?;
    if let Some(game) = app.get_webview_window("game") {
        if direct::window_mode(&game)? != mode {
            return Err("Disconnect before changing the connection mode.".into());
        }
        return Ok(());
    }
    mode_guard::prepare(app, mode)?;
    let url = match mode {
        login::ConnectionMode::BotOnly => WebviewUrl::App("bot-runtime.html".into()),
        login::ConnectionMode::GameClient => WebviewUrl::External(GAME_URL.parse().unwrap()),
    };
    WebviewWindowBuilder::new(app, "game", url)
        .title("Rayrag · Connection")
        .visible(mode == login::ConnectionMode::GameClient)
        .inner_size(1360.0, 880.0)
        .min_inner_size(1000.0, 720.0)
        .incognito(true)
        .initialization_script(if mode == login::ConnectionMode::GameClient {
            BRIDGE
        } else {
            ""
        })
        .on_navigation({
            let app = app.clone();
            move |url| {
                if *url != direct::url_for(mode) {
                    return false;
                }
                let shared = app.state::<maintenance::SharedGate>();
                let allowed = if let Ok(mut gate) = shared.try_lock() {
                    if let Some(l) = gate.lease.as_mut() {
                        l.invalidated = true;
                        l.acknowledged = false;
                        return false;
                    }
                    if !shared.take_authorized_navigation() {
                        gate.page_navigation();
                    }
                    gate.cancel_navigation();
                    gate.game_generation += 1;
                    gate.identity = None;
                    true
                } else {
                    shared.take_authorized_navigation()
                };
                allowed
            }
        })
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny)
        .build()
        .map_err(|_| "Could not open the game window.".to_string())?;
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Explicit command fields preserve the existing native boundary.
fn control_bot(
    app: tauri::AppHandle,
    window: WebviewWindow,
    action: String,
    settings: Option<Settings>,
    request: Option<serde_json::Value>,
    escape_guard: Option<automation::EscapeResumeGuard>,
    supply_guard: Option<automation::SupplyResumeGuard>,
    death_recovery_guard: Option<automation::DeathRecoveryGuard>,
) -> Result<(), String> {
    require_window(&window, "main")?;
    let mut _permit = maintenance::admit(&app)?;
    if let Some(guard) = &death_recovery_guard {
        if action != "start" {
            return Err("Death recovery state is only accepted by start.".into());
        }
        guard.validate()?;
    }
    if let Some(guard) = &supply_guard {
        if action != "start" {
            return Err("Supply resume state is only accepted by start.".into());
        }
        guard.validate()?;
    }
    if let Some(guard) = &escape_guard {
        if action != "start" {
            return Err("Escape resume state is only accepted by start.".into());
        }
        guard.validate()?;
    }
    if !matches!(
        action.as_str(),
        "start"
            | "stop"
            | "heartbeat"
            | "command"
            | "workflow"
            | "routine"
            | "macro"
            | "service"
            | "social"
            | "memo"
            | "socketPreview"
            | "socket"
            | "refinePreview"
            | "refine"
            | "refineAdvance"
            | "warp"
            | "warpPreview"
            | "warpCancel"
    ) {
        return Err("Unknown bot action.".into());
    }
    if matches!(action.as_str(), "start" | "stop" | "heartbeat") && request.is_some() {
        return Err("This control does not accept an automation request.".into());
    }
    if matches!(
        action.as_str(),
        "command"
            | "workflow"
            | "routine"
            | "macro"
            | "service"
            | "social"
            | "memo"
            | "socketPreview"
            | "socket"
            | "refinePreview"
            | "refine"
            | "refineAdvance"
            | "warp"
            | "warpPreview"
            | "warpCancel"
    ) && settings.is_some()
    {
        return Err("Use start to apply automation settings.".into());
    }
    if action == "stop" {
        let mut in_world = false;
        if let Ok(mut state) = app.state::<login::SharedLogin>().lock() {
            in_world = state.in_world;
            state.cancel();
        }
        if !in_world {
            if let Some(game) = app.get_webview_window("game") {
                if direct::window_mode(&game)? == login::ConnectionMode::BotOnly
                    && !app.state::<direct::SharedDirect>().entered_world()
                {
                    direct::cancel_admitted(&app, &mut _permit);
                    game.destroy()
                        .map_err(|_| "Could not cancel the connection.")?;
                    return Ok(());
                }
            }
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
        "command"
            | "workflow"
            | "routine"
            | "macro"
            | "service"
            | "social"
            | "memo"
            | "socketPreview"
            | "socket"
            | "refinePreview"
            | "refine"
            | "refineAdvance"
            | "warp"
            | "warpPreview"
            | "warpCancel"
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
        let supply_json =
            serde_json::to_string(&supply_guard).map_err(|_| "Invalid supply resume state.")?;
        let recovery_json = serde_json::to_string(&death_recovery_guard)
            .map_err(|_| "Invalid death recovery state.")?;
        format!(
            "window.__RAYRAG__?.control({action_json},{settings_json},{escape_json},{supply_json},{recovery_json})"
        )
    };
    if action == "warp" {
        mode_guard::mark_admitted(&app, direct::window_mode(&game)?)?;
    }
    game.eval(script)
        .map_err(|_| "Could not reach the game controller.".into())
}

#[tauri::command]
fn bridge_status(
    app: tauri::AppHandle,
    window: WebviewWindow,
    mut status: serde_json::Value,
) -> Result<(), String> {
    require_game_runtime(&window)?;
    // Status is display data only. Never evaluate it or interpret it as a command.
    let encoded = serde_json::to_string(&status).map_err(|_| "Invalid status.")?;
    if encoded.len() > MAX_STATUS_BYTES || !status.is_object() {
        return Err("Status exceeds its limit.".into());
    }
    if let Ok(mut gate) = app.state::<maintenance::SharedGate>().lock() {
        if direct::window_mode(&window)? == login::ConnectionMode::BotOnly
            && !app.state::<direct::SharedDirect>().status_matches(&status)
        {
            return Err("Stale bot runtime status.".into());
        }
        if direct::window_mode(&window)? == login::ConnectionMode::BotOnly {
            app.state::<direct::SharedDirect>().observe_world(&status);
        }
        let identity = if status.get("connected").and_then(|v| v.as_bool()) == Some(true)
            && status.get("compatible").and_then(|v| v.as_bool()) == Some(true)
            && status.get("player").is_some_and(|v| v.is_object())
        {
            status
                .get("sessionId")
                .and_then(|v| v.as_str())
                .zip(status.get("connectionId").and_then(|v| v.as_str()))
                .map(|(session, connection)| maintenance::GameIdentity {
                    session_id: session.to_owned(),
                    connection_id: connection.to_owned(),
                })
        } else {
            None
        };
        if identity != gate.identity {
            if !gate.lease.as_ref().is_some_and(|l| l.committed) {
                gate.lease = None;
            }
            gate.game_generation += 1;
        }
        mode_guard::bind_owner(&app, gate.game_generation, &identity);
        gate.identity = identity;
        gate.observed = Some(std::time::Instant::now());
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
    if let Ok(mut update) = app.state::<updater::SharedUpdate>().lock() {
        update.wait_for_official(
            status.get("maintenanceWaiting").and_then(|v| v.as_bool()) == Some(true),
        );
    }
    app.emit_to("main", "game-status", status)
        .map_err(|_| "Controller is unavailable.".into())
}

fn require_game_runtime(window: &WebviewWindow) -> Result<(), String> {
    require_window(window, "game")?;
    direct::window_mode(window)?;
    Ok(())
}

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(maintenance::SharedGate::default())
        .manage(mode_guard::SharedGuard::default())
        .manage(updater::SharedUpdate::default())
        .manage(login::SharedLogin::default())
        .manage(direct::SharedDirect::default())
        .manage(settings_close::SharedClose::default())
        .setup(|app| {
            ci_smoke::install(app.handle())?;
            #[cfg(target_os = "macos")]
            settings_close::install_macos_quit(app.handle())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            #[cfg(feature = "ci-smoke")]
            ci_smoke::ci_smoke_report,
            settings_close::settings_close_ready,
            settings_close::settings_close_cancel,
            settings_close::settings_close_complete,
            updater::update_status,
            updater::current_form,
            updater::save_current_form,
            updater::update_initialized,
            updater::update_reserve,
            updater::update_ack,
            updater::update_release,
            updater::update_install,
            updater::update_lease_alive,
            updater::update_invalidate,
            updater::update_final_ack,
            updater::update_open_release,
            open_game,
            close_game,
            control_bot,
            bridge_status,
            direct::direct_connect,
            direct::direct_poll,
            direct::direct_observed,
            mode_guard::warp_guard_mark,
            mode_guard::warp_guard_initialize,
            mode_guard::warp_guard_clear,
            direct::direct_send,
            login::login_game,
            login::reconnect_game,
            login::saved_login,
            login::forget_login,
            login::cancel_pending_login,
            login::take_pending_login
        ])
        .on_page_load(|webview, payload| {
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                ci_smoke::page_loaded(webview.app_handle(), webview.label());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    settings_close::close_requested(window.app_handle(), api);
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                ci_smoke::destroyed(window.app_handle(), window.label());
                if window.label() == "main" {
                    direct::cancel(window.app_handle());
                    if let Some(game) = window.app_handle().get_webview_window("game") {
                        let _ = game.destroy();
                    }
                } else if window.label() == "game" {
                    direct::cancel(window.app_handle());
                    if let Ok(mut gate) = window
                        .app_handle()
                        .state::<maintenance::SharedGate>()
                        .lock()
                    {
                        if !gate.lease.as_ref().is_some_and(|l| l.committed) {
                            gate.page_closed();
                            gate.game_generation += 1;
                            gate.identity = None;
                            if let Some(l) = gate.lease.as_mut() {
                                l.invalidated = true;
                                l.acknowledged = false;
                            }
                        }
                    }
                    if let Ok(mut state) = window.app_handle().state::<login::SharedLogin>().lock()
                    {
                        state.close();
                    }
                    let _ = window.app_handle().emit_to("main", "game-closed", ());
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not launch Rayrag Companion")
        .run(|app, event| {
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                settings_close::exit_requested(app, code, &api);
            }
        });
}

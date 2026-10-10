use settings::automation::Settings;
use tauri::{webview::WebviewBuilder, Emitter, Manager, Webview, WebviewUrl};

mod game;
mod mcp;
mod session;
mod settings;
mod shared;
mod shell;
mod update;

const GAME_URL: &str = "https://websea01.rayrag.com/";
const BRIDGE: &str = include_str!("../generated/game-bridge.js");
// Bounded inventory, cart and storage snapshots can each contain 600 items.
const MAX_STATUS_BYTES: usize = 500_000;

fn app_data(app: &tauri::AppHandle) -> Result<std::path::PathBuf, tauri::Error> {
    if let Some(directory) = shell::ci_smoke::data_dir() {
        return Ok(directory);
    }
    app.path().app_data_dir()
}

fn require_view(window: &Webview, label: &str) -> Result<(), String> {
    if window.label() != label {
        return Err("Command is not available in this view.".into());
    }
    Ok(())
}

#[tauri::command]
// Keep admitted window operations on the UI thread: URL/build operations may
// synchronously dispatch there, while other UI commands need the same gate.
fn open_game(app: tauri::AppHandle, window: Webview) -> Result<(), String> {
    require_view(&window, "main")?;
    let mut permit = session::maintenance::admit(&app)?;
    permit.ever_game = true;
    permit.game_generation += 1;
    permit.identity = None;
    if app.get_webview("game").is_none() {
        permit.authorize_navigation();
    }
    let result = open_game_window(
        &app,
        session::login::ConnectionMode::GameClient,
        &mut permit,
    );
    if result.is_err() {
        permit.cancel_navigation();
    }
    result
}

#[tauri::command]
fn close_game(
    app: tauri::AppHandle,
    window: Webview,
    mcp_operation: Option<String>,
) -> Result<(), String> {
    require_view(&window, "main")?;
    let mut _permit = session::maintenance::admit(&app)?;
    let _mcp = mcp::authorize_effect(&app, &_permit, mcp_operation.as_deref(), "close_game")?;
    session::direct::cancel_admitted(&app, &mut _permit);
    close_game_runtime(&app, &mut _permit)
}

/// Child webview closure has no native WindowEvent::Destroyed. Keep explicit
/// disconnect and updater retirement on the same completion boundary.
/// Call on the UI thread: native Close executes synchronously there.
fn close_game_runtime(
    app: &tauri::AppHandle,
    gate: &mut session::maintenance::Gate,
) -> Result<(), String> {
    let Some(game) = app.get_webview("game") else {
        return Ok(());
    };
    game.close()
        .map_err(|_| "Could not disconnect the game.".to_string())?;
    app.state::<session::direct::SharedDirect>()
        .game_destroyed(gate);
    if let Ok(mut state) = app.state::<session::login::SharedLogin>().lock() {
        state.close();
    }
    let _ = app.emit_to("main", "game-closed", ());
    Ok(())
}

fn open_game_window(
    app: &tauri::AppHandle,
    mode: session::login::ConnectionMode,
    gate: &mut session::maintenance::Gate,
) -> Result<(), String> {
    session::mode_guard::check_app(app, mode)?;
    if let Some(game) = app.get_webview("game") {
        if session::direct::runtime_mode(&game)? != mode {
            return Err("Disconnect before changing the connection mode.".into());
        }
        return Ok(());
    }
    session::mode_guard::prepare(app, mode)?;
    let url = match mode {
        session::login::ConnectionMode::BotOnly => WebviewUrl::App("bot-runtime.html".into()),
        session::login::ConnectionMode::GameClient => {
            WebviewUrl::External(GAME_URL.parse().unwrap())
        }
    };
    let builder = WebviewBuilder::new("game", url)
        .incognito(true)
        .background_throttling(tauri::utils::config::BackgroundThrottlingPolicy::Disabled)
        .initialization_script(if mode == session::login::ConnectionMode::GameClient {
            BRIDGE
        } else {
            ""
        })
        .on_navigation({
            let app = app.clone();
            move |url| {
                if *url != session::direct::url_for(mode) {
                    return false;
                }
                let shared = app.state::<session::maintenance::SharedGate>();
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
        .on_new_window(|_, _| tauri::webview::NewWindowResponse::Deny);
    let main = app
        .get_window("main")
        .ok_or("The companion window is unavailable.")?;
    // The local shell supplies the visible bounds only after Game is selected.
    let size = main
        .inner_size()
        .map_err(|_| "Game view size unavailable.")?
        .to_logical::<f64>(
            main.scale_factor()
                .map_err(|_| "Game view scale unavailable.")?,
        );
    main.add_child(
        builder,
        tauri::LogicalPosition::new(-size.width - 1.0, 0.0),
        size,
    )
    .map_err(|_| "Could not open the game view.".to_string())?;
    gate.game_opened(mode);
    Ok(())
}

#[tauri::command]
#[allow(clippy::too_many_arguments)] // Explicit command fields preserve the existing native boundary.
fn control_bot(
    app: tauri::AppHandle,
    window: Webview,
    action: String,
    settings: Option<Settings>,
    request: Option<serde_json::Value>,
    escape_guard: Option<settings::automation::EscapeResumeGuard>,
    supply_guard: Option<settings::automation::SupplyResumeGuard>,
    death_recovery_guard: Option<settings::automation::DeathRecoveryGuard>,
    apply_id: Option<String>,
    live_settings_guard: Option<settings::automation::LiveSettingsGuard>,
    run_limit: Option<game::control::RunLimitCause>,
    mcp_operation: Option<String>,
) -> Result<(), String> {
    require_view(&window, "main")?;
    game::control::validate_run_limit(&action, run_limit)?;
    if let Some(guard) = &live_settings_guard {
        if action != "start" {
            return Err("Live settings protection is only accepted by start.".into());
        }
        guard.validate_at(9_007_199_254_740_991)?;
    }
    let admitted_death = if let Some(guard) = &death_recovery_guard {
        if action != "start" {
            return Err("Death recovery state is only accepted by start.".into());
        }
        Some(settings::automation::DeathResume::try_from(guard)?)
    } else {
        None
    };
    let admitted_supply = if let Some(guard) = &supply_guard {
        if action != "start" {
            return Err("Supply resume state is only accepted by start.".into());
        }
        Some(settings::automation::SupplyResume::try_from(guard)?)
    } else {
        None
    };
    let admitted_escape = if let Some(guard) = &escape_guard {
        if action != "start" {
            return Err("Escape resume state is only accepted by start.".into());
        }
        Some(settings::automation::EscapeResume::try_from(guard)?)
    } else {
        None
    };
    if !matches!(
        action.as_str(),
        "start"
            | "apply"
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
    if matches!(action.as_str(), "start" | "apply" | "stop" | "heartbeat") && request.is_some() {
        return Err("This control does not accept an automation request.".into());
    }
    if action == "apply" {
        let id = apply_id
            .as_deref()
            .ok_or("Settings Apply identity is required.")?;
        if id.len() != 32
            || !id
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err("Invalid settings Apply identity.".into());
        }
        settings
            .as_ref()
            .ok_or("Settings are required.")?
            .validate_form()?;
    } else if apply_id.is_some() {
        return Err("Settings Apply identity is only accepted by apply.".into());
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
    if action == "stop"
        && update::update_continuation::stop_while_settling(&app, mcp_operation.as_deref())?
    {
        return Ok(());
    }
    let mut _permit = session::maintenance::admit(&app)?;
    let _mcp = mcp::authorize_effect(
        &app,
        &_permit,
        mcp_operation.as_deref(),
        &format!("control_bot:{action}"),
    )?;
    if action == "stop" {
        let mut in_world = false;
        if let Ok(mut state) = app.state::<session::login::SharedLogin>().lock() {
            in_world = state.in_world;
            state.cancel();
        }
        if app.get_webview("game").is_some()
            && app
                .state::<session::direct::SharedDirect>()
                .cancel_pending_login(&mut _permit, in_world)
        {
            close_game_runtime(&app, &mut _permit)
                .map_err(|_| "Could not cancel the connection.")?;
            return Ok(());
        }
    }
    let admitted_settings = if action == "start" {
        Some(settings::automation::RunSettings::try_from(
            settings.as_ref().ok_or("Combat settings are required.")?,
        )?)
    } else {
        None
    };
    let game = app.get_webview("game").ok_or("Open the game first.")?;
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
        game::control::request_script(
            &action,
            request.as_ref().ok_or("Automation request is required.")?,
        )?
    } else {
        let action_json = serde_json::to_string(&action).map_err(|_| "Invalid action.")?;
        let settings_json = match admitted_settings {
            Some(settings) => serde_json::to_string(&settings),
            None => serde_json::to_string(&settings),
        }
        .map_err(|_| "Invalid settings.")?;
        let escape_json =
            serde_json::to_string(&admitted_escape).map_err(|_| "Invalid escape resume state.")?;
        let supply_json =
            serde_json::to_string(&admitted_supply).map_err(|_| "Invalid supply resume state.")?;
        let recovery_json =
            serde_json::to_string(&admitted_death).map_err(|_| "Invalid death recovery state.")?;
        let apply_json =
            serde_json::to_string(&apply_id).map_err(|_| "Invalid settings Apply identity.")?;
        let live_guard_json = serde_json::to_string(&live_settings_guard)
            .map_err(|_| "Invalid live settings protection.")?;
        let run_limit_json =
            serde_json::to_string(&run_limit).map_err(|_| "Invalid run limit cause.")?;
        format!(
            "window.__RAYRAG__?.control({action_json},{settings_json},{escape_json},{supply_json},{recovery_json},{apply_json},{live_guard_json},{run_limit_json})"
        )
    };
    if action == "warp" {
        session::mode_guard::mark_admitted(&app, session::direct::runtime_mode(&game)?)?;
    }
    game.eval(script)
        .map_err(|_| "Could not reach the game controller.".into())
}

#[tauri::command]
fn bridge_status(
    app: tauri::AppHandle,
    window: Webview,
    mut status: serde_json::Value,
) -> Result<(), String> {
    require_game_runtime(&window)?;
    // Status is display data only. Never evaluate it or interpret it as a command.
    let encoded = serde_json::to_string(&status).map_err(|_| "Invalid status.")?;
    if encoded.len() > MAX_STATUS_BYTES || !status.is_object() {
        return Err("Status exceeds its limit.".into());
    }
    status["mcpObservation"] = serde_json::Value::Null;
    if let Ok(mut gate) = app.state::<session::maintenance::SharedGate>().lock() {
        if session::direct::runtime_mode(&window)? == session::login::ConnectionMode::BotOnly
            && !app
                .state::<session::direct::SharedDirect>()
                .status_matches(&status)
        {
            return Err("Stale bot runtime status.".into());
        }
        if session::direct::runtime_mode(&window)? == session::login::ConnectionMode::BotOnly {
            app.state::<session::direct::SharedDirect>()
                .observe_world(&status);
        }
        let identity = if status.get("connected").and_then(|v| v.as_bool()) == Some(true)
            && status.get("compatible").and_then(|v| v.as_bool()) == Some(true)
            && status.get("player").is_some_and(|v| v.is_object())
        {
            status
                .get("sessionId")
                .and_then(|v| v.as_str())
                .zip(status.get("connectionId").and_then(|v| v.as_str()))
                .map(|(session, connection)| session::maintenance::GameIdentity {
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
        session::mode_guard::bind_owner(&app, gate.game_generation, &identity);
        gate.identity = identity;
        gate.observed = Some(std::time::Instant::now());
        status["mcpObservation"] = mcp::observe(&app, gate.game_generation);
    }
    if let Ok(mut state) = app.state::<session::login::SharedLogin>().lock() {
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
    update::update_continuation::observe(&app, &status);
    if let Ok(mut update) = app.state::<update::updater::SharedUpdate>().lock() {
        update.wait_for_official(
            status.get("maintenanceWaiting").and_then(|v| v.as_bool()) == Some(true),
        );
    }
    app.emit_to("main", "game-status", status)
        .map_err(|_| "Controller is unavailable.".into())
}

fn require_game_runtime(window: &Webview) -> Result<(), String> {
    require_view(window, "game")?;
    session::direct::runtime_mode(window)?;
    Ok(())
}

pub fn run() {
    let _ = rustls::crypto::ring::default_provider().install_default();
    tauri::Builder::default()
        .manage(session::maintenance::SharedGate::default())
        .manage(session::mode_guard::SharedGuard::default())
        .manage(update::updater::SharedUpdate::default())
        .manage(update::update_continuation::SharedContinuation::default())
        .manage(session::login::SharedLogin::default())
        .manage(session::direct::SharedDirect::default())
        .manage(settings::settings_close::SharedClose::default())
        .manage(mcp::SharedMcp::default())
        .setup(|app| {
            shell::ci_smoke::install(app.handle())?;
            update::update_continuation::initialize(app.handle())?;
            #[cfg(target_os = "macos")]
            settings::settings_close::install_macos_quit(app.handle())?;
            if let Err(error) = shell::client_view::create_main(app.handle()) {
                #[cfg(not(target_os = "macos"))]
                return Err(error.into());
                // Ready retries safe reconstruction and queues native guidance
                // on failure. Returning a setup error would terminate before
                // an independently dispatched dialog could become visible.
                #[cfg(target_os = "macos")]
                let _ = error;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            mcp::mcp_set_enabled,
            mcp::mcp_reply,
            mcp::mcp_claim,
            #[cfg(feature = "ci-smoke")]
            shell::ci_smoke::ci_smoke_report,
            settings::settings_close::settings_close_ready,
            settings::settings_close::settings_close_cancel,
            settings::settings_close::settings_close_complete,
            update::updater::update_status,
            update::updater::update_check,
            update::updater::current_form,
            update::updater::save_current_form,
            update::updater::update_initialized,
            update::updater::update_reserve,
            update::updater::update_ack,
            update::updater::update_release,
            update::updater::update_install,
            update::updater::update_lease_alive,
            update::updater::update_invalidate,
            update::updater::update_final_ack,
            update::update_continuation::update_prepare,
            update::update_continuation::update_prepared,
            update::update_continuation::update_cancel,
            update::update_continuation::update_continuation,
            update::update_continuation::update_startup_stopped,
            update::update_continuation::update_restore,
            update::update_continuation::update_restored,
            update::updater::update_open_release,
            open_game,
            close_game,
            shell::client_view::set_game_view,
            control_bot,
            bridge_status,
            game::map_data::map_database,
            session::direct::direct_connect,
            session::direct::direct_poll,
            session::direct::direct_observed,
            session::mode_guard::warp_guard_mark,
            session::mode_guard::warp_guard_initialize,
            session::mode_guard::warp_guard_clear,
            session::direct::direct_send,
            session::login::login_game,
            session::login::reconnect_game,
            session::login::saved_login,
            session::login::forget_login,
            session::login::cancel_pending_login,
            session::login::take_pending_login
        ])
        .on_page_load(|webview, payload| {
            if webview.label() == "main"
                && payload.event() == tauri::webview::PageLoadEvent::Started
            {
                mcp::shutdown(webview.app_handle());
            }
            if payload.event() == tauri::webview::PageLoadEvent::Finished {
                shell::ci_smoke::page_loaded(webview.app_handle(), webview.label());
            }
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    shell::ci_smoke::milestone("close-requested");
                    settings::settings_close::close_requested(window.app_handle(), api);
                }
            }
            if matches!(event, tauri::WindowEvent::Destroyed) {
                shell::ci_smoke::destroyed(window.app_handle(), window.label());
                if window.label() == "main" {
                    mcp::shutdown(window.app_handle());
                    session::direct::cancel(window.app_handle());
                    if let Ok(mut gate) = window
                        .app_handle()
                        .state::<session::maintenance::SharedGate>()
                        .lock()
                    {
                        let _ = close_game_runtime(window.app_handle(), &mut gate);
                    }
                    if let Ok(mut state) = window
                        .app_handle()
                        .state::<session::login::SharedLogin>()
                        .lock()
                    {
                        state.close();
                    }
                }
            }
        })
        .build(tauri::generate_context!())
        .expect("Could not launch Rayrag Companion")
        .run(|app, event| {
            if matches!(event, tauri::RunEvent::Exit) {
                mcp::shutdown(app);
            }
            #[cfg(target_os = "macos")]
            if matches!(
                event,
                tauri::RunEvent::Ready | tauri::RunEvent::Reopen { .. }
            ) {
                shell::client_view::recover_main(app);
            }
            if let tauri::RunEvent::ExitRequested { code, api, .. } = event {
                #[cfg(target_os = "macos")]
                if code.is_none() && shell::client_view::main_failure_pending() {
                    // A failed controller may destroy its empty native window.
                    // Keep the loop alive for queued guidance; explicit Quit
                    // still follows the existing settings-save handshake.
                    api.prevent_exit();
                    return;
                }
                settings::settings_close::exit_requested(app, code, &api);
            }
        });
}

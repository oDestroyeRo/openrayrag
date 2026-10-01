use serde::{Deserialize, Serialize};
use std::sync::OnceLock;
use tauri::{Emitter, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
mod login;

const GAME_URL: &str = "https://websea01.rayrag.com/";
const BRIDGE: &str = include_str!("../generated/game-bridge.js");

fn supported_map(map: &str) -> bool {
    static MAPS: OnceLock<serde_json::Map<String, serde_json::Value>> = OnceLock::new();
    MAPS.get_or_init(|| {
        serde_json::from_str(include_str!("../../src/data/navigation-maps.json"))
            .expect("Bundled navigation catalog must be valid")
    })
    .contains_key(map)
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    map: String,
    targets: Vec<u32>,
    radius: u8,
    min_hp_percent: u8,
    loot: bool,
    #[serde(rename = "route_randomWalk")]
    route_random_walk: u8,
    #[serde(rename = "route_step")]
    route_step: u8,
    #[serde(rename = "route_avoidWalls")]
    route_avoid_walls: bool,
    #[serde(rename = "route_randomWalk_maxRouteTime")]
    route_random_walk_max_route_time: u16,
    attack_route_max_path_distance: u16,
    attack_max_route_time: u8,
}

impl Settings {
    fn validate(&self) -> Result<(), String> {
        if !(1..=20).contains(&self.radius)
            || !(20..=95).contains(&self.min_hp_percent)
            || !supported_map(&self.map)
            || !matches!(self.route_random_walk, 0 | 2)
            || !(1..=20).contains(&self.route_step)
            || !(1..=600).contains(&self.route_random_walk_max_route_time)
            || !(1..=200).contains(&self.attack_route_max_path_distance)
            || !(1..=60).contains(&self.attack_max_route_time)
            || self.targets.is_empty()
            || self.targets.len() > 64
            || self.map.is_empty()
            || self.map.len() > 64
            || !self
                .map
                .bytes()
                .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
            || self
                .targets
                .iter()
                .enumerate()
                .any(|(i, id)| *id == 0 || *id > i32::MAX as u32 || self.targets[..i].contains(id))
        {
            return Err("Invalid combat settings.".into());
        }
        Ok(())
    }
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
) -> Result<(), String> {
    require_window(&window, "main")?;
    if !matches!(action.as_str(), "start" | "stop" | "heartbeat") {
        return Err("Unknown bot action.".into());
    }
    if action == "stop" {
        if let Ok(mut state) = app.state::<login::SharedLogin>().lock() {
            state.pending = None;
            state.cancelled = true;
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
    let action_json = serde_json::to_string(&action).map_err(|_| "Invalid action.")?;
    let settings_json = serde_json::to_string(&settings).map_err(|_| "Invalid settings.")?;
    game.eval(format!(
        "window.__RAYRAG__?.control({action_json},{settings_json})"
    ))
    .map_err(|_| "Could not reach the game controller.".into())
}

#[tauri::command]
fn bridge_status(
    app: tauri::AppHandle,
    window: WebviewWindow,
    status: serde_json::Value,
) -> Result<(), String> {
    require_window(&window, "game")?;
    // Status is display data only. Never evaluate it or interpret it as a command.
    let encoded = serde_json::to_string(&status).map_err(|_| "Invalid status.")?;
    if encoded.len() > 100_000 || !status.is_object() {
        return Err("Status exceeds its limit.".into());
    }
    if let Ok(mut state) = app.state::<login::SharedLogin>().lock() {
        state.in_world = status
            .get("player")
            .is_some_and(|player| player.is_object());
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
                        state.pending = None;
                        state.in_world = false;
                        state.cancelled = false;
                    }
                    let _ = window.app_handle().emit_to("main", "game-closed", ());
                }
            }
        })
        .run(tauri::generate_context!())
        .expect("Could not launch Rayrag Companion");
}

#[cfg(test)]
mod tests {
    use super::Settings;
    #[test]
    fn validates_control_boundary() {
        let mut value = Settings {
            map: "prt_fild05".into(),
            targets: vec![4000],
            radius: 12,
            min_hp_percent: 45,
            loot: true,
            route_random_walk: 0,
            route_step: 10,
            route_avoid_walls: true,
            route_random_walk_max_route_time: 75,
            attack_route_max_path_distance: 20,
            attack_max_route_time: 4,
        };
        assert!(value.validate().is_ok());
        value.route_random_walk = 2;
        assert!(value.validate().is_ok());
        for map in [
            "prt_fild08",
            "pay_fild02",
            "pay_fild03",
            "gef_dun03",
            "yuno",
        ] {
            value.map = map.into();
            assert!(value.validate().is_ok());
        }
        value.route_random_walk = 0;
        assert!(value.validate().is_ok());
        for map in ["unsupported_map", "payon_p", "2009rwc_03", "pvp_n_1-5"] {
            value.map = map.into();
            assert!(value.validate().is_err());
        }
        value.map = "prt_fild05".into();
        value.route_random_walk = 1;
        assert!(value.validate().is_err());
        value.route_random_walk = 2;
        value.route_step = 21;
        assert!(value.validate().is_err());
        value.route_step = 10;
        value.attack_max_route_time = 0;
        assert!(value.validate().is_err());
        value.attack_max_route_time = 4;
        let json = serde_json::to_value(&value).unwrap();
        assert_eq!(json["route_randomWalk"], 2);
        assert_eq!(json["attackRouteMaxPathDistance"], 20);
        assert_eq!(json["route_avoidWalls"], true);
        assert!(serde_json::from_value::<Settings>(json)
            .unwrap()
            .validate()
            .is_ok());
        value.radius = 255;
        assert!(value.validate().is_err());
        value.radius = 12;
        value.min_hp_percent = 0;
        assert!(value.validate().is_err());
        value.min_hp_percent = 45;
        value.targets.clear();
        assert!(value.validate().is_err());
        value.targets = vec![4000, 4000];
        assert!(value.validate().is_err());
        value.targets = vec![0];
        assert!(value.validate().is_err());
        value.targets = vec![4000];
        value.map.clear();
        assert!(value.validate().is_err());
        value.map = "../another-map".into();
        assert!(value.validate().is_err());
    }
}

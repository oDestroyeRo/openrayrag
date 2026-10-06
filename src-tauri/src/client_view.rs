//! A persistent game webview shares the companion window, never its authority.
use frunk::{hlist_pat, prelude::IntoValidated};
use serde::Deserialize;
use tauri::{webview::WebviewBuilder, Manager, Webview};

pub(crate) fn create_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    crate::ci_smoke::milestone("main-window-building");
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("The main window configuration must exist");
    let window = tauri::window::WindowBuilder::from_config(app, config)?.build()?;
    crate::ci_smoke::milestone("main-webview-building");
    window.add_child(
        WebviewBuilder::from_config(config).auto_resize(),
        tauri::LogicalPosition::new(0, 0),
        window.inner_size()?,
    )?;
    crate::ci_smoke::milestone("main-webview-built");
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq, frunk::Generic)]
#[serde(deny_unknown_fields)]
pub(crate) struct GameViewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

fn parked_x(width: f64) -> Result<f64, String> {
    if !width.is_finite() || width < 1.0 {
        return Err("Game view size unavailable.".into());
    }
    // The right edge stays left of the client area even when the window grows.
    Ok(-width - 1.0)
}

impl GameViewBounds {
    fn clipped(self, width: f64, height: f64) -> Result<Self, String> {
        if ![self.x, self.y, self.width, self.height, width, height]
            .iter()
            .all(|value| value.is_finite())
        {
            return Err("Invalid game view bounds.".into());
        }
        ((self.x >= 0.0 && self.x < width)
            .then_some(self.x)
            .ok_or(())
            .into_validated()
            + (self.y >= 0.0 && self.y < height)
                .then_some(self.y)
                .ok_or(())
            + (self.width >= 1.0).then_some(self.width).ok_or(())
            + (self.height >= 1.0).then_some(self.height).ok_or(()))
        .into_result()
        .map(|hlist_pat!(x, y, requested_width, requested_height)| {
            frunk::from_generic(frunk::hlist![
                x,
                y,
                requested_width.min(width - x),
                requested_height.min(height - y)
            ])
        })
        .map_err(|_| "Invalid game view bounds.".into())
    }
}

#[tauri::command]
pub(crate) fn set_game_view(
    app: tauri::AppHandle,
    window: Webview,
    bounds: Option<GameViewBounds>,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    let Some(game) = app.get_webview("game") else {
        return if bounds.is_none() {
            Ok(())
        } else {
            Err("Connect with the game client before opening Game.".into())
        };
    };
    let Some(bounds) = bounds else {
        // Keep the native view visible so its socket/controller is not suspended
        // on platforms where disabled background throttling is unsupported.
        let width = game
            .size()
            .map_err(|_| "Game view size unavailable.")?
            .to_logical::<f64>(
                window
                    .window()
                    .scale_factor()
                    .map_err(|_| "Game view scale unavailable.")?,
            )
            .width;
        return game
            .set_position(tauri::LogicalPosition::new(parked_x(width)?, 0.0))
            .and_then(|()| game.show())
            .and_then(|()| window.set_focus())
            .map_err(|_| "Could not switch to Bot.".into());
    };
    if crate::direct::runtime_mode(&game)? != crate::login::ConnectionMode::GameClient {
        return Err("Game is unavailable in Bot only mode.".into());
    }
    // Presentation cannot expose official input during update installation.
    let _permit = crate::maintenance::admit(&app)?;
    let parent = window.window();
    let size = parent
        .inner_size()
        .map_err(|_| "Game view size unavailable.")?
        .to_logical::<f64>(
            parent
                .scale_factor()
                .map_err(|_| "Game view scale unavailable.")?,
        );
    let bounds = bounds.clipped(size.width, size.height)?;
    game.set_bounds(tauri::Rect {
        position: tauri::LogicalPosition::new(bounds.x, bounds.y).into(),
        size: tauri::LogicalSize::new(bounds.width, bounds.height).into(),
    })
    .and_then(|()| game.show())
    .map_err(|_| "Could not show Game.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parked_game_keeps_its_size_and_cannot_reappear_on_window_resize() {
        for width in [1.0, 820.0, 1360.0, 4000.0] {
            assert!(parked_x(width).unwrap() + width < 0.0);
        }
        for width in [0.0, -1.0, f64::NAN, f64::INFINITY] {
            assert!(parked_x(width).is_err());
        }
    }

    #[test]
    fn sharing_a_parent_window_does_not_share_controller_authority() {
        let controller: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/controller.json")).unwrap();
        assert!(controller.get("windows").is_none());
        assert_eq!(controller["webviews"], serde_json::json!(["main"]));
        for capability in [
            include_str!("../capabilities/game-telemetry.json"),
            include_str!("../capabilities/bot-runtime.json"),
        ] {
            let capability: serde_json::Value = serde_json::from_str(capability).unwrap();
            assert!(capability.get("windows").is_none());
            assert_eq!(capability["webviews"], serde_json::json!(["game"]));
            let permissions = capability["permissions"].as_array().unwrap();
            for permission in controller["permissions"].as_array().unwrap() {
                assert!(
                    !permissions.contains(permission),
                    "A game view gained controller permission: {permission}"
                );
            }
        }
        let official: serde_json::Value =
            serde_json::from_str(include_str!("../capabilities/game-telemetry.json")).unwrap();
        assert_eq!(official["local"], false);
        assert_eq!(
            official["remote"]["urls"],
            serde_json::json!([crate::GAME_URL])
        );
    }

    #[test]
    fn game_bounds_follow_the_content_area_and_clip_a_resize_race() {
        let bounds = GameViewBounds {
            x: 24.0,
            y: 180.0,
            width: 1100.0,
            height: 720.0,
        };
        assert_eq!(
            bounds.clipped(1100.0, 880.0).unwrap(),
            GameViewBounds {
                x: 24.0,
                y: 180.0,
                width: 1076.0,
                height: 700.0,
            }
        );
    }

    #[test]
    fn finite_bounds_preserve_fractional_room_after_a_resize() {
        let bounds = GameViewBounds {
            x: 99.75,
            y: 49.5,
            width: 10.0,
            height: 10.0,
        };
        let expected = GameViewBounds {
            x: 99.75,
            y: 49.5,
            width: 0.25,
            height: 0.5,
        };
        assert_eq!(bounds.clipped(100.0, 50.0).unwrap(), expected);
        assert_eq!(bounds.clipped(100.0, 50.0).unwrap(), expected);
        assert_eq!(bounds.width, 10.0);
        for (width, height) in [
            (f64::NAN, 50.0),
            (100.0, f64::INFINITY),
            (99.75, 50.0),
            (100.0, 49.5),
        ] {
            assert_eq!(
                bounds.clipped(width, height).unwrap_err(),
                "Invalid game view bounds."
            );
        }
    }

    #[test]
    fn malformed_or_offscreen_bounds_cannot_show_the_game() {
        for bounds in [
            GameViewBounds {
                x: -1.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            GameViewBounds {
                x: 1100.0,
                y: 0.0,
                width: 1.0,
                height: 1.0,
            },
            GameViewBounds {
                x: 0.0,
                y: 880.0,
                width: 1.0,
                height: 1.0,
            },
            GameViewBounds {
                x: 0.0,
                y: 0.0,
                width: 0.0,
                height: 1.0,
            },
            GameViewBounds {
                x: 0.0,
                y: f64::NAN,
                width: 1.0,
                height: 1.0,
            },
            GameViewBounds {
                x: 0.0,
                y: 0.0,
                width: f64::INFINITY,
                height: 1.0,
            },
        ] {
            assert!(bounds.clipped(1100.0, 880.0).is_err());
        }
    }
}

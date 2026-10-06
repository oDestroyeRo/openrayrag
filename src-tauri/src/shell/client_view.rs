//! A persistent game webview shares the companion window, never its authority.
use crate::shared::domain_values::{ClippedViewExtent, RequestedViewExtent, ViewOrigin};
use frunk::{hlist_pat, prelude::IntoValidated};
use serde::Deserialize;
use tauri::{webview::WebviewBuilder, Manager, Webview};

pub(crate) fn create_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    crate::shell::ci_smoke::milestone("main-window-building");
    let config = app
        .config()
        .app
        .windows
        .iter()
        .find(|window| window.label == "main")
        .expect("The main window configuration must exist");
    let window = tauri::window::WindowBuilder::from_config(app, config)?.build()?;
    crate::shell::ci_smoke::milestone("main-webview-building");
    window.add_child(
        WebviewBuilder::from_config(config).auto_resize(),
        tauri::LogicalPosition::new(0, 0),
        window.inner_size()?,
    )?;
    crate::shell::ci_smoke::milestone("main-webview-built");
    #[cfg(target_os = "macos")]
    recover_main(app)?;
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
trait MainWindowEffects {
    type Error;
    fn show_application(&mut self) -> Result<(), Self::Error>;
    fn unminimize(&mut self) -> Result<(), Self::Error>;
    fn show_window(&mut self) -> Result<(), Self::Error>;
    fn focus(&mut self) -> Result<(), Self::Error>;
}

#[cfg(any(target_os = "macos", test))]
fn recover_main_program<E: MainWindowEffects>(effects: &mut E) -> Result<(), E::Error> {
    effects.show_application()?;
    effects.unminimize()?;
    effects.show_window()?;
    effects.focus()
}

#[cfg(target_os = "macos")]
struct NativeMainWindow<'a> {
    app: &'a tauri::AppHandle,
    window: tauri::Window,
}

#[cfg(target_os = "macos")]
impl MainWindowEffects for NativeMainWindow<'_> {
    type Error = tauri::Error;
    fn show_application(&mut self) -> tauri::Result<()> {
        self.app.show()
    }
    fn unminimize(&mut self) -> tauri::Result<()> {
        self.window.unminimize()
    }
    fn show_window(&mut self) -> tauri::Result<()> {
        self.window.show()
    }
    fn focus(&mut self) -> tauri::Result<()> {
        self.window.set_focus()
    }
}

/// Recover presentation only; reopening never changes settings or run intent.
#[cfg(target_os = "macos")]
pub(crate) fn recover_main(app: &tauri::AppHandle) -> tauri::Result<()> {
    if let Some(window) = app.get_window("main") {
        recover_main_program(&mut NativeMainWindow { app, window })?;
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub(crate) struct GameViewBounds {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct ClippedViewBounds {
    x: ViewOrigin,
    y: ViewOrigin,
    width: ClippedViewExtent,
    height: ClippedViewExtent,
}
#[cfg(test)]
impl ClippedViewBounds {
    fn raw(self) -> GameViewBounds {
        GameViewBounds {
            x: self.x.get(),
            y: self.y.get(),
            width: self.width.get(),
            height: self.height.get(),
        }
    }
}

fn parked_x(width: f64) -> Result<f64, String> {
    if !width.is_finite() || width < 1.0 {
        return Err("Game view size unavailable.".into());
    }
    // The right edge stays left of the client area even when the window grows.
    Ok(-width - 1.0)
}

impl GameViewBounds {
    fn clipped(self, width: f64, height: f64) -> Result<ClippedViewBounds, String> {
        if ![self.x, self.y, self.width, self.height, width, height]
            .iter()
            .all(|value| value.is_finite())
        {
            return Err("Invalid game view bounds.".into());
        }
        (ViewOrigin::try_from((self.x, width)).into_validated()
            + ViewOrigin::try_from((self.y, height))
            + RequestedViewExtent::try_from(self.width)
            + RequestedViewExtent::try_from(self.height))
        .into_result()
        .map_err(|_| "Invalid game view bounds.")
        .and_then(|hlist_pat!(x, y, requested_width, requested_height)| {
            Ok(ClippedViewBounds {
                x,
                y,
                width: ClippedViewExtent::clip(requested_width, width - x.get())
                    .map_err(|_| "Invalid game view bounds.")?,
                height: ClippedViewExtent::clip(requested_height, height - y.get())
                    .map_err(|_| "Invalid game view bounds.")?,
            })
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
    if crate::session::direct::runtime_mode(&game)?
        != crate::session::login::ConnectionMode::GameClient
    {
        return Err("Game is unavailable in Bot only mode.".into());
    }
    // Presentation cannot expose official input during update installation.
    let _permit = crate::session::maintenance::admit(&app)?;
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
        position: tauri::LogicalPosition::new(bounds.x.get(), bounds.y.get()).into(),
        size: tauri::LogicalSize::new(bounds.width.get(), bounds.height.get()).into(),
    })
    .and_then(|()| game.show())
    .map_err(|_| "Could not show Game.".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reopening_restores_a_hidden_minimized_window_before_focusing_it() {
        struct Window {
            hidden_app: bool,
            minimized: bool,
            hidden_window: bool,
            focused: bool,
        }
        impl MainWindowEffects for Window {
            type Error = &'static str;
            fn show_application(&mut self) -> Result<(), Self::Error> {
                self.hidden_app = false;
                Ok(())
            }
            fn unminimize(&mut self) -> Result<(), Self::Error> {
                self.minimized = false;
                Ok(())
            }
            fn show_window(&mut self) -> Result<(), Self::Error> {
                self.hidden_window = false;
                Ok(())
            }
            fn focus(&mut self) -> Result<(), Self::Error> {
                if self.hidden_app || self.minimized || self.hidden_window {
                    return Err("Window is not usable");
                }
                self.focused = true;
                Ok(())
            }
        }
        let mut window = Window {
            hidden_app: true,
            minimized: true,
            hidden_window: true,
            focused: false,
        };
        assert_eq!(recover_main_program(&mut window), Ok(()));
        assert!(window.focused);
        assert_eq!(recover_main_program(&mut window), Ok(()));
    }

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
            serde_json::from_str(include_str!("../../capabilities/controller.json")).unwrap();
        assert!(controller.get("windows").is_none());
        assert_eq!(controller["webviews"], serde_json::json!(["main"]));
        for capability in [
            include_str!("../../capabilities/game-telemetry.json"),
            include_str!("../../capabilities/bot-runtime.json"),
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
            serde_json::from_str(include_str!("../../capabilities/game-telemetry.json")).unwrap();
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
            bounds.clipped(1100.0, 880.0).unwrap().raw(),
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
        assert_eq!(bounds.clipped(100.0, 50.0).unwrap().raw(), expected);
        assert_eq!(bounds.clipped(100.0, 50.0).unwrap().raw(), expected);
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

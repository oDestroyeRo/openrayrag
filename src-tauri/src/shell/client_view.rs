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
    let controller = (|| {
        window.add_child(
            WebviewBuilder::from_config(config).auto_resize(),
            tauri::LogicalPosition::new(0, 0),
            window.inner_size()?,
        )
    })();
    if let Err(error) = controller {
        // A failed controller must not leave an empty registered main window
        // which would prevent a later, safe reconstruction.
        let _ = window.destroy();
        return Err(error);
    }
    crate::shell::ci_smoke::milestone("main-webview-built");
    Ok(())
}

#[cfg(any(target_os = "macos", test))]
const RECOVERY_ERROR: &str = "Could not restore the Companion window. Quit and reopen Rayrag Companion. Your saved settings are preserved.";

#[cfg(any(target_os = "macos", test))]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum MainWindowState {
    Complete,
    Absent,
    Incomplete,
}

#[cfg(any(target_os = "macos", test))]
trait MainWindowEffects {
    fn state(&mut self) -> MainWindowState;
    fn create(&mut self) -> Result<(), &'static str>;
    fn show_application(&mut self) -> Result<(), &'static str>;
    fn unminimize(&mut self) -> Result<(), &'static str>;
    fn show_window(&mut self) -> Result<(), &'static str>;
    fn focus(&mut self) -> Result<(), &'static str>;
    fn verify_visible(&mut self) -> Result<(), &'static str>;
}

#[cfg(any(target_os = "macos", test))]
fn recover_main_program<E: MainWindowEffects>(effects: &mut E) -> Result<(), &'static str> {
    match effects.state() {
        MainWindowState::Complete => (),
        MainWindowState::Absent => {
            effects.create()?;
            if effects.state() != MainWindowState::Complete {
                return Err(RECOVERY_ERROR);
            }
        }
        // Rebuilding around a surviving controller or game could duplicate its
        // lifecycle. Preserve that owner and provide native recovery guidance.
        MainWindowState::Incomplete => return Err(RECOVERY_ERROR),
    }
    effects.show_application()?;
    effects.unminimize()?;
    effects.show_window()?;
    effects.focus()?;
    effects.verify_visible()
}

#[cfg(target_os = "macos")]
struct NativeMainWindow<'a> {
    app: &'a tauri::AppHandle,
    window: Option<tauri::Window>,
}

#[cfg(target_os = "macos")]
impl NativeMainWindow<'_> {
    fn window(&self) -> Result<&tauri::Window, &'static str> {
        self.window.as_ref().ok_or(RECOVERY_ERROR)
    }
}

#[cfg(target_os = "macos")]
impl MainWindowEffects for NativeMainWindow<'_> {
    fn state(&mut self) -> MainWindowState {
        self.window = self.app.get_window("main");
        match (self.window.as_ref(), self.app.get_webview("main")) {
            (Some(_), Some(controller)) if controller.window().label() == "main" => {
                MainWindowState::Complete
            }
            (None, None) if self.app.get_webview("game").is_none() => MainWindowState::Absent,
            _ => MainWindowState::Incomplete,
        }
    }
    fn create(&mut self) -> Result<(), &'static str> {
        create_main(self.app).map_err(|_| RECOVERY_ERROR)
    }
    fn show_application(&mut self) -> Result<(), &'static str> {
        self.app.show().map_err(|_| RECOVERY_ERROR)
    }
    fn unminimize(&mut self) -> Result<(), &'static str> {
        self.window()?.unminimize().map_err(|_| RECOVERY_ERROR)
    }
    fn show_window(&mut self) -> Result<(), &'static str> {
        self.window()?.show().map_err(|_| RECOVERY_ERROR)
    }
    fn focus(&mut self) -> Result<(), &'static str> {
        self.window()?.set_focus().map_err(|_| RECOVERY_ERROR)
    }
    fn verify_visible(&mut self) -> Result<(), &'static str> {
        let window = self.window()?;
        if window.is_visible().map_err(|_| RECOVERY_ERROR)?
            && !window.is_minimized().map_err(|_| RECOVERY_ERROR)?
        {
            Ok(())
        } else {
            Err(RECOVERY_ERROR)
        }
    }
}

/// Recover presentation only; reopening never changes settings or run intent.
#[cfg(target_os = "macos")]
pub(crate) fn recover_main(app: &tauri::AppHandle) {
    if recover_main_program(&mut NativeMainWindow { app, window: None }).is_err() {
        report_main_failure();
    }
}

/// A recovery error must remain visible even when the HTML window is absent.
#[cfg(target_os = "macos")]
pub(crate) fn report_main_failure() {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{NSAlert, NSApplication};
    use objc2_foundation::NSString;

    eprintln!("{RECOVERY_ERROR}");
    let Some(main_thread) = MainThreadMarker::new() else {
        return;
    };
    let application = NSApplication::sharedApplication(main_thread);
    #[allow(deprecated)]
    application.activateIgnoringOtherApps(true);
    let alert = NSAlert::new(main_thread);
    alert.setMessageText(&NSString::from_str("Could not restore Companion"));
    alert.setInformativeText(&NSString::from_str(RECOVERY_ERROR));
    alert.addButtonWithTitle(&NSString::from_str("OK"));
    alert.runModal();
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

    struct Window {
        state: MainWindowState,
        created_state: MainWindowState,
        calls: Vec<&'static str>,
        failure: Option<&'static str>,
        hidden_app: bool,
        minimized: bool,
        hidden_window: bool,
        focused: bool,
    }
    impl Window {
        fn hidden(state: MainWindowState) -> Self {
            Self {
                state,
                created_state: MainWindowState::Complete,
                calls: vec![],
                failure: None,
                hidden_app: true,
                minimized: true,
                hidden_window: true,
                focused: false,
            }
        }
        fn effect(&mut self, call: &'static str) -> Result<(), &'static str> {
            self.calls.push(call);
            if self.failure == Some(call) {
                Err(RECOVERY_ERROR)
            } else {
                Ok(())
            }
        }
    }
    impl MainWindowEffects for Window {
        fn state(&mut self) -> MainWindowState {
            self.calls.push("state");
            self.state
        }
        fn create(&mut self) -> Result<(), &'static str> {
            self.effect("create")?;
            self.state = self.created_state;
            Ok(())
        }
        fn show_application(&mut self) -> Result<(), &'static str> {
            self.effect("show-application")?;
            self.hidden_app = false;
            Ok(())
        }
        fn unminimize(&mut self) -> Result<(), &'static str> {
            self.effect("unminimize")?;
            self.minimized = false;
            Ok(())
        }
        fn show_window(&mut self) -> Result<(), &'static str> {
            self.effect("show-window")?;
            self.hidden_window = false;
            Ok(())
        }
        fn focus(&mut self) -> Result<(), &'static str> {
            self.effect("focus")?;
            if self.hidden_app || self.minimized || self.hidden_window {
                return Err(RECOVERY_ERROR);
            }
            self.focused = true;
            Ok(())
        }
        fn verify_visible(&mut self) -> Result<(), &'static str> {
            self.effect("verify-visible")
        }
    }

    #[test]
    fn reopening_restores_a_hidden_minimized_window_before_focusing_it() {
        let mut window = Window::hidden(MainWindowState::Complete);
        assert_eq!(recover_main_program(&mut window), Ok(()));
        assert!(window.focused);
        assert_eq!(
            window.calls,
            [
                "state",
                "show-application",
                "unminimize",
                "show-window",
                "focus",
                "verify-visible"
            ]
        );
        window.calls.clear();
        assert_eq!(recover_main_program(&mut window), Ok(()));
        assert!(!window.calls.contains(&"create"));
    }

    #[test]
    fn reopening_reconstructs_only_a_missing_window_without_surviving_owners() {
        let mut absent = Window::hidden(MainWindowState::Absent);
        assert_eq!(recover_main_program(&mut absent), Ok(()));
        assert_eq!(&absent.calls[..3], ["state", "create", "state"]);
        assert!(absent.focused);

        let mut orphaned = Window::hidden(MainWindowState::Incomplete);
        assert_eq!(recover_main_program(&mut orphaned), Err(RECOVERY_ERROR));
        assert_eq!(orphaned.calls, ["state"]);
        assert_eq!(orphaned.state, MainWindowState::Incomplete);
    }

    #[test]
    fn creation_or_presentation_failure_remains_a_recovery_error() {
        let operations = [
            "create",
            "show-application",
            "unminimize",
            "show-window",
            "focus",
            "verify-visible",
        ];
        for failed in operations {
            let mut window = Window::hidden(MainWindowState::Absent);
            window.failure = Some(failed);
            assert_eq!(recover_main_program(&mut window), Err(RECOVERY_ERROR));
            assert_eq!(window.calls.last(), Some(&failed));
            if failed == "create" {
                assert_eq!(window.state, MainWindowState::Absent);
            }
        }
    }

    #[test]
    fn accepted_creation_without_a_registered_controller_is_not_success() {
        for created_state in [MainWindowState::Absent, MainWindowState::Incomplete] {
            let mut window = Window::hidden(MainWindowState::Absent);
            window.created_state = created_state;
            assert_eq!(recover_main_program(&mut window), Err(RECOVERY_ERROR));
            assert_eq!(window.calls, ["state", "create", "state"]);
            assert!(!window.focused);
        }
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

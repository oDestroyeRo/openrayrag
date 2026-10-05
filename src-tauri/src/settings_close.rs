use serde::Serialize;
use std::sync::Mutex;
use tauri::{Emitter, Manager, Webview};

const ERROR: &str = "Close was not confirmed by saved current settings. Try closing again.";

#[cfg(target_os = "macos")]
mod macos {
    use objc2::{
        runtime::{AnyObject, Imp, Sel},
        MainThreadMarker,
    };
    use objc2_app_kit::{NSApplication, NSApplicationTerminateReply};
    use std::sync::OnceLock;

    static APP: OnceLock<tauri::AppHandle> = OnceLock::new();

    extern "C-unwind" fn should_terminate(
        _delegate: &AnyObject,
        _selector: Sel,
        _sender: &NSApplication,
    ) -> NSApplicationTerminateReply {
        // No Rust panic may cross this AppKit callback. A failure must keep the
        // window available so a pending edit is not silently discarded.
        let _ = std::panic::catch_unwind(|| {
            if let Some(app) = APP.get() {
                // Queue a preventable Tauri exit; its existing save handshake
                // performs the eventual shutdown after native confirmation.
                app.exit(0);
            }
        });
        NSApplicationTerminateReply::TerminateCancel
    }

    pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let mtm = MainThreadMarker::new().ok_or("Quit setup must run on the main thread")?;
        let application = NSApplication::sharedApplication(mtm);
        let delegate = application
            .delegate()
            .ok_or("Application delegate is unavailable")?;
        APP.set(app.clone())
            .map_err(|_| "Quit setup already initialized")?;
        let selector = objc2::sel!(applicationShouldTerminate:);
        // Tao's current delegate lacks this optional AppKit method. Register on
        // the actual delegate class, without replacing its existing methods or
        // default menus. AppKit calls this for menu, Cmd-Q, and Dock Quit. See:
        // https://developer.apple.com/documentation/appkit/nsapplicationdelegate/applicationshouldterminate(_:)
        // SAFETY: Setup is on the main thread, the runtime class lives for the
        // process, and this signature is exactly (id, SEL, NSApplication*) ->
        // NSUInteger. The encoding follows the target's pointer-width ABI.
        let added = unsafe {
            let class = objc2::ffi::object_getClass(objc2::rc::Retained::as_ptr(&delegate).cast());
            if !objc2::ffi::class_getInstanceMethod(class, selector).is_null() {
                return Err("Application delegate already handles macOS Quit".into());
            }
            let implementation: Imp = std::mem::transmute(
                should_terminate
                    as extern "C-unwind" fn(
                        &AnyObject,
                        Sel,
                        &NSApplication,
                    ) -> NSApplicationTerminateReply,
            );
            let encoding = if cfg!(target_pointer_width = "64") {
                c"Q@:@"
            } else {
                c"I@:@"
            };
            objc2::ffi::class_addMethod(
                class.cast_mut(),
                selector,
                implementation,
                encoding.as_ptr(),
            )
        };
        if !added.as_bool() {
            return Err("Could not register the settings save guard for macOS Quit".into());
        }
        Ok(())
    }
}

#[cfg(target_os = "macos")]
pub(crate) use macos::install as install_macos_quit;

#[derive(Clone, Serialize)]
pub(crate) struct Request {
    token: String,
}

#[derive(Clone, Copy, Debug, PartialEq)]
enum Intent {
    Close,
    Quit(i32),
}

#[derive(Default)]
pub(crate) struct CloseState {
    ready: bool,
    pending: Option<(Request, Intent)>,
    completing: bool,
}
pub(crate) type SharedClose = Mutex<CloseState>;

impl CloseState {
    fn request(&mut self, intent: Intent) -> Option<Request> {
        // Before registration the controller keeps its form inert. Allow shutdown
        // if its JS never initializes; there cannot be an editable unsaved draft.
        if !self.ready || self.completing {
            return None;
        }
        let (request, current) = self.pending.get_or_insert_with(|| {
            (
                Request {
                    token: uuid::Uuid::new_v4().to_string(),
                },
                intent,
            )
        });
        if matches!(intent, Intent::Quit(_)) {
            *current = intent;
        }
        Some(request.clone())
    }

    fn request_exit(&mut self, code: Option<i32>) -> Option<Request> {
        if code == Some(tauri::RESTART_EXIT_CODE) {
            return None;
        }
        self.request(Intent::Quit(code.unwrap_or(0)))
    }

    fn complete(
        &mut self,
        token: &str,
        saved_revision: Option<u64>,
        revision: u64,
    ) -> Result<Intent, String> {
        if saved_revision != Some(revision) {
            return Err(ERROR.into());
        }
        let (_, intent) = self
            .pending
            .as_ref()
            .filter(|(request, _)| request.token == token)
            .ok_or(ERROR)?;
        let intent = *intent;
        self.pending = None;
        self.completing = true;
        Ok(intent)
    }

    fn cancel(&mut self, token: &str) {
        if self
            .pending
            .as_ref()
            .is_some_and(|(request, _)| request.token == token)
        {
            self.pending = None;
        }
    }
}

pub(crate) fn close_requested(app: &tauri::AppHandle, api: &tauri::CloseRequestApi) {
    let request = app
        .state::<SharedClose>()
        .lock()
        .ok()
        .and_then(|mut state| state.request(Intent::Close));
    if let Some(request) = request {
        api.prevent_close();
        // Never hold the state or maintenance mutex across UI dispatch.
        let _ = app.emit_to("main", "settings-close-request", request);
    }
}

pub(crate) fn exit_requested(
    app: &tauri::AppHandle,
    code: Option<i32>,
    api: &tauri::ExitRequestApi,
) {
    if app.get_webview("main").is_none() {
        return;
    }
    let request = app
        .state::<SharedClose>()
        .lock()
        .ok()
        .and_then(|mut state| state.request_exit(code));
    if let Some(request) = request {
        api.prevent_exit();
        let _ = app.emit_to("main", "settings-close-request", request);
    }
}

#[tauri::command]
pub(crate) fn settings_close_ready(
    app: tauri::AppHandle,
    window: Webview,
) -> Result<Option<Request>, String> {
    crate::require_view(&window, "main")?;
    let shared = app.state::<SharedClose>();
    let mut state = shared.lock().map_err(|_| ERROR)?;
    state.ready = true;
    Ok(state.pending.as_ref().map(|(request, _)| request.clone()))
}

#[tauri::command]
pub(crate) fn settings_close_cancel(
    app: tauri::AppHandle,
    window: Webview,
    token: String,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    app.state::<SharedClose>()
        .lock()
        .map_err(|_| ERROR)?
        .cancel(&token);
    Ok(())
}

#[tauri::command]
pub(crate) async fn settings_close_complete(
    app: tauri::AppHandle,
    window: Webview,
    token: String,
    revision: u64,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    let intent = {
        // Only the existing validated, private settings writer can prove this
        // revision. Its update/install admission fence still applies to shutdown.
        let gate = crate::maintenance::admit(&app)?;
        app.state::<SharedClose>()
            .lock()
            .map_err(|_| ERROR)?
            .complete(&token, gate.form_revision, revision)?
    };
    match intent {
        Intent::Close => {
            if window.window().destroy().is_err() {
                app.state::<SharedClose>()
                    .lock()
                    .map_err(|_| ERROR)?
                    .completing = false;
                return Err(ERROR.into());
            }
        }
        Intent::Quit(code) => app.exit(code),
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn startup_without_a_controller_can_close_but_registered_restore_must_acknowledge() {
        let mut state = CloseState::default();
        assert!(state.request(Intent::Close).is_none());
        assert!(state.request(Intent::Quit(0)).is_none());
        state.ready = true;
        let request = state.request(Intent::Close).unwrap();
        assert!(state.complete("unknown", Some(1), 1).is_err());
        assert_eq!(
            state.complete(&request.token, Some(1), 1).unwrap(),
            Intent::Close
        );
    }

    #[test]
    fn duplicate_requests_keep_one_token_and_quit_promotes_close() {
        let mut state = CloseState {
            ready: true,
            ..Default::default()
        };
        let request = state.request(Intent::Close).unwrap();
        assert_eq!(state.request(Intent::Close).unwrap().token, request.token);
        assert_eq!(state.request(Intent::Quit(7)).unwrap().token, request.token);
        assert_eq!(state.request(Intent::Close).unwrap().token, request.token);
        assert_eq!(
            state.complete(&request.token, Some(1), 1).unwrap(),
            Intent::Quit(7)
        );
        assert!(state.request(Intent::Quit(7)).is_none());
        assert!(state.complete(&request.token, Some(1), 1).is_err());
    }

    #[test]
    fn failed_save_cancels_only_its_token_and_allows_a_new_attempt() {
        let mut state = CloseState {
            ready: true,
            ..Default::default()
        };
        let request = state.request(Intent::Close).unwrap();
        state.cancel("unknown");
        assert_eq!(state.request(Intent::Close).unwrap().token, request.token);
        state.cancel(&request.token);
        let retry = state.request(Intent::Quit(0)).unwrap();
        assert_ne!(retry.token, request.token);
        assert!(state.complete(&request.token, Some(1), 1).is_err());
        assert_eq!(
            state.complete(&retry.token, Some(1), 1).unwrap(),
            Intent::Quit(0)
        );
    }

    #[test]
    fn only_the_saved_revision_can_acknowledge_shutdown() {
        let mut state = CloseState {
            ready: true,
            ..Default::default()
        };
        let request = state.request_exit(None).unwrap();
        assert!(state.complete(&request.token, None, 1).is_err());
        assert!(state.complete(&request.token, Some(1), 2).is_err());
        assert_eq!(state.request_exit(None).unwrap().token, request.token);
        assert_eq!(
            state.complete(&request.token, Some(2), 2).unwrap(),
            Intent::Quit(0)
        );
    }

    #[test]
    fn updater_restart_bypasses_the_save_handshake_even_with_a_pending_close() {
        let mut state = CloseState {
            ready: true,
            ..Default::default()
        };
        assert!(state.request_exit(Some(tauri::RESTART_EXIT_CODE)).is_none());
        assert!(state.pending.is_none());
        let request = state.request(Intent::Close).unwrap();
        assert!(state.request_exit(Some(tauri::RESTART_EXIT_CODE)).is_none());
        assert_eq!(
            state.complete(&request.token, Some(1), 1).unwrap(),
            Intent::Close
        );
    }
}

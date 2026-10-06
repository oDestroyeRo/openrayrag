pub(crate) use crate::settings_close_logic::Request;
use crate::settings_close_logic::{exit_intent, Completion, Intent, Lifecycle, RequestPlan};
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

pub(crate) type SharedClose = Mutex<Lifecycle>;

fn generate_token() -> String {
    uuid::Uuid::new_v4().to_string()
}

fn request(
    state: &mut Lifecycle,
    intent: Intent,
    generate: impl FnOnce() -> String,
) -> Option<Request> {
    let (request, intent) = match state.request_plan(intent) {
        RequestPlan::Allow => return None,
        RequestPlan::GenerateToken(intent) => (Request { token: generate() }, intent),
        RequestPlan::Reuse { request, intent } => (request, intent),
    };
    *state = Lifecycle::pending(request.clone(), intent);
    Some(request)
}

fn request_exit(
    state: &mut Lifecycle,
    code: Option<i32>,
    generate: impl FnOnce() -> String,
) -> Option<Request> {
    request(
        state,
        exit_intent(code, tauri::RESTART_EXIT_CODE)?,
        generate,
    )
}

pub(crate) fn close_requested(app: &tauri::AppHandle, api: &tauri::CloseRequestApi) {
    let request = app
        .state::<SharedClose>()
        .lock()
        .ok()
        .and_then(|mut state| request(&mut state, Intent::Close, generate_token));
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
        .and_then(|mut state| request_exit(&mut state, code, generate_token));
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
    *state = state.register();
    Ok(state.pending_request())
}

#[tauri::command]
pub(crate) fn settings_close_cancel(
    app: tauri::AppHandle,
    window: Webview,
    token: String,
) -> Result<(), String> {
    crate::require_view(&window, "main")?;
    let shared = app.state::<SharedClose>();
    let mut state = shared.lock().map_err(|_| ERROR)?;
    *state = state.cancel(&token);
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
        let shared = app.state::<SharedClose>();
        let mut state = shared.lock().map_err(|_| ERROR)?;
        let (next, intent) = state
            .complete(Completion {
                token: &token,
                saved_revision: gate.form_revision,
                revision,
            })
            .map_err(|_| ERROR)?;
        *state = next;
        intent
    };
    crate::ci_smoke::milestone("close-save-confirmed");
    match intent {
        Intent::Close => {
            if window.window().destroy().is_err() {
                let shared = app.state::<SharedClose>();
                let mut state = shared.lock().map_err(|_| ERROR)?;
                *state = state.completion_failed();
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
    use std::cell::Cell;

    #[test]
    fn token_effect_runs_only_when_a_registered_controller_starts_a_fresh_handshake() {
        let calls = Cell::new(0);
        let generate = || {
            calls.set(calls.get() + 1);
            format!("token-{}", calls.get())
        };
        let mut state = Lifecycle::Unregistered;
        assert!(request(&mut state, Intent::Close, generate).is_none());
        assert!(request_exit(&mut state, None, generate).is_none());
        assert_eq!(calls.get(), 0);

        state = state.register();
        let first = request(&mut state, Intent::Close, generate).unwrap();
        assert_eq!(calls.get(), 1);
        assert_eq!(request(&mut state, Intent::Close, generate).unwrap(), first);
        assert_eq!(request_exit(&mut state, Some(7), generate).unwrap(), first);
        let (next, intent) = state
            .complete(Completion {
                token: &first.token,
                saved_revision: Some(1),
                revision: 1,
            })
            .unwrap();
        assert_eq!(intent, Intent::Quit(7));
        state = next;
        assert!(request(&mut state, Intent::Close, generate).is_none());
        assert!(request_exit(&mut state, None, generate).is_none());
        assert_eq!(calls.get(), 1);

        state = state.completion_failed();
        let retry = request(&mut state, Intent::Close, generate).unwrap();
        assert_eq!(calls.get(), 2);
        assert_ne!(retry, first);
        state = state.cancel(&retry.token);
        assert!(request_exit(&mut state, None, generate).is_some());
        assert_eq!(calls.get(), 3);
    }

    #[test]
    fn updater_restart_preserves_ready_and_pending_states_without_generating_a_token() {
        let mut state = Lifecycle::Ready;
        assert!(
            request_exit(&mut state, Some(tauri::RESTART_EXIT_CODE), || panic!(
                "restart must not generate a token"
            ))
            .is_none()
        );
        assert_eq!(state, Lifecycle::Ready);
        let request = request(&mut state, Intent::Close, || "owned".into()).unwrap();
        let before = state.clone();
        assert!(
            request_exit(&mut state, Some(tauri::RESTART_EXIT_CODE), || panic!(
                "restart must reuse no token"
            ))
            .is_none()
        );
        assert_eq!(state, before);
        assert_eq!(
            state
                .complete(Completion {
                    token: &request.token,
                    saved_revision: Some(1),
                    revision: 1
                })
                .unwrap()
                .1,
            Intent::Close
        );
    }
}

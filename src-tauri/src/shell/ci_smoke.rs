//! Packaged, offline CI proof. Production builds do not contain the test driver.

pub(crate) fn active() -> bool {
    cfg!(feature = "ci-smoke") && std::env::args().any(|arg| arg.starts_with("--ci-smoke-test="))
}

pub(crate) fn data_dir() -> Option<std::path::PathBuf> {
    #[cfg(feature = "ci-smoke")]
    if let Some(run) = enabled::RUN.get() {
        return Some(run.data.clone());
    }
    None
}

pub(crate) fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    #[cfg(feature = "ci-smoke")]
    return enabled::install(app);
    #[cfg(not(feature = "ci-smoke"))]
    {
        let _ = app;
        Ok(())
    }
}

pub(crate) fn page_loaded(app: &tauri::AppHandle, label: &str) {
    #[cfg(feature = "ci-smoke")]
    enabled::page_loaded(app, label);
    #[cfg(not(feature = "ci-smoke"))]
    let _ = (app, label);
}

pub(crate) fn milestone(stage: &'static str) {
    #[cfg(feature = "ci-smoke")]
    enabled::milestone(stage);
    #[cfg(not(feature = "ci-smoke"))]
    let _ = stage;
}

pub(crate) fn destroyed(app: &tauri::AppHandle, label: &str) {
    #[cfg(feature = "ci-smoke")]
    enabled::destroyed(app, label);
    #[cfg(not(feature = "ci-smoke"))]
    let _ = (app, label);
}

#[cfg(feature = "ci-smoke")]
#[tauri::command]
pub(crate) fn ci_smoke_report(
    app: tauri::AppHandle,
    window: tauri::Webview,
    token: String,
    event: String,
) -> Result<bool, String> {
    enabled::report(app, window, token, event)
}

#[cfg(feature = "ci-smoke")]
mod enabled {
    use serde_json::{json, Value};
    use std::{
        fs::OpenOptions,
        io::Write,
        path::{Path, PathBuf},
        sync::{
            atomic::{AtomicBool, Ordering},
            Mutex, OnceLock,
        },
        time::Duration,
    };
    use tauri::Manager;

    pub(super) static RUN: OnceLock<Run> = OnceLock::new();
    const IDENTIFIER: &str = "com.rayrag.companion.ci";
    const WATCHDOG_SECONDS: u64 = 35;

    pub(super) struct Run {
        pub(super) data: PathBuf,
        result: PathBuf,
        token: String,
        stage: Stage,
        baseline: Mutex<Option<Value>>,
        milestone: Mutex<&'static str>,
        finished: AtomicBool,
    }

    #[derive(Clone, Copy, PartialEq, Debug)]
    enum Stage {
        Save,
        Reopen,
    }
    impl Stage {
        fn parse(value: &str) -> Result<Self, &'static str> {
            match value {
                "save" => Ok(Self::Save),
                "reopen" => Ok(Self::Reopen),
                _ => Err("Unknown CI smoke stage"),
            }
        }
        fn name(self) -> &'static str {
            match self {
                Self::Save => "save",
                Self::Reopen => "reopen",
            }
        }
    }

    fn isolated_path(root: &Path, path: &Path, directory: bool) -> Result<PathBuf, String> {
        if !path.is_absolute() {
            return Err("CI smoke paths must be absolute".into());
        }
        if directory {
            let canonical = path.canonicalize().map_err(|_| "CI data unavailable")?;
            if canonical.parent() != Some(root) || !canonical.is_dir() {
                return Err("CI data must be a direct child of its temporary root".into());
            }
            Ok(canonical)
        } else {
            if path.parent().and_then(|p| p.canonicalize().ok()).as_deref() != Some(root)
                || path.file_name().is_none()
                || path.exists()
            {
                return Err("CI result must be a new file inside its temporary root".into());
            }
            Ok(path.to_path_buf())
        }
    }

    fn request(identifier: &str) -> Result<Option<Run>, String> {
        if !super::active() {
            return Ok(None);
        }
        if identifier != IDENTIFIER {
            return Err("CI smoke requires its isolated application identifier".into());
        }
        let args: Vec<_> = std::env::args()
            .filter_map(|arg| arg.strip_prefix("--ci-smoke-test=").map(str::to_owned))
            .collect();
        if args.len() != 1 {
            return Err("Exactly one CI smoke stage is required".into());
        }
        let stage = Stage::parse(&args[0])?;
        let token = std::env::var("RAYRAG_CI_TOKEN").map_err(|_| "CI token unavailable")?;
        if uuid::Uuid::parse_str(&token).is_err() {
            return Err("Invalid CI smoke token".into());
        }
        let root = PathBuf::from(std::env::var_os("RAYRAG_CI_ROOT").ok_or("CI root unavailable")?)
            .canonicalize()
            .map_err(|_| "CI root unavailable")?;
        let temporary = std::env::temp_dir()
            .canonicalize()
            .map_err(|_| "Temporary directory unavailable")?;
        if !root.starts_with(&temporary) || root == temporary || !root.is_dir() {
            return Err("CI smoke data must be inside a unique temporary directory".into());
        }
        let data = isolated_path(
            &root,
            &PathBuf::from(std::env::var_os("RAYRAG_CI_DATA_DIR").ok_or("CI data unavailable")?),
            true,
        )?;
        let result = isolated_path(
            &root,
            &PathBuf::from(std::env::var_os("RAYRAG_CI_RESULT").ok_or("CI result unavailable")?),
            false,
        )?;
        Ok(Some(Run {
            data,
            result,
            token,
            stage,
            baseline: Mutex::new(None),
            milestone: Mutex::new("smoke-installed"),
            finished: AtomicBool::new(false),
        }))
    }

    pub(super) fn install(app: &tauri::AppHandle) -> Result<(), Box<dyn std::error::Error>> {
        let Some(run) = request(&app.config().identifier)? else {
            return Ok(());
        };
        RUN.set(run).map_err(|_| "CI smoke already initialized")?;
        // Fail closed even if the WebView never starts or IPC stops responding.
        std::thread::spawn(|| {
            std::thread::sleep(Duration::from_secs(WATCHDOG_SECONDS));
            let run = RUN.get().expect("CI watchdog was installed with a run");
            if !run.finished.load(Ordering::SeqCst) {
                finish(run, Err("Packaged WebView smoke timed out".into()));
                std::process::exit(1);
            }
        });
        Ok(())
    }

    pub(super) fn milestone(stage: &'static str) {
        if let Some(run) = RUN.get() {
            if let Ok(mut current) = run.milestone.lock() {
                *current = stage;
            }
        }
    }

    fn offline(app: &tauri::AppHandle) -> Result<(), String> {
        let gate = app.state::<crate::session::maintenance::SharedGate>();
        let gate = gate
            .lock()
            .map_err(|_| "CI maintenance state unavailable")?;
        if app.get_webview("game").is_some() || gate.ever_game || gate.identity.is_some() {
            return Err("CI smoke must remain offline without a game window".into());
        }
        Ok(())
    }

    fn loaded(run: &Run) -> Result<Value, String> {
        let data = super::data_dir().ok_or("CI settings directory is not initialized")?;
        if data != run.data {
            return Err("CI settings directory changed during the run".into());
        }
        let document =
            crate::settings::current_form::load(data)?.ok_or("Packaged settings were not saved")?;
        serde_json::to_value(document).map_err(|_| "CI settings could not be read".into())
    }

    fn edited(document: &Value) -> bool {
        document.pointer("/settings/radius") == Some(&json!(17))
            && document.pointer("/settings/loot") == Some(&json!(false))
            && document.pointer("/settings/route_step") == Some(&json!(7))
    }

    fn verify_saved(baseline: &Value, document: &Value) -> Result<(), String> {
        if !edited(document)
            || document.get("revision").and_then(Value::as_u64)
                <= baseline.get("revision").and_then(Value::as_u64)
        {
            return Err("Close did not save the newest settings edit".into());
        }
        let mut expected = baseline.clone();
        expected["settings"]["radius"] = json!(17);
        expected["settings"]["loot"] = json!(false);
        expected["settings"]["route_step"] = json!(7);
        expected["revision"] = document["revision"].clone();
        if expected != *document {
            return Err("Close changed settings outside the requested form edits".into());
        }
        Ok(())
    }

    fn finish(run: &Run, outcome: Result<Value, String>) {
        if run.finished.swap(true, Ordering::SeqCst) {
            return;
        }
        let mut checks = vec![
            "webview-boot",
            "offline-controller",
            "native-settings-ipc",
            "window-close-save",
        ];
        if run.stage == Stage::Reopen {
            checks.push("settings-restore");
        }
        let result = match outcome {
            Ok(document) => json!({
                "protocol": 1, "stage": run.stage.name(), "token": run.token,
                "passed": true, "checks": checks,
                "document": document,
            }),
            Err(message) => json!({
                "protocol": 1, "stage": run.stage.name(), "token": run.token,
                "passed": false, "message": message,
                "milestone": run.milestone.try_lock().map(|stage| *stage).unwrap_or("unavailable"),
            }),
        };
        let written = (|| -> std::io::Result<()> {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&run.result)?;
            file.write_all(&serde_json::to_vec_pretty(&result)?)?;
            file.sync_all()
        })();
        if written.is_err() {
            eprintln!("CI smoke result could not be saved");
            std::process::exit(1);
        }
    }

    pub(super) fn report(
        app: tauri::AppHandle,
        window: tauri::Webview,
        token: String,
        event: String,
    ) -> Result<bool, String> {
        crate::require_view(&window, "main")?;
        let run = RUN.get().ok_or("CI smoke is not active")?;
        if token != run.token || app.config().identifier != IDENTIFIER {
            return Err("CI smoke request is not authorized".into());
        }
        if event == "ready" {
            milestone("controller-ready-ipc");
        }
        offline(&app)?;
        match event.as_str() {
            "ready" => {
                let gate = app.state::<crate::session::maintenance::SharedGate>();
                let gate = gate
                    .lock()
                    .map_err(|_| "CI maintenance state unavailable")?;
                let ready = gate.initialized && gate.form_revision.is_some();
                if ready {
                    milestone("controller-ready");
                }
                Ok(ready)
            }
            "arm" => {
                let document = loaded(run)?;
                if run.stage == Stage::Reopen && !edited(&document) {
                    return Err("Reopened native settings do not match the first launch".into());
                }
                let mut baseline = run.baseline.lock().map_err(|_| "CI baseline unavailable")?;
                if baseline.is_some() {
                    return Err("CI close check was already armed".into());
                }
                *baseline = Some(document);
                milestone("controller-armed");
                Ok(true)
            }
            "fail" => {
                finish(run, Err("Packaged controller assertion failed".into()));
                std::process::exit(1);
            }
            _ => Err("Unknown CI smoke report".into()),
        }
    }

    pub(super) fn page_loaded(app: &tauri::AppHandle, label: &str) {
        let Some(run) = RUN.get() else { return };
        milestone("page-loaded");
        if label != "main" {
            finish(run, Err("Unexpected window opened during CI smoke".into()));
            std::process::exit(1);
        }
        let configuration = json!({"token": run.token, "stage": run.stage.name()});
        let script = format!(
            r#"(async () => {{
                const config = {configuration};
                const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
                const report = event => invoke('ci_smoke_report', {{token: config.token, event}});
                const node = id => {{ const value = document.getElementById(id); if (!value) throw new Error('Missing controller element'); return value; }};
                const assert = value => {{ if (!value) throw new Error('Controller smoke assertion failed'); }};
                try {{
                    const deadline = Date.now() + 25_000;
                    while (!(await report('ready'))) {{
                        if (Date.now() > deadline) throw new Error('Controller did not initialize');
                        await new Promise(resolve => setTimeout(resolve, 100));
                    }}
                    assert(!node('app').inert && node('status').textContent.trim() === 'OFFLINE');
                    assert(node('start').disabled && node('stop').disabled);
                    assert(!node('username').value && !node('password').value);
                    const before = await invoke('current_form');
                    assert(before && before.version === 1 && before.selectedProfileId === null);
                    assert(Number(node('radius').value) === before.settings.radius);
                    assert(node('loot').checked === before.settings.loot);
                    assert(Number(node('route-step').value) === before.settings.route_step);
                    if (config.stage === 'reopen') {{
                        assert(before.settings.radius === 17 && before.settings.loot === false && before.settings.route_step === 7);
                    }}
                    await report('arm');
                    if (config.stage === 'save') {{
                        node('radius').value = '17';
                        node('loot').checked = false;
                        node('route-step').value = '7';
                        for (const id of ['radius', 'loot', 'route-step']) node(id).dispatchEvent(new Event('input', {{bubbles: true}}));
                    }}
                    // Send the actual close request in the same task as the edits,
                    // before the controller's 300 ms autosave timer can run.
                    await invoke('plugin:window|close', {{label: 'main'}});
                }} catch {{ await report('fail'); }}
            }})();"#
        );
        if app
            .get_webview("main")
            .map_or(true, |window| window.eval(script).is_err())
        {
            finish(
                run,
                Err("Could not inject the packaged WebView check".into()),
            );
            std::process::exit(1);
        }
    }

    pub(super) fn destroyed(app: &tauri::AppHandle, label: &str) {
        let Some(run) = RUN.get() else { return };
        if label != "main" {
            return;
        }
        milestone("window-destroyed");
        let outcome = (|| {
            offline(app)?;
            let baseline = run.baseline.lock().map_err(|_| "CI baseline unavailable")?;
            let baseline = baseline
                .as_ref()
                .ok_or("Window closed before controller assertions")?;
            let document = loaded(run)?;
            match run.stage {
                Stage::Save => verify_saved(baseline, &document)?,
                Stage::Reopen if baseline != &document => {
                    return Err("Reopening changed settings".into())
                }
                Stage::Reopen => (),
            }
            Ok(document)
        })();
        let passed = outcome.is_ok();
        finish(run, outcome);
        if !passed {
            std::process::exit(1);
        }
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn closing_requires_the_newest_edit_and_preserves_other_settings() {
            let baseline = json!({"revision": 2, "selectedProfileId": null, "settings": {"radius": 12, "loot": true, "route_step": 10, "map": "", "targets": []}});
            let mut saved = baseline.clone();
            saved["settings"]["radius"] = json!(17);
            saved["settings"]["loot"] = json!(false);
            saved["settings"]["route_step"] = json!(7);
            assert!(verify_saved(&baseline, &saved).is_err());
            saved["revision"] = json!(3);
            assert!(verify_saved(&baseline, &saved).is_ok());
            saved["settings"]["map"] = json!("unexpected");
            assert!(verify_saved(&baseline, &saved).is_err());
        }

        #[test]
        fn test_paths_cannot_escape_the_isolated_root() {
            let temporary = tempfile::tempdir().unwrap();
            let root = temporary.path().canonicalize().unwrap();
            std::fs::create_dir(root.join("data")).unwrap();
            assert!(isolated_path(&root, &root.join("data"), true).is_ok());
            assert!(isolated_path(&root, &root, true).is_err());
            assert!(isolated_path(&root, Path::new("relative"), false).is_err());
            assert!(isolated_path(&root, &root.join("result.json"), false).is_ok());
            std::fs::write(root.join("result.json"), b"existing").unwrap();
            assert!(isolated_path(&root, &root.join("result.json"), false).is_err());
            assert!(Stage::parse("production").is_err());
        }
    }
}

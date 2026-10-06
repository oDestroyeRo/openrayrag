//! Launch failure stays recoverable until the successor has been accepted.
pub(crate) const ERROR: &str = "The update was installed, but the app could not restart. Quit and reopen Rayrag Companion. Your saved settings are preserved.";

#[cfg(any(target_os = "macos", test))]
trait RestartEffects {
    type Error;
    fn launch(&mut self) -> Result<(), Self::Error>;
    fn retire(&mut self);
}

#[cfg(any(target_os = "macos", test))]
fn restart_program<E: RestartEffects>(effects: &mut E) -> Result<(), E::Error> {
    // Keep the incumbent window and native resources until launch succeeds.
    // Tauri's process::restart exits even if its executable spawn fails.
    effects.launch()?;
    effects.retire();
    Ok(())
}

#[cfg(target_os = "macos")]
struct NativeRestart<'a> {
    app: &'a tauri::AppHandle,
    arguments: Vec<std::ffi::OsString>,
}

#[cfg(target_os = "macos")]
impl RestartEffects for NativeRestart<'_> {
    type Error = String;
    fn launch(&mut self) -> Result<(), String> {
        // Use LaunchServices, rather than directly spawning the Mach-O binary,
        // so macOS registers and activates the new application instance.
        let status = std::process::Command::new("/usr/bin/open")
            .args(&self.arguments)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map_err(|_| ERROR.to_string())?;
        if status.success() {
            Ok(())
        } else {
            Err(ERROR.into())
        }
    }
    fn retire(&mut self) {
        self.app.cleanup_before_exit();
        std::process::exit(0);
    }
}

pub(crate) fn restart(app: &tauri::AppHandle, env: &tauri::Env) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        let binary = tauri::process::current_binary(env).map_err(|_| ERROR)?;
        let arguments = crate::update::update_restart_logic::macos_arguments(&binary, &env.args_os)
            .ok_or(ERROR)?;
        restart_program(&mut NativeRestart { app, arguments }).map_err(|_| ERROR.into())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = (app, env);
        Err(ERROR.into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Recorder {
        calls: Vec<&'static str>,
        launch: Result<(), &'static str>,
    }
    impl RestartEffects for Recorder {
        type Error = &'static str;
        fn launch(&mut self) -> Result<(), Self::Error> {
            self.calls.push("launch");
            self.launch
        }
        fn retire(&mut self) {
            self.calls.push("retire");
        }
    }
    #[test]
    fn accepted_launch_retires_the_original_process_once() {
        let mut effects = Recorder {
            calls: vec![],
            launch: Ok(()),
        };
        assert!(restart_program(&mut effects).is_ok());
        assert_eq!(effects.calls, ["launch", "retire"]);
    }
    #[test]
    fn launch_failure_keeps_the_original_process_and_window_available() {
        let mut effects = Recorder {
            calls: vec![],
            launch: Err("launch failed"),
        };
        assert!(restart_program(&mut effects).is_err());
        assert_eq!(effects.calls, ["launch"]);
    }
}

fn main() {
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&[
            "open_game",
            "control_bot",
            "bridge_status",
            "login_game",
            "saved_login",
            "forget_login",
            "cancel_pending_login",
            "take_pending_login",
        ]),
    ))
    .expect("Tauri build configuration must be valid");
}

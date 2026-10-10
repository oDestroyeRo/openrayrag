//! Exact local runtime location for Tauri's asset mode and platform origin.
pub(crate) enum RuntimeAssets {
    Development,
    Bundled { windows: bool },
}

pub(crate) fn bot_runtime_url(assets: RuntimeAssets) -> &'static str {
    match assets {
        RuntimeAssets::Development => "http://127.0.0.1:1420/bot-runtime.html",
        RuntimeAssets::Bundled { windows: true } => "http://tauri.localhost/bot-runtime.html",
        RuntimeAssets::Bundled { windows: false } => "tauri://localhost/bot-runtime.html",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn development_uses_the_configured_server() {
        assert_eq!(
            bot_runtime_url(RuntimeAssets::Development),
            "http://127.0.0.1:1420/bot-runtime.html"
        );
    }

    #[test]
    fn bundled_windows_uses_the_default_http_custom_protocol_origin() {
        assert_eq!(
            bot_runtime_url(RuntimeAssets::Bundled { windows: true }),
            "http://tauri.localhost/bot-runtime.html"
        );
    }

    #[test]
    fn bundled_macos_and_linux_use_the_tauri_custom_protocol_origin() {
        assert_eq!(
            bot_runtime_url(RuntimeAssets::Bundled { windows: false }),
            "tauri://localhost/bot-runtime.html"
        );
    }
}

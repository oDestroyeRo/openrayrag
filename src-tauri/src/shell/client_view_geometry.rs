//! Public platform measurements for the companion's CSS content origin.

#[cfg(target_os = "macos")]
pub(super) fn top_content_inset(platform: &tauri::webview::PlatformWebview) -> Result<f64, String> {
    use super::client_view_logic::{
        automatic_inset_enabled, automatic_top_inset, AutomaticInsetContext,
    };
    use objc2_app_kit::{NSView, NSWindowStyleMask};

    // SAFETY: Tauri provides a live WKWebView (an NSView subclass), and calls
    // with_webview on the main thread. The reference stays inside that callback.
    let view = unsafe { &*platform.inner().cast::<NSView>() };
    let window = view
        .window()
        .ok_or("Game view content origin unavailable.")?;
    let mut context = AutomaticInsetContext {
        full_size_content: window
            .styleMask()
            .contains(NSWindowStyleMask::FullSizeContentView),
        transparent_titlebar: window.titlebarAppearsTransparent(),
        enclosing_scroll_view: view.enclosingScrollView().is_some(),
        content_layout_top: 0.0,
    };
    if automatic_inset_enabled(context) {
        // WKWebView enables automatic insets at initialization. Mirror its
        // public AppKit calculation instead of assuming a titlebar height:
        // https://github.com/WebKit/WebKit/blob/main/Source/WebKit/UIProcess/mac/PageClientImplMac.mm
        window.updateConstraintsIfNeeded();
        context.content_layout_top = view
            .convertRect_fromView(window.contentLayoutRect(), None)
            .origin
            .y;
    }
    automatic_top_inset(context)
}

#[cfg(not(target_os = "macos"))]
pub(super) fn top_content_inset(
    _platform: &tauri::webview::PlatformWebview,
) -> Result<f64, String> {
    Ok(0.0)
}

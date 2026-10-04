use crate::{
    current_form::{self, FormDocument},
    maintenance::{GameIdentity, SharedGate},
    update_install,
};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewWindow};
const FEED: &str =
    "https://github.com/oDestroyeRo/openrayrag/releases/latest/download/latest-semver.json";
const LEGACY_FEED: &str =
    "https://github.com/oDestroyeRo/openrayrag/releases/latest/download/latest.json";
const MAX_METADATA: usize = 64_000;
const AUTOMATIC_SUPPORTED: bool = cfg!(all(target_os = "macos", target_arch = "aarch64"));
const MANUAL_UPDATE: &str = "Download the latest release to update this platform. Automatic installation is available on Apple Silicon macOS.";
const RELEASE: &str = "https://github.com/oDestroyeRo/openrayrag/releases/latest";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub version: String,
    pub platform: &'static str,
    pub phase: String,
    pub available_version: Option<String>,
    pub message: String,
    pub bytes: u64,
    pub release_url: &'static str,
}
#[derive(Clone)]
struct Candidate {
    version: String,
    bytes: Arc<Vec<u8>>,
}
pub(crate) struct UpdateState {
    status: Status,
    candidate: Option<Candidate>,
    busy: bool,
    next: Instant,
    failures: u8,
}
pub(crate) type SharedUpdate = Mutex<UpdateState>;
impl UpdateState {
    pub(crate) fn wait_for_official(&mut self, waiting: bool) {
        if self.status.phase == "waiting" {
            self.status.message=if waiting { "Update waits for a new fully initialized connection after an official gameplay action. Nothing will be replayed." } else { "Update is downloaded. Waiting for all game and login actions to stop." }.into();
        }
    }
}
impl Default for UpdateState {
    fn default() -> Self {
        Self {
            status: Status {
                version: env!("CARGO_PKG_VERSION").into(),
                platform: std::env::consts::OS,
                phase: if AUTOMATIC_SUPPORTED {
                    "checking"
                } else {
                    "manual"
                }
                .into(),
                available_version: None,
                message: if AUTOMATIC_SUPPORTED {
                    "Checking for signed client updates."
                } else {
                    MANUAL_UPDATE
                }
                .into(),
                bytes: 0,
                release_url: RELEASE,
            },
            candidate: None,
            busy: false,
            next: Instant::now(),
            failures: 0,
        }
    }
}
#[derive(Deserialize)]
struct Feed {
    version: String,
    platforms: BTreeMap<String, Platform>,
}
#[derive(Deserialize)]
struct Platform {
    url: String,
    signature: String,
}
fn version(v: &str) -> Option<semver::Version> {
    let n = semver::Version::parse(v).ok()?;
    if !n.pre.is_empty() || !n.build.is_empty() || n.to_string() != v {
        return None;
    }
    Some(n)
}
fn parse_feed(bytes: &[u8], current: &str) -> Result<Option<(String, Platform)>, String> {
    if bytes.len() > MAX_METADATA {
        return Err("Update metadata is too large.".into());
    }
    let f: Feed = serde_json::from_slice(bytes).map_err(|_| "Update metadata is invalid.")?;
    let v = version(&f.version).ok_or("Update version is unsupported.")?;
    let c = semver::Version::parse(current).map_err(|_| "Installed version is unavailable.")?;
    if v <= c {
        return Ok(None);
    }
    let p = f
        .platforms
        .into_iter()
        .find(|(k, _)| k == "darwin-aarch64")
        .map(|(_, v)| v)
        .ok_or("No Apple Silicon update is available.")?;
    let expected=format!("https://github.com/oDestroyeRo/openrayrag/releases/download/v{}/Rayrag_Companion_{}_aarch64.app.tar.gz",f.version,f.version);
    if p.url != expected || p.signature.len() > 4096 {
        return Err("Update download metadata is invalid.".into());
    }
    Ok(Some((f.version, p)))
}
#[derive(Debug)]
enum DownloadError {
    Request,
    Status(reqwest::StatusCode),
    Interrupted,
    SizeLimit,
}
impl DownloadError {
    fn message(&self) -> &'static str {
        match self {
            Self::Request | Self::Status(_) => "Update download failed.",
            Self::Interrupted => "Update download was interrupted.",
            Self::SizeLimit => "Update exceeds its size limit.",
        }
    }
}
impl From<DownloadError> for String {
    fn from(error: DownloadError) -> Self {
        error.message().into()
    }
}
async fn bounded(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    mut progress: impl FnMut(usize),
) -> Result<Vec<u8>, DownloadError> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| DownloadError::Request)?;
    let status = response.status();
    if !status.is_success() {
        return Err(DownloadError::Status(status));
    }
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err(DownloadError::SizeLimit);
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| DownloadError::Interrupted)?
    {
        if bytes
            .len()
            .checked_add(chunk.len())
            .map_or(true, |n| n > limit)
        {
            return Err(DownloadError::SizeLimit);
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len());
    }
    Ok(bytes)
}
async fn find_update(
    client: &reqwest::Client,
    primary: &str,
    legacy: &str,
    current: &str,
) -> Result<Option<(String, Platform)>, String> {
    let metadata = match bounded(client, primary, MAX_METADATA, |_| {}).await {
        Ok(metadata) => metadata,
        // A missing feed permits the legacy bridge. Any other failure must
        // remain visible rather than silently select an older update feed.
        Err(DownloadError::Status(reqwest::StatusCode::NOT_FOUND)) => {
            bounded(client, legacy, MAX_METADATA, |_| {}).await?
        }
        Err(error) => return Err(error.into()),
    };
    parse_feed(&metadata, current)
}
fn key() -> String {
    serde_json::from_str::<serde_json::Value>(include_str!("../tauri.conf.json"))
        .ok()
        .and_then(|v| {
            v["plugins"]["updater"]["pubkey"]
                .as_str()
                .map(str::to_owned)
        })
        .unwrap_or_default()
}
fn download_client(https_only: bool) -> Result<reqwest::Client, String> {
    // The custom bounded transport does not construct plugin::Update, whose
    // builder normally installs this provider. Install it explicitly here.
    let _ = rustls::crypto::ring::default_provider().install_default();
    reqwest::Client::builder()
        .https_only(https_only)
        .timeout(Duration::from_secs(300))
        .connect_timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::limited(5))
        .build()
        .map_err(|_| "Update networking is unavailable.".into())
}
async fn check(app: tauri::AppHandle) {
    if !AUTOMATIC_SUPPORTED {
        return;
    }
    let result = async {
        let client = download_client(true)?;
        let Some((v, p)) =
            find_update(&client, FEED, LEGACY_FEED, env!("CARGO_PKG_VERSION")).await?
        else {
            return Ok(None);
        };
        {
            let shared = app.state::<SharedUpdate>();
            let mut u = shared.lock().map_err(|_| "Update state unavailable.")?;
            u.status.phase = "downloading".into();
            u.status.available_version = Some(v.clone());
            u.status.message = "Downloading a signed client update in the background.".into();
        }
        let bytes = bounded(&client, &p.url, update_install::MAX_ARCHIVE, |n| {
            if let Ok(mut u) = app.state::<SharedUpdate>().lock() {
                u.status.bytes = n as u64;
            }
        })
        .await?;
        update_install::verify(&bytes, &p.signature, &key(), &v)?;
        Ok::<_, String>(Some(Candidate {
            version: v,
            bytes: Arc::new(bytes),
        }))
    }
    .await;
    if let Ok(mut u) = app.state::<SharedUpdate>().lock() {
        u.busy = false;
        match result {
            Ok(Some(c)) => {
                u.status.phase = "waiting".into();
                u.status.message =
                    "Update verified. Waiting for all game and login actions to stop.".into();
                u.candidate = Some(c);
                u.failures = 0;
                u.next = Instant::now() + Duration::from_secs(3600);
            }
            Ok(None) => {
                u.status.phase = "current".into();
                u.status.message = "Client is up to date.".into();
                u.failures = 0;
                u.next = Instant::now() + Duration::from_secs(3600);
            }
            Err(e) => {
                u.status.phase = "error".into();
                u.status.message = e;
                u.failures = (u.failures + 1).min(6);
                u.next = Instant::now()
                    + Duration::from_secs((60u64 * 2u64.pow(u.failures as u32)).min(3600));
            }
        }
    }
}
pub(crate) fn schedule(app: &tauri::AppHandle) {
    if crate::ci_smoke::active() {
        return;
    }
    if !AUTOMATIC_SUPPORTED {
        return;
    }
    let shared = app.state::<SharedUpdate>();
    let Ok(mut u) = shared.lock() else { return };
    if u.busy || u.candidate.is_some() || Instant::now() < u.next {
        return;
    }
    u.busy = true;
    u.status.phase = "checking".into();
    let app = app.clone();
    tauri::async_runtime::spawn(check(app));
}
#[tauri::command]
pub(crate) fn update_status(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Status, String> {
    crate::require_window(&window, "main")?;
    schedule(&app);
    let mut status = app
        .state::<SharedUpdate>()
        .lock()
        .map_err(|_| "Update state unavailable.")?
        .status
        .clone();
    if status.phase == "waiting" && app.state::<SharedGate>().page_held() {
        status.message="Update waits because a replaced game page may have unresolved actions. Quit and reopen Companion when safe, or use the release download.".into();
    }
    Ok(status)
}
#[tauri::command]
pub(crate) fn update_open_release(window: WebviewWindow) -> Result<(), String> {
    crate::require_window(&window, "main")?;
    // Explicit main-window click; fixed public URL only, no process capability
    // or caller-supplied arguments are exposed to either webview.
    open_release_page().map_err(|_| {
        "Could not open the release download. Visit the repository Releases page.".into()
    })
}
fn open_release_page() -> std::io::Result<()> {
    #[cfg(windows)]
    {
        use windows_sys::Win32::{
            UI::Shell::ShellExecuteW, UI::WindowsAndMessaging::SW_SHOWNORMAL,
        };
        let verb: Vec<u16> = "open".encode_utf16().chain([0]).collect();
        let url: Vec<u16> = RELEASE.encode_utf16().chain([0]).collect();
        // SAFETY: fixed URL/verb are live NUL-terminated buffers. No caller
        // supplies a program, URL, or arguments to this native command.
        let result = unsafe {
            ShellExecuteW(
                std::ptr::null_mut(),
                verb.as_ptr(),
                url.as_ptr(),
                std::ptr::null(),
                std::ptr::null(),
                SW_SHOWNORMAL,
            )
        } as isize;
        if result <= 32 {
            return Err(std::io::Error::other("Release browser unavailable"));
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new(if cfg!(target_os = "macos") {
            "/usr/bin/open"
        } else {
            "xdg-open"
        })
        .arg(RELEASE)
        .spawn()
        .map(|_| ())
    }
}
#[tauri::command]
pub(crate) fn current_form(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<FormDocument>, String> {
    crate::require_window(&window, "main")?;
    current_form::load(crate::app_data(&app).map_err(|_| "Settings storage unavailable.")?)
}
#[tauri::command]
pub(crate) fn save_current_form(
    app: tauri::AppHandle,
    window: WebviewWindow,
    document: FormDocument,
) -> Result<u64, String> {
    crate::require_window(&window, "main")?;
    let mut gate = crate::maintenance::admit(&app)?;
    current_form::save(
        crate::app_data(&app).map_err(|_| "Settings storage unavailable.")?,
        &document,
    )?;
    gate.form_revision = Some(document.revision);
    Ok(document.revision)
}
#[tauri::command]
pub(crate) fn update_initialized(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<(), String> {
    crate::require_window(&window, "main")?;
    let mut gate = crate::maintenance::admit(&app)?;
    gate.initialized = true;
    Ok(())
}
#[tauri::command]
pub(crate) fn update_reserve(
    app: tauri::AppHandle,
    window: WebviewWindow,
    document: FormDocument,
) -> Result<String, String> {
    crate::require_window(&window, "main")?;
    if !AUTOMATIC_SUPPORTED {
        return Err(MANUAL_UPDATE.into());
    }
    let shared = app.state::<SharedGate>();
    let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
    if app
        .state::<SharedUpdate>()
        .lock()
        .map_err(|_| "Update state unavailable.")?
        .candidate
        .is_none()
    {
        return Err("No verified update is ready.".into());
    }
    if app
        .state::<crate::login::SharedLogin>()
        .lock()
        .map_err(|_| "Login state unavailable.")?
        .maintenance_busy()
    {
        return Err("Waiting for login to settle.".into());
    }
    let loaded =
        current_form::load(crate::app_data(&app).map_err(|_| "Settings storage unavailable.")?)?
            .ok_or("Save current settings before updating.")?;
    if serde_json::to_vec(&loaded).ok() != serde_json::to_vec(&document).ok() {
        return Err("Current settings changed before update settlement.".into());
    }
    let game = app.get_webview_window("game");
    let nonce = uuid::Uuid::new_v4().simple().to_string();
    gate.reserve(nonce.clone(), document.revision, game.is_some())?;
    if let Some(game) = game {
        let script = format!(
            "window.__RAYRAG__?.maintenance({},true)",
            serde_json::to_string(&nonce).map_err(|_| "Invalid lease.")?
        );
        if game.eval(script).is_err() {
            gate.lease = None;
            return Err("Game update settlement is unavailable.".into());
        }
    }
    Ok(nonce)
}
#[tauri::command]
pub(crate) fn update_ack(
    app: tauri::AppHandle,
    window: WebviewWindow,
    nonce: String,
    identity: GameIdentity,
    revision: u64,
) -> Result<bool, String> {
    crate::require_game_runtime(&window)?;
    if nonce.len() != 32 {
        return Ok(false);
    }
    let shared = app.state::<SharedGate>();
    let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
    if crate::direct::window_mode(&window)? == crate::login::ConnectionMode::BotOnly
        && !app
            .state::<crate::direct::SharedDirect>()
            .settled_for(&identity)
    {
        return Ok(false);
    }
    Ok(gate.acknowledge(&nonce, identity, revision))
}
#[tauri::command]
pub(crate) fn update_release(
    app: tauri::AppHandle,
    window: WebviewWindow,
    nonce: String,
) -> Result<(), String> {
    crate::require_window(&window, "main")?;
    let shared = app.state::<SharedGate>();
    let mut g = shared.lock().map_err(|_| "Update state unavailable.")?;
    if !g.lease.as_ref().is_some_and(|l| l.committed) {
        if g.lease.as_ref().is_some_and(|l| l.nonce == nonce) {
            g.lease = None;
        }
        if let Some(game) = app.get_webview_window("game") {
            let _ = game.eval(format!(
                "window.__RAYRAG__?.maintenance({},false)",
                serde_json::to_string(&nonce).map_err(|_| "Invalid lease.")?
            ));
        }
    }
    Ok(())
}
#[tauri::command]
pub(crate) async fn update_install(
    app: tauri::AppHandle,
    window: WebviewWindow,
    nonce: String,
) -> Result<bool, String> {
    crate::require_window(&window, "main")?;
    if !AUTOMATIC_SUPPORTED {
        return Err(MANUAL_UPDATE.into());
    }
    let candidate = {
        let shared = app.state::<SharedGate>();
        let mut g = shared.lock().map_err(|_| "Update state unavailable.")?;
        if !g
            .lease
            .as_ref()
            .is_some_and(|l| l.nonce == nonce && l.acknowledged)
        {
            g.expire();
            return Ok(false);
        }
        if g.lease
            .as_ref()
            .is_some_and(|l| l.committed || l.invalidated)
        {
            return Err("Update settlement changed.".into());
        }
        if app
            .state::<crate::login::SharedLogin>()
            .lock()
            .map_err(|_| "Login state unavailable.")?
            .maintenance_busy()
        {
            return Err("Login settlement changed.".into());
        }
        if let Some(game) = app.get_webview_window("game") {
            let l = g.lease.as_mut().ok_or("Update settlement changed.")?;
            if !l.final_ack {
                if !l.final_requested {
                    l.final_requested = true;
                    game.eval(format!(
                        "window.__RAYRAG__?.maintenance({},'commit')",
                        serde_json::to_string(&nonce).map_err(|_| "Invalid lease.")?
                    ))
                    .map_err(|_| "Could not recheck game settlement.")?;
                }
                return Ok(false);
            }
        }
        let c = app
            .state::<SharedUpdate>()
            .lock()
            .map_err(|_| "Update state unavailable.")?
            .candidate
            .clone()
            .ok_or("No update is ready.")?;
        g.commit(&nonce)?;
        c
    };
    // A committed lease continues blocking commands while window destruction finishes.
    let mut retirement_owner = None;
    let result = async {
        let retirement = {
            // URL queries dispatch to the UI thread, whose commands may need
            // SharedGate. Capture the mode first; retirement rechecks the lease
            // generation and identity after acquiring the admission lock.
            let mode = app
                .get_webview_window("game")
                .as_ref()
                .map(crate::direct::window_mode)
                .transpose()?;
            let shared = app.state::<SharedGate>();
            let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
            app.state::<crate::direct::SharedDirect>()
                .retire_for_update(&mut gate, &nonce, mode)?
        };
        retirement_owner = Some(retirement.owner());
        let owner = retirement
            .join(
                app.state::<SharedGate>().inner(),
                app.state::<crate::direct::SharedDirect>().inner(),
            )
            .await?;
        if let Some(game) = app.get_webview_window("game") {
            {
                let shared = app.state::<SharedGate>();
                let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
                app.state::<crate::direct::SharedDirect>()
                    .request_game_close(&mut gate, &owner)?;
            }
            game.destroy()
                .map_err(|_| "Could not close the settled game.")?;
        }
        for _ in 0..40 {
            let gate = app.state::<SharedGate>();
            if app.get_webview_window("game").is_none()
                && gate
                    .lock()
                    .map_err(|_| "Update state unavailable.")?
                    .replacement_ready(&owner)
            {
                break;
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(25)))
                .await
                .map_err(|_| "Window settlement unavailable.")?;
        }
        if app.get_webview_window("game").is_some() {
            Err("Game window did not close; update deferred.".into())
        } else {
            if let Ok(mut u) = app.state::<SharedUpdate>().lock() {
                u.status.phase = "installing".into();
                u.status.message = "Installing the verified client update.".into();
            }
            let install_app = app.clone();
            tauri::async_runtime::spawn_blocking(move || {
                let shared = install_app.state::<SharedGate>();
                let gate = shared.lock().map_err(|_| "Update state unavailable.")?;
                if install_app.get_webview_window("game").is_some()
                    || !install_app
                        .state::<crate::direct::SharedDirect>()
                        .replacement_ready(&gate, &owner)
                {
                    return Err("Game settlement changed before replacement.".into());
                }
                update_install::install(&candidate.bytes, &candidate.version)
            })
            .await
            .map_err(|_| "Update install task failed.")?
        }
    }
    .await;
    if let Err(e) = result {
        {
            let shared = app.state::<SharedGate>();
            let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
            if let Some(owner) = retirement_owner {
                gate.release_retirement(&owner);
            } else if gate.lease.as_ref().is_some_and(|l| l.nonce == nonce) {
                gate.lease = None;
            }
        }
        if let Ok(mut u) = app.state::<SharedUpdate>().lock() {
            u.status.phase = "error".into();
            u.status.message = e.clone();
            u.candidate = None;
            u.next = Instant::now() + Duration::from_secs(3600);
        }
        return Err(e);
    }
    app.restart();
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        collections::VecDeque,
        io::{Read, Write},
        net::TcpListener,
        sync::mpsc,
    };
    type FeedResult = Result<Option<(String, Platform)>, String>;

    fn feed(version: &str) -> Vec<u8> {
        serde_json::to_vec(&serde_json::json!({
            "version": version,
            "platforms": {"darwin-aarch64": {
                "url": format!("https://github.com/oDestroyeRo/openrayrag/releases/download/v{version}/Rayrag_Companion_{version}_aarch64.app.tar.gz"),
                "signature": "test"
            }}
        }))
        .unwrap()
    }

    fn response(status: &str, body: &[u8]) -> Vec<u8> {
        let mut bytes = format!(
            "HTTP/1.1 {status}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            body.len()
        )
        .into_bytes();
        bytes.extend_from_slice(body);
        bytes
    }

    fn find_from_server(responses: Vec<Vec<u8>>, current: &str) -> (FeedResult, Vec<String>) {
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let base = format!("http://{}", server.local_addr().unwrap());
        server.set_nonblocking(true).unwrap();
        let (stop, stopped) = mpsc::channel();
        let thread = std::thread::spawn(move || {
            let mut responses = VecDeque::from(responses);
            let mut paths = Vec::new();
            loop {
                match server.accept() {
                    Ok((mut stream, _)) => {
                        // Accepted sockets inherit nonblocking mode on some platforms.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_secs(2)))
                            .unwrap();
                        let mut request = Vec::new();
                        let mut chunk = [0; 2048];
                        while !request.windows(4).any(|bytes| bytes == b"\r\n\r\n") {
                            let count = stream.read(&mut chunk).unwrap();
                            assert!(count > 0);
                            request.extend_from_slice(&chunk[..count]);
                            assert!(request.len() < 8192);
                        }
                        paths.push(
                            String::from_utf8_lossy(&request)
                                .split_whitespace()
                                .nth(1)
                                .unwrap()
                                .to_owned(),
                        );
                        let bytes = responses
                            .pop_front()
                            .unwrap_or_else(|| response("500 Unexpected request", b""));
                        let _ = stream.write_all(&bytes);
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        if stopped.recv_timeout(Duration::from_millis(5)).is_ok() {
                            break;
                        }
                    }
                    Err(error) => panic!("Synthetic feed server failed: {error}"),
                }
            }
            paths
        });
        let result = tauri::async_runtime::block_on(find_update(
            &download_client(false).unwrap(),
            &format!("{base}/latest-semver.json"),
            &format!("{base}/latest.json"),
            current,
        ));
        stop.send(()).unwrap();
        (result, thread.join().unwrap())
    }

    #[test]
    fn automatic_updates_are_admitted_only_on_apple_silicon_macos() {
        let state = UpdateState::default();
        assert_eq!(state.status.platform, std::env::consts::OS);
        assert_eq!(
            state.status.phase,
            if AUTOMATIC_SUPPORTED {
                "checking"
            } else {
                "manual"
            }
        );
        assert!(state.candidate.is_none());
        assert_eq!(state.status.bytes, 0);
        if !AUTOMATIC_SUPPORTED {
            assert_eq!(state.status.message, MANUAL_UPDATE);
        }
    }
    #[test]
    fn interrupted_and_oversized_downloads_never_become_candidates() {
        fn fetch(response: &'static [u8], limit: usize) -> Result<Vec<u8>, DownloadError> {
            let server = TcpListener::bind("127.0.0.1:0").unwrap();
            let url = format!("http://{}/synthetic", server.local_addr().unwrap());
            let thread = std::thread::spawn(move || {
                let (mut stream, _) = server.accept().unwrap();
                let mut request = [0; 2048];
                let _ = stream.read(&mut request);
                let _ = stream.write_all(response);
            });
            let result = tauri::async_runtime::block_on(bounded(
                &download_client(false).unwrap(),
                &url,
                limit,
                |_| {},
            ));
            thread.join().unwrap();
            result
        }
        assert_eq!(
            fetch(
                b"HTTP/1.1 200 OK\r\nContent-Length: 3\r\nConnection: close\r\n\r\nabc",
                4
            )
            .unwrap(),
            b"abc"
        );
        assert!(fetch(
            b"HTTP/1.1 200 OK\r\nContent-Length: 100\r\nConnection: close\r\n\r\nx",
            4
        )
        .is_err());
        assert!(fetch(
            b"HTTP/1.1 200 OK\r\nContent-Length: 4\r\nConnection: close\r\n\r\nx",
            4
        )
        .is_err());
        assert!(fetch(b"HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n5\r\nabcde\r\n0\r\n\r\n",4).is_err());
    }
    #[test]
    fn stable_newer_fixed_immutable_assets_only() {
        let url="https://github.com/oDestroyeRo/openrayrag/releases/download/v0.2.9/Rayrag_Companion_0.2.9_aarch64.app.tar.gz";
        let mut f = serde_json::json!({"version":"0.2.9","platforms":{"darwin-aarch64":{"url":url,"signature":"test"}}});
        assert!(parse_feed(&serde_json::to_vec(&f).unwrap(), "0.1.0")
            .unwrap()
            .is_some());
        assert!(parse_feed(&serde_json::to_vec(&f).unwrap(), "0.2.9")
            .unwrap()
            .is_none());
        f["platforms"]["darwin-aarch64"]["url"] = "https://evil.test/app".into();
        assert!(parse_feed(&serde_json::to_vec(&f).unwrap(), "0.1.0").is_err());
        for v in [
            "0.2.10-beta",
            "0.2.10+other",
            "v0.2.10",
            "01.2.10",
            "1.02.10",
            "1.2.010",
            "1.2",
            " 1.2.10",
            "1.2.10 ",
        ] {
            assert!(version(v).is_none());
        }
        for v in ["0.2.10", "0.3.0", "1.0.0", "12.30.100"] {
            assert!(version(v).is_some());
            let metadata = feed(v);
            assert_eq!(parse_feed(&metadata, "0.2.9").unwrap().unwrap().0, v);
            assert!(parse_feed(&metadata, v).unwrap().is_none());
            assert!(parse_feed(&metadata, "13.0.0").unwrap().is_none());
        }
    }
    #[test]
    fn primary_feed_success_and_current_version_never_use_legacy() {
        for current in ["0.2.63", "1.0.0", "2.0.0"] {
            let (result, paths) = find_from_server(
                vec![
                    response("200 OK", &feed("1.0.0")),
                    response("200 OK", &feed("3.0.0")),
                ],
                current,
            );
            assert_eq!(paths, ["/latest-semver.json"]);
            let found = result.unwrap();
            if current == "0.2.63" {
                assert_eq!(found.unwrap().0, "1.0.0");
            } else {
                assert!(found.is_none());
            }
        }
    }
    #[test]
    fn missing_primary_feed_uses_legacy_once() {
        let (result, paths) = find_from_server(
            vec![
                response("404 Not Found", b""),
                response("200 OK", &feed("0.2.64")),
            ],
            "0.2.63",
        );
        assert_eq!(result.unwrap().unwrap().0, "0.2.64");
        assert_eq!(paths, ["/latest-semver.json", "/latest.json"]);
        let (result, paths) = find_from_server(
            vec![
                response("404 Not Found", b""),
                response("200 OK", &feed("0.2.63")),
            ],
            "0.2.63",
        );
        assert!(result.unwrap().is_none());
        assert_eq!(paths, ["/latest-semver.json", "/latest.json"]);
    }
    #[test]
    fn primary_failure_never_uses_legacy() {
        let mut truncated = response("200 OK", &feed("1.0.0"));
        truncated.pop();
        let mut streamed = format!(
            "HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n{:x}\r\n",
            MAX_METADATA + 1
        )
        .into_bytes();
        streamed.extend_from_slice(&vec![b'x'; MAX_METADATA + 1]);
        streamed.extend_from_slice(b"\r\n0\r\n\r\n");
        let failures = [
            response("403 Forbidden", b""),
            response("429 Too Many Requests", b""),
            response("500 Internal Server Error", b""),
            response("502 Bad Gateway", b""),
            response("503 Service Unavailable", b""),
            b"HTTP/1.1 200 OK\r\nContent-Length: 64001\r\nConnection: close\r\n\r\n".to_vec(),
            response("200 OK", &vec![b'x'; MAX_METADATA + 1]),
            streamed,
            truncated,
            response("200 OK", b"invalid json"),
            response("200 OK", &feed("1.0.0-beta.1")),
            response("204 No Content", b""),
            Vec::new(),
        ];
        for failure in failures {
            let (result, paths) =
                find_from_server(vec![failure, response("200 OK", &feed("0.2.64"))], "0.2.63");
            assert!(result.is_err());
            assert_eq!(paths, ["/latest-semver.json"]);
        }
    }
    #[test]
    fn missing_primary_does_not_hide_legacy_failure() {
        for failure in [
            response("404 Not Found", b""),
            response("403 Forbidden", b""),
            response("500 Internal Server Error", b""),
            response("200 OK", b"invalid json"),
            response("200 OK", &vec![b'x'; MAX_METADATA + 1]),
            Vec::new(),
        ] {
            let (result, paths) =
                find_from_server(vec![response("404 Not Found", b""), failure], "0.2.63");
            assert!(result.is_err());
            assert_eq!(paths, ["/latest-semver.json", "/latest.json"]);
        }
    }
    #[test]
    fn semver_feed_still_requires_exact_archive_and_bounded_signature() {
        let mut metadata: serde_json::Value = serde_json::from_slice(&feed("1.2.3")).unwrap();
        let expected = metadata["platforms"]["darwin-aarch64"]["url"]
            .as_str()
            .unwrap()
            .to_owned();
        for url in [
            expected.replace("v1.2.3/", "v1.2.2/"),
            expected.replace("Companion_1.2.3_", "Companion_1.2.2_"),
            format!("{expected}?download=1"),
            expected.replace("aarch64", "x64"),
            expected.replace("https://", "http://"),
        ] {
            metadata["platforms"]["darwin-aarch64"]["url"] = url.into();
            assert!(parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.2.63").is_err());
        }
        metadata["platforms"]["darwin-aarch64"]["url"] = expected.into();
        metadata["platforms"]["darwin-aarch64"]["signature"] = "x".repeat(4097).into();
        assert!(parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.2.63").is_err());
        metadata["platforms"] = serde_json::json!({});
        assert!(parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.2.63").is_err());
    }
    #[test]
    fn feed_version_cannot_override_authenticated_archive_version() {
        use base64::{engine::general_purpose::STANDARD, Engine};
        let signed: serde_json::Value =
            serde_json::from_str(include_str!("update-signature-test.json")).unwrap();
        let payload = STANDARD
            .decode(signed["payloadBase64"].as_str().unwrap())
            .unwrap();
        let public_key = signed["publicKey"].as_str().unwrap();
        for advertised in ["0.2.27", "1.0.0"] {
            let mut metadata: serde_json::Value =
                serde_json::from_slice(&feed(advertised)).unwrap();
            metadata["platforms"]["darwin-aarch64"]["signature"] = signed["signature"].clone();
            let (v, platform) = parse_feed(&serde_json::to_vec(&metadata).unwrap(), "0.1.0")
                .unwrap()
                .unwrap();
            assert_eq!(
                update_install::verify(&payload, &platform.signature, public_key, &v).is_ok(),
                advertised == "0.2.27"
            );
            assert!(update_install::verify(&payload, &platform.signature, "invalid", &v).is_err());
        }
    }
}

#[tauri::command]
pub(crate) fn update_lease_alive(
    app: tauri::AppHandle,
    window: WebviewWindow,
    nonce: String,
) -> Result<bool, String> {
    crate::require_game_runtime(&window)?;
    let shared = app.state::<SharedGate>();
    let mut g = shared.lock().map_err(|_| "Update state unavailable.")?;
    g.expire();
    Ok(g.lease.as_ref().is_some_and(|l| l.nonce == nonce))
}

#[tauri::command]
pub(crate) fn update_invalidate(
    app: tauri::AppHandle,
    window: WebviewWindow,
    nonce: String,
    kind: String,
) -> Result<(), String> {
    crate::require_game_runtime(&window)?;
    if !matches!(kind.as_str(), "frame" | "socket" | "page") {
        return Err("Invalid lease mutation.".into());
    }
    let shared = app.state::<SharedGate>();
    let mut g = shared.lock().map_err(|_| "Update state unavailable.")?;
    if kind == "frame" || !g.lease.as_ref().is_some_and(|l| l.committed) {
        g.invalidate(&nonce);
    }
    Ok(())
}
#[tauri::command]
pub(crate) fn update_final_ack(
    app: tauri::AppHandle,
    window: WebviewWindow,
    nonce: String,
    identity: GameIdentity,
    revision: u64,
) -> Result<bool, String> {
    crate::require_game_runtime(&window)?;
    let shared = app.state::<SharedGate>();
    let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
    if crate::direct::window_mode(&window)? == crate::login::ConnectionMode::BotOnly
        && !app
            .state::<crate::direct::SharedDirect>()
            .settled_for(&identity)
    {
        return Ok(false);
    }
    Ok(gate.final_ack(&nonce, &identity, revision))
}

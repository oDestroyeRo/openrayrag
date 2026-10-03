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
const FEED: &str = "https://github.com/oDestroyeRo/openrayrag/releases/latest/download/latest.json";
const RELEASE: &str = "https://github.com/oDestroyeRo/openrayrag/releases/latest";
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Status {
    pub version: String,
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
                phase: "checking".into(),
                available_version: None,
                message: "Checking for signed client updates.".into(),
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
    if n.major != 0
        || n.minor != 2
        || !n.pre.is_empty()
        || !n.build.is_empty()
        || n.to_string() != v
    {
        return None;
    }
    Some(n)
}
fn parse_feed(bytes: &[u8], current: &str) -> Result<Option<(String, Platform)>, String> {
    if bytes.len() > 64_000 {
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
async fn bounded(
    client: &reqwest::Client,
    url: &str,
    limit: usize,
    mut progress: impl FnMut(usize),
) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Update download failed.")?
        .error_for_status()
        .map_err(|_| "Update download failed.")?;
    if response.content_length().is_some_and(|n| n > limit as u64) {
        return Err("Update exceeds its size limit.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Update download was interrupted.")?
    {
        if bytes
            .len()
            .checked_add(chunk.len())
            .map_or(true, |n| n > limit)
        {
            return Err("Update exceeds its size limit.".into());
        }
        bytes.extend_from_slice(&chunk);
        progress(bytes.len());
    }
    Ok(bytes)
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
    let result = async {
        let client = download_client(true)?;
        let metadata = bounded(&client, FEED, 64_000, |_| {}).await?;
        let Some((v, p)) = parse_feed(&metadata, env!("CARGO_PKG_VERSION"))? else {
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
    std::process::Command::new("/usr/bin/open")
        .arg(RELEASE)
        .spawn()
        .map(|_| ())
        .map_err(|_| {
            "Could not open the release download. Visit the repository Releases page.".into()
        })
}
#[tauri::command]
pub(crate) fn current_form(
    app: tauri::AppHandle,
    window: WebviewWindow,
) -> Result<Option<FormDocument>, String> {
    crate::require_window(&window, "main")?;
    current_form::load(
        app.path()
            .app_data_dir()
            .map_err(|_| "Settings storage unavailable.")?,
    )
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
        app.path()
            .app_data_dir()
            .map_err(|_| "Settings storage unavailable.")?,
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
    let loaded = current_form::load(
        app.path()
            .app_data_dir()
            .map_err(|_| "Settings storage unavailable.")?,
    )?
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
    let result = async {
        if let Some(game) = app.get_webview_window("game") {
            game.destroy()
                .map_err(|_| "Could not close the settled game.")?;
        }
        for _ in 0..40 {
            if app.get_webview_window("game").is_none() {
                break;
            }
            tauri::async_runtime::spawn_blocking(|| std::thread::sleep(Duration::from_millis(25)))
                .await
                .map_err(|_| "Window settlement unavailable.")?;
        }
        if app
            .state::<SharedGate>()
            .lock()
            .map_err(|_| "Update state unavailable.")?
            .lease
            .as_ref()
            .map_or(true, |l| l.invalidated)
        {
            return Err("Game settlement changed before replacement.".into());
        }
        if app.get_webview_window("game").is_some() {
            Err("Game window did not close; update deferred.".into())
        } else {
            if let Ok(mut u) = app.state::<SharedUpdate>().lock() {
                u.status.phase = "installing".into();
                u.status.message = "Installing the verified client update.".into();
            }
            tauri::async_runtime::spawn_blocking(move || {
                update_install::install(&candidate.bytes, &candidate.version)
            })
            .await
            .map_err(|_| "Update install task failed.")?
        }
    }
    .await;
    if let Err(e) = result {
        app.state::<SharedGate>()
            .lock()
            .map_err(|_| "Update state unavailable.")?
            .lease = None;
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
    #[test]
    fn interrupted_and_oversized_downloads_never_become_candidates() {
        use std::{
            io::{Read, Write},
            net::TcpListener,
        };
        fn fetch(response: &'static [u8], limit: usize) -> Result<Vec<u8>, String> {
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
        for v in ["0.2.10-beta", "0.2.10+other", "0.3.0", "v0.2.10"] {
            assert!(version(v).is_none());
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

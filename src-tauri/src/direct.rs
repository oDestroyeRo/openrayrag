//! Fixed TLS transport for the bundled controller. Authentication remains native.
use crate::{
    direct_wire,
    login::{ConnectionMode, LoginProfile, SharedLogin},
    maintenance::{GameIdentity, GameRetirement, Gate, SharedGate},
};
use futures_util::{SinkExt, StreamExt};
use serde::Serialize;
use std::{collections::VecDeque, sync::Mutex, time::Duration};
use tauri::{Manager, Webview};
use tokio::{
    io::{AsyncRead, AsyncWrite},
    sync::{mpsc, oneshot},
    task::JoinHandle,
};
use tokio_tungstenite::{
    connect_async_with_config,
    tungstenite::{protocol::WebSocketConfig, Message},
    WebSocketStream,
};

const ENDPOINT: &str = "wss://gamesea01.rayrag.com/ws";
const VERSION_URL: &str =
    "https://websea01.rayrag.com/StreamingAssets/ClientConfigGenerated/ServerVersion.txt";
const MAX_FRAME: usize = 512 * 1024;
const MAX_QUEUE_BYTES: usize = 4 * 1024 * 1024;
const MAX_EVENTS: usize = 64;
const MAX_BATCH_EVENTS: usize = 16;
const CONTROL_EVENT_BYTES: usize = 256;
// Applying one polled batch can send Ready for every map change before polling again.
// Keep those acknowledgements and the terminal event writable while reads pause.
const RESERVED_EVENTS: usize = MAX_BATCH_EVENTS + 1;
pub(crate) fn runtime_url() -> tauri::Url {
    if cfg!(debug_assertions) {
        "http://127.0.0.1:1420/bot-runtime.html".parse().unwrap()
    } else {
        "tauri://localhost/bot-runtime.html".parse().unwrap()
    }
}
pub(crate) fn url_for(mode: ConnectionMode) -> tauri::Url {
    match mode {
        ConnectionMode::BotOnly => runtime_url(),
        ConnectionMode::GameClient => crate::GAME_URL.parse().unwrap(),
    }
}
pub(crate) fn runtime_mode(window: &Webview) -> Result<ConnectionMode, String> {
    mode_for_url(&window.url().map_err(|_| "Connection URL unavailable.")?)
}
fn mode_for_url(url: &tauri::Url) -> Result<ConnectionMode, String> {
    if *url == runtime_url() {
        Ok(ConnectionMode::BotOnly)
    } else if url.as_str() == crate::GAME_URL {
        Ok(ConnectionMode::GameClient)
    } else {
        Err("Unverified connection runtime.".into())
    }
}
fn local_window(window: &Webview) -> Result<(), String> {
    crate::require_view(window, "game")?;
    if runtime_mode(window)? != ConnectionMode::BotOnly {
        return Err("Command requires the bundled bot runtime.".into());
    }
    Ok(())
}
fn is_warp(bytes: &[u8]) -> bool {
    bytes.first() == Some(&29)
        && match bytes.get(1) {
            Some(1) | Some(4) => bytes.get(6) == Some(&55),
            Some(5) => bytes.get(2..4) == Some(&[55, 0]),
            _ => false,
        }
}
fn id(value: &str) -> bool {
    uuid::Uuid::parse_str(value).is_ok() && value.len() == 36
}
#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub(crate) enum Event {
    Opened,
    ReadySent,
    EnterSent { bytes: Vec<u8> },
    Frame { bytes: Vec<u8> },
    Closed { reason: &'static str },
    Failed { reason: String },
}
impl Event {
    fn size(&self) -> usize {
        match self {
            // A polled frame can produce one ReadySent before another batch is drained.
            // Charge at least that event's size so the reserve survives successive batches.
            Self::EnterSent { bytes } | Self::Frame { bytes } => {
                bytes.len().max(CONTROL_EVENT_BYTES)
            }
            _ => CONTROL_EVENT_BYTES,
        }
    }
}
struct Outgoing {
    bytes: Vec<u8>,
    result: oneshot::Sender<Result<(), String>>,
}
struct Connection {
    session: String,
    id: String,
    epoch: u64,
    connected: bool,
    entered_world: bool,
    queue: VecDeque<Event>,
    queue_bytes: usize,
    pending: usize,
    delivery: Option<u64>,
    delivery_sequence: u64,
    outgoing: mpsc::Sender<Outgoing>,
    task: Option<JoinHandle<()>>,
}
impl Connection {
    fn incoming_capacity(&self) -> bool {
        self.queue.len() < MAX_EVENTS - RESERVED_EVENTS
            && self.queue_bytes
                <= MAX_QUEUE_BYTES - MAX_FRAME - RESERVED_EVENTS * CONTROL_EVENT_BYTES
    }
    fn push_event(&mut self, event: Event) -> Result<(), String> {
        if self.queue.len() >= MAX_EVENTS || self.queue_bytes + event.size() > MAX_QUEUE_BYTES {
            return Err("Incoming transport queue exceeded its limit.".into());
        }
        self.queue_bytes += event.size();
        self.queue.push_back(event);
        Ok(())
    }
}
#[derive(Default)]
struct State {
    epoch: u64,
    connecting: Option<u64>,
    joining: Option<u64>,
    current: Option<Connection>,
    retired: Option<JoinHandle<()>>,
}
#[derive(Default)]
pub(crate) struct SharedDirect(Mutex<State>);
pub(crate) struct UpdateRetirement {
    owner: GameRetirement,
    epoch: u64,
    task: Option<JoinHandle<()>>,
}
impl UpdateRetirement {
    pub(crate) fn owner(&self) -> GameRetirement {
        self.owner.clone()
    }
    // The task may need SharedGate to finish. Never join it under either lock.
    pub(crate) async fn join(
        self,
        gate: &SharedGate,
        direct: &SharedDirect,
    ) -> Result<GameRetirement, String> {
        let joined = if let Some(task) = self.task {
            match task.await {
                Ok(()) => Ok(()),
                Err(error) if error.is_cancelled() => Ok(()),
                Err(_) => Err("Game transport retirement failed."),
            }
        } else {
            Ok(())
        };
        let mut gate = gate.lock().map_err(|_| "Update state unavailable.")?;
        let mut state = direct.0.lock().map_err(|_| "Transport unavailable.")?;
        if state.joining == Some(self.epoch) {
            state.joining = None;
        }
        joined?;
        if state.epoch != self.epoch || !state.empty() {
            return Err("Game transport changed during retirement.".into());
        }
        gate.transport_retired(&self.owner)?;
        Ok(self.owner)
    }
}
impl State {
    fn push(&mut self, gate: &mut Gate, epoch: u64, event: Option<Event>) -> Result<(), String> {
        let current = self
            .current
            .as_mut()
            .filter(|c| c.epoch == epoch)
            .ok_or("Connection replaced.")?;
        mutate(gate);
        if let Some(event) = event {
            current.push_event(event)?;
        }
        Ok(())
    }
    fn empty(&self) -> bool {
        self.connecting.is_none()
            && self.joining.is_none()
            && self.current.is_none()
            && self.retired.is_none()
    }
    fn settled_for(&self, identity: &GameIdentity) -> bool {
        self.connecting.is_none()
            && self.joining.is_none()
            && self.retired.is_none()
            && self.current.as_ref().is_some_and(|c| {
                SharedDirect::matches(c, &identity.session_id, &identity.connection_id)
                    && c.connected
                    && c.pending == 0
                    && c.delivery.is_none()
                    && c.queue.is_empty()
                    && c.outgoing.capacity() == c.outgoing.max_capacity()
            })
    }
    fn reserve(&mut self) -> Result<(u64, Option<JoinHandle<()>>), String> {
        if self.current.is_some() || self.connecting.is_some() || self.joining.is_some() {
            return Err("Disconnect or reconnect before creating another transport.".into());
        }
        self.epoch = self.epoch.wrapping_add(1);
        self.connecting = Some(self.epoch);
        let retired = self.retired.take();
        if retired.is_some() {
            self.joining = Some(self.epoch);
        }
        Ok((self.epoch, retired))
    }
    fn cancel(&mut self) {
        self.epoch = self.epoch.wrapping_add(1);
        self.connecting = None;
        if let Some(mut previous) = self.current.take() {
            if let Some(task) = previous.task.take() {
                task.abort();
                self.retired = Some(task);
            }
        }
    }
    // A delayed completion can only retire its own generation, never its replacement.
    fn cancel_if_epoch(&mut self, epoch: u64) -> bool {
        let Some(current) = self.current.as_mut().filter(|c| c.epoch == epoch) else {
            return false;
        };
        self.epoch = self.epoch.wrapping_add(1);
        current.epoch = self.epoch;
        current.connected = false;
        if let Some(task) = current.task.take() {
            task.abort();
            self.retired = Some(task);
        }
        current.pending = 0;
        current.queue.clear();
        current.queue_bytes = 256;
        current.queue.push_back(Event::Closed {
            reason: "Transport write did not settle. Pending outcomes remain unresolved.",
        });
        true
    }
}
impl SharedDirect {
    fn matches(connection: &Connection, session: &str, connection_id: &str) -> bool {
        connection.session == session && connection.id == connection_id
    }
    pub(crate) fn status_matches(&self, status: &serde_json::Value) -> bool {
        self.0.lock().ok().is_some_and(|s| {
            s.current.as_ref().is_some_and(|c| {
                Self::matches(
                    c,
                    status
                        .get("sessionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                    status
                        .get("connectionId")
                        .and_then(|v| v.as_str())
                        .unwrap_or(""),
                ) && (status.get("connected").and_then(|v| v.as_bool()) != Some(true)
                    || c.connected)
            })
        })
    }
    pub(crate) fn observe_world(&self, status: &serde_json::Value) {
        if status.get("connected").and_then(|v| v.as_bool()) != Some(true)
            || !status.get("player").is_some_and(|v| v.is_object())
        {
            return;
        }
        if let Ok(mut state) = self.0.lock() {
            if let Some(c) = state.current.as_mut().filter(|c| {
                c.connected
                    && Self::matches(
                        c,
                        status
                            .get("sessionId")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                        status
                            .get("connectionId")
                            .and_then(|v| v.as_str())
                            .unwrap_or(""),
                    )
            }) {
                c.entered_world = true;
            }
        }
    }
    pub(crate) fn entered_world(&self) -> bool {
        self.0
            .lock()
            .ok()
            .is_some_and(|s| s.current.as_ref().is_some_and(|c| c.entered_world))
    }
    // Caller holds SharedGate, preventing retirement/frame/write admission from racing ACK.
    pub(crate) fn settled_for(&self, identity: &GameIdentity) -> bool {
        self.0.lock().ok().is_some_and(|s| s.settled_for(identity))
    }
    // Caller holds SharedGate, in the same order as ordinary cancellation and frames.
    pub(crate) fn retire_for_update(
        &self,
        gate: &mut Gate,
        nonce: &str,
        mode: Option<ConnectionMode>,
    ) -> Result<UpdateRetirement, String> {
        let mut state = self.0.lock().map_err(|_| "Transport unavailable.")?;
        let settled = match mode {
            Some(ConnectionMode::BotOnly) => gate
                .identity
                .as_ref()
                .is_some_and(|identity| state.settled_for(identity)),
            Some(ConnectionMode::GameClient) | None => state.empty(),
        };
        if !settled {
            return Err("Game transport is not settled for retirement.".into());
        }
        let owner = gate.begin_retirement(nonce, mode.is_some())?;
        state.epoch = state.epoch.wrapping_add(1);
        let task = state.current.take().and_then(|mut c| c.task.take());
        if let Some(task) = &task {
            state.joining = Some(state.epoch);
            task.abort();
        }
        Ok(UpdateRetirement {
            owner,
            epoch: state.epoch,
            task,
        })
    }
    pub(crate) fn replacement_ready(&self, gate: &Gate, owner: &GameRetirement) -> bool {
        self.0
            .lock()
            .ok()
            .is_some_and(|s| s.empty() && gate.replacement_ready(owner))
    }
    pub(crate) fn request_game_close(
        &self,
        gate: &mut Gate,
        owner: &GameRetirement,
    ) -> Result<(), String> {
        if !self.0.lock().map_err(|_| "Transport unavailable.")?.empty() {
            return Err("Game transport changed before close.".into());
        }
        gate.request_game_close(owner)
    }
    pub(crate) fn cancel_admitted(&self, gate: &mut Gate) {
        if let Ok(mut state) = self.0.lock() {
            mutate(gate);
            state.cancel();
        }
    }
    pub(crate) fn game_destroyed(&self, gate: &mut Gate) {
        if let Ok(mut state) = self.0.lock() {
            if state.empty() && gate.updater_game_destroyed() {
                return;
            }
            mutate(gate);
            state.cancel();
        }
        gate.game_closed();
    }
}
fn mutate(gate: &mut Gate) {
    gate.revision += 1;
    if let Some(nonce) = gate.lease.as_ref().map(|l| l.nonce.clone()) {
        gate.invalidate(&nonce);
    }
}
pub(crate) fn cancel_admitted(app: &tauri::AppHandle, gate: &mut Gate) {
    app.state::<SharedDirect>().cancel_admitted(gate);
}
pub(crate) fn cancel(app: &tauri::AppHandle) {
    if let Ok(mut gate) = app.state::<SharedGate>().lock() {
        cancel_admitted(app, &mut gate);
    }
}
fn cancel_if_epoch(app: &tauri::AppHandle, epoch: u64) {
    if let Ok(mut gate) = app.state::<SharedGate>().lock() {
        if let Ok(mut state) = app.state::<SharedDirect>().0.lock() {
            if state.cancel_if_epoch(epoch) {
                mutate(&mut gate);
            }
        }
    }
}
fn push(app: &tauri::AppHandle, epoch: u64, event: Option<Event>) -> Result<(), String> {
    let shared = app.state::<SharedGate>();
    let mut gate = shared.lock().map_err(|_| "Update state unavailable.")?;
    let shared = app.state::<SharedDirect>();
    let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
    state.push(&mut gate, epoch, event)
}
fn incoming_capacity(app: &tauri::AppHandle, epoch: u64) -> Result<bool, String> {
    let shared = app.state::<SharedDirect>();
    let state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
    let current = state
        .current
        .as_ref()
        .filter(|c| c.epoch == epoch)
        .ok_or("Connection replaced.")?;
    Ok(current.incoming_capacity())
}
fn admit_handshake(app: &tauri::AppHandle, epoch: u64) -> Result<(), String> {
    let _permit = crate::maintenance::admit(app)?;
    let shared = app.state::<SharedDirect>();
    let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
    let c = state
        .current
        .as_mut()
        .filter(|c| c.epoch == epoch)
        .ok_or("Connection replaced.")?;
    c.pending += 1;
    Ok(())
}
fn admit_ping(app: &tauri::AppHandle, epoch: u64) -> bool {
    let Ok(_permit) = crate::maintenance::admit(app) else {
        return false;
    };
    let shared = app.state::<SharedDirect>();
    let Ok(mut state) = shared.0.lock() else {
        return false;
    };
    let Some(c) = state
        .current
        .as_mut()
        .filter(|c| c.epoch == epoch && c.connected)
    else {
        return false;
    };
    c.pending += 1;
    true
}
fn finish_write(app: &tauri::AppHandle, epoch: u64) {
    if let Ok(mut state) = app.state::<SharedDirect>().0.lock() {
        if let Some(c) = state.current.as_mut().filter(|c| c.epoch == epoch) {
            c.pending = c.pending.saturating_sub(1);
        }
    }
}
async fn public_text(client: &reqwest::Client, url: &str, limit: usize) -> Result<Vec<u8>, String> {
    let mut response = client
        .get(url)
        .send()
        .await
        .map_err(|_| "Public compatibility check unavailable.")?;
    if !response.status().is_success()
        || response.content_length().is_some_and(|v| v > limit as u64)
    {
        return Err("Game compatibility could not be verified.".into());
    }
    let mut bytes = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| "Public compatibility check unavailable.")?
    {
        if bytes.len() + chunk.len() > limit {
            return Err("Compatibility response exceeded its limit.".into());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}
fn verified_build(bytes: &[u8]) -> bool {
    let Ok(text) = std::str::from_utf8(bytes) else {
        return false;
    };
    // Inert text only: exactly one pinned declaration, no execution or Unity downloads.
    let declaration = format!("var buildUrl = \"{}\";", crate::login::VERIFIED_BUILD);
    text.matches("var buildUrl").count() == 1 && text.contains(&declaration)
}
pub(crate) async fn server_version() -> Result<(), String> {
    let client = reqwest::Client::builder()
        .https_only(true)
        .redirect(reqwest::redirect::Policy::none())
        .user_agent("Rayrag-Companion")
        .timeout(Duration::from_secs(10))
        .build()
        .map_err(|_| "Compatibility check unavailable.")?;
    let bytes = public_text(&client, VERSION_URL, 64).await?;
    if bytes
        .iter()
        .copied()
        .filter(|b| !b.is_ascii_whitespace())
        .collect::<Vec<_>>()
        != b"8"
    {
        return Err("This server protocol version is not verified.".into());
    }
    if !verified_build(&public_text(&client, crate::GAME_URL, 128 * 1024).await?) {
        return Err("This game build is not verified.".into());
    }
    Ok(())
}
fn config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_FRAME))
        .max_frame_size(Some(MAX_FRAME))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_FRAME * 2)
}
// The same loop runs against a local synthetic socket in tests. Production endpoint is fixed above.
struct TransportHooks<E, F, P, H, C> {
    event: E,
    finished: F,
    ping: P,
    handshake: H,
    incoming_capacity: C,
}
async fn drive<S, E, F, P, H, C>(
    mut socket: WebSocketStream<S>,
    profile: LoginProfile,
    mut outgoing: mpsc::Receiver<Outgoing>,
    mut hooks: TransportHooks<E, F, P, H, C>,
    ping_period: Duration,
) -> Result<(), String>
where
    S: AsyncRead + AsyncWrite + Unpin,
    E: FnMut(Option<Event>) -> Result<(), String>,
    F: FnMut(),
    P: FnMut() -> bool,
    H: FnMut() -> Result<(), String>,
    C: FnMut() -> Result<bool, String>,
{
    (hooks.handshake)()?;
    let auth = socket
        .send(Message::Binary(
            direct_wire::authentication(&profile.username, &profile.password).into(),
        ))
        .await;
    (hooks.finished)();
    auth.map_err(|_| "Sign-in write failed.")?;
    (hooks.event)(Some(Event::Opened))?;
    let slot = profile.character_slot;
    drop(profile);
    let mut pings =
        tokio::time::interval_at(tokio::time::Instant::now() + ping_period, ping_period);
    pings.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let mut approved = false;
    let login_deadline = tokio::time::Instant::now() + Duration::from_secs(60);
    loop {
        let capacity = (hooks.incoming_capacity)()?;
        tokio::select! {
            _=pings.tick()=>{
                if (hooks.ping)(){let answer=socket.send(Message::Binary(vec![4].into())).await;(hooks.finished)();
                    answer.map_err(|_|"Keepalive write failed. Pending outcomes remain unresolved.")?;}
            }
            request=outgoing.recv()=>{
                let Some(request)=request else {return Ok(())};
                let ready=request.bytes==[2];
                let mut answer=socket.send(Message::Binary(request.bytes.into())).await.map_err(|_|"Transport write failed.".to_string());
                if answer.is_ok()&&ready{answer=(hooks.event)(Some(Event::ReadySent));}
                (hooks.finished)();let failed=answer.is_err();let _=request.result.send(answer);
                if failed{return Err("Transport write failed. Pending action outcomes remain unresolved.".into());}
            }
            frame=socket.next(),if capacity=>{
                let Some(frame)=frame else {return Ok(())};
                match frame.map_err(|_|"Connection stream failed.")? {
                    Message::Binary(bytes)=>{
                        if !approved {
                            if bytes.first()==Some(&0){let name=direct_wire::selected_character(&bytes,slot)?;let packet=direct_wire::enter(&name);
                                (hooks.handshake)()?;
                                let entered=socket.send(Message::Binary(packet.clone().into())).await;(hooks.finished)();entered.map_err(|_|"Character selection write failed.")?;
                                (hooks.event)(Some(Event::EnterSent{bytes:packet}))?;approved=true;
                            }else if bytes.first()==Some(&1)||bytes.first()==Some(&32){return Err("Sign-in was rejected. Check the account and try explicitly again.".into());}
                            else{return Err("Unexpected pre-login response.".into());}
                        }else if bytes.first()==Some(&0)||bytes.first()==Some(&1){return Err("Unexpected authentication response.".into());}
                        else{(hooks.event)(Some(Event::Frame{bytes:bytes.to_vec()}))?;}
                    }
                    Message::Close(_)=>return Ok(()),
                    Message::Ping(_)|Message::Pong(_)=>{(hooks.event)(None)?;},
                    _=>return Err("Unsupported transport frame.".into()),
                }
            }
            // Polling frees capacity without changing command/Ping admission or ownership.
            _=tokio::time::sleep(Duration::from_millis(10)),if !capacity=>{},
            _=tokio::time::sleep_until(login_deadline),if !approved=>return Err("Sign-in timed out.".into()),
        }
    }
}
async fn run(
    app: tauri::AppHandle,
    epoch: u64,
    profile: LoginProfile,
    outgoing: mpsc::Receiver<Outgoing>,
) {
    let result: Result<(), String> = async {
        server_version().await?;
        let (socket, _) = tokio::time::timeout(
            Duration::from_secs(15),
            connect_async_with_config(ENDPOINT, Some(config()), false),
        )
        .await
        .map_err(|_| "Connection timed out.")?
        .map_err(|_| "Could not establish the verified TLS connection.")?;
        drive(
            socket,
            profile,
            outgoing,
            TransportHooks {
                event: |event| {
                    if matches!(event, Some(Event::Opened)) {
                        let shared = app.state::<SharedDirect>();
                        let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
                        let c = state
                            .current
                            .as_mut()
                            .filter(|c| c.epoch == epoch)
                            .ok_or("Connection replaced.")?;
                        c.connected = true;
                    }
                    push(&app, epoch, event)
                },
                finished: || finish_write(&app, epoch),
                ping: || admit_ping(&app, epoch),
                handshake: || admit_handshake(&app, epoch),
                incoming_capacity: || incoming_capacity(&app, epoch),
            },
            Duration::from_secs(5),
        )
        .await
    }
    .await;
    if let Ok(mut state) = app.state::<SharedDirect>().0.lock() {
        if let Some(c) = state.current.as_mut().filter(|c| c.epoch == epoch) {
            c.connected = false;
        }
    }
    let event = match result {
        Ok(()) => Event::Closed {
            reason: "Game connection closed.",
        },
        Err(reason) => Event::Failed { reason },
    };
    if push(&app, epoch, Some(event)).is_err() {
        cancel_if_epoch(&app, epoch);
    }
}
#[tauri::command]
pub(crate) async fn direct_connect(
    app: tauri::AppHandle,
    window: Webview,
    session_id: String,
    connection_id: String,
) -> Result<(), String> {
    local_window(&window)?;
    if !id(&session_id) || !id(&connection_id) {
        return Err("Invalid connection identity.".into());
    }
    let (epoch, retired, login_generation, page_generation) = {
        let gate = crate::maintenance::admit(&app)?;
        let shared = app.state::<SharedDirect>();
        let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
        let (epoch, retired) = state.reserve()?;
        let generation = app
            .state::<SharedLogin>()
            .lock()
            .map_err(|_| "Login state unavailable.")?
            .generation();
        (epoch, retired, generation, gate.game_generation)
    };
    if let Some(task) = retired {
        let _ = task.await;
        if let Ok(mut state) = app.state::<SharedDirect>().0.lock() {
            if state.joining == Some(epoch) {
                state.joining = None;
            }
        }
    }
    // Reservation and both generations must survive cancellation/navigation/another login.
    let answer = (|| {
        local_window(&window)?;
        let gate = crate::maintenance::admit(&app)?;
        if gate.game_generation != page_generation {
            return Err("Connection page replaced.".into());
        }
        let shared = app.state::<SharedDirect>();
        let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
        if state.connecting != Some(epoch) || state.epoch != epoch || state.current.is_some() {
            return Err("Connection request replaced.".into());
        }
        let profile = app
            .state::<SharedLogin>()
            .lock()
            .map_err(|_| "Login state unavailable.")?
            .claim_generation(login_generation, session_id.clone())?;
        if profile.mode != ConnectionMode::BotOnly {
            return Err("Queued login uses another connection mode.".into());
        }
        profile.validate()?;
        let (sender, receiver) = mpsc::channel(16);
        state.connecting = None;
        state.current = Some(Connection {
            session: session_id,
            id: connection_id,
            epoch,
            connected: false,
            entered_world: false,
            queue: VecDeque::new(),
            queue_bytes: 0,
            pending: 0,
            delivery: None,
            delivery_sequence: 0,
            outgoing: sender,
            task: None,
        });
        let task = tokio::spawn(run(app.clone(), epoch, profile, receiver));
        state.current.as_mut().unwrap().task = Some(task);
        Ok(())
    })();
    if answer.is_err() {
        if let Ok(mut state) = app.state::<SharedDirect>().0.lock() {
            if state.connecting == Some(epoch) {
                state.connecting = None;
            }
        }
    }
    answer
}
#[derive(Serialize)]
pub(crate) struct Batch {
    events: Vec<Event>,
    delivery: Option<u64>,
}
#[tauri::command]
pub(crate) fn direct_observed(
    app: tauri::AppHandle,
    window: Webview,
    session_id: String,
    connection_id: String,
    delivery: u64,
) -> Result<(), String> {
    local_window(&window)?;
    let shared = app.state::<SharedDirect>();
    let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
    let c = state
        .current
        .as_mut()
        .filter(|c| SharedDirect::matches(c, &session_id, &connection_id))
        .ok_or("Connection replaced.")?;
    if c.delivery != Some(delivery) {
        return Err("Stale transport delivery.".into());
    }
    c.delivery = None;
    Ok(())
}
#[tauri::command]
pub(crate) fn direct_poll(
    app: tauri::AppHandle,
    window: Webview,
    session_id: String,
    connection_id: String,
) -> Result<Batch, String> {
    local_window(&window)?;
    let shared = app.state::<SharedDirect>();
    let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
    let current = state
        .current
        .as_mut()
        .filter(|c| SharedDirect::matches(c, &session_id, &connection_id))
        .ok_or("Connection replaced.")?;
    if current.delivery.is_some() {
        return Err("Apply the previous transport batch first.".into());
    }
    let mut events = Vec::new();
    for _ in 0..MAX_BATCH_EVENTS {
        let Some(event) = current.queue.pop_front() else {
            break;
        };
        current.queue_bytes = current.queue_bytes.saturating_sub(event.size());
        events.push(event);
    }
    if !events.is_empty() {
        current.delivery_sequence = current.delivery_sequence.wrapping_add(1);
        current.delivery = Some(current.delivery_sequence);
    }
    Ok(Batch {
        events,
        delivery: current.delivery,
    })
}
#[tauri::command]
pub(crate) async fn direct_send(
    app: tauri::AppHandle,
    window: Webview,
    session_id: String,
    connection_id: String,
    bytes: Vec<u8>,
) -> Result<(), String> {
    local_window(&window)?;
    if bytes.is_empty() || bytes.len() > 65_536 || matches!(bytes[0], 0 | 1 | 3 | 32) {
        return Err("Invalid controller gameplay packet.".into());
    }
    let (result, epoch) = {
        let _permit = crate::maintenance::admit(&app)?;
        let shared = app.state::<SharedDirect>();
        let mut state = shared.0.lock().map_err(|_| "Transport unavailable.")?;
        let current = state
            .current
            .as_mut()
            .filter(|c| c.connected && SharedDirect::matches(c, &session_id, &connection_id))
            .ok_or("Connection replaced or closed.")?;
        if is_warp(&bytes) {
            crate::mode_guard::mark_admitted(&app, ConnectionMode::BotOnly)?;
        }
        let (answer, result) = oneshot::channel();
        current.pending += 1;
        if current
            .outgoing
            .try_send(Outgoing {
                bytes,
                result: answer,
            })
            .is_err()
        {
            current.pending -= 1;
            return Err("Outgoing queue exceeded its limit.".into());
        }
        (result, current.epoch)
    };
    match tokio::time::timeout(Duration::from_secs(10), result).await {
        Ok(Ok(answer)) => answer,
        _ => {
            cancel_if_epoch(&app, epoch);
            Err("Transport write did not settle. Outcome remains unresolved.".into())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc,
    };
    fn profile() -> LoginProfile {
        serde_json::from_value(serde_json::json!({"username":"synthetic-user","password":"synthetic-only","characterSlot":0,"mode":"botOnly"})).unwrap()
    }
    fn approval() -> Vec<u8> {
        let name = b"Synthetic";
        let mut out = vec![0];
        let mut bit = 8;
        let mut write = |v: u32, n: usize| {
            for i in 0..n {
                let at = bit / 8;
                if at == out.len() {
                    out.push(0);
                }
                out[at] |= (((v >> i) & 1) as u8) << (bit % 8);
                bit += 1;
            }
        };
        write(0, 1);
        write(1, 32);
        write(name.len() as u32, 16);
        for b in name {
            write(u32::from(*b), 8);
        }
        write(0, 32);
        write(0, 16);
        write(0, 32);
        out
    }
    fn connection(epoch: u64) -> Connection {
        let (outgoing, _) = mpsc::channel(16);
        Connection {
            session: "s".into(),
            id: "c".into(),
            epoch,
            connected: true,
            entered_world: false,
            queue: VecDeque::new(),
            queue_bytes: 0,
            pending: 0,
            delivery: None,
            delivery_sequence: 0,
            outgoing,
            task: None,
        }
    }
    fn committed_gate(has_game: bool) -> SharedGate {
        let shared = SharedGate::default();
        {
            let mut gate = shared.lock().unwrap();
            gate.initialized = true;
            gate.form_revision = Some(1);
            gate.game_generation = 7;
            if has_game {
                gate.identity = Some(GameIdentity {
                    session_id: "s".into(),
                    connection_id: "c".into(),
                });
                gate.observed = Some(std::time::Instant::now());
            }
            gate.reserve("update".into(), 1, has_game).unwrap();
            if let Some(identity) = gate.identity.clone() {
                assert!(gate.acknowledge("update", identity.clone(), 3));
                gate.lease.as_mut().unwrap().final_requested = true;
                assert!(gate.final_ack("update", &identity, 3));
            }
            gate.commit("update").unwrap();
        }
        shared
    }
    #[tokio::test]
    async fn updater_retirement_preserves_committed_game_client_and_startup_leases() {
        for mode in [Some(ConnectionMode::GameClient), None] {
            let shared = committed_gate(mode.is_some());
            let direct = SharedDirect::default();
            let retirement = direct
                .retire_for_update(&mut shared.lock().unwrap(), "update", mode)
                .unwrap();
            let owner = retirement.owner();
            assert!(!direct.replacement_ready(&shared.lock().unwrap(), &owner));
            retirement.join(&shared, &direct).await.unwrap();
            let mut gate = shared.lock().unwrap();
            if mode.is_some() {
                assert!(!direct.replacement_ready(&gate, &owner));
                direct.request_game_close(&mut gate, &owner).unwrap();
                // This is the same production helper called by game Destroyed.
                direct.game_destroyed(&mut gate);
            }
            assert!(direct.replacement_ready(&gate, &owner));
            assert!(!gate.lease.as_ref().unwrap().invalidated);
            assert_eq!(gate.game_generation, 7);
            assert_eq!(gate.revision, 0);
            assert!(gate.admit().is_err());
            // Ordinary cancellation still fences the committed empty transport.
            direct.cancel_admitted(&mut gate);
            assert!(gate.lease.as_ref().unwrap().invalidated);
            assert!(!direct.replacement_ready(&gate, &owner));
        }
    }
    #[tokio::test]
    async fn updater_bot_retirement_joins_outside_locks_and_cannot_cancel_replacement() {
        struct DropProof {
            gate: Arc<SharedGate>,
            direct: Arc<SharedDirect>,
            stopped: Arc<AtomicBool>,
        }
        impl Drop for DropProof {
            fn drop(&mut self) {
                assert!(self.gate.try_lock().is_ok());
                assert!(self.direct.0.try_lock().is_ok());
                self.stopped.store(true, Ordering::SeqCst);
            }
        }
        let shared = Arc::new(committed_gate(true));
        let direct = Arc::new(SharedDirect::default());
        let stopped = Arc::new(AtomicBool::new(false));
        let proof = DropProof {
            gate: shared.clone(),
            direct: direct.clone(),
            stopped: stopped.clone(),
        };
        let (started, ready) = oneshot::channel();
        let task = tokio::spawn(async move {
            let _proof = proof;
            started.send(()).unwrap();
            std::future::pending::<()>().await;
        });
        ready.await.unwrap();
        {
            let mut state = direct.0.lock().unwrap();
            state.epoch = 9;
            state.current = Some(connection(9));
            state.current.as_mut().unwrap().task = Some(task);
        }
        let retirement = direct
            .retire_for_update(
                &mut shared.lock().unwrap(),
                "update",
                Some(ConnectionMode::BotOnly),
            )
            .unwrap();
        let owner = retirement.owner();
        assert!(!direct.replacement_ready(&shared.lock().unwrap(), &owner));
        assert!(direct.0.lock().unwrap().joining.is_some());
        retirement.join(&shared, &direct).await.unwrap();
        assert!(stopped.load(Ordering::SeqCst));
        let mut gate = shared.lock().unwrap();
        {
            let mut state = direct.0.lock().unwrap();
            assert!(!state.cancel_if_epoch(9));
            assert!(state
                .push(&mut gate, 9, Some(Event::Frame { bytes: vec![1] }))
                .is_err());
        }
        direct.request_game_close(&mut gate, &owner).unwrap();
        direct.game_destroyed(&mut gate);
        assert!(direct.replacement_ready(&gate, &owner));
        {
            let mut state = direct.0.lock().unwrap();
            state.epoch = 11;
            state.current = Some(connection(11));
            assert!(!state.cancel_if_epoch(9));
        }
        assert!(direct
            .retire_for_update(&mut gate, "update", Some(ConnectionMode::BotOnly))
            .is_err());
        assert!(direct.request_game_close(&mut gate, &owner).is_err());
        assert!(!direct.replacement_ready(&gate, &owner));
        assert!(direct.0.lock().unwrap().current.as_ref().unwrap().connected);
    }
    #[tokio::test]
    async fn cancellation_during_updater_join_cannot_revive_the_committed_lease() {
        let shared = committed_gate(true);
        let direct = SharedDirect::default();
        {
            let mut state = direct.0.lock().unwrap();
            state.epoch = 1;
            state.current = Some(connection(1));
            state.current.as_mut().unwrap().task = Some(tokio::spawn(std::future::pending()));
        }
        let retirement = direct
            .retire_for_update(
                &mut shared.lock().unwrap(),
                "update",
                Some(ConnectionMode::BotOnly),
            )
            .unwrap();
        let owner = retirement.owner();
        direct.cancel_admitted(&mut shared.lock().unwrap());
        assert!(retirement.join(&shared, &direct).await.is_err());
        let mut gate = shared.lock().unwrap();
        assert!(gate.lease.as_ref().unwrap().invalidated);
        assert!(direct.0.lock().unwrap().empty());
        assert!(direct.request_game_close(&mut gate, &owner).is_err());
        assert!(!direct.replacement_ready(&gate, &owner));
    }
    #[tokio::test]
    async fn updater_retirement_rejects_every_unsettled_native_owner() {
        for blocker in 0..10 {
            let shared = committed_gate(true);
            let direct = SharedDirect::default();
            let (outgoing, _receiver) = mpsc::channel(16);
            {
                let mut state = direct.0.lock().unwrap();
                state.current = Some(connection(1));
                match blocker {
                    0 => state.connecting = Some(1),
                    1 => state.joining = Some(1),
                    2 => state.retired = Some(tokio::spawn(std::future::pending())),
                    3 => state.current.as_mut().unwrap().pending = 1,
                    4 => state.current.as_mut().unwrap().delivery = Some(1),
                    5 => state
                        .current
                        .as_mut()
                        .unwrap()
                        .push_event(Event::ReadySent)
                        .unwrap(),
                    6 => state.current.as_mut().unwrap().connected = false,
                    7 => state.current.as_mut().unwrap().session = "stale".into(),
                    8 => {
                        let (result, _) = oneshot::channel();
                        outgoing
                            .try_send(Outgoing {
                                bytes: vec![1],
                                result,
                            })
                            .unwrap();
                        state.current.as_mut().unwrap().outgoing = outgoing;
                    }
                    _ => {}
                }
            }
            let mode = if blocker == 9 {
                ConnectionMode::GameClient
            } else {
                ConnectionMode::BotOnly
            };
            assert!(
                direct
                    .retire_for_update(&mut shared.lock().unwrap(), "update", Some(mode))
                    .is_err(),
                "blocker {blocker}"
            );
            let task = direct.0.lock().unwrap().retired.take();
            if let Some(task) = task {
                task.abort();
                let _ = task.await;
            }
            assert!(direct.0.lock().unwrap().current.is_some());
        }
    }
    #[tokio::test]
    async fn stale_or_invalidated_retirement_never_owns_game_destruction() {
        for change in 0..7 {
            let shared = committed_gate(true);
            let direct = SharedDirect::default();
            assert!(direct
                .retire_for_update(
                    &mut shared.lock().unwrap(),
                    "stale",
                    Some(ConnectionMode::GameClient)
                )
                .is_err());
            let retirement = direct
                .retire_for_update(
                    &mut shared.lock().unwrap(),
                    "update",
                    Some(ConnectionMode::GameClient),
                )
                .unwrap();
            let owner = retirement.join(&shared, &direct).await.unwrap();
            let mut gate = shared.lock().unwrap();
            direct.request_game_close(&mut gate, &owner).unwrap();
            match change {
                0 => gate.lease.as_mut().unwrap().nonce = "other".into(),
                1 => gate.game_generation += 1,
                2 => gate.identity.as_mut().unwrap().connection_id = "replacement".into(),
                3 => gate.revision += 1,
                4 => gate.form_revision = Some(2),
                5 => gate.invalidate("update"),
                _ => direct.cancel_admitted(&mut gate), // User CloseRequested.
            }
            direct.game_destroyed(&mut gate);
            assert!(gate.lease.as_ref().unwrap().invalidated);
            assert_eq!(gate.identity, None);
            assert!(!direct.replacement_ready(&gate, &owner));
            assert!(gate.transport_retired(&owner).is_err());
        }
    }
    #[tokio::test]
    async fn unowned_close_and_native_frames_invalidate_committed_leases() {
        let shared = committed_gate(true);
        let direct = SharedDirect::default();
        direct.game_destroyed(&mut shared.lock().unwrap());
        assert!(shared.lock().unwrap().lease.as_ref().unwrap().invalidated);
        for event in [Some(Event::Frame { bytes: vec![1] }), None] {
            let shared = committed_gate(true);
            let direct = SharedDirect::default();
            direct.0.lock().unwrap().current = Some(connection(1));
            let mut gate = shared.lock().unwrap();
            direct.0.lock().unwrap().push(&mut gate, 1, event).unwrap();
            assert!(gate.lease.as_ref().unwrap().invalidated);
            assert!(direct
                .retire_for_update(&mut gate, "update", Some(ConnectionMode::BotOnly))
                .is_err());
        }
    }
    #[test]
    fn urls_and_build_are_exact_and_compatibility_text_is_inert() {
        assert_eq!(
            mode_for_url(&runtime_url()).unwrap(),
            ConnectionMode::BotOnly
        );
        assert_eq!(
            mode_for_url(&crate::GAME_URL.parse().unwrap()).unwrap(),
            ConnectionMode::GameClient
        );
        for url in [
            "https://websea01.rayrag.com/other",
            "https://other.rayrag.com/",
            "http://127.0.0.1:1420/index.html",
            "http://127.0.0.1:1420/bot-runtime.html?x=1",
        ] {
            assert!(mode_for_url(&url.parse().unwrap()).is_err());
        }
        let declaration = format!("var buildUrl = \"{}\";", crate::login::VERIFIED_BUILD);
        assert!(verified_build(declaration.as_bytes()));
        assert!(!verified_build(b"var buildUrl = \"other\";"));
        assert!(!verified_build(
            format!("{declaration}{declaration}").as_bytes()
        ));
    }
    #[test]
    fn stale_send_failure_cannot_cancel_replacement_and_delivery_fences_settlement() {
        let shared = SharedDirect::default();
        let identity = GameIdentity {
            session_id: "s".into(),
            connection_id: "c".into(),
        };
        {
            let mut state = shared.0.lock().unwrap();
            state.epoch = 9;
            state.current = Some(connection(9));
            assert!(!state.cancel_if_epoch(8));
            assert!(state.current.as_ref().unwrap().connected);
        }
        assert!(shared.settled_for(&identity));
        {
            let mut state = shared.0.lock().unwrap();
            let c = state.current.as_mut().unwrap();
            c.delivery = Some(1);
        }
        assert!(!shared.settled_for(&identity));
        {
            let mut state = shared.0.lock().unwrap();
            let c = state.current.as_mut().unwrap();
            c.delivery = None;
            c.pending = 1;
        }
        assert!(!shared.settled_for(&identity));
        {
            let mut state = shared.0.lock().unwrap();
            assert!(state.cancel_if_epoch(9));
            assert!(!state.cancel_if_epoch(9));
        }
        assert!(!shared.settled_for(&identity));
        assert!(!shared.status_matches(
            &serde_json::json!({"sessionId":"s","connectionId":"c","connected":true})
        ));
        assert!(shared.status_matches(
            &serde_json::json!({"sessionId":"s","connectionId":"c","connected":false})
        ));
    }
    #[test]
    fn world_entry_latch_survives_map_player_gaps_but_not_replacement() {
        let shared = SharedDirect::default();
        shared.0.lock().unwrap().current = Some(connection(1));
        assert!(!shared.entered_world());
        shared.observe_world(&serde_json::json!({"sessionId":"s","connectionId":"c","connected":true,"player":{"id":0}}));
        assert!(shared.entered_world());
        shared.observe_world(
            &serde_json::json!({"sessionId":"s","connectionId":"c","connected":true,"player":null}),
        );
        assert!(shared.entered_world());
        shared.0.lock().unwrap().current = Some(connection(2));
        assert!(!shared.entered_world());
        shared.observe_world(&serde_json::json!({"sessionId":"old","connectionId":"c","connected":true,"player":{"id":0}}));
        assert!(!shared.entered_world());
    }
    #[tokio::test]
    async fn cancellation_during_retirement_cannot_bypass_join_barrier() {
        let mut state = State {
            current: Some(connection(1)),
            epoch: 1,
            ..State::default()
        };
        state.current.as_mut().unwrap().task = Some(tokio::spawn(std::future::pending()));
        state.cancel();
        let (epoch, retired) = state.reserve().unwrap();
        assert!(state.reserve().is_err());
        state.cancel();
        assert_ne!(state.epoch, epoch);
        assert!(state.reserve().is_err());
        assert_eq!(state.joining, Some(epoch));
        let _ = retired.unwrap().await;
        state.joining = None;
        assert!(state.reserve().is_ok());
    }
    #[test]
    fn cancellation_and_every_native_frame_invalidate_final_update_ack() {
        let identity = GameIdentity {
            session_id: "s".into(),
            connection_id: "c".into(),
        };
        let mut gate = Gate::default();
        gate.initialized = true;
        gate.form_revision = Some(1);
        gate.identity = Some(identity.clone());
        gate.observed = Some(std::time::Instant::now());
        gate.reserve("a".repeat(32), 1, true).unwrap();
        assert!(gate.acknowledge(&"a".repeat(32), identity.clone(), 7));
        gate.lease.as_mut().unwrap().final_requested = true;
        mutate(&mut gate);
        assert!(!gate.final_ack(&"a".repeat(32), &identity, 7));
        assert!(gate.lease.as_ref().unwrap().invalidated);
    }
    async fn sockets() -> (
        WebSocketStream<tokio::net::TcpStream>,
        WebSocketStream<tokio::net::TcpStream>,
    ) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async_with_config(tcp, Some(config()))
                .await
                .unwrap()
        });
        let tcp = tokio::net::TcpStream::connect(address).await.unwrap();
        let (client, _) = tokio_tungstenite::client_async_with_config(
            format!("ws://{address}/"),
            tcp,
            Some(config()),
        )
        .await
        .unwrap();
        (client, server.await.unwrap())
    }
    async fn next<S>(socket: &mut S) -> Vec<u8>
    where
        S: futures_util::Stream<Item = Result<Message, tokio_tungstenite::tungstenite::Error>>
            + Unpin,
    {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                match socket.next().await.unwrap().unwrap() {
                    Message::Binary(v) => return v.to_vec(),
                    Message::Ping(_) | Message::Pong(_) => {}
                    other => panic!("unexpected {other:?}"),
                }
            }
        })
        .await
        .unwrap()
    }
    #[tokio::test]
    async fn actual_socket_auth_enter_ready_maps_stop_ping_lease_and_cancel() {
        let (client, mut server) = sockets().await;
        let (outgoing, receiver) = mpsc::channel(16);
        let (events, mut observed) = mpsc::unbounded_channel();
        let allowed = Arc::new(AtomicBool::new(false));
        let permission = allowed.clone();
        let completed = Arc::new(AtomicUsize::new(0));
        let writes = completed.clone();
        let task = tokio::spawn(drive(
            client,
            profile(),
            receiver,
            TransportHooks {
                event: move |e| {
                    if let Some(e) = e {
                        events.send(e).unwrap();
                    }
                    Ok(())
                },
                finished: move || {
                    writes.fetch_add(1, Ordering::SeqCst);
                },
                ping: move || permission.load(Ordering::SeqCst),
                handshake: || Ok(()),
                incoming_capacity: || Ok(true),
            },
            Duration::from_millis(40),
        ));
        assert_eq!(
            next(&mut server).await,
            direct_wire::authentication("synthetic-user", "synthetic-only")
        );
        assert!(matches!(observed.recv().await.unwrap(), Event::Opened));
        server
            .send(Message::Binary(approval().into()))
            .await
            .unwrap();
        assert_eq!(next(&mut server).await, direct_wire::enter("Synthetic"));
        assert!(matches!(
            observed.recv().await.unwrap(),
            Event::EnterSent { .. }
        ));
        for frame in [
            vec![3, 0, 0, 0, 0],
            vec![56, 1],
            vec![94, 0],
            vec![18, 0],
            vec![32, 4],
        ] {
            server
                .send(Message::Binary(frame.clone().into()))
                .await
                .unwrap();
            assert!(matches!(observed.recv().await.unwrap(),Event::Frame{bytes} if bytes==frame));
        }
        for bytes in [vec![2], vec![19], vec![2]] {
            let (answer, result) = oneshot::channel();
            outgoing
                .send(Outgoing {
                    bytes: bytes.clone(),
                    result: answer,
                })
                .await
                .unwrap();
            assert_eq!(next(&mut server).await, bytes);
            assert_eq!(result.await.unwrap(), Ok(()));
            if bytes == [2] {
                assert!(matches!(observed.recv().await.unwrap(), Event::ReadySent));
            }
        }
        assert_eq!(completed.load(Ordering::SeqCst), 5);
        // Manual Stop is just an ordinary command: the native application Ping continues.
        allowed.store(true, Ordering::SeqCst);
        assert_eq!(next(&mut server).await, [4]);
        allowed.store(false, Ordering::SeqCst);
        tokio::time::sleep(Duration::from_millis(20)).await;
        assert!(
            tokio::time::timeout(Duration::from_millis(100), server.next())
                .await
                .is_err()
        );
        task.abort();
        let _ = task.await;
        assert!(tokio::time::timeout(Duration::from_secs(2), server.next())
            .await
            .unwrap()
            .is_none_or(|v| v.is_err() || matches!(v, Ok(Message::Close(_)))));
    }
    struct FailingIo {
        tcp: tokio::net::TcpStream,
        fail: Arc<AtomicBool>,
    }
    async fn backpressured_burst(frame_size: usize, count: usize) {
        let (client, mut server) = sockets().await;
        let (outgoing, receiver) = mpsc::channel(16);
        let queue = Arc::new(Mutex::new(connection(1)));
        let events = queue.clone();
        let capacity = queue.clone();
        let completed = Arc::new(AtomicUsize::new(0));
        let writes = completed.clone();
        let allow_ping = Arc::new(AtomicBool::new(false));
        let permission = allow_ping.clone();
        let task = tokio::spawn(drive(
            client,
            profile(),
            receiver,
            TransportHooks {
                event: move |event: Option<Event>| {
                    if let Some(event) = event {
                        events.lock().unwrap().push_event(event)?;
                    }
                    Ok(())
                },
                finished: move || {
                    writes.fetch_add(1, Ordering::SeqCst);
                },
                ping: move || permission.load(Ordering::SeqCst),
                handshake: || Ok(()),
                incoming_capacity: move || Ok(capacity.lock().unwrap().incoming_capacity()),
            },
            Duration::from_millis(20),
        ));
        next(&mut server).await;
        server
            .send(Message::Binary(approval().into()))
            .await
            .unwrap();
        assert_eq!(next(&mut server).await, direct_wire::enter("Synthetic"));
        let (mut server_write, mut server) = server.split();
        let producer = tokio::spawn(async move {
            for n in 0..count {
                let mut frame = vec![0; frame_size];
                frame[0] = 6;
                frame[1] = n as u8;
                server_write
                    .send(Message::Binary(frame.into()))
                    .await
                    .unwrap();
            }
            server_write
        });
        // Deliberately delay the bundled runtime's first poll past a full burst.
        tokio::time::timeout(Duration::from_secs(2), async {
            while queue.lock().unwrap().incoming_capacity() {
                assert!(!task.is_finished());
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        tokio::time::sleep(Duration::from_millis(80)).await;
        assert!(
            !task.is_finished(),
            "a delayed consumer must not close the transport"
        );
        assert!(queue.lock().unwrap().queue.len() < MAX_EVENTS);
        assert!(!queue.lock().unwrap().incoming_capacity());

        // A drained batch can request Ready for every processed map change.
        for _ in 0..MAX_BATCH_EVENTS {
            let (answer, result) = oneshot::channel();
            outgoing
                .send(Outgoing {
                    bytes: vec![2],
                    result: answer,
                })
                .await
                .unwrap();
            assert_eq!(next(&mut server).await, [2]);
            assert_eq!(result.await.unwrap(), Ok(()));
        }
        let (answer, result) = oneshot::channel();
        outgoing
            .send(Outgoing {
                bytes: vec![19],
                result: answer,
            })
            .await
            .unwrap();
        assert_eq!(next(&mut server).await, [19]);
        assert_eq!(result.await.unwrap(), Ok(()));
        allow_ping.store(true, Ordering::SeqCst);
        assert_eq!(next(&mut server).await, [4]);
        allow_ping.store(false, Ordering::SeqCst);
        assert!(completed.load(Ordering::SeqCst) >= 19);
        assert!(!task.is_finished());

        let mut frames = Vec::new();
        let mut ready = 0;
        tokio::time::timeout(Duration::from_secs(2), async {
            while frames.len() < count {
                {
                    let mut c = queue.lock().unwrap();
                    assert!(c.queue.len() <= MAX_EVENTS);
                    assert!(c.queue_bytes <= MAX_QUEUE_BYTES);
                    for _ in 0..MAX_BATCH_EVENTS {
                        let Some(event) = c.queue.pop_front() else {
                            break;
                        };
                        c.queue_bytes -= event.size();
                        match event {
                            Event::Frame { bytes } => frames.push(bytes[1]),
                            Event::ReadySent => ready += 1,
                            Event::Opened | Event::EnterSent { .. } => {}
                            other => panic!("unexpected {other:?}"),
                        }
                    }
                }
                tokio::time::sleep(Duration::from_millis(1)).await;
            }
        })
        .await
        .unwrap();
        assert_eq!(frames, (0..count).map(|n| n as u8).collect::<Vec<_>>());
        assert_eq!(ready, MAX_BATCH_EVENTS);
        assert!(!task.is_finished());
        let _server_write = producer.await.unwrap();
        task.abort();
        assert!(task.await.unwrap_err().is_cancelled());
    }
    #[tokio::test]
    async fn actual_socket_backpressures_spawn_burst_without_blocking_ready_stop_or_ping() {
        backpressured_burst(2, MAX_EVENTS + 19).await;
    }
    #[tokio::test]
    async fn actual_socket_backpressures_byte_burst_without_blocking_ready_stop_or_ping() {
        backpressured_burst(MAX_FRAME, MAX_QUEUE_BYTES / MAX_FRAME + 3).await;
    }
    #[test]
    fn incoming_capacity_reserves_worst_case_frame_batch_ready_and_terminal() {
        for frame_size in [2, MAX_FRAME] {
            let mut c = connection(1);
            while c.incoming_capacity() {
                c.push_event(Event::Frame {
                    bytes: vec![6; frame_size],
                })
                .unwrap();
            }
            assert!(c.queue.len() < MAX_EVENTS);
            for _ in 0..MAX_BATCH_EVENTS {
                c.push_event(Event::ReadySent).unwrap();
            }
            c.push_event(Event::Closed {
                reason: "Synthetic close.",
            })
            .unwrap();
            assert!(c.queue.len() <= MAX_EVENTS);
            assert!(c.queue_bytes <= MAX_QUEUE_BYTES);
        }
    }
    #[test]
    fn mixed_small_map_batches_can_reuse_ready_reserve_without_byte_overflow() {
        let mut c = connection(1);
        for size in [16; MAX_BATCH_EVENTS * 2].into_iter().chain([MAX_FRAME; 6]) {
            assert!(c.incoming_capacity());
            c.push_event(Event::Frame {
                bytes: vec![18; size],
            })
            .unwrap();
        }
        let padding =
            MAX_QUEUE_BYTES - MAX_FRAME - RESERVED_EVENTS * CONTROL_EVENT_BYTES - c.queue_bytes;
        for size in [padding, MAX_FRAME] {
            assert!(c.incoming_capacity());
            c.push_event(Event::Frame {
                bytes: vec![6; size],
            })
            .unwrap();
        }
        assert!(!c.incoming_capacity());
        for _ in 0..2 {
            // Each processed small map frame sends Ready before the next poll.
            for _ in 0..MAX_BATCH_EVENTS {
                let event = c.queue.pop_front().unwrap();
                c.queue_bytes -= event.size();
            }
            for _ in 0..MAX_BATCH_EVENTS {
                c.push_event(Event::ReadySent).unwrap();
            }
            assert!(c.queue.len() < MAX_EVENTS);
            assert!(c.queue_bytes <= MAX_QUEUE_BYTES - CONTROL_EVENT_BYTES);
        }
    }
    impl tokio::io::AsyncRead for FailingIo {
        fn poll_read(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &mut tokio::io::ReadBuf<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.tcp).poll_read(cx, buf)
        }
    }
    impl tokio::io::AsyncWrite for FailingIo {
        fn poll_write(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
            buf: &[u8],
        ) -> std::task::Poll<std::io::Result<usize>> {
            if self.fail.load(Ordering::SeqCst) {
                return std::task::Poll::Ready(Err(std::io::ErrorKind::BrokenPipe.into()));
            }
            std::pin::Pin::new(&mut self.tcp).poll_write(cx, buf)
        }
        fn poll_flush(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.tcp).poll_flush(cx)
        }
        fn poll_shutdown(
            mut self: std::pin::Pin<&mut Self>,
            cx: &mut std::task::Context<'_>,
        ) -> std::task::Poll<std::io::Result<()>> {
            std::pin::Pin::new(&mut self.tcp).poll_shutdown(cx)
        }
    }
    #[tokio::test]
    async fn actual_socket_rejects_denial_and_preserves_failed_write_outcome() {
        let (client, mut server) = sockets().await;
        let (sender, receiver) = mpsc::channel(16);
        let task = tokio::spawn(drive(
            client,
            profile(),
            receiver,
            TransportHooks {
                event: |_| Ok(()),
                finished: || {},
                ping: || false,
                handshake: || Ok(()),
                incoming_capacity: || Ok(true),
            },
            Duration::from_secs(5),
        ));
        next(&mut server).await;
        server.send(Message::Binary(vec![1].into())).await.unwrap();
        assert!(task.await.unwrap().unwrap_err().contains("rejected"));
        drop(sender);
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move {
            let (tcp, _) = listener.accept().await.unwrap();
            tokio_tungstenite::accept_async(tcp).await.unwrap()
        });
        let fail = Arc::new(AtomicBool::new(false));
        let tcp = tokio::net::TcpStream::connect(address).await.unwrap();
        let io = FailingIo {
            tcp,
            fail: fail.clone(),
        };
        let (client, _) = tokio_tungstenite::client_async(format!("ws://{address}/"), io)
            .await
            .unwrap();
        let mut server = server.await.unwrap();
        let (sender, receiver) = mpsc::channel(16);
        let (opened, mut opens) = mpsc::unbounded_channel();
        let task = tokio::spawn(drive(
            client,
            profile(),
            receiver,
            TransportHooks {
                event: move |e| {
                    if matches!(e, Some(Event::Opened)) {
                        opened.send(()).unwrap();
                    }
                    Ok(())
                },
                finished: || {},
                ping: || false,
                handshake: || Ok(()),
                incoming_capacity: || Ok(true),
            },
            Duration::from_secs(5),
        ));
        next(&mut server).await;
        opens.recv().await.unwrap();
        fail.store(true, Ordering::SeqCst);
        let (answer, result) = oneshot::channel();
        sender
            .send(Outgoing {
                bytes: vec![19],
                result: answer,
            })
            .await
            .unwrap();
        assert!(result.await.unwrap().is_err());
        assert!(task.await.unwrap().unwrap_err().contains("unresolved"));
    }
    #[tokio::test]
    #[ignore = "anonymous public compatibility probe; no authentication or socket"]
    async fn anonymous_native_public_compatibility_probe() {
        let _ = rustls::crypto::ring::default_provider().install_default();
        server_version().await.unwrap();
    }
}

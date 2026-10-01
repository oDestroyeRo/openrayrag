import { BotEngine, type Settings, type Snapshot } from './engine';
import { command, walkCommand, decode, GAME_URL, SOCKET_URL, VERIFIED_BUILD } from './protocol';
import { LoginController, loginDriver, loginReady, type LoginProfile, type LoginStatus, type UnityClient } from './login';
import { currentMapInfo, loadMapCatalog, type MapCatalog } from './map-data';

interface BridgeWindow extends Window {
  buildUrl?: string;
  createUnityInstance?: (...args: unknown[]) => Promise<UnityClient>;
  __TAURI_INTERNALS__?: { invoke: (name: string, args: unknown) => Promise<unknown> };
  __RAYRAG__?: {
    control: (action: 'start' | 'stop' | 'heartbeat', settings?: Settings) => void;
    snapshot: () => Snapshot;
  };
}

const page = window as BridgeWindow;
if (location.origin === new URL(GAME_URL).origin && location.pathname === '/' && !page.__RAYRAG__) {
  const sessionId = crypto.randomUUID();
  const NativeSocket = window.WebSocket;
  let active: WebSocket | undefined;
  let heartbeat = 0;
  let publishing = false;
  let login: LoginController | undefined;
  let loginStatus: LoginStatus = { phase: 'idle', message: '' };
  let loginCancelled = false;
  let capturedUnity = false;
  let claimStarted = false;
  let unityClient: UnityClient | undefined;
  let catalog: MapCatalog | null = null;
  let catalogLoading = true;
  const engine = new BotEngine(action => {
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    NativeSocket.prototype.send.call(active, action.type === 'walk' ? walkCommand(action.destination) : command(action.type, 'id' in action ? action.id : undefined));
  });
  const publish = () => {
    if (!page.__TAURI_INTERNALS__ || publishing) return;
    publishing = true;
    page.__TAURI_INTERNALS__.invoke('bridge_status', { status: {
      ...engine.snapshot(), sessionId, login: login?.status ?? loginStatus,
      mapInfo: currentMapInfo(engine.map, engine.entities.values(), catalog, catalogLoading),
    } })
      .catch(() => { if (engine.running) engine.stop('Controller connection lost.'); })
      .finally(() => { publishing = false; });
  };
  // Fixed, public, same-origin assets. Failures fall back to live observations;
  // no credentials are sent and the official game connection is unaffected.
  void loadMapCatalog().then(value => { catalog = value; }).catch(() => {})
    .finally(() => { catalogLoading = false; publish(); });
  const stop = (reason: string) => {
    try { engine.stop(reason); } catch { engine.disconnect(); }
    publish();
  };
  const cancelLogin = () => {
    loginCancelled = true;
    if (login) login.cancel();
    else loginStatus = { phase: 'cancelled', message: 'Automatic sign-in cancelled. Continue manually or reopen the game.' };
    void page.__TAURI_INTERNALS__?.invoke('cancel_pending_login', {}).catch(() => {});
    publish();
  };

  // The official page keeps its Unity instance inside a callback. Wrap the factory
  // when its exact loader finishes, before the page's script onload callback runs.
  document.addEventListener('load', event => {
    const script = event.target;
    if (capturedUnity || !(script instanceof HTMLScriptElement)
      || script.src !== new URL(`${VERIFIED_BUILD}/Build Web.loader.js`, GAME_URL).href
      || !page.createUnityInstance) return;
    capturedUnity = true;
    const create = page.createUnityInstance;
    page.createUnityInstance = (...args) => create(...args).then(instance => {
      unityClient = instance;
      return instance;
    });
  }, true);

  const claimLogin = () => {
    if (claimStarted || loginCancelled || !unityClient || !page.__TAURI_INTERNALS__) return;
    if (!loginReady(unityClient)) return;
    claimStarted = true;
    const client = unityClient;
    void page.__TAURI_INTERNALS__.invoke('take_pending_login', { build: page.buildUrl ?? '' }).then(value => {
      const { profile, cancelled } = value as { profile: LoginProfile | null; cancelled: boolean };
      if (cancelled) {
        loginStatus = { phase: 'cancelled', message: 'Automatic sign-in cancelled. Continue manually or reopen the game.' };
        publish();
      }
      if (!profile) return;
      if (loginCancelled) { profile.password = ''; return; }
      login = new LoginController(loginDriver(client));
      void login.start(profile).catch(() => {
        profile.password = '';
        login = undefined;
        loginStatus = { phase: 'failed', message: 'Invalid sign-in settings. Reopen the game to try again.' };
        publish();
      });
      publish();
    }).catch(() => {
      loginStatus = { phase: 'failed', message: 'Automatic sign-in is unavailable. Check the game build and reopen it.' };
      publish();
    });
  };

  window.WebSocket = class extends NativeSocket {
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      if (String(url) !== SOCKET_URL) return;
      // One session at a time. A new connection never resumes an old bot run.
      stop('Opening game session.');
      active = this;
      let failed = false;
      let opcode = -1;
      let queue = Promise.resolve();
      this.addEventListener('open', () => {
        if (active !== this) return;
        engine.connect(page.buildUrl === VERIFIED_BUILD); publish();
      });
      this.addEventListener('message', event => {
        if (active !== this || failed) return;
        queue = queue.then(async () => {
          if (active !== this || failed) return;
          const value: unknown = event.data;
          const data = value instanceof ArrayBuffer ? new Uint8Array(value)
            : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : null;
          if (!data) return;
          opcode = data[0] ?? -1;
          // Authentication contents are never logged. Only populated character slots
          // are read while an explicitly requested sign-in is active.
          login?.receive(data);
          engine.receive(decode(data));
          if (engine.player) login?.complete();
        }).catch(error => {
          failed = true;
          const detail = error instanceof Error ? error.message.slice(0,80) : 'Decode error';
          engine.fail(`Packet ${opcode}: ${detail}. Reopen the game after updating Companion.`); publish();
        });
      });
      this.addEventListener('close', () => {
        if (active === this) { active = undefined; login?.disconnect(); engine.disconnect(); publish(); }
      });
      this.addEventListener('error', () => { if (active === this) stop('Game connection error.'); });
    }
  };

  page.__RAYRAG__ = {
    control(action, settings) {
      if (action === 'heartbeat') { heartbeat = Date.now(); return; }
      if (action === 'stop') { cancelLogin(); stop('Stopped by you.'); return; }
      try {
        if (page.buildUrl !== VERIFIED_BUILD) throw new Error('This game build is not verified.');
        if (!settings) throw new Error('Choose combat settings first.');
        engine.start(settings); heartbeat = Date.now();
      } catch (error) { stop(error instanceof Error ? error.message : 'Could not start.'); }
      publish();
    },
    snapshot: () => engine.snapshot(),
  };
  const manualInput = (event: Event) => {
    if (!event.isTrusted) return;
    cancelLogin();
    if (engine.running) stop('Paused for manual game input.');
  };
  document.addEventListener('pointerdown', manualInput, true);
  document.addEventListener('keydown', manualInput, true);
  window.addEventListener('pagehide', () => stop('Game page closed.'));
  setInterval(() => {
    try {
      claimLogin();
      login?.tick();
      if (engine.running && Date.now() - heartbeat > 6000) engine.stop('Controller heartbeat lost.');
      engine.tick();
    } catch { stop('Automation stopped after a connection error.'); }
    publish();
  }, 500);
}

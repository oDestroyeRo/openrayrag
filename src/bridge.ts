import { type Settings } from './engine';
import { command, walkCommand, GAME_URL, SOCKET_URL, VERIFIED_BUILD } from './protocol';
import { featureCommand, validateExpandedAction } from './protocol-feature';
import { worldCommand, validateWorldAction } from './world-protocol';
import { CompanionController, type CompanionSnapshot } from './controller';
import { LoginController, loginDriver, loginReady, type LoginProfile, type LoginStatus, type UnityClient } from './login';
import { currentMapInfo, loadMapCatalog, type MapCatalog } from './map-data';
import type { EscapeResumeGuard } from './escape';

interface BridgeWindow extends Window {
  buildUrl?: string;
  createUnityInstance?: (...args: unknown[]) => Promise<UnityClient>;
  __TAURI_INTERNALS__?: { invoke: (name: string, args: unknown) => Promise<unknown> };
  __RAYRAG__?: {
    control: (action: 'start' | 'stop' | 'heartbeat', settings?: Settings, escapeGuard?: EscapeResumeGuard) => void;
    perform: (action: 'command' | 'workflow' | 'routine' | 'service', request: unknown) => void;
    snapshot: () => CompanionSnapshot;
  };
}

const page = window as BridgeWindow;
if (location.origin === new URL(GAME_URL).origin && location.pathname === '/' && !page.__RAYRAG__) {
  const sessionId = crypto.randomUUID();
  const NativeSocket = window.WebSocket;
  let active: WebSocket | undefined;
  let connectionId: string | null = null;
  let heartbeat = 0;
  let publishing = false;
  let lastPublished = 0;
  let login: LoginController | undefined;
  let loginStatus: LoginStatus = { phase: 'idle', message: '' };
  let loginCancelled = false;
  let enteredWorld = false;
  let capturedUnity = false;
  let claimStarted = false;
  let unityClient: UnityClient | undefined;
  let catalog: MapCatalog | null = null;
  let catalogLoading = true;
  const controller = new CompanionController(action => {
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    const packet = action.type === 'walk' ? walkCommand(action.destination)
      : action.type === 'attack' || action.type === 'pickup' || action.type === 'stop'
        ? command(action.type, 'id' in action ? action.id : undefined)
        : (() => {
          try { return featureCommand(validateExpandedAction(action)); }
          catch { return worldCommand(validateWorldAction(action)); }
        })();
    NativeSocket.prototype.send.call(active, Uint8Array.from(packet));
  });
  const engine = controller.engine;
  const publish = () => {
    if (!page.__TAURI_INTERNALS__ || publishing) return;
    publishing = true;
    page.__TAURI_INTERNALS__.invoke('bridge_status', { status: {
      ...controller.snapshot(), sessionId, connectionId, login: login?.status ?? loginStatus,
      mapInfo: currentMapInfo(engine.map, engine.entities.values(), catalog, catalogLoading),
    } })
      .catch(() => { if (controller.active) controller.heartbeat(false); })
      .finally(() => { publishing = false; });
  };
  // Fixed, public, same-origin assets. Failures fall back to live observations;
  // no credentials are sent and the official game connection is unaffected.
  void loadMapCatalog().then(value => { catalog = value; }).catch(() => {})
    .finally(() => { catalogLoading = false; publish(); });
  const stop = (reason: string) => {
    try { controller.stop(reason); } catch { controller.disconnect(); }
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
    void page.__TAURI_INTERNALS__.invoke('take_pending_login', { build: page.buildUrl ?? '', sessionId }).then(value => {
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
      connectionId = crypto.randomUUID();
      // Retain the requested run while a new verified connection prepares its state.
      controller.pause('Opening game session.');
      active = this;
      let failed = false;
      let opcode = -1;
      let connectionGeneration = -1;
      let queue = Promise.resolve();
      this.addEventListener('open', () => {
        if (active !== this) return;
        controller.connect(page.buildUrl === VERIFIED_BUILD);
        connectionGeneration = controller.connectionGeneration; publish();
      });
      this.addEventListener('message', event => {
        if (active !== this || failed) return;
        queue = queue.then(async () => {
          if (active !== this || failed) return;
          const value: unknown = event.data;
          const data = value instanceof ArrayBuffer ? new Uint8Array(value)
            : value instanceof Blob ? new Uint8Array(await value.arrayBuffer()) : null;
          if (!data || active !== this || failed) return;
          opcode = data[0] ?? -1;
          // Authentication contents are never logged. Only populated character slots
          // are read while an explicitly requested sign-in is active.
          login?.receive(data);
          controller.receive(data, connectionGeneration);
          if (engine.player) { enteredWorld = true; login?.complete(); }
        }).catch(error => {
          if (active !== this) return;
          failed = true;
          const detail = error instanceof Error ? error.message.slice(0,80) : 'Decode error';
          controller.fail(`Packet ${opcode}: ${detail}. Reopen the game after updating Companion.`); publish();
        });
      });
      this.addEventListener('close', () => {
        if (active === this) { active = undefined; login?.disconnect(); controller.disconnect(); publish(); }
      });
      this.addEventListener('error', () => { if (active === this) { controller.pause('Waiting for the game connection.'); publish(); } });
    }
  };

  page.__RAYRAG__ = {
    control(action, settings, escapeGuard) {
      if (action === 'heartbeat') { heartbeat = Date.now(); controller.heartbeat(true); return; }
      if (action === 'stop') { cancelLogin(); stop('Stopped by you.'); return; }
      try {
        if (page.buildUrl !== VERIFIED_BUILD) throw new Error('This game build is not verified.');
        if (!settings) throw new Error('Choose combat settings first.');
        controller.heartbeat(true); controller.start(settings, escapeGuard); heartbeat = Date.now();
      } catch (error) { controller.engine.reason = error instanceof Error ? error.message : 'Could not start.'; }
      publish();
    },
    perform(action, request) {
      try {
        if (page.buildUrl !== VERIFIED_BUILD) throw new Error('This game build is not verified.');
        controller.perform(action, request); heartbeat = Date.now();
      } catch (error) { controller.engine.reason = error instanceof Error ? error.message : 'Could not perform this action.'; }
      publish();
    },
    snapshot: () => controller.snapshot(),
  };
  const manualInput = (event: Event) => {
    if (!event.isTrusted) return;
    // A map refresh briefly removes the player; it is not a new login attempt.
    if (!enteredWorld) cancelLogin();
    if (controller.active) { controller.pause('Yielding briefly to manual game input.', 2_000); publish(); }
  };
  document.addEventListener('pointerdown', manualInput, true);
  document.addEventListener('keydown', manualInput, true);
  window.addEventListener('pagehide', () => stop('Game page closed.'));
  setInterval(() => {
    try {
      claimLogin();
      login?.tick();
      if (controller.active && Date.now() - heartbeat > 6000) controller.heartbeat(false);
      controller.tick();
    } catch { controller.pause('Waiting after a connection error.'); }
    if (Date.now() - lastPublished >= 500) { lastPublished = Date.now(); publish(); }
  }, 100);
}

import type { DeathRecoveryGuard } from './death-recovery';
import { MaintenanceLease } from './maintenance';
import { socketCommand } from './socket-protocol';
import { couldOwnOfficialGameplay, isOfficialGameplayCommand } from './official-input';
import { type Settings } from './engine';
import { command, walkCommand, decode, OP, GAME_URL, SOCKET_URL, VERIFIED_BUILD } from './protocol';
import { featureCommand, validateExpandedAction } from './protocol-feature';
import { worldCommand, validateWorldAction } from './world-protocol';
import { socialCommand } from './social-protocol';
import { memoCommand } from './memo-protocol';
import { CompanionController, type CompanionSnapshot } from './controller';
import { LoginController, loginDriver, loginReady, type LoginProfile, type LoginStatus, type UnityClient } from './login';
import { currentMapInfo, loadMapCatalog, type MapCatalog } from './map-data';
import type { SupplyResumeGuard } from './supply-trip';
import type { EscapeResumeGuard } from './escape';

interface BridgeWindow extends Window {
  buildUrl?: string;
  createUnityInstance?: (...args: unknown[]) => Promise<UnityClient>;
  __TAURI_INTERNALS__?: { invoke: (name: string, args: unknown) => Promise<unknown> };
  __RAYRAG__?: {
    control: (action: 'start' | 'stop' | 'heartbeat', settings?: Settings, escapeGuard?: EscapeResumeGuard, supplyGuard?: SupplyResumeGuard, recoveryGuard?: DeathRecoveryGuard) => void;
    perform: (action: 'command' | 'workflow' | 'routine' | 'service' | 'social' | 'memo' | 'socketPreview' | 'socket', request: unknown) => void;
    maintenance:(nonce:string,reserve:boolean|'commit')=>void;
    snapshot: () => CompanionSnapshot;
  };
}

const page = window as BridgeWindow;
if (location.origin === new URL(GAME_URL).origin && location.pathname === '/' && !page.__RAYRAG__) {
  const sessionId = crypto.randomUUID();
  const NativeSocket = window.WebSocket;
  const maintenance=new MaintenanceLease();
  let maintenanceNonce:string|null=null;
  let receiveQueue=Promise.resolve();
  let officialUncertain=false;
  let officialRevision=0;
  const officialOwners=new Set<WebSocket>();
  let officialOwnerOverflow=false;
  let leaseRevision:number|null=null;
  const mutation=(kind:'frame'|'socket'|'page'='frame')=>{
    maintenance.mutate();
    if(maintenanceNonce)void page.__TAURI_INTERNALS__?.invoke('update_invalidate',{nonce:maintenanceNonce,kind}).catch(()=>{});
  };
  let probingLease=false;
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
    maintenance.assertDispatch();
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    const packet = action.type === 'walk' ? walkCommand(action.destination)
      : action.type === 'attack' || action.type === 'pickup' || action.type === 'stop'
        ? command(action.type, 'id' in action ? action.id : undefined)
        : (() => {
          try { return featureCommand(validateExpandedAction(action)); }
          catch { return worldCommand(validateWorldAction(action)); }
        })();
    NativeSocket.prototype.send.call(active, Uint8Array.from(packet));
  }, Date.now, undefined, action => {
    maintenance.assertDispatch();
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    NativeSocket.prototype.send.call(active, socialCommand(action));
  }, slot => {
    maintenance.assertDispatch();
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    NativeSocket.prototype.send.call(active, memoCommand(slot));
  }, action => {
    maintenance.assertDispatch();
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    NativeSocket.prototype.send.call(active, socketCommand(action));
  });
  const engine = controller.engine;
  const publish = () => {
    if (!page.__TAURI_INTERNALS__ || publishing) return;
    publishing = true;
    page.__TAURI_INTERNALS__.invoke('bridge_status', { status: {
      ...controller.snapshot(), sessionId, connectionId, maintenanceWaiting:officialUncertain, login: login?.status ?? loginStatus,
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
    if (maintenance.blocked || claimStarted || loginCancelled || !unityClient || !page.__TAURI_INTERNALS__) return;
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
    send(data: string | Blob | BufferSource): void {
      // Suppress every payload on the owned socket during final settlement,
      // before even inspecting opcodes. No replay/queue and no body logging.
      if(this.gameSocket&&maintenance.blocked)return;
      if(this.gameplayReady&&this.readyState===NativeSocket.OPEN&&page.buildUrl===VERIFIED_BUILD&&couldOwnOfficialGameplay(data)) {
        officialRevision++;officialUncertain=true;
        if(officialOwners.size<32||officialOwners.has(this))officialOwners.add(this);else officialOwnerOverflow=true;
        mutation();
      }
      if (active === this && this.readyState === NativeSocket.OPEN && engine.connected && engine.compatible && page.buildUrl === VERIFIED_BUILD
        && engine.actorActionIdentity(undefined,true) && isOfficialGameplayCommand(data)) {
        // Only a current official action takes over the field controller. An
        // obsolete/opaque transport still fences updater availability above.
        try { controller.manualCommand(); publish(); } catch { /* Never prevent or replay the official send. */ }
      }
      super.send(data);
    }
    private readonly gameSocket:boolean;
    private gameplayReady=false;
    constructor(url: string | URL, protocols?: string | string[]) {
      super(url, protocols);
      this.gameSocket=String(url)===SOCKET_URL;
      if (!this.gameSocket) return;
      mutation('socket');
      connectionId = crypto.randomUUID();
      // Retain the requested run while a new verified connection prepares its state.
      controller.pause('Opening game session.');
      active = this;
      let failed = false;
      let initialEnter=false;let fullResources=false;let enterCount=0;let reconciliationEligible=false;let reconciliationRevision:number|null=null;let readyOwn:string|null=null;
      let opcode = -1;
      let connectionGeneration = -1;
      let queue = Promise.resolve();receiveQueue=queue;
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
          mutation();
          controller.receive(data, connectionGeneration);
          if(engine.actorActionIdentity(undefined,true))this.gameplayReady=true;
          if(data[0]===OP.enter){enterCount++;initialEnter=enterCount===1;fullResources=false;readyOwn=null;reconciliationEligible=initialEnter&&officialUncertain&&!officialOwnerOverflow&&officialOwners.size===0;reconciliationRevision=reconciliationEligible?officialRevision:null;}
          if(data[0]===OP.clear||data[0]===OP.map){reconciliationEligible=false;readyOwn=null;}
          if(initialEnter&&data[0]===56){const events=decode(data);fullResources=events.some(e=>e.type==='inventory')&&events.some(e=>e.type==='skills')&&events.some(e=>e.type==='stats');}
          if(initialEnter&&data[0]===OP.spawn){const own=decode(data).find(e=>e.type==='spawn'&&e.entity.kind===0&&e.entity.id===engine.playerId);
            if(own?.type==='spawn'){const identity=engine.actorActionIdentity(undefined,true);readyOwn=fullResources&&own.entryType===1&&identity?JSON.stringify(identity):null;}}
          // A new, complete initialization restores availability, never an old
          // request's outcome. Same-socket map changes and timers cannot do this.
          if(officialUncertain&&!officialOwnerOverflow&&officialOwners.size===0&&reconciliationEligible&&reconciliationRevision===officialRevision&&fullResources&&readyOwn!==null&&readyOwn===JSON.stringify(engine.actorActionIdentity(undefined,true))&&controller.settledForMaintenance()){
            officialUncertain=false;officialOwners.clear();reconciliationEligible=false;reconciliationRevision=null;readyOwn=null;
          }
          if (engine.player) { enteredWorld = true; login?.complete(); }
        }).catch(error => {
          if (active !== this) return;
          failed = true;
          const detail = error instanceof Error ? error.message.slice(0,80) : 'Decode error';
          controller.fail(`Packet ${opcode}: ${detail}. Reopen the game after updating Companion.`); publish();
        });
        receiveQueue=queue;
      });
      this.addEventListener('close', () => {
        officialOwners.delete(this);
        if (active === this) { mutation('socket');active = undefined; login?.disconnect(); controller.disconnect(); publish(); }
      });
      this.addEventListener('error', () => { if (active === this) { controller.pause('Waiting for the game connection.'); publish(); } });
    }
  };

  page.__RAYRAG__ = {
    control(action, settings, escapeGuard, supplyGuard, recoveryGuard) {
      maintenance.assertDispatch();mutation();
      if (action === 'heartbeat') { heartbeat = Date.now(); controller.heartbeat(true); return; }
      if (action === 'stop') { cancelLogin(); stop('Stopped by you.'); return; }
      try {
        if (page.buildUrl !== VERIFIED_BUILD) throw new Error('This game build is not verified.');
        if (!settings) throw new Error('Choose combat settings first.');
        controller.heartbeat(true); controller.start(settings, escapeGuard, supplyGuard, recoveryGuard); heartbeat = Date.now();
      } catch (error) { controller.engine.reason = error instanceof Error ? error.message : 'Could not start.'; }
      publish();
    },
    perform(action, request) {
      try {
        maintenance.assertDispatch();mutation();
        if (page.buildUrl !== VERIFIED_BUILD) throw new Error('This game build is not verified.');
        controller.perform(action, request); heartbeat = Date.now();
      } catch (error) { controller.engine.reason = error instanceof Error ? error.message : 'Could not perform this action.'; }
      publish();
    },
    maintenance(nonce,reserve) {
      if(reserve==='commit'){
        void receiveQueue.then(async()=>{
          if(maintenanceNonce!==nonce||leaseRevision===null||!maintenance.matches(nonce,leaseRevision)||!controller.settledForMaintenance()||!connectionId)return;
          await page.__TAURI_INTERNALS__?.invoke('update_final_ack',{nonce,identity:{sessionId,connectionId},revision:leaseRevision}).catch(()=>{});
        });return;
      }
      if(!reserve){maintenance.release(nonce);if(maintenanceNonce===nonce)maintenanceNonce=null;return;}
      const settled=()=>active?.readyState===NativeSocket.OPEN&&page.buildUrl===VERIFIED_BUILD&&!officialUncertain
        &&controller.settledForMaintenance()&&!['signingIn','selecting','entering'].includes((login?.status??loginStatus).phase);
      const revision=maintenance.reserve(nonce,settled());if(revision===null)return;
      maintenanceNonce=nonce;leaseRevision=revision;
      void receiveQueue.then(async()=>{
        if(!maintenance.matches(nonce,revision)||!settled()||!connectionId){maintenance.release(nonce);maintenanceNonce=null;return;}
        maintenance.hold(nonce,revision);
        try {const accepted=await page.__TAURI_INTERNALS__?.invoke('update_ack',{nonce,identity:{sessionId,connectionId},revision});if(accepted!==true){maintenance.release(nonce);maintenanceNonce=null;}}
        catch {/* Keep dispatch frozen until native proves this nonce is released. */}
      });
    },
    snapshot: () => controller.snapshot(),
  };
  const manualInput = (event: Event) => {
    if (!event.isTrusted || maintenance.blocked) return;
    // A map refresh briefly removes the player; it is not a new login attempt.
    if (!enteredWorld) cancelLogin();
    controller.manualInput(); publish();
  };
  document.addEventListener('pointerdown', manualInput, true);
  document.addEventListener('keydown', manualInput, true);
  window.addEventListener('pagehide', () => {mutation('page');if(!maintenance.blocked)stop('Game page closed.');});
  setInterval(() => {
    try {
      if(maintenanceNonce&&!probingLease&&page.__TAURI_INTERNALS__){
        probingLease=true;const nonce=maintenanceNonce;
        void page.__TAURI_INTERNALS__.invoke('update_lease_alive',{nonce}).then(alive=>{if(alive===false){maintenance.release(nonce);if(maintenanceNonce===nonce)maintenanceNonce=null;}}).catch(()=>{}).finally(()=>{probingLease=false;});
      }
      if(maintenance.blocked)return;
      claimLogin();
      login?.tick();
      if (controller.active && Date.now() - heartbeat > 6000) controller.heartbeat(false);
      controller.tick();
    } catch { controller.pause('Waiting after a connection error.'); }
    if (Date.now() - lastPublished >= 500) { lastPublished = Date.now(); publish(); }
  }, 100);
}

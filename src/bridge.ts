import { initializationCertificate, initializationResetCandidate, initializationResetAllowed, initializationIdentityCurrent } from './runtime-initialization-policy';
import type { DeathRecoveryGuard } from './death-recovery';
import { MaintenanceLease } from './maintenance';
import { couldOwnOfficialGameplay, isOfficialGameplayCommand, isOfficialLookCommand, isOfficialMovementCommand, isOfficialRefineCommand } from './official-input';
import { type Settings } from './engine';
import { OP, GAME_URL, SOCKET_URL, VERIFIED_BUILD } from './protocol';
import { officialWarpSkill, warpInitializationPacket } from './warp-protocol';
import type { CompanionSnapshot } from './controller';
import type { ControllerUpdateCheckpoint, ControllerUpdateRestore } from './controller-update';
import { wireController } from './controller-wire';
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
    perform: (action: 'command' | 'workflow' | 'routine' | 'macro' | 'service' | 'social' | 'memo' | 'socketPreview' | 'socket' | 'refinePreview' | 'refine' | 'refineAdvance' | 'warp' | 'warpPreview' | 'warpCancel', request: unknown) => void;
    maintenance:(nonce:string,reserve:boolean|'commit')=>void;
    prepareUpdate:(requestId:string)=>void;
    cancelUpdate:(requestId:string)=>void;
    restoreUpdate:(payload:ControllerUpdateRestore)=>void;
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
  let retryInitialization=()=>{};
  let officialUncertain=false;
  let officialRevision=0;
  const officialOwners=new Set<WebSocket>();
  let officialOwnerOverflow=false;
  let leaseRevision:number|null=null;
  let updateRequest:{id:string;checking:boolean;prepared:boolean}|null=null;
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
  const guardHeldAtStart=localStorage.getItem('rayrag.warp.uncertain.v1')!==null;
  let guardResetAllowed=false;
  let guardNonce:string|null=null;
  const guardWrites=new Set<Promise<unknown>>();
  const guardReady=page.__TAURI_INTERNALS__?page.__TAURI_INTERNALS__.invoke('warp_guard_initialize',{legacyHeld:guardHeldAtStart}).then(value=>{
    if(typeof value==='string'){guardNonce=value;localStorage.setItem('rayrag.warp.uncertain.v1','held');if(!controller.warp.blocked){controller.warp.externalWarp();controller.warp.connectionChanged(engine.connected);}}
  }).catch(()=>{controller.engine.reason='Connection recovery guard unavailable.';}):Promise.resolve();
  guardWrites.add(guardReady);void guardReady.finally(()=>guardWrites.delete(guardReady));
  const controller = wireController(packet => {
    maintenance.assertDispatch();
    if (active?.readyState !== NativeSocket.OPEN) throw new Error('Game connection is closed.');
    NativeSocket.prototype.send.call(active, Uint8Array.from(packet));
  }, {
    // A bounded uncertainty marker only. Never persist commands, cells or memo data.
    read:()=>localStorage.getItem('rayrag.warp.uncertain.v1')!==null,
    write:held=>{
      if(!held&&(guardHeldAtStart||guardNonce!==null)&&!guardResetAllowed)throw new Error('Authoritative first-entry certificate is incomplete.');
      if(held)localStorage.setItem('rayrag.warp.uncertain.v1','held');else localStorage.removeItem('rayrag.warp.uncertain.v1');
      if(!held&&guardNonce&&connectionId){const task=Promise.resolve(publish()).then(()=>page.__TAURI_INTERNALS__?.invoke('warp_guard_clear',{permit:guardNonce,identity:{sessionId,connectionId}}));guardWrites.add(task);void task.catch(()=>{}).finally(()=>guardWrites.delete(task));}
    },
  });
  const engine = controller.engine;
  const runtimeStatus=(status=controller.snapshot())=>({...status,sessionId,connectionId,maintenanceWaiting:officialUncertain,
    login:login?.status??loginStatus,mapInfo:currentMapInfo(engine.map,engine.entities.values(),catalog,catalogLoading),
    reconnectAvailable:false,build:page.buildUrl??'',connectionMode:'gameClient'});
  const checkpoint=():ControllerUpdateCheckpoint|null=>{const value=controller.updateCheckpoint();return value?{...value,status:runtimeStatus(value.status)}:null;};
  const confirmPrepared=()=>{
    const request=updateRequest;
    if(!request||request.checking||request.prepared||maintenance.blocked)return;
    request.checking=true;
    void receiveQueue.then(async()=>{
      if(updateRequest!==request||guardWrites.size>0||officialUncertain||active?.readyState!==NativeSocket.OPEN
        ||!connectionId||page.buildUrl!==VERIFIED_BUILD||['signingIn','selecting','entering'].includes((login?.status??loginStatus).phase))return;
      const value=checkpoint();if(!value)return;
      request.prepared=true;
      await page.__TAURI_INTERNALS__?.invoke('update_prepared',{requestId:request.id,checkpoint:value});
    }).catch(()=>{}).finally(()=>{request.checking=false;});
  };
  const publish = () => {
    if (!page.__TAURI_INTERNALS__ || publishing) return;
    publishing = true;
    return page.__TAURI_INTERNALS__.invoke('bridge_status', { status:runtimeStatus() })
      .then(()=>{}).catch(() => { if (controller.active) controller.heartbeat(false); })
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
    private observedQueue=guardReady;
    private readyObserved=false;
    private runtimeGeneration=-1;
    private observationRevision=0;
    send(data: string | Blob | BufferSource): void {
      // Suppress every payload on the owned socket during final settlement,
      // before even inspecting opcodes. No replay/queue and no body logging.
      if(this.gameSocket&&maintenance.blocked)return;
      const warpBytes=data instanceof ArrayBuffer?new Uint8Array(data):ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):null;
      if(this.gameSocket&&active===this&&this.readyState===NativeSocket.OPEN&&page.buildUrl===VERIFIED_BUILD&&warpBytes&&officialWarpSkill(warpBytes)&&page.__TAURI_INTERNALS__){
        const copy=warpBytes.slice(),generation=controller.connectionGeneration;
        officialRevision++;officialUncertain=true;
        if(officialOwners.size<32||officialOwners.has(this))officialOwners.add(this);else officialOwnerOverflow=true;
        mutation();if(engine.actorActionIdentity(undefined,true)&&isOfficialGameplayCommand(copy))controller.manualCommand(isOfficialMovementCommand(copy));controller.observeOfficialPacket(copy);
        const task=page.__TAURI_INTERNALS__.invoke('warp_guard_mark',{}).then(value=>{
          if(typeof value!=='string')throw new Error('Warp recovery guard unavailable.');
          if(active!==this||generation!==controller.connectionGeneration||this.readyState!==NativeSocket.OPEN||maintenance.blocked)return;
          NativeSocket.prototype.send.call(this,copy);
        }).catch(()=>{if(active===this){controller.engine.reason='Warp was not sent because its recovery guard could not be saved.';publish();}});
        guardWrites.add(task);void task.finally(()=>guardWrites.delete(task));return;
      }
      if(this.gameSocket&&(this.gameplayReady||isOfficialRefineCommand(data))&&this.readyState===NativeSocket.OPEN&&page.buildUrl===VERIFIED_BUILD&&couldOwnOfficialGameplay(data)) {
        officialRevision++;officialUncertain=true;
        if(officialOwners.size<32||officialOwners.has(this))officialOwners.add(this);else officialOwnerOverflow=true;
        mutation();
        if(isOfficialRefineCommand(data))controller.officialRefineCommand(this.gameplayCharacter);
      }
      if (active === this && this.readyState === NativeSocket.OPEN && engine.connected && engine.compatible && page.buildUrl === VERIFIED_BUILD
        &&engine.actorActionIdentity()&&isOfficialLookCommand(data)) {
        try {controller.officialLook();publish();} catch { /* Never prevent or replay the official send. */ }
      }
      if (active === this && this.readyState === NativeSocket.OPEN && engine.connected && engine.compatible && page.buildUrl === VERIFIED_BUILD
        && engine.actorActionIdentity(undefined,true) && isOfficialGameplayCommand(data)) {
        // Current official actions reconcile a requested run. An
        // obsolete/opaque transport still fences updater availability above.
        try { controller.manualCommand(isOfficialMovementCommand(data)); publish(); } catch { /* Never prevent or replay the official send. */ }
      }
      if (active===this && this.readyState===NativeSocket.OPEN && page.buildUrl===VERIFIED_BUILD) {
        const bytes=data instanceof ArrayBuffer?new Uint8Array(data):ArrayBuffer.isView(data)?new Uint8Array(data.buffer,data.byteOffset,data.byteLength):null;
        if(bytes && ((bytes[0]===2&&bytes.length===1)||(bytes[0]===3&&bytes.length<=106)||(bytes[0]===29&&bytes.length<=8))){
          const copy=bytes.slice();
          // Mark external Warp synchronously; serialize initialization with
          // inbound resource/memo evidence before accepting the Ready transcript.
          if(officialWarpSkill(copy)){try{controller.observeOfficialPacket(copy);}catch{}}
          else if(warpInitializationPacket(copy)){
            this.observationRevision++;
            this.observedQueue=this.observedQueue.then(()=>{if(active===this&&this.runtimeGeneration===controller.connectionGeneration){controller.observeOfficialPacket(copy);if(copy[0]===2)this.readyObserved=true;}});
            receiveQueue=this.observedQueue;
          }
        }
      }
      super.send(data);
    }
    private readonly gameSocket:boolean;
    private gameplayReady=false;
    private gameplayCharacter:string|null=null;
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
      let initialEnter=false;let memoObserved=false;let firstOwnSeen=false;let fullResources=false;let enterCount=0;let reconciliationEligible=false;let reconciliationRevision:number|null=null;let readyOwn:string|null=null;
      let refineResources:string|null=null;let resetResources:string|null=null;let firstResources=false;let refineBaselineConsumed=false;
      let opcode = -1;
      let connectionGeneration = -1;
      let initializationRetryQueued=false;
      const reconcileInitialization=(revision:number)=>{
        if(revision!==this.observationRevision||active!==this||failed||this.readyState!==NativeSocket.OPEN||connectionGeneration!==controller.connectionGeneration||maintenance.blocked)return;
        // A timer may recheck retained first-initialization evidence after grace
        // or readiness changes. It never supplies missing reset/resource proof.
        if(officialUncertain&&!officialOwnerOverflow&&officialOwners.size===0&&reconciliationEligible&&reconciliationRevision===officialRevision&&initializationIdentityCurrent(fullResources,readyOwn,JSON.stringify(engine.actorActionIdentity(undefined,true)),false,false)){
          if(!refineBaselineConsumed){
            if(controller.warp.blocked){if(resetResources!==null&&controller.reconcileOfficialInitialization(resetResources))refineBaselineConsumed=true;}
            else{refineBaselineConsumed=true;if(refineResources!==null)controller.reconcileOfficialRefineInitialization(refineResources);}
          }
          if(controller.settledForMaintenance()){
            officialUncertain=false;officialOwners.clear();reconciliationEligible=false;reconciliationRevision=null;readyOwn=null;
          }
        }
      };
      retryInitialization=()=>{
        if(active!==this||failed||maintenance.blocked||initializationRetryQueued)return;
        initializationRetryQueued=true;
        const generation=connectionGeneration,revision=this.observationRevision;
        this.observedQueue=this.observedQueue.then(()=>{
          initializationRetryQueued=false;
          if(generation!==controller.connectionGeneration)return;
          reconcileInitialization(revision);
        }).catch(()=>{initializationRetryQueued=false;});
        receiveQueue=this.observedQueue;
      };
      receiveQueue=this.observedQueue;
      this.addEventListener('open', () => {
        if (active !== this) return;
        controller.connect(page.buildUrl === VERIFIED_BUILD);
        connectionGeneration=controller.connectionGeneration;this.runtimeGeneration=connectionGeneration;publish();
      });
      this.addEventListener('message', event => {
        if (active !== this || failed) return;
        const revision=++this.observationRevision;
        this.observedQueue = this.observedQueue.then(async () => {
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
          const observation=controller.receive(data,connectionGeneration,before=>{
            const firstOwn=before.spawns.find(e=>e.kind===0&&e.id===engine.playerId);
            if(firstOwn&&!firstOwnSeen){firstOwnSeen=true;
              const certificate=initializationCertificate({initial:initialEnter,fullResources,memo:memoObserved,readyObserved:this.readyObserved});
              if(initializationResetCandidate(certificate,firstOwn.entryType,resetResources)
                &&initializationResetAllowed(certificate,firstOwn.entryType,resetResources,controller.officialInitializationResourceRevision()))guardResetAllowed=true;}
          });
          if(!observation)return;
          if(engine.actorActionIdentity(undefined,true)){this.gameplayReady=true;this.gameplayCharacter=engine.player?.name??null;}
          if(observation.enter){enterCount++;initialEnter=enterCount===1;memoObserved=false;firstOwnSeen=false;this.readyObserved=false;guardResetAllowed=false;fullResources=false;readyOwn=null;refineResources=null;resetResources=null;firstResources=false;refineBaselineConsumed=false;reconciliationEligible=initialEnter&&officialUncertain&&!officialOwnerOverflow&&officialOwners.size===0;reconciliationRevision=reconciliationEligible?officialRevision:null;}
          if(observation.clear||observation.map){reconciliationEligible=false;readyOwn=null;}
          if(initialEnter&&observation.opcode===56&&!firstResources){firstResources=true;fullResources=observation.fullResources;
            if(fullResources){refineResources=controller.officialRefineResourceRevision();resetResources=controller.officialInitializationResourceRevision();}}
          if(initialEnter&&observation.memoSlots)memoObserved=true;
          if(initialEnter&&observation.opcode===OP.spawn){const own=observation.spawns.find(e=>e.kind===0&&e.id===engine.playerId);
            if(own){const identity=engine.actorActionIdentity(undefined,true);readyOwn=fullResources&&own.entryType===1&&identity?JSON.stringify(identity):null;}}
          reconcileInitialization(revision);
          if (engine.player) { enteredWorld = true; login?.complete(); }
        }).catch(error => {
          if (active !== this) return;
          failed = true;
          const detail = error instanceof Error ? error.message.slice(0,80) : 'Decode error';
          controller.fail(`Packet ${opcode}: ${detail}. Reopen the game after updating Companion.`); publish();
        });
        receiveQueue=this.observedQueue;
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
      if (action === 'heartbeat') { heartbeat = Date.now(); controller.heartbeat(true);retryInitialization();return; }
      if (action === 'stop') { updateRequest=null;cancelLogin(); stop('Stopped by you.'); return; }
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
          if(maintenanceNonce!==nonce||leaseRevision===null||!maintenance.matches(nonce,leaseRevision)||guardWrites.size>0||!controller.settledForMaintenance()||!connectionId)return;
          const finalCheckpoint=checkpoint();
          await page.__TAURI_INTERNALS__?.invoke('update_final_ack',{nonce,identity:{sessionId,connectionId},revision:leaseRevision,...(finalCheckpoint?{checkpoint:finalCheckpoint}:{})}).catch(()=>{});
        });return;
      }
      if(!reserve){maintenance.release(nonce);if(maintenanceNonce===nonce)maintenanceNonce=null;return;}
      const settled=()=>active?.readyState===NativeSocket.OPEN&&page.buildUrl===VERIFIED_BUILD&&!officialUncertain
        &&guardWrites.size===0&&controller.settledForMaintenance()&&!['signingIn','selecting','entering'].includes((login?.status??loginStatus).phase);
      const revision=maintenance.reserve(nonce,settled());if(revision===null)return;
      maintenanceNonce=nonce;leaseRevision=revision;
      void receiveQueue.then(async()=>{
        if(!maintenance.matches(nonce,revision)||!settled()||!connectionId){maintenance.release(nonce);maintenanceNonce=null;return;}
        maintenance.hold(nonce,revision);
        try {const accepted=await page.__TAURI_INTERNALS__?.invoke('update_ack',{nonce,identity:{sessionId,connectionId},revision});if(accepted!==true){maintenance.release(nonce);maintenanceNonce=null;}}
        catch {/* Keep dispatch frozen until native proves this nonce is released. */}
      });
    },
    prepareUpdate(requestId){
      if(!/^[a-f0-9]{32}$/.test(requestId)||maintenance.blocked||updateRequest&&updateRequest.id!==requestId)return;
      if(!updateRequest){mutation();updateRequest={id:requestId,checking:false,prepared:false};controller.prepareUpdate();}
      confirmPrepared();publish();
    },
    cancelUpdate(requestId){
      if(updateRequest?.id!==requestId)return;
      updateRequest=null;controller.cancelUpdate();heartbeat=Date.now();publish();
    },
    restoreUpdate(payload){
      if(!payload||!/^[a-f0-9]{32}$/.test(payload.requestId))return;
      let success=false;
      try {maintenance.assertDispatch();mutation();controller.restoreUpdate(payload.checkpoint,payload.settings,payload.escapeGuard,payload.supplyGuard,payload.deathRecoveryGuard);heartbeat=Date.now();success=true;}
      catch(error){engine.reason=error instanceof Error?error.message:'Update continuation rejected.';}
      void page.__TAURI_INTERNALS__?.invoke('update_restored',{requestId:payload.requestId,success}).catch(()=>{});publish();
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
      confirmPrepared();
      retryInitialization();
    } catch { controller.pause('Waiting after a connection error.'); }
    if (Date.now() - lastPublished >= 500) { lastPublished = Date.now(); publish(); }
  }, 100);
}

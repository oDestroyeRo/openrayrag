import { wireController } from './controller-wire';
import type { CompanionController } from './controller';
import { decode, OP } from './protocol';
import { MaintenanceLease } from './maintenance';
import type { LoginStatus } from './login';
import { currentMapInfo, type MapCatalog } from './map-data';

export type DirectEvent = {kind:'opened'}|{kind:'readySent'}|{kind:'enterSent'|'frame';bytes:number[]}|{kind:'closed';reason:string}|{kind:'failed';reason:string};
export interface RuntimePort {
  invoke(name:string,args:unknown):Promise<unknown>;
  store:ConstructorParameters<typeof CompanionController>[8];
  now?:()=>number;
  guardNonce?:string;
}
interface MaintenanceOwner {nonce:string;revision:number}
interface MaintenanceRequest {owner:MaintenanceOwner;commit:boolean;checking:boolean}
/** Transport projection only: both modes retain the same controller and action policies. */
export class DirectRuntime {
  readonly controller:CompanionController;
  private readonly lease:MaintenanceLease;
  private readonly now:()=>number;
  private queue=Promise.resolve();
  private writes=new Set<Promise<unknown>>();
  private polling=false;
  private opened=false;
  private ended=false;
  private heartbeat=0;
  private login:LoginStatus={phase:'signingIn',message:'Opening verified bot connection.'};
  private entered=false;
  private enterCount=0;
  private initial=false;
  private full=false;
  private memo=false;
  private readyPending=false;
  private firstResources=false;
  private firstOwnSeen=false;
  private resources:string|null=null;
  private refineResources:string|null=null;
  private own:string|null=null;
  private certificate=false;
  private resetAllowed=false;
  private initializationHeld=false;
  private nonce:string|null=null;
  private maintenanceOwner:MaintenanceOwner|null=null;
  private pendingMaintenance:MaintenanceRequest|null=null;
  private probing=false;
  private publishing=false;
  private lastPublished=0;
  catalog:MapCatalog|null=null;
  catalogLoading=false;
  constructor(private readonly port:RuntimePort,readonly sessionId=crypto.randomUUID(),readonly connectionId=crypto.randomUUID()){
    this.now=port.now??Date.now;
    this.lease=new MaintenanceLease(this.now);
    this.initializationHeld=port.store?.read()===true;
    this.controller=wireController(packet=>{this.lease.assertDispatch();if(!this.opened||this.ended)throw new Error('Bot connection closed.');void this.send(packet).catch(()=>{});},{read:()=>port.store?.read()??false,write:held=>{
      if(!held&&this.initializationHeld&&!this.resetAllowed)throw new Error('Authoritative first-entry certificate is incomplete.');
      port.store?.write(held);
      if(!held&&this.port.guardNonce){const task=this.publish().then(()=>this.port.invoke('warp_guard_clear',{identity:this.args(),permit:this.port.guardNonce}));
        this.writes.add(task);void task.catch(()=>{}).finally(()=>this.writes.delete(task));}
    }},this.now);
  }
  private args(extra:Record<string,unknown>={}){return {sessionId:this.sessionId,connectionId:this.connectionId,...extra};}
  async connect():Promise<void>{
    try{await this.port.invoke('direct_connect',this.args());}
    catch{this.terminal('Explicit sign-in is required. Reconnect this account from the client.',false);}
  }
  private mutate(){this.pendingMaintenance=null;this.lease.mutate();if(this.nonce)void this.port.invoke('update_invalidate',{nonce:this.nonce,kind:'frame'}).catch(()=>{});}
  private send(packet:Uint8Array):Promise<unknown>{
    this.lease.assertDispatch();
    if(!this.opened||this.ended)throw new Error('Bot connection closed.');
    const task=this.port.invoke('direct_send',this.args({bytes:Array.from(packet)}));this.writes.add(task);
    void task.catch(()=>this.terminal('Transport write failed. Pending outcomes remain unresolved.',true)).finally(()=>this.writes.delete(task));
    return task;
  }
  private terminal(reason:string,retryable:boolean){
    if(this.ended)return;this.mutate();this.ended=true;this.opened=false;
    this.login=this.entered?{phase:'complete',message:'Connection closed.'}:{phase:'failed',message:retryable?'Game disconnected during sign-in. Try reconnecting.':reason};
    this.controller.disconnect();this.controller.engine.reason=reason;void this.publish();
  }
  /** Native has already discarded credentials, approval bodies and optional token bytes. */
  receive(events:DirectEvent[]):Promise<void>{
    this.queue=this.queue.then(async()=>{for(const event of events){if(this.ended)break;await this.apply(event);}}).catch(()=>this.terminal('Unverified game packet. Update Companion before reconnecting.',false));
    return this.queue;
  }
  private async apply(event:DirectEvent):Promise<void>{
    this.mutate();
    if(event.kind==='closed'||event.kind==='failed'){
      this.terminal(event.reason,event.kind==='closed'||/stream failed|timed out|TLS connection/.test(event.reason));return;
    }
    if(event.kind==='readySent'){if(!this.opened)throw new Error('Ready before connection');this.controller.observeOfficialPacket(new Uint8Array([2]));this.certificate=this.initial&&this.full&&this.memo;return;}
    if(event.kind==='opened'){
      if(this.opened)throw new Error('Duplicate connection');this.opened=true;
      this.controller.connect(true);this.login={phase:'selecting',message:'Selecting the requested existing character.'};return;
    }
    if(!this.opened)throw new Error('Frame before connection');
    const bytes=Uint8Array.from(event.bytes);
    if(event.kind==='enterSent'){
      if(this.enterCount||this.login.phase!=='selecting')throw new Error('Unexpected enter request');
      this.controller.observeOfficialPacket(bytes);this.login={phase:'entering',message:'Waiting for authoritative character state.'};return;
    }
    const events=decode(bytes);
    const ownEntry=events.find(e=>e.type==='spawn'&&e.entity.id===this.controller.engine.playerId&&e.entity.kind===0);
    if(ownEntry?.type==='spawn'&&!this.firstOwnSeen){this.firstOwnSeen=true;
      if(this.initial&&this.certificate&&ownEntry.entryType===1&&this.resources!==null&&this.resources===this.controller.officialInitializationResourceRevision())this.resetAllowed=true;}
    this.controller.receive(bytes,this.controller.connectionGeneration);
    if(events.some(e=>e.type==='enter')){
      this.enterCount++;this.initial=this.enterCount===1;this.full=false;this.memo=false;this.firstResources=false;this.firstOwnSeen=false;
      this.resources=null;this.refineResources=null;this.own=null;this.certificate=false;this.readyPending=true;
    }
    if(events.some(e=>e.type==='map')){
      this.initial=false;this.readyPending=true;this.certificate=false;this.own=null;
    }
    if(events.some(e=>e.type==='clear')){this.certificate=false;this.own=null;}
    if(this.initial&&bytes[0]===56&&!this.firstResources){
      this.firstResources=true;this.full=events.some(e=>e.type==='inventory')&&events.some(e=>e.type==='skills')&&events.some(e=>e.type==='stats');
      if(this.full){this.resources=this.controller.officialInitializationResourceRevision();this.refineResources=this.controller.officialRefineResourceRevision();}
    }
    if(this.initial&&events.some(e=>e.type==='memoSlots'))this.memo=true;
    // Initial full resources and memo are sent before PlayerReady. Map changes need
    // their applied reset only. A duplicate/stale opcode never supplies this proof.
    if(this.readyPending&&(!this.initial||this.full&&this.memo)){
      this.readyPending=false;await this.send(new Uint8Array([2]));
      if(this.ended)return;
    }
    if(this.initial&&bytes[0]===OP.spawn){
      const own=events.find(e=>e.type==='spawn'&&e.entity.kind===0&&e.entity.id===this.controller.engine.playerId);
      const identity=this.controller.engine.actorActionIdentity(undefined,true);
      this.own=this.certificate&&own?.type==='spawn'&&own.entryType===1&&identity?JSON.stringify(identity):null;
    }
    this.reconcile();
    if(this.controller.engine.player){this.entered=true;this.login={phase:'complete',message:'Character connected. Bot controls are ready.'};}
  }
  private reconcile(){
    if(!this.certificate||!this.own||this.lease.blocked||this.ended||this.own!==JSON.stringify(this.controller.engine.actorActionIdentity(undefined,true)))return;
    if(this.controller.warp.blocked){if(this.resources!==null&&this.controller.reconcileOfficialInitialization(this.resources))this.certificate=false;}
    else if(this.refineResources!==null){this.controller.reconcileOfficialRefineInitialization(this.refineResources);this.certificate=false;}
  }
  async cycle():Promise<void>{
    if(this.polling||this.ended)return;this.polling=true;
    try{
      const batch=await this.port.invoke('direct_poll',this.args()) as {events:DirectEvent[];delivery:number|null};
      if(!batch||!Array.isArray(batch.events)||batch.events.length>16||batch.delivery!==null&&!Number.isSafeInteger(batch.delivery))throw new Error('Invalid native event batch');
      await this.receive(batch.events);
      if(batch.delivery!==null)await this.port.invoke('direct_observed',this.args({delivery:batch.delivery}));
      if(this.nonce&&!this.probing){this.probing=true;const nonce=this.nonce;
        const owner=this.maintenanceOwner;
        void this.port.invoke('update_lease_alive',{nonce}).then(alive=>{if(alive===false&&owner)this.releaseMaintenance(owner);}).catch(()=>{}).finally(()=>{this.probing=false;});}
      if(!this.ended&&!this.lease.blocked){
        if(this.controller.active&&this.now()-this.heartbeat>6000)this.controller.heartbeat(false);
        this.controller.tick();this.reconcile();
      }
      if(this.now()-this.lastPublished>=500){this.lastPublished=this.now();await this.publish();}
    }catch{this.terminal('Bot connection unavailable. Pending outcomes remain unresolved.',true);}
    finally{this.polling=false;this.confirmMaintenance();}
  }
  control(action:'start'|'stop'|'heartbeat',...args:Parameters<CompanionController['start']>):void{
    this.lease.assertDispatch();this.mutate();
    if(action==='heartbeat'){this.heartbeat=this.now();this.controller.heartbeat(true);return;}
    try{
      if(action==='stop'){this.controller.stop();}
      else {this.controller.heartbeat(true);this.controller.start(...args);this.heartbeat=this.now();}
    }catch(error){this.controller.engine.reason=error instanceof Error?error.message:'Command failed.';}
    void this.publish();
  }
  perform(...args:Parameters<CompanionController['perform']>):void{
    try{this.lease.assertDispatch();this.mutate();this.controller.perform(...args);this.heartbeat=this.now();}
    catch(error){this.controller.engine.reason=error instanceof Error?error.message:'Command failed.';}void this.publish();
  }
  maintenance(nonce:string,reserve:boolean|'commit'):void{
    if(!reserve){
      if(this.pendingMaintenance?.owner.nonce===nonce)this.pendingMaintenance=null;
      if(this.maintenanceOwner?.nonce===nonce)this.releaseMaintenance(this.maintenanceOwner);
      return;
    }
    if(reserve==='commit'){
      const owner=this.maintenanceOwner;
      if(!owner||owner.nonce!==nonce||!this.lease.matches(nonce,owner.revision))return;
      this.pendingMaintenance={owner,commit:true,checking:false};
    }else{
      if(this.lease.blocked||!this.maintenanceReady())return;
      this.pendingMaintenance={owner:{nonce,revision:this.lease.ownerRevision},commit:false,checking:false};
    }
    this.confirmMaintenance();
  }
  private maintenanceReady():boolean{
    return this.opened&&!this.ended&&this.writes.size===0&&this.login.phase==='complete'&&this.controller.settledForMaintenance();
  }
  private releaseMaintenance(owner:MaintenanceOwner):void{
    if(this.maintenanceOwner!==owner)return;
    this.lease.release(owner.nonce);this.nonce=null;this.maintenanceOwner=null;
    if(this.pendingMaintenance?.owner===owner)this.pendingMaintenance=null;
  }
  private confirmMaintenance():void{
    const request=this.pendingMaintenance;if(!request||request.checking||this.polling)return;
    const {owner,commit}=request,{nonce,revision}=owner;
    if(this.lease.ownerRevision!==revision||!this.maintenanceReady()){
      this.pendingMaintenance=null;if(!commit)this.releaseMaintenance(owner);return;
    }
    if(!commit&&this.maintenanceOwner!==owner){
      if(this.lease.reserve(nonce,true)!==revision){this.pendingMaintenance=null;return;}
      this.nonce=nonce;this.maintenanceOwner=owner;
    }
    request.checking=true;
    void this.queue.then(async()=>{
      // Includes each native flush promise. Native independently fences its queued
      // frames and pending writes while holding the update Gate lock.
      if(!commit)await Promise.allSettled([...this.writes]);
      if(this.pendingMaintenance!==request)return;
      request.checking=false;
      if(this.maintenanceOwner!==owner||!this.lease.matches(nonce,revision)){
        this.pendingMaintenance=null;if(!commit)this.releaseMaintenance(owner);return;
      }
      // receive() can finish before delivery observation or status publication.
      // Retry only after cycle's finally clears polling, retaining this owner.
      if(this.polling)return;
      this.pendingMaintenance=null;
      if(!this.maintenanceReady()){if(!commit)this.releaseMaintenance(owner);return;}
      if(commit){await this.port.invoke('update_final_ack',{nonce,identity:this.args(),revision}).catch(()=>{});return;}
      this.lease.hold(nonce,revision);
      try{if(await this.port.invoke('update_ack',{nonce,identity:this.args(),revision})!==true)this.releaseMaintenance(owner);}
      catch{/* Keep frozen until native proves the lease released. */}
    }).catch(()=>{/* Native release remains authoritative after a failed confirmation. */});
  }
  snapshot(){return this.controller.snapshot();}
  async publish(){
    if(this.publishing)return;this.publishing=true;
    try{await this.port.invoke('bridge_status',{status:{...this.controller.snapshot(),sessionId:this.sessionId,connectionId:this.connectionId,login:this.login,
      mapInfo:currentMapInfo(this.controller.engine.map,this.controller.engine.entities.values(),this.catalog,this.catalogLoading)}});}
    catch{if(this.controller.active)this.controller.heartbeat(false);}finally{this.publishing=false;}
  }
}

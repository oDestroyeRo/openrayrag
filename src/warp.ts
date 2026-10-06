import { actionConfirmationTimeout } from './automation-logic';
import type { MemoSlots } from './memo-protocol';
import type { GameEvent } from './protocol';
import { validateWarpRequest, type WarpBinding, type WarpRequest, type WarpWire, type WarpPreviewRequest } from './warp-protocol';

import { WARP_SELECTION_MS, WARP_RECOVERY, type WarpContext, type WarpGuardStore, type WarpSnapshot, type Attempt, equal, physical, slotsEqual } from './warp-logic';

export { WARP_SELECTION_MS, WARP_RECOVERY, type WarpContext, type WarpGuardStore, type WarpSnapshot } from './warp-logic';

/** Owns a single ground/activation pair. Nothing in observe/tick writes a game packet. */
export class ManualWarp {
  private prepared:WarpRequest|null=null;private generation=0;private held=false;private storageUnavailable=false;private attempt:Attempt|null=null;
  private state:WarpSnapshot['state']='idle';private reason='Preview a ground request. Portal creation will remain unconfirmed.';
  private selection:WarpSnapshot['selection']='unknown';private evidence='No resources submitted.';
  private death:{character:string;connection:number;inventory:boolean;sp:boolean;slots:MemoSlots|null}|null=null;
  private newSession:{inventory:boolean;sp:boolean;skills:boolean;memo:boolean;ready:boolean;spawned:boolean;character:string;actorId:number;connection:number;incarnation:number|null;world:string|null}|null=null;
  private enterAvailable=false;private enterRequested:string|null=null;private recoveredSlots:MemoSlots|null=null;
  constructor(private readonly send:(wire:WarpWire)=>void,private readonly now=Date.now,private readonly store?:WarpGuardStore){
    try{this.held=store?.read()??false;}catch{this.held=true;this.storageUnavailable=true;}
    if(this.held){this.state='stopped';this.reason='A prior Warp Portal request remains uncertain. '+WARP_RECOVERY;}
  }
  get blocked():boolean{return this.held;}
  get busy():boolean{return !!this.attempt&&!this.attempt.stopped&&!this.attempt.activated;}
  get revision():number{return this.generation;}
  /** Preview, sent stages and retired receipts all participate in the update lease. */
  settledForMaintenance():boolean{return !this.prepared&&!this.attempt&&!this.held&&!this.storageUnavailable;}
  connectionChanged(connected:boolean):void{
    this.cancel('Connection changed. '+WARP_RECOVERY);
    // A disconnected observation gap cannot preserve an old memo readback as
    // current. A new session must supply memo94 before any reset can release it.
    if(this.attempt)this.attempt.memoValid=false;
    this.enterAvailable=connected;this.enterRequested=null;this.newSession=null;this.death=null;
  }
  initialization(event:{type:'enterRequest';character:string}|{type:'playerReady'}):void {
    if(event.type==='enterRequest'){if(this.enterAvailable&&this.enterRequested===null)this.enterRequested=event.character;else{this.enterAvailable=false;this.newSession=null;}}
    else if(event.type==='playerReady'&&this.newSession){
      if(!this.newSession.ready&&this.newSession.inventory&&this.newSession.sp&&this.newSession.skills&&this.newSession.memo)this.newSession.ready=true;
      else this.newSession=null;
    }
  }
  externalWarp():void {this.newSession=null;this.enterAvailable=false;this.cancel('An external or unattributed Warp Portal action was observed. '+WARP_RECOVERY);try{this.hold();}catch{}this.state='stopped';}
  observeDeath(events:GameEvent[],c:WarpContext):void {
    if(c.binding&&(!this.attempt||this.attempt.character===c.character)&&events.some(event=>event.type==='death'&&event.id===c.binding!.actorId)){
      this.death={character:c.character,connection:c.connection,inventory:false,sp:false,slots:c.slots?structuredClone(c.slots):null};this.cancel('Own death clears server casts and selection. Waiting for ready revival and resource/memo reconciliation.');
    }
  }
  prepare(request:WarpPreviewRequest,c:WarpContext):void {
    this.tick(c);const snapshot=this.snapshot(c);
    if(request.type==='warpActivate'){if(!snapshot.activation)throw new Error('Destination activation is not ready.');this.prepared=snapshot.activation;return;}
    if(!snapshot.ready)throw new Error(snapshot.reason);
    if(request.slot>=snapshot.ready.level||!c.slots?.[request.slot])throw new Error('Choose a nonempty memo slot below the learned level.');
    if(!c.groundAllowed(request.target))throw new Error('Ground must be a different verified open cell in permitted range and field area.');
    this.prepared=validateWarpRequest({...request,preview:snapshot.ready});
  }
  cancel(reason:string):void{
    this.prepared=null;
    this.generation=Math.min(2147483647,this.generation+1);
    if(this.attempt){this.attempt.stopped=true;this.state=this.attempt.activated?'activationSent':'stopped';}
    this.reason=reason;
  }
  private hold():void{
    // Persist before transport. Failed persistence cannot permit a send.
    try{this.store?.write(true);}catch{this.held=true;this.storageUnavailable=true;this.state='stopped';throw new Error('Warp Portal uncertainty guard could not be stored. Nothing was sent.');}
    this.held=true;
  }
  /** Evidence for a certified fresh-runtime reset; this never retires a hold. */
  initializedSession(c:WarpContext):boolean {
    const init=this.newSession,b=c.binding;
    return !!(c.ready&&c.resourcesReady&&c.sp!==null&&c.gems!==null&&c.slots&&b&&init
      &&init.inventory&&init.sp&&init.skills&&init.memo&&init.ready&&init.spawned
      &&init.character===c.character&&init.connection===c.connection&&init.actorId===b.actorId&&init.incarnation===b.incarnation&&init.world===b.world);
  }
  private release(c:WarpContext,session:boolean):void{
    if(!c.ready||!c.idle||!c.resourcesReady||c.sp===null||c.gems===null)return;
    let recoveredSlots:MemoSlots|null=null;
    if(session){
      if(!this.initializedSession(c))return;
    }
    else{
      const p=this.attempt;if(!this.death||this.death.character!==c.character||!c.binding||this.death.connection!==c.binding.connectionEpoch)return;
      const memo=c.slots??this.death.slots??(p?.memoValid?p.slots:null);
      if(!memo){this.reason='Server action reset observed; a complete memo readback is still required.';return;}
      // A reset cancels actions, never reconstructs a missing spending readback.
      const resources=p?p.spObserved&&(!p.activated||p.inventoryObserved&&p.activationSpObserved):this.death.inventory&&this.death.sp;
      if(!resources){this.reason='Server action reset observed; authoritative inventory/SP evidence is still missing. '+WARP_RECOVERY;return;}
      if(!c.slots)recoveredSlots=structuredClone(memo);
    }
    try{this.store?.write(false);}catch{this.storageUnavailable=true;this.reason='Reset observed, but the uncertainty guard could not be cleared. Automation remains held.';return;}
    this.recoveredSlots=recoveredSlots;
    this.held=false;this.storageUnavailable=false;this.attempt=null;this.death=null;this.newSession=null;this.state='recovered';this.selection='cleared';this.generation=Math.min(2147483647,this.generation+1);
    this.reason='Verified action reset and ready resource/memo observations reconciled. No request was resumed.';
  }
  takeRecoveredMemo():MemoSlots|null{const slots=this.recoveredSlots;this.recoveredSlots=null;return slots;}
  private binding(c:WarpContext):WarpBinding|null{return c.binding?{...c.binding,generation:this.generation}:null;}
  private prerequisite(c:WarpContext,activation=false):string|null{
    if(!c.ready||!c.binding)return 'Enter a fresh alive verified character first.';
    if(!c.idle)return 'Wait for stationary movement, casts and all other owners to settle.';
    if(c.unavailable)return c.unavailable;
    if(!c.slots)return 'Wait for all four memo slots; CanMemo is not a casting requirement.';
    if(!c.resourcesReady||c.cost===null||c.sp===null||c.gems===null)return 'Verified inventory, equipment and SP are required.';
    if(!activation&&c.sp<c.cost)return 'Insufficient effective SP for the ground stage.';
    if(c.gems<=c.reserve)return 'Keep the configured Blue Gemstone reserve plus one available gemstone.';
    if(this.generation>=2147483647)return 'Warp Portal observation budget exhausted.';
    if(this.storageUnavailable)return 'Warp Portal uncertainty storage is unavailable.';
    return null;
  }
  dispatch(input:unknown,c:WarpContext):void{
    const request=validateWarpRequest(input);this.tick(c);
    if(!this.prepared||!equal(request,this.prepared))throw new Error('Warp preview is stale. Preview again.');this.prepared=null;
    if(request.type==='warpGround'){
      if(this.held)throw new Error('A previous Warp Portal request is still held. '+WARP_RECOVERY);
      const blocker=this.prerequisite(c);if(blocker)throw new Error(blocker);
      const binding=this.binding(c)!;
      if(!equal(binding,request.preview))throw new Error('Warp Portal preview is stale. Preview again.');
      if(request.slot>=binding.level||!c.slots![request.slot])throw new Error('Choose a nonempty memo slot below the observed learned level.');
      if(!c.groundAllowed(request.target)||request.target.x===binding.x&&request.target.y===binding.y)throw new Error('Choose a different verified open cell in stationary range, LOS and the permitted field area.');
      this.hold();const since=this.now();this.newSession=null;this.enterAvailable=false;this.death=null;
      this.attempt={request,character:c.character,slots:structuredClone(c.slots!),sp:c.sp!,gems:c.gems!,cost:c.cost!,since,deadline:since+actionConfirmationTimeout({type:'skill'}),selectionDeadline:since+WARP_SELECTION_MS,waiting:false,castObserved:false,executed:false,spObserved:false,settledAt:Infinity,stopped:false,activated:false,activationSince:null,activationWindowClosed:false,activationSpRevision:0,activationInventoryRevision:0,inventoryObserved:false,activationSpObserved:false,memoValid:true};
      this.state='groundSent';this.selection='unknown';this.evidence=`Ground prerequisite: ${c.cost} SP. Waiting for ordered SP readback. Activation may consume up to one Blue Gemstone, including failure.`;
      this.reason='Ground request submitted once. Waiting for own selection, exact execution and SP readback. '+WARP_RECOVERY;
      try{this.send({stage:'ground',level:binding.level,...request.target});}catch{this.cancel('Ground socket write is uncertain. Nothing will retry. '+WARP_RECOVERY);throw new Error('Ground socket write is uncertain; automation remains held.');}
      return;
    }
    const activation=this.activation(c);if(!activation||!equal(request,activation))throw new Error('Activation preview is unavailable or stale. Review a fresh activation preview.');
    const p=this.attempt!;p.activated=true;p.activationSince=this.now();p.deadline=this.now()+actionConfirmationTimeout({type:'skill'});p.activationSpRevision=c.binding!.spRevision;p.activationInventoryRevision=c.binding!.inventoryRevision;
    this.state='activationSent';this.reason='Activation submitted once; portal creation is unconfirmed. '+WARP_RECOVERY;
    this.evidence='Ground SP debit observed. Activation costs zero SP while selection is valid and may consume up to one Blue Gemstone, even on failure. Waiting for resource evidence only.';
    try{this.send({stage:'activate',slot:p.request.slot});}catch{this.cancel('Activation socket write is uncertain; creation unconfirmed. '+WARP_RECOVERY);throw new Error('Activation socket write is uncertain; nothing will retry.');}
  }
  private activation(c:WarpContext):WarpRequest|null{
    const p=this.attempt,b=this.binding(c);if(!p||p.stopped||p.activated||!p.waiting||!p.executed||!p.spObserved||this.now()<p.settledAt||this.now()>=p.selectionDeadline||!b||this.prerequisite(c,true))return null;
    if(!equal(physical(b),physical(p.request.preview))||b.inventoryRevision!==p.request.preview.inventoryRevision||b.spRevision!==p.request.preview.spRevision+1||c.sp!==p.sp-p.cost||c.gems!==p.gems||!c.groundAllowed(p.request.target)||p.request.target.x===b.x&&p.request.target.y===b.y)return null;
    return {type:'warpActivate',preview:b};
  }
  observe(events:GameEvent[],c:WarpContext):void{
    // Retire deadlines before a late receipt can advance the active stage.
    // Late evidence may still reconcile resources, but never restore intent.
    this.tick(c);
    // Only first Enter after an actual socket-open can start a new initialization barrier.
    for(const event of events){
      if(event.type==='enter'){
        const eligible=this.enterAvailable&&this.enterRequested!==null;this.enterAvailable=false;this.cancel('Character entry invalidated Warp intent. '+WARP_RECOVERY);
        if(this.attempt)this.attempt.memoValid=false;
        this.death=null;this.newSession=eligible?{inventory:false,sp:false,skills:false,memo:false,ready:false,spawned:false,character:this.enterRequested!,actorId:event.id,connection:c.connection,incarnation:null,world:null}:null;
      }
      if(this.newSession){
        if(event.type==='inventory')this.newSession.inventory=true;
        if(event.type==='stats'&&event.sp!==undefined)this.newSession.sp=true;
        if(event.type==='skills'&&event.learned)this.newSession.skills=true;
        if(event.type==='memoSlots')this.newSession.memo=true;
        if(event.type==='spawn'&&event.entity.id===this.newSession.actorId){
          if(this.newSession.ready&&!this.newSession.spawned&&event.entity.kind===0&&!event.entity.dead&&event.entity.hp>0&&event.entity.name===this.newSession.character&&c.binding){
            this.newSession.spawned=true;this.newSession.incarnation=c.binding.incarnation;this.newSession.world=c.binding.world;
          }else this.newSession=null;
        }
        if(event.type==='map'||event.type==='clear')this.newSession=null;
      }
      const p=this.attempt;
      if(event.type==='death')this.observeDeath([event],c);
      if(this.death&&(!c.character||this.death.character===c.character)&&c.connection===this.death.connection){
        if(event.type==='inventory')this.death.inventory=true;
        if(event.type==='stats'&&event.sp!==undefined)this.death.sp=true;
        if(event.type==='serverEvent'&&event.event===8)this.death.slots=null;
        if(event.type==='memoSlots')this.death.slots=structuredClone(event.slots);
      }
      if(!p){if(event.type==='warpState'&&event.state===1||event.type==='skillResult'&&event.skillId===55&&event.source===c.binding?.actorId)this.externalWarp();continue;}
      if(event.type==='memoSlots'&&!slotsEqual(event.slots,p.slots))p.memoValid=false;
      if(event.type==='serverEvent'&&event.event===8)p.memoValid=false;
      const b=c.binding;
      const lifetime=!!b&&b.world===p.request.preview.world&&b.actorId===p.request.preview.actorId&&b.incarnation===p.request.preview.incarnation&&b.connectionEpoch===p.request.preview.connectionEpoch;
      if(event.type==='warpState'){
        this.selection=event.state===1?'waiting':'cleared';
        if(!lifetime||event.state===0||p.waiting||p.executed){this.cancel('Selection observation is cleared, duplicate or ambiguous. No activation is permitted. '+WARP_RECOVERY);}
        else p.waiting=true;
      }
      if(event.type==='castStart'&&event.id===p.request.preview.actorId){
        if(!lifetime||p.castObserved||event.skillId!==55||event.level!==p.request.preview.level||!equal(event.targetPosition,p.request.target))this.cancel('Own cast start is ambiguous or contradicts the captured ground request. '+WARP_RECOVERY);
        else p.castObserved=true;
      }
      if(event.type==='skillResult'&&event.source===p.request.preview.actorId){
        if(lifetime&&!p.executed&&p.waiting&&!event.indirect&&event.skillId===55&&event.level===p.request.preview.level&&event.mode==='ground'&&equal(event.targetPosition,p.request.target)&&event.position.x===p.request.preview.x&&event.position.y===p.request.preview.y){
          p.executed=true;p.settledAt=this.now()+event.motionSeconds*1000;p.selectionDeadline=this.now()+WARP_SELECTION_MS;
          if(!p.stopped){this.state='selectionObserved';this.reason='Destination selection observed. Wait for the ordered SP debit and motion settlement, then review an explicit activation preview.';}
        }else this.cancel('Own skill execution is duplicate or contradicts the captured Warp Portal request. '+WARP_RECOVERY);
      }
      if(event.type==='sp'||event.type==='stats'&&event.sp!==undefined){
        if(this.death&&(!c.character||this.death.character===c.character)&&c.connection===this.death.connection&&event.type==='stats'){p.spObserved=true;p.activationSpObserved=true;this.evidence='Fresh authoritative SP reconciled after proved death; prior creation remains unconfirmed.';}
        else if(lifetime&&p.activated&&c.binding!.spRevision>p.activationSpRevision){p.activationSpObserved=true;this.evidence=(p.activationWindowClosed?'Late activation':'Activation')+' SP readback observed; portal creation remains unconfirmed.';}
        else if(lifetime&&p.executed&&!p.spObserved&&c.sp===p.sp-p.cost&&c.binding!.spRevision===p.request.preview.spRevision+1){p.spObserved=true;this.evidence=`Ordered ground SP debit observed: ${p.sp} → ${c.sp}. Creation remains unconfirmed.`;}
        else if(!p.activated)this.cancel('SP changed without the expected ordered ground execution debit. '+WARP_RECOVERY);
      }
      if(event.type==='inventory'&&this.death&&(!c.character||this.death.character===c.character)&&c.connection===this.death.connection)p.inventoryObserved=true;
      if((event.type==='inventory'||event.type==='inventoryDelta')&&p.activated&&lifetime&&c.binding!.inventoryRevision>p.activationInventoryRevision){p.inventoryObserved=true;this.evidence=`${p.activationWindowClosed?'Late activation':'Activation'} inventory readback: ${p.gems} → ${c.gems} Blue Gemstones. This does not confirm portal creation; consumption can precede failure.`;}
      if(event.type==='requestFailure'||event.type==='skillFailure'||event.type==='featureError')this.cancel('A request failure was observed. Resource consumption and portal outcome remain unconfirmed. '+WARP_RECOVERY);
      if(event.type==='map'||event.type==='clear')this.cancel('World changed; this does not prove queued casts ended. '+WARP_RECOVERY);
    }
    this.tick(c);
  }
  tick(c:WarpContext):void{
    const p=this.attempt,b=this.binding(c);
    if(this.prepared&&(!c.ready||!c.idle||!b||!equal(this.prepared.preview,b)))this.prepared=null;
    if(p&&!p.stopped&&!p.activated){
      const original=p.request.preview;
      if(!c.ready||!b||!equal(physical(b),physical(original))||b.inventoryRevision!==original.inventoryRevision||c.gems!==p.gems||!p.memoValid||c.slots&&!slotsEqual(c.slots,p.slots))this.cancel('Captured character, memo, ground or resource evidence changed. Activation canceled. '+WARP_RECOVERY);
      else if(this.now()<p.since||this.now()>=(p.spObserved?p.selectionDeadline:p.deadline))this.cancel('The local observation window expired. Queued server casts may still finish. '+WARP_RECOVERY);
    }
    if(p?.activated&&!p.activationWindowClosed&&p.activationSince!==null&&(this.now()<p.activationSince||this.now()>=p.deadline)){
      p.activationWindowClosed=true;
      this.cancel('The activation observation window ended or the clock changed; portal creation remains unconfirmed. '+WARP_RECOVERY);
    }
    if(this.held){if(this.newSession)this.release(c,true);else if(this.death)this.release(c,false);}
  }
  snapshot(c:WarpContext):WarpSnapshot{
    const blocker=this.held?'An unresolved Warp Portal request holds automation. '+WARP_RECOVERY:this.prerequisite(c);
    return {generation:this.generation,blocked:this.held,pending:this.busy,state:this.state,reason:blocker&&!this.held?blocker:this.reason,
      ready:blocker?null:this.binding(c),activation:this.activation(c),preview:this.prepared?structuredClone(this.prepared):null,slots:c.slots?structuredClone(c.slots):null,cost:c.cost,gems:c.gems,reserve:c.reserve,selection:this.selection,resourceEvidence:this.evidence,captured:this.attempt?{slot:this.attempt.request.slot,ground:{...this.attempt.request.target},destination:structuredClone(this.attempt.slots[this.attempt.request.slot]!)}:null};
  }
}

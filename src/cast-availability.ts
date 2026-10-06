import { sameActionIdentity } from './actor-identity';
import type { Entity, GameEvent, LookAction } from './protocol';
import type { WorldEvent } from './world-protocol';

import { type ObservedCast, type AvailabilityContext, type Probe, CAST_AVAILABILITY_ATTEMPTS, CAST_AVAILABILITY_INTERVAL, CAST_AVAILABILITY_WINDOW, CAST_SCHEDULING_MARGIN } from './cast-availability-logic';

export { type ObservedCast, type AvailabilityContext, CAST_AVAILABILITY_ATTEMPTS, CAST_AVAILABILITY_INTERVAL, CAST_AVAILABILITY_WINDOW } from './cast-availability-logic';

/** Sender-free policy. Look is independent availability, never a private probe
 * acknowledgment. Its FIFO/source proof requires durable non-vending authority. */
export class CastAvailability {
  private firstEnter=true;
  private initialization:number|null=null;
  private baseline=false;
  private interaction=false;
  private vending=false;
  private initializedInteraction=false;
  private armed=false;
  private probe:Probe|null=null;
  private possibleProbes=0;
  private cooldownUntil=0;
  constructor(private readonly now=Date.now) {}
  connectionChanged():void {
    this.firstEnter=true;this.initialization=null;this.baseline=false;this.interaction=false;this.vending=false;
    this.initializedInteraction=false;this.armed=false;this.probe=null;this.possibleProbes=0;this.cooldownUntil=0;
  }
  allowRun():void {this.armed=true;}
  stop(reason='Cast availability recovery stopped.'):void {this.armed=false;this.cancel(reason);}
  cancel(reason:string):void {if(this.probe){this.probe.stopped=true;this.probe.reason=reason;}}
  retire(reason:string):void {
    this.cancel(reason);
    // Cast/lifetime retirement does not acknowledge possibly transmitted Look
    // input. Drain only their added delay; preserve every other admission guard.
    // Start once: unrelated frames must not keep renewing this independent hold.
    if(this.possibleProbes>0&&this.cooldownUntil===0)this.cooldownUntil=this.now()+(this.possibleProbes+1)*100+100;
  }
  observe(event:GameEvent,own:Entity|undefined):void {
    if(event.type==='enter') {
      if(this.firstEnter){this.initialization=event.id;this.firstEnter=false;}
      else this.initialization=null;
    } else if(event.type==='map'||event.type==='clear')this.initialization=null;
    else if(event.type==='spawn'&&this.initialization!==null&&event.entity.id===this.initialization&&own?.id===event.entity.id
      &&event.entity.kind===0&&event.entryType===1) {
      this.baseline=true;this.initialization=null;
      // Events observed during initialization cannot be overwritten by a
      // default WorldState or a later spawn/reset.
      if(!this.initializedInteraction){this.interaction=false;this.vending=false;}
    }
  }
  observeWorld(event:WorldEvent):void {
    if(event.type==='vendingStarted'){this.vending=true;this.interaction=true;this.initializedInteraction=true;}
    else if(event.type==='npcEnd'){this.vending=false;this.interaction=false;this.initializedInteraction=true;}
    else if(event.type==='npcFocus'&&event.focus||['npcDialog','npcOptions','npcSprite','npcRefine','shopOpened','storageOpened','barterOpened','vendingViewed'].includes(event.type)){
      this.interaction=true;this.initializedInteraction=true;
    }
    // VendingStop sends/replies and map/clear/death are not authoritative exits.
  }
  get nonVending():boolean {return this.baseline&&!this.vending&&!this.interaction;}
  capture(cast:ObservedCast):void {
    this.retire('A newer own cast superseded this recovery attempt.');
    const readyAt=cast.capturedAt+Math.max(0,cast.remainingSeconds)*1000+CAST_SCHEDULING_MARGIN;
    this.probe={cast:{...cast,identity:{...cast.identity}},readyAt,deadline:readyAt+CAST_AVAILABILITY_WINDOW,
      attempts:0,lastSent:null,stopped:!cast.ambiguous,reason:cast.ambiguous?'Waiting for the cast-duration hint before bounded stationary recovery.':''};
  }
  castChanged(cast:ObservedCast|null):void {
    if(this.probe&&(!cast||cast.revision!==this.probe.cast.revision||!sameActionIdentity(cast.identity,this.probe.cast.identity)))
      this.retire('The observed own cast or actor lifetime changed.');
  }
  available():void {
    this.cancel('Stationary cast availability was observed.');
    // Every possibly transmitted query counts, including sends that threw and
    // retired casts. This timer drains input delay only, never the cast/receipt.
    this.cooldownUntil=Math.max(this.cooldownUntil,this.now()+(this.possibleProbes+1)*100+100);
  }
  cooldownSettled():boolean {
    if(this.now()<this.cooldownUntil)return false;
    if(this.cooldownUntil>0){this.possibleProbes=0;this.cooldownUntil=0;}return true;
  }
  take(context:AvailabilityContext):LookAction|null {
    this.castChanged(context.cast);const p=this.probe;if(!p||p.stopped||!p.cast.ambiguous)return null;
    const now=this.now();
    if(!this.armed||!context.requested){this.cancel('Cast availability recovery requires an explicitly requested run.');return null;}
    if(!context.exclusive){this.cancel(context.reason||'Another command owner prevents cast availability recovery.');return null;}
    if(now>=p.deadline||p.attempts>=CAST_AVAILABILITY_ATTEMPTS){this.cancel('Stationary cast recovery exhausted its bounded Look attempts. Waiting for authoritative availability.');return null;}
    if(!this.nonVending){p.reason='Waiting for verified non-vending initialization or authoritative NPC exit.';return null;}
    if(this.possibleProbes>=64){this.cancel('Waiting for aggregate stationary input uncertainty to settle.');return null;}
    if(!context.ready||!this.cooldownSettled()||now<p.readyAt||p.lastSent!==null&&now-p.lastSent<CAST_AVAILABILITY_INTERVAL)return null;
    if(p.cast.facing===undefined||!Number.isInteger(p.cast.facing)||p.cast.facing<0||p.cast.facing>7){this.cancel('The captured cast has no verified facing for stationary recovery.');return null;}
    // Reserve before the caller reaches the transport. A send-then-throw cannot
    // erase this attempt or authorize unlimited retries.
    p.attempts++;this.possibleProbes++;p.lastSent=now;
    p.reason=`Checking stationary cast availability (${p.attempts}/${CAST_AVAILABILITY_ATTEMPTS}).`;
    return {type:'look',direction:p.cast.facing,head:1};
  }
  get reason():string {return this.probe?.reason??'';}
  get attempts():number {return this.probe?.attempts??0;}
}

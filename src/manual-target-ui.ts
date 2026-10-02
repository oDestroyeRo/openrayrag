import { validActorSnapshot, type ActorObservationSnapshot } from './actor-observations';
import type { CharacterSnapshot } from './character-state';
import { manualTargetPolicy, previewManualTarget, validateManualTargetRequest, type ManualTargetRequest } from './manual-target';
import type { Entity } from './protocol';
import type { Settings } from './settings';

interface Hooks {settings():Settings;command(request:Record<string,unknown>):Promise<unknown>;stop?():void;notify(text:string,error?:boolean):void}
const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
/** Disposable preview; execution rebuilds its route and checks live identities. */
export class ManualTargetUi {
  readonly root=document.createElement('details');
  private readonly x=document.createElement('input');private readonly y=document.createElement('input');
  private readonly timeout=document.createElement('input');private readonly monsters=document.createElement('select');
  private readonly output=document.createElement('pre');private readonly stop=document.createElement('button');
  private status:Record<string,unknown>={};private locked=true;
  constructor(private readonly hooks:Hooks) {
    this.root.className='manual-group';const heading=document.createElement('summary');heading.textContent='Bounded walk & normal attack';this.root.append(heading);
    const hint=document.createElement('p');hint.className='hint';hint.textContent='One current-map destination or one visible monster. No field run, skill strategies, loot or reconnect. At the arrow reserve we send Stop; shots already in flight can consume more before it arrives.';this.root.append(hint);
    const controls=document.createElement('div');controls.className='form-grid';this.root.append(controls);
    const field=(title:string,input:HTMLElement)=>{const label=document.createElement('label');label.className='form-field';label.textContent=title;label.append(input);controls.append(label);};
    for(const [input,id,label,value,max]of [[this.x,'manual-walk-x','Destination X','0','511'],[this.y,'manual-walk-y','Destination Y','0','511'],[this.timeout,'manual-target-timeout','Whole command deadline, seconds','30','120']] as const){input.id=id;input.type='number';input.min=input===this.timeout?'1':'0';input.max=max;input.step='1';input.value=value;field(label,input);}
    this.monsters.id='manual-monster';field('Visible monster identity',this.monsters);
    const buttons=document.createElement('div');buttons.className='button-row';this.root.append(buttons);
    const button=(title:string,id:string,fn:()=>void)=>{const b=document.createElement('button');b.type='button';b.className='secondary compact';b.id=id;b.dataset.manual='true';b.textContent=title;b.addEventListener('click',fn);buttons.append(b);};
    for(const kind of ['walk','attack'] as const){
      button(`Preview ${kind}`,`manual-preview-${kind}`,()=>this.operation(()=>{const request=this.request(kind);const route=previewManualTarget(request,this.context(request));this.output.textContent=`Verified ${kind} preview · ${request.map} · ${Math.max(0,route.length-1)} walking cells · ${request.timeoutSeconds}s deadline. Execution checks current state again.`;}));
      button(kind==='walk'?'Walk once':'Attack selected monster',`manual-run-${kind}`,()=>this.operation(async()=>{const request=this.request(kind);previewManualTarget(request,this.context(request));await this.hooks.command(request as unknown as Record<string,unknown>);}));
    }
    this.stop.type='button';this.stop.id='manual-target-stop';this.stop.className='secondary compact';this.stop.textContent='Stop manual command';this.stop.disabled=true;this.stop.addEventListener('click',()=>this.hooks.stop?.());buttons.append(this.stop);
    this.output.id='manual-target-output';this.output.className='telemetry-summary';this.output.textContent='No manual command requested.';this.root.append(this.output);
  }
  private operation(fn:()=>void|Promise<void>):void {if(this.locked)return;void Promise.resolve().then(fn).catch(error=>{const reason=error instanceof Error?error.message:'Manual command is unavailable.';this.output.textContent=reason;this.hooks.notify(reason,true);});}
  private actors():ActorObservationSnapshot {const actors=this.status.actorObservations;if(!validActorSnapshot(actors))throw new Error('Fresh observed actor identities are unavailable.');return actors;}
  private request(kind:'walk'|'attack'):ManualTargetRequest {
    const numeric=(input:HTMLInputElement)=>{if(!/^\d+$/.test(input.value.trim()))throw new Error('Enter whole destination coordinates and a positive deadline.');return Number(input.value);};
    const actors=this.actors(),self=actors.actors.find(a=>a.id===actors.selfId),player=object(this.status.player);
    if(!self||self.kind!==0||this.status.connected!==true||this.status.compatible!==true||typeof this.status.map!=='string')throw new Error('A fresh verified current-map character is required.');
    if(Date.now()<actors.at||Date.now()-actors.at>15000||actors.at-(actors.lastFrameAt??0)>15000)throw new Error('Manual command observations are stale.');
    const target=actors.actors.find(a=>`${actors.world}:${a.id}:${a.incarnation}`===this.monsters.value);
    return validateManualTargetRequest({type:'manualTarget',map:this.status.map,owner:{world:actors.world,id:player.id,incarnation:self.incarnation},command:kind==='walk'?{type:'walk',destination:{x:numeric(this.x),y:numeric(this.y)}}:{type:'attack',target:{world:actors.world,id:target?.id,incarnation:target?.incarnation}},timeoutSeconds:numeric(this.timeout),policy:manualTargetPolicy(this.hooks.settings())});
  }
  private context(request:ManualTargetRequest) {
    const actors=this.actors(),player=this.status.player as Entity|null;
    const targetId=request.command.type==='attack'?request.command.target.id:null;
    const target=targetId===null?null:(this.status.monsters as Entity[]??[]).find(e=>e.id===targetId)??null;
    const observed=target?actors.actors.find(a=>a.id===target.id):null;
    const world=object(this.status.world),npc=object(world.npc);
    return {map:String(this.status.map),player,owner:request.owner,interactionBusy:world.vending!=null||npc.id!=null||typeof npc.mode==='string'&&npc.mode!=='idle',target,targetIdentity:observed?{world:actors.world,id:observed.id,incarnation:observed.incarnation}:null,character:this.status.character as CharacterSnapshot,observations:{...actors,candidateId:target?.id??null}};
  }
  lock(locked:boolean):void {this.locked=locked;for(const input of this.root.querySelectorAll<HTMLInputElement|HTMLSelectElement|HTMLButtonElement>('input,select,[data-manual]'))input.disabled=locked;}
  render(value:Record<string,unknown>):void {
    this.status=value;const selected=this.monsters.value;this.monsters.replaceChildren();
    const empty=document.createElement('option');empty.value='';empty.textContent='Choose a visible living monster';this.monsters.append(empty);
    const actors=validActorSnapshot(value.actorObservations)?value.actorObservations:null;
    for(const raw of Array.isArray(value.monsters)?value.monsters:[]){const actor=object(raw),observed=actors?.actors.find(a=>a.id===actor.id&&a.kind===1);if(!observed||actor.dead===true||typeof actor.hp!=='number'||actor.hp<=0)continue;const option=document.createElement('option');option.value=`${actors!.world}:${actor.id}:${observed.incarnation}`;option.textContent=`${String(actor.name??'Monster').slice(0,64)} #${actor.id} · level ${actor.level} · ${actor.x}, ${actor.y} · lifetime ${observed.incarnation}`;this.monsters.append(option);}
    this.monsters.value=selected;
    const manual=object(value.manualTarget);const state=`${manual.state??'idle'} · ${manual.reason??''} · ${manual.elapsedSeconds??0}s elapsed · ${manual.remainingSeconds??0}s remaining${manual.settling===true?' · waiting for Stop/movement reconciliation':''}`;
    if(Number(manual.sequence)>0&&this.output.dataset.result!==state){this.output.textContent=state;this.output.dataset.result=state;}
    this.stop.disabled=manual.active!==true&&manual.settling!==true;
  }
}

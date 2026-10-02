import { memoPreview, type MemoSnapshot } from './memo';
import { validateMemoRequest, type MemoLocation, type MemoRequest, type MemoSlot } from './memo-protocol';

const object=(v:unknown):Record<string,unknown>=>v&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
const integer=(v:unknown,min=0,max=2147483647):boolean=>Number.isInteger(v)&&Number(v)>=min&&Number(v)<=max;
const exact=(v:Record<string,unknown>,keys:string[]):boolean=>Object.keys(v).length===keys.length&&Object.keys(v).every(key=>keys.includes(key));
const location=(v:unknown):v is MemoLocation=>{const p=object(v);return exact(p,['map','x','y'])&&typeof p.map==='string'&&/^[a-zA-Z0-9_-]{1,64}$/.test(p.map)&&integer(p.x,0,32767)&&integer(p.y,0,32767);};
export function validMemoSnapshot(input:unknown):input is MemoSnapshot {
  const v=object(input);
  if(!exact(v,['generation','revision','slots','pending','blocked','state','reason','ready','learnedWarp','unavailable'])||!integer(v.generation)||!integer(v.revision)
    ||typeof v.pending!=='boolean'||typeof v.blocked!=='boolean'||(v.pending&&!v.blocked)
    ||!['unknown','observed','alreadyCurrent','sent','notified','confirmed','uncertain'].includes(String(v.state))||typeof v.reason!=='string'||v.reason.length>512
    ||!(v.learnedWarp===null||integer(v.learnedWarp,0,255))||!(v.unavailable===null||typeof v.unavailable==='string'&&v.unavailable.length<=512)
    ||!(v.slots===null||Array.isArray(v.slots)&&v.slots.length===4&&v.slots.every(slot=>slot===null||location(slot))))return false;
  if(v.ready===null)return true;
  try {const r=validateMemoRequest({type:'memoSave',slot:0,preview:v.ready});return r.preview.revision===v.revision&&v.slots!==null&&!v.blocked&&v.unavailable===null;}catch{return false;}
}
const describe=(v:MemoLocation|null):string=>v?`${v.map} (${v.x}, ${v.y})`:'Empty';
/** Revision-bound explicit controls. Neither a selection nor a status event sends. */
export class MemoUi {
  readonly root=document.createElement('details');
  private readonly slots=document.createElement('pre');
  private readonly choice=document.createElement('select');
  private readonly previewButton=document.createElement('button');
  private readonly saveButton=document.createElement('button');
  private readonly previewText=document.createElement('p');
  private readonly reason=document.createElement('p');
  private snapshot:MemoSnapshot|null=null;private request:MemoRequest|null=null;private lifecycle:string|null=null;private locked=true;private sending=false;
  constructor(private readonly send:(request:MemoRequest)=>Promise<unknown>,private readonly notify:(message:string,error?:boolean)=>void){
    this.root.className='manual-group memo-panel';const title=document.createElement('summary');title.textContent='Memo slots · current location';
    const help=document.createElement('p');help.className='hint';help.textContent='Learned Warp Portal permits slots 0–3 by level. Preview replaces one slot with your stationary current map/cell only. Save sends once; it does not cast Warp Portal. No automatic writes or retries. A sent update cannot be undone.';
    this.slots.className='telemetry-summary';this.slots.setAttribute('aria-label','Observed memo slots');this.choice.setAttribute('aria-label','Memo slot');
    for(let slot=0;slot<4;slot++){const option=document.createElement('option');option.value=String(slot);option.textContent=`Slot ${slot} · requires learned level ${slot+1}`;this.choice.append(option);}this.choice.value='0';
    this.previewButton.textContent='Preview current location';this.saveButton.textContent='Save once';
    for(const button of [this.previewButton,this.saveButton]){button.type='button';button.className='secondary compact';button.dataset.manual='true';}
    this.previewText.className=this.reason.className='telemetry-summary';this.previewText.setAttribute('aria-label','Memo overwrite preview');
    this.root.append(title,help,this.slots,this.choice,this.previewButton,this.previewText,this.saveButton,this.reason);
    this.choice.addEventListener('change',()=>{this.request=null;this.previewText.textContent='Choose Preview to inspect this slot before writing.';this.update();});
    this.previewButton.addEventListener('click',()=>this.preview());this.saveButton.addEventListener('click',()=>void this.save());this.update();
  }
  lock(value:boolean):void{this.locked=value;this.update();}
  clear():void{this.snapshot=null;this.request=null;this.lifecycle=null;this.choice.value='0';this.previewText.textContent='';this.lock(true);this.update();}
  render(input:unknown):void{
    const s=object(input),memo=s.memo,player=object(s.player);this.snapshot=validMemoSnapshot(memo)?memo:null;
    const lifecycle=JSON.stringify([s.sessionId??null,s.connectionId??null,player.id??null,player.name??null,this.snapshot?.generation??null]);
    if(this.lifecycle!==null&&this.lifecycle!==lifecycle){this.request=null;this.choice.value='0';this.previewText.textContent='Preview canceled after session/character/Stop changes.';}
    this.lifecycle=lifecycle;
    if(this.request&&(!this.snapshot?.ready||JSON.stringify(this.request.preview)!==JSON.stringify(this.snapshot.ready))){this.request=null;this.previewText.textContent='Preview is stale. Preview again from current server state.';}
    this.update();
  }
  private blocker():string|null{
    if(this.locked||this.sending)return 'Stop automation and wait for all current actions to settle.';
    if(!this.snapshot)return 'Waiting for verified memo state.';
    if(!this.snapshot.ready)return this.snapshot.unavailable??'Wait for a complete fresh character/memo snapshot.';
    if(Number(this.choice.value)>=(this.snapshot.learnedWarp??0))return 'This slot requires a higher learned Warp Portal level.';
    return null;
  }
  private update():void{
    const blocker=this.blocker();this.choice.disabled=this.locked||this.sending;this.previewButton.disabled=!!blocker;this.saveButton.disabled=!!blocker||!this.request;
    this.slots.textContent=Array.from({length:4},(_,slot)=>`Slot ${slot}: ${this.snapshot?.slots?describe(this.snapshot.slots[slot]!):'Unknown · full readback not observed'}`).join('\n');
    this.reason.textContent=[this.snapshot?.state?`${this.snapshot.state} · ${this.snapshot.reason}`:'Waiting for the server memo snapshot.',blocker].filter(Boolean).join('\n');
  }
  private preview():void{
    if(this.blocker()||!this.snapshot)return;
    try{const result=memoPreview(this.snapshot,Number(this.choice.value) as MemoSlot);this.request=result.request;
      this.previewText.textContent=`Slot ${this.choice.value} · previous: ${describe(result.previous)}\nCurrent: ${describe(this.snapshot.ready)}\n${result.message}`;
    }catch(e){this.request=null;this.notify(e instanceof Error?e.message:'Preview unavailable.',true);}this.update();
  }
  private async save():Promise<void>{
    if(this.blocker()||!this.request||!this.snapshot)return;
    const request=this.request;
    try{const current=memoPreview(this.snapshot,request.slot).request;if(!current||JSON.stringify(current)!==JSON.stringify(request))throw new Error('Memo preview is stale. Preview again.');}
    catch(e){this.request=null;this.notify(e instanceof Error?e.message:'Memo preview is stale.',true);this.update();return;}
    this.request=null;this.sending=true;this.update();
    try{await this.send(validateMemoRequest(request));this.notify('One memo save requested. Check the slot notification and full readback result.');}
    catch(e){this.notify(e instanceof Error?e.message:'Memo save was not accepted.',true);}
    finally{this.sending=false;this.update();}
  }
}

import { SOCKET_METADATA, type SocketSnapshot, type SocketPreview } from './socket';
import { socketStockFloors, type SocketPreviewRequest, type SocketCommitRequest } from './socket-protocol';
import type { AutomationSettings } from './settings';

export class SocketUi {
  readonly root=document.createElement('details');
  private readonly target=document.createElement('select'); private readonly card=document.createElement('select');
  private readonly preview=document.createElement('button'); private readonly commit=document.createElement('button');
  private readonly output=document.createElement('p');private locked=true;private sending=false;
  private current:SocketPreview|null=null;private status:SocketSnapshot|null=null;private dismissedToken:string|null=null;private previewPolicy:string|null=null;
  constructor(private readonly prepare:(request:SocketPreviewRequest)=>Promise<unknown>,private readonly send:(request:SocketCommitRequest)=>Promise<unknown>,
    private readonly notify:(text:string,error?:boolean)=>void,private readonly settings:()=>AutomationSettings){
    this.root.className='manual-details';this.root.id='socket-card-action';
    const title=document.createElement('summary');title.textContent='Socket one card · irreversible';
    const help=document.createElement('p');help.className='hint';help.textContent='Consume exactly one observed regular card to fill the first free slot on unequipped gear. Installed cards cannot be removed or replaced here. This action never equips gear or retries.';
    for(const [name,input]of [['Unequipped target',this.target],['Regular card',this.card]]as const){const label=document.createElement('label');label.className='form-field';const text=document.createElement('span');text.textContent=name;input.setAttribute('aria-label',name);label.append(text,input);this.root.append(label);}
    this.preview.type=this.commit.type='button';this.preview.textContent='Preview one-card change';this.commit.textContent='Consume 1 card and socket permanently';
    this.output.className='telemetry-summary';this.root.prepend(title,help);this.root.append(this.preview,this.output,this.commit);
    const edited=()=>{this.dismissedToken=this.current?.previewToken??this.dismissedToken;this.current=null;this.update();};
    this.target.addEventListener('change',edited);this.card.addEventListener('change',edited);
    this.preview.addEventListener('click',()=>void this.request(false));this.commit.addEventListener('click',()=>void this.request(true));this.update();
  }
  lock(value:boolean):void{this.locked=value;this.update();}
  clear():void{this.current=null;this.status=null;this.dismissedToken=null;this.previewPolicy=null;this.render(null);this.lock(true);}
  policyChanged():void{this.update();}
  render(value:unknown):void{
    this.status=validSocketSnapshot(value)?value:null;
    const selected=[this.target.value,this.card.value];
    this.target.replaceChildren();this.card.replaceChildren();
    const placeholder=(select:HTMLSelectElement,label:string)=>{const option=document.createElement('option');option.value='';option.textContent=label;select.append(option);};
    placeholder(this.target,'No observed usable target');placeholder(this.card,'No card above reserve');
    for(const row of this.status?.targets??[]){const option=document.createElement('option');option.value=String(row.bagId);option.textContent=`${row.name} · bag ${row.bagId} · +${row.refine} · ${row.capacity} slots`;this.target.append(option);}
    let floors:ReadonlyMap<number,number>=new Map();try{floors=socketStockFloors(this.settings());}catch{/* Validation is repeated before requesting. */}
    for(const row of this.status?.cards??[]){const reserve=floors.get(row.itemId)??0,option=document.createElement('option');option.value=String(row.bagId);option.textContent=`${row.name} · ${row.count} owned · ${reserve} reserved`;option.disabled=row.count<=reserve;this.card.append(option);}
    if(selected[0])this.target.value=selected[0];if(selected[1])this.card.value=selected[1];
    this.current=this.status?.preview?.previewToken===this.dismissedToken?null:this.status?.preview??null;
    if(this.current){this.target.value=String(this.current.targetBagId);this.card.value=String(this.current.cardBagId);}
    this.update();
  }
  private update():void{
    let policy:string|null=null;try{policy=JSON.stringify(this.settings());}catch{/* Invalid visible settings cannot commit. */}
    if(this.current&&(policy===null||policy!==this.previewPolicy)){this.dismissedToken=this.current.previewToken;this.current=null;}
    const blocked=this.locked||this.sending||this.status?.pending===true;
    this.target.disabled=this.card.disabled=blocked;this.preview.disabled=blocked||!this.target.value||!this.card.value;
    this.commit.disabled=blocked||!this.current||String(this.current.targetBagId)!==this.target.value||String(this.current.cardBagId)!==this.card.value;
    const p=this.current,slots=p?.target.slots.map(id=>id?SOCKET_METADATA[id]?.name??`Item #${id}`:'empty').join(', ');
    this.output.textContent=[this.status?`${this.status.state} · ${this.status.reason}`:'Connect a verified character and stop automation to preview socketing.',
      p&&`${p.target.name} +${p.target.refine} · bag ${p.targetBagId} · current slots: [${slots}]. Consume 1 ${p.card.name}; slot ${p.slot+1} becomes item #${p.card.itemId}. Keep ${p.card.reserve} in reserve.`].filter(Boolean).join('\n');
  }
  private async request(commit:boolean):Promise<void>{
    if(commit?this.commit.disabled:this.preview.disabled)return;
    let policy:AutomationSettings;try{policy=this.settings();}catch(e){this.notify(e instanceof Error?e.message:'Validate the visible protection settings first.',true);return;}
    const request={targetBagId:Number(this.target.value),cardBagId:Number(this.card.value),policy};
    const token=this.current?.previewToken;this.sending=true;this.update();
    try{if(commit){if(!token)return;this.dismissedToken=token;this.current=null;await this.send({...request,previewToken:token});this.notify('One irreversible socket request accepted. Check pending / confirmed / uncertain; no retry.');}
      else{this.previewPolicy=JSON.stringify(policy);await this.prepare(request);}}
    catch(e){this.current=null;this.notify(e instanceof Error?e.message:'Socket request was not accepted.',true);}
    finally{this.sending=false;this.update();}
  }
}
/** Bound purpose-specific telemetry; raw GUIDs and arbitrary inventory fields are absent. */
export function validSocketSnapshot(value:unknown):value is SocketSnapshot{
  if(!value||typeof value!=='object'||Array.isArray(value))return false;
  const v=value as Record<string,unknown>;
  if(Object.keys(v).some(k=>!['state','pending','reason','targets','cards','preview'].includes(k))
    ||!['idle','preview','pending','confirmed','uncertain','reconciled'].includes(String(v.state))||typeof v.pending!=='boolean'
    ||typeof v.reason!=='string'||v.reason.length>1024||!Array.isArray(v.targets)||v.targets.length>200||!Array.isArray(v.cards)||v.cards.length>200)return false;
  const id=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>0&&Number(x)<=2147483647;
  const record=(x:unknown):Record<string,unknown>|null=>x&&typeof x==='object'&&!Array.isArray(x)?x as Record<string,unknown>:null;
  const target=(x:unknown)=>{const t=record(x);return !!t&&Object.keys(t).length===6&&Object.keys(t).every(k=>['bagId','itemId','name','refine','slots','capacity'].includes(k))&&id(t.bagId)&&id(t.itemId)
    &&typeof t.name==='string'&&t.name.length<=256&&Number.isInteger(t.refine)&&Number(t.refine)>=0&&Number(t.refine)<=255&&Number.isInteger(t.capacity)&&Number(t.capacity)>=1&&Number(t.capacity)<=4
    &&Array.isArray(t.slots)&&t.slots.length===4&&t.slots.every(x=>x===0||id(x));};
  const card=(x:unknown)=>{const t=record(x);return !!t&&Object.keys(t).length===5&&Object.keys(t).every(k=>['bagId','itemId','name','count','reserve'].includes(k))&&id(t.bagId)&&id(t.itemId)
    &&typeof t.name==='string'&&t.name.length<=256&&Number.isInteger(t.count)&&Number(t.count)>=1&&Number(t.count)<=32767&&Number.isInteger(t.reserve)&&Number(t.reserve)>=0&&Number(t.reserve)<=32767;};
  if(!v.targets.every(target)||!v.cards.every(card))return false;
  if(v.preview===null)return true;
  const p=record(v.preview);
  return !!p&&Object.keys(p).length===7&&Object.keys(p).every(k=>['targetBagId','cardBagId','previewToken','target','card','slot','cost'].includes(k))&&id(p.targetBagId)&&id(p.cardBagId)
    &&typeof p.previewToken==='string'&&/^[a-f0-9]{32}$/.test(p.previewToken)&&target(p.target)&&card(p.card)&&Number.isInteger(p.slot)&&Number(p.slot)>=0&&Number(p.slot)<Number(record(p.target)?.capacity)&&p.cost===1
    &&p.targetBagId===record(p.target)?.bagId&&p.cardBagId===record(p.card)?.bagId;
}

export { validRefineSnapshot } from './refine-ui-logic';
import { itemName } from './game-catalog';
import { validateRefineRequest, type RefinePreviewRequest, type RefineRequest } from './refine-protocol';
import type { AutomationSettingsInput } from './settings';
const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:{};
function element<K extends keyof HTMLElementTagNameMap>(tag:K,text?:string):HTMLElementTagNameMap[K]{const node=document.createElement(tag);if(text!==undefined)node.textContent=text;return node;}
export class RefineUi {
 readonly root=element('section');private readonly target=element('select');private readonly maximum=element('input');private readonly reserve=element('input');
 private readonly previewButton=element('button','Preview one refine');private readonly sendButton=element('button','Spend ore and zeny for one attempt');private readonly closeButton=element('button','Advance / close refining dialogue');
 private readonly output=element('pre');private readonly reason=element('p');private status:Record<string,unknown>={};private locked=true;private sending=false;
 private previewRequest:RefinePreviewRequest|null=null;private previewSignature='';private candidatesKey='';private session='';
 constructor(private readonly policy:()=>AutomationSettingsInput,private readonly preview:(request:RefinePreviewRequest)=>Promise<unknown>,private readonly send:(request:RefineRequest)=>Promise<unknown>,private readonly close:(promptToken:string)=>Promise<unknown>,private readonly notify:(message:string,error?:boolean)=>void){
  this.root.className='manual-refine';this.root.append(element('h3','Refine one item'),element('p','Open a refining dialogue in the game first. Only unequipped weapons and armor are supported. Every attempt spends one ore and zeny; some levels can downgrade by one. Stop cannot refund an attempt or close the NPC.'));
  this.target.setAttribute('aria-label','Refine equipment');this.maximum.type=this.reserve.type='number';this.maximum.min=this.reserve.min='0';this.maximum.max='2000000000';this.reserve.max='2147483647';this.maximum.value='10000';this.reserve.value='0';
  this.maximum.setAttribute('aria-label','Refine spending limit');this.reserve.setAttribute('aria-label','Zeny to keep after refine');
  for(const [label,input] of [['Equipment',this.target],['Maximum spend for this attempt',this.maximum],['Zeny to keep afterward',this.reserve]] as const){const row=element('label',label);row.append(input);this.root.append(row);input.addEventListener('input',()=>this.invalidate());input.addEventListener('change',()=>this.invalidate());}
  this.output.setAttribute('aria-label','Refine preview');this.reason.setAttribute('aria-label','Refine result');
  const buttons=element('div');buttons.className='actions';buttons.append(this.previewButton,this.sendButton,this.closeButton);this.root.append(buttons,this.output,this.reason);
  this.previewButton.addEventListener('click',()=>{if(this.unavailable())return;try{const request=this.request();this.previewRequest=request;this.previewSignature=JSON.stringify(request);void this.action(()=>this.preview(request),'Preview requested. Review the fresh cost before committing.');}catch(e){this.error(e);}});
  this.sendButton.addEventListener('click',()=>{const p=record(record(this.status.refine).preview);if(!this.canSend()||!this.previewRequest)return;
   const request=validateRefineRequest({...this.request(),previewToken:p.token});this.invalidate();void this.action(()=>this.send(request),'One refining attempt requested. Wait for exact resource and equipment confirmation.');});
  this.closeButton.addEventListener('click',()=>{if(this.unavailable()||record(record(this.status.world).npc).mode!=='refine')return;const token=record(this.status.refine).dialogueToken;if(typeof token!=='string')return;this.invalidate();void this.action(()=>this.close(token),'NPC advance requested; the NPC script determines whether it closes.');});
  this.update();
 }
 private error(e:unknown):void{this.notify(e instanceof Error?e.message:'Invalid refining request.',true);}
 private async action(run:()=>Promise<unknown>,success:string):Promise<void>{this.sending=true;this.update();try{await run();this.notify(success);}catch(e){this.invalidate();this.error(e);}finally{this.sending=false;this.update();}}
 private request():RefinePreviewRequest{return validateRefineRequest({targetBagId:Number(this.target.value),catalystBagId:0,policy:this.policy(),maxSpend:Number(this.maximum.value),minZeny:Number(this.reserve.value)},true);}
 private unavailable():boolean{return this.locked||this.sending||this.status.connected!==true||this.status.compatible!==true||record(this.status.refine).blocked===true||record(this.status.player).dead!==false;}
 private canSend():boolean{if(this.unavailable()||!this.previewRequest)return false;try{return JSON.stringify(this.request())===this.previewSignature&&record(record(this.status.refine).preview).targetBagId===this.previewRequest.targetBagId&&typeof record(record(this.status.refine).preview).token==='string';}catch{return false;}}
 private invalidate():void{this.previewRequest=null;this.previewSignature='';this.update();}
 settledForMaintenance():boolean{return !this.sending&&!this.previewRequest&&record(this.status.refine).preview==null&&record(this.status.refine).blocked!==true;}
 policyChanged():void{if(this.previewRequest){try{if(JSON.stringify(this.request())!==this.previewSignature)this.invalidate();}catch{this.invalidate();}}}
 lock(value:boolean):void{this.locked=value;this.update();}
 clear():void{this.status={};this.session='';this.candidatesKey='';this.target.replaceChildren();this.invalidate();}
 render(status:Record<string,unknown>):void{
  const player=record(status.player),session=JSON.stringify([status.sessionId,status.connectionId,player.id,record(status.actorObservations).world]);if(this.session&&session!==this.session)this.invalidate();this.session=session;
  if(record(this.status.refine).preview&&record(status.refine).preview===null)this.invalidate();this.status=status;this.policyChanged();
  const rows=record(status.refine).candidates,key=JSON.stringify(rows??[]);if(key!==this.candidatesKey){const selected=this.target.value;this.target.replaceChildren();
   for(const entry of Array.isArray(rows)?rows:[]){const row=record(entry),option=element('option',`${String(row.name)} +${String(row.refine)} · bag #${String(row.bagId)}`);option.value=String(row.bagId);this.target.append(option);}
   if(Array.isArray(rows)&&rows.some(row=>record(row).bagId===Number(selected)))this.target.value=selected;this.candidatesKey=key;}
  this.update();
 }
 private update():void{
  const s=record(this.status.refine),p=record(s.preview);this.previewButton.disabled=this.unavailable()||record(record(this.status.world).npc).mode!=='refine'||!this.target.value;
  this.sendButton.disabled=!this.canSend();this.closeButton.disabled=this.unavailable()||record(record(this.status.world).npc).mode!=='refine'||typeof s.dialogueToken!=='string';
  this.target.disabled=this.maximum.disabled=this.reserve.disabled=this.unavailable();
  this.output.textContent=typeof p.token==='string'&&this.previewRequest?`${String(p.name)} +${String(p.startingRefine)} · bag #${String(p.targetBagId)}\nCost: 1 ${itemName(Number(p.oreItemId))} (#${String(p.oreItemId)}) and ${String(p.zenyCost)} zeny.\n${p.failurePossible===true?'Risk: the item can downgrade by one.':'The pinned source threshold permits only improvement at this level.'}\nNo catalyst. No automatic repeat. Deployment behavior has not been live verified.`:'Preview one currently observed item to see its exact cost and risk.';
  this.sendButton.textContent=p.failurePossible===true?'Accept downgrade risk and spend once':'Spend ore and zeny for one attempt';
  this.reason.textContent=typeof s.reason==='string'?s.reason:'Open a refining dialogue manually after connecting.';
 }
}

import { validateFormSettings, type Settings } from './settings';
export interface FormDocument {version:1;revision:number;selectedProfileId:string|null;settings:Settings}
export function formDocument(value:unknown):FormDocument {
  if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Invalid current settings document.');
  const v=value as Record<string,unknown>;
  if(Object.keys(v).length!==4||!['version','revision','selectedProfileId','settings'].every(k=>Object.hasOwn(v,k))||v.version!==1||!Number.isSafeInteger(v.revision)||Number(v.revision)<0
    ||v.selectedProfileId!==null&&(typeof v.selectedProfileId!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(v.selectedProfileId)))throw new Error('Invalid current settings document.');
  return {version:1,revision:Number(v.revision),selectedProfileId:v.selectedProfileId as string|null,settings:validateFormSettings(v.settings as Settings)};
}
/** Serialize saves; a delayed restore or old save never overwrites newer form edits. */
export class CurrentForm {
  private revision=0;private edits=0;private chain=Promise.resolve();private last:string|null=null;
  initialized=false;
  constructor(private readonly read:()=>Omit<FormDocument,'version'|'revision'>,private readonly save:(d:FormDocument)=>Promise<number>){}
  touch():void {this.edits++;}
  restore(value:unknown,apply:(d:FormDocument)=>void):void {
    if(value!==null&&value!==undefined){const d=formDocument(value);this.revision=d.revision;if(this.edits===0)apply(d);}
    this.initialized=true;
  }
  flush():Promise<FormDocument>{
    let d:FormDocument;try{d=formDocument({version:1,revision:this.revision,...this.read()});}catch(e){return Promise.reject(e);}
    const content=JSON.stringify({...d,revision:0});if(content!==this.last){this.revision++;d.revision=this.revision;this.last=content;}
    const requested=structuredClone(d);
    const task=this.chain.catch(()=>{}).then(async()=>{if(await this.save(requested)!==requested.revision)throw new Error('Current settings save was not confirmed.');return requested;});
    this.chain=task.then(()=>{});return task;
  }
}

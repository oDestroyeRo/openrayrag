import { formDocument, nextFormSave, type FormDocument } from './current-form-logic';
export { formDocument, type FormDocument } from './current-form-logic';
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
    const proposal=nextFormSave(d,this.revision,this.last);this.revision=proposal.revision;this.last=proposal.content;
    const requested=proposal.document;
    const task=this.chain.catch(()=>{}).then(async()=>{if(await this.save(requested)!==requested.revision)throw new Error('Current settings save was not confirmed.');return requested;});
    this.chain=task.then(()=>{});return task;
  }
}

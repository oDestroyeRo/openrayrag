import type { FormDocument } from './current-form';

export interface CloseRequest { token:string }
interface Hooks {
  settled():Promise<void>;
  flush():Promise<FormDocument>;
  unchanged(document:FormDocument):boolean;
  complete(token:string,revision:number):Promise<void>;
  cancel(token:string):Promise<void>;
  lock(locked:boolean):void;
  status(message:string):void;
}

/** Keep the controller alive until its latest validated settings write is confirmed. */
export class SettingsClose {
  private pending:Promise<void>|null=null;
  constructor(private readonly hooks:Hooks){}

  request(value:unknown):Promise<void> {
    if(!value||typeof value!=='object'||typeof (value as CloseRequest).token!=='string'
      ||!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test((value as CloseRequest).token))return Promise.resolve();
    if(this.pending)return this.pending;
    const {token}=value as CloseRequest;
    this.hooks.lock(true);
    this.hooks.status('Saving current settings before closing…');
    this.pending=this.save(token);
    return this.pending;
  }

  private async save(token:string):Promise<void> {
    try {
      await this.hooks.settled();
      let document:FormDocument;
      // Also cover an edit already dispatched when the controls were locked.
      do {document=await this.hooks.flush();}while(!this.hooks.unchanged(document));
      await this.hooks.complete(token,document.revision);
      // Keep controls locked until native destruction, including slow UI dispatch.
    }catch {
      await this.hooks.cancel(token).catch(()=>{});
      this.hooks.status('Close cancelled: current settings could not be saved. Check the settings or local storage, then try closing again.');
      this.hooks.lock(false);
      this.pending=null;
    }
  }
}

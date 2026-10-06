/** A lease freezes dispatch, never queues it and never changes run intent. */
export class MaintenanceLease {
  private current:{nonce:string;deadline:number;revision:number;held:boolean}|null=null;
  private revision=0;
  constructor(private readonly now=Date.now){}
  get blocked():boolean {if(this.current&&!this.current.held&&this.now()>=this.current.deadline)this.current=null;return this.current!==null;}
  get ownerRevision():number{return this.revision;}
  mutate():void {this.revision++;}
  reserve(nonce:string,settled:boolean):number|null {
    if(!/^[a-f0-9]{32}$/.test(nonce)||this.blocked||!settled)return null;
    this.current={nonce,deadline:this.now()+4000,revision:this.revision,held:false};return this.revision;
  }
  matches(nonce:string,revision:number):boolean{return this.blocked&&this.current?.nonce===nonce&&this.current.revision===revision&&this.revision===revision;}
  hold(nonce:string,revision:number):boolean{if(!this.matches(nonce,revision))return false;this.current!.held=true;return true;}
  release(nonce:string):void{if(this.current?.nonce===nonce)this.current=null;}
  assertDispatch():void{if(this.blocked)throw new Error('Client update is settling. Try again shortly.');}
}

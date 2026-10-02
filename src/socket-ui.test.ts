import { DEFAULT_AUTOMATION } from './settings';
import {afterEach,describe,expect,it,vi} from 'vitest';
import {SocketUi} from './socket-ui';
import type {SocketSnapshot} from './socket';
class Element {
  children:Element[]=[];textContent='';value='';disabled=false;attributes=new Map<string,string>();listeners=new Map<string,Array<()=>unknown>>();
  constructor(readonly tag:string){}
  append(...nodes:Element[]):void{this.children.push(...nodes);}
  prepend(...nodes:Element[]):void{this.children.unshift(...nodes);}
  replaceChildren(...nodes:Element[]):void{this.children=[...nodes];this.value='';}
  setAttribute(k:string,v:string):void{this.attributes.set(k,v);}
  addEventListener(k:string,f:()=>unknown):void{this.listeners.set(k,[...(this.listeners.get(k)??[]),f]);}
  all():Element[]{return [this,...this.children.flatMap(c=>c.all())];}
  async emit(k:string):Promise<void>{for(const f of this.listeners.get(k)??[])f();await Promise.resolve();await Promise.resolve();}
}
function fixture(){
  vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});
  const prepare=vi.fn(async()=>{}),send=vi.fn(async()=>{}),notify=vi.fn(),ui=new SocketUi(prepare,send,notify,()=>DEFAULT_AUTOMATION),root=ui.root as unknown as Element;
  const button=(name:string)=>root.all().find(n=>n.tag==='button'&&n.textContent===name)!;
  const field=(name:string)=>root.all().find(n=>n.attributes.get('aria-label')===name)!;
  const target={bagId:20001,itemId:1102,name:'Sword',refine:4,slots:[4002,0,0,0],capacity:4};
  const card={bagId:4002,itemId:4002,name:'Fabre Card',count:3,reserve:1};
  const status:SocketSnapshot={state:'idle',pending:false,reason:'Ready to preview.',targets:[target],cards:[card],preview:null};
  const preview={targetBagId:20001,cardBagId:4002,previewToken:'a'.repeat(32),target,card,slot:1,cost:1 as const};
  return{ui,root,prepare,send,notify,status,preview,button,field};
}
afterEach(()=>vi.unstubAllGlobals());
describe('one-card socket manual UI',()=>{
  it('exposes an irreversible reviewable action while offline and never sends',async()=>{
    const s=fixture();expect(s.root.all().some(n=>n.textContent==='Socket one card · irreversible')).toBe(true);
    expect(s.button('Preview one-card change').disabled).toBe(true);expect(s.button('Consume 1 card and socket permanently').disabled).toBe(true);
    await s.button('Consume 1 card and socket permanently').emit('click');expect(s.send).not.toHaveBeenCalled();
  });
  it('requires preview then an explicit second click and shows precise stock/slot change',async()=>{
    const s=fixture();s.ui.render(s.status);s.ui.lock(false);s.field('Unequipped target').value='20001';s.field('Regular card').value='4002';await s.field('Regular card').emit('change');
    await s.button('Preview one-card change').emit('click');expect(s.prepare).toHaveBeenCalledExactlyOnceWith({targetBagId:20001,cardBagId:4002,policy:DEFAULT_AUTOMATION});expect(s.send).not.toHaveBeenCalled();
    s.ui.render({...s.status,state:'preview',preview:s.preview});expect(s.root.all().map(n=>n.textContent).join(' ')).toContain('slot 2 becomes item #4002');
    await s.button('Consume 1 card and socket permanently').emit('click');await s.button('Consume 1 card and socket permanently').emit('click');
    expect(s.send).toHaveBeenCalledExactlyOnceWith({targetBagId:20001,cardBagId:4002,previewToken:'a'.repeat(32),policy:DEFAULT_AUTOMATION});
  });
  it('invalidates selected preview after editing, clearing or pending ownership without queueing',async()=>{
    const s=fixture();s.ui.render(s.status);s.ui.lock(false);s.field('Unequipped target').value='20001';s.field('Regular card').value='4002';await s.field('Regular card').emit('change');await s.button('Preview one-card change').emit('click');s.ui.render({...s.status,state:'preview',preview:s.preview});await s.field('Regular card').emit('change');
    s.ui.render({...s.status,state:'preview',preview:s.preview});
    expect(s.button('Consume 1 card and socket permanently').disabled).toBe(true);
    s.ui.render({...s.status,state:'pending',pending:true});expect(s.button('Preview one-card change').disabled).toBe(true);
    s.ui.clear();expect(s.field('Regular card').disabled).toBe(true);expect(s.send).not.toHaveBeenCalled();
  });
  it('retires a preview when visible protection settings change before an explicit send',async()=>{
    const s=fixture();s.ui.render(s.status);s.ui.lock(false);s.field('Unequipped target').value='20001';s.field('Regular card').value='4002';await s.field('Regular card').emit('change');
    await s.button('Preview one-card change').emit('click');s.ui.render({...s.status,state:'preview',preview:s.preview});expect(s.button('Consume 1 card and socket permanently').disabled).toBe(false);
    const old=DEFAULT_AUTOMATION.loadout.minAmmoStock;
    try{DEFAULT_AUTOMATION.loadout.minAmmoStock=2;s.ui.policyChanged();expect(s.button('Consume 1 card and socket permanently').disabled).toBe(true);await s.button('Consume 1 card and socket permanently').emit('click');expect(s.send).not.toHaveBeenCalled();}
    finally{DEFAULT_AUTOMATION.loadout.minAmmoStock=old;}
  });
});

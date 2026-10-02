import { afterEach, describe, expect, it, vi } from 'vitest';
import { ManualTargetUi } from './manual-target-ui';
import { BotEngine } from './engine';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';
import { DEFAULT_MAP_POLICY } from './map-policy';
import type { Entity } from './protocol';
import { GridNavigator, searchGrid } from './navigation';

class Element {
  children:Element[]=[];textContent='';id='';type='';disabled=false;dataset:Record<string,string>={};
  private selected='';listeners=new Map<string,Array<()=>unknown>>();
  constructor(readonly tag:string){}
  get value():string{return this.selected;}
  set value(value:string){this.selected=this.tag==='select'&&!this.children.some(child=>child.value===value)?'':value;}
  append(...children:Element[]){this.children.push(...children);}
  replaceChildren(...children:Element[]){this.children=children;this.selected='';}
  addEventListener(name:string,callback:()=>unknown){this.listeners.set(name,[...(this.listeners.get(name)??[]),callback]);}
  all():Element[]{return [this,...this.children.flatMap(child=>child.all())];}
  querySelectorAll():Element[]{return this.all().filter(e=>e.tag==='input'||e.tag==='select'||e.dataset.manual==='true');}
  async click(){if(this.disabled)return;for(const fn of this.listeners.get('click')??[])fn();await Promise.resolve();await Promise.resolve();await Promise.resolve();}
}
const physical=new GridNavigator(searchGrid('prt_fild08')!);
let origin={x:100,y:100};
for(let y=100;y<200;y++){let found=false;for(let x=100;x<200;x++)if(physical.safe({x,y})&&physical.safe({x:x+1,y})){origin={x,y};found=true;break;}if(found)break;}
const player:Entity={id:1,classId:0,name:'Test',kind:0,level:10,hp:100,maxHp:100,...origin,dead:false};
const monster:Entity={...player,id:2,classId:4000,name:'Poring',kind:1,level:1,x:origin.x+1};
function setup(selfId=1,targetId=2){
  vi.stubGlobal('document',{createElement:(tag:string)=>new Element(tag)});
  const engine=new BotEngine(()=>{});engine.connect(true);engine.receive([{type:'enter',id:selfId,map:'prt_fild08'},{type:'spawn',entity:{...player,id:selfId}},{type:'spawn',entity:{...monster,id:targetId}},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1}]);
  const nav=engine.snapshot().navigation!;
  const command=vi.fn(async(_request:Record<string,unknown>)=>{}),notify=vi.fn(),stop=vi.fn();
  const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[],automation:structuredClone(DEFAULT_AUTOMATION)};
  const view=new ManualTargetUi({settings:()=>settings,command,notify,stop});
  const render=()=>view.render(engine.snapshot() as unknown as Record<string,unknown>);render();view.lock(false);
  const element=(id:string)=>(view.root as unknown as Element).all().find(e=>e.id===id)!;
  return {engine,view,render,element,command,notify,stop,settings,nav};
}
afterEach(()=>vi.unstubAllGlobals());
describe('bounded manual UI',()=>{
  it('exposes only bound visible living monster choices and invalidates reused IDs',()=>{
    const f=setup(),select=f.element('manual-monster');expect(select.children).toHaveLength(2);select.value=select.children[1]!.value;
    f.engine.receive([{type:'spawn',entity:{...monster}}]);f.render();expect(select.value).toBe('');
    f.engine.receive([{type:'spawn',entity:{...monster,id:3,kind:0}},{type:'spawn',entity:{...monster,id:4,kind:2}},{type:'death',id:2}]);f.render();expect(select.children).toHaveLength(1);
  });
  it('contains malformed coordinates and settings without a native call',async()=>{
    const f=setup();f.element('manual-walk-x').value='';await f.element('manual-run-walk').click();expect(f.notify).toHaveBeenCalled();expect(f.command).not.toHaveBeenCalled();
    f.element('manual-walk-x').value='100';f.element('manual-walk-y').value='100';f.settings.minHpPercent=NaN;await f.element('manual-preview-walk').click();expect(f.element('manual-target-output').textContent).toContain('Invalid');expect(f.command).not.toHaveBeenCalled();
  });
  it('retains preview on unchanged idle render and displays terminal settling/status',()=>{
    const f=setup();f.element('manual-target-output').textContent='Current manual preview.';f.render();expect(f.element('manual-target-output').textContent).toBe('Current manual preview.');
    f.view.render({...f.engine.snapshot(),manualTarget:{sequence:1,state:'cancelled',active:false,settling:true,reason:'Waiting for target clear.',elapsedSeconds:2,remainingSeconds:0}} as unknown as Record<string,unknown>);
    expect(f.element('manual-target-output').textContent).toContain('cancelled');expect(f.element('manual-target-output').textContent).toContain('reconciliation');expect(f.element('manual-target-stop').disabled).toBe(false);
  });
  it('keeps Stop available while other controls are locked for an active manual task',async()=>{
    const f=setup();f.view.render({...f.engine.snapshot(),manualTarget:{sequence:1,state:'walking',active:true,settling:false,reason:'Walking.',elapsedSeconds:1,remainingSeconds:29}} as unknown as Record<string,unknown>);f.view.lock(true);
    expect(f.element('manual-run-walk').disabled).toBe(true);expect(f.element('manual-target-stop').disabled).toBe(false);await f.element('manual-target-stop').click();expect(f.stop).toHaveBeenCalledOnce();expect(f.command).not.toHaveBeenCalled();
  });
  it('previews and dispatches only the explicit lifetime with empty saved selections',async()=>{
    const f=setup(),select=f.element('manual-monster');select.value=select.children[1]!.value;await f.element('manual-preview-attack').click();expect(f.command).not.toHaveBeenCalled();expect(f.element('manual-target-output').textContent).toContain('Verified attack');
    await f.element('manual-run-attack').click();expect(f.command).toHaveBeenCalledOnce();expect(f.command.mock.calls[0]![0]).toMatchObject({type:'manualTarget',command:{type:'attack',target:{id:2}}});expect(f.settings.targets).toEqual([]);
  });
  it('extracts current policy from controls rather than the last field Start',async()=>{
    const f=setup();const select=f.element('manual-monster');select.value=select.children[1]!.value;f.settings.automation.combat.levelDifference=-100;
    await f.element('manual-run-attack').click();expect(f.command).not.toHaveBeenCalled();expect(f.element('manual-target-output').textContent).toContain('level');
    f.settings.automation.combat.levelDifference=1;f.settings.automation.mapPolicy={...DEFAULT_MAP_POLICY,deny:['prt_fild08']};await f.element('manual-run-attack').click();expect(f.command).not.toHaveBeenCalled();expect(f.element('manual-target-output').textContent).toContain('allowed');
  });
  it('rejects observed sitting and casting in the actual preview callback',async()=>{
    const f=setup(),select=f.element('manual-monster');select.value=select.children[1]!.value;f.engine.receive([{type:'sit',id:1,sitting:true}]);f.render();await f.element('manual-run-attack').click();expect(f.command).not.toHaveBeenCalled();expect(f.element('manual-target-output').textContent).toContain('Stand');
    f.engine.receive([{type:'sit',id:1,sitting:false},{type:'castStart',id:1,skillId:11,level:1,position:origin,remainingSeconds:10,flags:0}]);f.render();await f.element('manual-run-attack').click();expect(f.command).not.toHaveBeenCalled();expect(f.element('manual-target-output').textContent).toContain('cast');
  });
  it('rejects a published active NPC or vending interaction before native execution',async()=>{
    const f=setup();f.element('manual-walk-x').value=String(origin.x+1);f.element('manual-walk-y').value=String(origin.y);
    for(const world of [{npc:{id:3,mode:'dialog'},vending:null},{npc:{id:null,mode:'idle'},vending:{name:'Synthetic'}}]){f.view.render({...f.engine.snapshot(),world} as unknown as Record<string,unknown>);await f.element('manual-run-walk').click();expect(f.element('manual-target-output').textContent).toContain('interaction');expect(f.command).not.toHaveBeenCalled();}
  });
  it.each([[0,2],[1,0]])('binds published own %s and target %s without truthiness fallbacks',async(selfId,targetId)=>{
    const f=setup(selfId,targetId),select=f.element('manual-monster');select.value=select.children[1]!.value;await f.element('manual-run-attack').click();expect(f.command).toHaveBeenCalledOnce();expect(f.command.mock.calls[0]![0]).toMatchObject({owner:{id:selfId},command:{type:'attack',target:{id:targetId}}});
  });

});

import { describe, expect, it } from 'vitest';
import { FeatureUi } from './feature-ui';
import { DEFAULT_SETTINGS } from './settings';
import { DEFAULT_MAP_POLICY } from './map-policy';

function setup(settings=()=>DEFAULT_SETTINGS){
  const nodes=new Map<string,{textContent:string;dataset:Record<string,string>;value:string;hidden:boolean}>();
  const host={querySelector:(key:string)=>{if(!nodes.has(key))nodes.set(key,{textContent:'',dataset:{actors:''},value:'',hidden:false});return nodes.get(key)!;}};
  const view=Object.create(FeatureUi.prototype);Object.assign(view,{host,hooks:{settings,map:()=> 'prt_fild08'},status:{},dispositionPlan:null,macroUi:{render:()=>{}},manualTargets:{render:()=>{}},refine:{render:()=>{},lock:()=>{},clear:()=>{}},social:{render:()=>{}},memo:{render:()=>{}},socket:{render:()=>{}},warp:{render:()=>{}}});
  return {view,render:(status:unknown)=>FeatureUi.prototype.render.call(view,status),output:host.querySelector('#map-policy-preview'),session:host.querySelector('#session-details')};
}
describe('map policy status rendering',()=>{
  it('omits stale idle/Stopped task labels while retaining observed counters and an active task',()=>{
    const ui=setup();const observed={elapsedSeconds:123,deaths:2,character:{experience:{baseGained:250,jobGained:125}}};
    ui.render({...observed,running:true,task:{kind:'idle',pending:false,label:'Ready. Choose your targets and press Start.'}});
    expect(ui.session.textContent).toContain('2m 3s');expect(ui.session.textContent).toContain('2 deaths');expect(ui.session.textContent).toContain('Base EXP +250');
    expect(ui.session.textContent).not.toContain('Choose your targets');
    ui.render({...observed,running:false,task:{kind:'attack',pending:true,label:'Attacking Poring'}});expect(ui.session.textContent).not.toContain('Attacking');
    ui.render({...observed,running:true,task:{kind:'attack',pending:true,label:'Walking toward Poring'}});expect(ui.session.textContent).toContain('Walking toward Poring');
  });
  it.each(['planning','complete','failed','cancelled'])('publishes terminal %s without a rectangle and preserves a later preview',state=>{
    const ui=setup();const travel={state:'walking',policy:{...DEFAULT_MAP_POLICY,mode:'weighted'},purpose:'travel',reason:'Approaching a portal.'};
    ui.render({travel});expect(ui.output.textContent).toContain('Approaching a portal.');
    const terminal={...travel,state,reason:'Terminal travel result.'};ui.render({travel:terminal});expect(ui.output.textContent).toContain(`${state} · travel · Terminal travel result.`);
    ui.output.textContent='Fresh explicit preview.';ui.render({travel:terminal});expect(ui.output.textContent).toBe('Fresh explicit preview.');
  });
  it('keeps Start, manual and service ownership controls blocked during planning',()=>{
    const ui=setup();ui.render({travel:{state:'planning',policy:DEFAULT_MAP_POLICY,purpose:'travel',reason:'Planning'}});
    expect(ui.view.active()).toBe(true);expect(ui.view.serviceBlocked()).toBe(true);
    ui.render({travel:{state:'cancelled',policy:DEFAULT_MAP_POLICY,purpose:'travel',reason:'Stopped'}});
    expect(ui.view.active()).toBe(false);expect(ui.view.serviceBlocked()).toBe(false);
  });
  it('keeps rendering current telemetry while settings validation throws during an edit',()=>{
    const ui=setup(()=>{throw new Error('Unknown allowed map: partial-entry');});
    expect(()=>ui.render({elapsedSeconds:123,deaths:2,travel:{state:'idle'}})).not.toThrow();
    expect(ui.output.textContent).toContain('Unknown allowed map: partial-entry');expect(ui.session.textContent).toContain('2 deaths');
  });
  it('keeps rendering when a malformed travel policy cannot be validated',()=>{
    const ui=setup();expect(()=>ui.render({elapsedSeconds:60,travel:{state:'complete',policy:{...DEFAULT_MAP_POLICY,allow:['bad-map']}}})).not.toThrow();
    expect(ui.output.textContent).toContain('Map policy:');expect(ui.session.textContent).toContain('1m');
  });
});

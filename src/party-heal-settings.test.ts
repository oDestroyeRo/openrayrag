import {DEFAULT_HP_POTIONS,type HpPotionSettings} from './hp-potions';
import {describe,it,expect,vi} from 'vitest';
import cases from './data/party-heal-cases.json';
import {DEFAULT_AUTOMATION,DEFAULT_SETTINGS,DEFAULT_PARTY_HEAL,validateAutomation} from './settings';
import {FeatureUi,validFeatureStatus} from './feature-ui';
import {ProfileStore} from './profiles';
import {castReadiness,effectiveSpCost,skillAfterCastSeconds} from './cast-policy';
import {CharacterState} from './character-state';
import {ActorObservations} from './actor-observations';
describe('bounded optional party Heal settings',()=>{
 it.each(cases)('shares native case $name',row=>{const input:unknown={...structuredClone(DEFAULT_AUTOMATION),...('absent' in row?{}:{partyHeal:row.value})};if(row.valid)expect(validateAutomation(input as typeof DEFAULT_AUTOMATION).partyHeal).toEqual('absent' in row?undefined:row.value);else expect(()=>validateAutomation(input as typeof DEFAULT_AUTOMATION)).toThrow();});
 it('round trips only configured policy in profiles, excluding pending runtime refs',()=>{const values=new Map<string,string>();const store=new ProfileStore({getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value)});const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),partyHeal:{...DEFAULT_PARTY_HEAL,enabled:true}}};const profile=store.save('Party Heal','Acolyte',settings);expect(store.list().find(row=>row.id===profile.id)?.settings).toEqual(settings);expect(()=>store.save('Bad','Acolyte',{...settings,automation:{...settings.automation,partyHeal:{...DEFAULT_PARTY_HEAL,pending:true}}} as typeof settings)).toThrow();});
 it('reads and restores default-off controls without recursively invoking settings',()=>{
  const nodes=new Map<string,{value:string;checked:boolean;textContent:string}>();
  const host={querySelector:(key:string)=>{if(!nodes.has(key))nodes.set(key,{value:'',checked:false,textContent:''});return nodes.get(key)!;}};
  const view:FeatureUi=Object.create(FeatureUi.prototype),settings=vi.fn(()=>({...DEFAULT_SETTINGS,automation:view.read()}));
  // This partial fixture skips construction; keep lazily mounted controls by reference.
  const mountedInputs=new Map<string,ReturnType<typeof host.querySelector>>();
  const settingInputs={get:(path:string)=>{
   if(!mountedInputs.has(path))mountedInputs.set(path,host.querySelector(`[data-setting="${path}"]`));
   return mountedInputs.get(path);
  }};
  let hpPotions:HpPotionSettings=structuredClone(DEFAULT_HP_POTIONS);
  Object.assign(view,{hpPotions:{read:()=>structuredClone(hpPotions),write:(value:HpPotionSettings)=>{hpPotions=structuredClone(value);}},host,settingInputs,hooks:{settings},editors:new Map(),dispositionEditor:{read:()=>[],write:()=>{}}});
  view.write(structuredClone(DEFAULT_AUTOMATION));expect(view.read()).not.toHaveProperty('partyHeal');
  host.querySelector('[data-setting="partyHeal.enabled"]').checked=true;expect(view.read().partyHeal).toEqual({...DEFAULT_PARTY_HEAL,enabled:true});
  view.write({...structuredClone(DEFAULT_AUTOMATION),partyHeal:{...DEFAULT_PARTY_HEAL,enabled:false,level:5}});expect(view.read().partyHeal?.level).toBe(5);
  view.write(structuredClone(DEFAULT_AUTOMATION));expect(view.read()).not.toHaveProperty('partyHeal');expect(settings).not.toHaveBeenCalled();
 });
 it('keeps manual/Start/service controls fenced by canceled Heal telemetry',()=>{const view=Object.create(FeatureUi.prototype);Object.assign(view,{status:{partyHeal:{state:'uncertain'}}});expect(view.active()).toBe(true);expect(view.serviceBlocked()).toBe(true);expect(validFeatureStatus({partyHeal:{attempts:Infinity}})).toBe(false);});
 it('uses verified Heal SP table, levels and modifier arithmetic without gemstone costs',()=>{const state=new CharacterState(),observations=new ActorObservations(()=>1000);observations.spawn({id:0,kind:0,classId:3,name:'Acolyte',level:10,hp:100,maxHp:100,sp:100,maxSp:100,x:10,y:10,dead:false,statuses:[]});observations.frame();state.apply({type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},0);state.apply({type:'skills',learned:[{skillId:41,level:10}]},0);state.apply({type:'stats',level:10,hp:100,maxHp:100,sp:100,maxSp:100},0);for(let level=1;level<=10;level++)expect(effectiveSpCost(state,41,level)).toBe(10+level*3);expect(castReadiness(41,10,state,observations.snapshot(0,null,true))).toMatchObject({state:'blocked'});expect(castReadiness(41,10,state,observations.snapshot(0,null,true),false)).toMatchObject({state:'blocked'});expect(castReadiness(41,10,state,observations.snapshot(0,null,true),true)).toMatchObject({state:'ready',profile:{range:9,spCost:40,afterCastSeconds:1}});state.apply({type:'inventory',items:[{type:2,bagId:1,itemId:1101,count:1,refine:0,guid:'g',slots:[4053,0,0,0]}],equipment:[1,...Array(9).fill(0)],ammoId:-1},0);expect(effectiveSpCost(state,41,1)).toBe(14);expect(skillAfterCastSeconds(41)).toBe(1);});
});

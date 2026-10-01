import {describe,it,expect} from 'vitest';
import {DEFAULT_SETTINGS,DEFAULT_AUTOMATION,DEFAULT_ESCAPE,validateSettings,type Settings} from './settings';
const settings=():Settings=>({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:structuredClone(DEFAULT_AUTOMATION)});
describe('automation settings boundary',()=>{
  it('preserves default behavior without requiring automation fields',()=>{const value=settings();delete value.automation;expect(validateSettings(value)).toEqual(value);});
  it('clones nested profile rules instead of retaining mutable inputs',()=>{const value=settings();value.automation!.combat.rules=[{classId:4000,action:'ignore',priority:2}];const validated=validateSettings(value);value.automation!.combat.rules[0]!.priority=99;expect(validated.automation!.combat.rules[0]!.priority).toBe(2);});
  it('rejects unknown credential fields at every object boundary',()=>{const value=settings();expect(()=>validateSettings({...value,password:'secret'} as Settings)).toThrow();expect(()=>validateSettings({...value,automation:{...value.automation!,follow:{...value.automation!.follow,password:'secret'}}} as Settings)).toThrow();});
  it('permits noncombat travel and follow with no monster selection',()=>{const value=settings();value.targets=[];value.automation!.combat.mode='off';value.automation!.follow.name='Leader';expect(validateSettings(value).targets).toEqual([]);value.automation!.combat.mode='selected';expect(()=>validateSettings(value)).toThrow('Choose selected');});
  it('requires recovery hysteresis above the emergency stop floor',()=>{const value=settings();value.automation!.recovery.enabled=true;value.automation!.recovery.hpStart=45;expect(()=>validateSettings(value)).toThrow('above');value.automation!.recovery.hpStart=60;value.automation!.recovery.hpEnd=60;expect(()=>validateSettings(value)).toThrow();});
  it('accepts zero remaining death allowance and rejects values outside the bounded range',()=>{const value=settings();value.automation!.respawn={enabled:true,maxDeaths:0};expect(validateSettings(value).automation!.respawn.maxDeaths).toBe(0);for(const limit of [-1,101,0.5]){value.automation!.respawn.maxDeaths=limit;expect(()=>validateSettings(value)).toThrow();}});
  it('rejects duplicated rules and unbounded work',()=>{const value=settings();value.automation!.items=[{itemId:501,resource:'hp',belowPercent:70,minStock:0,cooldownSeconds:1},{itemId:501,resource:'hp',belowPercent:80,minStock:0,cooldownSeconds:1}];expect(()=>validateSettings(value)).toThrow();value.automation!.items=[];value.automation!.recovery.timeoutSeconds=3601;expect(()=>validateSettings(value)).toThrow();});
  it('normalizes omitted escape settings to disabled without changing legacy profiles',()=>{
    const value=settings();delete value.automation!.escape;
    expect(validateSettings(value).automation!.escape).toEqual(DEFAULT_ESCAPE);
  });
  it('validates the same bounded escape policy accepted by native controls',()=>{
    for(const mode of ['random','save'] as const)for(const method of ['item','skill'] as const){
      const value=settings();value.automation!.escape={enabled:true,hpBelowPercent:95,mode,method,minStock:9999,cooldownSeconds:3600};
      expect(validateSettings(value).automation!.escape).toEqual(value.automation!.escape);
    }
    for(const [key,value] of [['enabled',1],['hpBelowPercent',0],['hpBelowPercent',96],['hpBelowPercent',1.5],['mode','memo'],['method','debug'],['minStock',-1],['minStock',10000],['cooldownSeconds',0],['cooldownSeconds',3601],['opcode',21]] as const){
      const input=settings();Object.assign(input.automation!.escape!,{[key]:value});expect(()=>validateSettings(input)).toThrow();
    }
    const input=settings();Object.assign(input.automation!,{escape:null});expect(()=>validateSettings(input)).toThrow();
  });
});

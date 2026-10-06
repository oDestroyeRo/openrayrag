import followCases from '../../data/party-follow-settings-cases.json';
import {describe,it,expect} from 'vitest';
import {DEFAULT_SETTINGS,DEFAULT_AUTOMATION,DEFAULT_ESCAPE,validateSettings,type Settings} from './settings';
import { CurrentForm, formDocument, type FormDocument } from './current-form';
const settings=():Settings=>({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:structuredClone(DEFAULT_AUTOMATION)});
describe('automation settings boundary',()=>{
  it('preserves optional disposition absence and validates its strict schema',()=>{const value=settings();expect(validateSettings(value).automation).not.toHaveProperty('disposition');value.automation!.disposition={maxSpend:0,rules:[{itemId:501,keep:1,minimum:2,desired:3,maximum:4,store:true,sell:false,cart:false,restock:'storage',allowUnique:false}]};expect(validateSettings(value).automation!.disposition).toEqual(value.automation!.disposition);for(const invalid of [null,{maxSpend:0,rules:[{...value.automation!.disposition.rules[0],password:'excluded'}]},{maxSpend:0,rules:[{...value.automation!.disposition.rules[0],maximum:2}]}]){const changed=structuredClone(value);Object.assign(changed.automation!,{disposition:invalid});expect(()=>validateSettings(changed)).toThrow();}});
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
describe('loadout settings migration and bounds',()=>{
 it('defaults missing legacy loadout to disabled without mutating the input',()=>{const value=settings();const legacy=JSON.parse(JSON.stringify(value));delete legacy.automation.loadout;expect(validateSettings(legacy).automation!.loadout.enabled).toBe(false);expect(legacy.automation.loadout).toBeUndefined();});
 it('clones ordered preferences and rejects unknown keys, duplicates and out of bounds',()=>{
  const value=settings();value.automation!.loadout={enabled:true,autoAmmo:true,minAmmoStock:10,ammoPreferences:[{itemId:1751},{itemId:1750}],restore:'conditionEnd',cooldownSeconds:2};
  const checked=validateSettings(value);value.automation!.loadout.ammoPreferences[0]!.itemId=1752;expect(checked.automation!.loadout.ammoPreferences[0]!.itemId).toBe(1751);
  for(const bad of [{minAmmoStock:10000},{minAmmoStock:-1},{cooldownSeconds:0},{restore:'always'},{enabled:'yes'},{password:'excluded'},{ammoPreferences:[{itemId:1750},{itemId:1750}]},{ammoPreferences:[{itemId:1750,guid:'forbidden'}]}])expect(()=>validateSettings({...value,automation:{...value.automation!,loadout:{...value.automation!.loadout,...bad}}} as Settings)).toThrow();
 });
});


import threatEscapeCases from '../../data/threat-escape-cases.json';
import { escapeSettings } from './settings';
import { validateEscapeResumeGuard } from '../recovery/escape';
describe('shared threat escape policy and ephemeral guard boundary', () => {
  it.each(threatEscapeCases)('$name', test => {
    const check = () => test.kind === 'guard' ? validateEscapeResumeGuard(test.value as never)
      : validateSettings({ ...settings(), automation: { ...settings().automation!, escape: test.value as never } });
    if (test.valid) expect(check).not.toThrow(); else expect(check).toThrow();
    if (test.kind === 'policy') {
      const form = () => formDocument({ version: 1, revision: 0, selectedProfileId: null,
        settings: { ...settings(), map: '', targets: [], automation: { ...settings().automation!, escape: test.value } } });
      if (test.valid) expect(form).not.toThrow(); else expect(form).toThrow();
    }
  });
  it('keeps omitted threat fields on the original HP path and excludes episode state from profiles', () => {
    const value = settings(); value.automation!.escape = { enabled: true, hpBelowPercent: 20, mode: 'random', method: 'item', minStock: 0, cooldownSeconds: 60 };
    expect(escapeSettings(validateSettings(value))).toMatchObject({ hpEnabled: true, threatEnabled: false, threatCount: 3, threatWindowSeconds: 10 });
    expect(() => validateSettings({ ...value, automation: { ...value.automation!, escape: { ...value.automation!.escape, recovery: { hpPercent: 100, threatCount: 1, quietSeconds: 60 } } } } as never)).toThrow();
  });
  it('round-trips configured escape and resource-condition policies through the stopped current form', async () => {
    const input = settings(); input.map = ''; input.targets = [];
    input.automation!.escape = { ...DEFAULT_ESCAPE, enabled: true, hpEnabled: false, threatEnabled: true, threatCount: 64, threatWindowSeconds: 60 };
    input.automation!.items = [{ itemId: 501, resource: 'hp', belowPercent: 80, minStock: 0, cooldownSeconds: 1,
      conditions: [{ field: 'actorSpPercent', actor: { scope: 'self' }, operator: 'gte', value: 25.5 }] }];
    let saved: FormDocument | null = null;
    const form = new CurrentForm(() => ({ settings: input, selectedProfileId: 'threat-profile' }), async value => { saved = structuredClone(value); return value.revision; });
    const flushed = await form.flush();
    const restored = new CurrentForm(() => ({ settings: DEFAULT_SETTINGS, selectedProfileId: null }), async value => value.revision);
    let applied: FormDocument | null = null;
    restored.restore(JSON.parse(JSON.stringify(saved)), value => { applied = value; });
    expect(applied).toEqual(flushed); expect(flushed.settings.automation!.escape).toEqual(input.automation!.escape);
    expect(flushed.settings.automation!.items).toEqual(input.automation!.items);
    expect(() => validateSettings(flushed.settings)).toThrow();
    for (const runtime of [{ recovery: { hpPercent: 100, threatCount: 1, quietSeconds: 60 } }, { pending: true }, { actorId: 0 }]) {
      Object.assign(input.automation!.escape!, runtime);
      await expect(form.flush()).rejects.toThrow(); expect(saved).toEqual(flushed);
      for (const key of Object.keys(runtime)) delete (input.automation!.escape as unknown as Record<string, unknown>)[key];
    }
  });
});

it('shares strict optional party-follow policy cases with native validation',()=>{
 for(const row of followCases){const value=settings();Object.assign(value.automation!,{follow:row.follow});expect((()=>{try{validateSettings(value);return true;}catch{return false;}})(),JSON.stringify(row.follow)).toBe(row.valid);}
 const legacy=settings();expect(validateSettings(legacy).automation!.follow).toEqual(DEFAULT_AUTOMATION.follow);
});

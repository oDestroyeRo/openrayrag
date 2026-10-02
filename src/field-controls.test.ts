import { describe, expect, it } from 'vitest';
import { canStartField, settingsWithFieldMap } from './field-controls';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, validateSettings, type Settings } from './settings';
import { DEFAULT_MAP_POLICY, insideLockArea } from './map-policy';
import { GridNavigator, type WalkGrid } from './navigation';
import { ProfileStore } from './profiles';
const physical:WalkGrid={width:12,height:12,walkable:p=>p.x>=0&&p.y>=0&&p.x<12&&p.y<12&&p.x!==6};
function settings():Settings{return {...DEFAULT_SETTINGS,map:'prontera',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:{...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:4,maxY:4}}}};}
function state(){return {native:true,fresh:true,busy:false,stopping:false,loginBusy:false,runActive:false,connected:true,compatible:true,map:'prontera',player:{kind:0,x:8,y:4,dead:false},settings:validateSettings(settingsWithFieldMap(settings()))};}
describe('main field request boundaries',()=>{
  it('binds a new field identity from another map while preserving current selected target IDs and old defaults',()=>{
    const input=settings(),bound=settingsWithFieldMap(input);expect(validateSettings(bound).map).toBe('prt_fild08');expect(bound.targets).toEqual([4000]);expect(input.map).toBe('prontera');
    input.automation!.mapPolicy!.lockArea=null;expect(settingsWithFieldMap(input).map).toBe('prontera');
    const legacy={...DEFAULT_SETTINGS,map:'prontera',targets:[4000]};expect(settingsWithFieldMap(legacy)).toEqual(legacy);
  });
  it('permits physical area entry after an old masked navigator reports not ready',()=>{
    const s=state();const masked=new GridNavigator({...physical,walkable:p=>physical.walkable(p)&&insideLockArea(s.settings.automation!.mapPolicy!,'prt_fild08',p)});
    expect(masked.safe(s.player)).toBe(false);expect(canStartField(s,()=>physical)).toBe(true);
    s.map='prt_fild08';expect(canStartField(s,()=>physical)).toBe(true);
    s.player.x=6;expect(canStartField(s,()=>physical)).toBe(false);expect(canStartField(state(),()=>null)).toBe(false);
  });
  it.each(['native','fresh','connected','compatible'] as const)('retains the %s admission gate',key=>{expect(canStartField({...state(),[key]:false},()=>physical)).toBe(false);});
  it.each(['busy','stopping','loginBusy','runActive'] as const)('retains the %s owner gate',key=>{expect(canStartField({...state(),[key]:true},()=>physical)).toBe(false);});
  it('rejects malformed settings, actor identity and position; dead Start requires opted-in respawn',()=>{
    const s=state();expect(canStartField({...s,settings:null},()=>physical)).toBe(false);expect(canStartField({...s,player:null},()=>physical)).toBe(false);
    expect(canStartField({...s,player:{...s.player,kind:1}},()=>physical)).toBe(false);expect(canStartField({...s,player:{...s.player,x:NaN}},()=>physical)).toBe(false);
    s.player.dead=true;expect(canStartField(s,()=>physical)).toBe(false);s.settings.automation!.respawn.enabled=true;expect(canStartField(s,()=>physical)).toBe(true);
  });
  it('preserves profile map admission and never starts a profile when applying it',()=>{
    const input=validateSettings(settingsWithFieldMap(settings()));const store=new ProfileStore({getItem:()=>null,setItem:()=>{}},()=> 'policy',()=>0);store.save('Field','Test',input);
    expect(()=>store.forMap('policy','prontera','Test')).toThrow('Enter prt_fild08');expect(store.forMap('policy','prt_fild08','Test').settings.map).toBe('prt_fild08');
  });
});

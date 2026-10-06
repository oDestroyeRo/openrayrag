import { describe, expect, it } from 'vitest';
import cases from '../../data/map-policy-cases.json';
import { DEFAULT_MAP_POLICY, fieldGrid, insideLockArea, lockEntry, mapAllowed, policyIdentity, validateMapPolicy } from './map-policy';
import { GridNavigator, searchGrid, type WalkGrid } from './navigation';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS, validateSettings } from '../settings/settings';
import { ProfileStore } from '../settings/profiles';
import { PersistentFieldRun } from '../session/reconnect';
const policy=()=>({...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:4,maxY:4}});
const grid:WalkGrid={width:12,height:12,walkable:p=>p.x>=0&&p.y>=0&&p.x<12&&p.y<12};
describe('map policy portable boundary',()=>{
  for(const c of cases)it(c.name,()=>{
    if(c.valid)expect(validateMapPolicy(c.policy)).toEqual(c.policy);
    else expect(()=>validateMapPolicy(c.policy)).toThrow();
  });
  it('keeps old profiles omitted and roundtrips policy without starting',()=>{
    const saved=new Map<string,string>();const store=new ProfileStore({getItem:k=>saved.get(k)??null,setItem:(k,v)=>{saved.set(k,v);}},()=> 'policy');
    const settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:policy()}};
    store.save('Area','Test',settings);expect(store.forMap('policy','prt_fild08').settings).toEqual(validateSettings(settings));
    const old=new ProfileStore({getItem:()=>null,setItem:()=>{}},()=> 'old');old.save('Old','Test',{...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]});expect(old.list()[0]!.settings.automation).toBeUndefined();
  });
  it('preserves explicit lock identity when reconnecting on another map',()=>{
    const run=new PersistentFieldRun(()=>100000);run.begin({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:policy()}},'Test','old');
    const request=run.resumeFor({sessionId:'new',connected:true,compatible:true,map:'prontera',player:{name:'Test'}})!;
    expect(request.settings.map).toBe('prt_fild08');expect(request.settings.automation!.mapPolicy!.lockArea!.map).toBe('prt_fild08');
  });
  it('rejects an inconsistent field lock/destination map',()=>{
    const value={...DEFAULT_SETTINGS,map:'prontera',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),mapPolicy:policy()}};
    expect(()=>validateSettings(value)).toThrow('lock map');
  });
});
describe('field rectangle geometry',()=>{
  it('accepts zero/inclusive edges, preserves physical sight and masks movement/corner cuts',()=>{
    const p=policy(),physical={...grid,seeThrough:()=>true};const field=fieldGrid('prt_fild08',physical,p),nav=new GridNavigator(field);
    expect(insideLockArea(p,'prt_fild08',{x:0,y:0})).toBe(true);expect(insideLockArea(p,'prt_fild08',{x:4,y:4})).toBe(true);
    expect(field.seeThrough!({x:5,y:4})).toBe(true);expect(nav.safe({x:5,y:4})).toBe(false);expect(nav.clearWalkCorridor({x:3,y:3},{x:5,y:5})).toBe(false);
    expect(nav.plan({x:2,y:2},{x:5,y:5})).toBeNull();
    expect(fieldGrid('prontera',grid,p).walkable({x:2,y:2})).toBe(false);
  });
  it('finds a reachable alternative when the closest rectangle cell and centre are blocked',()=>{
    const p=policy(),physical={...grid,walkable:(q:{x:number;y:number})=>grid.walkable(q)&&!(q.x===4&&q.y!==0)&&!(q.x===2&&q.y===2)};
    const entry=lockEntry('prt_fild08',{x:8,y:4},physical,p)!;expect(entry).toEqual({x:4,y:0});expect(new GridNavigator(physical).plan({x:8,y:4},entry)).not.toBeNull();
  });
  it('rejects disconnected interior and does not enter through portal or diagonal corner',()=>{
    const p=policy(),wall={...grid,walkable:(q:{x:number;y:number})=>grid.walkable(q)&&q.x!==5};expect(lockEntry('prt_fild08',{x:8,y:4},wall,p)).toBeNull();
    const tiny={...grid,walkable:(q:{x:number;y:number})=>q.x===0&&q.y===0||q.x===1&&q.y===1};expect(lockEntry('prt_fild08',{x:1,y:1},tiny,{...p,lockArea:{...p.lockArea,maxX:0,maxY:0}})).toBeNull();
  });
  it('uses deny precedence and stable semantic cache identity',()=>{
    const p={...policy(),allow:['prt_fild08','prontera'],deny:['prt_fild08']};expect(mapAllowed(p,'prt_fild08')).toBe(false);expect(mapAllowed(p,'prontera')).toBe(true);
    expect(policyIdentity(p)).toBe(policyIdentity({...p,allow:[...p.allow].reverse()}));expect(searchGrid('prontera')!.width).toBe(320);
  });
});

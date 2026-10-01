import { describe, expect, it } from 'vitest';
import { MapTargets } from './targets';
import { type MapInfo } from './map-data';

const info: MapInfo = { code:'prt_fild05',name:'Prontera Field 5',source:'database',monsters:[
  {classId:4000,name:'Poring',level:1,maxHp:51,spawnCount:70,visibleCount:2},
  {classId:4007,name:'Thief Bug',level:8,maxHp:152,spawnCount:10,visibleCount:0},
] };
describe('map monster selection', () => {
  it('starts with no implicit targets and keeps deliberate choices across live updates', () => {
    const targets=new MapTargets();targets.update('session',info,7);
    expect(targets.ids).toEqual([]);
    targets.select(4000,true);targets.update('session',info,7);
    expect(targets.ids).toEqual([4000]);
    targets.select(4000,false);targets.update('session',info,7);expect(targets.ids).toEqual([]);
  });
  it('clears old choices and types when map or game session changes', () => {
    const targets=new MapTargets();targets.update('session',info,7);targets.selectEligible();
    targets.update('session',{...info,code:'prontera',monsters:[]},7);
    expect(targets.ids).toEqual([]);expect(targets.options).toEqual([]);
    targets.update('session',info,7);targets.selectEligible();
    targets.update('next-session',info,7);expect(targets.ids).toEqual([]);
  });
  it('retains observed types leaving view and selection when metadata arrives', () => {
    const targets=new MapTargets();
    targets.update('session',{...info,source:'loading',monsters:[{...info.monsters[0]!,spawnCount:null}]},7);
    targets.select(4000,true);
    targets.update('session',{...info,source:'observed',monsters:[]},7);
    expect(targets.ids).toEqual([4000]);expect(targets.options[0]?.visibleCount).toBe(0);
    targets.update('session',info,7);expect(targets.options[0]?.spawnCount).toBe(70);expect(targets.ids).toEqual([4000]);
  });
  it('honors the level limit for individual choices and select eligible', () => {
    const targets=new MapTargets();targets.update('session',info,1);
    targets.select(4007,true);targets.select(9999,true);expect(targets.ids).toEqual([]);
    targets.selectEligible();expect(targets.ids).toEqual([4000]);
    targets.update('session',info,7);targets.selectEligible();expect(targets.ids).toEqual([4000,4007]);
    targets.clear();expect(targets.ids).toEqual([]);
    targets.update('session',info,null);targets.selectEligible();expect(targets.ids).toEqual([]);
  });
});

import { describe,expect,it } from 'vitest';
import { validFeatureStatus } from './feature-ui';
describe('extended controller telemetry',()=>{
  it('accepts bounded character and workflow state without requiring unavailable fields',()=>{
    expect(validFeatureStatus({})).toBe(true);
    expect(validFeatureStatus({loadout:{state:'holding',reason:'Waiting for target clear.',stock:3}})).toBe(true);
    expect(validFeatureStatus({loadout:{stock:Infinity}})).toBe(false);
    expect(validFeatureStatus({character:{inventoryKnown:true,inventory:[{bagId:1,itemId:501,count:3}],stats:{sp:20,maxSp:30}},workflow:{running:false,reason:'Stopped'}})).toBe(true);
  });
  it('rejects non-finite values, oversized arrays, long strings and deep trees',()=>{
    expect(validFeatureStatus({character:{stats:{sp:NaN}}})).toBe(false);
    expect(validFeatureStatus({world:{storage:Array(2049).fill(null)}})).toBe(false);
    expect(validFeatureStatus({workflow:{reason:'x'.repeat(8193)}})).toBe(false);
    let value:unknown=0;for(let n=0;n<12;n++)value={nested:value};expect(validFeatureStatus({character:value})).toBe(false);
  });
  it('rejects incomplete barter telemetry before rendering',()=>{
    expect(validFeatureStatus({world:{barter:[{}]}})).toBe(false);
    expect(validFeatureStatus({world:{barter:[{item:{itemId:501},required:undefined}]}})).toBe(false);
    expect(validFeatureStatus({world:{barter:[{item:{itemId:501},required:[{}]}]}})).toBe(false);
    expect(validFeatureStatus({world:{barter:[{item:{itemId:501},required:[{itemId:502,count:2}]}]}})).toBe(true);
  });
});

import {ActorObservations} from './actor-observations';
import {actorSnapshotAt} from './actor-predicate-ui';
it('bounds actor telemetry and never freshens the last observed game frame during UI dry runs',()=>{
 const observations=new ActorObservations(()=>1000);observations.spawn({id:1,kind:0,classId:0,name:'Player',level:1,hp:10,maxHp:10,x:1,y:1,dead:false,statuses:[]});observations.frame();const snapshot=observations.snapshot(1,null,true);
 expect(validFeatureStatus({actorObservations:snapshot})).toBe(true);expect(actorSnapshotAt(snapshot,20000)?.lastFrameAt).toBe(1000);expect(actorSnapshotAt(snapshot,20000)?.at).toBe(20000);
 expect(validFeatureStatus({actorObservations:{...snapshot,world:'invalid'}})).toBe(false);expect(validFeatureStatus({actorObservations:{...snapshot,actors:Array(65).fill(snapshot.actors[0])}})).toBe(false);
});

it('bounds attack strategy ledger telemetry without allowing non-finite counts',()=>{expect(validFeatureStatus({attackStrategies:{pending:false,truncated:false,entries:[{id:2,normalStarted:false,rules:[{id:'open',attempts:1,uses:0,uncertain:true}]}]}})).toBe(true);expect(validFeatureStatus({attackStrategies:{entries:[{rules:[{attempts:NaN}]}]}})).toBe(false);expect(validFeatureStatus({attackStrategies:{entries:Array(2049).fill(null)}})).toBe(false);});

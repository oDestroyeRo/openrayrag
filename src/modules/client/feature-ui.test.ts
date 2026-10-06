import { describe,expect,it } from 'vitest';
import { FeatureUi, chooseFollowMode, validFeatureStatus } from './feature-ui';
describe('extended controller telemetry',()=>{
  it('clears macro ownership on game close while preserving the editor draft',()=>{
    let rendered:unknown='previous';
    const draft={text:'unsaved script'};
    const view=Object.assign(Object.create(FeatureUi.prototype),{status:{macro:{state:'monitoring'}},macroUi:{draft,render:(value:unknown)=>{rendered=value;}},refine:{settledForMaintenance:()=>true}});
    expect(view.active()).toBe(true);expect(view.settledForMaintenance()).toBe(false);
    view.clearMacro();
    expect(view.active()).toBe(false);expect(view.settledForMaintenance()).toBe(true);expect(rendered).toBeUndefined();
    expect(draft.text).toBe('unsaved script');
  });
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

import {ActorObservations} from '../world/actor-observations';
import {actorSnapshotAt} from '../world/actor-predicate-ui';
it('bounds actor telemetry and never freshens the last observed game frame during UI dry runs',()=>{
 const observations=new ActorObservations(()=>1000);observations.spawn({id:1,kind:0,classId:0,name:'Player',level:1,hp:10,maxHp:10,x:1,y:1,dead:false,statuses:[]});observations.frame();const snapshot=observations.snapshot(1,null,true);
 expect(validFeatureStatus({actorObservations:snapshot})).toBe(true);expect(actorSnapshotAt(snapshot,20000)?.lastFrameAt).toBe(1000);expect(actorSnapshotAt(snapshot,20000)?.at).toBe(20000);
 expect(validFeatureStatus({actorObservations:{...snapshot,world:'invalid'}})).toBe(false);expect(validFeatureStatus({actorObservations:{...snapshot,actors:Array(65).fill(snapshot.actors[0])}})).toBe(false);
});

it('bounds attack strategy ledger telemetry without allowing non-finite counts',()=>{expect(validFeatureStatus({attackStrategies:{pending:false,truncated:false,entries:[{id:2,normalStarted:false,rules:[{id:'open',attempts:1,uses:0,uncertain:true}]}]}})).toBe(true);expect(validFeatureStatus({attackStrategies:{entries:[{rules:[{attempts:NaN}]}]}})).toBe(false);expect(validFeatureStatus({attackStrategies:{entries:Array(2049).fill(null)}})).toBe(false);});

it('bounds party engagement diagnostics without exposing affiliation or permitting invalid counts',()=>{
 expect(validFeatureStatus({partyEngagement:{enabled:true,accepted:1,blocked:2,reasons:['Party engagement unavailable: revoked party membership.']}})).toBe(true);
 for(const change of [{partyId:5},{enabled:1},{accepted:NaN},{accepted:151},{accepted:-1},{blocked:150,accepted:1},{reasons:Array(5).fill('unknown')},{reasons:['x'.repeat(161)]}])expect(validFeatureStatus({partyEngagement:{enabled:true,accepted:0,blocked:0,reasons:[],...change}})).toBe(false);
});

it('mode selection explicitly clears conflicts and rendezvous telemetry remains strict',()=>{
 expect(chooseFollowMode({name:'Leader',distance:8,lostSeconds:15},'partyLeader')).toEqual({name:'',distance:8,lostSeconds:15,mode:'partyLeader'});
 expect(chooseFollowMode({name:'',distance:4,lostSeconds:10,mode:'partyLeader',rendezvous:true},'name').rendezvous).toBe(false);
 const status={state:'preparing',reason:'Waiting for movement.',destination:'prontera',remainingSeconds:8,attemptUsed:true,ownsTravel:true};
 expect(validFeatureStatus({partyFollow:status})).toBe(true);
 for(const changed of [{...status,remainingSeconds:121},{...status,remainingSeconds:NaN},{...status,memberId:7},{...status,state:'unknown'},{...status,ownsTravel:1}])expect(validFeatureStatus({partyFollow:changed})).toBe(false);
});

it('locks the actual follow controls according to mutually exclusive mode and configuration ownership',()=>{
 const mode={value:'partyLeader'},name={disabled:false},rendezvous={disabled:false};
 const controls:Record<string,object>={'follow.mode':mode,'follow.name':name,'follow.rendezvous':rendezvous};
 const view=Object.assign(Object.create(FeatureUi.prototype),{locked:false,host:{querySelector:(selector:string)=>controls[selector.match(/"([^"]+)"/)![1]!]}});
 const sync=()=>Reflect.apply(Reflect.get(FeatureUi.prototype,'syncFollowMode'),view,[]);
 sync();expect(name.disabled).toBe(true);expect(rendezvous.disabled).toBe(false);
 mode.value='name';sync();expect(name.disabled).toBe(false);expect(rendezvous.disabled).toBe(true);
 view.locked=true;mode.value='partyLeader';sync();expect(name.disabled).toBe(true);expect(rendezvous.disabled).toBe(true);
});

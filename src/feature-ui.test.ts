import { describe,expect,it } from 'vitest';
import { validFeatureStatus } from './feature-ui';
describe('extended controller telemetry',()=>{
  it('accepts bounded character and workflow state without requiring unavailable fields',()=>{
    expect(validFeatureStatus({})).toBe(true);
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

import {describe,it,expect} from 'vitest';
import {refineCommand,validateRefineRequest,validateRefineAdvance} from './refine-protocol';
import {validControllerAction} from './controller';
import cases from './data/refine-request-cases.json';
import {DEFAULT_AUTOMATION,validateAutomation} from './settings';
describe('manual refine boundary',()=>{
 it('encodes only the source opcode80 no-catalyst fields',()=>expect([...refineCommand({targetBagId:0x12345678,oreItemId:984,catalystBagId:0})]).toEqual([80,120,86,52,18,216,3,0,0,0,0,0,0]));
 it.each(cases)('$name',row=>{const request=row.request;
  if(row.mode==='refineAdvance'){if(row.valid)expect(validateRefineAdvance(request)).toHaveLength(32);else expect(()=>validateRefineAdvance(request)).toThrow();return;}
  if(row.valid){const parsed=row.mode==='refinePreview'?validateRefineRequest(request,true):validateRefineRequest(request);expect(parsed.targetBagId).toBeGreaterThan(0);}
  else expect(()=>row.mode==='refinePreview'?validateRefineRequest(request,true):validateRefineRequest(request)).toThrow();
  expect(validControllerAction(request)).toBe(false);
 });
 it('rejects malformed wire requests including catalysts',()=>{for(const value of [{targetBagId:1,oreItemId:984,catalystBagId:1},{targetBagId:0,oreItemId:984,catalystBagId:0},{targetBagId:1,oreItemId:0,catalystBagId:0},{targetBagId:1,oreItemId:984,catalystBagId:0,raw:[80]}])expect(()=>refineCommand(value as never)).toThrow();});
});

it('enforces the whole native request budget even when every policy collection is otherwise valid',()=>{const policy=structuredClone(DEFAULT_AUTOMATION);policy.combat.rules=Array.from({length:64},(_,i)=>({classId:4000+i,action:'attack',priority:0,conditions:Array.from({length:16},()=>({field:'actorStatus',actor:{scope:'self'},statusId:6,operator:'eq',value:false}))}));expect(()=>validateAutomation(policy)).not.toThrow();const input={targetBagId:700,catalystBagId:0,maxSpend:10000,minZeny:0,policy};expect(new TextEncoder().encode(JSON.stringify(input)).length).toBeGreaterThan(65536);expect(()=>validateRefineRequest(input,true)).toThrow('limit');});
it('rejects lone UTF16 surrogate policy text before native serialization while accepting a paired scalar',()=>{const policy=structuredClone(DEFAULT_AUTOMATION);const input={targetBagId:700,catalystBagId:0,maxSpend:10000,minZeny:0,policy};for(const name of ['\ud800','\udfff','x\ud800y']){policy.follow.name=name;expect(()=>validateRefineRequest(input,true)).toThrow('text');}policy.follow.name='😀';expect(()=>validateRefineRequest(input,true)).not.toThrow();});

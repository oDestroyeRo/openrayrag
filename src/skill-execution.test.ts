import {describe,it,expect} from 'vitest';
import {matchesSkillExecution} from './skill-execution';
import {AutomationScheduler} from './automation';
import {CharacterState} from './character-state';
import type {ExpandedAction,SkillResult} from './protocol-feature';
describe('exact skill execution matching used by active and canceled owners',()=>{
 it('requires exact ground coordinates and rejects missing coordinate/mode/level/source/indirect evidence',()=>{const action:ExpandedAction={type:'skill',mode:'ground',skillId:19,level:4,position:{x:20,y:30}};const event:SkillResult={type:'skillResult',mode:'ground',source:1,skillId:19,level:4,targetPosition:{x:20,y:30},position:{x:10,y:10},motionSeconds:1.5};for(const mismatch of [{targetPosition:undefined},{targetPosition:{x:20,y:31}},{targetPosition:{x:21,y:30}},{mode:'self' as const},{level:3},{source:2},{skillId:11},{indirect:true}])expect(matchesSkillExecution(action,{...event,...mismatch},1)).toBe(false);expect(matchesSkillExecution(action,event,1)).toBe(true);const scheduler=new AutomationScheduler(()=>{},()=>1000);scheduler.submit(action,new CharacterState());expect(scheduler.observe({...event,targetPosition:{x:20,y:31}},new CharacterState(),1).confirmed).toBe(false);expect(scheduler.observe(event,new CharacterState(),1).confirmed).toBe(true);});
});

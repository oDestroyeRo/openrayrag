import { skillId as domainSkillId } from './domain-values';
import { describe, expect, it } from 'vitest';
import { CompanionController } from './controller';
import { BitWriter } from './binary';
import { DEFAULT_SETTINGS } from './settings';
import type { Entity } from './protocol';
import type { ManualSocialAction } from './social-protocol';

const player:Entity={id:1,classId:0,name:'Synthetic',kind:0,level:7,hp:100,maxHp:100,x:10,y:10,dead:false};
const chat={type:'chat' as const,channel:0 as const,text:'Literal <b>/hello %</b>'};
function fixture(){let now=1000;const sent:ManualSocialAction[]=[];const controller=new CompanionController(()=>{},()=>now,()=>({width:20,height:20,walkable:()=>true}),a=>sent.push(a));controller.connect(true);
 controller.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player}]);controller.world.reset('prt_fild08');
 const packet=(w:BitWriter,generation?:number)=>controller.receive(w.finish(),generation);
 const echo=(actor=1,text=chat.text)=>packet(new BitWriter().u8(44).i32(actor).string(text).string('Synthetic').u8(0));
 return{controller,sent,packet,echo,advance:(ms:number)=>{now+=ms;controller.tick();}};}
describe('manual social controller boundary',()=>{
 it('shares ownership and reports only server echoes, with no logs containing message content',()=>{const t=fixture();t.controller.perform('social',chat);expect(t.sent).toEqual([chat]);expect(t.controller.active).toBe(true);expect(()=>t.controller.perform('social',chat)).toThrow();expect(()=>t.controller.perform('command',{type:'sit',sitting:true})).toThrow();t.echo(2);expect(t.controller.social.busy).toBe(true);t.echo();expect(t.controller.snapshot().social.state).toBe('echo');expect(t.controller.snapshot().log.map(row=>JSON.stringify(row)).join('')).not.toContain(chat.text);});
 it('rejects field-running, stale, missing party and granted-only skill evidence immediately',()=>{const t=fixture();expect(()=>t.controller.perform('social',{...chat,channel:2})).toThrow('party');t.controller.engine.character.granted.set(domainSkillId(1),10);expect(()=>t.controller.perform('social',{...chat,channel:1})).toThrow('learned');expect(()=>t.controller.perform('social',{type:'emote',id:0})).toThrow('learned');t.controller.engine.character.skillsKnown=true;t.controller.engine.character.learned.set(domainSkillId(1),7);t.controller.perform('social',{type:'emote',id:0});t.controller.stop();t.advance(16000);expect(()=>t.controller.perform('social',chat)).toThrow('stale');expect(t.sent).toHaveLength(1);
  const running=fixture();running.controller.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]});expect(()=>running.controller.perform('social',chat)).toThrow();expect(running.sent).toEqual([]);});
 it('cancels on Stop, world changes, connection and character replacement without replay',()=>{for(const reason of ['Stop','map','clear','socket','character']){const t=fixture();t.controller.perform('social',chat);const old=t.controller.connectionGeneration;
  if(reason==='Stop')t.controller.stop();else if(reason==='map')t.packet(new BitWriter().u8(18).string('prt_fild05'));else if(reason==='clear')t.packet(new BitWriter().u8(16));else if(reason==='socket'){t.controller.disconnect();t.controller.connect(true);}else t.packet(new BitWriter().u8(3).i32(2).string('prt_fild08'));
  expect(t.controller.social.busy).toBe(false);t.echo();t.packet(new BitWriter().u8(44).i32(1).string(chat.text).string('Synthetic').u8(0),old);t.advance(500);expect(t.sent,reason).toHaveLength(1);expect(t.controller.snapshot().social.state).not.toBe('echo');}});
 it('receives no social instructions through automated documents and keeps the ten-second window finite',()=>{const t=fixture();for(const mode of ['command','routine','workflow','service'] as const)expect(()=>t.controller.perform(mode,chat)).toThrow();t.controller.perform('social',chat);t.advance(10000);expect(t.controller.social.busy).toBe(false);t.echo();expect(t.controller.snapshot().social.state).toBe('unconfirmed');expect(t.sent).toEqual([chat]);});
 it('rejects old window/socket-generation echoes after a new ready session and clears on identity replacement',()=>{const t=fixture();t.packet(new BitWriter().u8(19).i32(1));t.controller.perform('social',chat);const generation=t.controller.connectionGeneration;t.controller.disconnect();t.controller.connect(true);
  t.controller.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:player}]);t.controller.world.reset('prt_fild08');t.controller.perform('social',{...chat,text:'New session'});
  t.packet(new BitWriter().u8(44).i32(1).string('New session').string('Synthetic').u8(0),generation);expect(t.controller.social.busy).toBe(true);expect(t.controller.snapshot().social.history).toHaveLength(1);
  t.echo(1,'New session');expect(t.controller.snapshot().social.state).toBe('echo');t.controller.perform('social',{...chat,text:'Changed identity'});
  t.controller.engine.receive([{type:'spawn',entity:{...player,name:'Different character'}}]);t.echo(1,'Changed identity');expect(t.controller.social.busy).toBe(false);expect(t.controller.snapshot().social.state).toBe('idle');expect(t.sent).toHaveLength(3);
 });
 it('preserves a leading BOM through the full decoder and own-echo comparison',()=>{const t=fixture();const text='\ufeffliteral';t.controller.perform('social',{...chat,text});t.packet(new BitWriter().u8(44).i32(1).string(text).string('\ufeffSynthetic').u8(0));
  expect(t.controller.snapshot().social.state).toBe('echo');expect(t.controller.snapshot().social.history.at(-1)).toMatchObject({text,name:'\ufeffSynthetic'});expect(t.sent).toEqual([{...chat,text}]);
 });
});

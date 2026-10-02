import { describe,expect,it } from 'vitest';
import { CompanionController, validControllerAction } from './controller';
import { BitWriter } from './binary';
import { DEFAULT_SETTINGS,validateSettings } from './settings';
import { validateRoutineSpec } from './routines';
import { memoPreview } from './memo';
import type { MemoSlots } from './memo-protocol';
import type { Entity } from './protocol';
const p:Entity={id:1,classId:4,name:'Synthetic',kind:0,level:30,hp:100,maxHp:100,x:10,y:10,dead:false};
const empty:MemoSlots=[null,null,null,null],saved:MemoSlots=[{map:'prt_fild08',x:10,y:10},null,null,null];
function fixture(){let now=1000;const sent:number[]=[];const actions:unknown[]=[];const c=new CompanionController(a=>actions.push(a),()=>now,()=>({width:20,height:20,walkable:()=>true}),()=>{},slot=>sent.push(slot));c.connect(true);c.engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...p}}]);c.world.reset('prt_fild08');c.engine.character.skillsKnown=true;c.engine.character.learned.set(55,4);
 const packet=(w:BitWriter,epoch?:number)=>c.receive(w.finish(),epoch);
 const slots=(values:MemoSlots=empty,epoch?:number)=>{const w=new BitWriter().u8(94);for(const loc of values){w.u8(loc?1:0);if(loc)w.string(loc.map).i16(loc.x).i16(loc.y);}packet(w,epoch);};
 slots();const request=()=>memoPreview(c.snapshot().memo,0).request!;
 return {c,sent,actions,packet,slots,request,ack:(slot=0)=>packet(new BitWriter().u8(91).u8(8).i32(slot).string('')),advance:(ms:number)=>{now+=ms;c.tick();}};}
describe('manual memo controller ownership',()=>{
 it('uses separate manual dispatch and complete source receipts, never generic automation',()=>{const t=fixture(),request=t.request();expect(validControllerAction(request)).toBe(false);for(const mode of ['command','workflow','routine','service','social'] as const)expect(()=>t.c.perform(mode,request)).toThrow();expect(()=>validateRoutineSpec({name:'No memo',durationSeconds:1,maxActions:1,rules:[{name:'No memo',priority:0,cooldownSeconds:0,maxRuns:1,conditions:[{field:'hpPercent',operator:'lte',value:100}],action:request}]},validControllerAction)).toThrow();expect(()=>validateSettings({...DEFAULT_SETTINGS,...{memo:request}})).toThrow();
  t.c.perform('memo',request);expect(t.c.snapshot().memo.state).toBe('sent');expect(t.c.active).toBe(true);expect(()=>t.c.perform('command',{type:'sit',sitting:true})).toThrow();expect(()=>t.c.perform('social',{type:'chat',channel:0,text:'test'})).toThrow();expect(()=>t.c.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]})).toThrow();t.ack();t.slots(saved);expect(t.c.snapshot().memo.state).toBe('confirmed');expect(t.sent).toEqual([0]);});
 it('rejects stale preview, granted-only skill, unknown/forbidden map, nonwalkable cell and field run',()=>{const t=fixture();t.c.engine.character.learned.delete(55);t.c.engine.character.granted.set(55,4);expect(()=>t.c.perform('memo',t.request())).toThrow();t.c.engine.character.learned.set(55,4);const r=t.request();t.slots();expect(()=>t.c.perform('memo',r)).toThrow('stale');t.c.engine.map='unknown_map';expect(t.c.snapshot().memo.ready).toBeNull();t.c.engine.map='pay_dun00';expect(t.c.snapshot().memo.unavailable).toContain('forbids');t.c.engine.map='prt_fild08';t.c.engine.player!.x=25;expect(t.c.snapshot().memo.unavailable).toContain('walkable');t.c.engine.player!.x=10;t.c.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]});expect(t.c.snapshot().memo.ready).toBeNull();expect(t.sent).toEqual([]);});
 it('does not authorize an accepted moving path or an unsettled skill owner',()=>{const t=fixture(),r=t.request();t.c.engine.receive([{type:'walk',id:1,walk:{origin:{x:10,y:10},cells:[{x:10,y:10},{x:11,y:10}],secondsPerCell:1,firstSeconds:1,locked:false}}]);expect(()=>t.c.perform('memo',r)).toThrow();t.advance(500);expect(t.c.snapshot().memo.ready).toBeNull();expect(t.sent).toEqual([]);});
 it('keeps an explicit unACKed walk fenced through Stop, time and delayed old position/attack',()=>{const t=fixture();const walk={type:'walk' as const,destination:{x:11,y:10}};
  Reflect.apply(Reflect.get(CompanionController.prototype,'send'),t.c,[walk]);t.c.stop();t.advance(6000);
  t.packet(new BitWriter().u8(10).i32(1).i16(10).i16(10));expect(t.c.snapshot().memo.ready).toBeNull();
  t.packet(new BitWriter().u8(11).i32(1).i32(2).i32(0).i16(10).i16(10));expect(t.c.snapshot().memo.ready).toBeNull();
  // Source-shaped unlocked path: two cells, east direction, one second total.
  t.packet(new BitWriter().u8(7).i32(1).i16(10).i16(10).f32(10).f32(10).f32(1).f32(1).u8(2).u8(0x60).u8(0));
  expect(t.c.snapshot().memo.ready).toBeNull();t.advance(1100);t.packet(new BitWriter().u8(19).i32(1));expect(t.c.snapshot().memo.ready?.x).toBe(11);expect(t.sent).toEqual([]);
 });
 it('cannot confirm generic failures, malformed notifications, death or a different physical cell',()=>{for(const packet of [new BitWriter().u8(42).u8(1),new BitWriter().u8(91).u8(8).i32(4).string(''),new BitWriter().u8(91).u8(8).i32(0).string('not source'),new BitWriter().u8(10).i32(1).i16(11).i16(10),new BitWriter().u8(36).i32(1).i16(10).i16(10)]){const t=fixture();t.c.perform('memo',t.request());t.packet(packet);t.ack();t.slots(saved);expect(t.c.snapshot().memo.state).not.toBe('confirmed');expect(t.sent).toEqual([0]);}});
 it('does not treat BOM-only notification text as the exact empty source acknowledgement',()=>{const t=fixture();t.c.perform('memo',t.request());t.packet(new BitWriter().u8(91).u8(8).i32(0).string('\ufeff'));t.slots(saved);expect(t.c.snapshot().memo.state).toBe('uncertain');expect(t.sent).toEqual([0]);});
 it('preserves a sent/held fence through same-connection own-incarnation replacement or Enter until full readback',()=>{
  for(const boundary of ['spawn','enter'])for(const canceled of [false,true]){const t=fixture();t.c.perform('memo',t.request());if(canceled)t.c.stop();
    if(boundary==='enter')t.packet(new BitWriter().u8(3).i32(1).string('prt_fild08'));
    t.c.engine.receive([{type:'spawn',entity:{...p}}]);t.packet(new BitWriter().u8(19).i32(1));
    expect(t.c.snapshot().memo.slots).toBeNull();expect(t.c.memo.blocked).toBe(true);expect(t.c.snapshot().memo.state).toBe('uncertain');
    expect(()=>t.c.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]})).toThrow();expect(()=>t.c.perform('command',{type:'sit',sitting:true})).toThrow();
    t.slots(saved);expect(t.c.memo.blocked).toBe(false);expect(t.c.snapshot().memo.state).toBe('uncertain');expect(t.sent).toEqual([0]);
  }
 });
 it('cancels on Stop/map/clear/socket/character changes, fences old epochs and never replays',()=>{for(const reason of ['Stop','map','clear','socket','character']){const t=fixture();t.c.perform('memo',t.request());const epoch=t.c.connectionGeneration;if(reason==='Stop')t.c.stop();else if(reason==='map')t.packet(new BitWriter().u8(18).string('prt_fild07'));else if(reason==='clear')t.packet(new BitWriter().u8(16));else if(reason==='socket'){t.c.disconnect();t.c.connect(true);}else t.packet(new BitWriter().u8(3).i32(2).string('prt_fild08'));expect(t.c.memo.busy).toBe(false);t.ack();t.slots(saved,epoch);t.advance(1000);expect(t.c.snapshot().memo.state).not.toBe('confirmed');expect(t.sent).toEqual([0]);}});
 it('keeps timeout uncertainty blocked until full state and rejects old socket packets',()=>{const t=fixture();t.c.perform('memo',t.request());t.advance(10000);expect(t.c.memo.blocked).toBe(true);expect(()=>t.c.start({...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000]})).toThrow();expect(()=>t.c.perform('service',{})).toThrow();t.ack();t.slots(saved);expect(t.c.memo.blocked).toBe(false);expect(t.c.snapshot().memo.state).toBe('uncertain');expect(t.sent).toEqual([0]);const epoch=t.c.connectionGeneration;t.c.disconnect();t.c.connect(true);t.slots(saved,epoch);expect(t.c.snapshot().memo.slots).toBeNull();});
 it('retains the actual initial post-enter/pre-spawn readback without default identity authority',()=>{const t=fixture();t.packet(new BitWriter().u8(3).i32(2).string('prt_fild08'));t.slots();expect(t.c.snapshot().memo.slots).toEqual(empty);expect(t.c.snapshot().memo.ready).toBeNull();t.c.engine.receive([{type:'spawn',entity:{...p,id:2}},{type:'skills',learned:[{skillId:55,level:4}]}]);t.packet(new BitWriter().u8(19).i32(2));expect(t.c.snapshot().memo.ready?.actorId).toBe(2);expect(t.sent).toEqual([]);});
});

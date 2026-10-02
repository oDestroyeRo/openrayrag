import resourceCases from './data/actor-resource-condition-cases.json';
import { describe, expect, it } from 'vitest';
import { ActorObservations, evaluateActorPredicate, validActorConditions, validActorSnapshot, type ActorPredicate } from './actor-observations';
import { RESOURCE_OPERATORS } from './actor-resources';
import { BotEngine } from './engine';
import type { Entity } from './protocol';
import { WorldState } from './world-state';
import type { PartyMember, WorldEvent } from './world-protocol';
const entity:Entity={id:2,kind:0,classId:0,name:'Member',level:10,hp:100,maxHp:100,sp:0,maxSp:0,x:10,y:10,dead:false,statuses:[],partyId:5,partyName:'Party'};
const member:PartyMember={memberId:7,entityId:2,level:10,name:'Member',leader:false,map:'prontera',hp:100,maxHp:100,sp:50,maxSp:100};
const hp:ActorPredicate={field:'actorHpPercent',actor:{scope:'target'},operator:'eq',value:100};
const sp:ActorPredicate={field:'actorSpPercent',actor:{scope:'target'},operator:'eq',value:50};
function setup(spawn=true) {
  let at=1000, worldId=0;const observations=new ActorObservations(()=>at,()=>`00000000-0000-0000-0000-${String(++worldId).padStart(12,'0')}`);
  const world=new WorldState();world.reset('prontera');if(spawn)observations.spawn({...entity});observations.frame();
  const sync=()=>world.partyActors.sync(world.party,world.map,observations,1);
  const event=(event:WorldEvent)=>{world.apply(event,1);world.partyActors.observe(event,world.party,world.map,observations,1);};
  const join=(members=[member])=>event({type:'partyJoined',partyId:5,name:'Party',login:false,members});
  const snapshot=()=>observations.snapshot(1,2,true);
  const trace=(condition:ActorPredicate=hp)=>evaluateActorPredicate(condition,snapshot());
  return {observations,world,snapshot,trace,sync,event,join,advance:(ms:number)=>{at+=ms;},set:(value:number)=>{at=value;}};
}
describe('observed actor resource predicates',()=>{
 it('shares exact resource schema cases with the native validator',()=>{for(const row of resourceCases)expect(validActorConditions([row.condition]),JSON.stringify(row.condition)).toBe(row.valid);});
 it('keeps numerical boundaries, unknown signs and strict condition schema',()=>{
  const s=setup();for(const [operator,expected] of [['lt','unmatched'],['lte','matched'],['eq','matched'],['gte','matched'],['gt','unmatched']] as const)expect(s.trace({...hp,operator}).state).toBe(expected);
  for(const value of [0,100,0.25])for(const operator of RESOURCE_OPERATORS)expect(validActorConditions([{...hp,operator,value}])).toBe(true);
  for(const change of [{value:-1},{value:100.001},{value:NaN},{value:Infinity},{value:'50'},{value:true},{operator:'ne'},{operator:'gte;code'},{extra:1},{skillId:1}])expect(validActorConditions([{...hp,...change}])).toBe(false);
  for(const operator of RESOURCE_OPERATORS)expect(s.trace({...sp,operator,value:0}).state).toBe('unavailable');
 });
 it('compares exact percentage boundaries without division rounding changing equality',()=>{const s=setup();s.observations.apply({type:'heal',id:2,hp:29,maxHp:100});expect(s.trace({...hp,value:29}).state).toBe('matched');expect(s.trace({...hp,operator:'lt',value:29}).state).toBe('unmatched');expect(s.trace({...hp,operator:'gt',value:29}).state).toBe('unmatched');});
 it('supports self zero, target, explicit lifetime and monster-only candidate selectors',()=>{
  const s=setup(false);s.observations.spawn({...entity,id:0,sp:0,maxSp:100},0);const snap=s.observations.snapshot(0,0,true,[],true,0);
  for(const actor of [{scope:'self'},{scope:'target'},{scope:'actor',id:0,world:snap.world,incarnation:snap.actors[0]!.incarnation}] as const){expect(evaluateActorPredicate({...hp,actor},snap).state).toBe('matched');expect(evaluateActorPredicate({...sp,actor,value:0},snap).state).toBe('matched');}
  expect(evaluateActorPredicate({...hp,actor:{scope:'candidate'}},snap).state).toBe('unavailable');s.observations.spawn({...entity,id:3,kind:1});expect(evaluateActorPredicate({...hp,actor:{scope:'candidate'}},s.observations.snapshot(0,null,true,[],true,3)).state).toBe('matched');
  expect(validActorConditions([{...hp,actor:{scope:'candidate'}}])).toBe(false);expect(validActorConditions([{...hp,actor:{scope:'candidate'}}],true)).toBe(true);
 });
 it('does not infer nonparty or enemy SP even from nonzero spawn data',()=>{
  const s=setup();for(const kind of [0,1,2,4]){s.observations.spawn({...entity,kind,sp:99,maxSp:100});expect(s.trace(sp).state).toBe('unavailable');}
 });
 it('does not interpret unsupported snapshot SP provenance as enemy or arbitrary-player evidence',()=>{const s=setup();const snap=s.snapshot();for(const kind of [0,1]){snap.actors[0]!.kind=kind;snap.actors[0]!.sp={value:50,max:100,at:1000,source:'spawn',reason:null};expect(evaluateActorPredicate(sp,snap).state).toBe('unavailable');}snap.actors[0]!.sp!.source='party';expect(evaluateActorPredicate(sp,snap).state).toBe('unavailable');});
 it('applies spawn, damage and recovery in exact order, ignoring visual combat',()=>{
  const s=setup();const hit={type:'hit' as const,id:2,damage:20,position:{x:10,y:10}};
  s.observations.apply(hit);expect(s.trace({...hp,value:80}).state).toBe('matched');
  s.observations.apply({type:'attack',source:1,target:2,position:{x:10,y:10}});
  s.observations.apply({type:'skillImpact',source:1,target:2,skillId:11,damage:20,damageSeconds:0,hits:1,result:1,position:{x:10,y:10}});
  expect(s.trace({...hp,value:80}).state).toBe('matched');s.observations.apply({type:'heal',id:2,hp:90,maxHp:100});s.observations.apply(hit);expect(s.trace({...hp,value:70}).state).toBe('matched');
 });
 it('deduplicates only the exact captured context, never matching numeric values',()=>{
  const s=setup();s.join();const hit={type:'hit' as const,id:2,damage:10,position:{x:10,y:10}};const captured=s.observations.context(2);
  s.observations.apply(hit,captured);s.observations.apply(hit,captured);expect(s.trace({...hp,value:90}).state).toBe('matched');
  s.event({type:'partyHealth',memberId:7,hp:90,maxHp:100,sp:60,maxSp:100});s.observations.apply(hit);expect(s.trace({...hp,value:80}).state).toBe('matched');
  s.event({type:'partyHealth',memberId:7,hp:75,maxHp:100,sp:60,maxSp:100});s.observations.apply(hit);s.observations.apply({type:'heal',id:2,hp:95,maxHp:100});s.observations.apply(hit);expect(s.trace({...hp,value:85}).state).toBe('matched');
 });
 it('never revives invalid or stale baselines with fresh damage',()=>{
  const s=setup();for(const [hpValue,maxHp] of [[50,0],[101,100],[NaN,100],[50,Infinity],[1.5,100]]){s.observations.apply({type:'heal',id:2,hp:hpValue!,maxHp:maxHp!});s.observations.apply({type:'hit',id:2,damage:1,position:{x:10,y:10}});expect(s.trace().state).toBe('unavailable');}
  s.observations.apply({type:'heal',id:2,hp:100,maxHp:100});s.advance(15_001);s.observations.frame();s.observations.apply({type:'hit',id:2,damage:1,position:{x:10,y:10}});expect(s.trace().state).toBe('unavailable');
  s.observations.apply({type:'heal',id:2,hp:100,maxHp:100});expect(s.trace().state).toBe('matched');s.observations.apply({type:'hit',id:2,damage:-1,position:{x:10,y:10}});expect(s.trace().state).toBe('unavailable');
 });
 it('keeps independent HP/SP clocks and does not refresh them on status or unrelated traffic',()=>{
  const s=setup(false);s.observations.spawn({...entity,id:0,sp:50,maxSp:100},0);s.advance(15_000);s.observations.frame();const selfHp={...hp,actor:{scope:'self' as const}};const snap=()=>s.observations.snapshot(0,null,true);
  expect(evaluateActorPredicate(selfHp,snap()).state).toBe('matched');s.advance(1);s.observations.apply({type:'sp',sp:50,maxSp:100},undefined,0);s.observations.apply({type:'status',id:0,statusId:1,seconds:10});s.observations.frame();expect(evaluateActorPredicate(selfHp,snap()).state).toBe('unavailable');expect(evaluateActorPredicate({...sp,actor:{scope:'self'}},snap()).state).toBe('matched');
  s.set(999);expect(evaluateActorPredicate({...sp,actor:{scope:'self'}},snap()).state).toBe('unavailable');s.observations.frame();expect(snap().actors).toEqual([]);
 });
 it('rejects late captured contexts and out-of-order resource histories',()=>{
  const s=setup();const old=s.observations.context(2);s.advance(1);s.observations.apply({type:'heal',id:2,hp:60,maxHp:100});s.observations.partyResources(2,member,old);expect(s.trace({...hp,value:60}).state).toBe('matched');
  s.observations.spawn({...entity});s.observations.partyResources(2,member,old);expect(s.trace(sp).state).toBe('unavailable');s.observations.apply({type:'heal',id:2,hp:5,maxHp:100},old);expect(s.trace().state).toBe('matched');
  s.advance(100);s.observations.apply({type:'heal',id:2,hp:100,maxHp:100});const outOfOrder={...s.observations.context(2),at:1001};s.observations.apply({type:'hit',id:2,damage:1,position:{x:10,y:10}},outOfOrder);expect(s.trace().state).toBe('unavailable');
 });
 it('requires fresh resource maxima and affiliation after resurrection, without reusing cached spawn values',()=>{
  const engine=new BotEngine(()=>{},()=>1000);engine.connect(true);engine.receive([{type:'enter',id:0,map:'prontera'},{type:'spawn',entity:{...entity,id:0,sp:50,maxSp:100}},{type:'death',id:0},{type:'resurrection',id:0,hp:50,position:{x:10,y:10}}]);
  for(const condition of [hp,sp])expect(evaluateActorPredicate({...condition,actor:{scope:'self'}},engine.actorObservation()).state).toBe('unavailable');expect(engine.observations.partyActor(0)?.partyId).toBeNull();
  engine.receive([{type:'stats',level:10,hp:50,maxHp:100,sp:20,maxSp:100}]);expect(evaluateActorPredicate({...hp,actor:{scope:'self'},value:50},engine.actorObservation()).state).toBe('matched');
 });
 it('does not match SP for a known zero-HP actor',()=>{const s=setup();s.join();s.event({type:'partyHealth',memberId:7,hp:0,maxHp:100,sp:50,maxSp:100});expect(s.trace(sp).state).toBe('unavailable');});
 it('publishes bounded detached resource observations and rejects malformed snapshots',()=>{
  const s=setup();s.join();const snap=s.snapshot();expect(validActorSnapshot(snap)).toBe(true);snap.actors[0]!.hp!.value=1;expect(s.trace().state).toBe('matched');
  for(const change of [{max:0},{value:101},{at:Infinity},{source:'skill-cost'},{reason:'code'},{extra:1}]){const value=s.snapshot();Object.assign(value.actors[0]!.hp!,change);expect(validActorSnapshot(value)).toBe(false);}
  for(let id=3;id<400;id++)s.observations.spawn({...entity,id});expect(s.snapshot().actors).toHaveLength(64);expect(JSON.stringify(s.snapshot()).length).toBeLessThan(65_536);
 });
 it('captures verified own stats/SP in engine without generating commands',()=>{
  const sent:unknown[]=[];const engine=new BotEngine(action=>sent.push(action),()=>1000);engine.connect(true);engine.receive([{type:'enter',id:0,map:'prontera'},{type:'spawn',entity:{...entity,id:0,sp:30,maxSp:100}},{type:'stats',hp:75,maxHp:100,sp:40,maxSp:100,level:10}]);
  expect(evaluateActorPredicate({...hp,actor:{scope:'self'},value:75},engine.actorObservation()).state).toBe('matched');engine.receive([{type:'sp',sp:50,maxSp:100}]);expect(evaluateActorPredicate({...sp,actor:{scope:'self'}},engine.actorObservation()).state).toBe('matched');expect(sent).toEqual([]);
 });
});
describe('announced own resource initialization',()=>{
 function loading(id:number) {
  let at=1000;const sent:unknown[]=[];const engine=new BotEngine(action=>sent.push(action),()=>at);engine.connect(true);
  const enter=()=>engine.receive([{type:'enter',id,map:'prontera'}]);
  const stats=()=>engine.receive([{type:'stats',level:10,hp:80,maxHp:100,sp:50,maxSp:100}]);
  const spawn=(entryType:number|undefined=1,changes:Partial<Entity>={})=>engine.receive([{type:'spawn',entryType,entity:{...entity,id,sp:undefined,maxSp:undefined,...changes}}]);
  const trace=()=>evaluateActorPredicate({...sp,actor:{scope:'self'}},engine.actorObservation());
  const observed=()=>engine.actorObservation().actors.find(actor=>actor.id===id);
  return {engine,sent,enter,stats,spawn,trace,observed,advance:(ms:number)=>{at+=ms;}};
 }
 it.each([0,1])('carries only fresh announced-own %i SP into the matching initial arrival, keeping its original clock',id=>{
  const f=loading(id);f.enter();f.stats();expect(f.engine.actorActionIdentity()).toBeNull();expect(f.engine.actorObservation().actors).toEqual([]);
  f.advance(100);f.spawn();expect(f.trace().state).toBe('matched');expect(f.observed()?.sp).toEqual({value:50,max:100,at:1000,source:'own-stats',reason:null});
  expect(f.observed()?.hp).toMatchObject({value:100,at:1100,source:'spawn'});expect(f.sent).toEqual([]);
  f.advance(14_901);f.engine.receive([{type:'heal',id,hp:100,maxHp:100}]);expect(f.trace().state).toBe('unavailable');
 });
 it.each([0,1])('keeps foreign actor resources separate from announced own %i and consumes initialization once',id=>{
  const f=loading(id);f.enter();f.stats();f.engine.receive([{type:'spawn',entryType:1,entity:{...entity,id:2}}]);
  expect(f.engine.observations.snapshot(id,2,true).actors.find(actor=>actor.id===2)?.sp).toBeUndefined();
  f.advance(1);f.spawn(1,{sp:0,maxSp:0});expect(f.trace().state).toBe('matched');
  f.spawn();expect(f.trace().state).toBe('unavailable');f.stats();expect(f.trace().state).toBe('matched');
 });
 it('retains independent ordered pre-arrival SP updates without turning stale evidence fresh',()=>{
  const f=loading(0);f.enter();f.stats();f.advance(1);f.engine.receive([{type:'sp',sp:20,maxSp:100}]);f.advance(15_001);f.spawn();
  expect(f.observed()?.sp).toMatchObject({value:20,at:1001,source:'own-sp'});expect(f.trace().state).toBe('unavailable');
 });
 it.each(['pre-enter','reenter','reconnect','map','clear','remove','death','wrong-kind','wrong-entry0','wrong-entry2','missing-entry'] as const)('rejects %s initialization ownership',edge=>{
  const f=loading(0);if(edge==='pre-enter'){f.stats();f.enter();}else{f.enter();f.stats();}
  if(edge==='reenter')f.enter();else if(edge==='reconnect'){f.engine.connect(true);f.enter();}
  else if(edge==='map')f.engine.receive([{type:'map',map:'geffen'}]);else if(edge==='clear')f.engine.receive([{type:'clear'}]);
  else if(edge==='remove')f.engine.receive([{type:'remove',id:0,dead:false}]);else if(edge==='death')f.engine.receive([{type:'death',id:0}]);
  else if(edge==='wrong-kind')f.spawn(1,{kind:1});else if(edge==='wrong-entry0')f.spawn(0);else if(edge==='wrong-entry2')f.spawn(2);
  else if(edge==='missing-entry')f.engine.receive([{type:'spawn',entity:{...entity,id:0,sp:undefined,maxSp:undefined}}]);
  f.spawn();expect(f.trace().state).toBe('unavailable');
 });
 it('accepts new receipts after repeated Enter and never replaces invalid receipts with cached character SP',()=>{
  const f=loading(0);f.enter();f.stats();f.enter();f.advance(1);f.stats();f.spawn();expect(f.trace().state).toBe('matched');expect(f.observed()?.sp?.at).toBe(1001);
  f.enter();f.stats();f.engine.receive([{type:'sp',sp:50,maxSp:0}]);f.spawn();expect(f.trace().state).toBe('unavailable');expect(f.observed()?.sp?.reason).toBe('invalid');
 });
 it('rejects captured pre-announcement and superseded receipt contexts across initial arrival',()=>{
  const observations=new ActorObservations(()=>1000),before=observations.context();observations.beginOwnInitialization(0);
  const update={type:'sp' as const,sp:50,maxSp:100};observations.apply(update,before);
  const old=observations.context();observations.apply({...update,sp:20});observations.apply(update,old);
  observations.spawn({...entity,id:0,sp:undefined,maxSp:undefined},0,1);observations.apply(update,old,0);observations.frame();
  expect(observations.snapshot(0,null,true).actors[0]?.sp).toMatchObject({value:20,at:1000,source:'own-sp'});
 });
});
describe('shared visible party actor binding',()=>{
 it('requires full same-map identity and applies initial online resources',()=>{const s=setup();s.join();expect(s.world.partyActors.get(7)).toMatchObject({partyId:5,memberId:7,entityId:2,map:'prontera'});expect(s.trace(sp).state).toBe('matched');});
 it('can bind a fresh roster preceding spawn but does not replay its older HP over spawn',()=>{const s=setup(false);s.join();s.advance(1);s.observations.spawn({...entity,hp:70});s.sync();expect(s.trace({...hp,value:70}).state).toBe('matched');expect(s.trace(sp).state).toBe('matched');});
 it('rejects offline entity zero without rejecting actual actor-zero visible HP/own SP',()=>{const s=setup(false);s.observations.spawn({...entity,id:0},0);s.join([{...member,entityId:0}]);expect(s.world.partyActors.get(7)).toBeNull();expect(evaluateActorPredicate({...hp,actor:{scope:'self'}},s.observations.snapshot(0,null,true)).state).toBe('matched');expect(evaluateActorPredicate({...sp,actor:{scope:'self'}},s.observations.snapshot(0,null,true)).state).toBe('unavailable');});
 it.each([undefined,-1,6])('requires matching visible party affiliation %s',partyId=>{const s=setup(false);s.observations.spawn({...entity,partyId});s.join();expect(s.world.partyActors.get(7)).toBeNull();expect(s.trace(sp).state).toBe('unavailable');});
 it('accepts fresh actor-targeted affiliation but invalidates an existing association on change',()=>{const s=setup(false);s.observations.spawn({...entity,partyId:undefined,partyName:undefined});s.join();s.observations.apply({type:'partyAffiliation',id:2,partyId:5,partyName:'Party'});s.sync();expect(s.world.partyActors.get(7)).not.toBeNull();s.observations.apply({type:'partyAffiliation',id:2,partyId:-1,partyName:''});s.sync();expect(s.trace(sp).state).toBe('unavailable');});
 it.each([0,1])('fences late captured affiliation at %i ms separation without refreshing resources',delay=>{const s=setup();s.join();const old=s.observations.context(2);s.advance(delay);s.observations.apply({type:'partyAffiliation',id:2,partyId:-1,partyName:''});s.observations.apply({type:'partyAffiliation',id:2,partyId:5,partyName:'Party'},old);expect(s.observations.partyActor(2)?.partyId).toBe(-1);s.sync();expect(s.world.partyActors.get(7)).toBeNull();s.event({type:'partyMember',change:'update',member});expect(s.trace(sp).state).toBe('unavailable');s.observations.apply({type:'partyAffiliation',id:2,partyId:5,partyName:'Party'});s.sync();expect(s.world.partyActors.get(7)).not.toBeNull();s.advance(15_001);s.observations.apply({type:'partyAffiliation',id:2,partyId:5,partyName:'Party'});s.observations.frame();expect(s.trace(sp).state).toBe('unavailable');});
 it('rejects duplicate online entity IDs and requires full evidence after they disappear',()=>{const s=setup();s.join([member,{...member,memberId:8}]);expect(s.world.partyActors.get(7)).toBeNull();s.event({type:'partyRemove',memberId:8});s.event({type:'partyHealth',memberId:7,hp:100,maxHp:100,sp:50,maxSp:100});expect(s.trace(sp).state).toBe('unavailable');s.event({type:'partyMember',change:'update',member});expect(s.trace(sp).state).toBe('matched');});
 it.each(['remove','replace','map','logout','left','new-party'] as const)('invalidates %s and cannot rebind via late map/resource rows',change=>{const s=setup();s.join();if(change==='remove')s.event({type:'partyRemove',memberId:7});else if(change==='replace')s.observations.spawn({...entity});else if(change==='map')s.event({type:'partyMap',memberId:7,map:'geffen'});else if(change==='logout')s.event({type:'partyMember',change:'logout',member:{...member,entityId:0}});else if(change==='left')s.event({type:'partyLeft',disbanded:false});else s.event({type:'partyJoined',partyId:6,name:'Other',login:false,members:[member]});s.sync();s.event({type:'partyMap',memberId:7,map:'prontera'});s.event({type:'partyHealth',memberId:7,hp:100,maxHp:100,sp:50,maxSp:100});expect(s.world.partyActors.get(7)).toBeNull();expect(s.trace(sp).state).toBe('unavailable');});
 it('requires a new full row for the replacement lifetime and rejects missing/new-party affiliation',()=>{const s=setup();s.join();s.observations.spawn({...entity,partyId:undefined,partyName:undefined});s.sync();s.event({type:'partyMember',change:'update',member});expect(s.trace(sp).state).toBe('unavailable');s.observations.apply({type:'partyAffiliation',id:2,partyId:5,partyName:'Party'});s.sync();s.event({type:'partyHealth',memberId:7,hp:100,maxHp:100,sp:50,maxSp:100});expect(s.trace(sp).state).toBe('matched');});
 it('rejects a resource context captured before membership invalidation on the same lifetime',()=>{const s=setup();s.join();const captured=s.observations.context(2);s.event({type:'partyRemove',memberId:7});s.observations.partyResources(2,member,captured);expect(s.trace(sp).state).toBe('unavailable');expect(s.trace().state).toBe('unavailable');s.event({type:'partyMember',change:'add',member});expect(s.trace(sp).state).toBe('matched');});
 it('cannot turn a pre-invalidation snapshot into the first SP baseline',()=>{const s=setup();const captured=s.observations.context(2);s.observations.clearPartyResources(2,captured);s.observations.partyResources(2,member,captured);expect(s.trace(sp).state).toBe('unavailable');});
 it('invalidates a party-derived HP delta chain on membership removal',()=>{const s=setup();s.join();s.observations.apply({type:'hit',id:2,damage:10,position:{x:10,y:10}});s.event({type:'partyRemove',memberId:7});expect(s.trace({...hp,value:90}).state).toBe('unavailable');s.observations.apply({type:'hit',id:2,damage:10,position:{x:10,y:10}});expect(s.trace().state).toBe('unavailable');s.observations.apply({type:'heal',id:2,hp:100,maxHp:100});expect(s.trace().state).toBe('matched');});
 it('never binds cross-map health and does not fabricate a visible actor',()=>{const s=setup(false);s.join([{...member,map:'geffen'}]);s.event({type:'partyHealth',memberId:7,hp:10,maxHp:100,sp:50,maxSp:100});expect(s.snapshot().actors).toEqual([]);s.observations.spawn({...entity});s.event({type:'partyMap',memberId:7,map:'prontera'});s.event({type:'partyHealth',memberId:7,hp:100,maxHp:100,sp:50,maxSp:100});expect(s.world.partyActors.get(7)).toBeNull();expect(s.trace(sp).state).toBe('unavailable');});
 it('does not reuse persistent roster resource rows after a map/session reset',()=>{const s=setup();s.join();s.world.reset('prontera',true);s.observations.reset();s.observations.spawn({...entity});s.observations.frame();s.sync();s.event({type:'partyHealth',memberId:7,hp:100,maxHp:100,sp:50,maxSp:100});expect(s.trace(sp).state).toBe('unavailable');});
});

it('captured arrival eligibility is detached, positive, fresh and globally unambiguous without restoring party resources',()=>{
 const s=setup();s.join([{...member,leader:true}]);const captured={...s.world.partyActors.get(7)!,name:member.name,partyName:'Party'};
 expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).toBeNull();
 s.world.reset('prontera',true);s.observations.reset();s.observations.spawn({...entity});s.observations.frame();
 expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).not.toBeNull();
 expect(s.world.partyActors.get(7)).toBeNull();expect(s.trace(sp).state).toBe('unavailable');
 s.world.party!.members.set(8,{...member,memberId:8,entityId:3});s.world.party!.members.set(9,{...member,memberId:9,entityId:3});
 expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).toBeNull();
 s.world.party!.members.delete(8);s.world.party!.members.delete(9);s.advance(15001);
 expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).toBeNull();
});


it('detached captured arrival requires authoritative living HP and never repairs shared resources',()=>{
 const s=setup();s.join([{...member,leader:true}]);const captured={...s.world.partyActors.get(7)!,name:member.name,partyName:'Party'};
 s.world.reset('prontera',true);s.observations.reset();s.observations.spawn({...entity});s.observations.frame();
 s.observations.partyResources(2,{hp:0,maxHp:100},s.observations.context(2));expect(s.observations.livingPlayer(2)).toBe(false);
 expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).toBeNull();
 s.observations.clearPartyResources(2,s.observations.context(2));expect(s.observations.livingPlayer(2)).toBe(false);
 expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).toBeNull();
 s.observations.apply({type:'heal',id:2,hp:100,maxHp:100});expect(s.world.partyActors.capturedArrival(captured,s.world.party,s.world.map,s.observations)).not.toBeNull();
 expect(s.world.partyActors.get(7)).toBeNull();expect(s.trace(sp).state).toBe('unavailable');
});

it('visible position evidence belongs to one actor lifetime and never refreshes resources, affiliation or status clocks',()=>{
 const s=setup();s.join();const old=s.observations.context(2),before=s.snapshot().actors[0]!;
 s.advance(16000);s.observations.apply({type:'position',id:2,position:{x:10,y:10}});s.observations.frame();
 expect(s.observations.visibleAt(2)).toBe(old.at+16000);expect(s.snapshot().actors[0]!).toMatchObject({observedAt:before.observedAt,hp:before.hp,sp:before.sp});
 expect(s.trace(sp).state).toBe('unavailable');expect(s.observations.partyActor(2)?.affiliationRevision).toBe(0);
 s.observations.apply({type:'position',id:2,position:{x:10,y:10}},old);expect(s.observations.visibleAt(2)).toBe(old.at+16000);
 s.observations.spawn({...entity});const replacement=s.observations.visibleAt(2);s.advance(1);s.observations.apply({type:'position',id:2,position:{x:10,y:10}},old);expect(s.observations.visibleAt(2)).toBe(replacement);
 s.observations.remove(2);s.observations.apply({type:'position',id:2,position:{x:10,y:10}});expect(s.observations.visibleAt(2)).toBeNull();
 s.observations.reset();s.observations.spawn({...entity});const reset=s.observations.visibleAt(2);s.advance(1);s.observations.apply({type:'position',id:2,position:{x:10,y:10}},old);expect(s.observations.visibleAt(2)).toBe(reset);
});

import {describe,it,expect} from 'vitest';
import {BotEngine,type Action} from './engine';
import {DEFAULT_AUTOMATION,DEFAULT_RETREAT,DEFAULT_SETTINGS,type Settings} from './settings';
import {type Entity} from './protocol';
import {type WalkGrid} from './navigation';
import {attackDistance} from './combat';
import {DEFAULT_MAP_POLICY} from './map-policy';

const self:Entity={id:1,classId:0,name:'Self',kind:0,level:20,hp:100,maxHp:100,x:100,y:100,dead:false,sp:15,maxSp:20,sitting:false};
const enemy:Entity={id:2,classId:4000,name:'Poring',kind:1,level:1,hp:50,maxHp:50,x:102,y:100,dead:false};
function setup(grid:WalkGrid={width:200,height:200,walkable:()=>true},selfId=1,targetId=2){
 let now=100000;const sent:Action[]=[];
 const engine=new BotEngine(action=>sent.push(action),()=>now,()=>grid);
 engine.connect(true);engine.receive([{type:'enter',id:selfId,map:'prt_fild08'},{type:'spawn',entity:{...self,id:selfId}},{type:'spawn',entity:{...enemy,id:targetId}}]);
 const gear=(count=20,weapon=1701)=>engine.receive([{type:'inventory',items:[{bagId:77,itemId:weapon,count:1,type:2,guid:'weapon'},{bagId:1750,itemId:1750,count,type:1}],equipment:[0,0,0,0,77,0,0,0,0,0],ammoId:1750},{type:'skills',learned:[{skillId:1,level:2},{skillId:29,level:5}]}]);gear();
 const settings:Settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],automation:{...structuredClone(DEFAULT_AUTOMATION),retreat:{...DEFAULT_RETREAT,enabled:true}}};
 const step=(ms=100,dispatch=true)=>{now+=ms;engine.receive([]);engine.tick(dispatch);};
 const attack=()=>engine.receive([{type:'attack',source:selfId,target:targetId,position:{x:engine.player!.x,y:engine.player!.y}}]);
 const clear=()=>engine.receive([{type:'changeTarget',id:0}]);
 const ack=(cells=engine.snapshot().navigation!.leg,seconds=.1,locked=false)=>engine.receive([{type:'walk',id:selfId,walk:{origin:cells[0]!,cells,secondsPerCell:seconds,firstSeconds:seconds,locked}}]);
 const engage=()=>{engine.start(settings);step();expect(sent.at(-1)).toEqual({type:'attack',id:targetId});attack();step();expect(sent.at(-1)).toEqual({type:'stop'});};
 return {engine,sent,settings,step,attack,clear,ack,gear,engage,selfId,targetId,now:()=>now};
}
describe('bounded normal ranged retreat',()=>{
 it.each([undefined,false])('keeps default/disabled action parity (%s)',enabled=>{
  const f=setup();if(enabled===undefined)delete f.settings.automation!.retreat;else f.settings.automation!.retreat!.enabled=false;
  f.engine.start(f.settings);f.step();f.attack();for(let n=0;n<5;n++)f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);expect(f.engine.snapshot().retreat.state).toBe('off');
 });
 it('requires a matching normal Attack, not dispatch, foreign attack or target selection',()=>{
  const f=setup();f.engine.start(f.settings);f.step();f.engine.receive([{type:'changeTarget',id:2},{type:'attack',source:99,target:2,position:{x:100,y:100}}]);f.step();expect(f.sent).toEqual([{type:'attack',id:2},{type:'stop'}]);expect(f.engine.retreatOwned).toBe(false);
  const g=setup();g.engine.start(g.settings);g.step();g.engine.receive([{type:'changeTarget',id:2}]);g.step(2000);expect(g.sent).toEqual([{type:'attack',id:2}]);
 });
 it.each([[1,2],[0,2],[1,0]])('Stop/clear/accepted walk/reattack owns self%d,target%d', (selfId,targetId)=>{
  const f=setup(undefined,selfId,targetId);f.engage();f.step();expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);f.clear();f.step();
  const cells=f.engine.snapshot().navigation!.leg;expect(cells.length).toBeGreaterThan(1);expect(f.sent.at(-1)?.type).toBe('walk');expect(f.engine.snapshot().retreat.attempts).toBe(1);
  f.ack(cells,.2);f.step(100);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  f.step(cells.length*200);expect(f.sent.at(-1)).toEqual({type:'attack',id:targetId});expect(f.engine.snapshot().retreat.state).toBe('resumed');expect(f.engine.runIntent).toBe(true);
  expect(attackDistance(f.engine.player!,f.engine.entities.get(targetId)!)).toBeGreaterThanOrEqual(5);
 });
 it('does not acquire another monster, loot or cast during an accepted retreat',()=>{
  const f=setup();f.settings.automation!.loot.ownership='all';f.engage();f.clear();f.step();const cells=f.engine.snapshot().navigation!.leg;
  f.engine.receive([{type:'spawn',entity:{...enemy,id:3,x:100}},{type:'drop',drop:{id:9,itemId:501,count:1,isNew:true,x:100,y:100}}]);f.ack(cells,.2);f.step(cells.length*200);
  expect(f.sent.map(a=>a.type)).toEqual(['attack','stop','walk','attack']);expect(f.sent.at(-1)).toEqual({type:'attack',id:2});
 });
 it('cannot clear an unresolved explicit walk with same-target or actor-zero Attack',()=>{
  const f=setup();f.engage();f.clear();f.step();const cells=f.engine.snapshot().navigation!.leg;f.engine.stop();
  f.attack();f.engine.receive([{type:'attack',source:1,target:0,position:{x:99,y:99}}]);f.clear();f.step(4100);f.step(4100);
  expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);expect(f.engine.idleForActions()).toBe(false);expect(f.engine.settledForMaintenance()).toBe(false);
  expect(()=>f.engine.start(f.settings)).toThrow('retreat');expect(()=>f.engine.manualAction({type:'sit',sitting:false})).toThrow();
  f.ack(cells.slice(0,2),2);f.step(1900);expect(f.engine.idleForActions()).toBe(false);f.step(300);expect(f.engine.idleForActions()).toBe(true);expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
 });
 it('does not retry an unaccepted walk after its deadline or release it on elapsed time',()=>{
  const f=setup();f.engage();f.clear();f.step();f.step(4100);f.step(4100);
  expect(f.engine.snapshot().retreat).toMatchObject({state:'skipped',settling:true});expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);expect(f.engine.retreatOwned).toBe(true);expect(f.engine.runIntent).toBe(true);
 });
 it('reconciles a trusted official position correction without another Stop or refreshed retreat allowance',()=>{
  const f=setup();f.engage();f.clear();f.step();f.engine.officialGameplay();
  f.engine.receive([{type:'position',id:1,position:{x:100,y:101}}]);
  expect(f.sent.filter(a=>a.type==='stop')).toHaveLength(1);expect(f.engine.runIntent).toBe(true);
  expect(f.engine.snapshot().retreat.attempts).toBe(1);
  f.engine.receive([{type:'stop',id:1},{type:'changeTarget',id:0}]);f.step();
  expect(f.engine.retreatOwned).toBe(false);expect(f.engine.running).toBe(true);
 });
 it('late own Attack after a prior clear requires a fresh clear and sends at most one additional Stop',()=>{
  const f=setup();f.engage();f.clear();f.attack();f.attack();f.step();expect(f.sent.map(a=>a.type)).toEqual(['attack','stop','stop']);f.clear();f.step();expect(f.sent.at(-1)?.type).toBe('walk');
 });
 it('accepts a shortened authoritative route but replans without refilling steps or attempt',()=>{
  const f=setup();f.settings.route_step=2;f.settings.attackMaxRouteTime=20;f.engage();f.clear();f.step();const first=f.engine.snapshot().navigation!.leg;
  f.ack(first.slice(0,2));f.step(300);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(2);expect(f.engine.snapshot().retreat.attempts).toBe(1);
 });
 it('moving targets exhaust cumulative path steps instead of repeatedly obtaining a fresh path',()=>{
  const f=setup();f.settings.route_step=1;f.settings.automation!.retreat!.maxPathSteps=4;f.settings.attackMaxRouteTime=20;f.engage();f.clear();
  for(let n=0;n<5;n++){f.step();const cells=f.engine.snapshot().navigation!.leg;if(!cells.length)break;f.ack(cells);f.step(200);f.engine.entities.get(2)!.x=f.engine.player!.x+1;f.engine.entities.get(2)!.y=f.engine.player!.y;}
  f.step();expect(f.sent.filter(a=>a.type==='walk').length).toBeLessThanOrEqual(4);expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.engine.snapshot().retreat.attempts).toBe(1);
 });
 it('holds original movement time through target replans and generic panel yield',()=>{
  const f=setup();f.settings.attackMaxRouteTime=1;f.settings.route_step=1;f.engage();f.clear();f.step();const cells=f.engine.snapshot().navigation!.leg;f.ack(cells,.5);
  f.engine.entities.get(2)!.y++;f.step(1100,false);expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);expect(f.engine.runIntent).toBe(true);
 });
 it('Walk, Stop and planning do not refresh the original no-progress clock',()=>{
  const f=setup();f.settings.attackMaxRouteTime=60;f.engage();f.clear();
  for(let n=0;n<12;n++)f.step(1000,false);
  expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.engine.snapshot().retreat.reason).toContain('original engagement');expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(0);
 });
 it('genuine attack progress cannot extend the original ninety-second engagement allowance',()=>{
  const f=setup();f.settings.attackMaxRouteTime=60;f.engage();
  for(let n=0;n<90;n++){f.attack();f.step(1000,false);}
  expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.engine.snapshot().retreat.reason).toContain('original engagement');expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(0);
 });
 it('does not reopen a spent normal-started strategy opener after retreat',()=>{
  const f=setup();f.settings.automation!.attackStrategies=[{id:'opener',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
  f.engine.start({...f.settings,automation:{...f.settings.automation!,attackStrategies:[]}});f.step();f.attack();
  f.engine.settings.automation!.attackStrategies=f.settings.automation!.attackStrategies;
  f.step();f.clear();f.step();const cells=f.engine.snapshot().navigation!.leg;f.ack(cells);f.step(1000);
  expect(f.sent.filter(a=>a.type==='skill')).toEqual([]);expect(f.sent.at(-1)).toEqual({type:'attack',id:2});expect(f.engine.snapshot().attackStrategies.entries[0]!.normalStarted).toBe(true);
 });
 it('an applicable strategy wait cancels retreat without replacing its outstanding Walk',()=>{
  const f=setup();f.engage();f.clear();f.step();
  f.engine.settings.automation!.attackStrategies=[{id:'repeat',speciesIds:[4000],skillId:11,level:1,behavior:'repeat',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
  f.engine.character.skillsKnown=false;f.step();expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);expect(f.sent.filter(a=>a.type==='skill')).toHaveLength(0);
 });
 it('requires ammo/resource proof even when loadout management is off',()=>{
  const f=setup();f.settings.automation!.loadout.minAmmoStock=3;f.engine.start(f.settings);f.step();f.attack();f.gear(3);f.step();expect(f.sent.map(a=>a.type)).toEqual(['attack','stop']);expect(f.engine.snapshot().retreat.reason).toContain('reserve');
  const g=setup();g.engine.start(g.settings);g.step();g.attack();g.engine.character.inventoryKnown=false;g.step();expect(g.sent.some(a=>a.type==='walk')).toBe(false);
 });
 it.each(['melee','unknown-skills','desired-range'])('does not retreat with %s profile',variant=>{
  const f=setup();if(variant==='melee')f.gear(20,1201);if(variant==='unknown-skills')f.engine.character.skillsKnown=false;if(variant==='desired-range')f.settings.automation!.retreat!.desiredDistance=14;
  f.engine.start(f.settings);f.step();f.attack();f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);expect(f.engine.retreatOwned).toBe(false);
 });
 it('cancels a sent retreat when verified range changes and retains movement ownership',()=>{
  const f=setup();f.engage();f.clear();f.step();f.gear(20,1201);f.step();expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.engine.retreatOwned).toBe(true);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);
 });
 it('known own casting and unresolved extension block retreat body dispatch beyond prediction',()=>{
  const f=setup();f.engine.start(f.settings);f.engine.receive([{type:'castStart',id:1,skillId:11,level:1,position:{x:100,y:100},remainingSeconds:1,flags:0,target:2}]);
  f.step(1100);f.engine.receive([{type:'castExtend',id:1,deltaSeconds:10}]);f.step(2000);expect(f.sent).toEqual([]);expect(f.engine.observedOwnCastSettled()).toBe(false);
  f.engine.receive([{type:'skillResult',source:1,skillId:11,level:1,mode:'target',target:2,position:{x:100,y:100},motionSeconds:0,indirect:true}]);f.step();expect(f.sent).toEqual([]);
  f.engine.receive([{type:'castStop',id:1}]);f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);expect(f.engine.observedOwnCastSettled()).toBe(true);
 });
 it.each([0,1])('shares proc ambiguity and accepted Walk availability for own %s despite an idle predicate',id=>{
  const f=setup(undefined,id);f.engine.start(f.settings);
  f.engine.receive([{type:'castStart',id,skillId:42,level:1,target:id,position:{x:100,y:100},remainingSeconds:30,flags:0},
    {type:'skillResult',source:id,skillId:42,level:1,mode:'self',position:{x:100,y:100},motionSeconds:0,indirect:false}]);
  f.step(2000);expect(f.engine.observedOwnCastSettled()).toBe(false);expect(f.sent).toEqual([]);
  const walk={origin:{x:100,y:100},cells:[{x:100,y:100},{x:100,y:101}],secondsPerCell:.1,firstSeconds:.1,locked:false};
  f.engine.receive([{type:'walk',id:id===0?1:0,walk}]);expect(f.engine.observedOwnCastSettled()).toBe(false);
  f.engine.receive([{type:'walk',id,walk}]);expect(f.engine.observedOwnCastSettled()).toBe(true);
  expect(f.engine.actorObservation().actors.find(actor=>actor.id===id)?.cast.state).toBe('idle');
  f.step(300);expect(f.sent.at(-1)).toEqual({type:'attack',id:2});f.attack();f.step();f.clear();f.step();
  expect(f.sent.map(action=>action.type)).toEqual(['attack','stop','walk']);expect(f.engine.snapshot().retreat.attempts).toBe(1);
 });
 it.each([0,1])('shares exact own %s CounterAttack availability while preserving separate retreat admission',id=>{
  const f=setup(undefined,id);f.engine.start(f.settings);
  f.engine.receive([{type:'castStart',id,skillId:31,level:1,target:id,position:{x:100,y:100},remainingSeconds:30,flags:0},
    {type:'resetMotion',id:id===0?1:0}]);f.step();expect(f.sent).toEqual([]);expect(f.engine.observedOwnCastSettled()).toBe(false);
  f.engine.receive([{type:'resetMotion',id}]);expect(f.engine.observedOwnCastSettled()).toBe(true);
  expect(f.engine.actorObservation().actors.find(actor=>actor.id===id)?.cast.state).toBe('casting');
  f.step();f.attack();f.step();f.clear();f.step();expect(f.sent.map(action=>action.type)).toEqual(['attack','stop','walk']);
 });
 it('own cast cancellation retires a sent retreat instead of releasing it on a cast deadline',()=>{
  const f=setup();f.engage();f.clear();f.step();f.engine.receive([{type:'castStart',id:1,skillId:11,level:1,position:{x:100,y:100},remainingSeconds:1,flags:0,target:2}]);f.step(2000);
  expect(f.engine.snapshot().retreat).toMatchObject({state:'skipped',settling:true});expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);expect(f.engine.observedOwnCastSettled()).toBe(false);
  f.engine.receive([{type:'castStop',id:1}]);f.step();expect(f.engine.retreatOwned).toBe(true);
 });
 it('no route skips the one actor with finite intent instead of approaching forever',()=>{
  const f=setup({width:200,height:200,walkable:q=>q.y===100&&q.x>=100&&q.x<=102});f.engage();expect(f.engine.snapshot().retreat.state).toBe('skipped');f.clear();f.step();for(let n=0;n<20;n++)f.step();expect(f.sent).toEqual([{type:'attack',id:2},{type:'stop'}]);expect(f.engine.runIntent).toBe(true);
 });
 it('retains attempt budgets across target movement and same-world Stop/Start',()=>{
  const f=setup();f.settings.automation!.retreat!.maxAttempts=1;f.engage();f.clear();f.step();let cells=f.engine.snapshot().navigation!.leg;f.ack(cells);f.step(1000);
  f.engine.stop();f.clear();f.engine.receive([{type:'stop',id:1}]);f.engine.entities.get(2)!.x=f.engine.player!.x+1;f.engine.entities.get(2)!.y=f.engine.player!.y;
  f.engine.start(f.settings);f.step();f.attack();f.step();expect(f.engine.snapshot().retreat.attempts).toBe(1);expect(f.engine.snapshot().retreat.reason).toContain('allowance');expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);
 });
 it.each(['map','clear','death','self-replaced','target-replaced'])('cancels at %s and holds uncertain movement until fresh transport',variant=>{
  const f=setup();f.engage();f.clear();f.step();if(variant==='map')f.engine.receive([{type:'map',map:'prontera'}]);if(variant==='clear')f.engine.receive([{type:'clear'}]);if(variant==='death')f.engine.receive([{type:'death',id:1}]);if(variant==='self-replaced')f.engine.receive([{type:'spawn',entity:{...self}}]);if(variant==='target-replaced')f.engine.receive([{type:'spawn',entity:{...enemy}}]);
  f.step();expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);expect(f.engine.retreatOwned).toBe(true);
  if(variant==='self-replaced'){f.engine.receive([{type:'stop',id:1},{type:'changeTarget',id:0}]);expect(f.engine.retreatOwned).toBe(true);}
  f.engine.disconnect();f.engine.connect(true);expect(f.engine.retreatOwned).toBe(false);expect(f.engine.runIntent).toBe(false);
 });
 it('recovery wins only after the retreat leg settles',()=>{
  const f=setup();f.settings.automation!.recovery.enabled=true;f.engage();f.clear();f.step();const cells=f.engine.snapshot().navigation!.leg;f.engine.player!.hp=55;f.step();expect(f.sent.at(-1)?.type).toBe('stop');expect(f.sent.some(a=>a.type==='sit')).toBe(false);f.ack(cells.slice(0,2));f.step(300);f.step();expect(f.sent.at(-1)).toEqual({type:'sit',sitting:true});
 });
 it('keeps source-ordered own drops and finite kill counters from the accepted engagement',()=>{
  const f=setup();f.engage();f.engine.receive([{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:102,y:100}},{type:'remove',id:2,dead:true}]);expect(f.engine.kills).toBe(1);f.clear();f.step(1000);expect(f.sent.filter(a=>a.type==='pickup'||a.type==='walk').length).toBeGreaterThan(0);
 });
 it.each(['spawn','resurrection'] as const)('a new target %s cannot inherit prior retreat kill/drop evidence',kind=>{
  const f=setup();f.engage();
  if(kind==='spawn')f.engine.receive([{type:'spawn',entity:{...enemy}}]);else f.engine.receive([{type:'resurrection',id:2,hp:50,position:{x:102,y:100}}]);
  f.engine.receive([{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:102,y:100}},{type:'remove',id:2,dead:true}]);
  expect(f.engine.kills).toBe(0);f.clear();f.step(1000);expect(f.sent.filter(a=>a.type==='pickup')).toHaveLength(0);
 });
 it('keeps the firing destination and each walk inside the inclusive field area',()=>{
  const f=setup();f.settings.automation!.mapPolicy={...DEFAULT_MAP_POLICY,lockArea:{map:'prt_fild08',minX:100,minY:95,maxX:105,maxY:105}};f.engage();f.clear();f.step();
  const cells=f.engine.snapshot().navigation!.leg;expect(cells.length).toBeGreaterThan(1);expect(cells.every(p=>p.x>=100&&p.x<=105&&p.y>=95&&p.y<=105)).toBe(true);
 });
 it('validates returned blocked/corner-cut walks and preserves the unresolved owner',()=>{
  const grid:WalkGrid={width:200,height:200,walkable:q=>q.x!==99||q.y!==100};const f=setup(grid);f.engage();f.clear();f.step();f.ack([{x:100,y:100},{x:99,y:100}],.1);f.step();expect(f.engine.snapshot().retreat.state).toBe('skipped');expect(f.engine.retreatOwned).toBe(true);expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(1);
 });
});

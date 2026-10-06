import {describe,it,expect,vi} from 'vitest';
import {BotEngine,DEFAULT_AUTOMATION,DEFAULT_SETTINGS,type Action,type Settings} from '../automation/engine';
import type {Entity,GameEvent} from '../protocol/protocol';
import type {FeatureEvent,SkillResult} from '../protocol/protocol-feature';
import {GridNavigator,type WalkGrid} from '../navigation/navigation';
import {DEFAULT_MAP_POLICY} from '../navigation/map-policy';
const player:Entity={id:1,kind:0,classId:2,name:'Mage',level:10,hp:100,maxHp:100,sp:200,maxSp:200,x:2,y:2,dead:false,statuses:[]};
const monster:Entity={id:2,kind:1,classId:4000,name:'Monster',level:1,hp:100,maxHp:100,x:9,y:2,dead:false,statuses:[]};
const grid:WalkGrid={width:30,height:30,walkable:p=>p.x!==6,seeThrough:()=>true};
function setup(mapGrid=grid){let time=100_000;const sent:Action[]=[];const engine=new BotEngine(action=>sent.push(action),()=>time,()=>mapGrid);engine.connect(true);engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}},{type:'spawn',entity:{...monster}}]);engine.receive([{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:11,level:10},{skillId:12,level:10},{skillId:16,level:10},{skillId:19,level:10}]}]);const settings:Settings={...DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],radius:20,attackMaxRouteTime:10,automation:structuredClone(DEFAULT_AUTOMATION)};settings.automation!.attackStrategies=[{id:'open',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:2,maxUses:1,cooldownSeconds:1}];const receive=(e:GameEvent|FeatureEvent)=>engine.receive([e]);const step=(ms=100)=>{time+=ms;engine.tick();};const result=(extra:Partial<SkillResult>={}):SkillResult=>({type:'skillResult',mode:'target',source:1,target:2,skillId:11,level:1,position:{x:2,y:2},motionSeconds:0,indirect:false,...extra});return {engine,sent,settings,step,receive,result};}
describe('owned attack skill geometry and receipts',()=>{
 it('requires a learned skill target inside the field rectangle even across a snipable barrier',()=>{
  const {engine,sent,settings,step}=setup();
  settings.automation!.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:8,maxY:10}};
  engine.start(settings);step();expect(sent).toEqual([]);
  engine.stop();sent.length=0;settings.automation!.mapPolicy.lockArea!.maxX=9;
  engine.start(settings);step();expect(sent).toEqual([{type:'skill',mode:'target',skillId:11,level:1,target:2}]);
 });
 it.each(['boundary','timeout'] as const)('does not acknowledge an explicit skill approach with a late attack after %s',cause=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  settings.route_avoidWalls=false;
  settings.automation!.mapPolicy={...structuredClone(DEFAULT_MAP_POLICY),lockArea:{map:'prt_fild08',minX:0,minY:0,maxX:20,maxY:10}};
  receive({type:'position',id:2,position:{x:17,y:2}});engine.start(settings);step();expect(sent[0]!.type).toBe('walk');
  if(cause==='boundary'){receive({type:'position',id:2,position:{x:21,y:2}});step();}
  else step(4100);
  expect(sent.at(-1)).toEqual({type:'stop'});
  for(const target of [2,0]){
   receive({type:'attack',source:1,target,position:{x:2,y:2}});step(100);
   expect(sent.map(action=>action.type)).toEqual(['walk','stop']);
   expect(()=>engine.start(settings)).toThrow('Wait');expect(()=>engine.manualAction({type:'sit',sitting:false})).toThrow('wait');
  }
  engine.stop();const stopped=sent.length;
  const cells=[{x:2,y:2},{x:3,y:2}];receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:2,firstSeconds:2,locked:false}});
  step(1000);expect(sent).toHaveLength(stopped);expect(engine.idleForActions()).toBe(false);
  step(1200);expect(engine.idleForActions()).toBe(true);
 });
 it('selects a spell-reachable monster across a snipable barrier even when ordinary attacks cannot reach it',()=>{const {engine,sent,settings,step}=setup();engine.start(settings);step();expect(sent).toEqual([{type:'skill',mode:'target',skillId:11,level:1,target:2}]);expect(engine.snapshot().attackStrategies.entries[0]!.rules[0]).toMatchObject({attempts:1,uses:0,uncertain:true});});
 it('confirms once only after direct source/skill/level/mode/actor execution and waits source after-cast delay',()=>{const {engine,sent,settings,step,receive,result}=setup();engine.start(settings);step();for(const wrong of [{source:3},{skillId:12},{level:2},{mode:'self' as const},{target:3},{indirect:true}])receive(result(wrong));receive({type:'castStart',id:1,skillId:11,level:1,position:{x:2,y:2},remainingSeconds:1,flags:0,target:2});expect(engine.snapshot().attackStrategies.entries[0]!.rules[0]!.uses).toBe(0);receive(result());receive(result());expect(engine.snapshot().attackStrategies.entries[0]!.rules[0]!.uses).toBe(1);step(500);expect(sent).toHaveLength(1);step(600);expect(sent).toHaveLength(1);});
 it('sends opener before normal attack and never uses a normal-click chase for cast positioning',()=>{const {engine,sent,settings,step,receive,result}=setup({width:30,height:30,walkable:()=>true});engine.start(settings);step();expect(sent[0]!.type).toBe('skill');receive(result());step(1100);expect(sent[1]).toEqual({type:'attack',id:2});expect(engine.snapshot().attackStrategies.entries[0]!.normalStarted).toBe(true);});
 it('owns approach until its accepted leg settles, then revalidates moving target and Blind range',()=>{const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});receive({type:'position',id:2,position:{x:17,y:2}});engine.start(settings);step();expect(sent[0]!.type).toBe('walk');const cells=engine.snapshot().navigation!.leg;receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:.05,firstSeconds:.05,locked:false}});receive({type:'position',id:2,position:{x:20,y:2}});receive({type:'status',id:1,statusId:5,seconds:100});step(500);expect(sent.every(action=>action.type!=='skill'&&action.type!=='attack')).toBe(true);step(100);expect(sent.at(-1)!.type).toBe('walk');const next=engine.snapshot().navigation!.leg;receive({type:'walk',id:1,walk:{origin:next[0]!,cells:next,secondsPerCell:.05,firstSeconds:.05,locked:false}});step(1000);const final=engine.snapshot().navigation!.leg;receive({type:'walk',id:1,walk:{origin:final[0]!,cells:final,secondsPerCell:.05,firstSeconds:.05,locked:false}});step(200);expect(sent.at(-1)).toEqual({type:'skill',mode:'target',skillId:11,level:1,target:2});});
 it('does not close an unknown opener and skips that actor after bounded waiting without canceling field intent',()=>{const {engine,sent,settings,step,receive}=setup();receive({type:'status',id:1,statusId:5,seconds:null,refresh:true});engine.start(settings);for(let n=0;n<31;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}expect(sent.some(action=>action.type==='skill'||action.type==='attack')).toBe(false);expect(engine.running).toBe(true);expect(engine.runIntent).toBe(true);expect(engine.log.some(entry=>entry.text.includes('30 seconds'))).toBe(true);expect(engine.snapshot().attackStrategies.entries[0]!.normalStarted).toBe(false);});
 it('keeps Stop/Start uncertainty and ignores canceled late execution',()=>{const {engine,sent,settings,step,receive,result}=setup();engine.start(settings);step();engine.stop();receive(result());for(let n=0;n<30;n++)step(1000);receive({type:'sp',sp:200,maxSp:200});engine.start(settings);step();expect(sent.filter(action=>action.type==='skill')).toHaveLength(1);expect(engine.reason).toContain('unresolved');expect(engine.snapshot().attackStrategies.entries[0]!.rules[0]!.uses).toBe(0);});
 it('extends stationary manual Thunderstorm to a blocked center and requires exact ground confirmation',()=>{const {engine,sent,receive,step}=setup();engine.manualAction({type:'skill',mode:'ground',skillId:19,level:1,position:{x:6,y:2}});expect(sent[0]!.type).toBe('skill');receive({type:'skillResult',mode:'ground',source:1,skillId:19,level:1,position:{x:2,y:2},targetPosition:{x:6,y:3},motionSeconds:0});expect(engine.actionResult.status).toBe('pending');receive({type:'skillResult',mode:'ground',source:1,skillId:19,level:1,position:{x:2,y:2},targetPosition:{x:6,y:2},motionSeconds:0});expect(engine.actionResult.status).toBe('confirmed');step(1400);expect(engine.idleForActions()).toBe(false);step(100);expect(engine.idleForActions()).toBe(true);expect(()=>engine.manualAction({type:'skill',mode:'ground',skillId:19,level:1,position:{x:20,y:2}})).toThrow('range');});
 it('preserves empty strategy routing search counts and outcomes',()=>{const counts:number[]=[];for(const strategies of [undefined,[]]){const {engine,settings,step,sent}=setup({width:30,height:30,walkable:()=>true});if(strategies===undefined)delete settings.automation!.attackStrategies;else settings.automation!.attackStrategies=strategies;let count=0;const original=GridNavigator.prototype.plan;GridNavigator.prototype.plan=function(...args){count++;return original.apply(this,args);};try{engine.start(settings);step();counts.push(count);expect(sent[0]).toEqual({type:'attack',id:2});}finally{GridNavigator.prototype.plan=original;}}expect(counts[0]).toBe(counts[1]);});
 it('keeps inherited movement and pursuit time bounded without sending an out-of-range cast',()=>{const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});settings.attackMaxRouteTime=1;receive({type:'position',id:2,position:{x:17,y:2}});engine.start(settings);step();const cells=engine.snapshot().navigation!.leg;receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:.2,firstSeconds:.2,locked:false}});receive({type:'position',id:2,position:{x:24,y:2}});step(1000);expect(sent.some(action=>action.type==='skill'||action.type==='attack')).toBe(false);expect(engine.reason).toContain('time limit');});
 it('blocks repeat casts behind Stop target-clear and pending gear ownership',()=>{const {engine,sent,settings,step,receive,result}=setup({width:30,height:30,walkable:()=>true});settings.automation!.loadout.enabled=true;settings.automation!.attackStrategies![0]!.behavior='repeat';settings.automation!.attackStrategies![0]!.maxUses=2;settings.automation!.attackStrategies![0]!.cooldownSeconds=3;engine.start(settings);step();receive(result());step(1100);expect(sent.at(-1)).toEqual({type:'attack',id:2});receive({type:'changeTarget',id:2});step(2000);expect(sent.at(-1)).toEqual({type:'stop'});for(let n=0;n<50;n++){receive({type:'sp',sp:200,maxSp:200});step(100);}expect(sent.filter(action=>action.type==='skill')).toHaveLength(1);receive({type:'changeTarget',id:0});step();expect(sent.filter(action=>action.type==='skill')).toHaveLength(2);});
 it.each(['remove','death','clear','map','disconnect'] as const)('invalidates strategy counters at %s and ignores old receipt credit',boundary=>{const {engine,settings,step,receive,result}=setup();engine.start(settings);step();if(boundary==='disconnect')engine.disconnect();else if(boundary==='remove')receive({type:'remove',id:2,dead:false});else if(boundary==='death')receive({type:'death',id:2});else if(boundary==='clear')receive({type:'clear'});else receive({type:'map',map:'prt_fild05'});receive(result());expect(engine.snapshot().attackStrategies.entries).toEqual([]);});
 it('keeps a timed-out cast tombstone after Start and does not credit late direct results',()=>{const {engine,settings,sent,step,receive,result}=setup();engine.start(settings);step();for(let n=0;n<30;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}expect(engine.running).toBe(false);receive(result());engine.start(settings);step();expect(sent.filter(action=>action.type==='skill')).toHaveLength(1);expect(engine.reason).toContain('unresolved');});
 it('treats fresh rejection as a spent failed rule rather than a confirmed use',()=>{const {engine,settings,step,receive}=setup();engine.start(settings);step();receive({type:'skillFailure',reason:3});expect(engine.running).toBe(false);expect(engine.snapshot().attackStrategies.entries[0]!.rules[0]).toMatchObject({attempts:1,uses:0,rejected:true,uncertain:false});});
 it('uses projectile sight rather than walkability, including directional asymmetry and range boundaries',()=>{const nav=new GridNavigator({width:20,height:20,walkable:()=>true,seeThrough:p=>!(p.x===1&&p.y===0)});expect(nav.canCast({x:0,y:0},{x:2,y:1},9)).toBe(false);expect(nav.canCast({x:2,y:1},{x:0,y:0},9)).toBe(true);const clear=new GridNavigator({width:20,height:20,walkable:()=>true});expect(clear.canCast({x:2,y:2},{x:11,y:2},9)).toBe(true);expect(clear.canCast({x:2,y:2},{x:12,y:2},9)).toBe(false);expect(clear.canCast({x:2,y:2},{x:7,y:2},5)).toBe(true);expect(clear.canCast({x:2,y:2},{x:8,y:2},5)).toBe(false);});

 it.each([undefined, []])('remembers normal dispatch while strategies are disabled (%j) before enabling an opener', disabled=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  const strategies=settings.automation!.attackStrategies!;
  if(disabled===undefined)delete settings.automation!.attackStrategies;else settings.automation!.attackStrategies=disabled;
  receive({type:'position',id:2,position:{x:3,y:2}});
  engine.start(settings);step();expect(sent).toEqual([{type:'attack',id:2}]);
  expect(engine.snapshot().attackStrategies.entries).toEqual([]);
  engine.stop();settings.automation!.attackStrategies=strategies;engine.start(settings);step();
  expect(sent.filter(action=>action.type==='skill')).toEqual([]);
  expect(engine.snapshot().attackStrategies.entries[0]!.normalStarted).toBe(true);
 });
 it('settles an outstanding pickup before dispatching a newly observed attack skill',()=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  settings.route_avoidWalls=false;settings.automation!.loot.ownership='all';receive({type:'remove',id:2,dead:false});
  receive({type:'drop',drop:{id:99,itemId:909,count:1,isNew:true,x:3,y:2}});
  engine.start(settings);step();expect(sent).toEqual([{type:'pickup',id:99}]);
  receive({type:'spawn',entity:{...monster}});step();step(1000);
  expect(sent).toEqual([{type:'pickup',id:99}]);expect(engine.pendingFeatureAction).toBeNull();
  receive({type:'pickup',id:99,picker:1});step();
  expect(sent.at(-1)).toEqual({type:'skill',mode:'target',skillId:11,level:1,target:2});
  expect(engine.looted).toBe(1);
 });
 it('keeps the chosen pickup route and its accepted leg when a skill target appears',()=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  settings.route_avoidWalls=false;settings.automation!.loot.ownership='all';receive({type:'remove',id:2,dead:false});
  receive({type:'drop',drop:{id:99,itemId:909,count:1,isNew:true,x:7,y:2}});
  engine.start(settings);step();expect(sent[0]!.type).toBe('walk');
  const cells=engine.snapshot().navigation!.leg;
  receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:.5,firstSeconds:.5,locked:false}});
  receive({type:'spawn',entity:{...monster}});step();
  expect(engine.snapshot().navigation!.mode).toBe('pickup');expect(sent).toHaveLength(1);
  step(2100);expect(sent.at(-1)).toEqual({type:'pickup',id:99});
  step();expect(sent.filter(action=>action.type==='skill')).toHaveLength(0);
  receive({type:'pickup',id:99,picker:1});step();
  expect(sent.at(-1)).toEqual({type:'skill',mode:'target',skillId:11,level:1,target:2});
 });
 it.each(['in-flight','completed'] as const)('starts a fresh skill pursuit clock after an inherited %s search leg', legState=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  const random=vi.spyOn(GridNavigator.prototype,'randomGoal').mockReturnValue({x:5,y:2});
  try{
   settings.route_avoidWalls=false;settings.route_randomWalk=2;settings.attackMaxRouteTime=1;receive({type:'remove',id:2,dead:false});
   engine.start(settings);step();const cells=engine.snapshot().navigation!.leg;
   receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:1,firstSeconds:1,locked:false}});
   step(2000);receive({type:'spawn',entity:{...monster,x:17}});
   step(legState==='completed'?1200:100);
   expect(sent.some(action=>action.type==='stop')).toBe(false);
   expect(engine.snapshot().navigation!.mode).toBe('skill');
   if(legState==='in-flight'){expect(sent).toHaveLength(1);step(1100);}
   expect(sent.at(-1)!.type).toBe('walk');
   const approach=engine.snapshot().navigation!.leg;
   receive({type:'walk',id:1,walk:{origin:approach[0]!,cells:approach,secondsPerCell:.05,firstSeconds:.05,locked:false}});
   step(500);expect(sent.at(-1)).toEqual({type:'skill',mode:'target',skillId:11,level:1,target:2});
  }finally{random.mockRestore();}
 });
 it.each(['in-flight','completed'] as const)("starts a fresh pursuit for another actor after the prior actor's %s leg", legState=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  settings.route_avoidWalls=false;settings.attackMaxRouteTime=4;receive({type:'position',id:2,position:{x:17,y:2}});
  engine.start(settings);step();const cells=engine.snapshot().navigation!.leg;
  receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:1,firstSeconds:1,locked:false}});
  step(2000);receive({type:'remove',id:2,dead:false});
  receive({type:'spawn',entity:{...monster,id:3,x:20}});
  step(legState==='completed'?4200:100);
  expect(engine.snapshot().navigation!.mode).toBe('skill');
  if(legState==='in-flight')step(4200);
  expect(engine.reason).not.toContain('time limit');
  expect(engine.snapshot().navigation!.mode).toBe('skill');
  const approach=engine.snapshot().navigation!.leg;
  receive({type:'walk',id:1,walk:{origin:approach[0]!,cells:approach,secondsPerCell:.05,firstSeconds:.05,locked:false}});
  step(500);expect(sent.at(-1)).toEqual({type:'skill',mode:'target',skillId:11,level:1,target:3});
 });
 it.each(['unknown','blocked'] as const)('enforces the missing walk ACK deadline while cast prerequisites are %s', state=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  receive({type:'position',id:2,position:{x:17,y:2}});engine.start(settings);step();
  expect(sent[0]!.type).toBe('walk');
  receive(state==='unknown'?{type:'status',id:1,statusId:5,seconds:null,refresh:true}:{type:'status',id:1,statusId:2,seconds:100});
  for(let n=0;n<5;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}
  expect(sent.map(action=>action.type)).toEqual(['walk','stop']);
  expect(engine.snapshot().navigation!.leg).toEqual([]);expect(engine.reason).toContain('Walk did not complete');
  expect(engine.running).toBe(true);expect(engine.snapshot().attackStrategies.entries[0]!.normalStarted).toBe(false);
 });
 it.each(['unknown','blocked'] as const)('enforces the pursuit deadline on an accepted approach while prerequisites are %s', state=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  settings.route_avoidWalls=false;settings.attackMaxRouteTime=4;receive({type:'position',id:2,position:{x:17,y:2}});engine.start(settings);step();
  const cells=engine.snapshot().navigation!.leg;
  receive({type:'walk',id:1,walk:{origin:cells[0]!,cells,secondsPerCell:1,firstSeconds:1,locked:false}});
  receive(state==='unknown'?{type:'status',id:1,statusId:5,seconds:null,refresh:true}:{type:'status',id:1,statusId:2,seconds:100});
  for(let n=0;n<4;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}
  expect(sent.at(-1)).toEqual({type:'stop'});expect(engine.reason).toContain('Approach time limit (4s)');
  expect(engine.running).toBe(true);expect(engine.runIntent).toBe(true);
  expect(sent.some(action=>action.type==='attack'||action.type==='skill')).toBe(false);
 });
 it('checks an inherited search walk ACK without authorizing another walk while the opener is unavailable',()=>{
  const {engine,sent,settings,step,receive}=setup({width:30,height:30,walkable:()=>true});
  const random=vi.spyOn(GridNavigator.prototype,'randomGoal').mockReturnValue({x:5,y:2});
  try{
   settings.route_avoidWalls=false;settings.route_randomWalk=2;receive({type:'remove',id:2,dead:false});engine.start(settings);step();
   receive({type:'status',id:1,statusId:5,seconds:null,refresh:true});receive({type:'spawn',entity:{...monster}});
   for(let n=0;n<5;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}
   expect(sent.map(action=>action.type)).toEqual(['walk','stop']);expect(engine.reason).toContain('Walk did not complete');
  }finally{random.mockRestore();}
 });
 it.each(['remove','spawn'] as const)('resets prerequisite waiting for a new incarnation after %s', boundary=>{
  const {engine,sent,settings,step,receive}=setup();receive({type:'status',id:1,statusId:5,seconds:null,refresh:true});
  engine.start(settings);step();
  for(let n=0;n<20;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}
  const incarnation=engine.snapshot().attackStrategies.entries[0]!.incarnation;
  if(boundary==='remove')receive({type:'remove',id:2,dead:false});
  receive({type:'spawn',entity:{...monster}});
  for(let n=0;n<15;n++){receive({type:'sp',sp:200,maxSp:200});step(1000);}
  expect(engine.reason).toContain('Blind state is unavailable');expect(engine.reason).not.toContain('Waited 30');
  expect(engine.snapshot().attackStrategies.entries[0]!.incarnation).not.toBe(incarnation);
  expect(sent.some(action=>action.type==='skill'||action.type==='attack')).toBe(false);
 });

});

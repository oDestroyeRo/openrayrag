import { benchmarkSourcePlugin } from './source-snapshot.mjs';
import { map, sort } from 'remeda';
// Run: bun scripts/benchmarks/benchmark-routing.mjs [baseline-ref]
// Setup/map analysis is excluded. Both revisions use the same deterministic inputs.
// Baseline source and its imports come from the same immutable tree; packages stay locked here.
import { deepStrictEqual } from 'node:assert';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';

export async function runBenchmark(args = process.argv.slice(2)) {
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
const baseline=execFileSync('git',['rev-parse','--verify',`${args[0]??'HEAD'}^{commit}`],{cwd:root,encoding:'utf8'}).trim();
const folder=await mkdtemp(join(tmpdir(),'rayrag-routing-benchmark-'));
async function bundle(name,ref){
  const output=join(folder,`${name}.mjs`);
  await build({stdin:{contents:"export {BotEngine,DEFAULT_SETTINGS,DEFAULT_AUTOMATION} from './src/modules/automation/engine.ts'; export {GridNavigator,searchGrid} from './src/modules/navigation/navigation.ts';",resolveDir:root},
    bundle:true,platform:'node',format:'esm',outfile:output,logLevel:'silent',
    plugins:ref?[benchmarkSourcePlugin(root, ref)]:[]});
  return output;
}
function counters(api){
  /** @type {import("../shared/tooling-domain-values.mjs").RoutingWorkCounters} */
  const stats={planRequests:0,searchedPlans:0,stepChecks:0};
  const plan=api.GridNavigator.prototype.plan,step=api.GridNavigator.prototype.step;
  api.GridNavigator.prototype.step=function(...args){stats.stepChecks++;return step.apply(this,args);};
  api.GridNavigator.prototype.plan=function(...args){stats.planRequests++;const before=stats.stepChecks;
    const result=plan.apply(this,args);if(stats.stepChecks>before)stats.searchedPlans++;return result;};
  return stats;
}
const open={width:400,height:400,walkable:()=>true};
const wall={...open,walkable:p=>p.x!==200||p.y<3};
const denseWall={width:80,height:80,walkable:p=>p.x!==40||p.y===0};
function field(api,grid,origin,targets,equipment=false){
  let now=100000;const sent=[];
  const engine=new api.BotEngine(action=>sent.push(action),()=>now,()=>grid);
  engine.connect(true);engine.receive([{type:'enter',id:1,map:'prt_fild08'},
    {type:'spawn',entity:{id:1,classId:0,name:'Player',kind:0,level:7,hp:70,maxHp:70,dead:false,...origin}},
    ...map(targets,(position,i)=>({type:'spawn',entity:{id:i+2,classId:4000,name:'Poring',kind:1,level:1,hp:51,maxHp:51,dead:false,...position}})),
    {type:'inventory',items:[],equipment:[],ammoId:-1}]);
  const settings={...api.DEFAULT_SETTINGS,map:'prt_fild08',targets:[4000],radius:20};
  if(equipment){settings.automation=structuredClone(api.DEFAULT_AUTOMATION);
    settings.automation.equipment=[{itemId:1201,hpBelowPercent:1,monsterClassId:4000}];}
  engine.start(settings);
  return {engine,sent,tick(){now+=100;engine.receive([]);engine.tick();}};
}
function denseTargets(api,grid,origin){
  const nav=new api.GridNavigator(grid),targets=[];
  for(let y=origin.y-12;y<=origin.y+12;y++)for(let x=origin.x-12;x<=origin.x+12;x++){
    if(nav.safe({x,y})&&(x!==origin.x||y!==origin.y))targets.push({x,y});
  }
  let seed=42;
  for(let i=targets.length-1;i>0;i--){seed=(Math.imul(seed,1664525)+1013904223)>>>0;
    const j=seed%(i+1);[targets[i],targets[j]]=[targets[j],targets[i]];}
  return targets.slice(0,150);
}
function scenarios(api){
  const published=api.searchGrid('prt_fild08'),origin={x:152,y:354};
  const dense=denseTargets(api,published,origin),openDense=denseTargets(api,open,{x:100,y:100});
  return [
    {name:'dense published Field8 acquisition',make:()=>{const f=field(api,published,origin,dense);return {run:()=>f.tick(),outcome:()=>f.sent[0]};}},
    {name:'dense inactive enemy equipment',make:()=>{const f=field(api,open,{x:100,y:100},openDense,true);return {run:()=>f.tick(),outcome:()=>f.sent[0]};}},
    {name:'unchanged direct pursuit (10 ticks)',make:()=>{const f=field(api,open,{x:100,y:100},[{x:106,y:100}]);f.tick();return {run:()=>{for(let i=0;i<10;i++)f.tick();},outcome:()=>f.sent};}},
    {name:'unchanged wall/cap rejection (10 ticks)',make:()=>{const f=field(api,wall,{x:199,y:200},[{x:201,y:200}]);f.tick();return {run:()=>{for(let i=0;i<10;i++)f.tick();},outcome:()=>f.sent};}},
    {name:'unchanged 150 blocked targets',make:()=>{const targets=Array.from({length:150},(_,i)=>({x:41+i%12,y:34+Math.floor(i/12)}));
      const f=field(api,denseWall,{x:39,y:40},targets);f.tick();return {run:()=>f.tick(),outcome:()=>f.sent};}},
    {name:'cold wall/cap rejection',make:()=>{const f=field(api,wall,{x:199,y:200},[{x:201,y:200}]);return {run:()=>f.tick(),outcome:()=>f.sent};}},
    {name:'moving origin wall/cap rejection (10 misses)',make:()=>{const nav=new api.GridNavigator(wall);let rejected=0;
      return {run:()=>{for(let y=200;y<210;y++)if(!nav.plan({x:199,y},{x:201,y},{range:1,maxDistance:20}))rejected++;},outcome:()=>rejected};}},
    {name:'reachable wall detour (10 misses)',make:()=>{const grid={...open,walkable:p=>p.x!==200||p.y<196||p.y>204},nav=new api.GridNavigator(grid);const paths=[];
      return {run:()=>{for(let y=198;y<208;y++)paths.push(nav.plan({x:199,y},{x:203,y},{range:1,maxDistance:20}));},outcome:()=>paths};}},
    {name:'unique short routes (100 cache misses)',make:()=>{const nav=new api.GridNavigator(open);return {run:()=>{for(let i=0;i<100;i++)nav.plan({x:100+i,y:100},{x:106+i,y:102},{range:1,maxDistance:20});},outcome:()=>100};}},
  ];
}
/** @returns {readonly import("../shared/tooling-domain-values.mjs").RoutingSample[]} */
function measure(api){
  const stats=counters(api),results=[];
  for(const scenario of scenarios(api)){
    const samples=[];let counts,outcome;
    for(let i=0;i<7;i++){
      const fixture=scenario.make();stats.planRequests=0;stats.searchedPlans=0;stats.stepChecks=0;
      const start=performance.now();fixture.run();const elapsed=performance.now()-start;
      if(i>=2)samples.push(elapsed);counts={...stats};outcome=fixture.outcome();
    }
    const ordered=sort(samples,(a,b)=>a-b);results.push({scenario:scenario.name,medianMs:Number(ordered[2].toFixed(3)),...counts,outcome});
  }
  return results;
}
function compact(result){
  const outcome=result.outcome;
  return {...result,outcome:Array.isArray(outcome)&&outcome.some(Array.isArray)
    ?{routes:outcome.length,cells:outcome.reduce((sum,route)=>sum+(route?.length??0),0),sha256:createHash('sha256').update(JSON.stringify(outcome)).digest('hex')}:outcome};
}
try{
  const beforeFile=await bundle('before',baseline),afterFile=await bundle('after');
  const [before,after]=await Promise.all([import(pathToFileURL(beforeFile).href),import(pathToFileURL(afterFile).href)]);
  const beforeResults=measure(before),afterResults=measure(after);
  for(let i=0;i<beforeResults.length;i++)deepStrictEqual(afterResults[i].outcome,beforeResults[i].outcome,beforeResults[i].scenario);
  console.log(JSON.stringify({baseline,bun:process.versions.bun,before:map(beforeResults,compact),after:map(afterResults,compact)},null,2));
}finally{await rm(folder,{recursive:true,force:true});}

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBenchmark();
}

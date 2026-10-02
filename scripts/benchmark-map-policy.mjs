// node scripts/benchmark-map-policy.mjs [baseline-ref] [--incremental]
// Exact default-policy TravelStep oracle; timings are local planning, not network latency.
import { deepStrictEqual } from 'node:assert';
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const ref=execFileSync('git',['rev-parse','--verify',`${process.argv[2]??'HEAD'}^{commit}`],{cwd:root,encoding:'utf8'}).trim();
const incremental=process.argv.includes('--incremental');
// Oracle mode removes timer latency; responsiveness is measured separately.
const scheduler={now:()=>performance.now(),schedule:callback=>{let cancelled=false;queueMicrotask(()=>{if(!cancelled)callback();});return()=>{cancelled=true;};}};
const query=(planner,args,current)=>incremental&&current?planner.routeBetweenMapsAsync(...args,undefined,undefined,{scheduler}):planner.routeBetweenMaps(...args);
const folder=await mkdtemp(join(tmpdir(),'rayrag-map-policy-oracle-'));
async function bundle(name,baseline=false){
  const outfile=join(folder,name+'.mjs');
  await build({stdin:{contents:"export {TravelPlanner,routeBetweenMaps,TRAVEL_PORTALS} from './src/travel.ts';",resolveDir:root},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent',plugins:baseline?[{name:'exact-baseline',setup(b){b.onLoad({filter:/\/src\/.*\.(ts|json)$/},args=>({contents:execFileSync('git',['show',`${ref}:${args.path.slice(root.length+1)}`],{cwd:root,encoding:'utf8',maxBuffer:32000000}),loader:args.path.endsWith('.json')?'json':'ts'}));}}]:[]});
  return import(pathToFileURL(outfile).href);
}
let seed=25;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const median=v=>v.sort((a,b)=>a-b)[Math.floor(v.length/2)];
try{
  const [before,after]=await Promise.all([bundle('before',true),bundle('after')]);
  const fixtures=[['prt_fild08',{x:169,y:193},'prontera'],['prt_fild08',{x:169,y:193},'payon'],['prt_fild08',{x:169,y:193},'geffen'],['moc_fild02',{x:77,y:338},'morocc']];
  const summaries=[];let comparisons=0;
  for(const fixture of fixtures){const results=[],times=[];for(const api of [before,after]){const planner=new api.TravelPlanner(),samples=[];let result;for(let n=0;n<5;n++){const started=performance.now();result=await query(planner,fixture,api===after);samples.push(performance.now()-started);}results.push(result);times.push(median(samples));}
    deepStrictEqual(results[1],results[0]);comparisons++;summaries.push({fixture:`${fixture[0]}→${fixture[2]}`,beforeMs:+times[0].toFixed(3),afterMs:+times[1].toFixed(3),crossings:results[0]?.length??null,outcomeHash:createHash('sha256').update(JSON.stringify(results[0])).digest('hex').slice(0,12)});}
  for(let run=0;run<300;run++){
    const names=['a','b','c','d','e'],edges=[];for(let i=0;i<15;i++){const fromMap=names[Math.floor(random()*names.length)],toMap=names[Math.floor(random()*names.length)],area={x:2+Math.floor(random()*8),y:2+Math.floor(random()*8),halfWidth:0,halfHeight:0};edges.push({id:`${run}:${i}`,fromMap,toMap,area,arrival:{x:1+Math.floor(random()*9),y:1+Math.floor(random()*9)},source:{kind:'Warp',commit:'fixture',path:'fixture',line:1}});}
    const blocked=new Set();for(const map of names)for(let i=0;i<12;i++)blocked.add(`${map}:${Math.floor(random()*12)}:${Math.floor(random()*12)}`);
    const grid=map=>({width:12,height:12,portals:edges.filter(e=>e.fromMap===map).map(e=>e.area),walkable:p=>p.x>=0&&p.y>=0&&p.x<12&&p.y<12&&!blocked.has(`${map}:${p.x}:${p.y}`)});
    const a=new before.TravelPlanner({edges,grid}),b=new after.TravelPlanner({edges,grid});for(const target of names)for(const avoidWalls of [false,true]){deepStrictEqual(incremental?await b.routeBetweenMapsAsync('a',{x:1,y:1},target,avoidWalls,undefined,{scheduler}):b.routeBetweenMaps('a',{x:1,y:1},target,avoidWalls),a.routeBetweenMaps('a',{x:1,y:1},target,avoidWalls));comparisons++;}
  }
  console.log(JSON.stringify({baseline:ref,incremental,exactComparisons:comparisons,fixtures:summaries},null,2));
}finally{await rm(folder,{recursive:true,force:true});}

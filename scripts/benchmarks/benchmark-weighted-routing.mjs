import { filter, map as mapArray } from 'effect/Array';
// bun scripts/benchmarks/benchmark-weighted-routing.mjs <frozen-before-esm-bundle> [--incremental]
// The bundle must export TravelPlanner and DEFAULT_MAP_POLICY. Scores, not tie
// paths, are compared: the conservative frontier can change equal-cost order.
import { deepStrictEqual } from 'node:assert';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { median } from './benchmark-policy.mjs';

export async function runBenchmark(args = process.argv.slice(2)) {
const root=resolve(dirname(fileURLToPath(import.meta.url)),'../..');
if(!args[0])throw new Error('Provide the frozen pre-optimization ESM bundle.');
const incremental=args.includes('--incremental');
const scheduler={now:()=>performance.now(),schedule:callback=>{let cancelled=false;queueMicrotask(()=>{if(!cancelled)callback();});return()=>{cancelled=true;};}};
const folder=await mkdtemp(join(tmpdir(),'rayrag-weighted-oracle-'));

let seed=2532;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
/** @returns {import("../shared/tooling-domain-values.mjs").RouteOptimum | null} */
function outcome(planner,route,fromMap,from,walls,policy){
  if(!route)return null;let score=0,map=fromMap,p=from;
  for(const step of route){const path=planner.search(map,p,step.portal,walls);if(!path)throw new Error('Returned approach is not physically reachable.');score=score+path.cost+200+(policy.penalties.find(r=>r.map===map)?.cost??0);map=step.portal.toMap;p=step.portal.arrival;}
  if(route.length)score+=planner.search(map,p,null,walls).cost;return {score,hops:route.length};
}
try{
  const outfile=join(folder,'after.mjs');await build({stdin:{contents:"export {TravelPlanner} from './src/modules/navigation/travel.ts';export {DEFAULT_MAP_POLICY} from './src/modules/navigation/map-policy.ts';",resolveDir:root},bundle:true,platform:'node',format:'esm',outfile,logLevel:'silent'});
  const [before,after]=await Promise.all([import(pathToFileURL(resolve(args[0])).href),import(pathToFileURL(outfile).href)]);
  let comparisons=0;const fixtures=[];
  for(const destination of ['prontera','payon','geffen']){
    const rows=[],outcomes=[];
    for(const api of [before,after]){
      const policy={...api.DEFAULT_MAP_POLICY,mode:'weighted'},cold=[],warm=[];let route,planner;
      for(let n=0;n<3;n++){planner=new api.TravelPlanner();const start=performance.now();route=planner.routeBetweenMaps('prt_fild08',{x:169,y:193},destination,true,policy);cold.push(performance.now()-start);}
      for(let n=0;n<3;n++){const start=performance.now();route=planner.routeBetweenMaps('prt_fild08',{x:169,y:193},destination,true,policy);warm.push(performance.now()-start);}
      rows.push({coldMs:+median(cold).toFixed(3),repeatedMs:+median(warm).toFixed(3)});outcomes.push(outcome(planner,route,'prt_fild08',{x:169,y:193},true,policy));
    }
    deepStrictEqual(outcomes[1],outcomes[0]);comparisons++;fixtures.push({fixture:`prt_fild08→${destination}`,before:rows[0],after:rows[1],outcome:outcomes[0]});
  }
  for(let run=0;run<250;run++){
    const names=['a','b','c','d'],edges=[];for(let i=0;i<12;i++){const fromMap=names[Math.floor(random()*4)],toMap=names[Math.floor(random()*4)];edges.push({id:`${run}:${i}`,fromMap,toMap,area:{x:2+Math.floor(random()*6),y:2+Math.floor(random()*6),halfWidth:random()<.15?1:0,halfHeight:random()<.15?1:0},arrival:{x:1+Math.floor(random()*8),y:1+Math.floor(random()*8)},source:{kind:'Warp',commit:'fixture',path:'fixture',line:1}});}
    const blocked=new Set();for(const map of names)for(let i=0;i<7;i++)blocked.add(`${map}:${Math.floor(random()*10)}:${Math.floor(random()*10)}`);
    const grid=map=>({width:10,height:10,portals:mapArray(filter(edges,e=>e.fromMap===map),e=>e.area),walkable:p=>p.x>=0&&p.y>=0&&p.x<10&&p.y<10&&!blocked.has(`${map}:${p.x}:${p.y}`)});
    const policy={...after.DEFAULT_MAP_POLICY,mode:'weighted',allow:run%5===0?names.filter(()=>random()<.8):[],deny:run%3===0?names.filter(()=>random()<.25):[],penalties:names.map(map=>({map,cost:Math.floor(random()*1000000)+random()}))};
    const a=new before.TravelPlanner({edges,grid,allowSameMap:run%2===0}),b=new after.TravelPlanner({edges,grid,allowSameMap:run%2===0});
    for(const destination of names)for(const walls of [false,true]){const from={x:1,y:1},old=a.routeBetweenMaps('a',from,destination,walls,policy),next=incremental?await b.routeBetweenMapsAsync('a',from,destination,walls,policy,{scheduler}):b.routeBetweenMaps('a',from,destination,walls,policy);if(incremental)deepStrictEqual(next,old);deepStrictEqual(outcome(b,next,'a',from,walls,policy),outcome(a,old,'a',from,walls,policy),`Scenario${run}/${destination}/${walls}`);comparisons++;}
  }
  console.log(JSON.stringify({incremental,weightedOptimumComparisons:comparisons,fixtures},null,2));
}finally{await rm(folder,{recursive:true,force:true});}

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBenchmark();
}

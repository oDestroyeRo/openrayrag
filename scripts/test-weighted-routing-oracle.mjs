import { filter, find, map as mapArray } from 'remeda';
// Independent eager score/hop frontier through the unchanged 64-hop bound.
// Reuses only physical local search; it does not reuse weightedPotential or the
// optimized world frontier. Both integer/half and large fractional penalties.
import assert from 'node:assert/strict';
import {pathToFileURL, fileURLToPath} from 'node:url';
import { build } from 'esbuild';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
export async function runBenchmark(args = process.argv.slice(2)) {
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const folder=await mkdtemp(join(tmpdir(),'rayrag-weighted-proof-')),bundle=join(folder,'planner.mjs');
await build({stdin:{contents:"export {TravelPlanner} from './src/travel.ts';export {DEFAULT_MAP_POLICY} from './src/map-policy.ts';",resolveDir:root},bundle:true,platform:'node',format:'esm',outfile:bundle,logLevel:'silent'});
const {TravelPlanner,DEFAULT_MAP_POLICY}=await import(pathToFileURL(bundle).href);
// Proof scheduler only. Actual macrotask latency is measured by the benchmark.
const scheduler={now:()=>performance.now(),schedule:callback=>{let cancelled=false;queueMicrotask(()=>{if(!cancelled)callback();});return()=>{cancelled=true;};}};
let seed=0x2531;const random=()=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed/2**32;};
const allowed=(p,m)=>!p.deny.includes(m)&&(!p.allow.length||p.allow.includes(m));
const stateKey=(map,p)=>`${map}:${p.x}:${p.y}`;
function eager(planner,edges,same,fromMap,from,toMap,walls,policy){
 if(!allowed(policy,toMap)||!planner.mapCells(fromMap)||!planner.mapCells(toMap)||!planner.search(fromMap,from,null,walls))return null;
 if(fromMap===toMap)return {score:0,hops:0};
 let frontier=new Map([[stateKey(fromMap,from),{map:fromMap,p:from,score:0}]]);
 /** @type {{score: number, hops: number} | null} */
 let best=null;
 for(let hop=0;hop<=64&&frontier.size;hop++){
  const next=new Map();
  for(const node of frontier.values()){
   if(node.map===toMap){const escape=planner.search(node.map,node.p,null,walls);if(escape){const candidate={score:node.score+escape.cost,hops:hop};if(!best||candidate.score<best.score||candidate.score===best.score&&hop<best.hops)best=candidate;}continue;}
   if(hop===64)continue;
   for(const edge of edges){if(edge.fromMap!==node.map||!same&&edge.fromMap===edge.toMap||!allowed(policy,edge.toMap))continue;
    const target=planner.mapCells(edge.toMap);if(!target||!target.tiles[target.index(edge.arrival)])continue;
    const approach=planner.search(node.map,node.p,edge,walls);if(!approach)continue;
    const score=node.score+approach.cost+200+(find(policy.penalties,p=>p.map===node.map)?.cost??0),key=stateKey(edge.toMap,edge.arrival);
    if(!next.has(key)||score<next.get(key).score)next.set(key,{map:edge.toMap,p:edge.arrival,score});
   }
  }
  frontier=next;
 }
 return best;
}
let comparisons=0,reachable=0;const started=performance.now();
try {
for(const fractional of [false,true]) {
seed=fractional?0x2599:0x2531;
for(let run=0;run<250;run++){
 const names=['a','b','c','d'],edges=[];
 for(let i=0;i<11;i++){const fromMap=names[Math.floor(random()*4)],toMap=names[Math.floor(random()*4)];edges.push({id:`${run}:${i}`,fromMap,toMap,area:{x:2+Math.floor(random()*6),y:2+Math.floor(random()*6),halfWidth:random()<.15?1:0,halfHeight:random()<.15?1:0},arrival:{x:1+Math.floor(random()*8),y:1+Math.floor(random()*8)},source:{kind:'Warp',commit:'test',path:'test',line:1}});}
 const blocked=new Set();for(const map of names)for(let i=0;i<7;i++)blocked.add(`${map}:${Math.floor(random()*10)}:${Math.floor(random()*10)}`);
 const grid=map=>({width:10,height:10,portals:mapArray(filter(edges,e=>e.fromMap===map),e=>e.area),walkable:p=>p.x>=0&&p.y>=0&&p.x<10&&p.y<10&&!blocked.has(`${map}:${p.x}:${p.y}`)});
 const policy={...DEFAULT_MAP_POLICY,mode:'weighted',allow:run%5===0?names.filter(()=>random()<.8):[],deny:run%3===0?names.filter(()=>random()<.25):[],penalties:names.map(map=>({map,cost:fractional?Math.floor(random()*1000000)+random():Math.floor(random()*300)+(run%2?.5:0)}))};
 const same=run%2===0,planner=new TravelPlanner({edges,grid,allowSameMap:same});
 for(const target of names)for(const walls of [false,true]){
  const from={x:1,y:1},expected=eager(planner,edges,same,'a',from,target,walls,policy),route=await planner.routeBetweenMapsAsync('a',from,target,walls,policy,{scheduler});
  assert.deepEqual(route,planner.routeBetweenMaps('a',from,target,walls,policy),'Synchronous exact route, cells, escape and ties');
  /** @type {{score: number, hops: number} | null} */
  let actual=null;if(route){let map='a',p=from,score=0;for(const step of route){assert(allowed(policy,step.portal.toMap));const path=planner.search(map,p,step.portal,walls);assert(path);score+=path.cost+200+(find(policy.penalties,r=>r.map===map)?.cost??0);map=step.portal.toMap;p=step.portal.arrival;}
    if(route.length)score+=planner.search(map,p,null,walls).cost;actual={score,hops:route.length};reachable++;
  }
  assert.deepEqual(actual,expected,JSON.stringify({run,target,walls,policy}));comparisons++;
 }
}
}
console.log(JSON.stringify({comparisons,reachable,elapsedMs:Math.round(performance.now()-started)}));

} finally { await rm(folder,{recursive:true,force:true}); }

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBenchmark();
}

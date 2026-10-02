// node scripts/benchmark-responsive-routing.mjs
// Offline ESM/native-module and Safari-targeted injected-IIFE artifacts under
// the same host scheduler. This does not claim native WebKit or live-game proof.
import { strictEqual } from 'node:assert';
import { build } from 'esbuild';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createContext, runInContext } from 'node:vm';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const folder=await mkdtemp(join(tmpdir(),'rayrag-responsive-'));
const entry="export {TravelPlanner} from './src/travel.ts';export {DEFAULT_MAP_POLICY} from './src/map-policy.ts';";
const round=n=>+n.toFixed(3), results=[];
async function measure(api,mode,destination,warm){
  const planner=new api.TravelPlanner(), policy={...api.DEFAULT_MAP_POLICY,mode},from={x:169,y:193};
  const oracle=new api.TravelPlanner().routeBetweenMaps('prt_fild08',from,destination,true,policy);
  if(warm)await planner.routeBetweenMapsAsync('prt_fild08',from,destination,true,policy);
  let maxSlice=0,maxSchedule=0,maxTickDelay=0,slices=0,lastTick=performance.now();
  const timer=setInterval(()=>{const now=performance.now();maxTickDelay=Math.max(maxTickDelay,now-lastTick-10);lastTick=now;},10);
  const start=performance.now();
  try{
    const route=await planner.routeBetweenMapsAsync('prt_fild08',from,destination,true,policy,{onSlice:s=>{maxSlice=Math.max(maxSlice,s.durationMs);maxSchedule=Math.max(maxSchedule,s.schedulingDelayMs);slices++;}});
    const total=performance.now()-start;
    strictEqual(JSON.stringify(route),JSON.stringify(oracle),'Exact routes, cells, escapes and ties');
    return {mode,destination,cache:warm?'repeated':'cold',totalMs:round(total),maxSliceMs:round(maxSlice),maxSchedulingDelayMs:round(maxSchedule),maxTimerDelayMs:round(maxTickDelay),slices};
  }finally{clearInterval(timer);}
}
async function cancellation(api){
  const abort=new AbortController();let slices=0,cancelledAt=0,requestedAt=0;
  const planner=new api.TravelPlanner();const start=performance.now();
  try{
    await planner.routeBetweenMapsAsync('prt_fild08',{x:169,y:193},'payon',true,{...api.DEFAULT_MAP_POLICY,mode:'weighted'},
      {signal:abort.signal,onSlice:()=>{if(++slices===3){requestedAt=performance.now();setTimeout(()=>{cancelledAt=performance.now();abort.abort();},0);}}});
    throw new Error('Expected cancellation.');
  }catch(error){if(error.name!=='AbortError')throw error;return{totalMs:round(performance.now()-start),inputSchedulingDelayMs:round(cancelledAt-requestedAt),cancellationLatencyMs:round(performance.now()-cancelledAt),slices};}
}
try{
  const esm=join(folder,'native-module.mjs'),iife=join(folder,'injected-iife.js');
  for(const [outfile,format] of [[esm,'esm'],[iife,'iife']])await build({stdin:{contents:entry,resolveDir:root},bundle:true,platform:'browser',target:'safari16',format,outfile,globalName:'RouteBenchmark',logLevel:'silent'});
  const native=await import(pathToFileURL(esm).href);
  const context=createContext({performance,setTimeout,clearTimeout,structuredClone,atob,AbortController});
  runInContext(await readFile(iife,'utf8'),context);const injected=context.RouteBenchmark;
  for(const [runtime,api] of [['native-module-artifact',native],['injected-iife-artifact',injected]]){
    const rows=[];
    for(const mode of ['legacy','weighted'])for(const destination of ['prontera','payon','geffen'])for(const warm of [false,true])rows.push(await measure(api,mode,destination,warm));
    results.push({runtime,rows,cancellation:await cancellation(api)});
  }
  console.log(JSON.stringify({host:process.version,sliceBudgetMs:8,results},null,2));
}finally{await rm(folder,{recursive:true,force:true});}

// Offline-only native WebKit/Chrome fixture. No app, socket or gameplay transport
// is opened. Serve the output directory and load index.html in the chosen runtime.
// An explicit output directory must be new; default outputs are unique.
import { build } from 'esbuild';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const root=resolve(dirname(fileURLToPath(import.meta.url)),'..');
const output=process.argv[2] ? resolve(process.argv[2]) : await mkdtemp(join(tmpdir(),'rayrag-responsive-fixture-'));
if(process.argv[2]){await mkdir(dirname(output),{recursive:true});await mkdir(output,{mode:0o700});}
const result=await build({stdin:{resolveDir:root,contents:`
import {TravelController} from './src/travel-controller';
import {TravelPlanner} from './src/travel';
import {DEFAULT_MAP_POLICY} from './src/map-policy';
const host=document.getElementById('fixture');
host.innerHTML='<h1>Offline route planning</h1><p>No socket or gameplay transport. Stop affects this fixture only.</p><label>Destination <select id="destination"><option>payon</option><option>geffen</option><option>prontera</option></select></label><label>Mode <select id="mode"><option>weighted</option><option>legacy</option></select></label><label>Input check <input id="input-check" autocomplete="off"></label><button id="plan">Start plan</button><button id="stop">Stop fixture plan</button><button id="measure">Measure cold and repeated</button><p id="state"></p><p id="measurement-state" role="status">Measurements idle.</p><output id="results"></output><section id="measurement-rows" aria-label="Measurement rows"></section>';
const element=id=>document.getElementById(id), output=element('results'), measurementRows=element('measurement-rows');
const player={id:1,kind:0,classId:0,name:'Offline fixture',level:1,hp:100,maxHp:100,x:169,y:193,dead:false};
const context={identity:'offline/connection1/world1/own1',map:'prt_fild08',player};
let planner=new TravelPlanner(), started=0, slices=[], commands=[], inputAt=null, stopAt=null, maxTickDelay=0,lastTick=performance.now();
let measurement=null;
const round=n=>Math.round(n*1000)/1000;
const maxOf=(records,key)=>records.reduce((max,s)=>Math.max(max,s[key]),0);
const paragraph=(parent,text)=>{const p=document.createElement('p');p.textContent=text;parent.append(p);};
const record=s=>slices.push(s);
const controller=new TravelController(action=>commands.push(action),Date.now,undefined,{context:()=>context,plan:(...args)=>planner.routeBetweenMapsAsync(...args.slice(0,5),{...args[5],onSlice:record})});
const state=()=>{const s=controller.snapshot();return {state:s.state,reason:s.reason,inputAt,stopAt,elapsedMs:performance.now()-started,maxSliceMs:maxOf(slices,'durationMs'),maxSchedulingDelayMs:maxOf(slices,'schedulingDelayMs'),maxTickDelayMs:maxTickDelay,slices:slices.length,commands:commands.map(a=>a.type)};};
const renderState=()=>{const s=state();output.replaceChildren();paragraph(output,s.state+' · '+s.reason);paragraph(output,'Input: '+JSON.stringify(s.inputAt));paragraph(output,'Stop: '+JSON.stringify(s.stopAt));paragraph(output,'Elapsed '+round(s.elapsedMs)+' ms; max slice '+round(s.maxSliceMs)+' ms; scheduling '+round(s.maxSchedulingDelayMs)+' ms.');paragraph(output,'100 ms tick delay '+round(s.maxTickDelayMs)+' ms; slices '+s.slices+'; commands '+JSON.stringify(s.commands)+'.');};
const renderProgress=()=>{if(!measurement)return;const m=measurement;element('measurement-state').textContent='Completed '+m.rows.length+'/12; '+m.current+'; elapsed '+round(performance.now()-m.start)+' ms; slices '+m.records.length+'; page '+document.visibilityState+'.';};
setInterval(()=>{const now=performance.now();maxTickDelay=Math.max(maxTickDelay,now-lastTick-100);lastTick=now;element('state').textContent=controller.snapshot().state+' · '+controller.snapshot().reason;renderProgress();},100);
element('input-check').addEventListener('input',()=>{inputAt={at:performance.now()-started,state:controller.snapshot().state,value:element('input-check').value};renderState();});
element('plan').addEventListener('click',()=>{if(controller.active||measurement)return;planner=new TravelPlanner();slices=[];commands=[];inputAt=null;stopAt=null;maxTickDelay=0;started=lastTick=performance.now();controller.start('prt_fild08',player,element('destination').value,10,true,{...DEFAULT_MAP_POLICY,mode:element('mode').value});element('state').textContent=controller.snapshot().state;renderState();});
element('stop').addEventListener('click',()=>{const before=performance.now();controller.cancel();measurement?.abort.abort();stopAt={at:before-started,latencyMs:performance.now()-before};renderState();});
element('measure').addEventListener('click',async()=>{
  if(measurement)return;
  controller.cancel();output.replaceChildren();measurementRows.replaceChildren();
  const m={abort:new AbortController(),rows:[],current:'starting',start:performance.now(),records:[]};measurement=m;
  element('plan').disabled=element('measure').disabled=true;window.routePlanningMeasurements=m.rows;renderProgress();
  try{
    for(const mode of ['legacy','weighted'])for(const destination of ['prontera','payon','geffen']){
      const p=new TravelPlanner();
      for(const cache of ['cold','repeated']){
        m.current=mode+' '+destination+' '+cache;m.records=[];m.start=performance.now();let maxTimerDelay=0,lastTimer=m.start;
        const timer=setInterval(()=>{const now=performance.now();maxTimerDelay=Math.max(maxTimerDelay,now-lastTimer-100);lastTimer=now;},100);
        renderProgress();
        try{await p.routeBetweenMapsAsync('prt_fild08',player,destination,true,{...DEFAULT_MAP_POLICY,mode},{signal:m.abort.signal,onSlice:s=>m.records.push(s)});}finally{clearInterval(timer);}
        const row={mode,destination,cache,totalMs:round(performance.now()-m.start),maxSliceMs:round(maxOf(m.records,'durationMs')),maxSchedulingDelayMs:round(maxOf(m.records,'schedulingDelayMs')),maxTimerDelayMs:round(maxTimerDelay),slices:m.records.length};m.rows.push(row);
        paragraph(measurementRows,m.rows.length+'. '+m.current+': total '+row.totalMs+' ms; slice '+row.maxSliceMs+' ms; scheduling '+row.maxSchedulingDelayMs+' ms; tick delay '+row.maxTimerDelayMs+' ms; '+row.slices+' slices.');
      }
    }
    element('measurement-state').textContent='Completed 12/12; no gameplay commands. All measurements are shown below.';
  }catch(error){element('measurement-state').textContent=(error.name==='AbortError'?'Cancelled':'Failed')+' after '+m.rows.length+'/12: '+m.current+'; '+error.name+': '+error.message;}
  finally{measurement=null;element('plan').disabled=element('measure').disabled=false;}
});
window.routePlanningFixture={state,stop:()=>element('stop').click()};
`},bundle:true,platform:'browser',target:'safari16',format:'iife',outfile:join(output,'fixture.js'),write:false,logLevel:'silent'});
for(const file of result.outputFiles)await writeFile(file.path,file.contents,{flag:'wx',mode:0o600});
await writeFile(join(output,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><title>Offline route planning fixture</title><style>body{font:16px system-ui;max-width:900px;margin:32px auto;background:#141b23;color:#e3eaf2}label{display:block;margin:12px 0}button,input,select{font:inherit;margin:8px;padding:8px}output{display:block}output p,#measurement-rows p{background:#223044;padding:10px;margin:6px 0}#measurement-state{font-weight:600}</style></head><body><main id="fixture"></main><script src="fixture.js"></script></body></html>',{flag:'wx',mode:0o600});
console.log(output);

import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { packetReport, validatePacketReport } from './benchmark-policy.mjs';

// Offline synthetic replay through the real adapters. Instrumented decoder counts
// and uninstrumented timings use separate bundles. No network or native transport.
export async function runBenchmark(args = process.argv.slice(2)) {
const root = resolve(import.meta.dirname, '..');
const baseline = args[0];
if (!baseline) throw new Error('Usage: bun scripts/benchmark-packet-processing.mjs <baseline-ref>');
const temporary = await mkdtemp(join(tmpdir(), 'rayrag-packet-benchmark-'));
const adapterPaths = new Set(['src/controller.ts', 'src/direct-runtime.ts', 'src/bridge.ts']);
const harness = `
import { BitWriter } from ${JSON.stringify(join(root, 'src/binary.ts'))};
import { DirectRuntime } from ${JSON.stringify(join(root, 'src/direct-runtime.ts'))};
import { initializeBridge } from ${JSON.stringify(join(root, 'src/bridge.ts'))};
import { OP, GAME_URL, SOCKET_URL, VERIFIED_BUILD } from ${JSON.stringify(join(root, 'src/protocol.ts'))};

let now=100_000;
Date.now = () => now;
let uuid=0;
crypto.randomUUID = () => '00000000-0000-4000-8000-'+String(++uuid).padStart(12,'0');
globalThis.setInterval = () => 0;
globalThis.__packetCounts = {general:0,world:0};
class NativeSocket extends EventTarget {
  static OPEN=1;readyState=1;writes=[];
  constructor(url){super();this.url=url;}
  send(data){this.writes.push(Array.from(new Uint8Array(data)));}
}
function spawn(id,kind,entry=0){
  const name=new TextEncoder().encode(kind===0?'Synthetic':'Poring');
  const body=new BitWriter().u8(15).i32(id).i32(kind===0?6:4000).i32(0).i32(~name.length).i32(name.length).take(name)
    .u8(kind).u8(0).u8(0).i32(100+id).i32(100).u8(15).i32(100).i32(100).i32(200).i32(200).i32(0).u8(0).finish();
  return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body).finish();
}
function resources(){
  const writer=new BitWriter().u8(56);
  for(const value of [15,15,10000,1,1,1,1,1,1,0,0,0])writer.i32(value);
  for(const value of [100,100,200,200,...Array(16).fill(1),2000])writer.i32(value);
  writer.f32(.5).i32(100).i32(0).bool(true).i16(0).i16(0).bool(true).u8(1).i32(1).i32(717).i16(3).i32(0).u8(0);
  for(let index=0;index<10;index++)writer.i32(0);
  return writer.i32(-1).finish();
}
const initial=[new BitWriter().u8(OP.enter).i32(0).string('prt_fild08').finish(),resources(),
  new BitWriter().u8(94).u8(0).u8(0).u8(0).u8(0).finish(),spawn(0,0,1)];
const burst=[spawn(2,1),new BitWriter().u8(OP.move).i32(2).position({x:103,y:100}).finish(),
  new BitWriter().u8(OP.tracking).u16(2).i32(0).i16(100).i16(100).u8(0).i32(2).i16(103).i16(100).u8(1).finish(),resources()];
const packets=[...initial,...Array.from({length:150},()=>burst).flat()];
async function flush(){for(let index=0;index<12;index++)await Promise.resolve();}
async function fixture(mode){
  now=100_000;uuid=0;
  if(mode==='botOnly'){
    const writes=[],invoke=async(name,args)=>{if(name==='direct_send')writes.push(args.bytes);};
    const runtime=new DirectRuntime({invoke,now:Date.now,store:{read:()=>false,write:()=>{}}});
    await runtime.receive([{kind:'opened'},{kind:'enterSent',bytes:[...new BitWriter().u8(3).bool(false).string('Synthetic').finish()]}]);
    return {writes,frame:bytes=>runtime.receive([{kind:'frame',bytes:Array.from(bytes)}]),ready:()=>runtime.receive([{kind:'readySent'}]),
      perform:()=>runtime.perform('command',{type:'sit',sitting:false}),snapshot:()=>runtime.controller.snapshot()};
  }
  const page={WebSocket:NativeSocket,buildUrl:VERIFIED_BUILD,addEventListener:()=>{}};
  Object.assign(globalThis,{window:page,location:{origin:new URL(GAME_URL).origin,pathname:'/'},
    localStorage:{getItem:()=>null,setItem:()=>{},removeItem:()=>{}},document:{addEventListener:()=>{}}});
  initializeBridge();
  const socket=new page.WebSocket(SOCKET_URL);socket.dispatchEvent(new Event('open'));
  return {writes:socket.writes,frame:async bytes=>{socket.dispatchEvent(Object.assign(new Event('message'),{data:Uint8Array.from(bytes).buffer}));await flush();},
    ready:async()=>{socket.send(Uint8Array.of(2));await flush();},perform:()=>page.__RAYRAG__.perform('command',{type:'sit',sitting:false}),snapshot:()=>page.__RAYRAG__.snapshot()};
}
async function replay(mode){
  const f=await fixture(mode);
  for(let index=0;index<packets.length;index++){await f.frame(packets[index]);if(index===2)await f.ready();}
  now+=1200;f.perform();await flush();
  return {snapshot:f.snapshot(),writes:f.writes};
}
const output={frames:packets.length};
for(const mode of ['gameClient','botOnly']){
  globalThis.__packetCounts={general:0,world:0};
  const result=await replay(mode),counts={...globalThis.__packetCounts};
  const samples=[];
  for(let iteration=0;iteration<9;iteration++){
    const start=performance.now();await replay(mode);
    if(iteration>=2)samples.push(performance.now()-start);
  }
  samples.sort((a,b)=>a-b);
  output[mode]={...result,counts,medianMs:samples[Math.floor(samples.length/2)],samplesMs:samples};
}
process.stdout.write(JSON.stringify(output));
`;

/** @param {string | null} ref @param {boolean} instrumented @returns {Promise<import("./tooling-domain-values.mjs").PacketReplay>} */
async function measure(ref, instrumented) {
  const outputFile = join(temporary, `${ref ? 'baseline' : 'current'}-${instrumented ? 'counts' : 'time'}.mjs`);
  await build({
    stdin:{contents:harness,resolveDir:root,sourcefile:'packet-benchmark.ts',loader:'ts'},
    bundle:true,platform:'node',format:'esm',target:'es2022',outfile:outputFile,
    plugins:[{name:'offline-packet-replay',setup(builder){
      builder.onLoad({filter:/\/src\/(controller|bridge|direct-runtime|protocol|world-protocol|map-data)\.ts$/},async({path})=>{
        const relative=path.slice(root.length+1);
        if(relative==='src/map-data.ts')return {contents:'export const currentMapInfo=()=>null;export const loadMapCatalog=async()=>null;',loader:'ts'};
        let contents=ref&&adapterPaths.has(relative)
          ?execFileSync('git',['show',`${ref}:${relative}`],{cwd:root,encoding:'utf8'})
          :await readFile(path,'utf8');
        if(relative==='src/bridge.ts')contents=contents.replace('const page = window as BridgeWindow;','export function initializeBridge(){\nconst page = window as BridgeWindow;')+'\n}';
        if(instrumented&&relative==='src/protocol.ts')contents=contents.replace('export function decode(data: Uint8Array): GameEvent[] {','$&\nglobalThis.__packetCounts.general++;');
        if(instrumented&&relative==='src/world-protocol.ts')contents=contents.replace('export function decodeWorld(data: Uint8Array): WorldEvent[] | null {','$&\nglobalThis.__packetCounts.world++;');
        return {contents,loader:'ts'};
      });
    }}],
  });
  return JSON.parse(execFileSync(process.execPath,[outputFile],{cwd:root,encoding:'utf8'}));
}
try {
  // Count runs are separate from timing runs; all timing bundles omit counters.
  const beforeCounts=await measure(baseline,true),afterCounts=await measure(null,true);
  const beforeTime=await measure(baseline,false),afterTime=await measure(null,false);
  const result = packetReport(baseline, beforeCounts, afterCounts, beforeTime, afterTime);
  process.stdout.write(`${JSON.stringify(result,null,2)}\n`);
  validatePacketReport(result);
} finally {
  await rm(temporary,{recursive:true,force:true});
}

}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await runBenchmark();
}

import { describe, expect, it } from 'vitest';
import { MAX_PLANNING_JOBS, runPlanning, type PlanningScheduler, type PlanningWork, type PlanningPhase } from './route-planning';
import { TravelPlanner, type PortalEdge } from './travel';
import { DEFAULT_MAP_POLICY } from './map-policy';

export class ManualPlanningScheduler implements PlanningScheduler {
  time = 0;
  readonly callbacks = new Set<() => void>();
  now = () => this.time++;
  schedule(callback: () => void): () => void { this.callbacks.add(callback); return () => this.callbacks.delete(callback); }
  next(): void { const callback = this.callbacks.values().next().value; if (callback) { this.callbacks.delete(callback); callback(); } }
  drain(): void { let count = 0; while (this.callbacks.size) { if (++count > 100_000) throw new Error('Unbounded planner.'); this.next(); } }
}
const edge = (id: string, fromMap: string, toMap: string, x: number): PortalEdge => ({ id, fromMap, toMap,
  area: { x, y: 4, halfWidth: 0, halfHeight: 0 }, arrival: { x: 1, y: 1 },
  source: { kind: 'Warp', commit: 'fixture', path: 'fixture', line: 1 } });
const edges = [edge('ab','a','b',7),edge('ac','a','c',5),edge('bd','b','d',2),edge('cd','c','d',7),edge('ca','c','a',2)];
const planner = () => new TravelPlanner({ edges, grid: map => ({ width: 10, height: 10,
  portals: edges.filter(e => e.fromMap === map).map(e => e.area),
  walkable: p => p.x >= 0 && p.y >= 0 && p.x < 10 && p.y < 10 && !(p.x === 4 && p.y < 7) }) });

describe('incremental exact routing', () => {
  it('preserves cells, escape paths, ties and availability across detached policies', async () => {
    const runtime = new ManualPlanningScheduler();
    const sync = planner(), asyncPlanner = planner();
    for (const mode of ['legacy', 'weighted'] as const) for (const walls of [false,true]) for (const destination of ['a','b','c','d']) {
      const policy = { ...DEFAULT_MAP_POLICY, mode, deny: destination === 'c' ? ['c'] : ['a'], penalties: [{map:'b',cost:200.0001},{map:'c',cost:0.999999}] };
      const expected = sync.routeBetweenMaps('a',{x:1,y:1},destination,walls,policy);
      const result = asyncPlanner.routeBetweenMapsAsync('a',{x:1,y:1},destination,walls,policy,{scheduler:runtime,sliceMs:1});
      runtime.drain();
      expect(await result).toEqual(expected);
    }
  });
  it.each<PlanningPhase>(['map-analysis','local-search','heuristic','world-search','route-copy'])('cancels deterministically inside %s', async phase => {
    const runtime = new ManualPlanningScheduler(), abort = new AbortController(); let observed = false;
    const result = planner().routeBetweenMapsAsync('a',{x:1,y:1},'d',true,{...DEFAULT_MAP_POLICY,mode:'weighted'},
      {scheduler:runtime,sliceMs:1,signal:abort.signal,onSlice:slice=>{if(slice.phase===phase){observed=true;abort.abort();}}});
    runtime.drain(); await expect(result).rejects.toMatchObject({name:'AbortError'});
    expect(observed).toBe(true); expect(runtime.callbacks.size).toBe(0);
  });
  it('captures position and policy before its first yield', async () => {
    const runtime = new ManualPlanningScheduler(), p = planner(), from = {x:1,y:1};
    const policy = {...DEFAULT_MAP_POLICY,mode:'weighted' as const,deny:[] as string[]};
    const expected = p.routeBetweenMaps('a',from,'d',true,policy);
    const result = p.routeBetweenMapsAsync('a',from,'d',true,policy,{scheduler:runtime,sliceMs:1});
    from.x = -1; policy.deny.push('d'); runtime.drain();
    expect(await result).toEqual(expected);
  });
  it('yields during cold map analysis and releases a cancelled job immediately', async () => {
    const runtime = new ManualPlanningScheduler(), abort = new AbortController();
    let reads = 0;
    const p = new TravelPlanner({edges:[],grid:()=>({width:512,height:512,walkable:()=>{reads++;return true;}})});
    const result = p.routeBetweenMapsAsync('a',{x:1,y:1},'b',true,{...DEFAULT_MAP_POLICY,mode:'weighted'},{scheduler:runtime,sliceMs:1,signal:abort.signal});
    expect(reads).toBe(0); runtime.next(); runtime.next();
    expect(reads).toBeGreaterThan(0); expect(reads).toBeLessThan(512*512);
    abort.abort(); const stoppedAt = reads; runtime.drain();
    await expect(result).rejects.toMatchObject({name:'AbortError'}); expect(reads).toBe(stoppedAt);
  });
});

describe('planning scheduling and retention', () => {
  function* forever(): PlanningWork<number> { while (true) yield; }
  it('distinguishes a completed undefined value from rejection and closes once', async () => {
    const runtime = new ManualPlanningScheduler();
    const work = (function* (): PlanningWork<undefined> { return undefined; })();
    let closes = 0;
    const close = work.return.bind(work);
    work.return = value => { closes++; return close(value); };
    const result = runPlanning(work, { scheduler: runtime });
    runtime.drain();
    await expect(result).resolves.toBeUndefined();
    expect(closes).toBe(1);
    expect(runtime.callbacks.size).toBe(0);
  });
  it.each([undefined, null, false, 0, 'search failure'])('retains the original thrown value %s over iterator cleanup failure', async cause => {
    const runtime = new ManualPlanningScheduler();
    const work = (function* (): PlanningWork<never> { throw cause; })();
    let closes = 0;
    work.return = () => { closes++; throw new Error('cleanup failure'); };
    const settled = runPlanning(work, { scheduler: runtime }).then(
      value => ({ type: 'completed', value }), error => ({ type: 'failed', error }));
    runtime.drain();
    expect(await settled).toEqual({ type: 'failed', error: cause });
    expect(closes).toBe(1);
    expect(runtime.callbacks.size).toBe(0);
  });
  it('rejects an undefined iterator-close failure and releases its job slot', async () => {
    const runtime = new ManualPlanningScheduler();
    const work = (function* (): PlanningWork<number> { return 7; })();
    work.return = () => { throw undefined; };
    const settled = runPlanning(work, { scheduler: runtime }).then(
      value => ({ type: 'completed', value }), error => ({ type: 'failed', error }));
    runtime.drain();
    expect(await settled).toEqual({ type: 'failed', error: undefined });
    const jobs = Array.from({ length: MAX_PLANNING_JOBS }, () => runPlanning((function* () { return 9; })(), { scheduler: runtime }));
    runtime.drain();
    expect(await Promise.all(jobs)).toEqual(Array(MAX_PLANNING_JOBS).fill(9));
  });
  it('bounds concurrent jobs without queuing and frees slots on abort', async () => {
    const runtime = new ManualPlanningScheduler(), abort = new AbortController();
    const jobs = Array.from({length:MAX_PLANNING_JOBS},()=>runPlanning(forever(),{scheduler:runtime,signal:abort.signal}));
    await expect(runPlanning(forever(),{scheduler:runtime})).rejects.toThrow('Too many');
    expect(runtime.callbacks.size).toBe(MAX_PLANNING_JOBS);
    abort.abort(); await Promise.all(jobs.map(job=>expect(job).rejects.toMatchObject({name:'AbortError'})));
    expect(runtime.callbacks.size).toBe(0);
    const next = runPlanning((function*(){return 7;})(),{scheduler:runtime}); runtime.drain(); expect(await next).toBe(7);
  });
  it('rejects errors and ignores a delayed callback after cancellation', async () => {
    const runtime = new ManualPlanningScheduler(), abort = new AbortController();
    let resumed = false;
    const result = runPlanning((function*(){yield;resumed=true;return 1;})(),{scheduler:runtime,sliceMs:1,signal:abort.signal});
    runtime.next(); const late = runtime.callbacks.values().next().value!; abort.abort(); late();
    await expect(result).rejects.toMatchObject({name:'AbortError'}); expect(resumed).toBe(false);
    const failed = runPlanning((function*(){yield;throw new Error('search failed');})(),{scheduler:runtime,sliceMs:1});
    runtime.drain(); await expect(failed).rejects.toThrow('search failed');
  });
  it('bounds a slice even when the injected clock does not advance', async () => {
    const runtime = new ManualPlanningScheduler(); runtime.now=()=>0;
    const abort = new AbortController(); let operations=0;
    const result=runPlanning((function*(){while(true){operations++;yield;}})(),{scheduler:runtime,signal:abort.signal});
    runtime.next(); expect(operations).toBe(4096); expect(runtime.callbacks.size).toBe(1);
    abort.abort(); await expect(result).rejects.toMatchObject({name:'AbortError'});
  });
});

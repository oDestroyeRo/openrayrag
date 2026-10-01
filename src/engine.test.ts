import { describe, expect, it, vi } from 'vitest';
import { BotEngine, DEFAULT_SETTINGS, DEFAULT_AUTOMATION, type Action, validateSettings } from './engine';
import { GridNavigator, searchGrid, type WalkGrid } from './navigation';
import { type Entity, type Position, type GameEvent } from './protocol';

const player: Entity={id:1,classId:0,name:'Test player',kind:0,level:7,hp:70,maxHp:70,x:100,y:100,dead:false};
const monster: Entity={id:2,classId:4000,name:'Poring',kind:1,level:1,hp:51,maxHp:51,x:101,y:100,dead:false};
const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
const openGrid: WalkGrid = { width: 200, height: 200, walkable: () => true };
function setup() {
  let now=100_000;
  const sent:Action[]=[];
  const engine=new BotEngine(a=>sent.push(a),()=>now, () => openGrid);
  engine.connect(true);
  engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}},{type:'spawn',entity:{...monster}}]);
  const step=(ms=1000) => { now+=ms; engine.tick(); };
  return {engine,sent,step};
}
describe('combat and looting behavior', () => {
  it('rejects a start based on the previous map without sending an attack', () => {
    const {engine,sent}=setup();
    expect(()=>engine.start({...settings,map:'prt_fild05'})).toThrow('Map changed');
    expect(engine.running).toBe(false);expect(sent).toEqual([]);
  });
  it('matches selected monster classes even when names differ, and never attacks catalog-only entries', () => {
    const {engine,sent,step}=setup();
    engine.start({...settings,targets:[4002]});step();expect(sent).toEqual([]);
    engine.stop();sent.length=0;
    engine.entities.get(2)!.name='Renamed Poring';
    engine.start(settings);step();expect(sent).toEqual([{type:'attack',id:2}]);
  });
  it('rejects empty, duplicate, invalid or unbound map selections', () => {
    for (const targets of [[],[4000,4000],[0],[-1],[1.5],[2**31]]) {
      expect(()=>validateSettings({...settings,targets})).toThrow();
    }
    expect(()=>validateSettings({...settings,map:''})).toThrow();
    expect(()=>validateSettings({...settings,map:'../map'})).toThrow();
  });
  it('does nothing until explicitly started, then sends one attack', () => {
    const {engine,sent,step}=setup(); step(); expect(sent).toEqual([]);
    engine.start(settings);step();step();expect(sent).toEqual([{type:'attack',id:2}]);
  });
  it('requires a verified, connected, living character', () => {
    const {engine}=setup();engine.compatible=false;
    expect(()=>engine.start(settings)).toThrow();engine.compatible=true;
    engine.player!.hp=10;expect(()=>engine.start(settings)).toThrow();
    engine.player!.hp=70;engine.player!.dead=true;expect(()=>engine.start(settings)).toThrow();
  });
  it('does not attack another player, a distant monster, a stronger monster or an unlisted monster', () => {
    const {engine,sent,step}=setup();engine.entities.delete(2);
    for (const entity of [{...monster,id:3,kind:0},{...monster,id:4,x:130},{...monster,id:5,level:30},{...monster,id:6,classId:4100,name:'Baphomet'}]) engine.receive([{type:'spawn',entity}]);
    engine.start(settings);step();expect(sent).toEqual([]);
  });
  it('skips targets already engaged by another character', () => {
    const {engine,sent,step}=setup();engine.receive([{type:'attack',source:99,target:2,position:{x:100,y:100}}]);
    engine.start(settings);step();expect(sent).toEqual([]);
  });
  it('stops immediately at the HP limit and does not double-count visual attacks', () => {
    const {engine,sent,step}=setup();engine.start(settings);step();
    engine.receive([{type:'attack',source:2,target:1,position:{x:102,y:100}}]);expect(engine.player!.hp).toBe(70);
    engine.receive([{type:'hit',id:1,damage:40,position:{x:100,y:100}}]);
    expect(engine.running).toBe(false);expect(engine.player!.hp).toBe(30);expect(sent.at(-1)).toEqual({type:'stop'});
  });
  it('counts server-confirmed kills and pickups', () => {
    const {engine,sent,step}=setup();engine.start(settings);step();
    engine.receive([{type:'remove',id:2,dead:true},{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}}]);
    expect(engine.kills).toBe(1);step();expect(sent.at(-1)).toEqual({type:'pickup',id:9});expect(engine.looted).toBe(0);
    engine.receive([{type:'pickup',id:9,picker:1}]);expect(engine.looted).toBe(1);
  });
  it('does not claim an out-of-sight removal as a kill', () => {
    const {engine,step}=setup();engine.start(settings);step();engine.receive([{type:'remove',id:2,dead:false}]);expect(engine.kills).toBe(0);
  });
  it('does not loot unrelated drops or count another player pickup', () => {
    const {engine,sent,step}=setup();engine.entities.delete(2);
    engine.receive([{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}}]);engine.start(settings);step();expect(sent).toEqual([]);
    engine.receive([{type:'pickup',id:9,picker:99}]);expect(engine.looted).toBe(0);
  });
  it('honors disabled looting', () => {
    const {engine,sent,step}=setup();engine.start({...settings,loot:false});step();
    engine.receive([{type:'remove',id:2,dead:true},{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}}]);step();expect(sent).toEqual([{type:'attack',id:2}]);
  });
  it('does not take pre-existing drops beside a new kill', () => {
    const {engine,sent,step}=setup();
    engine.receive([{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}}]);
    engine.start(settings);step();engine.receive([{type:'remove',id:2,dead:true}]);step();
    expect(sent).toEqual([{type:'attack',id:2}]);
  });
  it('does not take an old drop newly revealed after a kill', () => {
    const {engine,sent,step}=setup();engine.start(settings);step();
    engine.receive([{type:'remove',id:2,dead:true},{type:'drop',drop:{id:9,itemId:909,count:1,isNew:false,x:101,y:100}}]);step();
    expect(sent).toEqual([{type:'attack',id:2}]);
  });
  it('clears loot attribution between runs', () => {
    const {engine,sent,step}=setup();engine.start(settings);step();engine.receive([{type:'remove',id:2,dead:true}]);
    engine.stop();engine.start(settings);
    engine.receive([{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101,y:100}}]);step();
    expect(sent).toEqual([{type:'attack',id:2},{type:'stop'}]);
  });
  it('allows manual restart after in-place resurrection', () => {
    const {engine,step}=setup();engine.start(settings);step();engine.receive([{type:'death',id:1}]);
    engine.receive([{type:'resurrection',id:1,hp:70,position:{x:100,y:100}}]);
    expect(engine.running).toBe(false);expect(engine.player!.dead).toBe(false);
    expect(()=>engine.start(settings)).not.toThrow();
  });
  it('fails closed when a stop cannot be sent', () => {
    const engine=new BotEngine(()=>{throw new Error('Socket failed');},Date.now,()=>openGrid);
    engine.connect(true);engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}}]);
    engine.start(settings);expect(()=>engine.stop()).not.toThrow();
    expect(engine.connected).toBe(false);expect(engine.compatible).toBe(false);expect(engine.running).toBe(false);
  });
  it('requires a fresh start after map change or reconnect', () => {
    const {engine,sent,step}=setup();engine.start(settings);step();
    engine.receive([{type:'map',map:'prontera'}]);expect(engine.running).toBe(false);expect(engine.entities.size).toBe(0);expect(sent.at(-1)).toEqual({type:'stop'});
    engine.disconnect();engine.connect(true);step();expect(engine.running).toBe(false);
  });
  it('stops after sleep or stale server traffic', () => {
    const first=setup();first.engine.start(settings);first.step(6000);expect(first.engine.running).toBe(false);
    const second=setup();second.engine.start(settings);for(let i=0;i<16;i++)second.step();expect(second.engine.running).toBe(false);
  });
  it('times out unreachable targets without flooding requests', () => {
    const {engine,sent,step}=setup();engine.start(settings);step();
    for(let i=0;i<13;i++){engine.receive([]);step();}
    expect(sent).toEqual([{type:'attack',id:2},{type:'stop'}]);
    expect(engine.running).toBe(true);step();expect(sent.length).toBe(2);
  });
  it('invalidates automation on protocol failure and bounds the activity log', () => {
    const {engine,step}=setup();engine.start(settings);step();engine.fail('Layout changed');
    expect(engine.running).toBe(false);expect(engine.compatible).toBe(false);
    for(let i=0;i<100;i++)engine.note(String(i));expect(engine.log.length).toBe(50);
  });
});

describe('planned walking and map search', () => {
  function field(grid: WalkGrid = openGrid, origin = {x:100,y:100}) {
    let now=100_000;const sent:Action[]=[];
    const engine=new BotEngine(a=>sent.push(a),()=>now,()=>grid);
    engine.connect(true);engine.receive([{type:'enter',id:1,map:'prt_fild05'},{type:'spawn',entity:{...player,...origin}}]);
    const step=(ms=500)=>{now+=ms;engine.receive([]);engine.tick();};
    const start=(overrides:Partial<typeof DEFAULT_SETTINGS>={})=>engine.start({...settings,map:'prt_fild05',...overrides});
    const accept=(secondsPerCell=.1,locked=false)=>{
      const cells=engine.snapshot().navigation!.leg;
      if(cells.length<2)throw new Error('No leg');
      const first=cells[0]!;
      engine.receive([{type:'walk',id:1,walk:{origin:{x:first.x+.5,y:first.y+.5},cells,secondsPerCell,firstSeconds:secondsPerCell,locked}}]);
    };
    return {engine,sent,step,start,accept};
  }
  function route(cells: Position[], locked=false): GameEvent {
    return {type:'walk',id:1,walk:{origin:{x:cells[0]!.x+.5,y:cells[0]!.y+.5},cells,secondsPerCell:.2,firstSeconds:.2,locked}};
  }
  it('requires a verified collision map even when random walking is off', () => {
    const e=new BotEngine(()=>{});e.connect(true);e.receive([{type:'enter',id:1,map:'unsupported_map'},{type:'spawn',entity:{...player}}]);
    expect(()=>e.start({...settings,map:'unsupported_map'})).toThrow('Verified walkability is not available');expect(e.snapshot().navigation).toBeNull();
  });
  it('shows the complete collision analysis before Start', () => {
    const f=field(searchGrid('prt_fild05')!,{x:367,y:230});
    expect(f.engine.snapshot().navigation).toMatchObject({ready:true,blocked:77807,walkable:82193,excluded:479,reachable:81710,mode:'idle'});
    expect(f.engine.running).toBe(false);
  });
  it('rejects invalid route settings', () => {
    for(const change of [{route_randomWalk:1},{route_step:21},{route_step:0},{route_avoidWalls:1},{attackRouteMaxPathDistance:0},{attackMaxRouteTime:0},{route_randomWalk_maxRouteTime:601}])
      expect(()=>validateSettings({...settings,...change} as typeof settings)).toThrow();
  });
  it('walks around a wall to an adjacent melee tile before sending Attack', () => {
    const grid:WalkGrid={...openGrid,walkable:p=>!(p.x===102&&p.y>=98&&p.y<=102)};
    const f=field(grid);f.engine.receive([{type:'spawn',entity:{...monster,x:104,y:100}}]);f.start({attackMaxRouteTime:30});f.step();
    expect(f.sent[0]?.type).toBe('walk');
    const path=f.engine.snapshot().navigation!.route;expect(path.some(p=>p.y<98||p.y>102)).toBe(true);
    for(let i=0;i<30&&!f.sent.some(a=>a.type==='attack');i++){if(f.sent.at(-1)?.type==='walk'&&f.engine.snapshot().navigation!.leg.length)f.accept();f.step(1000);}
    expect(f.sent.at(-1)).toEqual({type:'attack',id:2});expect(f.engine.running).toBe(true);
  });
  it('keeps a selected target through a wall detour beyond the acquisition radius', () => {
    const f=field({...openGrid,walkable:p=>!(p.x===102&&p.y>=95&&p.y<=105)});
    f.engine.receive([{type:'spawn',entity:{...monster,x:104}}]);f.start({radius:4,attackRouteMaxPathDistance:60,attackMaxRouteTime:30});f.step();
    for(let i=0;i<25&&!f.sent.some(a=>a.type==='attack');i++){f.accept(.01);f.step(500);}
    expect(f.sent.at(-1)).toEqual({type:'attack',id:2});expect(f.sent.some(a=>a.type==='stop')).toBe(false);
  });
  it('skips a closer disconnected target and approaches a reachable target', () => {
    const f=field({...openGrid,walkable:p=>p.x!==102});
    f.engine.receive([{type:'spawn',entity:{...monster,x:103}},{type:'spawn',entity:{...monster,id:3,x:100,y:104}}]);
    f.start();f.step();expect(f.engine.snapshot().target).toBe('Poring');expect(f.engine.snapshot().navigation!.goal).toEqual({x:100,y:104});
    for(let i=0;i<5&&f.sent.at(-1)?.type!=='attack';i++){f.accept();f.step(500);}
    expect(f.sent.at(-1)).toEqual({type:'attack',id:3});
  });
  it('attacks same-cell and unobstructed diagonal targets without walking', () => {
    for(const position of [{x:100,y:100},{x:101,y:101}]){const f=field();f.engine.receive([{type:'spawn',entity:{...monster,...position}}]);f.start();f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);}
  });
  it('uses straight capped legs and waits for the accepted timing before another request', () => {
    const f=field({...openGrid,walkable:p=>!(p.x===104&&p.y>=99&&p.y<=102)});f.engine.receive([{type:'spawn',entity:{...monster,x:110}}]);f.start({route_step:3,attackMaxRouteTime:20});f.step();
    expect(f.engine.player).toMatchObject({x:100,y:100});expect(f.engine.snapshot().navigation!.leg.length).toBeLessThanOrEqual(4);
    f.step();expect(f.sent).toHaveLength(1);f.accept(1);f.step();expect(f.sent).toHaveLength(1);
    for(let i=0;i<7;i++)f.step();expect(f.sent.length).toBeGreaterThan(1);
  });
  it('searches beyond the scan radius within the same connected area', () => {
    const f=field(searchGrid('prt_fild05')!,{x:367,y:230});f.start({route_randomWalk:2,radius:1});f.step();
    expect(f.sent[0]?.type).toBe('walk');const n=f.engine.snapshot().navigation!;
    expect(n.routeLength).toBeGreaterThan(2);expect(n.leg.length).toBeLessThanOrEqual(11);
    expect(new GridNavigator(searchGrid('prt_fild05')!).validRoute(n.route)).toBe(true);
    f.step();expect(f.sent).toHaveLength(1);f.accept();for(let i=0;i<6;i++)f.step();expect(f.engine.running).toBe(true);
  });
  it('switches search to combat after its outstanding leg, with no stale Stop', () => {
    const f=field();f.start({route_randomWalk:2,attackMaxRouteTime:30});f.step();
    const end=f.engine.snapshot().navigation!.leg.at(-1)!;
    f.engine.receive([{type:'spawn',entity:{...monster,...end}}]);f.step();expect(f.sent).toHaveLength(1);
    f.accept();for(let i=0;i<8;i++)f.step();
    expect(f.sent.at(-1)).toEqual({type:'attack',id:2});expect(f.sent.some(a=>a.type==='stop')).toBe(false);
  });
  function searchingWalk() {
    const f=field();
    const random=vi.spyOn(Math,'random').mockReturnValue(.6);
    try { f.start({route_randomWalk:2,radius:20}); f.step(); }
    finally { random.mockRestore(); }
    const cells=f.engine.snapshot().navigation!.leg;
    expect(cells).toHaveLength(11);
    f.accept(.4);
    return {...f,end:cells.at(-1)!};
  }
  it('does not spend the default attack budget finishing an inherited search walk', () => {
    const f=searchingWalk();f.engine.receive([{type:'spawn',entity:{...monster,...f.end}}]);f.step();
    expect(f.engine.snapshot().target).toBe('Poring');
    for(let i=0;i<13&&!f.sent.some(a=>a.type==='attack');i++)f.step();
    expect(f.sent.map(a=>a.type)).toEqual(['walk','attack']);
    expect(f.sent.at(-1)).toEqual({type:'attack',id:2});
  });
  it('shows the selected target while waiting for the inherited walk', () => {
    const f=searchingWalk();f.engine.receive([{type:'spawn',entity:{...monster,...f.end}}]);f.step();
    expect(f.engine.reason).toContain('Poring');
    expect(f.engine.reason).toContain('finishing');
    expect(f.engine.reason).not.toContain('Searching');
  });
  it('starts direct approach timing only after the inherited leg and retains it across target movement', () => {
    const f=searchingWalk();const target={...monster,x:f.end.x+5,y:f.end.y};
    f.engine.receive([{type:'spawn',entity:target}]);f.step();
    for(let i=0;i<14&&f.sent.length===1;i++)f.step();
    expect(f.sent.map(a=>a.type)).toEqual(['walk','attack']);
    const cells=Array.from({length:5},(_,i)=>({x:f.end.x+i,y:f.end.y}));
    f.engine.receive([{type:'walk',id:1,walk:{origin:{x:f.end.x+.5,y:f.end.y+.5},cells,secondsPerCell:2,firstSeconds:2,locked:false}}]);for(let i=0;i<4;i++)f.step();
    expect(f.sent.some(a=>a.type==='stop')).toBe(false);
    f.engine.receive([{type:'position',id:2,position:{x:target.x,y:target.y+1}}]);
    for(let i=0;i<4;i++)f.step();
    expect(f.sent.at(-1)).toEqual({type:'stop'});
    expect(f.engine.reason).toContain('timed out');
    expect(f.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('keeps an inherited locked walk bounded before the pursuit timer starts', () => {
    const f=searchingWalk();f.engine.receive([{type:'spawn',entity:{...monster,...f.end}}]);f.step();f.accept(.4,true);
    for(let i=0;i<10;i++)f.step();
    expect(f.sent.some(a=>a.type==='stop')).toBe(true);
    expect(f.engine.log.some(e=>e.text.includes('Walk did not complete'))).toBe(true);
  });
  it('collects fractional own drops using their grid cell after a kill', () => {
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster}}]);f.start();f.step();
    f.engine.receive([{type:'remove',id:2,dead:true},{type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:101.5,y:100.5}}]);f.step(1000);
    expect(f.sent.at(-1)).toEqual({type:'pickup',id:9});
  });
  it('replans a moved target and cancels pursuit when it disappears', () => {
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:108}}]);f.start({attackMaxRouteTime:20});f.step();
    f.engine.receive([{type:'position',id:2,position:{x:108,y:103}}]);f.step();expect(f.engine.snapshot().navigation!.goal).toEqual({x:108,y:103});
    f.engine.receive([{type:'remove',id:2,dead:false}]);expect(f.sent.at(-1)).toEqual({type:'stop'});expect(f.engine.kills).toBe(0);
  });
  it('drops old leg timers on position corrections and stopping hits', () => {
    for(const correction of [{type:'position',id:1,position:{x:100,y:101}},{type:'hit',id:1,damage:1,position:{x:100,y:101},stops:true},{type:'stop',id:1}] as GameEvent[]){
      const f=field({...openGrid,walkable:p=>!(p.x===104&&p.y>=99&&p.y<=102)});f.engine.receive([{type:'spawn',entity:{...monster,x:108}}]);f.start({attackMaxRouteTime:20});f.step();f.accept(1);
      f.engine.receive([correction]);f.step();expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(2);
      expect(f.engine.snapshot().navigation!.leg[0]).toMatchObject({x:100,y:correction.type==='stop'?100:101});
    }
  });
  it('follows a delayed shortened route without blaming the replacement destination', () => {
    const f=field({...openGrid,walkable:p=>!(p.x===104&&p.y>=99&&p.y<=102)});f.engine.receive([{type:'spawn',entity:{...monster,x:108}}]);f.start({attackMaxRouteTime:20});f.step();f.accept(1);
    f.engine.receive([{type:'stop',id:1}]);f.step();
    f.engine.receive([route([{x:100,y:100},{x:100,y:101}])]);
    expect(f.engine.snapshot().navigation!.leg.at(-1)).toEqual({x:100,y:101});
    expect(f.sent.some(a=>a.type==='stop')).toBe(false);
    f.step();expect(f.engine.player).toMatchObject({x:100,y:101});expect(f.engine.running).toBe(true);
    expect(f.engine.snapshot().navigation!.goal).toEqual({x:108,y:100});
  });
  it('recovers when a late no-ack route arrives on its temporarily excluded endpoint', () => {
    const f=field();f.start({route_randomWalk:2});f.step();
    const oldCells=f.engine.snapshot().navigation!.leg;
    for(let i=0;i<10;i++)f.step();
    expect(f.sent.some(a=>a.type==='stop')).toBe(true);
    f.engine.receive([route(oldCells)]);
    for(let i=0;i<6;i++)f.step();
    expect(f.engine.running).toBe(true);expect(f.engine.snapshot().navigation!.blocked).toBe(0);
  });
  it('bounds no-ack and locked-route recovery without marking physical walls', () => {
    for(const locked of [false,true]){const f=field();f.start({route_randomWalk:2});f.step();if(locked)f.accept(.1,true);
      for(let i=0;i<40&&f.engine.running;i++)f.step();
      expect(f.engine.running).toBe(false);expect(f.engine.reason).toContain('three failed');expect(f.sent.filter(a=>a.type==='walk')).toHaveLength(3);
      expect(f.engine.snapshot().navigation!.blocked).toBe(0);
    }
  });
  it('applies approach time limits to slow movement and later server pursuit', () => {
    const f=field({...openGrid,walkable:p=>!(p.x===104&&p.y>=99&&p.y<=102)});f.engine.receive([{type:'spawn',entity:{...monster,x:108}}]);f.start();f.step();f.accept(1);
    for(let i=0;i<8;i++)f.step();expect(f.sent.at(-1)).toEqual({type:'stop'});expect(f.engine.reason).toContain('time limit');
    const g=field();g.engine.receive([{type:'spawn',entity:{...monster}}]);g.start();g.step();
    g.engine.receive([route([{x:100,y:100},{x:101,y:100}])]);for(let i=0;i<8;i++)g.step();
    expect(g.sent.at(-1)).toEqual({type:'stop'});expect(g.engine.reason).toContain('timed out');
  });
  it('validates every accepted walk against walls and portal policy, including during attack', () => {
    const f=field({...openGrid,walkable:p=>p.x!==102});f.engine.receive([{type:'spawn',entity:{...monster}}]);f.start();f.step();
    f.engine.receive([route([{x:100,y:100},{x:101,y:100},{x:102,y:100}])]);expect(f.engine.running).toBe(false);expect(f.sent.at(-1)).toEqual({type:'stop'});
    const g=field(searchGrid('prt_fild05')!,{x:367,y:230});g.start();g.engine.receive([route([{x:373,y:205}])]);expect(g.engine.reason).toContain('portal');
  });
  it('does not resume after manual stop, minimap updates or map changes', () => {
    const f=field();f.start({route_randomWalk:2});f.step();const pos={x:f.engine.player!.x,y:f.engine.player!.y};
    f.engine.receive([{type:'tracking',id:1,position:{x:10,y:20}}]);expect(f.engine.player).toMatchObject(pos);
    f.engine.stop();f.step();expect(f.sent).toHaveLength(2);f.engine.receive([{type:'map',map:'prontera'}]);f.step();expect(f.engine.running).toBe(false);
  });
});

describe('verified map transitions', () => {
  it('discards the old route and enables fresh Field 8 routing only after the character arrives and Start is pressed', () => {
    let now=100_000; const sent:Action[]=[];
    const engine=new BotEngine(action=>sent.push(action),()=>now);
    engine.connect(true);
    engine.receive([{type:'enter',id:1,map:'prt_fild05'},{type:'spawn',entity:{...player,x:367,y:230}}]);
    engine.start({...settings,map:'prt_fild05',route_randomWalk:2});
    now+=500;engine.tick();
    expect(sent.at(-1)?.type).toBe('walk');
    engine.receive([{type:'map',map:'prt_fild08'}]);
    expect(engine.running).toBe(false);
    expect(engine.player).toBeUndefined();
    expect(engine.snapshot().navigation).toMatchObject({ready:false,blocked:70001,route:[],leg:[]});
    engine.receive([{type:'spawn',entity:{...player,x:152,y:354}}]);
    expect(engine.snapshot().navigation).toMatchObject({ready:true,walkable:89999,blocked:70001,mode:'idle',route:[],leg:[]});
    const count=sent.length;now+=500;engine.tick();expect(sent).toHaveLength(count);
    expect(()=>engine.start({...settings,map:'prt_fild05'})).toThrow('Map changed');
    engine.receive([{type:'spawn',entity:{...monster,id:3,x:153,y:354}}]);
    engine.start(settings);now+=500;engine.tick();
    expect(sent.at(-1)).toEqual({type:'attack',id:3});
    engine.stop();engine.entities.delete(3);
    engine.start({...settings,route_randomWalk:2});now+=500;engine.tick();
    expect(sent.at(-1)?.type).toBe('walk');
    expect(new GridNavigator(searchGrid('prt_fild08')!).validRoute(engine.snapshot().navigation!.route)).toBe(true);
    engine.receive([{type:'map',map:'unsupported_map'},{type:'spawn',entity:{...player}}]);
    expect(engine.snapshot().navigation).toBeNull();
    expect(()=>engine.start({...settings,map:'unsupported_map'})).toThrow('Verified walkability is not available');
  });
});

describe('direct monster targeting on a verified clear corridor', () => {
  function field(grid: WalkGrid = openGrid) {
    let now=100_000; const sent:Action[]=[];
    const engine=new BotEngine(action=>sent.push(action),()=>now,()=>grid);
    engine.connect(true);
    engine.receive([{type:'enter',id:1,map:'prt_fild08'},{type:'spawn',entity:{...player}}]);
    const step=(ms=100)=>{now+=ms;engine.receive([]);engine.tick();};
    const start=(overrides:Partial<typeof DEFAULT_SETTINGS>={})=>engine.start({...settings,...overrides});
    const accepted=(cells:Position[],secondsPerCell=.1):GameEvent=>({type:'walk',id:1,
      walk:{origin:{x:cells[0]!.x+.5,y:cells[0]!.y+.5},cells,secondsPerCell,firstSeconds:secondsPerCell,locked:false}});
    return {engine,sent,step,start,accepted};
  }
  it('clicks a distant clear monster once, follows the server walk, and credits confirmed combat and loot',()=>{
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start();f.step();
    expect(f.sent).toEqual([{type:'attack',id:2}]);
    expect(f.engine.player).toMatchObject({x:100,y:100});
    const cells=Array.from({length:6},(_,i)=>({x:100+i,y:100}));
    f.engine.receive([f.accepted(cells)]);
    f.step(700);
    expect(f.engine.player).toMatchObject({x:105,y:100});
    expect(f.sent).toHaveLength(1);
    f.engine.receive([{type:'attack',source:1,target:2,position:{x:105,y:100}},{type:'death',id:2},
      {type:'drop',drop:{id:9,itemId:909,count:1,isNew:true,x:106,y:100}}]);
    expect(f.engine.kills).toBe(1);f.step(200);
    expect(f.sent.at(-1)).toEqual({type:'pickup',id:9});
    f.engine.receive([{type:'pickup',picker:1,id:9}]);expect(f.engine.looted).toBe(1);
    expect(f.sent.some(action=>action.type==='walk')).toBe(false);
  });
  it('keeps collision routing when a wall, diagonal corner or portal obstructs the straight corridor',()=>{
    const cases:Array<{grid:WalkGrid;target:Position}>=[
      {grid:{...openGrid,walkable:p=>!(p.x===102&&p.y===100)},target:{x:104,y:100}},
      {grid:{...openGrid,walkable:p=>!(p.x===101&&p.y===100)},target:{x:104,y:104}},
      {grid:{...openGrid,portals:[{x:102,y:100,halfWidth:0,halfHeight:0}]},target:{x:104,y:100}},
    ];
    for(const {grid,target} of cases){
      const f=field(grid);f.engine.receive([{type:'spawn',entity:{...monster,...target}}]);f.start({attackMaxRouteTime:30});f.step();
      expect(f.sent[0]?.type).toBe('walk');expect(f.sent.some(action=>action.type==='attack')).toBe(false);
      expect(new GridNavigator(grid).validRoute(f.engine.snapshot().navigation!.route)).toBe(true);
    }
  });
  it('rejects a monster in a portal or beyond the path limit without sending a direct click',()=>{
    const portal=field({...openGrid,portals:[{x:104,y:100,halfWidth:0,halfHeight:0}]});
    portal.engine.receive([{type:'spawn',entity:{...monster,x:104}}]);portal.start();portal.step();expect(portal.sent).toEqual([]);
    const capped=field();capped.engine.receive([{type:'spawn',entity:{...monster,x:108}}]);capped.start({attackRouteMaxPathDistance:3});capped.step();expect(capped.sent).toEqual([]);
  });
  it('waits for an inherited unacknowledged leg and its authoritative finish before clicking',()=>{
    const f=field();const random=vi.spyOn(Math,'random').mockReturnValue(.6);
    try{f.start({route_randomWalk:2});f.step();}finally{random.mockRestore();}
    const cells=f.engine.snapshot().navigation!.leg;
    const end=cells.at(-1)!;const target={x:end.x+2,y:end.y};
    f.engine.receive([{type:'spawn',entity:{...monster,...target}}]);f.step(1000);
    expect(f.sent).toHaveLength(1);expect(f.sent[0]?.type).toBe('walk');
    f.engine.receive([f.accepted(cells)]);f.step(1600);
    expect(f.sent.map(action=>action.type)).toEqual(['walk','attack']);
    expect(f.sent.at(-1)).toEqual({type:'attack',id:2});
  });
  it('does not repeat a clear direct click when the monster moves along open ground',()=>{
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start();f.step();
    f.engine.receive([{type:'position',id:2,position:{x:108,y:102}}]);f.step();
    expect(f.sent).toEqual([{type:'attack',id:2}]);expect(f.engine.snapshot().navigation?.goal).toEqual({x:108,y:102});
  });
  it('fences an unacknowledged direct chase before routing to a monster that moved behind an obstacle',()=>{
    const f=field({...openGrid,walkable:p=>!(p.x===103&&p.y===102)});
    f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start({attackMaxRouteTime:30});f.step();
    expect(f.sent).toEqual([{type:'attack',id:2}]);
    f.engine.receive([{type:'position',id:2,position:{x:106,y:104}}]);f.step();
    expect(f.sent.map(action=>action.type)).toEqual(['attack','stop']);
    f.step();expect(f.sent).toHaveLength(2);
    const oldCells=[{x:100,y:100},{x:101,y:100},{x:102,y:100}];
    f.engine.receive([f.accepted(oldCells)]);f.step(100);
    expect(f.sent).toHaveLength(2);f.step(200);
    expect(f.engine.player).toMatchObject({x:102,y:100});
    expect(f.sent.at(-1)?.type).toBe('walk');
    expect(f.engine.running).toBe(true);
  });
  it('waits through a late shortened chase after the target disappears before selecting another target',()=>{
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start();f.step();
    f.engine.receive([{type:'remove',id:2,dead:false},{type:'spawn',entity:{...monster,id:3,x:100,y:106}}]);
    f.step();expect(f.sent.map(action=>action.type)).toEqual(['attack','stop']);
    f.engine.receive([f.accepted([{x:100,y:100},{x:101,y:100},{x:102,y:100}],1)]);
    f.step(1000);expect(f.sent).toHaveLength(2);
    f.step(1100);expect(f.engine.player).toMatchObject({x:102,y:100});
    expect(f.sent.at(-1)).toEqual({type:'attack',id:3});
  });
  it.each(['rest','item','skill'] as const)('waits through late chase movement before %s preemption',policy=>{
    const f=field(),automation=structuredClone(DEFAULT_AUTOMATION);
    f.engine.receive([{type:'heal',id:1,hp:70,maxHp:100},{type:'sp',sp:20,maxSp:20},
      {type:'skills',learned:[{skillId:1,level:2},{skillId:2,level:1}]},
      {type:'inventory',items:[{bagId:501,itemId:501,count:4,type:1}],equipment:[],ammoId:-1},
      {type:'spawn',entity:{...monster,x:106}}]);
    if(policy==='rest'){automation.recovery.enabled=true;automation.recovery.spStart=0;}
    if(policy==='item')automation.items=[{itemId:501,resource:'hp',belowPercent:60,minStock:1,cooldownSeconds:10}];
    if(policy==='skill')automation.skills=[{skillId:2,level:1,target:'self',hpBelowPercent:60,spAbovePercent:0,cooldownSeconds:10}];
    f.start({automation});f.step();expect(f.sent).toEqual([{type:'attack',id:2}]);
    f.engine.receive([{type:'heal',id:1,hp:55,maxHp:100}]);f.step();f.step();
    expect(f.sent.map(action=>action.type)).toEqual(['attack','stop']);
    f.engine.receive([f.accepted([{x:100,y:100},{x:101,y:100},{x:102,y:100}],1)]);
    f.step(1000);expect(f.sent).toHaveLength(2);
    f.step(1100);expect(f.engine.player).toMatchObject({x:102,y:100});
    expect(f.sent.at(-1)).toEqual(policy==='rest'?{type:'sit',sitting:true}:policy==='item'
      ?{type:'useItem',itemId:501}:{type:'skill',mode:'self',skillId:2,level:1});
  });
  it('keeps manual actions and restart fenced after Stop until the late accepted walk finishes',()=>{
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start();f.step();f.engine.stop();
    expect(f.engine.idleForActions()).toBe(false);
    expect(()=>f.engine.manualAction({type:'sit',sitting:false})).toThrow('wait');
    expect(()=>f.start()).toThrow('Wait');
    f.engine.receive([{type:'attack',source:1,target:99,position:{x:100,y:100}},
      {type:'position',id:1,position:{x:100,y:100}},
      {type:'walk',id:1,walk:{origin:{x:100.5,y:100.5},
        cells:[{x:100,y:100},{x:101,y:100}],secondsPerCell:1,firstSeconds:1,locked:true}}]);
    expect(f.engine.idleForActions()).toBe(false);
    f.engine.receive([f.accepted([{x:100,y:100},{x:101,y:100},{x:102,y:100}],1)]);
    expect(f.engine.idleForActions()).toBe(false);f.step(1000);expect(f.engine.idleForActions()).toBe(false);
    f.step(1100);expect(f.engine.idleForActions()).toBe(true);
    f.engine.manualAction({type:'sit',sitting:false});
    expect(f.sent).toEqual([{type:'attack',id:2},{type:'stop'},{type:'sit',sitting:false}]);
  });
  it.each(['attack','stop'] as const)('releases the canceled implicit walk on a matching own %s response',response=>{
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start();f.step();f.engine.stop();
    f.engine.receive([response==='attack'?{type:'attack',source:1,target:2,position:{x:100,y:100}}:{type:'stop',id:1}]);
    expect(f.engine.idleForActions()).toBe(true);
  });
  it('retains the unresolved walk after an early approach timeout before changing targets',()=>{
    const f=field();f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start({attackMaxRouteTime:1});f.step();
    f.step(1000);expect(f.sent.map(action=>action.type)).toEqual(['attack','stop']);
    f.engine.receive([{type:'spawn',entity:{...monster,id:3,x:100,y:106}}]);f.step();
    expect(f.sent).toHaveLength(2);
    f.engine.receive([f.accepted([{x:100,y:100},{x:101,y:100},{x:102,y:100}],1)]);
    f.step(1000);expect(f.sent).toHaveLength(2);f.step(1100);
    expect(f.sent.at(-1)).toEqual({type:'attack',id:3});
  });
  it('preserves the first request approach budget through repeated clear and obstructed target changes',()=>{
    const f=field({...openGrid,walkable:p=>!(p.x===103&&p.y===102)});
    f.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);f.start();f.step();
    for(let i=0;i<6;i++){
      f.engine.receive([{type:'position',id:2,position:{x:106,y:104}}]);f.step(500);
      f.engine.receive([{type:'stop',id:1},{type:'position',id:2,position:{x:106,y:100}}]);f.step(500);
    }
    expect(f.sent.filter(action=>action.type==='attack')).toHaveLength(4);
    expect(f.sent.at(-1)).toEqual({type:'stop'});
    expect(f.engine.running).toBe(true);
    expect(f.engine.log.find(entry=>entry.text.includes('Approach time limit (4s)'))?.at).toBe(104_100);
    const count=f.sent.length;f.step(1000);expect(f.sent).toHaveLength(count);
  });
  it('stops an invalid authoritative direct-chase path and bounds a valid slow chase',()=>{
    const invalid=field({...openGrid,walkable:p=>!(p.x===102&&p.y===101)});
    invalid.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);invalid.start();invalid.step();
    invalid.engine.receive([invalid.accepted([{x:100,y:100},{x:101,y:101},{x:102,y:101}])]);
    expect(invalid.engine.running).toBe(false);expect(invalid.sent.at(-1)).toEqual({type:'stop'});
    const slow=field();slow.engine.receive([{type:'spawn',entity:{...monster,x:106}}]);slow.start();slow.step();
    slow.engine.receive([slow.accepted(Array.from({length:6},(_,i)=>({x:100+i,y:100})),1)]);
    for(let i=0;i<4;i++)slow.step(1000);
    expect(slow.sent.map(action=>action.type)).toEqual(['attack','stop']);
    expect(slow.engine.reason).toContain('timed out');
  });
});

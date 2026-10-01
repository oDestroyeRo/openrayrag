import { describe, expect, it } from 'vitest';
import { BitWriter } from './binary';
import { CompanionController } from './controller';
import type { Action } from './engine';
import { escapeAction } from './escape';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_SETTINGS, type Settings } from './settings';
import { OP, decode, type Entity } from './protocol';
import { FEATURE_OP, featureCommand, validateExpandedAction } from './protocol-feature';
import type { WorldAction } from './world-protocol';
import { PersistentFieldRun } from './reconnect';

const player: Entity = { id: 1, name: 'Test', classId: 1, kind: 0, level: 7, x: 100, y: 100, hp: 100, maxHp: 100, dead: false };
function spawn(entity = player, entryType = 0): Uint8Array {
  const name = new TextEncoder().encode(entity.name);
  const body = new BitWriter().u8(15).i32(entity.id).i32(entity.classId).i32(0).i32(~name.length).i32(entity.name.length).take(name)
    .u8(entity.kind).u8(0).u8(entity.dead ? 3 : 0).i32(entity.x).i32(entity.y).u8(entity.level)
    .i32(entity.hp).i32(entity.maxHp).i32(100).i32(100).i32(-1).u8(1).finish();
  return new BitWriter().u8(OP.spawn).u8(entryType).i32(body.length).take(body).finish();
}
function stats(hp = 100, items: Array<[number, number]> = [[601, 5], [602, 5]], skills: number[] = [53, 54], sp = 100): Uint8Array {
  const data = [7, 1, 1000, 1, 1, 1, 1, 1, 1, 0, 0, 0];
  const combat = [hp, 100, sp, 100, ...Array(16).fill(0), 1000];
  const w = new BitWriter().u8(FEATURE_OP.stats);
  for (const value of [...data, ...combat]) w.i32(value);
  w.f32(0.4).i32(20).i32(0).bool(true).i16(skills.length);
  for (const skill of skills) w.i16(skill).u8(1);
  w.i16(0).bool(true).u8(1).i32(items.length);
  for (const [id, count] of items) w.i32(id).i16(count);
  w.i32(0).u8(0); for (let i = 0; i < 10; i++) w.i32(0);
  return w.i32(-1).finish();
}
const heal = (hp: number) => new BitWriter().u8(OP.heal).i32(1).i32(0).i32(hp).i32(100).finish();
const delta = (id = 601) => new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(id).i16(1).i32(20).bool(false).finish();
function settings(overrides: Partial<NonNullable<typeof DEFAULT_AUTOMATION.escape>> = {}): Settings {
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.escape = { ...DEFAULT_ESCAPE, enabled: true, ...overrides };
  return { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], automation };
}
function setup(input: Settings = settings(), hp = 100, resources = true) {
  let time = 100_000; const sent: Array<Action | WorldAction> = [];
  const controller = new CompanionController(action => sent.push(action), () => time, map => map === 'unknown' ? null
    : { width: 200, height: 200, walkable: () => true });
  controller.connect(true);
  const packet = (data: Uint8Array) => controller.receive(data);
  packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish()); packet(spawn({ ...player, hp }));
  if (resources) packet(stats(hp));
  packet(spawn({ ...player, id: 2, name: 'Poring', classId: 4000, kind: 1, x: 101, hp: 10, maxHp: 10 }));
  const step = (ms = 100) => { time += ms; controller.tick(); };
  const advance = (ms: number) => { while (ms > 0) { const part = Math.min(ms, 100); step(part); ms -= part; } };
  const start = () => controller.start(input);
  const danger = () => { packet(heal(20)); advance(250); };
  const actions = () => sent.filter(action => action.type === 'useItem' || action.type === 'skill');
  const arrival = (hp = 20) => { packet(Uint8Array.of(OP.clear)); packet(spawn({ ...player, hp }, 2)); };
  return { controller, sent, packet, step, advance, start, danger, actions, arrival, time: () => time };
}

describe('ordinary player escape contracts', () => {
  it('encodes only supported wings and self Teleport/Return at level one', () => {
    expect([...featureCommand(escapeAction({ ...DEFAULT_ESCAPE, mode: 'random' }))]).toEqual([47, 89, 2, 0, 0, 255, 255, 255, 255]);
    expect([...featureCommand(escapeAction({ ...DEFAULT_ESCAPE, mode: 'save' }))]).toEqual([47, 90, 2, 0, 0, 255, 255, 255, 255]);
    expect([...featureCommand(escapeAction({ ...DEFAULT_ESCAPE, method: 'skill' }))]).toEqual([29, 5, 53, 0, 1]);
    expect([...featureCommand(escapeAction({ ...DEFAULT_ESCAPE, method: 'skill', mode: 'save' }))]).toEqual([29, 5, 54, 0, 1]);
    expect(() => validateExpandedAction({ type: 'randomTeleport' })).toThrow();
  });
  it('retains Warp and EnterServer entry codes in real MemoryPack packets', () => {
    expect(decode(spawn(player, 2))[0]).toMatchObject({ type: 'spawn', entryType: 2, entity: player });
    expect(decode(spawn(player, 1))[0]).toMatchObject({ type: 'spawn', entryType: 1 });
  });
});

describe('exclusive emergency escape owner', () => {
  it('keeps default and disabled runs on their existing HP wait path', () => {
    const input = settings({ enabled: false }); const f = setup(input); f.start(); f.danger();
    expect(f.actions()).toEqual([]); expect(f.controller.snapshot()).toMatchObject({ runRequested: true, state: 'waiting' });
  });
  it('preempts combat above the HP floor and lets Stop settle before sending once', () => {
    const f = setup(settings({ hpBelowPercent: 70 })); f.start(); f.step();
    expect(f.sent.at(-1)?.type).toBe('attack'); f.packet(heal(60));
    expect(f.sent.at(-1)?.type).toBe('stop'); f.advance(249); expect(f.actions()).toHaveLength(0);
    f.step(1); expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
    const count = f.sent.length; f.advance(1000); expect(f.sent).toHaveLength(count);
    expect(f.controller.engine.running).toBe(false);
  });
  it('is reachable when Start initially waits below the ordinary HP floor', () => {
    const f = setup(settings(), 20); f.start(); f.advance(250);
    expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
    expect(f.controller.runRequested).toBe(true);
  });
  it.each(['unknown inventory', 'reserve', 'missing wing', 'unknown skill', 'unlearned skill', 'insufficient SP', 'dead', 'NPC', 'unknown map'])('waits without sending when %s blocks escape', gate => {
    const input = settings(gate.includes('skill') || gate === 'insufficient SP' ? { method: 'skill' } : {});
    const f = setup(input); f.start();
    if (gate === 'unknown inventory') f.controller.engine.character.inventoryKnown = false;
    if (gate === 'reserve') input.automation!.escape!.minStock = 5; // restart with the actual guarded policy
    if (gate === 'missing wing') f.controller.engine.character.inventory.clear();
    if (gate === 'unknown skill') f.controller.engine.character.skillsKnown = false;
    if (gate === 'unlearned skill') f.controller.engine.character.learned.clear();
    if (gate === 'insufficient SP') f.controller.engine.character.stats!.sp = 29;
    if (gate === 'dead') f.packet(new BitWriter().u8(OP.death).i32(1).finish());
    if (gate === 'NPC') f.controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    if (gate === 'unknown map') { f.packet(new BitWriter().u8(OP.map).string('unknown').finish()); f.packet(spawn({ ...player, hp: 20 })); }
    if (gate === 'reserve') { f.controller.stop(); f.controller.start(input); }
    if (gate !== 'dead') f.danger(); else f.advance(500);
    expect(f.actions()).toHaveLength(0);
  });
  it('never overwrites an uncertain consumable owner', () => {
    const input = settings(); input.automation!.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 1 }];
    const f = setup(input); f.packet(stats(100, [[501, 4], [601, 5]])); f.start(); f.step();
    expect(f.actions()).toEqual([{ type: 'useItem', itemId: 501 }]); f.danger(); f.advance(10_000);
    expect(f.actions()).toEqual([{ type: 'useItem', itemId: 501 }]);
  });
  it('uses learned Teleport or Return with their separate verified SP costs', () => {
    for (const [mode, id, sp] of [['random', 53, 30], ['save', 54, 10]] as const) {
      const f = setup(settings({ mode, method: 'skill' })); f.packet(stats(100, [], [id], sp)); f.start(); f.danger();
      expect(f.actions()).toEqual([{ type: 'skill', mode: 'self', skillId: id, level: 1 }]);
    }
  });
  it('does not equate item cost, SP, animation, movement or unrelated spawns with arrival', () => {
    const f = setup(); f.start(); f.danger(); f.packet(delta());
    f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(70).i32(100).finish());
    f.packet(new BitWriter().u8(OP.move).i32(1).position({ x: 120, y: 100 }).finish());
    f.packet(spawn({ ...player, id: 3 }, 2));
    expect(f.controller.snapshot().escape).toMatchObject({ pending: true, consumed: true, state: 'sent' });
    expect(f.actions()).toHaveLength(1);
  });
  it('requires same-map clear then matching alive Warp spawn, including the same tile', () => {
    const f = setup(); f.start(); f.danger(); f.packet(spawn({ ...player, hp: 20 }, 2));
    expect(f.controller.escape.busy).toBe(true); f.packet(Uint8Array.of(OP.clear));
    for (const entity of [{ ...player, id: 3 }, { ...player, name: 'Other' }, { ...player, dead: true, hp: 0 }]) f.packet(spawn(entity, 2));
    f.packet(spawn({ ...player, hp: 20 }, 0)); expect(f.controller.escape.busy).toBe(true);
    f.packet(spawn({ ...player, hp: 20 }, 2));
    expect(f.controller.snapshot()).toMatchObject({ runRequested: true, state: 'waiting', escape: { state: 'confirmed', pending: false, latched: true } });
    expect(f.controller.engine.player).toMatchObject({ x: 100, y: 100, hp: 20 });
  });
  it('confirms cross-map EnterServer arrival and preserves a preceding map fence through clear', () => {
    const f = setup(settings({ mode: 'save' })); f.start(); f.danger();
    f.packet(new BitWriter().u8(OP.map).string('prontera').finish()); expect(f.controller.escape.busy).toBe(true);
    f.packet(Uint8Array.of(OP.clear)); f.packet(spawn({ ...player, hp: 20 }, 1));
    expect(f.controller.snapshot().escape.state).toBe('confirmed'); expect(f.actions()).toEqual([{ type: 'useItem', itemId: 602 }]);
    f.packet(heal(100)); f.step(); expect(f.controller.engine.settings.map).toBe('prontera');
    expect(f.controller.snapshot().escape.reason).toBe('Escape arrival confirmed; HP recovered and escape cooldown active.');
  });
  it('waits on unknown arrival ground after an otherwise confirmed escape', () => {
    const f = setup(); f.start(); f.danger(); f.packet(new BitWriter().u8(OP.map).string('unknown').finish());
    f.packet(spawn(player, 1)); f.step();
    expect(f.controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true, escape: { state: 'confirmed' } });
    expect(f.controller.engine.running).toBe(false);
  });
  it('cancels an unsent preparation on Stop', () => {
    const f = setup(); f.start(); f.packet(heal(20)); f.advance(100); f.controller.stop(); f.advance(1000);
    expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot()).toMatchObject({ runRequested: false, state: 'idle', escape: { pending: false } });
  });
  it('retains sent ownership across Stop/Start and drains late arrival without restoring canceled work', () => {
    const f = setup(); f.start(); f.danger(); f.controller.stop();
    expect(() => f.controller.perform('command', { type: 'useItem', itemId: 601 })).toThrow();
    f.controller.start(settings()); f.packet(delta()); f.advance(1000); expect(f.actions()).toHaveLength(1);
    f.controller.stop(); f.arrival(); f.packet(heal(100)); f.advance(1000);
    expect(f.controller.snapshot()).toMatchObject({ runRequested: false, running: false, escape: { pending: false } });
    expect(f.actions()).toHaveLength(1);
  });
  it('never retries consumed-without-arrival, even after timeout and cooldown expiry', () => {
    const f = setup(); f.start(); f.danger(); f.packet(delta());
    for (let i = 0; i < 70; i++) { f.step(1000); f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish()); }
    expect(f.actions()).toHaveLength(1); expect(f.controller.snapshot().escape).toMatchObject({ state: 'uncertain', consumed: true });
    f.arrival(); expect(f.controller.escape.busy).toBe(false); f.packet(heal(100)); f.danger(); expect(f.actions()).toHaveLength(2);
  });
  it('does not fall back or retry a definitive server rejection until recovery and cooldown', () => {
    const f = setup(settings({ cooldownSeconds: 2 })); f.start(); f.danger(); f.packet(Uint8Array.of(FEATURE_OP.skillFailure, 5));
    f.advance(2000); f.packet(heal(20)); expect(f.actions()).toHaveLength(1); expect(f.controller.snapshot().escape.state).toBe('rejected');
    f.packet(heal(100)); f.danger(); expect(f.actions()).toHaveLength(2);
  });
  it('does not count death and later respawn as escape arrival', () => {
    const f = setup(); f.start(); f.danger(); f.packet(new BitWriter().u8(OP.death).i32(1).finish()); f.arrival(100);
    expect(f.controller.snapshot().escape).toMatchObject({ pending: true, state: 'uncertain' }); expect(f.actions()).toHaveLength(1);
  });
  it('requires a self HP recovery sample and cooldown, never low-HP refresh or another player', () => {
    const f = setup(settings({ cooldownSeconds: 2 })); f.start(); f.danger(); f.arrival();
    f.packet(spawn({ ...player, id: 3 }, 2)); f.advance(2000); f.arrival(); expect(f.actions()).toHaveLength(1);
    f.packet(heal(40)); f.advance(500); expect(f.actions()).toHaveLength(1);
    f.packet(heal(100)); f.danger(); expect(f.actions()).toHaveLength(2);
  });
  it('holds an uncertain disconnected request until fresh same-character resource reconciliation', () => {
    const f = setup(); f.start(); f.danger(); const old = f.controller.connectionGeneration;
    f.controller.disconnect(); f.controller.connect(true);
    f.controller.receive(spawn(player, 2), old); expect(f.controller.escape.busy).toBe(true);
    f.packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish()); f.packet(spawn({ ...player, hp: 20 }, 1));
    expect(f.controller.escape.busy).toBe(true); f.packet(stats(20, [[601, 4]])); f.advance(1000);
    expect(f.controller.escape.busy).toBe(false); expect(f.actions()).toHaveLength(1); expect(f.controller.engine.running).toBe(false);
    f.packet(heal(100)); f.step(); expect(f.controller.engine.running).toBe(true);
  });
  it('disarms automatic reload until verified resources and recovery, carrying cooldown outside profiles', () => {
    let now = 0; const run = new PersistentFieldRun(() => now); run.begin(settings(), 'Test', 'old');
    run.observe({ sessionId: 'old', connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Test' },
      escape: { state: 'sent', reason: '', pending: true, consumed: false, cooldownSeconds: 60, latched: true } });
    now = 10_000;
    const request = run.resumeFor({ sessionId: 'new', connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Test' } })!;
    expect(request.escapeGuard).toEqual({ latched: true, cooldownSeconds: 60 });
    const f = setup(request.settings, 20, false); f.controller.start(request.settings, request.escapeGuard); f.advance(1000);
    expect(f.actions()).toHaveLength(0); expect(f.controller.escape.busy).toBe(true);
    f.packet(stats(20)); f.advance(1000); expect(f.actions()).toHaveLength(0); expect(f.controller.escape.busy).toBe(false);
    f.packet(heal(100)); f.step(); expect(f.controller.engine.running).toBe(true);
    f.danger(); expect(f.actions()).toHaveLength(0);
    run.stop(); const another = { sessionId: 'third', connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Test' } };
    run.observe(another); expect(run.guardForStart(settings(), 'Test', 'third')).toEqual({ latched: true, cooldownSeconds: 50 });
  });
  it('binds retained cooldown to its character rather than contaminating a different character',()=>{
    let now=0;const run=new PersistentFieldRun(()=>now);
    const observe=(name:string,sessionId:string,cooldownSeconds:number)=>run.observe({sessionId,connected:true,compatible:true,map:'prt_fild08',player:{name},
      escape:{state:'sent',reason:'',pending:true,consumed:false,cooldownSeconds,latched:true}});
    observe('A','page-a',3600);run.stop();now=10_000;observe('B','page-b',1);run.stop();now=20_000;
    expect(run.guardForStart(settings({cooldownSeconds:1}),'B','page-c')).toEqual({latched:true,cooldownSeconds:0});
    expect(run.guardForStart(settings(),'A','page-return-a')).toEqual({latched:true,cooldownSeconds:3580});
    run.begin(settings(),'C','page-d');expect(run.guardForStart(settings(),'C','page-e')).toBeUndefined();
  });
  it('caps guard history without evicting spent episodes and expires only resolved cooldowns',()=>{
    let now=0;const run=new PersistentFieldRun(()=>now);
    const sample=(name:string,latched:boolean,cooldownSeconds=1)=>run.observe({sessionId:`page-${name}`,connected:true,compatible:true,map:'prt_fild08',player:{name},
      escape:{state:latched?'sent':'idle',reason:'',pending:latched,consumed:false,cooldownSeconds,latched}});
    for(let i=0;i<64;i++)sample(`Character${i}`,true);
    expect(run.guardForStart(settings(),'Unknown','new-page')).toEqual({latched:true,cooldownSeconds:3600});
    now=2000;expect(run.guardForStart(settings(),'Character0','return-page')).toEqual({latched:true,cooldownSeconds:0});
    sample('Character0',false,0);expect(run.guardForStart(settings(),'Character0','return-page')).toBeUndefined();
    expect(run.guardForStart(settings(),'Unknown','new-page')).toBeUndefined();
    expect(run.guardForStart(settings(),'Character63','return-page')).toEqual({latched:true,cooldownSeconds:0});
  });
  it('captures an escape receipt published during a map refresh with no player, even after Stop',()=>{
    const run=new PersistentFieldRun(()=>0);run.begin(settings(),'Test','page-old');
    run.observe({sessionId:'page-old',connected:true,compatible:true,map:'prt_fild08',player:{name:'Test'},
      escape:{state:'idle',reason:'',pending:false,consumed:false,cooldownSeconds:0,latched:false}});
    run.stop();run.observe({sessionId:'page-old',connected:true,compatible:true,map:'prt_fild08',player:null,
      escape:{state:'canceled',reason:'',pending:true,consumed:false,cooldownSeconds:60,latched:true}});
    expect(run.guardForStart(settings(),'Test','page-new')).toEqual({latched:true,cooldownSeconds:60});
  });
  it('retains overflow uncertainty after a tracked slot is freed and UI begins a returning overflow character',()=>{
    let now=0;const run=new PersistentFieldRun(()=>now);
    const sample=(name:string,latched:boolean,cooldownSeconds:number)=>run.observe({sessionId:`page-${name}`,connected:true,compatible:true,map:'prt_fild08',player:{name},
      escape:{state:latched?'sent':'idle',reason:'',pending:latched,consumed:false,cooldownSeconds,latched}});
    for(let i=0;i<64;i++)sample(`C${i}`,true,1);
    expect(run.guardForStart(settings(),'Overflow','overflow-initial')).toEqual({latched:true,cooldownSeconds:3600});
    now=3_601_000;sample('Overflow',true,60);sample('C0',false,0);
    expect(run.guardForStart(settings(),'Overflow','overflow-return')).toEqual({latched:true,cooldownSeconds:3600});
    run.begin(settings(),'Overflow','overflow-return');
    expect(run.guardForStart(settings(),'Overflow','overflow-return')).toEqual({latched:true,cooldownSeconds:3600});
    run.stop();expect(run.guardForStart(settings(),'OtherUntracked','another-page')).toEqual({latched:true,cooldownSeconds:3600});
  });
  it('retains untracked overflow ownership published without a player after Stop',()=>{
    const run=new PersistentFieldRun(()=>2000);
    const sample=(name:string,latched:boolean)=>run.observe({sessionId:`page-${name}`,connected:true,compatible:true,map:'prt_fild08',player:{name},
      escape:{state:latched?'sent':'idle',reason:'',pending:latched,consumed:false,cooldownSeconds:0,latched}});
    for(let i=0;i<64;i++)sample(`C${i}`,true);
    run.begin(settings(),'Overflow','page-overflow');run.stop();
    run.observe({sessionId:'page-overflow',connected:true,compatible:true,map:'prt_fild08',player:null,
      escape:{state:'canceled',reason:'',pending:true,consumed:false,cooldownSeconds:60,latched:true}});
    sample('C0',false);run.begin(settings(),'Overflow','overflow-return');
    expect(run.guardForStart(settings(),'Overflow','overflow-return')).toEqual({latched:true,cooldownSeconds:3600});
  });
});

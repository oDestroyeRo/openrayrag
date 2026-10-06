import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../shared/binary';
import { CompanionController } from '../runtime/controller';
import type { Action } from '../automation/engine';
import { escapeAction, validateEscapeResumeGuard, CONSERVATIVE_ESCAPE_RECOVERY } from './escape';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_SETTINGS, type Settings, type SettingsInput } from '../settings/settings';
import { OP, decode, type Entity } from '../protocol/protocol';
import { FEATURE_OP, featureCommand, validateExpandedAction } from '../protocol/protocol-feature';
import type { WorldAction } from '../protocol/world-protocol';
import { PersistentFieldRun } from '../session/reconnect';
import { DEFAULT_MAP_POLICY } from '../navigation/map-policy';
import { walkDuration } from '../navigation/movement';

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
const attack = (source = 2, target = 1) => new BitWriter().u8(OP.attack).i32(source).i32(target).u8(0).u8(0).u8(1).u8(0).position({ x: 101, y: 100 }).finish();
const delta = (id = 601) => new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(id).i16(1).i32(20).bool(false).finish();
function settings(overrides: Partial<NonNullable<typeof DEFAULT_AUTOMATION.escape>> = {}): Settings {
  const automation = structuredClone(DEFAULT_AUTOMATION);
  automation.escape = { ...DEFAULT_ESCAPE, enabled: true, ...overrides };
  return { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000], automation };
}
function setup(input: SettingsInput = settings(), hp = 100, resources = true, failSend = false, blockedCell = false, ownId = 1) {
  let time = 100_000; const sent: Array<Action | WorldAction> = [];
  const controller = new CompanionController(action => { sent.push(action); if (failSend && (action.type === 'useItem' || action.type === 'skill')) throw new Error('transport failed'); }, () => time, map => map === 'unknown' ? null
    : { width: 200, height: 200, walkable: cell => !(blockedCell && cell.x === 102 && cell.y === 100) });
  controller.connect(true);
  const packet = (data: Uint8Array) => controller.receive(data);
  packet(new BitWriter().u8(OP.enter).i32(ownId).string('prt_fild08').finish()); packet(spawn({ ...player, id: ownId, hp }));
  if (resources) packet(stats(hp));
  packet(spawn({ ...player, id: 2, name: 'Poring', classId: 4000, kind: 1, x: 101, hp: 10, maxHp: 10 }));
  const step = (ms = 100) => { time += ms; controller.tick(); };
  const advance = (ms: number) => { while (ms > 0) { const part = Math.min(ms, 100); step(part); ms -= part; } };
  const start = () => controller.start(input);
  const danger = () => { packet(heal(20)); advance(250); };
  const actions = () => sent.filter(action => action.type === 'useItem' || action.type === 'skill');
  const arrival = (hp = 20) => { packet(Uint8Array.of(OP.clear)); packet(spawn({ ...player, id: ownId, hp }, 2)); };
  return { controller, sent, packet, step, advance, start, danger, actions, arrival, setTime: (at: number) => { time = at; }, time: () => time };
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
    f.packet(heal(100)); f.step(); expect(f.controller.engine.running).toBe(false);
    expect(f.controller.snapshot().escape.recovery).toEqual(CONSERVATIVE_ESCAPE_RECOVERY);
    for (let i = 0; i < 60; i++) { f.advance(1000); f.packet(heal(100)); }
    expect(f.controller.engine.running).toBe(true);
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


describe('observed threat escape episodes', () => {
  const policy = (extra: Parameters<typeof settings>[0] = {}) => settings({ hpEnabled: false, threatEnabled: true, threatCount: 2, threatWindowSeconds: 2, cooldownSeconds: 1, ...extra });
  const second = (f: ReturnType<typeof setup>) => f.packet(spawn({ ...player, id: 3, name: 'Second monster', kind: 1 }));
  const threaten = (f: ReturnType<typeof setup>) => { second(f); f.packet(attack()); f.packet(attack(3)); f.advance(250); };
  it('is off by default and combines independently enabled HP and threat triggers with OR', () => {
    const off = setup(); off.start(); threaten(off); expect(off.actions()).toHaveLength(0);
    const threats = setup(policy()); threats.start(); threaten(threats); expect(threats.actions()).toHaveLength(1);
    expect(threats.controller.snapshot().escape).toMatchObject({ trigger: '2 recently observed monster attackers', threats: { count: 2, threshold: 2, windowSeconds: 2 } });
    const hp = setup(policy({ hpEnabled: true })); hp.start(); hp.danger(); expect(hp.actions()).toHaveLength(1);
    const disabledHp = setup(policy()); disabledHp.start(); disabledHp.danger(); expect(disabledHp.actions()).toHaveLength(0);
    const disabled = setup(policy({ enabled: false })); disabled.start(); threaten(disabled); expect(disabled.actions()).toHaveLength(0);
  });
  it('requires the exact distinct threshold and rechecks active evidence before sending', () => {
    const f = setup(policy()); f.start(); f.packet(attack()); f.packet(attack()); f.advance(250); expect(f.actions()).toHaveLength(0);
    second(f); f.packet(attack(3)); f.advance(100); f.packet(new BitWriter().u8(OP.death).i32(3).finish()); f.advance(250);
    expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(false);
    second(f); f.packet(attack(3)); f.advance(250); expect(f.actions()).toHaveLength(1);
  });
  it('does not let threat-only escape bypass an uncertain resource owner or stale connection packets', () => {
    const input = policy(); input.automation!.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 1 }];
    const f = setup(input); f.packet(stats(100, [[501, 4], [601, 5]])); f.start(); f.step(); threaten(f);
    expect(f.actions()).toEqual([{ type: 'useItem', itemId: 501 }]);
    const other = setup(policy()); const old = other.controller.connectionGeneration;
    other.controller.disconnect(); other.controller.connect(true);
    other.controller.receive(attack(), old); expect(other.controller.engine.observedThreats(2).count).toBeNull();
  });
  it.each(['cost', 'transport'] as const)('never replays after uncertain %s, even with continuing attacks and expired cooldown', failure => {
    const f = setup(policy(), 100, true, failure === 'transport'); f.start(); threaten(f);
    if (failure === 'cost') f.packet(delta());
    for (let i = 0; i < 35; i++) { f.advance(1000); f.packet(attack()); f.packet(attack(3)); }
    expect(f.actions()).toHaveLength(1); expect(f.controller.snapshot().escape.pending).toBe(true);
    f.controller.stop(); f.arrival(100); f.advance(2500); expect(f.actions()).toHaveLength(1);
    expect(f.controller.snapshot()).toMatchObject({ runRequested: false, escape: { pending: false } });
  });
  it('requires a full below-threshold quiet window with recovered HP, and restarts it on a new threat', () => {
    const f = setup(policy()); f.start(); threaten(f); f.arrival(100);
    f.advance(1500); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.packet(spawn({ ...player, id: 2, kind: 1 })); second(f); f.packet(attack()); f.packet(attack(3));
    f.advance(1999); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.step(1); f.advance(1999); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.step(1); expect(f.controller.snapshot().escape.latched).toBe(false);
    threaten(f); expect(f.actions()).toHaveLength(2);
  });
  it('retains captured HP, threshold, quiet interval and cooldown across profile changes and Stop/Start', () => {
    const input = policy({ hpBelowPercent: 80, cooldownSeconds: 5 }); const f = setup(input); f.start(); threaten(f); f.arrival(80);
    f.controller.stop(); f.controller.start(settings({ enabled: false, hpBelowPercent: 1, threatWindowSeconds: 1, cooldownSeconds: 1 }));
    expect(f.controller.snapshot().escape.recovery).toEqual({ hpPercent: 90, threatCount: 2, quietSeconds: 2 });
    f.advance(6000); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.packet(heal(100)); f.advance(1999); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.step(1); expect(f.controller.snapshot().escape.latched).toBe(false);
    expect(f.actions()).toHaveLength(1);
  });
  it('does not count disconnected or stale time as quiet and starts again from fresh own-world health', () => {
    const f = setup(policy({ threatWindowSeconds: 4 })); f.start(); threaten(f); f.arrival(100); f.advance(3000);
    f.controller.disconnect(); f.advance(10_000); f.controller.connect(true);
    f.packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish()); f.packet(spawn(player, 1)); f.packet(stats(100));
    f.advance(3999); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.step(1); expect(f.controller.snapshot().escape.latched).toBe(false);
    const stale = setup(policy({ threatWindowSeconds: 20 })); stale.start(); threaten(stale); stale.arrival(100); stale.advance(16_000);
    stale.packet(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish()); stale.advance(5000);
    expect(stale.controller.snapshot().escape.latched).toBe(true);
  });
  it('restarts quiet recovery after a world refresh or clock rollback, never accepting missing actors as safety', () => {
    const f = setup(policy()); f.start(); threaten(f); f.arrival(100); f.advance(1500);
    f.packet(Uint8Array.of(OP.clear)); f.advance(5000); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.packet(spawn(player, 2)); f.advance(1999); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.step(1); expect(f.controller.snapshot().escape.latched).toBe(false);
    const rollback = setup(policy()); rollback.start(); threaten(rollback); rollback.arrival(100); rollback.advance(1500);
    rollback.setTime(rollback.time() - 3000); rollback.step(); rollback.packet(heal(100)); rollback.advance(2000); expect(rollback.controller.snapshot().escape.latched).toBe(true);
    rollback.packet(heal(100)); rollback.advance(2000); expect(rollback.controller.snapshot().escape.latched).toBe(true); // receive rollback invalidates actor lifetimes
    rollback.packet(spawn(player)); rollback.advance(2000); expect(rollback.controller.snapshot().escape.latched).toBe(false);
  });
  it('carries captured scalar requirements across reload even when the replacement profile disables escape', () => {
    const f = setup(policy({ hpBelowPercent: 80, threatWindowSeconds: 4 })); f.start(); threaten(f);
    const run = new PersistentFieldRun(() => 100_000); run.begin(policy(), 'Test', 'old');
    run.observe({ sessionId: 'old', connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Test' }, escape: f.controller.snapshot().escape });
    run.stop(); const changed = settings({ enabled: false });
    const guard = run.guardForStart(changed, 'Test', 'new')!;
    expect(guard.recovery).toEqual({ hpPercent: 90, threatCount: 2, quietSeconds: 4 });
    const restored = setup(changed, 80); restored.controller.start(changed, guard); restored.advance(5000);
    expect(restored.controller.snapshot().escape.latched).toBe(true); restored.packet(heal(100)); restored.advance(3999);
    expect(restored.controller.snapshot().escape.latched).toBe(true); restored.step(1); expect(restored.controller.snapshot().escape.latched).toBe(false);
  });
  it('strictly validates ephemeral recovery values and conservatively accepts old scalar-only guards', () => {
    expect(() => validateEscapeResumeGuard({ latched: true, cooldownSeconds: 0 })).not.toThrow();
    for (const recovery of [{ hpPercent: 0, threatCount: 1, quietSeconds: 1 }, { hpPercent: 100, threatCount: 65, quietSeconds: 1 },
      { hpPercent: 100, threatCount: 1, quietSeconds: 61 }, { hpPercent: 100, threatCount: 0, quietSeconds: 1 },
      { hpPercent: 100, threatCount: 1, quietSeconds: 0 }, { hpPercent: 100, threatCount: 1, quietSeconds: 1, actorId: 2 }, null]) {
      expect(() => validateEscapeResumeGuard({ latched: true, cooldownSeconds: 0, recovery } as never)).toThrow();
    }
  });
});


it('keeps a fresh own-world quiet interval longer than 15 seconds without demanding repeated unchanged HP packets', () => {
  const f = setup(settings({ threatEnabled: true, threatCount: 1, threatWindowSeconds: 20, cooldownSeconds: 1 }));
  f.start(); f.packet(attack()); f.advance(250); f.arrival(100);
  for (let i = 0; i < 20; i++) { f.advance(1000); f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish()); }
  expect(f.controller.snapshot().escape.latched).toBe(false);
});
it('cannot weaken an unknown old recovery requirement through a later latched publication', () => {
  const run = new PersistentFieldRun(() => 0);
  const status = { connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Test' } };
  const escape = { state: 'sent' as const, reason: '', pending: true, consumed: false, cooldownSeconds: 60, latched: true };
  run.observe({ ...status, sessionId: 'old', escape });
  run.observe({ ...status, sessionId: 'new', escape: { ...escape, recovery: { hpPercent: 40, threatCount: 3, quietSeconds: 1 } } });
  expect(run.guardForStart(settings({ enabled: false }), 'Test', 'third')?.recovery).toEqual(CONSERVATIVE_ESCAPE_RECOVERY);
});


it('preserves healthy default HP-only reload behavior when fresh verified health is already present', () => {
  const run = new PersistentFieldRun(() => 0); run.begin(settings(), 'Test', 'old');
  const resumed = run.resumeFor({ sessionId: 'new', connected: true, compatible: true, map: 'prt_fild08', player: { name: 'Test' } })!;
  expect(resumed.escapeGuard?.recovery).toEqual({ hpPercent: 46, threatCount: 0, quietSeconds: 0 });
  const f = setup(resumed.settings); f.controller.start(resumed.settings, resumed.escapeGuard); f.step();
  expect(f.controller.engine.running).toBe(true); expect(f.controller.snapshot().escape.latched).toBe(true);
  f.danger(); expect(f.actions()).toHaveLength(0);
});


function ownWalk(cells = Array.from({ length: 6 }, (_, i) => ({ x: 100 + i, y: 100 })), seconds = 1, id = 1): Uint8Array {
  const first = cells[0]!;
  const directions = [[0,-1],[-1,-1],[-1,0],[-1,1],[0,1],[1,1],[1,0],[1,-1]];
  const w = new BitWriter().u8(OP.walk).i32(id).position(first).f32(first.x).f32(first.y).f32(seconds).f32(seconds).u8(cells.length);
  const direction = (i: number) => i < cells.length ? directions.findIndex(([x,y]) => cells[i]!.x - cells[i-1]!.x === x && cells[i]!.y - cells[i-1]!.y === y) : 0;
  for (let i = 1; i < cells.length; i += 2) w.u8(direction(i) << 4 | direction(i+1));
  return w.u8(0).finish();
}
const movementThreatPolicy = (extra: Parameters<typeof settings>[0] = {}) => settings({ hpEnabled: false, threatEnabled: true, threatCount: 1, threatWindowSeconds: 10, cooldownSeconds: 1, ...extra });
describe('observed threat physical settlement and scheduling continuity', () => {
  it.each(['tick-first', 'receive-first'] as const)('restarts the full quiet interval after an unknown scheduler pause (%s)', order => {
    const f = setup(movementThreatPolicy({ threatWindowSeconds: 2 })); f.start(); f.packet(attack()); f.advance(250); f.arrival(100); f.advance(100);
    if (order === 'tick-first') f.step(6000);
    else { f.setTime(f.time() + 6000); f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish()); }
    expect(f.controller.snapshot().escape).toMatchObject({ latched: true, state: 'confirmed', recovery: { hpPercent: 46, threatCount: 1, quietSeconds: 2 } });
    expect(f.actions()).toHaveLength(1);
    // Fresh unrelated traffic cannot replace the invalidated own-health sample.
    f.advance(2500); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.packet(heal(100)); f.advance(1999); expect(f.controller.snapshot().escape.latched).toBe(true);
    f.step(1); expect(f.controller.snapshot().escape.latched).toBe(false);
  });
  it('waits for the accepted own walk to actually finish after Stop', () => {
    const f = setup(movementThreatPolicy()); f.start(); f.step(); f.packet(ownWalk()); f.packet(attack());
    f.advance(250); expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.reason).toContain('physical movement');
    f.advance(4749); expect(f.actions()).toHaveLength(0); f.step(1); expect(f.actions()).toHaveLength(1);
    expect(f.controller.engine.idleForActions()).toBe(true);
  });
  it('keeps the explicitly enabled legacy HP trigger preemption while accepted movement continues', () => {
    const f = setup(movementThreatPolicy({ hpEnabled: true })); f.start(); f.step(); f.packet(ownWalk()); f.packet(heal(20)); f.advance(250);
    expect(f.actions()).toHaveLength(1); expect(f.controller.engine.idleForActions()).toBe(false);
  });
  it('retains an unacknowledged explicit walk through unrelated own Attack replies and a late walk ACK after Stop', () => {
    const f = setup(movementThreatPolicy(), 100, true, false, true);
    f.packet(spawn({ ...player, id: 2, kind: 1, classId: 4000, x: 104 })); f.start(); f.step();
    expect(f.sent.at(-1)?.type).toBe('walk'); const cells = f.controller.engine.snapshot().navigation!.leg;
    f.packet(attack()); f.advance(250); expect(f.actions()).toHaveLength(0);
    f.packet(attack(1, 2)); f.advance(250); expect(f.actions()).toHaveLength(0);
    f.packet(ownWalk(cells));
    const duration = walkDuration({ origin: cells[0]!, cells, secondsPerCell: 1, firstSeconds: 1, locked: false });
    f.advance(Math.ceil(duration) - 1); expect(f.actions()).toHaveLength(0); f.step(1); expect(f.actions()).toHaveLength(1);
  });
  it('drains an implicit direct-attack walk fence before a threat-only dispatch', () => {
    const f = setup(movementThreatPolicy()); f.packet(spawn({ ...player, id: 2, kind: 1, classId: 4000, x: 106 })); f.start(); f.step();
    expect(f.sent.at(-1)?.type).toBe('attack'); f.packet(attack()); f.advance(250); expect(f.actions()).toHaveLength(0);
    f.advance(3749); expect(f.actions()).toHaveLength(0); f.step(1); expect(f.actions()).toHaveLength(1);
  });
  it('rechecks recent evidence when physical movement finally settles', () => {
    const f = setup(movementThreatPolicy({ threatWindowSeconds: 1 })); f.start(); f.step(); f.packet(ownWalk()); f.packet(attack()); f.advance(5000);
    expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(false);
  });
  it('continues to respect an unresolved automatic cast owner before threat preparation', () => {
    const input = movementThreatPolicy(); input.automation!.skills = [{ skillId: 53, level: 1, target: 'self', hpBelowPercent: 100, spAbovePercent: 0, cooldownSeconds: 1 }];
    const f = setup(input); f.start(); f.step(); expect(f.actions()).toEqual([{ type: 'skill', mode: 'self', skillId: 53, level: 1 }]);
    f.packet(attack()); f.advance(1000); expect(f.actions()).toHaveLength(1); expect(f.controller.snapshot().escape.pending).toBe(false);
  });
});

describe('death recovery during observed-threat escape preparation', () => {
  function deathRecoverySetup(id: number) {
    const input = movementThreatPolicy({ threatWindowSeconds: 60 });
    input.automation!.respawn = { enabled: true, maxDeaths: 1 };
    input.automation!.recovery.enabled = false;
    return setup(input, 100, true, false, false, id);
  }
  function freshWait(f: ReturnType<typeof setup>) {
    for (let i = 0; i < 35; i++) {
      f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(100).i32(100).finish()); f.advance(1000);
    }
  }
  it.each([0, 1].flatMap(id => ['cast', 'movement'].map(owner => ({ id, owner }))))(
    'retires unsent $owner preparation on own$id death before the single automatic respawn', ({ id, owner }) => {
      const f = deathRecoverySetup(id); f.start();
      if (owner === 'cast') f.packet(observedCastStart(id)); else f.packet(ownWalk(undefined, 1, id));
      f.packet(attack(2, id)); f.advance(300);
      expect(f.controller.snapshot().escape).toMatchObject({ pending: true, state: 'preparing', latched: false });
      f.packet(spawn({ ...player, id: 3, kind: 1, classId: 4000 }));
      f.packet(new BitWriter().u8(OP.death).i32(3).finish());
      expect(f.controller.snapshot().escape.pending).toBe(true); expect(f.controller.engine.deaths).toBe(0);
      f.packet(new BitWriter().u8(OP.death).i32(id).finish()); freshWait(f);
      expect(f.sent.filter(action => action.type === 'respawn')).toEqual([{ type: 'respawn' }]);
      expect(f.actions()).toHaveLength(0); expect(f.controller.engine.deaths).toBe(1);
      expect(f.controller.snapshot().escape).toMatchObject({ pending: false, state: 'idle', latched: false });
      expect(f.controller.snapshot().deathRecoveryGuard).toMatchObject({ phase: 'revival', uncertain: true });
    });
  it.each([0, 1])('preserves sent escape uncertainty on own%i death and never spends an automatic respawn', id => {
    const f = deathRecoverySetup(id); f.start(); f.packet(attack(2, id)); f.advance(250);
    expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
    f.packet(new BitWriter().u8(OP.death).i32(id).finish()); freshWait(f);
    expect(f.sent.filter(action => action.type === 'respawn')).toHaveLength(0);
    expect(f.actions()).toHaveLength(1); expect(f.controller.engine.deaths).toBe(1);
    expect(f.controller.snapshot().escape).toMatchObject({ pending: true, state: 'uncertain', latched: true });
  });
  it.each([0, 1])('keeps the one-death limit after unsent escape cancellation and verified own%i revival', id => {
    const f = deathRecoverySetup(id); f.start(); f.packet(observedCastStart(id)); f.packet(attack(2, id)); f.advance(300);
    f.packet(new BitWriter().u8(OP.death).i32(id).finish()); f.advance(2300);
    expect(f.sent.filter(action => action.type === 'respawn')).toEqual([{ type: 'respawn' }]);
    f.arrival(100); f.advance(500);
    expect(f.controller.engine.deaths).toBe(1); expect(f.controller.engine.running).toBe(true);
    expect(f.controller.snapshot().deathRecoveryGuard).toBeUndefined();
    f.packet(new BitWriter().u8(OP.death).i32(id).finish()); freshWait(f);
    expect(f.controller.engine.deaths).toBe(2); expect(f.sent.filter(action => action.type === 'respawn')).toHaveLength(1);
    expect(f.controller.snapshot().reason).toContain('Death limit reached');
    expect(f.controller.snapshot().reason).toContain('Stop'); expect(f.controller.runRequested).toBe(true);
  });
});


it('expires threat evidence while an explicit unacknowledged walk is still fenced', () => {
  const f = setup(movementThreatPolicy({ threatWindowSeconds: 1 }), 100, true, false, true);
  f.packet(spawn({ ...player, id: 2, kind: 1, classId: 4000, x: 104 })); f.start(); f.step();
  expect(f.sent.at(-1)?.type).toBe('walk'); f.packet(attack()); f.advance(1000);
  expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(false);
  f.packet(new BitWriter().u8(OP.stop).i32(1).finish()); f.advance(250);
  expect(f.actions()).toHaveLength(0);
});
it('does not let a changed input profile enable HP preemption inside an already preparing threat request', () => {
  const input = movementThreatPolicy(); const f = setup(input); f.start(); f.step(); f.packet(ownWalk()); f.packet(attack());
  input.automation!.escape!.hpEnabled = true; f.packet(heal(20)); f.advance(250);
  expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.reason).toContain('physical movement');
  f.advance(4750); expect(f.actions()).toHaveLength(1);
  expect(f.controller.snapshot().escape.recovery).toEqual({ hpPercent: 46, threatCount: 1, quietSeconds: 10 });
});


function fieldEntryThreats(windowSeconds = 10) {
  const input = movementThreatPolicy({ threatWindowSeconds: windowSeconds });
  input.automation!.mapPolicy = { ...DEFAULT_MAP_POLICY, lockArea: { map: 'prt_fild08', minX: 104, maxX: 108, minY: 98, maxY: 102 } };
  const f = setup(input); f.start(); f.step();
  const cells = f.controller.travel.snapshot().leg;
  expect(cells.length).toBeGreaterThan(1); expect(f.sent.at(-1)?.type).toBe('walk'); expect(f.controller.engine.idleForActions()).toBe(true);
  return { ...f, cells };
}
describe('shared transport-wide movement settlement for observed-threat escape', () => {
  it('retains unacknowledged field-entry movement beyond four seconds and drains a late matching ACK after Stop', () => {
    const f = fieldEntryThreats(); f.packet(attack()); f.advance(5000);
    expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(true);
    expect(f.controller.travel.active).toBe(false); expect(f.controller.engine.idleForActions()).toBe(true);
    f.packet(attack(1, 2)); expect(f.actions()).toHaveLength(0);
    f.packet(attack()); f.packet(ownWalk(f.cells));
    const duration = walkDuration({ origin: f.cells[0]!, cells: f.cells, secondsPerCell: 1, firstSeconds: 1, locked: false });
    f.advance(Math.ceil(duration) - 1); expect(f.actions()).toHaveLength(0); f.step(1); expect(f.actions()).toHaveLength(1);
  });
  it('never turns an expired threat and missing travel ACK into an escape request', () => {
    const f = fieldEntryThreats(5); f.packet(attack()); f.advance(6000);
    expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(false);
    f.packet(ownWalk(f.cells)); f.advance(5000); expect(f.actions()).toHaveLength(0);
  });
  it('requires a matching endpoint and current own lifetime for canceled travel movement', () => {
    const f = fieldEntryThreats(); f.packet(attack());
    f.packet(ownWalk([{ x: 100, y: 100 }, { x: 101, y: 100 }], 1)); f.advance(5000);
    expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(true);
    // A replacement lifetime cancels preparation; it cannot inherit the old threat.
    f.packet(spawn(player)); f.advance(250); expect(f.actions()).toHaveLength(0); expect(f.controller.snapshot().escape.pending).toBe(false);
  });
  it.each(['service', 'return', 'travel'] as const)('shares the same non-expiring transport fence for %s approach ownership', purpose => {
    const f = setup(movementThreatPolicy()); f.start(); f.controller.engine.stop();
    f.controller.travel.startApproach('prt_fild08', f.controller.engine.player!, { x: 104, y: 100 }, 10, DEFAULT_MAP_POLICY, purpose);
    f.controller.travel.tick('prt_fild08', f.controller.engine.player); const cells = f.controller.travel.snapshot().leg;
    f.packet(attack()); f.advance(5000); expect(f.actions()).toHaveLength(0);
    f.packet(attack()); f.packet(ownWalk(cells)); f.advance(3999); expect(f.actions()).toHaveLength(0); f.step(1); expect(f.actions()).toHaveLength(1);
  });
});

describe('updater admission during observed-threat escape', () => {
  it('admits a stopped unsent preparation without dispatching its escape', () => {
    const f = setup(movementThreatPolicy()); f.start(); f.packet(attack());
    expect(f.controller.snapshot().escape).toMatchObject({ state: 'preparing', pending: true });
    expect(f.controller.settledForMaintenance()).toBe(false);
    f.controller.stop(); f.advance(1000);
    expect(f.controller.settledForMaintenance()).toBe(true); expect(f.actions()).toHaveLength(0);
  });
  it.each(['sent', 'consumed', 'refreshing', 'uncertain', 'transport'] as const)('keeps %s ownership after Stop until authoritative arrival', phase => {
    const f = setup(movementThreatPolicy(), 100, true, phase === 'transport'); f.start(); f.packet(attack()); f.advance(250);
    if (phase === 'consumed') f.packet(delta());
    if (phase === 'refreshing') { f.packet(Uint8Array.of(OP.clear)); f.packet(spawn(player, 0)); }
    if (phase === 'uncertain') f.advance(31000);
    expect(f.controller.snapshot().escape).toMatchObject({ state: phase === 'transport' ? 'canceled' : phase === 'consumed' ? 'sent' : phase, pending: true });
    f.controller.stop(); f.advance(40000);
    expect(f.controller.runRequested).toBe(false); expect(f.controller.engine.idleForActions()).toBe(true);
    expect(f.controller.settledForMaintenance()).toBe(false); expect(f.actions()).toHaveLength(1);
    f.arrival(100); f.step();
    expect(f.controller.snapshot().escape.pending).toBe(false); expect(f.controller.settledForMaintenance()).toBe(true);
    expect(f.controller.runRequested).toBe(false); expect(f.actions()).toHaveLength(1);
  });
  it('retains restored uncertainty after Stop until fresh own health and resources arrive', () => {
    const input = movementThreatPolicy(), f = setup(input, 100, false);
    f.controller.start(input, { latched: true, cooldownSeconds: 60, recovery: { hpPercent: 100, threatCount: 1, quietSeconds: 60 } });
    f.controller.stop(); f.advance(30000);
    expect(f.controller.snapshot().escape.pending).toBe(true); expect(f.controller.settledForMaintenance()).toBe(false);
    f.packet(stats(100)); f.step();
    expect(f.controller.snapshot().escape).toMatchObject({ pending: false, latched: true });
    expect(f.controller.settledForMaintenance()).toBe(true); expect(f.actions()).toHaveLength(0);
  });
});

it('prioritizes threat escape over an eligible resource-conditioned item and retains the quiet latch through resource traffic', () => {
  const input = movementThreatPolicy({ threatWindowSeconds: 2, cooldownSeconds: 1 });
  input.automation!.items = [{ itemId: 501, resource: 'hp', belowPercent: 90, minStock: 0, cooldownSeconds: 1,
    conditions: [{ field: 'actorSpPercent', actor: { scope: 'self' }, operator: 'gte', value: 25.5 }] }];
  const normal = setup(input, 80); normal.packet(stats(80, [[501, 4], [601, 5]])); normal.start(); normal.step();
  expect(normal.actions()).toEqual([{ type: 'useItem', itemId: 501 }]);
  const f = setup(input, 80); f.packet(stats(80, [[501, 4], [601, 5]])); f.packet(attack()); f.start(); f.advance(250);
  expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]); f.arrival(100); f.step();
  f.advance(1000); f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(30).i32(100).finish()); f.packet(heal(100));
  f.advance(899); expect(f.controller.snapshot().escape.latched).toBe(true);
  f.step(1); expect(f.controller.snapshot().escape.latched).toBe(false); expect(f.actions()).toHaveLength(1);
});

function observedCastStart(id = 1, seconds = 10, target: number | { x: number; y: number } = 2, skillId = 11, level = 1): Uint8Array {
  const w = new BitWriter().u8(typeof target === 'number' ? FEATURE_OP.castStart : FEATURE_OP.areaCastStart).i32(id);
  if (typeof target === 'number') w.i32(target); else w.position(target);
  w.u8(skillId).u8(level); if (typeof target !== 'number') w.u8(1);
  return w.u8(0).position(player).f32(seconds).u8(0).finish();
}
function observedCastResult(options: Partial<{ source: number; skillId: number; level: number; target: number; ground: { x: number; y: number }; self: boolean; indirect: boolean }> = {}): Uint8Array {
  const { source = 1, skillId = 11, level = 1, target = 2, ground, self = false, indirect = false } = options;
  const mode = ground ? 4 : self ? 5 : 1, w = new BitWriter().u8(FEATURE_OP.skill).u8(mode).i32(source);
  if (ground) w.position(ground); else if (!self) w.i32(source).i32(target);
  w.u8(skillId).u8(level).u8(0).position(player);
  if (!ground && !self) w.i32(0).u8(0).u8(1);
  w.f32(0); if (!ground && !self) w.f32(0); if (!ground) w.bool(indirect);
  return w.finish();
}
const observedCastStop = (id = 1) => new BitWriter().u8(FEATURE_OP.castStop).i32(id).finish();
const observedCastAdjust = (id = 1, seconds = 10) => new BitWriter().u8(FEATURE_OP.castExtend).i32(id).f32(seconds).finish();
describe('observed own cast settlement before threat escape', () => {
  it.each([0, 1])('waits for a known official own cast on actor %i after manual input yields', id => {
    const f = setup(movementThreatPolicy(), 100, true, false, false, id);
    f.start(); f.controller.manualCommand(); f.packet(observedCastStart(id)); f.packet(attack(2, id)); f.advance(2300);
    expect(f.actions()).toHaveLength(0);
    expect(f.controller.snapshot().escape).toMatchObject({ pending: true, latched: false, state: 'preparing' });
    expect(f.controller.snapshot().escape.reason).toContain('observed own cast');
    f.packet(observedCastStop(2)); expect(f.actions()).toHaveLength(0);
    f.packet(observedCastStop(id)); expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
  });
  it('does not manufacture a cast from initial unknown state, foreign casts or pre-start adjustments', () => {
    const f = setup(movementThreatPolicy()); f.start(); f.packet(observedCastAdjust()); f.packet(observedCastStart(2));
    expect(f.controller.engine.observedOwnCastSettled()).toBe(true);
    f.packet(attack()); f.advance(250); expect(f.actions()).toHaveLength(1);
  });
  it.each(['deadline', 'late adjustment', 'shortened to unknown'] as const)('retains an observed cast after %s until a matching late terminal', change => {
    const f = setup(movementThreatPolicy({ threatWindowSeconds: 60 })); f.start(); f.packet(observedCastStart(1, 1)); f.packet(attack());
    if (change === 'shortened to unknown') f.packet(observedCastAdjust(1, -1));
    f.advance(1100); if (change === 'late adjustment') f.packet(observedCastAdjust());
    f.advance(250); expect(f.actions()).toHaveLength(0); expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
    if (change !== 'deadline') expect(f.controller.engine.actorObservation().actors.find(actor => actor.id === 1)?.cast.state).toBe('unknown');
    f.packet(Uint8Array.of(FEATURE_OP.skillFailure, 5)); f.packet(new BitWriter().u8(FEATURE_OP.sp).i32(90).i32(100).finish());
    expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
    f.packet(observedCastResult()); expect(f.actions()).toHaveLength(1);
  });
  it('keeps the newest cast and rejects wrong own source, skill, level, target, mode and indirect terminals', () => {
    const f = setup(movementThreatPolicy()); f.start(); f.packet(observedCastStart()); f.packet(attack());
    f.packet(observedCastStart(1, 10, 3, 12, 2)); f.advance(250);
    for (const wrong of [{}, { source: 2, skillId: 12, level: 2, target: 3 }, { skillId: 12, level: 1, target: 3 },
      { skillId: 12, level: 2, target: 2 }, { skillId: 12, level: 2, self: true }, { skillId: 12, level: 2, target: 3, indirect: true }]) {
      f.packet(observedCastResult(wrong)); expect(f.actions()).toHaveLength(0); expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
    }
    f.packet(observedCastResult({ skillId: 12, level: 2, target: 3 })); expect(f.actions()).toHaveLength(1);
  });
  it('requires the exact ground position for an observed area cast', () => {
    const f = setup(movementThreatPolicy(), 100, true, false, false, 0); f.start();
    f.packet(observedCastStart(0, 1, { x: 104, y: 100 }, 19, 3)); f.packet(attack(2, 0)); f.advance(1100); f.packet(observedCastAdjust(0));
    f.packet(observedCastResult({ source: 0, skillId: 19, level: 3, target: 2 }));
    f.packet(observedCastResult({ source: 0, skillId: 19, level: 3, ground: { x: 103, y: 100 } })); expect(f.actions()).toHaveLength(0);
    f.packet(observedCastResult({ source: 0, skillId: 19, level: 3, ground: { x: 104, y: 100 } })); expect(f.actions()).toHaveLength(1);
  });
  it.each([-1, 0])('matches an untargeted or self-zero cast target %i only to own direct self execution', target => {
    const f = setup(movementThreatPolicy(), 100, true, false, false, 0); f.start(); f.packet(observedCastStart(0, 10, target, 53)); f.packet(attack(2, 0)); f.advance(250);
    f.packet(observedCastResult({ source: 0, skillId: 53, target: 2 })); expect(f.actions()).toHaveLength(0);
    f.packet(observedCastResult({ source: 0, skillId: 53, self: true })); expect(f.actions()).toHaveLength(1);
  });
  it('retains cast uncertainty through Stop, Start, manual input and ordinary physical Stop', () => {
    const input = movementThreatPolicy({ threatWindowSeconds: 60 }), f = setup(input); f.start(); f.packet(observedCastStart()); f.packet(attack());
    f.controller.stop(); f.advance(1000); expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
    f.start(); f.controller.manualCommand(); f.packet(new BitWriter().u8(OP.stop).i32(1).finish()); f.advance(2300);
    expect(f.actions()).toHaveLength(0); expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
    f.packet(observedCastStop()); expect(f.actions()).toHaveLength(1);
  });
  it('rechecks expired threat evidence after cast settlement instead of dispatching the old preparation', () => {
    const f = setup(movementThreatPolicy({ threatWindowSeconds: 1 })); f.start(); f.packet(observedCastStart()); f.packet(attack()); f.advance(1100);
    expect(f.controller.snapshot().escape.pending).toBe(false); f.packet(observedCastStop()); f.advance(250); expect(f.actions()).toHaveLength(0);
  });
  it.each(['replacement', 'map', 'connection'] as const)('invalidates the old cast and unsent escape on own %s without accepting stale terminal evidence', change => {
    const f = setup(movementThreatPolicy()); f.start(); f.packet(observedCastStart()); f.packet(attack()); f.advance(250);
    const previous = f.controller.connectionGeneration;
    if (change === 'connection') { f.controller.disconnect(); f.controller.connect(true); f.packet(new BitWriter().u8(OP.enter).i32(1).string('prt_fild08').finish()); }
    if (change === 'map') f.packet(Uint8Array.of(OP.clear));
    f.packet(spawn(player, change === 'replacement' ? 0 : change === 'map' ? 2 : 1));
    expect(f.controller.engine.observedOwnCastSettled()).toBe(true); expect(f.actions()).toHaveLength(0);
    f.packet(stats()); f.packet(spawn({ ...player, id: 2, kind: 1, classId: 4000 })); f.packet(observedCastStart(1, 10, 2, 12)); f.packet(attack());
    if (change === 'connection') f.controller.receive(observedCastStop(), previous);
    else f.packet(observedCastResult());
    f.advance(250); expect(f.actions()).toHaveLength(0); expect(f.controller.engine.observedOwnCastSettled()).toBe(false);
    f.packet(observedCastResult({ skillId: 12 })); f.advance(250); expect(f.actions()).toHaveLength(1);
  });
  it.each([false, true])('preserves explicitly enabled legacy HP preemption with threat enabled %s', threatEnabled => {
    const f = setup(settings({ hpEnabled: true, threatEnabled, threatCount: 1 })); f.start(); f.controller.manualCommand(); f.packet(observedCastStart());
    f.packet(heal(20)); f.packet(attack()); f.advance(2300);
    expect(f.controller.engine.observedOwnCastSettled()).toBe(false); expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
  });
  it.each([{ skillId: 42, level: 1, self: true }, { skillId: 43, level: 1, self: false }, { skillId: 43, level: 3, self: false },
    { skillId: 96, level: 3, self: false }, { skillId: 96, level: 5, self: false }, { skillId: 96, level: 10, self: false }])(
    'inherits proc ambiguity for $skillId/$level and waits for accepted own walking to finish', ({ skillId, level, self }) => {
      const f = setup(movementThreatPolicy()), target = self ? 1 : 2;
      f.start(); f.packet(observedCastStart(1, 1, target, skillId, level)); f.packet(attack()); f.advance(1250);
      // Unmarked equipment/card proc shape from the pinned server, not a cast receipt.
      f.packet(new BitWriter().u8(FEATURE_OP.skill).u8(2).i32(1).i32(-1).i32(target).u8(skillId).u8(level)
        .u8(0).position(player).i32(0).u8(0).u8(1).f32(0).f32(0).bool(false).finish());
      expect(f.controller.engine.observedOwnCastSettled()).toBe(false); expect(f.actions()).toHaveLength(0);
      expect(f.controller.snapshot().escape).toMatchObject({ state: 'preparing', latched: false });
      f.packet(new BitWriter().u8(OP.stop).i32(1).finish()); expect(f.actions()).toHaveLength(0);
      f.packet(ownWalk([{ x: 100, y: 100 }, { x: 101, y: 100 }]));
      expect(f.controller.engine.observedOwnCastSettled()).toBe(true); expect(f.actions()).toHaveLength(0);
      expect(f.controller.snapshot().escape.reason).toContain('physical movement');
      f.advance(999); expect(f.actions()).toHaveLength(0); f.step(1); expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
      f.advance(1000); expect(f.actions()).toHaveLength(1);
    });
  it.each([0, 1])('inherits only own CounterAttack ResetMotion availability for actor %i', id => {
    const f = setup(movementThreatPolicy(), 100, true, false, false, id);
    f.start(); f.packet(observedCastStart(id, 10, id, 31)); f.packet(attack(2, id)); f.advance(250);
    f.packet(new BitWriter().u8(FEATURE_OP.resetMotion).i32(2).finish());
    expect(f.controller.engine.observedOwnCastSettled()).toBe(false); expect(f.actions()).toHaveLength(0);
    f.packet(new BitWriter().u8(FEATURE_OP.resetMotion).i32(id).finish());
    expect(f.controller.engine.observedOwnCastSettled()).toBe(true); expect(f.actions()).toEqual([{ type: 'useItem', itemId: 601 }]);
    f.advance(1000); expect(f.actions()).toHaveLength(1);
  });
  it('does not treat ResetMotion as settlement for another observed skill before threat escape', () => {
    const f = setup(movementThreatPolicy()); f.start(); f.packet(observedCastStart()); f.packet(attack()); f.advance(250);
    f.packet(new BitWriter().u8(FEATURE_OP.resetMotion).i32(1).finish());
    expect(f.controller.engine.observedOwnCastSettled()).toBe(false); expect(f.actions()).toHaveLength(0);
    f.packet(observedCastStop()); expect(f.actions()).toHaveLength(1);
  });
});

import { describe, expect, it, vi } from 'vitest';
import { CompanionController, type ControllerAction } from './controller';
import { BotEngine, type Action } from './engine';
import { DEFAULT_AUTOMATION, DEFAULT_ESCAPE, DEFAULT_SETTINGS } from './settings';
import { type Entity, type GameEvent, OP } from './protocol';
import { type FeatureEvent, FEATURE_OP } from './protocol-feature';
import { BitWriter } from './binary';
import { WORLD_OP } from './world-protocol';
import type { WalkGrid } from './navigation';
import { dispositionContextFromStatus } from './disposition-ui';
import { planDisposition } from './disposition';

const player: Entity = { id: 1, classId: 0, name: 'Test', kind: 0, level: 7, hp: 100, maxHp: 100, x: 100, y: 100, dead: false };
const monster: Entity = { id: 2, classId: 4000, name: 'Poring', kind: 1, level: 1, hp: 10, maxHp: 10, x: 101, y: 100, dead: false };
const grid: WalkGrid = { width: 200, height: 200, walkable: () => true };
const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
function setup() {
  let now = 100_000; const sent: Array<Action | ControllerAction> = [];
  const controller = new CompanionController(action => sent.push(action), () => now, map => map === 'unknown' ? null : grid);
  controller.connect(true);
  const receive = (...events: Array<GameEvent | FeatureEvent>) => { controller.engine.receive(events);
    for (const event of events) if (event.type === 'enter' || event.type === 'map') controller.world.reset(event.map);
    controller.tick(); };
  receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } });
  const step = (ms = 100) => { now += ms; controller.tick(); };
  const advance = (ms: number) => { while (ms > 0) { const part = Math.min(ms, 100); step(part); ms -= part; } };
  const packet = (writer: BitWriter) => controller.receive(writer.finish());
  return { controller, sent, receive, step, advance, packet, time: () => now };
}
function policy() { return structuredClone(DEFAULT_AUTOMATION); }
const routine = (action: ControllerAction, durationSeconds = 20) => ({ name: 'Test', durationSeconds, maxActions: 2,
  rules: [{ name: 'Act', priority: 1, maxRuns: 2, cooldownSeconds: 0, conditions: [{ field: 'hpPercent', operator: 'gte', value: 0 }], action }] });

describe('persistent field run ownership', () => {
  it('uses cart receipt weights in the authoritative snapshot and disposition preview', () => {
    const { controller, receive, packet, sent }=setup();
    receive({type:'stats',level:7,hp:100,maxHp:100,zeny:1000,weight:210,maxWeight:10000,cartWeight:79900},
      {type:'inventory',items:[{bagId:501,itemId:501,type:1,count:3}],equipment:[],ammoId:-1},
      {type:'skills',learned:[{skillId:73,level:1}]});
    controller.world.replaceCart([{bagId:501,itemId:501,type:1,count:1140},{bagId:512,itemId:512,type:1,count:5}]);
    const policy={maxSpend:0,rules:[{itemId:501,keep:0,minimum:0,desired:0,maximum:1,store:false,sell:false,cart:true,restock:'off' as const,allowUnique:false}]};
    const context=()=>dispositionContextFromStatus({...controller.snapshot(),sessionId:'test',connectionId:1});
    expect(planDisposition(policy,context()).actions[0]?.count).toBe(1);
    packet(new BitWriter().u8(WORLD_OP.cart).u8(1).i32(501).u8(1).i32(501).i16(1141).i16(1).i32(79970).i32(140));
    receive({type:'inventoryDelta',add:false,bagId:501,change:1,weight:140});
    expect(controller.snapshot().character.stats).toMatchObject({cartWeight:79970,weight:140});
    const result=planDisposition(policy,context());expect(result.actions).toEqual([]);expect(result.unmet[0]?.count).toBe(1);
    expect(sent).toEqual([]);
  });
  it('keeps canceled ground execution fenced until the exact requested coordinate is confirmed',()=>{
    const {controller,receive,packet}=setup();const automation=policy();automation.combat.mode='off';
    receive({type:'spawn',entity:{...player,statuses:[],sp:200,maxSp:200}},{type:'inventory',items:[],equipment:Array(10).fill(0),ammoId:-1},{type:'skills',learned:[{skillId:19,level:1}]});
    controller.start({...settings,automation});controller.pause('External owner',60_000);
    controller.engine.manualAction({type:'skill',mode:'ground',skillId:19,level:1,position:{x:105,y:100}});
    controller.tick();controller.pause('Temporary interruption',60_000);
    expect(controller.snapshot().reason).toContain('Waiting for a confirmed result');
    const ground=(y:number)=>new BitWriter().u8(FEATURE_OP.skill).u8(4).i32(1).position({x:105,y}).u8(19).u8(1).u8(0).position({x:100,y:100}).f32(1.5);
    packet(ground(101));expect(controller.snapshot().reason).toContain('Waiting for a confirmed result');
    packet(ground(100));expect(controller.snapshot().reason).not.toContain('Waiting for a confirmed result');
    expect(controller.runRequested).toBe(true);expect(controller.engine.running).toBe(false);
  });
  it.each([0,2])('settles a late canceled bolt before emergency escape when motion is %s seconds', motion => {
    const {controller,receive,packet,sent,step}=setup();const automation=policy();
    automation.escape={...DEFAULT_ESCAPE,enabled:true};
    automation.attackStrategies=[{id:'open',speciesIds:[4000],skillId:11,level:1,behavior:'opener',maxAttempts:1,maxUses:1,cooldownSeconds:1}];
    receive({type:'spawn',entity:{...player,statuses:[],sp:200,maxSp:200}},
      {type:'inventory',items:[{bagId:601,itemId:601,type:1,count:2}],equipment:Array(10).fill(0),ammoId:-1},
      {type:'skills',learned:[{skillId:11,level:1}]});
    controller.start({...settings,automation});step();
    expect(sent.filter(a=>a.type==='skill')).toHaveLength(1);
    packet(new BitWriter().u8(OP.heal).i32(1).i32(0).i32(20).i32(100));
    for(let n=0;n<31;n++){step(1000);packet(new BitWriter().u8(FEATURE_OP.sp).i32(200).i32(200));}
    packet(new BitWriter().u8(FEATURE_OP.skill).u8(1).i32(1).i32(1).i32(2).u8(11).u8(1).u8(0)
      .position({x:100,y:100}).i32(1).u8(0).u8(1).f32(motion).f32(0).bool(false));
    expect(controller.engine.featureActionsSettled).toBe(false);
    step(Math.max(1,motion)*1000-1);
    expect(sent.filter(a=>a.type==='useItem')).toHaveLength(0);
    expect(controller.engine.featureActionsSettled).toBe(false);
    step(1);step(250);
    expect(sent.filter(a=>a.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
    expect(sent.filter(a=>a.type==='skill')).toHaveLength(1);
  });
  it('keeps a low HP run waiting and resumes only after authoritative recovery', () => {
    const { controller, sent, receive, step } = setup(); controller.start(settings); step();
    receive({ type: 'hit', id: 1, damage: 80, position: { x: 100, y: 100 } });
    expect(controller.snapshot()).toMatchObject({ runRequested: true, running: false, state: 'waiting' });
    const count = sent.length; step(); expect(sent).toHaveLength(count);
    receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 }); step();
    expect(controller.snapshot()).toMatchObject({ runRequested: true, running: true, state: 'running' });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
  });
  it('starts a low HP request in waiting instead of dropping its intent', () => {
    const { controller, receive, step } = setup(); receive({ type: 'hit', id: 1, damage: 80, position: { x: 100, y: 100 } });
    controller.start(settings); expect(controller.runRequested).toBe(true); expect(controller.engine.running).toBe(false);
    receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 }); step(); expect(controller.engine.running).toBe(true);
  });
  it('rebinds the map while preserving selected species and ignoring unselected monsters', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings); step();
    receive({ type: 'map', map: 'prt_fild05' }); expect(controller.runRequested).toBe(true);
    receive({ type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster, classId: 4002 } }); step();
    expect(controller.engine.settings).toMatchObject({ map: 'prt_fild05', targets: [4000] });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(1);
    receive({ type: 'spawn', entity: { ...monster, id: 3 } }); step(); expect(sent.at(-1)).toEqual({ type: 'attack', id: 3 });
  });
  it('waits on unknown ground and an unsupported build without sending commands', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings);
    receive({ type: 'map', map: 'unknown' }, { type: 'spawn', entity: { ...player } }); const count = sent.length;
    step(); expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true }); expect(sent).toHaveLength(count);
    controller.connect(false); receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } });
    step(); expect(controller.snapshot().state).toBe('waiting'); expect(sent).toHaveLength(count);
  });
  it('preserves intent through disconnect and ignores packets from the former connection generation', () => {
    const { controller, receive, sent, packet, step } = setup(); controller.start(settings); step();
    const old = controller.connectionGeneration; controller.disconnect(); expect(controller.runRequested).toBe(true);
    const count = sent.length; step(); expect(sent).toHaveLength(count); controller.connect(true);
    controller.receive(new BitWriter().u8(OP.map).string('wrong_map').finish(), old);
    expect(controller.engine.map).toBe('');
    receive({ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster } });
    packet(new BitWriter().u8(OP.heal).i32(1).i32(1).i32(100).i32(100)); step();
    expect(controller.engine.running).toBe(true); expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
  });
  it('yields for manual input and resumes after two seconds, but client Stop cancels retries', () => {
    const { controller, sent, step, advance } = setup(); controller.start(settings); step();
    controller.pause('Manual input', 2000); const count = sent.length; advance(1900); expect(sent).toHaveLength(count);
    step(100); step(); expect(controller.engine.running).toBe(true); expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
    controller.stop(); advance(3000); expect(controller.snapshot()).toMatchObject({ runRequested: false, state: 'idle', running: false });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(2);
  });
  it('pauses on lost client heartbeat and resumes only after it returns', () => {
    const { controller, sent, advance, step } = setup(); controller.start(settings); step(); controller.heartbeat(false);
    const count = sent.length; advance(1000); expect(sent).toHaveLength(count); expect(controller.snapshot().state).toBe('waiting');
    controller.heartbeat(true); step(); step(); expect(controller.engine.running).toBe(true);
  });
  it('preserves finite kill budgets through recovery and map rebinds', () => {
    const { controller, receive, step } = setup(); const automation = policy(); automation.limits.kills = 1;
    controller.start({ ...settings, automation }); step(); receive({ type: 'death', id: 2 });
    expect(controller.snapshot()).toMatchObject({ kills: 1, runRequested: true, state: 'waiting' });
    receive({ type: 'map', map: 'prt_fild05' }, { type: 'spawn', entity: { ...player } }, { type: 'spawn', entity: { ...monster, id: 3 } });
    step(); expect(controller.engine.running).toBe(false); expect(controller.snapshot().reason).toContain('session limit');
  });
  it('does not duplicate an item after an uncertain six-second result', () => {
    const { controller, receive, sent, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 1 }];
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); advance(7000);
    expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true });
    expect(controller.snapshot().reason).toContain('Waiting for a confirmed result');
    receive({ type: 'inventoryDelta', add: false, bagId: 501, change: 1, weight: 10 }); advance(1000);
    expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
  });
  it('waits for revival when automatic respawn is disabled and retains the death budget', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings); step(); receive({ type: 'death', id: 1 });
    expect(controller.snapshot()).toMatchObject({ runRequested: true, state: 'waiting', deaths: 1 });
    expect(sent.some(action => action.type === 'respawn')).toBe(false);
    receive({ type: 'resurrection', id: 1, hp: 100, position: { x: 100, y: 100 } }); step();
    expect(controller.engine.running).toBe(true); expect(controller.engine.deaths).toBe(1);
  });
  it('confirms same-map respawn only after an alive self spawn, then resumes the requested run', () => {
    const { controller, receive, sent, step } = setup(); const automation = policy(); automation.respawn.enabled = true;
    controller.start({ ...settings, automation }); step(); receive({ type: 'death', id: 1 }); step();
    expect(sent.at(-1)).toEqual({ type: 'respawn' }); receive({ type: 'clear' });
    expect(controller.engine.actionResult.status).toBe('pending'); expect(controller.engine.running).toBe(false);
    receive({ type: 'spawn', entity: { ...monster, id: 3 } }); expect(controller.engine.actionResult.status).toBe('pending');
    receive({ type: 'spawn', entity: { ...player } }); step();
    expect(controller.engine.actionResult.status).toBe('confirmed'); expect(controller.engine.running).toBe(true);
    expect(controller.engine.deaths).toBe(1);
  });
  it('resumes after an unsolicited refresh without falsely confirming respawn', () => {
    const { controller, receive, step } = setup(); controller.start(settings); step(); receive({ type: 'clear' });
    expect(controller.engine.actionResult.status).toBe('idle'); expect(controller.runRequested).toBe(true);
    receive({ type: 'spawn', entity: { ...player } }); step(); expect(controller.engine.running).toBe(true);
  });
  it('blocks field Start during a confirmed NPC interaction and resumes after it ends', () => {
    const { controller, packet, step } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false }); controller.start(settings);
    expect(controller.snapshot().state).toBe('waiting'); expect(controller.engine.running).toBe(false);
    packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); step(); expect(controller.engine.running).toBe(true);
  });
});

describe('latency and confirmation ownership', () => {
  it('reacts to an incoming packet immediately and starts the next action at 100 ms', () => {
    const { controller, sent, packet, step } = setup(); controller.start(settings); step();
    controller.engine.entities.delete(2); controller.engine.entities.set(3, { ...monster, id: 3 }); step();
    packet(new BitWriter().u8(OP.remove).i32(2).bool(false));
    expect(sent.at(-1)).toEqual({ type: 'attack', id: 3 });
  });
  it('uses a short loot settling delay while preserving own-kill attribution', () => {
    const { controller, sent, receive, step } = setup(); controller.start(settings); step();
    receive({ type: 'death', id: 2 }, { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    step(100); expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
    step(50); expect(sent.at(-1)).toEqual({ type: 'pickup', id: 9 }); step();
    expect(sent.filter(action => action.type === 'pickup')).toHaveLength(1);
  });
  it('credits a confirmed own targeted skill kill and permits its new loot', () => {
    const { controller, receive, sent, step } = setup(); const automation = policy();
    automation.skills = [{ skillId: 3, level: 1, target: 'enemy', hpBelowPercent: 100, spAbovePercent: 0, cooldownSeconds: 10 }];
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    controller.start({ ...settings, automation }); step(); expect(sent.at(-1)?.type).toBe('skill');
    receive({ type: 'skillResult', source: 1, target: 2, skillId: 3, level: 1, mode: 'target', indirect: false, motionSeconds: 0, position: { x: 100, y: 100 }, damage: 10 },
      { type: 'death', id: 2 }, { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    expect(controller.engine.kills).toBe(1); step(150); expect(sent.at(-1)).toEqual({ type: 'pickup', id: 9 });
  });
  it('never counts an indirect or foreign skill kill as its own', () => {
    const { controller, receive } = setup(); controller.start(settings);
    receive({ type: 'skillResult', source: 9, target: 2, skillId: 3, level: 1, mode: 'target', indirect: false, motionSeconds: 0, position: { x: 100, y: 100 } }, { type: 'death', id: 2 });
    expect(controller.engine.kills).toBe(0);
  });
  it('quarantines canceled world commands so a late response cannot confirm a replacement', () => {
    const { controller, packet, advance } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('command', { type: 'npcAdvance' }); controller.stop();
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late').bool(false));
    expect(controller.active).toBe(false); advance(10_000);
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('waits for skill motion before debiting and dispatching the next routine action', () => {
    const { controller, receive, sent, step, advance } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 2, level: 1 }] });
    controller.perform('routine', routine({ type: 'skill', mode: 'self', skillId: 2, level: 1 })); step();
    receive({ type: 'skillResult', source: 1, skillId: 2, level: 1, mode: 'self', indirect: false, motionSeconds: 2, position: { x: 100, y: 100 } });
    expect(controller.routine.snapshot().actionsIssued).toBe(1); advance(1900); expect(sent).toHaveLength(1);
    step(100); expect(sent).toHaveLength(2); expect(controller.routine.snapshot().actionsIssued).toBe(2);
  });
  it('expires the owning routine before sending its not-yet-started resource step', () => {
    const { controller, receive, sent, step } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'shopOpened', mode: 'buy', discountLevel: 0, entries: [{ itemId: 501, price: 10 }] });
    controller.perform('routine', routine({ type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] }, 1)); step(500); step(500);
    expect(sent).toEqual([]); expect(controller.routine.snapshot().state).toBe('failed'); expect(controller.workflow.snapshot().running).toBe(false);
  });
  it('rejects a distant manual skill and sends Stop for a canceled pending manual skill', () => {
    const { controller, receive, sent } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    controller.engine.entities.get(2)!.x = 110;
    expect(() => controller.perform('command', { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 })).toThrow('Move next');
    controller.engine.entities.get(2)!.x = 101;
    controller.perform('command', { type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 }); controller.stop();
    expect(sent.map(action => action.type)).toEqual(['skill', 'stop']);
  });
  it('sends Stop for a manual skill timeout even when the field engine was idle', () => {
    let now = 100_000; const sent: Action[] = []; const engine = new BotEngine(action => sent.push(action), () => now, () => grid);
    engine.connect(true); engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } },
      { type: 'spawn', entity: { ...monster } }, { type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] }]);
    engine.manualAction({ type: 'skill', mode: 'target', skillId: 3, level: 1, target: 2 }); now += 30_000; engine.tick();
    expect(sent.map(action => action.type)).toEqual(['skill', 'stop']);
  });
});

describe('persistent recovery and transaction regressions', () => {
  it('holds at the weight limit without a 100 ms Stop/restart storm', () => {
    const { controller, receive, sent, advance, step } = setup(); const automation = policy(); automation.limits.weightPercent = 50;
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, weight: 50, maxWeight: 100 });
    controller.start({ ...settings, automation }); advance(1000);
    expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true }); expect(sent).toEqual([]);
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, weight: 40, maxWeight: 100 }); step();
    expect(controller.engine.running).toBe(true); expect(sent.at(-1)).toEqual({ type: 'attack', id: 2 });
  });
  it('backs off missing feature prerequisites without repeated Stop packets', () => {
    const { controller, sent, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 80, minStock: 0, cooldownSeconds: 1 }];
    controller.start({ ...settings, automation }); advance(1000);
    expect(controller.snapshot().state).toBe('waiting'); expect(sent.filter(action => action.type === 'stop')).toHaveLength(1);
  });
  it('does not resume a retained run on a different character', () => {
    const { controller, receive, sent, step } = setup(); controller.start(settings); step(); controller.disconnect(); controller.connect(true);
    receive({ type: 'enter', id: 9, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player, id: 9, name: 'Other' } }, { type: 'spawn', entity: { ...monster } }); step();
    expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true });
    expect(sent.filter(action => action.type === 'attack')).toHaveLength(1);
    expect(controller.snapshot().reason).toContain('originally selected character');
  });
  it('resumes a canceled sit after the existing deadline without a permanent resource hold', () => {
    const { controller, receive, sent, step, advance } = setup(); const automation = policy(); automation.recovery.enabled = true;
    receive({ type: 'stats', level: 7, hp: 55, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 1, level: 2 }] });
    controller.start({ ...settings, automation }); step(); expect(sent.at(-1)).toEqual({ type: 'sit', sitting: true });
    controller.pause('Manual input', 2000); receive({ type: 'sit', id: 1, sitting: true }); advance(6000);
    expect(controller.engine.running).toBe(true); expect(controller.snapshot().reason).not.toContain('Stop and Start');
    expect(sent.filter(action => action.type === 'sit')).toHaveLength(1);
  });
  it('drains a late consumed-item receipt and respects its cooldown before continuing', () => {
    const { controller, receive, sent, packet, step, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 10 }];
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); step(); controller.pause('Manual input', 2000);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(10).bool(false));
    advance(9000); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    // Fresh HP update confirms the policy no longer needs another consumable.
    automation.items[0]!.belowPercent = 90;
    controller.engine.player!.hp = 100; controller.stop();
    expect(controller.runRequested).toBe(false);
  });
  it('does not reopen an unresolved NPC request just because ten seconds elapsed', () => {
    const { controller, advance, packet } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('command', { type: 'npcAdvance' }); controller.stop(); advance(10_100);
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late').bool(false));
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('keeps the desired lock-map return through low HP and manual yielding', () => {
    const { controller, receive, step } = setup(); const automation = policy(); automation.respawn.enabled = true; automation.travel.returnToLockMap = true;
    controller.start({ ...settings, automation }); step(); receive({ type: 'death', id: 1 });
    const travelStart = vi.spyOn(controller.travel, 'start').mockImplementation(() => {});
    receive({ type: 'map', map: 'prontera' }, { type: 'spawn', entity: { ...player, hp: 20 } });
    controller.pause('Manual input', 2000); receive({ type: 'heal', id: 1, hp: 100, maxHp: 100 });
    step(2000); expect(travelStart).toHaveBeenLastCalledWith('prontera', expect.anything(), 'prt_fild08', settings.route_step, settings.route_avoidWalls);
    expect(controller.engine.running).toBe(false);
  });
  it('lets a 12-second manual or routine skill finish before its 30-second deadline', () => {
    const { controller, receive, sent, step, advance } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 2, level: 1 }] });
    controller.perform('routine', routine({ type: 'skill', mode: 'self', skillId: 2, level: 1 }, 60)); step(); advance(12_000);
    expect(controller.routine.snapshot()).toMatchObject({ state: 'waiting', actionsIssued: 1 });
    expect(sent).toHaveLength(1);
    receive({ type: 'skillResult', source: 1, skillId: 2, level: 1, mode: 'self', indirect: false, motionSeconds: 2, position: { x: 100, y: 100 } });
    expect(controller.routine.snapshot().actionsCompleted).toBe(1);
  });
  it('uses the existing owned travel path to leave a verified portal arrival', () => {
    const sent: Action[] = [];
    const portalGrid = { ...grid, portals: [{ x: 100, y: 100, halfWidth: 1, halfHeight: 1 }] };
    const controller = new CompanionController(action => sent.push(action as Action), () => 100_000, () => portalGrid);
    controller.connect(true); controller.engine.receive([{ type: 'enter', id: 1, map: 'prt_fild08' }, { type: 'spawn', entity: { ...player } }]);
    controller.world.reset('prt_fild08'); const start = vi.spyOn(controller.travel, 'start').mockImplementation(() => {});
    controller.start(settings); expect(start).toHaveBeenCalledWith('prt_fild08', expect.anything(), 'prt_fild08', settings.route_step, settings.route_avoidWalls);
    expect(sent).toEqual([]);
  });
  it('does not credit another character finishing a monster after an own nonlethal skill', () => {
    const { controller, receive, sent, step } = setup(); const automation = policy();
    automation.skills = [{ skillId: 3, level: 1, target: 'enemy', hpBelowPercent: 100, spAbovePercent: 0, cooldownSeconds: 10 }];
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, sp: 100, maxSp: 100 }, { type: 'skills', learned: [{ skillId: 3, level: 1 }] });
    controller.start({ ...settings, automation }); step();
    receive({ type: 'skillResult', source: 1, target: 2, skillId: 3, level: 1, mode: 'target', indirect: false, motionSeconds: 0, position: { x: 100, y: 100 }, damage: 1 },
      { type: 'skillImpact', source: 9, target: 2, skillId: 3, position: { x: 101, y: 100 }, damage: 10, damageSeconds: 0, hits: 1, result: 0 },
      { type: 'death', id: 2 }, { type: 'drop', drop: { id: 9, itemId: 909, count: 1, isNew: true, x: 101, y: 100 } });
    step(150); expect(controller.engine.kills).toBe(0); expect(sent.some(action => action.type === 'pickup')).toBe(false);
  });
  it('confirms a vendor response with an owner ID distinct from its visible proxy without a focus packet', () => {
    const { controller, packet } = setup(); controller.engine.actors.set(7, { ...player, id: 7, kind: 2 });
    controller.perform('command', { type: 'vendingView', id: 7 });
    packet(new BitWriter().u8(WORLD_OP.vendingView).i32(999).string('Vendor').i32(0));
    expect(controller.active).toBe(false); expect(controller.world.viewedVending?.id).toBe(999);
  });
  it('confirms an exact vendor receipt when NPC end precedes inventory and balance updates', () => {
    const { controller, receive, packet } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'vendingViewed', id: 999, name: 'Vendor', entries: [{ item: { bagId: 501, itemId: 501, type: 1, count: 5 }, price: 10 }] });
    controller.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 2 }] });
    packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); expect(controller.active).toBe(true);
    controller.engine.receive([{ type: 'inventoryDelta', add: true, bagId: 501, change: 2, weight: 10, item: { bagId: 501, itemId: 501, type: 1, count: 2 } }, { type: 'currency', zeny: 80 }]);
    controller.receive(Uint8Array.of(200)); expect(controller.active).toBe(false); expect(controller.engine.reason).toContain('confirmed');
  });
  it('confirms a unique cart deposit with a new destination bag ID and matching GUID', () => {
    const { controller, receive, packet } = setup(); const guid = '000102030405060708090a0b0c0d0e0f';
    receive({ type: 'inventory', items: [{ bagId: 10001, itemId: 1101, type: 2, count: 1, guid }], cart: [], equipment: [], ammoId: -1 }, { type: 'skills', learned: [{ skillId: 73, level: 1 }] });
    controller.world.replaceCart([]); controller.perform('command', { type: 'cart', direction: 1, bagId: 10001, count: 1 });
    const moved = new BitWriter().u8(WORLD_OP.cart).u8(1).i32(10002).u8(2).i32(1101).i16(1).u8(0).u8(0).take(Uint8Array.from({ length: 16 }, (_, i) => i));
    for (let i = 0; i < 4; i++) moved.i32(0);
    packet(moved.i16(1).i32(100).i32(0)); expect(controller.active).toBe(true);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(10001).i16(1).i32(0).bool(false));
    expect(controller.active).toBe(false); expect(controller.world.cart.get(10002)?.guid).toBe(guid);
  });
});

describe('canceled world receipt reconciliation', () => {
  it('drains a canceled vendor-view response using its retained proxy ownership', () => {
    const { controller, packet, advance } = setup(); controller.engine.actors.set(7, { ...player, id: 7, kind: 2 });
    controller.perform('command', { type: 'vendingView', id: 7 }); controller.stop();
    packet(new BitWriter().u8(WORLD_OP.vendingView).i32(999).string('Vendor').i32(0));
    advance(10_000); controller.world.apply({ type: 'npcEnd' });
    expect(() => controller.perform('command', { type: 'vendingView', id: 7 })).not.toThrow();
  });
  it('drains canceled cart ownership only after its matching transfer and source decrease', () => {
    const { controller, receive, packet, advance } = setup();
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], cart: [], equipment: [], ammoId: -1 }, { type: 'skills', learned: [{ skillId: 73, level: 1 }] });
    controller.world.replaceCart([]); controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 }); controller.stop();
    packet(new BitWriter().u8(WORLD_OP.cart).u8(1).i32(501).u8(1).i32(501).i16(1).i16(1).i32(10).i32(30));
    advance(10_000); expect(() => controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 })).toThrow();
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(30).bool(false));
    expect(() => controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 })).not.toThrow();
  });
  it('drains a canceled vending purchase using its captured exact receipt', () => {
    const { controller, receive, advance } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'vendingViewed', id: 999, name: 'Vendor', entries: [{ item: { bagId: 501, itemId: 501, type: 1, count: 5 }, price: 10 }] });
    controller.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 1 }] }); controller.stop(); advance(10_000);
    controller.engine.receive([{ type: 'inventoryDelta', add: true, bagId: 501, change: 1, weight: 10, item: { bagId: 501, itemId: 501, type: 1, count: 1 } }, { type: 'currency', zeny: 90 }]);
    controller.receive(Uint8Array.of(200));
    expect(() => controller.perform('command', { type: 'vendingPurchase', rows: [{ id: 501, count: 1 }] })).not.toThrow();
  });
});

describe('world retirement and heartbeat deadline regressions', () => {
  it('keeps a confirmed consumable cooldown through the real one-second heartbeat cadence', () => {
    const { controller, receive, sent, packet, step, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 100, minStock: 0, cooldownSeconds: 10 }];
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], equipment: [], ammoId: -1 });
    controller.start({ ...settings, automation }); step(); advance(6000);
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(30).bool(false));
    for (let second = 0; second < 9; second++) { controller.heartbeat(true); advance(1000); }
    controller.heartbeat(true); advance(900); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(1);
    advance(100); step(); expect(sent.filter(action => action.type === 'useItem')).toHaveLength(2);
  });
  it('keeps prerequisite retry backoff while the client heartbeat remains healthy', () => {
    const { controller, sent, advance } = setup(); const automation = policy();
    automation.items = [{ itemId: 501, resource: 'hp', belowPercent: 80, minStock: 0, cooldownSeconds: 1 }];
    controller.start({ ...settings, automation }); advance(100);
    for (let second = 0; second < 4; second++) { controller.heartbeat(true); advance(1000); }
    expect(sent.filter(action => action.type === 'stop')).toHaveLength(1); expect(controller.engine.running).toBe(false);
  });
  it('retires a normally timed-out world request until its late response drains', () => {
    const { controller, advance, packet } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('command', { type: 'npcAdvance' }); advance(10_100);
    expect(controller.active).toBe(false);
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late first response').bool(false));
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('retires a sent workflow after failure, even when it has no manual pending wrapper', () => {
    const { controller, receive, step, advance, packet } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true }); controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('workflow', { name: 'Dialog', map: settings.map, npcId: 7, maxSpend: 0, minStock: [], steps: [{ type: 'advance' }] });
    step(); advance(10_100); expect(controller.workflow.snapshot().state).toBe('failed');
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late workflow response').bool(false));
    expect(() => controller.perform('command', { type: 'npcAdvance' })).not.toThrow();
  });
  it('retires a sent one-step resource workflow after its unconfirmed timeout', () => {
    const { controller, receive, step, advance, packet } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'shopOpened', mode: 'buy', discountLevel: 0, entries: [{ itemId: 501, price: 10 }] });
    controller.perform('command', { type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] }); step(); advance(10_100);
    expect(() => controller.perform('command', { type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); controller.start(settings);
    expect(controller.runRequested).toBe(true);
  });
  it('retains sent world ownership when its parent routine duration ends', () => {
    const { controller, step, packet } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false });
    controller.perform('routine', routine({ type: 'npcAdvance' }, 1)); step(500); step(500);
    expect(controller.routine.snapshot().state).toBe('failed');
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
    packet(new BitWriter().u8(WORLD_OP.npc).u8(1).string('NPC').string('Late routine response').bool(false));
    // The original ten-second fence still applies even though the receipt drained.
    expect(() => controller.perform('command', { type: 'npcAdvance' })).toThrow();
  });
  it('does not create uncertain ownership for a queued resource step that was never sent', () => {
    const { controller, receive, step, packet, sent } = setup();
    receive({ type: 'stats', level: 7, hp: 100, maxHp: 100, zeny: 100 }, { type: 'inventory', items: [], equipment: [], ammoId: -1 });
    controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'shopOpened', mode: 'buy', discountLevel: 0, entries: [{ itemId: 501, price: 10 }] });
    controller.perform('routine', routine({ type: 'shop', mode: 'buy', rows: [{ id: 501, count: 1 }] }, 1)); step(500); step(500);
    expect(sent).toEqual([]); packet(new BitWriter().u8(WORLD_OP.npc).u8(3)); controller.start(settings);
    expect(controller.engine.running).toBe(true);
  });
  it('captures Start as waiting behind a canceled cart fence and resumes after the exact late receipt', () => {
    const { controller, receive, packet, advance, step, sent } = setup();
    receive({ type: 'inventory', items: [{ bagId: 501, itemId: 501, type: 1, count: 4 }], cart: [], equipment: [], ammoId: -1 }, { type: 'skills', learned: [{ skillId: 73, level: 1 }] });
    controller.world.replaceCart([]); controller.perform('command', { type: 'cart', direction: 1, bagId: 501, count: 1 }); controller.stop();
    expect(() => controller.start(settings)).not.toThrow(); expect(controller.snapshot()).toMatchObject({ state: 'waiting', runRequested: true });
    packet(new BitWriter().u8(WORLD_OP.cart).u8(1).i32(501).u8(1).i32(501).i16(1).i16(1).i32(10).i32(30));
    packet(new BitWriter().u8(FEATURE_OP.inventoryDelta).bool(false).i32(501).i16(1).i32(30).bool(false));
    expect(controller.engine.running).toBe(false); advance(10_000); step();
    expect(controller.engine.running).toBe(true); expect(sent.filter(action => action.type === 'attack')).toHaveLength(1);
    expect(sent.filter(action => action.type === 'cart')).toHaveLength(1);
  });
  it('still rejects Start while a manual command is actively awaiting its first result', () => {
    const { controller } = setup(); controller.world.apply({ type: 'npcFocus', id: 7, focus: true });
    controller.world.apply({ type: 'npcDialog', name: 'NPC', text: 'Hello', big: false }); controller.perform('command', { type: 'npcAdvance' });
    expect(() => controller.start(settings)).toThrow('Stop the current'); expect(controller.runRequested).toBe(false);
  });
});

describe('routine actor observations',()=>{
 it('passes typed cast evidence into routine decisions and ignores a superseded socket',()=>{
  const {controller,sent,receive,step,packet}=setup();
  receive({type:'spawn',entity:{...player,statuses:[]}});
  controller.perform('routine',{name:'Wait for idle cast',durationSeconds:30,maxActions:1,rules:[{name:'Stand',priority:0,cooldownSeconds:1,maxRuns:1,conditions:[{field:'actorCasting',actor:{scope:'self'},operator:'ne',value:true}],action:{type:'sit',sitting:false}}]});
  step();expect(sent).toEqual([]);
  packet(new BitWriter().u8(27).i32(1));step();expect(sent).toEqual([{type:'sit',sitting:false}]);
  controller.disconnect();controller.connect(true);
  controller.receive(new BitWriter().u8(27).i32(1).finish(),0);expect(controller.engine.snapshot().actorObservations.actors).toEqual([]);
 });
});

describe('persistent ammo and loadout receipts',()=>{
  function loadoutFixture(){const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.cooldownSeconds=1;automation.loadout.minAmmoStock=3;
    t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
    const inventory:FeatureEvent={type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:-1};
    t.receive(inventory);return {...t,automation,inventory};
  }
  it('keeps emergency escape behind an uncertain equipment receipt until exact reconciliation',()=>{
    const t=loadoutFixture();
    t.automation.escape={...DEFAULT_ESCAPE,enabled:true};
    t.receive({...t.inventory,items:[...t.inventory.items,{bagId:601,itemId:601,type:1,count:3}]});
    t.controller.start({...settings,automation:t.automation});t.step();
    expect(t.sent).toEqual([{type:'equip',bagId:1750,equipped:true}]);
    t.advance(7000);t.receive({type:'heal',id:1,hp:10,maxHp:100});t.advance(400);
    expect(t.controller.engine.featureActionsSettled).toBe(false);
    expect(t.sent.some(action=>action.type==='useItem')).toBe(false);
    t.receive({type:'equipment',bagId:1750,equipped:true,slot:13});t.advance(400);
    expect(t.sent.filter(action=>action.type==='equip')).toHaveLength(1);
    expect(t.sent.filter(action=>action.type==='useItem')).toEqual([{type:'useItem',itemId:601}]);
  });
  it('never replays an unconfirmed automatic equip through persistent resume, deadlines, unchanged snapshots or map refresh',()=>{
    const t=loadoutFixture();t.controller.start({...settings,automation:t.automation});t.step();expect(t.sent).toEqual([{type:'equip',bagId:1750,equipped:true}]);
    t.advance(12000);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.controller.engine.snapshot().loadout.state).toBe('fault');
    t.receive(t.inventory);t.advance(3000);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);
    t.receive({type:'map',map:'prt_fild05'},{type:'spawn',entity:{...player,classId:5,level:50}},{type:'spawn',entity:{...monster}});t.advance(3000);
    expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);
    t.packet(new BitWriter().u8(OP.equipment).i32(1750).u8(13).bool(true));t.step();t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  });
  it('keeps manual equipment overrides stopped until a new explicit Start',()=>{
    const t=loadoutFixture();t.controller.start({...settings,automation:t.automation});t.step();t.receive({type:'equipment',bagId:1750,slot:13,equipped:true});t.step();
    t.receive({type:'equipment',bagId:1750,slot:13,equipped:false});t.receive({type:'changeTarget',id:0});const count=t.sent.length;t.advance(6000);
    expect(t.sent).toHaveLength(count);expect(t.controller.engine.running).toBe(false);
    t.controller.stop();t.controller.start({...settings,automation:t.automation});t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(2);
  });
  it('does not admit unrelated ServerEvent ammo faults while loadout policy is disabled',()=>{
    const t=setup();t.receive({type:'serverEvent',event:4,value:0,text:''});expect(t.controller.engine.idleForActions()).toBe(true);expect(t.controller.engine.snapshot().loadout.state).toBe('off');
    t.controller.start(settings);t.step();expect(t.sent).toEqual([{type:'attack',id:2}]);
  });
  it('holds a fired reserve until both target clear and a new valid stock receipt, with no auto equip fallback',()=>{
    const t=loadoutFixture();t.inventory={...t.inventory,type:'inventory',ammoId:1750} as Extract<FeatureEvent,{type:'inventory'}>;t.receive(t.inventory);t.controller.start({...settings,automation:t.automation});t.step();
    t.receive({type:'inventoryDelta',add:false,bagId:1750,change:17,weight:0});t.receive({type:'changeTarget',id:0});t.advance(6000);
    expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(0);
    t.packet(new BitWriter().u8(OP.inventoryDelta).bool(true).u8(1).i32(1750).i16(17).i32(0).i32(1750).i16(20));t.step();
    expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(2);
  });
});
describe('loadout manual-yield intent',()=>{
 it('keeps an observation baseline during pointer yield, so manual equipment cancels automatic override until explicit Start',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.autoAmmo=false;automation.equipment=[{itemId:1701,hpBelowPercent:100,monsterClassId:0}];
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  t.receive({type:'inventory',items:[{bagId:1001,itemId:1101,type:2,count:1,guid:'sword'},{bagId:1002,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:1750});
  t.controller.start({...settings,automation});t.step();t.receive({type:'equipment',bagId:1001,slot:4,equipped:false},{type:'equipment',bagId:1002,slot:4,equipped:true});
  t.controller.pause('Yielding briefly to manual game input.',2000);
  t.receive({type:'equipment',bagId:1002,slot:4,equipped:false},{type:'equipment',bagId:1001,slot:4,equipped:true},{type:'changeTarget',id:0});t.advance(7000);
  expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1002,equipped:true}]);expect(t.controller.engine.running).toBe(false);
  t.controller.stop();t.controller.start({...settings,automation});t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(2);
 });
 it('selects a fresh compatible alternate stack only after target clear and waits for slot13 before a new attack',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.minAmmoStock=3;automation.loadout.cooldownSeconds=1;
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  const inventory:Extract<FeatureEvent,{type:'inventory'}>={type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:4}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:1750};
  t.receive(inventory);t.controller.start({...settings,automation});t.step();
  t.receive({type:'inventoryDelta',add:false,bagId:1750,change:1,weight:0});t.advance(6000);expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(0);
  t.packet(new BitWriter().u8(OP.inventoryDelta).bool(true).u8(1).i32(1751).i16(20).i32(0).i32(1751).i16(20));t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(0);
  t.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));t.step();expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1751,equipped:true}]);expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);
  t.packet(new BitWriter().u8(OP.equipment).i32(1751).u8(13).bool(true));t.step();expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(2);
 });
});
describe('late manual equipment receipts',()=>{
 it('retains the observation baseline through persistent resume when a manual gear ACK arrives after the input yield',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.autoAmmo=false;automation.equipment=[{itemId:1701,hpBelowPercent:100,monsterClassId:0}];
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  t.receive({type:'inventory',items:[{bagId:1001,itemId:1101,type:2,count:1,guid:'sword'},{bagId:1002,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:1750});
  t.controller.start({...settings,automation});t.step();t.receive({type:'equipment',bagId:1001,slot:4,equipped:false},{type:'equipment',bagId:1002,slot:4,equipped:true});
  t.controller.pause('Yielding briefly to manual game input.',2000);t.packet(new BitWriter().u8(FEATURE_OP.changeTarget).i32(0));t.advance(2500);
  expect(t.controller.engine.running).toBe(true);
  t.receive({type:'equipment',bagId:1002,slot:4,equipped:false},{type:'equipment',bagId:1001,slot:4,equipped:true},{type:'changeTarget',id:0});t.advance(7000);
  expect(t.controller.engine.running).toBe(false);expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1002,equipped:true}]);
 });
});
describe('loadout receipt survival through external revival',()=>{
 it('preserves an in-flight equip fence through death/resurrection until exact late readback, without resending',()=>{
  const t=setup(),automation=policy();automation.loadout.enabled=true;automation.loadout.minAmmoStock=3;
  t.controller.engine.player!.classId=5;t.controller.engine.player!.level=50;
  t.receive({type:'inventory',items:[{bagId:1001,itemId:1701,type:2,count:1,guid:'bow'},{bagId:1750,itemId:1750,type:1,count:20}],equipment:[0,0,0,0,1001,0,0,0,0,0],ammoId:-1});
  t.controller.start({...settings,automation});t.step();expect(t.sent.filter(a=>a.type==='equip')).toEqual([{type:'equip',bagId:1750,equipped:true}]);
  t.receive({type:'death',id:1});t.receive({type:'resurrection',id:1,hp:100,position:{x:100,y:100}});t.advance(12000);
  expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.controller.engine.running).toBe(false);expect(t.controller.engine.snapshot().loadout.state).toBe('fault');
  t.packet(new BitWriter().u8(OP.equipment).i32(1750).u8(13).bool(true));t.step();t.step();expect(t.sent.filter(a=>a.type==='equip')).toHaveLength(1);expect(t.sent.filter(a=>a.type==='attack')).toHaveLength(1);
 });
});

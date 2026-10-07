import { describe, expect, it } from 'vitest';
import { CompanionController } from './controller';
import { BitWriter } from '../../shared/binary';
import { OP, type Entity } from '../protocol/protocol';
import { FEATURE_OP } from '../protocol/protocol-feature';
import { DEFAULT_SETTINGS } from '../settings/settings';

const settings = { ...DEFAULT_SETTINGS, map: 'prt_fild08', targets: [4000] };
const player: Entity = {
  id: 1,
  classId: 0,
  kind: 0,
  name: 'Test',
  level: 7,
  hp: 100,
  maxHp: 100,
  x: 100,
  y: 100,
  dead: false,
};
function spawn(entity = player, entry = 1): Uint8Array {
  const name = new TextEncoder().encode(entity.name);
  const body = new BitWriter()
    .u8(15)
    .i32(entity.id)
    .i32(entity.classId)
    .i32(0)
    .i32(~name.length)
    .i32(entity.name.length)
    .take(name)
    .u8(entity.kind)
    .u8(0)
    .u8(0)
    .i32(entity.x)
    .i32(entity.y)
    .u8(entity.level)
    .i32(entity.hp)
    .i32(entity.maxHp)
    .i32(0)
    .i32(0)
    .i32(0)
    .u8(0)
    .finish();
  return new BitWriter().u8(OP.spawn).u8(entry).i32(body.length).take(body).finish();
}
function fixture() {
  let now = 100_000;
  const controller = new CompanionController(
    () => {},
    () => now,
    () => ({ width: 200, height: 200, walkable: () => true }),
  );
  const enter = (hp = player.hp) => {
    controller.connect(true);
    controller.receive(new BitWriter().u8(OP.enter).i32(1).string(settings.map).finish());
    controller.receive(spawn({ ...player, hp }));
  };
  const reward = (
    baseTotal: number,
    baseGained: number,
    jobTotal: number,
    jobGained: number,
    generation?: number,
  ) =>
    controller.receive(
      new BitWriter()
        .u8(FEATURE_OP.experience)
        .i32(baseTotal)
        .i32(baseGained)
        .i32(jobTotal)
        .i32(jobGained)
        .finish(),
      generation,
    );
  enter();
  return {
    controller,
    enter,
    reward,
    step: () => {
      now += 100;
      controller.tick();
    },
  };
}

describe('confirmed EXP gained in a controller run', () => {
  it('preserves the EXP cursor and elapsed time when live settings apply to the same run', () => {
    const f = fixture();
    f.controller.start(settings);
    f.reward(100, 10, 200, 5);
    f.step();
    const before = f.controller.snapshot();
    f.controller.applySettings({ ...settings, radius: 8 }, 'a'.repeat(32));
    const applied = f.controller.snapshot();
    expect(applied.settingsApply?.state).toBe('applied');
    expect(applied.activeSettings?.radius).toBe(8);
    expect(applied.runExperience).toEqual(before.runExperience);
    expect(applied.elapsedSeconds).toBe(before.elapsedSeconds);
    f.reward(120, 20, 207, 7);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      run: 1,
      revision: 2,
      baseGained: 30,
      jobGained: 12,
    });
  });
  it('starts at zero, counts wire observations once, and keeps latest/current observations separate', () => {
    const f = fixture();
    f.reward(1576, 21, 5430, 18);
    expect(f.controller.snapshot().runExperience).toBeNull();
    f.controller.start(settings);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      baseGained: 0,
      jobGained: 0,
      revision: 0,
    });
    f.reward(1700, 124, 5510, 80);
    f.reward(1822, 122, 5622, 112);
    for (let i = 0; i < 3; i++) {
      f.step();
      expect(f.controller.snapshot().runExperience).toMatchObject({
        baseGained: 246,
        jobGained: 192,
        revision: 2,
      });
    }
    expect(f.controller.snapshot().character.experience).toEqual({
      baseTotal: 1822,
      baseGained: 122,
      jobTotal: 5622,
      jobGained: 112,
    });
    f.controller.pause('Temporary wait.');
    f.reward(1843, 21, 5640, 18);
    f.controller.stop();
    f.reward(1864, 21, 5658, 18);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      baseGained: 267,
      jobGained: 210,
      revision: 3,
    });
    f.controller.start(settings);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      run: 2,
      baseGained: 0,
      jobGained: 0,
    });
  });
  it('adds authoritative signed deltas through level rollover and map waits', () => {
    const f = fixture();
    f.controller.start(settings);
    f.reward(2131, 309, 25, 192);
    f.reward(2110, -21, 7, -18);
    f.controller.receive(new BitWriter().u8(OP.map).string(settings.map).finish());
    f.controller.receive(spawn({ ...player, level: 8 }));
    f.reward(20, 42, 10, 3);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      baseGained: 330,
      jobGained: 177,
    });
    expect(f.controller.snapshot().character.experience).toEqual({
      baseTotal: 20,
      baseGained: 42,
      jobTotal: 10,
      jobGained: 3,
    });
  });
  it('ignores stale generations and freezes results when a different character arrives', () => {
    const f = fixture();
    f.controller.start(settings);
    f.reward(100, 10, 200, 5);
    const generation = f.controller.connectionGeneration;
    f.controller.disconnect();
    f.reward(120, 20, 220, 20, generation);
    f.controller.connect(true);
    f.controller.receive(new BitWriter().u8(OP.enter).i32(1).string(settings.map).finish());
    f.reward(100, 10, 200, 5); // Initialization may carry the previous reward.
    f.controller.receive(spawn({ ...player, name: 'Other' }));
    f.reward(110, 10, 205, 5);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      character: 'Test',
      baseGained: 10,
      jobGained: 5,
      revision: 1,
    });
    f.controller.stop();
    f.controller.start(settings);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      character: 'Other',
      baseGained: 0,
      jobGained: 0,
    });
  });
  it('does not recount reconnect initialization published after the fresh own entry', () => {
    const f = fixture();
    f.controller.start(settings);
    f.reward(100, 10, 200, 5);
    f.controller.disconnect();
    f.enter();
    f.reward(100, 10, 200, 5);
    f.reward(100, 10, 200, 5);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      baseGained: 10,
      jobGained: 5,
      revision: 1,
    });
    f.reward(120, 20, 207, 7);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      baseGained: 30,
      jobGained: 12,
      revision: 2,
    });
  });
  it('counts new rewards and losses while the reconnected character waits for HP', () => {
    const f = fixture();
    f.controller.start(settings);
    f.reward(100, 10, 200, 5);
    f.controller.disconnect();
    f.enter(20);
    f.reward(100, 10, 200, 5);
    expect(f.controller.snapshot().reason).toContain('Waiting for HP');
    expect(f.controller.snapshot().running).toBe(false);
    f.reward(120, 20, 207, 7);
    f.reward(110, -10, 205, -2);
    expect(f.controller.snapshot().runExperience).toMatchObject({
      baseGained: 20,
      jobGained: 10,
      revision: 3,
    });
  });
});

import { describe, expect, it } from 'vitest';
import { CharacterState } from './character-state';
import type { Entity } from './protocol';

const player: Entity = { id: 1, classId: 0, name: 'Player', kind: 0, level: 13,
  hp: 149, maxHp: 149, x: 100, y: 100, dead: false, sp: 0, maxSp: 0 };

describe('player spawn resources', () => {
  it('preserves full login stats when a nearby-player broadcast follows', () => {
    const state = new CharacterState();
    state.apply({ type: 'stats', level: 13, hp: 149, maxHp: 149, sp: 20, maxSp: 30 }, 1);
    state.spawn(player);
    expect(state.snapshot().stats).toMatchObject({ hp: 149, sp: 20, maxSp: 30 });
    state.resetField();
    state.spawn(player);
    expect(state.snapshot().stats).toMatchObject({ sp: 20, maxSp: 30 });
  });

  it('keeps placeholder SP unknown until authoritative values arrive', () => {
    const state = new CharacterState();
    state.spawn(player);
    expect(state.snapshot().stats?.sp).toBeUndefined();
    expect(state.snapshot().stats?.maxSp).toBeUndefined();
    state.apply({ type: 'sp', sp: 0, maxSp: 30 }, 1);
    expect(state.snapshot().stats).toMatchObject({ sp: 0, maxSp: 30 });
  });

  it('accepts a real self spawn including exhausted SP', () => {
    const state = new CharacterState();
    state.spawn({ ...player, sp: 0, maxSp: 30 });
    expect(state.snapshot().stats).toMatchObject({ sp: 0, maxSp: 30 });
  });
});

import { describe, expect, it } from 'vitest';
import { InputAdmission } from './input-admission';
import {
  actionInputCost,
  advanceInputDebt,
  opcodeInputCost,
  recoveryInputAvailable,
  type InputDebt,
} from './input-admission-logic';

function fixture() {
  let now = 100_000;
  const ledger = new InputAdmission(() => now);
  ledger.observe(now, true);
  return {
    ledger,
    at: (value: number, active = true) => {
      now = value;
      ledger.observe(now, active);
    },
    ready: () => ledger.recoveryAvailable(now, true),
  };
}

describe('automatic recovery input admission', () => {
  it('preserves immediate confirmed-use bursts and paces sustained input', () => {
    const f = fixture();
    for (let i = 0; i < 4; i++) {
      expect(f.ready()).toBe(true);
      f.ledger.dispatch(200, () => undefined);
    }
    expect(f.ready()).toBe(false);
    f.at(100_199);
    expect(f.ready()).toBe(false);
    f.at(100_200);
    expect(f.ready()).toBe(true);
  });

  it('combines Stop, attack, walk, Look and pickup debt without gating their sender', () => {
    const f = fixture();
    const actions = [
      { type: 'attack', id: 2 },
      { type: 'walk', destination: { x: 1, y: 1 } },
      { type: 'look', direction: 0, head: 1 },
      { type: 'pickup', id: 3 },
      { type: 'stop' },
    ] as const;
    let sent = 0;
    for (const action of actions) f.ledger.dispatch(actionInputCost(action), () => sent++);
    expect(sent).toBe(5);
    expect(f.ready()).toBe(false);
    f.at(100_399);
    expect(f.ready()).toBe(false);
    f.at(100_400);
    expect(f.ready()).toBe(true);
  });

  it('does not credit loading, absent own actors, stale observations or reversed clocks', () => {
    let state: InputDebt = { milliseconds: 800, at: 100_000, active: true, pending: 0 };
    state = advanceInputDebt(state, 110_000, false);
    state = advanceInputDebt(state, 120_000, true);
    expect(state.milliseconds).toBe(800);
    state = advanceInputDebt(state, 119_000, true);
    state = advanceInputDebt(state, 120_100, true);
    expect(state.milliseconds).toBe(800);
    state = advanceInputDebt(state, 120_300, true);
    expect(recoveryInputAvailable(state)).toBe(true);
    expect(advanceInputDebt(state, NaN, true).active).toBe(false);
  });

  it.each(['resolve', 'reject'] as const)(
    'anchors a delayed native %s without refunding possible debt',
    async (outcome) => {
      const f = fixture();
      let resolve!: () => void, reject!: () => void;
      const write = new Promise<void>((done, fail) => {
        resolve = done;
        reject = fail;
      });
      expect(f.ledger.dispatch(800, () => write)).toBe(write);
      f.at(110_000);
      expect(f.ready()).toBe(false);
      if (outcome === 'resolve') resolve();
      else reject();
      await Promise.resolve();
      expect(f.ready()).toBe(false);
      f.at(110_199);
      expect(f.ready()).toBe(false);
      f.at(110_200);
      expect(f.ready()).toBe(true);
    },
  );

  it('keeps synchronous send-then-throw debt and fences a retired write completion', async () => {
    const f = fixture();
    expect(() =>
      f.ledger.dispatch(800, () => {
        throw new Error('after socket write');
      }),
    ).toThrow();
    expect(f.ready()).toBe(false);
    let resolve!: () => void;
    f.ledger.dispatch(
      200,
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    f.ledger.connectionChanged();
    f.at(100_000);
    f.ledger.dispatch(800, () => undefined);
    resolve();
    await Promise.resolve();
    expect(f.ready()).toBe(false);
    f.at(100_200);
    expect(f.ready()).toBe(true);
  });

  it('retains aggregate debt until every overlapping native write settles', async () => {
    const f = fixture();
    let first!: () => void, second!: () => void;
    f.ledger.dispatch(
      400,
      () =>
        new Promise<void>((done) => {
          first = done;
        }),
    );
    f.ledger.dispatch(
      400,
      () =>
        new Promise<void>((done) => {
          second = done;
        }),
    );
    f.at(101_000);
    first();
    await Promise.resolve();
    f.at(102_000);
    expect(f.ready()).toBe(false);
    second();
    await Promise.resolve();
    expect(f.ready()).toBe(false);
    f.at(102_200);
    expect(f.ready()).toBe(true);
  });

  it('uses source-qualified costs without adding generic skill or economic charges', () => {
    expect([7, 8, 11, 13, 14, 19, 41, 64, 76, 78, 82, 107].map(opcodeInputCost)).toEqual([
      250, 150, 250, 100, 250, 200, 1000, 1000, 250, 250, 200, 250,
    ]);
    expect(actionInputCost({ type: 'skill', mode: 'self', skillId: 28, level: 1 })).toBe(0);
    expect(actionInputCost({ type: 'shop', mode: 'sell', rows: [] })).toBe(0);
    expect(actionInputCost({ type: 'useItem', itemId: 601 })).toBe(700);
    expect(actionInputCost({ type: 'useItem', itemId: 602 })).toBe(1200);
    expect(actionInputCost({ type: 'skill', mode: 'self', skillId: 53, level: 1 })).toBe(500);
    expect(actionInputCost({ type: 'skill', mode: 'self', skillId: 54, level: 1 })).toBe(1000);
    expect(opcodeInputCost(47)).toBe(1200);
    expect(opcodeInputCost(29)).toBe(1000);
    expect(opcodeInputCost(undefined)).toBe(0);
  });
});

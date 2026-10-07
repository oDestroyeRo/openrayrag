import { expect, it, vi } from 'vitest';
import { EmbeddedGameView, gameViewBounds, type GameViewBounds } from './game-view';

const bounds: GameViewBounds = { x: 24, y: 180, width: 1052, height: 660 };
const settled = async () => {
  for (let i = 0; i < 12; i++) await Promise.resolve();
};

it('clips the game below the toolbar and inside the resized viewport', () => {
  expect(
    gameViewBounds({ x: -24, y: 140, width: 1200, height: 800 }, { width: 1100, height: 880 }, 180),
  ).toEqual({ x: 0, y: 180, width: 1100, height: 700 });
  expect(gameViewBounds({ ...bounds, y: -700 }, { width: 1100, height: 880 }, 180)).toBeNull();
  expect(gameViewBounds({ ...bounds, width: NaN }, { width: 1100, height: 880 }, 180)).toBeNull();
});

it('retains the connection while switching views and only presents changed bounds', async () => {
  let layout = bounds;
  const present = vi.fn(async (_bounds: GameViewBounds | null) => {}),
    changed = vi.fn(),
    error = vi.fn();
  const view = new EmbeddedGameView({ bounds: () => layout, present, changed, error });
  view.setVisible(true);
  await settled();
  view.refresh();
  view.refresh();
  await settled();
  expect(present.mock.calls).toEqual([[bounds]]);
  layout = { ...bounds, width: 1200 };
  view.refresh();
  await settled();
  view.setVisible(false);
  await settled();
  view.setVisible(true);
  await settled();
  expect(present.mock.calls).toEqual([[bounds], [layout], [null], [layout]]);
  expect(changed.mock.calls).toEqual([[true], [true], [false], [true]]);
  expect(error).not.toHaveBeenCalled();
});

it('hides after a delayed Show and coalesces obsolete resize requests', async () => {
  let layout = bounds,
    finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const present = vi
    .fn(async (_bounds: GameViewBounds | null) => {})
    .mockImplementationOnce(() => pending);
  const changed = vi.fn(),
    error = vi.fn();
  const view = new EmbeddedGameView({ bounds: () => layout, present, changed, error });
  view.setVisible(true);
  layout = { ...bounds, width: 900 };
  view.refresh();
  layout = { ...bounds, width: 850 };
  view.refresh();
  view.setVisible(false);
  expect(present).toHaveBeenCalledOnce();
  finish();
  await settled();
  expect(present.mock.calls).toEqual([[bounds], [null]]);
  expect(changed.mock.calls).toEqual([[false]]);
  expect(error).not.toHaveBeenCalled();
});

it('keeps failed presentation recoverable without retrying on every heartbeat', async () => {
  const present = vi
    .fn(async (_bounds: GameViewBounds | null) => {})
    .mockRejectedValueOnce(new Error('Unavailable'));
  const changed = vi.fn(),
    error = vi.fn();
  const view = new EmbeddedGameView({ bounds: () => bounds, present, changed, error });
  view.setVisible(true);
  await settled();
  view.refresh();
  await settled();
  expect(present).toHaveBeenCalledOnce();
  expect(error).toHaveBeenCalledOnce();
  expect(changed).toHaveBeenCalledWith(false);
  view.setVisible(false);
  await settled();
  view.setVisible(true);
  await settled();
  expect(present.mock.calls).toEqual([[bounds], [null], [bounds]]);
  expect(changed).toHaveBeenLastCalledWith(true);
});

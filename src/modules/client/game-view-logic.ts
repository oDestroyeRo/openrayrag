export interface GameViewBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** CSS pixels match native logical coordinates; never cover the sticky controls. */
export function gameViewBounds(
  rect: GameViewBounds,
  viewport: { width: number; height: number },
  toolbarBottom: number,
): GameViewBounds | null {
  if (
    ![
      rect.x,
      rect.y,
      rect.width,
      rect.height,
      viewport.width,
      viewport.height,
      toolbarBottom,
    ].every(Number.isFinite)
  )
    return null;
  const x = Math.max(0, rect.x),
    y = Math.max(0, rect.y, toolbarBottom);
  const width = Math.min(rect.x + rect.width, viewport.width) - x;
  const height = Math.min(rect.y + rect.height, viewport.height) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

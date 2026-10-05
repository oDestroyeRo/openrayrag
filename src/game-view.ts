export interface GameViewBounds { x: number; y: number; width: number; height: number }

/** CSS pixels match native logical coordinates; never cover the sticky controls. */
export function gameViewBounds(rect: GameViewBounds, viewport: { width: number; height: number }, toolbarBottom: number): GameViewBounds | null {
  if (![rect.x, rect.y, rect.width, rect.height, viewport.width, viewport.height, toolbarBottom].every(Number.isFinite)) return null;
  const x = Math.max(0, rect.x), y = Math.max(0, rect.y, toolbarBottom);
  const width = Math.min(rect.x + rect.width, viewport.width) - x;
  const height = Math.min(rect.y + rect.height, viewport.height) - y;
  return width >= 1 && height >= 1 ? { x, y, width, height } : null;
}

/** Coalesce layout changes so a delayed Show can never outlive the next Hide. */
export class EmbeddedGameView {
  private selected = false;
  private desired: GameViewBounds | null = null;
  private completed = 'null';
  private sending = false;

  constructor(private readonly hooks: {
    bounds(): GameViewBounds | null;
    present(bounds: GameViewBounds | null): Promise<void>;
    changed(shown: boolean): void;
    error(): void;
  }) {}

  setVisible(selected: boolean): void { this.selected = selected; this.refresh(); }

  refresh(): void {
    this.desired = this.selected ? this.hooks.bounds() : null;
    if (!this.sending) void this.flush();
  }

  private async flush(): Promise<void> {
    this.sending = true;
    try {
      while (JSON.stringify(this.desired) !== this.completed) {
        const bounds = this.desired, key = JSON.stringify(bounds);
        try {
          await this.hooks.present(bounds);
          if (key === JSON.stringify(this.desired)) this.hooks.changed(bounds !== null);
        } catch {
          if (key === JSON.stringify(this.desired)) { this.hooks.changed(false); this.hooks.error(); }
        }
        this.completed = key;
      }
    } finally { this.sending = false; }
  }
}

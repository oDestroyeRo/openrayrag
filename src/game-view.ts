import type { GameViewBounds } from './game-view-logic';
export { gameViewBounds, type GameViewBounds } from './game-view-logic';

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

import type { FormDocument, FormRevision } from './current-form';
import { closeRequest, type CloseToken } from './settings-close-logic';
export { type CloseRequest, type CloseToken } from './settings-close-logic';

interface Hooks {
  settled(): Promise<void>;
  flush(): Promise<FormDocument>;
  unchanged(document: FormDocument): boolean;
  complete(token: CloseToken, revision: FormRevision): Promise<void>;
  cancel(token: CloseToken): Promise<void>;
  lock(locked: boolean): void;
  status(message: string): void;
}

/** Keep the controller alive until its latest validated settings write is confirmed. */
export class SettingsClose {
  private pending: Promise<void> | null = null;
  constructor(private readonly hooks: Hooks) {}

  request(value: unknown): Promise<void> {
    const request = closeRequest(value);
    if (!request) return Promise.resolve();
    if (this.pending) return this.pending;
    const { token } = request;
    this.hooks.lock(true);
    this.hooks.status('Saving current settings before closing…');
    this.pending = this.save(token);
    return this.pending;
  }

  private async save(token: CloseToken): Promise<void> {
    try {
      await this.hooks.settled();
      let document: FormDocument;
      // Also cover an edit already dispatched when the controls were locked.
      do {
        document = await this.hooks.flush();
      } while (!this.hooks.unchanged(document));
      await this.hooks.complete(token, document.revision);
      // Keep controls locked until native destruction, including slow UI dispatch.
    } catch {
      await this.hooks.cancel(token).catch(() => {});
      this.hooks.status(
        'Close cancelled: current settings could not be saved. Check the settings or local storage, then try closing again.',
      );
      this.hooks.lock(false);
      this.pending = null;
    }
  }
}

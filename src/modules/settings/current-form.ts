import { DomainValueError } from '../../shared/domain-values';
import {
  formDocument,
  formRevision,
  nextFormSave,
  type FormDocument,
  type FormDocumentInput,
} from './current-form-logic';
export {
  formDocument,
  type FormDocument,
  type FormDocumentInput,
  type FormRevision,
} from './current-form-logic';
/** Serialize saves; a delayed restore or old save never overwrites newer form edits. */
export class CurrentForm {
  private revision = formRevision(0);
  private edits = 0;
  private chain = Promise.resolve();
  private last: string | null = null;
  initialized = false;
  constructor(
    private readonly read: () => Omit<FormDocumentInput, 'version' | 'revision'>,
    private readonly save: (d: FormDocument) => Promise<number>,
  ) {}
  touch(): void {
    this.edits++;
  }
  restore(value: unknown, apply: (d: FormDocument) => void): void {
    if (value !== null && value !== undefined) {
      const d = formDocument(value);
      this.revision = d.revision;
      if (this.edits === 0) apply(d);
    }
    this.initialized = true;
  }
  flush(): Promise<FormDocument> {
    let proposal: ReturnType<typeof nextFormSave>;
    try {
      const d = formDocument({ version: 1, revision: this.revision, ...this.read() });
      proposal = nextFormSave(d, this.revision, this.last);
    } catch (e) {
      return Promise.reject(
        e instanceof DomainValueError && e.domain === 'Revision'
          ? new Error('Invalid current settings document.')
          : e,
      );
    }
    this.revision = proposal.revision;
    this.last = proposal.content;
    const requested = proposal.document;
    const task = this.chain
      .catch(() => {})
      .then(async () => {
        if ((await this.save(requested)) !== requested.revision)
          throw new Error('Current settings save was not confirmed.');
        return requested;
      });
    this.chain = task.then(() => {});
    return task;
  }
}

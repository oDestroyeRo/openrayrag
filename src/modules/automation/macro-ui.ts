import { equals } from 'effect/Equal';
import { dryRunMacro, macroInventoryItemIds, type MacroScript } from './macros';
import type { RoutineObservation } from './routines';
import { DEFAULT_SETTINGS, settingsDraft, type SettingsInput } from '../settings/settings';
import {
  formatBotScript,
  parseBotScript,
  updateBotScriptSettings,
  type BotScriptDocument,
} from '../settings/bot-script';
import {
  macroSource,
  restoreMacroSource,
  encodeMacroSource,
  addMacroExample,
  macroStatusText,
  macroPreviewText,
  type Example,
} from './macro-ui-logic';
import { readStoredText, writeStoredText, browserTextStorage } from '../../shared/storage-effects';
export { macroActive, macroBaseSettings, macroExample, validMacroSnapshot } from './macro-ui-logic';

const STORAGE_KEY = 'rayrag.companion.setup-script.v1';
const LEGACY_STORAGE_KEY = 'rayrag.companion.macro.v1';
type LocalStore = Pick<Storage, 'getItem' | 'setItem'>;
interface DraftApplication {
  source: string;
  saved: string;
  document: BotScriptDocument;
}
/** Only source is stored here; CurrentForm remains the owner of retained settings.
 * A clean restore replaces cached set statements with the latest retained form.
 * Migration is read-only until the user edits or explicitly saves.
 */
export class MacroDraft {
  text: string;
  private appliedText: string;
  private savedText: string;
  private appliedDocument: BotScriptDocument;
  private settingsKey: string | null = null;
  private retainedSettings = structuredClone(DEFAULT_SETTINGS);
  readonly restoreError: string | null;
  constructor(private readonly storage: LocalStore | null) {
    let source = formatBotScript({ settings: this.retainedSettings, script: null });
    let error: string | null = null;
    try {
      const stored = storage ? readStoredText(storage, STORAGE_KEY) : null;
      const legacy = stored || !storage ? null : readStoredText(storage, LEGACY_STORAGE_KEY);
      source = restoreMacroSource(stored, legacy, this.retainedSettings);
    } catch {
      error =
        'Saved Setup could not be loaded. The saved data has been kept; editing a valid script or selecting Save script replaces the script copy.';
    }
    this.text = source;
    this.appliedText = source;
    this.savedText = source;
    this.restoreError = error;
    this.appliedDocument = parseBotScript(source);
  }
  get dirty(): boolean {
    return this.text !== this.appliedText;
  }
  get unsaved(): boolean {
    return this.dirty || this.appliedText !== this.savedText;
  }
  read(settings: SettingsInput = this.retainedSettings): BotScriptDocument {
    return parseBotScript(this.text, settings);
  }
  configured(): BotScriptDocument {
    if (this.dirty) throw new Error('Finish a valid Script or discard your draft before Start.');
    return structuredClone(this.appliedDocument);
  }
  syncSettings(settings: SettingsInput): void {
    const key = JSON.stringify(settings);
    if (key === this.settingsKey) return;
    const dirty = this.dirty;
    const applied = updateBotScriptSettings(this.appliedText, settings);
    const saved =
      this.appliedText === this.savedText
        ? applied
        : updateBotScriptSettings(this.savedText, settings);
    const retained = settingsDraft(settings);
    this.appliedText = applied.text;
    this.savedText = saved.text;
    if (!dirty) this.text = this.appliedText;
    this.retainedSettings = retained;
    this.appliedDocument = applied.document;
    this.settingsKey = key;
  }
  /** Admit the new source before Form changes; preserve a recoverable saved baseline. */
  prepare(document: BotScriptDocument): DraftApplication {
    const source = macroSource(this.text, document);
    let saved = this.savedText;
    try {
      saved = updateBotScriptSettings(saved, document.settings).text;
    } catch {
      // A sparse saved source near the size limit may not fit expanded settings.
      // Keep it intact until a replacement saves; it must not block replacement.
      // Discard's final Form sync reports any remaining conversion failure.
    }
    return { source, saved, document: structuredClone(document) };
  }
  commit(application: DraftApplication): void {
    this.text = application.source;
    this.appliedText = application.source;
    this.savedText = application.saved;
    this.retainedSettings = settingsDraft(application.document.settings);
    this.appliedDocument = application.document;
    this.settingsKey = null;
  }
  apply(document: BotScriptDocument): void {
    this.commit(this.prepare(document));
  }
  save(): BotScriptDocument {
    const document = this.read();
    if (!this.storage)
      throw new Error('Local script storage is unavailable. Copy your script before closing.');
    const source = macroSource(this.text, document);
    writeStoredText(this.storage, STORAGE_KEY, encodeMacroSource(source));
    this.text = source;
    this.appliedText = source;
    this.savedText = source;
    this.retainedSettings = settingsDraft(document.settings);
    this.appliedDocument = structuredClone(document);
    this.settingsKey = null;
    return document;
  }
  get enabledScript(): MacroScript | null {
    return structuredClone(this.appliedDocument.script);
  }
  discard(): void {
    if (this.appliedText !== this.savedText) {
      this.appliedDocument = parseBotScript(this.savedText, this.retainedSettings);
      this.appliedText = this.savedText;
      this.settingsKey = null;
    }
    this.text = this.appliedText;
  }
}

interface Hooks {
  settings(): SettingsInput;
  apply(settings: SettingsInput): void;
  changed(): void;
  notify(message: string, error?: boolean): void;
}

/** Form and Script are two views of one Setup; no editor action sends commands. */
export class MacroUi {
  readonly root = document.createElement('section');
  readonly summary = document.createElement('p');
  private readonly editor = document.createElement('textarea');
  private readonly result = document.createElement('pre');
  private readonly progress = document.createElement('p');
  private readonly saved = document.createElement('p');
  private readonly draft: MacroDraft;
  private observation: RoutineObservation = {};
  private observedAt = 0;
  private locked = false;
  private syncError: string | null = null;
  private syncKey: string | null = null;
  private applying = false;
  constructor(
    private readonly hooks: Hooks,
    storage?: LocalStore | null,
  ) {
    let local = storage ?? null;
    if (storage === undefined) {
      try {
        local = browserTextStorage();
      } catch {
        /* Saving reports unavailable storage. */
      }
    }
    // FeatureUi mounts before SettingsForm; do not read the retained form here.
    this.draft = new MacroDraft(local);
    this.root.className = 'panel macro-panel';
    this.root.id = 'setup-script-editor';
    const help = document.createElement('p');
    help.className = 'hint';
    help.textContent =
      'Form and Script share your current settings. Valid edits update and save the same setup automatically; incomplete text stays here until corrected or discarded. Start bot is always explicit. Paste an old JSON macro here to import it with your current settings.';
    const templates = document.createElement('div');
    templates.className = 'actions macro-actions';
    const select = document.createElement('select');
    select.id = 'macro-example';
    select.dataset.config = 'true';
    select.setAttribute('aria-label', 'Example rules');
    for (const [value, label] of [
      ['leveling', 'Leveling route'],
      ['continuous', 'Until stopped'],
      ['buy', 'Buy potions'],
      ['store', 'Store loot'],
      ['item', 'Use an item'],
      ['skill', 'Use a skill'],
    ]) {
      const option = document.createElement('option');
      option.value = value!;
      option.textContent = label!;
      select.append(option);
    }
    templates.append(
      select,
      this.button('Add example rules', () => this.addExample(select.value as Example)),
    );
    const label = document.createElement('label');
    label.htmlFor = 'macro-document';
    label.textContent = 'Setup script';
    this.editor.id = 'macro-document';
    this.editor.rows = 22;
    this.editor.spellcheck = false;
    this.editor.dataset.config = 'true';
    this.editor.value = this.draft.text;
    this.editor.addEventListener('input', (event) => {
      event.stopPropagation();
      this.edited();
    });
    const reference = document.createElement('p');
    reference.className = 'hint';
    reference.textContent =
      'Example: set radius = 12. A rule starts with rule "Name", checks when hpPercent < 60, adds use item 501 timeout 30s, and ends with end. # begins a comment. All when lines must match; higher priority wins. With no rules, Start bot uses ordinary field automation.';
    const limits = document.createElement('p');
    limits.className = 'hint';
    limits.textContent =
      'duration 1h, actions 20 and runs 5 bound script work. Use unlimited deliberately. spend 0 allows no spending; buy and store reserve their caps, including fees. Run limits and recovery policies in the set lines remain active. Editing, previewing and saving send no game commands.';
    const actions = document.createElement('div');
    actions.className = 'actions macro-actions';
    actions.append(
      this.button('Validate & preview', () => this.preview()),
      this.button('Save script', () => this.apply()),
      this.button('Discard draft', () => this.discard()),
    );
    this.result.className = 'telemetry-summary macro-preview';
    this.result.id = 'macro-preview';
    this.result.hidden = true;
    this.result.setAttribute('role', 'status');
    this.progress.className = 'hint';
    this.progress.id = 'macro-state';
    this.progress.setAttribute('role', 'status');
    this.progress.textContent = 'No rules running.';
    this.saved.className = 'hint';
    this.saved.id = 'macro-saved';
    this.summary.className = 'setup-rules-summary notice';
    this.summary.id = 'setup-rules-summary';
    this.summary.setAttribute('role', 'status');
    this.root.append(
      help,
      templates,
      label,
      this.editor,
      reference,
      limits,
      actions,
      this.saved,
      this.result,
      this.progress,
    );
    this.savedState();
    if (this.draft.restoreError) hooks.notify(this.draft.restoreError, true);
  }
  get dirty(): boolean {
    return this.draft.dirty;
  }
  get unsaved(): boolean {
    return this.draft.unsaved;
  }
  readScript(): { script: string; dirty: boolean; unsaved: boolean } {
    return { script: this.draft.text, dirty: this.draft.dirty, unsaved: this.draft.unsaved };
  }
  /** The same admitted Form/Script transaction used by the editor; never activates a run. */
  setScript(script: string): { draftChanged: boolean; persisted: boolean } {
    if (this.locked) throw new Error('Wait for the current request before editing Script.');
    parseBotScript(script, this.hooks.settings());
    this.editor.value = script;
    return this.apply(false);
  }
  configured(): BotScriptDocument {
    if (this.applying) throw new Error('Wait for Script settings to synchronize.');
    if (this.syncError) throw new Error(this.syncError);
    return this.draft.configured();
  }
  syncSettings(settings: SettingsInput): void {
    // SettingsForm's changed hook synchronously echoes through Main.updateButtons.
    // Expose the new compiled document only after the complete admission commits.
    if (this.applying) return;
    const key = JSON.stringify(settings);
    if (key === this.syncKey) return;
    this.syncKey = key;
    try {
      this.draft.syncSettings(settings);
      if (this.syncError && this.result.textContent === this.syncError) this.result.hidden = true;
      this.syncError = null;
      if (!this.draft.dirty) this.editor.value = this.draft.text;
    } catch (error) {
      this.syncError = `Setup cannot be converted to Script: ${error instanceof Error ? error.message : 'Reduce the settings or rules.'}`;
      this.result.hidden = false;
      this.result.textContent = this.syncError;
    }
    this.savedState();
  }
  private button(label: string, click: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'secondary compact';
    button.dataset.config = 'true';
    button.textContent = label;
    button.addEventListener('click', () => {
      if (!button.disabled && !this.locked) {
        try {
          click();
        } catch (error) {
          this.error(error);
        }
      }
    });
    return button;
  }
  private edited(): void {
    if (this.locked) {
      this.editor.value = this.draft.text;
      return;
    }
    this.apply(false);
  }
  private savedState(): void {
    this.saved.textContent =
      this.syncError ??
      (this.draft.dirty
        ? 'Script incomplete or invalid · Correct it or Discard draft before using Form or Start.'
        : this.draft.unsaved
          ? 'Shared setup updated but script not saved · Retry Save script, or copy the script and Discard draft before closing.'
          : 'Setup saved · Form and Script share these settings. Start bot is always explicit.');
    const script = this.draft.enabledScript;
    this.summary.textContent = script
      ? `${script.rules.length} script rule${script.rules.length === 1 ? '' : 's'} enabled · ${script.name}. Start bot uses these rules and the Form settings. Edit them in Script.`
      : 'No script rules enabled · Start bot uses the Form settings.';
  }
  private error(error: unknown): void {
    const message = (
      error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : 'Invalid Setup script.'
    ).slice(0, 2000);
    this.result.hidden = false;
    this.result.textContent = message;
    this.hooks.notify(message, true);
  }
  private preview(): void {
    try {
      this.draft.text = this.editor.value;
      const document = this.draft.read(this.hooks.settings());
      const observed = Date.now() - this.observedAt < 7000 ? structuredClone(this.observation) : {};
      this.result.hidden = false;
      if (!document.script) {
        this.result.textContent =
          'Valid settings-only Setup. Start bot uses ordinary field automation.\nPreview sends no commands.';
      } else {
        if (observed.inventory)
          for (const id of macroInventoryItemIds(document.script))
            observed.inventory = { ...observed.inventory, [id]: observed.inventory[id] ?? 0 };
        const trace = dryRunMacro(document.script, observed);
        this.result.textContent = macroPreviewText(trace);
      }
      this.hooks.notify(
        'Valid Setup. Preview does not confirm routes, prices, storage capacity or learned skills.',
      );
    } catch (error) {
      this.error(error);
    }
  }
  private apply(explicit = true): { draftChanged: boolean; persisted: boolean } {
    if (this.locked) return { draftChanged: false, persisted: false };
    let draftChanged = false;
    let persisted = false;
    try {
      this.draft.text = this.editor.value;
      const document = this.draft.read(this.hooks.settings()); // Validate every setting and rule before any mutation.
      const application = this.draft.prepare(document);
      this.applying = true;
      // Rule/comment edits must preserve selected profiles and native revisions.
      // Effect caches equality/hash results; mutable Form values need fresh comparison snapshots.
      if (!equals(structuredClone(document.settings), structuredClone(this.hooks.settings())))
        this.hooks.apply(document.settings);
      this.draft.commit(application);
      draftChanged = true;
      const retained = this.hooks.settings();
      // Form can fill default policies or retain an observed map omitted by Script.
      // Only suppress an equivalent echo; otherwise Main must rebase the source.
      this.syncError = null;
      this.syncKey = equals(structuredClone(document.settings), structuredClone(retained))
        ? JSON.stringify(retained)
        : null;
      if (this.editor.value !== this.draft.text) this.editor.value = this.draft.text;
      this.draft.save();
      persisted = true;
      this.result.hidden = true;
      if (explicit)
        this.hooks.notify('Shared setup saved on this computer. Start bot remains explicit.');
    } catch (error) {
      if (explicit) this.error(error);
      else {
        this.result.hidden = false;
        this.result.textContent = (
          error instanceof Error ? error.message : 'Invalid Setup script.'
        ).slice(0, 2000);
      }
    } finally {
      this.applying = false;
      this.savedState();
      this.hooks.changed();
    }
    return { draftChanged, persisted };
  }
  private discard(): void {
    this.draft.discard();
    this.syncKey = null;
    this.editor.value = this.draft.text;
    this.result.hidden = true;
    this.savedState();
    this.hooks.changed();
  }
  private addExample(kind: Example): void {
    this.draft.text = this.editor.value;
    const document = this.draft.read(this.hooks.settings());
    const example = addMacroExample(this.editor.value, document, kind);
    this.editor.value = example.text;
    this.editor.focus();
    this.editor.setSelectionRange(example.insertion, example.insertion);
    this.editor.scrollTop = this.editor.scrollHeight;
    this.edited();
    this.hooks.notify(
      'Example rules added to the shared setup. Check conditions, targets, run limits and spending caps before Start bot.',
    );
  }
  lock(config: boolean): void {
    this.locked = config;
    for (const input of this.root.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement
    >('[data-config]'))
      input.disabled = config;
  }
  render(value: unknown, observation: RoutineObservation): void {
    this.observation = structuredClone(observation);
    this.observedAt = Date.now();
    this.progress.textContent = macroStatusText(value);
  }
}

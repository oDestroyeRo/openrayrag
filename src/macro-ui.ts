import { dryRunMacro, macroInventoryItemIds, validateMacroScript, type MacroScript } from './macros';
import type { RoutineObservation } from './routines';
import { automationSettings, validateSettings, type Settings } from './settings';

const STORAGE_KEY = 'rayrag.companion.macro.v1';
type LocalStore = Pick<Storage, 'getItem' | 'setItem'>;
type Example = 'leveling' | 'continuous' | 'buy' | 'store' | 'item' | 'skill';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function macroActive(value: unknown): boolean { const state=record(value).state;return typeof state==='string'&&['running', 'waiting', 'monitoring'].includes(state); }
/** Script targets can supply an empty field draft; non-field scripts need no combat selection. */
export function macroBaseSettings(value: Settings, script: MacroScript): Settings {
  const settings=structuredClone(value);
  const policy=structuredClone(automationSettings(settings));
  if(!settings.targets.length&&['selected','both'].includes(policy.combat.mode)) {
    const field=script.rules.flatMap(rule=>rule.steps).find(step=>step.type==='farm');
    if(field?.type==='farm')settings.targets=[...field.targets];
    else {policy.combat={...policy.combat,mode:'off'};settings.automation=policy;}
  }
  return validateSettings(settings);
}
export function validMacroSnapshot(value: unknown): boolean {
  const state = record(value);
  const counts = ['generation', 'actionsIssued', 'actionsCompleted', 'sequencesIssued', 'sequencesCompleted', 'spendReserved'];
  const keys = ['state', 'reason', 'name', 'currentRule', 'stepIndex', 'pendingActionId', 'elapsedSeconds', 'fieldIntentActive', 'fieldSuspended', ...counts];
  return Object.keys(state).length === keys.length && Object.keys(state).every(key => keys.includes(key))
    && typeof state.state === 'string' && ['idle', 'running', 'waiting', 'monitoring', 'completed', 'failed', 'cancelled'].includes(state.state)
    && typeof state.reason === 'string' && state.reason.length <= 200 && typeof state.name === 'string' && state.name.length <= 80
    && (state.currentRule === null || typeof state.currentRule === 'string' && state.currentRule.length <= 80)
    && counts.every(key => Number.isSafeInteger(state[key]) && Number(state[key]) >= 0)
    && (state.stepIndex === null || Number.isInteger(state.stepIndex) && Number(state.stepIndex) >= 0 && Number(state.stepIndex) < 16)
    && (state.pendingActionId === null || Number.isSafeInteger(state.pendingActionId) && Number(state.pendingActionId) > 0)
    && typeof state.elapsedSeconds === 'number' && Number.isFinite(state.elapsedSeconds) && state.elapsedSeconds >= 0 && state.elapsedSeconds <= Number.MAX_SAFE_INTEGER / 1_000
    && typeof state.fieldIntentActive === 'boolean' && typeof state.fieldSuspended === 'boolean';
}

/** Templates are editable proposals. Loading, saving and previewing never start automation. */
export function macroExample(kind: Example, context: { map?: string; targets?: number[] } = {}): MacroScript {
  const farm = { type: 'farm' as const, map: context.map || 'prt_fild08', targets: context.targets?.length ? context.targets : [4000, 4012, 4002], timeoutSeconds: 300 };
  const common = { priority: 10, cooldownSeconds: 10, maxRuns: 1 };
  const rules: MacroScript['rules'] = kind === 'leveling' ? [
    { ...common, name: 'First field', conditions: [{ field: 'level', operator: 'lt', value: 20 }], steps: [farm] },
    { ...common, name: 'Next field', conditions: [{ field: 'level', operator: 'gte', value: 20 }], steps: [{ ...farm, map: 'prt_fild07', targets: [4000] }] },
  ] : kind === 'continuous' ? [
    { ...common, name: 'Start farming', conditions: [{ field: 'level', operator: 'gte', value: 1 }], steps: [farm] },
    { ...common, name: 'First Aid', priority: 100, maxRuns: 0,
      conditions: [{ field: 'hpPercent', operator: 'lt', value: 60 }, { field: 'spPercent', operator: 'gte', value: 30 }],
      steps: [{ type: 'skill', skillId: 2, level: 1, mode: 'self', timeoutSeconds: 30 }] },
  ] : kind === 'buy' ? [{ ...common, name: 'Restock potions', priority: 50, maxRuns: 2,
    conditions: [{ field: 'inventory', itemId: 501, operator: 'lt', value: 5 }, { field: 'zeny', operator: 'gte', value: 500 }],
    steps: [{ type: 'buy', serviceId: 'tool-dealer-buy', itemId: 501, quantity: 5, maxSpend: 500, timeoutSeconds: 600 }] }]
    : kind === 'store' ? [{ ...common, name: 'Store jellopy', priority: 50, maxRuns: 2,
      conditions: [{ field: 'inventory', itemId: 909, operator: 'gte', value: 20 }],
      steps: [{ type: 'store', serviceId: 'kafra-south-storage', itemId: 909, quantity: 10, keep: 10, maxSpend: 100, timeoutSeconds: 600 }] }]
      : kind === 'item' ? [{ ...common, name: 'Use a potion', priority: 100, maxRuns: 5,
        conditions: [{ field: 'hpPercent', operator: 'lt', value: 60 }, { field: 'inventory', itemId: 501, operator: 'gte', value: 1 }],
        steps: [{ type: 'useItem', itemId: 501, timeoutSeconds: 30 }] }]
        : [{ ...common, name: 'First Aid', priority: 100, maxRuns: 5,
          conditions: [{ field: 'hpPercent', operator: 'lt', value: 60 }, { field: 'spPercent', operator: 'gte', value: 30 }],
          steps: [{ type: 'skill', skillId: 2, level: 1, mode: 'self', timeoutSeconds: 30 }] }];
  return validateMacroScript({ version: 1, name: kind === 'continuous' ? 'Until stopped' : kind === 'leveling' ? 'Leveling route' : rules[0]!.name,
    durationSeconds: kind === 'continuous' ? 0 : 3600, maxActions: kind === 'continuous' ? 0 : 20, maxSpend: kind === 'buy' ? 1000 : kind === 'store' ? 200 : 0, rules });
}

/** This store contains a validated script only: no credentials or active continuation. */
export class MacroDraft {
  text: string;
  private savedText: string;
  readonly restoreError: string | null;
  constructor(private readonly storage: LocalStore | null) {
    let script = macroExample('leveling');
    let error: string | null = null;
    try {
      const stored = storage?.getItem(STORAGE_KEY);
      if (stored) {
        if (new TextEncoder().encode(stored).length > 66_000) throw new Error('Saved macro is too large.');
        const value = record(JSON.parse(stored));
        if (Object.keys(value).length !== 2 || value.version !== 1 || !Object.hasOwn(value, 'script')) throw new Error('Unknown saved macro format.');
        script = validateMacroScript(value.script);
      }
    } catch { error = 'The saved macro could not be loaded. Your saved document has been kept; use a valid script and Save to replace it.'; }
    this.text = JSON.stringify(script, null, 2); this.savedText = this.text; this.restoreError = error;
  }
  get dirty(): boolean { return this.text !== this.savedText; }
  read(): MacroScript {
    try { return validateMacroScript(JSON.parse(this.text)); }
    catch (error) { throw new Error(error instanceof SyntaxError ? `JSON syntax: ${error.message}` : error instanceof Error ? error.message : 'Invalid macro.'); }
  }
  save(): MacroScript {
    const script = this.read();
    if (!this.storage) throw new Error('Local script storage is unavailable. Copy your script before closing.');
    this.storage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, script }));
    this.text = JSON.stringify(script, null, 2); this.savedText = this.text; return script;
  }
}

interface Hooks {
  settings(): Settings;
  start(request: { script: MacroScript; settings: Settings }): Promise<unknown>;
  stop(): void;
  changed(): void;
  notify(message: string, error?: boolean): void;
}

/** A focused editor around the same protocol admitted by the game controller. */
export class MacroUi {
  readonly root = document.createElement('details');
  private readonly editor = document.createElement('textarea');
  private readonly result = document.createElement('pre');
  private readonly progress = document.createElement('p');
  private readonly saved = document.createElement('p');
  private readonly draft: MacroDraft;
  private observation: RoutineObservation = {};
  private observedAt = 0;
  private busy = false;
  private locked = false;
  private readonly startButton = document.createElement('button');
  private readonly stopButton = document.createElement('button');
  constructor(private readonly hooks: Hooks, storage?: LocalStore | null) {
    let local = storage ?? null;
    if (storage === undefined) { try { local = window.localStorage; } catch { /* Report unavailable storage when saving. */ } }
    this.draft = new MacroDraft(local);
    this.root.className = 'manual-group macro-panel'; this.root.open = true;
    const title = document.createElement('summary'); title.textContent = 'Macro scripts'; this.root.append(title);
    const help = document.createElement('p'); help.className = 'hint';
    help.textContent = 'Choose an example, edit its conditions and steps, then preview before starting. Farm activates a field; level or inventory rules can select the next sequence. Until stopped starts farming once and monitors First Aid. Check that your character has the skill. Existing recovery and death limits stay active.';
    const templates = document.createElement('div'); templates.className = 'actions macro-actions';
    const select = document.createElement('select'); select.id = 'macro-example'; select.dataset.config = 'true'; select.setAttribute('aria-label', 'Macro example');
    for (const [value, label] of [['leveling', 'Leveling route'], ['continuous', 'Until stopped'], ['buy', 'Buy potions'], ['store', 'Store loot'], ['item', 'Use an item'], ['skill', 'Use a skill']]) {
      const option = document.createElement('option'); option.value = value!; option.textContent = label!; select.append(option);
    }
    const example = this.button('Load example', 'config', () => {
      const settings = hooks.settings(); this.editor.value = JSON.stringify(macroExample(select.value as Example, settings), null, 2); this.edited();
      this.result.hidden = true; hooks.notify('Example loaded. Check map, targets, quantities and spending caps before Start.');
    });
    templates.append(select, example);
    const label = document.createElement('label'); label.htmlFor = 'macro-document'; label.textContent = 'Script · JSON version 1';
    this.editor.id = 'macro-document'; this.editor.rows = 18; this.editor.spellcheck = false; this.editor.dataset.config = 'true';
    this.editor.value = this.draft.text; this.editor.addEventListener('input', () => this.edited());
    const reference = document.createElement('p'); reference.className = 'hint';
    reference.textContent = 'Conditions: level, jobLevel, hpPercent, spPercent, weightPercent, zeny, map, inventory and observed actor predicates. All conditions in a rule must match. Steps: farm, travel, buy, store, useItem and skill. Higher priority wins; a selected sequence finishes before another rule runs.';
    const limits = document.createElement('p'); limits.className = 'hint';
    limits.textContent = 'Set durationSeconds, maxActions or a rule’s maxRuns to 0 for no limit. maxActions counts script steps; every step still needs a positive timeoutSeconds. Use Stop macro to end an unlimited macro; recovery and death limits stay active. maxSpend is the whole script allowance; maxSpend: 0 permits no spending. Each buy/store step reserves its declared cap, including NPC fees, without refunds. Changing map preserves this run’s limits. Saving does not start or resume a script.';
    const actions = document.createElement('div'); actions.className = 'actions macro-actions';
    actions.append(this.button('Validate & preview', 'config', () => this.preview()), this.button('Save on this computer', 'config', () => {
      try { this.draft.text = this.editor.value; this.draft.save(); this.editor.value = this.draft.text; this.savedState(); hooks.changed(); hooks.notify('Macro saved on this computer.'); }
      catch (error) { this.error(error); }
    }));
    this.startButton.type = 'button'; this.startButton.className = 'primary compact'; this.startButton.textContent = 'Start macro'; this.startButton.dataset.manual = 'true';
    this.startButton.addEventListener('click', () => void this.start());
    this.stopButton.type = 'button'; this.stopButton.className = 'danger compact'; this.stopButton.textContent = 'Stop macro';
    this.stopButton.addEventListener('click', () => hooks.stop()); actions.append(this.startButton, this.stopButton);
    this.result.className = 'telemetry-summary macro-preview'; this.result.id = 'macro-preview'; this.result.hidden = true; this.result.setAttribute('role', 'status');
    this.progress.className = 'hint'; this.progress.id = 'macro-state'; this.progress.setAttribute('role', 'status'); this.progress.textContent = 'No macro running.';
    this.saved.className = 'hint'; this.saved.id = 'macro-saved'; this.savedState();
    this.root.append(help, templates, label, this.editor, reference, limits, actions, this.saved, this.result, this.progress);
    this.stopButton.disabled = true;
    if (this.draft.restoreError) hooks.notify(this.draft.restoreError, true);
  }
  get dirty(): boolean { return this.draft.dirty; }
  private button(label: string, kind: 'config', click: () => void): HTMLButtonElement {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary compact'; button.dataset[kind] = 'true'; button.textContent = label;
    button.addEventListener('click', () => { if (!button.disabled) { try { click(); } catch (error) { this.error(error); } } }); return button;
  }
  private edited(): void { this.draft.text = this.editor.value; this.savedState(); this.result.hidden = true; this.hooks.changed(); }
  private savedState(): void { this.saved.textContent = this.draft.dirty ? 'Unsaved changes · Save or copy your script before closing.' : 'Script ready · Start is always explicit; saving never starts automation.'; }
  private error(error: unknown): void { const message = (error instanceof Error ? error.message : typeof error === 'string' ? error : 'Invalid macro.').slice(0, 2000); this.result.hidden = false; this.result.textContent = message; this.hooks.notify(message, true); }
  private preview(): void {
    try {
      this.draft.text = this.editor.value; const script = this.draft.read();
      const observed = Date.now() - this.observedAt < 7000 ? structuredClone(this.observation) : {};
      if (observed.inventory) for (const id of macroInventoryItemIds(script)) observed.inventory = { ...observed.inventory, [id]: observed.inventory[id] ?? 0 };
      const trace = dryRunMacro(script, observed);
      this.result.hidden = false; this.result.textContent = `${trace.rule ? `Next sequence: ${trace.rule}` : 'No rule currently matches.'}\nPreview sends no commands.\n` + trace.rules.map(rule =>
        `${rule.name}: ${rule.state}\n${rule.conditions.map(condition => `  ${condition.condition.field}: ${condition.state} · ${condition.reason}`).join('\n')}\n  Steps: ${rule.steps.map(step => step.type).join(' → ')}`).join('\n\n');
      this.hooks.notify('Valid script. Preview does not confirm routes, prices, storage capacity or learned skills.');
    } catch (error) { this.error(error); }
  }
  private async start(): Promise<void> {
    if (this.busy || this.locked || this.startButton.disabled) return;
    try {
      this.draft.text = this.editor.value; const script = this.draft.read(); const settings = macroBaseSettings(this.hooks.settings(),script);
      this.busy = true; this.startButton.disabled = true; await this.hooks.start({ script, settings });
    } catch (error) { this.error(error); }
    finally { this.busy = false; this.startButton.disabled = this.locked; }
  }
  lock(config: boolean, manual: boolean): void {
    for (const input of this.root.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | HTMLButtonElement>('[data-config]')) input.disabled = config;
    this.locked = manual; this.startButton.disabled = manual || this.busy;
  }
  render(value: unknown, observation: RoutineObservation): void {
    this.observation = structuredClone(observation); this.observedAt = Date.now(); const state = record(value);
    this.progress.textContent = typeof state.reason === 'string' ? `${state.name || 'Macro'} · ${state.state} · ${state.reason}\n${state.actionsCompleted ?? 0}/${state.actionsIssued ?? 0} steps confirmed · ${state.spendReserved ?? 0} spending allowance reserved${state.currentRule ? ` · ${state.currentRule}` : ''}` : 'No macro running.';
    this.stopButton.disabled = !macroActive(value);
  }
}

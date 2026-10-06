import { filter, find, flatMap, map, pipe } from 'remeda';
import { validateMacroScript, type dryRunMacro, type MacroScript } from './macros-logic';
import { automationSettings, validateSettings, type Settings } from './settings';
import { formatBotScript, parseBotScript, type BotScriptDocument } from './bot-script';
export type Example = 'leveling' | 'continuous' | 'buy' | 'store' | 'item' | 'skill';
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
export function macroActive(value: unknown): boolean { const state=record(value).state;return typeof state==='string'&&['running', 'waiting', 'monitoring'].includes(state); }
/** Script targets can supply an empty field draft; non-field scripts need no combat selection. */
export function macroBaseSettings(value: Settings, script: MacroScript): Settings {
  const settings=structuredClone(value);
  const policy=structuredClone(automationSettings(settings));
  if(!settings.targets.length&&['selected','both'].includes(policy.combat.mode)) {
    const field=find(flatMap(script.rules, rule=>rule.steps), step=>step.type==='farm');
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

/** Decode saved source and legacy rules without touching storage. */
export function restoreMacroSource(stored: string | null | undefined, legacy: string | null | undefined, settings: Settings): string {
  if (!stored && !legacy) return formatBotScript({ settings, script: null });
  const raw = stored ?? legacy!;
  if (new TextEncoder().encode(raw).length > 1_000_000) throw new Error('Saved Setup is too large.');
  const value = record(JSON.parse(raw));
  if (Object.keys(value).length !== 2 || value.version !== 1) throw new Error('Unknown saved Setup format.');
  if (!stored) return formatBotScript({ settings, script: validateMacroScript(value.script) });
  if (typeof value.source !== 'string') throw new Error('Invalid saved Setup source.');
  parseBotScript(value.source);
  return value.source;
}
export function macroSource(text: string, document: BotScriptDocument): string {
  return text.trimStart().startsWith('{') ? formatBotScript(document) : text;
}
export function encodeMacroSource(source: string): string { return JSON.stringify({ version: 1, source }); }
export function macroStatusText(value: unknown): string {
  const state = record(value);
  return typeof state.reason === 'string' ? `${state.name || 'Rules'} · ${state.state} · ${state.reason}\n${state.actionsCompleted ?? 0}/${state.actionsIssued ?? 0} steps confirmed · ${state.spendReserved ?? 0} spending allowance reserved${state.currentRule ? ` · ${state.currentRule}` : ''}` : 'No rules running.';
}
export function macroPreviewText(trace: ReturnType<typeof dryRunMacro>): string {
  return `${trace.rule ? `Next sequence: ${trace.rule}` : 'No rule currently matches.'}\nPreview sends no commands.\n` + map(trace.rules, rule =>
    `${rule.name}: ${rule.state}\n${map(rule.conditions, condition => `  ${condition.condition.field}: ${condition.state} · ${condition.reason}`).join('\n')}\n  Steps: ${map(rule.steps, step => step.type).join(' → ')}`).join('\n\n');
}
export function addMacroExample(sourceText: string, document: BotScriptDocument, kind: Example): { text: string; insertion: number } {
  const source = macroSource(sourceText, document);
  const example = macroExample(kind, document.settings);
  const names = new Set(map(document.script?.rules ?? [], rule => rule.name));
  for (const rule of example.rules) {
    const base = rule.name; let suffix = 2;
    while (names.has(rule.name)) rule.name = `${base.slice(0, 74)} ${suffix++}`;
    names.add(rule.name);
  }
  validateMacroScript({ ...example, ...(document.script ?? {}), rules: [...document.script?.rules ?? [], ...example.rules] });
  const lines = formatBotScript({ settings: document.settings, script: example }).split('\n');
  const start = lines.findIndex(line => line.trimStart().startsWith('rule '));
  const existingLines = source.split(/\r?\n/);
  const limits = pipe(lines.slice(0, start), filter(line => /^(duration|actions|spend)\s/.test(line)
    && find(existingLines, existing => new RegExp(`^\\s*${line.split(' ')[0]}\\s`).test(existing)) === undefined));
  return { text: `${source.trimEnd()}\n\n${[...limits, ...lines.slice(start)].join('\n')}\n`, insertion: source.trimEnd().length + 2 };
}

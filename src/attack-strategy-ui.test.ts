import { describe, expect, it, vi } from 'vitest';
import { FeatureUi } from './feature-ui';
import { DEFAULT_AUTOMATION, DEFAULT_SETTINGS } from './settings';

function setup() {
  const nodes = new Map<string, { value: string; checked: boolean; textContent: string }>();
  const host = { querySelector: (key: string) => {
    if (!nodes.has(key)) nodes.set(key, { value: '', checked: false, textContent: '' });
    return nodes.get(key)!;
  } };
  const view: FeatureUi = Object.create(FeatureUi.prototype);
  const settings = vi.fn(() => ({ ...DEFAULT_SETTINGS, automation: view.read() }));
  let rows: Array<Record<string, unknown>> = [];
  Object.assign(view, {
    host, hooks: { settings },
    editors: new Map([['attackStrategies', { read: () => structuredClone(rows), write: (value: typeof rows) => { rows = structuredClone(value); } }]]),
    dispositionEditor: { read: () => [], write: () => {} },
  });
  return { view, settings, setRows: (value: typeof rows) => { rows = value; } };
}

describe('attack strategy settings in the native UI', () => {
  it('reads default and legacy settings without calling the app settings hook recursively', () => {
    const ui = setup();
    ui.view.write(structuredClone(DEFAULT_AUTOMATION));
    expect(ui.view.read()).not.toHaveProperty('attackStrategies');
    expect(ui.settings).not.toHaveBeenCalled();
  });

  it('preserves an explicit empty list and resets its presence when a legacy profile is loaded', () => {
    const ui = setup();
    ui.view.write({ ...structuredClone(DEFAULT_AUTOMATION), attackStrategies: [] });
    expect(ui.view.read().attackStrategies).toEqual([]);
    ui.view.write(structuredClone(DEFAULT_AUTOMATION));
    expect(ui.view.read()).not.toHaveProperty('attackStrategies');
    expect(ui.settings).not.toHaveBeenCalled();
  });

  it('includes newly added rules even when the loaded profile omitted strategies', () => {
    const ui = setup();
    ui.view.write(structuredClone(DEFAULT_AUTOMATION));
    ui.setRows([{ id: 'opening-bolt', speciesIds: [4000], skillId: '11', level: 1, behavior: 'opener', maxAttempts: 1, maxUses: 1, cooldownSeconds: 3 }]);
    expect(ui.view.read().attackStrategies?.[0]?.skillId).toBe(11);
    expect(ui.settings).not.toHaveBeenCalled();
  });
});

import { DEFAULT_SETTINGS } from './settings';
import { describe, expect, it } from 'vitest';
import { FeatureUi } from './feature-ui';

function setup() {
  const nodes = new Map<string, { textContent: string; dataset: Record<string, string>; value: string; hidden: boolean }>();
  const host = { querySelector: (key: string) => {
    if (!nodes.has(key)) nodes.set(key, { textContent: '', dataset: { actors: '' }, value: '', hidden: false });
    return nodes.get(key)!;
  } };
  const view = Object.create(FeatureUi.prototype);
  Object.assign(view, { host, hooks:{settings:()=>DEFAULT_SETTINGS,map:()=>''}, status: {}, dispositionPlan: null, social: { render: () => {} } });
  return {
    render: (supply: unknown) => FeatureUi.prototype.render.call(view, { supply }),
    output: host.querySelector('#supply-preview'),
  };
}

describe('supply status transitions', () => {
  it.each(['complete', 'cancelled'])('replaces active telemetry with %s and preserves a subsequent preview', (state) => {
    const ui = setup();
    const supply = { state: 'returning', active: true, uncertain: false, reason: 'Returning to the captured map and work cell.', actions: 11, spent: 0, reserved: 0, remainingTrips: 0 };
    ui.render(supply);
    expect(ui.output.textContent).toContain('returning');
    const terminal = { ...supply, state, active: false, reason: state === 'complete' ? 'Supply goals and return destination confirmed.' : 'Stopped by you.' };
    ui.render(terminal);
    expect(ui.output.textContent).toContain(`${state} · ${terminal.reason}`);
    expect(ui.output.textContent).toContain('0 trips left');
    ui.output.textContent = 'Preview only · no commands sent.';
    ui.render(terminal);
    expect(ui.output.textContent).toBe('Preview only · no commands sent.');
  });

  it('leaves an idle preview intact when no trip has started', () => {
    const ui = setup();
    ui.output.textContent = 'Preview only · 1 stock goal';
    ui.render({ state: 'armed', active: false, uncertain: false, actions: 0, returnDestination: null });
    expect(ui.output.textContent).toBe('Preview only · 1 stock goal');
  });
});

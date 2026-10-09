import { expect, it, vi } from 'vitest';
import { FarmingReadiness, navigateFarmingReadiness } from './farming-readiness';
import type { ReadinessRow } from './farming-readiness-logic';

class Node {
  children: Node[] = [];
  textContent = '';
  className = '';
  type = '';
  hidden = false;
  open = false;
  parentElement: Node | null = null;
  selectors = new Map<string, Node>();
  focus = vi.fn();
  scrollIntoView = vi.fn();
  click = vi.fn();
  dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  ownerDocument = { createElement: (tag: string) => new Node(tag) };
  constructor(readonly tag: string) {}
  get tagName() {
    return this.tag.toUpperCase();
  }
  querySelector(selector: string) {
    return this.selectors.get(selector) ?? null;
  }
  append(...nodes: Node[]) {
    this.children.push(...nodes);
  }
  replaceChildren() {
    this.children = [];
  }
  addEventListener(name: string, callback: () => void) {
    this.listeners.set(name, callback);
  }
}
it('shows warnings before choices, opens new warnings, preserves collapsed state and invokes navigation only', () => {
  const panel = new Node('details'),
    summary = new Node('summary'),
    list = new Node('div'),
    navigate = vi.fn();
  const view = new FarmingReadiness(
    panel as unknown as HTMLDetailsElement,
    summary as unknown as HTMLElement,
    list as unknown as HTMLElement,
    navigate,
  );
  const rows: ReadinessRow[] = [
    {
      id: 'limits',
      severity: 'info',
      title: 'Run limits',
      detail: 'Unlimited time.',
      action: 'limits',
    },
    {
      id: 'respawn',
      severity: 'warning',
      title: 'No allowance',
      detail: '<img src=x>',
      action: 'recovery',
    },
  ];
  view.render([{ label: 'Saved draft', rows }]);
  expect(panel.hidden).toBe(false);
  expect(panel.open).toBe(true);
  expect(summary.textContent).toContain('1 setting to review');
  const first = list.children[1]!.children[0]!;
  expect(first.dataset.severity).toBe('warning');
  expect(first.children[1]!.textContent).toBe('<img src=x>');
  first.children[2]!.listeners.get('click')!();
  expect(navigate).toHaveBeenCalledExactlyOnceWith('recovery');
  panel.open = false;
  view.render([{ label: 'Saved draft', rows: structuredClone(rows) }]);
  expect(list.children[1]!.children[0]).toBe(first);
  view.render([
    {
      label: 'Saved draft',
      rows: rows.map((row) => ({ ...row, detail: row.detail + ' updated' })),
    },
  ]);
  expect(panel.open).toBe(false);
  expect(navigate).toHaveBeenCalledTimes(1);
  view.render([]);
  expect(panel.hidden).toBe(true);
});

it.each([
  ['account', '#auto-reconnect', 'settings', null],
  ['recovery', '[data-setting="respawn.maxDeaths"]', 'bot', 'recovery'],
  ['supply', '[data-setting="supply.enabled"]', 'bot', 'inventory'],
  ['limits', '[data-setting="limits.minutes"]', 'bot', 'workflows'],
] as const)(
  'opens and focuses the owning controls for %s through the rendered link',
  (action, selector, page, section) => {
    const root = new Node('main'),
      panel = new Node('details'),
      summary = new Node('summary'),
      list = new Node('div'),
      control = new Node('input'),
      details = new Node('details'),
      form = new Node('button');
    control.parentElement = details;
    root.selectors.set(selector, control);
    root.selectors.set('#signin-panel', details);
    root.selectors.set('#setup-tab-form', form);
    const shell = { showPage: vi.fn(), showBotSection: vi.fn() };
    const view = new FarmingReadiness(
      panel as unknown as HTMLDetailsElement,
      summary as unknown as HTMLElement,
      list as unknown as HTMLElement,
      (next) => navigateFarmingReadiness(next, root as unknown as HTMLElement, shell),
    );
    view.render([
      {
        label: 'Before Start',
        rows: [
          {
            id: action,
            severity: 'warning',
            title: 'Review',
            detail: 'Choose explicitly.',
            action,
          },
        ],
      },
    ]);
    list.children[1]!.children[0]!.children[2]!.listeners.get('click')!();
    expect(shell.showPage).toHaveBeenCalledExactlyOnceWith(page);
    expect(details.open).toBe(true);
    expect(control.focus).toHaveBeenCalledOnce();
    expect(control.scrollIntoView).toHaveBeenCalledExactlyOnceWith({ block: 'nearest' });
    if (section) {
      expect(shell.showBotSection).toHaveBeenCalledExactlyOnceWith(section);
      expect(form.click).toHaveBeenCalledOnce();
    } else expect(shell.showBotSection).not.toHaveBeenCalled();
  },
);

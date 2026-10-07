import { afterEach, expect, it, vi } from 'vitest';
import { ClientAttention } from './client-attention';
import type { AttentionItem } from './client-attention-logic';

class Node {
  children: Node[] = []; textContent = ''; className = ''; id = ''; type = ''; hidden = false; dataset: Record<string, string> = {};
  listeners = new Map<string, () => void>();
  ownerDocument = { createElement: (tag: string) => new Node(tag) };
  constructor(readonly tag: string) {}
  append(...nodes: Node[]) { this.children.push(...nodes); }
  replaceChildren() { this.children = []; }
  addEventListener(name: string, callback: () => void) { this.listeners.set(name, callback); }
}
afterEach(() => vi.restoreAllMocks());
it('renders telemetry as text, retains unchanged cards and only invokes supplied navigation', () => {
  const panel = new Node('section'), list = new Node('ol'), navigate = vi.fn();
  const create = vi.spyOn(list.ownerDocument, 'createElement');
  const view = new ClientAttention(panel as unknown as HTMLElement, list as unknown as HTMLElement, navigate);
  const cards: AttentionItem[] = [{ id: 'action', severity: 'warning', title: 'Action needs review', detail: '<img src=x>',
    nextStep: 'Review the outstanding receipt.', action: 'tools' }];
  view.render(cards); const row = list.children[0]!;
  expect(panel.hidden).toBe(false); expect(row.children[0]!.children[1]!.textContent).toBe('<img src=x>');
  const button = row.children[1]!;
  expect(button.type).toBe('button'); expect(button.dataset.clientNavigation).toBe('attention');
  button.listeners.get('click')!(); expect(navigate).toHaveBeenCalledExactlyOnceWith('tools');
  create.mockClear(); view.render(structuredClone(cards));
  expect(list.children[0]).toBe(row); expect(create).not.toHaveBeenCalled();
  view.render([]); expect(panel.hidden).toBe(true); expect(list.children).toEqual([]);
});

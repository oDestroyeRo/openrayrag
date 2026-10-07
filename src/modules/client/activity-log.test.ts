import { afterEach, describe, expect, it, vi } from 'vitest';
import { ActivityLog } from './activity-log';

class Node {
  children: Node[] = [];
  textContent = '';
  className = '';
  constructor(readonly tag: string) {}
  append(...children: Node[]) {
    this.children.push(...children);
  }
  replaceChildren(...children: Node[]) {
    this.children = children;
  }
}
function fixture() {
  const create = vi.fn((tag: string) => new Node(tag));
  vi.stubGlobal('document', { createElement: create });
  const list = new Node('ol');
  return { create, list, view: new ActivityLog(list as unknown as HTMLElement) };
}
afterEach(() => vi.unstubAllGlobals());

describe('activity log projection', () => {
  it('retains unchanged rows across newly allocated status arrays without formatting again', () => {
    const { view, list, create } = fixture(),
      entries = [{ at: 1000, text: 'Observed' }];
    const format = vi.spyOn(Date.prototype, 'toLocaleTimeString');
    view.render(entries);
    const row = list.children[0];
    create.mockClear();
    format.mockClear();
    view.render(structuredClone(entries));
    expect(list.children[0]).toBe(row);
    expect(create).not.toHaveBeenCalled();
    expect(format).not.toHaveBeenCalled();
    format.mockRestore();
  });
  it('detects in-place middle text and timestamp edits without interpreting markup', () => {
    const { view, list } = fixture(),
      entries = Array.from({ length: 3 }, (_, i) => ({ at: i * 1000, text: String(i) }));
    view.render(entries);
    const oldTime = list.children[1]!.children[0]!.textContent;
    entries[1]!.text = '<img src=x>';
    entries[1]!.at += 1000;
    view.render(entries);
    expect(list.children[1]!.children[1]!.textContent).toBe('<img src=x>');
    expect(list.children[1]!.children[0]!.textContent).not.toBe(oldTime);
  });
  it('bounds rows at fifty and reflects append, rollover, removal and order changes', () => {
    const { view, list, create } = fixture(),
      entries = Array.from({ length: 50 }, (_, i) => ({ at: i * 1000, text: String(i) }));
    view.render(entries);
    create.mockClear();
    entries.push({ at: 51000, text: 'Outside bound' });
    view.render(entries);
    expect(list.children).toHaveLength(50);
    expect(create).not.toHaveBeenCalled();
    entries.pop();
    entries.unshift({ at: 52000, text: 'Newest' });
    entries.length = 50;
    view.render(entries);
    expect(list.children[0]!.children[1]!.textContent).toBe('Newest');
    entries.reverse();
    entries.pop();
    view.render(entries);
    expect(list.children).toHaveLength(49);
    expect(list.children[0]!.children[1]!.textContent).toBe('48');
  });
  it('clears on disconnect, changes empty-state copy and renders the same log after reconnect', () => {
    const { view, list } = fixture(),
      entries = [{ at: 1000, text: 'Connected' }];
    view.render(entries);
    view.render([], 'Session activity will appear after connection.');
    expect(list.children[0]!.textContent).toBe('Session activity will appear after connection.');
    view.render([]);
    expect(list.children[0]!.textContent).toBe('No activity observed yet.');
    view.render(entries);
    expect(list.children[0]!.children[1]!.textContent).toBe('Connected');
  });
});

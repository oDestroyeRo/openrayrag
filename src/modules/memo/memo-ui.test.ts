import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoUi, validMemoSnapshot } from './memo-ui';
import { ManualMemo, type MemoContext } from './memo';
import { FeatureUi, validFeatureStatus } from '../client/feature-ui';
import type { MemoRequest } from './memo-protocol';
class Element {
  children: Element[] = [];
  textContent = '';
  value = '';
  disabled = false;
  dataset: Record<string, string> = {};
  attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  constructor(readonly tag: string) {}
  append(...children: Element[]): void {
    this.children.push(...children);
  }
  setAttribute(k: string, v: string): void {
    this.attributes.set(k, v);
  }
  addEventListener(k: string, callback: () => unknown): void {
    this.listeners.set(k, [...(this.listeners.get(k) ?? []), callback]);
  }
  all(): Element[] {
    return [this, ...this.children.flatMap((child) => child.all())];
  }
  async emit(k: string): Promise<void> {
    for (const callback of this.listeners.get(k) ?? []) callback();
    await Promise.resolve();
    await Promise.resolve();
  }
}
const context: MemoContext = {
  ready: true,
  idle: true,
  world: '00000000-0000-4000-8000-000000000001',
  actorId: 0,
  incarnation: 1,
  connectionEpoch: 1,
  map: 'prt_fild08',
  x: 10,
  y: 20,
  canMemo: true,
  walkable: true,
  learnedWarp: 4,
};
function setup(send = vi.fn(async (_r: MemoRequest) => {})) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  const model = new ManualMemo(() => {});
  model.observeSlots([null, { map: 'prontera', x: 100, y: 200 }, null, null], context);
  const notify = vi.fn(),
    ui = new MemoUi(send, notify),
    root = ui.root as unknown as Element;
  const button = (name: string) =>
    root.all().find((node) => node.tag === 'button' && node.textContent === name)!;
  const field = (name: string) =>
    root.all().find((node) => node.attributes.get('aria-label') === name)!;
  const status = {
    sessionId: 'page-a',
    connectionId: 'socket-a',
    player: { id: 0, name: 'Synthetic' },
    memo: model.snapshot(context),
  };
  ui.render(status);
  ui.lock(false);
  return { ui, root, model, send, notify, button, field, status };
}
afterEach(() => vi.unstubAllGlobals());
describe('explicit memo preview controls', () => {
  it('shows all four server slots and only sends on Save after Preview', async () => {
    const s = setup();
    expect(s.field('Observed memo slots').textContent).toContain('Slot 1: prontera (100, 200)');
    expect(s.button('Save once').disabled).toBe(true);
    await s.field('Memo slot').emit('change');
    await s.field('Memo slot').emit('keydown');
    s.ui.render(s.status);
    expect(s.send).not.toHaveBeenCalled();
    await s.button('Preview current location').emit('click');
    expect(s.field('Memo overwrite preview').textContent).toContain('previous: Empty');
    expect(s.field('Memo overwrite preview').textContent).toContain('Current: prt_fild08 (10, 20)');
    await s.button('Save once').emit('click');
    expect(s.send).toHaveBeenCalledExactlyOnceWith({
      type: 'memoSave',
      slot: 0,
      preview: s.status.memo.ready,
    });
    await s.button('Save once').emit('click');
    expect(s.send).toHaveBeenCalledOnce();
    expect(s.root.all().some((node) => node.tag === 'input' || node.tag === 'textarea')).toBe(
      false,
    );
  });
  it('distinguishes Unknown, Empty and Already current without sending', async () => {
    const s = setup();
    s.model.reset('Enter');
    s.ui.render({ ...s.status, memo: s.model.snapshot(context) });
    expect(s.field('Observed memo slots').textContent).toContain('Unknown');
    s.model.observeSlots([{ map: context.map, x: 10, y: 20 }, null, null, null], context);
    s.ui.render({ ...s.status, memo: s.model.snapshot(context) });
    await s.button('Preview current location').emit('click');
    expect(s.field('Memo overwrite preview').textContent).toContain('Already current');
    expect(s.button('Save once').disabled).toBe(true);
    expect(s.send).not.toHaveBeenCalled();
  });
  it('invalidates previews on revision/cell/Stop and page/socket/character identity changes', async () => {
    for (const change of [
      { sessionId: 'page-b' },
      { connectionId: 'socket-b' },
      { player: { id: 1, name: 'Other' } },
      { memo: { ...setup().status.memo, generation: 1 } },
    ]) {
      const s = setup();
      await s.button('Preview current location').emit('click');
      s.ui.render({ ...s.status, ...change });
      await s.button('Save once').emit('click');
      expect(s.send).not.toHaveBeenCalled();
      expect(s.button('Save once').disabled).toBe(true);
    }
    const s = setup();
    await s.button('Preview current location').emit('click');
    s.model.observeSlots([null, null, null, null], context);
    s.ui.render({ ...s.status, memo: s.model.snapshot(context) });
    expect(s.field('Memo overwrite preview').textContent).toContain('stale');
    await s.button('Save once').emit('click');
    expect(s.send).not.toHaveBeenCalled();
    s.ui.clear();
    expect(s.field('Memo slot').value).toBe('0');
    expect(s.button('Preview current location').disabled).toBe(true);
  });
  it('requires learned slot eligibility and settled owners, and never queues or retries a double click', async () => {
    let finish!: () => void;
    const send = vi.fn(
        (_r: MemoRequest) =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      ),
      s = setup(send);
    s.field('Memo slot').value = '3';
    s.ui.render({ ...s.status, memo: { ...s.status.memo, learnedWarp: 3 } });
    expect(s.button('Preview current location').disabled).toBe(true);
    s.field('Memo slot').value = '0';
    s.ui.render(s.status);
    s.ui.lock(true);
    await s.button('Preview current location').emit('click');
    expect(s.send).not.toHaveBeenCalled();
    s.ui.lock(false);
    await s.button('Preview current location').emit('click');
    await s.button('Save once').emit('click');
    await s.button('Save once').emit('click');
    expect(s.send).toHaveBeenCalledOnce();
    finish();
    await Promise.resolve();
    await Promise.resolve();
    expect(s.button('Save once').disabled).toBe(true);
  });
  it('strictly bounds telemetry and fences the shared UI owner', () => {
    const s = setup();
    expect(validMemoSnapshot(s.status.memo)).toBe(true);
    for (const memo of [
      { ...s.status.memo, slots: [] },
      { ...s.status.memo, slots: [null, null, null, null, null] },
      { ...s.status.memo, extra: [] },
      { ...s.status.memo, reason: 'a'.repeat(513) },
      { ...s.status.memo, ready: { ...s.status.memo.ready, revision: 99 } },
      { ...s.status.memo, slots: [{ map: '<script>', x: 1, y: 2 }, null, null, null] },
      { ...s.status.memo, pending: true, blocked: false },
    ]) {
      expect(validMemoSnapshot(memo)).toBe(false);
      expect(validFeatureStatus({ memo })).toBe(false);
    }
    expect(
      Reflect.apply(FeatureUi.prototype.active, { status: { memo: { blocked: true } } }, []),
    ).toBe(true);
    expect(
      Reflect.apply(
        FeatureUi.prototype.serviceBlocked,
        { status: { memo: { blocked: true } } },
        [],
      ),
    ).toBe(true);
  });
});

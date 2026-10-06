import { afterEach, describe, expect, it, vi } from 'vitest';
import { SocialUi, validSocialSnapshot } from './social-ui';
import { ManualSocial } from './social';
import type { ManualSocialAction } from './social-protocol';
import { FeatureUi, validFeatureStatus } from '../client/feature-ui';

// Exercises the actual button callbacks without the account-bearing entrypoint.
class Element {
  children: Element[] = []; textContent = ''; value = ''; disabled = false;
  dataset: Record<string, string> = {}; attributes = new Map<string, string>();
  listeners = new Map<string, Array<() => unknown>>();
  constructor(readonly tag: string) {}
  append(...children: Element[]): void { this.children.push(...children); }
  setAttribute(name: string, value: string): void { this.attributes.set(name, value); }
  addEventListener(name: string, callback: () => unknown): void { this.listeners.set(name, [...(this.listeners.get(name) ?? []), callback]); }
  all(): Element[] { return [this, ...this.children.flatMap(child => child.all())]; }
  async emit(name: string): Promise<void> { for (const callback of this.listeners.get(name) ?? []) callback(); await Promise.resolve(); await Promise.resolve(); }
}
function setup(send = vi.fn(async (_action: ManualSocialAction) => {})) {
  vi.stubGlobal('document', { createElement: (tag: string) => new Element(tag) });
  const notify = vi.fn(), ui = new SocialUi(send, notify), root = ui.root as unknown as Element;
  const field = (name: string) => root.all().find(node => node.attributes.get('aria-label') === name)!;
  const button = (name: string) => root.all().find(node => node.tag === 'button' && node.textContent === name)!;
  const social = new ManualSocial(() => {}).snapshot();
  const status = { sessionId: 'synthetic-page', connectionId: 'synthetic-socket', connected: true, compatible: true, player: { id: 0, kind:0, name: 'Synthetic', classId: 0 },
    character: { skillsKnown: true, learned: [{ skillId: 1, level: 7 }], granted: [], statuses: [] }, world: { party: null }, social };
  ui.render(status); ui.lock(false);
  return { ui, root, field, button, send, notify, status };
}
afterEach(() => vi.unstubAllGlobals());
describe('explicit manual social controls', () => {
  it('sends only from button clicks, preserves opaque draft text, and offers the exact player picker', async () => {
    const s = setup(), draft = s.field('Chat draft'); draft.value = '<b>/hello %</b>'; await draft.emit('input');
    await draft.emit('keydown'); await draft.emit('change'); expect(s.send).not.toHaveBeenCalled();
    expect(s.root.all().some(node => node.textContent === `${draft.value.length} / 140 UTF-16 units`)).toBe(true);
    await s.button('Send message').emit('click'); expect(s.send).toHaveBeenCalledExactlyOnceWith({ type: 'chat', channel: 0, text: draft.value });
    const picker = s.field('Player emote'); expect(picker.children).toHaveLength(59);
    expect(picker.children.some(node => node.value === '58')).toBe(true); expect(picker.children.some(node => node.value === '200')).toBe(false);
    picker.value = '58'; await picker.emit('change'); await s.button('Send emote').emit('click'); expect(s.send).toHaveBeenLastCalledWith({ type: 'emote', id: 58 });
  });
  it('rejects unavailable evidence, cooldowns and owner locks without queueing a later send', async () => {
    const s = setup(), draft = s.field('Chat draft'), channel = s.field('Chat channel'); draft.value = 'test';
    channel.value = '2'; await channel.emit('change'); expect(s.button('Send message').disabled).toBe(true); await s.button('Send message').emit('click');
    channel.value = '1'; s.ui.render({ ...s.status, character: { ...s.status.character, skillsKnown: false, granted: [{ skillId: 1, level: 10 }] } });
    expect(s.button('Send message').disabled).toBe(true); expect(s.button('Send emote').disabled).toBe(true);
    s.ui.render({ ...s.status, social: { ...s.status.social, shoutWaitMs: 10000, emoteWaitMs: 500 } });
    expect(s.button('Send message').disabled).toBe(true); expect(s.button('Send emote').disabled).toBe(true);
    s.ui.lock(true); await s.button('Send emote').emit('click'); s.ui.lock(false); s.ui.render(s.status);
    expect(s.send).not.toHaveBeenCalled(); expect(s.button('Send message').disabled).toBe(false);
    s.ui.render({ ...s.status, connected: false }); await s.button('Send message').emit('click'); expect(s.send).not.toHaveBeenCalled();
  });
  it('fences duplicate clicks until IPC settles and never submits through Enter', async () => {
    let finish!: () => void; const send = vi.fn((_action: ManualSocialAction) => new Promise<void>(resolve => { finish = resolve; }));
    const s = setup(send); s.field('Chat draft').value = 'once'; await s.field('Chat draft').emit('input');
    await s.button('Send message').emit('click'); await s.button('Send message').emit('click'); await s.field('Chat draft').emit('keydown');
    expect(send).toHaveBeenCalledOnce(); expect(s.button('Send message').disabled).toBe(true); finish(); await Promise.resolve(); await Promise.resolve();
    expect(s.notify).toHaveBeenCalledOnce();
  });
  it('renders incoming content literally, keeps drafts through status updates and clears on generation change', () => {
    const s = setup(); s.field('Chat draft').value = 'draft';
    const history = [{ sequence: 1, at: 1, kind: 'chat', direction: 'received', actorId: -1, name: '<img src=x>', text: '<script>/run %</script>', channel: 3, state: 'observed' }];
    s.ui.render({ ...s.status, social: { ...s.status.social, history } });
    expect(s.field('Session social history').textContent).toContain('<img src=x> · Notice: <script>/run %</script>');
    expect(s.field('Session social history')).not.toHaveProperty('innerHTML'); expect(s.field('Chat draft').value).toBe('draft');
    s.ui.render({ ...s.status, social: { ...s.status.social, generation: 1 } }); expect(s.field('Chat draft').value).toBe('');
    s.field('Chat draft').value = 'another draft'; s.ui.render({ ...s.status, social: { ...s.status.social, history } }); s.ui.clear();
    expect(s.field('Chat draft').value).toBe(''); expect(s.field('Session social history').textContent).toBe(''); expect(s.button('Send emote').disabled).toBe(true); expect(s.send).not.toHaveBeenCalled();
  });
  it('rejects snapshots outside the bounded display contract while retaining unknown inbound emotes', () => {
    const base = new ManualSocial(() => {}).snapshot(); expect(validSocialSnapshot(base)).toBe(true);
    const row = { sequence: 1, at: 1, kind: 'emote', direction: 'received', actorId: 0, name: 'Actor #0', text: 'Emote #-100', emoteId: -100, state: 'observed' };
    expect(validSocialSnapshot({ ...base, history: [row] })).toBe(true);
    for (const bad of [{ ...row, actorId: -1 }, { ...row, emoteId: 2147483648 }, { ...row, text: '😀'.repeat(1025) }, { ...row, name: 'a'.repeat(257) }, { ...row, kind: 'chat', channel: 4 }, { ...row, extra: { tree: [] } }])
      expect(validSocialSnapshot({ ...base, history: [bad] })).toBe(false);
    expect(validSocialSnapshot({ ...base, extra: [] })).toBe(false);
    expect(validFeatureStatus({ social: base })).toBe(true); expect(validFeatureStatus({ social: { ...base, extra: [] } })).toBe(false);
    expect(validSocialSnapshot({ ...base, history: Array.from({ length: 201 }, () => row) })).toBe(false);
    expect(validSocialSnapshot({ ...base, history: Array.from({ length: 20 }, () => ({ ...row, text: 'x'.repeat(4096) })) })).toBe(false);
    expect(Reflect.apply(FeatureUi.prototype.serviceBlocked, { status: { social: { pending: true } } }, [])).toBe(true);
    expect(Reflect.apply(FeatureUi.prototype.active, { status: { social: { pending: true } } }, [])).toBe(true);
  });
  it('clears drafts across page, socket and character changes even when generation counters collide', () => {
    for (const replacement of [{ sessionId: 'new-page' }, { connectionId: 'new-socket' }, { player: { id: 2, name: 'Another', classId: 0 } }, { player: { id: 0, name: 'Another', classId: 0 } }]) {
      const s = setup(); const social = { ...s.status.social, generation: 4 }; s.ui.render({ ...s.status, social }); s.field('Chat draft').value = 'old session draft';
      s.ui.render({ ...s.status, ...replacement, social }); expect(s.field('Chat draft').value).toBe(''); expect(s.send).not.toHaveBeenCalled();
    }
  });
});

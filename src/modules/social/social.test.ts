import { describe, expect, it } from 'vitest';
import { ManualSocial, displayText, type SocialContext } from './social';
import type { ManualSocialAction } from './social-protocol';

const context: SocialContext = {
  ready: true,
  actorId: 1,
  name: 'Synthetic',
  job: 0,
  learnedBasic: 7,
  inParty: true,
  silenced: false,
};
function fixture() {
  let now = 1000;
  const sent: ManualSocialAction[] = [];
  const model = new ManualSocial(
    (a) => sent.push(a),
    () => now,
  );
  return {
    model,
    sent,
    advance: (ms: number) => {
      now += ms;
      model.tick();
    },
  };
}
const chat = { type: 'chat' as const, channel: 0 as const, text: '  <b>/literal %</b> 😀  ' };
const echo = {
  type: 'chat' as const,
  actorId: 1,
  channel: 0 as const,
  text: chat.text,
  name: 'Synthetic',
};
describe('manual social evidence and cancellation', () => {
  it('requires an explicit dispatch; own exact echo differs from unrelated traffic', () => {
    const t = fixture();
    t.model.observe(echo, context);
    t.advance(1000);
    expect(t.sent).toEqual([]);
    t.model.dispatch(chat, context);
    expect(t.model.snapshot().state).toBe('sent');
    expect(() => t.model.dispatch(chat, context)).toThrow();
    for (const event of [
      { ...echo, actorId: 2 },
      { ...echo, actorId: -1 },
      { ...echo, channel: 3 as const },
      { ...echo, text: 'different' },
      { type: 'emote' as const, actorId: 1, id: 58 },
    ])
      t.model.observe(event, context);
    expect(t.model.busy).toBe(true);
    t.model.observe(echo, context);
    expect(t.model.snapshot().state).toBe('echo');
    expect(t.sent).toEqual([chat]);
  });
  it('never attributes identical requests or canceled/late echoes to a newer attempt', () => {
    const t = fixture();
    t.model.dispatch(chat, context);
    t.model.cancel('Stop');
    t.model.dispatch(chat, context);
    t.model.observe(echo, context);
    expect(t.model.snapshot().state).toBe('sent');
    t.advance(10000);
    expect(t.model.snapshot().state).toBe('unconfirmed');
    t.model.observe(echo, context);
    expect(t.model.snapshot().state).toBe('unconfirmed');
    expect(t.sent).toHaveLength(2);
  });
  it('accepts observed actor0 and refuses unknown/unready default identity', () => {
    const t = fixture();
    expect(() => t.model.dispatch(chat, { ...context, ready: false, actorId: 0 })).toThrow();
    expect(() => t.model.dispatch(chat, { ...context, actorId: null })).toThrow();
    t.model.dispatch(chat, { ...context, actorId: 0 });
    t.model.observe({ ...echo, actorId: 0 }, { ...context, ready: false, actorId: 0 });
    expect(t.model.busy).toBe(true);
    t.model.observe({ ...echo, actorId: 0 }, { ...context, actorId: 0 });
    expect(t.model.snapshot().state).toBe('echo');
  });
  it('enforces learned prerequisites and dispatch gaps; never queues or retries', () => {
    const t = fixture();
    for (const c of [
      { ...context, learnedBasic: null },
      { ...context, learnedBasic: 0 },
    ])
      expect(() => t.model.dispatch({ type: 'emote', id: 0 }, c)).toThrow();
    expect(() =>
      t.model.dispatch({ ...chat, channel: 2 }, { ...context, inParty: false }),
    ).toThrow();
    expect(() =>
      t.model.dispatch({ ...chat, channel: 1 }, { ...context, learnedBasic: 6 }),
    ).toThrow();
    expect(() =>
      t.model.dispatch({ type: 'emote', id: 0 }, { ...context, silenced: true }),
    ).toThrow();
    t.model.dispatch({ type: 'emote', id: 0 }, { ...context, job: 1, learnedBasic: null });
    t.model.observe({ type: 'emote', actorId: 1, id: 0 }, context);
    expect(() => t.model.dispatch({ type: 'emote', id: 1 }, context)).toThrow();
    t.advance(1799);
    expect(() => t.model.dispatch({ type: 'emote', id: 1 }, context)).toThrow();
    t.advance(1);
    t.model.dispatch({ type: 'emote', id: 58 }, context);
    t.model.observe({ type: 'emote', actorId: 1, id: 58 }, context);
    expect(t.model.busy).toBe(true);
    t.model.observe({ type: 'emote', actorId: 2, id: 200 }, context);
    expect(t.model.busy).toBe(true);
    t.model.observe({ type: 'emote', actorId: 1, id: 205 }, context);
    expect(t.model.snapshot().state).toBe('echo');
    t.model.dispatch({ ...chat, channel: 1 }, context);
    t.model.observe({ ...echo, channel: 1 }, context);
    t.advance(19999);
    expect(() => t.model.dispatch({ ...chat, channel: 1, text: 'New' }, context)).toThrow();
    t.advance(1);
    t.model.dispatch({ ...chat, channel: 1, text: 'New' }, context);
    t.advance(10000);
    expect(t.model.snapshot().state).toBe('unconfirmed');
    expect(t.sent).toHaveLength(4);
  });
  it('bounds rows, serialized UTF8, Unicode-safe text/name display and literal markup', () => {
    const t = fixture();
    for (let i = 0; i < 250; i++)
      t.model.observe(
        { ...echo, text: '<script>literal</script>😀'.repeat(500), name: '😀'.repeat(200) },
        context,
      );
    const s = t.model.snapshot();
    expect(s.history.length).toBeLessThanOrEqual(200);
    expect(new TextEncoder().encode(JSON.stringify(s.history)).length).toBeLessThanOrEqual(32768);
    expect(s.history.at(-1)?.text).toContain('<script>literal</script>');
    expect(s.history.at(-1)?.text).toContain('[truncated]');
    for (const row of s.history) {
      expect(new TextEncoder().encode(row.text).length).toBeLessThanOrEqual(4096);
      expect(new TextEncoder().encode(row.name).length).toBeLessThanOrEqual(256);
      expect(row.text).not.toContain('\ufffd');
    }
    expect(displayText('😀'.repeat(100), 256)).not.toContain('\ufffd');
    t.model.reset('New character');
    expect(t.model.snapshot().history).toEqual([]);
    expect(t.sent).toEqual([]);
  });
  it('fails correlation closed after the bounded fingerprint budget fills', () => {
    const t = fixture();
    for (let i = 0; i < 260; i++) {
      const action = { ...chat, text: `Message ${i}` };
      t.model.dispatch(action, context);
      t.model.observe({ ...echo, text: action.text }, context);
      if (t.model.busy) t.advance(10000);
    }
    t.model.dispatch(chat, context);
    t.model.observe(echo, context);
    expect(t.model.busy).toBe(true);
    t.advance(10000);
    expect(t.model.snapshot().state).toBe('unconfirmed');
  });
  it('prunes short history at the count cap and never retries an uncertain socket write', () => {
    const t = fixture();
    for (let i = 0; i < 250; i++)
      t.model.observe({ type: 'emote', actorId: 0, id: 0 }, { ...context, actorId: 0, name: '' });
    expect(t.model.snapshot().history).toHaveLength(200);
    expect(t.model.snapshot().history[0]?.sequence).toBe(51);
    let now = 1000;
    const send = () => {
        throw new Error('Synthetic transport failure');
      },
      model = new ManualSocial(send, () => now);
    expect(() => model.dispatch({ type: 'emote', id: 0 }, context)).toThrow('unconfirmed');
    expect(model.snapshot().state).toBe('unconfirmed');
    expect(model.busy).toBe(false);
    expect(model.snapshot().emoteWaitMs).toBe(1800);
    now += 10000;
    model.tick();
    model.observe({ type: 'emote', actorId: 1, id: 0 }, context);
    expect(model.snapshot().state).toBe('unconfirmed');
  });
});

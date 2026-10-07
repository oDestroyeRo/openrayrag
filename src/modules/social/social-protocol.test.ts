import { describe, expect, it } from 'vitest';
import { BitWriter } from '../../shared/binary';
import { decode } from '../protocol/protocol';
import { decodeSocial, EMOTES, socialCommand, validateSocialAction } from './social-protocol';
import { validControllerAction } from '../runtime/controller';
import { validateRoutineSpec } from '../automation/routines';
import cases from '../../data/social-request-cases.json';

describe('pinned manual social wire', () => {
  it('matches literal outgoing and incoming fixtures', () => {
    expect([...socialCommand({ type: 'chat', channel: 2, text: 'Hi' })]).toEqual([
      44, 2, 0, 72, 105, 2,
    ]);
    expect([...socialCommand({ type: 'emote', id: 58 })]).toEqual([54, 58, 0, 0, 0]);
    expect(decode(Uint8Array.from([44, 1, 0, 0, 0, 2, 0, 72, 105, 1, 0, 65, 0]))).toEqual([
      { type: 'chat', actorId: 1, text: 'Hi', name: 'A', channel: 0 },
    ]);
    expect(decode(Uint8Array.from([54, 0, 0, 0, 0, 205, 0, 0, 0]))).toEqual([
      { type: 'emote', actorId: 0, id: 205 },
    ]);
    expect(decodeSocial(new BitWriter().u8(54).i32(5).i32(-20).finish())).toEqual([
      { type: 'emote', actorId: 5, id: -20 },
    ]);
    // Leading UTF8 BOM bytes are content in both source strings, not a stream signature.
    expect(
      decodeSocial(
        Uint8Array.from([44, 1, 0, 0, 0, 4, 0, 239, 187, 191, 120, 4, 0, 239, 187, 191, 110, 0]),
      ),
    ).toEqual([{ type: 'chat', actorId: 1, text: '\ufeffx', name: '\ufeffn', channel: 0 }]);
  });
  it('reads full u16 text and name bounds, including receive-only system messages', () => {
    const text = 'a'.repeat(65535),
      name = 'b'.repeat(65535);
    expect(
      decodeSocial(
        new BitWriter().u8(44).i32(-1).string(text, 65535).string(name, 65535).u8(3).finish(),
      ),
    ).toEqual([{ type: 'chat', actorId: -1, text, name, channel: 3 }]);
  });
  it('rejects malformed UTF8, omitted/truncated fields, invalid actors/channels and trailers', () => {
    const full = Uint8Array.from([44, 0, 0, 0, 0, 2, 0, 72, 105, 1, 0, 65, 0]);
    expect(decodeSocial(new Uint8Array())).toBeNull();
    for (let n = 1; n < full.length; n++) expect(() => decodeSocial(full.slice(0, n))).toThrow();
    for (const data of [
      Uint8Array.from([...full, 0]),
      new BitWriter().u8(44).i32(-2).string('x').string('A').u8(0).finish(),
      new BitWriter().u8(44).i32(1).string('x').string('A').u8(4).finish(),
      new BitWriter().u8(54).i32(-1).i32(0).finish(),
      Uint8Array.from([44, 1, 0, 0, 0, 1, 0, 255, 0, 0, 0]),
    ])
      expect(() => decodeSocial(data)).toThrow();
  });
  it('shares exact native cases, all59 emotes and explicit routine exclusion', () => {
    expect(EMOTES).toHaveLength(59);
    for (const c of cases) {
      expect(
        (() => {
          try {
            validateSocialAction(c.request);
            return true;
          } catch {
            return false;
          }
        })(),
        c.name,
      ).toBe(c.valid);
      expect(validControllerAction(c.request)).toBe(false);
      expect(() =>
        validateRoutineSpec(
          {
            name: 'Rejected',
            durationSeconds: 10,
            maxActions: 1,
            rules: [
              {
                name: 'No social',
                priority: 0,
                cooldownSeconds: 1,
                maxRuns: 1,
                conditions: [{ field: 'hpPercent', operator: 'lt', value: 100 }],
                action: c.request,
              },
            ],
          },
          validControllerAction,
        ),
      ).toThrow();
    }
    for (const text of ['\ud800', '\udfff', 'a\ud800b'])
      expect(() => validateSocialAction({ type: 'chat', channel: 0, text })).toThrow();
  });
});

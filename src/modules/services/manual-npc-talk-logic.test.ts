import { describe, expect, it } from 'vitest';
import { validateManualNpcTalkRequest } from './manual-npc-talk-logic';

const world = '12345678-1234-1234-1234-123456789abc';
const request = () => ({
  type: 'manualNpcTalk', map: 'prontera',
  owner: { world, id: 1, incarnation: 1 },
  target: { world, id: 20, incarnation: 2 },
});

describe('manual NPC talk request admission', () => {
  it('admits actor zero, the int32 boundary and maps without collision data', () => {
    const input = request();
    input.map = 'unmapped_field'; input.owner.id = 0; input.target.id = 0x7fffffff;
    input.target.incarnation = 0x7fffffff;
    expect(validateManualNpcTalkRequest(input)).toEqual(input);
    input.target.id = 0;
    expect(validateManualNpcTalkRequest(input).target.id).toBe(0);
  });

  it.each([
    null, [], {}, { ...request(), type: 'npcTalk' }, { ...request(), id: 20 },
    { ...request(), map: '' }, { ...request(), map: 'a'.repeat(65) }, { ...request(), map: 'bad/map' },
    { ...request(), owner: { ...request().owner, extra: true } },
    { ...request(), target: { ...request().target, extra: true } },
    { ...request(), owner: { world, id: 1 } },
    { ...request(), target: { ...request().target, world: '00000000-0000-0000-0000-000000000000' } },
    { ...request(), owner: { ...request().owner, world: 'not-a-world' } },
    { ...request(), target: { ...request().target, id: -1 } },
    { ...request(), target: { ...request().target, id: 0x80000000 } },
    { ...request(), target: { ...request().target, id: 1.5 } },
    { ...request(), target: { ...request().target, incarnation: 0 } },
    { ...request(), target: { ...request().target, incarnation: 0x80000000 } },
  ])('rejects malformed or cross-world input %#', input => {
    expect(() => validateManualNpcTalkRequest(input)).toThrow();
  });

  it('retains detached actor identities', () => {
    const input = request(), admitted = validateManualNpcTalkRequest(input);
    input.owner.id = 9; input.target.incarnation = 9;
    expect(admitted.owner.id).toBe(1); expect(admitted.target.incarnation).toBe(2);
  });
});

import { describe, expect, it } from 'vitest';
import {
  fieldIdentityWaitReason,
  fieldResumeDecision,
  type FieldResumeState,
} from './controller-field-policy';

const state: FieldResumeState = {
  now: 20000,
  lastFrame: 20000,
  retryAt: 0,
  originalCharacter: 'Test',
  character: 'Test',
  unresolvedWorld: false,
  weightLimit: 80,
  weight: 1,
  maxWeight: 100,
  databasePreparing: false,
  databaseReason: 'Database preparation',
  dead: false,
  respawnEnabled: true,
  deaths: 0,
  maxDeaths: 1,
  hp: 100,
  maxHp: 100,
  minHpPercent: 40,
  npcMode: 'idle',
  npcId: null,
  vending: false,
};

describe('field resume decisions', () => {
  it('checks connection, protocol and own lifetime before field policy', () => {
    const ready = {
      connected: true,
      compatible: true,
      hasPlayer: true,
      map: 'field',
      dead: false,
      ownActorObserved: true,
    };
    expect(fieldIdentityWaitReason(ready)).toBeNull();
    expect(fieldIdentityWaitReason({ ...ready, connected: false, compatible: false })).toBe(
      'Waiting for the game to reconnect.',
    );
    expect(fieldIdentityWaitReason({ ...ready, compatible: false, hasPlayer: false })).toBe(
      'Waiting for a verified game build and protocol.',
    );
    expect(fieldIdentityWaitReason({ ...ready, map: '' })).toBe(
      'Waiting for the character and map to load.',
    );
    expect(fieldIdentityWaitReason({ ...ready, ownActorObserved: false })).toBe(
      'Waiting for the current own actor lifetime to be observed.',
    );
    expect(fieldIdentityWaitReason({ ...ready, ownActorObserved: false, dead: true })).toBeNull();
  });
  it('admits a settled healthy field while preserving an unexpired retry deadline', () => {
    expect(fieldResumeDecision(state)).toEqual({ type: 'resume' });
    expect(fieldResumeDecision({ ...state, retryAt: state.now + 1 })).toEqual({ type: 'hold' });
    expect(fieldResumeDecision({ ...state, retryAt: state.now })).toEqual({ type: 'resume' });
  });
  it('prioritizes original character and world outcomes over fresh field evidence', () => {
    expect(
      fieldResumeDecision({ ...state, character: 'Other', unresolvedWorld: true, weight: 100 }),
    ).toEqual({ type: 'wait', reason: 'Waiting for the originally selected character.' });
    expect(fieldResumeDecision({ ...state, unresolvedWorld: true, weight: 100 })).toEqual({
      type: 'wait',
      reason: 'Waiting for the canceled world request to settle or its interaction to close.',
    });
  });
  it('waits at inclusive weight and HP limits but ignores weight when disabled', () => {
    expect(fieldResumeDecision({ ...state, weight: undefined })).toEqual({
      type: 'wait',
      reason: 'Waiting for a confirmed weight update.',
    });
    expect(fieldResumeDecision({ ...state, weight: 80 })).toEqual({
      type: 'wait',
      reason: 'Waiting for carried weight to fall below the configured limit.',
    });
    expect(
      fieldResumeDecision({ ...state, weightLimit: 0, weight: undefined, maxWeight: undefined }),
    ).toEqual({ type: 'resume' });
    expect(fieldResumeDecision({ ...state, hp: 40 })).toEqual({
      type: 'wait',
      reason: 'Waiting for HP to recover above the configured limit.',
    });
    expect(fieldResumeDecision({ ...state, hp: 41 })).toEqual({ type: 'resume' });
  });
  it('does not turn database preparation into a new field wait effect', () => {
    expect(fieldResumeDecision({ ...state, lastFrame: 5000 })).toEqual({ type: 'resume' });
    expect(fieldResumeDecision({ ...state, lastFrame: 4999 })).toEqual({
      type: 'wait',
      reason: 'Waiting for a fresh server update.',
    });
    expect(fieldResumeDecision({ ...state, lastFrame: 4999, databasePreparing: true })).toEqual({
      type: 'database-wait',
      reason: 'Database preparation',
    });
  });
  it('permits the inclusive respawn allowance while preserving disabled and exceeded waits', () => {
    expect(fieldResumeDecision({ ...state, dead: true, hp: 0, deaths: 1 })).toEqual({
      type: 'resume',
    });
    expect(fieldResumeDecision({ ...state, dead: true, respawnEnabled: false })).toEqual({
      type: 'wait',
      reason: 'Waiting for revival.',
    });
    expect(fieldResumeDecision({ ...state, dead: true, deaths: 2 })).toMatchObject({
      type: 'wait',
      reason: expect.stringContaining('Death limit reached.'),
    });
  });
  it.each([{ npcMode: 'dialog' }, { npcId: 1 }, { vending: true }])(
    'waits for NPC/vending ownership: %j',
    (interaction) => {
      expect(fieldResumeDecision({ ...state, ...interaction })).toEqual({
        type: 'wait',
        reason: 'Waiting for the current NPC or vending interaction to finish.',
      });
    },
  );
});

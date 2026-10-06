import { describe, expect, it } from 'vitest';
import { publishedActionResult, receiptRetirement, type ActionFailure, type AutomationOutcome } from './automation-logic';
import type { ExpandedAction } from '../protocol/protocol-feature';

const causes: ActionFailure['type'][] = ['server-rejection', 'cancel', 'send-failure', 'timeout'];
const resourceActions: ExpandedAction['type'][] = ['useItem', 'allocateStats', 'allocateSkill', 'skill'];

describe('typed action outcome projection and receipt policy', () => {
  it('publishes only the original result fields for every internal outcome', () => {
    const outcomes: AutomationOutcome[] = [
      { sequence: 0, status: 'idle', reason: '' },
      { sequence: 1, status: 'pending', reason: 'Waiting for useItem confirmation.' },
      { sequence: 1, status: 'confirmed', reason: 'useItem confirmed by the server.' },
      ...causes.map(type => ({ sequence: 1, status: 'failed' as const, failure: { type, reason: 'Exact caller message.' } })),
    ];
    for (const outcome of outcomes) {
      const result = publishedActionResult(outcome);
      expect(result).toEqual({ sequence: outcome.sequence, status: outcome.status,
        reason: outcome.status === 'failed' ? outcome.failure.reason : outcome.reason });
      expect(Object.keys(result)).toEqual(['sequence', 'status', 'reason']);
      result.reason = 'Changed display text.';
      expect(publishedActionResult(outcome).reason).not.toBe(result.reason);
    }
  });

  it('retires continuing receipts by cause independently of the displayed message', () => {
    for (const type of causes) for (const actionType of resourceActions) {
      const expected = type === 'server-rejection'
        ? { state: 'rejected', discard: true } : { state: 'uncertain', discard: false };
      for (const reason of ['Translated rejection.', 'Server rejected skill (code 3).', '']) {
        expect(receiptRetirement({ continuing: true, actionType, failure: { type, reason } })).toEqual(expected);
      }
    }
  });

  it('retains stopped resource receipts, releases posture receipts, and preserves nonresource release', () => {
    for (const type of causes) {
      const failure: ActionFailure = { type, reason: 'Failure.' };
      for (const actionType of resourceActions) {
        expect(receiptRetirement({ continuing: false, actionType, failure })).toEqual({ state: 'retained', discard: false });
      }
      for (const actionType of ['sit', 'respawn'] as const) {
        expect(receiptRetirement({ continuing: false, actionType, failure })).toEqual({ state: 'released', discard: true });
      }
    }
    expect(receiptRetirement({ continuing: false, actionType: 'equip', failure: null })).toEqual({ state: 'retained', discard: false });
    expect(receiptRetirement({ continuing: true, actionType: 'equip', failure: null })).toEqual({ state: 'released', discard: true });
    expect(receiptRetirement({ continuing: false, actionType: null, failure: null })).toEqual({ state: 'released', discard: false });
    const failure: ActionFailure = { type: 'server-rejection', reason: 'Opaque response text.' };
    expect(receiptRetirement({ continuing: true, actionType: null, failure })).toEqual({ state: 'rejected', discard: true });
    expect(receiptRetirement({ continuing: false, actionType: null, failure })).toEqual({ state: 'released', discard: false });
  });
});

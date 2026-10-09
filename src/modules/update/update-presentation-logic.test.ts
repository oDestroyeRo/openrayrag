import { describe, expect, it } from 'vitest';
import { deferredReason } from './update-continuation-logic';
import { updateActivity, updatePresentation, updateVersion } from './update-presentation-logic';

describe('safe updater presentation', () => {
  it.each(['../private/path', 'account token', '', '0.18.0\n', null, {}, '9'.repeat(81)])(
    'rejects unsafe version %j',
    (value) => {
      expect(updateVersion(value)).toBeNull();
    },
  );
  it('distinguishes exact allowed Error instances and strings without leaking arbitrary messages', () => {
    for (const error of [
      'Update handoff confirmation timed out. Press Stop before starting again.',
      new Error('Update handoff confirmation timed out. Press Stop before starting again.'),
    ])
      expect(deferredReason('prepare', error)).toContain('preparation timed out');
    expect(deferredReason('prepare', new Error('Update handoff is unavailable.'))).toContain(
      'could not be reached',
    );
    for (const error of [
      'private/account/path',
      new Error('private/account/path'),
      { message: 'private/account/path' },
    ]) {
      expect(deferredReason('reserve', error)).not.toContain('private');
      expect(deferredReason('reserve', error)).toContain('connection could not be prepared');
    }
    expect(
      deferredReason(
        'reserve',
        new Error(
          'Update waits because a replaced game page may have unresolved actions. Quit and reopen Companion when safe, or use the release download.',
        ),
      ),
    ).toContain('replaced game page');
  });
  it('keeps elapsed waits, versions and safe next action visible and merges history without mutating either owner', () => {
    const diagnostic = {
      stage: 'prepare' as const,
      installedVersion: '0.17.1',
      targetVersion: '0.18.0',
      startedAt: 1000,
      at: 1000,
      message: 'Waiting for the current action. Stop cancels continuation.',
      retryAt: 0,
    };
    expect(updatePresentation(diagnostic, true, 13_000)).toEqual({
      active: true,
      reason:
        'Update to v0.18.0 (installed v0.17.1) · prepare · 12s. Waiting for the current action. Stop cancels continuation.',
    });
    const game = [{ at: 2000, text: 'Combat confirmed.' }],
      updater = [{ at: 3000, text: 'Update deferred.' }];
    expect(updateActivity(game, updater)).toEqual([updater[0], game[0]]);
    expect(game).toEqual([{ at: 2000, text: 'Combat confirmed.' }]);
    expect(updater).toEqual([{ at: 3000, text: 'Update deferred.' }]);
  });
});
